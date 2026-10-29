import 'dotenv/config';
import { persistLiveHypoUntilRecovered, seedLegacyHypoConversation } from '@infra/testing/hypo-episode-recovery';
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { DatabaseModule } from '@infra/db/database.module';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { PostgresNightscoutRepository } from '@infra/db/postgres-nightscout.repository';
import { NightscoutSyncService } from '@modules/integrations/nightscout/application/nightscout-sync.service';
import { WorkerService } from '../../../apps/worker/src/worker.service';
import { AiGatewayService } from '@modules/ai-gateway/application/ai-gateway.service';
import { PushNotificationService } from '@modules/notifications/application/push-notification.service';
import { PushNotificationProvider } from '@modules/notifications/infrastructure/push-notification-provider';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';
import type { PushNotificationEnvelope } from '@modules/notifications/domain/push-notification';
import { detectHypo } from '@modules/triggering/application/hypo-detector';
import { truncatePublicTablesForIntegrationTests } from '@infra/db/postgres-test-isolation';
import type { AiExecutionResult, AiGateway, AiTask } from '@modules/ai-gateway/domain/ai-gateway';
import type { ContextPackageRecord } from '@modules/context/domain/context-package';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
})
class AnalysisFollowUpModule {}

class EmptyNightscoutClient {
  async fetchEntries(): Promise<{ entries: Record<string, unknown>[]; next_cursor: string | null }> {
    return { entries: [], next_cursor: null };
  }
}

class StaticAiProvider implements AiProvider {
  constructor(private readonly output: Record<string, unknown>) {}

  async generate(): Promise<AiProviderResponse> {
    return {
      provider: 'test-fixture',
      model: 'deterministic-recommendation-v1',
      received_at: new Date().toISOString(),
      raw_output: this.output,
    };
  }
}

class StaticAiGateway implements AiGateway {
  lastInput: { task: AiTask; context_package: ContextPackageRecord; timeout_ms?: number } | null = null;

  constructor(private readonly output: Record<string, unknown>) {}

  async execute(input: { task: AiTask; context_package: ContextPackageRecord; timeout_ms?: number }): Promise<AiExecutionResult> {
    this.lastInput = input;
    const delegate = new AiGatewayService(new StaticAiProvider(this.output));
    return delegate.execute(input);
  }
}

class RecordingPushNotificationProvider implements PushNotificationProvider {
  readonly sent: Array<{ patientId: string; pushToken: string; conversationId: string; questionId: string }> = [];
  private readonly failures: Array<Error | PushNotificationProviderError> = [];

  constructor(private readonly nextFailure?: Error | PushNotificationProviderError) {}

  pushFailure(error: Error | PushNotificationProviderError): void {
    this.failures.push(error);
  }

  async send(notification: PushNotificationEnvelope): Promise<void> {
    const nextFailure = this.failures.shift();
    if (nextFailure) {
      throw nextFailure;
    }

    const payload = notification.payload;
    if (payload.type !== 'conversation_question') {
      throw new Error(`Unexpected push type in analysis follow-up flow: ${payload.type}`);
    }

    this.sent.push({
      patientId: payload.patientId,
      pushToken: notification.pushToken,
      conversationId: payload.conversationId,
      questionId: payload.questionId,
    });
  }
}

async function resetSharedPostgresState(pool: Pool): Promise<void> {
  await truncatePublicTablesForIntegrationTests(pool);
}

async function ensurePatient(pool: Pool, patientId: string): Promise<void> {
  await pool.query(
    `INSERT INTO patients (id, display_name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING`,
    [patientId, `patient-${patientId.slice(0, 8)}`],
  );
}

