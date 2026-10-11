import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AckBody, AgreementBody, BlockBody, CapabilityPatchBody, ConfirmCapabilitiesBody, ConfirmRequestBody, DeviceBody, InterpretBody,
  JobAnswerBody, MatchRespondBody, MediaUploadBody, OtpStartBody, OtpVerifyBody, ProviderSettingsBody, RatingBody, ReceiptBody,
  RefreshBody, ReportBody, SendMessageBody, UpdateMeBody, VerificationBody,
} from '@sm/contracts';
import { asrAvailable, config, conversations, identity, intake, matching, media, safety, trust } from '@sm/core';
import { requireAuth } from './server';

const IdParams = z.object({ id: z.string().uuid() });
const id = (req: FastifyRequest) => IdParams.parse(req.params).id;

export function registerRoutes(app: FastifyInstance) {
  app.get('/v1/config', async () => ({ voiceInput: asrAvailable(), termsVersion: config.termsVersion, locales: ['mr', 'hi', 'en'] }));

  // ---- sign-in
  app.post('/v1/auth/otp/start', async (req) => identity.startOtp(OtpStartBody.parse(req.body).phone, req.ip));
  app.post('/v1/auth/otp/verify', async (req) => identity.verifyOtp(OtpVerifyBody.parse(req.body)));
  app.post('/v1/auth/refresh', async (req) => {
    const b = RefreshBody.parse(req.body);
    return identity.refresh(b.refreshToken, b.deviceId);
  });

  app.register(async (r) => {
    r.addHook('preHandler', requireAuth);

    r.post('/v1/auth/logout', async (req) => (await identity.logout(req.actor), { ok: true }));
    r.get('/v1/me', async (req) => identity.getMe(req.actor));
    r.patch('/v1/me', async (req) =>
      identity.updateMe(req.actor, UpdateMeBody.extend({ defaultView: z.enum(['find', 'offer']).optional() }).parse(req.body)),
    );
    r.patch('/v1/me/device', async (req) => (await identity.updateDevice(req.actor, DeviceBody.parse(req.body)), { ok: true }));
    r.patch('/v1/me/provider-settings', async (req) => {
      await identity.updateProviderSettings(req.actor, ProviderSettingsBody.parse(req.body));
      return identity.getMe(req.actor);
    });
    r.delete('/v1/me', async (req) => (await identity.deleteAccount(req.actor), { ok: true }));
    r.post('/v1/me/verification', async (req) => trust.submitUdyam(req.actor, VerificationBody.parse(req.body).reference));

    // ---- speak or type, then confirm
    r.post('/v1/interpret', async (req) => intake.interpretUtterance(req.actor, InterpretBody.parse(req.body)));
    r.post('/v1/interpretations/:id/reject', async (req) => (await intake.rejectDraft(req.actor, id(req)), { ok: true }));

    r.post('/v1/capabilities/confirm', async (req) => intake.confirmCapabilities(req.actor, ConfirmCapabilitiesBody.parse(req.body)));
    r.get('/v1/capabilities', async (req) => intake.listCapabilities(req.actor));
    r.patch('/v1/capabilities/:id', async (req) => (await intake.patchCapability(req.actor, id(req), CapabilityPatchBody.parse(req.body)), { ok: true }));

    r.post('/v1/capabilities/:id/revise', async (req) => {
      const b = z.object({ interpretationId: z.string().uuid() }).parse(req.body);
      await intake.reviseCapability(req.actor, id(req), b.interpretationId);
      return { ok: true };
    });
    r.get('/v1/provider/area', async (req) => ({ area: await intake.getServiceArea(req.actor) }));
    r.patch('/v1/provider/area', async (req) => {
      const b = z.object({
        serviceRadiusM: z.number().int().min(500).max(50000).optional(),
        location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
      }).parse(req.body);
      return { area: await intake.setServiceArea(req.actor, b) };
    });

    r.post('/v1/requests/confirm', async (req) => intake.confirmRequest(req.actor, ConfirmRequestBody.parse(req.body)));
    r.get('/v1/requests', async (req) => matching.listMyRequests(req.actor));
    r.get('/v1/requests/:id', async (req) => matching.getRequest(req.actor, id(req)));
    r.post('/v1/requests/:id/cancel', async (req) => (await matching.cancelRequest(req.actor, id(req)), { ok: true }));

    // ---- provider side
    r.get('/v1/provider/summary', async (req) => matching.providerSummary(req.actor));
    r.get('/v1/matches', async (req) => matching.listIncoming(req.actor));
    r.post('/v1/matches/:id/respond', async (req) => matching.respondToMatch(req.actor, id(req), MatchRespondBody.parse(req.body).action));
    r.post('/v1/matches/:id/ack', async (req) => (await matching.acknowledge(req.actor, id(req), AckBody.parse(req.body).event), { ok: true }));

    // ---- chat
    r.get('/v1/conversations', async (req) => conversations.listConversations(req.actor));
    r.get('/v1/conversations/:id', async (req) => conversations.getConversation(req.actor, id(req)));
    r.get('/v1/conversations/:id/messages', async (req) => {
      const q = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(req.query);
      return conversations.listMessages(req.actor, id(req), q.after);
    });
    r.post('/v1/conversations/:id/messages', async (req) => conversations.sendMessage(req.actor, id(req), SendMessageBody.parse(req.body)));
    r.post('/v1/conversations/:id/share-number', async (req) => conversations.shareNumber(req.actor, id(req)));
    r.post('/v1/conversations/:id/receipts', async (req) => (await conversations.updateReceipts(req.actor, id(req), ReceiptBody.parse(req.body)), { ok: true }));
    r.post('/v1/sync', async (req) => {
      const b = z.object({ cursors: z.record(z.string().uuid(), z.number().int().min(0)).default({}) }).parse(req.body ?? {});
      return conversations.sync(req.actor, b.cursors);
    });

    // ---- agreement, job confirmation, rating
    r.get('/v1/conversations/:id/agreement', async (req) => ({ agreement: await trust.getAgreement(req.actor, id(req)) }));
    r.post('/v1/conversations/:id/agreement', async (req) => trust.proposeAgreement(req.actor, id(req), AgreementBody.parse(req.body)));
    r.post('/v1/agreements/:id/confirm', async (req) => trust.confirmAgreement(req.actor, id(req)));
    r.post('/v1/agreements/:id/withdraw', async (req) => (await trust.withdrawAgreement(req.actor, id(req)), { ok: true }));
    r.post('/v1/agreements/:id/answer', async (req) => trust.answerJob(req.actor, id(req), JobAnswerBody.parse(req.body).answer));
    r.post('/v1/agreements/:id/rate', async (req) => trust.rate(req.actor, id(req), RatingBody.parse(req.body)));

    // ---- safety
    r.post('/v1/reports', async (req) => safety.report(req.actor, ReportBody.parse(req.body)));
    r.get('/v1/blocks', async (req) => safety.listBlocks(req.actor));
    r.post('/v1/blocks', async (req) => (await safety.block(req.actor, BlockBody.parse(req.body).accountId), { ok: true }));
    r.delete('/v1/blocks/:id', async (req) => (await safety.unblock(req.actor, id(req)), { ok: true }));

    // ---- media
    r.post('/v1/media', async (req) => media.createUpload(req.actor, MediaUploadBody.parse(req.body)));
    r.post('/v1/media/:id/complete', async (req) => (await media.completeUpload(req.actor, id(req)), { ok: true }));
    r.get('/v1/media/:id', async (req) => media.getMediaUrls(req.actor, id(req)));
  });

  // Signed URLs for local storage. The signature is the authorization.
  const Signed = z.object({ exp: z.string().optional(), sig: z.string().optional() });
  app.put('/v1/media/upload/:id', async (req) => {
    const q = Signed.parse(req.query);
    media.checkLocalSignature(`/v1/media/upload/${id(req)}`, q.exp, q.sig);
    if (!Buffer.isBuffer(req.body)) throw Object.assign(new Error('binary body required'), { statusCode: 415 });
    await media.receiveLocalUpload(id(req), req.body);
    return { ok: true };
  });
  app.get('/v1/media/file/:id/:variant', async (req, reply) => {
    const p = z.object({ id: z.string().uuid(), variant: z.enum(['full', 'thumb']) }).parse(req.params);
    const q = Signed.parse(req.query);
    media.checkLocalSignature(`/v1/media/file/${p.id}/${p.variant}`, q.exp, q.sig);
    const data = await media.readLocalFile(p.id, p.variant);
    return reply.type('image/jpeg').header('cache-control', 'private, max-age=300').send(data);
  });
}
