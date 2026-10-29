import 'dotenv/config';
import { persistLiveHypoUntilRecovered, seedLegacyHypoConversation } from '@infra/testing/hypo-episode-recovery';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { DatabaseModule } from '@infra/db/database.module';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { PostgresNightscoutRepository } from '@infra/db/postgres-nightscout.repository';
import { NightscoutSyncService } from './nightscout-sync.service';
import { NightscoutClient } from './nightscout-client';
import { AiGatewayService } from '@modules/ai-gateway/application/ai-gateway.service';
import { FakeAiProvider } from '@modules/ai-gateway/infrastructure/fake-ai-provider';
import { AiProviderError } from '@modules/ai-gateway/infrastructure/ai-provider.error';
import { AiProvider, AiProviderInput, AiProviderResponse } from '@modules/ai-gateway/domain/ai-gateway';
import { FakePushNotificationProvider } from '@modules/notifications/infrastructure/fake-push-notification-provider';
import { PushNotificationService } from '@modules/notifications/application/push-notification.service';
import { WorkerService } from '../../../../apps/worker/src/worker.service';
import { ApiService } from '../../../../apps/api/src/application/api.service';
import { detectHypo } from '@modules/triggering/application/hypo-detector';
import { createInvestigationCandidateFromQuestionId } from '@modules/context/application/investigation-policy';
import { truncatePublicTablesForIntegrationTests } from '@infra/db/postgres-test-isolation';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
})
class InvestigationLoopModule {}

type SyntheticEntry = {
  _id: string;
  date: number;
  dateString: string;
  patient: string;
  sgv: number;
  units: 'mg/dL';
};

const SCENARIO_ANCHOR_MS = Date.now();

function syntheticEntry(id: string, patient: string, minutesAgo: number, sgv: number): SyntheticEntry {
  const date = SCENARIO_ANCHOR_MS - minutesAgo * 60_000;
  return { _id: id, date, dateString: new Date(date).toISOString(), patient, sgv, units: 'mg/dL' };
}

/** Each sync in its own minute (the nightscout.sync dedupe bucket). */
function syncTime(minutesAgo: number): string {
  return new Date(SCENARIO_ANCHOR_MS - minutesAgo * 60_000).toISOString();
}

class QueueNightscoutClient implements NightscoutClient {
  constructor(private readonly entriesByPatient: Map<string, SyntheticEntry[]>) {}

  async fetchEntries(input: { patient_id: string }): Promise<{ entries: Record<string, unknown>[]; next_cursor: string | null }> {
    const queue = this.entriesByPatient.get(input.patient_id) ?? [];
    const next = queue.shift();
    return {
      entries: next ? [next as unknown as Record<string, unknown>] : [],
      next_cursor: null,
    };
  }

  async fetchTreatments(): Promise<{ treatments: Record<string, unknown>[]; next_cursor: string | null }> {
    return {
      treatments: [],
      next_cursor: null,
    };
  }
}

class FlakyDirectResponseProvider implements AiProvider {
  readonly providerName = 'fake-flaky';
  readonly model = 'deterministic-hypo-v1';
  private failedOnce = false;
  private readonly delegate = new FakeAiProvider();

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    if (input.task.task_type === 'CONVERSATION_DIRECT_RESPONSE' && !this.failedOnce) {
      this.failedOnce = true;
      throw new AiProviderError('forced retryable direct response failure', true, 'FORCED_RETRYABLE');
    }

    return this.delegate.generate(input);
  }
}

class CapturingDirectResponseProvider extends FakeAiProvider {
  public lastInput: AiProviderInput | null = null;

  override async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    this.lastInput = input;
    return super.generate(input);
  }
}

