// The private, AI-assisted profile: what has been learned about a person's work
// from their own chats and photos. Only its owner can see or change it.

import { describePhoto, extractFromChat, LEARN_VERSION, learningAvailable, writeSummary, type ChatExtractor } from '../ai/learn';
import { config } from '../config';
import { asActor, asSystem, type Tx } from '../db';
import { notFound } from '../errors';
import type { Actor } from './identity';
import { readObject } from './media';

const MODEL = () => `${config.AI_INTERPRETER}:${config.AI_LLM_MODEL}:${LEARN_VERSION}`;
const MAX_PER_TALENT = 30;

async function storeFacts(tx: Tx, accountId: string, capabilityId: string, facts: { kind: string; text: string }[], source: 'chat' | 'photo', sourceId: string) {
  let added = 0;
  for (const f of facts) {
    const text = f.text.trim().slice(0, 240);
    if (text.length < 8) continue;
    // The same thing learned twice is one fact; something the owner removed is not learned again.
    const dup = await tx.maybeOne(`SELECT 1 FROM profile_insights WHERE capability_id = $1 AND lower(text) = lower($2) LIMIT 1`, [capabilityId, text]);
    if (dup) continue;
    await tx.exec(
      `INSERT INTO profile_insights(account_id, capability_id, kind, text, source, source_id, model_version) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [accountId, capabilityId, f.kind, text, source, sourceId, MODEL()],
    );
    added++;
  }
  // Keep the newest; a profile is a short page, not a log.
  await tx.exec(
    `UPDATE profile_insights SET removed_at = now() WHERE id IN (
       SELECT id FROM profile_insights WHERE capability_id = $1 AND removed_at IS NULL AND kind <> 'summary'
       ORDER BY created_at DESC OFFSET $2)`,
    [capabilityId, MAX_PER_TALENT],
  );
  return added;
}

async function refreshSummary(capabilityId: string) {
  if (!learningAvailable()) return;
  const data = await asSystem(async (tx) => {
    const cap = await tx.maybeOne(
      `SELECT c.account_id, cv.original_text, cv.canonical_en FROM capabilities c JOIN capability_versions cv ON cv.id = c.current_version_id WHERE c.id = $1 AND c.status <> 'removed'`,
      [capabilityId],
    );
    if (!cap) return null;
    const facts = await tx.query(`SELECT text FROM profile_insights WHERE capability_id = $1 AND removed_at IS NULL AND kind <> 'summary' ORDER BY created_at DESC LIMIT 20`, [capabilityId]);
    return { cap, facts: facts.map((f) => f.text as string) };
  });
  if (!data || data.facts.length === 0) return;
  const text = await writeSummary(`${data.cap.original_text} (${data.cap.canonical_en})`, data.facts);
  await asSystem(async (tx) => {
    await tx.exec(`UPDATE profile_insights SET removed_at = now() WHERE capability_id = $1 AND kind = 'summary' AND removed_at IS NULL`, [capabilityId]);
    await tx.exec(
      `INSERT INTO profile_insights(account_id, capability_id, kind, text, source, model_version) VALUES ($1,$2,'summary',$3,'profile',$4)`,
      [data.cap.account_id, capabilityId, text, MODEL()],
    );
  });
}

// Reads one conversation and adds what it shows about the provider's work to the
// provider's private profile. Runs after an agreement is confirmed and again when
// the job is completed.
export async function learnFromConversation(conversationId: string, extract: ChatExtractor = extractFromChat): Promise<{ added: number; skipped?: string }> {
  const chat = await asSystem(async (tx) => {
    const c = await tx.maybeOne(
      `SELECT c.id, c.provider_id, c.requester_id, c.capability_id, cv.original_text, cv.canonical_en,
              pa.ai_learning AS provider_ok, ra.ai_learning AS requester_ok, pa.status AS provider_status
       FROM conversations c
       JOIN capabilities cap ON cap.id = c.capability_id JOIN capability_versions cv ON cv.id = cap.current_version_id
       JOIN accounts pa ON pa.id = c.provider_id JOIN accounts ra ON ra.id = c.requester_id
       WHERE c.id = $1`,
      [conversationId],
    );
    if (!c) return { skip: 'not_found' as const };
    // Both people in the chat must have AI learning switched on.
    if (!c.provider_ok || !c.requester_ok || c.provider_status !== 'active') return { skip: 'opted_out' as const };
    const msgs = await tx.query(
      `SELECT sender_id, body FROM messages WHERE conversation_id = $1 AND kind = 'text' AND deleted_at IS NULL AND body IS NOT NULL ORDER BY seq DESC LIMIT 80`,
      [conversationId],
    );
    const agreed = await tx.maybeOne(
      `SELECT what, price_minor FROM agreements WHERE conversation_id = $1 AND state IN ('confirmed','completed') ORDER BY created_at DESC LIMIT 1`,
      [conversationId],
    );
    return { c, msgs: msgs.reverse(), agreed };
  });
  if ('skip' in chat) return { added: 0, skipped: chat.skip };
  if (chat.msgs.length < 3) return { added: 0, skipped: 'too_short' };

  const out = await extract({
    talent: `${chat.c.original_text} (${chat.c.canonical_en})`,
    agreed: chat.agreed ? { what: chat.agreed.what, priceRupees: chat.agreed.price_minor ? chat.agreed.price_minor / 100 : null } : undefined,
    lines: chat.msgs.map((m) => ({ who: m.sender_id === chat.c.provider_id ? ('PROVIDER' as const) : ('CUSTOMER' as const), text: String(m.body).slice(0, 600) })),
  });
  const added = await asSystem((tx) => storeFacts(tx, chat.c.provider_id, chat.c.capability_id, out.facts, 'chat', conversationId));
  if (added > 0) await refreshSummary(chat.c.capability_id).catch((e) => console.error('[learn] summary failed:', (e as Error).message));
  return { added };
}

// Looks at one work photo a person added to a talent and notes what it shows.
export async function learnFromProofPhoto(assetId: string): Promise<{ added: number; skipped?: string }> {
  const row = await asSystem((tx) =>
    tx.maybeOne(
      `SELECT p.capability_id, p.account_id, m.object_key, m.scan_state, a.ai_learning, cv.original_text, cv.canonical_en
       FROM capability_proofs p JOIN media_assets m ON m.id = p.media_asset_id JOIN accounts a ON a.id = p.account_id
       JOIN capabilities c ON c.id = p.capability_id JOIN capability_versions cv ON cv.id = c.current_version_id
       WHERE p.media_asset_id = $1`,
      [assetId],
    ),
  );
  if (!row) return { added: 0, skipped: 'not_found' };
  if (!row.ai_learning) return { added: 0, skipped: 'opted_out' };
  if (row.scan_state === 'rejected') return { added: 0, skipped: 'rejected' };
  // Not checked yet: the job is retried shortly.
  if (row.scan_state !== 'clean') throw new Error('photo not ready');
  const seen = await describePhoto(await readObject(row.object_key), `${row.original_text} (${row.canonical_en})`);
  if (!seen.showsWork) return { added: 0, skipped: 'not_work' };
  const added = await asSystem((tx) => storeFacts(tx, row.account_id, row.capability_id, [{ kind: 'photo', text: seen.text }], 'photo', assetId));
  if (added > 0) await refreshSummary(row.capability_id).catch((e) => console.error('[learn] summary failed:', (e as Error).message));
  return { added };
}

export async function listInsights(actor: Actor) {
  return asActor(actor.accountId, async (tx) => {
    const rows = await tx.query(
      `SELECT id, capability_id, kind, text, source, created_at FROM profile_insights
       WHERE account_id = $1 AND removed_at IS NULL ORDER BY (kind = 'summary') DESC, created_at DESC`,
      [actor.accountId],
    );
    return rows.map((r) => ({ id: r.id as string, capabilityId: r.capability_id as string | null, kind: r.kind as string, text: r.text as string, source: r.source as string }));
  });
}

export async function removeInsight(actor: Actor, id: string) {
  await asActor(actor.accountId, async (tx) => {
    const n = await tx.exec(`UPDATE profile_insights SET removed_at = now() WHERE id = $1 AND account_id = $2 AND removed_at IS NULL`, [id, actor.accountId]);
    if (n === 0) throw notFound('insight_not_found');
  });
}
