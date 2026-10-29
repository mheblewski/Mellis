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

describePostgres('patient device registration (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let patientId: string;
  let otherPatientId: string;
  let ewa: string;
  let piotr: string;
  // Loaded lazily: offline runs must not import the gated modules (postgres-gated-spec-imports.spec.ts).
  let GlucoMindClass: typeof import('./postgres-glucomind.repository').PostgresGlucoMindRepository;
  let RescueClass: typeof import('./postgres-rescue-carbs.repository').PostgresRescueCarbsRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrations(pool);
    GlucoMindClass = (await import('./postgres-glucomind.repository')).PostgresGlucoMindRepository;
    RescueClass = (await import('./postgres-rescue-carbs.repository')).PostgresRescueCarbsRepository;
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    patientId = randomUUID();
    otherPatientId = randomUUID();
    ewa = randomUUID();
    piotr = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'Janek'), ($2::uuid, 'Zosia')`, [patientId, otherPatientId]);
    await pool.query(`INSERT INTO users (id, display_name) VALUES ($1::uuid, 'Ewa'), ($2::uuid, 'Piotr')`, [ewa, piotr]);
    await pool.query(
      `INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type) VALUES ($1::uuid, $3::uuid, 'PARENT'), ($2::uuid, $4::uuid, 'PARENT')`,
      [ewa, piotr, patientId, otherPatientId],
    );
  });

  afterAll(async () => {
    if (pool) {
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  async function rows(): Promise<Array<{ patient_id: string; device_id: string; active: boolean; rescue_carb_alerts_enabled: boolean; answer_ready_push_enabled: boolean }>> {
    const result = await pool.query(
      `SELECT patient_id::text, device_id, active, rescue_carb_alerts_enabled, answer_ready_push_enabled FROM patient_devices ORDER BY created_at, device_id`,
    );
    return result.rows;
  }

  it('a reinstall (new device id, same token) replaces the old row and keeps its switches', async () => {
    const glucomind = new GlucoMindClass(pool);
    const rescue = new RescueClass(pool);
    await glucomind.upsertPatientDevice({ patientId, platform: 'ios', deviceId: 'install-1', pushToken: 'token-a', appVersion: null, userId: ewa });
    await rescue.setDeviceSettings(patientId, 'install-1', { rescue_carb_alerts_enabled: true, answer_ready_push_enabled: false, reservoir_push_enabled: false });

    const device = await glucomind.upsertPatientDevice({ patientId, platform: 'ios', deviceId: 'install-2', pushToken: 'token-a', appVersion: null, userId: ewa });
    expect(device).toMatchObject({ device_id: 'install-2', active: true, rescue_carb_alerts_enabled: true, answer_ready_push_enabled: false, reservoir_push_enabled: false });
    expect((device as unknown as Record<string, unknown>).inserted).toBeUndefined();
    expect((await rows()).map((row) => [row.device_id, row.active])).toEqual([['install-1', false], ['install-2', true]]);

    // The switch in Settings (new device id) now really stops the alerts: the old row no longer sends them.
    await rescue.setDeviceSettings(patientId, 'install-2', { rescue_carb_alerts_enabled: false });
    expect(await rescue.listAlertDevices(patientId)).toEqual([]);
    // The old row is inactive: its settings are not served, so the app registers again instead of showing them.
    expect(await rescue.getDeviceSettings(patientId, 'install-1')).toBeNull();
    expect(await rescue.setDeviceSettings(patientId, 'install-1', { rescue_carb_alerts_enabled: true })).toBeNull();
  });

  it('a registration of an existing row keeps its own switches', async () => {
    const glucomind = new GlucoMindClass(pool);
    const rescue = new RescueClass(pool);
    await glucomind.upsertPatientDevice({ patientId, platform: 'ios', deviceId: 'install-1', pushToken: 'token-a', appVersion: null, userId: ewa });
    await glucomind.upsertPatientDevice({ patientId, platform: 'ios', deviceId: 'install-2', pushToken: 'token-b', appVersion: null, userId: ewa });
    await rescue.setDeviceSettings(patientId, 'install-1', { rescue_carb_alerts_enabled: true });

    // install-2 now gets token-a (it is an existing row): it keeps its switch off, install-1 stops.
    const device = await glucomind.upsertPatientDevice({ patientId, platform: 'ios', deviceId: 'install-2', pushToken: 'token-a', appVersion: null, userId: ewa });
    expect(device).toMatchObject({ device_id: 'install-2', active: true, rescue_carb_alerts_enabled: false });
    expect((await rows()).map((row) => [row.device_id, row.active])).toEqual([['install-1', false], ['install-2', true]]);
  });

  it('a phone signed in to another caregiver stops getting the previous caregiver\'s pushes', async () => {
    const glucomind = new GlucoMindClass(pool);
    // Ewa's row of this phone (matched by device id; its token since rotated) and a row without a user from before
    // migration 070 (matched by token).
    await glucomind.upsertPatientDevice({ patientId, platform: 'ios', deviceId: 'phone', pushToken: 'token-old', appVersion: null, userId: ewa });
    await glucomind.upsertPatientDevice({ patientId, platform: 'ios', deviceId: 'legacy', pushToken: 'token-a', appVersion: null });
    // Ewa's sign-out failed offline; Piotr signs in on the same phone.
    await glucomind.upsertPatientDevice({ patientId: otherPatientId, platform: 'ios', deviceId: 'phone', pushToken: 'token-a', appVersion: null, userId: piotr });

    expect(await glucomind.listActivePatientDevices(patientId, 'ios')).toEqual([]);
    expect((await glucomind.listActivePatientDevices(otherPatientId, 'ios')).map((device) => device.device_id)).toEqual(['phone']);
  });

  it('leaves the same caregiver\'s other patients and other phones alone', async () => {
    const glucomind = new GlucoMindClass(pool);
    await pool.query(`INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type) VALUES ($1::uuid, $2::uuid, 'PARENT')`, [ewa, otherPatientId]);
    await glucomind.upsertPatientDevice({ patientId, platform: 'ios', deviceId: 'phone', pushToken: 'token-a', appVersion: null, userId: ewa });
    await glucomind.upsertPatientDevice({ patientId: otherPatientId, platform: 'ios', deviceId: 'phone', pushToken: 'token-a', appVersion: null, userId: ewa });
    await glucomind.upsertPatientDevice({ patientId, platform: 'ios', deviceId: 'own-phone', pushToken: 'token-m', appVersion: null, userId: piotr });
    await glucomind.upsertPatientDevice({ patientId, platform: 'ios', deviceId: 'phone', pushToken: 'token-a', appVersion: null, userId: ewa });

    expect((await rows()).every((row) => row.active)).toBe(true);
  });

  it('a registration without a user only replaces rows of the same patient and token', async () => {
    const glucomind = new GlucoMindClass(pool);
    await glucomind.upsertPatientDevice({ patientId: otherPatientId, platform: 'ios', deviceId: 'phone', pushToken: 'token-a', appVersion: null, userId: piotr });
    await glucomind.upsertPatientDevice({ patientId, platform: 'ios', deviceId: 'phone', pushToken: 'token-a', appVersion: null });

    expect((await rows()).every((row) => row.active)).toBe(true);
  });

  it('a phone releases its own rows with its secret, without a session (085)', async () => {
    const glucomind = new GlucoMindClass(pool);
    await pool.query(`INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type) VALUES ($1::uuid, $2::uuid, 'PARENT') ON CONFLICT DO NOTHING`, [ewa, otherPatientId]);
    await glucomind.upsertPatientDevice({ patientId, platform: 'ios', deviceId: 'phone', pushToken: 'token-a', appVersion: null, userId: ewa, releaseSecretHash: 'hash-1' });
    await glucomind.upsertPatientDevice({ patientId: otherPatientId, platform: 'ios', deviceId: 'phone', pushToken: 'token-a', appVersion: null, userId: ewa, releaseSecretHash: 'hash-1' });
    await glucomind.upsertPatientDevice({ patientId, platform: 'ios', deviceId: 'own-phone', pushToken: 'token-m', appVersion: null, userId: piotr, releaseSecretHash: 'hash-2' });
    // A registration without a secret (an older build) keeps the stored one.
    await glucomind.upsertPatientDevice({ patientId, platform: 'ios', deviceId: 'phone', pushToken: 'token-a', appVersion: null, userId: ewa });

    expect(await glucomind.releasePatientDevices('ios', 'token-a', 'wrong')).toBe(0);
    expect(await glucomind.releasePatientDevices('ios', 'token-a', 'hash-1')).toBe(2);
    expect((await rows()).map((row) => [row.device_id, row.active]).sort()).toEqual([
      ['own-phone', true],
      ['phone', false],
      ['phone', false],
    ]);
  });
});
