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

describePostgres('live activity subscriptions (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let patientA: string;
  let patientB: string;
  let userId: string;
  // Loaded lazily: offline runs must not import the gated modules (postgres-gated-spec-imports.spec.ts).
  let RepositoryClass: typeof import('./postgres-live-activity.repository').PostgresLiveActivityRepository;
  const now = new Date('2026-10-27T10:00:00.000Z');

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrations(pool);
    RepositoryClass = (await import('./postgres-live-activity.repository')).PostgresLiveActivityRepository;
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    patientA = randomUUID();
    patientB = randomUUID();
    userId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'A'), ($2::uuid, 'B')`, [patientA, patientB]);
    await pool.query(`INSERT INTO users (id, display_name) VALUES ($1::uuid, 'Ewa')`, [userId]);
    // Live Activities go to members with glucose alerts.
    await pool.query(
      `INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type, is_owner) VALUES ($1::uuid, $2::uuid, 'primary_caregiver', true), ($1::uuid, $3::uuid, 'primary_caregiver', true)`,
      [userId, patientA, patientB],
    );
    await pool.query(
      `INSERT INTO patient_devices (patient_id, platform, device_id, push_token) VALUES ($1::uuid, 'ios', 'phone-1', 'apns'), ($2::uuid, 'ios', 'phone-1', 'apns')`,
      [patientA, patientB],
    );
  });

  afterAll(async () => {
    if (pool) {
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  it('saves the switch and tokens, keeps fields left out and refuses an unregistered phone', async () => {
    const repo = new RepositoryClass(pool);
    const created = await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientA, userId, change: { enabled: true, start_token: 'start-1' }, now });
    expect(created).toMatchObject({ enabled: true, island_enabled: true, start_token: 'start-1', update_token: null });
    // Switched on: the app's own activity comes first, the server waits before a push-to-start.
    expect(Date.parse(created!.start_requested_at!)).toBe(now.getTime());
    const iconOnly = await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientA, userId, change: { island_enabled: false }, now });
    expect(iconOnly).toMatchObject({ enabled: true, island_enabled: false, start_token: 'start-1' });

    const later = new Date(now.getTime() + 60_000);
    const withActivity = await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientA, userId, change: { activity_id: 'act-1', update_token: 'upd-1' }, now: later });
    expect(withActivity).toMatchObject({ enabled: true, start_token: 'start-1', activity_id: 'act-1', update_token: 'upd-1', start_requested_at: null });
    expect(Date.parse(withActivity!.activity_started_at!)).toBe(later.getTime());

    expect(await repo.upsertFromDevice({ deviceId: 'phone-x', patientId: patientA, userId, change: { enabled: true }, now })).toBeNull();
    expect((await repo.listEnabled()).map((row) => row.device_id)).toEqual(['phone-1']);
  });

  it('an ended activity waits before the next start; another patient forgets the old activity', async () => {
    const repo = new RepositoryClass(pool);
    await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientA, userId, change: { enabled: true, start_token: 's', activity_id: 'a', update_token: 'u' }, now });
    const ended = await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientA, userId, change: { activity_id: null, update_token: null }, now });
    expect(ended).toMatchObject({ update_token: null, activity_started_at: null });
    expect(Date.parse(ended!.start_requested_at!)).toBe(now.getTime());

    await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientA, userId, change: { activity_id: 'a2', update_token: 'u2' }, now });
    const moved = await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientB, userId, change: { enabled: true }, now });
    expect(moved).toMatchObject({ patient_id: patientB, activity_id: null, update_token: null, start_token: 's' });
  });

  it('marks pushes, starts and forgets, and lists switched-off phones with an activity', async () => {
    const repo = new RepositoryClass(pool);
    await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientA, userId, change: { enabled: true, start_token: 's', activity_id: 'a', update_token: 'u' }, now });
    await repo.markUpdated('phone-1', { [patientA]: '2026-10-27T09:58:00.000Z' }, now);
    expect(Date.parse((await repo.listEnabled())[0].last_reading_at!)).toBe(Date.parse('2026-10-27T09:58:00.000Z'));

    await repo.markStartRequested('phone-1', {}, now);
    expect((await repo.listEnabled())[0]).toMatchObject({ update_token: null, activity_id: null });

    await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientA, userId, change: { enabled: false, update_token: 'u3' }, now });
    expect(await repo.listEnabled()).toEqual([]);
    expect((await repo.listDisabledWithActivity()).map((row) => row.update_token)).toEqual(['u3']);
    await repo.forgetActivity('phone-1', 'u3', now);
    expect(await repo.listDisabledWithActivity()).toEqual([]);

    await repo.forgetStartToken('phone-1', 's', now);
    const row = (await pool.query(`SELECT start_token FROM live_activity_subscriptions WHERE device_id = 'phone-1'`)).rows[0];
    expect(row.start_token).toBeNull();
  });

  it('skips a phone signed out of the patient', async () => {
    const repo = new RepositoryClass(pool);
    await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientA, userId, change: { enabled: true }, now });
    await pool.query(`UPDATE patient_devices SET active = false WHERE patient_id = $1::uuid`, [patientA]);
    expect(await repo.listEnabled()).toEqual([]);
  });

  it('two patients: saved in order with the island choice, shown per patient access', async () => {
    const repo = new RepositoryClass(pool);
    const row = await repo.upsertFromDevice({
      deviceId: 'phone-1', patientId: patientA, userId,
      change: { enabled: true, patient_ids: [patientA, patientB], island_mode: 'closer', island_left_patient_id: patientB }, now,
    });
    expect(row).toMatchObject({ patient_id: patientA, patient_ids: [patientA, patientB], island_mode: 'closer', island_left_patient_id: patientB });
    expect((await repo.listEnabled())[0].shown_patient_ids).toEqual([patientA, patientB]);
    // Another owner, so this person can lose ownership and access (a patient always keeps an owner).
    const owner = randomUUID();
    await pool.query(`INSERT INTO users (id, display_name) VALUES ($1::uuid, 'Tomek')`, [owner]);
    await pool.query(
      `INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type, is_owner) VALUES ($1::uuid, $2::uuid, 'primary_caregiver', true), ($1::uuid, $3::uuid, 'primary_caregiver', true)`,
      [owner, patientA, patientB],
    );

    // Glucose alerts taken away for B: B drops out, A stays.
    await pool.query(`UPDATE caregiver_relationships SET is_owner = false, permissions = '{"glucose_alerts": false}'::jsonb WHERE patient_id = $1::uuid AND user_id = $2::uuid`, [patientB, userId]);
    expect((await repo.listEnabled())[0].shown_patient_ids).toEqual([patientA]);
    // A's membership gone: only B... which is also not allowed: nothing to show, the row is skipped.
    await pool.query(`DELETE FROM caregiver_relationships WHERE patient_id = $1::uuid AND user_id = $2::uuid`, [patientA, userId]);
    expect(await repo.listEnabled()).toEqual([]);
    await pool.query(`UPDATE caregiver_relationships SET permissions = '{}'::jsonb WHERE patient_id = $1::uuid AND user_id = $2::uuid`, [patientB, userId]);
    expect((await repo.listEnabled())[0].shown_patient_ids).toEqual([patientB]);
    // The phone signed out of B too.
    await pool.query(`UPDATE patient_devices SET active = false WHERE patient_id = $1::uuid`, [patientB]);
    expect(await repo.listEnabled()).toEqual([]);
  });

  it('two patients need the phone registered for both; an older app keeps or replaces the list', async () => {
    const repo = new RepositoryClass(pool);
    await pool.query(`UPDATE patient_devices SET active = false WHERE patient_id = $1::uuid`, [patientB]);
    expect(await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientA, userId, change: { enabled: true, patient_ids: [patientA, patientB] }, now })).toBeNull();
    await pool.query(`UPDATE patient_devices SET active = true WHERE patient_id = $1::uuid`, [patientB]);

    await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientA, userId, change: { enabled: true, patient_ids: [patientA, patientB] }, now });
    // The same first patient without a list (token updates, an app from before 094): the list stays.
    const tokens = await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientA, userId, change: { activity_id: 'a', update_token: 'u' }, now });
    expect(tokens).toMatchObject({ patient_ids: [patientA, patientB], update_token: 'u' });
    // An older app switching to B: B alone, the old activity forgotten.
    const moved = await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientB, userId, change: { enabled: true }, now });
    expect(moved).toMatchObject({ patient_id: patientB, patient_ids: [patientB], update_token: null });
  });

  it('remembers the readings pushed per patient; a change of patients or island mode clears them', async () => {
    const repo = new RepositoryClass(pool);
    await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientA, userId, change: { enabled: true, patient_ids: [patientA, patientB], activity_id: 'a', update_token: 'u' }, now });
    await repo.markUpdated('phone-1', { [patientA]: '2026-10-27T09:58:00.000Z', [patientB]: '2026-10-27T09:59:00.000Z' }, now);
    let row = (await repo.listEnabled())[0];
    expect(row.last_readings).toEqual({ [patientA]: '2026-10-27T09:58:00.000Z', [patientB]: '2026-10-27T09:59:00.000Z' });
    expect(Date.parse(row.last_reading_at!)).toBe(Date.parse('2026-10-27T09:58:00.000Z'));

    // Token unchanged, same list: nothing to push again.
    await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientA, userId, change: { patient_ids: [patientA, patientB] }, now });
    expect((await repo.listEnabled())[0].last_readings).not.toEqual({});

    await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientA, userId, change: { island_mode: 'closer' }, now });
    row = (await repo.listEnabled())[0];
    expect(row).toMatchObject({ last_readings: {}, last_reading_at: null, update_token: 'u' });

    await repo.markUpdated('phone-1', { [patientA]: '2026-10-27T09:58:00.000Z', [patientB]: null }, now);
    expect((await repo.listEnabled())[0].last_readings).toEqual({ [patientA]: '2026-10-27T09:58:00.000Z' });
    await repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientA, userId, change: { patient_ids: [patientA] }, now });
    expect((await repo.listEnabled())[0]).toMatchObject({ patient_ids: [patientA], last_readings: {}, update_token: 'u' });
  });

  it('refuses a list that does not start with the row\'s patient (database check)', async () => {
    const repo = new RepositoryClass(pool);
    await expect(repo.upsertFromDevice({ deviceId: 'phone-1', patientId: patientA, userId, change: { enabled: true, patient_ids: [patientB, patientA] }, now })).rejects.toThrow();
  });
});
