import { defineConfig } from 'vitest/config';

// Integration tests run against a separate database and Redis index so they never touch development data.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_OWNER_URL: 'postgres://sm_owner:sm_owner_dev@localhost:55432/skill_marketplace_test',
      DATABASE_APP_URL: 'postgres://sm_app:sm_app_dev@localhost:55432/skill_marketplace_test',
      REDIS_URL: 'redis://localhost:56379/1',
      OTP_PROVIDER: 'dev',
      SMS_PROVIDER: 'dev',
      PUSH_PROVIDER: 'dev',
      AI_INTERPRETER: 'rules',
      AI_EMBEDDER: 'local',
      AI_ASR: 'none',
      MEDIA_LOCAL_DIR: '.data/media-test',
      WAVE_SIZE: '5',
      MAX_WAVES: '3',
    },
  },
});
