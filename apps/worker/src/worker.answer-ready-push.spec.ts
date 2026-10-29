import { describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';
import { MEAL_CHAT_REPLY_JOB_TYPE } from '@modules/meal-chat/application/meal-chat-reply.job';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';

// answer-ready-push.v1: once the answer is stored (or the question failed for good) the asking caregiver's phones with
// "Gotowa odpowiedź" on get a push. Fake repository and push service.
const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const QUESTION = '33333333-3333-4333-8333-333333333333';
const MEAL = '44444444-4444-4444-8444-444444444444';
const ASKER = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';

const DEVICES = [
  { push_token: 'asker-on', user_id: ASKER, answer_ready_push_enabled: true },
  { push_token: 'asker-off', user_id: ASKER, answer_ready_push_enabled: false },
  { push_token: 'other-caregiver', user_id: OTHER, answer_ready_push_enabled: true },
  { push_token: 'legacy-row', user_id: null, answer_ready_push_enabled: true },
];

function setup(options: { answer?: string | null; conversationFound?: boolean; cancelled?: boolean; alreadyPushed?: boolean } = {}) {
  const repository = {
    claimNextJob: vi.fn().mockResolvedValueOnce({
      id: 'job-1',
      lease_token: 'lease-1',
      job_type: 'conversation.direct_response',
      payload_version: 1,
      payload: { patient_id: PATIENT, conversation_id: CONVERSATION, user_message_id: QUESTION },
      attempts: 1,
      max_attempts: 1,
    }).mockResolvedValueOnce(null),
    getConversation: vi.fn().mockResolvedValue(options.conversationFound === false ? null : { id: CONVERSATION }),
    getMessageByIdempotencyKey: vi.fn().mockResolvedValue(options.answer === null ? null : { content: options.answer ?? '**Glukoza 142 mg/dL** i stabilna.' }),
    getMessageById: vi.fn().mockResolvedValue({ id: QUESTION, message_type: 'USER_MESSAGE', author_user_id: ASKER }),
    isUserMessageCancelled: vi.fn().mockResolvedValue(options.cancelled ?? false),
    listActivePatientDevices: vi.fn().mockResolvedValue(DEVICES),
    deactivatePatientDevicesByPushToken: vi.fn(),
    claimAnswerPush: vi.fn().mockResolvedValue(!options.alreadyPushed),
    finalizeJobSuccess: vi.fn().mockResolvedValue({ rowCount: 1, ownershipLost: false }),
    finalizeJobCancelled: vi.fn().mockResolvedValue({ rowCount: 1 }),
    finalizeJobRetry: vi.fn(),
    finalizeJobFailure: vi.fn().mockResolvedValue(undefined),
  } as any;
  const pushNotificationService = { sendAnswerReady: vi.fn().mockResolvedValue(undefined) } as any;
  const worker = new WorkerService(repository, {} as any, { getOrThrow: vi.fn().mockReturnValue('test') } as any, {} as any, pushNotificationService);
  return { worker, repository, pushNotificationService };
}

describe('WorkerService answer-ready push', () => {
  it('sends the stored answer only to the asking caregiver\'s phones that have the switch on', async () => {
    const { worker, repository, pushNotificationService } = setup();

    await worker.processOnce();

    expect(repository.finalizeJobSuccess).toHaveBeenCalled();
    expect(repository.getMessageByIdempotencyKey).toHaveBeenCalledWith(CONVERSATION, `assistant-message:direct:${CONVERSATION}:${QUESTION}`);
    expect(pushNotificationService.sendAnswerReady).toHaveBeenCalledTimes(1);
    expect(pushNotificationService.sendAnswerReady).toHaveBeenCalledWith({
      patientId: PATIENT,
      pushToken: 'asker-on',
      target: { conversationId: CONVERSATION },
      questionMessageId: QUESTION,
      title: 'Odpowiedź gotowa',
      body: 'Glukoza 142 mg/dL i stabilna.',
    });
  });

  it('pushes nothing when the question was cancelled and no answer was stored', async () => {
    const { worker, repository, pushNotificationService } = setup({ answer: null, cancelled: true });

    await worker.processOnce();

    expect(repository.finalizeJobCancelled).toHaveBeenCalled();
    expect(repository.finalizeJobFailure).not.toHaveBeenCalled();
    expect(pushNotificationService.sendAnswerReady).not.toHaveBeenCalled();
  });

  it('tells the asker when the question failed for good, but not after a cancel', async () => {
    const failed = setup({ conversationFound: false, answer: null });
    await failed.worker.processOnce();
    expect(failed.repository.finalizeJobFailure).toHaveBeenCalled();
    expect(failed.pushNotificationService.sendAnswerReady).toHaveBeenCalledTimes(1);
    expect(failed.pushNotificationService.sendAnswerReady.mock.calls[0][0]).toMatchObject({
      pushToken: 'asker-on',
      title: 'Nie udało się odpowiedzieć',
      body: 'Nie mogę teraz przygotować odpowiedzi. Otwórz rozmowę i spróbuj ponownie.',
    });

    const cancelled = setup({ conversationFound: false, answer: null, cancelled: true });
    await cancelled.worker.processOnce();
    expect(cancelled.pushNotificationService.sendAnswerReady).not.toHaveBeenCalled();
  });

  it('a job rerun after a lost lease pushes nothing: the first finish already pushed (migration 083)', async () => {
    const { worker, repository, pushNotificationService } = setup({ alreadyPushed: true });

    await worker.processOnce();

    expect(repository.claimAnswerPush).toHaveBeenCalledWith({ patientId: PATIENT, questionMessageId: QUESTION, outcome: 'ready' });
    expect(pushNotificationService.sendAnswerReady).not.toHaveBeenCalled();
  });

  it('says nothing failed when an earlier run of the job already stored the answer', async () => {
    const { worker, pushNotificationService } = setup({ conversationFound: false });

    await worker.processOnce();

    expect(pushNotificationService.sendAnswerReady).not.toHaveBeenCalled();
  });

  it('pushes no "ready" for a cancelled question even when an answer row exists', async () => {
    const { worker, pushNotificationService } = setup({ cancelled: true });

    await (worker as any).pushAnswerOutcome({ job_type: 'conversation.direct_response', payload: { patient_id: PATIENT, conversation_id: CONVERSATION, user_message_id: QUESTION } }, 'ready');

    expect(pushNotificationService.sendAnswerReady).not.toHaveBeenCalled();
  });

  it('a phone whose token APNs rejected is deactivated, the others still get the push', async () => {
    const { worker, repository, pushNotificationService } = setup();
    repository.listActivePatientDevices.mockResolvedValue([
      { push_token: 'dead', user_id: ASKER, answer_ready_push_enabled: true },
      { push_token: 'alive', user_id: ASKER, answer_ready_push_enabled: true },
    ]);
    pushNotificationService.sendAnswerReady.mockImplementation(async ({ pushToken }: { pushToken: string }) => {
      if (pushToken === 'dead') throw new PushNotificationProviderError('DEVICE_TOKEN_UNREGISTERED', 'gone', false);
    });

    await worker.processOnce();

    expect(repository.deactivatePatientDevicesByPushToken).toHaveBeenCalledWith('ios', 'dead');
    expect(pushNotificationService.sendAnswerReady).toHaveBeenCalledTimes(2);
  });

  it('a failed push never fails the finished job', async () => {
    const { worker, repository, pushNotificationService } = setup();
    pushNotificationService.sendAnswerReady.mockRejectedValue(new Error('APNS down'));

    await worker.processOnce();

    expect(repository.finalizeJobSuccess).toHaveBeenCalledTimes(1);
    expect(repository.finalizeJobFailure).not.toHaveBeenCalled();
  });

  it('a meal chat answer opens the meal', async () => {
    const { worker, pushNotificationService } = setup();
    (worker as any).mealChatRepository = {
      getMessage: vi.fn().mockResolvedValue({ id: QUESTION, role: 'USER', author_user_id: ASKER }),
      listMessages: vi.fn().mockResolvedValue([
        { id: QUESTION, role: 'USER', content: 'Ile węgli?', reply_to_message_id: null },
        { id: 'reply-1', role: 'ASSISTANT', content: 'Ok. 60 g węglowodanów.', reply_to_message_id: QUESTION },
      ]),
    };

    // A failure after the reply was stored (an earlier run's) is not told as a failure.
    await (worker as any).pushAnswerOutcome({ job_type: MEAL_CHAT_REPLY_JOB_TYPE, payload: { patient_id: PATIENT, meal_record_id: MEAL, user_message_id: QUESTION } }, 'failed');
    expect(pushNotificationService.sendAnswerReady).not.toHaveBeenCalled();

    await (worker as any).pushAnswerOutcome({ job_type: MEAL_CHAT_REPLY_JOB_TYPE, payload: { patient_id: PATIENT, meal_record_id: MEAL, user_message_id: QUESTION } }, 'ready');

    expect(pushNotificationService.sendAnswerReady).toHaveBeenCalledTimes(1);
    expect(pushNotificationService.sendAnswerReady.mock.calls[0][0]).toMatchObject({
      pushToken: 'asker-on',
      target: { mealId: MEAL },
      body: 'Ok. 60 g węglowodanów.',
    });
  });
});
