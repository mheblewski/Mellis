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
import { PostgresConversationMealActionRepository } from './postgres-conversation-meal-actions.repository';
import { PostgresLoopActionRepository } from './postgres-loop-actions.repository';
import { PostgresMealEntryDetachment, PostgresMealRecordRepository } from './postgres-meal-history.repository';
import { PostgresMealWbtRepository } from './postgres-meal-wbt.repository';
import { ConversationMealActionsService, type MealActionRecord } from '@modules/meal-actions/application/conversation-meal-actions.service';
import type { MealActionRequest } from '@modules/meal-actions/application/meal-action-policy';
import { StaleWriteError } from '@shared/errors/app-error';

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

const PANCAKES = [
  { name: 'Naleśnik', grams: 120, carbs_g: 34.2, protein_g: 7.8, fat_g: 8.4, source: 'DIABCALC' },
  { name: 'Twaróg półtłusty', grams: 60, carbs_g: 2.1, protein_g: 11.1, fat_g: 2.4, source: 'DIABCALC' },
];

describePostgres('conversation meal actions (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let loop: PostgresLoopActionRepository;
  let records: PostgresMealRecordRepository;
  let store: PostgresConversationMealActionRepository;
  let service: ConversationMealActionsService;
  let patientId: string;
  let userId: string;
  let otherUserId: string;
  let conversationId: string;
  let userMessageId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrations(pool);
    loop = new PostgresLoopActionRepository(pool);
    records = new PostgresMealRecordRepository(pool);
    store = new PostgresConversationMealActionRepository(pool, records);
    const detachment = new PostgresMealEntryDetachment(pool);
    const wbt = new PostgresMealWbtRepository(pool);
    service = new ConversationMealActionsService(store, {
      assignLoopAction: (args) => loop.assign(args),
      setCarbEntryKind: async ({ patientId: patient, eventId, kind, userId: user }) => {
        await pool.query(
          `INSERT INTO carb_entry_kinds (patient_id, event_id, kind, set_by_user_id, set_at) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, now())
           ON CONFLICT (patient_id, event_id) DO UPDATE SET kind = EXCLUDED.kind`,
          [patient, eventId, kind, user],
        );
        if (kind !== 'MEAL') await detachment.detachMealEntriesFromNonMealAnchor(patient, eventId, user);
      },
      detachCarbEntry: async ({ patientId: patient, eventId, userId: user }) => { await detachment.detachEntry(patient, eventId, user); },
      setWbtReminder: ({ patientId: patient, mealRecordId, enabled, userId: user }) => wbt.setManualReminder({ patientId: patient, mealRecordId, enabled, remindAt: at(150), userId: user }),
      afterMealValuesChanged: async () => undefined,
    });
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    patientId = randomUUID();
    userId = randomUUID();
    otherUserId = randomUUID();
    conversationId = randomUUID();
    userMessageId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'meal-actions-test')`, [patientId]);
    await pool.query(`INSERT INTO users (id, display_name) VALUES ($1::uuid, 'Piotr'), ($2::uuid, 'Ewa')`, [userId, otherUserId]);
    await pool.query(
      `INSERT INTO meal_history_epochs (patient_id, starts_at, assignment_policy_version, decided_by)
       VALUES ($1::uuid, $2::timestamptz, 'new-meal-assignment.v1', 'test')`,
      [patientId, at(-600)],
    );
    await pool.query(`INSERT INTO loop_action_epochs (patient_id, starts_at) VALUES ($1::uuid, $2::timestamptz)`, [patientId, at(-600)]);
    await pool.query(`INSERT INTO conversations (id, patient_id, thread_state_version) VALUES ($1::uuid, $2::uuid, 'v1')`, [conversationId, patientId]);
    await pool.query(
      `INSERT INTO messages (id, conversation_id, patient_id, role, message_type, content, provenance_ref, idempotency_key)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'USER', 'USER_MESSAGE', 'Zamiast skyru zjadł naleśniki z serem', 'test', 'key-1')`,
      [userMessageId, conversationId, patientId],
    );
  });

  afterAll(async () => {
    if (pool) {
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  async function carbEntry(minutes: number, carbs: number): Promise<string> {
    const sourceId = randomUUID();
    const sourceRecordId = randomUUID();
    const eventId = randomUUID();
    const occurredAt = at(minutes);
    await pool.query(
      `INSERT INTO sources (id, patient_id, source_system, source_key, metadata) VALUES ($1::uuid,$2::uuid,'NIGHTSCOUT',$3,'{}'::jsonb)`,
      [sourceId, patientId, `source-${sourceId}`],
    );
    await pool.query(
      `INSERT INTO source_records (id, patient_id, source_id, source_system, source_record_id, natural_key, record_type, occurred_at, recorded_at, raw_payload, provenance, canonical_hash)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'NIGHTSCOUT',$4,$5,'TREATMENT',$6::timestamptz,$6::timestamptz,$7::jsonb,'{}'::jsonb,$8)`,
      [sourceRecordId, patientId, sourceId, `record-${sourceRecordId}`, `natural-${sourceRecordId}`, occurredAt, JSON.stringify({ carbs }), `hash-${sourceRecordId}`],
    );
    await pool.query(
      `INSERT INTO events (id, patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload, event_ingestion_origin, created_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'CARB_ENTRY',$4::timestamptz,$4::timestamptz,'{}'::jsonb,'{}'::jsonb,$5::jsonb,'LIVE',$6::timestamptz)`,
      [eventId, patientId, sourceRecordId, occurredAt, JSON.stringify({ carbs }), new Date(Date.parse(occurredAt) + 60_000).toISOString()],
    );
    return eventId;
  }

  /** A loop carb entry answered "new meal", confirmed as skyr (150 g) by the caregiver. */
  async function confirmedSkyrMeal(): Promise<{ mealId: string; identity: string; actionId: string }> {
    await carbEntry(0, 10);
    await loop.groupNewEvents(patientId);
    const [action] = await loop.listActionsBetween(patientId, at(-60), at(60));
    await loop.assign({ patientId, actionId: action.id, purpose: 'NEW_MEAL', mealRecordId: null, userId });
    const mealId = (await loop.getAction(patientId, action.id))!.meal_record_id!;
    const identity = (await records.findMealIdentityById(patientId, mealId))!;
    await records.editContent(patientId, identity, userId, {
      description: 'Skyr naturalny (150 g)',
      items: [{ name: 'Skyr naturalny', grams: 150, carbs_g: 6, protein_g: 16.5, fat_g: 0, source: 'DIABCALC' }],
      macros: { carbs_g: 6, protein_g: 16.5, fat_g: 0 },
    });
    return { mealId, identity, actionId: action.id };
  }

  async function propose(request: MealActionRequest): Promise<MealActionRecord> {
    const result = await service.propose({ patientId, conversationId, userMessageId, request, reason: 'test' });
    if (result.status !== 'PROPOSED') throw new Error(`${result.status}: ${result.problem}`);
    return result.action;
  }

  const ids = (action: MealActionRecord) => ({ patientId, conversationId, actionId: action.id, userId });

  it('stores items as meal content: kept in revisions and counted by content_revision', async () => {
    const { identity } = await confirmedSkyrMeal();
    const before = await records.getMealRecord(patientId, identity);
    expect(before).toMatchObject({ status: 'CORRECTED', description: 'Skyr naturalny (150 g)', items: [{ name: 'Skyr naturalny', grams: 150 }] });
    const revision = await records.editContent(patientId, identity, userId, { items: null });
    expect(revision).toBe(before.content_revision! + 1);
    const revisions = (await pool.query(`SELECT revisions FROM meal_records WHERE meal_identity = $1`, [identity])).rows[0].revisions;
    expect(revisions.at(-1).confirmed_items).toEqual([expect.objectContaining({ name: 'Skyr naturalny' })]);
  });

  it('a values edit keeps the items only while they add up', async () => {
    const { identity } = await confirmedSkyrMeal();
    await records.correctMacros(patientId, identity, userId, { carbs_g: 6, protein_g: 16.5, fat_g: 0 });
    expect((await records.getMealRecord(patientId, identity)).items).toHaveLength(1);
    await records.correctMacros(patientId, identity, userId, { carbs_g: 12, protein_g: 16.5, fat_g: 0 });
    expect((await records.getMealRecord(patientId, identity)).items).toBeNull();
  });

  it('replaces the meal only after the card is confirmed, notes it in the meal chat, and undoes it', async () => {
    const { mealId, identity } = await confirmedSkyrMeal();
    const action = await propose({ operation: 'REPLACE_CONTENT', meal_id: mealId, items: PANCAKES });
    expect((await records.getMealRecord(patientId, identity)).description).toBe('Skyr naturalny (150 g)');

    const applied = await service.apply(ids(action));
    expect(applied).toMatchObject({ status: 'APPLIED', decided_by: 'Piotr' });
    const meal = await records.getMealRecord(patientId, identity);
    expect(meal).toMatchObject({ status: 'CORRECTED', description: 'Naleśnik (120 g), Twaróg półtłusty (60 g)', items: [expect.objectContaining({ name: 'Naleśnik' }), expect.objectContaining({ name: 'Twaróg półtłusty' })] });
    expect(meal.macros.carbs).toEqual({ grams: 36.3, origin: 'CAREGIVER' });
    const notes = (await pool.query(`SELECT content, origin_conversation_id::text FROM meal_chat_messages WHERE meal_record_id = $1::uuid`, [mealId])).rows;
    expect(notes).toEqual([{ content: expect.stringContaining('Zmiana z Rozmów'), origin_conversation_id: conversationId }]);

    expect(await service.apply(ids(action))).toMatchObject({ status: 'APPLIED' });
    expect((await records.getMealRecord(patientId, identity)).content_revision).toBe(meal.content_revision);

    await expect(service.undo(ids(action))).resolves.toMatchObject({ status: 'UNDONE' });
    expect(await records.getMealRecord(patientId, identity)).toMatchObject({ description: 'Skyr naturalny (150 g)', items: [expect.objectContaining({ name: 'Skyr naturalny' })] });
  });

  it('"Cofnij" on a meal with accepted AI values gives it back as CONFIRMED, not CORRECTED', async () => {
    const { mealId, identity } = await confirmedSkyrMeal();
    await pool.query(`UPDATE meal_records SET status = 'CONFIRMED' WHERE id = $1::uuid`, [mealId]);
    const action = await propose({ operation: 'UPDATE_MACROS', meal_id: mealId, fat_g: 5 });
    await service.apply(ids(action));
    expect((await records.getMealRecord(patientId, identity)).status).toBe('CORRECTED');
    await expect(service.undo(ids(action))).resolves.toMatchObject({ status: 'UNDONE' });
    expect(await records.getMealRecord(patientId, identity)).toMatchObject({ status: 'CONFIRMED' });
  });

  it('a card prepared before the other caregiver changed the meal becomes STALE and writes nothing', async () => {
    const { mealId, identity } = await confirmedSkyrMeal();
    const action = await propose({ operation: 'UPDATE_MACROS', meal_id: mealId, fat_g: 5 });
    await records.updateDescription(patientId, identity, 'Skyr z miodem');
    await expect(service.apply(ids(action))).resolves.toMatchObject({ status: 'STALE' });
    expect((await records.getMealRecord(patientId, identity)).macros.fat.grams).toBe(0);
  });

  it('"Cofnij" is refused once the meal changed again after the confirmed change', async () => {
    const { mealId, identity } = await confirmedSkyrMeal();
    const action = await propose({ operation: 'REPLACE_CONTENT', meal_id: mealId, items: PANCAKES });
    await service.apply(ids(action));
    await records.updateDescription(patientId, identity, 'Naleśniki od babci');
    await expect(service.undo(ids(action))).rejects.toBeInstanceOf(StaleWriteError);
    expect((await records.getMealRecord(patientId, identity)).description).toBe('Naleśniki od babci');
    expect((await store.get(patientId, conversationId, action.id))?.status).toBe('APPLIED');
  });

  it('a newer card for the same meal supersedes the waiting one', async () => {
    const { mealId } = await confirmedSkyrMeal();
    const first = await propose({ operation: 'UPDATE_MACROS', meal_id: mealId, fat_g: 5 });
    const wbt = await propose({ operation: 'SET_WBT_REMINDER', meal_id: mealId, enabled: true });
    await propose({ operation: 'REPLACE_CONTENT', meal_id: mealId, items: PANCAKES });
    expect((await store.get(patientId, conversationId, first.id))?.status).toBe('SUPERSEDED');
    expect((await store.get(patientId, conversationId, wbt.id))?.status).toBe('PROPOSED');
  });

  it('answers a loop entry from the card: an add-on joins the meal; a different answer meanwhile makes it STALE', async () => {
    const { mealId } = await confirmedSkyrMeal();
    const addOn = await carbEntry(20, 15);
    await loop.groupNewEvents(patientId);
    const action = await propose({ operation: 'SET_PURPOSE', carb_event_id: addOn, purpose: 'MEAL_ADDITION', target_meal_id: mealId });
    expect(action.before).toMatchObject({ purpose: null, label: 'bez odpowiedzi' });
    expect(action.after).toMatchObject({ purpose: 'MEAL_ADDITION', meal_id: mealId, label: 'dokładka do: Skyr naturalny (150 g)' });

    await expect(service.apply(ids(action))).resolves.toMatchObject({ status: 'APPLIED' });
    expect((await loop.getAction(patientId, action.loop_action_id!))).toMatchObject({ purpose: 'MEAL_ADDITION', meal_record_id: mealId });
    expect((await pool.query(`SELECT count(*)::int AS n FROM meal_record_entries WHERE meal_record_id = $1::uuid`, [mealId])).rows[0].n).toBe(2);

    const ignored = await propose({ operation: 'SET_PURPOSE', carb_event_id: addOn, purpose: 'IGNORED' });
    await loop.assign({ patientId, actionId: action.loop_action_id!, purpose: 'HYPO_TREATMENT', mealRecordId: null, userId: otherUserId });
    await expect(service.apply(ids(ignored))).resolves.toMatchObject({ status: 'STALE' });
    expect((await loop.getAction(patientId, action.loop_action_id!))?.purpose).toBe('HYPO_TREATMENT');
  });

  it('makes an unanswered loop entry a meal of its own and describes it in one confirmation', async () => {
    await carbEntry(0, 10);
    await loop.groupNewEvents(patientId);
    const [entry] = await loop.listActionsBetween(patientId, at(-60), at(60));
    const action = await propose({
      operation: 'SET_PURPOSE',
      loop_action_id: entry.id,
      purpose: 'NEW_MEAL',
      description: 'Pół croissanta maślanego',
      items: [{ name: 'Croissant maślany', grams: 30, carbs_g: 13, protein_g: 2.5, fat_g: 6, source: 'DIABCALC' }],
    });
    expect(action.after).toMatchObject({ purpose: 'NEW_MEAL', label: 'osobny posiłek: Pół croissanta maślanego (W 13 g · B 2,5 g · T 6 g)' });

    const applied = await service.apply(ids(action));
    expect(applied.status).toBe('APPLIED');
    const mealId = (await loop.getAction(patientId, entry.id))!.meal_record_id!;
    expect(applied.after).toMatchObject({ meal_id: mealId });
    const meal = await records.getMealRecord(patientId, (await records.findMealIdentityById(patientId, mealId))!);
    expect(meal).toMatchObject({ status: 'CORRECTED', description: 'Pół croissanta maślanego', items: [{ name: 'Croissant maślany', grams: 30 }] });
    const notes = await pool.query(`SELECT count(*)::int AS n FROM meal_chat_messages WHERE meal_record_id = $1::uuid`, [mealId]);
    expect(notes.rows[0].n).toBe(1);
    // The change names the meal it made (get_meals shows it with the meal).
    expect((await pool.query(`SELECT meal_record_id::text AS id FROM conversation_meal_actions WHERE id = $1::uuid`, [action.id])).rows[0].id).toBe(mealId);
  });

  it('lists the meals and loop entries the AI picks from, newest first', async () => {
    const { mealId } = await confirmedSkyrMeal();
    const addOn = await carbEntry(20, 15);
    await loop.groupNewEvents(patientId);
    const meals = await store.listMealStatesBetween(patientId, at(-120), at(120));
    expect(meals.map((meal) => [meal.meal_id, meal.description, meal.carbs_g, meal.loop_carbs_g])).toEqual([[mealId, 'Skyr naturalny (150 g)', 6, 10]]);
    const entries = await store.listEntriesBetween(patientId, at(-120), at(120));
    expect(entries.map((entry) => [entry.carb_event_id === addOn, entry.carbs_g, entry.purpose, entry.meal_id])).toEqual([
      [true, 15, null, null],
      [false, 10, 'NEW_MEAL', mealId],
    ]);
    expect(entries.every((entry) => entry.loop_action_id !== null)).toBe(true);
    expect(await store.listForUserMessage(patientId, userMessageId)).toEqual([]);
  });

  it('reads an entry by its carb event and shows the meal it started', async () => {
    const { mealId } = await confirmedSkyrMeal();
    const carb = (await pool.query(`SELECT anchor_event_id::text AS id FROM meal_records WHERE id = $1::uuid`, [mealId])).rows[0].id;
    expect(await store.loadEntryState(patientId, { carbEventId: carb })).toMatchObject({
      purpose: 'NEW_MEAL',
      purpose_meal_id: mealId,
      kind: 'MEAL',
      carbs_g: 10,
      meal: { meal_id: mealId, is_anchor: true, entry_count: 1, has_content: true, dependants: 0 },
    });
  });
});
