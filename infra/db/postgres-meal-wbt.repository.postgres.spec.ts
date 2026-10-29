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

describePostgres('meal WBT conversations (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let patientId: string;
  // Loaded lazily: offline runs must not import the gated modules (postgres-gated-spec-imports.spec.ts).
  let RepositoryClass: typeof import('./postgres-meal-wbt.repository').PostgresMealWbtRepository;

  beforeAll(async () => {
    // One connection: the suggestion rows below skip the meal foreign key for this session only.
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrations(pool);
    RepositoryClass = (await import('./postgres-meal-wbt.repository')).PostgresMealWbtRepository;
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'wbt-test')`, [patientId]);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`SET session_replication_role = DEFAULT`).catch(() => undefined);
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  it('keeps one conversation per meal and opens a new one after it was deleted', async () => {
    const repo = new RepositoryClass(pool);
    const mealId = randomUUID();
    const first = await repo.getOrCreateWbtConversation(patientId, mealId, 'WBT · posiłek 12:00');
    expect(await repo.getOrCreateWbtConversation(patientId, mealId, 'WBT · posiłek 12:00')).toBe(first);
    const row = (await pool.query(`SELECT trigger_type, origin, title, title_source, wbt_meal_record_id::text FROM conversations WHERE id = $1::uuid`, [first])).rows[0];
    expect(row).toEqual({ trigger_type: 'MEAL_WBT', origin: 'USER', title: 'WBT · posiłek 12:00', title_source: 'SYSTEM', wbt_meal_record_id: mealId });

    await pool.query(`UPDATE conversations SET deleted_at = now() WHERE id = $1::uuid`, [first]);
    const second = await repo.getOrCreateWbtConversation(patientId, mealId, 'WBT · posiłek 12:00');
    expect(second).not.toBe(first);
    expect((await pool.query(`SELECT wbt_meal_record_id FROM conversations WHERE id = $1::uuid`, [first])).rows[0].wbt_meal_record_id).toBeNull();
  });

  it('stores the chat\'s doses as the meal\'s newest suggestions and drops a failed answer\'s ones', async () => {
    const repo = new RepositoryClass(pool);
    const mealId = randomUUID();
    const conversationId = await repo.getOrCreateWbtConversation(patientId, mealId, 'WBT');
    await pool.query(`SET session_replication_role = replica`);
    const userMessageId = randomUUID();
    const stored = await repo.insertChatSuggestion({ patientId, mealRecordId: mealId, conversationId, userMessageId, result: { dose_units: 0.5, basis: 'CHAT' } });

    expect(stored).toMatchObject({ status: 'DONE', conversation_id: conversationId, user_message_id: userMessageId, result: { dose_units: 0.5 } });
    expect((await repo.getLatestSuggestion(patientId, mealId))?.id).toBe(stored.id);
    expect((await repo.listChatSuggestions(patientId, conversationId)).map((row) => row.id)).toEqual([stored.id]);

    await repo.discardChatSuggestionsForUserMessage(patientId, userMessageId);
    expect(await repo.listChatSuggestions(patientId, conversationId)).toEqual([]);
    await pool.query(`SET session_replication_role = DEFAULT`);
  });

  it('starts one suggestion per meal while one is pending (two caregivers tapping at once)', async () => {
    const repo = new RepositoryClass(pool);
    const mealId = randomUUID();
    await pool.query(`SET session_replication_role = replica`);
    const first = await repo.createSuggestionIfNonePending(patientId, mealId, randomUUID());
    const second = await repo.createSuggestionIfNonePending(patientId, mealId, randomUUID());
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    await repo.completeSuggestion(first.id, 'DONE', { dose_units: 0.5 });
    expect((await repo.createSuggestionIfNonePending(patientId, mealId, randomUUID())).created).toBe(true);
    await pool.query(`SET session_replication_role = DEFAULT`);
  });

  describe('reminder time and state (audit 2026-10-26)', () => {
    const now = new Date('2026-10-26T18:00:00.000Z');
    const at = (minutesFromNow: number) => new Date(now.getTime() + minutesFromNow * 60_000).toISOString();

    async function meal(entries: string[]): Promise<string> {
      const id = randomUUID();
      const anchorId = randomUUID();
      const epochId = randomUUID();
      await pool.query(`SET session_replication_role = replica`);
      await pool.query(
        `INSERT INTO meal_records (id, patient_id, meal_identity, epoch_id, assignment_policy_version, anchor_event_id, status)
         VALUES ($1::uuid, $2::uuid, 'meal:v1:' || $3 || ':' || $4, $3::uuid, 'v1', $4::uuid, 'AWAITING_DESCRIPTION')`,
        [id, patientId, epochId, anchorId],
      );
      for (const [index, occurredAt] of entries.entries()) {
        await pool.query(
          `INSERT INTO meal_record_entries (patient_id, event_id, meal_record_id, occurred_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)`,
          [patientId, index === 0 ? anchorId : randomUUID(), id, occurredAt],
        );
      }
      await pool.query(`SET session_replication_role = DEFAULT`);
      return id;
    }

    it('follows the meal earlier and later but keeps a split part\'s postponement', async () => {
      const repo = new RepositoryClass(pool);
      const { followWbtRemindersToMealStart } = await import('./postgres-meal-wbt.repository');
      const mealId = await meal([at(-30)]);
      await repo.setAutoReminder({ patientId, mealRecordId: mealId, enabled: true, remindAt: at(120), now });
      expect((await repo.getReminder(patientId, mealId))?.remind_at).toBe(at(120));

      // An earlier entry joined: the time moves earlier.
      await pool.query(`SET session_replication_role = replica`);
      await pool.query(`INSERT INTO meal_record_entries (patient_id, event_id, meal_record_id, occurred_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)`, [patientId, randomUUID(), mealId, at(-60)]);
      await pool.query(`SET session_replication_role = DEFAULT`);
      await followWbtRemindersToMealStart(pool, patientId, [mealId], now);
      expect((await repo.getReminder(patientId, mealId))?.remind_at).toBe(at(90));

      // A split part postponed it; the macros' write keeps that, and so does the meal moving earlier still.
      await repo.postponeReminder(patientId, mealId, at(200));
      await repo.setAutoReminder({ patientId, mealRecordId: mealId, enabled: true, remindAt: at(90), now });
      expect(await repo.getReminder(patientId, mealId)).toMatchObject({ remind_at: at(200), not_before: at(200), status: 'SCHEDULED' });

      // The caregiver's own switch follows the meal too (its ON CONFLICT used to keep the old time).
      const other = await meal([at(-10)]);
      await repo.setManualReminder({ patientId, mealRecordId: other, enabled: true, remindAt: at(500), userId: randomUUID(), now });
      expect((await repo.getReminder(patientId, other))).toMatchObject({ remind_at: at(140), source: 'MANUAL', enabled: true });
      await repo.setAutoReminder({ patientId, mealRecordId: other, enabled: false, remindAt: at(140), now });
      expect((await repo.getReminder(patientId, other))).toMatchObject({ source: 'MANUAL', enabled: true });
    });

    it('protein or fat added long after the time: MISSED, never due; an outage skip is marked STALE', async () => {
      const repo = new RepositoryClass(pool);
      const mealId = await meal([at(-300)]);
      await repo.setAutoReminder({ patientId, mealRecordId: mealId, enabled: false, remindAt: at(-150), now });
      await repo.setAutoReminder({ patientId, mealRecordId: mealId, enabled: true, remindAt: at(-150), now });
      expect((await repo.getReminder(patientId, mealId))?.status).toBe('MISSED');
      expect(await repo.listDueReminders(now.toISOString(), 120)).toEqual([]);
      expect(await repo.skipStaleReminders(now.toISOString(), 120)).toBe(0);
      // Taken off again: simply off.
      await repo.setAutoReminder({ patientId, mealRecordId: mealId, enabled: false, remindAt: at(-150), now });
      expect(await repo.getReminder(patientId, mealId)).toMatchObject({ status: 'SCHEDULED', enabled: false });

      // Scheduled in time, then the worker was down: skipped as STALE.
      const late = await meal([at(-300)]);
      await repo.setAutoReminder({ patientId, mealRecordId: late, enabled: true, remindAt: at(-150), now: new Date(Date.parse(at(-200))) });
      expect((await repo.getReminder(patientId, late))?.status).toBe('SCHEDULED');
      expect(await repo.skipStaleReminders(now.toISOString(), 120)).toBe(1);
      expect(await repo.getReminder(patientId, late)).toMatchObject({ status: 'SKIPPED', skip_reason: 'STALE' });
    });
  });
});
