import { describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError, StaleWriteError, ValidationError } from '@shared/errors/app-error';
import { ApiService } from './api.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const MEAL = '22222222-2222-4222-8222-222222222222';
const PHOTO = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '55555555-5555-4555-8555-555555555555';
const CAREGIVER = { user_id: '44444444-4444-4444-8444-444444444444' } as any;

const PROPOSAL = { items: [{ name: 'Skyr Polmlek truskawka i kiwi', grams: 75 }, { name: 'Łyżeczka miodu', grams: null }], carbs_g: 28.2, protein_g: 4.2, fat_g: 9.8, confidence: 'MEDIUM', assumptions: '', proposal_id: 'proposal-1' };

function setup(status = 'AWAITING_DESCRIPTION', pendingProposalId: string | null = null) {
  const repo = {
    async getAccessRow(userId: string, patientId: string) {
      return userId === CAREGIVER.user_id && patientId === PATIENT ? { can_read_patient: true, can_write_patient: true } : null;
    },
    insertAuditEvent: vi.fn(),
    insertJob: vi.fn(async (job: unknown) => job),
    getJobStatusByDedupeKey: vi.fn(async () => 'queued'),
    requeueFailedJob: vi.fn(async () => true),
  };
  const api = new ApiService(repo as any, {} as any);
  const records = {
    findMealIdentityById: vi.fn(async () => 'meal:identity'),
    getAnchorEventId: vi.fn(async () => 'anchor-event'),
    getMealRecord: vi.fn(async () => ({ status, content_revision: 3, started_at: '2026-10-15T06:15:00.000Z', source_carbs_g: 30, description: null, has_photo: false, pending_proposal_id: pendingProposalId, macros: { carbs: { grams: null, origin: null }, protein: { grams: null, origin: null }, fat: { grams: null, origin: null } } })),
    recordDescription: vi.fn(async () => undefined),
    confirmProposal: vi.fn(async () => undefined),
    updateDescription: vi.fn(async () => undefined),
    correctMacros: vi.fn(async () => undefined),
  };
  const chat = {
    countPhotosOfMeal: vi.fn(async (_p: string, _m: string, ids: string[]) => ids.length),
    insertUserMessage: vi.fn(async () => ({ message: { id: MESSAGE }, created: true })),
    listMessages: vi.fn(async () => [{ id: MESSAGE, role: 'USER', content: 'Kanapka', photo_ids: [], proposal: null, question: null, author_display_name: 'Piotr', reply_to_message_id: null, created_at: 'x' }]),
    getMessage: vi.fn(async () => ({ id: MESSAGE, role: 'ASSISTANT', proposal: PROPOSAL })),
    insertPhoto: vi.fn(async () => PHOTO),
  };
  const storage = { save: vi.fn(async () => undefined), read: vi.fn() };
  Object.assign(api as any, { mealRecordRepository: records, mealChatRepository: chat, photoStorage: storage, mealWbtRepository: { getReminder: async () => null, setAutoReminder: async () => undefined, setManualReminder: async () => undefined, getLatestSuggestion: async () => null } });
  return { api, repo, records, chat, storage };
}

