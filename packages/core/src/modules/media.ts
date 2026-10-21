import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import { config } from '../config';
import { signMedia, verifyMedia } from '../crypto';
import { asActor, asSystem } from '../db';
import { badRequest, forbidden, notFound } from '../errors';
import { publish } from '../redis';
import { emit } from '../util';
import type { Actor } from './identity';

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
const AUDIO_MIMES = new Set(['audio/webm', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/3gpp']);
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_AUDIO = 3 * 1024 * 1024; // about 60 seconds of compressed speech
const URL_TTL_SEC = 300;

let s3: S3Client | null = null;
const s3Client = () =>
  (s3 ??= new S3Client({ region: config.S3_REGION, ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT, forcePathStyle: true } : {}) }));

const localPath = (key: string) => join(config.mediaLocalDir, key);

export async function writeObject(key: string, data: Buffer, mime: string) {
  if (config.MEDIA_STORAGE === 's3') {
    await s3Client().send(new PutObjectCommand({ Bucket: config.S3_BUCKET!, Key: key, Body: data, ContentType: mime }));
    return;
  }
  await mkdir(dirname(localPath(key)), { recursive: true });
  await writeFile(localPath(key), data);
}

export async function readObject(key: string): Promise<Buffer> {
  if (config.MEDIA_STORAGE === 's3') {
    const out = await s3Client().send(new GetObjectCommand({ Bucket: config.S3_BUCKET!, Key: key }));
    return Buffer.from(await out.Body!.transformToByteArray());
  }
  return readFile(localPath(key));
}

export async function deleteObject(key: string) {
  if (config.MEDIA_STORAGE === 's3') {
    await s3Client().send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET!, Key: key })).catch(() => undefined);
    return;
  }
  await rm(localPath(key), { force: true });
}

// Relative on purpose: each app joins it to the server address it already uses, so files keep
// working when that address changes (a new tunnel, a new domain) without touching server settings.
function signedLocalUrl(path: string) {
  const exp = Math.floor(Date.now() / 1000) + URL_TTL_SEC;
  return `${path}?exp=${exp}&sig=${signMedia(`${path}:${exp}`)}`;
}

export function checkLocalSignature(path: string, exp: string | undefined, sig: string | undefined) {
  if (!exp || !sig || Number(exp) < Date.now() / 1000 || !verifyMedia(`${path}:${exp}`, sig)) throw forbidden('bad_signature');
}

export async function createUpload(actor: Actor, body: { kind: 'image' | 'audio'; mime: string; bytes: number; conversationId?: string }) {
  const mime = body.mime.split(';')[0]!.trim().toLowerCase();
  if (body.kind === 'image' && (!IMAGE_MIMES.has(mime) || body.bytes > MAX_IMAGE)) throw badRequest('unsupported_image');
  if (body.kind === 'audio' && (!AUDIO_MIMES.has(mime) || body.bytes > MAX_AUDIO)) throw badRequest('unsupported_audio');

  const asset = await asActor(actor.accountId, async (tx) => {
    if (body.conversationId) {
      // Row-level security hides conversations the actor is not part of.
      const conv = await tx.maybeOne(`SELECT id FROM conversations WHERE id = $1 AND status = 'open'`, [body.conversationId]);
      if (!conv) throw notFound('conversation_not_found');
    }
    return tx.one(
      `INSERT INTO media_assets(owner_id, conversation_id, kind, object_key, mime, bytes, expires_at)
       VALUES ($1, $2, $3, 'pending', $4, $5, CASE WHEN $3 = 'audio' AND $2::uuid IS NULL THEN now() + interval '1 hour' END) RETURNING id`,
      [actor.accountId, body.conversationId ?? null, body.kind, mime, body.bytes],
    );
  });
  const key = `${body.kind}/${asset.id}/original`;
  await asActor(actor.accountId, (tx) => tx.exec(`UPDATE media_assets SET object_key = $2 WHERE id = $1`, [asset.id, key]));

  if (config.MEDIA_STORAGE === 's3') {
    const uploadUrl = await getSignedUrl(
      s3Client(),
      new PutObjectCommand({ Bucket: config.S3_BUCKET!, Key: key, ContentType: mime, ContentLength: body.bytes }),
      { expiresIn: URL_TTL_SEC },
    );
    return { assetId: asset.id as string, uploadUrl, needsComplete: true };
  }
  return { assetId: asset.id as string, uploadUrl: signedLocalUrl(`/v1/media/upload/${asset.id}`), needsComplete: false };
}

// Local storage only: the API receives the bytes on the signed URL.
export async function receiveLocalUpload(assetId: string, data: Buffer) {
  const asset = await asSystem((tx) => tx.maybeOne(`SELECT * FROM media_assets WHERE id = $1 AND scan_state = 'pending'`, [assetId]));
  if (!asset) throw notFound();
  const limit = asset.kind === 'image' ? MAX_IMAGE : MAX_AUDIO;
  if (data.length === 0 || data.length > limit) throw badRequest('bad_size');
  await writeObject(asset.object_key, data, asset.mime);
  await markUploaded(assetId);
}

export async function completeUpload(actor: Actor, assetId: string) {
  const owned = await asActor(actor.accountId, (tx) =>
    tx.maybeOne(`SELECT id FROM media_assets WHERE id = $1 AND owner_id = $2 AND scan_state = 'pending'`, [assetId, actor.accountId]),
  );
  if (!owned) throw notFound();
  await markUploaded(assetId);
}

