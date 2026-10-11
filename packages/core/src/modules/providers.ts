// Outbound delivery adapters: SMS and push. Each has a development
// implementation that logs, so the system runs end to end with no accounts.

import { config } from '../config';

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
  channelId: 'requests' | 'messages';
}

export const devOutbox: { sms: { phone: string; text: string }[]; push: PushMessage[] } = { sms: [], push: [] };

export async function sendSms(phone: string, text: string): Promise<{ ok: boolean; costMinor: number }> {
  if (config.SMS_PROVIDER === 'dev') {
    devOutbox.sms.push({ phone, text });
    console.log(`[sms:dev] ${phone.slice(0, 5)}… ${text}`);
    return { ok: true, costMinor: 0 };
  }
  if (config.SMS_PROVIDER === 'phone') {
    // An Android phone running the open-source "SMS Gateway for Android" app sends
    // the message from its own SIM. Free, but only suitable for small pilots.
    if (!config.SMS_PHONE_URL) throw new Error('SMS_PROVIDER=phone needs SMS_PHONE_URL');
    const res = await fetch(`${config.SMS_PHONE_URL.replace(/\/$/, '')}/message`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Basic ' + Buffer.from(`${config.SMS_PHONE_USER ?? ''}:${config.SMS_PHONE_PASS ?? ''}`).toString('base64'),
      },
      body: JSON.stringify({ textMessage: { text }, phoneNumbers: [phone] }),
      signal: AbortSignal.timeout(8000),
    });
    return { ok: res.ok, costMinor: 0 };
  }
  if (config.SMS_PROVIDER === 'whatsapp') {
    // WhatsApp only lets a business start a conversation with a pre-approved template,
    // so the alert text is whatever that template says; `text` is not sent.
    if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID) throw new Error('SMS_PROVIDER=whatsapp needs WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID');
    const res = await fetch(`https://graph.facebook.com/v21.0/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone.replace('+', ''),
        type: 'template',
        template: { name: config.WHATSAPP_ALERT_TEMPLATE, language: { code: config.WHATSAPP_TEMPLATE_LANG } },
      }),
      signal: AbortSignal.timeout(8000),
    });
    // About ₹0.115 per utility message in India.
    return { ok: res.ok, costMinor: 12 };
  }
  if (!config.SMS_HTTP_URL) throw new Error('SMS_PROVIDER=http needs SMS_HTTP_URL');
  const res = await fetch(config.SMS_HTTP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(config.SMS_HTTP_AUTH ? { authorization: config.SMS_HTTP_AUTH } : {}) },
    body: JSON.stringify({ to: phone, text }),
    signal: AbortSignal.timeout(8000),
  });
  return { ok: res.ok, costMinor: 20 };
}

// Fast2SMS "Smart OTP": delivers our own code by WhatsApp or SMS, whichever the
// OTP template (FAST2SMS_OTP_ID) was created for in their dashboard. The WhatsApp
// channel needs no sender registration.
export async function sendOtpFast2Sms(phone: string, code: string): Promise<void> {
  if (!config.FAST2SMS_API_KEY || !config.FAST2SMS_OTP_ID) throw new Error('OTP_PROVIDER=fast2sms needs FAST2SMS_API_KEY and FAST2SMS_OTP_ID');
  const res = await fetch('https://www.fast2sms.com/dev/otp/send', {
    method: 'POST',
    headers: { authorization: config.FAST2SMS_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    // They accept 10-digit Indian numbers only.
    body: JSON.stringify({ mobile: phone.replace(/^\+91/, ''), otp_id: config.FAST2SMS_OTP_ID, otp: code, otp_expiry: 5 }),
    signal: AbortSignal.timeout(8000),
  });
  const body = (await res.json().catch(() => ({}))) as { return?: boolean; message?: string };
  if (!res.ok || body.return === false) throw new Error(`Fast2SMS rejected the OTP request (${res.status}): ${body.message ?? ''}`);
}

// 2Factor.in sends the code through its own pre-registered OTP template.
export async function sendOtpTwoFactor(phone: string, code: string): Promise<void> {
  if (!config.TWOFACTOR_API_KEY) throw new Error('OTP_PROVIDER=twofactor needs TWOFACTOR_API_KEY');
  const res = await fetch(`https://2factor.in/API/V1/${config.TWOFACTOR_API_KEY}/SMS/${phone.replace('+', '')}/${code}`, {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
  });
  const body = (await res.json().catch(() => ({}))) as { Status?: string };
  if (!res.ok || (body.Status && body.Status !== 'Success')) throw new Error(`2Factor rejected the OTP request (${res.status})`);
}

// Expo's push service delivers through FCM on Android. High priority and a
// dedicated channel are what get a request alert shown promptly (spec §6).
export async function sendPush(messages: PushMessage[]): Promise<boolean[]> {
  if (messages.length === 0) return [];
  if (config.PUSH_PROVIDER === 'dev') {
    devOutbox.push.push(...messages);
    for (const m of messages) console.log(`[push:dev] ${m.title} — ${m.body} ${JSON.stringify(m.data)}`);
    return messages.map(() => true);
  }
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(
        messages.map((m) => ({
          to: m.to,
          title: m.title,
          body: m.body,
          data: m.data,
          priority: 'high',
          sound: 'default',
          channelId: m.channelId,
          ttl: m.channelId === 'requests' ? 600 : 3600,
        })),
      ),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return messages.map(() => false);
    const json = (await res.json()) as { data?: { status: string }[] };
    return messages.map((_, i) => json.data?.[i]?.status === 'ok');
  } catch {
    return messages.map(() => false);
  }
}
