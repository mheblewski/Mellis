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
import { PostgresMealJournalRepository } from './postgres-meal-journal.repository';
import { PostgresMealMergeRepository, type MealMergeWrite } from './postgres-meal-merge.repository';

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

const BASE_MS = Date.parse('2026-11-01T12:00:00.000Z');
const at = (minutes: number) => new Date(BASE_MS + minutes * 60_000).toISOString();

describePostgres('meal merge (postgres, migration 097)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let loopActions: PostgresLoopActionRepository;
  let records: PostgresMealRecordRepository;
  let journal: PostgresMealJournalRepository;
  let merges: PostgresMealMergeRepository;
  let patientId: string;
  let userId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrations(pool);
    loopActions = new PostgresLoopActionRepository(pool);
    records = new PostgresMealRecordRepository(pool);
    journal = new PostgresMealJournalRepository(pool);
    merges = new PostgresMealMergeRepository(pool);
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    patientId = randomUUID();
    userId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'meal-merge-test')`, [patientId]);
    await pool.query(`INSERT INTO users (id, display_name) VALUES ($1::uuid, 'Opiekun A')`, [userId]);
    await pool.query(
      `INSERT INTO meal_history_epochs (patient_id, starts_at, assignment_policy_version, decided_by)
       VALUES ($1::uuid, $2::timestamptz, 'new-meal-assignment.v1', 'test')`,
      [patientId, at(-600)],
    );
    await pool.query(`INSERT INTO loop_action_epochs (patient_id, starts_at) VALUES ($1::uuid, $2::timestamptz)`, [patientId, at(-600)]);
  });

  afterAll(async () => {
    if (pool) {
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  async function event(minutes: number, type: 'CARB_ENTRY' | 'BOLUS', value: number, seconds = 0): Promise<string> {
    const sourceId = randomUUID();
    const sourceRecordId = randomUUID();
    const eventId = randomUUID();
    const occurredAt = new Date(Date.parse(at(minutes)) + seconds * 1000).toISOString();
    const payload = type === 'CARB_ENTRY' ? { carbs: value } : { insulin_units: value };
    await pool.query(`INSERT INTO sources (id, patient_id, source_system, source_key, metadata) VALUES ($1::uuid,$2::uuid,'NIGHTSCOUT',$3,'{}'::jsonb)`, [sourceId, patientId, `source-${sourceId}`]);
    await pool.query(
      `INSERT INTO source_records (id, patient_id, source_id, source_system, source_record_id, natural_key, record_type, occurred_at, recorded_at, raw_payload, provenance, canonical_hash)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'NIGHTSCOUT',$4,$5,'TREATMENT',$6::timestamptz,$6::timestamptz,$7::jsonb,'{}'::jsonb,$8)`,
      [sourceRecordId, patientId, sourceId, `record-${sourceRecordId}`, `natural-${sourceRecordId}`, occurredAt, JSON.stringify(payload), `hash-${sourceRecordId}`],
    );
    await pool.query(
      `INSERT INTO events (id, patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload, event_ingestion_origin, created_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::timestamptz,$5::timestamptz,'{}'::jsonb,'{}'::jsonb,$6::jsonb,'LIVE',$7::timestamptz)`,
      [eventId, patientId, sourceRecordId, type, occurredAt, JSON.stringify(payload), new Date(Date.parse(occurredAt) + 60_000).toISOString()],
    );
    return eventId;
  }

  /** A meal from the loop: its carbs and bolus, answered "Nowy posiłek". */
  async function meal(minutes: number, carbs: number, insulin: number): Promise<{ mealId: string; actionId: string }> {
    await event(minutes, 'CARB_ENTRY', carbs);
    await event(minutes, 'BOLUS', insulin, 20);
    await loopActions.groupNewEvents(patientId);
    const action = (await loopActions.listActionsBetween(patientId, at(minutes - 1), at(minutes + 1)))[0];
    await loopActions.assign({ patientId, actionId: action.id, purpose: 'NEW_MEAL', mealRecordId: null, userId });
    return { mealId: (await loopActions.getAction(patientId, action.id))!.meal_record_id!, actionId: action.id };
  }

  const identity = async (mealId: string) => (await records.findMealIdentityById(patientId, mealId))!;
  const record = async (mealId: string) => records.getMealRecord(patientId, await identity(mealId));
  const write = (overrides: Partial<MealMergeWrite> & Pick<MealMergeWrite, 'targetId' | 'sourceIds'>): MealMergeWrite => ({
    patientId, content: 'NONE', contentMealId: null, addedCarbsG: 0, split: null, userId, ...overrides,
  });

  async function wbtReminder(mealId: string, remindAt: string): Promise<void> {
    await pool.query(
      `INSERT INTO meal_wbt_reminders (patient_id, meal_record_id, enabled, source, remind_at) VALUES ($1::uuid, $2::uuid, true, 'MANUAL', $3::timestamptz)`,
      [patientId, mealId, remindAt],
    );
  }

  async function secondDose(mealId: string, status: string): Promise<void> {
    await pool.query(
      `INSERT INTO care_reminders (patient_id, note, trigger, due_at, wait_until, status, kind, meal_record_id)
       VALUES ($1::uuid, 'Druga dawka', 'GLUCOSE_RISING', $2::timestamptz, $3::timestamptz, $4, 'SECOND_DOSE', $5::uuid)`,
      [patientId, at(30), at(120), status, mealId],
    );
  }

  it('moves the other meals into the kept one: entries, boluses, reminders and its description with all carbs', async () => {
    const first = await meal(0, 30, 3);
    const lunch = await meal(20, 45, 4.5);
    const dessert = await meal(50, 15, 1.5);
    await records.updateDescription(patientId, await identity(lunch.mealId), 'Obiad');
    await records.correctMacros(patientId, await identity(lunch.mealId), userId, { carbs_g: 45, protein_g: 25, fat_g: 20 });
    await wbtReminder(lunch.mealId, at(170));
    await wbtReminder(dessert.mealId, at(200));
    await secondDose(first.mealId, 'GIVEN');
    await secondDose(dessert.mealId, 'ACTIVE');
    await pool.query(`INSERT INTO meal_wbt_suggestions (patient_id, meal_record_id, status) VALUES ($1::uuid, $2::uuid, 'DONE')`, [patientId, lunch.mealId]);

    await merges.merge(write({ targetId: lunch.mealId, sourceIds: [first.mealId, dessert.mealId], content: 'KEPT', contentMealId: lunch.mealId, addedCarbsG: 45 }));

    const merged = await record(lunch.mealId);
    expect(merged).toMatchObject({ description: 'Obiad', status: 'CORRECTED', source_carbs_g: 90, started_at: at(0) });
    expect(merged.macros.carbs.grams).toBe(90);
    expect(merged.macros.protein.grams).toBe(25);
    expect(await records.findMealIdentityById(patientId, first.mealId)).toBeNull();
    expect(await records.findMealIdentityById(patientId, dessert.mealId)).toBeNull();
    const actions = await loopActions.listActionsForMeals(patientId, [lunch.mealId]);
    expect(actions.map((action) => [action.id, action.purpose]).sort()).toEqual([
      [dessert.actionId, 'MEAL_ADDITION'], [first.actionId, 'MEAL_ADDITION'], [lunch.actionId, 'NEW_MEAL'],
    ].sort());
    // One WBT reminder (the kept meal's own), now timed from the merged meal's start; the old suggestion is gone.
    const wbt = (await pool.query(`SELECT meal_record_id::text, remind_at FROM meal_wbt_reminders WHERE patient_id = $1::uuid`, [patientId])).rows;
    expect(wbt.map((row) => row.meal_record_id)).toEqual([lunch.mealId]);
    expect((await pool.query(`SELECT 1 FROM meal_wbt_suggestions WHERE patient_id = $1::uuid`, [patientId])).rowCount).toBe(0);
    // One second dose: the one still to come.
    const care = (await pool.query(`SELECT status, meal_record_id::text FROM care_reminders WHERE patient_id = $1::uuid`, [patientId])).rows;
    expect(care).toEqual([{ status: 'ACTIVE', meal_record_id: lunch.mealId }]);
    expect((await pool.query(`SELECT content, merged_meal_ids::text[] AS ids FROM meal_merges WHERE meal_record_id = $1::uuid`, [lunch.mealId])).rows[0])
      .toEqual({ content: 'KEPT', ids: [first.mealId, dessert.mealId] });
  });

  it('resets the content of several described meals and keeps the merged meal in the journal', async () => {
    const soup = await meal(0, 20, 2);
    const main = await meal(30, 40, 4);
    await records.updateDescription(patientId, await identity(soup.mealId), 'Zupa');
    await records.updateDescription(patientId, await identity(main.mealId), 'Kotlet');

    await merges.merge(write({ targetId: soup.mealId, sourceIds: [main.mealId], content: 'RESET' }));

    const merged = await record(soup.mealId);
    expect(merged).toMatchObject({ description: null, status: 'AWAITING_DESCRIPTION', source_carbs_g: 60 });
    expect(merged.macros.carbs.grams).toBeNull();
    const listed = await journal.listJournalMeals(patientId, null, 10);
    expect(listed.map((row) => row.meal_record_id)).toEqual([soup.mealId]);
  });

  it('copies the kept content onto the split meal and moves its later parts baseline by the merged carbs', async () => {
    const described = await meal(0, 30, 3);
    const split = await meal(20, 50, 3);
    await records.updateDescription(patientId, await identity(described.mealId), 'Pizza');
    await records.correctMacros(patientId, await identity(described.mealId), userId, { carbs_g: 30, protein_g: 10, fat_g: 30 });
    await pool.query(
      `INSERT INTO planned_boluses (patient_id, meal_record_id, first_carbs_g, first_insulin_u, carbs_g, planned_insulin_u, now_percent, delay_minutes, due_at, meal_carbs_g)
       VALUES ($1::uuid, $2::uuid, 30, 3, 20, 2, 60, 90, $3::timestamptz, 50)`,
      [patientId, split.mealId, at(110)],
    );

    await merges.merge(write({ targetId: split.mealId, sourceIds: [described.mealId], content: 'KEPT', contentMealId: described.mealId, addedCarbsG: 50, split: 'KEEP' }));

    const merged = await record(split.mealId);
    expect(merged).toMatchObject({ description: 'Pizza', status: 'CORRECTED' });
    expect(merged.macros.carbs.grams).toBe(80);
    const part = (await pool.query(`SELECT meal_record_id::text, meal_carbs_g, carbs_g, status FROM planned_boluses WHERE patient_id = $1::uuid`, [patientId])).rows[0];
    // The meal's carbs went from 50 (its loop entry) to 80: the part's baseline follows, its own carbs stay.
    expect(part).toMatchObject({ meal_record_id: split.mealId, status: 'SCHEDULED' });
    expect(Number(part.meal_carbs_g)).toBe(80);
    expect(Number(part.carbs_g)).toBe(20);
  });

  it('deletes a meal: out of the journal and the AI list, reminders off, loop history kept', async () => {
    const one = await meal(0, 40, 4);
    const stay = await meal(-120, 30, 3);
    await pool.query(
      `INSERT INTO meal_wbt_reminders (patient_id, meal_record_id, enabled, source, remind_at, status) VALUES ($1::uuid, $2::uuid, true, 'AUTO', $3::timestamptz, 'SCHEDULED')`,
      [patientId, one.mealId, at(150)],
    );

    expect(await merges.deleteMeal(patientId, one.mealId)).toBe(true);
    expect(await merges.deleteMeal(patientId, one.mealId)).toBe(false);

    const row = (await pool.query(`SELECT status FROM meal_records WHERE id = $1::uuid`, [one.mealId])).rows[0];
    expect(row.status).toBe('CANCELLED');
    const wbt = (await pool.query(`SELECT enabled, status FROM meal_wbt_reminders WHERE meal_record_id = $1::uuid`, [one.mealId])).rows[0];
    expect(wbt).toMatchObject({ enabled: false, status: 'SKIPPED' });
    const actions = (await pool.query(`SELECT purpose, meal_record_id::text AS meal FROM loop_actions WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid`, [patientId, one.mealId])).rows;
    expect(actions).toEqual([{ purpose: 'NEW_MEAL', meal: one.mealId }]);
    const listed = await records.listMealRecordsStartedBetween(patientId, at(-600), at(600));
    expect(listed).toHaveLength(1);
    expect(await record(stay.mealId)).toMatchObject({ source_carbs_g: 30 });
  });

  it('does not touch anything when the meal to delete is unknown', async () => {
    const one = await meal(0, 40, 4);
    await expect(merges.deleteMeal(patientId, randomUUID())).rejects.toThrow(/Meal not found/);
    expect((await pool.query(`SELECT status FROM meal_records WHERE id = $1::uuid`, [one.mealId])).rows[0].status).not.toBe('CANCELLED');
  });

  it('writes nothing when a meal is gone', async () => {
    const one = await meal(0, 20, 2);
    await expect(merges.merge(write({ targetId: one.mealId, sourceIds: [randomUUID()] }))).rejects.toThrow(/Meal not found/);
    expect(await record(one.mealId)).toMatchObject({ source_carbs_g: 20 });
  });
});
