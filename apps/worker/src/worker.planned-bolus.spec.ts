import { describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service';
import { PlannedBolusService } from '@modules/remote-commands/application/planned-bolus.service';
import type { PlannedBolusRecord } from '@modules/remote-commands/application/split-bolus';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const MEAL = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-10-20T13:31:00.000Z';

function plan(overrides: Partial<PlannedBolusRecord> = {}): PlannedBolusRecord {
  return {
    id: 'plan-1', kind: 'SPLIT', patient_id: PATIENT, meal_record_id: MEAL, proposal_id: 'b1', conversation_id: 'c1', first_command_id: 'cmd-1',
    first_carbs_g: 36, first_insulin_u: 3.6, carbs_g: 24, planned_insulin_u: 2.4, icr_g_per_u: 10, now_percent: 60, delay_minutes: 90,
    due_at: '2026-10-20T13:30:00.000Z', status: 'SCHEDULED', notified_at: null, resolved_at: null, resolved_by_user_id: null, resolved_by_name: null,
    given_command_id: null, given_loop_action_id: null, given_insulin_u: null, created_at: '2026-10-20T12:00:30.000Z', ...overrides,
  };
}

function setup(options: { plans: PlannedBolusRecord[]; actions?: Array<Record<string, unknown>>; glucose?: number; glucoseAt?: string; mealStatus?: string; readings?: Array<{ at: string; value: number }> }) {
  const repository = {
    getTherapyProfileAt: vi.fn().mockResolvedValue({ status: 'KNOWN', timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', 8]], basal_u_per_h: [['00:00', 0.6]] }),
    listInsulinDeliveryEventsByRange: vi.fn().mockResolvedValue([{ event_id: 's1', type: 'SMB', occurred_at: '2026-10-20T12:30:00.000Z', payload: { insulin_units: 0.4 } }]),
    getPumpBolusIncrement: vi.fn().mockResolvedValue(0.05),
    getCurrentState: vi.fn().mockResolvedValue({ glucose: { value: options.glucose ?? 160 } }),
    listActivePatientDevices: vi.fn().mockResolvedValue([{ push_token: 'token-piotr' }, { push_token: 'token-ewa' }]),
    deactivatePatientDevicesByPushToken: vi.fn(),
  } as any;
  const pushNotificationService = { sendPlannedBolusReminder: vi.fn().mockResolvedValue(undefined) } as any;
  const worker = new WorkerService(
    repository,
    { ensureNightscoutSource: vi.fn(), prepareNightscoutSources: vi.fn().mockResolvedValue({ seed: null, sources: 1 }), enqueueRecurringSyncJobs: vi.fn(), runNightscoutSyncJob: vi.fn(), runHypoDetectionJob: vi.fn() } as any,
    { getOrThrow: vi.fn().mockReturnValue('test') } as any,
    {} as any,
    pushNotificationService,
  );
  const store = {
    listOpen: vi.fn().mockResolvedValue(options.plans),
    markNotified: vi.fn().mockResolvedValue(true),
    resolve: vi.fn().mockImplementation(async (_p: string, id: string, to: string) => ({ ...plan({ id }), status: to, resolved_at: NOW })),
  } as any;
  const postponed: string[] = [];
  const internals = worker as any;
  internals.plannedBolusRepository = store;
  internals.plannedBolusService = new PlannedBolusService({
    store,
    commands: { latestForPlannedBolus: vi.fn().mockResolvedValue(null) },
    postponeWbtReminder: async (_p, _m, at) => { postponed.push(at); },
  });
  internals.mealRecordRepository = {
    findMealIdentityById: vi.fn().mockResolvedValue('identity-1'),
    getMealRecord: vi.fn().mockResolvedValue({ status: options.mealStatus ?? 'CORRECTED', started_at: '2026-10-20T12:00:00.000Z', description: 'Burger wołowy z frytkami (300 g)' }),
  };
  internals.loopActionRepository = { listActionsForMeals: vi.fn().mockResolvedValue(options.actions ?? []) };
  internals.bolusDashboardRepository = {
    // The newest reading from the fake: the given glucose 2 min before the call (stale readings are filtered by the SQL).
    listGlucoseReadingsSince: vi.fn().mockImplementation(async (_patient: string, sinceIso: string) => options.readings
      ?? (options.glucose !== undefined && options.glucoseAt !== undefined && options.glucoseAt < sinceIso ? [] : [{ at: options.glucoseAt ?? new Date(Date.parse(NOW) - 2 * 60_000).toISOString(), value: options.glucose ?? 160 }])),
    getLatestLoopStatus: vi.fn().mockResolvedValue(null),
  };
  return { worker, store, pushNotificationService, postponed };
}

describe('WorkerService planned second parts of split boluses', () => {
  it('sends a due part once to every phone with the dose now (deferred carbs / ICR now minus the loop extra)', async () => {
    const { worker, store, pushNotificationService } = setup({ plans: [plan()] });
    await worker.processPlannedBoluses(NOW);
    expect(store.markNotified).toHaveBeenCalledWith(PATIENT, 'plan-1');
    expect(pushNotificationService.sendPlannedBolusReminder).toHaveBeenCalledTimes(2);
    // 24 g / ICR 8 = 3 U, minus 0.4 U of SMB since the meal.
    expect(pushNotificationService.sendPlannedBolusReminder).toHaveBeenCalledWith({
      patientId: PATIENT, pushToken: 'token-ewa', mealId: MEAL, plannedBolusId: 'plan-1',
      title: 'Druga część bolusa', body: 'Burger wołowy z frytkami: 24 g, ok. 2,6 j\nKliknij, aby sprawdzić dawkę',
    });
  });

  it('warns in the push when glucose is low, and sends nothing before the due time or a second time', async () => {
    const low = setup({ plans: [plan()], glucose: 82 });
    await low.worker.processPlannedBoluses(NOW);
    expect(low.pushNotificationService.sendPlannedBolusReminder.mock.calls[0][0].body).toContain('Glukoza 82 mg/dL: sprawdź, zanim podasz');
    // A reading from before a CGM gap is not quoted as glucose now.
    const stale = setup({ plans: [plan()], glucose: 82, glucoseAt: '2026-10-20T11:30:00.000Z' });
    await stale.worker.processPlannedBoluses(NOW);
    expect(stale.pushNotificationService.sendPlannedBolusReminder.mock.calls[0][0].body).not.toContain('Glukoza 82');

    const early = setup({ plans: [plan()] });
    await early.worker.processPlannedBoluses('2026-10-20T13:29:00.000Z');
    expect(early.pushNotificationService.sendPlannedBolusReminder).not.toHaveBeenCalled();

    const notified = setup({ plans: [plan({ status: 'NOTIFIED' })] });
    await notified.worker.processPlannedBoluses(NOW);
    expect(notified.store.markNotified).not.toHaveBeenCalled();
  });

  it('settles a part given by hand (a bolus assigned to the meal as an addition near the due time) and moves the WBT reminder', async () => {
    const { worker, store, pushNotificationService, postponed } = setup({
      plans: [plan()],
      actions: [
        // An addition long before the due time (a dessert) does not count.
        { id: 'la-dessert', purpose: 'MEAL_ADDITION', bolus_units: 0.5, started_at: '2026-10-20T12:20:00.000Z' },
        { id: 'la-part', purpose: 'MEAL_ADDITION', bolus_units: 2.5, started_at: '2026-10-20T13:25:00.000Z' },
      ],
    });
    await worker.processPlannedBoluses(NOW);
    expect(store.resolve).toHaveBeenCalledWith(PATIENT, 'plan-1', 'GIVEN', { user_id: null, loop_action_id: 'la-part', insulin_u: 2.5 });
    expect(pushNotificationService.sendPlannedBolusReminder).not.toHaveBeenCalled();
    expect(postponed).toEqual(['2026-10-20T14:31:00.000Z']);
  });

  it('a bolus that came with carbs (a dessert added to the meal) never settles the part (audit 2026-10-26)', async () => {
    const { worker, store, pushNotificationService } = setup({
      plans: [plan()],
      actions: [{ id: 'la-dessert', purpose: 'MEAL_ADDITION', bolus_units: 2, carbs_g: 20, started_at: '2026-10-20T13:20:00.000Z' }],
    });
    await worker.processPlannedBoluses(NOW);
    expect(store.resolve).not.toHaveBeenCalledWith(PATIENT, 'plan-1', 'GIVEN', expect.anything());
    expect(pushNotificationService.sendPlannedBolusReminder).toHaveBeenCalledTimes(2);
  });

  it('expires a part nobody gave within 2 h of its time and cancels the part of a cancelled meal', async () => {
    const late = setup({ plans: [plan({ status: 'NOTIFIED' })] });
    await late.worker.processPlannedBoluses('2026-10-20T15:31:00.000Z');
    expect(late.store.resolve).toHaveBeenCalledWith(PATIENT, 'plan-1', 'EXPIRED');

    const cancelled = setup({ plans: [plan()], mealStatus: 'CANCELLED' });
    await cancelled.worker.processPlannedBoluses(NOW);
    expect(cancelled.store.resolve).toHaveBeenCalledWith(PATIENT, 'plan-1', 'CANCELLED');
    expect(cancelled.pushNotificationService.sendPlannedBolusReminder).not.toHaveBeenCalled();
  });
});

describe('WorkerService deferred meal boluses (deferred-bolus.v1)', () => {
  // The meal (16 g, sent to Trio at 12:00 with no insulin) waits for its whole dose.
  const deferred = (overrides: Partial<PlannedBolusRecord> = {}) => plan({
    kind: 'DEFERRED_INSULIN', first_carbs_g: 16, first_insulin_u: 0, carbs_g: 0, planned_insulin_u: 2, now_percent: 100, delay_minutes: 15,
    due_at: '2026-10-20T12:15:00.000Z', ...overrides,
  });
  const readings = (end: string, ...values: number[]) => values.map((value, index) => ({
    at: new Date(Date.parse(end) - (values.length - 1 - index) * 5 * 60_000).toISOString(), value,
  }));

  it('waits while glucose is still falling, even past 15 min', async () => {
    const { worker, store, pushNotificationService } = setup({ plans: [deferred()], readings: readings('2026-10-20T12:20:00.000Z', 120, 108, 96, 86) });
    await worker.processPlannedBoluses('2026-10-20T12:20:30.000Z');
    expect(store.markNotified).not.toHaveBeenCalled();
    expect(pushNotificationService.sendPlannedBolusReminder).not.toHaveBeenCalled();
  });

  it('reminds once glucose has stopped falling, with the dose for the whole meal now (16 g / 8; the 12:30 SMB comes later)', async () => {
    const { worker, store, pushNotificationService } = setup({ plans: [deferred()], readings: readings('2026-10-20T12:25:00.000Z', 92, 95, 99, 104), glucose: 104 });
    await worker.processPlannedBoluses('2026-10-20T12:25:30.000Z');
    expect(store.markNotified).toHaveBeenCalledWith(PATIENT, 'plan-1');
    expect(pushNotificationService.sendPlannedBolusReminder).toHaveBeenCalledWith({
      patientId: PATIENT, pushToken: 'token-piotr', mealId: MEAL, plannedBolusId: 'plan-1',
      title: 'Bolus na posiłek', body: 'Burger wołowy z frytkami: ok. 2 j na 16 g\nGlukoza 104 mg/dL przestała spadać: sprawdź dawkę i podaj',
    });
  });

  it('reminds anyway 60 min after the meal, saying glucose still falls (16 g / 8 − 0,4 j SMB)', async () => {
    const { worker, pushNotificationService } = setup({ plans: [deferred()], readings: readings('2026-10-20T13:01:00.000Z', 110, 100, 92, 85) });
    await worker.processPlannedBoluses('2026-10-20T13:01:30.000Z');
    expect(pushNotificationService.sendPlannedBolusReminder.mock.calls[0][0].body).toBe('Burger wołowy z frytkami: ok. 1,6 j na 16 g\nGlukoza 85 mg/dL nadal spada: sprawdź glukozę, zanim podasz');
  });
});
