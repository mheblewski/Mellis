/**
 * Scenarios group 6 (mother of a child with T1D and an AID diabetologist, 2026-11-10): giving insulin for meals,
 * checked against the real server logic (no mocks of the dose code: only the stores and the data the server reads).
 * A test marked it.fails shows a gap in the app (the file passes while the gap is there).
 */
import { describe, expect, it } from 'vitest';
import { GLUCOSE_FORECAST_CALIBRATION } from '@modules/glucose-forecast/application/forecast-calibration';
import { scheduleValueAt } from '@modules/meal-wbt/application/wbt-policy';
import { mealPlanMovementDecision, mealPlanMovementContent } from '@modules/meal-plan/application/meal-plan';
import { withoutDoseHere } from '@modules/meal-chat/application/meal-chat-reply.job';
import { FakeMealChatResponder } from '@modules/meal-chat/application/meal-chat-responder';
import { BolusProposalSession, restLaterArgs, type NewBolusProposal } from '../application/bolus-proposal-tool';
import { computeDoseCalculation } from '../application/dose-calculator';
import type { MealForecastData } from '../application/meal-dose-forecast';
import type { RemoteCommandContext } from '../application/remote-command-policy';
import type { NewRemoteCommand, RemoteCommandRecord, RemoteCommandStore } from '../application/remote-command-record';
import { RemoteCommandsService, type RemoteCommandRequest } from '../application/remote-commands.service';
import { PlannedBolusService, type PlannedBolusStore } from '../application/planned-bolus.service';
import {
  calculatorHeldBackU,
  estimatePlannedBolus,
  mealDoseExcess,
  mealDoseShortfall,
  mealExcessLine,
  plannedBolusPushContent,
  plannedBolusReadiness,
  type PlannedBolusRecord,
} from '../application/split-bolus';
import { IN_FLIGHT_STATUSES } from '../application/remote-command-status';

// 11:30 in Warsaw (UTC+1 in November).
const now = new Date('2026-11-10T10:30:00.000Z');
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const minutesLater = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
/** Read without calibration so the numbers stay with the curve (as the card specs do). */
const noCalibration = { ...GLUCOSE_FORECAST_CALIBRATION, version: 'test-none', shrink_by_minutes: { 5: 1 } };
const LABELS = /WYSOKO|NISKO|HIGH|LOW\b/;

/** Readings every 5 min ending 1 min ago, and Trio's calculation (no curve unless given: v1 arithmetic plus the floor). */
function forecast(options: { glucose: number; per5?: number; iob: number; isf?: number; target?: number; loopTarget?: number; curve?: number[]; cob?: number; at?: Date }): MealForecastData {
  const at = options.at ?? now;
  const ago = (minutes: number) => new Date(at.getTime() - minutes * 60_000).toISOString();
  const per5 = options.per5 ?? 0;
  return {
    readings: [3, 2, 1, 0].map((back) => ({ at: ago(1 + back * 5), value: options.glucose - per5 * back })),
    prediction: {
      source: 'OPENAPS', system: 'TRIO', computed_at: ago(1), bg: options.glucose, carbs_req_g: null, iob_u: options.iob, cob_g: options.cob ?? 0,
      isf_mgdl_per_u: options.isf ?? 100, icr_g_per_u: 8.33, eventual_bg: options.curve?.at(-1) ?? options.glucose,
      target_mgdl: options.loopTarget ?? options.target ?? 100,
      curves: options.curve ? { IOB: options.curve } : {},
    },
    profile_isf: options.isf ?? 100,
    profile_target: options.target ?? 100,
    profile_units: 'mg/dl',
    calibration: noCalibration,
  };
}

const cardContext = (data: MealForecastData, overrides: Partial<RemoteCommandContext> = {}) => ({
  now: now.toISOString(),
  glucose: { value: data.readings.at(-1)!.value, observed_at: data.readings.at(-1)!.at, delta: data.readings.at(-1)!.value - data.readings.at(-2)!.value },
  lowest_recent_glucose: Math.min(...data.readings.map((reading) => reading.value)),
  loop: { iob_units: data.prediction!.iob_u, cob_grams: 0, observed_at: data.prediction!.computed_at },
  last_bolus: null,
  icr_g_per_u: 8.33,
  bolus_history_known: true,
  meal_forecast: data,
  ...overrides,
});

