import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresNightscoutRepository } from './postgres-nightscout.repository';
import {
  assertPoolUsesIsolatedTestDatabase,
  configurePostgresIntegrationEnvironment,
  truncatePublicTablesForIntegrationTests,
} from './postgres-test-isolation';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

const MIGRATION_025 = readFileSync(resolve(__dirname, 'migrations/025_therapies_observed_at.sql'), 'utf8');

function profile(overrides: Partial<{ therapy_version: string; observed_at: string; snapshot: Record<string, unknown> }> = {}) {
  return {
    source_system: 'NIGHTSCOUT' as const,
    source_record_id: null,
    profile_key: 'Default',
    active_profile_id: 'Default',
    therapy_version: overrides.therapy_version ?? 'ns-profile:v1',
    observed_at: overrides.observed_at ?? '2026-10-09T08:00:00.000Z',
    valid_from: '2026-10-01T00:00:00.000Z',
    valid_to: null,
    snapshot: overrides.snapshot ?? { basal: [{ time: '00:00', value: 0.8 }], carbratio: [{ time: '00:00', value: 10 }] },
    provenance: { source: 'test' },
    completeness: 'COMPLETE' as const,
  };
}

describePostgres('therapies.observed_at schema drift (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let repository: PostgresNightscoutRepository;

  async function createSource(patientId: string) {
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING`, [patientId, `patient-${patientId.slice(0, 8)}`]);
    return repository.ensureNightscoutSource({ patientId, sourceKey: `nightscout-${patientId}`, sourceVersion: 'test', metadata: {} });
  }

  async function hasObservedAtColumn(): Promise<boolean> {
    const result = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'therapies' AND column_name = 'observed_at'`);
    return (result.rowCount ?? 0) > 0;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    // Schema changes below run only after the connection is verified as the isolated test database.
    await assertPoolUsesIsolatedTestDatabase(pool);
    repository = new PostgresNightscoutRepository(pool);
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
  });

  afterAll(async () => {
    if (pool) {
      await assertPoolUsesIsolatedTestDatabase(pool);
      await pool.query(MIGRATION_025);
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  it('reproduces the import failure on a schema without observed_at and recovers via migration 025', async () => {
    const source = await createSource(randomUUID());

    // Simulate a database initialised before 001_init.sql was edited.
    await assertPoolUsesIsolatedTestDatabase(pool);
    await pool.query(`ALTER TABLE therapies DROP COLUMN IF EXISTS observed_at`);
    await expect(repository.persistImportedTherapyProfile({ source: source as any, profile: profile() }))
      .rejects.toMatchObject({ code: '42703' });

    await pool.query(MIGRATION_025);
    expect(await hasObservedAtColumn()).toBe(true);

    const persisted = await repository.persistImportedTherapyProfile({ source: source as any, profile: profile() });
    expect(persisted).not.toBeNull();
    const stored = await pool.query(`SELECT observed_at FROM therapies WHERE patient_id = $1::uuid`, [source.patient_id]);
    expect(stored.rows).toHaveLength(1);
    expect(new Date(stored.rows[0].observed_at).toISOString()).toBe('2026-10-09T08:00:00.000Z');
  });

  it('is a no-op on an up-to-date schema and keeps existing therapy rows', async () => {
    const source = await createSource(randomUUID());
    await repository.persistImportedTherapyProfile({ source: source as any, profile: profile() });

    await pool.query(MIGRATION_025);
    await pool.query(MIGRATION_025);

    const stored = await pool.query(`SELECT therapy_version, observed_at FROM therapies WHERE patient_id = $1::uuid`, [source.patient_id]);
    expect(stored.rows).toHaveLength(1);
    expect(new Date(stored.rows[0].observed_at).toISOString()).toBe('2026-10-09T08:00:00.000Z');
  });

  it('re-imports idempotently per therapy version and isolates patients', async () => {
    const sourceA = await createSource(randomUUID());
    const sourceB = await createSource(randomUUID());

    const first = await repository.persistImportedTherapyProfile({ source: sourceA as any, profile: profile() });
    const second = await repository.persistImportedTherapyProfile({ source: sourceA as any, profile: profile({ observed_at: '2026-10-12T08:00:00.000Z' }) });
    await repository.persistImportedTherapyProfile({ source: sourceB as any, profile: profile({ observed_at: '2026-10-05T08:00:00.000Z' }) });

    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);

    const rowsA = await pool.query(`SELECT observed_at FROM therapies WHERE patient_id = $1::uuid`, [sourceA.patient_id]);
    const rowsB = await pool.query(`SELECT observed_at FROM therapies WHERE patient_id = $1::uuid`, [sourceB.patient_id]);
    expect(rowsA.rows).toHaveLength(1);
    expect(new Date(rowsA.rows[0].observed_at).toISOString()).toBe('2026-10-12T08:00:00.000Z');
    expect(rowsB.rows).toHaveLength(1);
    expect(new Date(rowsB.rows[0].observed_at).toISOString()).toBe('2026-10-05T08:00:00.000Z');
  });
});
