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
import { PostgresLoopActionRepository } from './postgres-loop-actions.repository';
import { PostgresMealRecordRepository } from './postgres-meal-history.repository';
import { ConflictError } from '@shared/errors/app-error';

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

describePostgres('loop actions (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let repo: PostgresLoopActionRepository;
  let records: PostgresMealRecordRepository;
  let patientId: string;
  let userId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrations(pool);
    repo = new PostgresLoopActionRepository(pool);
    records = new PostgresMealRecordRepository(pool);
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    patientId = randomUUID();
    userId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'loop-actions-test')`, [patientId]);
    await pool.query(`INSERT INTO users (id, display_name) VALUES ($1::uuid, 'Ewa')`, [userId]);
    await pool.query(
      `INSERT INTO meal_history_epochs (patient_id, starts_at, assignment_policy_version, decided_by)
       VALUES ($1::uuid, $2::timestamptz, 'new-meal-assignment.v1', 'test')`,
      [patientId, at(-600)],
    );
    await pool.query(`INSERT INTO loop_action_epochs (patient_id, starts_at) VALUES ($1::uuid, $2::timestamptz)`, [patientId, at(0)]);
  });

  afterAll(async () => {
    if (pool) {
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  async function event(args: { minutes: number; type: 'CARB_ENTRY' | 'BOLUS' | 'SMB' | 'GLUCOSE_READING_AVAILABLE'; value: number; origin?: 'LIVE' | 'HISTORICAL'; seconds?: number }): Promise<string> {
    const sourceId = randomUUID();
    const sourceRecordId = randomUUID();
    const eventId = randomUUID();
    const occurredAt = new Date(Date.parse(at(args.minutes)) + (args.seconds ?? 0) * 1000).toISOString();
    const payload = args.type === 'CARB_ENTRY' ? { carbs: args.value }
      : args.type === 'GLUCOSE_READING_AVAILABLE' ? { glucose_value: args.value }
        : { insulin_units: args.value };
    await pool.query(
      `INSERT INTO sources (id, patient_id, source_system, source_key, metadata) VALUES ($1::uuid,$2::uuid,'NIGHTSCOUT',$3,'{}'::jsonb)`,
      [sourceId, patientId, `source-${sourceId}`],
    );
    await pool.query(
      `INSERT INTO source_records (id, patient_id, source_id, source_system, source_record_id, natural_key, record_type, occurred_at, recorded_at, raw_payload, provenance, canonical_hash)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'NIGHTSCOUT',$4,$5,'TREATMENT',$6::timestamptz,$6::timestamptz,$7::jsonb,'{}'::jsonb,$8)`,
      [sourceRecordId, patientId, sourceId, `record-${sourceRecordId}`, `natural-${sourceRecordId}`, occurredAt, JSON.stringify(payload), `hash-${sourceRecordId}`],
    );
    await pool.query(
      `INSERT INTO events (id, patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload, event_ingestion_origin, created_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::timestamptz,$5::timestamptz,'{}'::jsonb,'{}'::jsonb,$6::jsonb,$7,$8::timestamptz)`,
      [eventId, patientId, sourceRecordId, args.type, occurredAt, JSON.stringify(payload), args.origin ?? 'LIVE', new Date(Date.parse(occurredAt) + 60_000).toISOString()],
    );
    return eventId;
  }

  async function actions() {
    return repo.listActionsBetween(patientId, at(-1000), at(1000));
  }

  it('groups the carbs and bolus of one calculator use and leaves SMBs, history and pre-epoch entries out', async () => {
    await event({ minutes: -30, type: 'CARB_ENTRY', value: 40 });
    await event({ minutes: 10, type: 'CARB_ENTRY', value: 10 });
    await event({ minutes: 10, type: 'BOLUS', value: 1.1, seconds: 78 });
    await event({ minutes: 25, type: 'CARB_ENTRY', value: 15 });
    await event({ minutes: 30, type: 'SMB', value: 0.3 });
    await event({ minutes: 40, type: 'CARB_ENTRY', value: 20, origin: 'HISTORICAL' });
    await event({ minutes: 60, type: 'BOLUS', value: 0.7 });

    expect(await repo.groupNewEvents(patientId)).toBe(4);
    expect(await repo.groupNewEvents(patientId)).toBe(0);
    const rows = await actions();
    expect(rows.map((row) => [row.carbs_g, row.bolus_units])).toEqual([[10, 1.1], [15, null], [null, 0.7]]);
    expect(rows.every((row) => row.purpose === null)).toBe(true);
  });

  it('creates a meal, adds an add-on, links a pre-bolus and moves a correction', async () => {
    await event({ minutes: 0, type: 'BOLUS', value: 2 });
    await event({ minutes: 15, type: 'CARB_ENTRY', value: 40 });
    await event({ minutes: 15, type: 'BOLUS', value: 2.5, seconds: 20 });
    await event({ minutes: 50, type: 'CARB_ENTRY', value: 10 });
    await event({ minutes: 50, type: 'BOLUS', value: 0.8, seconds: 10 });
    await event({ minutes: 60, type: 'SMB', value: 0.4 });
    await repo.groupNewEvents(patientId);
    const [preBolus, lunch, extra] = await actions();

    await repo.assign({ patientId, actionId: preBolus.id, purpose: 'PRE_BOLUS', mealRecordId: null, userId });
    await repo.assign({ patientId, actionId: lunch.id, purpose: 'NEW_MEAL', mealRecordId: null, userId });
    const mealId = (await repo.getAction(patientId, lunch.id))!.meal_record_id!;
    expect(mealId).toBeTruthy();
    expect((await repo.getAction(patientId, preBolus.id))!.meal_record_id).toBe(mealId);
    // The same answer again keeps the link; answered after its meal, a pre-bolus joins it too.
    await repo.assign({ patientId, actionId: preBolus.id, purpose: 'PRE_BOLUS', mealRecordId: null, userId });
    expect((await repo.getAction(patientId, preBolus.id))!.meal_record_id).toBe(mealId);
    await repo.assign({ patientId, actionId: preBolus.id, purpose: null, mealRecordId: null, userId });
    await repo.assign({ patientId, actionId: preBolus.id, purpose: 'PRE_BOLUS', mealRecordId: null, userId });
    expect((await repo.getAction(patientId, preBolus.id))!.meal_record_id).toBe(mealId);

    await repo.assign({ patientId, actionId: extra.id, purpose: 'MEAL_ADDITION', mealRecordId: mealId, userId });
    const identity = (await records.findMealIdentityById(patientId, mealId))!;
    let record = await records.getMealRecord(patientId, identity);
    expect(record.source_carbs_g).toBe(50);
    expect(record.status).toBe('AWAITING_DESCRIPTION');
    expect((await repo.listActionsForMeals(patientId, [mealId])).map((row) => row.purpose)).toEqual(['PRE_BOLUS', 'NEW_MEAL', 'MEAL_ADDITION']);

    // It was a correction after all: the entry leaves the meal and becomes virtual carbs.
    await repo.assign({ patientId, actionId: extra.id, purpose: 'CORRECTION', mealRecordId: mealId, userId });
    record = await records.getMealRecord(patientId, identity);
    expect(record.source_carbs_g).toBe(40);
    const kind = (await pool.query(`SELECT kind FROM carb_entry_kinds WHERE event_id = $1::uuid`, [extra.carb_event_id])).rows[0].kind;
    expect(kind).toBe('CORRECTION_CARBS');

    expect(await repo.listSmbsBetween(patientId, at(15), at(255))).toEqual([{ at: at(60), units: 0.4 }]);
    expect(await repo.nextMealStart(patientId, at(15))).toBeNull();
  });

  it('moves the meal\'s WBT reminder with an earlier entry that joins or leaves it (audit 2026-10-26)', async () => {
    await event({ minutes: 10, type: 'CARB_ENTRY', value: 10 });
    await event({ minutes: 40, type: 'CARB_ENTRY', value: 30 });
    await repo.groupNewEvents(patientId);
    const [early, main] = await actions();
    await repo.assign({ patientId, actionId: main.id, purpose: 'NEW_MEAL', mealRecordId: null, userId });
    const mealId = (await repo.getAction(patientId, main.id))!.meal_record_id!;
    const { PostgresMealWbtRepository } = await import('./postgres-meal-wbt.repository');
    const wbt = new PostgresMealWbtRepository(pool);
    await wbt.setAutoReminder({ patientId, mealRecordId: mealId, enabled: true, remindAt: at(190) });
    expect((await wbt.getReminder(patientId, mealId))?.remind_at).toBe(at(190));

    await repo.assign({ patientId, actionId: early.id, purpose: 'MEAL_ADDITION', mealRecordId: mealId, userId });
    expect((await wbt.getReminder(patientId, mealId))?.remind_at).toBe(at(160));

    await repo.assign({ patientId, actionId: early.id, purpose: null, mealRecordId: null, userId });
    expect((await wbt.getReminder(patientId, mealId))).toMatchObject({ remind_at: at(190), status: 'SCHEDULED' });
  });

  it('removes a meal created by mistake only once nothing else was added to it', async () => {
    await event({ minutes: 10, type: 'CARB_ENTRY', value: 20 });
    await event({ minutes: 30, type: 'CARB_ENTRY', value: 10 });
    await repo.groupNewEvents(patientId);
    const [first, second] = await actions();
    await repo.assign({ patientId, actionId: first.id, purpose: 'NEW_MEAL', mealRecordId: null, userId });
    const mealId = (await repo.getAction(patientId, first.id))!.meal_record_id!;
    await repo.assign({ patientId, actionId: second.id, purpose: 'MEAL_ADDITION', mealRecordId: mealId, userId });

    await expect(repo.assign({ patientId, actionId: first.id, purpose: 'CORRECTION', mealRecordId: null, userId })).rejects.toBeInstanceOf(ConflictError);

    await repo.assign({ patientId, actionId: second.id, purpose: 'NEW_MEAL', mealRecordId: null, userId });
    await repo.assign({ patientId, actionId: first.id, purpose: 'CORRECTION', mealRecordId: null, userId });
    expect(await records.findMealIdentityById(patientId, mealId)).toBeNull();

    // "Cofnij": the correction waits for an answer again, its carbs are no longer virtual.
    await repo.assign({ patientId, actionId: first.id, purpose: null, mealRecordId: null, userId });
    const undone = (await repo.getAction(patientId, first.id))!;
    expect([undone.purpose, undone.meal_record_id, undone.assigned_at]).toEqual([null, null, null]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM carb_entry_kinds WHERE event_id = $1::uuid`, [first.carb_event_id])).rows[0].n).toBe(0);
    const meals = (await pool.query(`SELECT id::text FROM meal_records WHERE patient_id = $1::uuid`, [patientId])).rows.map((row) => row.id);
    expect(meals).toEqual([(await repo.getAction(patientId, second.id))!.meal_record_id]);
  });

  it('removes a meal its chat cards point at (they go STALE and keep a subject), but not one a dose was sent for', async () => {
    await event({ minutes: 10, type: 'CARB_ENTRY', value: 20 });
    await event({ minutes: 40, type: 'CARB_ENTRY', value: 30 });
    await repo.groupNewEvents(patientId);
    const [first, second] = await actions();
    await repo.assign({ patientId, actionId: first.id, purpose: 'NEW_MEAL', mealRecordId: null, userId });
    await repo.assign({ patientId, actionId: second.id, purpose: 'NEW_MEAL', mealRecordId: null, userId });
    const firstMeal = (await repo.getAction(patientId, first.id))!.meal_record_id!;
    const secondMeal = (await repo.getAction(patientId, second.id))!.meal_record_id!;

    const conversationId = randomUUID();
    const messageId = randomUUID();
    await pool.query(`INSERT INTO conversations (id, patient_id, thread_state_version) VALUES ($1::uuid, $2::uuid, 'v1')`, [conversationId, patientId]);
    await pool.query(
      `INSERT INTO messages (id, conversation_id, patient_id, role, message_type, content, provenance_ref, idempotency_key)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'USER', 'USER_MESSAGE', 'To była kanapka', 'test', $4)`,
      [messageId, conversationId, patientId, `key-${messageId}`],
    );
    const card = async (operation: string, status: string) => (await pool.query<{ id: string }>(
      `INSERT INTO conversation_meal_actions (patient_id, conversation_id, user_message_id, operation, meal_record_id, payload, before, status, decided_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, '{}'::jsonb, '{}'::jsonb, $6, CASE WHEN $6 = 'APPLIED' THEN now() END)
       RETURNING id::text`,
      [patientId, conversationId, messageId, operation, firstMeal, status],
    )).rows[0].id;
    const waiting = await card('REPLACE_CONTENT', 'PROPOSED');
    const applied = await card('UPDATE_MACROS', 'APPLIED');

    // The first meal was a mistake: its carbs were a correction.
    await repo.assign({ patientId, actionId: first.id, purpose: 'CORRECTION', mealRecordId: null, userId });

    expect(await records.findMealIdentityById(patientId, firstMeal)).toBeNull();
    const cards = (await pool.query(`SELECT id::text, status, meal_record_id, carb_event_id::text, loop_action_id FROM conversation_meal_actions ORDER BY created_at`)).rows;
    expect(cards).toEqual([
      { id: waiting, status: 'STALE', meal_record_id: null, carb_event_id: first.carb_event_id, loop_action_id: null },
      { id: applied, status: 'APPLIED', meal_record_id: null, carb_event_id: first.carb_event_id, loop_action_id: null },
    ]);

    // A WBT dose sent from GlucoMind for the second meal keeps it.
    await pool.query(
      `INSERT INTO remote_commands (patient_id, user_id, device_id, source, carbs_g, insulin_u, bolus_step, context, policy_version, send_deadline, purpose, target_meal_record_id)
       VALUES ($1::uuid, $2::uuid, 'device-1', 'BOLUS_SCREEN', 0, 1.5, 0.05, '{}'::jsonb, 'test', now(), 'WBT', $3::uuid)`,
      [patientId, userId, secondMeal],
    );
    await expect(repo.assign({ patientId, actionId: second.id, purpose: 'CORRECTION', mealRecordId: null, userId }))
      .rejects.toThrow(/MEAL_HAS_REMOTE_COMMANDS/);
    expect((await repo.getAction(patientId, second.id))!).toMatchObject({ purpose: 'NEW_MEAL', meal_record_id: secondMeal });
    expect(await records.findMealIdentityById(patientId, secondMeal)).not.toBeNull();
  });

  it('refuses an assignment when the other caregiver answered differently, but not the same answer', async () => {
    await event({ minutes: 10, type: 'CARB_ENTRY', value: 20 });
    await repo.groupNewEvents(patientId);
    const [action] = await actions();
    const unassigned = { purpose: null, mealRecordId: null };

    await repo.assign({ patientId, actionId: action.id, purpose: 'CORRECTION', mealRecordId: null, userId, expected: unassigned });
    // The other phone still showed it unassigned: a different answer is refused, the same one is fine.
    await expect(repo.assign({ patientId, actionId: action.id, purpose: 'HYPO_TREATMENT', mealRecordId: null, userId, expected: unassigned }))
      .rejects.toThrow(/LOOP_ACTION_CHANGED/);
    await repo.assign({ patientId, actionId: action.id, purpose: 'CORRECTION', mealRecordId: null, userId, expected: unassigned });
    expect((await repo.getAction(patientId, action.id))!.purpose).toBe('CORRECTION');
    await expect(repo.assign({ patientId, actionId: action.id, purpose: null, mealRecordId: null, userId, expected: unassigned })).rejects.toThrow(/LOOP_ACTION_CHANGED/);
    await repo.assign({ patientId, actionId: action.id, purpose: null, mealRecordId: null, userId, expected: { purpose: 'CORRECTION', mealRecordId: null } });
    expect((await repo.getAction(patientId, action.id))!.purpose).toBeNull();
  });
});
