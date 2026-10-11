import { latLngToCell } from 'h3-js';
import type { OutboxEventType } from '@sm/contracts';
import { config } from './config';
import type { Tx } from './db';

// City cells (spec §7.2). A point belongs to the nearest listed city within 60 km;
// anything else falls back to a coarse hexagon so it still has a stable cell.
const CITY_CELLS: [string, number, number][] = [
  ['pune', 18.5204, 73.8567],
  ['mumbai', 19.076, 72.8777],
  ['nashik', 19.9975, 73.7898],
  ['nagpur', 21.1458, 79.0882],
  ['kolhapur', 16.705, 74.2433],
  ['chhatrapati_sambhajinagar', 19.8762, 75.3433],
];

function km(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

export function cellFor(lat: number, lng: number): string {
  let best: [string, number] | null = null;
  for (const [name, clat, clng] of CITY_CELLS) {
    const d = km(lat, lng, clat, clng);
    if (d <= 60 && (!best || d < best[1])) best = [name, d];
  }
  if (best) return best[0];
  try {
    return 'h3_' + latLngToCell(lat, lng, 4);
  } catch {
    return config.DEFAULT_CELL;
  }
}

export const h3r8 = (lat: number, lng: number) => latLngToCell(lat, lng, 8);

// Writes an event in the caller's transaction; the worker relays it afterwards (spec §3).
export async function emit(
  tx: Tx,
  eventType: OutboxEventType,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown> = {},
  cellId: string | null = null,
) {
  await tx.exec(
    `INSERT INTO outbox_events(aggregate_type, aggregate_id, event_type, payload, cell_id) VALUES ($1,$2,$3,$4,$5)`,
    [aggregateType, aggregateId, eventType, JSON.stringify(payload), cellId],
  );
  await tx.exec(`SELECT pg_notify('outbox', '')`);
}

export async function funnel(tx: Tx, accountId: string | null, step: string) {
  await tx.exec(`INSERT INTO funnel_events(account_id, step) VALUES ($1, $2)`, [accountId, step]);
}

export async function audit(
  tx: Tx,
  actor: { id: string | null; role: 'user' | 'admin' | 'system' },
  action: string,
  targetType?: string,
  targetId?: string,
  meta: Record<string, unknown> = {},
) {
  await tx.exec(
    `INSERT INTO audit_events(actor_id, actor_role, action, target_type, target_id, meta) VALUES ($1,$2,$3,$4,$5,$6)`,
    [actor.id, actor.role, action, targetType ?? null, targetId ?? null, JSON.stringify(meta)],
  );
}

export const pointSql = (lngParam: number, latParam: number) =>
  `ST_SetSRID(ST_MakePoint($${lngParam}, $${latParam}), 4326)::geography`;

export async function blockedEitherWay(tx: Tx, a: string, b: string): Promise<boolean> {
  const row = await tx.maybeOne(
    `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1`,
    [a, b],
  );
  return row !== null;
}
