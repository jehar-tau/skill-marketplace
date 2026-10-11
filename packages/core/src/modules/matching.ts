// Matching and bounded dispatch (spec §7). No model is called here: candidates
// come from SQL filters plus stored embeddings, so cost does not grow with the
// number of providers notified.

import { attributeMismatch, compatibleCategories, type Attributes } from '@sm/contracts';
import { activeEmbedder } from '../ai/embeddings';
import { config } from '../config';
import { asActor, asSystem, type Tx } from '../db';
import { conflict, forbidden, notFound } from '../errors';
import { embeddingTable } from '../migrate';
import { publish } from '../redis';
import { emit } from '../util';
import type { Actor } from './identity';
import { trustLine } from './intake';

const OPEN_STATUSES = ['confirmed', 'dispatching', 'responded', 'no_match'];
const SIBLING_MIN_SIMILARITY = 0.72;
const STOPWORDS = new Set(['needs', 'offers', 'need', 'offer', 'the', 'and', 'for', 'with', 'from', 'that', 'this', 'want', 'wanted', 'please',
  'मला', 'मुझे', 'पाहिजे', 'चाहिए', 'आहे', 'है', 'हवे', 'आणि', 'और', 'मी', 'मैं', 'करतो', 'करते', 'येते', 'शकतो']);

export function tokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t)),
  );
}

interface RequestRow {
  id: string;
  account_id: string;
  cell_id: string;
  category_id: number;
  status: string;
  deadline_at: Date | null;
  expires_at: Date;
  version_id: string;
  attributes: Attributes;
  original_text: string;
  canonical_en: string;
  slug: string;
  remote_ok: boolean;
}

export interface Candidate {
  capabilityId: string;
  providerAccountId: string;
  relevance: number;
  score: number;
  isNewProvider: boolean;
}

async function loadRequest(tx: Tx, requestId: string, lock: boolean): Promise<RequestRow | null> {
  return tx.maybeOne<RequestRow>(
    `SELECT r.id, r.account_id, r.cell_id, r.category_id, r.status, r.deadline_at, r.expires_at,
            rv.id AS version_id, rv.attributes, rv.original_text, rv.canonical_en, sc.slug, sc.remote_ok
     FROM requests r JOIN request_versions rv ON rv.id = r.current_version_id JOIN service_categories sc ON sc.id = r.category_id
     WHERE r.id = $1 ${lock ? 'FOR UPDATE OF r' : ''}`,
    [requestId],
  );
}

async function activeConfig(tx: Tx) {
  const row = await tx.maybeOne(`SELECT floor, weights FROM matching_config WHERE active AND model_key = $1 ORDER BY version DESC LIMIT 1`, [
    activeEmbedder().modelKey,
  ]);
  return {
    floor: (row?.floor as number | undefined) ?? activeEmbedder().defaultFloor,
    weights: { semantic: 0.75, lexical: 0.25, sameLeafBonus: 0.05, ...(row?.weights ?? {}) } as { semantic: number; lexical: number; sameLeafBonus: number },
  };
}

