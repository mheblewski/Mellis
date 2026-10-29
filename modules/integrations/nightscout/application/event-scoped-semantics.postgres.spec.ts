import 'dotenv/config';
import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
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
import { FakePushNotificationProvider } from '@modules/notifications/infrastructure/fake-push-notification-provider';
import { PushNotificationService } from '@modules/notifications/application/push-notification.service';
import { WorkerService } from '../../../../apps/worker/src/worker.service';
import { ApiService } from '../../../../apps/api/src/application/api.service';
import { createInvestigationCandidateFromQuestionId } from '@modules/context/application/investigation-policy';
import { truncatePublicTablesForIntegrationTests } from '@infra/db/postgres-test-isolation';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
})
class EventScopedSemanticsModule {}

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

async function ensureActors(pool: Pool, userId: string, patientId: string): Promise<void> {
  await pool.query(
    `
      INSERT INTO users (id, display_name)
      VALUES ($1::uuid, 'runtime-verifier')
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

async function processUntilQueuedEmpty(worker: WorkerService, pool: Pool, maxIterations = 60): Promise<void> {
  for (let i = 0; i < maxIterations; i += 1) {
    await worker.processOnce();
    const queued = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM jobs WHERE status = 'queued'`);
    if (Number(queued.rows[0].count) === 0) {
      return;
    }
  }
}

async function waitForPendingConversation(repository: PostgresGlucoMindRepository, patientId: string, maxIterations = 60): Promise<Record<string, unknown>> {
  for (let i = 0; i < maxIterations; i += 1) {
    // The question is asked once the episode has closed, so the conversation belongs to a CLOSED episode.
    const list = await repository.listHypoEpisodes(patientId, 'all', 10, null);
    const pending = list.items.find((item: any) => item.workflow_status === 'QUESTION_PENDING' && item.conversation_id) as any;
    if (pending?.conversation_id) {
      const conversation = await repository.getConversation(patientId, String(pending.conversation_id));
      if (conversation?.pending_question) {
        return conversation;
      }
    }
  }

  throw new Error('Timed out waiting for pending conversation');
}

