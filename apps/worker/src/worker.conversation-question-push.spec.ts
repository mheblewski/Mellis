import { describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';

// A clarifying question about the caregiver's own message (USER investigation) is pushed like any question: no phone
// switch holds it back and its text says nothing about a hypo. Fake repository and push.
const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const QUESTION = 'activity_before_drop';

function setup(devices: Array<Record<string, unknown>>) {
  const repository = {
    claimNextJob: vi.fn().mockResolvedValueOnce({
      id: 'push-job-1',
      lease_token: 'lease-push-1',
      job_type: 'notifications.push_conversation_question',
      payload_version: 1,
      payload: {
        patient_id: PATIENT,
        conversation_id: CONVERSATION,
        question_id: QUESTION,
        notification_dedupe_key: `conversation-question:${PATIENT}:${CONVERSATION}:${QUESTION}`,
      },
      attempts: 1,
      max_attempts: 5,
    }).mockResolvedValueOnce(null),
    patientHasAnyCaregiverRelationship: vi.fn().mockResolvedValue(true),
    getPushNotificationByDedupeKey: vi.fn().mockResolvedValue(null),
    incrementPushNotificationAttempts: vi.fn().mockResolvedValue(undefined),
    getConversation: vi.fn().mockResolvedValue({ id: CONVERSATION, episode_id: null, pending_question: { question_id: QUESTION } }),
    listActivePatientDevices: vi.fn().mockResolvedValue(devices),
    markPushNotificationSent: vi.fn().mockResolvedValue(undefined),
    markPushNotificationFailed: vi.fn().mockResolvedValue(undefined),
    finalizeJobSuccess: vi.fn().mockResolvedValue({ rowCount: 1, ownershipLost: false }),
    finalizeJobRetry: vi.fn(),
    finalizeJobFailure: vi.fn(),
  } as any;
  const pushNotificationService = { sendConversationQuestion: vi.fn().mockResolvedValue(undefined) } as any;
  const worker = new WorkerService(repository, {} as any, { getOrThrow: vi.fn().mockReturnValue('test') } as any, {} as any, pushNotificationService);
  return { worker, repository, pushNotificationService };
}

describe('WorkerService clarifying question push', () => {
  it('goes to every active phone, with a neutral text', async () => {
    const { worker, repository, pushNotificationService } = setup([
      { push_token: 'token-a' },
      { push_token: 'token-b' },
    ]);

    await worker.processOnce();

    expect(pushNotificationService.sendConversationQuestion).toHaveBeenCalledTimes(2);
    const sent = pushNotificationService.sendConversationQuestion.mock.calls.map((call: any[]) => call[0]);
    expect(sent.map((push: { pushToken: string }) => push.pushToken)).toEqual(['token-a', 'token-b']);
    expect(sent[0]).toMatchObject({
      questionId: QUESTION,
      title: 'Mellis potrzebuje odpowiedzi',
      body: 'Mam pytanie doprecyzowujące do Twojej wiadomości. Odpowiedź pomoże mi lepiej przeanalizować sytuację.',
    });
    expect(sent[0].body).not.toMatch(/hipo/i);
    expect(repository.markPushNotificationFailed).not.toHaveBeenCalled();
    expect(repository.markPushNotificationSent).toHaveBeenCalled();
  });
});
