import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError, ValidationError } from '@shared/errors/app-error';
import { ApiService } from './api.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const MEAL = '33333333-3333-4333-8333-333333333333';
const PHOTO = '44444444-4444-4444-8444-444444444444';
const CAREGIVER = { user_id: '55555555-5555-4555-8555-555555555555', auth_provider: 'COGNITO', auth_subject: 'sub-1' } as any;

function setup() {
  const repo = {
    getAccessRow: vi.fn(async (userId: string, patientId: string) =>
      userId === CAREGIVER.user_id && patientId === PATIENT ? { can_read_patient: true, can_write_patient: true } : null),
    insertAuditEvent: vi.fn(async () => undefined),
    getRecommendation: vi.fn(async () => null),
    getConversation: vi.fn(async () => ({ id: CONVERSATION, patient_id: PATIENT, deleted_at: null, messages: [] })),
    getMessageByIdempotencyKey: vi.fn(async () => null),
    insertJob: vi.fn(async (job: unknown) => job),
    getJobStatusByDedupeKey: vi.fn(async () => 'queued'),
  };
  const api = new ApiService(repo as any, {} as any);
  const remoteCommands = { get: vi.fn(), reportSent: vi.fn(), reportReply: vi.fn() };
  const chat = {
    countPhotosOfMeal: vi.fn(async (_p: string, _m: string, ids: string[]) => ids.length),
    insertUserMessage: vi.fn(async () => ({ message: { id: 'm-1' }, created: true })),
    listMessages: vi.fn(async () => []),
  };
  const records = {
    findMealIdentityById: vi.fn(async () => 'meal:identity'),
    getAnchorEventId: vi.fn(async () => 'anchor-event'),
    getMealRecord: vi.fn(async () => ({ status: 'DESCRIBED', content_revision: 1, started_at: '2026-10-15T06:15:00.000Z', source_carbs_g: 30, description: 'Kanapka', has_photo: false, pending_proposal_id: null, macros: { carbs: { grams: null, origin: null }, protein: { grams: null, origin: null }, fat: { grams: null, origin: null } } })),
  };
  Object.assign(api as any, {
    remoteCommands,
    mealChatRepository: chat,
    mealRecordRepository: records,
    conversationMealActions: { apply: vi.fn(), reject: vi.fn(), undo: vi.fn() },
    mealWbtRepository: { getReminder: async () => null, setAutoReminder: async () => undefined, getLatestSuggestion: async () => null },
    dashboardRepository: { getLatestLoopStatus: async () => ({ observed_at: '2026-10-28T12:00:00.000Z', raw_payload: { device: 'Trio', openaps: { suggested: {} } } }) },
  });
  return { api, repo, remoteCommands, chat };
}