async function ensureActors(pool: Pool, userId: string, patientId: string): Promise<void> {
  await pool.query(
    `
      INSERT INTO users (id, display_name)
      VALUES ($1::uuid, 'investigation-loop-tester')
      ON CONFLICT (id)
      DO UPDATE SET updated_at = now()
    `,
    [userId],
  );

  await pool.query(
    `
      INSERT INTO patients (id, display_name)
      VALUES ($1::uuid, $2)
      ON CONFLICT (id)
      DO UPDATE SET updated_at = now()
    `,
    [patientId, `patient-${patientId.slice(0, 8)}`],
  );

  await pool.query(
    `
      INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type, permissions)
      VALUES ($1::uuid, $2::uuid, 'primary_caregiver', '{}'::jsonb)
      ON CONFLICT (user_id, patient_id, relationship_type)
      DO UPDATE SET updated_at = now()
    `,
    [userId, patientId],
  );
}

async function processUntilQueuedEmpty(worker: WorkerService, pool: Pool, maxIterations = 80): Promise<void> {
  for (let i = 0; i < maxIterations; i += 1) {
    await worker.processOnce();
    const queued = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM jobs WHERE status = 'queued'`);
    if (Number(queued.rows[0].count) === 0) {
      return;
    }
  }
}

async function createOpenHypoConversation(args: {
  nightscoutSync: NightscoutSyncService;
  nightscoutRepository: PostgresNightscoutRepository;
  pool: Pool;
  patientId: string;
  eventId: string;
}): Promise<{ conversationId: string; triggerId: string; episodeId: string; eventId: string }> {
  const imported = await args.nightscoutSync.getImportedReadingForEvent(args.eventId);
  if (!imported) {
    throw new Error('IMPORTED_READING_NOT_FOUND');
  }

  const observedAt = new Date(String(imported.occurred_at)).toISOString();
  const recordedAt = new Date(String(imported.recorded_at)).toISOString();

  const reading = {
    reading_id: String(imported.event_id),
    source_record_id: String(imported.source_identity ?? imported.source_record_id),
    observed_at: observedAt,
    recorded_at: recordedAt,
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
  await seedLegacyHypoConversation(args.pool, { patientId: args.patientId, sourceEventId: args.eventId });

  const triggerRow = await args.pool.query<{
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
    [args.patientId, args.eventId],
  );

  const row = triggerRow.rows[0];
  if (!row) {
    throw new Error('TRIGGER_NOT_FOUND_FOR_EVENT');
  }

  return {
    conversationId: row.conversation_id,
    triggerId: row.trigger_id,
    episodeId: row.episode_id,
    eventId: args.eventId,
  };
}

async function createFreshHypoConversation(args: {
  nightscoutRepository: PostgresNightscoutRepository;
  nightscoutSync: NightscoutSyncService;
  pool: Pool;
  patientId: string;
}): Promise<{ conversationId: string; triggerId: string; episodeId: string; eventId: string }> {
  const source = await args.pool.query<{ id: string; patient_id: string; source_system: string; source_key: string; sync_cursor: string | null; last_successful_observed_at: string | null; source_version: string | null; metadata: Record<string, unknown> }>(
    `SELECT * FROM sources WHERE patient_id = $1::uuid AND source_system = 'NIGHTSCOUT' ORDER BY created_at DESC LIMIT 1`,
    [args.patientId],
  );

  const sourceRow = source.rows[0];
  if (!sourceRow) {
    throw new Error('NIGHTSCOUT_SOURCE_NOT_FOUND');
  }

  const stamp = Date.now();
  const observedAt = new Date(stamp).toISOString();
  const sourceRecordId = `fresh-hypo-${stamp}`;
  const normalizedReading = {
    source_system: 'NIGHTSCOUT',
    source_record_id: sourceRecordId,
    natural_key: `nightscout:${args.patientId}:${sourceRecordId}`,
    record_type: 'cgm.entry',
    observed_at: observedAt,
    recorded_at: observedAt,
    imported_at: observedAt,
    source_unit: 'mg/dL',
    glucose_value: 62,
    glucose_unit: 'mg/dL' as const,
    normalization_version: 'nightscout.entries.v1',
    raw_payload: { _id: sourceRecordId, dateString: observedAt, date: stamp, patient: args.patientId, sgv: 62, units: 'mg/dL' },
    provenance: {},
    canonical_hash: `fresh-hash-${sourceRecordId}`,
  };

  const persisted = await args.nightscoutRepository.persistImportedGlucoseReading({
    source: sourceRow,
    reading: normalizedReading as any,
    jobDedupeKey: `triggering.hypo_detection:${normalizedReading.natural_key}`,
    correlationId: sourceRow.id,
    causationId: sourceRow.id,
    jobPayload: {
      patient_id: args.patientId,
      source_id: sourceRow.id,
      source_record_id: sourceRecordId,
      natural_key: normalizedReading.natural_key,
      event_type: 'GLUCOSE_READING_AVAILABLE',
    },
  });

  await args.pool.query(`DELETE FROM jobs WHERE job_type = 'triggering.hypo_detection' AND dedupe_key = $1`, [`triggering.hypo_detection:${normalizedReading.natural_key}`]);

  const imported = await args.nightscoutSync.getImportedReadingForEvent(String(persisted.event_id));
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

  const existingEpisode = await args.nightscoutRepository.getLatestOpenHypoEpisode(args.patientId, 'LIVE');
  const detection = detectHypo({
    patient_id: args.patientId,
    rule_version: 'hypo.cgm.ada2026.v1',
    existing_episode: existingEpisode,
    reading,
  });

  await persistLiveHypoUntilRecovered(args.nightscoutRepository, {
    patientId: args.patientId,
    reading,
    detection,
    existingEpisode,
  });

  return createOpenHypoConversation({
    nightscoutSync: args.nightscoutSync,
    nightscoutRepository: args.nightscoutRepository,
    pool: args.pool,
    patientId: args.patientId,
    eventId: String(imported.event_id),
  });
}

describePostgres('smart investigation loop (postgres)', { timeout: 120_000 }, () => {
  const userId = randomUUID();
  const patientId = randomUUID();

  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;
  let pool: Pool;
  let repository: PostgresGlucoMindRepository;
  let nightscoutRepository: PostgresNightscoutRepository;
  let api: ApiService;
  let workerA: WorkerService;
  let workerB: WorkerService;
  let workerFlakyDirectResponse: WorkerService;
  let nightscoutSync: NightscoutSyncService;

  async function resetSharedPostgresState(pool: Pool): Promise<void> {
    await truncatePublicTablesForIntegrationTests(pool);
  }

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(InvestigationLoopModule, { logger: ['error', 'warn'] });
    pool = app.get<Pool>(DATABASE_POOL);
    repository = app.get(PostgresGlucoMindRepository, { strict: false });
    nightscoutRepository = app.get(PostgresNightscoutRepository, { strict: false });
    const configService = app.get(ConfigService);

      await resetSharedPostgresState(pool);

    const entriesByPatient = new Map<string, SyntheticEntry[]>();
    // Recent readings: a LIVE hypo is asked about only within the 30-minute freshness guard, once it has closed.
    entriesByPatient.set(patientId, [
      syntheticEntry('loop-hypo-1', patientId, 25, 63),
      syntheticEntry('loop-close-1', patientId, 20, 120),
      syntheticEntry('loop-hypo-2', patientId, 15, 61),
      syntheticEntry('loop-hypo-3', patientId, 14, 62),
      syntheticEntry('loop-hypo-4', patientId, 13, 64),
    ]);

    nightscoutSync = new NightscoutSyncService(
      nightscoutRepository,
      repository,
      new QueueNightscoutClient(entriesByPatient),
    );

    api = new ApiService(repository);
    workerA = new WorkerService(
      repository,
      nightscoutSync,
      configService,
      new AiGatewayService(new FakeAiProvider()),
      new PushNotificationService(new FakePushNotificationProvider()),
    );
    workerB = new WorkerService(
      repository,
      nightscoutSync,
      configService,
      new AiGatewayService(new FakeAiProvider()),
      new PushNotificationService(new FakePushNotificationProvider()),
    );
    workerFlakyDirectResponse = new WorkerService(
      repository,
      nightscoutSync,
      configService,
      new AiGatewayService(new FlakyDirectResponseProvider()),
      new PushNotificationService(new FakePushNotificationProvider()),
    );

    await ensureActors(pool, userId, patientId);
    await nightscoutSync.ensureNightscoutSource(patientId, 'https://nightscout.example.com');
  });

  afterAll(async () => {
    await resetSharedPostgresState(pool);
    await app.close();
  });

  it('processes DIRECT_RESPONSE asynchronously through WorkerService and persists exactly one ASSISTANT_MESSAGE with no investigation artifacts', async () => {
    const freshPatientId = randomUUID();
    const freshUserId = randomUUID();
    const principal = { user_id: freshUserId } as any;

    try {
      await ensureActors(pool, freshUserId, freshPatientId);
      const created = await api.createConversation(principal, freshPatientId, 'direct-response-happy-conversation');
      const conversationId = String(created.conversation.id);

      const first = await api.submitAnswer(principal, freshPatientId, conversationId, {
        message_type: 'USER_MESSAGE',
        content: 'Co oznacza trend glikemii?',
        idempotency_key: 'direct-response-happy-user-message',
      });

      expect(first.decision).toBe('DIRECT_RESPONSE');

      const queuedJobs = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM jobs WHERE patient_id = $1::uuid AND job_type = 'conversation.direct_response' AND payload->>'conversation_id' = $2`,
        [freshPatientId, conversationId],
      );
      expect(Number(queuedJobs.rows[0].count)).toBe(1);

      await processUntilQueuedEmpty(workerA, pool);

      const userMessageRows = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1::uuid AND message_type = 'USER_MESSAGE'`,
        [conversationId],
      );
      const assistantRows = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1::uuid AND message_type = 'ASSISTANT_MESSAGE'`,
        [conversationId],
      );
      expect(Number(userMessageRows.rows[0].count)).toBe(1);
      expect(Number(assistantRows.rows[0].count)).toBe(1);

      const aiExecutions = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ai_executions WHERE correlation_id = $1 AND task_type = 'CONVERSATION_DIRECT_RESPONSE'`,
        [conversationId],
      );
      expect(Number(aiExecutions.rows[0].count)).toBe(1);

      const investigationRows = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM investigations WHERE patient_id = $1::uuid AND conversation_id = $2::uuid`,
        [freshPatientId, conversationId],
      );
      const questionRows = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM context_questions WHERE patient_id = $1::uuid AND conversation_id = $2::uuid`,
        [freshPatientId, conversationId],
      );
      const analysisRows = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM analyses WHERE patient_id = $1::uuid AND episode_id IS NULL`,
        [freshPatientId],
      );
      const recommendationRows = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM recommendations WHERE patient_id = $1::uuid AND episode_id IS NULL`,
        [freshPatientId],
      );
      expect(Number(investigationRows.rows[0].count)).toBe(0);
      expect(Number(questionRows.rows[0].count)).toBe(0);
      expect(Number(analysisRows.rows[0].count)).toBe(0);
      expect(Number(recommendationRows.rows[0].count)).toBe(0);

      const conversation = (await repository.getConversation(freshPatientId, conversationId)) as any;
      expect(conversation.episode_id).toBeNull();
      expect(conversation.trigger_id).toBeNull();
    } finally {
      await pool.query(`DELETE FROM jobs WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM context_questions WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM messages WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM conversations WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM ai_execution_attempts WHERE ai_execution_id IN (SELECT id FROM ai_executions WHERE patient_id = $1)`, [freshPatientId]);
      await pool.query(`DELETE FROM ai_executions WHERE patient_id = $1`, [freshPatientId]);
      await pool.query(`DELETE FROM investigations WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM analyses WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM recommendations WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM patients WHERE id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM caregiver_relationships WHERE patient_id = $1::uuid AND user_id = $2::uuid`, [freshPatientId, freshUserId]);
      await pool.query(`DELETE FROM users WHERE id = $1::uuid`, [freshUserId]);
    }
  });

  it('excludes unrelated EVENT-scoped facts from direct-response context selection', async () => {
    const freshPatientId = randomUUID();
    const freshUserId = randomUUID();
    const principal = { user_id: freshUserId } as any;
    const capturingProvider = new CapturingDirectResponseProvider();
    const scopedWorker = new WorkerService(
      repository,
      nightscoutSync,
      app.get(ConfigService),
      new AiGatewayService(capturingProvider),
      new PushNotificationService(new FakePushNotificationProvider()),
    );

    try {
      await ensureActors(pool, freshUserId, freshPatientId);

      const oldConversation = await api.createConversation(principal, freshPatientId, 'direct-response-fact-leak-old');
      const activeConversation = await api.createConversation(principal, freshPatientId, 'direct-response-fact-leak-active');
      const oldConversationId = String(oldConversation.conversation.id);
      const activeConversationId = String(activeConversation.conversation.id);

      await pool.query(
        `
          INSERT INTO patient_context (
            patient_id, fact_key, fact_name, fact_type, scope, value, value_type, knowledge_status,
            source_type, source_ref, source_event_id, source_conversation_id, source_question_id,
            related_episode_id, related_trigger_id, observed_at, recorded_at, confidence, validity,
            created_by, status
          ) VALUES (
            $1::uuid, 'additional_carbohydrates', 'Additional carbohydrates around hypo', 'CAREGIVER_CONTEXT', 'EVENT',
            '"Tak, 5g"'::jsonb, 'TEXT', 'KNOWN',
            'USER_REPORT', $2, NULL, $3::uuid, 'additional_carbohydrates',
            NULL, NULL, now(), now(), 'HIGH', 'VALID',
            $4, 'ACTIVE'
          )
        `,
        [freshPatientId, `conv/${oldConversationId}/messages/fact-seed`, oldConversationId, freshUserId],
      );

      await api.submitAnswer(principal, freshPatientId, activeConversationId, {
        message_type: 'USER_MESSAGE',
        content: 'Co oznacza trend glikemii?',
        idempotency_key: 'direct-response-fact-leak-message',
      });

      await processUntilQueuedEmpty(scopedWorker, pool);

      const capturedContext = capturingProvider.lastInput?.context_package as any;
      expect(capturingProvider.lastInput?.task.task_type).toBe('CONVERSATION_DIRECT_RESPONSE');
      expect(Array.isArray(capturedContext?.patient_facts)).toBe(true);
      expect(capturedContext.patient_facts).toHaveLength(0);
    } finally {
      await pool.query(`DELETE FROM jobs WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM context_questions WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM messages WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM conversations WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM patient_context WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM ai_execution_attempts WHERE ai_execution_id IN (SELECT id FROM ai_executions WHERE patient_id = $1)`, [freshPatientId]);
      await pool.query(`DELETE FROM ai_executions WHERE patient_id = $1`, [freshPatientId]);
      await pool.query(`DELETE FROM investigations WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM analyses WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM recommendations WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM patients WHERE id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM caregiver_relationships WHERE patient_id = $1::uuid AND user_id = $2::uuid`, [freshPatientId, freshUserId]);
      await pool.query(`DELETE FROM users WHERE id = $1::uuid`, [freshUserId]);
    }
  });

  it('keeps direct-response idempotency and worker retries free of duplicate jobs/executions/messages', async () => {
    const freshPatientId = randomUUID();
    const freshUserId = randomUUID();
    const principal = { user_id: freshUserId } as any;

    try {
      await ensureActors(pool, freshUserId, freshPatientId);
      const created = await api.createConversation(principal, freshPatientId, 'direct-response-replay-conversation');
      const conversationId = String(created.conversation.id);

      const first = await api.submitAnswer(principal, freshPatientId, conversationId, {
        message_type: 'USER_MESSAGE',
        content: 'What does glucose trend mean?',
        idempotency_key: 'direct-response-replay-message',
      });
      const replay = await api.submitAnswer(principal, freshPatientId, conversationId, {
        message_type: 'USER_MESSAGE',
        content: 'What does glucose trend mean?',
        idempotency_key: 'direct-response-replay-message',
      });

      expect(first.decision).toBe('DIRECT_RESPONSE');
      expect(replay.decision).toBe('DIRECT_RESPONSE');

      const userMessage = await pool.query<{ id: string; count: string }>(
        `
          SELECT MIN(id::text) AS id, count(*)::text AS count
          FROM messages
          WHERE conversation_id = $1::uuid
            AND idempotency_key = $2
        `,
        [conversationId, 'direct-response-replay-message'],
      );
      expect(Number(userMessage.rows[0].count)).toBe(1);

      const directJobs = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM jobs WHERE job_type = 'conversation.direct_response' AND payload->>'conversation_id' = $1`,
        [conversationId],
      );
      expect(Number(directJobs.rows[0].count)).toBe(1);

      await processUntilQueuedEmpty(workerA, pool);

      await repository.insertJob({
        jobType: 'conversation.direct_response',
        payloadVersion: 1,
        payload: {
          patient_id: freshPatientId,
          conversation_id: conversationId,
          user_message_id: String(userMessage.rows[0].id),
        },
        dedupeKey: `conversation.direct_response:manual-retry:${conversationId}`,
        correlationId: conversationId,
        causationId: conversationId,
        patientId: freshPatientId,
        availableAt: new Date().toISOString(),
        maxAttempts: 5,
      });

      await processUntilQueuedEmpty(workerA, pool);

      const assistantRows = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1::uuid AND message_type = 'ASSISTANT_MESSAGE'`,
        [conversationId],
      );
      const aiExecutions = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ai_executions WHERE correlation_id = $1 AND task_type = 'CONVERSATION_DIRECT_RESPONSE'`,
        [conversationId],
      );
      expect(Number(assistantRows.rows[0].count)).toBe(1);
      expect(Number(aiExecutions.rows[0].count)).toBe(1);
    } finally {
      await pool.query(`DELETE FROM jobs WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM messages WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM conversations WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM ai_execution_attempts WHERE ai_execution_id IN (SELECT id FROM ai_executions WHERE patient_id = $1)`, [freshPatientId]);
      await pool.query(`DELETE FROM ai_executions WHERE patient_id = $1`, [freshPatientId]);
      await pool.query(`DELETE FROM investigations WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM patients WHERE id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM caregiver_relationships WHERE patient_id = $1::uuid AND user_id = $2::uuid`, [freshPatientId, freshUserId]);
      await pool.query(`DELETE FROM users WHERE id = $1::uuid`, [freshUserId]);
    }
  });

  it('preserves retryable AI failure semantics for direct-response jobs and still avoids duplicate assistant output after retry', async () => {
    const freshPatientId = randomUUID();
    const freshUserId = randomUUID();
    const principal = { user_id: freshUserId } as any;

    try {
      await ensureActors(pool, freshUserId, freshPatientId);
      const created = await api.createConversation(principal, freshPatientId, 'direct-response-failure-conversation');
      const conversationId = String(created.conversation.id);

      await api.submitAnswer(principal, freshPatientId, conversationId, {
        message_type: 'USER_MESSAGE',
        content: 'What does this glucose trend indicate?',
        idempotency_key: 'direct-response-failure-message',
      });

      await workerFlakyDirectResponse.processOnce();

      const failedThenRetried = await pool.query<{ status: string; attempts: number }>(
        `SELECT status, attempts FROM jobs WHERE job_type = 'conversation.direct_response' AND payload->>'conversation_id' = $1 ORDER BY created_at DESC LIMIT 1`,
        [conversationId],
      );
      expect(failedThenRetried.rows[0].status).toBe('queued');
      expect(Number(failedThenRetried.rows[0].attempts)).toBeGreaterThanOrEqual(1);

      // Retryable failure requeues with backoff; make it immediately runnable for deterministic test execution.
      await pool.query(
        `UPDATE jobs SET available_at = now() WHERE job_type = 'conversation.direct_response' AND payload->>'conversation_id' = $1`,
        [conversationId],
      );

      await processUntilQueuedEmpty(workerA, pool);

      const assistantRows = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1::uuid AND message_type = 'ASSISTANT_MESSAGE'`,
        [conversationId],
      );
      expect(Number(assistantRows.rows[0].count)).toBe(1);
    } finally {
      await pool.query(`DELETE FROM jobs WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM messages WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM conversations WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM ai_execution_attempts WHERE ai_execution_id IN (SELECT id FROM ai_executions WHERE patient_id = $1)`, [freshPatientId]);
      await pool.query(`DELETE FROM ai_executions WHERE patient_id = $1`, [freshPatientId]);
      await pool.query(`DELETE FROM investigations WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM patients WHERE id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM caregiver_relationships WHERE patient_id = $1::uuid AND user_id = $2::uuid`, [freshPatientId, freshUserId]);
      await pool.query(`DELETE FROM users WHERE id = $1::uuid`, [freshUserId]);
    }
  });

  it('routes a caregiver data question to the time-range analysis, not to a direct response or a user investigation', async () => {
    const freshPatientId = randomUUID();
    const freshUserId = randomUUID();
    const principal = { user_id: freshUserId } as any;

    try {
      await ensureActors(pool, freshUserId, freshPatientId);
      const created = await api.createConversation(principal, freshPatientId, 'investigation-regression-conversation');
      const conversationId = String(created.conversation.id);

      const response = await api.submitAnswer(principal, freshPatientId, conversationId, {
        message_type: 'USER_MESSAGE',
        content: 'Dlaczego po obiedzie cukier rósł przez 4 godziny?',
        idempotency_key: 'investigation-regression-message',
      });
      expect(response.decision).toBe('ANALYSIS_REQUEST');

      const analysisJobs = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM jobs WHERE job_type = 'conversation.time_range_analysis' AND correlation_id = $1::uuid`,
        [conversationId],
      );
      const userInvestigations = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM investigations WHERE conversation_id = $1::uuid`,
        [conversationId],
      );
      expect(Number(analysisJobs.rows[0].count)).toBe(1);
      expect(Number(userInvestigations.rows[0].count)).toBe(0);

      const directJobs = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM jobs WHERE job_type = 'conversation.direct_response' AND payload->>'conversation_id' = $1`,
        [conversationId],
      );
      const assistantRows = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1::uuid AND message_type = 'ASSISTANT_MESSAGE'`,
        [conversationId],
      );

      expect(Number(directJobs.rows[0].count)).toBe(0);
      expect(Number(assistantRows.rows[0].count)).toBe(0);
    } finally {
      await pool.query(`DELETE FROM jobs WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM context_questions WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM messages WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM conversations WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM investigations WHERE patient_id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM patients WHERE id = $1::uuid`, [freshPatientId]);
      await pool.query(`DELETE FROM caregiver_relationships WHERE patient_id = $1::uuid AND user_id = $2::uuid`, [freshPatientId, freshUserId]);
      await pool.query(`DELETE FROM users WHERE id = $1::uuid`, [freshUserId]);
    }
  });

  it('enforces a DB-level invariant of at most one OPEN question per conversation', async () => {
    const target = await createFreshHypoConversation({
      nightscoutRepository,
      nightscoutSync,
      pool,
      patientId,
    });

    await pool.query(
      `
        INSERT INTO context_questions (
          conversation_id, patient_id, question_id, question_type, question_text,
          reason, expected_information_gain, expected_answer_types, related_event_id, status
        ) VALUES ($1::uuid, $2::uuid, $3, 'CONTEXT_QUESTION', 'q1', 'manual', 'HIGH', '[]'::jsonb, $4::uuid, 'OPEN')
      `,
      [target.conversationId, patientId, 'manual-open-one', target.eventId],
    );

    await expect(
      pool.query(
        `
          INSERT INTO context_questions (
            conversation_id, patient_id, question_id, question_type, question_text,
            reason, expected_information_gain, expected_answer_types, related_event_id, status
          ) VALUES ($1::uuid, $2::uuid, $3, 'CONTEXT_QUESTION', 'q2', 'manual', 'HIGH', '[]'::jsonb, $4::uuid, 'OPEN')
        `,
        [target.conversationId, patientId, 'manual-open-two', target.eventId],
      ),
    ).rejects.toThrow(/context_questions_single_open_per_conversation_idx|duplicate key value/);
  });
 });