function cardSession(data: MealForecastData, options: { doseBasis?: 'ICR' | 'CALCULATOR'; context?: Partial<RemoteCommandContext> } = {}) {
  const stored: NewBolusProposal[] = [];
  const instance = new BolusProposalSession({
    patientId: 'p1', conversationId: 'c1', userMessageId: 'm1', doseRequested: true, now: () => now,
    ...(options.doseBasis ? { doseBasis: options.doseBasis } : {}),
    context: async () => cardContext(data, options.context) as never,
    store: { insert: async (proposal) => { stored.push(proposal); return { ...proposal, id: `b${stored.length}`, status: 'PROPOSED', created_at: now.toISOString() }; } },
  });
  return { instance, stored };
}

const mealArgs = (carbs: number, description: string, items: unknown[] | null = null, extra: Record<string, unknown> = {}) => ({
  purpose: 'MEAL', carbs_g: carbs, insulin_u: null, reduce_for_drop: false, add_correction: false, eating_now: false,
  meal_description: description, items, reason: description, later: null, ...extra,
});

class MemoryCommandStore implements RemoteCommandStore {
  rows: RemoteCommandRecord[] = [];
  async requestNightscoutSync() {}
  async insert(command: NewRemoteCommand): Promise<RemoteCommandRecord> {
    const record: RemoteCommandRecord = { ...command, id: `00000000-0000-4000-8000-00000000000${this.rows.length + 1}`, status: 'AUTHORIZED', trio_message: null, status_message: null, authorized_at: now.toISOString(), sent_at: null, answered_at: null, loop_action_id: null, meal_record_id: null, matched_at: null };
    this.rows.push(record);
    return record;
  }
  async get(patientId: string, id: string) { return this.rows.find((row) => row.patient_id === patientId && row.id === id) ?? null; }
  async list(patientId: string) { return this.rows.filter((row) => row.patient_id === patientId); }
  async findInFlight(patientId: string) { return this.rows.find((row) => row.patient_id === patientId && IN_FLIGHT_STATUSES.has(row.status)) ?? null; }
  async recordSentAt() {}
  async listForProposal(_patientId: string, proposalId: string) { return this.rows.filter((row) => row.proposal_id === proposalId); }
  async listForPlannedBolus(_patientId: string, planId: string) { return this.rows.filter((row) => row.planned_bolus_id === planId); }
  async listWbtForMeal() { return []; }
  async latestForPlannedBolus(_patientId: string, planId: string) { return this.rows.filter((row) => row.planned_bolus_id === planId).at(-1) ?? null; }
  async findRecentWithInsulin() { return null; }
  async transition() { return null; }
  async recordLateReply() { return null; }
}

function planRecord(overrides: Partial<PlannedBolusRecord> = {}): PlannedBolusRecord {
  return {
    id: 'plan-1', patient_id: 'p1', meal_record_id: 'meal-1', proposal_id: 'b1', conversation_id: 'c1',
    first_command_id: 'cmd-1', first_carbs_g: 0, first_insulin_u: 0, carbs_g: 0, planned_insulin_u: 0, icr_g_per_u: 8.33, now_percent: 100, delay_minutes: 0,
    due_at: now.toISOString(), status: 'SCHEDULED', notified_at: null, resolved_at: null, resolved_by_user_id: null, resolved_by_name: null,
    given_command_id: null, given_loop_action_id: null, given_insulin_u: null, created_at: now.toISOString(),
    trigger: null, threshold_mgdl: null, dose_carbs_g: null, fixed_insulin_u: null, drop_cover_g: null, subtract_first_insulin: false, wait_until: null, ...overrides,
  } as PlannedBolusRecord;
}

class MemoryPlanStore implements PlannedBolusStore {
  rows: PlannedBolusRecord[] = [];
  async create(input: Parameters<PlannedBolusStore['create']>[0]) {
    const record = planRecord({ ...input, id: `plan-${this.rows.length + 1}`, status: 'SCHEDULED' } as Partial<PlannedBolusRecord>);
    this.rows.push(record);
    return record;
  }
  async get(_patientId: string, id: string) { return this.rows.find((row) => row.id === id) ?? null; }
  async latestForMeal(_patientId: string, mealId: string) { return this.rows.filter((row) => row.meal_record_id === mealId).at(-1) ?? null; }
  async listForProposals() { return new Map(); }
  async listOpen() { return this.rows; }
  async markNotified() { return true; }
  async resolve() { return null; }
}

const therapy = (icr: Array<[string, number]>) => ({ timezone: 'Europe/Warsaw', carb_ratio_g_per_u: icr, basal_u_per_h: [['00:00', 0.3]] as Array<[string, number]> });

