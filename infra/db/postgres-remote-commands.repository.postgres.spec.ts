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
import { ConflictError } from '@shared/errors/app-error';
import type { NewRemoteCommand } from '@modules/remote-commands/application/remote-command-record';

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

describePostgres('remote commands (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let patientId: string;
  let userId: string;
  // Loaded lazily: offline runs must not import the gated modules (postgres-gated-spec-imports.spec.ts).
  let RepositoryClass: typeof import('./postgres-remote-commands.repository').PostgresRemoteCommandRepository;
  let LoopActionsClass: typeof import('./postgres-loop-actions.repository').PostgresLoopActionRepository;
  let MealRecordsClass: typeof import('./postgres-meal-history.repository').PostgresMealRecordRepository;
  let ReconcilerClass: typeof import('@modules/remote-commands/application/remote-command-reconciler').RemoteCommandReconciler;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrations(pool);
    RepositoryClass = (await import('./postgres-remote-commands.repository')).PostgresRemoteCommandRepository;
    LoopActionsClass = (await import('./postgres-loop-actions.repository')).PostgresLoopActionRepository;
    MealRecordsClass = (await import('./postgres-meal-history.repository')).PostgresMealRecordRepository;
    ReconcilerClass = (await import('@modules/remote-commands/application/remote-command-reconciler')).RemoteCommandReconciler;
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    patientId = randomUUID();
    userId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'remote-commands-test')`, [patientId]);
    await pool.query(`INSERT INTO users (id, display_name) VALUES ($1::uuid, 'Ania')`, [userId]);
  });

  afterAll(async () => {
    if (pool) {
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  const command = (overrides: Partial<NewRemoteCommand> = {}): NewRemoteCommand => ({
    patient_id: patientId,
    user_id: userId,
    device_id: 'device-1',
    source: 'NEW_MEAL',
    conversation_id: null,
    proposal_id: null,
    follows_command_id: null,
    carbs_g: 46,
    insulin_u: 4.6,
    bolus_step: 0.05,
    icr_g_per_u: 10,
    icr_insulin_u: 4.6,
    meal_payload: {
      description: 'Naleśniki z serem ×2',
      items: [{ name: 'Naleśnik z serem', grams: 240, carbs_g: 46, protein_g: 22, fat_g: 14, source: 'DIABCALC' }],
      macros: { carbs_g: 46, protein_g: 22, fat_g: 14 },
    },
    context: { now: new Date().toISOString(), glucose: null, lowest_recent_glucose: null, loop: null, last_bolus: null, icr_g_per_u: 10, in_flight_command_id: null },
    warnings: [],
    policy_version: 'remote-commands.v1',
    send_deadline: new Date(Date.now() + 120_000).toISOString(),
    purpose: null,
    target_meal_record_id: null,
    ...overrides,
  });

  it('keeps one command of a patient in flight and one send per chat proposal', async () => {
    const repo = new RepositoryClass(pool);
    const first = await repo.insert(command());
    await expect(repo.insert(command())).rejects.toThrow(/COMMAND_IN_FLIGHT/);
    expect((await repo.findInFlight(patientId, new Date().toISOString()))?.id).toBe(first.id);

    await repo.transition(patientId, first.id, 'SENT', { sent_at: new Date().toISOString() });
    await repo.transition(patientId, first.id, 'SUCCEEDED', { status_message: 'Bolus podany' });
    expect(await repo.findInFlight(patientId, new Date().toISOString())).toBeNull();
    // A finished command never moves back.
    expect(await repo.transition(patientId, first.id, 'REJECTED', {})).toBeNull();

    const proposalId = randomUUID();
    const fromCard = await repo.insert(command({ proposal_id: proposalId }));
    await repo.transition(patientId, fromCard.id, 'SENT', { sent_at: new Date().toISOString() });
    await repo.transition(patientId, fromCard.id, 'SUCCEEDED', {});
    await expect(repo.insert(command({ proposal_id: proposalId }))).rejects.toBeInstanceOf(ConflictError);
  });

  it('lists the recent commands with carbs and insulin from any screen, newest first, and keeps the calculator in the context (dose-calculator.v1)', async () => {
    const repo = new RepositoryClass(pool);
    const calculation = { policy_version: 'dose-calculator.v1', default_u: 2.2, reference_u: 2.2, summary: 'Kalkulator pętli: 2,2 j zamiast 4,6 j z przelicznika — IOB 2,6 j, glukoza 120.' };
    const first = await repo.insert(command({ source: 'BOLUS_SCREEN', meal_payload: null, context: { ...command().context, dose_calculation: calculation as never } }));
    await repo.transition(patientId, first.id, 'SENT', { sent_at: new Date().toISOString() });
    await repo.transition(patientId, first.id, 'SUCCEEDED', {});
    const carbsOnly = await repo.insert(command({ insulin_u: 0 }));
    await repo.transition(patientId, carbsOnly.id, 'SEND_FAILED', {});
    const second = await repo.insert(command({ source: 'CHAT_CARD', proposal_id: randomUUID() }));
    await pool.query(`UPDATE remote_commands SET authorized_at = now() - interval '2 hours' WHERE id = $1::uuid`, [first.id]);
    const since = new Date(Date.now() - 90 * 60_000).toISOString();
    expect((await repo.listRecentMealBoluses(patientId, since)).map((row) => row.id)).toEqual([second.id]);
    expect((await repo.listRecentMealBoluses(patientId, new Date(Date.now() - 3 * 3_600_000).toISOString())).map((row) => row.id)).toEqual([second.id, first.id]);
    expect((await repo.get(patientId, first.id))?.context.dose_calculation).toMatchObject({ default_u: 2.2, reference_u: 2.2 });
    expect(await repo.listRecentMealBoluses(randomUUID(), since)).toEqual([]);
  });

  it('lists every command authorized since a time, newest first, any amounts and status (dose-calculator.v1 review L2, L3)', async () => {
    const repo = new RepositoryClass(pool);
    const old = await repo.insert(command({ insulin_u: 1.5, carbs_g: 0, meal_payload: null }));
    await repo.transition(patientId, old.id, 'SEND_FAILED', {});
    await pool.query(`UPDATE remote_commands SET authorized_at = now() - interval '3 hours' WHERE id = $1::uuid`, [old.id]);
    const carbsOnly = await repo.insert(command({ insulin_u: 0 }));
    await repo.transition(patientId, carbsOnly.id, 'SENT', { sent_at: new Date().toISOString() });
    await repo.transition(patientId, carbsOnly.id, 'SUCCEEDED', {});
    await pool.query(`UPDATE remote_commands SET authorized_at = now() - interval '20 minutes' WHERE id = $1::uuid`, [carbsOnly.id]);
    const bolus = await repo.insert(command({ carbs_g: 0, insulin_u: 2, meal_payload: null }));
    const since = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const recent = await repo.listRecent(patientId, since);
    expect(recent.map((row) => row.id)).toEqual([bolus.id, carbsOnly.id]);
    expect(recent[1]).toMatchObject({ carbs_g: carbsOnly.carbs_g, insulin_u: 0, status: 'SUCCEEDED' });
    expect(await repo.listRecent(randomUUID(), since)).toEqual([]);
  });

  it('stores the reminders of a Bolus tab command and refuses them on any other (migration 073)', async () => {
    const repo = new RepositoryClass(pool);
    const reminders = [{ kind: 'WBT' as const }, { kind: 'SECOND_DOSE' as const, trigger: 'AFTER_MINUTES' as const, minutes: 30 }];
    const stored = await repo.insert(command({ source: 'BOLUS_SCREEN', meal_payload: null, reminders }));
    expect((await repo.get(patientId, stored.id))?.reminders).toEqual(reminders);
    await repo.transition(patientId, stored.id, 'SEND_FAILED', {});
    await expect(repo.insert(command({ reminders }))).rejects.toThrow(/remote_commands_reminders_check/);
    const plain = await repo.insert(command({ source: 'BOLUS_SCREEN', meal_payload: null }));
    expect(plain.reminders).toBeNull();
  });

  it('queues one Nightscout read per source and time after Trio answered, once per command', async () => {
    const repo = new RepositoryClass(pool);
    const source = (await pool.query(`INSERT INTO sources (patient_id, source_system, source_key, source_version, metadata) VALUES ($1::uuid, 'NIGHTSCOUT', 'ns-test', 'v1', '{}'::jsonb) RETURNING id`, [patientId])).rows[0].id as string;
    const otherPatient = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'other')`, [otherPatient]);
    await pool.query(`INSERT INTO sources (patient_id, source_system, source_key, source_version, metadata) VALUES ($1::uuid, 'NIGHTSCOUT', 'ns-other', 'v1', '{}'::jsonb)`, [otherPatient]);
    const sent = await repo.insert(command());
    const at = [new Date(Date.now() + 3_000).toISOString(), new Date(Date.now() + 10_000).toISOString()];

    await repo.requestNightscoutSync(patientId, sent.id, at);
    await repo.requestNightscoutSync(patientId, sent.id, at);

    const jobs = (await pool.query(`SELECT payload, patient_id, available_at, status FROM jobs WHERE job_type = 'nightscout.sync' ORDER BY available_at`)).rows;
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.payload)).toEqual([{ source_id: source, remote_command_id: sent.id }, { source_id: source, remote_command_id: sent.id }]);
    expect(jobs.every((job) => job.patient_id === patientId && job.status === 'queued')).toBe(true);
    expect(jobs.map((job) => new Date(job.available_at).toISOString())).toEqual(at);
  });

  it('treats a command without reports as possibly delivered and marks one Trio did not answer', async () => {
    const repo = new RepositoryClass(pool);
    // Within the grace after the deadline it still blocks the next command.
    const recent = await repo.insert(command({ send_deadline: new Date(Date.now() - 10_000).toISOString() }));
    expect((await repo.findInFlight(patientId, new Date().toISOString()))?.id).toBe(recent.id);
    // Later it is unknown, never "not sent": no second dose is invited.
    await pool.query(`UPDATE remote_commands SET send_deadline = now() - interval '5 minutes' WHERE id = $1::uuid`, [recent.id]);
    expect(await repo.findInFlight(patientId, new Date().toISOString())).toBeNull();
    const unreported = await repo.get(patientId, recent.id);
    expect(unreported?.status).toBe('NO_REPLY');
    expect(unreported?.status_message).toMatch(/Nie wiadomo, czy polecenie dotarło/);
    expect((await repo.findRecentWithInsulin(patientId, new Date(Date.now() - 1_800_000).toISOString()))?.id).toBe(recent.id);
    // Trio's late final answer still counts, and sets the send time.
    expect((await repo.transition(patientId, recent.id, 'SUCCEEDED', {}))?.sent_at).not.toBeNull();

    const sent = await repo.insert(command());
    await repo.transition(patientId, sent.id, 'SENT', { sent_at: new Date(Date.now() - 4 * 60_000).toISOString() });
    const noReply = await repo.applyDeadlines(new Date().toISOString());
    expect(noReply.map((row) => row.id)).toEqual([sent.id]);
    expect((await repo.get(patientId, sent.id))?.status_message).toMatch(/Nie wysyłaj ponownie/);
    expect(await repo.transition(patientId, sent.id, 'TRIO_ACCEPTED', {})).toBeNull();
    expect((await repo.transition(patientId, sent.id, 'SUCCEEDED', {}))?.status).toBe('SUCCEEDED');
  });

  it("links the loop's carb entry and bolus to the command and creates the confirmed meal without a push", async () => {
    const repo = new RepositoryClass(pool);
    const loopActions = new LoopActionsClass(pool);
    const meals = new MealRecordsClass(pool);
    const startsAt = new Date(Date.now() - 3_600_000).toISOString();
    await pool.query(
      `INSERT INTO meal_history_epochs (patient_id, starts_at, assignment_policy_version, decided_by)
       VALUES ($1::uuid, $2::timestamptz, 'new-meal-assignment.v1', 'test')`,
      [patientId, startsAt],
    );
    await pool.query(`INSERT INTO loop_action_epochs (patient_id, starts_at) VALUES ($1::uuid, $2::timestamptz)`, [patientId, startsAt]);

    const sent = await repo.insert(command());
    await repo.transition(patientId, sent.id, 'SENT', { sent_at: new Date().toISOString() });
    await repo.transition(patientId, sent.id, 'SUCCEEDED', { status_message: 'Bolus podany' });

    // Trio's entries come back through Nightscout: the carbs, then the bolus 20 s later.
    const occurred = Date.parse(sent.authorized_at) + 20_000;
    await insertEvent('CARB_ENTRY', 46, new Date(occurred).toISOString());
    await insertEvent('BOLUS', 4.6, new Date(occurred + 20_000).toISOString());
    await loopActions.groupNewEvents(patientId);

    const logged: Array<Record<string, unknown>> = [];
    const reconciler = new ReconcilerClass({
      commands: repo,
      loopActions,
      meals: {
        findMealIdentityById: (patient, mealRecordId) => meals.findMealIdentityById(patient, mealRecordId),
        editContent: (patient, identity, user, edit) => meals.editContent(patient, identity, user, edit),
      },
      log: (event) => logged.push(event),
    });
    await reconciler.run(new Date(occurred + 60_000).toISOString());

    const linked = await repo.get(patientId, sent.id);
    expect(linked?.loop_action_id).not.toBeNull();
    expect(linked?.meal_record_id).not.toBeNull();
    // Trio confirmed the bolus: until it is in Nightscout the meal shows it as awaiting; a command not given is not.
    expect(await repo.confirmedBolusesForActions(patientId, [linked!.loop_action_id!, randomUUID()])).toEqual(new Map([[linked!.loop_action_id!, { units: 4.6, confirmed_at: expect.any(String) }]]));
    const action = await loopActions.getAction(patientId, linked!.loop_action_id!);
    expect(action).toMatchObject({ purpose: 'NEW_MEAL', assigned_by: 'Ania', carbs_g: 46, bolus_units: 4.6 });
    const identity = await meals.findMealIdentityById(patientId, linked!.meal_record_id!);
    const meal = await meals.getMealRecord(patientId, identity!);
    expect(meal.description).toBe('Naleśniki z serem ×2');
    expect(meal.status).toBe('CORRECTED');
    expect(meal.items?.[0].name).toBe('Naleśnik z serem');
    expect(logged.map((event) => event.event)).toEqual(['remote_command_matched']);
    const note = (await pool.query(`SELECT content FROM meal_chat_messages WHERE meal_record_id = $1::uuid`, [linked!.meal_record_id])).rows;
    expect(note.map((row) => row.content)).toEqual(['Posiłek zapisany z nowego posiłku: 46 g węglowodanów, 4,6 j insuliny wysłane do Trio.']);

    // Nothing left to match; a second run changes nothing.
    await reconciler.run(new Date(occurred + 90_000).toISOString());
    expect(logged).toHaveLength(1);
  });

  it('switches on the WBT reminder of a fatty meal and assigns WBT from the WBT window to that meal', async () => {
    const repo = new RepositoryClass(pool);
    const loopActions = new LoopActionsClass(pool);
    const meals = new MealRecordsClass(pool);
    const wbt = new (await import('./postgres-meal-wbt.repository')).PostgresMealWbtRepository(pool);
    const { shouldRemindAboutWbt, wbtReminderAt } = await import('@modules/meal-wbt/application/wbt-policy');
    const startsAt = new Date(Date.now() - 3_600_000).toISOString();
    await pool.query(
      `INSERT INTO meal_history_epochs (patient_id, starts_at, assignment_policy_version, decided_by)
       VALUES ($1::uuid, $2::timestamptz, 'new-meal-assignment.v1', 'test')`,
      [patientId, startsAt],
    );
    await pool.query(`INSERT INTO loop_action_epochs (patient_id, starts_at) VALUES ($1::uuid, $2::timestamptz)`, [patientId, startsAt]);
    const reconciler = new ReconcilerClass({
      commands: repo,
      loopActions,
      meals: {
        findMealIdentityById: (patient, mealRecordId) => meals.findMealIdentityById(patient, mealRecordId),
        editContent: (patient, identity, user, edit) => meals.editContent(patient, identity, user, edit),
        // As the worker wires it.
        afterMealSaved: async (patient, mealRecordId) => {
          const record = await meals.getMealRecord(patient, (await meals.findMealIdentityById(patient, mealRecordId))!);
          await wbt.setAutoReminder({ patientId: patient, mealRecordId, enabled: shouldRemindAboutWbt({ protein_g: record.macros.protein.grams, fat_g: record.macros.fat.grams }), remindAt: wbtReminderAt(record.started_at) });
        },
      },
      log: () => {},
    });

    // The meal from a card: 22 g protein is over the 20 g threshold.
    const meal = await repo.insert(command());
    await repo.transition(patientId, meal.id, 'SUCCEEDED', { status_message: 'Bolus podany' });
    const mealAt = Date.parse(meal.authorized_at) + 20_000;
    await insertEvent('CARB_ENTRY', 46, new Date(mealAt).toISOString());
    await insertEvent('BOLUS', 4.6, new Date(mealAt + 10_000).toISOString());
    await loopActions.groupNewEvents(patientId);
    await reconciler.run(new Date(mealAt + 60_000).toISOString());
    const mealId = (await repo.get(patientId, meal.id))!.meal_record_id!;
    expect(await wbt.getReminder(patientId, mealId)).toMatchObject({ enabled: true, source: 'AUTO' });

    // WBT from that meal's WBT window: the carbs-equivalent and the bolus become the meal's WBT, no new meal.
    const fromWindow = await repo.insert(command({ source: 'WBT_SCREEN', carbs_g: 15, insulin_u: 1.2, meal_payload: null, purpose: 'WBT', target_meal_record_id: mealId }));
    expect(fromWindow).toMatchObject({ purpose: 'WBT', target_meal_record_id: mealId });
    expect((await repo.latestWbtForMeal(patientId, mealId))?.id).toBe(fromWindow.id);
    expect(await repo.latestWbtForMeal(patientId, randomUUID())).toBeNull();
    // Every WBT command of the meal, oldest first, and only its WBT ones (the meal's own command is not one).
    expect((await repo.listWbtForMeal(patientId, mealId)).map((row) => row.id)).toEqual([fromWindow.id]);
    expect(await repo.listWbtForMeal(patientId, randomUUID())).toEqual([]);
    expect(await repo.listWbtForMeal(patientId, 'not-a-uuid')).toEqual([]);
    await repo.transition(patientId, fromWindow.id, 'SUCCEEDED', { status_message: 'Bolus podany' });
    const wbtAt = Date.parse(fromWindow.authorized_at) + 8 * 60_000;
    await insertEvent('CARB_ENTRY', 15, new Date(wbtAt).toISOString());
    await insertEvent('BOLUS', 1.2, new Date(wbtAt + 10_000).toISOString());
    await loopActions.groupNewEvents(patientId);
    await reconciler.run(new Date(wbtAt + 60_000).toISOString());

    const linked = (await repo.get(patientId, fromWindow.id))!;
    expect(linked.meal_record_id).toBe(mealId);
    expect(await loopActions.getAction(patientId, linked.loop_action_id!)).toMatchObject({ purpose: 'WBT', meal_record_id: mealId, carbs_g: 15, bolus_units: 1.2 });
    const kinds = (await pool.query(`SELECT kind FROM carb_entry_kinds WHERE patient_id = $1::uuid ORDER BY set_at`, [patientId])).rows.map((row) => row.kind);
    expect(kinds).toEqual(['MEAL', 'FAT_PROTEIN_UNITS']);
    expect((await pool.query(`SELECT count(*)::int AS n FROM meal_records WHERE patient_id = $1::uuid`, [patientId])).rows[0].n).toBe(1);
    const notes = (await pool.query(`SELECT content FROM meal_chat_messages WHERE meal_record_id = $1::uuid ORDER BY created_at`, [mealId])).rows.map((row) => row.content);
    expect(notes.at(-1)).toBe('WBT wysłane do Trio z okna WBT: 15 g węglowodanów, 1,2 j insuliny.');

    // The database keeps a WBT command tied to its meal.
    await expect(repo.insert(command({ source: 'WBT_SCREEN', purpose: 'WBT', target_meal_record_id: null }))).rejects.toThrow(/remote_commands_purpose_check/);
  });

  it('lists a conversation\'s bolus cards with the command sent from each', async () => {
    const proposalsClass = (await import('./postgres-bolus-proposals.repository')).PostgresBolusProposalRepository;
    const proposals = new proposalsClass(pool);
    const repo = new RepositoryClass(pool);
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await pool.query(`INSERT INTO conversations (id, patient_id, thread_state_version) VALUES ($1::uuid, $2::uuid, 'v1')`, [conversationId, patientId]);
    await pool.query(
      `INSERT INTO messages (id, conversation_id, patient_id, role, message_type, content, provenance_ref, idempotency_key)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'USER', 'USER_MESSAGE', 'Ile podać na naleśniki?', 'test', 'key-bolus-1')`,
      [messageId, conversationId, patientId],
    );
    const card = await proposals.insert({
      patient_id: patientId, conversation_id: conversationId, user_message_id: messageId, purpose: 'MEAL', carbs_g: 46, insulin_u: 3.8,
      icr_g_per_u: 12, icr_insulin_u: 3.8, meal_payload: { description: 'Naleśniki', items: null, macros: null }, reason: 'Obiad', warnings: [],
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    expect((await proposals.listForConversation(patientId, conversationId))[0]).toMatchObject({ proposal: { id: card.id, carbs_g: 46, insulin_u: 3.8 }, command: null });

    const sent = await repo.insert(command({ source: 'CHAT_CARD', proposal_id: card.id, conversation_id: conversationId }));
    await repo.transition(patientId, sent.id, 'SENT', { sent_at: new Date().toISOString(), status_message: 'Polecenie wysłane, czekam na odpowiedź Trio.' });
    expect((await proposals.listForConversation(patientId, conversationId))[0].command).toMatchObject({ id: sent.id, status: 'SENT', user_id: userId });

    // Trio kept the carbs and refused the bolus; the bolus-only retry never left the phone: the card keeps showing the
    // refusal (its retry), not the failed send (which would offer the whole dose with the carbs again).
    await repo.transition(patientId, sent.id, 'PARTIAL', { status_message: 'Węglowodany zapisane w Trio, bolus odrzucony' });
    const retry = await repo.insert(command({ source: 'CHAT_CARD', proposal_id: card.id, conversation_id: conversationId, follows_command_id: sent.id, carbs_g: 0, insulin_u: 2, meal_payload: null }));
    await repo.transition(patientId, retry.id, 'SEND_FAILED', { status_message: 'Nie udało się wysłać polecenia.' });
    expect((await proposals.listForConversation(patientId, conversationId))[0].command).toMatchObject({ id: sent.id, status: 'PARTIAL' });

    // A retried answer discards its unsent cards only.
    await proposals.discardForUserMessage(patientId, messageId);
    expect(await proposals.listForConversation(patientId, conversationId)).toHaveLength(1);
  });

  it('joins a retried bolus to the meal whose carbs Trio kept: one action, no separate correction', async () => {
    const repo = new RepositoryClass(pool);
    const loopActions = new LoopActionsClass(pool);
    const meals = new MealRecordsClass(pool);
    const startsAt = new Date(Date.now() - 3_600_000).toISOString();
    await pool.query(
      `INSERT INTO meal_history_epochs (patient_id, starts_at, assignment_policy_version, decided_by)
       VALUES ($1::uuid, $2::timestamptz, 'new-meal-assignment.v1', 'test')`,
      [patientId, startsAt],
    );
    await pool.query(`INSERT INTO loop_action_epochs (patient_id, starts_at) VALUES ($1::uuid, $2::timestamptz)`, [patientId, startsAt]);
    const reconciler = new ReconcilerClass({
      commands: repo,
      loopActions,
      meals: {
        findMealIdentityById: (patient, mealRecordId) => meals.findMealIdentityById(patient, mealRecordId),
        editContent: (patient, identity, user, edit) => meals.editContent(patient, identity, user, edit),
      },
      log: () => undefined,
    });

    // Trio stored the carbs and refused the bolus.
    const first = await repo.insert(command({ carbs_g: 16, insulin_u: 2.4 }));
    await repo.transition(patientId, first.id, 'SENT', { sent_at: new Date().toISOString() });
    await repo.transition(patientId, first.id, 'PARTIAL', {});
    const carbsAt = Date.parse(first.authorized_at) + 10_000;
    await insertEvent('CARB_ENTRY', 16, new Date(carbsAt).toISOString());
    await loopActions.groupNewEvents(patientId);
    await reconciler.run(new Date(carbsAt + 60_000).toISOString());
    const mealAction = (await repo.get(patientId, first.id))!.loop_action_id!;
    const meal = (await repo.get(patientId, first.id))!.meal_record_id!;

    // The first retry is refused too (over the max bolus); the second, lower one is given.
    const refusedRetry = await repo.insert(command({ carbs_g: 0, insulin_u: 2.4, meal_payload: null, follows_command_id: first.id }));
    await repo.transition(patientId, refusedRetry.id, 'SENT', { sent_at: new Date().toISOString() });
    await repo.transition(patientId, refusedRetry.id, 'REJECTED', {});
    const retry = await repo.insert(command({ carbs_g: 0, insulin_u: 2, meal_payload: null, follows_command_id: refusedRetry.id }));
    await repo.transition(patientId, retry.id, 'SENT', { sent_at: new Date().toISOString() });
    await repo.transition(patientId, retry.id, 'SUCCEEDED', {});
    const bolusAt = Date.parse(retry.authorized_at) + 5_000;
    await insertEvent('BOLUS', 2, new Date(bolusAt).toISOString());
    await loopActions.groupNewEvents(patientId);
    await reconciler.run(new Date(bolusAt + 60_000).toISOString());

    expect(await repo.get(patientId, retry.id)).toMatchObject({ loop_action_id: mealAction, meal_record_id: meal });
    const actions = await loopActions.listActionsBetween(patientId, startsAt, new Date(Date.now() + 120_000).toISOString());
    expect(actions.map((action) => [action.purpose, action.carbs_g, action.bolus_units])).toEqual([['NEW_MEAL', 16, 2]]);
  });

  it('saves the meal when the carbs arrive after Trio confirmed the bolus, and joins the bolus when it syncs', async () => {
    const repo = new RepositoryClass(pool);
    const loopActions = new LoopActionsClass(pool);
    const meals = new MealRecordsClass(pool);
    const startsAt = new Date(Date.now() - 3_600_000).toISOString();
    await pool.query(
      `INSERT INTO meal_history_epochs (patient_id, starts_at, assignment_policy_version, decided_by)
       VALUES ($1::uuid, $2::timestamptz, 'new-meal-assignment.v1', 'test')`,
      [patientId, startsAt],
    );
    await pool.query(`INSERT INTO loop_action_epochs (patient_id, starts_at) VALUES ($1::uuid, $2::timestamptz)`, [patientId, startsAt]);
    const reconciler = new ReconcilerClass({
      commands: repo,
      loopActions,
      meals: {
        findMealIdentityById: (patient, mealRecordId) => meals.findMealIdentityById(patient, mealRecordId),
        editContent: (patient, identity, user, edit) => meals.editContent(patient, identity, user, edit),
      },
      log: () => undefined,
    });
    const sent = await repo.insert(command({ carbs_g: 15, insulin_u: 1.9 }));
    await repo.transition(patientId, sent.id, 'SENT', { sent_at: new Date().toISOString() });
    await repo.transition(patientId, sent.id, 'SUCCEEDED', {});
    const carbsAt = Date.parse(sent.authorized_at) + 1_000;
    await insertEvent('CARB_ENTRY', 15, new Date(carbsAt).toISOString());
    await loopActions.groupNewEvents(patientId);
    await reconciler.run(new Date(carbsAt + 10_000).toISOString());
    const saved = await repo.get(patientId, sent.id);
    expect(saved?.meal_record_id).not.toBeNull();

    // The bolus syncs a minute later and forms its own action: it joins the meal's.
    await insertEvent('BOLUS', 1.9, new Date(carbsAt + 28_000).toISOString());
    await loopActions.groupNewEvents(patientId);
    await reconciler.run(new Date(carbsAt + 70_000).toISOString());
    const actions = await loopActions.listActionsBetween(patientId, startsAt, new Date(Date.now() + 120_000).toISOString());
    expect(actions.map((action) => [action.id === saved!.loop_action_id, action.purpose, action.carbs_g, action.bolus_units])).toEqual([[true, 'NEW_MEAL', 15, 1.9]]);
  });

  it('leaves a Bolus tab command for the caregiver to assign and lists it under the meal they choose', async () => {
    const repo = new RepositoryClass(pool);
    const loopActions = new LoopActionsClass(pool);
    const meals = new MealRecordsClass(pool);
    const startsAt = new Date(Date.now() - 3_600_000).toISOString();
    await pool.query(
      `INSERT INTO meal_history_epochs (patient_id, starts_at, assignment_policy_version, decided_by)
       VALUES ($1::uuid, $2::timestamptz, 'new-meal-assignment.v1', 'test')`,
      [patientId, startsAt],
    );
    await pool.query(`INSERT INTO loop_action_epochs (patient_id, starts_at) VALUES ($1::uuid, $2::timestamptz)`, [patientId, startsAt]);
    const reconciler = new ReconcilerClass({
      commands: repo,
      loopActions,
      meals: {
        findMealIdentityById: (patient, mealRecordId) => meals.findMealIdentityById(patient, mealRecordId),
        editContent: (patient, identity, user, edit) => meals.editContent(patient, identity, user, edit),
      },
      log: () => undefined,
    });
    const sent = await repo.insert(command({ source: 'BOLUS_SCREEN', meal_payload: null, carbs_g: 20, insulin_u: 2 }));
    await repo.transition(patientId, sent.id, 'SENT', { sent_at: new Date().toISOString() });
    await repo.transition(patientId, sent.id, 'PARTIAL', { status_message: 'Węglowodany zapisane w Trio, bolus odrzucony' });
    const carbsAt = Date.parse(sent.authorized_at) + 5_000;
    await insertEvent('CARB_ENTRY', 20, new Date(carbsAt).toISOString());
    await loopActions.groupNewEvents(patientId);
    await reconciler.run(new Date(carbsAt + 60_000).toISOString());

    // Linked, but no meal and no purpose: the "na co to było?" push asks the caregiver.
    const linked = await repo.get(patientId, sent.id);
    expect(linked).toMatchObject({ meal_record_id: null });
    expect(linked?.loop_action_id).not.toBeNull();
    const [action] = await loopActions.listActionsBetween(patientId, startsAt, new Date(Date.now() + 120_000).toISOString());
    expect(action).toMatchObject({ id: linked!.loop_action_id, purpose: null });
    expect((await pool.query(`SELECT count(*)::int AS n FROM meal_records WHERE patient_id = $1::uuid`, [patientId])).rows[0].n).toBe(0);

    // The caregiver says it was a meal: the meal page shows the refused bolus.
    await loopActions.assign({ patientId, actionId: action.id, purpose: 'NEW_MEAL', mealRecordId: null, userId });
    const meal = (await loopActions.getAction(patientId, action.id))!.meal_record_id!;
    expect((await repo.listForMeal(patientId, meal)).map((row) => row.id)).toEqual([sent.id]);
  });

  it('lets a refused card be retried and lists the retries under the meal', async () => {
    const repo = new RepositoryClass(pool);
    const proposalId = randomUUID();
    const first = await repo.insert(command({ proposal_id: proposalId }));
    await repo.transition(patientId, first.id, 'SENT', { sent_at: new Date().toISOString() });
    await repo.transition(patientId, first.id, 'PARTIAL', { status_message: 'Węglowodany zapisane w Trio, bolus odrzucony' });
    const retry = await repo.insert(command({ proposal_id: proposalId, follows_command_id: first.id, carbs_g: 0, insulin_u: 2, meal_payload: null }));
    expect((await repo.listForProposal(patientId, proposalId)).map((row) => row.id)).toEqual([first.id, retry.id]);
    // While the retry is in flight the card cannot be sent a third time.
    await expect(repo.insert(command({ proposal_id: proposalId, carbs_g: 0, insulin_u: 2, meal_payload: null }))).rejects.toThrow(/COMMAND_IN_FLIGHT|PROPOSAL_ALREADY_SENT/);

    // The meal created from the first command's carbs lists the retry before it is linked itself.
    const startsAt = new Date(Date.now() - 3_600_000).toISOString();
    await pool.query(
      `INSERT INTO meal_history_epochs (patient_id, starts_at, assignment_policy_version, decided_by)
       VALUES ($1::uuid, $2::timestamptz, 'new-meal-assignment.v1', 'test') RETURNING id`,
      [patientId, startsAt],
    );
    await pool.query(`INSERT INTO loop_action_epochs (patient_id, starts_at) VALUES ($1::uuid, $2::timestamptz)`, [patientId, startsAt]);
    await insertEventWithId(randomUUID(), 'CARB_ENTRY', 46, new Date().toISOString());
    const loopActions = new LoopActionsClass(pool);
    await loopActions.groupNewEvents(patientId);
    const [action] = await loopActions.listActionsBetween(patientId, startsAt, new Date(Date.now() + 60_000).toISOString());
    await loopActions.assign({ patientId, actionId: action.id, purpose: 'NEW_MEAL', mealRecordId: null, userId });
    const meal = (await loopActions.getAction(patientId, action.id))!.meal_record_id!;
    await pool.query(`UPDATE remote_commands SET meal_record_id = $2::uuid WHERE id = $1::uuid`, [first.id, meal]);
    expect((await repo.listForMeal(patientId, meal)).map((row) => row.id)).toEqual([first.id, retry.id]);
  });

  it('plans the second part of a split card on its meal, gives it once and moves the WBT reminder', async () => {
    const repo = new RepositoryClass(pool);
    const loopActions = new LoopActionsClass(pool);
    const meals = new MealRecordsClass(pool);
    const plans = new (await import('./postgres-planned-boluses.repository')).PostgresPlannedBolusRepository(pool);
    const wbt = new (await import('./postgres-meal-wbt.repository')).PostgresMealWbtRepository(pool);
    const { PlannedBolusService } = await import('@modules/remote-commands/application/planned-bolus.service');
    const startsAt = new Date(Date.now() - 3_600_000).toISOString();
    await pool.query(
      `INSERT INTO meal_history_epochs (patient_id, starts_at, assignment_policy_version, decided_by)
       VALUES ($1::uuid, $2::timestamptz, 'new-meal-assignment.v1', 'test')`,
      [patientId, startsAt],
    );
    await pool.query(`INSERT INTO loop_action_epochs (patient_id, starts_at) VALUES ($1::uuid, $2::timestamptz)`, [patientId, startsAt]);
    const planned = new PlannedBolusService({ store: plans, commands: repo, postponeWbtReminder: (patient, meal, at) => wbt.postponeReminder(patient, meal, at) });
    const reconciler = new ReconcilerClass({
      commands: repo,
      loopActions,
      meals: {
        findMealIdentityById: (patient, mealRecordId) => meals.findMealIdentityById(patient, mealRecordId),
        editContent: (patient, identity, user, edit) => meals.editContent(patient, identity, user, edit),
      },
      plannedBoluses: {
        createForMeal: async (sent, mealRecordId, startedAt) => { await planned.createForMeal(sent, mealRecordId, startedAt); },
        markGivenByCommand: (sent, actionId) => planned.markGivenByCommand(sent, actionId),
      },
      log: () => undefined,
    });

    // The first part of a 60 g pizza: 36 g and 3.6 U now, 24 g after 60 min.
    const split = { policy_version: 'split-bolus.v1', now_percent: 60, later_after_minutes: 60, total_carbs_g: 60, total_insulin_u: 6, later_carbs_g: 24, later_insulin_u: 2.4 };
    const first = await repo.insert(command({ carbs_g: 36, insulin_u: 3.6, split_plan: split }));
    expect((await repo.get(patientId, first.id))?.split_plan).toEqual({ kind: 'SPLIT', ...split });
    await repo.transition(patientId, first.id, 'SUCCEEDED', { status_message: 'Bolus podany' });
    const mealAt = Date.parse(first.authorized_at) + 10_000;
    await insertEvent('CARB_ENTRY', 36, new Date(mealAt).toISOString());
    await insertEvent('BOLUS', 3.6, new Date(mealAt + 10_000).toISOString());
    await loopActions.groupNewEvents(patientId);
    await reconciler.run(new Date(mealAt + 60_000).toISOString());
    const mealId = (await repo.get(patientId, first.id))!.meal_record_id!;
    const plan = (await plans.latestForMeal(patientId, mealId))!;
    expect(plan).toMatchObject({ status: 'SCHEDULED', carbs_g: 24, planned_insulin_u: 2.4, first_command_id: first.id, delay_minutes: 60 });
    expect(Date.parse(plan.due_at) - mealAt).toBe(60 * 60_000);
    expect((await plans.listOpen()).map((row) => row.id)).toEqual([plan.id]);
    await wbt.setAutoReminder({ patientId, mealRecordId: mealId, enabled: true, remindAt: new Date(mealAt + 150 * 60_000).toISOString() });

    // The second part: tied to its plan and meal, once.
    const second = await repo.insert(command({ source: 'PLANNED_BOLUS', carbs_g: 24, insulin_u: 2.2, meal_payload: null, purpose: 'MEAL_PART', target_meal_record_id: mealId, planned_bolus_id: plan.id }));
    await expect(repo.insert(command({ source: 'PLANNED_BOLUS', carbs_g: 24, insulin_u: 2.2, meal_payload: null, purpose: 'MEAL_PART', target_meal_record_id: mealId, planned_bolus_id: plan.id }))).rejects.toThrow(/COMMAND_IN_FLIGHT|PLANNED_BOLUS_ALREADY_SENT/);
    expect((await repo.latestForPlannedBolus(patientId, plan.id))?.id).toBe(second.id);
    // "Pomiń" on the other phone while this command is on its way: the part is not skipped.
    expect(await plans.resolve(patientId, plan.id, 'SKIPPED', { user_id: userId })).toBeNull();
    await repo.transition(patientId, second.id, 'SUCCEEDED', { status_message: 'Bolus podany' });
    await expect(repo.insert(command({ source: 'PLANNED_BOLUS', carbs_g: 24, insulin_u: 2.2, meal_payload: null, purpose: 'MEAL_PART', target_meal_record_id: mealId, planned_bolus_id: plan.id }))).rejects.toThrow(/PLANNED_BOLUS_ALREADY_SENT/);
    const partAt = Date.parse(second.authorized_at) + 5_000;
    await insertEvent('CARB_ENTRY', 24, new Date(partAt).toISOString());
    await insertEvent('BOLUS', 2.2, new Date(partAt + 5_000).toISOString());
    await loopActions.groupNewEvents(patientId);
    await reconciler.run(new Date(partAt + 60_000).toISOString());

    const linked = (await repo.get(patientId, second.id))!;
    expect(linked.meal_record_id).toBe(mealId);
    expect(await loopActions.getAction(patientId, linked.loop_action_id!)).toMatchObject({ purpose: 'MEAL_ADDITION', meal_record_id: mealId, carbs_g: 24, bolus_units: 2.2 });
    expect(await plans.get(patientId, plan.id)).toMatchObject({ status: 'GIVEN', given_command_id: second.id, resolved_by_name: 'Ania', given_insulin_u: 2.2 });
    // One meal; its own retry chain does not show the planned part.
    expect((await pool.query(`SELECT count(*)::int AS n FROM meal_records WHERE patient_id = $1::uuid`, [patientId])).rows[0].n).toBe(1);
    expect((await repo.listForMeal(patientId, mealId)).map((row) => row.id)).toEqual([first.id]);
    // WBT an hour after the second part at the earliest; an AUTO update keeps it there.
    const reminder = await wbt.getReminder(patientId, mealId);
    const resolvedAt = Date.parse((await plans.get(patientId, plan.id))!.resolved_at!);
    // 2.5 h after the meal's start, which is its earliest entry: the part's entry here is a few seconds before the
    // first one (the commands were authorized at once), and the time follows the meal (migration 081).
    const mealStart = Math.min(mealAt, partAt);
    expect(Date.parse(reminder!.remind_at)).toBe(Math.max(mealStart + 150 * 60_000, resolvedAt + 60 * 60_000));
    await wbt.setAutoReminder({ patientId, mealRecordId: mealId, enabled: true, remindAt: new Date(mealAt + 150 * 60_000).toISOString() });
    expect((await wbt.getReminder(patientId, mealId))!.remind_at).toBe(reminder!.remind_at);
    // Nothing open any more; a second plan for the meal can be made later, never two open ones.
    expect(await plans.listOpen()).toEqual([]);
    await expect(repo.insert(command({ source: 'PLANNED_BOLUS', purpose: 'MEAL_PART', target_meal_record_id: mealId, planned_bolus_id: null }))).rejects.toThrow(/remote_commands_purpose_check/);
  });

  async function insertEventWithId(eventId: string, type: 'CARB_ENTRY' | 'BOLUS', value: number, occurredAt: string): Promise<void> {
    const sourceId = randomUUID();
    const sourceRecordId = randomUUID();
    const payload = type === 'CARB_ENTRY' ? { carbs: value } : { insulin_units: value };
    await pool.query(`INSERT INTO sources (id, patient_id, source_system, source_key, metadata) VALUES ($1::uuid,$2::uuid,'NIGHTSCOUT',$3,'{}'::jsonb)`, [sourceId, patientId, `source-${sourceId}`]);
    await pool.query(
      `INSERT INTO source_records (id, patient_id, source_id, source_system, source_record_id, natural_key, record_type, occurred_at, recorded_at, raw_payload, provenance, canonical_hash)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'NIGHTSCOUT',$4,$5,'TREATMENT',$6::timestamptz,$6::timestamptz,$7::jsonb,'{}'::jsonb,$8)`,
      [sourceRecordId, patientId, sourceId, `record-${sourceRecordId}`, `natural-${sourceRecordId}`, occurredAt, JSON.stringify(payload), `hash-${sourceRecordId}`],
    );
    await pool.query(
      `INSERT INTO events (id, patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload, event_ingestion_origin, created_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::timestamptz,$5::timestamptz,'{}'::jsonb,'{}'::jsonb,$6::jsonb,'LIVE',$5::timestamptz)`,
      [eventId, patientId, sourceRecordId, type, occurredAt, JSON.stringify(payload)],
    );
  }

  async function insertEvent(type: 'CARB_ENTRY' | 'BOLUS', value: number, occurredAt: string): Promise<void> {
    const sourceId = randomUUID();
    const sourceRecordId = randomUUID();
    const payload = type === 'CARB_ENTRY' ? { carbs: value } : { insulin_units: value };
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
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::timestamptz,$5::timestamptz,'{}'::jsonb,'{}'::jsonb,$6::jsonb,'LIVE',$5::timestamptz)`,
      [randomUUID(), patientId, sourceRecordId, type, occurredAt, JSON.stringify(payload)],
    );
  }
});
