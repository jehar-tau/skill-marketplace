// Turning what a person says into private capabilities and requests (spec §5.1, §10).

import { CATEGORY_BY_SLUG, type Attributes, type Draft, type InterpretResponse, type Locale } from '@sm/contracts';
import { confirmationText } from '../ai/confirm';
import { activeEmbedder, toVectorLiteral } from '../ai/embeddings';
import { embed, interpret, transcribe } from '../ai/gateway';
import { asActor, type Tx } from '../db';
import { badRequest, notFound } from '../errors';
import { embeddingTable } from '../migrate';
import { rateLimit } from '../redis';
import { cellFor, emit, funnel, h3r8, pointSql } from '../util';
import type { Actor } from './identity';
import { takeAudio } from './media';

export async function interpretUtterance(
  actor: Actor,
  body: { purpose: 'capability' | 'request'; text?: string; audioAssetId?: string; locale?: Locale },
): Promise<InterpretResponse> {
  await rateLimit(`interpret:${actor.accountId}`, 30, 600);
  let text = body.text?.trim();
  let inputType: 'typed_text' | 'voice_clip' = 'typed_text';
  if (!text && body.audioAssetId) {
    const audio = await takeAudio(actor, body.audioAssetId);
    text = await transcribe(audio.data, audio.mime, body.locale);
    inputType = 'voice_clip';
  }
  if (!text) throw badRequest('empty_input');

  const out = await interpret({ purpose: body.purpose, text, localeHint: body.locale });
  // Confirm in the language the person used, not the app's default.
  const locale = out.locale;

  return asActor(actor.accountId, async (tx) => {
    const utt = await tx.one(
      `INSERT INTO utterances(account_id, purpose, input_type, original_text, source_locales, reply_locale)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [actor.accountId, body.purpose, inputType, text, [locale], locale],
    );
    await funnel(tx, actor.accountId, body.purpose === 'capability' ? 'first_utterance' : 'request_utterance');

    const drafts: Draft[] = [];
    for (const item of out.items) {
      const cat = await tx.one(`SELECT id FROM service_categories WHERE slug = $1`, [item.categorySlug]);
      const text2 = confirmationText(locale, body.purpose, item.categorySlug, item.attributes, item.deadlineAt);
      const row = await tx.one(
        `INSERT INTO interpretations(utterance_id, account_id, category_id, canonical_en, source_span, attributes, extra, deadline_at,
           confirmation_text, model_version, prompt_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [utt.id, actor.accountId, cat.id, item.canonicalEn, item.sourceSpan, JSON.stringify(item.attributes), JSON.stringify(item.extra),
         item.deadlineAt, text2, `${out.provider}:${out.modelId}`, out.promptVersion],
      );
      drafts.push({
        interpretationId: row.id,
        categorySlug: item.categorySlug,
        categoryLabel: CATEGORY_BY_SLUG.get(item.categorySlug)!.labels[locale],
        canonicalEn: item.canonicalEn,
        attributes: item.attributes,
        deadlineAt: item.deadlineAt,
        confirmationText: text2,
      });
    }
    return { utteranceId: utt.id, originalText: text!, locale, drafts, needsClarification: out.clarification };
  });
}

async function loadDraft(tx: Tx, actor: Actor, interpretationId: string, purpose: 'capability' | 'request') {
  const row = await tx.maybeOne(
    `SELECT i.*, u.original_text, u.reply_locale, u.purpose, sc.slug, sc.remote_ok
     FROM interpretations i JOIN utterances u ON u.id = i.utterance_id JOIN service_categories sc ON sc.id = i.category_id
     WHERE i.id = $1 AND i.account_id = $2 AND i.status = 'draft' FOR UPDATE OF i`,
    [interpretationId, actor.accountId],
  );
  if (!row || row.purpose !== purpose) throw notFound('draft_not_found');
  return row;
}

// The text that gets embedded: the hidden category first, then the derived English and the original words.
const embedText = (slug: string, canonicalEn: string, original: string) => `${slug} ${canonicalEn} ${original}`;

