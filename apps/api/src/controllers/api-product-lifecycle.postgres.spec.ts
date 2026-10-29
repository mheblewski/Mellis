import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { validateApiEnvironment } from '@infra/config/environment';
import { DatabaseModule } from '@infra/db/database.module';
import { configurePostgresIntegrationEnvironment, truncatePublicTablesForIntegrationTests } from '@infra/db/postgres-test-isolation';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { AiGatewayService } from '@modules/ai-gateway/application/ai-gateway.service';
import { AiProvider, AiProviderInput, AiProviderResponse } from '@modules/ai-gateway/domain/ai-gateway';
import { OpenAiProvider, OpenAiResponsesClient } from '@modules/ai-gateway/infrastructure/openai-provider';
import { FakeAiProvider } from '@modules/ai-gateway/infrastructure/fake-ai-provider';
import { PushNotificationService } from '@modules/notifications/application/push-notification.service';
import { FakePushNotificationProvider } from '@modules/notifications/infrastructure/fake-push-notification-provider';
import { WorkerService } from '../../../worker/src/worker.service';
import { ApiService } from '../application/api.service';
import { BearerPrincipalGuard } from '../auth/bearer-principal.guard';
import { MeController } from './me.controller';
import { PatientController } from './patient.controller';

process.env.COGNITO_USER_POOL_ID ??= 'eu-central-1_test';
process.env.COGNITO_CLIENT_ID ??= 'test-client-id';
process.env.COGNITO_TOKEN_USE ??= 'access';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

function isoNow(): string {
  return new Date().toISOString();
}

async function seedPatientAndUser(pool: Pool, userId: string, patientId: string, displayName = 'patient-demo'): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, display_name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING`,
    [userId, `user-${userId.slice(0, 8)}`],
  );

  await pool.query(
    `INSERT INTO patients (id, display_name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING`,
    [patientId, displayName],
  );
}

async function seedRelationship(pool: Pool, userId: string, patientId: string, type = 'CAREGIVER'): Promise<void> {
  await pool.query(
    `INSERT INTO caregiver_relationships (id, user_id, patient_id, relationship_type, permissions)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '{}'::jsonb)
     ON CONFLICT (user_id, patient_id, relationship_type) DO NOTHING`,
    [randomUUID(), userId, patientId, type],
  );
}

async function seedCurrentState(pool: Pool, patientId: string, snapshot: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO current_states (id, patient_id, state_version, as_of, snapshot)
     VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, $5::jsonb)
     ON CONFLICT (patient_id, state_version) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = now()`,
    [randomUUID(), patientId, 'current-state.v1', isoNow(), JSON.stringify(snapshot)],
  );
}

async function seedTodayEventSample(pool: Pool, patientId: string): Promise<void> {
  const sourceId = randomUUID();
  const now = new Date();
  const eventA = new Date(now.getTime() - 90 * 60 * 1000).toISOString();
  const eventB = new Date(now.getTime() - 50 * 60 * 1000).toISOString();
  const eventC = new Date(now.getTime() - 20 * 60 * 1000).toISOString();

  await pool.query(
    `
      INSERT INTO sources (id, patient_id, source_system, source_key, metadata)
      VALUES ($1::uuid, $2::uuid, 'NIGHTSCOUT', $3, '{}'::jsonb)
      ON CONFLICT (patient_id, source_system, source_key) DO NOTHING
    `,
    [sourceId, patientId, `nightscout:${patientId}:${sourceId}`],
  );

  const rows = [
    {
      sourceRecordId: randomUUID(),
      eventId: randomUUID(),
      occurredAt: eventA,
      type: 'GLUCOSE_READING_AVAILABLE',
      payload: { glucose_value: 164, glucose_unit: 'mg/dL' },
    },
    {
      sourceRecordId: randomUUID(),
      eventId: randomUUID(),
      occurredAt: eventB,
      type: 'BOLUS',
      payload: { insulin: 1.2, unit: 'U' },
    },
    {
      sourceRecordId: randomUUID(),
      eventId: randomUUID(),
      occurredAt: eventC,
      type: 'CARB_ENTRY',
      payload: { carbs: 18, unit: 'g' },
    },
  ];

  for (const row of rows) {
    await pool.query(
      `
        INSERT INTO source_records (
          id, patient_id, source_id, source_system, source_record_id, natural_key, record_type,
          occurred_at, recorded_at, imported_at, raw_payload, provenance, canonical_hash
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, 'NIGHTSCOUT', $4, $5, $6,
          $7::timestamptz, $7::timestamptz, $7::timestamptz, $8::jsonb, '{}'::jsonb, $9
        ) ON CONFLICT (source_id, natural_key) DO NOTHING
      `,
      [
        row.sourceRecordId,
        patientId,
        sourceId,
        `record-${row.sourceRecordId}`,
        `nightscout:${patientId}:${row.sourceRecordId}`,
        row.type.toLowerCase(),
        row.occurredAt,
        JSON.stringify(row.payload),
        `canon:${row.sourceRecordId}`,
      ],
    );

    await pool.query(
      `
        INSERT INTO events (
          id, patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $5::timestamptz, '{}'::jsonb, '{}'::jsonb, $6::jsonb
        ) ON CONFLICT (id) DO NOTHING
      `,
      [row.eventId, patientId, row.sourceRecordId, row.type, row.occurredAt, JSON.stringify(row.payload)],
    );
  }
}

async function seedOutOfRangeEventSample(pool: Pool, patientId: string, eventId: string): Promise<void> {
  const sourceId = randomUUID();
  const staleAt = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const sourceRecordId = randomUUID();

  await pool.query(
    `
      INSERT INTO sources (id, patient_id, source_system, source_key, metadata)
      VALUES ($1::uuid, $2::uuid, 'NIGHTSCOUT', $3, '{}'::jsonb)
      ON CONFLICT (patient_id, source_system, source_key) DO NOTHING
    `,
    [sourceId, patientId, `nightscout:${patientId}:stale-${sourceRecordId}`],
  );

  await pool.query(
    `
      INSERT INTO source_records (
        id, patient_id, source_id, source_system, source_record_id, natural_key, record_type,
        occurred_at, recorded_at, imported_at, raw_payload, provenance, canonical_hash
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, 'NIGHTSCOUT', $4, $5, 'carb_entry',
        $6::timestamptz, $6::timestamptz, $6::timestamptz, $7::jsonb, '{}'::jsonb, $8
      ) ON CONFLICT (source_id, natural_key) DO NOTHING
    `,
    [sourceRecordId, patientId, sourceId, `record-${sourceRecordId}`, `nightscout:${patientId}:${sourceRecordId}`, staleAt, JSON.stringify({ carbs: 99, unit: 'g' }), `canon:${sourceRecordId}`],
  );

  await pool.query(
    `
      INSERT INTO events (
        id, patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, 'CARB_ENTRY', $4::timestamptz, $4::timestamptz, '{}'::jsonb, '{}'::jsonb, $5::jsonb
      ) ON CONFLICT (id) DO NOTHING
    `,
    [eventId, patientId, sourceRecordId, staleAt, JSON.stringify({ carbs: 99, unit: 'g' })],
  );
}

function createAiGatewayForTest(): AiGatewayService {
  const mode = String(process.env.E2E_AI_PROVIDER ?? 'fake').toLowerCase();
  if (mode === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required when E2E_AI_PROVIDER=openai');
    }

    return new AiGatewayService(new OpenAiProvider({
      apiKey,
      model: process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-terra',
      timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS ?? '30000'),
    }));
  }

  return new AiGatewayService(new FakeAiProvider());
}

function createPricedOpenAiGatewayForTest(): AiGatewayService {
  const mockClient: OpenAiResponsesClient = {
    responses: {
      create: async () => ({
        output_text: JSON.stringify({
          assistant_message: 'To jest odpowiedz testowa z cennikiem OpenAI.',
        }),
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          total_tokens: 1500,
          input_tokens_details: {
            cached_tokens: 100,
          },
          output_tokens_details: {
            reasoning_tokens: 50,
          },
        },
      }),
    },
  };

  return new AiGatewayService(new OpenAiProvider({
    apiKey: 'sk-test',
    model: 'gpt-5.6-terra',
    timeoutMs: 5_000,
    pricing: {
      input_per_1k_tokens: 0.01,
      output_per_1k_tokens: 0.02,
      cached_input_per_1k_tokens: 0.005,
      reasoning_per_1k_tokens: 0.007,
      currency: 'USD',
      pricing_version: 'openai.pricing.test.v1',
    },
  }, mockClient));
}
class CapturingAiProvider implements AiProvider {
  readonly capturedInputs: AiProviderInput[] = [];

  constructor(private readonly delegate: AiProvider) {}

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    const snapshot = JSON.parse(JSON.stringify(input)) as AiProviderInput;
    this.capturedInputs.push(snapshot);
    return this.delegate.generate(input);
  }
}


async function processWorkerUntil(
  worker: WorkerService,
  predicate: () => Promise<boolean>,
  maxIterations = 40,
): Promise<void> {
  for (let i = 0; i < maxIterations; i += 1) {
    if (await predicate()) {
      return;
    }

    await worker.processOnce();
  }
}

async function seedEpisodeConversation(pool: Pool, patientId: string) {
  const sourceId = randomUUID();
  const sourceRecordId = randomUUID();
  const eventId = randomUUID();
  const episodeId = randomUUID();
  const triggerId = randomUUID();
  const conversationId = randomUUID();
  const questionId = 'activity_before_drop';
  const questionRowId = randomUUID();
  const now = isoNow();

  await pool.query(
    `INSERT INTO sources (id, patient_id, source_system, source_key, metadata)
     VALUES ($1::uuid, $2::uuid, 'NIGHTSCOUT', $3, '{}'::jsonb)
     ON CONFLICT (patient_id, source_system, source_key) DO NOTHING`,
    [sourceId, patientId, `nightscout:${patientId}:${sourceRecordId}`],
  );

  await pool.query(
    `INSERT INTO source_records (
      id, patient_id, source_id, source_system, source_record_id, natural_key, record_type,
      occurred_at, recorded_at, imported_at, raw_payload, provenance, canonical_hash
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, 'NIGHTSCOUT', $4, $5, 'cgm.entry',
      $6::timestamptz, $6::timestamptz, $6::timestamptz, $7::jsonb, '{}'::jsonb, $8
    ) ON CONFLICT (source_id, natural_key) DO NOTHING`,
    [sourceRecordId, patientId, sourceId, `record-${sourceRecordId}`, `nightscout:${patientId}:${sourceRecordId}`, now, JSON.stringify({ sgv: 72 }), `canon:${sourceRecordId}`],
  );

  await pool.query(
    `INSERT INTO events (
      id, patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, 'GLUCOSE_READING_AVAILABLE',
      $4::timestamptz, $4::timestamptz, '{}'::jsonb, '{}'::jsonb, $5::jsonb
    ) ON CONFLICT (id) DO NOTHING`,
    [eventId, patientId, sourceRecordId, now, JSON.stringify({ glucose_value: 72 })],
  );

  await pool.query(
    `INSERT INTO hypo_episodes (
      id, patient_id, trigger_id, start_event_id, state, severity, started_at, latest_event_id, rule_version
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'OPEN', 'L1', $5::timestamptz, $4::uuid, 'hypo.cgm.ada2026.v1'
    ) ON CONFLICT (patient_id, start_event_id) DO NOTHING`,
    [episodeId, patientId, triggerId, eventId, now],
  );

  await pool.query(
    `INSERT INTO triggers (
      id, patient_id, type, source_event_id, episode_id, rule_version, status, cooldown_seconds
    ) VALUES (
      $1::uuid, $2::uuid, 'HYPO_DETECTED', $3::uuid, $4::uuid, 'hypo.cgm.ada2026.v1', 'OPEN', 0
    ) ON CONFLICT (patient_id, type, source_event_id, rule_version) DO NOTHING`,
    [triggerId, patientId, eventId, episodeId],
  );

  await pool.query(
    `INSERT INTO conversations (
      id, patient_id, episode_id, trigger_id, origin, trigger_type, thread_state_version, awaiting_user_answer, conversation_type, client_request_id
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SYSTEM', 'HYPO_DETECTED', 'thread.v1', true, 'TRIGGER_INITIATED', $5
    ) ON CONFLICT (patient_id, episode_id) DO NOTHING`,
    [conversationId, patientId, episodeId, triggerId, `seed:${conversationId}`],
  );

  await pool.query(
    `INSERT INTO context_questions (
      id, conversation_id, patient_id, question_id, question_type, question_text, reason,
      expected_information_gain, expected_answer_types, related_event_id, status
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4, 'CONTEXT_QUESTION', 'Was there activity before the drop?',
      'Need to clarify the trigger context', 'HIGH', '[]'::jsonb, $5::uuid, 'OPEN'
    ) ON CONFLICT (conversation_id, question_id) DO NOTHING`,
    [questionRowId, conversationId, patientId, questionId, eventId],
  );

  await pool.query(
    `INSERT INTO messages (
      id, conversation_id, patient_id, role, message_type, content, question_id, provenance_ref, idempotency_key
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, 'SYSTEM', 'CONTEXT_QUESTION', 'Was there activity before the drop?', $4, $5, $6
    ) ON CONFLICT (conversation_id, idempotency_key) DO NOTHING`,
    [randomUUID(), conversationId, patientId, questionId, `trigger/${triggerId}/question/${questionId}`, `context-question:${conversationId}:${eventId}:${questionId}`],
  );

  return { conversationId, episodeId, triggerId, eventId, questionId };
}