describe('ApiService meal chat', () => {
  it('stores the first message as the meal description and asks the AI in a job', async () => {
    const { api, repo, records } = setup();
    const response = await api.postMealChatMessage(CAREGIVER, PATIENT, MEAL, { content: 'Kanapka z masłem', photo_ids: [PHOTO] }, 'key-1');

    expect(records.recordDescription).toHaveBeenCalledWith(PATIENT, 'meal:identity', { description: 'Kanapka z masłem', photo_ref: `photo:${PHOTO}` });
    expect(repo.insertJob).toHaveBeenCalledWith(expect.objectContaining({ jobType: 'meal.chat_reply', dedupeKey: `meal.chat_reply:${MESSAGE}` }));
    expect(response).toMatchObject({ reply_pending: true, reply_failed: false });
  });

  it('still asks the AI when the other caregiver described the meal a moment earlier', async () => {
    const { api, repo, records } = setup();
    records.recordDescription.mockRejectedValueOnce(new ConflictError('Meal record cannot move from DESCRIBED to DESCRIBED'));
    await api.postMealChatMessage(CAREGIVER, PATIENT, MEAL, { content: 'Kanapka' }, 'key-race');
    expect(repo.insertJob).toHaveBeenCalledWith(expect.objectContaining({ jobType: 'meal.chat_reply' }));
  });

  it('returns the reply being written while it is pending', async () => {
    const { api } = setup();
    Object.assign(api as any, { replyDrafts: { get: vi.fn(async () => ({ reply_to_message_id: MESSAGE, content: 'Dwie kanapki', thread_kind: 'MEAL_CHAT', thread_id: MEAL, updated_at: 'x' })) } });
    expect(await api.getMealChat(CAREGIVER, PATIENT, MEAL)).toMatchObject({ reply_pending: true, reply_draft: { reply_to_message_id: MESSAGE, content: 'Dwie kanapki' } });
    Object.assign(api as any, { replyDrafts: { get: vi.fn(async () => { throw new Error('db'); }) } });
    expect(await api.getMealChat(CAREGIVER, PATIENT, MEAL)).toMatchObject({ reply_draft: null });
  });

  it('refuses to accept a proposal for a meal the other caregiver changed, and checks only the first write', async () => {
    const stale = setup('AI_PROPOSED', 'proposal-1');
    await expect(stale.api.acceptMealChatProposal(CAREGIVER, PATIENT, MEAL, MESSAGE, { expected_revision: 2 })).rejects.toBeInstanceOf(StaleWriteError);
    expect(stale.records.updateDescription).not.toHaveBeenCalled();

    const current = setup('AI_PROPOSED', 'proposal-1');
    await current.api.acceptMealChatProposal(CAREGIVER, PATIENT, MEAL, MESSAGE, { expected_revision: 3 });
    expect(current.records.updateDescription.mock.calls[0]?.[3]).toEqual({ expectedRevision: 3 });
    expect(current.records.confirmProposal.mock.calls[0]?.[4]).toEqual({ expectedRevision: null, items: null });
    await expect(current.api.acceptMealChatProposal(CAREGIVER, PATIENT, MEAL, MESSAGE, { expected_revision: 'x' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('does not touch the description of a meal that already has one', async () => {
    const { api, records } = setup('CONFIRMED');
    await api.postMealChatMessage(CAREGIVER, PATIENT, MEAL, { content: 'A jednak dwie bułki' }, 'key-2');
    expect(records.recordDescription).not.toHaveBeenCalled();
  });

  it('rejects an empty message, too many photos and photos of another meal', async () => {
    const { api, chat } = setup();
    await expect(api.postMealChatMessage(CAREGIVER, PATIENT, MEAL, { content: ' ' }, 'k')).rejects.toBeInstanceOf(ValidationError);
    await expect(api.postMealChatMessage(CAREGIVER, PATIENT, MEAL, { photo_ids: [PHOTO, MEAL, MESSAGE, PATIENT] }, 'k')).rejects.toBeInstanceOf(ValidationError);
    chat.countPhotosOfMeal.mockResolvedValueOnce(0);
    await expect(api.postMealChatMessage(CAREGIVER, PATIENT, MEAL, { photo_ids: [PHOTO] }, 'k')).rejects.toBeInstanceOf(ValidationError);
  });

  it('confirms the pending proposal as such, otherwise saves the values as the caregiver', async () => {
    const pending = setup('AI_PROPOSED', 'proposal-1');
    await pending.api.acceptMealChatProposal(CAREGIVER, PATIENT, MEAL, MESSAGE);
    expect(pending.records.confirmProposal).toHaveBeenCalledWith(PATIENT, 'meal:identity', CAREGIVER.user_id, 'proposal-1', { expectedRevision: null, items: null });
    expect(pending.records.updateDescription).toHaveBeenCalledWith(PATIENT, 'meal:identity', 'Skyr Polmlek truskawka i kiwi (75 g), Łyżeczka miodu', { expectedRevision: null });

    const confirmed = setup('CONFIRMED');
    await confirmed.api.acceptMealChatProposal(CAREGIVER, PATIENT, MEAL, MESSAGE);
    expect(confirmed.records.correctMacros).toHaveBeenCalledWith(PATIENT, 'meal:identity', CAREGIVER.user_id, { carbs_g: 28.2, protein_g: 4.2, fat_g: 9.8 }, { expectedRevision: null, items: null });
  });

  it('stores the proposal items with the accepted values, so a later change has them to start from', async () => {
    const pending = setup('AI_PROPOSED', 'proposal-1');
    const items = [
      { name: 'Skyr Polmlek truskawka i kiwi', grams: 75, carbs_g: 10.5, protein_g: 4.2, fat_g: 2, source: 'DIABCALC' },
      { name: 'Łyżeczka miodu', grams: null, carbs_g: 17.7, protein_g: 0, fat_g: 7.8, source: 'ESTIMATE' },
    ];
    pending.chat.getMessage.mockResolvedValueOnce({ id: MESSAGE, role: 'ASSISTANT', proposal: { ...PROPOSAL, items } } as any);
    await pending.api.acceptMealChatProposal(CAREGIVER, PATIENT, MEAL, MESSAGE);
    expect(pending.records.confirmProposal.mock.calls[0]?.[4]).toEqual({ expectedRevision: null, items });
  });

  it('accepts only JPEG photos up to 4 MB', async () => {
    const { api, storage } = setup();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
    await expect(api.uploadMealPhoto(CAREGIVER, PATIENT, MEAL, { content_type: 'image/jpeg', data_base64: jpeg })).resolves.toEqual({ patient_id: PATIENT, photo_id: PHOTO });
    expect(storage.save).toHaveBeenCalledWith(PATIENT, PHOTO, expect.any(Buffer));
    await expect(api.uploadMealPhoto(CAREGIVER, PATIENT, MEAL, { content_type: 'image/jpeg', data_base64: Buffer.from('PNG').toString('base64') })).rejects.toBeInstanceOf(ValidationError);
    await expect(api.getMealPhoto(CAREGIVER, PATIENT, MEAL, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('requeues the failed reply of the last unanswered message', async () => {
    const { api, repo } = setup('DESCRIBED');
    await api.retryMealChatReply(CAREGIVER, PATIENT, MEAL);
    expect(repo.requeueFailedJob).toHaveBeenCalledWith('meal.chat_reply', `meal.chat_reply:${MESSAGE}`);
  });
});
