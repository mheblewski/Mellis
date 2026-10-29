import { describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';
import type { CareReminderRecord } from '@modules/care-reminders/application/care-reminders';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const MEAL = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-10-25T16:30:00.000Z';
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

function reminder(overrides: Partial<CareReminderRecord> = {}): CareReminderRecord {
  return {
    id: 'r1', patient_id: PATIENT, conversation_id: null, user_message_id: 'remote-command:c1', created_by_user_id: 'u1',
    note: 'Druga dawka · 45 g · 4,5 j o 18:05', trigger: 'GLUCOSE_RISING', due_at: ago(5), threshold_mgdl: null, wait_until: ago(-55),
    status: 'ACTIVE', fired_at: null, fired_reason: null, fired_glucose_mgdl: null, cancelled_at: null, cancelled_by_user_id: null,
    created_at: ago(5), kind: 'SECOND_DOSE', meal_record_id: MEAL, ...overrides,
  };
}

function setup(reminders: CareReminderRecord[], readings: Array<{ at: string; value: number; direction?: string | null }>) {
  const repository = {
    listActivePatientDevices: vi.fn().mockResolvedValue([{ push_token: 'token-1' }]),
    deactivatePatientDevicesByPushToken: vi.fn(),
  } as any;
  const pushNotificationService = { sendCareReminder: vi.fn().mockResolvedValue(undefined), sendWbtReminder: vi.fn().mockResolvedValue(undefined) } as any;
  const worker = new WorkerService(
    repository,
    { ensureNightscoutSource: vi.fn(), prepareNightscoutSources: vi.fn().mockResolvedValue({ seed: null, sources: 1 }), enqueueRecurringSyncJobs: vi.fn(), runNightscoutSyncJob: vi.fn(), runHypoDetectionJob: vi.fn() } as any,
    { getOrThrow: vi.fn().mockReturnValue('test') } as any,
    {} as any,
    pushNotificationService,
  );
  const store = {
    listActive: vi.fn().mockResolvedValue(reminders),
    markFired: vi.fn().mockResolvedValue(true),
    markExpired: vi.fn().mockResolvedValue(true),
  };
  const dashboards = {
    listGlucoseReadingsSince: vi.fn().mockResolvedValue(readings.map((reading) => ({ direction: null, ...reading }))),
    getLatestLoopStatus: vi.fn().mockResolvedValue(null),
  };
  Object.assign(worker as any, { careReminderRepository: store, bolusDashboardRepository: dashboards });
  return { worker, store, pushNotificationService, dashboards };
}

describe('WorkerService second doses of Bolus tab meals', () => {
  it('pushes once glucose rises, with the glucose and a route to the meal', async () => {
    const { worker, store, pushNotificationService } = setup([reminder()], [{ at: ago(10), value: 120 }, { at: ago(5), value: 130 }, { at: ago(0), value: 141, direction: 'SingleUp' }]);
    await worker.processCareReminders(NOW);
    expect(store.markFired).toHaveBeenCalledWith(PATIENT, 'r1', 'READY', 141);
    expect(pushNotificationService.sendCareReminder).toHaveBeenCalledWith({
      patientId: PATIENT, pushToken: 'token-1', conversationId: null, mealId: MEAL, reminderId: 'r1',
      title: 'Druga dawka · 45 g · 4,5 j o 18:05', body: 'Glukoza 141 ↑. Dotknij, aby podać.',
    });
  });

  it('waits while glucose does not rise, then lapses quietly', async () => {
    const flat = [{ at: ago(10), value: 120 }, { at: ago(5), value: 120 }, { at: ago(0), value: 120 }];
    const waiting = setup([reminder()], flat);
    await waiting.worker.processCareReminders(NOW);
    expect(waiting.store.markFired).not.toHaveBeenCalled();
    expect(waiting.store.markExpired).not.toHaveBeenCalled();

    const lapsed = setup([reminder({ wait_until: ago(1) })], flat);
    await lapsed.worker.processCareReminders(NOW);
    expect(lapsed.store.markExpired).toHaveBeenCalledWith(PATIENT, 'r1');
    expect(lapsed.pushNotificationService.sendCareReminder).not.toHaveBeenCalled();
  });

  it('a timed second dose comes at its time, without glucose when there is no fresh reading', async () => {
    const { worker, pushNotificationService } = setup([reminder({ trigger: 'AT_TIME', wait_until: null, due_at: ago(0) })], []);
    await worker.processCareReminders(NOW);
    expect(pushNotificationService.sendCareReminder).toHaveBeenCalledWith(expect.objectContaining({ mealId: MEAL, body: 'Dotknij, aby podać.' }));
  });

  it("leaves the chat's own reminders as they were (title, no meal)", async () => {
    const { worker, pushNotificationService, dashboards } = setup([reminder({ kind: null, meal_record_id: null, conversation_id: 'conv-1', note: 'Zmiana wkłucia', trigger: 'AT_TIME', wait_until: null })], []);
    await worker.processCareReminders(NOW);
    expect(dashboards.listGlucoseReadingsSince).not.toHaveBeenCalled();
    expect(pushNotificationService.sendCareReminder).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-1', mealId: null, title: 'Przypomnienie', body: 'Zmiana wkłucia' }));
  });
});

describe('WorkerService WBT reminder of a meal without macros', () => {
  it('asks to describe the meal or give the dose by hand', async () => {
    const { worker, pushNotificationService } = setup([], []);
    const wbt = {
      skipStaleReminders: vi.fn(),
      listDueReminders: vi.fn().mockResolvedValue([{ patient_id: PATIENT, meal_record_id: MEAL, enabled: true, source: 'MANUAL', remind_at: ago(1), status: 'SCHEDULED', sent_at: null }]),
      markReminder: vi.fn().mockResolvedValue(true),
    };
    const none = { grams: null, origin: null };
    Object.assign(worker as any, {
      mealWbtRepository: wbt,
      mealRecordRepository: {
        findMealIdentityById: vi.fn().mockResolvedValue('identity-1'),
        getMealRecord: vi.fn().mockResolvedValue({ status: 'AWAITING_DESCRIPTION', started_at: ago(150), description: null, macros: { carbs: none, protein: none, fat: none } }),
      },
      mealWbtAlreadyLogged: vi.fn().mockResolvedValue(false),
      plannedBolusRepository: { latestForMeal: vi.fn().mockResolvedValue(null) },
    });
    await worker.dispatchDueWbtReminders(NOW);
    expect(pushNotificationService.sendWbtReminder).toHaveBeenCalledWith({ patientId: PATIENT, pushToken: 'token-1', mealId: MEAL, body: 'Opisz posiłek, a policzę dawkę, albo podaj ją sam.' });
  });
});

describe('WorkerService WBT reminder behind an open later part (audit 2026-10-26)', () => {
  it('stays due while the part is open, so a worker restart never drops it as stale', async () => {
    const { worker, pushNotificationService } = setup([], []);
    const wbt = {
      skipStaleReminders: vi.fn().mockResolvedValue(0),
      listDueReminders: vi.fn().mockResolvedValue([{ patient_id: PATIENT, meal_record_id: MEAL, enabled: true, source: 'AUTO', remind_at: ago(100), status: 'SCHEDULED', sent_at: null }]),
      markReminder: vi.fn().mockResolvedValue(true),
      postponeReminder: vi.fn().mockResolvedValue(undefined),
    };
    const some = { grams: 30, origin: 'CAREGIVER' };
    Object.assign(worker as any, {
      mealWbtRepository: wbt,
      mealRecordRepository: {
        findMealIdentityById: vi.fn().mockResolvedValue('identity-1'),
        getMealRecord: vi.fn().mockResolvedValue({ status: 'DESCRIBED', started_at: ago(250), description: 'Pizza', macros: { carbs: some, protein: some, fat: some } }),
      },
      mealWbtAlreadyLogged: vi.fn().mockResolvedValue(false),
      plannedBolusRepository: { latestForMeal: vi.fn().mockResolvedValue({ status: 'SCHEDULED' }) },
    });
    await worker.dispatchDueWbtReminders(NOW);
    expect(wbt.postponeReminder).toHaveBeenCalledWith(PATIENT, MEAL, NOW);
    expect(wbt.markReminder).not.toHaveBeenCalled();
    expect(pushNotificationService.sendWbtReminder).not.toHaveBeenCalled();
  });
});

describe('WorkerService loop-action step isolation (audit 2026-10-26)', () => {
  it("one patient's grouping error stops neither the other patients nor the reminders", async () => {
    const { worker } = setup([], []);
    const groupNewEvents = vi.fn(async (patientId: string) => {
      if (patientId === 'broken') throw new Error('bad row');
      return 0;
    });
    const internals = worker as any;
    internals.loopActionRepository = { listPatientsWithEpoch: vi.fn().mockResolvedValue(['broken', PATIENT]), groupNewEvents };
    const planned = vi.spyOn(internals, 'processPlannedBoluses').mockResolvedValue(undefined);
    const care = vi.spyOn(internals, 'processCareReminders').mockRejectedValue(new Error('unexpected'));
    const news = vi.spyOn(internals, 'processReminderDoseNews').mockResolvedValue(undefined);
    await worker.processLoopActions(NOW);
    expect(groupNewEvents).toHaveBeenCalledWith(PATIENT);
    expect(planned).toHaveBeenCalled();
    expect(care).toHaveBeenCalled();
    // A step that throws does not skip the ones after it.
    expect(news).toHaveBeenCalled();
  });
});

describe('WorkerService telling the other caregivers a reminder\'s dose was given', () => {
  function newsSetup(kind: 'SECOND_DOSE' | 'WBT', senderUserId: string | null) {
    const { worker, pushNotificationService } = setup([], []);
    const repository = (worker as any).repository;
    repository.listActivePatientDevices.mockResolvedValue([
      { push_token: 'ewa-phone', user_id: 'u-ewa' },
      { push_token: 'piotr-phone', user_id: 'u-piotr' },
      { push_token: 'old-phone', user_id: null },
    ]);
    repository.pool = {};
    pushNotificationService.sendDoseGiven = vi.fn().mockResolvedValue(undefined);
    const journal = {
      remindersAwaitingDoseNews: vi.fn().mockResolvedValue([{ kind, reminder_id: kind === 'WBT' ? 'wbt' : 'r1', patient_id: PATIENT, meal_record_id: MEAL, fired_at: ago(30), until: null }]),
      commandSendersForActions: vi.fn().mockResolvedValue(new Map(senderUserId ? [['a2', { user_id: senderUserId, name: 'Ewa' }], ['a3', { user_id: senderUserId, name: 'Ewa' }]] : [])),
      markDoseGiven: vi.fn().mockResolvedValue(true),
    };
    const loopActions = {
      listActionsBetween: vi.fn().mockResolvedValue([
        { id: 'a1', started_at: ago(40), bolus_units: 4.5, purpose: 'NEW_MEAL', meal_record_id: MEAL, carbs_g: 45 },
        // Another meal's bolus inside the window: never the reminder's dose.
        { id: 'a3', started_at: ago(20), bolus_units: 5, purpose: 'NEW_MEAL', meal_record_id: 'other-meal', carbs_g: 50 },
        { id: 'a2', started_at: ago(10), bolus_units: 1.5, purpose: null, meal_record_id: null, carbs_g: null },
      ]),
    };
    const meals = {
      findMealIdentityById: vi.fn().mockResolvedValue('identity'),
      getMealRecord: vi.fn().mockResolvedValue({ started_at: '2026-10-25T16:05:00.000Z' }),
    };
    Object.assign(worker as any, { mealJournalRepository: journal, loopActionRepository: loopActions, mealRecordRepository: meals });
    return { worker, pushNotificationService, journal };
  }

  it('pushes the dose to the other caregivers only, once', async () => {
    const { worker, pushNotificationService, journal } = newsSetup('SECOND_DOSE', 'u-ewa');
    await worker.processReminderDoseNews(NOW);
    expect(journal.markDoseGiven).toHaveBeenCalledTimes(1);
    // The dose's loop action is kept: it answers no other reminder (migration 082).
    expect(journal.markDoseGiven).toHaveBeenCalledWith(expect.objectContaining({ kind: 'SECOND_DOSE' }), ago(10), 'a2');
    expect(pushNotificationService.sendDoseGiven).toHaveBeenCalledTimes(1);
    expect(pushNotificationService.sendDoseGiven).toHaveBeenCalledWith({
      patientId: PATIENT, pushToken: 'piotr-phone', mealId: MEAL, reminderKey: 'r1',
      title: 'Druga dawka podana', body: 'Opiekun Ewa podał drugą dawkę (1,5 j) na posiłek o 17:05',
    });
  });

  it('says WBT for a WBT reminder, and nothing for a dose entered in Trio', async () => {
    const wbt = newsSetup('WBT', 'u-ewa');
    await wbt.worker.processReminderDoseNews(NOW);
    expect(wbt.pushNotificationService.sendDoseGiven).toHaveBeenCalledWith(expect.objectContaining({ title: 'WBT podane', body: 'Opiekun Ewa podał 1,5 j na WBT po posiłku o 17:05', reminderKey: `wbt:${MEAL}` }));

    const trio = newsSetup('SECOND_DOSE', null);
    await trio.worker.processReminderDoseNews(NOW);
    expect(trio.journal.markDoseGiven).not.toHaveBeenCalled();
    expect(trio.pushNotificationService.sendDoseGiven).not.toHaveBeenCalled();
  });
});

describe('WorkerService reminders that come late or were already given (audit 2026-10-26)', () => {
  it('a chat reminder at a time more than 2 h late is missed: no push, the bell says so', async () => {
    const { worker, store, pushNotificationService } = setup([reminder({ kind: null, meal_record_id: null, conversation_id: 'conv-1', note: 'Zmiana wkłucia', trigger: 'AT_TIME', wait_until: null, due_at: ago(121) })], []);
    Object.assign(store, { markMissed: vi.fn().mockResolvedValue(true) });
    pushNotificationService.recordMissedCareReminder = vi.fn().mockResolvedValue(undefined);
    await worker.processCareReminders(NOW);
    expect((store as any).markMissed).toHaveBeenCalledWith(PATIENT, 'r1');
    expect(pushNotificationService.recordMissedCareReminder).toHaveBeenCalledWith({ patientId: PATIENT, conversationId: 'conv-1', mealId: null, reminderId: 'r1', note: 'Zmiana wkłucia' });
    expect(pushNotificationService.sendCareReminder).not.toHaveBeenCalled();

    // Within 2 h it still comes; a deleted conversation is not opened.
    const late = setup([reminder({ kind: null, meal_record_id: null, conversation_id: 'conv-1', conversation_deleted: true, note: 'Zmiana wkłucia', trigger: 'AT_TIME', wait_until: null, due_at: ago(110) })], []);
    await late.worker.processCareReminders(NOW);
    expect(late.pushNotificationService.sendCareReminder).toHaveBeenCalledWith(expect.objectContaining({ conversationId: null, body: 'Zmiana wkłucia' }));
  });

  it('a second dose given before its reminder came is settled without a push', async () => {
    const { worker, store, pushNotificationService } = setup([reminder({ trigger: 'AT_TIME', wait_until: null, due_at: ago(0), created_at: ago(60) })], []);
    Object.assign(store, { markGivenBeforeDue: vi.fn().mockResolvedValue(true) });
    (worker as any).loopActionRepository = {
      listActionsForMeals: vi.fn().mockResolvedValue([{ id: 'add-1', started_at: ago(20), purpose: 'MEAL_ADDITION', meal_record_id: MEAL, bolus_units: 1.5, carbs_g: null }]),
    };
    await worker.processCareReminders(NOW);
    expect((store as any).markGivenBeforeDue).toHaveBeenCalledWith(PATIENT, 'r1', ago(20), 'add-1');
    expect(store.markFired).not.toHaveBeenCalled();
    expect(pushNotificationService.sendCareReminder).not.toHaveBeenCalled();
  });

  it('the second dose\'s title is made at send time from what the meal\'s bolus delivered', async () => {
    const { worker, pushNotificationService } = setup([reminder({ trigger: 'AT_TIME', wait_until: null, due_at: ago(0) })], []);
    Object.assign(worker as any, {
      loopActionRepository: { listActionsForMeals: vi.fn().mockResolvedValue([{ id: 'meal-1', started_at: ago(150), purpose: 'NEW_MEAL', meal_record_id: MEAL, bolus_units: null, carbs_g: 45 }]) },
      mealRecordRepository: { findMealIdentityById: vi.fn().mockResolvedValue('identity-1'), getMealRecord: vi.fn().mockResolvedValue({ started_at: ago(150), macros: { carbs: { grams: 35 } } }) },
    });
    await worker.processCareReminders(NOW);
    expect(pushNotificationService.sendCareReminder).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Druga dawka · 35 g o 15:00',
      body: 'Posiłek zmieniony: 45→35 g. Bolus do posiłku nie został podany. Sprawdź, zanim podasz.',
    }));
  });

  it('a WBT reminder waits while the meal\'s second dose is still to come, and half an hour after it came', async () => {
    const run = async (secondDose: Partial<CareReminderRecord>) => {
      const { worker, pushNotificationService } = setup([], []);
      const wbt = {
        skipStaleReminders: vi.fn().mockResolvedValue(0),
        listDueReminders: vi.fn().mockResolvedValue([{ patient_id: PATIENT, meal_record_id: MEAL, enabled: true, source: 'MANUAL', remind_at: ago(1), status: 'SCHEDULED', sent_at: null }]),
        markReminder: vi.fn().mockResolvedValue(true),
        postponeReminder: vi.fn().mockResolvedValue(undefined),
      };
      const some = { grams: 30, origin: 'CAREGIVER' };
      Object.assign(worker as any, {
        mealWbtRepository: wbt,
        mealRecordRepository: { findMealIdentityById: vi.fn().mockResolvedValue('identity-1'), getMealRecord: vi.fn().mockResolvedValue({ status: 'DESCRIBED', started_at: ago(150), description: 'Pizza', macros: { carbs: some, protein: some, fat: some } }) },
        mealWbtAlreadyLogged: vi.fn().mockResolvedValue(false),
        plannedBolusRepository: { latestForMeal: vi.fn().mockResolvedValue(null) },
        careReminderRepository: { listForMeals: vi.fn().mockResolvedValue([reminder(secondDose)]) },
      });
      await worker.dispatchDueWbtReminders(NOW);
      return { wbt, pushNotificationService };
    };
    const open = await run({ status: 'ACTIVE' });
    expect(open.wbt.postponeReminder).toHaveBeenCalledWith(PATIENT, MEAL, NOW);
    expect(open.pushNotificationService.sendWbtReminder).not.toHaveBeenCalled();
    const came = await run({ status: 'FIRED', fired_at: ago(10) });
    expect(came.wbt.postponeReminder).toHaveBeenCalledWith(PATIENT, MEAL, ago(-20));
    const long = await run({ status: 'FIRED', fired_at: ago(45) });
    expect(long.pushNotificationService.sendWbtReminder).toHaveBeenCalled();
  });
});
