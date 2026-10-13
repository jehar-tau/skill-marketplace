// Agreement, post-job confirmation and two-way ratings (spec §8).

import { encryptSecret } from '../crypto';
import { asActor, asSystem, type Tx } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { publish } from '../redis';
import { audit, emit } from '../util';
import { postSystemMessage } from './conversations';
import type { Actor } from './identity';

const CONFIRM_TIMEOUT_HOURS = 72;
const RATING_REVEAL_DAYS = 7;

function agreementView(a: Record<string, any>, me: string, extra: { myAnswer?: string | null; myRating?: number | null; theirRating?: Record<string, any> | null } = {}) {
  return {
    id: a.id as string,
    conversationId: a.conversation_id as string,
    what: a.what as string,
    scheduledFor: a.scheduled_for as Date,
    priceMinor: a.price_minor as number | null,
    state: a.state as string,
    proposedByMe: a.proposed_by === me,
    canConfirm: a.state === 'proposed' && a.proposed_by !== me,
    // The "did this happen?" question opens once the agreed time has passed.
    canAnswer: a.state === 'confirmed' && new Date(a.scheduled_for).getTime() <= Date.now() && !extra.myAnswer,
    myAnswer: extra.myAnswer ?? null,
    canRate: a.state === 'completed' && extra.myRating == null,
    myRating: extra.myRating ?? null,
    theirRating: extra.theirRating ? { stars: extra.theirRating.stars as number, tags: extra.theirRating.tags as string[], comment: extra.theirRating.comment as string | null } : null,
  };
}

async function party(tx: Tx, actor: Actor, conversationId: string) {
  const c = await tx.maybeOne(`SELECT * FROM conversations WHERE id = $1`, [conversationId]);
  if (!c || (c.requester_id !== actor.accountId && c.provider_id !== actor.accountId)) throw notFound('conversation_not_found');
  return c;
}

export async function getAgreement(actor: Actor, conversationId: string) {
  return asActor(actor.accountId, async (tx) => {
    await party(tx, actor, conversationId);
    const a = await tx.maybeOne(`SELECT * FROM agreements WHERE conversation_id = $1 AND state <> 'withdrawn' ORDER BY created_at DESC LIMIT 1`, [conversationId]);
    if (!a) return null;
    const ans = await tx.maybeOne(`SELECT answer FROM job_confirmations WHERE agreement_id = $1 AND account_id = $2`, [a.id, actor.accountId]);
    const mine = await tx.maybeOne(`SELECT stars FROM ratings WHERE agreement_id = $1 AND rater_id = $2`, [a.id, actor.accountId]);
    // The other side's rating stays hidden until it is revealed (spec §8.3).
    const theirs = await tx.maybeOne(`SELECT stars, tags, comment FROM ratings WHERE agreement_id = $1 AND ratee_id = $2 AND revealed_at IS NOT NULL AND voided_at IS NULL`, [
      a.id, actor.accountId,
    ]);
    return agreementView(a, actor.accountId, { myAnswer: ans?.answer, myRating: mine?.stars, theirRating: theirs });
  });
}

