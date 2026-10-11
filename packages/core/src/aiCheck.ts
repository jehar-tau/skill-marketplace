// Checks every configured AI provider with one real call each and says plainly
// what works. Run with: pnpm ai:check
import { config } from './config';
import { activeEmbedder } from './ai/embeddings';
import { interpretWithAnthropic } from './ai/anthropic';
import { interpretWithOpenAiCompat } from './ai/openaiCompat';
import { interpretWithRules } from './ai/rules';

const SAMPLES = [
  { purpose: 'request' as const, text: 'मला उद्या रात्री ८ वाजेपर्यंत २ किलो चिकन बिर्याणी पाहिजे' },
  { purpose: 'capability' as const, text: 'main dasvi tak maths padhata hoon aur ghar ka veg khana bhi banata hoon, 300 rupaye per kg' },
];
let failed = false;

console.log(`\nUnderstanding text: ${config.AI_INTERPRETER}${config.AI_INTERPRETER === 'rules' ? ' (built-in, no account needed)' : ` — model ${config.AI_LLM_MODEL}`}`);
for (const s of SAMPLES) {
  try {
    const started = Date.now();
    const out =
      config.AI_INTERPRETER === 'anthropic' ? await interpretWithAnthropic(s)
      : config.AI_INTERPRETER === 'openai_compat' ? await interpretWithOpenAiCompat(s)
      : interpretWithRules(s);
    console.log(`  OK (${Date.now() - started} ms, language ${out.locale}) "${s.text.slice(0, 40)}…"`);
    for (const i of out.items) console.log(`     → ${i.categorySlug}: ${JSON.stringify(i.attributes)}${i.deadlineAt ? ' by ' + i.deadlineAt : ''}`);
    if (out.items.length === 0) console.log(`     → nothing understood (${out.clarification})`);
  } catch (e) {
    failed = true;
    console.log(`  FAILED: ${(e as Error).message}`);
  }
}

const embedder = activeEmbedder();
console.log(`\nMatching vectors: ${config.AI_EMBEDDER} — ${embedder.modelKey}, ${embedder.dims} values`);
try {
  const [a, b, c] = await embedder.embed(['chicken biryani home cooked', 'चिकन बिर्याणी घरगुती', 'plumber to fix a leaking tap']);
  const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
  console.log(`  OK. Same meaning across languages: ${cos(a!, b!).toFixed(2)}; unrelated: ${cos(a!, c!).toFixed(2)} (the first should be clearly higher)`);
} catch (e) {
  failed = true;
  console.log(`  FAILED: ${(e as Error).message}`);
}

console.log(`\nVoice input: ${config.AI_ASR}`);
if (config.AI_ASR === 'openai_compat') {
  try {
    const res = await fetch(`${config.AI_ASR_BASE_URL!.replace(/\/$/, '')}/models`, {
      headers: config.AI_ASR_API_KEY ? { authorization: `Bearer ${config.AI_ASR_API_KEY}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) {
      failed = true;
      console.log('  FAILED: the speech service rejected the key.');
    } else if (res.ok && JSON.stringify(await res.json()).includes(config.AI_ASR_MODEL!)) {
      console.log(`  Key accepted and model ${config.AI_ASR_MODEL} is available. Speak into the app to test the quality.`);
    } else {
      // Self-hosted speech servers often have no model list; reaching the server is the most this can confirm.
      console.log('  The speech server answered. Speak into the app to confirm it transcribes.');
    }
  } catch (e) {
    failed = true;
    console.log(`  FAILED: ${(e as Error).message}`);
  }
} else {
  console.log('  Off. The microphone button stays hidden until a speech service is set in .env.');
}

console.log(`\nSign-in codes: ${config.OTP_PROVIDER} · Push: ${config.PUSH_PROVIDER} · SMS: ${config.SMS_PROVIDER}\n`);
process.exit(failed ? 1 : 0);