async function storeEmbedding(tx: Tx, kind: 'capability' | 'request', versionId: string, vector: number[]) {
  const table = embeddingTable(kind, activeEmbedder().modelKey);
  await tx.exec(
    `INSERT INTO ${table}(${kind}_version_id, embedding) VALUES ($1, $2::vector)
     ON CONFLICT (${kind}_version_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
    [versionId, toVectorLiteral(vector)],
  );
}

export async function confirmCapabilities(
  actor: Actor,
  body: { interpretationIds: string[]; location: { lat: number; lng: number }; serviceRadiusM?: number },
) {
  const { lat, lng } = body.location;
  const cell = cellFor(lat, lng);
  // Embed outside the transaction so a slow provider never holds row locks.
  const previews = await asActor(actor.accountId, async (tx) => {
    const out = [];
    for (const id of body.interpretationIds) {
      const d = await tx.maybeOne(
        `SELECT i.id, i.canonical_en, i.source_span, sc.slug FROM interpretations i JOIN service_categories sc ON sc.id = i.category_id
         WHERE i.id = $1 AND i.account_id = $2 AND i.status = 'draft'`,
        [id, actor.accountId],
      );
      if (!d) throw notFound('draft_not_found');
      out.push(d);
    }
    return out;
  });
  const { vectors } = await embed(previews.map((p) => embedText(p.slug, p.canonical_en, p.source_span)));

  return asActor(actor.accountId, async (tx) => {
    const created: string[] = [];
    for (const [i, id] of body.interpretationIds.entries()) {
      const d = await loadDraft(tx, actor, id, 'capability');
      const cap = await tx.one(
        `INSERT INTO capabilities(account_id, cell_id, category_id, status, base_point, service_radius_m, h3_r8, remote_ok)
         VALUES ($1, $2, $3, 'active', ${pointSql(4, 5)}, $6, $7, $8) RETURNING id`,
        [actor.accountId, cell, d.category_id, lng, lat, body.serviceRadiusM ?? 5000, h3r8(lat, lng), d.remote_ok],
      );
      const ver = await tx.one(
        `INSERT INTO capability_versions(capability_id, account_id, version_no, interpretation_id, original_text, source_locale, canonical_en, attributes)
         VALUES ($1,$2,1,$3,$4,$5,$6,$7) RETURNING id`,
        [cap.id, actor.accountId, d.id, d.source_span, d.reply_locale, d.canonical_en, JSON.stringify(d.attributes)],
      );
      await tx.exec(`UPDATE capabilities SET current_version_id = $2 WHERE id = $1`, [cap.id, ver.id]);
      await tx.exec(`UPDATE interpretations SET status = 'confirmed' WHERE id = $1`, [d.id]);
      await tx.elevated(async () => {
        await storeEmbedding(tx, 'capability', ver.id, vectors[i]!);
        await tx.exec(`INSERT INTO capability_trust(capability_id) VALUES ($1)`, [cap.id]);
      });
      await emit(tx, 'capability.activated', 'capability', cap.id, {}, cell);
      created.push(cap.id);
    }
    await tx.exec(`UPDATE accounts SET home_cell_id = $2 WHERE id = $1`, [actor.accountId, cell]);
    await funnel(tx, actor.accountId, 'capability_confirmed');
    return { capabilityIds: created };
  });
}

function capabilityView(r: Record<string, any>) {
  return {
    id: r.id as string,
    status: r.status as string,
    // Shown in the language the app is set to, not the language the service was described in.
    categoryLabel: (r.labels[r.preferred_locale] ?? r.labels.en) as string,
    originalText: r.original_text as string,
    canonicalEn: r.canonical_en as string,
    attributes: r.attributes as Attributes,
    serviceRadiusM: r.service_radius_m as number,
    trust: trustLine({ ...r, verified: r.verified }),
    proofLinks: Number(r.proof_links ?? 0),
    proofPhotos: Number(r.proof_photos ?? 0),
    proofs: ((r.proofs ?? []) as Record<string, any>[]).map((p) => ({ id: p.id as string, kind: p.kind as 'link' | 'photo', url: p.url as string | null, mediaAssetId: p.media_asset_id as string | null })),
    experience: (r.experience ?? null) as 'business' | 'informal' | 'new' | null,
    experienceNote: (r.experience_note ?? null) as string | null,
    createdAt: r.created_at as Date,
  };
}

export function trustLine(r: Record<string, any>) {
  const completedJobs = (r.completed_jobs ?? 0) as number;
  const ratingCount = (r.rating_count ?? 0) as number;
  return {
    registeredBusiness: !!r.verified,
    completedJobs,
    ratingAvg: ratingCount > 0 ? Math.round((r.rating_avg as number) * 10) / 10 : null,
    ratingCount,
    isNew: completedJobs === 0,
  };
}

export async function listCapabilities(actor: Actor) {
  return asActor(actor.accountId, async (tx) => {
    const rows = await tx.query(
      `SELECT c.*, cv.original_text, cv.canonical_en, cv.attributes, cv.source_locale, sc.labels,
              (SELECT preferred_locale FROM accounts WHERE id = c.account_id) AS preferred_locale,
              ct.completed_jobs, ct.rating_avg, ct.rating_count,
              (SELECT count(*) FROM capability_proofs p WHERE p.capability_id = c.id AND p.kind = 'link') AS proof_links,
              (SELECT count(*) FROM capability_proofs p WHERE p.capability_id = c.id AND p.kind = 'photo') AS proof_photos,
              (SELECT coalesce(json_agg(json_build_object('id', p.id, 'kind', p.kind, 'url', p.url, 'media_asset_id', p.media_asset_id) ORDER BY p.created_at), '[]')
                 FROM capability_proofs p WHERE p.capability_id = c.id) AS proofs,
              EXISTS (SELECT 1 FROM verifications v WHERE v.account_id = c.account_id AND v.kind = 'udyam' AND v.state = 'verified') AS verified
       FROM capabilities c JOIN capability_versions cv ON cv.id = c.current_version_id
       JOIN service_categories sc ON sc.id = c.category_id LEFT JOIN capability_trust ct ON ct.capability_id = c.id
       WHERE c.account_id = $1 AND c.status <> 'removed' ORDER BY c.created_at DESC`,
      [actor.accountId],
    );
    return rows.map(capabilityView);
  });
}

export async function patchCapability(
  actor: Actor,
  id: string,
  patch: { status?: 'active' | 'paused' | 'removed'; serviceRadiusM?: number; experience?: 'business' | 'informal' | 'new' | null; experienceNote?: string | null },
) {
  await asActor(actor.accountId, async (tx) => {
    // experience fields: undefined leaves them alone, null clears them.
    const row = await tx.maybeOne(
      `UPDATE capabilities SET status = COALESCE($3, status), service_radius_m = COALESCE($4, service_radius_m),
              experience = CASE WHEN $5 THEN $6 ELSE experience END,
              experience_note = CASE WHEN $7 THEN $8 ELSE experience_note END, updated_at = now()
       WHERE id = $1 AND account_id = $2 AND status <> 'removed' RETURNING id, status, cell_id`,
      [id, actor.accountId, patch.status ?? null, patch.serviceRadiusM ?? null,
        patch.experience !== undefined, patch.experience ?? null,
        patch.experienceNote !== undefined, patch.experienceNote ? patch.experienceNote : null],
    );
    if (!row) throw notFound('capability_not_found');
    if (patch.status === 'active') await emit(tx, 'capability.activated', 'capability', id, {}, row.cell_id);
  });
}

export async function confirmRequest(actor: Actor, body: { interpretationId: string; location: { lat: number; lng: number } }) {
  await rateLimit(`request:${actor.accountId}`, 10, 3600);
  const { lat, lng } = body.location;
  const cell = cellFor(lat, lng);
  const preview = await asActor(actor.accountId, (tx) =>
    tx.maybeOne(
      `SELECT i.canonical_en, u.original_text, sc.slug FROM interpretations i JOIN utterances u ON u.id = i.utterance_id
       JOIN service_categories sc ON sc.id = i.category_id WHERE i.id = $1 AND i.account_id = $2 AND i.status = 'draft'`,
      [body.interpretationId, actor.accountId],
    ),
  );
  if (!preview) throw notFound('draft_not_found');
  const { vectors } = await embed([embedText(preview.slug, preview.canonical_en, preview.original_text)]);

  return asActor(actor.accountId, async (tx) => {
    const d = await loadDraft(tx, actor, body.interpretationId, 'request');
    if (d.deadline_at && d.deadline_at < new Date()) throw badRequest('deadline_passed');
    const req = await tx.one(
      `INSERT INTO requests(account_id, cell_id, category_id, status, point, h3_r8, deadline_at, expires_at)
       VALUES ($1, $2, $3, 'confirmed', ${pointSql(4, 5)}, $6, $7, COALESCE($7, now() + interval '48 hours')) RETURNING id`,
      [actor.accountId, cell, d.category_id, lng, lat, h3r8(lat, lng), d.deadline_at],
    );
    // The confirmed version is immutable; an edit creates a new request.
    const ver = await tx.one(
      `INSERT INTO request_versions(request_id, version_no, interpretation_id, original_text, source_locale, canonical_en, attributes)
       VALUES ($1,1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.id, d.id, d.original_text, d.reply_locale, d.canonical_en, JSON.stringify(d.attributes)],
    );
    await tx.exec(`UPDATE requests SET current_version_id = $2 WHERE id = $1`, [req.id, ver.id]);
    await tx.exec(`UPDATE interpretations SET status = 'confirmed' WHERE id = $1`, [d.id]);
    await tx.elevated(() => storeEmbedding(tx, 'request', ver.id, vectors[0]!));
    await emit(tx, 'request.confirmed', 'request', req.id, {}, cell);
    await funnel(tx, actor.accountId, 'request_confirmed');
    return { requestId: req.id as string };
  });
}