export async function proposeAgreement(actor: Actor, conversationId: string, body: { what: string; scheduledFor: string; priceMinor?: number }) {
  const out = await asActor(actor.accountId, async (tx) => {
    const c = await party(tx, actor, conversationId);
    if (c.status !== 'open') throw conflict('conversation_closed');
    const when = new Date(body.scheduledFor);
    if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 3600_000) throw badRequest('bad_time');
    const live = await tx.maybeOne(`SELECT id FROM agreements WHERE conversation_id = $1 AND state IN ('confirmed','completed','completed_unconfirmed','disputed')`, [conversationId]);
    if (live) throw conflict('agreement_exists');
    await tx.exec(`UPDATE agreements SET state = 'withdrawn' WHERE conversation_id = $1 AND state = 'proposed'`, [conversationId]);
    const a = await tx.one(
      `INSERT INTO agreements(conversation_id, request_id, capability_id, requester_id, provider_id, what, scheduled_for, price_minor, proposed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [conversationId, c.request_id, c.capability_id, c.requester_id, c.provider_id, body.what.trim(), when, body.priceMinor ?? null, actor.accountId],
    );
    await postSystemMessage(tx, conversationId, 'agreement', { agreementId: a.id, event: 'proposed' });
    return { a, other: c.requester_id === actor.accountId ? c.provider_id : c.requester_id };
  });
  await publish(out.other, { type: 'agreement', conversationId });
  await publish(actor.accountId, { type: 'agreement', conversationId });
  return agreementView(out.a, actor.accountId);
}

export async function confirmAgreement(actor: Actor, agreementId: string) {
  const out = await asActor(actor.accountId, async (tx) =>
    tx.elevated(async () => {
      const a = await tx.maybeOne(`SELECT * FROM agreements WHERE id = $1 FOR UPDATE`, [agreementId]);
      if (!a || (a.requester_id !== actor.accountId && a.provider_id !== actor.accountId)) throw notFound('agreement_not_found');
      if (a.state !== 'proposed') throw conflict('not_proposed');
      if (a.proposed_by === actor.accountId) throw forbidden('other_party_must_confirm');
      const upd = await tx.one(`UPDATE agreements SET state = 'confirmed', confirmed_at = now() WHERE id = $1 RETURNING *`, [agreementId]);
      // Agreeing with one provider closes the request to further waves; other responders are told it is filled.
      await tx.exec(`UPDATE requests SET status = 'agreed', updated_at = now() WHERE id = $1 AND status IN ('dispatching','responded','no_match','confirmed')`, [a.request_id]);
      await tx.exec(`UPDATE dispatch_waves SET state = 'closed' WHERE request_id = $1 AND state = 'open'`, [a.request_id]);
      const others = await tx.query(
        `UPDATE matches SET state = CASE WHEN state = 'interested' THEN 'filled' ELSE 'expired' END
         WHERE request_id = $1 AND provider_account_id <> $2 AND state IN ('notified','seen','interested') RETURNING id, provider_account_id`,
        [a.request_id, a.provider_id],
      );
      const match = await tx.one(`SELECT match_id FROM conversations WHERE id = $1`, [a.conversation_id]);
      await tx.exec(`INSERT INTO lead_events(provider_account_id, match_id, kind) VALUES ($1, $2, 'agreed')`, [a.provider_id, match.match_id]);
      await postSystemMessage(tx, a.conversation_id, 'agreement', { agreementId, event: 'confirmed' });
      await emit(tx, 'agreement.confirmed', 'agreement', agreementId, { conversationId: a.conversation_id, scheduledFor: upd.scheduled_for });
      return { a: upd, others };
    }),
  );
  for (const o of out.others) await publish(o.provider_account_id, { type: 'match', matchId: o.id });
  for (const id of [out.a.requester_id, out.a.provider_id]) {
    await publish(id, { type: 'agreement', conversationId: out.a.conversation_id });
    await publish(id, { type: 'request', requestId: out.a.request_id });
  }
  return agreementView(out.a, actor.accountId);
}

export async function withdrawAgreement(actor: Actor, agreementId: string) {
  const a = await asActor(actor.accountId, async (tx) => {
    const a = await tx.maybeOne(`UPDATE agreements SET state = 'withdrawn' WHERE id = $1 AND proposed_by = $2 AND state = 'proposed' RETURNING *`, [
      agreementId, actor.accountId,
    ]);
    if (!a) throw conflict('cannot_withdraw');
    return a;
  });
  for (const id of [a.requester_id, a.provider_id]) await publish(id, { type: 'agreement', conversationId: a.conversation_id });
}

// Outcome table from spec §8.2.
function outcome(requester: string | null, provider: string | null, timedOut: boolean): string | null {
  if (requester === 'yes' && provider === 'yes') return 'completed';
  if (requester === 'no' && provider === 'no') return 'not_done';
  if (requester && provider) return 'disputed';
  if (!timedOut) return null;
  if (requester === 'yes') return 'completed';
  if (provider === 'yes') return 'completed_unconfirmed';
  if (requester === 'no' || provider === 'no') return 'not_done';
  return 'completed_unconfirmed';
}

async function resolveAgreement(tx: Tx, agreementId: string, timedOut: boolean): Promise<Record<string, any> | null> {
  const a = await tx.maybeOne(`SELECT * FROM agreements WHERE id = $1 AND state = 'confirmed' FOR UPDATE`, [agreementId]);
  if (!a) return null;
  const answers = await tx.query(`SELECT account_id, answer FROM job_confirmations WHERE agreement_id = $1`, [agreementId]);
  const by = (id: string) => (answers.find((x) => x.account_id === id)?.answer as string | undefined) ?? null;
  const result = outcome(by(a.requester_id), by(a.provider_id), timedOut);
  if (!result) return null;
  const upd = await tx.one(`UPDATE agreements SET state = $2, resolved_at = now() WHERE id = $1 RETURNING *`, [agreementId, result]);
  if (result === 'completed') {
    await tx.exec(`UPDATE capability_trust SET completed_jobs = completed_jobs + 1 WHERE capability_id = $1`, [a.capability_id]);
    await tx.exec(`UPDATE requester_trust SET completed_jobs = completed_jobs + 1 WHERE account_id = $1`, [a.requester_id]);
    await tx.exec(`UPDATE requests SET status = 'completed', updated_at = now() WHERE id = $1`, [a.request_id]);
    // A finished job puts each person on the other's list, so they can find each other again.
    await tx.exec(
      `INSERT INTO saved_people(owner_id, person_id, conversation_id, source) VALUES ($1, $2, $3, 'job'), ($2, $1, $3, 'job')
       ON CONFLICT (owner_id, person_id) DO NOTHING`,
      [a.requester_id, a.provider_id, a.conversation_id],
    );
  }
  await postSystemMessage(tx, a.conversation_id, 'agreement', { agreementId, event: result });
  await emit(tx, 'job.resolved', 'agreement', agreementId, { result });
  return upd;
}

export async function answerJob(actor: Actor, agreementId: string, answer: 'yes' | 'no') {
  const a = await asActor(actor.accountId, (tx) =>
    tx.elevated(async () => {
      const a = await tx.maybeOne(`SELECT * FROM agreements WHERE id = $1`, [agreementId]);
      if (!a || (a.requester_id !== actor.accountId && a.provider_id !== actor.accountId)) throw notFound('agreement_not_found');
      if (a.state !== 'confirmed') throw conflict('not_awaiting_confirmation');
      if (new Date(a.scheduled_for).getTime() > Date.now()) throw conflict('too_early');
      await tx.exec(`INSERT INTO job_confirmations(agreement_id, account_id, answer) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [agreementId, actor.accountId, answer]);
      return (await resolveAgreement(tx, agreementId, false)) ?? a;
    }),
  );
  for (const id of [a.requester_id, a.provider_id]) await publish(id, { type: 'agreement', conversationId: a.conversation_id });
  return agreementView(a, actor.accountId, { myAnswer: answer });
}

