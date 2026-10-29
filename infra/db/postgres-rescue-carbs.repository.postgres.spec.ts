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
import type { RescueEvaluation } from '@modules/rescue-carbs/application/rescue-detection';

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

const evaluation = (overrides: Partial<RescueEvaluation> = {}): RescueEvaluation => ({
  policy_version: 'rescue-carbs.v1',
  evaluated_at: new Date().toISOString(),
  status: 'TRIGGER',
  level: 'PREDICTED_LOW',
  trigger_source: 'TRIO_CARBS_REQ',
  suppressed_reason: null,
  no_data_reason: null,
  glucose: { at: new Date(Date.now() - 60_000).toISOString(), value: 88 },
  delta_per_5min: -6,
  slope_per_min: -1.2,
  loop_used: true,
  carbs_req_g: 5,
  predicted_min_mgdl: 62,
  predicted_low_at: new Date(Date.now() + 20 * 60_000).toISOString(),
  minutes_to_low: 20,
  curve: null,
  clear: false,
  ...overrides,
});

describePostgres('rescue carb alerts (postgres)', { timeout: 120_000 }, () => {
  let pool: Pool;
  let patientId: string;
  let userId: string;
  // Loaded lazily: offline runs must not import the gated modules (postgres-gated-spec-imports.spec.ts).
  let RepositoryClass: typeof import('./postgres-rescue-carbs.repository').PostgresRescueCarbsRepository;
  let LoopActionsClass: typeof import('./postgres-loop-actions.repository').PostgresLoopActionRepository;
  let GlucoMindClass: typeof import('./postgres-glucomind.repository').PostgresGlucoMindRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    await assertPoolUsesIsolatedTestDatabase(pool);
    await applyMigrations(pool);
    RepositoryClass = (await import('./postgres-rescue-carbs.repository')).PostgresRescueCarbsRepository;
    LoopActionsClass = (await import('./postgres-loop-actions.repository')).PostgresLoopActionRepository;
    GlucoMindClass = (await import('./postgres-glucomind.repository')).PostgresGlucoMindRepository;
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    patientId = randomUUID();
    userId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'rescue-test')`, [patientId]);
    await pool.query(`INSERT INTO users (id, display_name) VALUES ($1::uuid, 'Ewa')`, [userId]);
  });

  afterAll(async () => {
    if (pool) {
      await truncatePublicTablesForIntegrationTests(pool);
      await pool.end();
    }
  });

  async function nightscoutCarbs(occurredAt: string, carbs: number, kind: string | null = null): Promise<string> {
    const sourceId = randomUUID();
    const recordId = randomUUID();
    const eventId = randomUUID();
    await pool.query(`INSERT INTO sources (id, patient_id, source_system, source_key, metadata) VALUES ($1::uuid,$2::uuid,'NIGHTSCOUT',$3,'{}'::jsonb)`, [sourceId, patientId, `s-${sourceId}`]);
    await pool.query(
      `INSERT INTO source_records (id, patient_id, source_id, source_system, source_record_id, natural_key, record_type, occurred_at, recorded_at, raw_payload, provenance, canonical_hash)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'NIGHTSCOUT',$4,$4,'TREATMENT',$5::timestamptz,$5::timestamptz,'{}'::jsonb,'{}'::jsonb,$4)`,
      [recordId, patientId, sourceId, `r-${recordId}`, occurredAt],
    );
    await pool.query(
      `INSERT INTO events (id, patient_id, source_record_id, type, occurred_at, recorded_at, payload, event_ingestion_origin)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'CARB_ENTRY',$4::timestamptz,$4::timestamptz,$5::jsonb,'LIVE')`,
      [eventId, patientId, recordId, occurredAt, JSON.stringify({ carbs })],
    );
    if (kind) await pool.query(`INSERT INTO carb_entry_kinds (patient_id, event_id, kind) VALUES ($1::uuid,$2::uuid,$3)`, [patientId, eventId, kind]);
    return eventId;
  }

  it('sends pushes only to phones of caregivers who still care for the patient', async () => {
    const repo = new RepositoryClass(pool);
    const glucomind = new GlucoMindClass(pool);
    const removed = randomUUID();
    await pool.query(`INSERT INTO users (id, display_name) VALUES ($1::uuid, 'Była opiekunka')`, [removed]);
    await pool.query(`INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type) VALUES ($1::uuid, $2::uuid, 'PARENT'), ($3::uuid, $2::uuid, 'PARENT')`, [userId, patientId, removed]);
    await glucomind.upsertPatientDevice({ patientId, platform: 'ios', deviceId: 'ewa', pushToken: 'token-ewa', appVersion: null, userId });
    await glucomind.upsertPatientDevice({ patientId, platform: 'ios', deviceId: 'old', pushToken: 'token-old', appVersion: null, userId: removed });
    await glucomind.upsertPatientDevice({ patientId, platform: 'ios', deviceId: 'legacy', pushToken: 'token-legacy', appVersion: null });
    await pool.query(`UPDATE patient_devices SET rescue_carb_alerts_enabled = true WHERE patient_id = $1::uuid`, [patientId]);
    await pool.query(`DELETE FROM caregiver_relationships WHERE user_id = $1::uuid`, [removed]);
    // A phone without a user (before migration 070) gets nothing either (sharing audit #22).
    expect((await glucomind.listActivePatientDevices(patientId, 'ios')).map((device) => (device as { device_id: string }).device_id).sort()).toEqual(['ewa']);
    expect((await repo.listAlertDevices(patientId)).map((device) => device.device_id).sort()).toEqual(['ewa']);
  });

  it('keeps one active alert, names its conversation and logs the treatment once, outside the loop', async () => {
    const repo = new RepositoryClass(pool);
    const now = new Date().toISOString();
    const alert = (await repo.insertAlert({ patientId, status: 'PENDING', evaluation: evaluation(), now }))!;
    expect(alert.status).toBe('PENDING');
    expect(await repo.insertAlert({ patientId, status: 'PENDING', evaluation: evaluation(), now })).toBeNull();

    const notified = (await repo.markNotified(alert.id, { patientId, evaluation: evaluation(), proposal: { carbs_g: 5 } as never, now, reminder: false, conversationTitle: 'Dosłodzenie 12:00' }))!;
    expect(notified.status).toBe('NOTIFIED');
    const conversation = (await pool.query(`SELECT * FROM conversations WHERE id = $1::uuid`, [notified.conversation_id])).rows[0];
    expect(conversation).toMatchObject({ origin: 'SYSTEM', trigger_type: 'RESCUE_CARBS', title: 'Dosłodzenie 12:00', title_source: 'SYSTEM', episode_id: null });
    const reminded = (await repo.markNotified(alert.id, { patientId, evaluation: evaluation(), proposal: { carbs_g: 6 } as never, now, reminder: true, conversationTitle: 'x' }))!;
    expect(reminded.conversation_id).toBe(notified.conversation_id);
    expect(reminded.reminder_sent_at).not.toBeNull();
    expect((await repo.getAlertByConversation(patientId, notified.conversation_id!))?.id).toBe(alert.id);

    const card = await repo.insertProposal({ patientId, alertId: alert.id, conversationId: notified.conversation_id!, userMessageId: randomUUID(), carbsG: 8, reason: 'Spada szybko.' });
    const givenAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const logged = await repo.logTreatment({ patientId, alertId: alert.id, carbsG: 8, givenAt, userId, source: 'CHAT_CARD', proposalId: card.id });
    expect(logged.status).toBe('LOGGED');
    if (logged.status !== 'LOGGED') return;
    expect(logged.alert).toMatchObject({ status: 'TREATED', treatment_carbs_g: 8, treatment_source: 'CHAT_CARD', treatment_proposal_id: card.id });
    expect((await repo.listProposalsForConversation(patientId, notified.conversation_id!))[0].status).toBe('ACCEPTED');
    expect(await repo.logTreatment({ patientId, alertId: alert.id, carbsG: 5, givenAt, userId, source: 'ALERT', proposalId: null })).toEqual({ status: 'ALREADY_LOGGED', logged_by: 'Ewa' });

    // In the meals tab as a hypo treatment, with the GlucoMind source.
    const entries = await new GlucoMindClass(pool).listCarbEntriesBetween(patientId, new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() + 60_000).toISOString());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event_id: logged.event_id, kind: 'HYPO_TREATMENT', event_ingestion_origin: 'LIVE' });
    expect(entries[0].payload).toMatchObject({ carbs: 8, entry_source: 'GLUCOMIND', in_loop: false });
  });

  it('records "Nie podaję" once, blocks the reminder, and still lets carbs be logged afterwards', async () => {
    const repo = new RepositoryClass(pool);
    const now = new Date().toISOString();
    const alert = (await repo.insertAlert({ patientId, status: 'PENDING', evaluation: evaluation(), now }))!;
    await repo.markNotified(alert.id, { patientId, evaluation: evaluation(), proposal: { carbs_g: 5 } as never, now, reminder: false, conversationTitle: 'Dosłodzenie 12:00' });

    const declined = await repo.declineAlert({ patientId, alertId: alert.id, userId });
    expect(declined.status).toBe('DECLINED');
    if (declined.status !== 'DECLINED') return;
    expect(declined.alert).toMatchObject({ status: 'NOTIFIED', declined_by_user_id: userId });
    expect(declined.alert.declined_at).not.toBeNull();
    const again = await repo.declineAlert({ patientId, alertId: alert.id, userId: null });
    expect(again.status === 'DECLINED' && again.alert.declined_at).toBe(declined.alert.declined_at);
    expect((await repo.getActiveAlert(patientId))?.id).toBe(alert.id);

    expect(await repo.markNotified(alert.id, { patientId, evaluation: evaluation(), proposal: { carbs_g: 6 } as never, now, reminder: true, conversationTitle: 'x' })).toBeNull();

    const logged = await repo.logTreatment({ patientId, alertId: alert.id, carbsG: 4, givenAt: now, userId, source: 'ALERT', proposalId: null });
    expect(logged.status === 'LOGGED' && logged.alert.status).toBe('TREATED');
    expect(await repo.declineAlert({ patientId, alertId: alert.id, userId })).toEqual({ status: 'ALREADY_LOGGED', logged_by: 'Ewa' });
    expect(await repo.declineAlert({ patientId, alertId: randomUUID(), userId })).toEqual({ status: 'NOT_FOUND' });
  });

  it('logs a chat card\'s carbs without an alert, and lets an alert that pushed take them so no reminder follows', async () => {
    const repo = new RepositoryClass(pool);
    const glucoMind = new GlucoMindClass(pool);
    const range = () => [new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() + 60_000).toISOString()] as const;
    const conversationId = randomUUID();
    await pool.query(`INSERT INTO conversations (id, patient_id, thread_state_version) VALUES ($1::uuid, $2::uuid, 'v1')`, [conversationId, patientId]);
    // A card of an ordinary conversation (no alert's own card), confirmed with these grams.
    const logCard = async (args: { carbsG: number; givenAt: string }) => {
      const card = await repo.insertProposal({ patientId, alertId: null, conversationId, userMessageId: randomUUID(), carbsG: args.carbsG, reason: 'Sok.', optionKey: null });
      const accepted = await repo.acceptChatProposal({ patientId, conversationId, proposalId: card.id, carbsG: args.carbsG, givenAt: args.givenAt, userId });
      if (accepted.status !== 'LOGGED') throw new Error(`card not logged: ${accepted.status}`);
      return { event_id: accepted.proposal.treatment!.event_id, alert_id: accepted.alert_id };
    };

    // No alert: a hypo treatment of GlucoMind's own, outside the loop.
    const firstAt = new Date(Date.now() - 40 * 60_000).toISOString();
    const first = await logCard({ carbsG: 7.5, givenAt: firstAt });
    expect(first.alert_id).toBeNull();
    let entries = await glucoMind.listCarbEntriesBetween(patientId, ...range());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event_id: first.event_id, kind: 'HYPO_TREATMENT' });
    expect(entries[0].payload).toMatchObject({ carbs: 7.5, entry_source: 'GLUCOMIND', in_loop: false });
    expect(await repo.getLastEatenCarbsAt(patientId, new Date(Date.now() - 3_600_000).toISOString(), new Date().toISOString())).toBe(firstAt);

    // An alert that pushed: carbs given before it started are not its treatment, carbs given after it are.
    const now = new Date().toISOString();
    const alert = (await repo.insertAlert({ patientId, status: 'PENDING', evaluation: evaluation(), now }))!;
    await repo.markNotified(alert.id, { patientId, evaluation: evaluation(), proposal: { carbs_g: 5 } as never, now, reminder: false, conversationTitle: 'Dosłodzenie 12:00' });
    expect((await logCard({ carbsG: 3, givenAt: new Date(Date.now() - 30 * 60_000).toISOString() })).alert_id).toBeNull();
    const second = await logCard({ carbsG: 6, givenAt: now });
    expect(second.alert_id).toBe(alert.id);
    expect(await repo.getActiveAlert(patientId)).toMatchObject({ id: alert.id, status: 'TREATED', treatment_source: 'CHAT_CARD', treatment_carbs_g: 6, treated_by_user_id: userId });
    expect(await repo.markNotified(alert.id, { patientId, evaluation: evaluation(), proposal: { carbs_g: 6 } as never, now, reminder: true, conversationTitle: 'x' })).toBeNull();
    expect(await repo.logTreatment({ patientId, alertId: alert.id, carbsG: 5, givenAt: now, userId, source: 'ALERT', proposalId: null })).toEqual({ status: 'ALREADY_LOGGED', logged_by: 'Ewa' });

    // A treated alert takes no more: the next one is a plain entry.
    expect((await logCard({ carbsG: 4, givenAt: now })).alert_id).toBeNull();
    entries = await glucoMind.listCarbEntriesBetween(patientId, ...range());
    expect(entries.map((entry) => entry.kind)).toEqual(['HYPO_TREATMENT', 'HYPO_TREATMENT', 'HYPO_TREATMENT', 'HYPO_TREATMENT']);
  });

  it('confirms a card of an ordinary conversation once, logging it outside the loop', async () => {
    const repo = new RepositoryClass(pool);
    const conversationId = randomUUID();
    await pool.query(`INSERT INTO conversations (id, patient_id, thread_state_version) VALUES ($1::uuid, $2::uuid, 'v1')`, [conversationId, patientId]);
    const card = await repo.insertProposal({ patientId, alertId: null, conversationId, userMessageId: randomUUID(), carbsG: 10, reason: 'Sok przy 65.' });
    expect(card).toMatchObject({ alert_id: null, status: 'PROPOSED', treatment: null });

    const givenAt = new Date(Date.now() - 3 * 60_000).toISOString();
    expect(await repo.acceptChatProposal({ patientId, conversationId: randomUUID(), proposalId: card.id, carbsG: 8, givenAt, userId })).toEqual({ status: 'PROPOSAL_NOT_FOUND' });
    const accepted = await repo.acceptChatProposal({ patientId, conversationId, proposalId: card.id, carbsG: 8, givenAt, userId });
    expect(accepted.status).toBe('LOGGED');
    if (accepted.status !== 'LOGGED') return;
    expect(accepted.alert_id).toBeNull();
    expect(accepted.proposal).toMatchObject({ status: 'ACCEPTED', carbs_g: 10, treatment: { carbs_g: 8, given_at: givenAt, logged_by_user_id: userId } });
    expect(await repo.acceptChatProposal({ patientId, conversationId, proposalId: card.id, carbsG: 8, givenAt, userId })).toEqual({ status: 'ALREADY_LOGGED', logged_by: 'Ewa' });
    expect((await repo.listProposalsForConversation(patientId, conversationId))[0].treatment?.event_id).toBe(accepted.proposal.treatment?.event_id);

    const entries = await new GlucoMindClass(pool).listCarbEntriesBetween(patientId, new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() + 60_000).toISOString());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event_id: accepted.proposal.treatment?.event_id, kind: 'HYPO_TREATMENT' });
    expect(entries[0].payload).toMatchObject({ carbs: 8, entry_source: 'GLUCOMIND', in_loop: false });
  });

  it('marks an alert that pushed and took a card of an ordinary conversation as CHAT_CARD (the CHECK of 053 allows it)', async () => {
    const repo = new RepositoryClass(pool);
    const now = new Date().toISOString();
    const alert = (await repo.insertAlert({ patientId, status: 'PENDING', evaluation: evaluation(), now }))!;
    await repo.markNotified(alert.id, { patientId, evaluation: evaluation(), proposal: { carbs_g: 5 } as never, now, reminder: false, conversationTitle: 'Dosłodzenie 12:00' });
    const conversationId = randomUUID();
    await pool.query(`INSERT INTO conversations (id, patient_id, thread_state_version) VALUES ($1::uuid, $2::uuid, 'v1')`, [conversationId, patientId]);
    const card = await repo.insertProposal({ patientId, alertId: null, conversationId, userMessageId: randomUUID(), carbsG: 10, reason: 'Sok przy 65.' });
    const accepted = await repo.acceptChatProposal({ patientId, conversationId, proposalId: card.id, carbsG: 8, givenAt: now, userId });
    expect(accepted).toMatchObject({ status: 'LOGGED', alert_id: alert.id });
    expect(await repo.getActiveAlert(patientId)).toMatchObject({ id: alert.id, status: 'TREATED', treatment_source: 'CHAT_CARD', treatment_proposal_id: card.id });
  });

  it('never makes a loop action of the logged rescue carbs, and counts them as recent carbs', async () => {
    const repo = new RepositoryClass(pool);
    await pool.query(`INSERT INTO loop_action_epochs (patient_id, starts_at) VALUES ($1::uuid, now() - interval '1 day')`, [patientId]);
    const alert = (await repo.insertAlert({ patientId, status: 'PENDING', evaluation: evaluation(), now: new Date().toISOString() }))!;
    const givenAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await repo.logTreatment({ patientId, alertId: alert.id, carbsG: 6, givenAt, userId, source: 'ALERT', proposalId: null });
    await nightscoutCarbs(new Date(Date.now() - 30 * 60_000).toISOString(), 20, 'CORRECTION_CARBS');

    const loopActions = new LoopActionsClass(pool);
    await loopActions.groupNewEvents(patientId);
    expect((await pool.query(`SELECT count(*)::int AS n FROM loop_action_events WHERE patient_id = $1::uuid`, [patientId])).rows[0].n).toBe(1);
    expect((await pool.query(
      `SELECT count(*)::int AS n FROM loop_action_events lae JOIN events e ON e.id = lae.event_id WHERE e.payload->>'entry_source' = 'GLUCOMIND'`,
    )).rows[0].n).toBe(0);

    const from = new Date(Date.now() - 15 * 60_000).toISOString();
    const to = new Date().toISOString();
    expect(await repo.getLastEatenCarbsAt(patientId, from, to)).toBe(givenAt);
  });

  it('ignores correction carbs as recent carbs and keeps the phone switch per device', async () => {
    const repo = new RepositoryClass(pool);
    await nightscoutCarbs(new Date(Date.now() - 5 * 60_000).toISOString(), 15, 'CORRECTION_CARBS');
    expect(await repo.getLastEatenCarbsAt(patientId, new Date(Date.now() - 15 * 60_000).toISOString(), new Date().toISOString())).toBeNull();

    await pool.query(`INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type, is_owner) VALUES ($1::uuid, $2::uuid, 'PARENT', true)`, [userId, patientId]);
    await pool.query(`INSERT INTO patient_devices (patient_id, platform, device_id, push_token, user_id) VALUES ($1::uuid,'ios','phone-a','token-a',$2::uuid), ($1::uuid,'ios','phone-b','token-b',$2::uuid)`, [patientId, userId]);
    expect(await repo.getDeviceSettings(patientId, 'phone-a')).toEqual({ device_id: 'phone-a', rescue_carb_alerts_enabled: false, answer_ready_push_enabled: true });
    expect(await repo.listPatientsWithAlertDevices()).toEqual([]);
    expect(await repo.setDeviceSettings(patientId, 'phone-a', { rescue_carb_alerts_enabled: true })).toEqual({ device_id: 'phone-a', rescue_carb_alerts_enabled: true, answer_ready_push_enabled: true });
    expect(await repo.listPatientsWithAlertDevices()).toEqual([patientId]);
    expect(await repo.listAlertDevices(patientId)).toEqual([{ device_id: 'phone-a', push_token: 'token-a' }]);
    // "Gotowa odpowiedź": only the switch sent changes.
    expect(await repo.setDeviceSettings(patientId, 'phone-a', { answer_ready_push_enabled: false })).toEqual({ device_id: 'phone-a', rescue_carb_alerts_enabled: true, answer_ready_push_enabled: false });
    expect(await repo.getDeviceSettings(patientId, 'phone-b')).toEqual({ device_id: 'phone-b', rescue_carb_alerts_enabled: false, answer_ready_push_enabled: true });
    expect(await repo.setDeviceSettings(patientId, 'unknown', { rescue_carb_alerts_enabled: true })).toBeNull();
  });

  it('tells rescue carbs from a meal among the recent carbs (owner decision 2026-10-26)', async () => {
    const repo = new RepositoryClass(pool);
    const range = () => [new Date(Date.now() - 15 * 60_000).toISOString(), new Date().toISOString()] as const;
    expect(await repo.getRecentEatenCarbs(patientId, ...range())).toEqual({ last_carbs_at: null, last_hypo_treatment_at: null });
    const mealAt = new Date(Date.now() - 4 * 60_000).toISOString();
    await nightscoutCarbs(mealAt, 30);
    await nightscoutCarbs(new Date(Date.now() - 2 * 60_000).toISOString(), 15, 'CORRECTION_CARBS');
    expect(await repo.getRecentEatenCarbs(patientId, ...range())).toEqual({ last_carbs_at: mealAt, last_hypo_treatment_at: null });

    // Tagged in the meals tab, and a Trio entry that is an alert's treatment (rescue carbs sent to Trio): rescue carbs.
    const taggedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await nightscoutCarbs(taggedAt, 10, 'HYPO_TREATMENT');
    expect(await repo.getRecentEatenCarbs(patientId, ...range())).toEqual({ last_carbs_at: mealAt, last_hypo_treatment_at: taggedAt });
    const trioAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const trioEntry = await nightscoutCarbs(trioAt, 8);
    const alert = (await repo.insertAlert({ patientId, status: 'PENDING', evaluation: evaluation(), now: new Date().toISOString() }))!;
    await pool.query(`UPDATE rescue_carb_alerts SET treatment_event_id = $2::uuid WHERE id = $1::uuid`, [alert.id, trioEntry]);
    expect(await repo.getRecentEatenCarbs(patientId, ...range())).toEqual({ last_carbs_at: mealAt, last_hypo_treatment_at: trioAt });
    expect(await repo.getLastEatenCarbsAt(patientId, ...range())).toBe(mealAt);
  });

  it('counts carbs nobody gave a kind as rescue carbs when they were eaten during a low (audit 2026-10-26)', async () => {
    const repo = new RepositoryClass(pool);
    const range = () => [new Date(Date.now() - 15 * 60_000).toISOString(), new Date().toISOString()] as const;
    const reading = async (at: string, value: number) => {
      const recordId = (await pool.query(`SELECT source_record_id FROM events WHERE id = $1::uuid`, [await nightscoutCarbs(at, 1, 'CORRECTION_CARBS')])).rows[0].source_record_id;
      await pool.query(
        `INSERT INTO events (id, patient_id, source_record_id, type, occurred_at, recorded_at, payload, event_ingestion_origin)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'GLUCOSE_READING_AVAILABLE',$4::timestamptz,$4::timestamptz,$5::jsonb,'LIVE')`,
        [randomUUID(), patientId, recordId, at, JSON.stringify({ glucose_value: value })],
      );
    };
    // A meal at 110 stays a meal.
    await reading(new Date(Date.now() - 12 * 60_000).toISOString(), 110);
    const mealAt = new Date(Date.now() - 11 * 60_000).toISOString();
    await nightscoutCarbs(mealAt, 30);
    expect(await repo.getRecentEatenCarbs(patientId, ...range())).toEqual({ last_carbs_at: mealAt, last_hypo_treatment_at: null });
    // 10 g typed into Trio at 62: a rescue, so a low alert does not ask for a second one.
    await reading(new Date(Date.now() - 4 * 60_000).toISOString(), 62);
    const trioAt = new Date(Date.now() - 3 * 60_000).toISOString();
    await nightscoutCarbs(trioAt, 10);
    expect(await repo.getRecentEatenCarbs(patientId, ...range())).toEqual({ last_carbs_at: trioAt, last_hypo_treatment_at: trioAt });
  });

  it('pushes first only from PENDING, reminds once, and records delivery and resends of an undelivered push', async () => {
    const repo = new RepositoryClass(pool);
    const t0 = new Date(Date.now() - 10 * 60_000);
    const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000).toISOString();
    const alert = (await repo.insertAlert({ patientId, status: 'PENDING', evaluation: evaluation(), now: at(0) }))!;
    expect(alert).toMatchObject({ alert_push_attempts: 0, alert_delivered_at: null, reminder_push_attempts: 0 });
    const notify = (reminder: boolean, now: string) => repo.markNotified(alert.id, { patientId, evaluation: evaluation(), proposal: { carbs_g: 5 } as never, now, reminder, conversationTitle: 'Dosłodzenie 12:00' });

    const notified = (await notify(false, at(0)))!;
    expect(notified).toMatchObject({ status: 'NOTIFIED', alert_push_attempts: 1, alert_last_push_attempt_at: at(0), alert_delivered_at: null });
    // A second worker's first push of the same alert is refused.
    expect(await notify(false, at(1))).toBeNull();

    // Undelivered: a resend is claimed once per 45 s, by one worker.
    expect(await repo.claimPushResend(alert.id, { reminder: false, now: at(30) })).toBeNull();
    const resent = (await repo.claimPushResend(alert.id, { reminder: false, now: at(60) }))!;
    expect(resent).toMatchObject({ alert_push_attempts: 2, alert_last_push_attempt_at: at(60), conversation_id: notified.conversation_id });
    expect(await repo.claimPushResend(alert.id, { reminder: false, now: at(61) })).toBeNull();
    await repo.markPushDelivered(alert.id, { reminder: false, now: at(62) });
    await repo.markPushDelivered(alert.id, { reminder: false, now: at(70) });
    expect((await repo.getAlert(patientId, alert.id))!.alert_delivered_at).toBe(at(62));
    expect(await repo.claimPushResend(alert.id, { reminder: false, now: at(200) })).toBeNull();

    // The one reminder: its own attempts and delivery; a second reminder is refused.
    const reminded = (await notify(true, at(300)))!;
    expect(reminded).toMatchObject({ reminder_sent_at: at(300), reminder_push_attempts: 1, reminder_delivered_at: null, alert_push_attempts: 2, alert_delivered_at: at(62) });
    expect(await notify(true, at(301))).toBeNull();
    expect((await repo.claimPushResend(alert.id, { reminder: true, now: at(360) }))?.reminder_push_attempts).toBe(2);

    // "Nie podaję" stops resends.
    await repo.declineAlert({ patientId, alertId: alert.id, userId });
    expect(await repo.claimPushResend(alert.id, { reminder: true, now: at(420) })).toBeNull();
  });

  it('claims no resend for a treated or closed alert', async () => {
    const repo = new RepositoryClass(pool);
    const now = new Date(Date.now() - 5 * 60_000).toISOString();
    const later = new Date().toISOString();
    const alert = (await repo.insertAlert({ patientId, status: 'PENDING', evaluation: evaluation(), now }))!;
    await repo.markNotified(alert.id, { patientId, evaluation: evaluation(), proposal: { carbs_g: 5 } as never, now, reminder: false, conversationTitle: 'Dosłodzenie' });
    await repo.logTreatment({ patientId, alertId: alert.id, carbsG: 5, givenAt: now, userId, source: 'ALERT', proposalId: null });
    expect(await repo.claimPushResend(alert.id, { reminder: false, now: later })).toBeNull();

    await repo.closeAlert(alert.id, { status: 'RESOLVED', outcome: null, now: later });
    const second = (await repo.insertAlert({ patientId, status: 'PENDING', evaluation: evaluation(), now }))!;
    await repo.markNotified(second.id, { patientId, evaluation: evaluation(), proposal: { carbs_g: 5 } as never, now, reminder: false, conversationTitle: 'Dosłodzenie' });
    await repo.closeAlert(second.id, { status: 'EXPIRED', outcome: null, now: later });
    expect(await repo.claimPushResend(second.id, { reminder: false, now: later })).toBeNull();
  });

  it('labels pushes with the patient\'s name only for a phone registered for several patients', async () => {
    const { PostgresPatientPushLabeler } = await import('./postgres-patient-push-label.repository');
    const labeler = new PostgresPatientPushLabeler(pool);
    const second = randomUUID();
    await pool.query(`UPDATE patients SET display_name = 'Janek' WHERE id = $1::uuid`, [patientId]);
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'Zosia')`, [second]);
    await pool.query(`INSERT INTO patient_devices (patient_id, platform, device_id, push_token) VALUES ($1::uuid,'ios','phone-a','token-a')`, [patientId]);
    expect(await labeler.labelFor('token-a', patientId)).toBeNull();

    await pool.query(`INSERT INTO patient_devices (patient_id, platform, device_id, push_token) VALUES ($1::uuid,'ios','phone-a','token-a')`, [second]);
    expect(await labeler.labelFor('token-a', patientId)).toBe('Janek');
    expect(await labeler.labelFor('token-a', second)).toBe('Zosia');

    await pool.query(`UPDATE patient_devices SET active = false WHERE patient_id = $1::uuid`, [second]);
    expect(await labeler.labelFor('token-a', patientId)).toBeNull();
  });

  it('closes an alert so the next one can start, and drops a failed answer\'s cards', async () => {
    const repo = new RepositoryClass(pool);
    const now = new Date().toISOString();
    const first = (await repo.insertAlert({ patientId, status: 'PENDING', evaluation: evaluation(), now }))!;
    await repo.touchAlert(first.id, { evaluation: evaluation({ clear: true }), now, clearSince: now });
    expect((await repo.getActiveAlert(patientId))?.clear_since).toBe(now);
    await repo.closeAlert(first.id, { status: 'RESOLVED', outcome: { false_alarm: true }, now });
    expect(await repo.getActiveAlert(patientId)).toBeNull();
    expect((await repo.getAlert(patientId, first.id))?.outcome).toEqual({ false_alarm: true });

    const second = (await repo.insertAlert({ patientId, status: 'PENDING', evaluation: evaluation(), now }))!;
    const notified = (await repo.markNotified(second.id, { patientId, evaluation: evaluation(), proposal: { carbs_g: 5 } as never, now, reminder: false, conversationTitle: 'Dosłodzenie' }))!;
    const messageId = randomUUID();
    await repo.insertProposal({ patientId, alertId: second.id, conversationId: notified.conversation_id!, userMessageId: messageId, carbsG: 6, reason: null });
    await repo.discardProposalsForUserMessage(patientId, messageId);
    expect(await repo.listProposalsForConversation(patientId, notified.conversation_id!)).toEqual([]);
  });
});
