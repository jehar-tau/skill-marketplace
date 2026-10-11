// Notification delivery (spec §6): push first, a delivery receipt from the app,
// and an SMS if no receipt arrives in time.

import type { Locale } from '@sm/contracts';
import { config } from '../config';
import { decryptSecret } from '../crypto';
import { asSystem, type Tx } from '../db';
import { isOnline, publish } from '../redis';
import { funnel } from '../util';
import { sendPush, sendSms, type PushMessage } from './providers';

const TEXT: Record<Locale, { newRequest: string; newRequestBody: (label: string) => string; sms: string; interested: string; interestedBody: string; message: string; messageBody: (n: string) => string; jobPrompt: string; jobPromptBody: string; agreement: string; agreementBody: string }> = {
  en: {
    newRequest: 'New request near you',
    newRequestBody: (l) => `Someone needs: ${l}. Tap to see it.`,
    sms: 'New request near you on Skill Marketplace. Open the app to respond.',
    interested: 'Someone can help',
    interestedBody: 'A provider responded to your request. Tap to chat.',
    message: 'New message',
    messageBody: (n) => `${n} sent you a message.`,
    jobPrompt: 'Did the job happen?',
    jobPromptBody: 'Tap to confirm and leave a rating.',
    agreement: 'Agreement update',
    agreementBody: 'Tap to review the agreed job.',
  },
  hi: {
    newRequest: 'आपके पास नया अनुरोध',
    newRequestBody: (l) => `किसी को चाहिए: ${l}. देखने के लिए टैप करें.`,
    sms: 'Skill Marketplace पर आपके पास नया अनुरोध आया है. जवाब देने के लिए ऐप खोलें.',
    interested: 'कोई मदद कर सकता है',
    interestedBody: 'एक सेवा देने वाले ने आपके अनुरोध का जवाब दिया. चैट के लिए टैप करें.',
    message: 'नया संदेश',
    messageBody: (n) => `${n} ने आपको संदेश भेजा.`,
    jobPrompt: 'क्या काम हुआ?',
    jobPromptBody: 'पुष्टि करने और रेटिंग देने के लिए टैप करें.',
    agreement: 'समझौते की जानकारी',
    agreementBody: 'तय हुए काम को देखने के लिए टैप करें.',
  },
  mr: {
    newRequest: 'तुमच्या जवळ नवीन मागणी',
    newRequestBody: (l) => `कोणाला हवे आहे: ${l}. पाहण्यासाठी टॅप करा.`,
    sms: 'Skill Marketplace वर तुमच्या जवळ नवीन मागणी आली आहे. उत्तर देण्यासाठी ॲप उघडा.',
    interested: 'कोणीतरी मदत करू शकते',
    interestedBody: 'एका सेवा देणाऱ्याने तुमच्या मागणीला उत्तर दिले. चॅटसाठी टॅप करा.',
    message: 'नवीन संदेश',
    messageBody: (n) => `${n} यांनी तुम्हाला संदेश पाठवला.`,
    jobPrompt: 'काम झाले का?',
    jobPromptBody: 'खात्री करण्यासाठी आणि रेटिंग देण्यासाठी टॅप करा.',
    agreement: 'ठरलेल्या कामाची माहिती',
    agreementBody: 'ठरलेले काम पाहण्यासाठी टॅप करा.',
  },
};

async function pushTokens(tx: Tx, accountId: string): Promise<string[]> {
  const rows = await tx.query(`SELECT push_token FROM sessions WHERE account_id = $1 AND revoked_at IS NULL AND push_token IS NOT NULL`, [accountId]);
  return rows.map((r) => r.push_token as string);
}

async function pushTo(
  accountId: string,
  kind: string,
  build: (locale: Locale) => Omit<PushMessage, 'to'>,
  matchId: string | null = null,
): Promise<boolean> {
  const { tokens, locale } = await asSystem(async (tx) => {
    const a = await tx.maybeOne(`SELECT preferred_locale FROM accounts WHERE id = $1 AND status = 'active'`, [accountId]);
    return { tokens: a ? await pushTokens(tx, accountId) : [], locale: ((a?.preferred_locale as Locale | undefined) ?? 'en') };
  });
  const msg = build(locale);
  const results = await sendPush(tokens.map((to) => ({ ...msg, to })));
  const sent = results.some(Boolean);
  await asSystem((tx) =>
    tx.exec(`INSERT INTO notification_attempts(match_id, account_id, kind, channel, state) VALUES ($1,$2,$3,$4,$5)`, [
      matchId, accountId, kind, tokens.length ? 'push' : 'none', tokens.length === 0 ? 'suppressed' : sent ? 'sent' : 'failed',
    ]),
  );
  return sent;
}