/** An open clarifying question of the conversation (the investigation writes it in production). */
async function upsertContextQuestion(pool: Pool, args: {
  conversationId: string;
  patientId: string;
  questionId: string;
  questionType: string;
  questionText: string;
  reason: string;
  expectedInformationGain: string;
  expectedAnswerTypes: Array<'YES' | 'NO' | 'UNKNOWN' | 'TEXT'>;
  relatedEventId: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO context_questions (
       conversation_id, patient_id, question_id, question_type, question_text, reason, expected_information_gain, expected_answer_types, related_event_id, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'OPEN')
     ON CONFLICT (conversation_id, question_id) DO UPDATE SET status = 'OPEN', updated_at = now()`,
    [args.conversationId, args.patientId, args.questionId, args.questionType, args.questionText, args.reason, args.expectedInformationGain, JSON.stringify(args.expectedAnswerTypes), args.relatedEventId],
  );
}

/** A queued push row for the question, as the question push job finds it. */
async function upsertPushNotification(pool: Pool, args: {
  dedupeKey: string;
  patientId: string;
  conversationId: string;
  questionId: string;
  notificationType: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO push_notifications (dedupe_key, patient_id, conversation_id, question_id, notification_type, payload, status)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,'queued')
     ON CONFLICT (dedupe_key) DO UPDATE SET updated_at = now()`,
    [args.dedupeKey, args.patientId, args.conversationId, args.questionId, args.notificationType, JSON.stringify(args.payload)],
  );
}

