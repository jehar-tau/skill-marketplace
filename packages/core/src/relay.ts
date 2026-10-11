// Background processing: the outbox relay and the job handlers (spec §3).
// Delivery is at-least-once; every handler is safe to run twice.

import { PgBoss } from 'pg-boss';
import pg from 'pg';
import { JOBS } from '@sm/contracts';
import { config } from './config';
import { asSystem, ownerPool } from './db';
import { closeWaveIfAllDeclined, dispatchRequest, expireWave, matchNewCapability } from './modules/matching';
import { processImage, purgeExpiredAudio } from './modules/media';
import { notifyAgreement, notifyInterested, notifyMessage, notifyWave, smsFallbackDelay, smsFallback } from './modules/notifications';
import { sweepTrust } from './modules/trust';

let boss: PgBoss | null = null;

export async function startJobs(): Promise<PgBoss> {
  // The queue lives in its own schema, owned by the migration role.
  boss = new PgBoss({ connectionString: config.DATABASE_OWNER_URL, schema: 'pgboss', max: config.DB_JOBS_POOL_MAX });
  boss.on('error', (e) => console.error('[jobs]', e));
  await boss.start();
  for (const name of Object.values(JOBS)) await boss.createQueue(name);
  return boss;
}

const send = (name: string, data: object, opts: { startAfter?: number; singletonKey?: string } = {}) => boss!.send(name, data, { retryLimit: 5, retryBackoff: true, ...opts });

// Translates a committed domain event into the jobs that follow from it.
async function route(e: { event_type: string; aggregate_id: string; payload: Record<string, any> }) {
  switch (e.event_type) {
    case 'request.confirmed':
      await send(JOBS.dispatchRequest, { requestId: e.aggregate_id });
      break;
    case 'capability.activated':
      await send(JOBS.matchCapability, { capabilityId: e.aggregate_id });
      break;
    case 'wave.created':
      await send(JOBS.notifyWave, { waveId: e.aggregate_id });
      await send(JOBS.waveExpire, { waveId: e.aggregate_id }, { startAfter: Number(e.payload.expirySec ?? config.WAVE_EXPIRY_SECONDS) });
      break;
    case 'match.responded':
      if (e.payload.action === 'interested') await send(JOBS.responsePush, { matchId: e.aggregate_id });
      else await send(JOBS.waveExpire, { waveId: e.payload.waveId, onlyIfAllDeclined: true });
      break;
    case 'message.created':
      await send(JOBS.messagePush, { conversationId: e.aggregate_id, seq: e.payload.seq }, { startAfter: 2 });
      break;
    case 'media.uploaded':
      await send(JOBS.mediaProcess, { assetId: e.aggregate_id });
      break;
    case 'agreement.confirmed':
      await send(JOBS.jobPrompt, { conversationId: e.payload.conversationId, kind: 'agreement' });
      break;
    default:
      break;
  }
}

let draining = false;
export async function drainOutbox(): Promise<number> {
  if (draining) return 0;
  draining = true;
  let total = 0;
  try {
    for (;;) {
      const n = await asSystem(async (tx) => {
        const rows = await tx.query(
          `SELECT id, event_type, aggregate_id, payload FROM outbox_events
           WHERE processed_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
        );
        for (const r of rows) {
          await route(r as any);
          await tx.exec(`UPDATE outbox_events SET processed_at = now() WHERE id = $1`, [r.id]);
        }
        return rows.length;
      });
      total += n;
      if (n < 100) break;
    }
  } finally {
    draining = false;
  }
  return total;
}

async function maintenance() {
  await ownerPool.query(`SELECT ensure_month_partitions(t) FROM unnest(ARRAY['messages','outbox_events','notification_attempts','ai_runs','audit_events']) t`);
  // Requests held back (for example by quiet hours) get another attempt; lapsed ones are closed.
  const open = await asSystem((tx) =>
    tx.query(
      `SELECT r.id FROM requests r WHERE r.status IN ('confirmed','dispatching','no_match')
         AND NOT EXISTS (SELECT 1 FROM dispatch_waves w WHERE w.request_id = r.id AND w.state = 'open') LIMIT 500`,
    ),
  );
  for (const r of open) await dispatchRequest(r.id);
  await asSystem((tx) => tx.exec(`UPDATE requests SET status = 'expired', updated_at = now() WHERE status = 'responded' AND expires_at < now()`));
  // Waves whose timer was lost (worker restart) are closed here.
  const lost = await asSystem((tx) => tx.query(`SELECT id FROM dispatch_waves WHERE state = 'open' AND expires_at < now() - interval '30 seconds' LIMIT 200`));
  for (const w of lost) await expireWave(w.id);
  const { prompts } = await sweepTrust();
  for (const p of prompts) await notifyAgreement(p.conversationId, p.recipients, 'job_prompt');
  await purgeExpiredAudio();
  await asSystem((tx) => tx.exec(`DELETE FROM otp_challenges WHERE expires_at < now() - interval '1 day'`));
}

export async function startWorker() {
  const b = await startJobs();
  const one = <T>(fn: (data: T) => Promise<unknown>) => async (jobs: { data: T }[]) => {
    for (const j of jobs) await fn(j.data);
  };

  await b.work(JOBS.dispatchRequest, one<{ requestId: string }>((d) => dispatchRequest(d.requestId)));
  await b.work(JOBS.matchCapability, one<{ capabilityId: string }>((d) => matchNewCapability(d.capabilityId)));
  await b.work(
    JOBS.notifyWave,
    one<{ waveId: string }>(async (d) => {
      const matchIds = await notifyWave(d.waveId);
      for (const matchId of matchIds) await send(JOBS.smsFallback, { matchId }, { startAfter: smsFallbackDelay() });
    }),
  );
  await b.work(
    JOBS.waveExpire,
    one<{ waveId: string; onlyIfAllDeclined?: boolean }>((d) => (d.onlyIfAllDeclined ? closeWaveIfAllDeclined(d.waveId) : expireWave(d.waveId))),
  );
  await b.work(JOBS.smsFallback, one<{ matchId: string }>((d) => smsFallback(d.matchId)));
  await b.work(JOBS.messagePush, one<{ conversationId: string; seq: number }>((d) => notifyMessage(d.conversationId, d.seq)));
  await b.work(JOBS.responsePush, one<{ matchId: string }>((d) => notifyInterested(d.matchId)));
  await b.work(JOBS.mediaProcess, one<{ assetId: string }>((d) => processImage(d.assetId)));
  await b.work(
    JOBS.jobPrompt,
    one<{ conversationId: string; kind: 'agreement' | 'job_prompt' }>(async (d) => {
      const c = await asSystem((tx) => tx.maybeOne(`SELECT requester_id, provider_id FROM conversations WHERE id = $1`, [d.conversationId]));
      if (c) await notifyAgreement(d.conversationId, [c.requester_id, c.provider_id], d.kind);
    }),
  );
  await b.work(JOBS.maintenance, one(() => maintenance()));
  await b.schedule(JOBS.maintenance, '*/2 * * * *');

  // Relay: wake on NOTIFY for low latency, and poll as a safety net.
  const listener = new pg.Client({ connectionString: config.DATABASE_APP_URL });
  await listener.connect();
  await listener.query('LISTEN outbox');
  const kick = () => drainOutbox().catch((e) => console.error('[relay]', e));
  listener.on('notification', kick);
  const timer = setInterval(kick, 1000);
  kick();

  return async () => {
    clearInterval(timer);
    await listener.end().catch(() => undefined);
    await b.stop({ graceful: true });
  };
}
