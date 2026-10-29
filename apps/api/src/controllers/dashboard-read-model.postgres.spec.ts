import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigModule } from '@nestjs/config';
import { validateApiEnvironment } from '@infra/config/environment';
import { DatabaseModule } from '@infra/db/database.module';
import { configurePostgresIntegrationEnvironment, truncatePublicTablesForIntegrationTests } from '@infra/db/postgres-test-isolation';
import { ApiService } from '../application/api.service';
import { BearerPrincipalGuard } from '../auth/bearer-principal.guard';
import { PatientController } from './patient.controller';

process.env.COGNITO_USER_POOL_ID ??= 'eu-central-1_test';
process.env.COGNITO_CLIENT_ID ??= 'test-client-id';
process.env.COGNITO_TOKEN_USE ??= 'access';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

function isoAt(offsetMinutes: number): string {
  return new Date(Date.parse('2026-10-05T08:00:00.000Z') + offsetMinutes * 60_000).toISOString();
}

async function seedPatientAndUser(pool: Pool, userId: string, patientId: string): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, display_name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING`,
    [userId, `user-${userId.slice(0, 8)}`],
  );

  await pool.query(
    `INSERT INTO patients (id, display_name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING`,
    [patientId, `patient-${patientId.slice(0, 8)}`],
  );
}

async function seedRelationship(pool: Pool, userId: string, patientId: string): Promise<void> {
  await pool.query(
    `INSERT INTO caregiver_relationships (id, user_id, patient_id, relationship_type, permissions)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'CAREGIVER', '{}'::jsonb)
     ON CONFLICT (user_id, patient_id, relationship_type) DO NOTHING`,
    [randomUUID(), userId, patientId],
  );
}

async function seedHypoEpisodeGraph(pool: Pool, args: {
  patientId: string;
  episodeState: 'OPEN' | 'CLOSED';
  severity: 'L1' | 'L2';
  startedAt: string;
  endedAt?: string | null;
  questionStatus?: 'OPEN' | 'ANSWERED';
  questionId?: string;
  questionText?: string;
  awaitingUserAnswer?: boolean;
}): Promise<{ eventId: string; episodeId: string; triggerId: string; conversationId: string; questionId: string }> {
  const sourceId = randomUUID();
  const sourceRecordId = randomUUID();
  const eventId = randomUUID();
  const episodeId = randomUUID();
  const triggerId = randomUUID();
  const conversationId = randomUUID();
  const questionId = args.questionId ?? 'activity_before_drop';
  const questionText = args.questionText ?? 'Was there activity before the drop?';

  await pool.query(
    `INSERT INTO sources (id, patient_id, source_system, source_key, metadata)
     VALUES ($1::uuid, $2::uuid, 'NIGHTSCOUT', $3, '{}'::jsonb)
     ON CONFLICT (patient_id, source_system, source_key) DO NOTHING`,
    [sourceId, args.patientId, `nightscout:${args.patientId}:${sourceRecordId}`],
  );

  await pool.query(
    `INSERT INTO source_records (
      id, patient_id, source_id, source_system, source_record_id, natural_key, record_type,
      occurred_at, recorded_at, imported_at, raw_payload, provenance, canonical_hash
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, 'NIGHTSCOUT', $4, $5, 'cgm.entry',
      $6::timestamptz, $6::timestamptz, $6::timestamptz, $7::jsonb, '{}'::jsonb, $8
    ) ON CONFLICT (source_id, natural_key) DO NOTHING`,
    [
      sourceRecordId,
      args.patientId,
      sourceId,
      `record-${sourceRecordId}`,
      `nightscout:${args.patientId}:${sourceRecordId}`,
      args.startedAt,
      JSON.stringify({ sgv: args.severity === 'L2' ? 53 : 63 }),
      `canon:${sourceRecordId}`,
    ],
  );

  await pool.query(
    `INSERT INTO events (
      id, patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, 'GLUCOSE_READING_AVAILABLE',
      $4::timestamptz, $4::timestamptz, '{}'::jsonb, '{}'::jsonb, $5::jsonb
    ) ON CONFLICT (id) DO NOTHING`,
    [eventId, args.patientId, sourceRecordId, args.startedAt, JSON.stringify({ glucose_value: args.severity === 'L2' ? 53 : 63 })],
  );

  await pool.query(
    `INSERT INTO hypo_episodes (
      id, patient_id, trigger_id, start_event_id, state, severity, started_at, ended_at, latest_event_id, rule_version, created_at, updated_at
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::timestamptz, $8::timestamptz, $4::uuid, 'hypo.cgm.ada2026.v1', $7::timestamptz, $7::timestamptz
    )`,
    [episodeId, args.patientId, triggerId, eventId, args.episodeState, args.severity, args.startedAt, args.endedAt ?? null],
  );

  await pool.query(
    `INSERT INTO triggers (
      id, patient_id, type, source_event_id, episode_id, rule_version, status, cooldown_seconds, created_at, updated_at
    ) VALUES (
      $1::uuid, $2::uuid, 'HYPO_DETECTED', $3::uuid, $4::uuid, 'hypo.cgm.ada2026.v1', $5, 0, $6::timestamptz, $6::timestamptz
    )`,
    [triggerId, args.patientId, eventId, episodeId, args.episodeState === 'OPEN' ? 'OPEN' : 'CLOSED', args.startedAt],
  );

  await pool.query(
    `INSERT INTO conversations (
      id, patient_id, episode_id, thread_state_version, awaiting_user_answer, conversation_type, created_at, updated_at
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, 'thread.v1', $4, 'TRIGGER_INITIATED', $5::timestamptz, $5::timestamptz
    )`,
    [conversationId, args.patientId, episodeId, args.awaitingUserAnswer ?? false, args.startedAt],
  );

  if (args.questionStatus) {
    await pool.query(
      `INSERT INTO context_questions (
        id, conversation_id, patient_id, question_id, question_type, question_text, reason,
        expected_information_gain, expected_answer_types, related_event_id, status, created_at, updated_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, 'CONTEXT_QUESTION', $5,
        'Need to clarify trigger context', 'HIGH', '["YES","NO","UNKNOWN"]'::jsonb, $6::uuid, $7, $8::timestamptz, $8::timestamptz
      )`,
      [randomUUID(), conversationId, args.patientId, questionId, questionText, eventId, args.questionStatus, args.startedAt],
    );
  }

  return { eventId, episodeId, triggerId, conversationId, questionId };
}

async function seedInvestigation(pool: Pool, args: {
  patientId: string;
  eventId: string;
  episodeId: string;
  triggerId: string;
  conversationId: string;
  state: 'NEW' | 'OPEN' | 'QUESTION_PENDING' | 'RE_EVALUATING' | 'FINISHED_NO_QUESTION' | 'FINISHED_ASK_LATER' | 'RESOLVED' | 'CLOSED';
  activeQuestionId?: string | null;
  createdAt: string;
  updatedAt: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO investigations (
      id, patient_id, event_id, event_family, state, active_question_id,
      conversation_id, episode_id, trigger_id, last_decision, last_decision_reason, created_at, updated_at
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, 'HYPO', $4, $5,
      $6::uuid, $7::uuid, $8::uuid, 'ASK_NOW', 'seeded for dashboard test', $9::timestamptz, $10::timestamptz
    )`,
    [
      randomUUID(),
      args.patientId,
      args.eventId,
      args.state,
      args.activeQuestionId ?? null,
      args.conversationId,
      args.episodeId,
      args.triggerId,
      args.createdAt,
      args.updatedAt,
    ],
  );
}

