import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import {
  assertPoolUsesIsolatedTestDatabase,
  configurePostgresIntegrationEnvironment,
  truncatePublicTablesForIntegrationTests,
} from '@infra/db/postgres-test-isolation';
import { createMealHistoryEpoch, type CreateEpochOptions } from './create-meal-history-epoch';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

const MIGRATIONS_DIR = resolve(__dirname, '../infra/db/migrations');
// Mirrors the dev database: 026 is not applied.
const SKIPPED_MIGRATIONS = new Set(['026_meal_supersession.sql']);

async function applyMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const fileName of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
      if (SKIPPED_MIGRATIONS.has(fileName)) continue;
      if (((await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [fileName])).rowCount ?? 0) > 0) continue;
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

describePostgres('create-meal-history-epoch (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let database: string;
  const quiet = () => undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrations(pool);
    database = (await pool.query(`SELECT current_database() AS db`)).rows[0].db;
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
  });

  afterAll(async () => {
    if (pool) {
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  async function patient(): Promise<string> {
    const patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'epoch-script-test')`, [patientId]);
    return patientId;
  }

  const futureStart = (hours = 24) => new Date(Date.now() + hours * 3_600_000).toISOString().replace('.000Z', 'Z');
  const options = (patientId: string, overrides: Partial<CreateEpochOptions> = {}): CreateEpochOptions => ({
    database,
    patientId,
    startsAt: futureStart(),
    policy: 'new-meal-assignment.v1',
    decidedBy: 'integration-test',
    note: 'Integration test of the epoch script',
    execute: false,
    ...overrides,
  });
  const epochs = async (patientId: string) => (await pool.query(`SELECT * FROM meal_history_epochs WHERE patient_id = $1::uuid`, [patientId])).rows;

  async function withClient<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  it('rolls back a dry run after all checks pass', async () => {
    const patientId = await patient();
    const lines: string[] = [];
    const result = await withClient((client) => createMealHistoryEpoch(client, options(patientId), (line) => lines.push(line)));
    expect(result.status).toBe('DRY_RUN_OK');
    expect(await epochs(patientId)).toEqual([]);
    expect(lines.join('\n')).toContain('check ok: no push notification created');
    expect(lines.join('\n')).not.toMatch(/postgres(ql)?:\/\//);
  });

  it('creates exactly one epoch starting at starts_at, then refuses a second one', async () => {
    const patientId = await patient();
    const startsAt = '2030-01-15T03:00:00+01:00';
    const created = await withClient((client) => createMealHistoryEpoch(client, options(patientId, { startsAt, execute: true }), quiet));
    expect(created.status).toBe('CREATED');

    const [row] = await epochs(patientId);
    expect(row).toMatchObject({
      id: created.epochId,
      assignment_policy_version: 'new-meal-assignment.v1',
      decided_by: 'integration-test',
      note: 'Integration test of the epoch script',
      retired_at: null,
    });
    expect(row.starts_at.toISOString()).toBe('2030-01-15T02:00:00.000Z');

    await expect(withClient((client) => createMealHistoryEpoch(client, options(patientId, { execute: true }), quiet)))
      .rejects.toThrow('already has an active meal history epoch');
    expect(await epochs(patientId)).toHaveLength(1);
  });

  it('lets only one of two parallel executions create the epoch', async () => {
    const patientId = await patient();
    const results = await Promise.allSettled([
      withClient((client) => createMealHistoryEpoch(client, options(patientId, { execute: true }), quiet)),
      withClient((client) => createMealHistoryEpoch(client, options(patientId, { execute: true }), quiet)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toContain('already has an active meal history epoch');
    expect(await epochs(patientId)).toHaveLength(1);
  });

  it('refuses a wrong database name, a missing patient and a start in the past by the database clock', async () => {
    const patientId = await patient();
    await expect(withClient((client) => createMealHistoryEpoch(client, options(patientId, { database: 'gluco_mind', execute: true }), quiet)))
      .rejects.toThrow('REFUSED: connected to');
    await expect(withClient((client) => createMealHistoryEpoch(client, options(randomUUID(), { execute: true }), quiet)))
      .rejects.toThrow('patient does not exist');
    // A skewed local clock passes the local check; the database clock still refuses.
    await expect(withClient((client) => createMealHistoryEpoch(client, options(patientId, { startsAt: '2020-01-01T00:00:00Z', execute: true }), quiet, new Date('2019-01-01T00:00:00Z'))))
      .rejects.toThrow('database clock');
    await expect(withClient((client) => createMealHistoryEpoch(client, options(patientId, { startsAt: '2020-01-01T00:00:00Z', execute: true }), quiet)))
      .rejects.toThrow('must be in the future');
    expect(await epochs(patientId)).toEqual([]);
  });

  it('refuses when migration 027 is not installed', async () => {
    const patientId = await patient();
    await pool.query(`ALTER TABLE meal_history_epochs RENAME TO meal_history_epochs_hidden_for_test`);
    try {
      await expect(withClient((client) => createMealHistoryEpoch(client, options(patientId, { execute: true }), quiet)))
        .rejects.toThrow('migration 027_meal_history.sql is not applied');
    } finally {
      await pool.query(`ALTER TABLE meal_history_epochs_hidden_for_test RENAME TO meal_history_epochs`);
    }
    expect(await epochs(patientId)).toEqual([]);
  });

  it('gives up after the lock timeout while a meal write holds the patient lock, creating nothing', async () => {
    const patientId = await patient();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`meal-history:${patientId}`]);
      const started = Date.now();
      await expect(withClient((client) => createMealHistoryEpoch(client, options(patientId, { execute: true }), quiet)))
        .rejects.toThrow(/lock timeout/);
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await epochs(patientId)).toEqual([]);
  });
});
