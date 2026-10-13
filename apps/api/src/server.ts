import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { admin, AppError, closePools, config, ROOT, identity, presenceKey, rateLimit, redis, startWorker, subscribe, type Actor } from '@sm/core';
import { registerAdminRoutes } from './admin';
import { registerLegalRoutes } from './legal';
import { registerRoutes } from './routes';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const app = Fastify({
  logger: { level: config.isProd ? 'info' : 'warn', redact: ['req.headers.authorization', 'req.headers["x-admin-token"]'] },
  bodyLimit: 1024 * 1024,
  trustProxy: true,
});

await app.register(cors, { origin: true, methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] });
await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

// Raw bytes for signed uploads; JSON everywhere else.
app.addContentTypeParser(/^(image|audio)\//, { parseAs: 'buffer', bodyLimit: 11 * 1024 * 1024 }, (_req, body, done) => done(null, body));
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 11 * 1024 * 1024 }, (_req, body, done) => done(null, body));

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message });
  if (err instanceof z.ZodError) return reply.status(400).send({ error: 'invalid_input', message: z.prettifyError(err) });
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status < 500) return reply.status(status).send({ error: 'bad_request', message: (err as Error).message });
  app.log.error(err);
  // The route pattern, not the address, so ids never end up in the error list.
  void admin.recordServerError(_req.method, _req.routeOptions?.url ?? 'unknown', (err as Error).message ?? 'error');
  return reply.status(500).send({ error: 'internal_error' });
});

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AppError(401, 'unauthorized');
  req.actor = await identity.authenticate(header.slice(7));
}

app.addHook('onRequest', async (req) => {
  if (req.url === '/health' || req.url.startsWith('/v1/ws')) return;
  await rateLimit(`ip:${req.ip}`, 600, 60);
});

app.get('/health', async () => ({ ok: true, env: config.APP_ENV }));
app.get('/admin', async (_req, reply) => reply.type('text/html').send(readFileSync(join(here, '../public/admin.html'), 'utf8')));

// Test builds: lets a phone on the same network download the APK straight from this machine.
app.get('/app.apk', async (_req, reply) => {
  const file = join(ROOT, 'SkillMarketplace.apk');
  if (config.isProd || !existsSync(file)) return reply.status(404).send({ error: 'not_found' });
  return reply
    .type('application/vnd.android.package-archive')
    .header('content-disposition', 'attachment; filename="SkillMarketplace.apk"')
    .send(createReadStream(file));
});

registerRoutes(app);
registerAdminRoutes(app);
registerLegalRoutes(app);

// ---------------------------------------------------------------- realtime gateway (spec §11)
// Sockets carry only "something changed" hints; clients fetch the data over HTTPS.
const sockets = new Map<string, Set<{ send: (data: string) => void }>>();

subscribe((accountId, event) => {
  const set = sockets.get(accountId);
  if (!set) return;
  const frame = JSON.stringify(event);
  for (const s of set) s.send(frame);
});

app.get('/v1/ws', { websocket: true }, (socket) => {
  let accountId: string | null = null;
  let beat: NodeJS.Timeout | null = null;
  const authTimer = setTimeout(() => socket.close(4401, 'auth timeout'), 8000);

  socket.on('message', async (raw: Buffer) => {
    let msg: { type?: string; token?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'auth' && !accountId && msg.token) {
      try {
        accountId = (await identity.authenticate(msg.token)).accountId;
      } catch {
        socket.close(4401, 'unauthorized');
        return;
      }
      clearTimeout(authTimer);
      if (!sockets.has(accountId)) sockets.set(accountId, new Set());
      sockets.get(accountId)!.add(socket);
      const mark = () => redis.set(presenceKey(accountId!), '1', 'EX', 60).catch(() => undefined);
      await mark();
      beat = setInterval(mark, 25_000);
      socket.send(JSON.stringify({ type: 'ready' }));
    } else if (msg.type === 'ping') {
      socket.send('{"type":"pong"}');
    }
  });

  socket.on('close', () => {
    clearTimeout(authTimer);
    if (beat) clearInterval(beat);
    if (!accountId) return;
    const set = sockets.get(accountId);
    set?.delete(socket);
    if (set && set.size === 0) {
      sockets.delete(accountId);
      redis.del(presenceKey(accountId)).catch(() => undefined);
    }
  });
});

// The web app, when it has been built (`pnpm build:web`), is served from the same
// address as the API, so one URL is everything a tester needs.
const webDir = join(ROOT, 'apps/mobile/dist');
if (existsSync(join(webDir, 'index.html'))) {
  await app.register(fastifyStatic, { root: webDir, wildcard: false, maxAge: '1h' });
  const indexHtml = readFileSync(join(webDir, 'index.html'), 'utf8');
  const RESERVED = /^\/(v1|admin|legal|health|app\.apk)(\/|$)/;
  app.setNotFoundHandler((req, reply) => {
    // Any other page address belongs to the app's own router.
    if (req.method === 'GET' && !RESERVED.test(req.url) && !/\.[a-z0-9]{2,5}(\?|$)/i.test(req.url)) {
      return reply.type('text/html').header('cache-control', 'no-cache').send(indexHtml);
    }
    return reply.status(404).send({ error: 'not_found' });
  });
  console.log('[api] serving the web app');
}

// One process is enough for local development; production runs apps/worker separately.
let stopWorker: (() => Promise<void>) | null = null;
// A single small hosted instance (free staging) can also run the worker in-process with INLINE_WORKER=true.
if (config.INLINE_WORKER ? config.INLINE_WORKER === 'true' : !config.isProd) {
  stopWorker = await startWorker();
  console.log('[api] background worker running in-process');
}

await app.listen({ port: config.PORT, host: '0.0.0.0' });
console.log(`[api] listening on http://localhost:${config.PORT}  (admin console: /admin)`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await stopWorker?.();
    await closePools();
    redis.disconnect();
    process.exit(0);
  });
}
