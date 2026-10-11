import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORIES } from '@sm/contracts';
import { config, ROOT } from './config';
import { ownerPool } from './db';
import { activeEmbedder } from './ai/embeddings';

const MIGRATIONS_DIR = join(ROOT, 'packages/core/migrations');

export function embeddingTable(kind: 'capability' | 'request', modelKey: string) {
  if (!/^[a-z0-9_]+$/.test(modelKey)) throw new Error(`Invalid embedding model key: ${modelKey}`);
  return `${kind}_embeddings_${modelKey}`;
}

// Forward-only migrations, each in its own transaction.
export async function migrate() {
  const c = await ownerPool.connect();
  try {
    await c.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sm_app') THEN
        CREATE ROLE sm_app LOGIN;
      END IF; END $$`);
    // Password comes from the environment so it never lives in a migration file.
    await c.query(`ALTER ROLE sm_app WITH LOGIN PASSWORD ${escapeLiteral(config.DATABASE_APP_PASSWORD)}`);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await c.query('COMMIT');
        console.log(`applied ${file}`);
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }

    for (const cat of CATEGORIES) {
      await c.query(
        `INSERT INTO service_categories(slug, parent_slug, risk_tier, remote_ok, labels)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (slug) DO UPDATE SET risk_tier = EXCLUDED.risk_tier, remote_ok = EXCLUDED.remote_ok, labels = EXCLUDED.labels`,
        [cat.slug, cat.slug.includes('.') ? cat.slug.split('.')[0] : null, cat.riskTier, cat.remoteOk, JSON.stringify(cat.labels)],
      );
    }

    // One pair of embedding tables per model, so each has a fixed vector size (spec §12.2).
    const { modelKey, dims, defaultFloor } = activeEmbedder();
    for (const kind of ['capability', 'request'] as const) {
      await c.query(
        `CREATE TABLE IF NOT EXISTS ${embeddingTable(kind, modelKey)} (
           ${kind}_version_id uuid PRIMARY KEY REFERENCES ${kind}_versions(id) ON DELETE CASCADE,
           embedding vector(${dims}) NOT NULL)`,
      );
    }
    await c.query('UPDATE embedding_models SET active = (model_key = $1)', [modelKey]);
    await c.query(
      `INSERT INTO embedding_models(model_key, dims, active) VALUES ($1, $2, true)
       ON CONFLICT (model_key) DO UPDATE SET active = true`,
      [modelKey, dims],
    );
    const cfg = await c.query('SELECT 1 FROM matching_config WHERE model_key = $1 AND active', [modelKey]);
    if (cfg.rowCount === 0) {
      await c.query('UPDATE matching_config SET active = false');
      await c.query(
        `INSERT INTO matching_config(model_key, floor, weights, note) VALUES ($1, $2, $3, $4)`,
        [modelKey, defaultFloor, JSON.stringify({ semantic: 0.75, lexical: 0.25, sameLeafBonus: 0.05 }),
         'Starting default; recalibrate against the labelled evaluation set before launch.'],
      );
    }
    await c.query(`SELECT ensure_month_partitions(t) FROM unnest(ARRAY['messages','outbox_events','notification_attempts','ai_runs','audit_events']) t`);
  } finally {
    c.release();
  }
}

function escapeLiteral(v: string) {
  return `'${v.replace(/'/g, "''")}'`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => {
      console.log('migrations up to date');
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
