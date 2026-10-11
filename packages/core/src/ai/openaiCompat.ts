// Interpreter for any OpenAI-compatible chat endpoint (Google Gemini, Groq,
// OpenRouter, a self-hosted model...). The provider is chosen in .env.

import { z } from 'zod';
import { config } from '../config';
import { Output, PROMPT_VERSION, SYSTEM, toItems, userMessage } from './shared';
import type { InterpretInput, InterpretOutput } from './types';

// The schema travels in the prompt because JSON-schema enforcement differs between
// providers; JSON mode plus validation here works on all of them.
const FORMAT = `

Reply with one JSON object and nothing else, in exactly this shape:
{"locale":"mr|hi|en","items":[{"category_slug":"","canonical_en":"","source_span":"","item":null,"diet":null,"quantity":null,"quantity_min":null,"quantity_max":null,"unit":null,"delivery":null,"notice_hours":null,"price_amount":null,"price_per":null,"subject":null,"grade":null,"mode":null,"deadline_iso":null,"other_details":null}],"clarification":null}
Allowed values: diet veg|nonveg|egg|jain; unit kg|g|plates|people|pieces|litres|hours|sessions; mode online|in_person|either. Numbers are JSON numbers, delivery is true/false, and every field you have no stated fact for is null.`;

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model reply');
  return JSON.parse(text.slice(start, end + 1));
}

export async function interpretWithOpenAiCompat(input: InterpretInput, now = new Date()): Promise<InterpretOutput> {
  const { AI_LLM_BASE_URL: base, AI_LLM_API_KEY: key, AI_LLM_MODEL: model } = config;
  if (!base) throw new Error('AI_INTERPRETER=openai_compat needs AI_LLM_BASE_URL');

  const call = async (jsonMode: boolean) =>
    fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 2000,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: SYSTEM + FORMAT },
          { role: 'user', content: userMessage(input, now) },
        ],
      }),
      signal: AbortSignal.timeout(config.AI_LLM_TIMEOUT_MS),
    });

  let res = await call(true);
  // A few endpoints reject JSON mode; the prompt alone is usually enough.
  if (res.status === 400) res = await call(false);
  if (!res.ok) throw new Error(`chat endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('empty model reply');

  const parsed = Output.safeParse(extractJson(content));
  if (!parsed.success) throw new Error('model reply did not match the schema: ' + z.prettifyError(parsed.error).slice(0, 200));
  const items = toItems(parsed.data, input, now);
  const inputTokens = json.usage?.prompt_tokens ?? 0;
  const outputTokens = json.usage?.completion_tokens ?? 0;
  return {
    locale: parsed.data.locale,
    items,
    clarification: items.length === 0 ? (parsed.data.clarification ?? 'unclear') : null,
    provider: 'openai_compat',
    modelId: model,
    promptVersion: PROMPT_VERSION,
    usage: { inputTokens, outputTokens },
    // Priced from .env so the spend cap works for whichever provider is configured (0 on a free tier).
    estCostUsd: (inputTokens * config.AI_LLM_PRICE_IN + outputTokens * config.AI_LLM_PRICE_OUT) / 1_000_000,
  };
}