async function seedAnalysisAndRecommendation(pool: Pool, patientId: string, episodeId: string, triggerId: string, conversationId: string, questionId: string) {
  const analysisId = randomUUID();
  const recommendationId = randomUUID();
  const contextPackageId = randomUUID();
  const now = isoNow();

  await pool.query(
    `INSERT INTO analyses (
      id, patient_id, episode_id, trigger_id, task_type, status,
      facts, unknowns, calculations, hypotheses, assumptions, uncertainty,
      question, proposal, rationale, analysis_version, context_package_id,
      context_package_version, context_package_hash, input_hash, prompt_version,
      model_fingerprint
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'USER_INVESTIGATION_FOLLOW_UP', 'COMPLETED',
      $5::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
      $6::jsonb, $7::jsonb, 'Persisted analysis', 'analysis.v1.1', $8::uuid,
      'context-package.v1', 'sha256:analysis-1', 'sha256:input-1', 'hypo-analysis.v1', 'test-model'
    ) ON CONFLICT (patient_id, episode_id, task_type, context_package_hash) DO NOTHING`,
    [
      analysisId,
      patientId,
      episodeId,
      triggerId,
      JSON.stringify([{ fact_id: 'fact.analysis.v1', statement: 'Hypo event requires context.', source_refs: [conversationId] }]),
      JSON.stringify({ question_id: questionId, text: 'Was there activity before the drop?', expected_answer_types: ['YES', 'NO', 'UNKNOWN'] }),
      JSON.stringify({ type: 'FOLLOW_UP_QUESTION', title: 'Clarify context', text: 'Ask for missing activity context.' }),
      contextPackageId,
    ],
  );

  await pool.query(
    `INSERT INTO recommendations (
      id, patient_id, analysis_id, episode_id, status, facts, unknowns, calculations, hypotheses,
      proposal, evidence, provenance
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'NO_ACTIONABLE_RECOMMENDATION',
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
      $5::jsonb, '[]'::jsonb, $6::jsonb
    ) ON CONFLICT (analysis_id) DO NOTHING`,
    [
      recommendationId,
      patientId,
      analysisId,
      episodeId,
      JSON.stringify({ recommendation_type: 'NO_ACTION', title: 'No action', text: 'No action is recommended.' }),
      JSON.stringify({ recommendation_status: 'NO_ACTIONABLE_RECOMMENDATION', analysis_id: analysisId }),
    ],
  );

  await pool.query(
    `UPDATE conversations SET analysis_id = $1::uuid, recommendation_id = $2::uuid, updated_at = $3::timestamptz WHERE id = $4::uuid`,
    [analysisId, recommendationId, now, conversationId],
  );

  await pool.query(
    `UPDATE hypo_episodes SET analysis_id = $1::uuid, recommendation_id = $2::uuid, updated_at = $3::timestamptz WHERE id = $4::uuid`,
    [analysisId, recommendationId, now, episodeId],
  );

  return { analysisId, recommendationId };
}