// Hard filters in SQL, then relevance and ranking in memory over the small surviving set (spec §7.3).
export async function findCandidates(tx: Tx, req: RequestRow, opts: { onlyCapabilityId?: string } = {}): Promise<Candidate[]> {
  const model = activeEmbedder().modelKey;
  const capEmb = embeddingTable('capability', model);
  const reqEmb = embeddingTable('request', model);
  const rows = await tx.query(
    `SELECT c.id AS capability_id, c.account_id, c.service_radius_m, c.remote_ok AS cap_remote, sc.slug,
            cv.attributes, cv.original_text, cv.canonical_en,
            1 - (ce.embedding <=> re.embedding) AS sim,
            ST_Distance(c.base_point, r.point) AS dist_m,
            COALESCE(ct.completed_jobs, 0) AS completed_jobs, ct.rating_avg, COALESCE(ct.rating_count, 0) AS rating_count,
            COALESCE(ct.notified_count, 0) AS notified_count, COALESCE(ct.responded_count, 0) AS responded_count,
            ps.ignored_streak,
            (SELECT count(*) FROM matches m2 WHERE m2.provider_account_id = c.account_id AND m2.created_at > now() - interval '24 hours') AS n24
     FROM requests r
     JOIN ${reqEmb} re ON re.request_version_id = r.current_version_id
     JOIN capabilities c ON c.status = 'active' AND c.account_id <> r.account_id
     JOIN service_categories sc ON sc.id = c.category_id
     JOIN capability_versions cv ON cv.id = c.current_version_id
     JOIN ${capEmb} ce ON ce.capability_version_id = cv.id
     JOIN accounts a ON a.id = c.account_id AND a.status = 'active'
     JOIN provider_settings ps ON ps.account_id = c.account_id
     LEFT JOIN capability_trust ct ON ct.capability_id = c.id
     WHERE r.id = $1
       AND (sc.slug = ANY($2) OR (position('.' in sc.slug) > 0 AND split_part(sc.slug, '.', 1) = $5))
       AND ($4::uuid IS NULL OR c.id = $4)
       AND (
         (c.cell_id = r.cell_id AND ST_DWithin(c.base_point, r.point, c.service_radius_m))
         OR (c.remote_ok AND $3)
       )
       AND NOT ps.paused
       AND NOT (
         CASE WHEN ps.quiet_start <= ps.quiet_end
           THEN (now() AT TIME ZONE 'Asia/Kolkata')::time >= ps.quiet_start AND (now() AT TIME ZONE 'Asia/Kolkata')::time < ps.quiet_end
           ELSE (now() AT TIME ZONE 'Asia/Kolkata')::time >= ps.quiet_start OR (now() AT TIME ZONE 'Asia/Kolkata')::time < ps.quiet_end
         END
       )
       AND NOT EXISTS (
         SELECT 1 FROM blocks b
         WHERE (b.blocker_id = r.account_id AND b.blocked_id = c.account_id) OR (b.blocker_id = c.account_id AND b.blocked_id = r.account_id)
       )
       AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.request_id = r.id AND m.provider_account_id = c.account_id)
       AND (SELECT count(*) FROM matches m3 WHERE m3.provider_account_id = c.account_id AND m3.created_at > now() - interval '24 hours') < ps.daily_cap
     ORDER BY sim DESC
     LIMIT 2000`,
    [req.id, compatibleCategories(req.slug), req.remote_ok, opts.onlyCapabilityId ?? null, req.slug.split('.')[0]],
  );

  const { floor, weights } = await activeConfig(tx);
  const reqTokens = tokens(`${req.original_text} ${req.canonical_en}`);
  const hoursUntilDeadline = req.deadline_at ? (req.deadline_at.getTime() - Date.now()) / 3_600_000 : undefined;

  const compatible = new Set(compatibleCategories(req.slug));
  const bestPerAccount = new Map<string, Candidate>();
  for (const r of rows) {
    if (attributeMismatch(req.attributes, r.attributes as Attributes, { hoursUntilDeadline }) !== null) continue;
    // The category is assigned by a language model and can be wrong on either side.
    // A capability filed under a sibling category (same family, e.g. two kinds of
    // teaching) is still considered, but only when the meaning is a strong match.
    if (!compatible.has(r.slug) && r.sim < SIBLING_MIN_SIMILARITY) continue;

    const capTokens = tokens(`${r.original_text} ${r.canonical_en}`);
    let overlap = 0;
    for (const t of reqTokens) if (capTokens.has(t)) overlap++;
    const lexical = reqTokens.size ? overlap / reqTokens.size : 0;
    const relevance = weights.semantic * Math.max(0, r.sim) + weights.lexical * lexical + (r.slug === req.slug ? weights.sameLeafBonus : 0);
    // Below the floor a provider is never notified, however few candidates there are (spec §7.4).
    if (relevance < floor) continue;

    const bayesRating = ((r.rating_avg ?? 0) * r.rating_count + 4 * 3) / (r.rating_count + 3);
    const trustPrior = 0.85 + 0.15 * (bayesRating / 5);
    const responsiveness = 0.8 + 0.2 * ((r.responded_count + 1) / (r.notified_count + 2));
    const inArea = r.dist_m <= r.service_radius_m;
    const distanceDecay = inArea ? 1 / (1 + (0.5 * r.dist_m) / r.service_radius_m) : 0.85;
    // Cooldown: the more a provider has been pinged today, the further back they go,
    // so a few popular providers do not absorb every request.
    const fairness = 1 / (1 + 0.1 * r.n24);
    const attention = 1 / (1 + 0.15 * r.ignored_streak);
    const score = relevance * trustPrior * responsiveness * distanceDecay * fairness * attention;

    const cand: Candidate = {
      capabilityId: r.capability_id,
      providerAccountId: r.account_id,
      relevance,
      score,
      isNewProvider: r.completed_jobs === 0,
    };
    const prev = bestPerAccount.get(r.account_id);
    if (!prev || cand.score > prev.score) bestPerAccount.set(r.account_id, cand);
  }
  return [...bestPerAccount.values()].sort((a, b) => b.score - a.score);
}

