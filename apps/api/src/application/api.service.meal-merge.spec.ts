import { describe, expect, it, vi } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@shared/errors/app-error';
import { ApiService } from './api.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const TAB_MEAL = '22222222-2222-4222-8222-222222222222';
const CHAT_MEAL = '33333333-3333-4333-8333-333333333333';
const SPLIT_MEAL = '44444444-4444-4444-8444-444444444444';
const PLAN = '55555555-5555-4555-8555-555555555555';
const CAREGIVER = { user_id: '66666666-6666-4666-8666-666666666666' } as any;
const READER = { user_id: '77777777-7777-4777-8777-777777777777' } as any;
const NOW = new Date('2026-11-01T13:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const none = { grams: null, origin: null };
const given = (grams: number) => ({ grams, origin: 'CAREGIVER' });

function setup(options: { described?: string[]; splitStatus?: string; secondSplit?: boolean; tabMinutesAgo?: number } = {}) {
  const repo = {
    getAccessRow: async (userId: string, patientId: string) => {
      if (patientId !== PATIENT) return null;
      if (userId === CAREGIVER.user_id) return { can_read_patient: true, can_write_patient: true };
      if (userId === READER.user_id) return { can_read_patient: true, can_write_patient: false };
      return null;
    },
    insertAuditEvent: async () => {},
  };
  const api = new ApiService(repo as any, {} as any);
  const described = new Set(options.described ?? [CHAT_MEAL]);
  const record = (id: string, minutes: number, carbs: number) => described.has(id)
    ? { status: 'CORRECTED', started_at: ago(minutes), description: 'Obiad', source_carbs_g: carbs, has_photo: false, items: null, macros: { carbs: given(carbs), protein: given(20), fat: given(25) }, content_revision: 2 }
    : { status: 'AWAITING_DESCRIPTION', started_at: ago(minutes), description: null, source_carbs_g: carbs, has_photo: false, items: null, macros: { carbs: none, protein: none, fat: none }, content_revision: 1 };
  const records: Record<string, any> = {
    [TAB_MEAL]: record(TAB_MEAL, options.tabMinutesAgo ?? 30, 20),
    [CHAT_MEAL]: record(CHAT_MEAL, 60, 45),
    [SPLIT_MEAL]: record(SPLIT_MEAL, 90, 50),
  };
  const plans = [
    { id: PLAN, meal_record_id: SPLIT_MEAL, status: options.splitStatus ?? 'SCHEDULED', due_at: ago(-30), kind: 'SPLIT', trigger: 'AFTER_MINUTES', wait_until: null, notified_at: null },
    ...(options.secondSplit ? [{ id: '88888888-8888-4888-8888-888888888888', meal_record_id: CHAT_MEAL, status: 'SCHEDULED', due_at: ago(-20), kind: 'SPLIT', trigger: 'AFTER_MINUTES', wait_until: null, notified_at: null }] : []),
  ];
  const mocks = {
    mealJournal: { mealOrigins: vi.fn(async () => new Map()) },
    mealMerges: { merge: vi.fn(async () => {}), assertNoDoseBeingSent: vi.fn(async () => {}), deleteMeal: vi.fn(async () => true) },
    mealRecordRepository: {
      findMealIdentityById: vi.fn(async (_p: string, id: string) => (records[id] ? `identity:${id}` : null)),
      getMealRecord: vi.fn(async (_p: string, identity: string) => records[identity.replace('identity:', '')]),
    },
    loopActions: { listActionsForMeals: vi.fn(async () => []) },
    mealWbtRepository: { listRemindersForMeals: vi.fn(async () => []), setAutoReminder: vi.fn(async () => {}) },
    careReminderRepository: { listForMeals: vi.fn(async () => []), get: vi.fn(async () => null), cancel: vi.fn(async () => null) },
    plannedBolusRepository: { listForMeals: vi.fn(async () => plans) },
    plannedBoluses: { skip: vi.fn(async () => ({})) },
    remoteCommandRepository: { confirmedBolusesForActions: vi.fn(async () => new Map()) },
  };
  Object.assign(api as any, mocks);
  return { api, mocks };
}

describe('ApiService meal delete ("Usuń")', () => {
  it('skips the later part still to come, then deletes the meal', async () => {
    const { api, mocks } = setup();
    expect(await api.deleteMeal(CAREGIVER, PATIENT, SPLIT_MEAL, NOW)).toEqual({ patient_id: PATIENT, meal_id: SPLIT_MEAL });
    expect(mocks.plannedBoluses.skip).toHaveBeenCalledWith(PATIENT, CAREGIVER.user_id, PLAN);
    expect(mocks.mealMerges.deleteMeal).toHaveBeenCalledWith(PATIENT, SPLIT_MEAL);
  });

  it('leaves the plan alone when a dose is being sent for the meal', async () => {
    const { api, mocks } = setup();
    mocks.mealMerges.assertNoDoseBeingSent.mockRejectedValueOnce(new ConflictError('MEAL_DELETE_SENDING: x'));
    await expect(api.deleteMeal(CAREGIVER, PATIENT, SPLIT_MEAL, NOW)).rejects.toThrow(/MEAL_DELETE_SENDING/);
    expect(mocks.plannedBoluses.skip).not.toHaveBeenCalled();
    expect(mocks.mealMerges.deleteMeal).not.toHaveBeenCalled();
  });

  it('does not delete when the later part cannot be skipped any more', async () => {
    const { api, mocks } = setup();
    mocks.plannedBoluses.skip.mockRejectedValueOnce(new ConflictError('PLANNED_PART_ON_ITS_WAY: x'));
    await expect(api.deleteMeal(CAREGIVER, PATIENT, SPLIT_MEAL, NOW)).rejects.toBeInstanceOf(ConflictError);
    expect(mocks.mealMerges.deleteMeal).not.toHaveBeenCalled();
  });

  it('an already deleted meal is fine, an unknown one is not found, a reader may not delete', async () => {
    const { api, mocks } = setup();
    mocks.mealRecordRepository.getMealRecord.mockResolvedValueOnce({ status: 'CANCELLED' } as any);
    await expect(api.deleteMeal(CAREGIVER, PATIENT, TAB_MEAL, NOW)).resolves.toMatchObject({ meal_id: TAB_MEAL });
    expect(mocks.mealMerges.deleteMeal).not.toHaveBeenCalled();
    await expect(api.deleteMeal(CAREGIVER, PATIENT, '99999999-9999-4999-8999-999999999999', NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(api.deleteMeal(READER, PATIENT, TAB_MEAL, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('ApiService meal merge ("Scal")', () => {
  it('previews a merge that keeps the one described meal', async () => {
    const { api, mocks } = setup();
    const { merge } = await api.previewMealMerge(CAREGIVER, PATIENT, { meal_ids: [TAB_MEAL, CHAT_MEAL] }, NOW);
    expect(merge).toEqual({ ok: true, meal_id: CHAT_MEAL, content: 'KEPT', split: false });
    expect(mocks.mealMerges.merge).not.toHaveBeenCalled();
  });

  it('merges into the described meal, adding the other meal carbs, and follows its macros for WBT', async () => {
    const { api, mocks } = setup();
    const result = await api.mergeMeals(CAREGIVER, PATIENT, { meal_ids: [TAB_MEAL, CHAT_MEAL] }, NOW);
    expect(mocks.mealMerges.merge).toHaveBeenCalledWith({
      patientId: PATIENT, targetId: CHAT_MEAL, sourceIds: [TAB_MEAL], content: 'KEPT', contentMealId: CHAT_MEAL, addedCarbsG: 20, split: null, userId: CAREGIVER.user_id,
    });
    expect(mocks.mealWbtRepository.setAutoReminder).toHaveBeenCalledWith(expect.objectContaining({ mealRecordId: CHAT_MEAL, enabled: true }));
    expect(result).toMatchObject({ meal_id: CHAT_MEAL, content: 'KEPT', split: null, item: { meal_id: CHAT_MEAL, title: 'Obiad' } });
  });

  it('asks before resetting several descriptions and merges once confirmed', async () => {
    const { api, mocks } = setup({ described: [TAB_MEAL, CHAT_MEAL] });
    expect((await api.previewMealMerge(CAREGIVER, PATIENT, { meal_ids: [TAB_MEAL, CHAT_MEAL] }, NOW)).merge).toMatchObject({ ok: true, content: 'RESET' });
    await expect(api.mergeMeals(CAREGIVER, PATIENT, { meal_ids: [TAB_MEAL, CHAT_MEAL] }, NOW)).rejects.toThrow(/MEAL_MERGE_RESET_UNCONFIRMED/);
    expect(mocks.mealMerges.merge).not.toHaveBeenCalled();
    await api.mergeMeals(CAREGIVER, PATIENT, { meal_ids: [TAB_MEAL, CHAT_MEAL], reset_confirmed: true }, NOW);
    expect(mocks.mealMerges.merge).toHaveBeenCalledWith(expect.objectContaining({ targetId: CHAT_MEAL, content: 'RESET', contentMealId: null, addedCarbsG: 0 }));
  });

  it('asks about the one split meal: keeping it leaves its parts, a new split skips them first', async () => {
    const { api, mocks } = setup();
    expect((await api.previewMealMerge(CAREGIVER, PATIENT, { meal_ids: [TAB_MEAL, SPLIT_MEAL] }, NOW)).merge).toEqual({ ok: true, meal_id: SPLIT_MEAL, content: 'NONE', split: true });
    await expect(api.mergeMeals(CAREGIVER, PATIENT, { meal_ids: [TAB_MEAL, SPLIT_MEAL] }, NOW)).rejects.toThrow(/MEAL_MERGE_SPLIT_UNDECIDED/);

    await api.mergeMeals(CAREGIVER, PATIENT, { meal_ids: [TAB_MEAL, SPLIT_MEAL], split: 'KEEP' }, NOW);
    expect(mocks.plannedBoluses.skip).not.toHaveBeenCalled();
    expect(mocks.mealMerges.merge).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: SPLIT_MEAL, split: 'KEEP' }));

    await api.mergeMeals(CAREGIVER, PATIENT, { meal_ids: [TAB_MEAL, SPLIT_MEAL], split: 'RESPLIT' }, NOW);
    expect(mocks.plannedBoluses.skip).toHaveBeenCalledWith(PATIENT, CAREGIVER.user_id, PLAN);
    expect(mocks.mealMerges.merge).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: SPLIT_MEAL, split: 'RESPLIT' }));
  });

  it('a part already given is no split: nothing to ask', async () => {
    const { api } = setup({ splitStatus: 'GIVEN' });
    expect((await api.previewMealMerge(CAREGIVER, PATIENT, { meal_ids: [TAB_MEAL, SPLIT_MEAL] }, NOW)).merge).toMatchObject({ ok: true, split: false, meal_id: SPLIT_MEAL }); // the earliest;
  });

  it('refuses two split meals without writing anything', async () => {
    const { api, mocks } = setup({ secondSplit: true });
    const { merge } = await api.previewMealMerge(CAREGIVER, PATIENT, { meal_ids: [CHAT_MEAL, SPLIT_MEAL] }, NOW);
    expect(merge).toMatchObject({ ok: false, code: 'MEAL_MERGE_SEVERAL_SPLIT' });
    await expect(api.mergeMeals(CAREGIVER, PATIENT, { meal_ids: [CHAT_MEAL, SPLIT_MEAL], split: 'RESPLIT' }, NOW)).rejects.toBeInstanceOf(ConflictError);
    expect(mocks.plannedBoluses.skip).not.toHaveBeenCalled();
    expect(mocks.mealMerges.merge).not.toHaveBeenCalled();
  });

  it('refuses meals more than 4 hours apart, also when asked to merge directly', async () => {
    const { api, mocks } = setup({ tabMinutesAgo: 60 + 4 * 60 + 1 });
    const { merge } = await api.previewMealMerge(CAREGIVER, PATIENT, { meal_ids: [TAB_MEAL, CHAT_MEAL] }, NOW);
    expect(merge).toMatchObject({ ok: false, code: 'MEAL_MERGE_TOO_FAR_APART' });
    await expect(api.mergeMeals(CAREGIVER, PATIENT, { meal_ids: [TAB_MEAL, CHAT_MEAL] }, NOW)).rejects.toThrow(/MEAL_MERGE_TOO_FAR_APART: Scalić można tylko posiłki, które zmieszczą się w 4 godzinach/);
    expect(mocks.mealMerges.merge).not.toHaveBeenCalled();
    const { api: within } = setup({ tabMinutesAgo: 60 + 4 * 60 });
    expect((await within.previewMealMerge(CAREGIVER, PATIENT, { meal_ids: [TAB_MEAL, CHAT_MEAL] }, NOW)).merge).toMatchObject({ ok: true });
  });

  it('refuses readers, bad ids, unknown meals and a bad split choice', async () => {
    const { api } = setup();
    await expect(api.mergeMeals(READER, PATIENT, { meal_ids: [TAB_MEAL, CHAT_MEAL] }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(api.mergeMeals(CAREGIVER, PATIENT, { meal_ids: ['x', TAB_MEAL] }, NOW)).rejects.toBeInstanceOf(ValidationError);
    await expect(api.mergeMeals(CAREGIVER, PATIENT, { meal_ids: [TAB_MEAL, '99999999-9999-4999-8999-999999999999'] }, NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(api.mergeMeals(CAREGIVER, PATIENT, { meal_ids: [TAB_MEAL, CHAT_MEAL], split: 'LATER' }, NOW)).rejects.toBeInstanceOf(ValidationError);
    expect((await api.previewMealMerge(CAREGIVER, PATIENT, { meal_ids: [TAB_MEAL, TAB_MEAL] }, NOW)).merge).toMatchObject({ ok: false, code: 'MEAL_MERGE_TOO_FEW' });
  });
});

describe('ApiService "Do posiłku" (meal-attach.v1)', () => {
  function withJournal(options: Parameters<typeof setup>[0] = {}, names = new Map<string, string>([[CHAT_MEAL, 'Obiad z rosołem']])) {
    const built = setup(options);
    const listJournalMealsBetween = vi.fn(async () => [{ meal_record_id: CHAT_MEAL, started_at: ago(60) }, { meal_record_id: SPLIT_MEAL, started_at: ago(90) }]);
    Object.assign((built.api as any).mealJournal, { listJournalMealsBetween, mealShortNames: vi.fn(async () => names) });
    return { ...built, listJournalMealsBetween };
  }

  it('offers the newest bigger meal of the last 3 hours with its short name', async () => {
    const { api, listJournalMealsBetween } = withJournal();
    const { target } = await api.getMealAttachTarget(CAREGIVER, PATIENT, TAB_MEAL, NOW);
    expect(listJournalMealsBetween).toHaveBeenCalledWith(PATIENT, ago(30 + 180), ago(30));
    expect(target).toEqual({ meal_id: CHAT_MEAL, started_at: ago(60), short_name: 'Obiad z rosołem', carbs_g: 45, insulin_total_u: null, split: false });
  });

  it('says whether the dose\'s meal is described, and finds no meal once it was merged away', async () => {
    expect((await withJournal().api.getMealAttachTarget(CAREGIVER, PATIENT, TAB_MEAL, NOW)).described).toBe(false);
    expect((await withJournal({ described: [TAB_MEAL] }).api.getMealAttachTarget(CAREGIVER, PATIENT, TAB_MEAL, NOW)).described).toBe(true);
    // "Posiłek utworzony: …": the AI's short name, else the description.
    expect((await withJournal({ described: [TAB_MEAL] }, new Map([[TAB_MEAL, 'Lody waniliowe']])).api.getMealAttachTarget(CAREGIVER, PATIENT, TAB_MEAL, NOW)).meal_name).toBe('Lody waniliowe');
    expect((await withJournal({ described: [TAB_MEAL] }, new Map()).api.getMealAttachTarget(CAREGIVER, PATIENT, TAB_MEAL, NOW)).meal_name).toBe('Obiad');
    expect((await withJournal().api.getMealAttachTarget(CAREGIVER, PATIENT, TAB_MEAL, NOW)).meal_name).toBeNull();
    const { api } = withJournal();
    (api as any).mealRecordRepository.findMealIdentityById.mockResolvedValue(null);
    await expect(api.getMealAttachTarget(CAREGIVER, PATIENT, TAB_MEAL, NOW)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('gives no name when the AI gave none (the app names the meal by its time)', async () => {
    const { api } = withJournal({}, new Map());
    expect((await api.getMealAttachTarget(CAREGIVER, PATIENT, TAB_MEAL, NOW)).target).toMatchObject({ meal_id: CHAT_MEAL, short_name: null });
  });

  it('offers nothing when joining would reset two descriptions', async () => {
    const { api } = withJournal({ described: [TAB_MEAL, CHAT_MEAL] });
    expect((await api.getMealAttachTarget(CAREGIVER, PATIENT, TAB_MEAL, NOW)).target).toBeNull();
  });

  it('offers nothing when the earlier meals are smaller', async () => {
    const { api } = withJournal({ tabMinutesAgo: 10 });
    (api as any).mealRecordRepository.getMealRecord.mockImplementation(async (_p: string, identity: string) => {
      const id = identity.replace('identity:', '');
      const carbs = id === TAB_MEAL ? 90 : 30;
      return { status: 'AWAITING_DESCRIPTION', started_at: ago(id === TAB_MEAL ? 10 : 60), description: id === CHAT_MEAL ? 'Obiad' : null, source_carbs_g: carbs, has_photo: false, items: null, macros: { carbs: none, protein: none, fat: none }, content_revision: 1 };
    });
    expect((await api.getMealAttachTarget(CAREGIVER, PATIENT, TAB_MEAL, NOW)).target).toBeNull();
  });
});
