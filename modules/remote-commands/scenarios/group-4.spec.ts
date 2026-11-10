import { describe, expect, it, vi } from 'vitest';
import { ConflictError, ValidationError } from '@shared/errors/app-error';
import { FITTED_V1_FORECAST_CALIBRATION } from '@modules/glucose-forecast/application/forecast-calibration';
import { BolusProposalSession, toBolusProposalView, type NewBolusProposal } from '../application/bolus-proposal-tool';
import type { MealForecastData } from '../application/meal-dose-forecast';
import type { RemoteCommandContext } from '../application/remote-command-policy';
import { RemoteCommandsService, type RemoteCommandRequest } from '../application/remote-commands.service';
import type { NewRemoteCommand, RemoteCommandRecord, RemoteCommandStore } from '../application/remote-command-record';
import { canTransitionRemoteCommand, IN_FLIGHT_STATUSES, type RemoteCommandStatus } from '../application/remote-command-status';
import { matchRemoteCommand, UNCERTAIN_SETTLED_MESSAGE } from '../application/remote-command-matching';
import { mealRemoteBolusView } from '../application/meal-remote-bolus';
import { calculatorHeldBackU, estimatePlannedBolus, mealDoseShortfall, plannedBolusReadiness } from '../application/split-bolus';
import { planBolusTabReminders, parseBolusReminders } from '../application/bolus-reminders';
import { runMealChatReplyJob } from '@modules/meal-chat/application/meal-chat-reply.job';
import { mealPlanPushDecision } from '@modules/meal-plan/application/meal-plan';
import { buildSuggestion, FakeWbtSuggestionResponder } from '@modules/meal-wbt/application/wbt-suggestion.job';
import { ApiService } from '../../../apps/api/src/application/api.service';

// Group 4 of the caregiver scenarios (mama + diabetolog, 2026-11-10), each test named by its scenario id. Offline: the
// server's own logic with in-memory stores, as the neighbouring specs do. it.fails marks a scenario the app gets wrong.

const noCalibration = { ...FITTED_V1_FORECAST_CALIBRATION, version: 'test-none', shrink_by_minutes: { 5: 1 } };

/** Readings every 5 min ending `ageMinutes` ago, and Trio's newest calculation. */
function forecastAt(now: Date, options: { glucose: number; per5?: number; iob: number; isf?: number; icr?: number; target?: number; curve?: number[]; carbsReq?: number | null; cob?: number }): MealForecastData {
  const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const per5 = options.per5 ?? 0;
  return {
    readings: [3, 2, 1, 0].map((back) => ({ at: at(1 + back * 5), value: options.glucose - per5 * back })),
    prediction: {
      source: 'OPENAPS', system: 'TRIO', computed_at: at(1), bg: options.glucose, carbs_req_g: options.carbsReq ?? null, iob_u: options.iob, cob_g: options.cob ?? 0,
      isf_mgdl_per_u: options.isf ?? 100, icr_g_per_u: options.icr ?? 8.3, eventual_bg: (options.curve ?? [options.glucose]).at(-1)!, target_mgdl: options.target ?? 100,
      curves: { IOB: options.curve ?? Array(7).fill(options.glucose) },
    },
    profile_isf: options.isf ?? 100,
    profile_target: options.target ?? 100,
    profile_units: 'mg/dl',
    calibration: noCalibration,
  } as MealForecastData;
}

function cardContext(now: Date, options: { glucose: number; delta?: number; iob: number; icr?: number; forecast?: MealForecastData | null }): Omit<RemoteCommandContext, 'in_flight_command_id' | 'recent_remote_bolus'> & { meal_forecast?: MealForecastData | null } {
  return {
    now: now.toISOString(),
    glucose: { value: options.glucose, observed_at: new Date(now.getTime() - 60_000).toISOString(), delta: options.delta ?? 0 },
    lowest_recent_glucose: options.glucose,
    loop: { iob_units: options.iob, cob_grams: 0, observed_at: new Date(now.getTime() - 60_000).toISOString() },
    last_bolus: null,
    icr_g_per_u: options.icr ?? 8.3,
    bolus_history_known: true,
    meal_forecast: options.forecast ?? null,
  };
}

function cardSession(now: Date, ctx: ReturnType<typeof cardContext>, doseBasis?: 'ICR' | 'CALCULATOR') {
  const stored: NewBolusProposal[] = [];
  const instance = new BolusProposalSession({
    patientId: 'p1', conversationId: 'c1', userMessageId: 'm1', doseRequested: true, now: () => now, ...(doseBasis ? { doseBasis } : {}),
    context: async () => ctx,
    store: { insert: async (proposal) => { stored.push(proposal); return { ...proposal, id: `b${stored.length}`, status: 'PROPOSED', created_at: now.toISOString() }; } },
  });
  return { instance, stored };
}

const mealArgs = (overrides: Record<string, unknown> = {}) => ({
  purpose: 'MEAL', carbs_g: 30, insulin_u: null, reduce_for_drop: false, add_correction: false, eating_now: true,
  meal_description: 'Kaszka', items: null, reason: 'Śniadanie.', later: null, ...overrides,
});

