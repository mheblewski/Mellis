import 'dotenv/config';
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
import { FakePushNotificationProvider } from '@modules/notifications/infrastructure/fake-push-notification-provider';
import { PushNotificationService } from '@modules/notifications/application/push-notification.service';
import { WorkerService } from '../../../../apps/worker/src/worker.service';
import { ApiService } from '../../../../apps/api/src/application/api.service';
import { truncatePublicTablesForIntegrationTests } from '@infra/db/postgres-test-isolation';
import { detectHypo } from '@modules/triggering/application/hypo-detector';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
})
class ReplayBoundaryModule {}

type SyntheticEntry = {
  _id: string;
  date: number;
  dateString: string;
  patient: string;
  sgv: number;
  units: 'mg/dL';
};

function buildRelativeNightscoutEntry(patientId: string, id: string, minutesAgo: number, value: number): SyntheticEntry {
  const observed = new Date(Date.now() - minutesAgo * 60_000);
  return {
    _id: id,
    date: observed.getTime(),
    dateString: observed.toISOString(),
    patient: patientId,
    sgv: value,
    units: 'mg/dL',
  };
}

class ReplayBoundaryNightscoutClient implements NightscoutClient {
  constructor(private readonly entriesByPatient: Map<string, SyntheticEntry[]>) {}

  async fetchEntries(input: { patient_id: string; before?: string }): Promise<{ entries: Record<string, unknown>[]; next_cursor: string | null }> {
    // The look-back read behind the cursor (late uploads) finds nothing here: each sync takes the next queued entry.
    if (input.before) return { entries: [], next_cursor: null };
    const queue = this.entriesByPatient.get(input.patient_id) ?? [];
    const next = queue.shift();
    return {
      entries: next ? [next as unknown as Record<string, unknown>] : [],
      next_cursor: null,
    };
  }

  async fetchTreatments(): Promise<{ treatments: Record<string, unknown>[]; next_cursor: string | null }> {
    return { treatments: [], next_cursor: null };
  }

  async fetchDeviceStatuses(): Promise<{ device_statuses: Record<string, unknown>[]; next_cursor: string | null }> {
    return { device_statuses: [], next_cursor: null };
  }
}

async function ensureActors(pool: Pool, userId: string, patientId: string): Promise<void> {
  await pool.query(
    `
      INSERT INTO users (id, display_name)
      VALUES ($1::uuid, 'replay-boundary-user')
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

async function processUntilQueuedEmpty(worker: WorkerService, pool: Pool, maxIterations = 120): Promise<void> {
  for (let i = 0; i < maxIterations; i += 1) {
    await worker.processSyncLaneOnce();
    await worker.processOnce();
    const queued = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM jobs WHERE status = 'queued'`);
    if (Number(queued.rows[0].count) === 0) {
      return;
    }
  }
}

async function findEpisodeForSourceRecord(pool: Pool, patientId: string, sourceRecordId: string): Promise<{ episode_id: string; event_id: string; ended_at: Date | null; conversations: number } | null> {
  const row = await pool.query<{ episode_id: string; event_id: string; ended_at: Date | null; conversations: string }>(
    `
      SELECT h.id::text AS episode_id,
             e.id::text AS event_id,
             h.ended_at,
             (SELECT count(*)::text FROM conversations c WHERE c.episode_id = h.id) AS conversations
      FROM source_records sr
      JOIN events e ON e.source_record_id = sr.id
      JOIN triggers t ON t.source_event_id = e.id
      JOIN hypo_episodes h ON h.id = t.episode_id
      WHERE sr.patient_id = $1::uuid
        AND sr.source_record_id = $2
        AND e.type = 'GLUCOSE_READING_AVAILABLE'
      LIMIT 1
    `,
    [patientId, sourceRecordId],
  );
  const found = row.rows[0];
  return found ? { episode_id: found.episode_id, event_id: found.event_id, ended_at: found.ended_at, conversations: Number(found.conversations) } : null;
}

/**
 * Recreates the rows that HISTORICAL hypo detection wrote before episodes from backfills became analytical only
 * (conversation + analysis.follow_up), so the legacy-data boundary keeps being tested.
 */