// Top N by score, with the last slot held for the best not-yet-proven provider so
// newcomers can earn a first job (spec §7.3 step 4).
export function pickWave(ranked: Candidate[], size: number): (Candidate & { exploration: boolean })[] {
  const top = ranked.slice(0, size).map((c) => ({ ...c, exploration: false }));
  if (ranked.length <= size || top.some((c) => c.isNewProvider)) return top;
  const newcomer = ranked.slice(size).find((c) => c.isNewProvider);
  if (newcomer) top[top.length - 1] = { ...newcomer, exploration: true };
  return top;
}

async function createWave(tx: Tx, req: RequestRow, picks: (Candidate & { exploration: boolean })[]) {
  const last = await tx.one(`SELECT COALESCE(max(wave_no), 0) AS n FROM dispatch_waves WHERE request_id = $1`, [req.id]);
  const urgent = req.deadline_at !== null && req.deadline_at.getTime() - Date.now() < 3 * 3_600_000;
  const expirySec = urgent ? Math.min(config.WAVE_EXPIRY_SECONDS, 300) : config.WAVE_EXPIRY_SECONDS;
  const wave = await tx.one(
    `INSERT INTO dispatch_waves(request_id, request_version_id, wave_no, expires_at)
     VALUES ($1, $2, $3, now() + $4 * interval '1 second') RETURNING id, expires_at`,
    [req.id, req.version_id, last.n + 1, expirySec],
  );
  let inserted = 0;
  for (const [i, p] of picks.entries()) {
    const m = await tx.maybeOne(
      `INSERT INTO matches(request_id, wave_id, capability_id, provider_account_id, requester_account_id, cell_id, score, rank, is_exploration)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (request_id, provider_account_id) DO NOTHING RETURNING id`,
      [req.id, wave.id, p.capabilityId, p.providerAccountId, req.account_id, req.cell_id, p.score, i + 1, p.exploration],
    );
    if (!m) continue;
    inserted++;
    await tx.exec(`INSERT INTO lead_events(provider_account_id, match_id, kind) VALUES ($1, $2, 'notified')`, [p.providerAccountId, m.id]);
    await tx.exec(`UPDATE capability_trust SET notified_count = notified_count + 1 WHERE capability_id = $1`, [p.capabilityId]);
  }
  if (inserted === 0) {
    await tx.exec(`UPDATE dispatch_waves SET state = 'closed' WHERE id = $1`, [wave.id]);
    return null;
  }
  await tx.exec(`UPDATE requests SET status = CASE WHEN status = 'responded' THEN status ELSE 'dispatching' END, updated_at = now() WHERE id = $1`, [req.id]);
  await emit(tx, 'wave.created', 'wave', wave.id, { requestId: req.id, expirySec }, req.cell_id);
  return wave.id as string;
}

