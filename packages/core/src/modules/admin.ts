// Operations console backend (spec §4, §8.5). Every action is audited.

import { asSystem } from '../db';
import { badRequest, forbidden, notFound } from '../errors';
import { audit } from '../util';
import { deleteAccountTx, denyAccount } from './identity';
import { voidRating } from './trust';

export async function metrics() {
  return asSystem(async (tx) => {
    const funnel = await tx.query(
      `SELECT step, count(DISTINCT account_id) AS accounts, count(*) AS events FROM funnel_events
       WHERE created_at > now() - interval '30 days' GROUP BY step ORDER BY step`,
    );
    const totals = await tx.one(
      `SELECT (SELECT count(*) FROM accounts WHERE status = 'active') AS accounts,
              (SELECT count(*) FROM capabilities WHERE status = 'active') AS active_capabilities,
              (SELECT count(DISTINCT account_id) FROM capabilities WHERE status = 'active') AS providers,
              (SELECT count(*) FROM requests WHERE created_at > now() - interval '7 days') AS requests_7d,
              (SELECT count(*) FROM requests WHERE status = 'no_match' AND created_at > now() - interval '7 days') AS no_match_7d,
              (SELECT count(*) FROM agreements WHERE state = 'completed') AS completed_jobs,
              (SELECT count(*) FROM agreements WHERE state = 'disputed') AS disputed_jobs,
              (SELECT count(*) FROM reports WHERE state IN ('open','in_review')) AS open_reports`,
    );
    const delivery = await tx.one(
      `SELECT count(*) FILTER (WHERE channel = 'push') AS push_sent,
              count(*) FILTER (WHERE channel = 'push' AND delivered_at IS NOT NULL) AS push_delivered,
              count(*) FILTER (WHERE opened_at IS NOT NULL) AS opened,
              count(*) FILTER (WHERE channel = 'sms') AS sms_sent,
              count(*) FILTER (WHERE channel = 'none') AS no_device,
              COALESCE(sum(cost_minor), 0) AS sms_cost_minor,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM delivered_at - sent_at)) FILTER (WHERE delivered_at IS NOT NULL) AS median_delivery_sec
       FROM notification_attempts WHERE kind = 'new_request' AND created_at > now() - interval '7 days'`,
    );
    const response = await tx.one(
      `SELECT count(*) AS notified, count(*) FILTER (WHERE state IN ('interested','filled')) AS interested,
              count(*) FILTER (WHERE state = 'declined') AS declined, count(*) FILTER (WHERE state = 'expired') AS lapsed
       FROM matches WHERE created_at > now() - interval '7 days'`,
    );
    const ai = await tx.query(
      `SELECT task, provider, count(*) AS runs, count(*) FILTER (WHERE status NOT IN ('ok')) AS not_ok,
              round(avg(latency_ms)) AS avg_ms, round(sum(est_cost_usd)::numeric, 4) AS cost_usd
       FROM ai_runs WHERE created_at > now() - interval '7 days' GROUP BY task, provider ORDER BY task`,
    );
    const queue = await tx.one(`SELECT count(*) AS unprocessed, COALESCE(extract(epoch FROM now() - min(created_at)), 0) AS oldest_sec FROM outbox_events WHERE processed_at IS NULL`);
    return { totals, funnel, delivery, response, ai, queue };
  });
}

export async function listReports(state: 'open' | 'all') {
  return asSystem((tx) =>
    tx.query(
      `SELECT r.*, ra.display_name AS reporter_name, sa.display_name AS subject_name, sa.status AS subject_status,
              (SELECT count(*) FROM reports r2 WHERE r2.subject_account_id = r.subject_account_id) AS subject_report_count
       FROM reports r JOIN accounts ra ON ra.id = r.reporter_id JOIN accounts sa ON sa.id = r.subject_account_id
       WHERE ($1 = 'all' OR r.state IN ('open','in_review')) ORDER BY r.created_at DESC LIMIT 200`,
      [state],
    ),
  );
}

// Chat content is readable only while a report on that conversation is open,
// and each read is written to the audit log.
export async function readReportedConversation(adminId: string, reportId: string) {
  return asSystem(async (tx) => {
    const r = await tx.maybeOne(`SELECT * FROM reports WHERE id = $1`, [reportId]);
    if (!r) throw notFound('report_not_found');
    if (!r.conversation_id) throw badRequest('report_has_no_conversation');
    if (!['open', 'in_review'].includes(r.state)) throw forbidden('report_closed');
    await audit(tx, { id: adminId, role: 'admin' }, 'conversation.read', 'conversation', r.conversation_id, { reportId });
    const rows = await tx.query(
      `SELECT seq, sender_id, kind, body, created_at, (meta ? 'scamWarning') AS scam_flag FROM messages
       WHERE conversation_id = $1 AND deleted_at IS NULL ORDER BY seq LIMIT 500`,
      [r.conversation_id],
    );
    // Shared phone numbers stay encrypted; the admin sees that a share happened, not the number.
    return rows.map((m) => ({ ...m, body: m.kind === 'contact_share' ? '[shared their phone number]' : m.body }));
  });
}

