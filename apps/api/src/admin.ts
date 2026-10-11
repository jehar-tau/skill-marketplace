import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { admin, AppError, config } from '@sm/core';

const Id = z.object({ id: z.string().uuid() });

// A single shared operator token is enough for a pilot run by a few people.
// Replace with per-person accounts before the team grows.
function isAdmin(token: unknown) {
  if (typeof token !== 'string') return false;
  const a = Buffer.from(token);
  const b = Buffer.from(config.ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerAdminRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', async (req) => {
      if (!isAdmin(req.headers['x-admin-token'])) throw new AppError(401, 'unauthorized');
    });
    const who = (req: { headers: Record<string, unknown> }) => String(req.headers['x-admin-name'] ?? 'operator').slice(0, 40);

    r.get('/admin/api/metrics', async () => admin.metrics());
    r.get('/admin/api/reports', async (req) => admin.listReports(z.object({ state: z.enum(['open', 'all']).default('open') }).parse(req.query).state));
    r.get('/admin/api/reports/:id/conversation', async (req) => admin.readReportedConversation(who(req), Id.parse(req.params).id));
    r.post('/admin/api/reports/:id/resolve', async (req) => {
      const body = z.object({
        resolution: z.enum(['resolved', 'dismissed', 'in_review']),
        action: z.enum(['none', 'suspend', 'delete']).optional(),
        note: z.string().max(1000).optional(),
      }).parse(req.body);
      await admin.resolveReport(who(req), Id.parse(req.params).id, body);
      return { ok: true };
    });
    r.post('/admin/api/accounts/:id/status', async (req) => {
      const body = z.object({ status: z.enum(['active', 'suspended']) }).parse(req.body);
      await admin.setAccountStatus(who(req), Id.parse(req.params).id, body.status);
      return { ok: true };
    });
    r.get('/admin/api/accounts/:id/ratings', async (req) => admin.listRatings(Id.parse(req.params).id));
    r.post('/admin/api/ratings/:id/void', async (req) => (await admin.adminVoidRating(who(req), Id.parse(req.params).id), { ok: true }));
    r.get('/admin/api/disputes', async () => admin.listDisputes());
    r.get('/admin/api/uncategorised', async () => admin.listUncategorised());
    r.get('/admin/api/verifications', async () => admin.listVerifications());
    r.post('/admin/api/verifications/:id', async (req) => {
      const body = z.object({ state: z.enum(['verified', 'rejected']) }).parse(req.body);
      await admin.decideVerification(who(req), Id.parse(req.params).id, body.state);
      return { ok: true };
    });
    r.get('/admin/api/matching', async () => admin.getMatchingConfig());
    r.post('/admin/api/matching/floor', async (req) => {
      const body = z.object({ floor: z.number().min(0).max(1), note: z.string().min(3).max(300) }).parse(req.body);
      await admin.setMatchingFloor(who(req), body.floor, body.note);
      return { ok: true };
    });
    r.get('/admin/api/audit', async () => admin.recentAudit());
  });
}