// Idempotent: safe to run again for the same request at any time.
export async function dispatchRequest(requestId: string): Promise<{ waveId: string | null; reason?: string }> {
  const result = await asSystem(async (tx) => {
    const req = await loadRequest(tx, requestId, true);
    if (!req || !OPEN_STATUSES.includes(req.status)) return { waveId: null, reason: 'closed' };
    if (req.expires_at.getTime() < Date.now()) {
      await tx.exec(`UPDATE requests SET status = 'expired', updated_at = now() WHERE id = $1`, [req.id]);
      return { waveId: null, reason: 'expired', notify: req.account_id };
    }
    if (await tx.maybeOne(`SELECT 1 FROM dispatch_waves WHERE request_id = $1 AND state = 'open'`, [req.id])) return { waveId: null, reason: 'wave_open' };
    const stats = await tx.one(
      `SELECT (SELECT count(*) FROM dispatch_waves WHERE request_id = $1) AS waves,
              (SELECT count(*) FROM matches WHERE request_id = $1) AS notified,
              (SELECT count(*) FROM matches WHERE request_id = $1 AND state = 'interested') AS interested`,
      [req.id],
    );
    if (stats.interested >= 2) return { waveId: null, reason: 'enough_responses' };
    if (stats.notified >= config.WAVE_SIZE * config.MAX_WAVES) return { waveId: null, reason: 'max_waves' };

    const ranked = await findCandidates(tx, req);
    if (ranked.length === 0) {
      if (stats.notified === 0 && req.status !== 'no_match') {
        // Stays open: a matching capability activated later is offered this request.
        await tx.exec(`UPDATE requests SET status = 'no_match', updated_at = now() WHERE id = $1`, [req.id]);
        return { waveId: null, reason: 'no_match', notify: req.account_id };
      }
      return { waveId: null, reason: 'no_candidates' };
    }
    const room = config.WAVE_SIZE * config.MAX_WAVES - stats.notified;
    const waveId = await createWave(tx, req, pickWave(ranked, Math.min(config.WAVE_SIZE, room)));
    return { waveId, notify: req.account_id };
  });
  if ('notify' in result && result.notify) await publish(result.notify, { type: 'request', requestId });
  return { waveId: result.waveId, reason: result.reason };
}

// A newly activated capability is offered any still-open request it fits.
export async function matchNewCapability(capabilityId: string): Promise<number> {
  const open = await asSystem((tx) =>
    tx.query(
      `SELECT r.id FROM capabilities c
       JOIN requests r ON r.status = ANY($2) AND r.expires_at > now() AND r.account_id <> c.account_id
         AND ((r.cell_id = c.cell_id AND ST_DWithin(c.base_point, r.point, c.service_radius_m)) OR c.remote_ok)
       WHERE c.id = $1 AND c.status = 'active'
       ORDER BY r.created_at DESC LIMIT 20`,
      [capabilityId, ['dispatching', 'responded', 'no_match']],
    ),
  );
  let made = 0;
  for (const { id } of open) {
    const res = await asSystem(async (tx) => {
      const req = await loadRequest(tx, id, true);
      if (!req || !OPEN_STATUSES.includes(req.status)) return null;
      const stats = await tx.one(
        `SELECT (SELECT count(*) FROM matches WHERE request_id = $1) AS notified,
                (SELECT count(*) FROM matches WHERE request_id = $1 AND state = 'interested') AS interested`,
        [id],
      );
      if (stats.interested >= 2 || stats.notified >= config.WAVE_SIZE * config.MAX_WAVES) return null;
      const ranked = await findCandidates(tx, req, { onlyCapabilityId: capabilityId });
      if (ranked.length === 0) return null;
      const waveId = await createWave(tx, req, [{ ...ranked[0]!, exploration: false }]);
      return waveId ? req.account_id : null;
    });
    if (res) {
      made++;
      await publish(res, { type: 'request', requestId: id });
    }
  }
  return made;
}

