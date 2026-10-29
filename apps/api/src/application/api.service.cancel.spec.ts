import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError } from '@shared/errors/app-error';
import { ApiService } from './api.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const MESSAGE = '33333333-3333-4333-8333-333333333333';
const CAREGIVER = { user_id: '44444444-4444-4444-8444-444444444444' } as any;
const READER = { user_id: '55555555-5555-4555-8555-555555555555' } as any;
const STRANGER = { user_id: '66666666-6666-4666-8666-666666666666' } as any;

function setup(outcome: string | null) {
  const repo = {
    async getAccessRow(userId: string, patientId: string) {
      if (patientId !== PATIENT) return null;
      if (userId === CAREGIVER.user_id) return { can_read_patient: true, can_write_patient: true };
      if (userId === READER.user_id) return { can_read_patient: true, can_write_patient: false };
      return null;
    },
    insertAuditEvent: vi.fn(),
    cancelUserMessageResponse: vi.fn(async () => (outcome ? { outcome, job_status: 'cancelled' } : null)),
    getConversation: vi.fn(async () => ({
      id: CONVERSATION,
      patient_id: PATIENT,
      messages: [
        { id: MESSAGE, role: 'USER', message_type: 'USER_MESSAGE', content: 'Jak minął dzień?', metadata: { response_state: 'CANCELLED' } },
        { id: 'internal', role: 'SYSTEM', message_type: 'INTERNAL_NOTE', content: 'hidden', metadata: {} },
      ],
    })),
  };
  return { repo, api: new ApiService(repo as any, {} as any) };
}

describe('ApiService.cancelMessageAnalysis', () => {
  it('cancels for a caregiver with write access and returns the explicit result and conversation', async () => {
    const { api, repo } = setup('CANCELLED');
    const response = await api.cancelMessageAnalysis(CAREGIVER, PATIENT, CONVERSATION, MESSAGE);

    expect(response.result).toBe('CANCELLED');
    expect(response.message_id).toBe(MESSAGE);
    expect(repo.cancelUserMessageResponse).toHaveBeenCalledWith(expect.objectContaining({
      patientId: PATIENT, conversationId: CONVERSATION, userMessageId: MESSAGE, cancelledBy: CAREGIVER.user_id,
    }));
    const messages = response.conversation.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0].response_status).toBe('CANCELLED');
    expect(messages[0].analysis_cancellable).toBe(false);
  });

  it('marks only a pending, job-backed user message as cancellable', async () => {
    const { api, repo } = setup('ALREADY_CANCELLED');
    const message = (id: string, decision: string, extra: Record<string, unknown> = {}) => ({
      id, role: 'USER', message_type: 'USER_MESSAGE', content: id, metadata: { decision, ...extra },
    });
    repo.getConversation.mockResolvedValue({
      id: CONVERSATION,
      patient_id: PATIENT,
      messages: [
        message('answered', 'DIRECT_RESPONSE'),
        { id: 'reply', role: 'ASSISTANT', message_type: 'ASSISTANT_MESSAGE', content: 'ok', metadata: { user_message_id: 'answered' } },
        message('investigation', 'INVESTIGATION_REQUIRED'),
        message('saving', 'ANALYSIS_REQUEST', { response_state: 'COMPLETING' }),
        message('pending', 'ANALYSIS_REQUEST'),
      ],
    } as any);

    const response = await api.cancelMessageAnalysis(CAREGIVER, PATIENT, CONVERSATION, MESSAGE);
    const cancellable = (response.conversation.messages as Array<Record<string, unknown>>)
      .filter((m) => m.analysis_cancellable === true)
      .map((m) => m.id);
    expect(cancellable).toEqual(['pending']);
  });

  it.each(['ALREADY_CANCELLED', 'ALREADY_COMPLETED', 'NOT_CANCELLABLE'])('passes through the race outcome %s unchanged', async (outcome) => {
    const { api } = setup(outcome);
    await expect(api.cancelMessageAnalysis(CAREGIVER, PATIENT, CONVERSATION, MESSAGE)).resolves.toMatchObject({ result: outcome });
  });

  it('refuses read-only and unrelated users before touching any state', async () => {
    for (const principal of [READER, STRANGER]) {
      const { api, repo } = setup('CANCELLED');
      await expect(api.cancelMessageAnalysis(principal, PATIENT, CONVERSATION, MESSAGE)).rejects.toBeInstanceOf(ForbiddenError);
      expect(repo.cancelUserMessageResponse).not.toHaveBeenCalled();
    }
  });

  it('returns 404 for a message outside this patient/conversation or a malformed id', async () => {
    const { api } = setup(null);
    await expect(api.cancelMessageAnalysis(CAREGIVER, PATIENT, CONVERSATION, MESSAGE)).rejects.toBeInstanceOf(NotFoundError);

    const valid = setup('CANCELLED');
    await expect(valid.api.cancelMessageAnalysis(CAREGIVER, PATIENT, 'not-a-uuid', MESSAGE)).rejects.toBeInstanceOf(NotFoundError);
    expect(valid.repo.cancelUserMessageResponse).not.toHaveBeenCalled();
  });
});
