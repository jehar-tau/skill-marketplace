import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from './config';

// A 64-character hex value is used as the key directly; anything else is hashed down to 32 bytes.
const toKey = (v: string) => (/^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, 'hex') : createHash('sha256').update(v).digest());
const encKey = toKey(config.PHONE_ENC_KEY);
const hashKey = toKey(config.PHONE_HASH_KEY);
const mediaKey = toKey(config.MEDIA_SIGNING_KEY);

// Indian numbers by default: 10 digits become +91XXXXXXXXXX.
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length === 10) return '+91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  return '+' + digits;
}

// AES-256-GCM: iv(12) | tag(16) | ciphertext
export function encryptSecret(plain: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}
export function decryptSecret(blob: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', encKey, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8');
}

export const phoneHash = (phone: string) => createHmac('sha256', hashKey).update(phone).digest('hex');
export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const randomOtp = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export function signMedia(payload: string): string {
  return createHmac('sha256', mediaKey).update(payload).digest('base64url');
}
export function verifyMedia(payload: string, sig: string): boolean {
  const expected = Buffer.from(signMedia(payload));
  const got = Buffer.from(sig);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
