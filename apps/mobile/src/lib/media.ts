import { api } from './api';
import { mediaUrl } from './config';

// Uploads one picked photo to private storage and returns its id.
export async function uploadImage(uri: string, mimeType?: string | null): Promise<string> {
  const blob = await (await fetch(uri)).blob();
  const mime = (mimeType ?? blob.type ?? 'image/jpeg').split(';')[0]!;
  const up = await api('/v1/media', { body: { kind: 'image', mime, bytes: blob.size } });
  const put = await fetch(mediaUrl(up.uploadUrl), { method: 'PUT', headers: { 'content-type': mime }, body: blob });
  if (!put.ok) throw new Error('upload');
  if (up.needsComplete) await api(`/v1/media/${up.assetId}/complete`, { method: 'POST' });
  return up.assetId as string;
}