async function markUploaded(assetId: string) {
  await asSystem(async (tx) => {
    const a = await tx.one(`UPDATE media_assets SET scan_state = 'uploaded' WHERE id = $1 RETURNING kind`, [assetId]);
    // Voice clips are only ever read by their owner's transcription request.
    if (a.kind === 'audio') await tx.exec(`UPDATE media_assets SET scan_state = 'clean' WHERE id = $1`, [assetId]);
    else await emit(tx, 'media.uploaded', 'media', assetId);
  });
}

// Worker: validate that the bytes really are an image, drop metadata such as GPS
// position, and make a thumbnail. Only then can the other party see it (spec §11).
export async function processImage(assetId: string) {
  const asset = await asSystem((tx) => tx.maybeOne(`SELECT * FROM media_assets WHERE id = $1 AND scan_state = 'uploaded'`, [assetId]));
  if (!asset) return;
  try {
    const original = await readObject(asset.object_key);
    // Re-encoding discards EXIF; rotate() first bakes in the orientation it described.
    const clean = await sharp(original, { limitInputPixels: 50_000_000 }).rotate().resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    const thumb = await sharp(clean).resize(360, 360, { fit: 'inside' }).jpeg({ quality: 70 }).toBuffer();
    const base = `image/${assetId}`;
    await writeObject(`${base}/clean.jpg`, clean, 'image/jpeg');
    await writeObject(`${base}/thumb.jpg`, thumb, 'image/jpeg');
    await deleteObject(asset.object_key);
    await asSystem((tx) =>
      tx.exec(`UPDATE media_assets SET scan_state = 'clean', object_key = $2, thumb_key = $3, mime = 'image/jpeg', bytes = $4 WHERE id = $1`, [
        assetId, `${base}/clean.jpg`, `${base}/thumb.jpg`, clean.length,
      ]),
    );
  } catch {
    await deleteObject(asset.object_key);
    await asSystem((tx) => tx.exec(`UPDATE media_assets SET scan_state = 'rejected' WHERE id = $1`, [assetId]));
  }
  if (asset.conversation_id) {
    const conv = await asSystem((tx) => tx.maybeOne(`SELECT requester_id, provider_id FROM conversations WHERE id = $1`, [asset.conversation_id]));
    if (conv) {
      for (const id of [conv.requester_id, conv.provider_id]) await publish(id, { type: 'conversation', conversationId: asset.conversation_id });
    }
  }
}

export async function getMediaUrls(actor: Actor, assetId: string) {
  // Row-level security limits this to the owner and the participants of its conversation.
  const asset = await asActor(actor.accountId, (tx) => tx.maybeOne(`SELECT * FROM media_assets WHERE id = $1 AND (kind = 'image' OR conversation_id IS NOT NULL)`, [assetId]));
  if (!asset) throw notFound();
  if (asset.kind === 'audio') {
    if (asset.scan_state !== 'clean') return { state: asset.scan_state as string, url: null, thumbUrl: null };
    const url = config.MEDIA_STORAGE === 's3'
      ? await getSignedUrl(s3Client(), new GetObjectCommand({ Bucket: config.S3_BUCKET!, Key: asset.object_key }), { expiresIn: URL_TTL_SEC })
      : signedLocalUrl(`/v1/media/file/${assetId}/full`);
    return { state: 'clean', url, thumbUrl: null };
  }
  if (asset.scan_state !== 'clean') return { state: asset.scan_state as string, url: null, thumbUrl: null };
  if (config.MEDIA_STORAGE === 's3') {
    const sign = (Key: string) => getSignedUrl(s3Client(), new GetObjectCommand({ Bucket: config.S3_BUCKET!, Key }), { expiresIn: URL_TTL_SEC });
    return { state: 'clean', url: await sign(asset.object_key), thumbUrl: await sign(asset.thumb_key) };
  }
  return {
    state: 'clean',
    url: signedLocalUrl(`/v1/media/file/${assetId}/full`),
    thumbUrl: signedLocalUrl(`/v1/media/file/${assetId}/thumb`),
  };
}

export async function readLocalFile(assetId: string, variant: string): Promise<{ data: Buffer; mime: string }> {
  const asset = await asSystem((tx) =>
    tx.maybeOne(`SELECT * FROM media_assets WHERE id = $1 AND scan_state = 'clean' AND (kind = 'image' OR conversation_id IS NOT NULL)`, [assetId]),
  );
  if (!asset) throw notFound();
  if (asset.kind === 'audio') return { data: await readObject(asset.object_key), mime: asset.mime };
  return { data: await readObject(variant === 'thumb' ? asset.thumb_key : asset.object_key), mime: 'image/jpeg' };
}

// Voice clips are deleted once transcribed; nothing is retained without separate consent (spec §10).
export async function takeAudio(actor: Actor, assetId: string): Promise<{ data: Buffer; mime: string }> {
  const asset = await asActor(actor.accountId, (tx) =>
    tx.maybeOne(`SELECT * FROM media_assets WHERE id = $1 AND owner_id = $2 AND kind = 'audio' AND scan_state = 'clean' AND conversation_id IS NULL`, [assetId, actor.accountId]),
  );
  if (!asset) throw notFound('audio_not_found');
  const data = await readObject(asset.object_key);
  await deleteObject(asset.object_key);
  await asActor(actor.accountId, (tx) => tx.exec(`UPDATE media_assets SET scan_state = 'rejected', expires_at = now() WHERE id = $1`, [assetId]));
  return { data, mime: asset.mime };
}

export async function purgeExpiredAudio() {
  const rows = await asSystem((tx) =>
    tx.query(`UPDATE media_assets SET scan_state = 'rejected' WHERE kind = 'audio' AND expires_at < now() AND scan_state <> 'rejected' RETURNING object_key`),
  );
  for (const r of rows) await deleteObject(r.object_key);
}