describePostgres('dashboard read-model contracts (postgres)', { timeout: 120_000 }, () => {
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
    authTokens = new Map();

    app = (await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateApiEnvironment }), DatabaseModule],
      controllers: [PatientController],
      providers: [ApiService, BearerPrincipalGuard],
    })
      .overrideGuard(BearerPrincipalGuard)
      .useValue({
        async canActivate(context: any): Promise<boolean> {
          const request = context.switchToHttp().getRequest();
          const authHeader = request.headers?.authorization ?? request.headers?.Authorization;
          if (!authHeader || !String(authHeader).startsWith('Bearer ')) {
            throw new UnauthorizedException('Missing bearer token');
          }

          const token = String(authHeader).slice('Bearer '.length).trim();
          const userId = authTokens.get(token);
          if (!userId) {
            throw new UnauthorizedException('Invalid bearer token');
          }

          request.principal = { user_id: userId, auth_subject: `sub:${userId}` };
          return true;
        },
      })
      .compile()).createNestApplication();

    await app.init();
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    authTokens.clear();
  });

  afterAll(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    await app.close();
    await pool.end();
  });

  it('returns pending_investigation as null when no pending investigation exists', async () => {
    const userId = randomUUID();
    const patientId = randomUUID();
    authTokens.set('user-a', userId);
    await seedPatientAndUser(pool, userId, patientId);
    await seedRelationship(pool, userId, patientId);

    const res = await request(app.getHttpServer())
      .get(`/v1/patients/${patientId}/pending-investigation`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);

    expect(res.body.pending_investigation).toBeNull();
  });

  it('returns QUESTION_PENDING as pending investigation', async () => {
    const userId = randomUUID();
    const patientId = randomUUID();
    authTokens.set('user-a', userId);
    await seedPatientAndUser(pool, userId, patientId);
    await seedRelationship(pool, userId, patientId);

    const seeded = await seedHypoEpisodeGraph(pool, {
      patientId,
      episodeState: 'OPEN',
      severity: 'L1',
      startedAt: isoAt(30),
      questionStatus: 'OPEN',
      awaitingUserAnswer: true,
      questionId: 'activity_before_drop',
      questionText: 'Was there activity before the drop?',
    });

    await seedInvestigation(pool, {
      patientId,
      eventId: seeded.eventId,
      episodeId: seeded.episodeId,
      triggerId: seeded.triggerId,
      conversationId: seeded.conversationId,
      state: 'QUESTION_PENDING',
      activeQuestionId: seeded.questionId,
      createdAt: isoAt(31),
      updatedAt: isoAt(31),
    });

    const res = await request(app.getHttpServer())
      .get(`/v1/patients/${patientId}/pending-investigation`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);

    expect(res.body.pending_investigation).toEqual({
      investigation_id: expect.any(String),
      state: 'QUESTION_PENDING',
      question: 'Was there activity before the drop?',
      question_id: 'activity_before_drop',
      conversation_id: seeded.conversationId,
      event_id: seeded.eventId,
    });
  });

  for (const state of ['RE_EVALUATING', 'FINISHED_NO_QUESTION', 'FINISHED_ASK_LATER', 'RESOLVED', 'CLOSED'] as const) {
    it(`does not return pending investigation when state is ${state}`, async () => {
      const userId = randomUUID();
      const patientId = randomUUID();
      authTokens.set('user-a', userId);
      await seedPatientAndUser(pool, userId, patientId);
      await seedRelationship(pool, userId, patientId);

      const seeded = await seedHypoEpisodeGraph(pool, {
        patientId,
        episodeState: 'OPEN',
        severity: 'L1',
        startedAt: isoAt(40),
        questionStatus: 'OPEN',
        awaitingUserAnswer: true,
      });

      await seedInvestigation(pool, {
        patientId,
        eventId: seeded.eventId,
        episodeId: seeded.episodeId,
        triggerId: seeded.triggerId,
        conversationId: seeded.conversationId,
        state,
        activeQuestionId: state === 'RE_EVALUATING' ? null : seeded.questionId,
        createdAt: isoAt(41),
        updatedAt: isoAt(41),
      });

      const res = await request(app.getHttpServer())
        .get(`/v1/patients/${patientId}/pending-investigation`)
        .set('Authorization', 'Bearer user-a')
        .expect(200);

      expect(res.body.pending_investigation).toBeNull();
    });
  }

  it('deterministically returns the newest pending investigation when many are pending', async () => {
    const userId = randomUUID();
    const patientId = randomUUID();
    authTokens.set('user-a', userId);
    await seedPatientAndUser(pool, userId, patientId);
    await seedRelationship(pool, userId, patientId);

    const older = await seedHypoEpisodeGraph(pool, {
      patientId,
      episodeState: 'OPEN',
      severity: 'L1',
      startedAt: isoAt(50),
      questionStatus: 'OPEN',
      awaitingUserAnswer: true,
      questionId: 'q-old',
      questionText: 'Old question',
    });

    await seedInvestigation(pool, {
      patientId,
      eventId: older.eventId,
      episodeId: older.episodeId,
      triggerId: older.triggerId,
      conversationId: older.conversationId,
      state: 'QUESTION_PENDING',
      activeQuestionId: 'q-old',
      createdAt: isoAt(51),
      updatedAt: isoAt(51),
    });

    const newer = await seedHypoEpisodeGraph(pool, {
      patientId,
      episodeState: 'OPEN',
      severity: 'L2',
      startedAt: isoAt(60),
      questionStatus: 'OPEN',
      awaitingUserAnswer: true,
      questionId: 'q-new',
      questionText: 'New question',
    });

    await seedInvestigation(pool, {
      patientId,
      eventId: newer.eventId,
      episodeId: newer.episodeId,
      triggerId: newer.triggerId,
      conversationId: newer.conversationId,
      state: 'QUESTION_PENDING',
      activeQuestionId: 'q-new',
      createdAt: isoAt(61),
      updatedAt: isoAt(61),
    });

    const res = await request(app.getHttpServer())
      .get(`/v1/patients/${patientId}/pending-investigation`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);

    expect(res.body.pending_investigation.question_id).toBe('q-new');
    expect(res.body.pending_investigation.question).toBe('New question');
    expect(res.body.pending_investigation.conversation_id).toBe(newer.conversationId);
  });

  it('enforces patient isolation for pending-investigation endpoint', async () => {
    const userId = randomUUID();
    const patientA = randomUUID();
    const patientB = randomUUID();
    authTokens.set('user-a', userId);
    await seedPatientAndUser(pool, userId, patientA);
    await seedPatientAndUser(pool, userId, patientB);
    await seedRelationship(pool, userId, patientA);

    const seeded = await seedHypoEpisodeGraph(pool, {
      patientId: patientA,
      episodeState: 'OPEN',
      severity: 'L1',
      startedAt: isoAt(70),
      questionStatus: 'OPEN',
      awaitingUserAnswer: true,
    });

    await seedInvestigation(pool, {
      patientId: patientA,
      eventId: seeded.eventId,
      episodeId: seeded.episodeId,
      triggerId: seeded.triggerId,
      conversationId: seeded.conversationId,
      state: 'QUESTION_PENDING',
      activeQuestionId: seeded.questionId,
      createdAt: isoAt(71),
      updatedAt: isoAt(71),
    });

    await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/pending-investigation`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);

    await request(app.getHttpServer())
      .get(`/v1/patients/${patientB}/pending-investigation`)
      .set('Authorization', 'Bearer user-a')
      .expect(403);
  });

  it('regression: pending investigation remains available when no hypo is open', async () => {
    const userId = randomUUID();
    const patientId = randomUUID();
    authTokens.set('user-a', userId);
    await seedPatientAndUser(pool, userId, patientId);
    await seedRelationship(pool, userId, patientId);

    const seeded = await seedHypoEpisodeGraph(pool, {
      patientId,
      episodeState: 'CLOSED',
      severity: 'L1',
      startedAt: isoAt(80),
      endedAt: isoAt(81),
      questionStatus: 'OPEN',
      awaitingUserAnswer: true,
      questionId: 'q-pending',
      questionText: 'Pending despite no open hypo',
    });

    await seedInvestigation(pool, {
      patientId,
      eventId: seeded.eventId,
      episodeId: seeded.episodeId,
      triggerId: seeded.triggerId,
      conversationId: seeded.conversationId,
      state: 'QUESTION_PENDING',
      activeQuestionId: 'q-pending',
      createdAt: isoAt(82),
      updatedAt: isoAt(82),
    });

    const pending = await request(app.getHttpServer())
      .get(`/v1/patients/${patientId}/pending-investigation`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);

    expect(pending.body.pending_investigation).not.toBeNull();
    expect(pending.body.pending_investigation.question).toBe('Pending despite no open hypo');
  });

  it('lists all pending questions for the patient in newest-first order and enforces patient isolation', async () => {
    const userId = randomUUID();
    const patientA = randomUUID();
    const patientB = randomUUID();
    authTokens.set('user-a', userId);
    await seedPatientAndUser(pool, userId, patientA);
    await seedPatientAndUser(pool, userId, patientB);
    await seedRelationship(pool, userId, patientA);

    const older = await seedHypoEpisodeGraph(pool, {
      patientId: patientA,
      episodeState: 'OPEN',
      severity: 'L1',
      startedAt: isoAt(90),
      questionStatus: 'OPEN',
      awaitingUserAnswer: true,
      questionId: 'q-old',
      questionText: 'Older question',
    });
    await seedInvestigation(pool, {
      patientId: patientA,
      eventId: older.eventId,
      episodeId: older.episodeId,
      triggerId: older.triggerId,
      conversationId: older.conversationId,
      state: 'QUESTION_PENDING',
      activeQuestionId: 'q-old',
      createdAt: isoAt(91),
      updatedAt: isoAt(91),
    });

    const newer = await seedHypoEpisodeGraph(pool, {
      patientId: patientA,
      episodeState: 'OPEN',
      severity: 'L2',
      startedAt: isoAt(100),
      questionStatus: 'OPEN',
      awaitingUserAnswer: true,
      questionId: 'q-new',
      questionText: 'Newer question',
    });
    await seedInvestigation(pool, {
      patientId: patientA,
      eventId: newer.eventId,
      episodeId: newer.episodeId,
      triggerId: newer.triggerId,
      conversationId: newer.conversationId,
      state: 'QUESTION_PENDING',
      activeQuestionId: 'q-new',
      createdAt: isoAt(101),
      updatedAt: isoAt(101),
    });

    const onlyPatientA = await request(app.getHttpServer())
      .get(`/v1/patients/${patientA}/pending-questions`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);

    expect(onlyPatientA.body.patient_id).toBe(patientA);
    expect(onlyPatientA.body.items.map((item: any) => item.question_id)).toEqual(['q-new', 'q-old']);
    expect(onlyPatientA.body.items.map((item: any) => item.origin)).toEqual(['SYSTEM', 'SYSTEM']);
    expect(onlyPatientA.body.items.map((item: any) => item.conversation_type)).toEqual(['TRIGGER_INITIATED', 'TRIGGER_INITIATED']);

    await request(app.getHttpServer())
      .get(`/v1/patients/${patientB}/pending-questions`)
      .set('Authorization', 'Bearer user-a')
      .expect(403);
  });

  it('excludes pending investigation conversations from the normal conversation history list', async () => {
    const userId = randomUUID();
    const patientId = randomUUID();
    authTokens.set('user-a', userId);
    await seedPatientAndUser(pool, userId, patientId);
    await seedRelationship(pool, userId, patientId);

    const pending = await seedHypoEpisodeGraph(pool, {
      patientId,
      episodeState: 'OPEN',
      severity: 'L1',
      startedAt: isoAt(110),
      questionStatus: 'OPEN',
      awaitingUserAnswer: true,
      questionId: 'q-pending-history',
      questionText: 'Pending question should be hidden from history',
    });
    await seedInvestigation(pool, {
      patientId,
      eventId: pending.eventId,
      episodeId: pending.episodeId,
      triggerId: pending.triggerId,
      conversationId: pending.conversationId,
      state: 'QUESTION_PENDING',
      activeQuestionId: 'q-pending-history',
      createdAt: isoAt(111),
      updatedAt: isoAt(111),
    });

    const conversations = await request(app.getHttpServer())
      .get(`/v1/patients/${patientId}/conversations?limit=50`)
      .set('Authorization', 'Bearer user-a')
      .expect(200);

    expect(conversations.body.items.some((item: any) => item.id === pending.conversationId)).toBe(false);
  });
});
