import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresGlucoMindRepository } from './postgres-glucomind.repository';
import { configurePostgresIntegrationEnvironment, truncatePublicTablesForIntegrationTests } from './postgres-test-isolation';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

describePostgres('user message analysis cancellation (PostgreSQL)', () => {
  let pool: Pool;
  let repository: PostgresGlucoMindRepository;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required for user message cancellation postgres tests');
    }
    pool = new Pool({ connectionString: databaseUrl });
    repository = new PostgresGlucoMindRepository(pool);
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
  });

  afterAll(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    await pool?.end();
  });

  async function scaffold(jobStatus: 'queued' | 'running' | 'succeeded' | 'failed' | null) {
    const patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'p')`, [patientId]);
    const conversation = await repository.createConversation({
      patientId, origin: 'USER', conversationType: 'USER_INITIATED', threadStateVersion: 'conv-v1', awaitingUserAnswer: false,
    });
    const conversationId = String(conversation.conversation.id);
    const message = await repository.insertMessage({
      conversationId, patientId, role: 'USER', messageType: 'USER_MESSAGE', content: ' Czy pomożesz\n  ustalić, jak minął wczorajszy dzień? ',
      questionId: null, answerType: null, answerText: null, answerValue: null, provenanceRef: 'user', metadata: {}, idempotencyKey: randomUUID(),
    });
    const userMessageId = String(message.id);
    if (jobStatus) {
      await pool.query(
        `INSERT INTO jobs (job_type, status, payload, dedupe_key, correlation_id, patient_id)
         VALUES ('conversation.direct_response', $1, $2::jsonb, $3, $4::uuid, $5::uuid)`,
        [jobStatus, JSON.stringify({ patient_id: patientId, conversation_id: conversationId, user_message_id: userMessageId }), `d:${userMessageId}`, conversationId, patientId],
      );
    }
    return { patientId, conversationId, userMessageId };
  }

  const cancel = (ids: { patientId: string; conversationId: string; userMessageId: string }) => repository.cancelUserMessageResponse({
    ...ids, cancelledBy: randomUUID(), nowIso: new Date().toISOString(),
  });

  it('cancels a queued job so it can never be claimed, idempotently', async () => {
    const ids = await scaffold('queued');
    await expect(cancel(ids)).resolves.toEqual({ outcome: 'CANCELLED', job_status: 'cancelled' });
    await expect(cancel(ids)).resolves.toMatchObject({ outcome: 'ALREADY_CANCELLED' });
    await expect(repository.claimNextJob('worker-1', new Date(Date.now() + 60_000).toISOString(), 60)).resolves.toBeNull();
    await expect(repository.claimUserMessageCompletion(ids.conversationId, ids.userMessageId)).resolves.toBe(false);
  });

  it('lets exactly one side win the race between cancel and completion claim', async () => {
    const won = await scaffold('running');
    await expect(repository.claimUserMessageCompletion(won.conversationId, won.userMessageId)).resolves.toBe(true);
    await expect(cancel(won)).resolves.toMatchObject({ outcome: 'ALREADY_COMPLETED' });

    const lost = await scaffold('running');
    await expect(cancel(lost)).resolves.toMatchObject({ outcome: 'CANCELLED', job_status: 'running' });
    await expect(repository.claimUserMessageCompletion(lost.conversationId, lost.userMessageId)).resolves.toBe(false);
    await expect(repository.isUserMessageCancelled(lost.conversationId, lost.userMessageId)).resolves.toBe(true);

    const concurrent = await scaffold('running');
    const [cancelled, claimed] = await Promise.all([cancel(concurrent), repository.claimUserMessageCompletion(concurrent.conversationId, concurrent.userMessageId)]);
    expect((cancelled?.outcome === 'CANCELLED') !== claimed).toBe(true);
  });

  it('rejects messages of another patient or without a cancellable job', async () => {
    const ids = await scaffold('failed');
    await expect(cancel(ids)).resolves.toMatchObject({ outcome: 'NOT_CANCELLABLE' });
    await expect(cancel({ ...ids, patientId: randomUUID() })).resolves.toBeNull();
  });

  it('reports the history status of every conversation in the list query', async () => {
    const processing = await scaffold('running');
    const cancelled = await scaffold('queued');
    await cancel(cancelled);
    const failed = await scaffold('failed');

    for (const ids of [processing, cancelled, failed]) {
      const list = await repository.listConversations(ids.patientId, 10, null);
      const expected = ids === processing ? 'PROCESSING' : ids === cancelled ? 'CANCELLED' : 'FAILED';
      expect((list.items[0] as Record<string, unknown>).activity_status).toBe(expected);
      expect((list.items[0] as Record<string, unknown>).title_preview).toBe('Czy pomożesz ustalić, jak minął wczorajszy dzień?');
    }
  });

  it('does not keep showing an older failed analysis once a later one succeeded', async () => {
    const ids = await scaffold(null);
    const insertExecution = (status: 'failed' | 'succeeded' | 'running', startedAt: string, processingState: Record<string, unknown> | null) => pool.query(
      `INSERT INTO ai_executions (task_identity, task_id, task_type, task_version, patient_id, context_package_id, context_package_version,
         context_package_hash, correlation_id, input_hash, prompt_version, output_schema_version, model_policy_version, status, started_at, processing_state)
       VALUES ($1, $1, 'conversation.time_range_analysis', 'v1', $2, 'cp', 'v1', 'h', $3, 'h', 'p1', 's1', 'm1', $4, $5::timestamptz, $6::jsonb)`,
      [randomUUID(), ids.patientId, ids.conversationId, status, startedAt, processingState === null ? null : JSON.stringify(processingState)],
    );
    await insertExecution('failed', '2026-10-15T07:54:21.000Z', { status: 'FAILED', current_step: { type: 'FAILED' }, steps: [] });
    expect((await repository.getConversation(ids.patientId, ids.conversationId))?.processing).toMatchObject({ status: 'FAILED' });

    await insertExecution('succeeded', '2026-10-15T07:57:53.000Z', null);
    expect((await repository.getConversation(ids.patientId, ids.conversationId))?.processing).toBeNull();

    await insertExecution('running', '2026-10-15T08:10:00.000Z', { status: 'PROCESSING', current_step: null, steps: [] });
    expect((await repository.getConversation(ids.patientId, ids.conversationId))?.processing).toMatchObject({ status: 'PROCESSING' });
  });

  it('reports a conversation without messages as EMPTY with no title', async () => {
    const patientId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'p')`, [patientId]);
    await repository.createConversation({ patientId, origin: 'USER', conversationType: 'USER_INITIATED', threadStateVersion: 'conv-v1', awaitingUserAnswer: false });
    const list = await repository.listConversations(patientId, 10, null);
    expect(list.items[0]).toMatchObject({ activity_status: 'EMPTY', title_preview: null });
  });
});