export async function rejectDraft(actor: Actor, interpretationId: string) {
  await asActor(actor.accountId, (tx) =>
    tx.exec(`UPDATE interpretations SET status = 'rejected' WHERE id = $1 AND account_id = $2 AND status = 'draft'`, [interpretationId, actor.accountId]),
  );
}

// Re-describing a service keeps its history, ratings and job count: the new
// wording becomes a new version of the same capability.
export async function reviseCapability(actor: Actor, capabilityId: string, interpretationId: string) {
  const preview = await asActor(actor.accountId, (tx) =>
    tx.maybeOne(
      `SELECT i.canonical_en, i.source_span, sc.slug FROM interpretations i JOIN service_categories sc ON sc.id = i.category_id
       WHERE i.id = $1 AND i.account_id = $2 AND i.status = 'draft'`,
      [interpretationId, actor.accountId],
    ),
  );
  if (!preview) throw notFound('draft_not_found');
  const { vectors } = await embed([embedText(preview.slug, preview.canonical_en, preview.source_span)]);

  await asActor(actor.accountId, async (tx) => {
    const cap = await tx.maybeOne(`SELECT id, cell_id FROM capabilities WHERE id = $1 AND account_id = $2 AND status <> 'removed' FOR UPDATE`, [
      capabilityId, actor.accountId,
    ]);
    if (!cap) throw notFound('capability_not_found');
    const d = await loadDraft(tx, actor, interpretationId, 'capability');
    const last = await tx.one(`SELECT COALESCE(max(version_no), 0) AS n FROM capability_versions WHERE capability_id = $1`, [capabilityId]);
    const ver = await tx.one(
      `INSERT INTO capability_versions(capability_id, account_id, version_no, interpretation_id, original_text, source_locale, canonical_en, attributes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [capabilityId, actor.accountId, last.n + 1, d.id, d.source_span, d.reply_locale, d.canonical_en, JSON.stringify(d.attributes)],
    );
    await tx.exec(`UPDATE capabilities SET current_version_id = $2, category_id = $3, remote_ok = $4, updated_at = now() WHERE id = $1`, [
      capabilityId, ver.id, d.category_id, d.remote_ok,
    ]);
    await tx.exec(`UPDATE interpretations SET status = 'confirmed' WHERE id = $1`, [d.id]);
    await tx.elevated(() => storeEmbedding(tx, 'capability', ver.id, vectors[0]!));
    await emit(tx, 'capability.activated', 'capability', capabilityId, {}, cap.cell_id);
  });
}

// Where the provider works and how far they travel. Applies to all their services.
export async function getServiceArea(actor: Actor) {
  return asActor(actor.accountId, async (tx) => {
    const r = await tx.maybeOne(
      `SELECT service_radius_m, cell_id FROM capabilities WHERE account_id = $1 AND status <> 'removed' ORDER BY created_at LIMIT 1`,
      [actor.accountId],
    );
    return r ? { serviceRadiusM: r.service_radius_m as number, cellId: r.cell_id as string } : null;
  });
}

export async function setServiceArea(actor: Actor, body: { serviceRadiusM?: number; location?: { lat: number; lng: number } }) {
  await asActor(actor.accountId, async (tx) => {
    if (body.serviceRadiusM) {
      await tx.exec(`UPDATE capabilities SET service_radius_m = $2, updated_at = now() WHERE account_id = $1 AND status <> 'removed'`, [
        actor.accountId, body.serviceRadiusM,
      ]);
    }
    if (body.location) {
      const { lat, lng } = body.location;
      const cell = cellFor(lat, lng);
      await tx.exec(
        `UPDATE capabilities SET base_point = ${pointSql(2, 3)}, cell_id = $4, h3_r8 = $5, updated_at = now() WHERE account_id = $1 AND status <> 'removed'`,
        [actor.accountId, lng, lat, cell, h3r8(lat, lng)],
      );
      await tx.exec(`UPDATE accounts SET home_cell_id = $2 WHERE id = $1`, [actor.accountId, cell]);
    }
    // A wider or moved area may now cover requests that are still open.
    const caps = await tx.query(`SELECT id, cell_id FROM capabilities WHERE account_id = $1 AND status = 'active'`, [actor.accountId]);
    for (const c of caps) await emit(tx, 'capability.activated', 'capability', c.id, {}, c.cell_id);
  });
  return getServiceArea(actor);
}

// ---------------------------------------------------------------- proof of work
// Optional. A provider can add links and photos to a talent whenever they like.

const MAX_PROOFS = 12;

// Accepts a full address, a bare domain, or an Instagram handle like "@name".
export function normaliseProofLink(raw: string): string | null {
  let v = raw.trim();
  if (!v || v.length > 300 || /\s/.test(v)) return null;
  if (/^@[A-Za-z0-9._]{1,30}$/.test(v)) v = `https://instagram.com/${v.slice(1)}`;
  else if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function ownCapability(tx: Tx, actor: Actor, capabilityId: string) {
  const cap = await tx.maybeOne(`SELECT id FROM capabilities WHERE id = $1 AND account_id = $2 AND status <> 'removed'`, [capabilityId, actor.accountId]);
  if (!cap) throw notFound('capability_not_found');
}

export async function listProofs(actor: Actor, capabilityId: string) {
  return asActor(actor.accountId, async (tx) => {
    await ownCapability(tx, actor, capabilityId);
    const rows = await tx.query(`SELECT id, kind, url, media_asset_id, created_at FROM capability_proofs WHERE capability_id = $1 ORDER BY created_at`, [capabilityId]);
    return rows.map((r) => ({ id: r.id as string, kind: r.kind as 'link' | 'photo', url: r.url as string | null, mediaAssetId: r.media_asset_id as string | null }));
  });
}

export async function addProof(actor: Actor, capabilityId: string, body: { link?: string; mediaAssetId?: string }) {
  await asActor(actor.accountId, async (tx) => {
    await ownCapability(tx, actor, capabilityId);
    const n = await tx.one(`SELECT count(*) AS n FROM capability_proofs WHERE capability_id = $1`, [capabilityId]);
    if (Number(n.n) >= MAX_PROOFS) throw badRequest('too_many_proofs');
    if (body.link !== undefined) {
      const url = normaliseProofLink(body.link);
      if (!url) throw badRequest('bad_link');
      await tx.exec(`INSERT INTO capability_proofs(capability_id, account_id, kind, url) VALUES ($1, $2, 'link', $3)`, [capabilityId, actor.accountId, url]);
    } else if (body.mediaAssetId) {
      const asset = await tx.maybeOne(`SELECT id FROM media_assets WHERE id = $1 AND owner_id = $2 AND kind = 'image' AND conversation_id IS NULL`, [
        body.mediaAssetId, actor.accountId,
      ]);
      if (!asset) throw badRequest('media_not_found');
      await tx.exec(`INSERT INTO capability_proofs(capability_id, account_id, kind, media_asset_id) VALUES ($1, $2, 'photo', $3)`, [
        capabilityId, actor.accountId, body.mediaAssetId,
      ]);
      await emit(tx, 'proof.added', 'media', body.mediaAssetId, { capabilityId });
    } else {
      throw badRequest('empty_proof');
    }
  });
  return listProofs(actor, capabilityId);
}

export async function removeProof(actor: Actor, proofId: string) {
  await asActor(actor.accountId, async (tx) => {
    const p = await tx.maybeOne(`DELETE FROM capability_proofs WHERE id = $1 AND account_id = $2 RETURNING media_asset_id`, [proofId, actor.accountId]);
    if (!p) throw notFound('proof_not_found');
    // One photo can back several businesses described together; keep it while any still uses it.
    if (p.media_asset_id) {
      await tx.exec(
        `UPDATE media_assets SET scan_state = 'rejected' WHERE id = $1 AND owner_id = $2
           AND NOT EXISTS (SELECT 1 FROM capability_proofs WHERE media_asset_id = $1)`,
        [p.media_asset_id, actor.accountId],
      );
    }
  });
}
