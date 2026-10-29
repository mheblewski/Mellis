import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiExecutionError } from '@modules/ai-gateway/domain/ai-gateway';
import { ANALYSIS_CANCELLATION_POLL_MS, WorkerService } from './worker.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const USER_MESSAGE = '33333333-3333-4333-8333-333333333333';
const PAYLOAD = { patient_id: PATIENT, conversation_id: CONVERSATION, user_message_id: USER_MESSAGE };

/** Explicit spies for what the test asserts; every other repository method resolves to null. */
function createRepository(overrides: Record<string, unknown>) {
  const explicit: Record<string, unknown> = {
    getConversation: vi.fn(async () => ({ id: CONVERSATION, patient_id: PATIENT, thread_state_version: 'conv-v1', awaiting_user_answer: false, messages: [] })),
    getMessageByIdempotencyKey: vi.fn(async () => null),
    getMessageById: vi.fn(async () => ({ id: USER_MESSAGE, message_type: 'USER_MESSAGE', content: 'Jak minął dzień?', created_at: '2026-10-08T10:00:00.000Z' })),
    listRecentConversationEventFacts: vi.fn(async () => []),
    insertMessage: vi.fn(async () => ({})),
    finalizeJobSuccess: vi.fn(async () => ({ rowCount: 1, ownershipLost: false })),
    finalizeJobCancelled: vi.fn(async () => ({ rowCount: 1, ownershipLost: false })),
    markAiExecutionRunning: vi.fn(async () => undefined),
    markAiExecutionSucceeded: vi.fn(async () => undefined),
    markAiExecutionFailed: vi.fn(async () => undefined),
    markAiExecutionCancelled: vi.fn(async () => undefined),
    isUserMessageCancelled: vi.fn(async () => false),
    claimUserMessageCompletion: vi.fn(async () => true),
    ...overrides,
  };
  return new Proxy(explicit, {
    get(target, property: string) {
      if (property in target) return target[property];
      if (property === 'then') return undefined;
      return async () => null;
    },
  }) as any;
}

function createWorker(repository: any, aiGateway: any) {
  const configService = { getOrThrow: vi.fn().mockReturnValue('test'), get: vi.fn().mockReturnValue(undefined) } as any;
  const nightscout = { ensureNightscoutSource: vi.fn(), prepareNightscoutSources: vi.fn().mockResolvedValue({ seed: null, sources: 1 }), enqueueRecurringSyncJobs: vi.fn(), runNightscoutSyncJob: vi.fn(), runHypoDetectionJob: vi.fn() } as any;
  return new WorkerService(repository, nightscout, configService, aiGateway, {} as any) as any;
}

describe('WorkerService analysis cancellation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does no work for a message cancelled before the job started', async () => {
    const repository = createRepository({ isUserMessageCancelled: vi.fn(async () => true) });
    const aiGateway = { execute: vi.fn() };
    await createWorker(repository, aiGateway).handleConversationDirectResponse('job-1', 'lease-1', PAYLOAD);

    expect(aiGateway.execute).not.toHaveBeenCalled();
    expect(repository.insertMessage).not.toHaveBeenCalled();
    expect(repository.finalizeJobCancelled).toHaveBeenCalledWith('job-1', 'lease-1', expect.any(String));
    expect(repository.finalizeJobSuccess).not.toHaveBeenCalled();
  });

  it('discards a finished AI result when the cancellation won the race to the completion claim', async () => {
    const repository = createRepository({ claimUserMessageCompletion: vi.fn(async () => false) });
    const aiGateway = { execute: vi.fn(async () => ({ metadata: {}, result: { assistant_message: 'Odpowiedź' } })) };
    await createWorker(repository, aiGateway).handleConversationDirectResponse('job-2', 'lease-2', PAYLOAD);

    expect(aiGateway.execute).toHaveBeenCalledTimes(1);
    expect(repository.claimUserMessageCompletion).toHaveBeenCalledWith(CONVERSATION, USER_MESSAGE);
    expect(repository.insertMessage).not.toHaveBeenCalled();
    expect(repository.markAiExecutionCancelled).toHaveBeenCalled();
    expect(repository.finalizeJobCancelled).toHaveBeenCalledWith('job-2', 'lease-2', expect.any(String));
  });

  it('saves the answer only after winning the completion claim', async () => {
    const order: string[] = [];
    const repository = createRepository({
      claimUserMessageCompletion: vi.fn(async () => { order.push('claim'); return true; }),
      insertMessage: vi.fn(async () => { order.push('insert'); return {}; }),
    });
    const aiGateway = { execute: vi.fn(async () => ({ metadata: {}, result: { assistant_message: 'Odpowiedź' } })) };
    await createWorker(repository, aiGateway).handleConversationDirectResponse('job-3', 'lease-3', PAYLOAD);

    expect(order).toEqual(['claim', 'insert']);
    expect(repository.finalizeJobSuccess).toHaveBeenCalled();
    expect(repository.finalizeJobCancelled).not.toHaveBeenCalled();
  });

  it('treats an aborted AI call as cancelled, not failed, and does not retry it', async () => {
    const repository = createRepository({});
    const aiGateway = { execute: vi.fn(async () => { throw new AiExecutionError('AI execution cancelled', 'AI_CANCELLED', false); }) };
    await expect(createWorker(repository, aiGateway).handleConversationDirectResponse('job-4', 'lease-4', PAYLOAD)).resolves.toBeUndefined();

    expect(repository.markAiExecutionFailed).not.toHaveBeenCalled();
    expect(repository.markAiExecutionCancelled).toHaveBeenCalled();
    expect(repository.finalizeJobCancelled).toHaveBeenCalledWith('job-4', 'lease-4', expect.any(String));
    expect(repository.insertMessage).not.toHaveBeenCalled();
  });

  it('aborts the running AI call when the message gets cancelled while it runs', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const repository = createRepository({ isUserMessageCancelled: vi.fn(async () => cancelled) });
    let seenSignal: AbortSignal | undefined;
    const aiGateway = {
      execute: vi.fn((input: { abort_signal?: AbortSignal }) => new Promise((_, reject) => {
        seenSignal = input.abort_signal;
        input.abort_signal?.addEventListener('abort', () => reject(new AiExecutionError('AI execution cancelled', 'AI_CANCELLED', false)));
      })),
    };
    const worker = createWorker(repository, aiGateway);
    const running = worker.executeCancellableAi({ task: {} }, CONVERSATION, USER_MESSAGE);
    const settled = running.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(ANALYSIS_CANCELLATION_POLL_MS);
    expect(seenSignal?.aborted).toBe(false);

    cancelled = true;
    await vi.advanceTimersByTimeAsync(ANALYSIS_CANCELLATION_POLL_MS);
    expect(seenSignal?.aborted).toBe(true);
    await expect(settled).resolves.toMatchObject({ code: 'AI_CANCELLED' });
  });
});
