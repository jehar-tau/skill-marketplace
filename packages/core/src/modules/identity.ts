import { jwtVerify, SignJWT } from 'jose';
import type { Locale } from '@sm/contracts';
import { config } from '../config';
import { decryptSecret, encryptSecret, normalizePhone, phoneHash, randomOtp, randomToken, sha256 } from '../crypto';
import { asActor, asSystem, type Tx } from '../db';
import { AppError, badRequest, tooMany } from '../errors';
import { rateLimit, redis } from '../redis';
import { audit, emit, funnel } from '../util';
import { sendOtpFast2Sms, sendOtpTwoFactor, sendSms } from './providers';

const jwtKey = new TextEncoder().encode(config.JWT_SECRET);
const ACCESS_TTL_SEC = 30 * 60;
const OTP_TTL_SEC = 5 * 60;

export interface Actor {
  accountId: string;
  sessionId: string;
}

async function issueAccess(accountId: string, sessionId: string) {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SEC}s`)
    .sign(jwtKey);
}

export async function authenticate(token: string): Promise<Actor> {
  try {
    const { payload } = await jwtVerify(token, jwtKey, { algorithms: ['HS256'] });
    const accountId = payload.sub!;
    // Suspension and deletion take effect immediately, not when the token expires.
    if (await redis.exists(`deny:${accountId}`)) throw new Error('denied');
    return { accountId, sessionId: String(payload.sid) };
  } catch {
    throw new AppError(401, 'unauthorized');
  }
}

export async function startOtp(rawPhone: string, ip: string): Promise<{ devCode?: string; pilot?: boolean }> {
  const phone = normalizePhone(rawPhone);
  if (!/^\+[0-9]{11,13}$/.test(phone)) throw badRequest('invalid_phone');
  const hash = phoneHash(phone);
  await rateLimit(`otp:ip:${ip}`, 20, 3600);
  await rateLimit(`otp:phone:${hash}`, 5, 3600);

  // Pilot mode: a small closed group signs in with one shared code and no SMS is
  // sent. Anyone who knows the code can sign in as any allowed number, so this is
  // for supervised testing only.
  if (config.OTP_PROVIDER === 'pilot') {
    const allowed = (config.PILOT_PHONES ?? '').split(',').map((p) => p.trim()).filter(Boolean).map(normalizePhone);
    if (allowed.length > 0 && !allowed.includes(phone)) throw new AppError(403, 'not_invited', 'This number is not on the test list yet.');
  }
  const code = config.OTP_PROVIDER === 'pilot' ? config.PILOT_CODE! : randomOtp();
  await asSystem((tx) =>
    tx.exec(
      `INSERT INTO otp_challenges(phone_hash, code_hash, expires_at) VALUES ($1, $2, now() + $3 * interval '1 second')
       ON CONFLICT (phone_hash) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0`,
      [hash, sha256(code + hash), OTP_TTL_SEC],
    ),
  );
  if (config.OTP_PROVIDER === 'dev') {
    console.log(`[otp:dev] ${phone} -> ${code}`);
    return { devCode: code };
  }
  if (config.OTP_PROVIDER === 'pilot') return { pilot: true };
  if (config.OTP_PROVIDER === 'fast2sms') {
    await sendOtpFast2Sms(phone, code);
    return {};
  }
  if (config.OTP_PROVIDER === 'twofactor') {
    await sendOtpTwoFactor(phone, code);
    return {};
  }
  await sendSms(phone, `${code} is your sign-in code. It is valid for 5 minutes. Do not share it with anyone.`);
  return {};
}

export async function verifyOtp(input: {
  phone: string;
  code: string;
  deviceId: string;
  platform: string;
  locale?: Locale;
}) {
  const phone = normalizePhone(input.phone);
  const hash = phoneHash(phone);
  return asSystem(async (tx) => {
    const ch = await tx.maybeOne(`SELECT * FROM otp_challenges WHERE phone_hash = $1 FOR UPDATE`, [hash]);
    if (!ch || ch.expires_at < new Date()) throw badRequest('otp_expired');
    if (ch.attempts >= 5) throw tooMany('otp_attempts');
    if (ch.code_hash !== sha256(input.code + hash)) {
      await tx.exec(`UPDATE otp_challenges SET attempts = attempts + 1 WHERE phone_hash = $1`, [hash]);
      // Commit the attempt count, then reject.
      return { error: 'otp_invalid' as const };
    }
    await tx.exec(`DELETE FROM otp_challenges WHERE phone_hash = $1`, [hash]);

    let account = await tx.maybeOne(`SELECT * FROM accounts WHERE phone_hash = $1`, [hash]);
    const isNew = !account;
    if (!account) {
      account = await tx.one(
        `INSERT INTO accounts(phone_enc, phone_hash, preferred_locale, terms_version_accepted, home_cell_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [encryptSecret(phone), hash, input.locale ?? 'en', config.termsVersion, config.DEFAULT_CELL],
      );
      await tx.exec(`INSERT INTO provider_settings(account_id) VALUES ($1)`, [account.id]);
      await tx.exec(`INSERT INTO requester_trust(account_id) VALUES ($1)`, [account.id]);
      await tx.exec(`INSERT INTO consents(account_id, scope, version) VALUES ($1, 'terms', $2)`, [account.id, config.termsVersion]);
      await funnel(tx, account.id, 'otp_done');
    }
    if (account.status !== 'active') throw new AppError(403, 'account_' + account.status);

    await tx.exec(`UPDATE sessions SET revoked_at = now() WHERE account_id = $1 AND device_id = $2 AND revoked_at IS NULL`, [
      account.id,
      input.deviceId,
    ]);
    const refreshToken = randomToken();
    const session = await tx.one(
      `INSERT INTO sessions(account_id, device_id, refresh_token_hash, platform) VALUES ($1,$2,$3,$4) RETURNING id`,
      [account.id, input.deviceId, sha256(refreshToken), input.platform],
    );
    return {
      accessToken: await issueAccess(account.id, session.id),
      refreshToken,
      expiresIn: ACCESS_TTL_SEC,
      isNew,
      account: publicAccount(account),
    };
  }).then((r) => {
    if ('error' in r) throw badRequest(String(r.error));
    return r;
  });
}

