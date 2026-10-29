import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';
import { MealActionsToolSession } from '@modules/meal-actions/application/meal-actions-tool';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const USER_MESSAGE = '33333333-3333-4333-8333-333333333333';

function createRepository(text: string, inserted: Array<Record<string, any>>, history: Array<Record<string, unknown>> = []) {
  const explicit: Record<string, unknown> = {
    claimNextJob: vi.fn(async () => ({
      id: 'job-1', lease_token: 'lease-1', job_type: 'conversation.direct_response', attempts: 1, max_attempts: 5,
      payload: { patient_id: PATIENT, conversation_id: CONVERSATION, user_message_id: USER_MESSAGE },
    })),
    getConversation: vi.fn(async () => ({
      id: CONVERSATION, patient_id: PATIENT, thread_state_version: 'conv-v1', awaiting_user_answer: false,
      messages: [...history, { id: USER_MESSAGE, role: 'USER', message_type: 'USER_MESSAGE', content: text, metadata: {} }],
    })),
    getMessageByIdempotencyKey: vi.fn(async () => null),
    getMessageById: vi.fn(async () => ({ id: USER_MESSAGE, message_type: 'USER_MESSAGE', content: text, created_at: '2026-10-19T10:00:00.000Z' })),
    listRecentConversationEventFacts: vi.fn(async () => []),
    insertMessage: vi.fn(async (message: Record<string, any>) => { inserted.push(message); return {}; }),
    finalizeJobSuccess: vi.fn(async () => ({ rowCount: 1, ownershipLost: false })),
    finalizeJobFailure: vi.fn(async () => ({ rowCount: 1, ownershipLost: false })),
    finalizeJobRetry: vi.fn(async () => ({ rowCount: 1, ownershipLost: false })),
    isUserMessageCancelled: vi.fn(async () => false),
    claimUserMessageCompletion: vi.fn(async () => true),
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
  const nightscout = { ensureNightscoutSource: vi.fn(), prepareNightscoutSources: vi.fn().mockResolvedValue({ seed: null, sources: 1 }), enqueueRecurringSyncJobs: vi.fn() } as any;
  const worker = new WorkerService(repository, nightscout, configService, aiGateway, {} as any) as any;
  worker.replyDraftRepository = { upsert: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
  const store = {
    discardForUserMessage: vi.fn(async () => undefined),
    listForUserMessage: vi.fn(async () => []),
    listMealStatesBetween: vi.fn(async () => []),
    listEntriesBetween: vi.fn(async () => []),
    listForConversation: vi.fn(async () => []),
  };
  const service = { propose: vi.fn(async () => ({ status: 'PROPOSED', action: { id: 'card-1', title: 't', before: {}, after: {}, warnings: [] } })) };
  worker.conversationMealActions = { repository: store, service };
  return { worker, store, service };
}

/** A gateway that calls propose_meal_change once and then answers with `text`. */
const proposingGateway = (text: string) => ({
  execute: vi.fn(async (input: { meal_actions?: MealActionsToolSession }) => {
    if (input.meal_actions) {
      await input.meal_actions.proposeChange({ operation: 'SET_WBT_REMINDER', meal: null, entry: null, items: null, description: null, carbs_g: null, protein_g: null, fat_g: null, purpose: null, target_meal: null, enabled: true, reason: '' });
    }
    return { metadata: {}, result: { assistant_message: text, follow_up_candidates: [] } };
  }),
});

describe('WorkerService meal changes in conversation answers', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('gives a meal change request the meal tools, marks the answer and corrects a claimed save', async () => {
    vi.stubEnv('AI_ENABLE_MEAL_ACTIONS', '1');
    const inserted: Array<Record<string, any>> = [];
    const gateway = {
      execute: vi.fn(async (input: { meal_actions?: MealActionsToolSession }) => {
        await input.meal_actions!.getMeals({ days_back: null });
        return { metadata: {}, result: { assistant_message: 'Zapisałem obiad.', follow_up_candidates: [] } };
      }),
    };
    const { worker, store } = createWorker(createRepository('Zamiast obiadu zjadł naleśniki', inserted), gateway);
    await worker.processOnce();

    const input = gateway.execute.mock.calls[0]![0] as Record<string, any>;
    expect(input.meal_actions).toBeInstanceOf(MealActionsToolSession);
    expect(input.meal_actions.meal_change_requested).toBe(true);
    // Never part of the hashed task input.
    expect(Object.keys(input)).not.toContain('meal_actions');
    // An earlier failed run's cards for this message are dropped before the new answer.
    expect(store.discardForUserMessage).toHaveBeenCalledWith(PATIENT, USER_MESSAGE);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].content).toBe('Zapisałem obiad.\n\nUwaga: nic nie zostało zapisane w posiłkach.');
    expect(inserted[0].metadata.meal_assistant).toBe(true);
  });

  it('a question cancelled during the retry wait drops the earlier attempt\'s cards and reminders', async () => {
    const inserted: Array<Record<string, any>> = [];
    const repository = createRepository('Ile insuliny na pizzę?', inserted);
    repository.isUserMessageCancelled = vi.fn(async () => true);
    const { worker } = createWorker(repository, { execute: vi.fn() });
    const reminders = { discardForUserMessage: vi.fn(async () => undefined) };
    const cards = { discardForUserMessage: vi.fn(async () => undefined) };
    const rescue = { discardProposalsForUserMessage: vi.fn(async () => undefined) };
    Object.assign(worker, { careReminderRepository: reminders, bolusProposalRepository: cards, rescueCarbsRepository: rescue });
    await worker.processOnce();
    expect(inserted).toHaveLength(0);
    expect(reminders.discardForUserMessage).toHaveBeenCalledWith(PATIENT, USER_MESSAGE);
    expect(cards.discardForUserMessage).toHaveBeenCalledWith(PATIENT, USER_MESSAGE);
    expect(rescue.discardProposalsForUserMessage).toHaveBeenCalledWith(PATIENT, USER_MESSAGE);
  });

  it('an answer that did not use the meal tools is stored as it was', async () => {
    vi.stubEnv('AI_ENABLE_MEAL_ACTIONS', '1');
    const inserted: Array<Record<string, any>> = [];
    const gateway = { execute: vi.fn(async () => ({ metadata: {}, result: { assistant_message: 'Zapisałem to sobie w pamięci.', follow_up_candidates: [] } })) };
    const { worker } = createWorker(createRepository('Jaka jest teraz glukoza?', inserted), gateway);
    await worker.processOnce();
    expect(inserted[0].content).toBe('Zapisałem to sobie w pamięci.');
    expect(inserted[0].metadata).not.toHaveProperty('meal_assistant');
    expect((gateway.execute.mock.calls[0] as any)[0].meal_actions.meal_change_requested).toBe(false);
  });

  it('"zapisz ten posiłek…" is a change for the chat to prepare, not the canned answer about storage', async () => {
    vi.stubEnv('AI_ENABLE_MEAL_ACTIONS', '1');
    const inserted: Array<Record<string, any>> = [];
    const gateway = proposingGateway('Przygotowałem zmianę do zatwierdzenia.');
    const { worker, service } = createWorker(createRepository('zapisz ten posiłek jako spaghetti', inserted), gateway);
    await worker.processOnce();
    expect(gateway.execute).toHaveBeenCalledTimes(1);
    expect(service.propose).not.toHaveBeenCalled();
    expect(inserted[0].metadata.source).toBe('direct-response-ai');
    expect(inserted[0].metadata.meal_assistant).toBe(true);
  });

  it('without the flag there are no meal tools and the storage question keeps its canned answer', async () => {
    const inserted: Array<Record<string, any>> = [];
    const gateway = proposingGateway('—');
    const { worker } = createWorker(createRepository('zapisz ten posiłek jako spaghetti', inserted), gateway);
    await worker.processOnce();
    expect(gateway.execute).not.toHaveBeenCalled();
    expect(inserted[0].metadata.policy).toBe('DATA_PERSISTENCE_EXPLANATION');
  });
});
