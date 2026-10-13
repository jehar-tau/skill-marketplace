import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

export const ROOT = findRoot();
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Either 64 hex characters, or any random string of 32+ characters (hosting
// providers that generate secrets for you produce the latter).
const hexKey = z.string().min(32, 'needs at least 32 characters');
const optional = z.string().optional().transform((v) => (v ? v : undefined));

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Which deployment this is. Staging and production both run with NODE_ENV=production.
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  DATABASE_OWNER_URL: z.string(),
  DATABASE_APP_URL: z.string(),
  DATABASE_APP_PASSWORD: z.string().default('sm_app_dev'),
  REDIS_URL: z.string(),
  PORT: z.coerce.number().default(4000),
  APP_NAME: z.string().default('Skill Marketplace'),
  SUPPORT_EMAIL: z.string().default('support@example.com'),
  // Render sets RENDER_EXTERNAL_URL to the service's public address.
  PUBLIC_BASE_URL: z.string().default(process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:4000'),
  // Connection limits. Free database tiers allow few connections; see docs/ENVIRONMENTS.md.
  DB_POOL_MAX: z.coerce.number().int().min(2).default(20),
  DB_JOBS_POOL_MAX: z.coerce.number().int().min(2).default(6),
  // Run the background worker inside the API process. Default: on in development, off in production.
  INLINE_WORKER: z.enum(['true', 'false']).optional(),
  JWT_SECRET: z.string().min(32),
  PHONE_ENC_KEY: hexKey,
  PHONE_HASH_KEY: hexKey,
  MEDIA_SIGNING_KEY: hexKey,
  ADMIN_TOKEN: z.string().min(16),
  OTP_PROVIDER: z.enum(['dev', 'pilot', 'fast2sms', 'twofactor', 'sms', 'http']).default('dev'),
  PILOT_CODE: optional,
  PILOT_PHONES: optional,
  TWOFACTOR_API_KEY: optional,
  FAST2SMS_API_KEY: optional,
  FAST2SMS_OTP_ID: optional,
  WHATSAPP_TOKEN: optional,
  WHATSAPP_PHONE_NUMBER_ID: optional,
  WHATSAPP_ALERT_TEMPLATE: z.string().default('new_lead'),
  WHATSAPP_TEMPLATE_LANG: z.string().default('en'),
  SMS_PROVIDER: z.enum(['dev', 'http', 'phone', 'whatsapp']).default('dev'),
  SMS_PHONE_URL: optional,
  SMS_PHONE_USER: optional,
  SMS_PHONE_PASS: optional,
  SMS_HTTP_URL: optional,
  SMS_HTTP_AUTH: optional,
  PUSH_PROVIDER: z.enum(['dev', 'expo']).default('dev'),
  AI_INTERPRETER: z.enum(['rules', 'anthropic', 'openai_compat']).default('rules'),
  AI_LLM_MODEL: z.string().default('claude-opus-5-5'),
  AI_LLM_BASE_URL: optional,
  AI_LLM_API_KEY: optional,
  AI_LLM_TIMEOUT_MS: z.coerce.number().default(15000),
  AI_LLM_PRICE_IN: z.coerce.number().default(0),
  AI_LLM_PRICE_OUT: z.coerce.number().default(0),
  AI_EMBEDDER: z.enum(['local', 'openai_compat']).default('local'),
  AI_EMBED_BASE_URL: optional,
  AI_EMBED_API_KEY: optional,
  AI_EMBED_MODEL: optional,
  AI_EMBED_DIMS: z.coerce.number().optional(),
  AI_ASR: z.enum(['none', 'openai_compat']).default('none'),
  AI_ASR_BASE_URL: optional,
  AI_ASR_API_KEY: optional,
  AI_ASR_MODEL: optional,
  AI_DAILY_SPEND_CAP_USD: z.coerce.number().default(20),
  MEDIA_STORAGE: z.enum(['local', 's3']).default('local'),
  MEDIA_LOCAL_DIR: z.string().default('.data/media'),
  S3_BUCKET: optional,
  S3_REGION: z.string().default('ap-south-1'),
  S3_ENDPOINT: optional,
  WAVE_SIZE: z.coerce.number().int().default(5),
  WAVE_EXPIRY_SECONDS: z.coerce.number().int().default(600),
  MAX_WAVES: z.coerce.number().int().default(3),
  SMS_FALLBACK_SECONDS: z.coerce.number().int().default(90),
  DEFAULT_CELL: z.string().default('pune'),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = {
  ...parsed.data,
  mediaLocalDir: resolve(ROOT, parsed.data.MEDIA_LOCAL_DIR),
  isProd: parsed.data.NODE_ENV === 'production',
  termsVersion: '2026-10',
};

if (config.OTP_PROVIDER === 'pilot' && !/^[0-9]{6}$/.test(config.PILOT_CODE ?? '')) {
  console.error('OTP_PROVIDER=pilot needs PILOT_CODE set to six digits.');
  process.exit(1);
}

if (config.isProd && (config.OTP_PROVIDER === 'dev' || config.JWT_SECRET.startsWith('dev_only'))) {
  console.error('Refusing to start in production with development OTP or secrets.');
  process.exit(1);
}