export async function refresh(refreshToken: string, deviceId: string) {
  return asSystem(async (tx) => {
    const s = await tx.maybeOne(
      `SELECT s.*, a.status FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.refresh_token_hash = $1 AND s.device_id = $2 AND s.revoked_at IS NULL FOR UPDATE OF s`,
      [sha256(refreshToken), deviceId],
    );
    if (!s || s.status !== 'active') throw new AppError(401, 'unauthorized');
    const next = randomToken();
    await tx.exec(`UPDATE sessions SET refresh_token_hash = $1, last_seen_at = now() WHERE id = $2`, [sha256(next), s.id]);
    return { accessToken: await issueAccess(s.account_id, s.id), refreshToken: next, expiresIn: ACCESS_TTL_SEC };
  });
}

function publicAccount(a: Record<string, any>) {
  return {
    id: a.id as string,
    displayName: a.display_name as string | null,
    preferredLocale: a.preferred_locale as Locale,
    defaultView: a.default_view as 'find' | 'offer',
    aiLearning: a.ai_learning as boolean,
    homeCellId: a.home_cell_id as string,
    createdAt: a.created_at as Date,
  };
}

export async function getMe(actor: Actor) {
  return asActor(actor.accountId, async (tx) => {
    const a = await tx.one(`SELECT * FROM accounts WHERE id = $1`, [actor.accountId]);
    const s = await tx.one(`SELECT * FROM provider_settings WHERE account_id = $1`, [actor.accountId]);
    const v = await tx.maybeOne(`SELECT state FROM verifications WHERE account_id = $1 AND kind = 'udyam'`, [actor.accountId]);
    const dev = await tx.maybeOne(`SELECT battery_exempt_confirmed, push_token IS NOT NULL AS has_push FROM sessions WHERE id = $1`, [
      actor.sessionId,
    ]);
    return {
      ...publicAccount(a),
      phoneMasked: maskPhone(decryptSecret(a.phone_enc)),
      providerSettings: {
        paused: s.paused,
        quietStart: String(s.quiet_start).slice(0, 5),
        quietEnd: String(s.quiet_end).slice(0, 5),
        dailyCap: s.daily_cap,
      },
      udyam: (v?.state as string | undefined) ?? null,
      device: { batteryExemptConfirmed: dev?.battery_exempt_confirmed ?? false, hasPush: dev?.has_push ?? false },
    };
  });
}

const maskPhone = (p: string) => p.slice(0, 3) + '•'.repeat(Math.max(0, p.length - 5)) + p.slice(-2);

export async function updateMe(actor: Actor, patch: { displayName?: string; preferredLocale?: Locale; defaultView?: 'find' | 'offer'; aiLearning?: boolean }) {
  await asActor(actor.accountId, (tx) =>
    tx.exec(
      `UPDATE accounts SET display_name = COALESCE($2, display_name), preferred_locale = COALESCE($3, preferred_locale),
         default_view = COALESCE($4, default_view), ai_learning = COALESCE($5, ai_learning), updated_at = now() WHERE id = $1`,
      [actor.accountId, patch.displayName?.trim() ?? null, patch.preferredLocale ?? null, patch.defaultView ?? null, patch.aiLearning ?? null],
    ),
  );
  return getMe(actor);
}

