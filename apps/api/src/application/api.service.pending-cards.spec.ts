import { describe, expect, it, vi } from 'vitest';
import { ApiService } from './api.service';

// Cards under a finished answer that is not stored yet (cards-after-text.v1): offline, repositories stubbed.

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const CAREGIVER = { user_id: '33333333-3333-4333-8333-333333333333' } as any;
const NOW = Date.now();

function card(id: string, userMessageId: string, option: string | null) {
  return {
    proposal: {
      id, patient_id: PATIENT, conversation_id: CONVERSATION, user_message_id: userMessageId, purpose: 'MEAL', carbs_g: 23, insulin_u: 2.9,
      icr_g_per_u: 8, icr_insulin_u: 2.9, meal_payload: { description: 'Cheeseburger', items: [], macros: null }, reason: null, warnings: [],
      split: null, dose_adjustment: null, card_advice: null, option_key: option, status: 'PROPOSED',
      expires_at: new Date(NOW + 15 * 60_000).toISOString(), created_at: new Date(NOW).toISOString(),
    },
    command: null,
  };
}

function setup(messages: Array<Record<string, unknown>>, cards: unknown[], rescueCards: unknown[] = [], answerReady: Record<string, unknown> | null = { answer_options: [{ key: 'A', title: 'Plan A' }] }) {
  const repo = {
    async getAccessRow(userId: string, patientId: string) {
      return userId === CAREGIVER.user_id && patientId === PATIENT ? { can_read_patient: true, can_write_patient: true } : null;
    },
    getConversation: vi.fn(async () => ({ id: CONVERSATION, patient_id: PATIENT, awaiting_user_answer: false, messages })),
  };
  const api = new ApiService(repo as any, {} as any) as any;
  api.replyDrafts = { get: vi.fn(async () => ({ reply_to_message_id: 'u2', content: 'Liczę…', answer_ready: answerReady })) };
  api.conversationMealActionRepository = { listForConversation: vi.fn(async () => []) };
  api.bolusProposals = { listForConversation: vi.fn(async () => cards) };
  api.plannedBolusesForCards = async () => new Map();
  api.cardRemindersFor = async () => new Map();
  api.buildConversationRescue = async () => null;
  api.rescueCarbs = { listProposalsForConversation: vi.fn(async () => rescueCards) };
  api.careReminderRepository = { listForConversation: vi.fn(async () => []) };
  return api as ApiService;
}

const answered = [
  { id: 'u1', role: 'USER', message_type: 'USER_MESSAGE', content: 'Ile na frytki?', metadata: {} },
  { id: 'a1', role: 'ASSISTANT', message_type: 'ASSISTANT_MESSAGE', content: 'Karta poniżej.', metadata: { user_message_id: 'u1' } },
];

describe('cards of a finished answer not stored yet', () => {
  it('lists the cards prepared so far for the latest message while its answer is not stored', async () => {
    const messages = [...answered, { id: 'u2', role: 'USER', message_type: 'USER_MESSAGE', content: 'Ile na cheeseburgera?', metadata: {} }];
    const rescue = [
      { id: 'r1', user_message_id: 'u2', carbs_g: 5, reason: null, option_key: 'A', status: 'PROPOSED', created_at: new Date(NOW).toISOString() },
      { id: 'r0', user_message_id: 'u2', carbs_g: 9, reason: null, option_key: 'A', status: 'DISCARDED', created_at: new Date(NOW).toISOString() },
    ];
    const api = setup(messages, [card('c1', 'u1', null), card('c2', 'u2', 'A'), card('c3', 'u2', 'B')], rescue);
    const conversation = await api.getConversation(CAREGIVER, PATIENT, CONVERSATION) as any;
    expect(conversation.pending_answer_cards).toMatchObject({
      reply_to_message_id: 'u2',
      answer_options: [{ key: 'A', title: 'Plan A' }],
      bolus_proposals: [{ id: 'c2', option_key: 'A', state: 'PROPOSED' }, { id: 'c3', option_key: 'B' }],
      rescue_carb_proposals: [{ id: 'r1', carbs_g: 5, option_key: 'A', status: 'PROPOSED' }],
    });
    expect(conversation.reply_draft).toEqual({ reply_to_message_id: 'u2', content: 'Liczę…' });
    // The stored answer's card stays under that answer; the pending ones are under no message yet.
    expect((conversation.messages as any[]).map((message) => message.bolus_proposals?.map((shown: any) => shown.id) ?? null)).toEqual([null, ['c1'], null]);
  });

  it('has none while the text is still written, even if cards exist (they never come before the text)', async () => {
    const messages = [...answered, { id: 'u2', role: 'USER', message_type: 'USER_MESSAGE', content: 'Ile?', metadata: {} }];
    const api = setup(messages, [card('c2', 'u2', null)], [], null);
    expect(await api.getConversation(CAREGIVER, PATIENT, CONVERSATION)).not.toHaveProperty('pending_answer_cards');
  });

  it('says cards are coming from the end of the text, before any card exists, and not without a mark', async () => {
    const messages = [...answered, { id: 'u2', role: 'USER', message_type: 'USER_MESSAGE', content: 'Ile?', metadata: {} }];
    const coming = setup(messages, [], [], { answer_options: [], cards_expected: true });
    expect(await coming.getConversation(CAREGIVER, PATIENT, CONVERSATION)).toMatchObject({ answer_cards_coming: true });
    const none = setup(messages, [], [], { answer_options: [], cards_expected: false });
    expect(await none.getConversation(CAREGIVER, PATIENT, CONVERSATION)).not.toHaveProperty('answer_cards_coming');
    const writing = setup(messages, [], [], null);
    expect(await writing.getConversation(CAREGIVER, PATIENT, CONVERSATION)).not.toHaveProperty('answer_cards_coming');
  });

  it('has none once the answer is stored, or while the answer has prepared no card', async () => {
    const stored = setup(answered, [card('c1', 'u1', null)]);
    expect(await stored.getConversation(CAREGIVER, PATIENT, CONVERSATION)).not.toHaveProperty('pending_answer_cards');
    const waiting = setup([...answered, { id: 'u2', role: 'USER', message_type: 'USER_MESSAGE', content: 'A teraz?', metadata: {} }], [card('c1', 'u1', null)]);
    expect(await waiting.getConversation(CAREGIVER, PATIENT, CONVERSATION)).not.toHaveProperty('pending_answer_cards');
  });
});
