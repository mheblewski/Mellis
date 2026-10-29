import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  assertPoolUsesIsolatedTestDatabase,
  configurePostgresIntegrationEnvironment,
  truncatePublicTablesForIntegrationTests,
} from './postgres-test-isolation';
import { PostgresTherapyContextEventRepository } from './postgres-therapy-context-events.repository';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

const MIGRATIONS_DIR = resolve(__dirname, 'migrations');
const SKIPPED_MIGRATIONS = new Set(['026_meal_supersession.sql']);

async function applyMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Local Homebrew Postgres has no pgvector; the RAG index (036) is not needed here.
    const hasVector = ((await client.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)).rowCount ?? 0) > 0;
    for (const fileName of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
      if (SKIPPED_MIGRATIONS.has(fileName) || (!hasVector && fileName.startsWith('036_'))) continue;
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [fileName]);
      if ((applied.rowCount ?? 0) > 0) continue;
      await client.query(readFileSync(resolve(MIGRATIONS_DIR, fileName), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [fileName]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const BASE_MS = Date.parse('2026-11-02T10:00:00.000Z');
const at = (minutes: number) => new Date(BASE_MS + minutes * 60_000).toISOString();

describePostgres('therapy context events (postgres, migration 086)', () => {
  let pool: Pool;
  let repo: PostgresTherapyContextEventRepository;
  let patientId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrations(pool);
    repo = new PostgresTherapyContextEventRepository(pool);
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'context-events-test')`, [patientId]);
  });

  afterAll(async () => {
    if (pool) {
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  const event = (id: string, kind: any, at: string, extra: Record<string, unknown> = {}) => ({ source_record_id: id, kind, event_type: kind, occurred_at: at, duration_minutes: null, details: {}, ...extra });

  it('stores each treatment once and reads a period and the newest of each kind', async () => {
    expect(await repo.insert(patientId, event('a', 'TEMP_TARGET', '2026-10-26T10:00:00.000Z', { duration_minutes: 60, details: { target_top: 140 } }))).toBe(true);
    expect(await repo.insert(patientId, event('a', 'TEMP_TARGET', '2026-10-26T10:00:00.000Z'))).toBe(false);
    await repo.insert(patientId, event('b', 'SITE_CHANGE', '2026-10-24T08:00:00.000Z'));
    await repo.insert(patientId, event('c', 'SITE_CHANGE', '2026-10-26T08:00:00.000Z'));
    await repo.insert(patientId, event('d', 'NOTE', '2026-10-26T12:00:00.000Z', { details: { notes: 'x' } }));

    const period = await repo.listBetween(patientId, '2026-10-26T00:00:00.000Z', '2026-10-26T23:59:00.000Z');
    expect(period.map((entry) => entry.source_record_id)).toEqual(['c', 'a', 'd']);
    expect(period[1]).toMatchObject({ kind: 'TEMP_TARGET', duration_minutes: 60, details: { target_top: 140 } });
    const latest = await repo.latestPerKind(patientId, '2026-10-26T11:00:00.000Z', ['SITE_CHANGE', 'TEMP_TARGET', 'NOTE']);
    expect(latest.map((entry) => entry.source_record_id).sort()).toEqual(['a', 'c']);
  });
});