describePostgres('event-scoped semantics (postgres)', { timeout: 120_000 }, () => {
  const userId = randomUUID();
  const patientOneId = randomUUID();
  const patientTwoId = randomUUID();

  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;
  let pool: Pool;
  let repository: PostgresGlucoMindRepository;
  let nightscoutRepository: PostgresNightscoutRepository;
  let api: ApiService;
  let worker: WorkerService;
  let nightscoutSync: NightscoutSyncService;

  async function resetSharedPostgresState(pool: Pool): Promise<void> {
    await truncatePublicTablesForIntegrationTests(pool);
  }

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(EventScopedSemanticsModule, { logger: ['error', 'warn'] });
    pool = app.get<Pool>(DATABASE_POOL);
    repository = app.get(PostgresGlucoMindRepository, { strict: false });
    nightscoutRepository = app.get(PostgresNightscoutRepository, { strict: false });
    const configService = app.get(ConfigService);

      await resetSharedPostgresState(pool);

    // Recent readings (the 30-minute freshness guard), each hypo followed by its recovery: a LIVE hypo asks the
    // caregiver only once it closes (first reading >= 70 mg/dL).
    const entriesByPatient = new Map<string, SyntheticEntry[]>();
    entriesByPatient.set(patientOneId, [
      syntheticEntry('hypo-1-low', patientOneId, 25, 68),
      syntheticEntry('hypo-1-close', patientOneId, 20, 110),
      syntheticEntry('hypo-2-low', patientOneId, 15, 66),
      syntheticEntry('hypo-2-close', patientOneId, 10, 110),
    ]);
    entriesByPatient.set(patientTwoId, [
      syntheticEntry('p2-hypo-low', patientTwoId, 25, 67),
      syntheticEntry('p2-hypo-close', patientTwoId, 20, 110),
    ]);

    nightscoutSync = new NightscoutSyncService(
      nightscoutRepository,
      repository,
      new QueueNightscoutClient(entriesByPatient),
    );
    api = new ApiService(repository);
    worker = new WorkerService(
      repository,
      nightscoutSync,
      configService,
      new AiGatewayService(new FakeAiProvider()),
      new PushNotificationService(new FakePushNotificationProvider()),
    );

    await ensureActors(pool, userId, patientOneId);
    await ensureActors(pool, userId, patientTwoId);

    await nightscoutSync.ensureNightscoutSource(patientOneId, 'https://nightscout.example.com');
    await nightscoutSync.ensureNightscoutSource(patientTwoId, 'https://nightscout.example.com');
  });

  afterAll(async () => {
    await resetSharedPostgresState(pool);
    await app.close();
  });

  it('rejects unregistered question ids and prevents candidate-derived patient_context persistence', async () => {
    const principal = { user_id: userId } as any;
    // Hypo conversations ask no question cards any more: answer into a caregiver conversation instead.
    const created = await api.createConversation(principal, patientOneId, 'unknown-question-conversation');
    const conversationId = String(created.conversation.id);
    const baselineContextCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM patient_context WHERE patient_id = $1::uuid`,
      [patientOneId],
    );

    await expect(
      api.submitAnswer(principal, patientOneId, conversationId, {
        question_id: 'not_registered_question',
        message_type: 'CONTEXT_ANSWER',
        answer: { type: 'YES' },
        idempotency_key: 'unknown-question-attempt',
      }),
    ).rejects.toThrow('Question not found');

    const afterContextCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM patient_context WHERE patient_id = $1::uuid`,
      [patientOneId],
    );
    expect(Number(afterContextCount.rows[0].count)).toBe(Number(baselineContextCount.rows[0].count));

    const unknownFactRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM patient_context WHERE patient_id = $1::uuid AND fact_key = 'not_registered_question'`,
      [patientOneId],
    );
    expect(Number(unknownFactRows.rows[0].count)).toBe(0);
  });

  it('enforces patient ownership consistency across triggers and patient_context references', async () => {
    const ownerPatientId = randomUUID();
    const foreignPatientId = randomUUID();
    const nowIso = new Date().toISOString();

    await ensureActors(pool, userId, ownerPatientId);
    await ensureActors(pool, userId, foreignPatientId);

    try {
      const ownerSourceId = randomUUID();
      const foreignSourceId = randomUUID();
      const ownerSourceRecordId = randomUUID();
      const foreignSourceRecordId = randomUUID();
      const ownerEventId = randomUUID();
      const foreignEventId = randomUUID();
      const ownerEpisodeId = randomUUID();
      const ownerEpisodeTriggerId = randomUUID();
      const ownerConversationId = randomUUID();

      await pool.query(
        `
          INSERT INTO sources (id, patient_id, source_system, source_key, source_version, metadata)
          VALUES ($1::uuid, $2::uuid, 'NIGHTSCOUT', $3, 'test.v1', '{}'::jsonb)
        `,
        [ownerSourceId, ownerPatientId, `owner-src-${ownerPatientId}`],
      );
      await pool.query(
        `
          INSERT INTO sources (id, patient_id, source_system, source_key, source_version, metadata)
          VALUES ($1::uuid, $2::uuid, 'NIGHTSCOUT', $3, 'test.v1', '{}'::jsonb)
        `,
        [foreignSourceId, foreignPatientId, `foreign-src-${foreignPatientId}`],
      );

      await pool.query(
        `
          INSERT INTO source_records (
            id, patient_id, source_id, source_system, source_record_id, natural_key, record_type, occurred_at, recorded_at,
            imported_at, payload_version, normalization_version, validity, raw_payload, provenance, canonical_hash
          ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, 'NIGHTSCOUT', $4, $5, 'cgm.entry', $6::timestamptz, $6::timestamptz,
            $6::timestamptz, 1, 'nightscout.entries.v1', 'VALID', '{}'::jsonb, '{}'::jsonb, $7
          )
        `,
        [ownerSourceRecordId, ownerPatientId, ownerSourceId, `owner-rec-${ownerPatientId}`, `owner-key-${ownerPatientId}`, nowIso, `owner-hash-${ownerPatientId}`],
      );
      await pool.query(
        `
          INSERT INTO source_records (
            id, patient_id, source_id, source_system, source_record_id, natural_key, record_type, occurred_at, recorded_at,
            imported_at, payload_version, normalization_version, validity, raw_payload, provenance, canonical_hash
          ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, 'NIGHTSCOUT', $4, $5, 'cgm.entry', $6::timestamptz, $6::timestamptz,
            $6::timestamptz, 1, 'nightscout.entries.v1', 'VALID', '{}'::jsonb, '{}'::jsonb, $7
          )
        `,
        [foreignSourceRecordId, foreignPatientId, foreignSourceId, `foreign-rec-${foreignPatientId}`, `foreign-key-${foreignPatientId}`, nowIso, `foreign-hash-${foreignPatientId}`],
      );

      await pool.query(
        `
          INSERT INTO events (id, patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload, event_version)
          VALUES ($1::uuid, $2::uuid, $3::uuid, 'GLUCOSE_READING_AVAILABLE', $4::timestamptz, $4::timestamptz, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1)
        `,
        [ownerEventId, ownerPatientId, ownerSourceRecordId, nowIso],
      );
      await pool.query(
        `
          INSERT INTO events (id, patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload, event_version)
          VALUES ($1::uuid, $2::uuid, $3::uuid, 'GLUCOSE_READING_AVAILABLE', $4::timestamptz, $4::timestamptz, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1)
        `,
        [foreignEventId, foreignPatientId, foreignSourceRecordId, nowIso],
      );

      await pool.query(
        `
          INSERT INTO hypo_episodes (
            id, patient_id, trigger_id, start_event_id, analysis_id, recommendation_id, state, severity, started_at,
            ended_at, latest_event_id, rule_version
          ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, NULL, NULL, 'OPEN', 'L1', $5::timestamptz,
            NULL, $4::uuid, 'hypo.cgm.ada2026.v1'
          )
        `,
        [ownerEpisodeId, ownerPatientId, ownerEpisodeTriggerId, ownerEventId, nowIso],
      );

      await pool.query(
        `
          INSERT INTO conversations (id, patient_id, episode_id, thread_state_version, awaiting_user_answer, conversation_type)
          VALUES ($1::uuid, $2::uuid, $3::uuid, 'conv-v1', true, 'TRIGGER_INITIATED')
        `,
        [ownerConversationId, ownerPatientId, ownerEpisodeId],
      );

      await expect(
        pool.query(
          `
            INSERT INTO triggers (id, patient_id, type, source_event_id, episode_id, rule_version, status, cooldown_seconds)
            VALUES ($1::uuid, $2::uuid, 'HYPO_DETECTED', $3::uuid, $4::uuid, 'hypo.cgm.ada2026.v1', 'OPEN', 0)
          `,
          [randomUUID(), ownerPatientId, foreignEventId, ownerEpisodeId],
        ),
      ).rejects.toThrow(/triggers_source_event_patient_fk/);

      await expect(
        pool.query(
          `
            INSERT INTO patient_context (
              patient_id, fact_key, fact_name, fact_type, scope, value, value_type, knowledge_status,
              source_type, source_ref, source_event_id, source_conversation_id, source_question_id,
              related_episode_id, related_trigger_id, observed_at, recorded_at, confidence, validity,
              created_by, status
            ) VALUES (
              $1::uuid, 'activity_before_drop', 'Activity before drop', 'CAREGIVER_CONTEXT', 'EVENT', 'true'::jsonb, 'BOOLEAN', 'KNOWN',
              'USER_REPORT', 'test/source', $2::uuid, $3::uuid, 'activity_before_drop',
              NULL, NULL, $4::timestamptz, $4::timestamptz, 'HIGH', 'VALID',
              'audit-test', 'ACTIVE'
            )
          `,
          [ownerPatientId, foreignEventId, ownerConversationId, nowIso],
        ),
      ).rejects.toThrow(/patient_context_source_event_patient_fk/);
    } finally {
      await pool.query('DELETE FROM patients WHERE id = ANY($1::uuid[])', [[ownerPatientId, foreignPatientId]]);
    }
  });

  it('rejects invalid patient_context semantic values via check constraints', async () => {
    const patientId = randomUUID();
    const nowIso = new Date().toISOString();
    await ensureActors(pool, userId, patientId);

    try {
      const sourceId = randomUUID();
      const sourceRecordId = randomUUID();
      const eventId = randomUUID();
      const episodeId = randomUUID();
      const episodeTriggerId = randomUUID();
      const conversationId = randomUUID();

      await pool.query(
        `
          INSERT INTO sources (id, patient_id, source_system, source_key, source_version, metadata)
          VALUES ($1::uuid, $2::uuid, 'NIGHTSCOUT', $3, 'test.v1', '{}'::jsonb)
        `,
        [sourceId, patientId, `src-${patientId}`],
      );

      await pool.query(
        `
          INSERT INTO source_records (
            id, patient_id, source_id, source_system, source_record_id, natural_key, record_type, occurred_at, recorded_at,
            imported_at, payload_version, normalization_version, validity, raw_payload, provenance, canonical_hash
          ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, 'NIGHTSCOUT', $4, $5, 'cgm.entry', $6::timestamptz, $6::timestamptz,
            $6::timestamptz, 1, 'nightscout.entries.v1', 'VALID', '{}'::jsonb, '{}'::jsonb, $7
          )
        `,
        [sourceRecordId, patientId, sourceId, `rec-${patientId}`, `key-${patientId}`, nowIso, `hash-${patientId}`],
      );

      await pool.query(
        `
          INSERT INTO events (id, patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload, event_version)
          VALUES ($1::uuid, $2::uuid, $3::uuid, 'GLUCOSE_READING_AVAILABLE', $4::timestamptz, $4::timestamptz, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1)
        `,
        [eventId, patientId, sourceRecordId, nowIso],
      );

      await pool.query(
        `
          INSERT INTO hypo_episodes (
            id, patient_id, trigger_id, start_event_id, analysis_id, recommendation_id, state, severity, started_at,
            ended_at, latest_event_id, rule_version
          ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, NULL, NULL, 'OPEN', 'L1', $5::timestamptz,
            NULL, $4::uuid, 'hypo.cgm.ada2026.v1'
          )
        `,
        [episodeId, patientId, episodeTriggerId, eventId, nowIso],
      );

      await pool.query(
        `
          INSERT INTO conversations (id, patient_id, episode_id, thread_state_version, awaiting_user_answer, conversation_type)
          VALUES ($1::uuid, $2::uuid, $3::uuid, 'conv-v1', true, 'TRIGGER_INITIATED')
        `,
        [conversationId, patientId, episodeId],
      );

      const makeInsert = (scope: string, knowledgeStatus: string, validity: string, status: string, valueType: string, suffix: string) => pool.query(
        `
          INSERT INTO patient_context (
            patient_id, fact_key, fact_name, fact_type, scope, value, value_type, knowledge_status,
            source_type, source_ref, source_event_id, source_conversation_id, source_question_id,
            related_episode_id, related_trigger_id, observed_at, recorded_at, confidence, validity,
            created_by, status
          ) VALUES (
            $1::uuid, 'activity_before_drop', 'Activity before drop', 'CAREGIVER_CONTEXT', $2, 'true'::jsonb, $3, $4,
            'USER_REPORT', $5, $6::uuid, $7::uuid, $8,
            NULL, NULL, $9::timestamptz, $9::timestamptz, 'HIGH', $10,
            'audit-test', $11
          )
        `,
        [patientId, scope, valueType, knowledgeStatus, `test/source/${suffix}`, eventId, conversationId, `q-${suffix}`, nowIso, validity, status],
      );

      await expect(makeInsert('PATIENT', 'KNOWN', 'VALID', 'ACTIVE', 'BOOLEAN', 'scope')).rejects.toThrow(/patient_context_scope_check/);
      await expect(makeInsert('EVENT', 'MAYBE', 'VALID', 'ACTIVE', 'BOOLEAN', 'knowledge')).rejects.toThrow(/patient_context_knowledge_status_check/);
      await expect(makeInsert('EVENT', 'KNOWN', 'BROKEN', 'ACTIVE', 'BOOLEAN', 'validity')).rejects.toThrow(/patient_context_validity_check/);
      await expect(makeInsert('EVENT', 'KNOWN', 'VALID', 'PENDING', 'BOOLEAN', 'status')).rejects.toThrow(/patient_context_status_check/);
      await expect(makeInsert('EVENT', 'KNOWN', 'VALID', 'ACTIVE', 'NUMBER', 'value-type')).rejects.toThrow(/patient_context_value_type_check/);
    } finally {
      await pool.query('DELETE FROM patients WHERE id = $1::uuid', [patientId]);
    }
  });
});
