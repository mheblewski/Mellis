import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '@shared/errors/app-error';
import { ApiService } from './api.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const ACTION = '55555555-5555-4555-8555-555555555555';
const CAREGIVER = { user_id: '33333333-3333-4333-8333-333333333333' } as any;

function setup(messages: Array<Record<string, unknown>> = [], conversation: Record<string, unknown> = {}) {
  const jobs: Array<{ jobType: string }> = [];
  let messageCount = 0;
  const client = {
    query: vi.fn(async (sql: string) => {
      if (/INSERT INTO messages/.test(sql)) {
        messageCount += 1;
        return { rows: [{ id: `message-${messageCount}`, created_at: '2026-10-19T12:00:00.000Z', role: 'USER', metadata: {} }] };
      }
      return { rows: [] };
    }),
  };
  const repo = {
    async getAccessRow(userId: string, patientId: string) {
      return userId === CAREGIVER.user_id && patientId === PATIENT ? { can_read_patient: true, can_write_patient: true } : null;
    },
    insertAuditEvent: vi.fn(),
    getConversation: vi.fn(async () => ({ id: CONVERSATION, patient_id: PATIENT, awaiting_user_answer: false, messages, ...conversation })),
    getMessageByIdempotencyKey: vi.fn(async () => null),
    withTransaction: vi.fn(async (handler: (c: typeof client) => Promise<unknown>) => handler(client)),
    insertJob: vi.fn(async (job: { jobType: string }) => { jobs.push(job); return job; }),
    evaluateInvestigationForEvent: vi.fn(async () => ({ shouldProceedToAnalysis: false, state: 'NO_QUESTION' })),
  };
  const api = new ApiService(repo as any, {} as any);
  const send = (content: string) => api.submitAnswer(CAREGIVER, PATIENT, CONVERSATION, { message_type: 'USER_MESSAGE', content, idempotency_key: `key-${content}` });
  return { api, repo, jobs, send };
}

describe('meal changes in conversations: routing', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('answers a meal change directly with the meal tools instead of analysing the period', async () => {
    vi.stubEnv('AI_ENABLE_MEAL_ACTIONS', '1');
    const { send, jobs } = setup();
    const response = await send('Zamiast ostatniego posiłku zjadł dwa naleśniki z serem');
    expect(response.decision).toBe('DIRECT_RESPONSE');
    expect(jobs.map((job) => job.jobType)).toEqual(['conversation.direct_response']);
  });

  it('a short reply to an answer working on a meal continues it; a dose question does not', async () => {
    vi.stubEnv('AI_ENABLE_MEAL_ACTIONS', '1');
    const history = [
      { id: 'u1', role: 'USER', content: 'zamiast zupy zjadł naleśniki', metadata: {} },
      { id: 'a1', role: 'ASSISTANT', content: 'Ile było sera?', metadata: { meal_assistant: true } },
    ];
    const followUp = setup(history);
    await followUp.send('około 50 g twarogu, cukier był wtedy 140');
    expect(followUp.jobs.map((job) => job.jobType)).toEqual(['conversation.direct_response']);

    const dose = setup(history);
    await dose.send('ile insuliny na ten posiłek?');
    expect(dose.jobs.map((job) => job.jobType)).not.toContain('conversation.direct_response');
  });

  it('without the flag, and in a hypo screen\'s chat, routing stays as it was', async () => {
    const off = setup();
    await off.send('Zamiast ostatniego posiłku zjadł dwa naleśniki z serem');
    expect(off.jobs.map((job) => job.jobType)).toEqual(['conversation.time_range_analysis']);

    vi.stubEnv('AI_ENABLE_MEAL_ACTIONS', '1');
    const hypo = setup([], { episode_id: '66666666-6666-4666-8666-666666666666' });
    (hypo.api as any).hypoConversationRange = vi.fn(async () => ({
      rangeType: 'SHORT_RANGE', rangeStart: '2026-10-19T09:00:00.000Z', rangeEnd: '2026-10-19T12:00:00.000Z', timezone: 'Europe/Warsaw', normalizationPolicyVersion: 'test',
    }));
    await hypo.send('to były węgle na hipo, nie posiłek');
    expect(hypo.jobs.map((job) => job.jobType)).toEqual(['conversation.time_range_analysis']);
  });
});

