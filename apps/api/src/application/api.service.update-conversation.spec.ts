import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError, ValidationError } from '@shared/errors/app-error';
import { ApiService } from './api.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const CAREGIVER = { user_id: '44444444-4444-4444-8444-444444444444' } as any;
const READER = { user_id: '55555555-5555-4555-8555-555555555555' } as any;

function setup(options: { exists?: boolean } = {}) {
  const repo = {
    async getAccessRow(userId: string, patientId: string) {
      if (patientId !== PATIENT) return null;
      if (userId === CAREGIVER.user_id) return { can_read_patient: true, can_write_patient: true };
      if (userId === READER.user_id) return { can_read_patient: true, can_write_patient: false };
      return null;
    },
    insertAuditEvent: vi.fn(),
    updateConversationListSettings: vi.fn(async () => options.exists ?? true),
  };
  return { repo, api: new ApiService(repo as any, {} as any) };
}

describe('ApiService.updateConversation', () => {
  it('renames with whitespace collapsed and records who changed it', async () => {
    const { api, repo } = setup();
    await api.updateConversation(CAREGIVER, PATIENT, CONVERSATION, { title: '  Pizza   w sobotę ' });
    expect(repo.updateConversationListSettings).toHaveBeenCalledWith({
      patientId: PATIENT, conversationId: CONVERSATION, userId: CAREGIVER.user_id, title: 'Pizza w sobotę', pinned: undefined,
    });
  });

  it('pins and unpins without touching the title', async () => {
    const { api, repo } = setup();
    await api.updateConversation(CAREGIVER, PATIENT, CONVERSATION, { pinned: true });
    await api.updateConversation(CAREGIVER, PATIENT, CONVERSATION, { pinned: false });
    expect(repo.updateConversationListSettings).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: undefined, pinned: true }));
    expect(repo.updateConversationListSettings).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: undefined, pinned: false }));
  });

  it('refuses an empty, overlong or non-text title, a non-boolean pin and an empty change', async () => {
    const { api, repo } = setup();
    for (const body of [{ title: '   ' }, { title: 'x'.repeat(81) }, { title: 7 }, { pinned: 'yes' }, {}]) {
      await expect(api.updateConversation(CAREGIVER, PATIENT, CONVERSATION, body)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(repo.updateConversationListSettings).not.toHaveBeenCalled();
  });

  it('is not allowed for a read-only caregiver', async () => {
    const { api, repo } = setup();
    await expect(api.updateConversation(READER, PATIENT, CONVERSATION, { pinned: true })).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.updateConversationListSettings).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown, deleted or malformed conversation id', async () => {
    await expect(setup({ exists: false }).api.updateConversation(CAREGIVER, PATIENT, CONVERSATION, { pinned: true })).rejects.toBeInstanceOf(NotFoundError);
    const { api, repo } = setup();
    await expect(api.updateConversation(CAREGIVER, PATIENT, 'not-a-uuid', { pinned: true })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.updateConversationListSettings).not.toHaveBeenCalled();
  });
});
