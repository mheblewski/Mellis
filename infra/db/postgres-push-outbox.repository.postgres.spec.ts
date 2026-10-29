import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresPushOutboxRepository } from './postgres-push-outbox.repository';
import { PostgresPlannedBolusRepository } from './postgres-planned-boluses.repository';
import type { PushOutboxRequest } from '@modules/notifications/application/push-outbox';
import { configurePostgresIntegrationEnvironment, truncatePublicTablesForIntegrationTests } from './postgres-test-isolation';

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

describePostgres('push outbox and meal changes of planned parts (PostgreSQL, audit 2026-10-26)', () => {
  let pool: Pool;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required for push outbox postgres tests');
    // One connection: the rows below skip foreign keys for this session only.
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await applyMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query(`SET session_replication_role = DEFAULT`);
    await truncatePublicTablesForIntegrationTests(pool);
  });

  afterAll(async () => {
    await pool?.query(`SET session_replication_role = DEFAULT`).catch(() => undefined);
    await truncatePublicTablesForIntegrationTests(pool);
    await pool?.end();
  });

  it('queues a push once, lists it when due, and remembers the phones it reached', async () => {
    const patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'p')`, [patientId]);
    const outbox = new PostgresPushOutboxRepository(pool);
    const request: PushOutboxRequest = { kind: 'wbt_reminder', input: { patientId, mealId: randomUUID(), body: 'Pizza o 18:00' } };
    const item = await outbox.enqueue({ dedupeKey: 'wbt-reminder:x', patientId, request, excludeUserId: null, expiresAt: '2026-10-26T13:00:00.000Z' });
    expect(item).toMatchObject({ dedupe_key: 'wbt-reminder:x', patient_id: patientId, request, attempts: 0, expires_at: '2026-10-26T13:00:00.000Z' });
    expect(await outbox.enqueue({ dedupeKey: 'wbt-reminder:x', patientId, request, excludeUserId: null, expiresAt: '2026-10-26T13:00:00.000Z' })).toBeNull();

    // Sent at once by its caller: not listed until an attempt schedules the next one.
    expect(await outbox.listDue('2026-10-26T12:00:00.000Z', 10)).toEqual([]);
    await outbox.markDelivered(item!.id, 'phone-a');
    await outbox.markDelivered(item!.id, 'phone-a');
    await outbox.finishAttempt(item!.id, { complete: false, nextAttemptAt: '2026-10-26T12:00:30.000Z', errorCode: 'APNS_NETWORK' });
    expect(await outbox.listDue('2026-10-26T12:00:10.000Z', 10)).toEqual([]);
    expect((await outbox.listDue('2026-10-26T12:00:30.000Z', 10)).map((due) => [due.id, due.attempts])).toEqual([[item!.id, 1]]);
    expect([...await outbox.deliveredTokens(item!.id)]).toEqual(['phone-a']);
    await outbox.finishAttempt(item!.id, { complete: true, nextAttemptAt: null, errorCode: null });
    expect(await outbox.listDue('2026-10-26T13:00:00.000Z', 10)).toEqual([]);

    // A push the API queues is due at the time it names.
    const queued = await outbox.enqueue({ dedupeKey: 'meal-excess:x', patientId, request, excludeUserId: randomUUID(), expiresAt: '2026-10-26T13:00:00.000Z', nextAttemptAt: '2026-10-26T12:05:00.000Z' });
    expect((await outbox.listDue('2026-10-26T12:05:00.000Z', 10)).map((due) => due.id)).toEqual([queued!.id]);
  });

  it('keeps the meal excess on a part and brings a part already pushed back as NOTIFIED', async () => {
    const patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'p')`, [patientId]);
    await pool.query(`SET session_replication_role = replica`);
    const id = randomUUID();
    const mealId = randomUUID();
    await pool.query(
      `INSERT INTO planned_boluses (id, patient_id, meal_record_id, first_carbs_g, first_insulin_u, carbs_g, planned_insulin_u, now_percent, delay_minutes, due_at, status, notified_at, meal_carbs_g)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 36, 3.6, 24, 2.4, 60, 90, now(), 'NOTIFIED', now(), 60)`,
      [id, patientId, mealId],
    );
    const plans = new PostgresPlannedBolusRepository(pool);
    expect(await plans.followMealChange(patientId, id, { carbs_g: 0, dose_carbs_g: null, planned_insulin_u: 0, meal_carbs_g: 26, meal_change_g: -24, cancel: true, reopen: false, meal_excess_g: 10 })).toBe(true);
    expect(await plans.get(patientId, id)).toMatchObject({ status: 'CANCELLED', cancelled_by_meal_change: true, meal_excess_g: 10 });
    expect(await plans.followMealChange(patientId, id, { carbs_g: 24, dose_carbs_g: null, planned_insulin_u: 2.4, meal_carbs_g: 60, meal_change_g: 0, cancel: false, reopen: true, meal_excess_g: 0 })).toBe(true);
    // Its push already went out: it is not sent a second time.
    expect(await plans.get(patientId, id)).toMatchObject({ status: 'NOTIFIED', meal_excess_g: 0, carbs_g: 24 });
  });
});
