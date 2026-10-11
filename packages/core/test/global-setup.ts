import pg from 'pg';

const ADMIN_URL = 'postgres://sm_owner:sm_owner_dev@localhost:55432/skill_marketplace';

export default async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS skill_marketplace_test WITH (FORCE)');
  await admin.query('CREATE DATABASE skill_marketplace_test');
  await admin.end();

  process.env.DATABASE_OWNER_URL = 'postgres://sm_owner:sm_owner_dev@localhost:55432/skill_marketplace_test';
  process.env.DATABASE_APP_URL = 'postgres://sm_app:sm_app_dev@localhost:55432/skill_marketplace_test';
  process.env.REDIS_URL = 'redis://localhost:56379/1';
  process.env.AI_EMBEDDER = 'local';
  const { migrate } = await import('../src/migrate');
  const { closePools } = await import('../src/db');
  const { redis } = await import('../src/redis');
  await migrate();
  await redis.flushdb();
  await closePools();
  redis.disconnect();
}