async function simulateLegacyHistoricalConversation(pool: Pool, nightscoutRepository: PostgresNightscoutRepository, patientId: string, eventId: string): Promise<void> {
  const event = (await pool.query<{ occurred_at: Date; recorded_at: Date; payload: Record<string, unknown>; source_record_id: string }>(
    `SELECT occurred_at, recorded_at, payload, source_record_id::text AS source_record_id FROM events WHERE id = $1::uuid`,
    [eventId],
  )).rows[0];
  const reading = {
    reading_id: eventId,
    source_record_id: event.source_record_id,
    observed_at: new Date(event.occurred_at).toISOString(),
    recorded_at: new Date(event.recorded_at).toISOString(),
    glucose_value: Number(event.payload.glucose_value),
    glucose_unit: 'mg/dL' as const,
    classification: 'UNKNOWN' as const,
    relation_to_episode: 'LATEST' as const,
    validity: 'VALID' as const,
    provenance_ref: `source-record/${event.source_record_id}`,
  };
  void reading;
  void nightscoutRepository;
  // The legacy rows themselves: a SYSTEM conversation for the episode and its analysis.follow_up job, exactly as
  // hypo detection wrote them when it started the conversation for every new episode.
  const episode = (await pool.query<{ episode_id: string; trigger_id: string }>(
    `SELECT t.episode_id::text AS episode_id, t.id::text AS trigger_id FROM triggers t WHERE t.patient_id = $1::uuid AND t.source_event_id = $2::uuid LIMIT 1`,
    [patientId, eventId],
  )).rows[0];
  const conversation = (await pool.query<{ id: string }>(
    `
      INSERT INTO conversations (patient_id, episode_id, trigger_id, origin, trigger_type, thread_state_version, awaiting_user_answer, conversation_type)
      VALUES ($1, $2, $3, 'SYSTEM', 'HYPO_DETECTED', 'conv-v1', true, 'TRIGGER_INITIATED')
      ON CONFLICT (patient_id, episode_id) DO UPDATE SET updated_at = now()
      RETURNING id::text
    `,
    [patientId, episode.episode_id, episode.trigger_id],
  )).rows[0];
  await pool.query(
    `
      INSERT INTO jobs (job_type, status, payload_version, payload, dedupe_key, correlation_id, causation_id, patient_id, available_at, max_attempts)
      VALUES ('analysis.follow_up', 'queued', 1, $1::jsonb, $2, $3, $4, $5, now(), 5)
      ON CONFLICT (job_type, dedupe_key) DO NOTHING
    `,
    [
      JSON.stringify({ patient_id: patientId, conversation_id: conversation.id, source_event_id: eventId }),
      `analysis.follow_up:trigger:${conversation.id}:${eventId}`,
      conversation.id,
      episode.trigger_id,
      patientId,
    ],
  );
}

async function findConversationForSourceRecord(pool: Pool, patientId: string, sourceRecordId: string): Promise<{ conversation_id: string; event_id: string; episode_id: string } | null> {
  const row = await pool.query<{ conversation_id: string; event_id: string; episode_id: string }>(
    `
      SELECT c.id::text AS conversation_id,
             e.id::text AS event_id,
             h.id::text AS episode_id
      FROM source_records sr
      JOIN events e ON e.source_record_id = sr.id
      JOIN triggers t ON t.source_event_id = e.id
      JOIN hypo_episodes h ON h.id = t.episode_id
      JOIN conversations c ON c.episode_id = h.id
      WHERE sr.patient_id = $1::uuid
        AND sr.source_record_id = $2
        AND e.type = 'GLUCOSE_READING_AVAILABLE'
      ORDER BY c.created_at DESC
      LIMIT 1
    `,
    [patientId, sourceRecordId],
  );

  return row.rows[0] ?? null;
}

/** The investigation of a hypo's source event, or null. */
async function investigationOfEvent(pool: Pool, patientId: string, eventId: string): Promise<Record<string, unknown> | null> {
  return (await pool.query(`SELECT * FROM investigations WHERE patient_id = $1 AND event_id = $2 LIMIT 1`, [patientId, eventId])).rows[0] ?? null;
}