async function recomputeTrust(tx: Tx, rating: Record<string, any>) {
  if (rating.capability_id) {
    await tx.exec(
      `UPDATE capability_trust SET (rating_avg, rating_count) =
         (SELECT avg(stars)::real, count(*) FROM ratings WHERE capability_id = $1 AND revealed_at IS NOT NULL AND voided_at IS NULL)
       WHERE capability_id = $1`,
      [rating.capability_id],
    );
  } else {
    await tx.exec(
      `UPDATE requester_trust SET (rating_avg, rating_count) =
         (SELECT avg(stars)::real, count(*) FROM ratings WHERE ratee_id = $1 AND capability_id IS NULL AND revealed_at IS NOT NULL AND voided_at IS NULL)
       WHERE account_id = $1`,
      [rating.ratee_id],
    );
  }
}

export async function rate(actor: Actor, agreementId: string, body: { stars: number; tags?: string[]; comment?: string }) {
  const a = await asActor(actor.accountId, (tx) =>
    tx.elevated(async () => {
      const a = await tx.maybeOne(`SELECT * FROM agreements WHERE id = $1 FOR UPDATE`, [agreementId]);
      if (!a || (a.requester_id !== actor.accountId && a.provider_id !== actor.accountId)) throw notFound('agreement_not_found');
      // Ratings exist only for jobs both sides agree happened.
      if (a.state !== 'completed') throw conflict('job_not_completed');
      const iAmRequester = a.requester_id === actor.accountId;
      const ratee = iAmRequester ? a.provider_id : a.requester_id;
      // Two accounts on one device rating each other is the cheapest way to fake a reputation.
      const shared = await tx.maybeOne(
        `SELECT 1 FROM sessions s1 JOIN sessions s2 ON s1.device_id = s2.device_id WHERE s1.account_id = $1 AND s2.account_id = $2 LIMIT 1`,
        [actor.accountId, ratee],
      );
      if (shared) throw forbidden('same_device');
      const ins = await tx.maybeOne(
        `INSERT INTO ratings(agreement_id, rater_id, ratee_id, capability_id, stars, tags, comment)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (agreement_id, rater_id) DO NOTHING RETURNING id`,
        [agreementId, actor.accountId, ratee, iAmRequester ? a.capability_id : null, body.stars, body.tags ?? [], body.comment?.trim() || null],
      );
      if (!ins) throw conflict('already_rated');
      // Both hidden until both are in, so neither can retaliate for a low score.
      const both = await tx.query(`SELECT * FROM ratings WHERE agreement_id = $1 AND voided_at IS NULL`, [agreementId]);
      if (both.length === 2) {
        await tx.exec(`UPDATE ratings SET revealed_at = now() WHERE agreement_id = $1 AND revealed_at IS NULL`, [agreementId]);
        for (const r of both) await recomputeTrust(tx, r);
      }
      return a;
    }),
  );
  for (const id of [a.requester_id, a.provider_id]) await publish(id, { type: 'agreement', conversationId: a.conversation_id });
  return { ok: true };
}

