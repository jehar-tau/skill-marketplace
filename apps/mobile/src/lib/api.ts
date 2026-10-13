import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { apiUrl, setApiUrlOverride } from './config';
import { getItem, getJson, setItem, setJson } from './storage';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

let tokens: Tokens | null = null;
let deviceId: string | null = null;
let onSignedOut: (() => void) | null = null;
let refreshing: Promise<boolean> | null = null;

export const setSignedOutHandler = (fn: () => void) => (onSignedOut = fn);
export const getAccessToken = () => tokens?.accessToken ?? null;

export async function getDeviceId(): Promise<string> {
  if (deviceId) return deviceId;
  deviceId = await getItem('device_id');
  if (!deviceId) {
    deviceId = newId();
    await setItem('device_id', deviceId);
  }
  return deviceId;
}

export async function loadTokens(): Promise<boolean> {
  setApiUrlOverride(await getItem('api_url'));
  tokens = await getJson<Tokens | null>('tokens', null);
  return tokens !== null;
}

export async function saveTokens(t: Tokens | null) {
  tokens = t;
  await (t ? setJson('tokens', t) : setItem('tokens', null));
}

async function refresh(): Promise<boolean> {
  if (!tokens) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${apiUrl()}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens!.refreshToken, deviceId: await getDeviceId() }),
      });
      if (!res.ok) {
        // Only a definite rejection signs the user out; a network error keeps the session.
        if (res.status === 401) {
          await saveTokens(null);
          onSignedOut?.();
        }
        return false;
      }
      const json = await res.json();
      await saveTokens({ accessToken: json.accessToken, refreshToken: json.refreshToken });
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const send = () =>
    fetch(apiUrl() + path, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.auth !== false && tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  let res: Response;
  try {
    res = await send();
    if (res.status === 401 && opts.auth !== false && (await refresh())) res = await send();
  } catch {
    throw new ApiError(0, 'offline');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? 'error', json.message);
  return json as T;
}

// Browsers only provide the built-in UUID function on https pages and localhost.
// Opened over plain http on a home network it is missing, so build the id from
// random bytes instead (which are available everywhere).
export function newId(): string {
  try {
    return Crypto.randomUUID();
  } catch {
    const b = Crypto.getRandomBytes(16);
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
  }
}
export const platform = Platform.OS === 'android' ? 'android' : Platform.OS === 'ios' ? 'ios' : 'web';

export async function saveServerAddress(url: string | null) {
  setApiUrlOverride(url);
  await setItem('api_url', url);
}
