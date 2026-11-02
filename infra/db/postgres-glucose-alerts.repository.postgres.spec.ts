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

describePostgres('glucose alerts (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let patientId: string;
  let otherPatientId: string;
  let caregiver: string;
  let formerCaregiver: string;
  let GlucoseClass: typeof import('./postgres-glucose-alerts.repository').PostgresGlucoseAlertsRepository;
  let RescueClass: typeof import('./postgres-rescue-carbs.repository').PostgresRescueCarbsRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrations(pool);
    GlucoseClass = (await import('./postgres-glucose-alerts.repository')).PostgresGlucoseAlertsRepository;
    RescueClass = (await import('./postgres-rescue-carbs.repository')).PostgresRescueCarbsRepository;
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    patientId = randomUUID();
    otherPatientId = randomUUID();
    caregiver = randomUUID();
    formerCaregiver = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'Ala'), ($2::uuid, 'Kuba')`, [patientId, otherPatientId]);
    await pool.query(`INSERT INTO users (id, display_name) VALUES ($1::uuid, 'Opiekun A'), ($2::uuid, 'Opiekun B')`, [caregiver, formerCaregiver]);
    await pool.query(`INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type) VALUES ($1::uuid, $2::uuid, 'PARENT')`, [caregiver, patientId]);
    // phone-a and phone-a-again: one phone registered twice (same token); phone-b: another phone of the caregiver;
    // phone-old: a caregiver no longer linked.
    await pool.query(
      `INSERT INTO patient_devices (patient_id, platform, device_id, push_token, user_id, updated_at) VALUES
         ($1::uuid, 'ios', 'phone-a', 'token-a', $2::uuid, now() - interval '1 hour'),
         ($1::uuid, 'ios', 'phone-a-again', 'token-a', $2::uuid, now()),
         ($1::uuid, 'ios', 'phone-b', 'token-b', $2::uuid, now()),
         ($1::uuid, 'ios', 'phone-old', 'token-old', $3::uuid, now())`,
      [patientId, caregiver, formerCaregiver],
    );
  });

  afterAll(async () => {
    if (pool) {
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  it('has "Powiadomienia o glikemii" off by default, lists each phone once with its kinds and never a former caregiver\'s phone', async () => {
    const repo = new GlucoseClass(pool);
    const rescue = new RescueClass(pool);
    expect(await repo.listPatientsWithGlucoseAlertDevices()).toEqual([]);
    expect(await rescue.getDeviceSettings(patientId, 'phone-b')).toMatchObject({ glucose_alerts_enabled: false, glucose_alert_kinds_off: [] });

    expect(await rescue.setDeviceSettings(patientId, 'phone-b', { glucose_alerts_enabled: true })).toMatchObject({ glucose_alerts_enabled: true, reservoir_push_enabled: true });
    expect(await rescue.setDeviceSettings(patientId, 'phone-b', { glucose_alert_kinds_off: ['fast', 'no_data'] })).toMatchObject({ glucose_alerts_enabled: true, glucose_alert_kinds_off: ['fast', 'no_data'] });
    expect(await rescue.setDeviceSettings(patientId, 'phone-b', { glucose_alert_low_repeat_minutes: 5, glucose_alert_repeat_minutes: 10 }))
      .toMatchObject({ glucose_alert_low_repeat_minutes: 5, glucose_alert_repeat_minutes: 10, glucose_alert_kinds_off: ['fast', 'no_data'] });
    await expect(rescue.setDeviceSettings(patientId, 'phone-b', { glucose_alert_repeat_minutes: 7 })).rejects.toThrow();
    await rescue.setDeviceSettings(patientId, 'phone-a-again', { glucose_alerts_enabled: true });
    await rescue.setDeviceSettings(patientId, 'phone-old', { glucose_alerts_enabled: true });

    expect(await repo.listPatientsWithGlucoseAlertDevices()).toEqual([patientId]);
    // The switch went to both rows of token-a (one phone): it is listed once.
    expect((await repo.listGlucoseAlertDevices(patientId)).map((device) => [device.push_token, device.kinds_off, device.low_repeat_minutes, device.repeat_minutes])).toEqual([
      ['token-a', [], 15, 30],
      ['token-b', ['fast', 'no_data'], 5, 10],
    ]);
  });

  it('stores the state with a compare-and-set claim', async () => {
    const repo = new GlucoseClass(pool);
    expect(await repo.getState(patientId)).toBeNull();
    const next = { last_reading_at: '2026-11-02T18:00:00.000Z', sent: { 'token-a': { low: '2026-11-02T18:00:30.000Z' } }, no_data_sent_at: null };
    expect(await repo.saveState(patientId, -1, next)).toBe(true);
    expect(await repo.saveState(patientId, -1, next)).toBe(false);
    const stored = await repo.getState(patientId);
    expect(stored).toEqual({ patient_id: patientId, ...next, revision: 0 });

    const later = { ...next, no_data_sent_at: '2026-11-02T18:20:00.000Z' };
    expect(await repo.saveState(patientId, 0, later)).toBe(true);
    expect(await repo.saveState(patientId, 0, later)).toBe(false);
    expect(await repo.getState(patientId)).toEqual({ patient_id: patientId, ...later, revision: 1 });
  });
});
