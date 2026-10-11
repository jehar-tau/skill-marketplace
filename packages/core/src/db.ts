import pg from 'pg';
import { config } from './config';

// int8 and numeric as JS numbers: sequence numbers and counts stay well inside 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const appPool = new pg.Pool({ connectionString: config.DATABASE_APP_URL, max: config.DB_POOL_MAX });
export const ownerPool = new pg.Pool({ connectionString: config.DATABASE_OWNER_URL, max: 2 });

type Row = Record<string, any>;

// One database transaction, carrying the actor that row-level security checks against.
export class Tx {
  private systemDepth = 0;
  constructor(
    private client: pg.PoolClient,
    public readonly actorId: string | null,
    private readonly baseSystem: boolean,
  ) {}

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.client.query(sql, params as any[]);
    return res.rows as T[];
  }
  async maybeOne<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }
  async one<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T> {
    const row = await this.maybeOne<T>(sql, params);
    if (!row) throw new Error('Expected a row but query returned none');
    return row;
  }
  async exec(sql: string, params: unknown[] = []): Promise<number> {
    const res = await this.client.query(sql, params as any[]);
    return res.rowCount ?? 0;
  }

  // Runs a block with row-level security lifted. Callers must have already
  // authorized the action; this exists for reads and writes that legitimately
  // cross accounts (matching, trust lines, notifications).
  async elevated<T>(fn: () => Promise<T>): Promise<T> {
    if (this.baseSystem) return fn();
    if (this.systemDepth++ === 0) await this.client.query("SELECT set_config('app.system', 'on', true)");
    try {
      return await fn();
    } finally {
      if (--this.systemDepth === 0) {
        await this.client.query("SELECT set_config('app.system', 'off', true)").catch(() => undefined);
      }
    }
  }
}

async function run<T>(actorId: string | null, system: boolean, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.actor_id', $1, true), set_config('app.system', $2, true)", [
      actorId ?? '',
      system ? 'on' : 'off',
    ]);
    const result = await fn(new Tx(client, actorId, system));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export const asActor = <T>(actorId: string, fn: (tx: Tx) => Promise<T>) => run(actorId, false, fn);
export const asSystem = <T>(fn: (tx: Tx) => Promise<T>) => run(null, true, fn);

export async function closePools() {
  await Promise.all([appPool.end(), ownerPool.end()]);
}