export async function updateDevice(actor: Actor, patch: { pushToken?: string | null; batteryExemptConfirmed?: boolean }) {
  await asActor(actor.accountId, async (tx) => {
    if (patch.pushToken !== undefined) {
      await tx.exec(`UPDATE sessions SET push_token = $2 WHERE id = $1 AND account_id = $3`, [actor.sessionId, patch.pushToken, actor.accountId]);
    }
    if (patch.batteryExemptConfirmed !== undefined) {
      await tx.exec(`UPDATE sessions SET battery_exempt_confirmed = $2 WHERE id = $1 AND account_id = $3`, [
        actor.sessionId,
        patch.batteryExemptConfirmed,
        actor.accountId,
      ]);
    }
  });
}

export async function updateProviderSettings(
  actor: Actor,
  patch: { paused?: boolean; quietStart?: string; quietEnd?: string; dailyCap?: number },
) {
  await asActor(actor.accountId, (tx) =>
    tx.exec(
      `UPDATE provider_settings SET paused = COALESCE($2, paused), quiet_start = COALESCE($3::time, quiet_start),
         quiet_end = COALESCE($4::time, quiet_end), daily_cap = COALESCE($5, daily_cap),
         ignored_streak = CASE WHEN $2 = false THEN 0 ELSE ignored_streak END, updated_at = now()
       WHERE account_id = $1`,
      [actor.accountId, patch.paused ?? null, patch.quietStart ?? null, patch.quietEnd ?? null, patch.dailyCap ?? null],
    ),
  );
}

export async function logout(actor: Actor) {
  await asActor(actor.accountId, (tx) =>
    tx.exec(`UPDATE sessions SET revoked_at = now(), push_token = NULL WHERE id = $1 AND account_id = $2`, [actor.sessionId, actor.accountId]),
  );
}

export async function denyAccount(accountId: string) {
  await redis.set(`deny:${accountId}`, '1', 'EX', ACCESS_TTL_SEC + 60);
}

// Removes or anonymises personal data and keeps only what other users' records
// depend on (their conversations and ratings stay intact, without this person's identity).
export async function deleteAccount(actor: Actor) {
  await asSystem(async (tx) => deleteAccountTx(tx, actor.accountId, { id: actor.accountId, role: 'user' }));
  await denyAccount(actor.accountId);
}

export async function deleteAccountTx(tx: Tx, accountId: string, by: { id: string | null; role: 'user' | 'admin' }) {
  await tx.exec(
    `UPDATE accounts SET status = 'deleted', deleted_at = now(), phone_enc = NULL, phone_hash = NULL, display_name = NULL, updated_at = now() WHERE id = $1`,
    [accountId],
  );
  await tx.exec(`UPDATE sessions SET revoked_at = now(), push_token = NULL WHERE account_id = $1 AND revoked_at IS NULL`, [accountId]);
  await tx.exec(`UPDATE capabilities SET status = 'removed', updated_at = now() WHERE account_id = $1`, [accountId]);
  await tx.exec(`UPDATE capability_versions SET original_text = '', canonical_en = '' WHERE account_id = $1`, [accountId]);
  await tx.exec(
    `UPDATE requests SET status = 'cancelled', updated_at = now() WHERE account_id = $1 AND status IN ('confirmed','dispatching','responded','no_match')`,
    [accountId],
  );
  await tx.exec(
    `UPDATE request_versions SET original_text = '', canonical_en = '' WHERE request_id IN (SELECT id FROM requests WHERE account_id = $1)`,
    [accountId],
  );
  await tx.exec(`UPDATE utterances SET original_text = '' WHERE account_id = $1`, [accountId]);
  await tx.exec(`UPDATE interpretations SET canonical_en = '', source_span = '', confirmation_text = '', attributes = '{}', extra = '{}' WHERE account_id = $1`, [accountId]);
  await tx.exec(`UPDATE messages SET body = NULL, meta = '{}', deleted_at = now() WHERE sender_id = $1`, [accountId]);
  await tx.exec(`UPDATE media_assets SET scan_state = 'rejected' WHERE owner_id = $1`, [accountId]);
  await tx.exec(`DELETE FROM verifications WHERE account_id = $1`, [accountId]);
  await tx.exec(`DELETE FROM capability_proofs WHERE account_id = $1`, [accountId]);
  await tx.exec(`UPDATE profile_insights SET text = '', removed_at = now() WHERE account_id = $1`, [accountId]);
  await tx.exec(`DELETE FROM saved_people WHERE owner_id = $1 OR person_id = $1`, [accountId]);
  await tx.exec(`UPDATE conversations SET status = 'closed' WHERE requester_id = $1 OR provider_id = $1`, [accountId]);
  await emit(tx, 'account.deleted', 'account', accountId);
  await audit(tx, by, 'account.delete', 'account', accountId);
}
