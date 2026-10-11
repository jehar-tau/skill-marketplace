// Language accuracy check (spec §10 release gate). Runs every labelled example
// through the interpreter set in .env and reports what it got right.
//   pnpm eval            uses the configured interpreter
//   pnpm eval rules      forces the built-in rules
// The examples in eval/cases.json are a starter set written by hand. Replace
// and extend them with real sentences from pilot users, checked by native speakers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT } from './config';
import { interpretWithAnthropic } from './ai/anthropic';
import { interpretWithOpenAiCompat } from './ai/openaiCompat';
import { interpretWithRules } from './ai/rules';
import type { InterpretOutput } from './ai/types';

interface Case {
  purpose: 'request' | 'capability';
  text: string;
  locale: string;
  categories: string[];
  attrs: Record<string, unknown>;
  count?: number;
  hasDeadline?: boolean;
  mustNotHave?: Record<string, unknown>;
}

const mode = process.argv[2] === 'rules' ? 'rules' : config.AI_INTERPRETER;
const cases = JSON.parse(readFileSync(join(ROOT, 'packages/core/eval/cases.json'), 'utf8')) as Case[];
const tally = { language: 0, category: 0, facts: 0, factsTotal: 0, invented: 0, split: 0, splitTotal: 0, deadline: 0, deadlineTotal: 0, errors: 0 };
const misses: string[] = [];

for (const c of cases) {
  let out: InterpretOutput;
  try {
    out = mode === 'anthropic' ? await interpretWithAnthropic(c) : mode === 'openai_compat' ? await interpretWithOpenAiCompat(c) : interpretWithRules(c);
    // Free tiers allow only a few calls a minute.
    if (mode !== 'rules') await new Promise((r) => setTimeout(r, 4500));
  } catch (e) {
    tally.errors++;
    misses.push(`ERROR  ${c.text.slice(0, 50)} — ${(e as Error).message.slice(0, 80)}`);
    continue;
  }
  const short = c.text.slice(0, 50);
  if (out.locale === c.locale) tally.language++;
  else misses.push(`language  ${short} — said ${out.locale}, expected ${c.locale}`);

  const got = out.items.map((i) => i.categorySlug);
  const categoryOk = c.purpose === 'capability' && c.count ? c.categories.every((x) => got.includes(x)) : c.categories.includes(got[0] ?? '');
  if (categoryOk) tally.category++;
  else misses.push(`category  ${short} — got ${got.join(', ') || 'nothing'}`);

  if (c.count !== undefined) {
    tally.splitTotal++;
    if (out.items.length === c.count) tally.split++;
    else misses.push(`split     ${short} — ${out.items.length} item(s), expected ${c.count}`);
  }
  // Facts are checked against everything extracted, since a multi-skill sentence spreads them over items.
  const merged = Object.assign({}, ...out.items.map((i) => i.attributes)) as Record<string, unknown>;
  for (const [k, v] of Object.entries(c.attrs)) {
    tally.factsTotal++;
    const ok = k === 'subject' ? String(merged[k] ?? '').includes(String(v)) : merged[k] === v;
    if (ok) tally.facts++;
    else misses.push(`fact      ${short} — ${k}: got ${JSON.stringify(merged[k])}, expected ${JSON.stringify(v)}`);
  }
  for (const [k, v] of Object.entries(c.mustNotHave ?? {})) {
    const bad = v === null ? merged[k] !== undefined : merged[k] === v;
    if (bad) {
      tally.invented++;
      misses.push(`INVENTED  ${short} — ${k}: ${JSON.stringify(merged[k])}`);
    }
  }
  if (c.hasDeadline) {
    tally.deadlineTotal++;
    if (out.items[0]?.deadlineAt) tally.deadline++;
    else misses.push(`deadline  ${short} — none found`);
  }
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}% (${a}/${b})` : 'n/a');
console.log(`\nInterpreter: ${mode}${mode === 'rules' ? '' : ' · ' + config.AI_LLM_MODEL}   Examples: ${cases.length}\n`);
console.log(`  Language detected    ${pct(tally.language, cases.length)}`);
console.log(`  Right kind of work   ${pct(tally.category, cases.length)}`);
console.log(`  Facts kept           ${pct(tally.facts, tally.factsTotal)}`);
console.log(`  Skills separated     ${pct(tally.split, tally.splitTotal)}`);
console.log(`  Deadline understood  ${pct(tally.deadline, tally.deadlineTotal)}`);
console.log(`  Invented facts       ${tally.invented}`);
console.log(`  Failed calls         ${tally.errors}`);
if (misses.length) console.log(`\nMisses:\n  ` + misses.join('\n  '));
console.log('');
process.exit(0);
