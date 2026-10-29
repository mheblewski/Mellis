import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError } from '@shared/errors/app-error';
import { ApiService } from './api.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const CAREGIVER = { user_id: '44444444-4444-4444-8444-444444444444' } as any;
const READER = { user_id: '55555555-5555-4555-8555-555555555555' } as any;

function setup(options: { exists?: boolean; deletedAt?: string | null } = {}) {
  const repo = {
    async getAccessRow(userId: string, patientId: string) {
      if (patientId !== PATIENT) return null;
      if (userId === CAREGIVER.user_id) return { can_read_patient: true, can_write_patient: true };
      if (userId === READER.user_id) return { can_read_patient: true, can_write_patient: false };
      return null;
    },
    insertAuditEvent: vi.fn(),
    softDeleteConversation: vi.fn(async () => options.exists ?? true),
    getConversation: vi.fn(async () => ({ id: CONVERSATION, patient_id: PATIENT, deleted_at: options.deletedAt ?? null, messages: [] })),
  };
  return { repo, api: new ApiService(repo as any, {} as any) };
}

describe('ApiService.deleteConversation', () => {
  it('soft-deletes for a caregiver with write access and records who deleted it', async () => {
    const { api, repo } = setup();
    await api.deleteConversation(CAREGIVER, PATIENT, CONVERSATION);
    expect(repo.softDeleteConversation).toHaveBeenCalledWith(PATIENT, CONVERSATION, CAREGIVER.user_id);
  });

  it('is not allowed for a read-only caregiver', async () => {
    const { api, repo } = setup();
    await expect(api.deleteConversation(READER, PATIENT, CONVERSATION)).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.softDeleteConversation).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown or malformed conversation id', async () => {
    await expect(setup({ exists: false }).api.deleteConversation(CAREGIVER, PATIENT, CONVERSATION)).rejects.toBeInstanceOf(NotFoundError);
    const { api, repo } = setup();
    await expect(api.deleteConversation(CAREGIVER, PATIENT, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.softDeleteConversation).not.toHaveBeenCalled();
  });

  it('hides a deleted conversation from reads and refuses new messages in it', async () => {
    const { api } = setup({ deletedAt: '2026-10-15T15:00:00.000Z' });
    await expect(api.getConversation(CAREGIVER, PATIENT, CONVERSATION)).rejects.toBeInstanceOf(NotFoundError);
    await expect(api.submitAnswer(CAREGIVER, PATIENT, CONVERSATION, { message_type: 'USER_MESSAGE', content: 'Hej', idempotency_key: 'k1' }))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});
