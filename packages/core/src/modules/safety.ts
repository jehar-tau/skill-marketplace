import { asActor } from '../db';
import { badRequest, notFound } from '../errors';
import { publish, rateLimit } from '../redis';
import { audit } from '../util';
import type { Actor } from './identity';

export async function report(
  actor: Actor,
  body: { subjectAccountId: string; conversationId?: string; reason: string; detail?: string },
) {
  await rateLimit(`report:${actor.accountId}`, 10, 3600);
  if (body.subjectAccountId === actor.accountId) throw badRequest('cannot_report_self');
  return asActor(actor.accountId, async (tx) => {
    if (body.conversationId) {
      const c = await tx.maybeOne(`SELECT requester_id, provider_id FROM conversations WHERE id = $1`, [body.conversationId]);
      if (!c || ![c.requester_id, c.provider_id].includes(body.subjectAccountId)) throw notFound('conversation_not_found');
    } else {
      // Without a conversation, the two must at least have been matched.
      const m = await tx.maybeOne(
        `SELECT 1 FROM matches WHERE (provider_account_id = $1 AND requester_account_id = $2) OR (provider_account_id = $2 AND requester_account_id = $1) LIMIT 1`,
        [actor.accountId, body.subjectAccountId],
      );
      if (!m) throw notFound('subject_not_found');
    }
    const r = await tx.one(
      `INSERT INTO reports(reporter_id, subject_account_id, conversation_id, reason, detail) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [actor.accountId, body.subjectAccountId, body.conversationId ?? null, body.reason, body.detail?.trim() || null],
    );
    await audit(tx, { id: actor.accountId, role: 'user' }, 'report.create', 'report', r.id);
    return { reportId: r.id as string };
  });
}

// Blocked pairs are never matched again and cannot message each other.
export async function block(actor: Actor, accountId: string) {
  if (accountId === actor.accountId) throw badRequest('cannot_block_self');
  const convs = await asActor(actor.accountId, async (tx) => {
    await tx.exec(`INSERT INTO blocks(blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [actor.accountId, accountId]);
    await tx.exec(
      `UPDATE matches SET state = 'expired' WHERE state IN ('notified','seen')
         AND ((provider_account_id = $1 AND requester_account_id = $2) OR (provider_account_id = $2 AND requester_account_id = $1))`,
      [actor.accountId, accountId],
    );
    return tx.query(`SELECT id FROM conversations WHERE (requester_id = $1 AND provider_id = $2) OR (requester_id = $2 AND provider_id = $1)`, [
      actor.accountId, accountId,
    ]);
  });
  for (const c of convs) {
    await publish(actor.accountId, { type: 'conversation', conversationId: c.id });
    await publish(accountId, { type: 'conversation', conversationId: c.id });
  }
}

export async function unblock(actor: Actor, accountId: string) {
  await asActor(actor.accountId, (tx) => tx.exec(`DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, [actor.accountId, accountId]));
}

export async function listBlocks(actor: Actor) {
  return asActor(actor.accountId, async (tx) => {
    const rows = await tx.query(
      `SELECT b.blocked_id, a.display_name, b.created_at FROM blocks b JOIN accounts a ON a.id = b.blocked_id WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
      [actor.accountId],
    );
    return rows.map((r) => ({ accountId: r.blocked_id as string, displayName: r.display_name as string | null, createdAt: r.created_at as Date }));
  });
}