describe('ApiService: ids that are not UUIDs never reach SQL', () => {
  it('refuses a malformed patient id with 403, without querying access', async () => {
    const { api, repo } = setup();
    await expect(api.getConversation(CAREGIVER, 'not-a-uuid', CONVERSATION)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(api.submitAnswer(CAREGIVER, "1' OR 1=1", CONVERSATION, { message_type: 'USER_MESSAGE', content: 'x', idempotency_key: 'k' })).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.getAccessRow).not.toHaveBeenCalled();
  });

  it('answers 404 for malformed recommendation and conversation ids', async () => {
    const { api, repo } = setup();
    await expect(api.getRecommendation(CAREGIVER, PATIENT, 'abc')).rejects.toBeInstanceOf(NotFoundError);
    await expect(api.getConversation(CAREGIVER, PATIENT, 'abc')).rejects.toBeInstanceOf(NotFoundError);
    await expect(api.submitAnswer(CAREGIVER, PATIENT, 'abc', { message_type: 'USER_MESSAGE', content: 'x', idempotency_key: 'k' })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.getRecommendation).not.toHaveBeenCalled();
    expect(repo.getConversation).not.toHaveBeenCalled();
  });

  it('answers 404 for malformed remote command and meal change ids', async () => {
    const { api, remoteCommands } = setup();
    await expect(api.getRemoteCommand(CAREGIVER, PATIENT, 'abc')).rejects.toBeInstanceOf(NotFoundError);
    await expect(api.reportRemoteCommandSent(CAREGIVER, PATIENT, 'abc', { accepted: true })).rejects.toBeInstanceOf(NotFoundError);
    await expect(api.reportRemoteCommandReply(CAREGIVER, PATIENT, 'abc', { success: true, message: 'ok' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(api.rejectConversationMealAction(CAREGIVER, PATIENT, CONVERSATION, 'abc')).rejects.toThrow('Meal change not found');
    expect(remoteCommands.get).not.toHaveBeenCalled();
    expect(remoteCommands.reportSent).not.toHaveBeenCalled();
  });
});

describe('ApiService.submitAnswer message shape', () => {
  it('refuses an unknown message_type with 422 instead of treating it as an answer', async () => {
    const { api, repo } = setup();
    await expect(api.submitAnswer(CAREGIVER, PATIENT, CONVERSATION, { message_type: 'SYSTEM', idempotency_key: 'k' } as any)).rejects.toThrow('message_type must be USER_MESSAGE or CONTEXT_ANSWER');
    expect(repo.getConversation).not.toHaveBeenCalled();
  });

  it('requires a question_id and a well-formed answer for CONTEXT_ANSWER', async () => {
    const { api } = setup();
    const base = { message_type: 'CONTEXT_ANSWER', idempotency_key: 'k' } as const;
    await expect(api.submitAnswer(CAREGIVER, PATIENT, CONVERSATION, { ...base, answer: { type: 'YES' } } as any)).rejects.toThrow('question_id is required');
    await expect(api.submitAnswer(CAREGIVER, PATIENT, CONVERSATION, { ...base, question_id: 'q' } as any)).rejects.toThrow('answer.type must be one of');
    await expect(api.submitAnswer(CAREGIVER, PATIENT, CONVERSATION, { ...base, question_id: 'q', answer: { type: 'MAYBE' } } as any)).rejects.toBeInstanceOf(ValidationError);
    await expect(api.submitAnswer(CAREGIVER, PATIENT, CONVERSATION, { ...base, question_id: 'q', answer: { type: 'TEXT', text: 42 } } as any)).rejects.toThrow('answer.text must be a string');
  });
});

describe('ApiService.postMealChatMessage photo ids', () => {
  it('drops duplicate photo ids like the main chat', async () => {
    const { api, chat } = setup();
    await api.postMealChatMessage(CAREGIVER, PATIENT, MEAL, { content: 'Kanapka', photo_ids: [PHOTO, PHOTO.toUpperCase()] }, 'key-1');
    expect(chat.countPhotosOfMeal).toHaveBeenCalledWith(PATIENT, MEAL, [PHOTO]);
    expect(chat.insertUserMessage).toHaveBeenCalledWith(expect.objectContaining({ photoIds: [PHOTO] }));
  });

  it('refuses photo ids that are not strings instead of silently dropping them', async () => {
    const { api, chat } = setup();
    await expect(api.postMealChatMessage(CAREGIVER, PATIENT, MEAL, { content: 'Kanapka', photo_ids: [PHOTO, 7] }, 'key-1')).rejects.toThrow('photo_ids must be photo ids');
    await expect(api.postMealChatMessage(CAREGIVER, PATIENT, MEAL, { content: 'Kanapka', photo_ids: 'x' }, 'key-1')).rejects.toBeInstanceOf(ValidationError);
    expect(chat.insertUserMessage).not.toHaveBeenCalled();
  });
});

describe('ApiService.authorizeRemoteCommand conversation_id', () => {
  const OTHER_CONVERSATION = '66666666-6666-4666-8666-666666666666';
  const body = (overrides: Record<string, unknown>) => ({ source: 'BOLUS_SCREEN', carbs_g: 20, insulin_u: 1, bolus_step: 0.05, device_id: 'phone-1', ...overrides });

  function remoteSetup() {
    vi.stubEnv('REMOTE_COMMANDS_ENABLED', 'true');
    const { api, repo, remoteCommands } = setup();
    Object.assign(repo, {
      getRemoteControlSwitches: vi.fn(async () => ({ patient_remote_control: { enabled: true }, caregiver_permissions: { remote_commands: true } })),
      conversationBelongsToPatient: vi.fn(async (_patientId: string, conversationId: string) => conversationId === CONVERSATION),
    });
    Object.assign(remoteCommands, { authorize: vi.fn(async () => ({ id: 'command-1' })) });
    return { api, repo, remoteCommands: remoteCommands as typeof remoteCommands & { authorize: ReturnType<typeof vi.fn> } };
  }

  it('refuses a conversation of another patient with 422 before anything is authorized', async () => {
    const { api, remoteCommands } = remoteSetup();
    await expect(api.authorizeRemoteCommand(CAREGIVER, PATIENT, body({ conversation_id: OTHER_CONVERSATION }) as any)).rejects.toThrow('conversation_id does not match a conversation of this patient');
    expect(remoteCommands.authorize).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('passes a command from this patient\'s conversation, and one without a conversation', async () => {
    const { api, repo, remoteCommands } = remoteSetup();
    await api.authorizeRemoteCommand(CAREGIVER, PATIENT, body({ conversation_id: CONVERSATION }) as any);
    await api.authorizeRemoteCommand(CAREGIVER, PATIENT, body({}) as any);
    expect(remoteCommands.authorize).toHaveBeenCalledTimes(2);
    expect((repo as any).conversationBelongsToPatient).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });
});

describe('ApiService.authorizeRemoteCommand reminders (bolus-reminders.v1)', () => {
  const body = (overrides: Record<string, unknown>) => ({ source: 'BOLUS_SCREEN', carbs_g: 45, insulin_u: 4.5, bolus_step: 0.05, device_id: 'phone-1', ...overrides });

  function remoteSetup() {
    vi.stubEnv('REMOTE_COMMANDS_ENABLED', 'true');
    const { api, repo, remoteCommands } = setup();
    Object.assign(repo, { getRemoteControlSwitches: vi.fn(async () => ({ patient_remote_control: { enabled: true }, caregiver_permissions: { remote_commands: true } })) });
    Object.assign(remoteCommands, { authorize: vi.fn(async () => ({ id: 'command-1' })) });
    return { api, remoteCommands: remoteCommands as typeof remoteCommands & { authorize: ReturnType<typeof vi.fn> } };
  }

  it('passes the reminders the app sent to the service', async () => {
    const { api, remoteCommands } = remoteSetup();
    const reminders = [{ kind: 'WBT' }, { kind: 'SECOND_DOSE', trigger: 'AFTER_MINUTES', minutes: 30 }];
    await api.authorizeRemoteCommand(CAREGIVER, PATIENT, body({ reminders }) as any);
    expect(remoteCommands.authorize.mock.calls[0][2]).toMatchObject({ reminders });
    await api.authorizeRemoteCommand(CAREGIVER, PATIENT, body({}) as any);
    expect(remoteCommands.authorize.mock.calls[1][2].reminders).toBeNull();
    vi.unstubAllEnvs();
  });

  it('refuses malformed reminders before anything is authorized', async () => {
    const { api, remoteCommands } = remoteSetup();
    await expect(api.authorizeRemoteCommand(CAREGIVER, PATIENT, body({ reminders: [{ kind: 'SECOND_DOSE', trigger: 'AFTER_MINUTES', minutes: 3 }] }) as any)).rejects.toThrow('minutes must be whole minutes 5-240');
    await expect(api.authorizeRemoteCommand(CAREGIVER, PATIENT, body({ reminders: [{ kind: 'WBT' }, { kind: 'WBT' }] }) as any)).rejects.toThrow('at most one WBT');
    expect(remoteCommands.authorize).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