describePostgres('API product lifecycle proof (postgres)', { timeout: 120_000 }, () => {
  let app: INestApplication;
  let pool: Pool;
  let authTokens: Map<string, string>;

  beforeAll(async () => {
    configurePostgresIntegrationEnvironment(process.env);
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required for Postgres API lifecycle tests');
    }

    pool = new Pool({ connectionString: databaseUrl });
    app = (await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateApiEnvironment }), DatabaseModule],
      controllers: [PatientController, MeController],
      providers: [ApiService, BearerPrincipalGuard],
    })
      .overrideGuard(BearerPrincipalGuard)
      .useValue({
        async canActivate(context: any): Promise<boolean> {
          const request = context.switchToHttp().getRequest();
          const authorization = request.headers.authorization;
          const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
          if (!token) {
            throw new UnauthorizedException('Missing bearer token');
          }

          const userId = authTokens.get(token);
          if (!userId) {
            throw new UnauthorizedException('Invalid bearer token');
          }

          request.principal = { user_id: userId, auth_provider: 'COGNITO', auth_subject: `fixture:${userId}` };
          return true;
        },
      })
      .compile()).createNestApplication();

    await app.init();
  });

  beforeEach(async () => {
    authTokens = new Map<string, string>();
    await truncatePublicTablesForIntegrationTests(pool);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('lists accessible patients and denies patient-scoped access by auth state', async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    const patientA = randomUUID();
    const patientB = randomUUID();
    authTokens.set('user-a', userA);
    authTokens.set('user-b', userB);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedPatientAndUser(pool, userB, patientB, 'patient-b');
    await seedRelationship(pool, userA, patientA);
    await seedRelationship(pool, userB, patientB);
    await seedCurrentState(pool, patientA, { status: 'OK', patient_id: String(patientA) });
    await seedCurrentState(pool, patientB, { status: 'OK', patient_id: String(patientB) });

    const listRes = await request(app.getHttpServer())
      .get('/v1/me/patients')
      .set('Authorization', 'Bearer user-a')
      .expect(200);

    expect(listRes.body.user_id).toBe(userA);
    expect(listRes.body.user_display_name).toBe(`user-${userA.slice(0, 8)}`);
    const patientIds = listRes.body.patients.map((row: { patient_id: string }) => row.patient_id);
    expect(patientIds).toEqual(expect.arrayContaining([patientA]));
    expect(patientIds).not.toContain(patientB);

    const allowedState = await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/pending-investigation`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);
    expect(allowedState.body.patient_id).toBe(patientA);

    const deniedState = await request(app.getHttpServer())
      .get(`/v1/patients/${patientB}/pending-investigation`)
      .set('Authorization', 'Bearer user-a')
      .expect(403);
    expect(deniedState.body.code).toBe('FORBIDDEN');

    await pool.query(`DELETE FROM caregiver_relationships WHERE user_id = $1::uuid AND patient_id = $2::uuid`, [userA, patientA]);

    const revokedList = await request(app.getHttpServer())
      .get('/v1/me/patients')
      .set('Authorization', 'Bearer user-a')
      .expect(200);
    expect(revokedList.body.patients.map((row: { patient_id: string }) => row.patient_id)).not.toContain(patientA);

    await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/pending-investigation`)
      .set('Authorization', 'Bearer user-a')
      .expect(403);
  });

  it('retrieves persisted conversation and pending question through the API with patient isolation', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    const patientB = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedPatientAndUser(pool, userA, patientB, 'patient-b');
    await seedRelationship(pool, userA, patientA);

    const seeded = await seedEpisodeConversation(pool, patientA);

    const res = await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/conversations/${seeded.conversationId}`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);

    expect(res.body.id).toBe(seeded.conversationId);
    expect(res.body.pending_question.question_id).toBe(seeded.questionId);
    expect(res.body.messages).toEqual(expect.any(Array));

    await request(app.getHttpServer())
      .get(`/v1/patients/${patientB}/conversations/${seeded.conversationId}`)
      .set('Authorization', 'Bearer user-a')
      .expect(403);

    await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/conversations/${randomUUID()}`)
      .set('Authorization', 'Bearer user-a')
      .expect(404);
  });

  it('retrieves a persisted recommendation through the API and enforces patient scope', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    const patientB = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedPatientAndUser(pool, userA, patientB, 'patient-b');
    await seedRelationship(pool, userA, patientA);

    const seeded = await seedEpisodeConversation(pool, patientA);
    const artifacts = await seedAnalysisAndRecommendation(pool, patientA, seeded.episodeId, seeded.triggerId, seeded.conversationId, seeded.questionId);

    const recommendation = await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/recommendations/${artifacts.recommendationId}`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);
    expect(recommendation.body.id).toBe(artifacts.recommendationId);
    expect(recommendation.body.proposal.recommendation_type).toBe('NO_ACTION');

    await request(app.getHttpServer())
      .get(`/v1/patients/${patientB}/recommendations/${artifacts.recommendationId}`)
      .set('Authorization', 'Bearer user-a')
      .expect(403);

    await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/recommendations/${randomUUID()}`)
      .set('Authorization', 'Bearer user-a')
      .expect(404);
  });

  it('creates user conversations idempotently and lists generic conversation history', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedRelationship(pool, userA, patientA);

    const created = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'conversation-create-1')
      .expect(201);

    const replay = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'conversation-create-1')
      .expect(200);

    expect(replay.body.conversation.id).toBe(created.body.conversation.id);
    expect(replay.body.conversation.origin).toBe('USER');
    expect(replay.body.conversation.episode_id).toBeNull();

    const seededHypo = await seedEpisodeConversation(pool, patientA);
    const listed = await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/conversations`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);

    expect(listed.body.patient_id).toBe(patientA);
    expect(listed.body.items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([created.body.conversation.id, seededHypo.conversationId]));

    const userConversation = listed.body.items.find((item: { id: string }) => item.id === created.body.conversation.id);
    expect(userConversation.origin).toBe('USER');

    const hypoConversation = listed.body.items.find((item: { id: string }) => item.id === seededHypo.conversationId);
    expect(hypoConversation.origin).toBe('SYSTEM');
    expect(hypoConversation.trigger_type).toBe('HYPO_DETECTED');
  });

  it('returns DIRECT_RESPONSE for a user message that is informational rather than investigative', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedRelationship(pool, userA, patientA);

    const createdConversation = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-direct-response-create')
      .expect(201);

    const result = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-direct-response-submit')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Co oznacza słowo insulin?',
      })
      .expect(200);

    expect(result.body.decision).toBe('DIRECT_RESPONSE');
    expect(result.body.conversation.awaiting_user_answer).toBe(false);

    const investigationRow = await pool.query(
      `SELECT * FROM investigations WHERE patient_id = $1 AND conversation_id = $2 LIMIT 1`,
      [patientA, createdConversation.body.conversation.id],
    );

    expect(investigationRow.rows[0]).toBeUndefined();
  });

  it('answers data-persistence follow-up as DIRECT_RESPONSE without triggering investigation artifacts', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedRelationship(pool, userA, patientA);

    const createdConversation = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'data-persistence-follow-up-create')
      .expect(201);

    const submit = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'data-persistence-follow-up-submit')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Czy zapiszesz ten posiłek do bazy czy będzie wykorzystywany tylko w tej rozmowie?',
      })
      .expect(200);

    expect(submit.body.decision).toBe('DIRECT_RESPONSE');
    expect(submit.body.conversation.awaiting_user_answer).toBe(false);

    const queuedDirect = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs WHERE patient_id = $1::uuid AND job_type = 'conversation.direct_response' AND payload->>'conversation_id' = $2`,
      [patientA, createdConversation.body.conversation.id],
    );
    const queuedTimeRange = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs WHERE patient_id = $1::uuid AND job_type = 'conversation.time_range_analysis' AND payload->>'conversation_id' = $2`,
      [patientA, createdConversation.body.conversation.id],
    );
    expect(Number(queuedDirect.rows[0].count)).toBe(1);
    expect(Number(queuedTimeRange.rows[0].count)).toBe(0);

    const repository = app.get(PostgresGlucoMindRepository);
    const configService = app.get(ConfigService);
    const worker = new WorkerService(
      repository,
      {
        ensureNightscoutSource: async () => ({ id: randomUUID(), patient_id: patientA }),
        getImportedReadingForEvent: async () => null,
        runNightscoutSyncJob: async () => ({ jobs_enqueued: 0, sources: 0, processed: 0 } as any),
        enqueueRecurringSyncJobs: async () => ({ sources: 0, jobs_enqueued: 0 }),
      } as any,
      configService,
      new AiGatewayService(new FakeAiProvider()),
      new PushNotificationService(new FakePushNotificationProvider()),
    );

    await processWorkerUntil(worker, async () => {
      const assistantAfterWorker = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1::uuid AND message_type = 'ASSISTANT_MESSAGE'`,
        [createdConversation.body.conversation.id],
      );
      return Number(assistantAfterWorker.rows[0].count) >= 1;
    });

    const assistant = await pool.query<{ content: string }>(
      `SELECT content FROM messages WHERE conversation_id = $1::uuid AND message_type = 'ASSISTANT_MESSAGE' ORDER BY created_at DESC LIMIT 1`,
      [createdConversation.body.conversation.id],
    );
    const assistantText = String(assistant.rows[0]?.content ?? '').toLowerCase();
    expect(assistantText).toContain('historii rozmowy');
    expect(assistantText).toContain('nie tworza automatycznie osobnego, ustrukturyzowanego rekordu posilku');

    const aiExecutions = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ai_executions WHERE patient_id = $1::text AND correlation_id = $2::text AND task_type = 'CONVERSATION_DIRECT_RESPONSE'`,
      [patientA, createdConversation.body.conversation.id],
    );
    const investigationRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM investigations WHERE patient_id = $1::uuid AND conversation_id = $2::uuid`,
      [patientA, createdConversation.body.conversation.id],
    );
    const questionRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM context_questions WHERE patient_id = $1::uuid AND conversation_id = $2::uuid`,
      [patientA, createdConversation.body.conversation.id],
    );
    const analysisRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM analyses WHERE patient_id = $1::uuid AND episode_id IS NULL`,
      [patientA],
    );
    const recommendationRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM recommendations WHERE patient_id = $1::uuid AND episode_id IS NULL`,
      [patientA],
    );

    expect(Number(aiExecutions.rows[0].count)).toBe(0);
    expect(Number(investigationRows.rows[0].count)).toBe(0);
    expect(Number(questionRows.rows[0].count)).toBe(0);
    expect(Number(analysisRows.rows[0].count)).toBe(0);
    expect(Number(recommendationRows.rows[0].count)).toBe(0);
  });

  it('keeps user conversation continuity after persistence follow-up and does not duplicate history on reload', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedRelationship(pool, userA, patientA);

    const createdConversation = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'continuity-after-persistence-create')
      .expect(201);

    const conversationId = String(createdConversation.body.conversation.id);
    const submitOne = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${conversationId}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'continuity-after-persistence-submit-1')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Czy zapiszesz ten posiłek do bazy czy będzie wykorzystywany tylko w tej rozmowie?',
      })
      .expect(200);
    expect(submitOne.body.decision).toBe('DIRECT_RESPONSE');

    const repository = app.get(PostgresGlucoMindRepository);
    const configService = app.get(ConfigService);
    const worker = new WorkerService(
      repository,
      {
        ensureNightscoutSource: async () => ({ id: randomUUID(), patient_id: patientA }),
        getImportedReadingForEvent: async () => null,
        runNightscoutSyncJob: async () => ({ jobs_enqueued: 0, sources: 0, processed: 0 } as any),
        enqueueRecurringSyncJobs: async () => ({ sources: 0, jobs_enqueued: 0 }),
      } as any,
      configService,
      new AiGatewayService(new FakeAiProvider()),
      new PushNotificationService(new FakePushNotificationProvider()),
    );

    await processWorkerUntil(worker, async () => {
      const assistantAfterWorker = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1::uuid AND message_type = 'ASSISTANT_MESSAGE'`,
        [conversationId],
      );
      return Number(assistantAfterWorker.rows[0].count) >= 1;
    });

    const submitTwo = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${conversationId}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'continuity-after-persistence-submit-2')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Co oznacza trend glikemii?',
      })
      .expect(200);
    expect(submitTwo.body.decision).toBe('DIRECT_RESPONSE');

    await processWorkerUntil(worker, async () => {
      const assistantAfterWorker = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1::uuid AND message_type = 'ASSISTANT_MESSAGE'`,
        [conversationId],
      );
      return Number(assistantAfterWorker.rows[0].count) >= 2;
    });

    const firstRead = await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/conversations/${conversationId}`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);
    const secondRead = await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/conversations/${conversationId}`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);

    const firstIds = (firstRead.body.messages as Array<{ id: string }>).map((message) => String(message.id));
    const secondIds = (secondRead.body.messages as Array<{ id: string }>).map((message) => String(message.id));

    expect(firstIds).toEqual(secondIds);
    expect(new Set(secondIds).size).toBe(secondIds.length);

    const assistantMessages = (secondRead.body.messages as Array<{ message_type: string }>).filter((message) => message.message_type === 'ASSISTANT_MESSAGE');
    const userMessages = (secondRead.body.messages as Array<{ message_type: string }>).filter((message) => message.message_type === 'USER_MESSAGE');
    expect(userMessages).toHaveLength(2);
    expect(assistantMessages).toHaveLength(2);
  });

  it('proves the API lifecycle contract for DIRECT_RESPONSE before and after the async worker processes the queued job', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedRelationship(pool, userA, patientA);

    const createdConversation = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-direct-lifecycle-create')
      .expect(201);

    const initial = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-direct-lifecycle-submit')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Co oznacza trend glikemii?',
      })
      .expect(200);

    expect(initial.body.decision).toBe('DIRECT_RESPONSE');
    expect(initial.body.conversation.awaiting_user_answer).toBe(false);

    const persistedUserMessage = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE conversation_id = $1::uuid AND idempotency_key = $2 AND message_type = 'USER_MESSAGE' LIMIT 1`,
      [createdConversation.body.conversation.id, 'user-message-direct-lifecycle-submit'],
    );
    expect(persistedUserMessage.rows[0]).toBeTruthy();
    const userMessageId = String(persistedUserMessage.rows[0].id);

    const directJobCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs WHERE patient_id = $1::uuid AND job_type = 'conversation.direct_response' AND payload->>'conversation_id' = $2 AND payload->>'user_message_id' = $3`,
      [patientA, createdConversation.body.conversation.id, userMessageId],
    );
    expect(Number(directJobCount.rows[0].count)).toBe(1);

    const investigationCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM investigations WHERE patient_id = $1::uuid AND conversation_id = $2::uuid`,
      [patientA, createdConversation.body.conversation.id],
    );
    const questionCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM context_questions WHERE patient_id = $1::uuid AND conversation_id = $2::uuid`,
      [patientA, createdConversation.body.conversation.id],
    );
    const analysisCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM analyses WHERE patient_id = $1::uuid`,
      [patientA],
    );
    const recommendationCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM recommendations WHERE patient_id = $1::uuid`,
      [patientA],
    );
    const assistantBeforeWorker = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1::uuid AND message_type = 'ASSISTANT_MESSAGE'`,
      [createdConversation.body.conversation.id],
    );

    expect(Number(investigationCount.rows[0].count)).toBe(0);
    expect(Number(questionCount.rows[0].count)).toBe(0);
    expect(Number(analysisCount.rows[0].count)).toBe(0);
    expect(Number(recommendationCount.rows[0].count)).toBe(0);
    expect(Number(assistantBeforeWorker.rows[0].count)).toBe(0);

    const repository = app.get(PostgresGlucoMindRepository);
    const configService = app.get(ConfigService);
    const worker = new WorkerService(
      repository,
      {
        ensureNightscoutSource: async () => ({ id: randomUUID(), patient_id: patientA }),
        getImportedReadingForEvent: async () => null,
        runNightscoutSyncJob: async () => ({ jobs_enqueued: 0, sources: 0, processed: 0 } as any),
        enqueueRecurringSyncJobs: async () => ({ sources: 0, jobs_enqueued: 0 }),
      } as any,
      configService,
      new AiGatewayService(new FakeAiProvider()),
      new PushNotificationService(new FakePushNotificationProvider()),
    );

    await processWorkerUntil(worker, async () => {
      const assistantAfterWorker = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1::uuid AND message_type = 'ASSISTANT_MESSAGE'`,
        [createdConversation.body.conversation.id],
      );
      return Number(assistantAfterWorker.rows[0].count) >= 1;
    });

    const assistantAfterWorker = await pool.query<{ id: string; provenance_ref: string | null; metadata: Record<string, unknown> }>(
      `SELECT id, provenance_ref, metadata FROM messages WHERE conversation_id = $1::uuid AND message_type = 'ASSISTANT_MESSAGE' LIMIT 1`,
      [createdConversation.body.conversation.id],
    );
    expect(assistantAfterWorker.rows[0]).toBeTruthy();
    expect(assistantAfterWorker.rows[0].provenance_ref).toMatch(/^ai-execution\//);

    const aiExecution = await pool.query<{
      id: string;
      task_type: string;
      patient_id: string;
      correlation_id: string;
      input_tokens: string | null;
      output_tokens: string | null;
      total_tokens: string | null;
      cached_input_tokens: string | null;
      reasoning_tokens: string | null;
      estimated_cost: string | null;
      pricing_version: string | null;
    }>(
      `SELECT id, task_type, patient_id, correlation_id, input_tokens::text, output_tokens::text, total_tokens::text, cached_input_tokens::text, reasoning_tokens::text, estimated_cost::text, pricing_version FROM ai_executions WHERE patient_id = $1::text AND task_type = 'CONVERSATION_DIRECT_RESPONSE' AND correlation_id = $2::text ORDER BY created_at DESC LIMIT 1`,
      [patientA, createdConversation.body.conversation.id],
    );
    expect(aiExecution.rows[0]).toBeTruthy();
    expect(aiExecution.rows[0].patient_id).toBe(patientA);
    expect(assistantAfterWorker.rows[0].metadata?.ai_execution_id).toBe(aiExecution.rows[0].id);
    expect(Number(aiExecution.rows[0].input_tokens ?? '0')).toBeGreaterThan(0);
    expect(Number(aiExecution.rows[0].output_tokens ?? '0')).toBeGreaterThan(0);
    expect(Number(aiExecution.rows[0].total_tokens ?? '0')).toBeGreaterThan(0);
    expect(Number(aiExecution.rows[0].total_tokens ?? '0')).toBe(
      Number(aiExecution.rows[0].input_tokens ?? '0') + Number(aiExecution.rows[0].output_tokens ?? '0'),
    );
    expect(aiExecution.rows[0].cached_input_tokens).toBeNull();
    expect(aiExecution.rows[0].reasoning_tokens).toBeNull();
    if (aiExecution.rows[0].estimated_cost === null) {
      expect(aiExecution.rows[0].pricing_version).toBeNull();
    }

    const aiAttempt = await pool.query<{
      attempt_number: string;
      status: string;
      input_tokens: string | null;
      output_tokens: string | null;
      total_tokens: string | null;
      cached_input_tokens: string | null;
      reasoning_tokens: string | null;
      estimated_cost: string | null;
      pricing_version: string | null;
    }>(
      `SELECT attempt_number::text, status, input_tokens::text, output_tokens::text, total_tokens::text, cached_input_tokens::text, reasoning_tokens::text, estimated_cost::text, pricing_version FROM ai_execution_attempts WHERE ai_execution_id = $1::uuid ORDER BY attempt_number ASC LIMIT 1`,
      [aiExecution.rows[0].id],
    );
    expect(aiAttempt.rows[0]).toBeTruthy();
    expect(aiAttempt.rows[0].status).toBe('SUCCEEDED');
    expect(Number(aiAttempt.rows[0].input_tokens ?? '0')).toBeGreaterThan(0);
    expect(Number(aiAttempt.rows[0].output_tokens ?? '0')).toBeGreaterThan(0);
    expect(Number(aiAttempt.rows[0].total_tokens ?? '0')).toBe(
      Number(aiAttempt.rows[0].input_tokens ?? '0') + Number(aiAttempt.rows[0].output_tokens ?? '0'),
    );
    expect(aiAttempt.rows[0].cached_input_tokens).toBeNull();
    expect(aiAttempt.rows[0].reasoning_tokens).toBeNull();
    if (aiAttempt.rows[0].estimated_cost === null) {
      expect(aiAttempt.rows[0].pricing_version).toBeNull();
    }

    const conversationAfterWorker = await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);

    const assistantFromApi = conversationAfterWorker.body.messages.find((message: { message_type: string }) => message.message_type === 'ASSISTANT_MESSAGE');
    expect(assistantFromApi).toBeTruthy();
    expect(assistantFromApi.ai_cost).toBeTruthy();
    expect(['KNOWN', 'UNKNOWN']).toContain(String(assistantFromApi.ai_cost.status));

    const userFromApi = conversationAfterWorker.body.messages.find((message: { message_type: string }) => message.message_type === 'USER_MESSAGE');
    expect(userFromApi).toBeTruthy();
    expect(userFromApi.ai_cost).toBeUndefined();

    const finalInvestigationCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM investigations WHERE patient_id = $1::uuid AND conversation_id = $2::uuid`,
      [patientA, createdConversation.body.conversation.id],
    );
    const finalQuestionCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM context_questions WHERE patient_id = $1::uuid AND conversation_id = $2::uuid`,
      [patientA, createdConversation.body.conversation.id],
    );
    const finalAnalysisCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM analyses WHERE patient_id = $1::uuid`,
      [patientA],
    );
    const finalRecommendationCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM recommendations WHERE patient_id = $1::uuid`,
      [patientA],
    );

    expect(Number(finalInvestigationCount.rows[0].count)).toBe(0);
    expect(Number(finalQuestionCount.rows[0].count)).toBe(0);
    expect(Number(finalAnalysisCount.rows[0].count)).toBe(0);
    expect(Number(finalRecommendationCount.rows[0].count)).toBe(0);

    const replay = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-direct-lifecycle-submit')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Co oznacza trend glikemii?',
      })
      .expect(200);

    expect(replay.body.decision).toBe('DIRECT_RESPONSE');

    const replayMessageCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1::uuid AND idempotency_key = $2 AND message_type = 'USER_MESSAGE'`,
      [createdConversation.body.conversation.id, 'user-message-direct-lifecycle-submit'],
    );
    const replayMessageRow = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM messages WHERE conversation_id = $1::uuid AND idempotency_key = $2 AND message_type = 'USER_MESSAGE' LIMIT 1`,
      [createdConversation.body.conversation.id, 'user-message-direct-lifecycle-submit'],
    );
    expect(Number(replayMessageCount.rows[0].count)).toBe(1);
    expect(String(replayMessageRow.rows[0].id)).toBe(userMessageId);

    const replayJobCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs WHERE patient_id = $1::uuid AND job_type = 'conversation.direct_response' AND payload->>'conversation_id' = $2`,
      [patientA, createdConversation.body.conversation.id],
    );
    const replayAiExecutionCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ai_executions WHERE patient_id = $1::text AND task_type = 'CONVERSATION_DIRECT_RESPONSE' AND correlation_id = $2::text`,
      [patientA, createdConversation.body.conversation.id],
    );
    const replayAssistantCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1::uuid AND message_type = 'ASSISTANT_MESSAGE'`,
      [createdConversation.body.conversation.id],
    );

    expect(Number(replayJobCount.rows[0].count)).toBe(1);
    expect(Number(replayAiExecutionCount.rows[0].count)).toBe(1);
    expect(Number(replayAssistantCount.rows[0].count)).toBe(1);
  });

  it('OFFLINE: priced OpenAI fixture persists KNOWN attempt/execution cost and exposes KNOWN API ai_cost', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedRelationship(pool, userA, patientA);

    const createdConversation = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'priced-openai-direct-create')
      .expect(201);

    const initial = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'priced-openai-direct-submit')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Co oznacza trend glikemii?',
      })
      .expect(200);

    expect(initial.body.decision).toBe('DIRECT_RESPONSE');

    const repository = app.get(PostgresGlucoMindRepository);
    const configService = app.get(ConfigService);
    const worker = new WorkerService(
      repository,
      {
        ensureNightscoutSource: async () => ({ id: randomUUID(), patient_id: patientA }),
        getImportedReadingForEvent: async () => null,
        runNightscoutSyncJob: async () => ({ jobs_enqueued: 0, sources: 0, processed: 0 } as any),
        enqueueRecurringSyncJobs: async () => ({ sources: 0, jobs_enqueued: 0 }),
      } as any,
      configService,
      createPricedOpenAiGatewayForTest(),
      new PushNotificationService(new FakePushNotificationProvider()),
    );

    await processWorkerUntil(worker, async () => {
      const assistantAfterWorker = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1::uuid AND message_type = 'ASSISTANT_MESSAGE'`,
        [createdConversation.body.conversation.id],
      );
      return Number(assistantAfterWorker.rows[0].count) >= 1;
    });

    const execution = await pool.query<{
      id: string;
      input_tokens: string | null;
      output_tokens: string | null;
      cached_input_tokens: string | null;
      reasoning_tokens: string | null;
      estimated_cost: string | null;
      cost_currency: string | null;
      pricing_version: string | null;
    }>(
      `
        SELECT id::text, input_tokens::text, output_tokens::text, cached_input_tokens::text, reasoning_tokens::text, estimated_cost::text, cost_currency, pricing_version
        FROM ai_executions
        WHERE patient_id = $1::text
          AND task_type = 'CONVERSATION_DIRECT_RESPONSE'
          AND correlation_id = $2::text
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [patientA, createdConversation.body.conversation.id],
    );

    expect(execution.rows[0]).toBeTruthy();
    expect(Number(execution.rows[0].input_tokens ?? '0')).toBe(1000);
    expect(Number(execution.rows[0].output_tokens ?? '0')).toBe(500);
    expect(Number(execution.rows[0].cached_input_tokens ?? '0')).toBe(100);
    expect(Number(execution.rows[0].reasoning_tokens ?? '0')).toBe(50);
    // 900 uncached input tokens at the input price + 100 cached at the cached price + output + reasoning surcharge.
    expect(Number(execution.rows[0].estimated_cost ?? '0')).toBeCloseTo(0.01985, 12);
    expect(execution.rows[0].cost_currency).toBe('USD');
    expect(execution.rows[0].pricing_version).toBe('openai.pricing.test.v1');

    const attempt = await pool.query<{
      input_tokens: string | null;
      output_tokens: string | null;
      cached_input_tokens: string | null;
      reasoning_tokens: string | null;
      estimated_cost: string | null;
      cost_currency: string | null;
      pricing_version: string | null;
    }>(
      `
        SELECT input_tokens::text, output_tokens::text, cached_input_tokens::text, reasoning_tokens::text, estimated_cost::text, cost_currency, pricing_version
        FROM ai_execution_attempts
        WHERE ai_execution_id = $1::uuid
        ORDER BY attempt_number ASC
        LIMIT 1
      `,
      [execution.rows[0].id],
    );

    expect(attempt.rows[0]).toBeTruthy();
    expect(Number(attempt.rows[0].input_tokens ?? '0')).toBe(1000);
    expect(Number(attempt.rows[0].output_tokens ?? '0')).toBe(500);
    expect(Number(attempt.rows[0].cached_input_tokens ?? '0')).toBe(100);
    expect(Number(attempt.rows[0].reasoning_tokens ?? '0')).toBe(50);
    expect(Number(attempt.rows[0].estimated_cost ?? '0')).toBeCloseTo(0.01985, 12);
    expect(attempt.rows[0].cost_currency).toBe('USD');
    expect(attempt.rows[0].pricing_version).toBe('openai.pricing.test.v1');

    const conversationAfterWorker = await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);

    const assistantFromApi = conversationAfterWorker.body.messages.find((message: { message_type: string }) => message.message_type === 'ASSISTANT_MESSAGE');
    expect(assistantFromApi).toBeTruthy();
    expect(assistantFromApi.ai_cost).toBeTruthy();
    expect(String(assistantFromApi.ai_cost.status)).toBe('KNOWN');
    expect(Number(assistantFromApi.ai_cost.amount ?? 0)).toBeCloseTo(0.01985, 12);
    expect(String(assistantFromApi.ai_cost.currency)).toBe('USD');
    expect(String(assistantFromApi.ai_cost.pricing_version)).toBe('openai.pricing.test.v1');
    expect(String(assistantFromApi.ai_cost.provider)).toBe('openai');
    expect(String(assistantFromApi.ai_cost.model)).toBe('gpt-5.6-terra');
  });

  it('LIVE: TODAY analysis with OpenAI provider uses bounded evidence and excludes stale events', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    const staleEventId = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedRelationship(pool, userA, patientA);
    await seedCurrentState(pool, patientA, {
      as_of: isoNow(),
      glucose: { value: 151, trend: 'DOWN', unit: 'mg/dL' },
      iob: { value: 4.29, unit: 'U' },
    });
    await seedTodayEventSample(pool, patientA);
    await seedOutOfRangeEventSample(pool, patientA, staleEventId);

    const createdConversation = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'live-today-analysis-create')
      .expect(201);

    const first = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'live-today-analysis-submit')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Przeanalizuj mi dzisiejszy dzień',
      })
      .expect(200);

    expect(first.body.decision).toBe('ANALYSIS_REQUEST');
    expect(first.body.conversation.awaiting_user_answer).toBe(false);

    const userMessage = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM messages WHERE conversation_id = $1::uuid AND idempotency_key = 'live-today-analysis-submit' LIMIT 1`,
      [createdConversation.body.conversation.id],
    );
    const userMessageId = String(userMessage.rows[0].id);

    const queuedJob = await pool.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM jobs
        WHERE patient_id = $1::uuid
          AND job_type = 'conversation.time_range_analysis'
          AND payload->>'conversation_id' = $2
          AND payload->>'user_message_id' = $3
          AND payload->>'range_type' = 'TODAY'
      `,
      [patientA, createdConversation.body.conversation.id, userMessageId],
    );
    expect(Number(queuedJob.rows[0].count)).toBe(1);

    const repository = app.get(PostgresGlucoMindRepository);
    const configService = app.get(ConfigService);
    const worker = new WorkerService(
      repository,
      {
        ensureNightscoutSource: async () => ({ id: randomUUID(), patient_id: patientA }),
        getImportedReadingForEvent: async () => null,
        runNightscoutSyncJob: async () => ({ jobs_enqueued: 0, sources: 0, processed: 0 } as any),
        enqueueRecurringSyncJobs: async () => ({ sources: 0, jobs_enqueued: 0 }),
      } as any,
      configService,
      createAiGatewayForTest(),
      new PushNotificationService(new FakePushNotificationProvider()),
    );

    await processWorkerUntil(worker, async () => {
      const executions = await pool.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM ai_executions
          WHERE patient_id = $1::text
            AND correlation_id = $2::text
            AND task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS'
        `,
        [patientA, createdConversation.body.conversation.id],
      );
      return Number(executions.rows[0].count) >= 1;
    });

    const todayExecution = await pool.query<{
      id: string;
      provider: string;
      model: string;
      input_tokens: string | null;
      output_tokens: string | null;
      total_tokens: string | null;
      cached_input_tokens: string | null;
      reasoning_tokens: string | null;
      estimated_cost: string | null;
      pricing_version: string | null;
    }>(
      `
        SELECT id, provider, model, input_tokens::text, output_tokens::text, total_tokens::text, cached_input_tokens::text, reasoning_tokens::text, estimated_cost::text, pricing_version
        FROM ai_executions
        WHERE patient_id = $1::text
          AND correlation_id = $2::text
          AND task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS'
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [patientA, createdConversation.body.conversation.id],
    );
    expect(todayExecution.rows[0]).toBeTruthy();
    expect(todayExecution.rows[0].provider).toBe(String(process.env.E2E_AI_PROVIDER ?? 'fake').toLowerCase() === 'openai' ? 'openai' : 'fake');
    expect(Number(todayExecution.rows[0].input_tokens ?? '0')).toBeGreaterThan(0);
    expect(Number(todayExecution.rows[0].output_tokens ?? '0')).toBeGreaterThan(0);
    expect(Number(todayExecution.rows[0].total_tokens ?? '0')).toBeGreaterThan(0);
    expect(Number(todayExecution.rows[0].total_tokens ?? '0')).toBe(
      Number(todayExecution.rows[0].input_tokens ?? '0') + Number(todayExecution.rows[0].output_tokens ?? '0'),
    );
    expect(todayExecution.rows[0].cached_input_tokens).toBeNull();
    expect(todayExecution.rows[0].reasoning_tokens).toBeNull();
    if (todayExecution.rows[0].estimated_cost === null) {
      expect(todayExecution.rows[0].pricing_version).toBeNull();
    }

    const todayAttempt = await pool.query<{
      attempt_number: string;
      status: string;
      input_tokens: string | null;
      output_tokens: string | null;
      total_tokens: string | null;
      cached_input_tokens: string | null;
      reasoning_tokens: string | null;
      estimated_cost: string | null;
      pricing_version: string | null;
    }>(
      `
        SELECT attempt_number::text, status, input_tokens::text, output_tokens::text, total_tokens::text, cached_input_tokens::text, reasoning_tokens::text, estimated_cost::text, pricing_version
        FROM ai_execution_attempts
        WHERE ai_execution_id = $1::uuid
        ORDER BY attempt_number ASC
        LIMIT 1
      `,
      [todayExecution.rows[0].id],
    );
    expect(todayAttempt.rows[0]).toBeTruthy();
    expect(todayAttempt.rows[0].status).toBe('SUCCEEDED');
    expect(Number(todayAttempt.rows[0].input_tokens ?? '0')).toBeGreaterThan(0);
    expect(Number(todayAttempt.rows[0].output_tokens ?? '0')).toBeGreaterThan(0);
    expect(Number(todayAttempt.rows[0].total_tokens ?? '0')).toBe(
      Number(todayAttempt.rows[0].input_tokens ?? '0') + Number(todayAttempt.rows[0].output_tokens ?? '0'),
    );
    expect(todayAttempt.rows[0].cached_input_tokens).toBeNull();
    expect(todayAttempt.rows[0].reasoning_tokens).toBeNull();
    if (todayAttempt.rows[0].estimated_cost === null) {
      expect(todayAttempt.rows[0].pricing_version).toBeNull();
    }

    const contextArtifact = await pool.query<{ package_version: string; payload: Record<string, unknown> }>(
      `
        SELECT package_version, payload
        FROM context_packages
        WHERE patient_id = $1::uuid
          AND job_id IN (
            SELECT id
            FROM jobs
            WHERE job_type = 'conversation.time_range_analysis'
              AND payload->>'conversation_id' = $2
          )
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [patientA, createdConversation.body.conversation.id],
    );
    expect(contextArtifact.rows[0]).toBeTruthy();
    expect(contextArtifact.rows[0].package_version).toBe('conversation-time-range-context.v1');
    expect((contextArtifact.rows[0].payload as any).capability).toBe('ANALYSIS_REQUEST');
    expect((contextArtifact.rows[0].payload as any).range.range_type).toBe('TODAY');
    expect(Number((contextArtifact.rows[0].payload as any).evidence_sections.glucose_events)).toBeGreaterThanOrEqual(1);
    const sourceRefs = Array.isArray((contextArtifact.rows[0].payload as any).source_refs) ? (contextArtifact.rows[0].payload as any).source_refs : [];
    expect(sourceRefs).not.toContain(staleEventId);

    const assistantRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1::uuid AND message_type = 'ASSISTANT_MESSAGE'`,
      [createdConversation.body.conversation.id],
    );
    expect(Number(assistantRows.rows[0].count)).toBe(1);

    const linkedConversation = await pool.query<{ analysis_id: string | null; recommendation_id: string | null }>(
      `SELECT analysis_id::text, recommendation_id::text FROM conversations WHERE id = $1::uuid LIMIT 1`,
      [createdConversation.body.conversation.id],
    );
    expect(linkedConversation.rows[0]).toBeTruthy();
    expect(linkedConversation.rows[0].analysis_id).toBeTruthy();
    expect(linkedConversation.rows[0].recommendation_id).toBeTruthy();

    const persistedAnalysis = await pool.query<{
      id: string;
      task_type: string;
      status: string;
      episode_id: string | null;
      trigger_id: string | null;
      facts: unknown[];
      unknowns: unknown[];
      context_package_hash: string | null;
    }>(
      `
        SELECT
          id::text AS id,
          task_type,
          status,
          episode_id::text,
          trigger_id::text,
          facts,
          unknowns,
          context_package_hash
        FROM analyses
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [linkedConversation.rows[0].analysis_id],
    );
    expect(persistedAnalysis.rows[0]).toBeTruthy();
    expect(persistedAnalysis.rows[0].task_type).toBe('CONVERSATION_TIME_RANGE_ANALYSIS');
    expect(persistedAnalysis.rows[0].status).toBe('INSUFFICIENT_DATA');
    expect(persistedAnalysis.rows[0].episode_id).toBeNull();
    expect(persistedAnalysis.rows[0].trigger_id).toBeNull();
    expect(Array.isArray(persistedAnalysis.rows[0].facts)).toBe(true);
    expect((persistedAnalysis.rows[0].facts ?? []).length).toBe(0);
    expect(Array.isArray(persistedAnalysis.rows[0].unknowns)).toBe(true);

    const persistedRecommendation = await pool.query<{
      id: string;
      analysis_id: string;
      episode_id: string | null;
      status: string;
      evidence: unknown[];
      provenance: Record<string, unknown>;
    }>(
      `
        SELECT
          id::text AS id,
          analysis_id::text AS analysis_id,
          episode_id::text,
          status,
          evidence,
          provenance
        FROM recommendations
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [linkedConversation.rows[0].recommendation_id],
    );
    expect(persistedRecommendation.rows[0]).toBeTruthy();
    expect(persistedRecommendation.rows[0].analysis_id).toBe(String(linkedConversation.rows[0].analysis_id));
    expect(persistedRecommendation.rows[0].episode_id).toBeNull();
    expect(persistedRecommendation.rows[0].status).toBe('INSUFFICIENT_DATA');
    expect(Array.isArray(persistedRecommendation.rows[0].evidence)).toBe(true);
    expect((persistedRecommendation.rows[0].evidence ?? []).length).toBe(0);
    expect(String((persistedRecommendation.rows[0].provenance as any).trigger_id ?? '')).toBe('');
    expect(String((persistedRecommendation.rows[0].provenance as any).analysis_id ?? '')).toBe(String(linkedConversation.rows[0].analysis_id));
    expect(String(((persistedRecommendation.rows[0].provenance as any).source_versions ?? {}).trigger_rule_version ?? '')).toBe('CONVERSATION_TIME_RANGE_ANALYSIS');

    const assistantMessage = await pool.query<{ content: string }>(
      `SELECT content FROM messages WHERE conversation_id = $1::uuid AND message_type = 'ASSISTANT_MESSAGE' ORDER BY created_at DESC LIMIT 1`,
      [createdConversation.body.conversation.id],
    );
    const assistantText = String(assistantMessage.rows[0].content ?? '');
    expect(assistantText).toMatch(/Dzisiejsz[e|y]/i);
    expect(assistantText.toLowerCase()).not.toContain('99 g');

    const replay = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'live-today-analysis-submit')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Przeanalizuj mi dzisiejszy dzień',
      })
      .expect(200);
    expect(replay.body.decision).toBe('ANALYSIS_REQUEST');

    const replayJobCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs WHERE patient_id = $1::uuid AND job_type = 'conversation.time_range_analysis' AND payload->>'conversation_id' = $2`,
      [patientA, createdConversation.body.conversation.id],
    );
    const replayExecutionCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ai_executions WHERE patient_id = $1::text AND correlation_id = $2::text AND task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS'`,
      [patientA, createdConversation.body.conversation.id],
    );
    const replayAssistantCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1::uuid AND message_type = 'ASSISTANT_MESSAGE'`,
      [createdConversation.body.conversation.id],
    );
    const replayAnalysisCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM analyses WHERE patient_id = $1::uuid AND task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS'`,
      [patientA],
    );
    const replayRecommendationCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM recommendations WHERE patient_id = $1::uuid`,
      [patientA],
    );
    expect(Number(replayJobCount.rows[0].count)).toBe(1);
    expect(Number(replayExecutionCount.rows[0].count)).toBe(1);
    expect(Number(replayAssistantCount.rows[0].count)).toBe(1);
    expect(Number(replayAnalysisCount.rows[0].count)).toBe(1);
    expect(Number(replayRecommendationCount.rows[0].count)).toBe(1);
  });

  it('LIVE: TODAY analysis persists completed Evidence Session for batched tool retrieval in production path', async () => {
    const previousToolFlag = process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
    process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = '1';

    try {
      const userA = randomUUID();
      const patientA = randomUUID();
      authTokens.set('user-a', userA);

      await seedPatientAndUser(pool, userA, patientA, 'patient-a');
      await seedRelationship(pool, userA, patientA);
      await seedCurrentState(pool, patientA, {
        as_of: isoNow(),
        glucose: { value: 143, trend: 'FLAT', unit: 'mg/dL' },
        iob: { value: 1.1, unit: 'U' },
      });
      await seedTodayEventSample(pool, patientA);

      const createdConversation = await request(app.getHttpServer())
        .post(`/v1/patients/${patientA}/conversations`)
        .set('Authorization', 'Bearer user-a')
        .set('Idempotency-Key', 'evidence-session-live-create')
        .expect(201);

      const submitted = await request(app.getHttpServer())
        .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
        .set('Authorization', 'Bearer user-a')
        .set('Idempotency-Key', 'evidence-session-live-submit')
        .send({
          message_type: 'USER_MESSAGE',
          content: 'Przeanalizuj mi dzisiejszy dzień',
        })
        .expect(200);

      expect(submitted.body.decision).toBe('ANALYSIS_REQUEST');

      let providerCall = 0;
      const gateway = new AiGatewayService({
        generate: async () => {
          providerCall += 1;
          if (providerCall === 1) {
            return {
              provider: 'fake',
              model: 'deterministic-hypo-v1',
              received_at: new Date().toISOString(),
              raw_output: {},
              tool_calls: [
                {
                  call_id: 'live-call-g',
                  tool_name: 'get_glucose_evidence',
                  arguments: {
                    time_range: {
                      // Glucose DETAIL covers at most 6 h per request.
                      from: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
                      to: new Date().toISOString(),
                    },
                    detail_level: 'DETAIL',
                  },
                },
                {
                  call_id: 'live-call-i',
                  tool_name: 'get_insulin_evidence',
                  arguments: {
                    time_range: {
                      from: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
                      to: new Date().toISOString(),
                    },
                    detail_level: 'SUMMARY',
                  },
                },
                {
                  call_id: 'live-call-b',
                  tool_name: 'get_basal_evidence',
                  arguments: {
                    time_range: {
                      from: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
                      to: new Date().toISOString(),
                    },
                    detail_level: 'SUMMARY',
                  },
                },
              ],
            };
          }

          return {
            provider: 'fake',
            model: 'deterministic-hypo-v1',
            received_at: new Date().toISOString(),
            raw_output: {
              assistant_message: 'Analiza zakończona: narzędzia dowodowe zostały użyte poprawnie.',
            },
          };
        },
      } as any);

      const repository = app.get(PostgresGlucoMindRepository);
      const configService = app.get(ConfigService);
      const worker = new WorkerService(
        repository,
        {
          ensureNightscoutSource: async () => ({ id: randomUUID(), patient_id: patientA }),
          getImportedReadingForEvent: async () => null,
          runNightscoutSyncJob: async () => ({ jobs_enqueued: 0, sources: 0, processed: 0 } as any),
          enqueueRecurringSyncJobs: async () => ({ sources: 0, jobs_enqueued: 0 }),
        } as any,
        configService,
        gateway,
        new PushNotificationService(new FakePushNotificationProvider()),
      );

      await processWorkerUntil(worker, async () => {
        const done = await pool.query<{ count: string }>(
          `
            SELECT count(*)::text AS count
            FROM evidence_sessions s
            JOIN ai_executions e ON e.id = s.ai_execution_id
            WHERE e.patient_id = $1::text
              AND e.correlation_id = $2::text
              AND e.task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS'
              AND s.status = 'COMPLETED'
          `,
          [patientA, createdConversation.body.conversation.id],
        );
        return Number(done.rows[0].count) >= 1;
      });

      expect(providerCall).toBe(2);

      const execution = await pool.query<{ id: string; status: string; processing_state: Record<string, unknown> | null }>(
        `
          SELECT id::text AS id, status, processing_state
          FROM ai_executions
          WHERE patient_id = $1::text
            AND correlation_id = $2::text
            AND task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS'
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [patientA, createdConversation.body.conversation.id],
      );
      expect(execution.rows[0]).toBeTruthy();
      expect(execution.rows[0].status).toBe('succeeded');
      expect(execution.rows[0].processing_state).toBeNull();

      const session = await pool.query<{
        status: string;
        tool_call_count: string;
        successful_tool_call_count: string;
        failed_tool_call_count: string;
        total_tool_result_bytes: string;
        unique_tool_result_bytes: string;
        duplicated_tool_result_bytes: string;
        initial_evidence_bytes: string;
        completed_at: string | null;
      }>(
        `
          SELECT
            status,
            tool_call_count::text,
            successful_tool_call_count::text,
            failed_tool_call_count::text,
            total_tool_result_bytes::text,
            unique_tool_result_bytes::text,
            duplicated_tool_result_bytes::text,
            initial_evidence_bytes::text,
            completed_at::text
          FROM evidence_sessions
          WHERE ai_execution_id = $1::uuid
          LIMIT 1
        `,
        [execution.rows[0].id],
      );
      expect(session.rows[0]).toBeTruthy();
      expect(session.rows[0].status).toBe('COMPLETED');
      expect(Number(session.rows[0].tool_call_count)).toBe(3);
      expect(Number(session.rows[0].successful_tool_call_count)).toBe(3);
      expect(Number(session.rows[0].failed_tool_call_count)).toBe(0);
      expect(Number(session.rows[0].total_tool_result_bytes)).toBeGreaterThan(0);
      expect(Number(session.rows[0].unique_tool_result_bytes)).toBeGreaterThan(0);
      expect(Number(session.rows[0].initial_evidence_bytes)).toBeGreaterThan(0);
      expect(session.rows[0].completed_at).toBeTruthy();

      const toolCalls = await pool.query<{
        sequence: string;
        call_id: string | null;
        tool_name: string;
        request_hash: string;
        result_hash: string | null;
        result_status: string | null;
        status: string;
        arguments: Record<string, unknown>;
      }>(
        `
          SELECT sequence::text, call_id, tool_name, request_hash, result_hash, result_status, status, arguments
          FROM evidence_session_tool_calls
          WHERE session_id = (
            SELECT id FROM evidence_sessions WHERE ai_execution_id = $1::uuid LIMIT 1
          )
          ORDER BY sequence ASC
        `,
        [execution.rows[0].id],
      );
      expect(toolCalls.rows.map((row) => row.call_id)).toEqual(['live-call-g', 'live-call-i', 'live-call-b']);
      expect(toolCalls.rows.map((row) => row.tool_name)).toEqual(['get_glucose_evidence', 'get_insulin_evidence', 'get_basal_evidence']);
      expect(toolCalls.rows.every((row) => row.status === 'SUCCEEDED')).toBe(true);
      expect(toolCalls.rows.every((row) => String(row.request_hash).startsWith('sha256:'))).toBe(true);
      expect(toolCalls.rows.every((row) => String(row.result_hash ?? '').length > 0)).toBe(true);
      expect(toolCalls.rows.every((row) => String(row.result_status ?? '').length > 0)).toBe(true);
      expect(toolCalls.rows.some((row) => JSON.stringify(row.arguments).includes('raw_payload'))).toBe(false);

      const assistantCount = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1::uuid AND message_type = 'ASSISTANT_MESSAGE'`,
        [createdConversation.body.conversation.id],
      );
      expect(Number(assistantCount.rows[0].count)).toBe(1);
    } finally {
      if (previousToolFlag === undefined) {
        delete process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
      } else {
        process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = previousToolFlag;
      }
    }
  });

  it('replays USER_MESSAGE idempotently with the originally persisted ANALYSIS_REQUEST decision', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedRelationship(pool, userA, patientA);

    const createdConversation = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-replay-investigation-create')
      .expect(201);

    const first = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-replay-investigation')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Dlaczego po obiedzie cukier rósł przez 4 godziny?',
      })
      .expect(200);

    const replay = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-replay-investigation')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Dlaczego po obiedzie cukier rósł przez 4 godziny?',
      })
      .expect(200);

    expect(first.body.decision).toBe('ANALYSIS_REQUEST');
    expect(replay.body.decision).toBe('ANALYSIS_REQUEST');

    const messages = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1 AND idempotency_key = $2`,
      [createdConversation.body.conversation.id, 'user-message-replay-investigation'],
    );
    expect(Number(messages.rows[0].count)).toBe(1);
  });

  it('OFFLINE: explicit 7-day request flows through payload, worker, ContextPackage, and TIME_RANGE AI task', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedRelationship(pool, userA, patientA);
    await seedCurrentState(pool, patientA, {
      as_of: isoNow(),
      glucose: { value: 140, trend: 'FLAT', unit: 'mg/dL' },
      iob: { value: 2.1, unit: 'U' },
    });
    await seedTodayEventSample(pool, patientA);

    const createdConversation = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'offline-7d-create')
      .expect(201);

    const messageResponse = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'offline-7d-submit')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Przeanalizuj ostatnie 7 dni',
      })
      .expect(200);

    expect(messageResponse.body.decision).toBe('ANALYSIS_REQUEST');

    const queuedJob = await pool.query<{
      id: string;
      range_type: string;
      range_start: string;
      range_end: string;
      timezone: string;
      normalization_policy_version: string;
    }>(
      `
        SELECT
          id::text AS id,
          payload->>'range_type' AS range_type,
          payload->>'range_start' AS range_start,
          payload->>'range_end' AS range_end,
          payload->>'timezone' AS timezone,
          payload->>'normalization_policy_version' AS normalization_policy_version
        FROM jobs
        WHERE patient_id = $1::uuid
          AND job_type = 'conversation.time_range_analysis'
          AND payload->>'conversation_id' = $2
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [patientA, createdConversation.body.conversation.id],
    );

    expect(queuedJob.rows[0]).toBeTruthy();
    expect(queuedJob.rows[0].range_type).toBe('MEDIUM_RANGE');
    expect(Date.parse(queuedJob.rows[0].range_start)).not.toBeNaN();
    expect(Date.parse(queuedJob.rows[0].range_end)).not.toBeNaN();
    expect(new Date(queuedJob.rows[0].range_start).getTime()).toBeLessThan(new Date(queuedJob.rows[0].range_end).getTime());
    expect(queuedJob.rows[0].timezone.length).toBeGreaterThan(0);
    expect(queuedJob.rows[0].normalization_policy_version).toBe('time-range-normalization.v1');

    const repository = app.get(PostgresGlucoMindRepository);
    const configService = app.get(ConfigService);
    const worker = new WorkerService(
      repository,
      {
        ensureNightscoutSource: async () => ({ id: randomUUID(), patient_id: patientA }),
        getImportedReadingForEvent: async () => null,
        runNightscoutSyncJob: async () => ({ jobs_enqueued: 0, sources: 0, processed: 0 } as any),
        enqueueRecurringSyncJobs: async () => ({ sources: 0, jobs_enqueued: 0 }),
      } as any,
      configService,
      createAiGatewayForTest(),
      new PushNotificationService(new FakePushNotificationProvider()),
    );

    await processWorkerUntil(worker, async () => {
      const executions = await pool.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM ai_executions
          WHERE patient_id = $1::text
            AND correlation_id = $2::text
            AND task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS'
        `,
        [patientA, createdConversation.body.conversation.id],
      );
      return Number(executions.rows[0].count) >= 1;
    });

    const contextArtifact = await pool.query<{ payload: Record<string, unknown> }>(
      `
        SELECT payload
        FROM context_packages
        WHERE patient_id = $1::uuid
          AND job_id = $2::uuid
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [patientA, queuedJob.rows[0].id],
    );

    expect(contextArtifact.rows[0]).toBeTruthy();
    expect((contextArtifact.rows[0].payload as any).range.range_type).toBe('MEDIUM_RANGE');
    expect((contextArtifact.rows[0].payload as any).range.range_start).toBe(queuedJob.rows[0].range_start);
    expect((contextArtifact.rows[0].payload as any).range.range_end).toBe(queuedJob.rows[0].range_end);
    expect((contextArtifact.rows[0].payload as any).range.timezone).toBe(queuedJob.rows[0].timezone);

    const execution = await pool.query<{ task_type: string; context_package_hash: string }>(
      `
        SELECT task_type, context_package_hash
        FROM ai_executions
        WHERE patient_id = $1::text
          AND correlation_id = $2::text
          AND task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS'
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [patientA, createdConversation.body.conversation.id],
    );

    expect(execution.rows[0].task_type).toBe('CONVERSATION_TIME_RANGE_ANALYSIS');
    expect(execution.rows[0].context_package_hash.length).toBeGreaterThan(0);

    const assistantMessage = await pool.query<{ metadata: Record<string, unknown> }>(
      `
        SELECT metadata
        FROM messages
        WHERE conversation_id = $1::uuid
          AND message_type = 'ASSISTANT_MESSAGE'
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [createdConversation.body.conversation.id],
    );

    expect((assistantMessage.rows[0].metadata as any).range_type).toBe('MEDIUM_RANGE');
    expect((assistantMessage.rows[0].metadata as any).range_start).toBe(queuedJob.rows[0].range_start);
    expect((assistantMessage.rows[0].metadata as any).range_end).toBe(queuedJob.rows[0].range_end);
    expect((assistantMessage.rows[0].metadata as any).timezone).toBe(queuedJob.rows[0].timezone);
  });

  it('routes explicit today question to ANALYSIS_REQUEST even without explicit analysis verb', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedRelationship(pool, userA, patientA);
    await seedCurrentState(pool, patientA, {
      as_of: isoNow(),
      glucose: { value: 166, trend: 'FLAT', unit: 'mg/dL' },
      iob: { value: 1.2, unit: 'U' },
    });
    await seedTodayEventSample(pool, patientA);

    const createdConversation = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'today-question-routing-create')
      .expect(201);

    const messageResponse = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'today-question-routing-submit')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Co dzisiaj było największym problemem?',
      })
      .expect(200);

    expect(messageResponse.body.decision).toBe('ANALYSIS_REQUEST');

    const jobs = await pool.query<{ job_type: string; payload: Record<string, unknown> }>(
      `
        SELECT job_type, payload
        FROM jobs
        WHERE patient_id = $1::uuid
          AND payload->>'conversation_id' = $2
        ORDER BY created_at DESC
      `,
      [patientA, createdConversation.body.conversation.id],
    );

    expect(jobs.rows[0]).toBeTruthy();
    expect(jobs.rows[0].job_type).toBe('conversation.time_range_analysis');
    expect(String((jobs.rows[0].payload as any).range_type)).toBe('TODAY');

    const directJobCount = await pool.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM jobs
        WHERE patient_id = $1::uuid
          AND payload->>'conversation_id' = $2
          AND job_type = 'conversation.direct_response'
      `,
      [patientA, createdConversation.body.conversation.id],
    );
    expect(Number(directJobCount.rows[0].count)).toBe(0);
  });

  it('forensic: two-turn continuity captures TURN 2 provider input and task routing', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedRelationship(pool, userA, patientA);
    await seedCurrentState(pool, patientA, {
      as_of: isoNow(),
      glucose: { value: 168, trend: 'FLAT', unit: 'mg/dL' },
      iob: { value: 1.5, unit: 'U' },
    });
    await seedTodayEventSample(pool, patientA);

    const createdConversation = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'forensic-continuity-create')
      .expect(201);

    const turn1 = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'forensic-continuity-turn-1')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Co było dzisiaj największym problemem?',
      })
      .expect(200);

    expect(turn1.body.decision).toBe('ANALYSIS_REQUEST');

    const capturingProvider = new CapturingAiProvider(new FakeAiProvider());
    const repository = app.get(PostgresGlucoMindRepository);
    const configService = app.get(ConfigService);
    const worker = new WorkerService(
      repository,
      {
        ensureNightscoutSource: async () => ({ id: randomUUID(), patient_id: patientA }),
        getImportedReadingForEvent: async () => null,
        runNightscoutSyncJob: async () => ({ jobs_enqueued: 0, sources: 0, processed: 0 } as any),
        enqueueRecurringSyncJobs: async () => ({ sources: 0, jobs_enqueued: 0 }),
      } as any,
      configService,
      new AiGatewayService(capturingProvider),
      new PushNotificationService(new FakePushNotificationProvider()),
    );

    await processWorkerUntil(worker, async () => {
      const assistantCount = await pool.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM messages
          WHERE conversation_id = $1::uuid
            AND role = 'ASSISTANT'
            AND message_type = 'ASSISTANT_MESSAGE'
        `,
        [createdConversation.body.conversation.id],
      );
      return Number(assistantCount.rows[0].count) >= 1;
    });

    const turn2 = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'forensic-continuity-turn-2')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'A co mogło je powodować?',
      })
      .expect(200);

    expect(turn2.body.decision).toBe('ANALYSIS_REQUEST');

    const turn2Jobs = await pool.query<{ job_type: string; payload: Record<string, unknown> }>(
      `
        SELECT job_type, payload
        FROM jobs
        WHERE patient_id = $1::uuid
          AND payload->>'conversation_id' = $2
        ORDER BY created_at DESC
      `,
      [patientA, createdConversation.body.conversation.id],
    );
    expect(turn2Jobs.rows.some((row) => row.job_type === 'conversation.time_range_analysis')).toBe(true);
    expect(turn2Jobs.rows.some((row) => row.job_type === 'conversation.direct_response')).toBe(false);

    await processWorkerUntil(worker, async () => {
      const assistantCount = await pool.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM messages
          WHERE conversation_id = $1::uuid
            AND role = 'ASSISTANT'
            AND message_type = 'ASSISTANT_MESSAGE'
        `,
        [createdConversation.body.conversation.id],
      );
      return Number(assistantCount.rows[0].count) >= 2;
    });

    const executionRows = await pool.query<{ task_type: string; status: string }>(
      `
        SELECT task_type, status
        FROM ai_executions
        WHERE patient_id = $1::text
          AND correlation_id = $2::text
        ORDER BY created_at ASC
      `,
      [patientA, createdConversation.body.conversation.id],
    );

    expect(executionRows.rows.map((row) => row.task_type)).toEqual([
      'CONVERSATION_TIME_RANGE_ANALYSIS',
      'CONVERSATION_TIME_RANGE_ANALYSIS',
    ]);
    expect(executionRows.rows.every((row) => row.status === 'succeeded')).toBe(true);

    const turn2Capture = capturingProvider.capturedInputs.find((input) => {
      if (input.task.task_type !== 'CONVERSATION_TIME_RANGE_ANALYSIS') {
        return false;
      }

      const payload = JSON.parse(input.prompt.user_payload) as {
        analysis_request_input?: { user_message_text?: string };
      };

      return String(payload.analysis_request_input?.user_message_text ?? '') === 'A co mogło je powodować?';
    });

    expect(turn2Capture).toBeTruthy();

    const turn2Payload = JSON.parse(String(turn2Capture?.prompt.user_payload ?? '{}')) as {
      analysis_request_input: { user_message_text: string; range_type: string; range_start: string; range_end: string };
      conversation_context: {
        recent_messages: Array<{
          role: string;
          message_type: string;
          content: string;
        }>;
      };
    };

    expect(turn2Payload.analysis_request_input.user_message_text).toBe('A co mogło je powodować?');
    expect(turn2Payload.analysis_request_input.range_type).toBe('TODAY');
    expect(turn2Payload.conversation_context.recent_messages.some((message) => message.content.includes('Co było dzisiaj największym problemem?'))).toBe(true);
    expect(turn2Payload.conversation_context.recent_messages.some((message) => message.role === 'ASSISTANT' && message.message_type === 'ASSISTANT_MESSAGE')).toBe(true);

    const timeRangeCalls = capturingProvider.capturedInputs.filter((input) => input.task.task_type === 'CONVERSATION_TIME_RANGE_ANALYSIS');
    const directCalls = capturingProvider.capturedInputs.filter((input) => input.task.task_type === 'CONVERSATION_DIRECT_RESPONSE');
    expect(timeRangeCalls.length).toBeGreaterThanOrEqual(2);
    expect(directCalls.length).toBe(0);
  });

  it('replays USER_MESSAGE idempotently with the originally persisted DIRECT_RESPONSE decision', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedRelationship(pool, userA, patientA);

    const createdConversation = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-replay-direct-create')
      .expect(201);

    const first = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-replay-direct')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Co oznacza trend glikemii?',
      })
      .expect(200);

    const replay = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-replay-direct')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Co oznacza trend glikemii?',
      })
      .expect(200);

    expect(first.body.decision).toBe('DIRECT_RESPONSE');
    expect(replay.body.decision).toBe('DIRECT_RESPONSE');

    const messages = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1 AND idempotency_key = $2`,
      [createdConversation.body.conversation.id, 'user-message-replay-direct'],
    );
    expect(Number(messages.rows[0].count)).toBe(1);
  });

  it('answers a caregiver data question with the time-range analysis, without a user investigation, question card or push', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedRelationship(pool, userA, patientA);

    const createdConversation = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-investigation-create')
      .expect(201);

    const result = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-investigation-submit')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Dlaczego po wczorajszym obiedzie cukier rósł przez 4 godziny?',
      })
      .expect(200);

    expect(result.body.decision).toBe('ANALYSIS_REQUEST');
    expect(result.body.conversation.episode_id).toBeNull();
    expect(result.body.conversation.awaiting_user_answer).toBe(false);

    const conversationId = createdConversation.body.conversation.id;
    const counts = await pool.query<{ investigations: string; open_questions: string; analysis_jobs: string; push_jobs: string }>(
      `
        SELECT
          (SELECT count(*) FROM investigations WHERE patient_id = $1 AND conversation_id = $2)::text AS investigations,
          (SELECT count(*) FROM context_questions WHERE patient_id = $1 AND conversation_id = $2 AND status = 'OPEN')::text AS open_questions,
          (SELECT count(*) FROM jobs WHERE job_type = 'conversation.time_range_analysis' AND correlation_id = $2::uuid)::text AS analysis_jobs,
          (SELECT count(*) FROM jobs WHERE job_type = 'notifications.push_conversation_question' AND correlation_id = $2::uuid)::text AS push_jobs
      `,
      [patientA, conversationId],
    );
    expect(counts.rows[0]).toEqual({ investigations: '0', open_questions: '0', analysis_jobs: '1', push_jobs: '0' });
  });

  it('creates no investigation and one analysis per message when a data question is repeated on the same conversation', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedRelationship(pool, userA, patientA);

    const createdConversation = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-repeat-create')
      .expect(201);

    await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-repeat-1')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Dlaczego po obiedzie cukier rósł przez 4 godziny?',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${createdConversation.body.conversation.id}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-repeat-2')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Dlaczego po obiedzie cukier rósł przez 4 godziny?',
      })
      .expect(200);

    const investigationCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM investigations WHERE patient_id = $1 AND conversation_id = $2`,
      [patientA, createdConversation.body.conversation.id],
    );
    expect(Number(investigationCount.rows[0].count)).toBe(0);

    const openQuestionCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM context_questions WHERE patient_id = $1 AND conversation_id = $2 AND status = 'OPEN'`,
      [patientA, createdConversation.body.conversation.id],
    );
    expect(Number(openQuestionCount.rows[0].count)).toBe(0);

    const analysisJobs = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs WHERE job_type = 'conversation.time_range_analysis' AND correlation_id = $1::uuid`,
      [createdConversation.body.conversation.id],
    );
    expect(Number(analysisJobs.rows[0].count)).toBe(2);
  });

  it('leaves a HYPO investigation untouched and creates no USER investigation from caregiver messages in the same conversation', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedRelationship(pool, userA, patientA);
    const seeded = await seedEpisodeConversation(pool, patientA);

    await pool.query(
      `
        INSERT INTO investigations (
          id, patient_id, event_id, event_family, state, active_question_id,
          conversation_id, episode_id, trigger_id, last_decision, last_decision_reason
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, 'HYPO', 'QUESTION_PENDING', $4,
          $5::uuid, $6::uuid, $7::uuid, 'ASK_NOW', 'Seeded hypo investigation'
        )
      `,
      [randomUUID(), patientA, seeded.eventId, seeded.questionId, seeded.conversationId, seeded.episodeId, seeded.triggerId],
    );

    const first = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${seeded.conversationId}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-same-conversation-hypo-1')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Dlaczego cukier jest wysoki?',
      })
      .expect(200);

    expect(first.body.decision).toBe('ANALYSIS_REQUEST');

    const second = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${seeded.conversationId}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-message-same-conversation-hypo-2')
      .send({
        message_type: 'USER_MESSAGE',
        content: 'Dlaczego rośnie?',
      })
      .expect(200);

    expect(second.body.decision).toBe('ANALYSIS_REQUEST');

    const byFamily = await pool.query<{ event_family: string; count: string }>(
      `
        SELECT event_family, count(*)::text AS count
        FROM investigations
        WHERE patient_id = $1::uuid
          AND conversation_id = $2::uuid
        GROUP BY event_family
        ORDER BY event_family ASC
      `,
      [patientA, seeded.conversationId],
    );

    const counts = new Map(byFamily.rows.map((row) => [row.event_family, Number(row.count)]));
    expect(counts.get('HYPO')).toBe(1);
    expect(counts.get('USER')).toBeUndefined();
  });

  it('proves the full patient-A flow, blocks patient-B access, and revocation removes access immediately', async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    const patientA = randomUUID();
    const patientB = randomUUID();
    authTokens.set('user-a', userA);
    authTokens.set('user-b', userB);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedPatientAndUser(pool, userA, patientB, 'patient-b');
    await seedPatientAndUser(pool, userB, patientB, 'patient-b');
    await seedRelationship(pool, userA, patientA);
    await seedRelationship(pool, userB, patientB);
    await seedCurrentState(pool, patientA, { current_state: 'stable', patient_id: String(patientA) });
    await seedCurrentState(pool, patientB, { current_state: 'stable', patient_id: String(patientB) });

    const patientList = await request(app.getHttpServer())
      .get('/v1/me/patients')
      .set('Authorization', 'Bearer user-a')
      .expect(200);
    expect(patientList.body.patients.map((row: { patient_id: string }) => row.patient_id)).toEqual(expect.arrayContaining([patientA]));
    expect(patientList.body.patients.map((row: { patient_id: string }) => row.patient_id)).not.toContain(patientB);

    await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/pending-investigation`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);

    await request(app.getHttpServer())
      .get(`/v1/patients/${patientB}/pending-investigation`)
      .set('Authorization', 'Bearer user-a')
      .expect(403);

    const seeded = await seedEpisodeConversation(pool, patientA);
    const answerRes = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${seeded.conversationId}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-a-patient-a-answer-1')
      .send({
        question_id: seeded.questionId,
        message_type: 'CONTEXT_ANSWER',
        answer: { type: 'YES' },
      })
      .expect(201);
    expect(answerRes.body.message.question_id).toBe(seeded.questionId);

    await request(app.getHttpServer())
      .post(`/v1/patients/${patientB}/conversations/${seeded.conversationId}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'user-a-patient-b-answer')
      .send({
        question_id: seeded.questionId,
        message_type: 'CONTEXT_ANSWER',
        answer: { type: 'YES' },
      })
      .expect(403);

    await pool.query(`DELETE FROM caregiver_relationships WHERE user_id = $1::uuid AND patient_id = $2::uuid`, [userA, patientA]);

    const revokedPatients = await request(app.getHttpServer())
      .get('/v1/me/patients')
      .set('Authorization', 'Bearer user-a')
      .expect(200);
    expect(revokedPatients.body.patients.map((row: { patient_id: string }) => row.patient_id)).not.toContain(patientA);

    await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/pending-investigation`)
      .set('Authorization', 'Bearer user-a')
      .expect(403);

    await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/conversations/${seeded.conversationId}`)
      .set('Authorization', 'Bearer user-a')
      .expect(403);
  });

  it('enforces actual API status semantics for lifecycle endpoints', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    const patientB = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedPatientAndUser(pool, userA, patientB, 'patient-b');
    await seedRelationship(pool, userA, patientA);
    const seeded = await seedEpisodeConversation(pool, patientA);

    await request(app.getHttpServer())
      .get('/v1/me/patients')
      .expect(401);

    await request(app.getHttpServer())
      .get(`/v1/patients/${patientB}/pending-investigation`)
      .set('Authorization', 'Bearer user-a')
      .expect(403);

    await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/conversations/${randomUUID()}`)
      .set('Authorization', 'Bearer user-a')
      .expect(404);

    const firstAnswer = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${seeded.conversationId}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'semantics-key-1')
      .send({
        question_id: seeded.questionId,
        message_type: 'CONTEXT_ANSWER',
        answer: { type: 'YES' },
      })
      .expect(201);
    expect(firstAnswer.body.message.answer_type).toBe('YES');

    const replayAnswer = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${seeded.conversationId}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'semantics-key-1')
      .send({
        question_id: seeded.questionId,
        message_type: 'CONTEXT_ANSWER',
        answer: { type: 'NO' },
      })
      .expect(200);
    expect(replayAnswer.body.message.answer_type).toBe('YES');

    await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/conversations/${seeded.conversationId}/messages`)
      .set('Authorization', 'Bearer user-a')
      .set('Idempotency-Key', 'semantics-key-2')
      .send({
        question_id: seeded.questionId,
        message_type: 'CONTEXT_ANSWER',
        answer: { type: 'TEXT' },
      })
      .expect(409);
  });

  it('blocks deep-link route confusion and cross-patient access for persisted conversation data', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    const patientB = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedPatientAndUser(pool, userA, patientB, 'patient-b');
    await seedRelationship(pool, userA, patientA);

    const seeded = await seedEpisodeConversation(pool, patientA);

    const validRes = await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/conversations/${seeded.conversationId}`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);
    expect(validRes.body.id).toBe(seeded.conversationId);

    await request(app.getHttpServer())
      .get(`/v1/patients/${patientB}/conversations/${seeded.conversationId}`)
      .set('Authorization', 'Bearer user-a')
      .expect(403);

    await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/conversations/${randomUUID()}`)
      .set('Authorization', 'Bearer user-a')
      .expect(404);
  });

  it('enforces device registration authorization at the controller boundary and denies revoked access', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    const patientB = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedPatientAndUser(pool, userA, patientB, 'patient-b');
    await seedRelationship(pool, userA, patientA);

    const created = await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/devices`)
      .set('Authorization', 'Bearer user-a')
      .send({
        platform: 'ios',
        device_id: 'ios-device-controller-1',
        push_token: 'token-controller-1',
        app_version: '1.2.3',
      })
      .expect(201);
    expect(created.body.device.push_token).toBe('token-controller-1');

    await request(app.getHttpServer())
      .post(`/v1/patients/${patientB}/devices`)
      .set('Authorization', 'Bearer user-a')
      .send({
        platform: 'ios',
        device_id: 'ios-device-controller-2',
        push_token: 'token-controller-2',
        app_version: '1.2.3',
      })
      .expect(403);

    await pool.query(`DELETE FROM caregiver_relationships WHERE user_id = $1::uuid AND patient_id = $2::uuid`, [userA, patientA]);

    await request(app.getHttpServer())
      .post(`/v1/patients/${patientA}/devices`)
      .set('Authorization', 'Bearer user-a')
      .send({
        platform: 'ios',
        device_id: 'ios-device-controller-3',
        push_token: 'token-controller-3',
        app_version: '1.2.3',
      })
      .expect(403);
  });
});

describePostgres('Read-path invariant: API reads do not trigger recomputation', { timeout: 120_000 }, () => {
  let app: INestApplication;
  let pool: Pool;
  let authTokens: Map<string, string>;

  beforeAll(async () => {
    configurePostgresIntegrationEnvironment(process.env);
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required for Postgres integration tests');
    }

    pool = new Pool({ connectionString: databaseUrl });
    app = (await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateApiEnvironment }), DatabaseModule],
      controllers: [PatientController, MeController],
      providers: [ApiService, BearerPrincipalGuard],
    })
      .overrideGuard(BearerPrincipalGuard)
      .useValue({
        async canActivate(context: any): Promise<boolean> {
          const request = context.switchToHttp().getRequest();
          const authorization = request.headers.authorization;
          const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
          if (!token) {
            throw new UnauthorizedException('Missing bearer token');
          }

          const userId = authTokens.get(token);
          if (!userId) {
            throw new UnauthorizedException('Invalid bearer token');
          }

          request.principal = { user_id: userId, auth_provider: 'COGNITO', auth_subject: `fixture:${userId}` };
          return true;
        },
      })
      .compile()).createNestApplication();

    await app.init();
  });

  beforeEach(async () => {
    authTokens = new Map<string, string>();
    await truncatePublicTablesForIntegrationTests(pool);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('proves API reads do not trigger analysis/recommendation recomputation', async () => {
    const userA = randomUUID();
    const patientA = randomUUID();
    authTokens.set('user-a', userA);

    await seedPatientAndUser(pool, userA, patientA, 'patient-a');
    await seedRelationship(pool, userA, patientA);
    const seeded = await seedEpisodeConversation(pool, patientA);
    const artifacts = await seedAnalysisAndRecommendation(pool, patientA, seeded.episodeId, seeded.triggerId, seeded.conversationId, seeded.questionId);

    // Count existing jobs
    const jobsBefore = await pool.query(`SELECT COUNT(*) as count FROM jobs WHERE (payload->>'patient_id')::uuid = $1`, [patientA]);
    const jobCountBefore = Number((jobsBefore.rows[0] as any).count);

    // Read Recommendation through API multiple times
    await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/recommendations/${artifacts.recommendationId}`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);

    await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/recommendations/${artifacts.recommendationId}`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);

    // Count jobs after reads
    const jobsAfter = await pool.query(`SELECT COUNT(*) as count FROM jobs WHERE (payload->>'patient_id')::uuid = $1`, [patientA]);
    const jobCountAfter = Number((jobsAfter.rows[0] as any).count);

    // No new jobs should have been created
    expect(jobCountAfter).toBe(jobCountBefore);

    // Verify existing Analysis/Recommendation were not modified
    const analysisAfter = await pool.query(`SELECT id::text, status, updated_at FROM analyses WHERE id = $1`, [artifacts.analysisId]);
    const recAfter = await pool.query(`SELECT id::text, status, updated_at FROM recommendations WHERE id = $1`, [artifacts.recommendationId]);

    expect(analysisAfter.rows.length).toBe(1);
    expect(recAfter.rows.length).toBe(1);
    expect(analysisAfter.rows[0].status).toBe('COMPLETED');
    expect(recAfter.rows[0].status).toBe('NO_ACTIONABLE_RECOMMENDATION');
  });
});
