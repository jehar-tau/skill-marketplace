import type { Attributes, Locale } from '@sm/contracts';

export interface InterpretInput {
  purpose: 'capability' | 'request';
  text: string;
  localeHint?: Locale;
}

export interface InterpretedItem {
  categorySlug: string;
  canonicalEn: string;
  // The part of the user's own words this item was read from.
  sourceSpan: string;
  attributes: Attributes;
  // Anything outside the typed schema: searchable, never filterable.
  extra: Record<string, unknown>;
  deadlineAt: string | null;
}

export interface InterpretOutput {
  locale: Locale;
  items: InterpretedItem[];
  clarification: string | null;
  provider: string;
  modelId: string;
  promptVersion: string;
  usage: { inputTokens?: number; outputTokens?: number; audioSeconds?: number };
  estCostUsd: number;
}