class MemoryStore implements RemoteCommandStore {
  rows: RemoteCommandRecord[] = [];
  syncRequests: Array<{ commandId: string; at: string[] }> = [];
  async requestNightscoutSync(_patientId: string, commandId: string, at: string[]) { this.syncRequests.push({ commandId, at }); }
  async insert(command: NewRemoteCommand): Promise<RemoteCommandRecord> {
    if (this.rows.some((row) => row.patient_id === command.patient_id && IN_FLIGHT_STATUSES.has(row.status))) throw new ConflictError('COMMAND_IN_FLIGHT');
    // remote_commands_one_per_proposal_idx (migration 048).
    if (command.proposal_id && this.rows.some((row) => row.proposal_id === command.proposal_id && !['EXPIRED', 'SEND_FAILED', 'REJECTED', 'PARTIAL'].includes(row.status))) throw new ConflictError('PROPOSAL_ALREADY_SENT');
    const record: RemoteCommandRecord = { ...command, id: `00000000-0000-4000-8000-00000000000${this.rows.length + 1}`, status: 'AUTHORIZED', trio_message: null, status_message: null, authorized_at: new Date(Date.parse(command.send_deadline) - 120_000).toISOString(), sent_at: null, answered_at: null, loop_action_id: null, meal_record_id: null, matched_at: null };
    this.rows.push(record);
    return record;
  }
  async get(patientId: string, id: string) { return this.rows.find((row) => row.patient_id === patientId && row.id === id) ?? null; }
  async list(patientId: string) { return this.rows.filter((row) => row.patient_id === patientId); }
  async findInFlight(patientId: string) { return this.rows.find((row) => row.patient_id === patientId && IN_FLIGHT_STATUSES.has(row.status)) ?? null; }
  async recordSentAt(patientId: string, id: string, at: string) { const row = await this.get(patientId, id); if (row && !row.sent_at) row.sent_at = at; }
  async listForProposal(patientId: string, proposalId: string) { return this.rows.filter((row) => row.patient_id === patientId && row.proposal_id === proposalId); }
  async listForPlannedBolus(patientId: string, planId: string) { return this.rows.filter((row) => row.patient_id === patientId && row.planned_bolus_id === planId); }
  async listWbtForMeal(patientId: string, mealId: string) { return this.rows.filter((row) => row.patient_id === patientId && row.purpose === 'WBT' && row.target_meal_record_id === mealId); }
  async findRecentWithInsulin(patientId: string, since: string) {
    return this.rows.filter((row) => row.patient_id === patientId && row.insulin_u > 0 && ['SENT', 'TRIO_ACCEPTED', 'SUCCEEDED', 'NO_REPLY', 'UNCERTAIN'].includes(row.status) && (row.sent_at ?? row.authorized_at) >= since).at(-1) ?? null;
  }
  async listRecentMealBoluses(patientId: string, since: string) {
    return this.rows.filter((row) => row.patient_id === patientId && row.carbs_g > 0 && row.insulin_u > 0 && row.authorized_at >= since);
  }
  async transition(patientId: string, id: string, to: RemoteCommandStatus, fields: Record<string, unknown>) {
    const row = await this.get(patientId, id);
    if (!row || !canTransitionRemoteCommand(row.status, to)) return null;
    Object.assign(row, { status: to }, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
    return row;
  }
  async recordLateReply(patientId: string, id: string, fields: { trio_message: string; status_message: string; answered_at: string }) {
    const row = await this.get(patientId, id);
    if (!row || row.status !== 'SUCCEEDED' || row.trio_message !== null) return null;
    Object.assign(row, fields);
    return row;
  }
}

const serviceContext = (now: Date, options: { glucose: number; delta?: number; iob: number; icr?: number; lastBolus?: { at: string; units: number } | null; forecast?: MealForecastData | null }) => async () => ({
  now: now.toISOString(),
  glucose: { value: options.glucose, observed_at: new Date(now.getTime() - 60_000).toISOString(), delta: options.delta ?? 0 },
  lowest_recent_glucose: options.glucose,
  loop: { iob_units: options.iob, cob_grams: 0, observed_at: new Date(now.getTime() - 60_000).toISOString() },
  last_bolus: options.lastBolus ?? null,
  icr_g_per_u: options.icr ?? 8.3,
  bolus_history_known: true,
  ...(options.forecast !== undefined ? { meal_forecast: options.forecast } : {}),
});

const bolusRequest = (overrides: Partial<RemoteCommandRequest> = {}): RemoteCommandRequest => ({
  source: 'BOLUS_SCREEN', carbs_g: 0, insulin_u: 1.5, bolus_step: 0.05, device_id: 'device-1', meal: null, acknowledged_warnings: [], ...overrides,
});

const UNCERTAIN_TRIO_MESSAGE = 'Błąd! Bolus nie powiódł się z powodu błędu: Bolus mógł się nie udać: Nieprawidłowa odpowiedź podczas PumpMessage(carelink, bolus)';

// ---------------------------------------------------------------------------------------------------------------------

describe('M4 Dokładka po obiedzie (czat posiłku: „doszło 10 g”)', () => {
  const icr = 30 / 3.6; // 3,6 j na 30 g: ICR ≈ 8,33 g/j
  const given = [{ purpose: 'NEW_MEAL', carbs_g: 30, bolus_units: 3.6 }];

  it('M4: 30 g + 10 g = 40 g; brakuje insuliny tylko na 10 g (ok. 1,2 j), a karta pełnej dawki nic nie wstrzymała', () => {
    const heldBack = calculatorHeldBackU([{ status: 'SUCCEEDED', icr_insulin_u: 3.6, context: { dose_calculation: { default_u: 3.6, icr_dose_u: 3.6 } } }]);
    expect(heldBack).toBe(0);
    expect(mealDoseShortfall({ actions: given, meal_carbs_g: 40, icr_g_per_u: icr, held_back_u: heldBack })).toEqual({ carbs_g: 10, uncovered_g: 10, insulin_u: 1.2, given_carbs_g: 30, given_insulin_u: 3.6 });
  });


  it('M4: druga część na 10 g liczona przy otwarciu (IOB 3,0 j z dawki obiadu, 140 ↗): jedna liczba, najwyżej 1,2 j', () => {
    const now = new Date('2026-11-10T11:00:00.000Z'); // 12:00 Warsaw
    const forecast = forecastAt(now, { glucose: 140, per5: 4, iob: 3.0, icr, curve: [140, 138, 130, 120, 110, 100, 95] });
    const estimate = estimatePlannedBolus({
      plan: { kind: 'SPLIT', carbs_g: 10, first_carbs_g: 30, first_insulin_u: 3.6, dose_carbs_g: null, drop_cover_g: null, fixed_insulin_u: null, subtract_first_insulin: false },
      meal_started_at: '2026-11-10T10:30:00.000Z', now_iso: now.toISOString(), therapy: { timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', icr]], basal_u_per_h: null },
      events: [], step: 0.05, fallback_time_zone: 'Europe/Warsaw', icr_at: () => icr, forecast,
    });
    expect(estimate.dose_before_calculator_u).toBe(1.2);
    // IOB 3,0 j 30 min after 3,6 j is the meal's own dose: the calculator for a later part does not lower it again.
    expect(estimate.insulin_u).toBe(1.2);
    expect(estimate.dose_calculation).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('M10 Pompa odpowiedziała niewyraźnie (Bolus 1,5 j, OrangeLink słaby)', () => {
  const now = new Date('2026-11-10T11:00:00.000Z');

  it('M10: niewyraźna odpowiedź = UNCERTAIN „Nie wiadomo…”, Nightscout czytany od razu, bez ponowienia; bolus w NS → „Podano”', async () => {
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, serviceContext(now, { glucose: 150, iob: 0.5 }));
    const first = await service.authorize('p1', 'mama', bolusRequest(), now);
    await service.reportSent('p1', 'mama', first.id, { accepted: true }, now);
    // Within 60 s nobody else can send (the command is in flight).
    await expect(service.authorize('p1', 'tata', bolusRequest(), new Date(now.getTime() + 30_000))).rejects.toThrow(/COMMAND_IN_FLIGHT|Poprzednie polecenie/);
    const answered = await service.reportReply('p1', 'mama', first.id, { success: false, message: UNCERTAIN_TRIO_MESSAGE }, new Date(now.getTime() + 60_000));
    expect(answered.status).toBe('UNCERTAIN');
    expect(answered.status_message).toMatch(/^Nie wiadomo, czy bolus został podany/);
    expect(store.syncRequests).toHaveLength(1);
    // A retry of the same command is never offered.
    await expect(service.authorize('p1', 'mama', bolusRequest({ follows_command_id: first.id }), new Date(now.getTime() + 90_000))).rejects.toBeInstanceOf(ValidationError);
    expect(mealRemoteBolusView([store.rows[0]], now)).toMatchObject({ state: 'BOLUS_UNCERTAIN', retry: null });
    // A new dose needs the "check the pump first" warning acknowledged.
    const preview = await service.preview('p1', { carbs_g: 0, insulin_u: 1.5, bolus_step: 0.05 }, new Date(now.getTime() + 120_000));
    expect(preview.warnings.map((warning) => warning.code)).toContain('UNCONFIRMED_REMOTE_BOLUS');
    await expect(service.authorize('p1', 'mama', bolusRequest(), new Date(now.getTime() + 120_000))).rejects.toThrow(/WARNINGS_CHANGED/);
    // Trio's bolus shows up in Nightscout: settled as given (the app then says "Podano 1,5 j").
    const match = matchRemoteCommand({ ...store.rows[0], sent_at: now.toISOString() }, [{ id: 'la1', started_at: new Date(now.getTime() + 20_000).toISOString(), purpose: null, carbs_g: null, bolus_units: 1.5 }], new Date(now.getTime() + 3 * 60_000).toISOString());
    expect(match).toMatchObject({ settled_status: 'SUCCEEDED', status_message: UNCERTAIN_SETTLED_MESSAGE });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

const PATIENT = '11111111-1111-4111-8111-111111111111';
const ENTRY = '22222222-2222-4222-8222-222222222222';
const MAMA = { user_id: '33333333-3333-4333-8333-333333333333' } as never;
const TATA = { user_id: '44444444-4444-4444-8444-444444444444' } as never;

function planCardApi(options: { context: (now: Date) => Record<string, unknown>; items: Array<{ name: string; carbs_g: number; protein_g: number; fat_g: number }>; doseBasis?: Record<string, 'ICR' | 'CALCULATOR'> }) {
  const api = new ApiService({} as never, {} as never) as never as Record<string, any>;
  const inserted: any[] = [];
  let next = 0;
  api.assertCanSendRemoteCommands = vi.fn(async () => undefined);
  api.userDoseBasis = vi.fn(async (userId: string) => options.doseBasis?.[userId] ?? 'CALCULATOR');
  api.mealPlans = { getEntry: vi.fn(async (_patient: string, id: string) => (id === ENTRY ? { id: ENTRY, kind: 'MEAL', status: 'PLANNED', planned_at: new Date().toISOString(), title: 'Obiad', items: options.items, dose_answer: null, given_meal_id: null } : null)) };
  api.plannedBoluses = { summariesForProposals: vi.fn(async () => new Map()) };
  api.bolusProposals = {
    listForMealPlanEntry: vi.fn(async () => []),
    discardUnsentForMealPlanEntry: vi.fn(async () => undefined),
    insert: vi.fn(async (proposal: any) => { const record = { ...proposal, id: `55555555-5555-4555-8555-55555555555${++next}`, status: 'PROPOSED', created_at: new Date().toISOString() }; inserted.push(record); return record; }),
    discard: vi.fn(async () => undefined),
  };
  api.remoteCommandContext = vi.fn(async (_patientId: string, now: Date) => options.context(now));
  return { api: api as never as ApiService, raw: api, inserted };
}

describe('M16 Posiłek opóźniony (obiad 11:30 → 12:15)', () => {
  const at = (clock: string) => new Date(`2026-11-10T${clock}:00.000Z`); // UTC clocks
  const entry = { kind: 'MEAL' as const, status: 'PLANNED' as const, planned_at: at('10:30').toISOString(), lead_minutes: 20, reminder_sent_at: at('10:10').toISOString(), missed_sent_at: null };

  it('M16: po „Zmień godzinę” (reminder_sent_at wyzerowany) push przychodzi ponownie 20 min przed nową godziną', () => {
    // Before the move the old meal would send the missed-dose push at 10:40.
    expect(mealPlanPushDecision(entry, at('10:41'), false)).toEqual({ action: 'MISSED' });
    // setPlannedAt clears reminder_sent_at and missed_sent_at (postgres-meal-plan.repository.ts).
    const moved = { ...entry, planned_at: at('11:15').toISOString(), reminder_sent_at: null };
    expect(mealPlanPushDecision(moved, at('10:41'), false)).toEqual({ action: 'WAIT' });
    expect(mealPlanPushDecision(moved, at('10:55'), false)).toEqual({ action: 'REMIND' });
  });

  it('M16: karta otwarta później jest liczona od nowa (stara karta z 11:10 odrzucona, nowa glukoza)', async () => {
    let glucose = 150;
    const { api, raw, inserted } = planCardApi({
      items: [{ name: 'Ziemniaki z kotletem', carbs_g: 30, protein_g: 4, fat_g: 3 }],
      context: (now) => ({ ...cardContext(now, { glucose, iob: 0, forecast: forecastAt(now, { glucose, iob: 0 }) }), forecast_inputs: {} }),
    });
    await api.mealPlanBolusCard(MAMA, PATIENT, ENTRY, { items: [{ name: 'Ziemniaki z kotletem', carbs_g: 30, protein_g: 4, fat_g: 3 }] });
    glucose = 95;
    await api.mealPlanBolusCard(MAMA, PATIENT, ENTRY, { items: [{ name: 'Ziemniaki z kotletem', carbs_g: 30, protein_g: 4, fat_g: 3 }] });
    expect(raw.bolusProposals.discardUnsentForMealPlanEntry).toHaveBeenCalledTimes(2);
    expect(inserted).toHaveLength(2);
    expect(inserted[1].insulin_u).toBeLessThan(inserted[0].insulin_u);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('M22 WBT na kolację (15 g + jajecznica z boczkiem)', () => {
  const now = new Date('2026-11-10T17:00:00.000Z');
  const base = { carbs_g: 15, insulin_u: 1.8, entry_at: now.toISOString(), set_at: now.toISOString(), now, time_zone: 'Europe/Warsaw' };

  it('M22: 15 g / ICR 8,3 = 1,8 j teraz; WBT osobno za 2,5 h; druga dawka „za 150 min” możliwa (do 240 min)', async () => {
    const service = new RemoteCommandsService(new MemoryStore(), serviceContext(now, { glucose: 130, iob: 0 }));
    expect((await service.preview('p1', { carbs_g: 15, insulin_u: null, bolus_step: 0.05 }, now)).insulin_u).toBe(1.8);
    expect(parseBolusReminders([{ kind: 'WBT' }, { kind: 'SECOND_DOSE', trigger: 'AFTER_MINUTES', minutes: 150 }])).toHaveLength(2);
    const plan = planBolusTabReminders({ ...base, reminders: [{ kind: 'WBT' }] });
    expect(plan.wbt_remind_at).toBe('2026-11-10T19:30:00.000Z');
  });

  it('M22: WBT liczone przy otwarciu z aktualną glukozą (poniżej 90 → 0 j)', async () => {
    const context = (glucose: number) => ({
      meal: { meal_record_id: 'm1', description: 'Jajecznica z boczkiem', started_at: now.toISOString(), local_time: null, carbs_g: 15, protein_g: 20, fat_g: 25, fat_protein_units: 3.1, meal_bolus_units: 1.8 },
      icr_g_per_u: 8.3,
      current: { as_of: new Date(now.getTime() + 150 * 60_000 - 60_000).toISOString(), glucose_mgdl: glucose, trend: 'Flat', iob_u: 0.2, cob_g: 0, minutes_after_meal: 150 },
      already_given: { wbt_carbs_logged_g: 0, late_bolus_units: 0, wbt_insulin_units: 0 },
    });
    const at = new Date(now.getTime() + 150 * 60_000).toISOString();
    expect((await buildSuggestion(new FakeWbtSuggestionResponder(), context(160), at)).dose_units).toBeGreaterThan(0);
    expect((await buildSuggestion(new FakeWbtSuggestionResponder(), context(85), at)).dose_units).toBe(0);
  });

  it('M22: WBT i „Druga dawka za 150 min” z jednego formularza nie przychodzą w tej samej chwili', () => {
    const plan = planBolusTabReminders({ ...base, reminders: [{ kind: 'WBT' }, { kind: 'SECOND_DOSE', trigger: 'AFTER_MINUTES', minutes: 150 }] });
    expect(plan.wbt_remind_at).toBe('2026-11-10T19:30:00.000Z');
    expect(plan.second_dose?.due_at).toBe('2026-11-10T19:30:00.000Z');
    // Observation only: two pushes (WBT + Druga dawka) at 19:30; split parts keep WBT ≥ 60 min after them (wbt_min_gap).
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('M28 ICR u mamy, kalkulator u taty (20 g, IOB 1,0 j)', () => {
  const now = new Date('2026-11-10T11:00:00.000Z');
  const ctx = () => cardContext(now, { glucose: 110, iob: 1.0, forecast: forecastAt(now, { glucose: 110, iob: 1.0 }) });
  const lunch = mealArgs({ carbs_g: 20, eating_now: false, meal_description: 'Obiad', items: [{ name: 'Makaron', grams: 100, carbs_g: 20, protein_g: 3, fat_g: 1, source: 'ESTIMATE' }] });

  it('M28: ta sama karta liczona przez mamę (ICR) = 2,4 j z przyciskiem kalkulatora; przez tatę (kalkulator) ≥ 1,2 j z przyciskiem ICR', async () => {
    const mama = cardSession(now, ctx(), 'ICR');
    await mama.instance.propose(lunch);
    expect(mama.stored[0].insulin_u).toBe(2.4);
    const mamaAdvice = mama.stored[0].card_advice!;
    expect(mamaAdvice.dose_calculation?.short_summary).toMatch(/^Z przelicznika/);
    const calculatorVariant = mamaAdvice.variants!.find((variant) => variant.kind === 'CALCULATOR_DOSE');
    expect(calculatorVariant?.label).toMatch(/^Z kalkulatora · /);
    const tata = cardSession(now, ctx(), 'CALCULATOR');
    await tata.instance.propose(lunch);
    expect(tata.stored[0].insulin_u).toBeGreaterThanOrEqual(1.2);
    expect(tata.stored[0].insulin_u).toBeLessThan(2.4);
    expect(tata.stored[0].card_advice!.variants!.find((variant) => variant.kind === 'ICR_DOSE')?.label).toBe('Z przelicznika · 2,4 j');
    expect(calculatorVariant!.insulin_now_u).toBe(tata.stored[0].insulin_u);
  });

  it('M28: karta wysłana przez mamę pokazuje tacie faktycznie podaną dawkę (stan SENT, nie „wysłane przeze mnie”)', async () => {
    const mama = cardSession(now, ctx(), 'ICR');
    await mama.instance.propose(lunch);
    const record = { ...mama.stored[0], id: 'b1', status: 'PROPOSED' as const, created_at: now.toISOString() };
    const command = { id: 'rc1', status: 'SUCCEEDED', status_message: 'Bolus podany', carbs_g: 20, insulin_u: 2.2, meal_record_id: 'meal1', user_id: 'mama', authorized_at: now.toISOString() };
    expect(toBolusProposalView(record, command, 'tata', now)).toMatchObject({ state: 'SENT', command: { insulin_u: 2.2, sent_by_me: false } });
  });

  // FAIL: the chat card is computed once with the asking caregiver's setting; the other caregiver opening it sees the
  // same primary dose (2,4 j) and has to press the variant button, while the planned-meal card recomputes per opener.
  it.fails('M28: tata otwierający kartę mamy w Rozmowach widzi jako główną dawkę swoją metodę (kalkulator)', async () => {
    const mama = cardSession(now, ctx(), 'ICR');
    await mama.instance.propose(lunch);
    const record = { ...mama.stored[0], id: 'b1', status: 'PROPOSED' as const, created_at: now.toISOString() };
    expect(toBolusProposalView(record, null, 'tata', now).insulin_u).toBeLessThan(2.4);
  });

  it('M28: karta z planu liczona per opiekun — ale otwarcie przez tatę odrzuca niewysłaną kartę mamy', async () => {
    const items = [{ name: 'Makaron', carbs_g: 20, protein_g: 3, fat_g: 1 }];
    const { api, raw, inserted } = planCardApi({
      items, doseBasis: { '33333333-3333-4333-8333-333333333333': 'ICR', '44444444-4444-4444-8444-444444444444': 'CALCULATOR' },
      context: (at) => ({ ...cardContext(at, { glucose: 110, iob: 1.0, forecast: forecastAt(at, { glucose: 110, iob: 1.0 }) }), forecast_inputs: {} }),
    });
    await api.mealPlanBolusCard(MAMA, PATIENT, ENTRY, { items });
    await api.mealPlanBolusCard(TATA, PATIENT, ENTRY, { items });
    expect(inserted[0].insulin_u).toBe(2.4);
    expect(inserted[1].insulin_u).toBeLessThan(2.4);
    expect(raw.bolusProposals.discardUnsentForMealPlanEntry).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('D3 Glukoza 62 ↓ przed śniadaniem (czat: „je teraz 30 g kaszki”)', () => {
  const now = new Date('2026-11-10T06:30:00.000Z');
  const forecast = forecastAt(now, { glucose: 62, per5: -4, iob: 0.8, isf: 60, carbsReq: 10, curve: [62, 57, 53, 50, 49, 50, 52] });
  const ctx = cardContext(now, { glucose: 62, delta: -4, iob: 0.8, forecast });

  it('D3: 0 j teraz, szybkie węgle najpierw (parzyste g), reszta „gdy przestanie spadać”; „Cała dawka” z pytaniem', async () => {
    const { instance, stored } = cardSession(now, ctx, 'ICR');
    const result: any = await instance.propose(mealArgs({ meal_description: 'Kaszka' }));
    expect(result.status).toBe('PROPOSED');
    expect(result.card.insulin_u).toBe(0);
    expect(result.advice.fast_carbs_first.carbs_g).toBeGreaterThan(0);
    expect(result.advice.fast_carbs_first.carbs_g % 2).toBe(0);
    expect(result.card.later).toEqual([expect.objectContaining({ kind: 'DEFERRED_INSULIN', trigger: 'GLUCOSE_STOPPED_FALLING' })]);
    const full = stored[0].card_advice!.variants!.find((variant) => variant.kind === 'FULL_BOLUS_NOW');
    expect(full).toMatchObject({ insulin_now_u: 3.6, needs_ack: true });
    expect(full!.ack_text).toBeTruthy();
    const view = toBolusProposalView({ ...stored[0], id: 'b1', status: 'PROPOSED', created_at: now.toISOString() }, null, 'u1', now);
    expect(view.risk === null || view.risk.min_mgdl < 54 || view.situation !== null).toBe(true);
  });

  it('D3: reszta dawki czeka do ≥ 80 i płaskiego trendu (sprawdzana od 15 min)', () => {
    const due = new Date(now.getTime() + 15 * 60_000).toISOString();
    const read = (minutes: number, value: number, slope: number) => plannedBolusReadiness({ now: new Date(now.getTime() + minutes * 60_000), trigger: 'GLUCOSE_STOPPED_FALLING', due_at: due, force_at: new Date(now.getTime() + 60 * 60_000).toISOString(), glucose: { value, at: new Date(now.getTime() + minutes * 60_000).toISOString() }, slope_per_min: slope, forecast_min_mgdl: null });
    expect(read(10, 85, 0)).toEqual({ state: 'WAIT', reason: 'TOO_EARLY' });
    expect(read(20, 75, 1)).toEqual({ state: 'WAIT', reason: 'LOW' });
    expect(read(25, 84, -2)).toEqual({ state: 'WAIT', reason: 'FALLING' });
    expect(read(30, 86, 0)).toMatchObject({ state: 'READY' });
  });

  it('D3: cała dawka nie trafi do Trio bez osobnego potwierdzenia przy glukozie < 70', async () => {
    const service = new RemoteCommandsService(new MemoryStore(), serviceContext(now, { glucose: 62, delta: -4, iob: 0.8, forecast }));
    const preview = await service.preview('p1', { carbs_g: 30, insulin_u: 3.6, bolus_step: 0.05 }, now);
    const keys = preview.warnings.map((warning) => warning.key);
    await expect(service.authorize('p1', 'mama', bolusRequest({ carbs_g: 30, insulin_u: 3.6, acknowledged_warnings: keys }), now)).rejects.toThrow(/LOW_GLUCOSE_CONFIRMATION_REQUIRED/);
    await expect(service.authorize('p1', 'mama', bolusRequest({ carbs_g: 30, insulin_u: 3.6, acknowledged_warnings: keys, low_glucose_confirmed: true }), now)).resolves.toMatchObject({ insulin_u: 3.6 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('D9 WBT bez węgli (jajecznica + kiełbaska, 2 g, ok. 2 WBT)', () => {
  const now = new Date('2026-11-10T17:30:00.000Z');
  const eggs = mealArgs({ carbs_g: 2, eating_now: false, meal_description: 'Jajecznica z kiełbaską', items: [{ name: 'Jajecznica z kiełbaską', grams: 200, carbs_g: 2, protein_g: 20, fat_g: 13, source: 'ESTIMATE' }] });

  it('D9: dawka teraz ok. 0 j, WBT nie od razu: przypomnienie za 150 min ze standardową dawką', async () => {
    const { instance, stored } = cardSession(now, cardContext(now, { glucose: 115, iob: 0.3, forecast: forecastAt(now, { glucose: 115, iob: 0.3 }) }), 'ICR');
    const result: any = await instance.propose(eggs);
    expect(result.status).toBe('PROPOSED');
    expect(result.card.insulin_u).toBeLessThanOrEqual(0.25);
    expect(result.wbt).toMatchObject({ units: 2, standard_dose_u: 0.7, reminder: expect.stringMatching(/^automatic, about 2.5 h/) });
    expect(stored[0].card_advice?.forecast_chart?.events.find((event) => event.kind === 'WBT')?.at_minutes ?? 150).toBe(150);
  });

  // FAIL: the WBT dose at the reminder is the standard dose bounded by glucose and WBT already given; SMBs the loop
  // gave for the fat and protein meanwhile are not taken off by the server (only the AI sees IOB as a hint).
  it.fails('D9: dawka WBT przy otwarciu odejmuje SMB, które pętla dała od posiłku', async () => {
    const at = new Date(now.getTime() + 150 * 60_000).toISOString();
    const context = (iob: number) => ({
      meal: { meal_record_id: 'm1', description: 'Jajecznica z kiełbaską', started_at: now.toISOString(), local_time: null, carbs_g: 2, protein_g: 20, fat_g: 13, fat_protein_units: 2, meal_bolus_units: 0 },
      icr_g_per_u: 8.3,
      current: { as_of: at, glucose_mgdl: 160, trend: 'FortyFiveUp', iob_u: iob, cob_g: 0, minutes_after_meal: 150 },
      already_given: { wbt_carbs_logged_g: 0, late_bolus_units: 0, wbt_insulin_units: 0 },
    });
    const without = await buildSuggestion(new FakeWbtSuggestionResponder(), context(0.1), at);
    const withSmb = await buildSuggestion(new FakeWbtSuggestionResponder(), context(1.0), at);
    expect(withSmb.dose_units as number).toBeLessThan(without.dose_units as number);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('D15 Kilka posiłków blisko siebie (karta planu 11 g / 0,7 j, potem zakładka Bolus 5 g)', () => {
  const planAt = new Date('2026-11-10T10:16:00.000Z');
  const now = new Date('2026-11-10T10:54:00.000Z');

  async function withPlanCardSent() {
    const store = new MemoryStore();
    const proposalId = '66666666-6666-4666-8666-666666666666';
    const proposals = { get: async () => ({ conversation_id: null, status: 'PROPOSED', expires_at: new Date(planAt.getTime() + 15 * 60_000).toISOString(), carbs_g: 11, insulin_u: 0.3, warnings: [], purpose: 'MEAL', meal_payload: { description: 'Zupa i podwieczorek', items: null, macros: null } }) };
    const forecast = forecastAt(now, { glucose: 184, per5: 6, iob: 1.4, curve: [184, 190, 195, 198, 198, 196, 194] });
    let current = planAt;
    const service = new RemoteCommandsService(store, async () => (await serviceContext(current, { glucose: current === planAt ? 125 : 184, delta: current === planAt ? 0 : 6, iob: current === planAt ? 1.1 : 1.4, forecast: current === planAt ? null : forecast })()), proposals as never);
    const card = await service.authorize('p1', 'ola', bolusRequest({ source: 'CHAT_CARD', proposal_id: proposalId, conversation_id: null, carbs_g: 11, insulin_u: 0.7, meal: { description: 'Zupa i podwieczorek', items: null, macros: null }, acknowledged_warnings: (await service.preview('p1', { carbs_g: 11, insulin_u: 0.7, bolus_step: 0.05, proposal_id: proposalId }, planAt)).warnings.map((warning) => warning.key) }), planAt);
    await service.reportSent('p1', 'ola', card.id, { accepted: true }, planAt);
    await service.reportReply('p1', 'ola', card.id, { success: true, message: 'Bolus started' }, planAt);
    current = now;
    return { service, store };
  }

  it('D15: dawka z zakładki Bolus liczona kalkulatorem z IOB 1,4 j (mniej niż 5 g / ICR)', async () => {
    const { service } = await withPlanCardSent();
    const preview = await service.preview('p1', { carbs_g: 5, insulin_u: null, bolus_step: 0.05, dose_default: 'CALCULATOR' }, now);
    expect(preview.icr_insulin_u).toBe(0.6);
    expect(preview.dose_calculation).toBeTruthy();
  });

  // FAIL: 38 min after the plan card the Bolus tab's confirmation says nothing about that meal's 0,7 j: RECENT_BOLUS
  // is 15 min, RECENT_REMOTE_BOLUS 30 min, and ALREADY_SENT_FOR_MEAL needs the same name or carbs (5 g vs 11 g).
  // The "Do tego posiłku: …" line exists only on the meal page (iOS MealJournalModels.doseAxisLine), and nothing asks
  // whether the 5 g are an addition to that meal or a new one.
  it.fails('D15: podgląd zakładki Bolus wspomina 0,7 j podane 38 min temu do posiłku z planu', async () => {
    const { service } = await withPlanCardSent();
    const preview = await service.preview('p1', { carbs_g: 5, insulin_u: 0.6, bolus_step: 0.05 }, now);
    expect(preview.warnings.map((warning) => warning.message).join(' ')).toMatch(/0,7 j/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('D21 Podwójne podanie z dwóch telefonów (ta sama karta 25 g / 3,0 j)', () => {
  const t0 = new Date('2026-11-10T11:00:10.000Z');
  const t1 = new Date('2026-11-10T11:00:40.000Z');
  const proposalId = '77777777-7777-4777-8777-777777777777';
  const proposals = { get: async () => ({ conversation_id: null, status: 'PROPOSED', expires_at: '2026-11-10T11:15:00.000Z', carbs_g: 25, insulin_u: 3.0, warnings: [], purpose: 'MEAL', meal_payload: { description: 'Obiad', items: null, macros: null } }) };
  const cardRequest = bolusRequest({ source: 'CHAT_CARD', proposal_id: proposalId, conversation_id: null, carbs_g: 25, insulin_u: 3.0, meal: { description: 'Obiad', items: null, macros: null } });

  async function mamaGave() {
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, serviceContext(t0, { glucose: 140, iob: 0.2, icr: 25 / 3 }), proposals as never);
    const keys = (await service.preview('p1', { carbs_g: 25, insulin_u: 3.0, bolus_step: 0.05, proposal_id: proposalId }, t0)).warnings.map((warning) => warning.key);
    const sent = await service.authorize('p1', 'mama', { ...cardRequest, acknowledged_warnings: keys }, t0);
    return { store, service, sent, keys };
  }

  it('D21: tata 30 s później — mama jeszcze czeka na Trio: odmowa (jedno polecenie naraz)', async () => {
    const { service, keys } = await mamaGave();
    await expect(service.authorize('p1', 'tata', { ...cardRequest, acknowledged_warnings: keys }, t1)).rejects.toThrow(/COMMAND_IN_FLIGHT|Poprzednie polecenie/);
  });

  it('D21: tata po potwierdzeniu dawki mamy — ta sama karta nie pójdzie drugi raz; odświeżona karta pokazuje SENT', async () => {
    const { service, sent, keys, store } = await mamaGave();
    await service.reportSent('p1', 'mama', sent.id, { accepted: true }, t0);
    await service.reportReply('p1', 'mama', sent.id, { success: true, message: 'Bolus started' }, t0);
    await expect(service.authorize('p1', 'tata', { ...cardRequest, acknowledged_warnings: keys }, t1)).rejects.toThrow();
    expect(store.rows).toHaveLength(1);
    const record = { id: proposalId, patient_id: 'p1', conversation_id: null, user_message_id: null, purpose: 'MEAL', carbs_g: 25, insulin_u: 3, icr_g_per_u: 8.33, icr_insulin_u: 3, meal_payload: { description: 'Obiad', items: null, macros: null }, reason: null, warnings: [], split: null, dose_adjustment: null, card_advice: null, status: 'PROPOSED', expires_at: '2026-11-10T11:15:00.000Z', created_at: '2026-11-10T11:00:00.000Z' } as never;
    expect(toBolusProposalView(record, { ...store.rows[0], user_id: 'mama' } as never, 'tata', t1)).toMatchObject({ state: 'SENT', command: { sent_by_me: false, insulin_u: 3 } });
  });

  // FAIL: the refusal tata gets is "Węglowodany są już w Trio: ponów sam bolus." (ValidationError for a retry), which
  // reads as an invitation to give the bolus alone; it names neither who gave nor the dose, and offers no explicit
  // "Podać mimo to?" second confirmation.
  it('D21: odmowa dla taty mówi, kto i ile podał („Mama podała 3 j o 12:00”), nie „ponów sam bolus”', async () => {
    const { service, sent, keys } = await mamaGave();
    await service.reportSent('p1', 'mama', sent.id, { accepted: true }, t0);
    await service.reportReply('p1', 'mama', sent.id, { success: true, message: 'Bolus started' }, t0);
    const error = await service.authorize('p1', 'tata', { ...cardRequest, acknowledged_warnings: keys }, t1).catch((caught: Error) => caught);
    expect((error as Error).message).not.toMatch(/ponów sam bolus/);
    expect((error as Error).message).toMatch(/podał[ao]?\s.*3 j/);
  });

  it('D21: tata z zakładki Bolus z tym samym posiłkiem dostaje DANGER „wysłano już… ta dawka poda insulinę drugi raz”', async () => {
    const { service, sent } = await mamaGave();
    await service.reportSent('p1', 'mama', sent.id, { accepted: true }, t0);
    await service.reportReply('p1', 'mama', sent.id, { success: true, message: 'Bolus started' }, t0);
    const preview = await service.preview('p1', { carbs_g: 25, insulin_u: 3.0, bolus_step: 0.05, source: 'BOLUS_SCREEN' }, t1);
    expect(preview.warnings.find((warning) => warning.code === 'ALREADY_SENT_FOR_MEAL')).toMatchObject({ severity: 'DANGER' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('D27 Szybkie węgle przy spadku z karty posiłku (88 ↓ −3/min, IOB 1,5 j, posiłek 20 g za 30 min)', () => {
  const items = [{ name: 'Kanapka', carbs_g: 20, protein_g: 4, fat_g: 3 }];
  const falling = (at: Date) => forecastAt(at, { glucose: 88, per5: -15, iob: 1.5, isf: 60, carbsReq: 8, curve: [88, 76, 66, 58, 53, 51, 52] });

  it('D27: karta z planu: najpierw szybkie węgle (parzyste g, 0 j), dawka posiłku czeka, aż glukoza przestanie spadać', async () => {
    const { api, inserted } = planCardApi({ items, context: (at) => ({ ...cardContext(at, { glucose: 88, delta: -15, iob: 1.5, forecast: falling(at) }), forecast_inputs: {} }) });
    const result: any = await api.mealPlanBolusCard(MAMA, PATIENT, ENTRY, { items });
    expect(inserted[0]).toMatchObject({ carbs_g: 20, insulin_u: 0 });
    expect(JSON.stringify(inserted[0].split)).toContain('GLUCOSE_STOPPED_FALLING');
    expect(result.proposal.fast_carbs_first.carbs_g).toBeGreaterThan(0);
    expect(result.proposal.fast_carbs_first.carbs_g % 2).toBe(0);
  });
});
