import { closePools, redis, startWorker } from '@sm/core';

const stop = await startWorker();
console.log('[worker] running');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await stop();
    await closePools();
    redis.disconnect();
    process.exit(0);
  });
}
