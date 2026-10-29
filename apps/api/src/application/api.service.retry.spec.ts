import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError } from '@shared/errors/app-error';
import { ApiService } from './api.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const MESSAGE = '33333333-3333-4333-8333-333333333333';
const CAREGIVER = { user_id: '44444444-4444-4444-8444-444444444444' } as any;
const READER = { user_id: '55555555-5555-4555-8555-555555555555' } as any;

function setup(options: { requeued: boolean; message?: Record<string, unknown> | null }) {
  const repo = {
    async getAccessRow(userId: string, patientId: string) {
      if (patientId !== PATIENT) return null;
      if (userId === CAREGIVER.user_id) return { can_read_patient: true, can_write_patient: true };
      if (userId === READER.user_id) return { can_read_patient: true, can_write_patient: false };
      return null;
    },
    insertAuditEvent: vi.fn(),
    getMessageById: vi.fn(async () => (options.message === undefined
      ? { id: MESSAGE, patient_id: PATIENT, role: 'USER', message_type: 'USER_MESSAGE', content: 'Co wywołało wzrost do 318?' }
      : options.message)),
    requeueFailedConversationResponse: vi.fn(async () => options.requeued),
    getConversation: vi.fn(async () => ({
      id: CONVERSATION,
      patient_id: PATIENT,
      messages: [{ id: MESSAGE, role: 'USER', message_type: 'USER_MESSAGE', content: 'Co wywołało wzrost do 318?', metadata: { decision: 'ANALYSIS_REQUEST' } }],
      processing: options.requeued ? { status: 'PROCESSING', current_step: { type: 'QUEUED', status: 'STARTED', label: 'Ponawiam analizę' }, steps: [] } : null,
    })),
  };
  return { repo, api: new ApiService(repo as any, {} as any) };
}

describe('ApiService.retryMessageAnalysis', () => {
  it('puts the failed answer of a caregiver message back in the queue and returns the conversation in progress', async () => {
    const { api, repo } = setup({ requeued: true });
    const response = await api.retryMessageAnalysis(CAREGIVER, PATIENT, CONVERSATION, MESSAGE);
    expect(response).toMatchObject({ result: 'REQUEUED', message_id: MESSAGE });
    expect(repo.requeueFailedConversationResponse).toHaveBeenCalledWith({ patientId: PATIENT, conversationId: CONVERSATION, userMessageId: MESSAGE });
    expect(response.conversation.processing).toMatchObject({ status: 'PROCESSING' });
  });

  it('reports NOT_FAILED when there was nothing to retry', async () => {
    const { api } = setup({ requeued: false });
    await expect(api.retryMessageAnalysis(CAREGIVER, PATIENT, CONVERSATION, MESSAGE)).resolves.toMatchObject({ result: 'NOT_FAILED' });
  });

  it('retries only a caregiver message of this patient', async () => {
    for (const message of [null, { id: MESSAGE, patient_id: PATIENT, message_type: 'ASSISTANT_MESSAGE' }, { id: MESSAGE, patient_id: 'other', message_type: 'USER_MESSAGE' }]) {
      const { api, repo } = setup({ requeued: true, message });
      await expect(api.retryMessageAnalysis(CAREGIVER, PATIENT, CONVERSATION, MESSAGE)).rejects.toBeInstanceOf(NotFoundError);
      expect(repo.requeueFailedConversationResponse).not.toHaveBeenCalled();
    }
    const { api } = setup({ requeued: true });
    await expect(api.retryMessageAnalysis(CAREGIVER, PATIENT, CONVERSATION, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a read-only user before touching any state', async () => {
    const { api, repo } = setup({ requeued: true });
    await expect(api.retryMessageAnalysis(READER, PATIENT, CONVERSATION, MESSAGE)).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.requeueFailedConversationResponse).not.toHaveBeenCalled();
  });
});
