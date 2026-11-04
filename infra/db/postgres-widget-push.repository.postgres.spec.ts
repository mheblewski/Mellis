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

describePostgres('widget push tokens (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let patientA: string;
  let patientB: string;
  let userId: string;
  let otherUser: string;
  let watchDevice: string;
  let otherWatchDevice: string;
  // Loaded lazily: offline runs must not import the gated modules (postgres-gated-spec-imports.spec.ts).
  let RepositoryClass: typeof import('./postgres-widget-push.repository').PostgresWidgetPushRepository;
  const now = new Date('2026-11-03T10:00:00.000Z');
  const token = 'ab'.repeat(32);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrations(pool);
    RepositoryClass = (await import('./postgres-widget-push.repository')).PostgresWidgetPushRepository;
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    patientA = randomUUID();
    patientB = randomUUID();
    userId = randomUUID();
    otherUser = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'A'), ($2::uuid, 'B')`, [patientA, patientB]);
    await pool.query(`INSERT INTO users (id, display_name) VALUES ($1::uuid, 'Ania'), ($2::uuid, 'Inny')`, [userId, otherUser]);
    await pool.query(
      `INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type) VALUES ($1::uuid, $2::uuid, 'parent'), ($1::uuid, $3::uuid, 'parent')`,
      [userId, patientA, patientB],
    );
    watchDevice = await createWatchDevice(userId, [patientA, patientB]);
    otherWatchDevice = await createWatchDevice(otherUser, [patientB]);
  });

  async function createWatchDevice(user: string, patientIds: string[]): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO watch_devices (user_id, device, patient_ids, token_hash) VALUES ($1::uuid, 'Apple Watch', $2::uuid[], $3) RETURNING id::text`,
      [user, patientIds, randomUUID()],
    );
    return result.rows[0].id;
  }

  afterAll(async () => {
    if (pool) {
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  function register(repo: InstanceType<typeof RepositoryClass>, patientIds: string[], user = userId, device = watchDevice) {
    return repo.upsert({ token, userId: user, watchDeviceId: device, topic: 'pl.mellis.TEAM.watchkitapp', environment: 'sandbox', platform: 'watchos', patientIds, now });
  }

  it('upserts by token and lists one target per patient with the throttle state', async () => {
    const repo = new RepositoryClass(pool);
    const row = await register(repo, [patientA, patientB]);
    expect(row).toMatchObject({ token, user_id: userId, watch_device_id: watchDevice, environment: 'sandbox', platform: 'watchos', last_pushed_at: null });
    expect([...row.patient_ids].sort()).toEqual([patientA, patientB].sort());

    const targets = await repo.listTargets();
    expect(targets).toHaveLength(2);
    expect(targets.every((t) => !t.has_state && t.last_reading_at === null)).toBe(true);

    await repo.markPushed({ token, patientId: patientA, readingAt: '2026-11-03T09:59:00.000Z', value: 142, level: 'in_range', now });
    await repo.markDeferred({ token, patientId: patientB, readingAt: '2026-11-03T09:58:00.000Z', now });
    const after = await repo.listTargets();
    const a = after.find((t) => t.patient_id === patientA)!;
    const b = after.find((t) => t.patient_id === patientB)!;
    expect(a).toMatchObject({ has_state: true, last_value: 142, last_level: 'in_range', deferred_reading_at: null });
    expect(Date.parse(a.last_reading_at!)).toBe(Date.parse('2026-11-03T09:59:00.000Z'));
    expect(Date.parse(a.token_last_pushed_at!)).toBe(now.getTime());
    expect(b).toMatchObject({ has_state: true, last_reading_at: null, last_pushed_at: null });
    expect(Date.parse(b.deferred_reading_at!)).toBe(Date.parse('2026-11-03T09:58:00.000Z'));

    await repo.markEvaluated({ token, patientId: patientB, readingAt: '2026-11-03T09:58:00.000Z', now });
    const evaluated = (await repo.listTargets()).find((t) => t.patient_id === patientB)!;
    expect(evaluated.deferred_reading_at).toBeNull();
    expect(Date.parse(evaluated.last_reading_at!)).toBe(Date.parse('2026-11-03T09:58:00.000Z'));
  });

  it('re-registering drops the state of patients no longer listed and moves the watch device', async () => {
    const repo = new RepositoryClass(pool);
    await register(repo, [patientA, patientB]);
    await repo.markPushed({ token, patientId: patientA, readingAt: '2026-11-03T09:59:00.000Z', value: 142, level: 'in_range', now });
    await repo.markPushed({ token, patientId: patientB, readingAt: '2026-11-03T09:59:00.000Z', value: 90, level: 'in_range', now });
    await register(repo, [patientB]);
    const states = (await pool.query(`SELECT patient_id::text FROM watch_push_state WHERE token = $1`, [token])).rows;
    expect(states).toEqual([{ patient_id: patientB }]);

    // Another caregiver's watch device took the token: the row is theirs, and without a relationship nothing is pushed.
    await register(repo, [patientB], otherUser, otherWatchDevice);
    expect(await repo.listTargets()).toEqual([]);
  });

  it('pushes nothing for a revoked watch device; revoking (or replacing) it forgets its tokens', async () => {
    const repo = new RepositoryClass(pool);
    await register(repo, [patientA]);
    await pool.query(`UPDATE watch_devices SET revoked_at = now() WHERE id = $1::uuid`, [watchDevice]);
    expect(await repo.listTargets()).toEqual([]);

    const DeviceRepository = (await import('./postgres-watch-device.repository')).PostgresWatchDeviceRepository;
    const devices = new DeviceRepository(pool);
    const fresh = await createWatchDevice(userId, [patientA]);
    await register(repo, [patientA], userId, fresh);
    expect((await repo.listTargets()).map((t) => t.patient_id)).toEqual([patientA]);
    expect(await devices.revokeDevice(fresh, otherUser, now)).toBe(false);
    expect(await devices.revokeDevice(fresh, userId, now)).toBe(true);
    expect((await pool.query(`SELECT count(*)::int AS n FROM watch_push_tokens`)).rows[0].n).toBe(0);
    expect(await devices.revokeDevice(fresh, userId, now)).toBe(false);

    const replaced = await devices.createWatchDevice({ userId, device: 'Apple Watch', patientIds: [patientA], tokenHash: randomUUID(), now });
    await register(repo, [patientA], userId, replaced.id);
    const replacement = await devices.createWatchDevice({ userId, device: 'Apple Watch', patientIds: [patientA], tokenHash: randomUUID(), now });
    expect(replacement.id).not.toBe(replaced.id);
    expect((await pool.query(`SELECT revoked_at FROM watch_devices WHERE id = $1::uuid`, [replaced.id])).rows[0].revoked_at).not.toBeNull();
    expect((await pool.query(`SELECT count(*)::int AS n FROM watch_push_tokens`)).rows[0].n).toBe(0);
  });

  it('skips patients the caregiver may no longer see on a dashboard', async () => {
    const repo = new RepositoryClass(pool);
    await register(repo, [patientA, patientB]);
    await pool.query(
      `UPDATE caregiver_relationships SET is_owner = false, permissions = '{"glucose_alerts": false, "ai_chat_meals": false}'::jsonb WHERE patient_id = $1::uuid`,
      [patientA],
    );
    expect((await repo.listTargets()).map((t) => t.patient_id)).toEqual([patientB]);
  });

  it('skips patients whose caregiver relationship ended and deletes a gone token with its state', async () => {
    const repo = new RepositoryClass(pool);
    await register(repo, [patientA, patientB]);
    await pool.query(`DELETE FROM caregiver_relationships WHERE patient_id = $1::uuid`, [patientA]);
    expect((await repo.listTargets()).map((t) => t.patient_id)).toEqual([patientB]);

    await repo.markPushed({ token, patientId: patientB, readingAt: '2026-11-03T09:59:00.000Z', value: 90, level: 'in_range', now });
    await repo.deleteToken(token);
    expect(await repo.listTargets()).toEqual([]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM watch_push_state`)).rows[0].n).toBe(0);
    // State writes for a deleted token are no-ops, never errors.
    await repo.markEvaluated({ token, patientId: patientB, readingAt: '2026-11-03T10:04:00.000Z', now });
    await repo.markPushed({ token, patientId: patientB, readingAt: '2026-11-03T10:04:00.000Z', value: 90, level: 'in_range', now });
    expect((await pool.query(`SELECT count(*)::int AS n FROM watch_push_state`)).rows[0].n).toBe(0);
  });

  it('refuses more than 4 patients and an unknown environment at the database too', async () => {
    const repo = new RepositoryClass(pool);
    await expect(register(repo, [patientA, patientB, randomUUID(), randomUUID(), randomUUID()])).rejects.toThrow();
    await expect(repo.upsert({ token, userId, watchDeviceId: watchDevice, topic: 'a.b', environment: 'dev' as any, platform: 'watchos', patientIds: [patientA], now })).rejects.toThrow();
    await expect(register(repo, [patientA], userId, randomUUID())).rejects.toThrow();
  });
});