// Sends the first alert for every match in a wave.
export async function notifyWave(waveId: string): Promise<string[]> {
  const matches = await asSystem((tx) =>
    tx.query(
      `SELECT m.id, m.provider_account_id, sc.labels FROM matches m
       JOIN requests r ON r.id = m.request_id JOIN service_categories sc ON sc.id = r.category_id
       WHERE m.wave_id = $1 AND m.state = 'notified'
         AND NOT EXISTS (SELECT 1 FROM notification_attempts n WHERE n.match_id = m.id)`,
      [waveId],
    ),
  );
  for (const m of matches) {
    // The payload names the kind of help wanted and nothing else: no location,
    // no requester identity, no request text.
    await pushTo(
      m.provider_account_id,
      'new_request',
      (l) => ({
        title: TEXT[l].newRequest,
        body: TEXT[l].newRequestBody((m.labels[l] ?? m.labels.en) as string),
        data: { type: 'match', matchId: m.id },
        channelId: 'requests',
      }),
      m.id,
    );
    await publish(m.provider_account_id, { type: 'match', matchId: m.id });
    await asSystem((tx) => funnel(tx, m.provider_account_id, 'notification_sent'));
  }
  return matches.map((m) => m.id as string);
}

// Runs SMS_FALLBACK_SECONDS after the push. Skipped once the app has acknowledged receipt.
export async function smsFallback(matchId: string): Promise<'sent' | 'skipped'> {
  const row = await asSystem((tx) =>
    tx.maybeOne(
      `SELECT m.provider_account_id, a.phone_enc, a.preferred_locale FROM matches m JOIN accounts a ON a.id = m.provider_account_id
       WHERE m.id = $1 AND m.state = 'notified' AND a.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM notification_attempts n WHERE n.match_id = m.id AND (n.delivered_at IS NOT NULL OR n.channel = 'sms'))`,
      [matchId],
    ),
  );
  if (!row || !row.phone_enc) return 'skipped';
  const res = await sendSms(decryptSecret(row.phone_enc), TEXT[(row.preferred_locale as Locale) ?? 'en'].sms);
  await asSystem((tx) =>
    tx.exec(`INSERT INTO notification_attempts(match_id, account_id, kind, channel, state, cost_minor) VALUES ($1,$2,'new_request','sms',$3,$4)`, [
      matchId, row.provider_account_id, res.ok ? 'sent' : 'failed', res.costMinor,
    ]),
  );
  return 'sent';
}

export async function notifyInterested(matchId: string) {
  const m = await asSystem((tx) => tx.maybeOne(`SELECT requester_account_id, request_id FROM matches WHERE id = $1 AND state = 'interested'`, [matchId]));
  if (!m) return;
  await pushTo(m.requester_account_id, 'provider_interested', (l) => ({
    title: TEXT[l].interested,
    body: TEXT[l].interestedBody,
    data: { type: 'request', requestId: m.request_id },
    channelId: 'messages',
  }));
}

// Message content never goes into a push payload; only who it is from.
export async function notifyMessage(conversationId: string, seq: number) {
  const row = await asSystem((tx) =>
    tx.maybeOne(
      `SELECT msg.sender_id, c.requester_id, c.provider_id, a.display_name
       FROM messages msg JOIN conversations c ON c.id = msg.conversation_id LEFT JOIN accounts a ON a.id = msg.sender_id
       WHERE msg.conversation_id = $1 AND msg.seq = $2`,
      [conversationId, seq],
    ),
  );
  if (!row || !row.sender_id) return;
  const recipient = row.sender_id === row.requester_id ? row.provider_id : row.requester_id;
  if (await isOnline(recipient)) return;
  const muted = await asSystem((tx) =>
    tx.maybeOne(`SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND account_id = $2 AND (muted OR read_seq >= $3)`, [
      conversationId, recipient, seq,
    ]),
  );
  if (muted) return;
  await pushTo(recipient, 'message', (l) => ({
    title: TEXT[l].message,
    body: TEXT[l].messageBody((row.display_name as string | null) ?? '…'),
    data: { type: 'conversation', conversationId },
    channelId: 'messages',
  }));
}

export async function notifyAgreement(conversationId: string, recipients: string[], kind: 'agreement' | 'job_prompt') {
  for (const id of recipients) {
    await pushTo(id, kind, (l) => ({
      title: kind === 'job_prompt' ? TEXT[l].jobPrompt : TEXT[l].agreement,
      body: kind === 'job_prompt' ? TEXT[l].jobPromptBody : TEXT[l].agreementBody,
      data: { type: 'conversation', conversationId },
      channelId: 'messages',
    }));
    await publish(id, { type: 'agreement', conversationId });
  }
}

export const smsFallbackDelay = () => config.SMS_FALLBACK_SECONDS;
