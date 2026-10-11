import { Redis } from 'ioredis';
import type { RealtimeEvent } from '@sm/contracts';
import { config } from './config';
import { tooMany } from './errors';

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
redis.on('error', (e) => console.error('[redis]', e.message));

// Fixed-window rate limit. Throws 429 when the window is exhausted.
export async function rateLimit(key: string, max: number, windowSec: number): Promise<void> {
  const k = `rl:${key}`;
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, windowSec);
  if (n > max) throw tooMany();
}

const RT_CHANNEL = 'rt';

// Fans an event out to every API instance; each forwards it to that account's sockets.
export async function publish(accountId: string, event: RealtimeEvent): Promise<void> {
  await redis.publish(RT_CHANNEL, JSON.stringify({ accountId, event })).catch(() => undefined);
}

export function subscribe(handler: (accountId: string, event: RealtimeEvent) => void): Redis {
  const sub = new Redis(config.REDIS_URL);
  sub.subscribe(RT_CHANNEL).catch((e) => console.error('[redis] subscribe failed', e.message));
  sub.on('message', (_ch, raw) => {
    try {
      const { accountId, event } = JSON.parse(raw);
      handler(accountId, event);
    } catch {
      // ignore malformed frames
    }
  });
  return sub;
}

export const presenceKey = (accountId: string) => `presence:${accountId}`;
export const isOnline = async (accountId: string) => (await redis.exists(presenceKey(accountId))) === 1;