describe('Scenariusze grupy 6: insulina do posiłku', () => {
  it('M6 — wysoko przed jedzeniem: tryb ICR daje 3,6 j na 30 g bez własnej korekty, kalkulator nie podnosi, korekta tylko na prośbę', async () => {
    // 240 ↗ (+4 / 5 min), IOB 0,4 j, ISF 100, cel 100, obiad 30 g, ICR 8,33.
    const high = forecast({ glucose: 240, per5: 4, iob: 0.4, curve: [240, 244, 246, 246, 244, 240, 236] });
    const byIcr = cardSession(high, { doseBasis: 'ICR' });
    const result: any = await byIcr.instance.propose(mealArgs(30, 'Obiad'));
    expect(result).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 30, insulin_u: 3.6, dose_from_icr: 3.6 } });
    // The correction is offered to the model, never put on the card by itself.
    expect(result.advice.correction).toMatchObject({ on_this_card: false });
    expect(result.advice.correction.dose_u).toBeGreaterThan(0.9);
    // No glucose state labels on the card.
    expect(JSON.stringify(byIcr.stored[0].warnings)).not.toMatch(LABELS);
    expect(byIcr.stored[0].card_advice!.dose_calculation!.short_summary ?? '').not.toMatch(LABELS);
    // Calculator mode: lowering only, so also 3,6 j.
    const calc: any = await cardSession(high, { doseBasis: 'CALCULATOR' }).instance.propose(mealArgs(30, 'Obiad'));
    expect(calc.card.insulin_u).toBe(3.6);
    // "Dodaj korektę" (add_correction): carbs + (glucose − target) / ISF − IOB, with the warning that Trio adds insulin itself.
    const withCorrection: any = await cardSession(high, { doseBasis: 'ICR' }).instance.propose(mealArgs(30, 'Obiad', null, { add_correction: true }));
    expect(withCorrection.card.insulin_u).toBeGreaterThan(4.5);
    expect(withCorrection.advice.correction).toMatchObject({ on_this_card: true });
    // The Bolus tab's opt-in higher dose (dose-calculator.v2): half the correction, at most +1 j, never the default.
    const tab = computeDoseCalculation({ now, carbs_g: 30, icr_g_per_u: 8.33, step: 0.05, data: high, iob_floor: true, opt_in: { recent_doses: [], recent_carbs: { last_at: null }, recent_guard: { last_at: null } } });
    expect(tab.default_u).toBe(3.6);
    expect(tab.higher_u).toBeGreaterThan(3.6);
    expect(tab.higher_u!).toBeLessThanOrEqual(4.6);
  });

  it('M12 — pizza (tłusta, duża): plan polecany dzieli posiłek, druga część przeliczana przy otwarciu z SMB i spadkiem', async () => {
    const pizza = [{ name: 'Pizza, 2 kawałki', grams: 230, carbs_g: 50, protein_g: 22, fat_g: 26, source: 'ESTIMATE' }];
    const steady = forecast({ glucose: 120, iob: 0.1 });
    const { instance, stored } = cardSession(steady, { doseBasis: 'ICR' });
    const result: any = await instance.propose(mealArgs(50, 'Pizza 2 kawałki', pizza, { use_advised_split: 'ADVISED' }));
    expect(result.status).toBe('PROPOSED');
    expect(result.split_advice).toMatchObject({ advised: true, on_this_card: true });
    expect(result.split_advice.now_percent).toBeGreaterThanOrEqual(50);
    expect(result.split_advice.now_percent).toBeLessThanOrEqual(70);
    expect(result.split_advice.after_minutes).toBeGreaterThanOrEqual(90);
    expect(result.split_advice.after_minutes).toBeLessThanOrEqual(120);
    const split = stored[0].split!;
    expect(split).toMatchObject({ kind: 'SPLIT', total_carbs_g: 50 });
    expect(stored[0].carbs_g + split.later_carbs_g).toBe(50);
    // The plan made from the sent command: the second part when due.
    const plans = new MemoryPlanStore();
    const command = { id: 'cmd-1', patient_id: 'p1', proposal_id: 'b1', conversation_id: 'c1', carbs_g: stored[0].carbs_g, insulin_u: stored[0].insulin_u, icr_g_per_u: 8.33, split_plan: split, meal_payload: null } as unknown as RemoteCommandRecord;
    const part = (await new PlannedBolusService({ store: plans, commands: new MemoryCommandStore() }).createForMeal(command, 'meal-1', now.toISOString()))!;
    expect(part).toMatchObject({ kind: 'SPLIT', carbs_g: split.later_carbs_g, delay_minutes: split.later_after_minutes });
    const due = new Date(Date.parse(part.due_at));
    const plain = estimatePlannedBolus({ plan: part, meal_started_at: now.toISOString(), now_iso: due.toISOString(), therapy: therapy([['00:00', 8.33]]), events: [], step: 0.05, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt });
    // With 0,6 j of SMB since the meal the part gives less.
    const smb = estimatePlannedBolus({ plan: part, meal_started_at: now.toISOString(), now_iso: due.toISOString(), therapy: therapy([['00:00', 8.33]]), events: [{ type: 'SMB', occurred_at: minutesLater(45), payload: { insulin_units: 0.6 } }] as never, step: 0.05, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt });
    expect(smb.insulin_u!).toBeLessThan(plain.insulin_u!);
    expect(smb.loop_extra_u).toBeCloseTo(0.6, 5);
    // Glucose falling when the part is opened: the calculator lowers it further (never raises it).
    const falling = forecast({ glucose: 105, per5: -6, iob: 1.2, at: due, curve: [105, 97, 90, 84, 79, 75, 72] });
    const lowered = estimatePlannedBolus({ plan: part, meal_started_at: now.toISOString(), now_iso: due.toISOString(), therapy: therapy([['00:00', 8.33]]), events: [], step: 0.05, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt, forecast: falling });
    expect(lowered.insulin_u!).toBeLessThan(plain.insulin_u!);
    expect(lowered.dose_before_calculator_u).toBe(plain.insulin_u);
    // A timed part's push still comes at its time; it carries no units (the card works the dose out when opened).
    const readiness = plannedBolusReadiness({ now: due, trigger: 'AFTER_MINUTES', due_at: part.due_at, force_at: null, glucose: { value: 105, at: due.toISOString() }, slope_per_min: -1.2, forecast_min_mgdl: 72 });
    expect(readiness.state).toBe('READY');
    const push = plannedBolusPushContent({ description: 'Pizza 2 kawałki', carbs_g: part.carbs_g, estimate_u: lowered.insulin_u, low_glucose: null, readiness });
    expect(push.title).toBe(`Druga część bolusa · ${part.carbs_g} g`);
    expect(push.body).not.toMatch(/\d\s*j\b/);
  });

  describe('M18 — ręczna zmiana dawki na karcie (0,3 → 0,7 j, jak Ewa 10.11)', () => {
    it('M18 — dawka zmieniona ręcznie: przeliczona prognoza, kontrola bezpieczeństwa, zapis kalkulatora przy poleceniu, czat posiłku bez „brakuje”', async () => {
      const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
      const data = forecast({ glucose: 127, iob: 1.15 });
      const forecastInputs = { readings: [16, 11, 6, 1].map((minutes) => ({ at: at(minutes), value: 127 })), prediction: null, profile_isf: 100, profile_units: 'mg/dL', dia_hours: 6 };
      const store = new MemoryCommandStore();
      const service = new RemoteCommandsService(store, async () => ({ ...cardContext(data), icr_g_per_u: 8.3, last_bolus: null, forecast_inputs: forecastInputs }) as never);
      const advised = await service.preview('p1', { carbs_g: 11, insulin_u: null, bolus_step: 0.05, dose_default: 'CALCULATOR' }, now);
      expect(advised.insulin_u).toBeLessThan(1.3);
      const manual = await service.preview('p1', { carbs_g: 11, insulin_u: 0.7, bolus_step: 0.05 }, now);
      // The chart is drawn again for 0,7 j: more insulin, lower line end.
      expect(manual.forecast?.insulin_u).toBe(0.7);
      expect(manual.forecast!.total_with_dose!).toBeLessThan(advised.forecast!.total_with_dose!);
      // 0,7 j is not dangerously above the data: no acknowledgement needed. 3 j would be (safety limit).
      expect(manual.warnings.filter((warning) => warning.severity === 'DANGER')).toEqual([]);
      const tooMuch = await service.preview('p1', { carbs_g: 11, insulin_u: 3, bolus_step: 0.05 }, now);
      expect(tooMuch.warnings.some((warning) => warning.severity === 'DANGER')).toBe(true);
      const request: RemoteCommandRequest = { source: 'BOLUS_SCREEN', carbs_g: 11, insulin_u: 0.7, bolus_step: 0.05, device_id: 'd1', meal: { description: 'Zupa i podwieczorek', items: null, macros: null }, acknowledged_warnings: manual.warnings.map((warning) => warning.key) };
      const sent = await service.authorize('p1', 'u-mama', request, now);
      // The history keeps the dose given and the calculator's own dose next to it.
      expect(sent.insulin_u).toBe(0.7);
      expect(store.rows[0].context.dose_calculation!.default_u).toBe(advised.insulin_u);
      expect(store.rows[0].icr_insulin_u).toBe(1.3);
      // Meal chat: what the calculator held back is no shortfall, and nothing else is missing for 11 g.
      const heldBack = calculatorHeldBackU([{ ...store.rows[0], status: 'SUCCEEDED' }]);
      expect(mealDoseShortfall({ actions: [{ purpose: 'NEW_MEAL', carbs_g: 11, bolus_units: 0.7 }], meal_carbs_g: 11, icr_g_per_u: 8.3, held_back_u: heldBack })).toBeNull();
    });

    // BUG: the rest of a lowered dose ("reszta zmniejszonej dawki") is planned for the grams the card's own dose left
    // uncovered (rest_carbs_g = carbs − card dose × ICR) and never takes off the card's dose again. When the caregiver
    // raises the dose on the card before sending, the rest part still doses the grams of the card's lower dose: the
    // meal gets more than carbs / ICR (here 46 g / 12 = 3,8 j planned, 3 j + 1,5 j = 4,5 j given).
    // Files: modules/remote-commands/application/bolus-proposal-tool.ts (restLaterArgs: dose_carbs_g: offer.rest_carbs_g),
    // split-bolus.ts (dosesCardCarbs false for dose_carbs_g ≠ card carbs → subtract_card_insulin false),
    // planned-bolus.service.ts createForMeal (first_insulin_u kept, never used for that part).
    it('M18 — reszta dawki po ręcznym podniesieniu dawki na karcie odejmuje to, co faktycznie podano', async () => {
      // IOB 1,5 j, glucose falling: the card gives less than 46 / 12 = 3,8 j and offers the rest.
      const falling = forecast({ glucose: 110, per5: -4, iob: 1.5, isf: 60, curve: [110, 102, 94, 86, 78, 72, 70] });
      const { instance, stored } = cardSession(falling, { doseBasis: 'CALCULATOR', context: { icr_g_per_u: 12 } });
      await instance.propose(mealArgs(46, 'Naleśniki z serem'));
      const card = stored[0];
      expect(card.card_advice!.rest_offer).toBeTruthy();
      await instance.propose(restLaterArgs(card as never, { trigger: 'AFTER_MINUTES', minutes: 45 })!);
      const withRest = stored[1];
      expect(withRest.split).toBeTruthy();
      // The caregiver changes the card's dose to 3 j and sends it with the rest plan.
      const commands = new MemoryCommandStore();
      const service = new RemoteCommandsService(commands, async () => ({ ...cardContext(falling), icr_g_per_u: 12 }) as never, { get: async () => ({ conversation_id: 'c1', status: 'PROPOSED', expires_at: minutesLater(15), split: withRest.split, purpose: 'MEAL', carbs_g: withRest.carbs_g, insulin_u: withRest.insulin_u, warnings: [] }) } as never);
      const preview = await service.preview('p1', { carbs_g: 46, insulin_u: 3, bolus_step: 0.05, source: 'CHAT_CARD' } as never, now);
      const sent = await service.authorize('p1', 'u-mama', { source: 'CHAT_CARD', carbs_g: 46, insulin_u: 3, bolus_step: 0.05, device_id: 'd1', conversation_id: 'c1', proposal_id: 'b2', acknowledged_warnings: preview.warnings.map((warning) => warning.key) }, now);
      expect(sent.insulin_u).toBe(3);
      const row = commands.rows[0];
      expect(row.split_plan).toBeTruthy();
      const plans = new MemoryPlanStore();
      const part = (await new PlannedBolusService({ store: plans, commands }).createForMeal({ ...row, status: 'SUCCEEDED' } as RemoteCommandRecord, 'meal-1', now.toISOString()))!;
      const rest = estimatePlannedBolus({ plan: part, meal_started_at: now.toISOString(), now_iso: minutesLater(45), therapy: therapy([['00:00', 12]]), events: [], step: 0.05, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt });
      // 3,8 j for the meal − 3 j given = 0,8 j at most.
      expect(rest.insulin_u!).toBeLessThanOrEqual(0.8);
    });
  });

  it('M24 — posiłek przed WF: własna niższa dawka przyjęta bez ostrzeżenia; karta nie wie o WF, push przed WF tylko przy niskiej/spadającej', async () => {
    const steady = forecast({ glucose: 140, iob: 0.2 });
    // 30 g / 8,33 = 3,6 j; the caregiver lowers it by ~30% to 2,5 j.
    const lower: any = await cardSession(steady, { doseBasis: 'ICR' }).instance.propose(mealArgs(30, 'Obiad', null, { insulin_u: 2.5, reason: 'Po obiedzie WF: mniej.' }));
    expect(lower).toMatchObject({ status: 'PROPOSED', card: { insulin_u: 2.5, dose_from_icr: 3.6 } });
    expect(lower.card.warnings).toEqual([]);
    // No variant on the card lowers the dose for an activity (no input about WF reaches the card).
    const plain = cardSession(steady, { doseBasis: 'ICR' });
    await plain.instance.propose(mealArgs(30, 'Obiad'));
    const kinds = (plain.stored[0].card_advice!.variants ?? []).map((variant) => variant.kind);
    expect(kinds.some((kind) => /ACTIV|EXERC|SPORT|WF/i.test(kind))).toBe(false);
    // The plan's WF entry: a push 30 min before only when glucose < 120 or falling under 150. At 140 → no push.
    const wf = { kind: 'MOVEMENT' as const, status: 'PLANNED' as const, planned_at: '2026-11-10T11:30:00.000Z', reminder_sent_at: null };
    expect(mealPlanMovementDecision(wf, new Date('2026-11-10T11:05:00.000Z'), { value: 140, arrow: '→' })).toEqual({ action: 'WAIT' });
    expect(mealPlanMovementDecision(wf, new Date('2026-11-10T11:05:00.000Z'), { value: 140, arrow: '↘' })).toEqual({ action: 'ALERT' });
    expect(mealPlanMovementContent({ title: 'WF' }, '12:30', { value: 140, arrow: '↘' }).body).toMatch(/Przed zajęciami mogą być potrzebne węglowodany/);
  });

  it('M30 — za dużo gramów po podanym bolusie: poprawa gramów ostrzega o za dużej dawce i nie proponuje bolusa', () => {
    // 30 g wpisane zamiast 13 g, 3,6 j poszło; posiłek poprawiony na 13 g.
    const actions = [{ purpose: 'NEW_MEAL', carbs_g: 30, bolus_units: 3.6 }];
    const excess = mealDoseExcess({ actions, meal_carbs_g: 13 });
    expect(excess).toEqual({ grams: 17, insulin_u: 2.04 });
    expect(mealExcessLine(excess!.grams, excess!.insulin_u, 'MEAL')).toBe('Posiłek ma teraz o 17 g węglowodanów mniej, niż było, gdy podano insulinę: podana insulina była o ok. 2,04 j za duża. Dokończ posiłek albo daj teraz ok. 18 g węglowodanów do zjedzenia. Sprawdź glukozę za 15 min.');
    // Nothing "missing" is said for the smaller meal.
    expect(mealDoseShortfall({ actions, meal_carbs_g: 13, icr_g_per_u: 8.33 })).toBeNull();
  });

  it('D5 — IOB z bolusa sprzed godziny: pełna 1,8 j na 15 g, teraz 0,9 j (połowa), obniżenie nie jest „brakiem” w czacie posiłku', async () => {
    const stacked = forecast({ glucose: 140, iob: 1.8 });
    const ctx = { last_bolus: { at: minutesAgo(60), units: 2.4 } };
    const { instance, stored } = cardSession(stacked, { doseBasis: 'CALCULATOR', context: ctx });
    const result: any = await instance.propose(mealArgs(15, 'Podwieczorek'));
    expect(result).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 15, insulin_u: 0.9, dose_from_icr: 1.8 } });
    const calculation = stored[0].card_advice!.dose_calculation!;
    expect(calculation).toMatchObject({ icr_dose_u: 1.8, default_u: 0.9, iob_floor_u: 0.9, reason_code: 'ACTIVE_INSULIN' });
    expect(calculation.summary).toMatch(/0,9 j zamiast 1,8 j/);
    expect(calculation.summary).toMatch(/IOB 1,8 j/);
    expect(calculation.summary).toMatch(/insulina w organizmie/);
    // The whole dose stays one tap away ("Cały bolus teraz" / "Z przelicznika").
    const variants = stored[0].card_advice!.variants ?? [];
    expect(variants.some((variant) => variant.insulin_now_u === 1.8)).toBe(true);
    // The rest of the lowered dose can be planned by hand.
    // rest_carbs_g = round(15 − 0,9 × 8,33 = 7,5) = 8 g → 0,95 j: the rounding up of grams gives 0,05 j over carbs / ICR.
    expect(stored[0].card_advice!.rest_offer).toMatchObject({ rest_carbs_g: 8 });
    expect(stored[0].card_advice!.rest_offer!.rest_u).toBeGreaterThanOrEqual(0.9);
    expect(stored[0].card_advice!.rest_offer!.rest_u).toBeLessThanOrEqual(0.95);
    // ICR mode: 1,8 j, the calculator's 0,9 j as the other button.
    const byIcr = cardSession(stacked, { doseBasis: 'ICR', context: ctx });
    await byIcr.instance.propose(mealArgs(15, 'Podwieczorek'));
    expect(byIcr.stored[0].insulin_u).toBe(1.8);
    expect(byIcr.stored[0].card_advice!.variants!.find((variant) => variant.kind === 'CALCULATOR_DOSE')).toMatchObject({ insulin_now_u: 0.9 });
    // The meal chat later: the 0,9 j held back is a decision, not "brakuje 0,9 j".
    const command = { status: 'SUCCEEDED', icr_insulin_u: 1.8, context: { dose_calculation: calculation } };
    expect(mealDoseShortfall({ actions: [{ purpose: 'NEW_MEAL', carbs_g: 15, bolus_units: 0.9 }], meal_carbs_g: 15, icr_g_per_u: 8.33, held_back_u: calculatorHeldBackU([command]) })).toBeNull();
  });

  describe('D11 — niezjedzony posiłek po pełnym bolusie (3,6 j na 30 g, zjedzone 12 g)', () => {
    it('D11 — zmniejszenie posiłku do 12 g: nadmiar insuliny w gramach i jednostkach, bez propozycji kolejnego bolusa', () => {
      const actions = [{ purpose: 'NEW_MEAL', carbs_g: 30, bolus_units: 3.6 }];
      const excess = mealDoseExcess({ actions, meal_carbs_g: 12 });
      expect(excess).toEqual({ grams: 18, insulin_u: 2.16 });
      const line = mealExcessLine(excess!.grams, excess!.insulin_u, 'MEAL')!;
      expect(line).toMatch(/o 18 g węglowodanów mniej/);
      expect(line).toMatch(/2,16 j za duża/);
      expect(mealDoseShortfall({ actions, meal_carbs_g: 12, icr_g_per_u: 8.33 })).toBeNull();
    });

    // GAP: the excess push and the meal page say only "Sprawdź glukozę": no grams of carbs to give (ok. 10–15 g or
    // finishing the plate), no forecast and no follow-up check in 15–20 min. split-bolus.ts mealExcessLine,
    // apps/api/src/application/api.service.ts queueMealExcessPush.
    it('D11 — komunikat o nadmiarze proponuje węglowodany (ile gramów) i kontrolę za 15–20 min', () => {
      const line = mealExcessLine(18, 2.16, 'MEAL')!;
      expect(line).toMatch(/\d+\s*g (?:szybkich )?węglowodanów (?:teraz|do zjedzenia)|dokończ/i);
      expect(line).toMatch(/za (?:15|20) min/);
    });
  });

  it('D17 — WF za 30 min: tymczasowy cel z Trio obniża kalkulator, własna niższa dawka bez ostrzeżeń; celu Mellis nie ustawia', async () => {
    // 25 g / 8,33 = 3 j. Trio's activity target 150 (set by hand in Trio): the calculator aims at it.
    const normal = computeDoseCalculation({ now, carbs_g: 25, icr_g_per_u: 8.33, step: 0.05, data: forecast({ glucose: 140, iob: 0.3 }), iob_floor: true });
    const activity = computeDoseCalculation({ now, carbs_g: 25, icr_g_per_u: 8.33, step: 0.05, data: forecast({ glucose: 140, iob: 0.3, loopTarget: 150 }), iob_floor: true });
    expect(normal.default_u).toBe(3);
    expect(activity.breakdown?.target_mgdl).toBe(150);
    expect(activity.default_u).toBeLessThan(3);
    // But nowhere near the 25–50% lower dose for exercise: only (140 − 150) / 100 + IOB.
    expect(activity.default_u).toBeGreaterThan(2.25);
    // The caregiver's own dose lowered by ~35% (2 j): kept, no warning.
    const own: any = await cardSession(forecast({ glucose: 140, iob: 0.3 }), { doseBasis: 'ICR' }).instance.propose(mealArgs(25, 'Obiad', null, { insulin_u: 2, reason: 'WF za pół godziny.' }));
    expect(own).toMatchObject({ status: 'PROPOSED', card: { insulin_u: 2, warnings: [] } });
  });

  it('D23 — ICR 8 do 11:00, potem 12: pierwsza część z ICR 8, druga przy otwarciu z ICR obowiązującym teraz (12), plan pamięta 8', async () => {
    // 10:50 local = 09:50 UTC: the card's ICR (context at that time) is 8.
    const at1050 = new Date('2026-11-10T09:50:00.000Z');
    const steady = forecast({ glucose: 130, iob: 0.2, at: at1050 });
    const stored: NewBolusProposal[] = [];
    const session = new BolusProposalSession({
      patientId: 'p1', conversationId: 'c1', userMessageId: 'm1', doseRequested: true, now: () => at1050, doseBasis: 'ICR',
      context: async () => ({ ...cardContext(steady), now: at1050.toISOString(), icr_g_per_u: scheduleValueAt([['00:00', 8], ['11:00', 12]], at1050.toISOString(), 'Europe/Warsaw') }) as never,
      store: { insert: async (proposal) => { stored.push(proposal); return { ...proposal, id: 'b1', status: 'PROPOSED', created_at: at1050.toISOString() }; } },
    });
    await session.propose(mealArgs(24, 'Kanapki', null, { later: { trigger: 'AFTER_MINUTES', after_minutes: 50, threshold_mgdl: null, carbs_g: 16, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null } }));
    expect(stored[0]).toMatchObject({ carbs_g: 24, insulin_u: 3, icr_g_per_u: 8 });
    // The card's estimate of the later part: 16 g / 8 = 2 j (the ICR known when the card was made).
    expect(stored[0].split).toMatchObject({ later_carbs_g: 16, later_insulin_u: 2 });
    const command = { id: 'cmd-1', patient_id: 'p1', proposal_id: 'b1', conversation_id: 'c1', carbs_g: 24, insulin_u: 3, icr_g_per_u: 8, split_plan: stored[0].split, meal_payload: null } as unknown as RemoteCommandRecord;
    const part = (await new PlannedBolusService({ store: new MemoryPlanStore(), commands: new MemoryCommandStore() }).createForMeal(command, 'meal-1', at1050.toISOString()))!;
    expect(part).toMatchObject({ icr_g_per_u: 8, planned_insulin_u: 2, due_at: '2026-11-10T10:40:00.000Z' });
    // Opened at 11:40 local: the profile valid now (getTherapyProfileAt(now) + scheduleValueAt, as api.service does).
    const estimate = estimatePlannedBolus({ plan: part, meal_started_at: at1050.toISOString(), now_iso: '2026-11-10T10:40:00.000Z', therapy: therapy([['00:00', 8], ['11:00', 12]]), events: [], step: 0.05, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt });
    expect(estimate).toMatchObject({ icr_g_per_u: 12, insulin_for_carbs_u: 1.3, insulin_u: 1.3 });
    // The push carries no units, so push and card cannot disagree on the ICR.
    expect(plannedBolusPushContent({ description: 'Kanapki', carbs_g: 16, estimate_u: estimate.insulin_u, low_glucose: null }).body).not.toMatch(/\d\s*j\b/);
  });

  describe('D29 — „dajmy mu kolejną dawkę” w czacie posiłku', () => {
    it('D29 — czat posiłku nie liczy dawki: brak „brakuje X j”, tylko gramy; jednostki od modelu dostają zdanie o zakładce Bolus', () => {
      // 10.11: 11 g, 0,7 j given, the card's calculator advised 0,3 j of 1,3 j: no shortfall sentence any more.
      const heldBack = calculatorHeldBackU([{ status: 'SUCCEEDED', icr_insulin_u: 1.3, context: { dose_calculation: { default_u: 0.3, icr_dose_u: 1.3 } } }]);
      expect(mealDoseShortfall({ actions: [{ purpose: 'NEW_MEAL', carbs_g: 11, bolus_units: 0.7 }], meal_carbs_g: 11, icr_g_per_u: 8.3, held_back_u: heldBack })).toBeNull();
      // A model reply that still names units gets the pointer to where a dose is computed from the data.
      expect(withoutDoseHere('Można podać 1 j.')).toMatch(/policzy ją zakładka Bolus albo czat Rozmowy/);
      expect(withoutDoseHere('Dawkę na teraz policzy zakładka Bolus.')).toBe('Dawkę na teraz policzy zakładka Bolus.');
    });

    // GAP: the meal chat reply has no action ("Przelicz dawkę" opening the Bolus tab / card with the calculator): the
    // reply type is { reply, question, proposal, short_name } (meal-chat-responder.ts MealChatReply); the caregiver must
    // leave the meal page and open the Bolus tab by hand.
    it.fails('D29 — odpowiedź na prośbę o dawkę niesie przycisk „Przelicz dawkę”', async () => {
      const reply = await new FakeMealChatResponder().respond({
        meal: { started_at: minutesAgo(40), local_time: '11:16', logged_carbs_g: 11 },
        turns: [{ role: 'USER', content: 'Dajmy mu kolejną dawkę', photos: [] }],
      });
      expect(reply).toHaveProperty('action');
    });
  });
});
