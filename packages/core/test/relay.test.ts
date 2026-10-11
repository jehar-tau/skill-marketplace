import { afterAll, describe, expect, it } from 'vitest';
import { asSystem, closePools } from '../src/db';
import { redis } from '../src/redis';
import { drainOutbox, startJobs } from '../src/relay';
import { ask, newUser } from './helpers';

afterAll(async () => {
  await closePools();
  redis.disconnect();
});

describe('outbox relay', () => {
  it('hands each committed event to the job queue exactly once', async () => {
    const boss = await startJobs();
    try {
      await drainOutbox();
      const asker = await newUser('Relay');
      await ask(asker, 'Need a carpenter for door repair');
      expect(await drainOutbox()).toBe(1);
      // A second pass finds nothing: the event was marked processed, not re-sent.
      expect(await drainOutbox()).toBe(0);
      const left = await asSystem((tx) => tx.one(`SELECT count(*) AS n FROM outbox_events WHERE processed_at IS NULL`));
      expect(left.n).toBe(0);
    } finally {
      await boss.stop({ graceful: false });
    }
  });
});
