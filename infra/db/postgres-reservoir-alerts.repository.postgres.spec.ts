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

describePostgres('reservoir alerts (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let patientId: string;
  let otherPatientId: string;
  let caregiver: string;
  let formerCaregiver: string;
  let observer: string;
  let ReservoirClass: typeof import('./postgres-reservoir-alerts.repository').PostgresReservoirAlertsRepository;
  let RescueClass: typeof import('./postgres-rescue-carbs.repository').PostgresRescueCarbsRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrations(pool);
    ReservoirClass = (await import('./postgres-reservoir-alerts.repository')).PostgresReservoirAlertsRepository;
    RescueClass = (await import('./postgres-rescue-carbs.repository')).PostgresRescueCarbsRepository;
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    patientId = randomUUID();
    otherPatientId = randomUUID();
    caregiver = randomUUID();
    formerCaregiver = randomUUID();
    observer = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'Ala'), ($2::uuid, 'Kuba')`, [patientId, otherPatientId]);
    await pool.query(`INSERT INTO users (id, display_name) VALUES ($1::uuid, 'Opiekun A'), ($2::uuid, 'Opiekun B'), ($3::uuid, 'Opiekun C')`, [caregiver, formerCaregiver, observer]);
    await pool.query(
      `INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type, is_owner, permissions) VALUES
         ($1::uuid, $3::uuid, 'PARENT', true, '{}'::jsonb),
         ($2::uuid, $3::uuid, 'OTHER', false, '{"glucose_alerts": false, "ai_chat_meals": true}'::jsonb)`,
      [caregiver, observer, patientId],
    );
    // phone-a and phone-a-again: one phone registered twice (same token); phone-b: a member without glucose alerts;
    // phone-old: a caregiver no longer linked; phone-legacy: a row without a user (gets no pushes since sharing).
    await pool.query(
      `INSERT INTO patient_devices (patient_id, platform, device_id, push_token, user_id, updated_at) VALUES
         ($1::uuid, 'ios', 'phone-a', 'token-a', $2::uuid, now() - interval '1 hour'),
         ($1::uuid, 'ios', 'phone-a-again', 'token-a', $2::uuid, now()),
         ($1::uuid, 'ios', 'phone-b', 'token-b', $4::uuid, now()),
         ($1::uuid, 'ios', 'phone-c', 'token-c', $2::uuid, now() - interval '2 hours'),
         ($1::uuid, 'ios', 'phone-old', 'token-old', $3::uuid, now()),
         ($1::uuid, 'ios', 'phone-legacy', 'token-legacy', NULL, now())`,
      [patientId, caregiver, formerCaregiver, observer],
    );
  });

  afterAll(async () => {
    if (pool) {
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  it('has "Zbiornik insuliny" on by default, lists each phone once, only for members with glucose alerts', async () => {
    const repo = new ReservoirClass(pool);
    expect(await repo.listPatientsWithReservoirDevices()).toEqual([patientId]);
    expect((await repo.listReservoirDevices(patientId)).map((device) => [device.device_id, device.push_token])).toEqual([['phone-a-again', 'token-a'], ['phone-c', 'token-c']]);

    const rescue = new RescueClass(pool);
    expect(await rescue.getDeviceSettings(patientId, 'phone-c')).toEqual({ device_id: 'phone-c', rescue_carb_alerts_enabled: false, answer_ready_push_enabled: true, reservoir_push_enabled: true });
    expect(await rescue.setDeviceSettings(patientId, 'phone-c', { reservoir_push_enabled: false })).toMatchObject({ reservoir_push_enabled: false, answer_ready_push_enabled: true });
    expect((await repo.listReservoirDevices(patientId)).map((device) => device.device_id)).toEqual(['phone-a-again']);

    await rescue.setDeviceSettings(patientId, 'phone-a', { reservoir_push_enabled: false });
    await rescue.setDeviceSettings(patientId, 'phone-a-again', { reservoir_push_enabled: false });
    expect(await repo.listPatientsWithReservoirDevices()).toEqual([]);
  });

  it('stores the state with a compare-and-set claim', async () => {
    const repo = new ReservoirClass(pool);
    expect(await repo.getState(patientId)).toBeNull();
    const next = { notified_level: 'warning' as const, notified_at: '2026-10-29T18:00:00.000Z', last_units: 19.5, reservoir_changed_at: '2026-10-27T07:00:00.000Z' };

    expect(await repo.saveState(patientId, -1, next, { units: 19.5, hours_left: 21.4 })).toBe(true);
    // A second worker that also read "no row" loses.
    expect(await repo.saveState(patientId, -1, next, { units: 19.5, hours_left: 21.4 })).toBe(false);
    const stored = await repo.getState(patientId);
    expect(stored).toEqual({ patient_id: patientId, ...next, revision: 0 });

    expect(await repo.saveState(patientId, 0, { ...next, last_units: 18 }, null)).toBe(true);
    expect(await repo.saveState(patientId, 0, { ...next, notified_level: 'alarm' }, { units: 7, hours_left: 7 })).toBe(false);
    expect(await repo.getState(patientId)).toMatchObject({ notified_level: 'warning', last_units: 18, revision: 1 });
    const row = (await pool.query(`SELECT notified_units::float AS units, notified_hours_left::float AS hours FROM reservoir_alert_states WHERE patient_id = $1::uuid`, [patientId])).rows[0];
    expect(row).toEqual({ units: 19.5, hours: 21.4 });
  });

  it('switches off every row of a dead token', async () => {
    const repo = new ReservoirClass(pool);
    await repo.deactivatePushToken('token-a');
    expect((await repo.listReservoirDevices(patientId)).map((device) => device.device_id)).toEqual(['phone-c']);
  });
});