// Periodic sweep: ask about finished jobs, time out unanswered ones, reveal old ratings.
export async function sweepTrust(): Promise<{ prompts: { conversationId: string; recipients: string[] }[] }> {
  return asSystem(async (tx) => {
    const due = await tx.query(
      `UPDATE agreements SET prompted_at = now() WHERE state = 'confirmed' AND scheduled_for <= now() AND prompted_at IS NULL
       RETURNING conversation_id, requester_id, provider_id`,
    );
    const stale = await tx.query(
      `SELECT id FROM agreements WHERE state = 'confirmed' AND scheduled_for <= now() - $1 * interval '1 hour'`,
      [CONFIRM_TIMEOUT_HOURS],
    );
    for (const s of stale) await resolveAgreement(tx, s.id, true);
    const reveal = await tx.query(
      `UPDATE ratings SET revealed_at = now() WHERE revealed_at IS NULL AND voided_at IS NULL AND created_at <= now() - $1 * interval '1 day' RETURNING *`,
      [RATING_REVEAL_DAYS],
    );
    for (const r of reveal) await recomputeTrust(tx, r);
    return { prompts: due.map((d) => ({ conversationId: d.conversation_id as string, recipients: [d.requester_id, d.provider_id] as string[] })) };
  });
}

export async function voidRating(tx: Tx, ratingId: string, adminId: string) {
  const r = await tx.maybeOne(`UPDATE ratings SET voided_at = now() WHERE id = $1 AND voided_at IS NULL RETURNING *`, [ratingId]);
  if (!r) throw notFound('rating_not_found');
  await recomputeTrust(tx, r);
  await audit(tx, { id: adminId, role: 'admin' }, 'rating.void', 'rating', ratingId);
}

// Optional "Registered business" badge (spec §8.4). The number is stored encrypted
// and shows as a badge only after an admin has checked it.
export async function submitUdyam(actor: Actor, reference: string) {
  await asActor(actor.accountId, (tx) =>
    tx.exec(
      `INSERT INTO verifications(account_id, kind, reference_enc) VALUES ($1, 'udyam', $2)
       ON CONFLICT (account_id, kind) DO UPDATE SET reference_enc = EXCLUDED.reference_enc, state = 'submitted', checked_at = NULL`,
      [actor.accountId, encryptSecret(reference)],
    ),
  );
  return { state: 'submitted' };
}

// What the app should ask this person about next time it opens: jobs whose time
// has passed and they have not said whether it happened, and finished jobs they have not rated.
export async function pendingReviews(actor: Actor) {
  return asActor(actor.accountId, (tx) =>
    tx.elevated(async () => {
      const rows = await tx.query(
        `SELECT a.id, a.conversation_id, a.what, a.state, a.scheduled_for,
                oa.display_name AS other_name,
                (a.provider_id = $1) AS i_am_provider
         FROM agreements a
         JOIN accounts oa ON oa.id = CASE WHEN a.requester_id = $1 THEN a.provider_id ELSE a.requester_id END
         WHERE (a.requester_id = $1 OR a.provider_id = $1)
           AND (
             (a.state = 'confirmed' AND a.scheduled_for <= now()
               AND NOT EXISTS (SELECT 1 FROM job_confirmations j WHERE j.agreement_id = a.id AND j.account_id = $1))
             OR (a.state = 'completed' AND a.resolved_at > now() - interval '30 days'
               AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.agreement_id = a.id AND r.rater_id = $1))
           )
         ORDER BY a.scheduled_for DESC LIMIT 5`,
        [actor.accountId],
      );
      return rows.map((r) => ({
        agreementId: r.id as string,
        conversationId: r.conversation_id as string,
        what: r.what as string,
        otherName: (r.other_name as string | null) ?? null,
        need: r.state === 'completed' ? ('rate' as const) : ('answer' as const),
        iAmProvider: r.i_am_provider as boolean,
      }));
    }),
  );
}
