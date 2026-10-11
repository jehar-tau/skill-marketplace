// Chat (spec §11) and deliberate number sharing (spec §9). The database is the
// message store; the WebSocket only tells clients that something new exists.

import { decryptSecret, encryptSecret } from '../crypto';
import { asActor, type Tx } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { publish, rateLimit } from '../redis';
import { blockedEitherWay, emit } from '../util';
import type { Actor } from './identity';
import { trustLine } from './intake';

// Advance-payment and OTP scams are the common fraud on classifieds; a plain
// keyword rule is enough to show a warning (spec §8.5). No model involved.
const SCAM_RE = /advance|upi\b|\botp\b|qr code|scan (the )?code|pay first|token amount|google ?pay|gpay|phonepe|paytm|अ‍ॅडव्हान्स|ॲडव्हान्स|एडवांस|आगाऊ|ओटीपी|पहले पैसे|आधी पैसे/i;

interface ConvRow {
  id: string;
  requester_id: string;
  provider_id: string;
  status: string;
  cell_id: string;
  last_seq: number;
  match_id: string;
}

// Row-level security already hides other people's conversations; the explicit
// participant check is the primary guard.
async function loadConversation(tx: Tx, actor: Actor, id: string, lock = false): Promise<ConvRow> {
  const c = await tx.maybeOne<ConvRow>(`SELECT * FROM conversations WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!c || (c.requester_id !== actor.accountId && c.provider_id !== actor.accountId)) throw notFound('conversation_not_found');
  return c;
}

const otherParty = (c: ConvRow, me: string) => (c.requester_id === me ? c.provider_id : c.requester_id);

function messageView(m: Record<string, any>, viewerId: string) {
  const meta = { ...(m.meta ?? {}) } as Record<string, any>;
  if (m.kind === 'contact_share' && meta.phone_enc) {
    meta.phone = decryptSecret(Buffer.from(meta.phone_enc, 'base64'));
    delete meta.phone_enc;
  }
  return {
    id: m.id as string,
    seq: m.seq as number,
    kind: m.kind as string,
    senderId: m.sender_id as string | null,
    mine: m.sender_id === viewerId,
    body: m.deleted_at ? null : (m.body as string | null),
    meta: m.deleted_at ? {} : meta,
    clientMessageId: m.client_message_id as string | null,
    createdAt: m.created_at as Date,
  };
}

async function insertMessage(
  tx: Tx,
  conv: ConvRow,
  msg: { senderId: string | null; clientMessageId?: string; kind: string; body?: string | null; meta?: Record<string, unknown>; locale?: string },
) {
  // The conversation row is locked by the caller, so seq is gap-free and unique.
  const { last_seq } = await tx.one(`UPDATE conversations SET last_seq = last_seq + 1, last_message_at = now() WHERE id = $1 RETURNING last_seq`, [conv.id]);
  const row = await tx.one(
    `INSERT INTO messages(conversation_id, seq, sender_id, client_message_id, kind, body, meta, source_locale, cell_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [conv.id, last_seq, msg.senderId, msg.clientMessageId ?? null, msg.kind, msg.body ?? null, JSON.stringify(msg.meta ?? {}), msg.locale ?? null, conv.cell_id],
  );
  if (msg.senderId) {
    await tx.exec(`UPDATE conversation_participants SET delivered_seq = $3, read_seq = $3 WHERE conversation_id = $1 AND account_id = $2`, [
      conv.id, msg.senderId, last_seq,
    ]);
  }
  await emit(tx, 'message.created', 'conversation', conv.id, { seq: last_seq }, conv.cell_id);
  return row;
}

export async function postSystemMessage(tx: Tx, conversationId: string, kind: 'agreement' | 'system', meta: Record<string, unknown>) {
  const conv = await tx.one<ConvRow>(`SELECT * FROM conversations WHERE id = $1 FOR UPDATE`, [conversationId]);
  return insertMessage(tx, conv, { senderId: null, kind, meta });
}

async function fanout(conv: ConvRow, seq: number) {
  await publish(conv.requester_id, { type: 'message', conversationId: conv.id, seq });
  await publish(conv.provider_id, { type: 'message', conversationId: conv.id, seq });
}

export async function sendMessage(actor: Actor, conversationId: string, body: { clientMessageId: string; body?: string; mediaAssetId?: string }) {
  await rateLimit(`msg:${actor.accountId}`, 60, 60);
  if (!body.body?.trim() && !body.mediaAssetId) throw badRequest('empty_message');
  const { row, conv, fresh } = await asActor(actor.accountId, async (tx) => {
    const conv = await loadConversation(tx, actor, conversationId, true);
    // A retry with the same client id returns the stored message instead of a duplicate.
    const dup = await tx.maybeOne(`SELECT * FROM messages WHERE conversation_id = $1 AND client_message_id = $2`, [conversationId, body.clientMessageId]);
    if (dup) return { row: dup, conv, fresh: false };
    if (conv.status !== 'open') throw conflict('conversation_closed');
    if (await tx.elevated(() => blockedEitherWay(tx, conv.requester_id, conv.provider_id))) throw forbidden('blocked');

    let kind = 'text';
    const meta: Record<string, unknown> = {};
    if (body.mediaAssetId) {
      const asset = await tx.maybeOne(`SELECT id FROM media_assets WHERE id = $1 AND owner_id = $2 AND conversation_id = $3 AND kind = 'image'`, [
        body.mediaAssetId, actor.accountId, conversationId,
      ]);
      if (!asset) throw badRequest('media_not_found');
      kind = 'image';
      meta.mediaAssetId = body.mediaAssetId;
    }
    const text = body.body?.trim() ?? null;
    if (text && SCAM_RE.test(text)) meta.scamWarning = true;
    const row = await insertMessage(tx, conv, { senderId: actor.accountId, clientMessageId: body.clientMessageId, kind, body: text, meta });
    return { row, conv, fresh: true };
  });
  if (fresh) await fanout(conv, row.seq);
  return messageView(row, actor.accountId);
}

// One-directional and per-conversation: the other party is never prompted to reciprocate.
export async function shareNumber(actor: Actor, conversationId: string) {
  const { row, conv, fresh } = await asActor(actor.accountId, async (tx) => {
    const conv = await loadConversation(tx, actor, conversationId, true);
    if (conv.status !== 'open') throw conflict('conversation_closed');
    if (await tx.elevated(() => blockedEitherWay(tx, conv.requester_id, conv.provider_id))) throw forbidden('blocked');
    const already = await tx.maybeOne(`SELECT 1 FROM contact_shares WHERE conversation_id = $1 AND shared_by = $2`, [conversationId, actor.accountId]);
    if (already) {
      const prev = await tx.one(`SELECT * FROM messages WHERE conversation_id = $1 AND sender_id = $2 AND kind = 'contact_share' ORDER BY seq DESC LIMIT 1`, [
        conversationId, actor.accountId,
      ]);
      return { row: prev, conv, fresh: false };
    }
    const me = await tx.one(`SELECT phone_enc FROM accounts WHERE id = $1`, [actor.accountId]);
    const phone = decryptSecret(me.phone_enc);
    await tx.exec(`INSERT INTO contact_shares(conversation_id, shared_by) VALUES ($1, $2)`, [conversationId, actor.accountId]);
    // Stored encrypted even inside the message, and decrypted only for the two participants.
    const row = await insertMessage(tx, conv, {
      senderId: actor.accountId,
      kind: 'contact_share',
      meta: { phone_enc: encryptSecret(phone).toString('base64') },
    });
    await tx.exec(`INSERT INTO lead_events(provider_account_id, match_id, kind) VALUES ($1, $2, 'contact_shared')`, [conv.provider_id, conv.match_id]);
    return { row, conv, fresh: true };
  });
  if (fresh) await fanout(conv, row.seq);
  return messageView(row, actor.accountId);
}

export async function listMessages(actor: Actor, conversationId: string, afterSeq = 0, limit = 100) {
  return asActor(actor.accountId, async (tx) => {
    await loadConversation(tx, actor, conversationId);
    const rows = await tx.query(`SELECT * FROM messages WHERE conversation_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`, [
      conversationId, afterSeq, Math.min(limit, 200),
    ]);
    return rows.map((m) => messageView(m, actor.accountId));
  });
}

// Catch-up after reconnect: everything newer than the client's cursors, in one call.
export async function sync(actor: Actor, cursors: Record<string, number>) {
  return asActor(actor.accountId, async (tx) => {
    const convs = await tx.query(`SELECT id, last_seq FROM conversations WHERE requester_id = $1 OR provider_id = $1`, [actor.accountId]);
    const out: Record<string, ReturnType<typeof messageView>[]> = {};
    for (const c of convs) {
      const after = cursors[c.id] ?? 0;
      if (c.last_seq <= after) continue;
      const rows = await tx.query(`SELECT * FROM messages WHERE conversation_id = $1 AND seq > $2 ORDER BY seq LIMIT 200`, [c.id, after]);
      out[c.id] = rows.map((m) => messageView(m, actor.accountId));
    }
    return out;
  });
}

export async function updateReceipts(actor: Actor, conversationId: string, r: { deliveredSeq?: number; readSeq?: number }) {
  const conv = await asActor(actor.accountId, async (tx) => {
    const conv = await loadConversation(tx, actor, conversationId);
    await tx.exec(
      `UPDATE conversation_participants SET
         delivered_seq = GREATEST(delivered_seq, LEAST($3::bigint, $5::bigint), LEAST($4::bigint, $5::bigint)),
         read_seq = GREATEST(read_seq, LEAST($4::bigint, $5::bigint))
       WHERE conversation_id = $1 AND account_id = $2`,
      [conversationId, actor.accountId, r.deliveredSeq ?? 0, r.readSeq ?? 0, conv.last_seq],
    );
    return conv;
  });
  await publish(otherParty(conv, actor.accountId), { type: 'receipt', conversationId });
}

const CONV_SELECT = `
  SELECT c.id, c.status, c.last_seq, c.last_message_at, c.created_at, c.requester_id, c.provider_id, c.request_id, c.capability_id,
         oa.id AS other_id, oa.display_name AS other_name, oa.status AS other_status,
         me.read_seq AS my_read_seq, them.read_seq AS their_read_seq, them.delivered_seq AS their_delivered_seq,
         rv.original_text AS request_text, sc.labels, mea.preferred_locale, r.status AS request_status,
         ct.completed_jobs AS cap_jobs, ct.rating_avg AS cap_avg, ct.rating_count AS cap_count,
         rt.completed_jobs AS req_jobs, rt.rating_avg AS req_avg, rt.rating_count AS req_count,
         EXISTS (SELECT 1 FROM verifications v WHERE v.account_id = c.provider_id AND v.kind = 'udyam' AND v.state = 'verified') AS verified,
         (SELECT m.body FROM messages m WHERE m.conversation_id = c.id AND m.kind = 'text' AND m.deleted_at IS NULL ORDER BY m.seq DESC LIMIT 1) AS last_text,
         EXISTS (SELECT 1 FROM contact_shares cs WHERE cs.conversation_id = c.id AND cs.shared_by = $1) AS i_shared_number,
         EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = c.requester_id AND b.blocked_id = c.provider_id) OR (b.blocker_id = c.provider_id AND b.blocked_id = c.requester_id)) AS blocked
  FROM conversations c
  JOIN accounts oa ON oa.id = CASE WHEN c.requester_id = $1 THEN c.provider_id ELSE c.requester_id END
  JOIN accounts mea ON mea.id = $1
  JOIN conversation_participants me ON me.conversation_id = c.id AND me.account_id = $1
  JOIN conversation_participants them ON them.conversation_id = c.id AND them.account_id = oa.id
  JOIN requests r ON r.id = c.request_id
  JOIN request_versions rv ON rv.id = r.current_version_id
  JOIN service_categories sc ON sc.id = r.category_id
  LEFT JOIN capability_trust ct ON ct.capability_id = c.capability_id
  LEFT JOIN requester_trust rt ON rt.account_id = c.requester_id
  WHERE (c.requester_id = $1 OR c.provider_id = $1)`;

function conversationView(r: Record<string, any>, me: string) {
  const iAmRequester = r.requester_id === me;
  return {
    id: r.id as string,
    status: r.status as string,
    role: iAmRequester ? ('requester' as const) : ('provider' as const),
    other: {
      id: r.other_id as string,
      displayName: r.other_status === 'active' ? ((r.other_name as string | null) ?? null) : null,
      // The trust line shown is for the other party in their role here: the matched
      // capability if they are the provider, their requester record otherwise.
      trust: iAmRequester
        ? trustLine({ completed_jobs: r.cap_jobs, rating_avg: r.cap_avg, rating_count: r.cap_count, verified: r.verified })
        : trustLine({ completed_jobs: r.req_jobs, rating_avg: r.req_avg, rating_count: r.req_count, verified: false }),
    },
    requestId: r.request_id as string,
    requestText: r.request_text as string,
    requestStatus: r.request_status as string,
    categoryLabel: (r.labels[r.preferred_locale] ?? r.labels.en) as string,
    lastSeq: r.last_seq as number,
    lastText: (r.last_text as string | null) ?? null,
    lastMessageAt: (r.last_message_at as Date | null) ?? (r.created_at as Date),
    unread: Math.max(0, (r.last_seq as number) - (r.my_read_seq as number)),
    theirReadSeq: r.their_read_seq as number,
    theirDeliveredSeq: r.their_delivered_seq as number,
    iSharedNumber: r.i_shared_number as boolean,
    blocked: r.blocked as boolean,
  };
}

export async function listConversations(actor: Actor) {
  return asActor(actor.accountId, (tx) =>
    tx.elevated(async () => {
      const rows = await tx.query(`${CONV_SELECT} ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT 100`, [actor.accountId]);
      return rows.map((r) => conversationView(r, actor.accountId));
    }),
  );
}

export async function getConversation(actor: Actor, conversationId: string) {
  return asActor(actor.accountId, (tx) =>
    tx.elevated(async () => {
      const r = await tx.maybeOne(`${CONV_SELECT} AND c.id = $2`, [actor.accountId, conversationId]);
      if (!r) throw notFound('conversation_not_found');
      return conversationView(r, actor.accountId);
    }),
  );
}
