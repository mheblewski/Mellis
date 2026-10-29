import { describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const USER_MESSAGE = '33333333-3333-4333-8333-333333333333';

function createRepository(order: string[], overrides: Record<string, unknown> = {}) {
  const explicit: Record<string, unknown> = {
    claimNextJob: vi.fn(async () => ({
      id: 'job-1', lease_token: 'lease-1', job_type: 'conversation.direct_response', attempts: 1, max_attempts: 5,
      payload: { patient_id: PATIENT, conversation_id: CONVERSATION, user_message_id: USER_MESSAGE },
    })),
    getConversation: vi.fn(async () => ({ id: CONVERSATION, patient_id: PATIENT, thread_state_version: 'conv-v1', awaiting_user_answer: false, messages: [] })),
    getMessageByIdempotencyKey: vi.fn(async () => null),
    getMessageById: vi.fn(async () => ({ id: USER_MESSAGE, message_type: 'USER_MESSAGE', content: 'Jak minął dzień?', created_at: '2026-10-19T10:00:00.000Z' })),
    listRecentConversationEventFacts: vi.fn(async () => []),
    insertMessage: vi.fn(async () => { order.push('insert'); return {}; }),
    finalizeJobSuccess: vi.fn(async () => { order.push('finalize'); return { rowCount: 1, ownershipLost: false }; }),
    finalizeJobFailure: vi.fn(async () => { order.push('failed'); return { rowCount: 1, ownershipLost: false }; }),
    finalizeJobRetry: vi.fn(async () => { order.push('retry'); return { rowCount: 1, ownershipLost: false }; }),
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

function createWorker(repository: any, aiGateway: any, order: string[]) {
  const configService = { getOrThrow: vi.fn().mockReturnValue('test'), get: vi.fn().mockReturnValue(undefined) } as any;
  const nightscout = { ensureNightscoutSource: vi.fn(), prepareNightscoutSources: vi.fn().mockResolvedValue({ seed: null, sources: 1 }), enqueueRecurringSyncJobs: vi.fn() } as any;
  const worker = new WorkerService(repository, nightscout, configService, aiGateway, {} as any) as any;
  const drafts = {
    upsert: vi.fn(async (args: { content: string }) => { order.push(`draft:${args.content}`); }),
    delete: vi.fn(async () => { order.push('draft-deleted'); }),
  };
  worker.replyDraftRepository = drafts;
  return { worker, drafts };
}

const writingGateway = (fail = false) => ({
  execute: vi.fn(async (input: { reply_draft_observer?: { onDraft: (text: string) => void } }) => {
    input.reply_draft_observer?.onDraft('Glikemia');
    await new Promise((resolve) => setTimeout(resolve, 30));
    input.reply_draft_observer?.onDraft('Glikemia w normie.');
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (fail) throw Object.assign(new Error('provider down'), { retryable: false });
    return { metadata: {}, result: { assistant_message: 'Glikemia w normie.', follow_up_candidates: [] } };
  }),
});

describe('WorkerService reply drafts', () => {
  it('writes the answer while it is written and deletes the draft only after the answer is stored', async () => {
    const order: string[] = [];
    const { worker, drafts } = createWorker(createRepository(order), writingGateway(), order);
    await worker.processOnce();

    expect(order).toEqual(['draft:Glikemia', 'draft:Glikemia w normie.', 'insert', 'finalize', 'draft-deleted']);
    expect(drafts.upsert).toHaveBeenCalledWith({ kind: 'CONVERSATION', threadId: CONVERSATION, patientId: PATIENT, replyToMessageId: USER_MESSAGE, content: 'Glikemia' });
    expect(drafts.delete).toHaveBeenCalledWith({ kind: 'CONVERSATION', threadId: CONVERSATION, replyToMessageId: USER_MESSAGE });
  });

  it('deletes the draft when the answer fails', async () => {
    const order: string[] = [];
    const { worker } = createWorker(createRepository(order), writingGateway(true), order);
    await worker.processOnce();
    // Deleted before the job state changes, so the app never reads the failed attempt's text as the answer in progress.
    expect(order.indexOf('draft-deleted')).toBeGreaterThan(-1);
    expect(order.indexOf('draft-deleted')).toBeLessThan(order.findIndex((entry) => entry === 'failed' || entry === 'retry'));
    expect(order).not.toContain('insert');
  });

  it('checks a free-text dose of a direct answer against the reading (none here: one sentence added)', async () => {
    const order: string[] = [];
    const repository = createRepository(order);
    const gateway = { execute: vi.fn(async () => ({ metadata: {}, result: { assistant_message: '**Propozycja:** 2 j na obiad.', follow_up_candidates: [] } })) };
    const { worker } = createWorker(repository, gateway, order);
    await worker.processOnce();
    const stored = repository.insertMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(JSON.stringify(stored)).toContain('brak aktualnego odczytu');
  });

  it('never makes the draft part of the AI task input that is hashed or stored', async () => {
    const order: string[] = [];
    const gateway = writingGateway();
    const { worker } = createWorker(createRepository(order), gateway, order);
    await worker.processOnce();
    const input = gateway.execute.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(input)).not.toContain('reply_draft_observer');
    expect(input.reply_draft_observer).toBeDefined();
  });
});

describe('reply drafts without the dose line', () => {
  it('leaves out "**Propozycja:**" lines and a line just starting one, keeps the rest', async () => {
    const { withoutDraftDoseLine } = await import('./worker.service');
    expect(withoutDraftDoseLine('Glukoza 180.\n**Propozycja:** 2,5 j\n**Uzasadnienie:** 30 g')).toBe('Glukoza 180.\n**Uzasadnienie:** 30 g');
    expect(withoutDraftDoseLine('Glukoza 180.\n**Prop')).toBe('Glukoza 180.');
    expect(withoutDraftDoseLine('Glukoza 180.\n**')).toBe('Glukoza 180.');
    expect(withoutDraftDoseLine('Proszę bardzo, oto wynik.')).toBe('Proszę bardzo, oto wynik.');
  });
});