describePostgres('historical replay user-facing boundary (postgres)', { timeout: 120_000 }, () => {
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;
  let pool: Pool;
  let repository: PostgresGlucoMindRepository;
  let nightscoutRepository: PostgresNightscoutRepository;
  let nightscoutSync: NightscoutSyncService;
  let worker: WorkerService;
  let api: ApiService;
  let entriesByPatient: Map<string, SyntheticEntry[]>;

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(ReplayBoundaryModule, { logger: ['error', 'warn'] });
    pool = app.get<Pool>(DATABASE_POOL);
    repository = app.get(PostgresGlucoMindRepository, { strict: false });
    nightscoutRepository = app.get(PostgresNightscoutRepository, { strict: false });
    const configService = app.get(ConfigService);

    await truncatePublicTablesForIntegrationTests(pool);

    entriesByPatient = new Map<string, SyntheticEntry[]>();
    nightscoutSync = new NightscoutSyncService(
      nightscoutRepository,
      repository,
      new ReplayBoundaryNightscoutClient(entriesByPatient),
    );

    worker = new WorkerService(
      repository,
      nightscoutSync,
      configService,
      new AiGatewayService(new FakeAiProvider()),
      new PushNotificationService(new FakePushNotificationProvider()),
    );

    api = new ApiService(repository);
  });

  afterAll(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    await app.close();
  });

  it('stores a closed LIVE hypo as an episode and asks nothing about it: no conversation, question card or push', async () => {
    const patientId = randomUUID();
    const userId = randomUUID();
    await ensureActors(pool, userId, patientId);

    entriesByPatient.set(patientId, [
      buildRelativeNightscoutEntry(patientId, 'live-entry-1', 20, 63),
      // Back above 70 mg/dL: the episode closes; since 2026-10-25 nothing is asked about it after the fact.
      buildRelativeNightscoutEntry(patientId, 'live-entry-2', 1, 95),
    ]);

    await nightscoutSync.ensureNightscoutSource(patientId, 'https://nightscout.example.com');
    await nightscoutSync.enqueueRecurringSyncJobs(new Date().toISOString());
    await processUntilQueuedEmpty(worker, pool);
    // The fake client returns one entry per sync: a second sync (another minute bucket, available now) brings the
    // recovery reading.
    await nightscoutSync.enqueueRecurringSyncJobs(new Date(Date.now() - 60_000).toISOString());
    await processUntilQueuedEmpty(worker, pool);

    const episode = await findEpisodeForSourceRecord(pool, patientId, 'live-entry-1');
    expect(episode?.ended_at).toBeTruthy();
    expect(episode?.conversations).toBe(0);

    // No investigation, no question card and nothing pushed after the fact.
    const investigation = await investigationOfEvent(pool, patientId, String(episode?.event_id));
    expect(investigation).toBeNull();
    const pending = await api.getPendingInvestigation({ user_id: userId } as any, patientId);
    expect(pending.pending_investigation).toBeNull();

    const pushRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM push_notifications WHERE patient_id = $1::uuid`,
      [patientId],
    );
    expect(Number(pushRows.rows[0].count)).toBe(0);
  });

  it('processes historical replay analytically: the episode is stored without conversation, investigation, question, push or follow-up', async () => {
    const patientId = randomUUID();
    const userId = randomUUID();
    await ensureActors(pool, userId, patientId);

    const now = new Date();
    const historicalObserved = new Date(now.getTime() - 8 * 60 * 60 * 1000);
    entriesByPatient.set(patientId, [
      buildRelativeNightscoutEntry(patientId, 'historical-entry-1', 8 * 60, 68),
    ]);

    const source = await nightscoutSync.ensureNightscoutSource(patientId, 'https://nightscout.example.com');
    await nightscoutSync.runNightscoutSyncWindow(
      source.id,
      now.toISOString(),
      new Date(historicalObserved.getTime() - 5 * 60 * 1000).toISOString(),
      new Date(historicalObserved.getTime() + 5 * 60 * 1000).toISOString(),
    );
    await processUntilQueuedEmpty(worker, pool);

    const episode = await findEpisodeForSourceRecord(pool, patientId, 'historical-entry-1');
    expect(episode).toBeTruthy();
    expect(episode?.conversations).toBe(0);

    const eventOrigin = await pool.query<{ event_ingestion_origin: string }>(
      `SELECT event_ingestion_origin FROM events WHERE id = $1::uuid`,
      [String(episode?.event_id)],
    );
    expect(eventOrigin.rows[0].event_ingestion_origin).toBe('HISTORICAL');

    const investigation = await investigationOfEvent(pool, patientId, String(episode?.event_id));
    expect(investigation).toBeNull();

    const counts = await pool.query<{ conversations: string; open_questions: string; pushes: string; follow_ups: string }>(
      `
        SELECT
          (SELECT count(*)::text FROM conversations WHERE patient_id = $1::uuid) AS conversations,
          (SELECT count(*)::text FROM context_questions WHERE patient_id = $1::uuid AND status = 'OPEN') AS open_questions,
          (SELECT count(*)::text FROM push_notifications WHERE patient_id = $1::uuid) AS pushes,
          (SELECT count(*)::text FROM jobs WHERE patient_id = $1::uuid AND job_type = 'analysis.follow_up') AS follow_ups
      `,
      [patientId],
    );
    expect(counts.rows[0]).toEqual({ conversations: '0', open_questions: '0', pushes: '0', follow_ups: '0' });

    const pending = await api.getPendingInvestigation({ user_id: userId } as any, patientId);
    expect(pending.pending_investigation).toBeNull();
  });

  it('filters legacy historical QUESTION_PENDING, also next to a live hypo (which has no pending investigation)', async () => {
    const patientId = randomUUID();
    const userId = randomUUID();
    await ensureActors(pool, userId, patientId);

    const now = new Date();
    const historicalObserved = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    entriesByPatient.set(patientId, [
      buildRelativeNightscoutEntry(patientId, 'historical-entry-legacy', 12 * 60, 67),
    ]);

    const source = await nightscoutSync.ensureNightscoutSource(patientId, 'https://nightscout.example.com');
    await nightscoutSync.runNightscoutSyncWindow(
      source.id,
      now.toISOString(),
      new Date(historicalObserved.getTime() - 5 * 60 * 1000).toISOString(),
      new Date(historicalObserved.getTime() + 5 * 60 * 1000).toISOString(),
    );
    await processUntilQueuedEmpty(worker, pool);

    // Current behaviour stores no conversation for the HISTORICAL episode; recreate the legacy rows explicitly.
    const legacyEpisode = await findEpisodeForSourceRecord(pool, patientId, 'historical-entry-legacy');
    expect(legacyEpisode?.conversations).toBe(0);
    await simulateLegacyHistoricalConversation(pool, nightscoutRepository, patientId, String(legacyEpisode?.event_id));
    await processUntilQueuedEmpty(worker, pool);

    const historicalConversation = await findConversationForSourceRecord(pool, patientId, 'historical-entry-legacy');
    expect(historicalConversation).toBeTruthy();

    await pool.query(
      `
        INSERT INTO context_questions (
          conversation_id, patient_id, question_id, question_type, question_text, reason, expected_information_gain, expected_answer_types, related_event_id, status
        ) VALUES (
          $1::uuid, $2::uuid, 'activity_before_drop', 'CONTEXT_QUESTION', 'Was there activity?', 'legacy', 'HIGH', '["YES","NO","UNKNOWN"]'::jsonb, $3::uuid, 'OPEN'
        )
        ON CONFLICT (conversation_id, question_id)
        DO UPDATE SET status = 'OPEN', updated_at = now()
      `,
      [String(historicalConversation?.conversation_id), patientId, String(historicalConversation?.event_id)],
    );

    await pool.query(
      `
        UPDATE investigations
        SET state = 'QUESTION_PENDING',
            active_question_id = 'activity_before_drop',
            updated_at = now()
        WHERE patient_id = $1::uuid
          AND event_id = $2::uuid
      `,
      [patientId, String(historicalConversation?.event_id)],
    );

    await pool.query(
      `UPDATE conversations SET awaiting_user_answer = true WHERE id = $1::uuid`,
      [String(historicalConversation?.conversation_id)],
    );

    const historicalOnlyPending = await api.getPendingInvestigation({ user_id: userId } as any, patientId);
    expect(historicalOnlyPending.pending_investigation).toBeNull();

    const livePatientId = randomUUID();
    const liveUserId = randomUUID();
    await ensureActors(pool, liveUserId, livePatientId);

    entriesByPatient.set(livePatientId, [
      buildRelativeNightscoutEntry(livePatientId, 'live-entry-mixed', 18, 62),
      buildRelativeNightscoutEntry(livePatientId, 'live-entry-mixed-recovery', 1, 92),
    ]);

    await nightscoutSync.ensureNightscoutSource(livePatientId, 'https://nightscout.example.com');
    await nightscoutSync.enqueueRecurringSyncJobs(new Date().toISOString());
    await processUntilQueuedEmpty(worker, pool);
    // The fake client returns one entry per sync: a second sync (another minute bucket, available now) brings the
    // recovery reading.
    await nightscoutSync.enqueueRecurringSyncJobs(new Date(Date.now() - 60_000).toISOString());
    await processUntilQueuedEmpty(worker, pool);

    const liveEpisode = await findEpisodeForSourceRecord(pool, livePatientId, 'live-entry-mixed');
    expect(liveEpisode?.ended_at).toBeTruthy();
    expect(liveEpisode?.conversations).toBe(0);

    const pendingAfterLive = await api.getPendingInvestigation({ user_id: liveUserId } as any, livePatientId);
    expect(pendingAfterLive.pending_investigation).toBeNull();
    expect((await api.getPendingInvestigation({ user_id: userId } as any, patientId)).pending_investigation).toBeNull();
  });

  it('is idempotent when the same historical source record is replayed twice', async () => {
    const patientId = randomUUID();
    const userId = randomUUID();
    await ensureActors(pool, userId, patientId);

    const now = new Date();
    const historicalObserved = new Date(now.getTime() - 18 * 60 * 60 * 1000);
    entriesByPatient.set(patientId, [
      buildRelativeNightscoutEntry(patientId, 'historical-entry-idempotent', 18 * 60, 66),
      buildRelativeNightscoutEntry(patientId, 'historical-entry-idempotent', 18 * 60, 66),
    ]);

    const source = await nightscoutSync.ensureNightscoutSource(patientId, 'https://nightscout.example.com');
    await nightscoutSync.runNightscoutSyncWindow(
      source.id,
      now.toISOString(),
      new Date(historicalObserved.getTime() - 10 * 60 * 1000).toISOString(),
      new Date(historicalObserved.getTime() + 10 * 60 * 1000).toISOString(),
    );
    await processUntilQueuedEmpty(worker, pool);

    await nightscoutSync.runNightscoutSyncWindow(
      source.id,
      new Date(Date.now() + 5 * 60_000).toISOString(),
      new Date(historicalObserved.getTime() - 10 * 60 * 1000).toISOString(),
      new Date(historicalObserved.getTime() + 10 * 60 * 1000).toISOString(),
    );
    await processUntilQueuedEmpty(worker, pool);

    const counts = await pool.query<{
      source_records: string;
      events: string;
      triggers: string;
      episodes: string;
      conversations: string;
      investigations: string;
    }>(
      `
        WITH src AS (
          SELECT id
          FROM source_records
          WHERE patient_id = $1::uuid
            AND source_record_id = 'historical-entry-idempotent'
        ),
        ev AS (
          SELECT id
          FROM events
          WHERE source_record_id IN (SELECT id FROM src)
            AND type = 'GLUCOSE_READING_AVAILABLE'
        ),
        trg AS (
          SELECT id, episode_id
          FROM triggers
          WHERE source_event_id IN (SELECT id FROM ev)
        ),
        ep AS (
          SELECT id
          FROM hypo_episodes
          WHERE id IN (SELECT episode_id FROM trg)
        ),
        conv AS (
          SELECT id
          FROM conversations
          WHERE episode_id IN (SELECT id FROM ep)
        )
        SELECT
          (SELECT count(*)::text FROM src) AS source_records,
          (SELECT count(*)::text FROM ev) AS events,
          (SELECT count(*)::text FROM trg) AS triggers,
          (SELECT count(*)::text FROM ep) AS episodes,
          (SELECT count(*)::text FROM conv) AS conversations,
          (SELECT count(*)::text FROM investigations WHERE event_id IN (SELECT id FROM ev)) AS investigations
      `,
      [patientId],
    );

    const row = counts.rows[0];
    expect(Number(row.source_records)).toBe(1);
    expect(Number(row.events)).toBe(1);
    expect(Number(row.triggers)).toBe(1);
    expect(Number(row.episodes)).toBe(1);
    // Analytical only: no conversation and therefore no investigation for a HISTORICAL episode.
    expect(Number(row.conversations)).toBe(0);
    expect(Number(row.investigations)).toBe(0);
  });
});
