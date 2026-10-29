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
import { PostgresMealEntryDetachment, PostgresMealRecordRepository } from './postgres-meal-history.repository';
import { ConflictError, NotFoundError } from '@shared/errors/app-error';
import { buildNewMealId } from '@modules/meal-candidates/application/new-meal-assignment';
import { selectMealsForAiContext } from '@modules/meal-candidates/application/meal-record-trust';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

const MIGRATIONS_DIR = resolve(__dirname, 'migrations');
// The dev database has not applied 026.
const SKIPPED_MIGRATIONS = new Set(['026_meal_supersession.sql']);

async function applyMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const fileName of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
      if (SKIPPED_MIGRATIONS.has(fileName)) continue;
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

const BASE_MS = Date.parse('2026-11-02T06:00:00.000Z');
const at = (minutes: number) => new Date(BASE_MS + minutes * 60_000).toISOString();

describePostgres('meal history store (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let records: PostgresMealRecordRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrations(pool);
    records = new PostgresMealRecordRepository(pool);
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
  });

  afterAll(async () => {
    if (pool) {
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  async function patient(): Promise<string> {
    const patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'meal-history-test')`, [patientId]);
    return patientId;
  }

  /** The status change the repository's former cancel() made; no app path cancels a meal record. */
  async function cancelMeal(patientId: string, mealIdentity: string): Promise<void> {
    await pool.query(
      `UPDATE meal_records SET status = 'CANCELLED', updated_at = now() WHERE patient_id = $1::uuid AND meal_identity = $2`,
      [patientId, mealIdentity],
    );
  }

  async function caregiver(): Promise<string> {
    const userId = randomUUID();
    await pool.query(`INSERT INTO users (id, display_name) VALUES ($1::uuid, 'caregiver-test')`, [userId]);
    return userId;
  }

  async function epoch(patientId: string, options: { startsAt?: string } = {}): Promise<string> {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO meal_history_epochs (patient_id, starts_at, assignment_policy_version, decided_by, note)
       VALUES ($1::uuid, $2::timestamptz, 'new-meal-assignment.v1', 'test', 'integration test epoch')
       RETURNING id::text`,
      [patientId, options.startsAt ?? at(0)],
    );
    return row.rows[0].id;
  }

  async function event(patientId: string, args: { minutes: number; type?: string; carbs?: number | null; origin?: 'LIVE' | 'HISTORICAL'; firstSeenMinutes?: number }): Promise<string> {
    const sourceId = randomUUID();
    const sourceRecordId = randomUUID();
    const eventId = randomUUID();
    const type = args.type ?? 'CARB_ENTRY';
    const payload = type === 'CARB_ENTRY' ? { carbs: args.carbs ?? 30 } : { insulin_units: 1.5 };
    await pool.query(
      `INSERT INTO sources (id, patient_id, source_system, source_key, metadata) VALUES ($1::uuid,$2::uuid,'NIGHTSCOUT',$3,'{}'::jsonb)`,
      [sourceId, patientId, `source-${sourceId}`],
    );
    await pool.query(
      `INSERT INTO source_records (id, patient_id, source_id, source_system, source_record_id, natural_key, record_type, occurred_at, recorded_at, raw_payload, provenance, canonical_hash)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'NIGHTSCOUT',$4,$5,'TREATMENT',$6::timestamptz,$6::timestamptz,$7::jsonb,'{}'::jsonb,$8)`,
      [sourceRecordId, patientId, sourceId, `record-${sourceRecordId}`, `natural-${sourceRecordId}`, at(args.minutes), JSON.stringify(payload), `hash-${sourceRecordId}`],
    );
    await pool.query(
      `INSERT INTO events (id, patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload, event_ingestion_origin, created_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::timestamptz,$5::timestamptz,'{}'::jsonb,'{}'::jsonb,$6::jsonb,$7,$8::timestamptz)`,
      [eventId, patientId, sourceRecordId, type, at(args.minutes), JSON.stringify(payload), args.origin ?? 'LIVE', at(args.firstSeenMinutes ?? args.minutes + 1)],
    );
    return eventId;
  }

  async function inTransaction(work: (client: import('pg').PoolClient) => Promise<void>): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await work(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * A meal as loop actions make it (NEW_MEAL on the anchor, MEAL_ADDITION for the others): the record and its entries
   * in one transaction. Returns the meal identity.
   */
  async function meal(patientId: string, epochId: string, anchorEventId: string, others: string[] = [], chainedTo: string | null = null): Promise<string> {
    const identity = buildNewMealId(epochId, anchorEventId);
    await inTransaction(async (client) => {
      const id = (await client.query<{ id: string }>(
        `INSERT INTO meal_records (patient_id, meal_identity, epoch_id, assignment_policy_version, anchor_event_id, chained_to_meal_record_id)
         VALUES ($1::uuid, $2, $3::uuid, 'new-meal-assignment.v1', $4::uuid, (SELECT id FROM meal_records WHERE meal_identity = $5))
         RETURNING id::text`,
        [patientId, identity, epochId, anchorEventId, chainedTo],
      )).rows[0].id;
      for (const eventId of [anchorEventId, ...others]) {
        await client.query(
          `INSERT INTO meal_record_entries (patient_id, event_id, meal_record_id, occurred_at) VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
          [patientId, eventId, id],
        );
      }
    });
    return identity;
  }

  async function counts(patientId: string) {
    const row = (await pool.query(
      `SELECT (SELECT count(*)::int FROM meal_records WHERE patient_id = $1::uuid) AS meals,
              (SELECT count(*)::int FROM meal_record_entries WHERE patient_id = $1::uuid) AS entries`,
      [patientId],
    )).rows[0];
    return { meals: row.meals, entries: row.entries };
  }

  async function markKind(patientId: string, eventId: string, kind: string): Promise<void> {
    await pool.query(`INSERT INTO carb_entry_kinds (patient_id, event_id, kind) VALUES ($1::uuid, $2::uuid, $3)`, [patientId, eventId, kind]);
  }

  async function mealOf(patientId: string, eventId: string): Promise<{ identity: string; anchor: string } | null> {
    const row = (await pool.query(
      `SELECT r.meal_identity, r.anchor_event_id::text
       FROM meal_record_entries e JOIN meal_records r ON r.id = e.meal_record_id
       WHERE e.patient_id = $1::uuid AND e.event_id = $2::uuid`,
      [patientId, eventId],
    )).rows[0];
    return row ? { identity: row.meal_identity, anchor: row.anchor_event_id } : null;
  }

  it('exposes confirmed meals to AI context selection and keeps proposals and pending meals unconfirmed', async () => {
    const patientId = await patient();
    const userId = await caregiver();
    const epochId = await epoch(patientId);
    const breakfast = await event(patientId, { minutes: 30, carbs: 40 });
    const lunch = await event(patientId, { minutes: 300, carbs: 60 });
    const dinner = await event(patientId, { minutes: 700, carbs: 50 });
    for (const id of [breakfast, lunch, dinner]) await meal(patientId, epochId, id);

    const breakfastId = buildNewMealId(epochId, breakfast);
    await records.recordDescription(patientId, breakfastId, { description: 'owsianka', photo_ref: null });
    const proposal = await records.recordAiProposal(patientId, breakfastId, { carbs_g: 45, protein_g: 9, fat_g: 6, ai_execution_id: null });
    await records.confirmProposal(patientId, breakfastId, userId, proposal);
    const lunchId = buildNewMealId(epochId, lunch);
    await records.recordDescription(patientId, lunchId, { description: 'zupa', photo_ref: null });
    await records.recordAiProposal(patientId, lunchId, { carbs_g: 55, protein_g: 14, fat_g: 10, ai_execution_id: null });

    const selection = selectMealsForAiContext(await records.listMealRecordsStartedBetween(patientId, at(0), at(600)));
    expect(selection.trusted.map((item) => item.meal_identity)).toEqual([breakfastId]);
    expect(selection.trusted[0]).toMatchObject({ protein: { value: 9, knowledge_status: 'KNOWN', value_source: 'AI_PROPOSAL' } });
    expect(selection.unconfirmed.map((item) => item.meal_identity)).toEqual([lunchId]);
    expect(selection.unconfirmed[0].protein).toMatchObject({ value: null, knowledge_status: 'UNKNOWN', unconfirmed_proposal_g: 14 });
    expect(JSON.stringify(selection)).not.toContain(buildNewMealId(epochId, dinner));
  });

  it('splits the later entries off a meal once its first entry is marked as not a meal', async () => {
    const patientId = await patient();
    const epochId = await epoch(patientId);
    const correction = await event(patientId, { minutes: 30, carbs: 5 });
    const breakfast = await event(patientId, { minutes: 50, carbs: 15 });
    const extra = await event(patientId, { minutes: 70, carbs: 10 });
    const hypo = await event(patientId, { minutes: 60, carbs: 10 });
    await meal(patientId, epochId, correction, [breakfast, hypo, extra]);
    await markKind(patientId, hypo, 'HYPO_TREATMENT');
    expect(await counts(patientId)).toEqual({ meals: 1, entries: 4 });

    const detachment = new PostgresMealEntryDetachment(pool);
    // Still a meal: nothing to do.
    await expect(detachment.detachMealEntriesFromNonMealAnchor(patientId, correction, null)).resolves.toEqual({ detached_event_ids: [], meal_record_id: null });
    await markKind(patientId, correction, 'CORRECTION_CARBS');
    const userId = await caregiver();
    const result = await detachment.detachMealEntriesFromNonMealAnchor(patientId, correction, userId);
    expect(result.detached_event_ids).toEqual([breakfast, extra]);

    const newMeal = buildNewMealId(epochId, breakfast);
    expect(await mealOf(patientId, breakfast)).toEqual({ identity: newMeal, anchor: breakfast });
    expect((await mealOf(patientId, extra))?.identity).toBe(newMeal);
    // The hypo treatment is not a meal either: it stays with the correction carbs.
    expect((await mealOf(patientId, hypo))?.identity).toBe(buildNewMealId(epochId, correction));
    expect(await counts(patientId)).toEqual({ meals: 2, entries: 4 });
    const record = await records.getMealRecord(patientId, newMeal);
    expect(record).toMatchObject({ status: 'AWAITING_DESCRIPTION', source_carbs_g: 25 });

    const log = (await pool.query(
      `SELECT event_id::text, from_meal_identity, to_meal_identity, reason, detached_by_user_id::text FROM meal_record_entry_detachments WHERE patient_id = $1::uuid ORDER BY event_id`,
      [patientId],
    )).rows;
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ from_meal_identity: buildNewMealId(epochId, correction), to_meal_identity: newMeal, reason: 'ANCHOR_NOT_A_MEAL', detached_by_user_id: userId });

    // Running the split again finds nothing left.
    await expect(detachment.detachMealEntriesFromNonMealAnchor(patientId, correction, userId)).resolves.toEqual({ detached_event_ids: [], meal_record_id: null });
  });

  it('lets the caregiver detach a joined entry into a meal of its own, never the first entry', async () => {
    const patientId = await patient();
    const epochId = await epoch(patientId);
    const lunch = await event(patientId, { minutes: 30, carbs: 40 });
    const dessert = await event(patientId, { minutes: 60, carbs: 20 });
    const late = await event(patientId, { minutes: 80, carbs: 10, origin: 'HISTORICAL' });
    await meal(patientId, epochId, lunch, [dessert, late]);
    expect(await counts(patientId)).toEqual({ meals: 1, entries: 3 });

    const detachment = new PostgresMealEntryDetachment(pool);
    await expect(detachment.detachEntry(patientId, lunch, null)).rejects.toBeInstanceOf(ConflictError);
    await expect(detachment.detachEntry(patientId, randomUUID(), null)).rejects.toBeInstanceOf(NotFoundError);

    const result = await detachment.detachEntry(patientId, dessert, null);
    expect(result.detached_event_ids).toEqual([dessert]);
    expect(result.meal_record_id).toEqual(expect.any(String));
    expect((await mealOf(patientId, dessert))?.identity).toBe(buildNewMealId(epochId, dessert));
    expect((await mealOf(patientId, lunch))?.identity).toBe(buildNewMealId(epochId, lunch));

    // A historical entry cannot start a meal: it is left on its own.
    await expect(detachment.detachEntry(patientId, late, null)).resolves.toEqual({ detached_event_ids: [late], meal_record_id: null });
    expect(await mealOf(patientId, late)).toBeNull();
    expect(await counts(patientId)).toEqual({ meals: 2, entries: 2 });
  });

  it('enforces one meal per event and immutable epochs in the database', async () => {
    const patientId = await patient();
    const epochId = await epoch(patientId);
    const eventId = await event(patientId, { minutes: 30 });
    await meal(patientId, epochId, eventId);
    const mealRecordId = (await pool.query(`SELECT id::text FROM meal_records WHERE patient_id = $1::uuid`, [patientId])).rows[0].id;

    await expect(pool.query(
      `INSERT INTO meal_record_entries (patient_id, event_id, meal_record_id, occurred_at) VALUES ($1::uuid,$2::uuid,$3::uuid,now())`,
      [patientId, eventId, mealRecordId],
    )).rejects.toThrow(/meal_record_entries_pkey/);
    await expect(meal(patientId, epochId, eventId)).rejects.toThrow(/meal_records_identity_unique|meal_records_anchor_unique/);
    await expect(pool.query(`UPDATE meal_history_epochs SET starts_at = starts_at - interval '1 day' WHERE id = $1::uuid`, [epochId]))
      .rejects.toThrow(/MEAL_HISTORY_EPOCH_IMMUTABLE/);
    await expect(epoch(patientId)).rejects.toThrow(/meal_history_epochs_one_active_per_patient/);
    await expect(pool.query(`UPDATE meal_records SET status = 'CONFIRMED' WHERE patient_id = $1::uuid`, [patientId]))
      .rejects.toThrow(/meal_records_trusted_requires_caregiver/);
  });

  const rawMealInsert = (patientId: string, epochId: string, anchorEventId: string, identity?: string) => `
    INSERT INTO meal_records (patient_id, meal_identity, epoch_id, assignment_policy_version, anchor_event_id)
    VALUES ('${patientId}', '${identity ?? buildNewMealId(epochId, anchorEventId)}', '${epochId}', 'new-meal-assignment.v1', '${anchorEventId}')
    RETURNING id::text`;

  it('rejects meals that the application could never start, directly in the database', async () => {
    const patientId = await patient();
    const epochId = await epoch(patientId);
    const historical = await event(patientId, { minutes: 30, origin: 'HISTORICAL' });
    const bolus = await event(patientId, { minutes: 35, type: 'BOLUS' });
    const preEpoch = await event(patientId, { minutes: -30 });
    const live = await event(patientId, { minutes: 40 });

    for (const anchor of [historical, bolus, preEpoch]) {
      await expect(inTransaction(async (client) => { await client.query(rawMealInsert(patientId, epochId, anchor)); }))
        .rejects.toThrow(/MEAL_RECORD_ANCHOR_NOT_ELIGIBLE/);
    }
    await expect(inTransaction(async (client) => { await client.query(rawMealInsert(patientId, epochId, live, 'meal:forged')); }))
      .rejects.toThrow(/meal_records_identity_derived/);
    // A meal without its anchor entry fails at commit (deferred foreign key).
    await expect(inTransaction(async (client) => { await client.query(rawMealInsert(patientId, epochId, live)); }))
      .rejects.toThrow(/meal_records_anchor_entry_fk/);

    await pool.query(`UPDATE meal_history_epochs SET retired_at = now() WHERE id = $1::uuid`, [epochId]);
    await expect(inTransaction(async (client) => { await client.query(rawMealInsert(patientId, epochId, live)); }))
      .rejects.toThrow(/MEAL_RECORD_EPOCH_NOT_ACTIVE/);
    expect(await counts(patientId)).toEqual({ meals: 0, entries: 0 });
  });

  it('keeps memberships and identity immutable', async () => {
    const patientId = await patient();
    const epochId = await epoch(patientId);
    const first = await event(patientId, { minutes: 30 });
    const bolus = await event(patientId, { minutes: 35, type: 'BOLUS' });
    const chainedIds = [];
    for (const minutes of [70, 110, 150, 190]) chainedIds.push(await event(patientId, { minutes, carbs: 10 }));
    const mainIdentity = await meal(patientId, epochId, first, chainedIds.slice(0, 2));
    await meal(patientId, epochId, chainedIds[2], [chainedIds[3]], mainIdentity);

    const meals = (await pool.query(`SELECT id::text, meal_identity, chained_to_meal_record_id IS NOT NULL AS chained FROM meal_records WHERE patient_id = $1::uuid ORDER BY created_at, meal_identity = $2 DESC`, [patientId, mainIdentity])).rows;
    const main = meals.find((row) => row.meal_identity === mainIdentity)!;
    const chained = meals.find((row) => row.meal_identity !== mainIdentity)!;
    expect(chained.chained).toBe(true);

    await expect(pool.query(
      `INSERT INTO meal_record_entries (patient_id, event_id, meal_record_id, occurred_at) VALUES ($1::uuid,$2::uuid,$3::uuid,now())`,
      [patientId, bolus, main.id],
    )).rejects.toThrow(/MEAL_RECORD_ENTRY_NOT_ELIGIBLE/);
    await expect(pool.query(`UPDATE meal_record_entries SET meal_record_id = $2::uuid WHERE patient_id = $1::uuid AND event_id = $3::uuid`, [patientId, chained.id, chainedIds[0]]))
      .rejects.toThrow(/MEAL_RECORD_ENTRY_IMMUTABLE/);
    await expect(pool.query(`UPDATE meal_records SET chained_to_meal_record_id = NULL WHERE id = $1::uuid`, [chained.id]))
      .rejects.toThrow(/MEAL_RECORD_IMMUTABLE_FIELD/);
    await expect(pool.query(`UPDATE meal_records SET anchor_event_id = $2::uuid WHERE id = $1::uuid`, [main.id, chainedIds[0]]))
      .rejects.toThrow(/MEAL_RECORD_IMMUTABLE_FIELD/);
    expect(await counts(patientId)).toEqual({ meals: 2, entries: 5 });
  });

  it('makes a concurrent epoch retirement wait for a meal being created', async () => {
    const patientId = await patient();
    const epochId = await epoch(patientId);
    const eventId = await event(patientId, { minutes: 30 });
    // meal_records_guard_insert share-locks the epoch row until the meal's transaction ends.
    const creating = await pool.connect();
    try {
      await creating.query('BEGIN');
      const id = (await creating.query<{ id: string }>(rawMealInsert(patientId, epochId, eventId))).rows[0].id;
      await creating.query(`INSERT INTO meal_record_entries (patient_id, event_id, meal_record_id, occurred_at) VALUES ($1::uuid, $2::uuid, $3::uuid, now())`, [patientId, eventId, id]);

      const retire = await pool.connect();
      try {
        await retire.query('BEGIN');
        await retire.query(`SET LOCAL lock_timeout = '300ms'`);
        await expect(retire.query(`UPDATE meal_history_epochs SET retired_at = now() WHERE id = $1::uuid`, [epochId])).rejects.toThrow(/lock timeout/);
        await retire.query('ROLLBACK');
      } finally {
        retire.release();
      }
      await creating.query('COMMIT');
    } finally {
      creating.release();
    }
    expect(await counts(patientId)).toEqual({ meals: 1, entries: 1 });
  });

  it('keeps every trust-relevant change in revisions, including after cancellation', async () => {
    const patientId = await patient();
    const userId = await caregiver();
    const epochId = await epoch(patientId);
    const eventId = await event(patientId, { minutes: 30 });
    const mealId = await meal(patientId, epochId, eventId);

    await records.recordDescription(patientId, mealId, { description: 'kanapka', photo_ref: null });
    const proposalId = await records.recordAiProposal(patientId, mealId, { carbs_g: 30, protein_g: 10, fat_g: 8, ai_execution_id: null });
    await records.confirmProposal(patientId, mealId, userId, proposalId);
    await records.correctMacros(patientId, mealId, userId, { carbs_g: 35, protein_g: 12, fat_g: 8 });
    await cancelMeal(patientId, mealId);

    const row = (await pool.query(`SELECT status, confirmed_macros, confirmed_by::text, revisions FROM meal_records WHERE meal_identity = $1`, [mealId])).rows[0];
    expect(row.status).toBe('CANCELLED');
    expect(row.confirmed_by).toBe(userId);
    expect(row.confirmed_macros.protein).toEqual({ grams: 12, origin: 'CAREGIVER' });
    expect(row.revisions.map((revision: { status: string }) => revision.status)).toEqual(['AWAITING_DESCRIPTION', 'DESCRIBED', 'AI_PROPOSED', 'CONFIRMED', 'CORRECTED']);
    expect(row.revisions[3].confirmed_macros.protein).toEqual({ grams: 10, origin: 'AI_PROPOSAL' });
    await expect(pool.query(`UPDATE meal_records SET revisions = '[]'::jsonb WHERE meal_identity = $1`, [mealId])).rejects.toThrow(/MEAL_RECORD_IMMUTABLE_FIELD/);
  });

  it('refuses a caregiver save based on an outdated meal, but not one following an AI proposal', async () => {
    const patientId = await patient();
    const userId = await caregiver();
    const epochId = await epoch(patientId);
    const eventId = await event(patientId, { minutes: 30 });
    const mealId = await meal(patientId, epochId, eventId);
    const revision = async () => (await records.getMealRecord(patientId, mealId)).content_revision;

    expect(await revision()).toBe(1);
    // Both caregivers opened the meal at revision 1; the first save wins and moves the revision.
    await records.updateDescription(patientId, mealId, 'pizza', { expectedRevision: 1 });
    expect(await revision()).toBe(2);
    await expect(records.updateDescription(patientId, mealId, 'kanapka', { expectedRevision: 1 })).rejects.toThrow(/MEAL_CHANGED/);
    await expect(records.correctMacros(patientId, mealId, userId, { carbs_g: 30, protein_g: null, fat_g: null }, { expectedRevision: 1 })).rejects.toThrow(/MEAL_CHANGED/);
    expect((await records.getMealRecord(patientId, mealId)).description).toBe('pizza');

    // An AI proposal does not count: the caregiver may still save on the revision they saw.
    const proposalId = await records.recordAiProposal(patientId, mealId, { carbs_g: 60, protein_g: 20, fat_g: 15, ai_execution_id: null });
    expect(await revision()).toBe(2);
    await records.confirmProposal(patientId, mealId, userId, proposalId, { expectedRevision: 2 });
    expect(await revision()).toBe(3);
    // Without an expected revision (older apps) nothing is checked.
    await records.correctMacros(patientId, mealId, userId, { carbs_g: 55, protein_g: null, fat_g: null });
    expect(await revision()).toBe(4);
  });

  it('applies evidence exclusions at read time without changing the membership', async () => {
    const patientId = await patient();
    const epochId = await epoch(patientId);
    const eventId = await event(patientId, { minutes: 30 });
    const mealId = await meal(patientId, epochId, eventId);

    await pool.query(
      `INSERT INTO evidence_exclusions (patient_id, exclusion_identity, target_kind, target_id, reason_code, lifecycle_status, origin_type, origin_ref, actor_type, actor_id)
       VALUES ($1::uuid, 'exclusion-1', 'EVENT', $2::uuid, 'SENSOR_ERROR', 'ACTIVE', 'TEST', 'test', 'USER', 'caregiver')`,
      [patientId, eventId],
    );
    const excluded = await records.getMealRecord(patientId, mealId);
    expect(excluded.evidence_excluded).toBe(true);
    expect(selectMealsForAiContext([excluded])).toMatchObject({ trusted: [], unconfirmed: [], excluded_count: 1 });

    await pool.query(
      `UPDATE evidence_exclusions SET lifecycle_status = 'REVOKED', revoked_at = now(), revoked_by_actor_type = 'USER', revoked_by_actor_id = 'caregiver'
       WHERE patient_id = $1::uuid`,
      [patientId],
    );
    const restored = await records.getMealRecord(patientId, mealId);
    expect(restored.evidence_excluded).toBe(false);
    expect(selectMealsForAiContext([restored]).unconfirmed).toHaveLength(1);
    expect(await counts(patientId)).toEqual({ meals: 1, entries: 1 });
  });

  it('lists meals started in a window with a fixed number of queries and the same records as reading each meal', async () => {
    const patientId = await patient();
    const userId = await caregiver();
    const epochId = await epoch(patientId);
    const minutes = [30, 330, 630, 930, 1230, 1530, 1830];
    const ids: string[] = [];
    for (const minute of minutes) ids.push(await event(patientId, { minutes: minute, carbs: 20 + minute / 30 }));
    // A second entry joins the first meal.
    const joined = await event(patientId, { minutes: 45, carbs: 12 });
    const mealIds = [];
    for (const [index, id] of ids.entries()) mealIds.push(await meal(patientId, epochId, id, index === 0 ? [joined] : []));

    await records.recordDescription(patientId, mealIds[0], { description: 'owsianka', photo_ref: null });
    await records.confirmProposal(patientId, mealIds[0], userId, await records.recordAiProposal(patientId, mealIds[0], { carbs_g: 45, protein_g: 9, fat_g: 6, ai_execution_id: null }));
    await records.recordDescription(patientId, mealIds[1], { description: 'zupa', photo_ref: null });
    await records.recordAiProposal(patientId, mealIds[1], { carbs_g: 55, protein_g: 14, fat_g: 10, ai_execution_id: null });
    await records.correctMacros(patientId, mealIds[2], userId, { carbs_g: 30, protein_g: null, fat_g: 5 });
    // Excluded through its event, and through the source record of its event.
    await pool.query(
      `INSERT INTO evidence_exclusions (patient_id, exclusion_identity, target_kind, target_id, reason_code, lifecycle_status, origin_type, origin_ref, actor_type, actor_id)
       VALUES ($1::uuid, 'exclusion-event', 'EVENT', $2::uuid, 'SENSOR_ERROR', 'ACTIVE', 'TEST', 'test', 'USER', 'caregiver'),
              ($1::uuid, 'exclusion-record', 'SOURCE_RECORD', (SELECT source_record_id FROM events WHERE id = $3::uuid), 'SENSOR_ERROR', 'ACTIVE', 'TEST', 'test', 'USER', 'caregiver')`,
      [patientId, ids[3], ids[4]],
    );
    // A meal whose first entry is not a meal is left out.
    await markKind(patientId, ids[5], 'FAT_PROTEIN_UNITS');

    // The previous implementation: the window's identities, then one getMealRecord per meal.
    const identities = (await pool.query(
      `SELECT r.meal_identity
       FROM meal_records r
       JOIN meal_record_entries e ON e.meal_record_id = r.id
       LEFT JOIN carb_entry_kinds anchor_kind ON anchor_kind.patient_id = r.patient_id AND anchor_kind.event_id = r.anchor_event_id
       WHERE r.patient_id = $1::uuid
         AND COALESCE(anchor_kind.kind, 'MEAL') = 'MEAL'
       GROUP BY r.id, r.meal_identity
       HAVING min(e.occurred_at) >= $2::timestamptz AND min(e.occurred_at) <= $3::timestamptz
       ORDER BY min(e.occurred_at), r.meal_identity`,
      [patientId, at(0), at(1600)],
    )).rows.map((row) => String(row.meal_identity));
    const expected = [];
    for (const identity of identities) expected.push(await records.getMealRecord(patientId, identity));

    let queries = 0;
    const countingPool = new Proxy(pool, {
      get(target, property, receiver) {
        if (property === 'query') return (...args: unknown[]) => { queries += 1; return (target.query as (...a: unknown[]) => unknown)(...args); };
        return Reflect.get(target, property, receiver);
      },
    });
    const listed = await new PostgresMealRecordRepository(countingPool).listMealRecordsStartedBetween(patientId, at(0), at(1600));

    expect(listed).toEqual(expected);
    expect(listed.map((record) => record.meal_identity)).toEqual([mealIds[0], mealIds[1], mealIds[2], mealIds[3], mealIds[4]]);
    expect(listed.map((record) => record.evidence_excluded)).toEqual([false, false, false, true, true]);
    expect(listed[0]).toMatchObject({ status: 'CONFIRMED', description: 'owsianka', source_carbs_g: 33 });
    // Meals, entry links, active exclusions: independent of the number of meals.
    expect(queries).toBe(3);
    await expect(records.listMealRecordsStartedBetween(patientId, at(2000), at(3000))).resolves.toEqual([]);
  });

  it('deletes a patient with meal history cleanly (cascade order)', async () => {
    const patientId = await patient();
    const epochId = await epoch(patientId);
    const ids = [];
    for (const minutes of [30, 70, 110, 150, 190]) ids.push(await event(patientId, { minutes, carbs: 10 }));
    const main = await meal(patientId, epochId, ids[0], ids.slice(1, 3));
    await meal(patientId, epochId, ids[3], [ids[4]], main);
    expect(await counts(patientId)).toEqual({ meals: 2, entries: 5 });
    await pool.query(`DELETE FROM patients WHERE id = $1::uuid`, [patientId]);
    expect(await counts(patientId)).toEqual({ meals: 0, entries: 0 });
  });

  it('starts fresh under a new epoch without reusing or changing meals of the retired one', async () => {
    const patientId = await patient();
    const firstEpoch = await epoch(patientId);
    const first = await event(patientId, { minutes: 30 });
    const firstMeal = await meal(patientId, firstEpoch, first);
    await pool.query(`UPDATE meal_history_epochs SET retired_at = now() WHERE id = $1::uuid`, [firstEpoch]);
    await expect(pool.query(`UPDATE meal_history_epochs SET retired_at = NULL WHERE id = $1::uuid`, [firstEpoch])).rejects.toThrow(/MEAL_HISTORY_EPOCH_IMMUTABLE/);

    const secondEpoch = await epoch(patientId, { startsAt: at(60) });
    const second = await event(patientId, { minutes: 70 });
    // The retired epoch takes no new meals; the new one does, with its own identity.
    const third = await event(patientId, { minutes: 80 });
    await expect(meal(patientId, firstEpoch, third)).rejects.toThrow(/MEAL_RECORD_EPOCH_NOT_ACTIVE/);
    expect(await meal(patientId, secondEpoch, second)).toBe(buildNewMealId(secondEpoch, second));
    expect((await mealOf(patientId, first))?.identity).toBe(firstMeal);
    expect(await counts(patientId)).toEqual({ meals: 2, entries: 2 });
  });

  it('keeps AI proposals untrusted until the caregiver confirms or corrects them', async () => {
    const patientId = await patient();
    const userId = await caregiver();
    const epochId = await epoch(patientId);
    const eventId = await event(patientId, { minutes: 30, carbs: 42 });
    const mealId = await meal(patientId, epochId, eventId);

    await expect(records.confirmProposal(patientId, mealId, userId, randomUUID())).rejects.toBeInstanceOf(ConflictError);
    await records.recordDescription(patientId, mealId, { description: 'naleśniki z serem', photo_ref: null });
    const firstProposal = await records.recordAiProposal(patientId, mealId, { carbs_g: 60, protein_g: 20, fat_g: 15, ai_execution_id: null });
    const proposalId = await records.recordAiProposal(patientId, mealId, { carbs_g: 55, protein_g: 18, fat_g: 12, ai_execution_id: null });
    // The caregiver confirmed what they saw first, but a newer proposal replaced it: refused, nothing trusted.
    await expect(records.confirmProposal(patientId, mealId, userId, firstProposal)).rejects.toThrow(/MEAL_PROPOSAL_CHANGED/);
    expect((await records.getMealRecord(patientId, mealId)).pending_proposal_id).toBe(proposalId);
    const stored = (await pool.query(`SELECT proposal FROM meal_records WHERE meal_identity = $1`, [mealId])).rows[0].proposal;
    expect(stored).toMatchObject({ proposal_id: proposalId, based_on: { description: 'naleśniki z serem', photo_ref: null } });

    const proposed = selectMealsForAiContext([await records.getMealRecord(patientId, mealId)]);
    expect(proposed.trusted).toEqual([]);
    expect(proposed.unconfirmed[0]).toMatchObject({
      record_status: 'AI_PROPOSED',
      trusted: false,
      description: 'naleśniki z serem',
      carbs: { value: 42, knowledge_status: 'KNOWN', origin: 'OBSERVED' },
      protein: { value: null, knowledge_status: 'UNKNOWN', unconfirmed_proposal_g: 18 },
    });

    await records.confirmProposal(patientId, mealId, userId, proposalId);
    const confirmed = selectMealsForAiContext([await records.getMealRecord(patientId, mealId)]);
    expect(confirmed.trusted[0]).toMatchObject({ record_status: 'CONFIRMED', protein: { value: 18, knowledge_status: 'KNOWN', value_source: 'AI_PROPOSAL' } });
    const audit = (await pool.query(`SELECT confirmed_by::text, confirmed_at IS NOT NULL AS has_time FROM meal_records WHERE meal_identity = $1`, [mealId])).rows[0];
    expect(audit).toEqual({ confirmed_by: userId, has_time: true });

    await records.correctMacros(patientId, mealId, userId, { carbs_g: 50, protein_g: 20, fat_g: null });
    const corrected = selectMealsForAiContext([await records.getMealRecord(patientId, mealId)]);
    expect(corrected.trusted[0]).toMatchObject({
      record_status: 'CORRECTED',
      protein: { value: 20, value_source: 'CAREGIVER' },
      fat: { value: null, knowledge_status: 'UNKNOWN' },
      source_carbs_g: 42,
    });

    await cancelMeal(patientId, mealId);
    expect(selectMealsForAiContext([await records.getMealRecord(patientId, mealId)])).toMatchObject({ trusted: [], unconfirmed: [], excluded_count: 1 });
    await expect(records.recordAiProposal(patientId, mealId, { carbs_g: 1, protein_g: 1, fat_g: 1, ai_execution_id: null })).rejects.toBeInstanceOf(ConflictError);
  });
});