describe('meal changes in conversations: cards and buttons', () => {
  const action = (status: string, userMessageId: string) => ({
    id: ACTION, user_message_id: userMessageId, operation: 'UPDATE_MACROS', status, title: 'Poprawka wartości · Obiad (13:10)',
    meal_record_id: '77777777-7777-4777-8777-777777777777', carb_event_id: null, loop_action_id: null, reason: null,
    before: { kind: 'CONTENT', fat_g: 0 }, after: { kind: 'CONTENT', fat_g: 20, edit: { macros: { fat_g: 20 } } },
    undoable: true, warnings: [], decided_by: null, decided_at: null, undone_at: null, created_at: '2026-10-19T12:00:00.000Z',
  });

  it('shows each card once, under the last answer to the message that prepared it; discarded cards never', async () => {
    const messages = [
      { id: 'u1', role: 'USER', message_type: 'USER_MESSAGE', content: 'tłuszczu było 20 g', metadata: {} },
      { id: 'a1', role: 'ASSISTANT', message_type: 'ASSISTANT_MESSAGE', content: 'Status', metadata: { user_message_id: 'u1' } },
      { id: 'a2', role: 'ASSISTANT', message_type: 'ASSISTANT_MESSAGE', content: 'Przygotowałem zmianę.', metadata: { user_message_id: 'u1' } },
    ];
    const { api } = setup(messages);
    (api as any).conversationMealActionRepository = {
      listForConversation: vi.fn(async () => [action('PROPOSED', 'u1'), { ...action('DISCARDED', 'u1'), id: 'other' }]),
    };
    (api as any).replyDrafts = { get: vi.fn(async () => null) };
    const conversation = await api.getConversation(CAREGIVER, PATIENT, CONVERSATION);
    const shown = (conversation.messages as any[]).map((message) => message.meal_actions?.map((card: any) => card.id) ?? null);
    expect(shown).toEqual([null, null, [ACTION]]);
    const card = (conversation.messages as any[])[2].meal_actions[0];
    expect(card).toMatchObject({ can_apply: true, can_edit: true, can_undo: false, after: { kind: 'CONTENT', fat_g: 20 } });
    expect(card.after).not.toHaveProperty('edit');
  });

  it('applies, rejects and undoes through the service, only in a live conversation', async () => {
    const { api } = setup();
    const service = {
      apply: vi.fn(async () => action('APPLIED', 'u1')),
      reject: vi.fn(async () => action('REJECTED', 'u1')),
      undo: vi.fn(async () => action('UNDONE', 'u1')),
    };
    (api as any).conversationMealActions = service;

    await expect(api.applyConversationMealAction(CAREGIVER, PATIENT, CONVERSATION, ACTION, { edited: { carbs_g: 40 } }))
      .resolves.toMatchObject({ patient_id: PATIENT, meal_action: { id: ACTION, status: 'APPLIED', can_undo: true } });
    expect(service.apply).toHaveBeenCalledWith({ patientId: PATIENT, conversationId: CONVERSATION, actionId: ACTION, userId: CAREGIVER.user_id, edited: { carbs_g: 40 } });
    await expect(api.rejectConversationMealAction(CAREGIVER, PATIENT, CONVERSATION, ACTION)).resolves.toMatchObject({ meal_action: { status: 'REJECTED' } });
    await expect(api.undoConversationMealAction(CAREGIVER, PATIENT, CONVERSATION, ACTION)).resolves.toMatchObject({ meal_action: { status: 'UNDONE' } });
    await expect(api.applyConversationMealAction(CAREGIVER, PATIENT, CONVERSATION, ACTION, { edited: [1] as any })).rejects.toThrow('edited must be an object');

    const deleted = setup([], { deleted_at: '2026-10-19T11:00:00.000Z' });
    (deleted.api as any).conversationMealActions = service;
    await expect(deleted.api.applyConversationMealAction(CAREGIVER, PATIENT, CONVERSATION, ACTION)).rejects.toBeInstanceOf(NotFoundError);
    await expect(api.applyConversationMealAction({ user_id: 'someone-else' } as any, PATIENT, CONVERSATION, ACTION)).rejects.toThrow();
  });
});
