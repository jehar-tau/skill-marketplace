import { randomUUID } from 'node:crypto';
import { asSystem } from '../src/db';
import * as identity from '../src/modules/identity';
import * as intake from '../src/modules/intake';
import type { Actor } from '../src/modules/identity';

export const PUNE = { lat: 18.5204, lng: 73.8567 };
export const NEARBY = { lat: 18.53, lng: 73.86 };
export const MUMBAI = { lat: 19.076, lng: 72.8777 };

let counter = 0;

export async function newUser(name: string, deviceId = randomUUID()): Promise<Actor & { phone: string; deviceId: string }> {
  const phone = '+9198' + String(Date.now() % 100000).padStart(5, '0') + String(counter++).padStart(3, '0');
  const { devCode } = await identity.startOtp(phone, `10.0.${counter % 250}.${(counter * 7) % 250}`);
  const session = await identity.verifyOtp({ phone, code: devCode!, deviceId, platform: 'android', locale: 'en' });
  const { jwtVerify } = await import('jose');
  const { payload } = await jwtVerify(session.accessToken, new TextEncoder().encode(process.env.JWT_SECRET!));
  const actor = { accountId: session.account.id, sessionId: String(payload.sid) };
  await identity.updateMe(actor, { displayName: name });
  // Tests run at any hour: switch quiet hours off.
  await asSystem((tx) => tx.exec(`UPDATE provider_settings SET quiet_start = '00:00', quiet_end = '00:00', daily_cap = 200 WHERE account_id = $1`, [actor.accountId]));
  return { ...actor, phone, deviceId };
}

export async function offer(actor: Actor, text: string, location = PUNE): Promise<string[]> {
  const res = await intake.interpretUtterance(actor, { purpose: 'capability', text });
  const out = await intake.confirmCapabilities(actor, { interpretationIds: res.drafts.map((d) => d.interpretationId), location });
  return out.capabilityIds;
}

export async function ask(actor: Actor, text: string, location = NEARBY): Promise<string> {
  const res = await intake.interpretUtterance(actor, { purpose: 'request', text });
  const out = await intake.confirmRequest(actor, { interpretationId: res.drafts[0]!.interpretationId, location });
  return out.requestId;
}

export const matchesFor = (requestId: string) =>
  asSystem((tx) => tx.query(`SELECT * FROM matches WHERE request_id = $1 ORDER BY rank`, [requestId]));
