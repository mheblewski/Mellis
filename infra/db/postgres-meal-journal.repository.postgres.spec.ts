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

describePostgres('meals journal and Bolus tab reminders (postgres, migration 073)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let patientId: string;
  // Loaded lazily, like the other gated specs.
  let JournalRepository: typeof import('./postgres-meal-journal.repository').PostgresMealJournalRepository;
  let CareReminderRepository: typeof import('./postgres-care-reminders.repository').PostgresCareReminderRepository;

  beforeAll(async () => {
    // One connection: the rows below skip their sources (epochs, events) with foreign keys off for this session.
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrations(pool);
    JournalRepository = (await import('./postgres-meal-journal.repository')).PostgresMealJournalRepository;
    CareReminderRepository = (await import('./postgres-care-reminders.repository')).PostgresCareReminderRepository;
  });

  beforeEach(async () => {
    await pool.query(`SET session_replication_role = DEFAULT`);
    await truncatePublicTablesForIntegrationTests(pool);
    patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'journal-test')`, [patientId]);
    await pool.query(`SET session_replication_role = replica`);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`SET session_replication_role = DEFAULT`).catch(() => undefined);
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  async function meal(startedAt: string, description: string | null, status = 'AWAITING_DESCRIPTION'): Promise<string> {
    const id = randomUUID();
    const anchorId = randomUUID();
    const epochId = randomUUID();
    await pool.query(
      `INSERT INTO meal_records (id, patient_id, meal_identity, epoch_id, assignment_policy_version, anchor_event_id, status, description)
       VALUES ($1::uuid, $2::uuid, 'meal:v1:' || $3 || ':' || $4, $3::uuid, 'v1', $4::uuid, $5, $6)`,
      [id, patientId, epochId, anchorId, status, description],
    );
    await pool.query(`INSERT INTO meal_record_entries (patient_id, event_id, meal_record_id, occurred_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)`, [patientId, anchorId, id, startedAt]);
    return id;
  }

  async function glucose(at: string, value: number): Promise<void> {
    await pool.query(
      `INSERT INTO events (id, patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload, event_ingestion_origin, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'GLUCOSE_READING_AVAILABLE', $4::timestamptz, $4::timestamptz, '{}'::jsonb, '{}'::jsonb, $5::jsonb, 'LIVE', $4::timestamptz)`,
      [randomUUID(), patientId, randomUUID(), at, JSON.stringify({ glucose_value: value })],
    );
  }

  it('lists described meals and meals with reminders, newest first, in pages', async () => {
    const care = new CareReminderRepository(pool);
    const repo = new JournalRepository(pool);
    const described = await meal('2026-10-25T10:00:00.000Z', 'Owsianka');
    const bolusTab = await meal('2026-10-25T16:05:00.000Z', null);
    const autoOff = await meal('2026-10-25T13:00:00.000Z', null);
    await meal('2026-10-25T12:00:00.000Z', 'Anulowany', 'CANCELLED');
    await meal('2026-10-25T11:00:00.000Z', null);
    await care.insertSecondDose({ patient_id: patientId, meal_record_id: bolusTab, created_by_user_id: null, source_ref: 'remote-command:c1', note: 'Druga dawka · 45 g · 4,5 j o 18:05', trigger: 'GLUCOSE_RISING', due_at: '2026-10-25T16:06:00.000Z', wait_until: '2026-10-25T17:05:00.000Z' });
    await pool.query(`INSERT INTO meal_wbt_reminders (patient_id, meal_record_id, enabled, source, remind_at) VALUES ($1::uuid, $2::uuid, false, 'AUTO', now())`, [patientId, autoOff]);

    const first = await repo.listJournalMeals(patientId, null, 1);
    expect(first.map((row) => row.meal_record_id)).toEqual([bolusTab]);
    const rest = await repo.listJournalMeals(patientId, first[0].started_at, 10);
    expect(rest.map((row) => row.meal_record_id)).toEqual([described]);
  });

  it('keeps one second dose per meal and switches it back on only while it can still come', async () => {
    const care = new CareReminderRepository(pool);
    const mealId = await meal('2026-10-25T16:05:00.000Z', null);
    const future = new Date(Date.now() + 30 * 60_000).toISOString();
    const reminder = { patient_id: patientId, meal_record_id: mealId, created_by_user_id: null, source_ref: 'remote-command:c1', note: 'Druga dawka', trigger: 'AT_TIME' as const, due_at: future, wait_until: null };
    const created = await care.insertSecondDose(reminder);
    expect(created).toMatchObject({ kind: 'SECOND_DOSE', meal_record_id: mealId, status: 'ACTIVE' });
    expect(await care.insertSecondDose(reminder)).toBeNull();
    await care.cancel(patientId, created!.id, randomUUID());
    expect((await care.reactivate(patientId, created!.id))?.status).toBe('ACTIVE');
    await pool.query(`UPDATE care_reminders SET status = 'CANCELLED', due_at = now() - interval '1 minute' WHERE id = $1::uuid`, [created!.id]);
    expect(await care.reactivate(patientId, created!.id)).toBeNull();
    expect((await care.listForMeals(patientId, [mealId])).map((row) => row.id)).toEqual([created!.id]);
  });

  it('settles a second dose given before it came, misses a late one, and keeps which dose answered a reminder (082)', async () => {
    const care = new CareReminderRepository(pool);
    const repo = new JournalRepository(pool);
    const mealId = await meal('2026-10-25T16:05:00.000Z', null);
    const future = new Date(Date.now() + 30 * 60_000).toISOString();
    const given = (await care.insertSecondDose({ patient_id: patientId, meal_record_id: mealId, created_by_user_id: null, source_ref: 'remote-command:g1', note: 'Druga dawka', trigger: 'AT_TIME', due_at: future, wait_until: null }))!;
    const action = randomUUID();
    expect(await care.markGivenBeforeDue(patientId, given.id, '2026-10-25T16:40:00.000Z', action)).toBe(true);
    expect(await care.markGivenBeforeDue(patientId, given.id, '2026-10-25T16:40:00.000Z', action)).toBe(false);
    expect(await care.get(patientId, given.id)).toMatchObject({ status: 'GIVEN', dose_given_at: '2026-10-25T16:40:00.000Z', dose_given_action_id: action });

    const missed = await care.insert({ patient_id: patientId, conversation_id: null, user_message_id: randomUUID(), created_by_user_id: null, note: 'Zmiana wkłucia', trigger: 'AT_TIME', due_at: future, threshold_mgdl: null, wait_until: null } as never);
    expect((await care.listActive()).map((row) => row.id)).toEqual([missed.id]);
    expect(await care.markMissed(patientId, missed.id)).toBe(true);
    expect((await care.get(patientId, missed.id))?.status).toBe('MISSED');
    expect(await care.listActive()).toEqual([]);

    const wbtAction = randomUUID();
    await pool.query(`INSERT INTO meal_wbt_reminders (patient_id, meal_record_id, enabled, source, remind_at, status, sent_at) VALUES ($1::uuid, $2::uuid, true, 'AUTO', now(), 'SENT', now())`, [patientId, mealId]);
    expect(await repo.markDoseGiven({ kind: 'WBT', reminder_id: 'wbt', patient_id: patientId, meal_record_id: mealId }, '2026-10-25T18:40:00.000Z', wbtAction)).toBe(true);
    expect([...await repo.answeredDoseActionIds(patientId)].sort()).toEqual([action, wbtAction].sort());

    // The excess the caregivers were last told about (084).
    expect(await repo.notifiedDoseExcess(patientId, mealId)).toBe(0);
    await repo.setNotifiedDoseExcess(patientId, mealId, 10);
    await repo.setNotifiedDoseExcess(patientId, mealId, 15);
    expect(await repo.notifiedDoseExcess(patientId, mealId)).toBe(15);
  });

  it('searches descriptions without case or Polish diacritics, with glucose 4 h after', async () => {
    const repo = new JournalRepository(pool);
    const pancakes = await meal('2026-10-25T10:00:00.000Z', 'Naleśniki z serem');
    await meal('2026-10-25T11:00:00.000Z', 'Zupa pomidorowa');
    await glucose('2026-10-25T10:30:00.000Z', 180);
    await glucose('2026-10-25T12:00:00.000Z', 95);
    await glucose('2026-10-25T15:00:00.000Z', 60);
    const rows = await repo.searchMeals(patientId, '%NALESNIKI%', 10);
    expect(rows).toEqual([{ meal_record_id: pancakes, started_at: '2026-10-25T10:00:00.000Z', glucose_peak_mgdl: 180, glucose_min_mgdl: 95 }]);
    expect(await repo.searchMeals(patientId, '%\\%%', 10)).toEqual([]);
  });

  it('validates the reminders a command stores', async () => {
    const valid = async (value: unknown) => (await pool.query(`SELECT glucomind_valid_bolus_reminders($1::jsonb) AS ok`, [JSON.stringify(value)])).rows[0].ok;
    expect(await valid([{ kind: 'WBT' }, { kind: 'SECOND_DOSE', trigger: 'AFTER_MINUTES', minutes: 30 }])).toBe(true);
    expect(await valid([{ kind: 'SECOND_DOSE', trigger: 'GLUCOSE_RISING' }])).toBe(true);
    expect(await valid([{ kind: 'WBT' }, { kind: 'WBT' }])).toBe(false);
    expect(await valid([{ kind: 'SECOND_DOSE', trigger: 'AFTER_MINUTES', minutes: 241 }])).toBe(false);
    expect(await valid([{ kind: 'SECOND_DOSE', trigger: 'AFTER_MINUTES', minutes: 30, extra: 1 }])).toBe(false);
    expect(await valid(['WBT'])).toBe(false);
    expect(await valid([])).toBe(false);
    expect(await valid({ kind: 'WBT' })).toBe(false);
  });
});
