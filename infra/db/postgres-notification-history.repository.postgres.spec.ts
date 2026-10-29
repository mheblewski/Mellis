import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresNotificationHistoryRepository } from './postgres-notification-history.repository';
import { PostgresGlucoMindRepository } from './postgres-glucomind.repository';
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

describePostgres('notification history for the bell (PostgreSQL)', () => {
  let pool: Pool;
  let repository: PostgresNotificationHistoryRepository;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required for notification history postgres tests');
    }
    // One connection: the rows below skip foreign keys for this session only.
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await applyMigrations(pool);
    repository = new PostgresNotificationHistoryRepository(pool);
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
  });

  afterAll(async () => {
    await pool?.query(`SET session_replication_role = DEFAULT`).catch(() => undefined);
    await truncatePublicTablesForIntegrationTests(pool);
    await pool?.end();
  });

  it('keeps one row per dedupe key, lists newest first and hides notifications of a deleted conversation', async () => {
    const patientId = randomUUID();
    const otherPatientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'p'), ($2::uuid, 'o')`, [patientId, otherPatientId]);
    const conversations = new PostgresGlucoMindRepository(pool);
    const create = async () => String((await conversations.createConversation({
      patientId, origin: 'USER', conversationType: 'USER_INITIATED', threadStateVersion: 'conv-v1', awaitingUserAnswer: false,
    })).conversation.id);
    const kept = await create();
    const deleted = await create();
    await pool.query(`UPDATE conversations SET deleted_at = now() WHERE id = $1::uuid`, [deleted]);
    const mealId = randomUUID();

    const question = (conversationId: string) => ({
      dedupeKey: `conversation-question:${patientId}:${conversationId}:q1`,
      patientId,
      type: 'conversation_question' as const,
      title: 'Hipo',
      body: 'Opisz',
      payload: { type: 'conversation_question' as const, patientId, conversationId, questionId: 'q1', routePath: '/x', universalLink: 'https://app.mellis.invalid/x' },
    });
    await repository.record(question(kept));
    await repository.record({ ...question(kept), title: 'second device' });
    await repository.record(question(deleted));
    await repository.record({
      dedupeKey: `wbt-reminder:${mealId}`,
      patientId,
      type: 'wbt_reminder',
      title: 'Przypomnienie o WBT',
      body: 'Pizza',
      payload: { type: 'wbt_reminder', patientId, mealId, routePath: '/y', universalLink: 'https://app.mellis.invalid/y' },
    });
    await pool.query(`UPDATE notification_history SET sent_at = now() - interval '1 hour' WHERE notification_type = 'conversation_question'`);

    const items = await repository.listRecent(patientId, 50);
    expect(items.map((item) => [item.type, item.title])).toEqual([
      ['wbt_reminder', 'Przypomnienie o WBT'],
      ['conversation_question', 'Hipo'],
    ]);
    expect(items[1].payload).toMatchObject({ conversationId: kept, questionId: 'q1' });
    expect(await repository.listRecent(otherPatientId, 50)).toEqual([]);
    expect(await repository.listRecent(patientId, 1)).toHaveLength(1);
  });

  it('leaves out notifications whose request was done, skipped or lapsed, and keeps the ones still waiting', async () => {
    const patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'p')`, [patientId]);
    const conversations = new PostgresGlucoMindRepository(pool);
    // The rows the notifications point at, without their sources (events, epochs, commands): foreign keys are off.
    await pool.query(`SET session_replication_role = replica`);
    const conversation = async () => {
      const created = (await conversations.createConversation({
        patientId, origin: 'USER', conversationType: 'USER_INITIATED', threadStateVersion: 'conv-v1', awaitingUserAnswer: false,
      })).conversation;
      // A hypo's conversation (its episode is not needed here).
      const episodeId = randomUUID();
      await pool.query(`UPDATE conversations SET episode_id = $2::uuid WHERE id = $1::uuid`, [created.id, episodeId]);
      return { id: String(created.id), episodeId };
    };
    const meal = async (status: string) => {
      const id = randomUUID();
      const epochId = randomUUID();
      const anchorId = randomUUID();
      await pool.query(
        `INSERT INTO meal_records (id, patient_id, meal_identity, epoch_id, assignment_policy_version, anchor_event_id, status)
         VALUES ($1::uuid, $2::uuid, 'meal:v1:' || $3 || ':' || $4, $3::uuid, 'v1', $4::uuid, $5)`,
        [id, patientId, epochId, anchorId, status],
      );
      return id;
    };
    const loopAction = async (purpose: string | null, mealId: string | null) => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO loop_actions (id, patient_id, started_at, purpose, meal_record_id, assigned_at)
         VALUES ($1::uuid, $2::uuid, now(), $3, $4::uuid, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)`,
        [id, patientId, purpose, mealId],
      );
      return id;
    };
    const plannedBolus = async (status: string) => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO planned_boluses (id, patient_id, meal_record_id, first_carbs_g, first_insulin_u, carbs_g, planned_insulin_u, now_percent, delay_minutes, due_at, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 30, 2, 20, 1.5, 60, 60, now(), $4)`,
        [id, patientId, randomUUID(), status],
      );
      return id;
    };
    const rescueAlert = async (status: string) => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO rescue_carb_alerts (id, patient_id, status, level, trigger_source, first_flag_at, last_evaluated_at, evaluation, declined_at)
         VALUES ($1::uuid, $2::uuid, $3, 'PREDICTED_LOW', 'CGM_TREND', now(), now(), '{}'::jsonb, NULL)`,
        [id, patientId, status],
      );
      return id;
    };
    const wbtReminder = async (mealId: string, enabled: boolean) => {
      await pool.query(
        `INSERT INTO meal_wbt_reminders (patient_id, meal_record_id, enabled, source, remind_at, status) VALUES ($1::uuid, $2::uuid, $3, 'AUTO', now(), 'SENT')`,
        [patientId, mealId, enabled],
      );
    };

    const wbtWaiting = await meal('DESCRIBED');
    await wbtReminder(wbtWaiting, true);
    await loopAction('MEAL_ADDITION', wbtWaiting);
    const wbtGiven = await meal('DESCRIBED');
    await wbtReminder(wbtGiven, true);
    await loopAction('WBT', wbtGiven);
    const wbtTurnedOff = await meal('DESCRIBED');
    await wbtReminder(wbtTurnedOff, false);
    const duePart = await plannedBolus('NOTIFIED');
    const givenPart = await plannedBolus('GIVEN');
    const openAlert = await rescueAlert('NOTIFIED');
    // One open alert per patient: the treated one is settled already.
    const treatedAlert = await rescueAlert('RESOLVED');
    const hypoOpen = await conversation();
    const questionOpen = await conversation();
    const questionAnswered = await conversation();
    for (const [conversationId, status] of [[questionOpen.id, 'OPEN'], [questionAnswered.id, 'ANSWERED']]) {
      await pool.query(
        `INSERT INTO context_questions (conversation_id, patient_id, question_id, reason, expected_information_gain, status) VALUES ($1::uuid, $2::uuid, 'q1', 'r', 'g', $3)`,
        [conversationId, patientId, status],
      );
    }
    const answerReady = await conversation();

    const notify = async (title: string, payload: Record<string, unknown>) => {
      await repository.record({
        dedupeKey: `${title}:${randomUUID()}`,
        patientId,
        type: payload.type as never,
        title,
        body: '',
        payload: { patientId, routePath: '/x', universalLink: 'https://app.mellis.invalid/x', ...payload } as never,
      });
    };
    await notify('wbt waiting', { type: 'wbt_reminder', mealId: wbtWaiting });
    await notify('wbt given', { type: 'wbt_reminder', mealId: wbtGiven });
    await notify('wbt turned off', { type: 'wbt_reminder', mealId: wbtTurnedOff });
    await notify('part due', { type: 'planned_bolus', mealId: randomUUID(), plannedBolusId: duePart });
    await notify('part given', { type: 'planned_bolus', mealId: randomUUID(), plannedBolusId: givenPart });
    await notify('alert open', { type: 'rescue_carbs', conversationId: hypoOpen.id, alertId: openAlert });
    await notify('alert treated', { type: 'rescue_carbs', conversationId: hypoOpen.id, alertId: treatedAlert });
    await notify('question open', { type: 'conversation_question', conversationId: questionOpen.id, questionId: 'q1' });
    await notify('question answered', { type: 'conversation_question', conversationId: questionAnswered.id, questionId: 'q1' });
    await notify('answer ready', { type: 'conversation_answer', conversationId: answerReady.id });
    await pool.query(`SET session_replication_role = DEFAULT`);

    const titles = (await repository.listRecent(patientId, 50)).map((item) => item.title).sort();
    expect(titles).toEqual(['alert open', 'answer ready', 'part due', 'question open', 'wbt waiting']);

    // "Nie podaję": the alert stays open, but asks for nothing more.
    await pool.query(`UPDATE rescue_carb_alerts SET declined_at = now() WHERE id = $1::uuid`, [openAlert]);
    expect((await repository.listRecent(patientId, 50)).map((item) => item.title)).not.toContain('alert open');
  });
});