export async function expireWave(waveId: string): Promise<void> {
  const requestId = await asSystem(async (tx) => {
    const wave = await tx.maybeOne(`UPDATE dispatch_waves SET state = 'closed' WHERE id = $1 AND state = 'open' RETURNING request_id`, [waveId]);
    if (!wave) return null;
    const lapsed = await tx.query(
      `UPDATE matches SET state = 'expired' WHERE wave_id = $1 AND state IN ('notified', 'seen') RETURNING provider_account_id, state`,
      [waveId],
    );
    if (lapsed.length) {
      // Providers who keep letting requests lapse are ranked lower and nudged to pause (spec §6).
      await tx.exec(`UPDATE provider_settings SET ignored_streak = ignored_streak + 1 WHERE account_id = ANY($1)`, [
        lapsed.map((l) => l.provider_account_id),
      ]);
    }
    return wave.request_id as string;
  });
  if (requestId) await dispatchRequest(requestId);
}

export async function respondToMatch(actor: Actor, matchId: string, action: 'interested' | 'declined') {
  const out = await asActor(actor.accountId, async (tx) => {
    return tx.elevated(async () => {
      const m = await tx.maybeOne(
        `SELECT m.*, r.status AS request_status, r.expires_at, w.state AS wave_state
         FROM matches m JOIN requests r ON r.id = m.request_id JOIN dispatch_waves w ON w.id = m.wave_id
         WHERE m.id = $1 FOR UPDATE OF m`,
        [matchId],
      );
      // Only the notified provider may respond; anyone else sees "not found".
      if (!m || m.provider_account_id !== actor.accountId) throw notFound('match_not_found');
      if (m.state === action) return { conversationId: await conversationIdFor(tx, matchId), requesterId: m.requester_account_id, requestId: m.request_id, changed: false, waveId: m.wave_id };
      if (!['notified', 'seen'].includes(m.state)) throw conflict('match_closed');
      if (!['dispatching', 'responded'].includes(m.request_status) || m.expires_at < new Date()) throw conflict('request_closed');

      await tx.exec(`UPDATE matches SET state = $2, responded_at = now() WHERE id = $1`, [matchId, action]);
      await tx.exec(`UPDATE provider_settings SET ignored_streak = 0 WHERE account_id = $1`, [actor.accountId]);
      await tx.exec(`UPDATE capability_trust SET responded_count = responded_count + 1 WHERE capability_id = $1`, [m.capability_id]);

      let conversationId: string | null = null;
      if (action === 'interested') {
        const conv = await tx.one(
          `INSERT INTO conversations(match_id, request_id, capability_id, requester_id, provider_id, cell_id)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [matchId, m.request_id, m.capability_id, m.requester_account_id, actor.accountId, m.cell_id],
        );
        conversationId = conv.id;
        await tx.exec(`INSERT INTO conversation_participants(conversation_id, account_id) VALUES ($1, $2), ($1, $3)`, [
          conv.id, m.requester_account_id, actor.accountId,
        ]);
        await tx.exec(`INSERT INTO lead_events(provider_account_id, match_id, kind) VALUES ($1, $2, 'interested')`, [actor.accountId, matchId]);
        await tx.exec(`UPDATE requests SET status = 'responded', updated_at = now() WHERE id = $1 AND status = 'dispatching'`, [m.request_id]);
      }
      await emit(tx, 'match.responded', 'match', matchId, { action, requestId: m.request_id, waveId: m.wave_id }, m.cell_id);
      return { conversationId, requesterId: m.requester_account_id as string, requestId: m.request_id as string, changed: true, waveId: m.wave_id as string };
    });
  });
  if (out.changed) {
    await publish(out.requesterId, { type: 'request', requestId: out.requestId });
    await publish(actor.accountId, { type: 'match', matchId });
  }
  return { conversationId: out.conversationId };
}

async function conversationIdFor(tx: Tx, matchId: string): Promise<string | null> {
  return ((await tx.maybeOne(`SELECT id FROM conversations WHERE match_id = $1`, [matchId]))?.id as string | undefined) ?? null;
}

// If every provider in the open wave has declined, move on without waiting for the timer.
export async function closeWaveIfAllDeclined(waveId: string) {
  const done = await asSystem((tx) =>
    tx.maybeOne(
      `SELECT 1 FROM dispatch_waves w WHERE w.id = $1 AND w.state = 'open'
       AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.wave_id = w.id AND m.state <> 'declined')`,
      [waveId],
    ),
  );
  if (done) await expireWave(waveId);
}

export async function listIncoming(actor: Actor) {
  return asActor(actor.accountId, (tx) =>
    tx.elevated(async () => {
      const rows = await tx.query(
        `SELECT m.id, m.state, m.created_at, m.capability_id, w.expires_at AS wave_expires_at, w.state AS wave_state,
                r.status AS request_status, r.deadline_at, rv.original_text, rv.attributes, rv.source_locale,
                sc.labels, a.preferred_locale,
                cv.original_text AS capability_text,
                round((ST_Distance(c.base_point, r.point) / 1000.0)::numeric) AS distance_km,
                rt.completed_jobs, rt.rating_avg, rt.rating_count, ra.display_name AS requester_name,
                conv.id AS conversation_id
         FROM matches m
         JOIN dispatch_waves w ON w.id = m.wave_id
         JOIN requests r ON r.id = m.request_id
         JOIN request_versions rv ON rv.id = r.current_version_id
         JOIN service_categories sc ON sc.id = r.category_id
         JOIN capabilities c ON c.id = m.capability_id
         JOIN capability_versions cv ON cv.id = c.current_version_id
         JOIN accounts a ON a.id = m.provider_account_id
         JOIN accounts ra ON ra.id = m.requester_account_id
         LEFT JOIN requester_trust rt ON rt.account_id = m.requester_account_id
         LEFT JOIN conversations conv ON conv.match_id = m.id
         WHERE m.provider_account_id = $1 AND m.created_at > now() - interval '14 days'
         ORDER BY m.created_at DESC LIMIT 60`,
        [actor.accountId],
      );
      return rows.map((r) => ({
        matchId: r.id as string,
        state: r.state as string,
        open: ['notified', 'seen'].includes(r.state) && ['dispatching', 'responded'].includes(r.request_status),
        requestText: r.original_text as string,
        categoryLabel: (r.labels[r.preferred_locale] ?? r.labels.en) as string,
        attributes: r.attributes as Attributes,
        deadlineAt: r.deadline_at as Date | null,
        // Rounded to the kilometre: enough to judge travel, not enough to locate anyone.
        distanceKm: Number(r.distance_km),
        requesterName: (r.requester_name as string | null) ?? null,
        requesterTrust: trustLine(r),
        capabilityId: r.capability_id as string,
        capabilityText: r.capability_text as string,
        waveExpiresAt: r.wave_expires_at as Date,
        conversationId: (r.conversation_id as string | null) ?? null,
        createdAt: r.created_at as Date,
      }));
    }),
  );
}

export async function listMyRequests(actor: Actor) {
  return asActor(actor.accountId, async (tx) => {
    const rows = await tx.query(
      `SELECT r.id, r.status, r.deadline_at, r.expires_at, r.created_at, rv.original_text, rv.attributes, rv.source_locale, sc.labels,
              a.preferred_locale,
              (SELECT count(*) FROM matches m WHERE m.request_id = r.id) AS notified,
              (SELECT count(*) FROM matches m WHERE m.request_id = r.id AND m.state <> 'notified') AS seen,
              (SELECT count(*) FROM matches m WHERE m.request_id = r.id AND m.state = 'interested') AS interested
       FROM requests r JOIN request_versions rv ON rv.id = r.current_version_id JOIN service_categories sc ON sc.id = r.category_id
       JOIN accounts a ON a.id = r.account_id
       WHERE r.account_id = $1 AND r.created_at > now() - interval '30 days' ORDER BY r.created_at DESC LIMIT 40`,
      [actor.accountId],
    );
    return rows.map(requestSummary);
  });
}

function requestSummary(r: Record<string, any>) {
  return {
    id: r.id as string,
    status: r.status as string,
    originalText: r.original_text as string,
    categoryLabel: (r.labels[r.preferred_locale] ?? r.labels.en) as string,
    attributes: r.attributes as Attributes,
    deadlineAt: r.deadline_at as Date | null,
    expiresAt: r.expires_at as Date,
    createdAt: r.created_at as Date,
    notified: Number(r.notified),
    seen: Number(r.seen),
    interested: Number(r.interested),
  };
}

export async function getRequest(actor: Actor, requestId: string) {
  return asActor(actor.accountId, async (tx) => {
    const r = await tx.maybeOne(
      `SELECT r.id, r.status, r.deadline_at, r.expires_at, r.created_at, rv.original_text, rv.attributes, rv.source_locale, sc.labels,
              a.preferred_locale,
              (SELECT count(*) FROM matches m WHERE m.request_id = r.id) AS notified,
              (SELECT count(*) FROM matches m WHERE m.request_id = r.id AND m.state <> 'notified') AS seen,
              (SELECT count(*) FROM matches m WHERE m.request_id = r.id AND m.state = 'interested') AS interested
       FROM requests r JOIN request_versions rv ON rv.id = r.current_version_id JOIN service_categories sc ON sc.id = r.category_id
       JOIN accounts a ON a.id = r.account_id
       WHERE r.id = $1 AND r.account_id = $2`,
      [requestId, actor.accountId],
    );
    if (!r) throw notFound('request_not_found');
    // The requester sees each responder's matched capability only: one trust line,
    // nothing about that provider's other skills (spec §8.3).
    const responders = await tx.elevated(() =>
      tx.query(
        `SELECT m.id AS match_id, conv.id AS conversation_id, pa.display_name, cv.original_text AS capability_text,
                ct.completed_jobs, ct.rating_avg, ct.rating_count, m.responded_at,
                EXISTS (SELECT 1 FROM verifications v WHERE v.account_id = m.provider_account_id AND v.kind = 'udyam' AND v.state = 'verified') AS verified
         FROM matches m
         JOIN conversations conv ON conv.match_id = m.id
         JOIN accounts pa ON pa.id = m.provider_account_id
         JOIN capabilities c ON c.id = m.capability_id
         JOIN capability_versions cv ON cv.id = c.current_version_id
         LEFT JOIN capability_trust ct ON ct.capability_id = m.capability_id
         WHERE m.request_id = $1 AND m.state IN ('interested', 'filled') AND m.requester_account_id = $2
         ORDER BY m.responded_at`,
        [requestId, actor.accountId],
      ),
    );
    const wave = await tx.maybeOne(`SELECT wave_no, expires_at FROM dispatch_waves WHERE request_id = $1 AND state = 'open'`, [requestId]);
    return {
      ...requestSummary(r),
      openWave: wave ? { waveNo: wave.wave_no as number, expiresAt: wave.expires_at as Date } : null,
      responders: responders.map((p) => ({
        matchId: p.match_id as string,
        conversationId: p.conversation_id as string,
        displayName: (p.display_name as string | null) ?? null,
        capabilityText: p.capability_text as string,
        trust: trustLine(p),
        respondedAt: p.responded_at as Date,
      })),
    };
  });
}

export async function cancelRequest(actor: Actor, requestId: string) {
  const providers = await asActor(actor.accountId, async (tx) => {
    const r = await tx.maybeOne(
      `UPDATE requests SET status = 'cancelled', updated_at = now() WHERE id = $1 AND account_id = $2 AND status = ANY($3) RETURNING id`,
      [requestId, actor.accountId, OPEN_STATUSES],
    );
    if (!r) throw conflict('request_not_open');
    await tx.exec(`UPDATE dispatch_waves SET state = 'closed' WHERE request_id = $1 AND state = 'open'`, [requestId]);
    return tx.query(`UPDATE matches SET state = 'expired' WHERE request_id = $1 AND state IN ('notified', 'seen') RETURNING id, provider_account_id`, [requestId]);
  });
  for (const p of providers) await publish(p.provider_account_id, { type: 'match', matchId: p.id });
}

// Delivery receipt from the app (spec §6). "opened" also marks the match as seen.
export async function acknowledge(actor: Actor, matchId: string, event: 'delivered' | 'opened') {
  const requester = await asActor(actor.accountId, async (tx) => {
    const m = await tx.maybeOne(`SELECT id, state, requester_account_id, request_id FROM matches WHERE id = $1 AND provider_account_id = $2`, [
      matchId, actor.accountId,
    ]);
    if (!m) throw forbidden();
    await tx.exec(
      `UPDATE notification_attempts SET
         delivered_at = COALESCE(delivered_at, now()),
         opened_at = CASE WHEN $2 = 'opened' THEN COALESCE(opened_at, now()) ELSE opened_at END,
         state = CASE WHEN $2 = 'opened' THEN 'opened' WHEN state = 'sent' THEN 'delivered' ELSE state END
       WHERE match_id = $1 AND account_id = $3`,
      [matchId, event, actor.accountId],
    );
    if (event === 'opened' && m.state === 'notified') {
      await tx.exec(`UPDATE matches SET state = 'seen' WHERE id = $1 AND state = 'notified'`, [matchId]);
      return { accountId: m.requester_account_id as string, requestId: m.request_id as string };
    }
    return null;
  });
  if (requester) await publish(requester.accountId, { type: 'request', requestId: requester.requestId });
}

// What a provider sees about their own business: how many leads came, how many
// they answered, and what their reputation is. Private to the provider.
export async function providerSummary(actor: Actor) {
  return asActor(actor.accountId, async (tx) => {
    const r = await tx.one(
      `SELECT
         (SELECT count(*) FROM capabilities WHERE account_id = $1 AND status = 'active') AS active_skills,
         (SELECT count(*) FROM capabilities WHERE account_id = $1 AND status = 'paused') AS paused_skills,
         (SELECT count(*) FROM matches WHERE provider_account_id = $1) AS leads_total,
         (SELECT count(*) FROM matches WHERE provider_account_id = $1 AND created_at > now() - interval '7 days') AS leads_week,
         (SELECT count(*) FROM matches WHERE provider_account_id = $1 AND state IN ('interested', 'filled')) AS replied,
         (SELECT count(*) FROM matches WHERE provider_account_id = $1 AND state = 'expired') AS missed,
         (SELECT COALESCE(sum(ct.completed_jobs), 0) FROM capability_trust ct JOIN capabilities c ON c.id = ct.capability_id WHERE c.account_id = $1) AS jobs_done,
         (SELECT COALESCE(sum(ct.rating_count), 0) FROM capability_trust ct JOIN capabilities c ON c.id = ct.capability_id WHERE c.account_id = $1) AS rating_count,
         (SELECT sum(ct.rating_avg * ct.rating_count) / NULLIF(sum(ct.rating_count), 0) FROM capability_trust ct JOIN capabilities c ON c.id = ct.capability_id WHERE c.account_id = $1) AS rating_avg,
         (SELECT paused FROM provider_settings WHERE account_id = $1) AS paused`,
      [actor.accountId],
    );
    return {
      activeSkills: Number(r.active_skills),
      pausedSkills: Number(r.paused_skills),
      leadsTotal: Number(r.leads_total),
      leadsThisWeek: Number(r.leads_week),
      replied: Number(r.replied),
      missed: Number(r.missed),
      jobsDone: Number(r.jobs_done),
      ratingCount: Number(r.rating_count),
      ratingAvg: r.rating_avg === null ? null : Math.round(Number(r.rating_avg) * 10) / 10,
      // Looking for work means: at least one live skill and not paused.
      searching: Number(r.active_skills) > 0 && !r.paused,
    };
  });
}
