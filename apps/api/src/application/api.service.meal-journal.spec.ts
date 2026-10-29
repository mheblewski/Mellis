import { describe, expect, it, vi } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@shared/errors/app-error';
import type { CareReminderRecord } from '@modules/care-reminders/application/care-reminders';
import { ApiService } from './api.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const MEAL = '22222222-2222-4222-8222-222222222222';
const CHAT_MEAL = '33333333-3333-4333-8333-333333333333';
const REMINDER = '44444444-4444-4444-8444-444444444444';
const PLAN = '55555555-5555-4555-8555-555555555555';
const CAREGIVER = { user_id: '66666666-6666-4666-8666-666666666666' } as any;
const READER = { user_id: '77777777-7777-4777-8777-777777777777' } as any;
const NOW = new Date('2026-10-25T17:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const none = { grams: null, origin: null };

function secondDose(overrides: Partial<CareReminderRecord> = {}): CareReminderRecord {
  return {
    id: REMINDER, patient_id: PATIENT, conversation_id: null, user_message_id: 'remote-command:c1', created_by_user_id: CAREGIVER.user_id,
    note: 'Druga dawka · 45 g · 4,5 j o 17:05', trigger: 'GLUCOSE_RISING', due_at: ago(55), threshold_mgdl: null, wait_until: ago(-5),
    status: 'ACTIVE', fired_at: null, fired_reason: null, fired_glucose_mgdl: null, cancelled_at: null, cancelled_by_user_id: null,
    created_at: ago(55), kind: 'SECOND_DOSE', meal_record_id: MEAL, ...overrides,
  };
}

function setup(options: { care?: CareReminderRecord; planStatus?: string } = {}) {
  const repo = {
    getAccessRow: async (userId: string, patientId: string) => {
      if (patientId !== PATIENT) return null;
      if (userId === CAREGIVER.user_id) return { can_read_patient: true, can_write_patient: true };
      if (userId === READER.user_id) return { can_read_patient: true, can_write_patient: false };
      return null;
    },
    insertAuditEvent: async () => {},
    listGlucoseReadingsBetween: vi.fn(async () => [{ at: ago(50), value: 120 }]),
  };
  const api = new ApiService(repo as any, {} as any);
  let care = options.care ?? secondDose();
  const plan = { id: PLAN, meal_record_id: CHAT_MEAL, status: options.planStatus ?? 'SCHEDULED', due_at: ago(-30), kind: 'SPLIT', trigger: 'AFTER_MINUTES', wait_until: null, notified_at: null };
  const records: Record<string, any> = {
    [MEAL]: { status: 'AWAITING_DESCRIPTION', started_at: ago(55), description: null, source_carbs_g: 45, has_photo: false, macros: { carbs: none, protein: none, fat: none }, content_revision: 1 },
    [CHAT_MEAL]: { status: 'CONFIRMED', started_at: ago(200), description: 'Pizza', source_carbs_g: 60, has_photo: false, macros: { carbs: { grams: 60, origin: 'CAREGIVER' }, protein: { grams: 20, origin: 'CAREGIVER' }, fat: { grams: 25, origin: 'CAREGIVER' } }, content_revision: 3 },
  };
  const mocks = {
    mealJournal: {
      listJournalMeals: vi.fn(async (_p: string, _before: string | null, limit: number) => [
        { meal_record_id: MEAL, started_at: ago(55) },
        { meal_record_id: CHAT_MEAL, started_at: ago(200) },
      ].slice(0, limit)),
      searchMeals: vi.fn(async () => [{ meal_record_id: CHAT_MEAL, started_at: ago(200), glucose_peak_mgdl: 210, glucose_min_mgdl: 95 }]),
      mealOrigins: vi.fn(async () => new Map([[MEAL, { first_command_source: 'BOLUS_SCREEN', conversation_id: null }], [CHAT_MEAL, { first_command_source: 'CHAT_CARD', conversation_id: 'conv-1' }]])),
      sendersForActions: vi.fn(async () => new Map([['a1', 'Piotr']])),
      listJournalMealStarts: vi.fn(async () => [ago(200), ago(55)]),
    },
    mealRecordRepository: {
      findMealIdentityById: vi.fn(async (_p: string, id: string) => (records[id] ? `identity:${id}` : null)),
      getMealRecord: vi.fn(async (_p: string, identity: string) => records[identity.replace('identity:', '')]),
    },
    loopActions: {
      listActionsForMeals: vi.fn(async () => [
        { id: 'a1', meal_record_id: MEAL, purpose: 'NEW_MEAL', started_at: ago(55), carbs_g: 45, bolus_units: 4.5, assigned_by: null },
        { id: 'a2', meal_record_id: CHAT_MEAL, purpose: 'NEW_MEAL', started_at: ago(200), carbs_g: 60, bolus_units: 6, assigned_by: 'Ewa' },
      ]),
      listActionsBetween: vi.fn(async () => [
        { id: 'a1', meal_record_id: MEAL, purpose: 'NEW_MEAL', started_at: ago(55), carbs_g: 45, bolus_units: 4.5, assigned_by: null },
        { id: 'o1', meal_record_id: null, purpose: null, started_at: ago(20), carbs_g: null, bolus_units: 1.5, assigned_by: null },
      ]),
    },
    mealWbtRepository: {
      listRemindersForMeals: vi.fn(async () => [{ patient_id: PATIENT, meal_record_id: MEAL, enabled: true, source: 'MANUAL', remind_at: ago(-95), status: 'SCHEDULED', sent_at: null }]),
      setManualReminder: vi.fn(async () => {}),
      getReminder: vi.fn(async () => null as null | { status: string; remind_at: string }),
    },
    careReminderRepository: {
      listForMeals: vi.fn(async () => [care]),
      get: vi.fn(async (_p: string, id: string) => (id === care.id ? care : null)),
      cancel: vi.fn(async () => { care = { ...care, status: 'CANCELLED' }; return care; }),
      reactivate: vi.fn(async () => { if (Date.parse(care.wait_until ?? '') <= NOW.getTime()) return null; care = { ...care, status: 'ACTIVE' }; return care; }),
    },
    plannedBolusRepository: {
      listForMeals: vi.fn(async () => [plan]),
      get: vi.fn(async (_p: string, id: string) => (id === PLAN ? plan : null)),
    },
    plannedBoluses: { skip: vi.fn(async () => { plan.status = 'SKIPPED'; return plan; }) },
    remoteCommandRepository: { confirmedBolusesForActions: vi.fn(async () => new Map()) },
  };
  Object.assign(api as any, mocks);
  return { api, mocks, repo };
}

describe('ApiService meals journal', () => {
  it('lists meals with their reminders, newest first, with the next page', async () => {
    const { api, mocks } = setup();
    const page = await api.getMealJournal(READER, PATIENT, { limit: '1' }, NOW);
    expect(page.next_before).toBe(`${ago(55)}|${MEAL}`);
    await api.getMealJournal(READER, PATIENT, { before: page.next_before!, limit: '1' }, NOW);
    expect(mocks.mealJournal.listJournalMeals).toHaveBeenLastCalledWith(PATIENT, ago(55), 2, null, MEAL);
    expect(page.items).toEqual([{
      meal_id: MEAL, started_at: ago(55), title: null, carbs_g: 45, insulin_total_u: 4.5, source: 'BOLUS_SCREEN', conversation_id: null, has_macros: false,
      reminders: [
        { id: REMINDER, kind: 'SECOND_DOSE', trigger: 'GLUCOSE_RISING', due_at: ago(55), wait_until: ago(-5), status: 'WAITING', enabled: true, fired_at: null },
        { id: 'wbt', kind: 'WBT', trigger: 'AFTER_MINUTES', due_at: ago(-95), wait_until: null, status: 'WAITING', enabled: true, fired_at: null },
      ],
    }]);
    const full = await api.getMealJournal(READER, PATIENT, {}, NOW);
    expect(full.next_before).toBeNull();
    expect(full.items[1]).toMatchObject({ meal_id: CHAT_MEAL, title: 'Pizza', carbs_g: 60, source: 'CHAT', conversation_id: 'conv-1', has_macros: true, reminders: [{ id: PLAN, kind: 'PLANNED_PART', status: 'WAITING' }] });
  });

  it("reads one calendar day and the month's dots", async () => {
    const { api, mocks } = setup();
    await api.getMealJournal(READER, PATIENT, { before: ago(0), after: ago(24 * 60), limit: '50' }, NOW);
    expect(mocks.mealJournal.listJournalMeals).toHaveBeenLastCalledWith(PATIENT, ago(0), 51, ago(24 * 60), null);
    const days = await api.getMealJournalDays(READER, PATIENT, { from: ago(30 * 24 * 60), to: ago(0) });
    expect(days.starts).toEqual([ago(200), ago(55)]);
    await expect(api.getMealJournalDays(READER, PATIENT, { from: ago(90 * 24 * 60), to: ago(0) })).rejects.toThrow(ValidationError);
    await expect(api.getMealJournalDays(READER, PATIENT, { from: ago(0) })).rejects.toThrow(ValidationError);
    await expect(api.getMealJournalDays({ user_id: 'nobody' } as any, PATIENT, { from: ago(60), to: ago(0) })).rejects.toThrow(ForbiddenError);
  });

  it("a cancelled meal's page is not found, and its reminders are not switched", async () => {
    const { api, mocks } = setup();
    const record = await mocks.mealRecordRepository.getMealRecord(PATIENT, `identity:${MEAL}`);
    record.status = 'CANCELLED';
    await expect(api.getMealOverview(READER, PATIENT, MEAL, NOW)).rejects.toThrow(NotFoundError);
    await expect(api.setMealReminderEnabled(CAREGIVER, PATIENT, MEAL, 'wbt', { enabled: false }, NOW)).rejects.toThrow(NotFoundError);
    expect(mocks.mealWbtRepository.setManualReminder).not.toHaveBeenCalled();
  });

  it('refuses a bad page start and strangers', async () => {
    const { api } = setup();
    await expect(api.getMealJournal(READER, PATIENT, { before: 'yesterday' }, NOW)).rejects.toThrow(ValidationError);
    await expect(api.getMealJournal({ user_id: 'nobody' } as any, PATIENT, {}, NOW)).rejects.toThrow(ForbiddenError);
  });

  it('searches descriptions with the glucose after the meal', async () => {
    const { api, mocks } = setup();
    const result = await api.searchMeals(READER, PATIENT, { q: ' pizza ' }, NOW);
    expect(mocks.mealJournal.searchMeals).toHaveBeenCalledWith(PATIENT, '%pizza%', 20);
    expect(result.items).toEqual([expect.objectContaining({ meal_id: CHAT_MEAL, glucose_peak_mgdl: 210, glucose_min_mgdl: 95 })]);
    await expect(api.searchMeals(READER, PATIENT, { q: '' }, NOW)).rejects.toThrow(ValidationError);
  });

  it("the meal's page has its values, glucose, boluses and a time line", async () => {
    const { api } = setup();
    const { overview } = await api.getMealOverview(READER, PATIENT, MEAL, NOW);
    expect(overview).toMatchObject({ meal_id: MEAL, description: null, status: 'AWAITING_DESCRIPTION', trusted: false, content_revision: 1, glucose: [{ at: ago(50), value: 120 }] });
    expect(overview.boluses).toEqual([{ at: ago(55), insulin_u: 4.5, carbs_g: 45, kind: 'MEAL', source: 'GLUCOMIND', author_name: 'Piotr' }]);
    // A bolus on no meal in the chart's window is drawn too, apart from the meal's own.
    expect(overview.other_boluses).toEqual([{ at: ago(20), insulin_u: 1.5, carbs_g: null, kind: 'OTHER', source: 'LOOP', author_name: null }]);
    expect((overview.timeline as Array<{ type: string }>).map((event) => event.type)).toEqual(['BOLUS', 'REMINDER', 'REMINDER']);
  });
});

describe('ApiService switching a meal reminder', () => {
  it('cancels and re-activates a second dose while it can still come', async () => {
    const { api, mocks } = setup();
    const off = await api.setMealReminderEnabled(CAREGIVER, PATIENT, MEAL, REMINDER, { enabled: false }, NOW);
    expect(mocks.careReminderRepository.cancel).toHaveBeenCalledWith(PATIENT, REMINDER, CAREGIVER.user_id);
    expect(off.item.reminders.find((reminder) => reminder.id === REMINDER)).toMatchObject({ status: 'OFF', enabled: false });
    const on = await api.setMealReminderEnabled(CAREGIVER, PATIENT, MEAL, REMINDER, { enabled: true }, NOW);
    expect(on.item.reminders.find((reminder) => reminder.id === REMINDER)).toMatchObject({ status: 'WAITING', enabled: true });
  });

  it('refuses one that already came or lapsed', async () => {
    const { api } = setup({ care: secondDose({ status: 'EXPIRED' }) });
    await expect(api.setMealReminderEnabled(CAREGIVER, PATIENT, MEAL, REMINDER, { enabled: true }, NOW)).rejects.toThrow(ConflictError);
  });

  it('switches the WBT reminder as the caregiver\'s own choice', async () => {
    const { api, mocks } = setup();
    await api.setMealReminderEnabled(CAREGIVER, PATIENT, MEAL, 'wbt', { enabled: false }, NOW);
    expect(mocks.mealWbtRepository.setManualReminder).toHaveBeenCalledWith({ patientId: PATIENT, mealRecordId: MEAL, enabled: false, remindAt: ago(-95), userId: CAREGIVER.user_id });
  });

  it('switches the WBT reminder on until 2.5 h after the meal, not after or once it came', async () => {
    const { api, mocks } = setup();
    await api.setMealReminderEnabled(CAREGIVER, PATIENT, MEAL, 'wbt', { enabled: true }, NOW);
    expect(mocks.mealWbtRepository.setManualReminder).toHaveBeenCalledWith({ patientId: PATIENT, mealRecordId: MEAL, enabled: true, remindAt: ago(-95), userId: CAREGIVER.user_id });
    await expect(api.setMealReminderEnabled(CAREGIVER, PATIENT, CHAT_MEAL, 'wbt', { enabled: true }, NOW)).rejects.toThrow('WBT_REMINDER_PASSED');
    mocks.mealWbtRepository.getReminder.mockResolvedValueOnce({ status: 'SENT', remind_at: ago(-95) });
    await expect(api.setMealReminderEnabled(CAREGIVER, PATIENT, MEAL, 'wbt', { enabled: true }, NOW)).rejects.toThrow('WBT_REMINDER_SETTLED');
    expect(mocks.mealWbtRepository.setManualReminder).toHaveBeenCalledTimes(1);
  });

  it('skips a planned part, which is not planned again', async () => {
    const { api, mocks } = setup();
    await api.setMealReminderEnabled(CAREGIVER, PATIENT, CHAT_MEAL, PLAN, { enabled: false }, NOW);
    expect(mocks.plannedBoluses.skip).toHaveBeenCalledWith(PATIENT, CAREGIVER.user_id, PLAN);
    await expect(api.setMealReminderEnabled(CAREGIVER, PATIENT, CHAT_MEAL, PLAN, { enabled: true }, NOW)).rejects.toThrow(ConflictError);
  });

  it('only writers, only the meal\'s own reminders, only true or false', async () => {
    const { api } = setup();
    await expect(api.setMealReminderEnabled(READER, PATIENT, MEAL, REMINDER, { enabled: false }, NOW)).rejects.toThrow(ForbiddenError);
    await expect(api.setMealReminderEnabled(CAREGIVER, PATIENT, CHAT_MEAL, REMINDER, { enabled: false }, NOW)).rejects.toThrow(NotFoundError);
    await expect(api.setMealReminderEnabled(CAREGIVER, PATIENT, MEAL, 'other', { enabled: false }, NOW)).rejects.toThrow(NotFoundError);
    await expect(api.setMealReminderEnabled(CAREGIVER, PATIENT, MEAL, REMINDER, { enabled: 'no' }, NOW)).rejects.toThrow(ValidationError);
  });
});
