// Outbox event envelope (spec §12). Payloads carry IDs only, never user text.

export type OutboxEventType =
  | 'request.confirmed'
  | 'capability.activated'
  | 'wave.created'
  | 'match.responded'
  | 'message.created'
  | 'media.uploaded'
  | 'agreement.confirmed'
  | 'job.resolved'
  | 'proof.added'
  | 'account.deleted';

export interface OutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: OutboxEventType;
  payload: Record<string, unknown>;
  cellId: string | null;
}

// Background job names (pg-boss queues).
export const JOBS = {
  dispatchRequest: 'dispatch.request',
  matchCapability: 'dispatch.capability',
  notifyWave: 'notify.wave',
  waveExpire: 'wave.expire',
  smsFallback: 'notify.sms_fallback',
  messagePush: 'notify.message',
  responsePush: 'notify.response',
  mediaProcess: 'media.process',
  jobPrompt: 'trust.job_prompt',
  learnChat: 'profile.learn_chat',
  learnPhoto: 'profile.learn_photo',
  maintenance: 'maintenance.sweep',
} as const;
