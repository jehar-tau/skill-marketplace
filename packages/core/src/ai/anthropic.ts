import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from '../config';
import { Output, PROMPT_VERSION, SYSTEM, toItems, userMessage } from './shared';
import type { InterpretInput, InterpretOutput } from './types';

// USD per million tokens, for spend metering only.
const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

let client: Anthropic | null = null;

export async function interpretWithAnthropic(input: InterpretInput, now = new Date()): Promise<InterpretOutput> {
  client ??= new Anthropic({ timeout: 20_000, maxRetries: 1 });
  const model = config.AI_LLM_MODEL;

  const response = await client.messages.parse({
    model,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { format: zodOutputFormat(Output), effort: 'low' },
    messages: [
      {
        role: 'user',
        content: userMessage(input, now),
      },
    ],
  });

  if (response.stop_reason === 'refusal') throw new Error('model declined the request');
  const parsed = response.parsed_output;
  if (!parsed) throw new Error('model returned no parsable output');

  const items = toItems(parsed, input, now);

  const [inPrice, outPrice] = PRICES[model] ?? [4, 20];
  const { input_tokens: inputTokens, output_tokens: outputTokens } = response.usage;
  return {
    locale: parsed.locale,
    items,
    clarification: items.length === 0 ? (parsed.clarification ?? 'unclear') : null,
    provider: 'anthropic',
    modelId: model,
    promptVersion: PROMPT_VERSION,
    usage: { inputTokens, outputTokens },
    estCostUsd: (inputTokens * inPrice + outputTokens * outPrice) / 1_000_000,
  };
}
