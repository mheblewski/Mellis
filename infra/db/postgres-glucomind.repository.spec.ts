import { describe, expect, it, vi } from 'vitest';
import { PostgresGlucoMindRepository } from './postgres-glucomind.repository';

describe('PostgresGlucoMindRepository', () => {
  it('reserves a deterministic attempt number for the same logical execution before the provider response is available', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'exec-1' }] })
      .mockResolvedValueOnce({ rows: [{ next_attempt_number: '1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'attempt-1', attempt_number: 1 }] });

    const repository = new PostgresGlucoMindRepository({ query } as any);

    await expect(repository.createAiExecutionAttempt({
      taskIdentity: 'task-identity',
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      startedAt: '2026-10-01T00:00:00.000Z',
    })).resolves.toEqual({ id: 'attempt-1', attempt_number: 1 });

    expect(query).toHaveBeenCalledTimes(3);
  });

  it('propagates database errors from markAiExecutionSucceeded (no silent downgrade)', async () => {
    const query = vi.fn().mockRejectedValue(Object.assign(new Error('column "input_fingerprint" of relation "ai_executions" does not exist'), { code: '42703' }));
    const repository = new PostgresGlucoMindRepository({ query } as any);

    await expect(
      repository.markAiExecutionSucceeded({
        taskIdentity: 'task-identity',
        nowIso: '2026-10-01T00:00:00.000Z',
        result: {
          task: {
            task_id: 'task-1',
            task_type: 'CONVERSATION_DIRECT_RESPONSE',
            task_version: 'v1',
            context_package_id: 'cp-1',
            context_package_version: 'context-package.v1',
            context_package_hash: 'hash-1',
            prompt_version: 'prompt-v1',
            output_schema_version: 'schema-v1',
            model_policy_version: 'model-policy-v1',
            correlation_id: 'corr-1',
            created_at: '2026-10-01T00:00:00.000Z',
          },
          input_hash: 'input-hash-1',
          task_identity: 'task-identity',
          metadata: {
            provider: 'fake',
            model: 'fake-model',
            prompt_version: 'prompt-v1',
            output_schema_version: 'schema-v1',
            model_policy_version: 'model-policy-v1',
            model_fingerprint: 'fp-1',
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              cached_input_tokens: 0,
              reasoning_tokens: 0,
            },
          },
          result: { assistant_message: 'ok' },
        },
      }),
    ).rejects.toMatchObject({ code: '42703' });

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('claimNextJob sends the allowed job types as one SQL array parameter, null when unrestricted, and refuses an empty list', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = { query: vi.fn(async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return { rows: [] }; }), release: vi.fn() };
    const repository = new PostgresGlucoMindRepository({ connect: vi.fn(async () => client) } as any);

    await repository.claimNextJob('w', '2026-10-05T10:00:00.000Z', 300, ['nightscout.sync', 'meal.wbt_suggestion']);
    const restricted = calls.find((call) => call.sql.includes('ORDER BY'))!;
    expect(restricted.sql).toContain('($6::text[] IS NULL OR job_type = ANY($6::text[]))');
    expect(restricted.params?.[5]).toEqual(['nightscout.sync', 'meal.wbt_suggestion']);

    calls.length = 0;
    await repository.claimNextJob('w', '2026-10-05T10:00:00.000Z', 300);
    expect(calls.find((call) => call.sql.includes('ORDER BY'))!.params?.[5]).toBeNull();

    await expect(repository.claimNextJob('w', '2026-10-05T10:00:00.000Z', 300, [])).rejects.toThrow('must not be empty');
  });

  it('claimNextJob fails an expired-lease job with no attempts left and reclaims only jobs with attempts left', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return sql.includes('LEASE_EXPIRED_NO_ATTEMPTS_LEFT') ? { rows: [{ id: 'job-crashing' }] } : { rows: [] };
      }),
      release: vi.fn(),
    };
    const repository = new PostgresGlucoMindRepository({ connect: vi.fn(async () => client) } as any);

    await repository.claimNextJob('w', '2026-10-05T10:00:00.000Z', 300, ['meal.chat_reply'], ['nightscout.sync']);

    const failExhausted = calls.findIndex((call) => call.sql.includes('LEASE_EXPIRED_NO_ATTEMPTS_LEFT'));
    const claim = calls.findIndex((call) => call.sql.includes('ORDER BY'));
    expect(failExhausted).toBeGreaterThan(-1);
    expect(failExhausted).toBeLessThan(claim);
    expect(calls[failExhausted]!.sql).toContain("SET status = 'failed'");
    expect(calls[failExhausted]!.sql).toContain('attempts >= max_attempts');
    expect(calls[failExhausted]!.params).toEqual(['2026-10-05T10:00:00.000Z', ['meal.chat_reply'], ['nightscout.sync']]);
    expect(calls[claim]!.sql).toContain("status = 'running' AND lock_expires_at < $1::timestamptz AND attempts < max_attempts");
  });

  it('claimNextJob puts the meal chat reply and the WBT suggestion among the interactive jobs', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = { query: vi.fn(async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return { rows: [] }; }), release: vi.fn() };
    const repository = new PostgresGlucoMindRepository({ connect: vi.fn(async () => client) } as any);

    await repository.claimNextJob('w', '2026-10-05T10:00:00.000Z', 300);

    const interactive = calls.find((call) => call.sql.includes('ORDER BY'))!.params?.[3];
    expect(interactive).toEqual(expect.arrayContaining(['meal.chat_reply', 'meal.wbt_suggestion', 'conversation.direct_response']));
  });
});

describe('PostgresGlucoMindRepository.getConversation knowledge sources', () => {
  it('returns the sanitized sources an AI answer cites, and nothing for other messages', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM conversations')) return { rows: [{ id: 'conv-1', patient_id: 'patient-1' }] };
      if (sql.includes('FROM messages m')) {
        return {
          rows: [
            { id: 'm-1', role: 'USER', message_type: 'USER_MESSAGE', content: 'Jak działa WBT?', metadata: {} },
            {
              id: 'm-2', role: 'ASSISTANT', message_type: 'ASSISTANT_MESSAGE', content: '1 WBT to 100 kcal [S1].',
              metadata: { knowledge_sources: [{ ref: 'S1', title: 'ISPAD 2022: Nutrition', section: '10.1', page: 1310, page_end: null, chunk_id: 'hidden' }, { ref: 'bad' }] },
            },
          ],
        };
      }
      return { rows: [] };
    });
    const repository = new PostgresGlucoMindRepository({ query } as any);
    const conversation = await repository.getConversation('patient-1', 'conv-1') as any;
    expect(conversation.messages[0]).not.toHaveProperty('knowledge_sources');
    expect(conversation.messages[1].knowledge_sources).toEqual([{ ref: 'S1', title: 'ISPAD 2022: Nutrition', section: '10.1', page: 1310, page_end: null }]);
  });
});