export async function resolveReport(
  adminId: string,
  reportId: string,
  body: { resolution: 'resolved' | 'dismissed' | 'in_review'; action?: 'none' | 'suspend' | 'delete'; note?: string },
) {
  const suspended = await asSystem(async (tx) => {
    const r = await tx.maybeOne(`SELECT * FROM reports WHERE id = $1 FOR UPDATE`, [reportId]);
    if (!r) throw notFound('report_not_found');
    await tx.exec(`UPDATE reports SET state = $2, assigned_to = $3, resolved_at = CASE WHEN $2 IN ('resolved','dismissed') THEN now() END WHERE id = $1`, [
      reportId, body.resolution, adminId,
    ]);
    const action = body.action ?? 'none';
    await tx.exec(`INSERT INTO moderation_actions(report_id, admin_id, action, target_account_id, note) VALUES ($1,$2,$3,$4,$5)`, [
      reportId, adminId, action, r.subject_account_id, body.note ?? null,
    ]);
    await audit(tx, { id: adminId, role: 'admin' }, `report.${body.resolution}`, 'report', reportId, { action });
    if (action === 'suspend') {
      await setAccountStatusTx(tx, adminId, r.subject_account_id, 'suspended');
      return r.subject_account_id as string;
    }
    if (action === 'delete') {
      await deleteAccountTx(tx, r.subject_account_id, { id: adminId, role: 'admin' });
      return r.subject_account_id as string;
    }
    return null;
  });
  if (suspended) await denyAccount(suspended);
}

async function setAccountStatusTx(tx: Parameters<Parameters<typeof asSystem>[0]>[0], adminId: string, accountId: string, status: 'active' | 'suspended') {
  const a = await tx.maybeOne(`UPDATE accounts SET status = $2, updated_at = now() WHERE id = $1 AND status <> 'deleted' RETURNING id`, [accountId, status]);
  if (!a) throw notFound('account_not_found');
  if (status === 'suspended') {
    await tx.exec(`UPDATE sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL`, [accountId]);
    await tx.exec(`UPDATE matches SET state = 'expired' WHERE provider_account_id = $1 AND state IN ('notified','seen')`, [accountId]);
  }
  await audit(tx, { id: adminId, role: 'admin' }, `account.${status}`, 'account', accountId);
}

export async function setAccountStatus(adminId: string, accountId: string, status: 'active' | 'suspended') {
  await asSystem((tx) => setAccountStatusTx(tx, adminId, accountId, status));
  if (status === 'suspended') await denyAccount(accountId);
}

export async function listDisputes() {
  return asSystem((tx) =>
    tx.query(
      `SELECT a.id, a.what, a.scheduled_for, a.resolved_at, a.requester_id, a.provider_id, ra.display_name AS requester_name, pa.display_name AS provider_name
       FROM agreements a JOIN accounts ra ON ra.id = a.requester_id JOIN accounts pa ON pa.id = a.provider_id
       WHERE a.state = 'disputed' ORDER BY a.resolved_at DESC LIMIT 100`,
    ),
  );
}

export async function listRatings(accountId: string) {
  return asSystem((tx) =>
    tx.query(`SELECT id, rater_id, ratee_id, stars, tags, comment, created_at, revealed_at, voided_at FROM ratings WHERE ratee_id = $1 OR rater_id = $1 ORDER BY created_at DESC LIMIT 100`, [accountId]),
  );
}

export async function adminVoidRating(adminId: string, ratingId: string) {
  await asSystem((tx) => voidRating(tx, ratingId, adminId));
}

// Utterances that fell into "other": reviewed weekly to grow the taxonomy (spec §7.1).
export async function listUncategorised() {
  return asSystem((tx) =>
    tx.query(
      `SELECT i.id, u.purpose, u.original_text, u.reply_locale, i.status, i.created_at
       FROM interpretations i JOIN utterances u ON u.id = i.utterance_id JOIN service_categories sc ON sc.id = i.category_id
       WHERE sc.slug = 'other' AND u.original_text <> '' AND i.created_at > now() - interval '30 days'
       ORDER BY i.created_at DESC LIMIT 200`,
    ),
  );
}

export async function listVerifications() {
  return asSystem((tx) =>
    tx.query(
      `SELECT v.id, v.account_id, v.kind, v.state, v.created_at, a.display_name FROM verifications v JOIN accounts a ON a.id = v.account_id
       WHERE v.state = 'submitted' ORDER BY v.created_at LIMIT 200`,
    ),
  );
}

export async function decideVerification(adminId: string, id: string, state: 'verified' | 'rejected') {
  await asSystem(async (tx) => {
    const v = await tx.maybeOne(`UPDATE verifications SET state = $2, checked_at = now() WHERE id = $1 RETURNING account_id`, [id, state]);
    if (!v) throw notFound('verification_not_found');
    await audit(tx, { id: adminId, role: 'admin' }, `verification.${state}`, 'verification', id);
  });
}

export async function getMatchingConfig() {
  return asSystem((tx) => tx.query(`SELECT * FROM matching_config ORDER BY version DESC LIMIT 10`));
}

export async function setMatchingFloor(adminId: string, floor: number, note: string) {
  if (!(floor >= 0 && floor <= 1)) throw badRequest('floor_out_of_range');
  await asSystem(async (tx) => {
    const cur = await tx.maybeOne(`SELECT * FROM matching_config WHERE active ORDER BY version DESC LIMIT 1`);
    if (!cur) throw notFound('no_active_config');
    await tx.exec(`UPDATE matching_config SET active = false WHERE active`);
    await tx.exec(`INSERT INTO matching_config(model_key, floor, weights, note) VALUES ($1,$2,$3,$4)`, [cur.model_key, floor, JSON.stringify(cur.weights), note]);
    await audit(tx, { id: adminId, role: 'admin' }, 'matching.floor', 'matching_config', undefined, { floor });
  });
}

export async function recentAudit() {
  return asSystem((tx) => tx.query(`SELECT actor_id, actor_role, action, target_type, target_id, created_at FROM audit_events ORDER BY created_at DESC LIMIT 200`));
}