async function createOpenConversationForAnalysis(args: {
  patientId: string;
  repository: PostgresGlucoMindRepository;
  nightscoutRepository: PostgresNightscoutRepository;
  nightscoutSync: NightscoutSyncService;
  pool: Pool;
}): Promise<{ conversationId: string; triggerId: string; episodeId: string; sourceEventId: string }> {
  const sourceResult = await args.pool.query<{
    id: string;
    patient_id: string;
    source_system: string;
    source_key: string;
    sync_cursor: string | null;
    last_successful_observed_at: string | null;
    source_version: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT * FROM sources WHERE patient_id = $1::uuid AND source_system = 'NIGHTSCOUT' ORDER BY created_at DESC LIMIT 1`,
    [args.patientId],
  );

  const source = sourceResult.rows[0];
  if (!source) {
    throw new Error('NIGHTSCOUT_SOURCE_NOT_FOUND');
  }

  const now = new Date().toISOString();
  const sourceRecordIdentity = `analysis-follow-up-${Date.now()}`;
  const normalizedReading = {
    source_system: 'NIGHTSCOUT',
    source_record_id: sourceRecordIdentity,
    natural_key: `nightscout:${args.patientId}:${sourceRecordIdentity}`,
    record_type: 'cgm.entry',
    observed_at: now,
    recorded_at: now,
    imported_at: now,
    source_unit: 'mg/dL',
    glucose_value: 62,
    glucose_unit: 'mg/dL' as const,
    normalization_version: 'nightscout.entries.v1',
    raw_payload: {
      _id: sourceRecordIdentity,
      dateString: now,
      date: Date.parse(now),
      patient: args.patientId,
      sgv: 62,
      units: 'mg/dL',
    },
    provenance: {},
    canonical_hash: `canonical-${sourceRecordIdentity}`,
  };

  const persistedReading = await args.nightscoutRepository.persistImportedGlucoseReading({
    source,
    reading: normalizedReading as any,
    jobDedupeKey: `triggering.hypo_detection:${normalizedReading.natural_key}`,
    correlationId: source.id,
    causationId: source.id,
    jobPayload: {
      patient_id: args.patientId,
      source_id: source.id,
      source_record_id: sourceRecordIdentity,
      natural_key: normalizedReading.natural_key,
      event_type: 'GLUCOSE_READING_AVAILABLE',
    },
  });

  await args.pool.query(
    `DELETE FROM jobs WHERE job_type = 'triggering.hypo_detection' AND dedupe_key = $1`,
    [`triggering.hypo_detection:${normalizedReading.natural_key}`],
  );

  const imported = await args.nightscoutSync.getImportedReadingForEvent(String(persistedReading.event_id));
  if (!imported) {
    throw new Error('IMPORTED_READING_NOT_FOUND');
  }

  const reading = {
    reading_id: String(imported.event_id),
    source_record_id: String(imported.source_identity ?? imported.source_record_id),
    observed_at: new Date(String(imported.occurred_at)).toISOString(),
    recorded_at: new Date(String(imported.recorded_at)).toISOString(),
    glucose_value: Number((imported.payload as Record<string, unknown>).glucose_value),
    glucose_unit: 'mg/dL' as const,
    classification: 'UNKNOWN' as const,
    relation_to_episode: 'LATEST' as const,
    validity: 'VALID' as const,
    provenance_ref: `source-record/${String(imported.source_record_id)}`,
  };

  const detection = detectHypo({
    patient_id: args.patientId,
    rule_version: 'hypo.cgm.ada2026.v1',
    existing_episode: null,
    reading,
  });

  await persistLiveHypoUntilRecovered(args.nightscoutRepository, {
    patientId: args.patientId,
    reading,
    detection,
    existingEpisode: null,
  });

  // Hypo detection starts no conversation since 2026-10-25: the questions and pushes run on an older one.
  await seedLegacyHypoConversation(args.pool, { patientId: args.patientId, sourceEventId: String(imported.event_id) });

  const row = await args.pool.query<{
    trigger_id: string;
    episode_id: string;
    conversation_id: string;
  }>(
    `
      SELECT t.id::text AS trigger_id,
             e.id::text AS episode_id,
             c.id::text AS conversation_id
      FROM triggers t
      JOIN hypo_episodes e ON e.id = t.episode_id
      JOIN conversations c ON c.episode_id = e.id
      WHERE t.patient_id = $1::uuid
        AND t.source_event_id = $2::uuid
      ORDER BY t.created_at DESC
      LIMIT 1
    `,
    [args.patientId, String(imported.event_id)],
  );

  const created = row.rows[0];
  if (!created) {
    throw new Error('CONVERSATION_NOT_CREATED');
  }

  return {
    conversationId: created.conversation_id,
    triggerId: created.trigger_id,
    episodeId: created.episode_id,
    sourceEventId: String(imported.event_id),
  };
}

describePostgres('analysis follow-up production path context evidence (postgres)', { timeout: 120_000 }, () => {
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;
  let pool: Pool;
  let repository: PostgresGlucoMindRepository;
  let nightscoutRepository: PostgresNightscoutRepository;
  let nightscoutSync: NightscoutSyncService;

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AnalysisFollowUpModule, { logger: ['error', 'warn'] });
    pool = app.get<Pool>(DATABASE_POOL);
    repository = app.get(PostgresGlucoMindRepository, { strict: false });
    nightscoutRepository = app.get(PostgresNightscoutRepository, { strict: false });
    nightscoutSync = new NightscoutSyncService(
      nightscoutRepository,
      repository,
      new EmptyNightscoutClient() as any,
    );
  });

  beforeEach(async () => {
    await resetSharedPostgresState(pool);
  });

  afterAll(async () => {
    await resetSharedPostgresState(pool);
    await app.close();
  });

  it('reuses a sent push notification instead of re-sending it when the dedupe key already completed', async () => {
    const patientId = randomUUID();
    const caregiverUserId = randomUUID();
    const workerConfig = app.get(ConfigService);

    await ensurePatient(pool, patientId);
    await pool.query(
      `INSERT INTO users (id, display_name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING`,
      [caregiverUserId, 'caregiver-test'],
    );
    await pool.query(
      `INSERT INTO caregiver_relationships (id, user_id, patient_id, relationship_type, permissions)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'caregiver', '{}'::jsonb)
       ON CONFLICT (user_id, patient_id, relationship_type) DO NOTHING`,
      [caregiverUserId, patientId],
    );
    await nightscoutSync.ensureNightscoutSource(patientId, 'https://nightscout.example.com');

    const flow = await createOpenConversationForAnalysis({ patientId, repository, nightscoutRepository, nightscoutSync, pool });
    await upsertContextQuestion(pool, {
      conversationId: flow.conversationId,
      patientId,
      questionId: 'activity_before_drop',
      questionType: 'CONTEXT_QUESTION',
      questionText: 'Did the patient do any activity before the low?',
      reason: 'Need to determine context for the suspected hypo.',
      expectedInformationGain: 'MEDIUM',
      expectedAnswerTypes: ['YES', 'NO', 'UNKNOWN'],
      relatedEventId: flow.sourceEventId,
    });
    await repository.setConversationAwaitingUserAnswer({ conversationId: flow.conversationId, awaitingUserAnswer: true });

    await repository.upsertPatientDevice({
      patientId,
      platform: 'ios',
      deviceId: 'device-dedupe-1',
      pushToken: 'push-token-dedupe',
      appVersion: '1.0.0',
      // Phones without a user get no pushes (sharing audit #22).
      userId: caregiverUserId,
    });

    await pool.query(`DELETE FROM jobs WHERE patient_id = $1::uuid`, [patientId]);

    const dedupeKey = `conversation-question:${patientId}:${flow.conversationId}:activity_before_drop`;
    await upsertPushNotification(pool, {
      dedupeKey,
      patientId,
      conversationId: flow.conversationId,
      questionId: 'activity_before_drop',
      notificationType: 'conversation_question',
      payload: {
        type: 'conversation_question',
        patientId,
        conversationId: flow.conversationId,
        questionId: 'activity_before_drop',
        routePath: `/patients/${patientId}/conversations/${flow.conversationId}`,
        universalLink: `https://app.mellis.invalid/patients/${patientId}/conversations/${flow.conversationId}`,
      },
    });
    await pool.query(
      `UPDATE push_notifications SET status = 'sent', sent_at = now(), last_error = NULL WHERE dedupe_key = $1`,
      [dedupeKey],
    );
    await repository.insertJob({
      jobType: 'notifications.push_conversation_question',
      payloadVersion: 1,
      payload: {
        patient_id: patientId,
        conversation_id: flow.conversationId,
        question_id: 'activity_before_drop',
        notification_dedupe_key: dedupeKey,
      },
      dedupeKey,
      correlationId: flow.conversationId,
      causationId: flow.triggerId,
      patientId,
      availableAt: new Date().toISOString(),
      maxAttempts: 5,
    });

    const provider = new RecordingPushNotificationProvider();
    const worker = new WorkerService(
      repository,
      nightscoutSync,
      workerConfig,
      new StaticAiGateway({}),
      new PushNotificationService(provider),
    );

    await worker.processOnce();

    expect(provider.sent).toHaveLength(0);
    const notificationAfter = await repository.getPushNotificationByDedupeKey(dedupeKey);
    expect(notificationAfter?.status).toBe('sent');
    const jobAfter = await pool.query<{ status: string }>(
      `SELECT status FROM jobs WHERE job_type = 'notifications.push_conversation_question' AND dedupe_key = $1 LIMIT 1`,
      [dedupeKey],
    );
    expect(jobAfter.rows[0]?.status).toBe('succeeded');
  });

  it('delivers queued conversation question push once and preserves question identity in payload', async () => {
    const patientId = randomUUID();
    const caregiverUserId = randomUUID();
    const workerConfig = app.get(ConfigService);

    await ensurePatient(pool, patientId);
    await pool.query(
      `INSERT INTO users (id, display_name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING`,
      [caregiverUserId, 'caregiver-delivery'],
    );
    await pool.query(
      `INSERT INTO caregiver_relationships (id, user_id, patient_id, relationship_type, permissions)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'caregiver', '{}'::jsonb)
       ON CONFLICT (user_id, patient_id, relationship_type) DO NOTHING`,
      [caregiverUserId, patientId],
    );
    await nightscoutSync.ensureNightscoutSource(patientId, 'https://nightscout.example.com');

    const flow = await createOpenConversationForAnalysis({ patientId, repository, nightscoutRepository, nightscoutSync, pool });
    await upsertContextQuestion(pool, {
      conversationId: flow.conversationId,
      patientId,
      questionId: 'activity_before_drop',
      questionType: 'CONTEXT_QUESTION',
      questionText: 'Did the patient do any activity before the low?',
      reason: 'Need to determine context for the suspected hypo.',
      expectedInformationGain: 'MEDIUM',
      expectedAnswerTypes: ['YES', 'NO', 'UNKNOWN'],
      relatedEventId: flow.sourceEventId,
    });
    await repository.setConversationAwaitingUserAnswer({ conversationId: flow.conversationId, awaitingUserAnswer: true });

    await repository.upsertPatientDevice({
      patientId,
      platform: 'ios',
      deviceId: 'device-delivery-1',
      pushToken: 'push-token-delivery',
      appVersion: '1.0.0',
      // Phones without a user get no pushes (sharing audit #22).
      userId: caregiverUserId,
    });

    await pool.query(`DELETE FROM jobs WHERE patient_id = $1::uuid`, [patientId]);

    const dedupeKey = `conversation-question:${patientId}:${flow.conversationId}:activity_before_drop`;
    await upsertPushNotification(pool, {
      dedupeKey,
      patientId,
      conversationId: flow.conversationId,
      questionId: 'activity_before_drop',
      notificationType: 'conversation_question',
      payload: {
        type: 'conversation_question',
        patientId,
        conversationId: flow.conversationId,
        questionId: 'activity_before_drop',
        routePath: `/patients/${patientId}/conversations/${flow.conversationId}`,
        universalLink: `https://app.mellis.invalid/patients/${patientId}/conversations/${flow.conversationId}`,
      },
    });
    await repository.insertJob({
      jobType: 'notifications.push_conversation_question',
      payloadVersion: 1,
      payload: {
        patient_id: patientId,
        conversation_id: flow.conversationId,
        question_id: 'activity_before_drop',
        notification_dedupe_key: dedupeKey,
      },
      dedupeKey,
      correlationId: flow.conversationId,
      causationId: flow.triggerId,
      patientId,
      availableAt: new Date().toISOString(),
      maxAttempts: 5,
    });

    const provider = new RecordingPushNotificationProvider();
    const worker = new WorkerService(
      repository,
      nightscoutSync,
      workerConfig,
      new StaticAiGateway({}),
      new PushNotificationService(provider),
    );

    await worker.processOnce();

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toEqual({
      patientId,
      pushToken: 'push-token-delivery',
      conversationId: flow.conversationId,
      questionId: 'activity_before_drop',
    });

    const notificationAfter = await repository.getPushNotificationByDedupeKey(dedupeKey);
    expect(notificationAfter?.status).toBe('sent');
    const jobAfter = await pool.query<{ status: string }>(
      `SELECT status FROM jobs WHERE job_type = 'notifications.push_conversation_question' AND dedupe_key = $1 LIMIT 1`,
      [dedupeKey],
    );
    expect(jobAfter.rows[0]?.status).toBe('succeeded');
  });

  it('re-queues a retryable APNs failure and preserves the push notification state for retry', async () => {
    const patientId = randomUUID();
    const caregiverUserId = randomUUID();
    const workerConfig = app.get(ConfigService);

    await ensurePatient(pool, patientId);
    await pool.query(
      `INSERT INTO users (id, display_name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING`,
      [caregiverUserId, 'caregiver-retry'],
    );
    await pool.query(
      `INSERT INTO caregiver_relationships (id, user_id, patient_id, relationship_type, permissions)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'caregiver', '{}'::jsonb)
       ON CONFLICT (user_id, patient_id, relationship_type) DO NOTHING`,
      [caregiverUserId, patientId],
    );
    await nightscoutSync.ensureNightscoutSource(patientId, 'https://nightscout.example.com');

    const flow = await createOpenConversationForAnalysis({ patientId, repository, nightscoutRepository, nightscoutSync, pool });
    await upsertContextQuestion(pool, {
      conversationId: flow.conversationId,
      patientId,
      questionId: 'additional_carbohydrates',
      questionType: 'CONTEXT_QUESTION',
      questionText: 'How many carbs were eaten?',
      reason: 'Need to clarify the context for this hypo.',
      expectedInformationGain: 'HIGH',
      expectedAnswerTypes: ['TEXT'],
      relatedEventId: flow.sourceEventId,
    });
    await repository.setConversationAwaitingUserAnswer({ conversationId: flow.conversationId, awaitingUserAnswer: true });

    await repository.upsertPatientDevice({
      patientId,
      platform: 'ios',
      deviceId: 'device-retry-1',
      pushToken: 'push-token-retry',
      appVersion: '1.0.0',
      // Phones without a user get no pushes (sharing audit #22).
      userId: caregiverUserId,
    });

    await pool.query(`DELETE FROM jobs WHERE patient_id = $1::uuid`, [patientId]);

    const dedupeKey = `conversation-question:${patientId}:${flow.conversationId}:additional_carbohydrates`;
    await upsertPushNotification(pool, {
      dedupeKey,
      patientId,
      conversationId: flow.conversationId,
      questionId: 'additional_carbohydrates',
      notificationType: 'conversation_question',
      payload: {
        type: 'conversation_question',
        patientId,
        conversationId: flow.conversationId,
        questionId: 'additional_carbohydrates',
        routePath: `/patients/${patientId}/conversations/${flow.conversationId}`,
        universalLink: `https://app.mellis.invalid/patients/${patientId}/conversations/${flow.conversationId}`,
      },
    });
    await repository.insertJob({
      jobType: 'notifications.push_conversation_question',
      payloadVersion: 1,
      payload: {
        patient_id: patientId,
        conversation_id: flow.conversationId,
        question_id: 'additional_carbohydrates',
        notification_dedupe_key: dedupeKey,
      },
      dedupeKey,
      correlationId: flow.conversationId,
      causationId: flow.triggerId,
      patientId,
      availableAt: new Date().toISOString(),
      maxAttempts: 5,
    });

    const provider = new RecordingPushNotificationProvider();
    provider.pushFailure(new PushNotificationProviderError('APNS_RETRYABLE', 'temporary apns throttling', true));
    const worker = new WorkerService(
      repository,
      nightscoutSync,
      workerConfig,
      new StaticAiGateway({}),
      new PushNotificationService(provider),
    );

    await worker.processOnce();

    const jobRow = await pool.query<{ status: string; attempts: string }>(
      `SELECT status, attempts::text AS attempts FROM jobs WHERE job_type = 'notifications.push_conversation_question' AND dedupe_key = $1 LIMIT 1`,
      [dedupeKey],
    );
    expect(jobRow.rows[0]?.status).toBe('queued');
    expect(Number(jobRow.rows[0]?.attempts ?? '0')).toBeGreaterThanOrEqual(1);

    const notificationRow = await repository.getPushNotificationByDedupeKey(dedupeKey);
    expect(notificationRow?.status).toBe('queued');
    expect(notificationRow?.last_error).toMatchObject({ code: 'APNS_RETRYABLE' });
  });

  it('re-queues push delivery when no active iOS device token is registered yet', async () => {
    const patientId = randomUUID();
    const caregiverUserId = randomUUID();
    const workerConfig = app.get(ConfigService);

    await ensurePatient(pool, patientId);
    await pool.query(
      `INSERT INTO users (id, display_name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING`,
      [caregiverUserId, 'caregiver-no-device'],
    );
    await pool.query(
      `INSERT INTO caregiver_relationships (id, user_id, patient_id, relationship_type, permissions)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'caregiver', '{}'::jsonb)
       ON CONFLICT (user_id, patient_id, relationship_type) DO NOTHING`,
      [caregiverUserId, patientId],
    );
    await nightscoutSync.ensureNightscoutSource(patientId, 'https://nightscout.example.com');

    const flow = await createOpenConversationForAnalysis({ patientId, repository, nightscoutRepository, nightscoutSync, pool });
    await upsertContextQuestion(pool, {
      conversationId: flow.conversationId,
      patientId,
      questionId: 'activity_before_drop',
      questionType: 'CONTEXT_QUESTION',
      questionText: 'Did the patient do any activity before the low?',
      reason: 'Need to determine context for the suspected hypo.',
      expectedInformationGain: 'MEDIUM',
      expectedAnswerTypes: ['YES', 'NO', 'UNKNOWN'],
      relatedEventId: flow.sourceEventId,
    });
    await repository.setConversationAwaitingUserAnswer({ conversationId: flow.conversationId, awaitingUserAnswer: true });

    await pool.query(`DELETE FROM jobs WHERE patient_id = $1::uuid`, [patientId]);

    const dedupeKey = `conversation-question:${patientId}:${flow.conversationId}:activity_before_drop`;
    await upsertPushNotification(pool, {
      dedupeKey,
      patientId,
      conversationId: flow.conversationId,
      questionId: 'activity_before_drop',
      notificationType: 'conversation_question',
      payload: {
        type: 'conversation_question',
        patientId,
        conversationId: flow.conversationId,
        questionId: 'activity_before_drop',
        routePath: `/patients/${patientId}/conversations/${flow.conversationId}`,
        universalLink: `https://app.mellis.invalid/patients/${patientId}/conversations/${flow.conversationId}`,
      },
    });
    await repository.insertJob({
      jobType: 'notifications.push_conversation_question',
      payloadVersion: 1,
      payload: {
        patient_id: patientId,
        conversation_id: flow.conversationId,
        question_id: 'activity_before_drop',
        notification_dedupe_key: dedupeKey,
      },
      dedupeKey,
      correlationId: flow.conversationId,
      causationId: flow.triggerId,
      patientId,
      availableAt: new Date().toISOString(),
      maxAttempts: 5,
    });

    const provider = new RecordingPushNotificationProvider();
    const worker = new WorkerService(
      repository,
      nightscoutSync,
      workerConfig,
      new StaticAiGateway({}),
      new PushNotificationService(provider),
    );

    await worker.processOnce();

    expect(provider.sent).toHaveLength(0);

    const notificationRow = await repository.getPushNotificationByDedupeKey(dedupeKey);
    expect(notificationRow?.status).toBe('queued');
    expect(notificationRow?.last_error).toMatchObject({ code: 'NO_ACTIVE_DEVICE' });

    const jobRow = await pool.query<{ status: string; attempts: string }>(
      `SELECT status, attempts::text AS attempts FROM jobs WHERE job_type = 'notifications.push_conversation_question' AND dedupe_key = $1 LIMIT 1`,
      [dedupeKey],
    );
    expect(jobRow.rows[0]?.status).toBe('queued');
    expect(Number(jobRow.rows[0]?.attempts ?? '0')).toBeGreaterThanOrEqual(1);
  });

  it('deactivates invalid APNs push tokens after a non-retryable device failure', async () => {
    const patientId = randomUUID();
    const caregiverUserId = randomUUID();
    const workerConfig = app.get(ConfigService);

    await ensurePatient(pool, patientId);
    await pool.query(
      `INSERT INTO users (id, display_name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING`,
      [caregiverUserId, 'caregiver-invalid'],
    );
    await pool.query(
      `INSERT INTO caregiver_relationships (id, user_id, patient_id, relationship_type, permissions)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'caregiver', '{}'::jsonb)
       ON CONFLICT (user_id, patient_id, relationship_type) DO NOTHING`,
      [caregiverUserId, patientId],
    );
    await nightscoutSync.ensureNightscoutSource(patientId, 'https://nightscout.example.com');

    const flow = await createOpenConversationForAnalysis({ patientId, repository, nightscoutRepository, nightscoutSync, pool });
    await upsertContextQuestion(pool, {
      conversationId: flow.conversationId,
      patientId,
      questionId: 'activity_before_drop',
      questionType: 'CONTEXT_QUESTION',
      questionText: 'Did the patient do any activity before the low?',
      reason: 'Need to determine context for the suspected hypo.',
      expectedInformationGain: 'MEDIUM',
      expectedAnswerTypes: ['YES', 'NO', 'UNKNOWN'],
      relatedEventId: flow.sourceEventId,
    });
    await repository.setConversationAwaitingUserAnswer({ conversationId: flow.conversationId, awaitingUserAnswer: true });

    await repository.upsertPatientDevice({
      patientId,
      platform: 'ios',
      deviceId: 'device-invalid-1',
      pushToken: 'invalid-push-token',
      appVersion: '1.0.0',
      // Phones without a user get no pushes (sharing audit #22).
      userId: caregiverUserId,
    });

    await pool.query(`DELETE FROM jobs WHERE patient_id = $1::uuid`, [patientId]);

    const dedupeKey = `conversation-question:${patientId}:${flow.conversationId}:activity_before_drop`;
    await upsertPushNotification(pool, {
      dedupeKey,
      patientId,
      conversationId: flow.conversationId,
      questionId: 'activity_before_drop',
      notificationType: 'conversation_question',
      payload: {
        type: 'conversation_question',
        patientId,
        conversationId: flow.conversationId,
        questionId: 'activity_before_drop',
        routePath: `/patients/${patientId}/conversations/${flow.conversationId}`,
        universalLink: `https://app.mellis.invalid/patients/${patientId}/conversations/${flow.conversationId}`,
      },
    });
    await repository.insertJob({
      jobType: 'notifications.push_conversation_question',
      payloadVersion: 1,
      payload: {
        patient_id: patientId,
        conversation_id: flow.conversationId,
        question_id: 'activity_before_drop',
        notification_dedupe_key: dedupeKey,
      },
      dedupeKey,
      correlationId: flow.conversationId,
      causationId: flow.triggerId,
      patientId,
      availableAt: new Date().toISOString(),
      maxAttempts: 5,
    });

    const provider = new RecordingPushNotificationProvider();
    provider.pushFailure(new PushNotificationProviderError('DEVICE_TOKEN_INVALID', 'bad device token', false));
    const worker = new WorkerService(
      repository,
      nightscoutSync,
      workerConfig,
      new StaticAiGateway({}),
      new PushNotificationService(provider),
    );

    await expect(worker.processOnce()).resolves.toBeUndefined();

    const deviceRow = await pool.query<{ active: boolean }>(
      `SELECT active FROM patient_devices WHERE patient_id = $1::uuid AND push_token = $2 AND platform = 'ios' LIMIT 1`,
      [patientId, 'invalid-push-token'],
    );
    expect(deviceRow.rows[0]?.active).toBe(false);

    const notificationRow = await repository.getPushNotificationByDedupeKey(dedupeKey);
    expect(notificationRow?.status).toBe('failed');
    const jobRow = await pool.query<{ status: string }>(
      `SELECT status FROM jobs WHERE job_type = 'notifications.push_conversation_question' AND dedupe_key = $1 LIMIT 1`,
      [dedupeKey],
    );
    expect(jobRow.rows[0]?.status).toBe('failed');
  });
});
