// The single entry point for model calls (spec §10). It owns routing, timeouts,
// fallback, spend caps and run logging. Callers never talk to a provider directly.

import type { Locale } from '@sm/contracts';
import { config } from '../config';
import { asSystem } from '../db';
import { AppError } from '../errors';
import { redis } from '../redis';
import { interpretWithAnthropic } from './anthropic';
import { interpretWithOpenAiCompat } from './openaiCompat';
import { activeEmbedder, localEmbedding } from './embeddings';
import { interpretWithRules } from './rules';
import type { InterpretInput, InterpretOutput } from './types';

async function logRun(task: string, provider: string, modelId: string, promptVersion: string | null, usage: object, cost: number, status: string, startedAt: number) {
  // Operational metadata only: no user text ever reaches this table.
  await asSystem((tx) =>
    tx.exec(
      `INSERT INTO ai_runs(task, provider, model_id, prompt_version, usage, est_cost_usd, status, latency_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [task, provider, modelId, promptVersion, JSON.stringify(usage), cost, status, Date.now() - startedAt],
    ),
  ).catch((e) => console.error('[ai] failed to log run', e.message));
}

const spendKey = () => `ai:spend:${new Date().toISOString().slice(0, 10)}`;

async function underSpendCap(): Promise<boolean> {
  const spent = Number((await redis.get(spendKey()).catch(() => null)) ?? 0);
  return spent < config.AI_DAILY_SPEND_CAP_USD;
}
async function addSpend(usd: number) {
  if (usd <= 0) return;
  await redis.incrbyfloat(spendKey(), usd).catch(() => undefined);
  await redis.expire(spendKey(), 3 * 86_400).catch(() => undefined);
}

// Circuit breaker: after three consecutive failures, skip the hosted model for a minute.
let failures = 0;
let openUntil = 0;

export async function interpret(input: InterpretInput): Promise<InterpretOutput> {
  const started = Date.now();
  const useHosted = config.AI_INTERPRETER !== 'rules' && Date.now() > openUntil && (await underSpendCap());
  if (useHosted) {
    try {
      const out = config.AI_INTERPRETER === 'anthropic' ? await interpretWithAnthropic(input) : await interpretWithOpenAiCompat(input);
      failures = 0;
      await addSpend(out.estCostUsd);
      await logRun(`interpret_${input.purpose}`, out.provider, out.modelId, out.promptVersion, out.usage, out.estCostUsd, 'ok', started);
      return out;
    } catch (e) {
      if (++failures >= 3) openUntil = Date.now() + 60_000;
      await logRun(`interpret_${input.purpose}`, config.AI_INTERPRETER, config.AI_LLM_MODEL, null, {}, 0, 'error', started);
      console.error('[ai] hosted interpreter failed, using rules:', (e as Error).message);
    }
  }
  const out = interpretWithRules(input);
  await logRun(`interpret_${input.purpose}`, out.provider, out.modelId, out.promptVersion, {}, 0, useHosted ? 'fallback' : 'ok', started);
  return out;
}

export async function embed(texts: string[]): Promise<{ vectors: number[][]; degraded: boolean }> {
  const started = Date.now();
  const embedder = activeEmbedder();
  try {
    const vectors = await embedder.embed(texts);
    if (embedder.modelKey !== 'local_hash_256') await logRun('embed', 'openai_compat', embedder.modelKey, null, { count: texts.length }, 0, 'ok', started);
    return { vectors, degraded: false };
  } catch (e) {
    await logRun('embed', 'openai_compat', embedder.modelKey, null, {}, 0, 'error', started);
    if (embedder.dims === 256) return { vectors: texts.map(localEmbedding), degraded: true };
    throw new AppError(503, 'embedding_unavailable', (e as Error).message);
  }
}

export const asrAvailable = () => config.AI_ASR === 'openai_compat' && !!config.AI_ASR_BASE_URL && !!config.AI_ASR_MODEL;

const ASR_LANG: Record<Locale, string> = { en: 'en', hi: 'hi', mr: 'mr' };

export async function transcribe(audio: Buffer, mime: string, localeHint?: Locale): Promise<string> {
  if (!asrAvailable()) throw new AppError(503, 'asr_unavailable', 'Voice input is not configured; please type instead.');
  const started = Date.now();
  const form = new FormData();
  const ext = mime.includes('webm') ? 'webm' : mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('wav') ? 'wav' : 'ogg';
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `clip.${ext}`);
  form.append('model', config.AI_ASR_MODEL!);
  if (localeHint) form.append('language', ASR_LANG[localeHint]);
  try {
    const res = await fetch(`${config.AI_ASR_BASE_URL!.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: config.AI_ASR_API_KEY ? { authorization: `Bearer ${config.AI_ASR_API_KEY}` } : {},
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`speech endpoint returned ${res.status}`);
    const json = (await res.json()) as { text?: string };
    const text = (json.text ?? '').trim();
    await logRun('transcribe', 'openai_compat', config.AI_ASR_MODEL!, null, { bytes: audio.length }, 0, text ? 'ok' : 'empty', started);
    if (!text) throw new AppError(422, 'asr_empty', 'Could not hear anything in the recording.');
    return text;
  } catch (e) {
    if (e instanceof AppError) throw e;
    await logRun('transcribe', 'openai_compat', config.AI_ASR_MODEL!, null, {}, 0, 'error', started);
    throw new AppError(503, 'asr_unavailable', 'Voice input is unavailable right now; please type instead.');
  }
}
