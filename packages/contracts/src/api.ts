import { z } from 'zod';
import { Attributes } from './attributes';

export const LocaleZ = z.enum(['en', 'hi', 'mr']);
export const Uuid = z.string().uuid();

// --- Identity
export const OtpStartBody = z.object({ phone: z.string().regex(/^\+?[0-9]{10,13}$/) });
export const OtpVerifyBody = z.object({
  phone: z.string(),
  code: z.string().regex(/^[0-9]{6}$/),
  deviceId: z.string().min(8).max(100),
  platform: z.enum(['android', 'ios', 'web']),
  locale: LocaleZ.optional(),
});
export const RefreshBody = z.object({ refreshToken: z.string().min(20), deviceId: z.string() });
export const UpdateMeBody = z
  .object({ displayName: z.string().min(1).max(60), preferredLocale: LocaleZ })
  .partial();
export const DeviceBody = z.object({
  pushToken: z.string().max(400).nullable().optional(),
  batteryExemptConfirmed: z.boolean().optional(),
});
export const ProviderSettingsBody = z
  .object({
    paused: z.boolean(),
    quietStart: z.string().regex(/^\d{2}:\d{2}$/),
    quietEnd: z.string().regex(/^\d{2}:\d{2}$/),
    dailyCap: z.number().int().min(1).max(200),
  })
  .partial();

// --- Utterances (shared by capability capture and request creation)
export const LocationZ = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export const InterpretBody = z.object({
  purpose: z.enum(['capability', 'request']),
  text: z.string().min(2).max(2000).optional(),
  audioAssetId: Uuid.optional(),
  locale: LocaleZ.optional(),
  location: LocationZ.optional(),
  localityText: z.string().max(120).optional(),
});

export const DraftZ = z.object({
  interpretationId: Uuid,
  categorySlug: z.string(),
  categoryLabel: z.string(),
  canonicalEn: z.string(),
  attributes: Attributes,
  deadlineAt: z.string().nullable(),
  confirmationText: z.string(),
});
export type Draft = z.infer<typeof DraftZ>;

export const InterpretResponse = z.object({
  utteranceId: Uuid,
  originalText: z.string(),
  locale: LocaleZ,
  drafts: z.array(DraftZ),
  needsClarification: z.string().nullable(),
});
export type InterpretResponse = z.infer<typeof InterpretResponse>;

export const ConfirmCapabilitiesBody = z.object({
  interpretationIds: z.array(Uuid).min(1).max(8),
  location: LocationZ,
  serviceRadiusM: z.number().int().min(500).max(50000).optional(),
});
export const ConfirmRequestBody = z.object({
  interpretationId: Uuid,
  location: LocationZ,
});
export const CapabilityPatchBody = z
  .object({ status: z.enum(['active', 'paused', 'removed']), serviceRadiusM: z.number().int().min(500).max(50000) })
  .partial();

// --- Matching
export const MatchRespondBody = z.object({ action: z.enum(['interested', 'declined']) });
export const AckBody = z.object({ event: z.enum(['delivered', 'opened']) });

// --- Chat
export const SendMessageBody = z.object({
  clientMessageId: Uuid,
  body: z.string().min(1).max(4000).optional(),
  mediaAssetId: Uuid.optional(),
});
export const ReceiptBody = z.object({ deliveredSeq: z.number().int().optional(), readSeq: z.number().int().optional() });

// --- Trust
export const AgreementBody = z.object({
  what: z.string().min(2).max(300),
  scheduledFor: z.string().datetime({ offset: true }),
  priceMinor: z.number().int().positive().optional(),
});
export const JobAnswerBody = z.object({ answer: z.enum(['yes', 'no']) });
export const RatingBody = z.object({
  stars: z.number().int().min(1).max(5),
  tags: z.array(z.string().max(30)).max(6).optional(),
  comment: z.string().max(500).optional(),
});
export const VerificationBody = z.object({ kind: z.literal('udyam'), reference: z.string().regex(/^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/) });

// --- Safety
export const ReportBody = z.object({
  subjectAccountId: Uuid,
  conversationId: Uuid.optional(),
  reason: z.enum(['harassment', 'fraud', 'no_show', 'unsafe', 'spam', 'other']),
  detail: z.string().max(1000).optional(),
});
export const BlockBody = z.object({ accountId: Uuid });

// --- Media
export const MediaUploadBody = z.object({
  kind: z.enum(['image', 'audio']),
  mime: z.string().max(80),
  bytes: z.number().int().positive().max(10 * 1024 * 1024),
  conversationId: Uuid.optional(),
});

// --- Realtime frames pushed over the WebSocket
export type RealtimeEvent =
  | { type: 'message'; conversationId: string; seq: number }
  | { type: 'receipt'; conversationId: string }
  | { type: 'match'; matchId: string }
  | { type: 'request'; requestId: string }
  | { type: 'conversation'; conversationId: string }
  | { type: 'agreement'; conversationId: string };
