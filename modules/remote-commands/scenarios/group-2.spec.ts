/**
 * Scenarios of a mother of a child with T1D and of a diabetologist (group 2): every way insulin for a meal is given,
 * checked on the server's own logic (cards, calculator, later parts, meal chat lines, pushes). A test marked
 * `it.fails` shows what the app does not do yet as the scenario expects; the file passes while that stays so.
 */
import { describe, expect, it } from 'vitest';
import { GLUCOSE_FORECAST_CALIBRATION } from '@modules/glucose-forecast/application/forecast-calibration';
import { scheduleValueAt } from '@modules/meal-wbt/application/wbt-policy';
import { BolusProposalSession, restLaterArgs, type NewBolusProposal } from '../application/bolus-proposal-tool';
import { computeDoseCalculation } from '../application/dose-calculator';
import type { MealForecastData } from '../application/meal-dose-forecast';
import type { RemoteCommandContext } from '../application/remote-command-policy';
import type { NewRemoteCommand, RemoteCommandRecord, RemoteCommandStore } from '../application/remote-command-record';
import { canTransitionRemoteCommand, IN_FLIGHT_STATUSES, type RemoteCommandStatus } from '../application/remote-command-status';
import { RemoteCommandsService } from '../application/remote-commands.service';
import {
  bolusesSinceMealForPart,
  estimatePlannedBolus,
  mealCarbsChangeUpdates,
  mealDoseExcess,
  mealDoseShortfall,
  mealExcessLine,
  partDeductionU,
  plannedBolusCalculatorLine,
  plannedBolusPushContent,
  plannedBolusReadiness,
  toPlannedBolusSummary,
  type PlannedBolusRecord,
} from '../application/split-bolus';
import { givenSinceMeal } from '../application/bolus-reminders';

const ICR = 8.3;
const now = new Date('2026-11-10T11:30:00.000Z');
const minutesAgo = (minutes: number, from = now) => new Date(from.getTime() - minutes * 60_000).toISOString();
const noCalibration = { ...GLUCOSE_FORECAST_CALIBRATION, version: 'test-none', shrink_by_minutes: { 5: 1 } };

/** Readings over 15 min and Trio's newest calculation (as dose-calculator.spec.ts builds them). */
function forecast(options: {
  glucose: number;
  /** mg/dL per 5 min (negative: falling). */
  per5?: number;
  iob: number;
  cob?: number;
  isf?: number;
  target?: number;
  /** Trio's own target now (a temporary target); default: the profile's. */
  loopTarget?: number;
  eventual?: number;
  curve?: number[];
  at?: Date;
  timezone?: string;
}): MealForecastData {
  const at = options.at ?? now;
  const per5 = options.per5 ?? 0;
  const readings = [3, 2, 1, 0].map((back) => ({ at: minutesAgo(1 + back * 5, at), value: options.glucose - per5 * back }));
  const eventual = options.eventual ?? options.glucose;
  return {
    readings,
    prediction: {
      source: 'OPENAPS', system: 'TRIO', computed_at: minutesAgo(1, at), bg: options.glucose, carbs_req_g: null, insulin_req_u: null,
      iob_u: options.iob, cob_g: options.cob ?? 0, isf_mgdl_per_u: options.isf ?? 150, icr_g_per_u: ICR, eventual_bg: eventual,
      target_mgdl: options.loopTarget ?? options.target ?? 100,
      curves: { IOB: options.curve ?? [options.glucose, options.glucose, options.glucose, options.glucose, options.glucose, options.glucose, eventual] },
    },
    profile_isf: options.isf ?? 150,
    profile_target: options.target ?? 100,
    profile_units: 'mg/dl',
    calibration: noCalibration,
    ...(options.timezone ? { timezone: options.timezone } : {}),
  } as MealForecastData;
}

const cardContext = (data: MealForecastData, overrides: Partial<RemoteCommandContext> = {}) => ({
  now: now.toISOString(),
  glucose: { value: data.readings.at(-1)!.value, observed_at: data.readings.at(-1)!.at, delta: data.readings.at(-1)!.value - data.readings.at(-2)!.value },
  lowest_recent_glucose: Math.min(...data.readings.map((reading) => reading.value)),
  loop: { iob_units: data.prediction!.iob_u, cob_grams: data.prediction!.cob_g, observed_at: data.prediction!.computed_at },
  last_bolus: null,
  icr_g_per_u: ICR,
  bolus_history_known: true,
  pump_bolus_step: 0.1,
  ...overrides,
  meal_forecast: data,
});

/** Card A (the chat's card and the planned meal's, one card), with the calculator as the default dose. */
function card(data: MealForecastData, overrides: Partial<RemoteCommandContext> = {}, at = now) {
  const stored: NewBolusProposal[] = [];
  const instance = new BolusProposalSession({
    patientId: 'p1', conversationId: null as never, userMessageId: 'm1', doseRequested: true, now: () => at, doseBasis: 'CALCULATOR',
    context: async () => ({ ...cardContext(data, overrides), now: at.toISOString() }) as never,
    store: { insert: async (proposal) => { stored.push(proposal); return { ...proposal, id: `b${stored.length}`, status: 'PROPOSED', created_at: at.toISOString() }; } },
  });
  return { instance, stored };
}

const mealArgs = (carbs: number, description: string, extra: Record<string, unknown> = {}) => ({
  purpose: 'MEAL', carbs_g: carbs, insulin_u: null, reduce_for_drop: false, add_correction: false, eating_now: false,
  meal_description: description, items: null, reason: description, later: null, ...extra,
});

function plan(overrides: Partial<PlannedBolusRecord> = {}): PlannedBolusRecord {
  return {
    id: 'plan-1', patient_id: 'p1', meal_record_id: 'meal-1', proposal_id: null, conversation_id: null,
    first_command_id: 'cmd-1', first_carbs_g: 30, first_insulin_u: 3.6, carbs_g: 10, planned_insulin_u: 1.2, icr_g_per_u: ICR, now_percent: 75, delay_minutes: 40,
    due_at: now.toISOString(), status: 'SCHEDULED', notified_at: null, resolved_at: null, resolved_by_user_id: null, resolved_by_name: null,
    given_command_id: null, given_loop_action_id: null, given_insulin_u: null, created_at: now.toISOString(),
    trigger: 'AFTER_MINUTES', threshold_mgdl: null, dose_carbs_g: null, fixed_insulin_u: null, drop_cover_g: null, subtract_first_insulin: false, wait_until: null,
    part_index: 0, meal_carbs_g: 40, meal_change_g: 0, cancelled_by_meal_change: false, meal_excess_g: 0,
    ...overrides,
  };
}

const therapy = { timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', ICR]] as Array<[string, number]>, basal_u_per_h: [['00:00', 0.3]] as Array<[string, number]> };

class MemoryStore implements RemoteCommandStore {
  rows: RemoteCommandRecord[] = [];
  async insert(command: NewRemoteCommand): Promise<RemoteCommandRecord> {
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
}

describe('group 2: meal insulin scenarios (mother, diabetologist)', () => {
  // ---------------------------------------------------------------- M2
  describe('M2: the child ate half the plate after the whole dose', () => {
    const actions = [{ purpose: 'NEW_MEAL', carbs_g: 30, bolus_units: 3.6 }];

    it('M2: the meal goes to 15 g, no insulin is proposed, the excess (15 g, 1,8 j) is said, a planned part is cancelled', () => {
      // No "brakuje": the meal chat adds no line about insulin to give.
      expect(mealDoseShortfall({ actions, meal_carbs_g: 15, icr_g_per_u: ICR, step: 0.1 })).toBeNull();
      // The meal without later parts: the insulin given for 15 g that were not eaten.
      const excess = mealDoseExcess({ actions, meal_carbs_g: 15 })!;
      expect(excess).toEqual({ grams: 15, insulin_u: 1.8 });
      expect(mealExcessLine(excess.grams, excess.insulin_u, 'MEAL')).toBe('Posiłek ma teraz o 15 g węglowodanów mniej, niż było, gdy podano insulinę: podana insulina była o ok. 1,8 j za duża. Dokończ posiłek albo daj teraz ok. 16 g węglowodanów do zjedzenia. Sprawdź glukozę za 15 min.');
      // A meal of 40 g with a second part of 10 g planned: the part is cancelled, 15 g more are an excess.
      const [update] = mealCarbsChangeUpdates([plan()], 15, 0.1);
      expect(update).toMatchObject({ carbs_g: 0, cancel: true, meal_excess_g: 15 });
      expect(mealExcessLine(update.meal_excess_g, Math.round((update.meal_excess_g / ICR) * 100) / 100)).toMatch(/1,81 j za duża/);
    });

    // FAIL: the excess line and its push ("Za duża dawka po zmianie posiłku") only say "Sprawdź glukozę": no fast carbs
    // (8–10 g) and no check time depending on the forecast. The low alert comes later and on its own (rescue push).
    it('M2: the excess line proposes fast carbs or a check in 15 min, depending on the forecast', () => {
      const excess = mealDoseExcess({ actions, meal_carbs_g: 15 })!;
      expect(mealExcessLine(excess.grams, excess.insulin_u, 'MEAL')).toMatch(/szybkich węglowodanów|za 15 min/);
    });
  });

  // ---------------------------------------------------------------- M8
  describe('M8: a meal 45 min after the father\'s correction', () => {
    const data = forecast({ glucose: 170, per5: -5, iob: 1.3, isf: 150 });

    it('M8: the calculator takes off some IOB but the meal dose stays within 1,8–3,6 j, never 0 j for IOB', () => {
      const calculation = computeDoseCalculation({ iob_floor: true, now, carbs_g: 30, icr_g_per_u: ICR, step: 0.1, data, forecast_nudge: false });
      // 30 / 8,3 + (170 − 15 − 100) / 150 − 1,3 = 2,67 → 2,6 j.
      expect(calculation).toMatchObject({ icr_dose_u: 3.6, default_u: 2.6, limited_by: 'CALCULATOR' });
      expect(calculation.default_u).toBeGreaterThanOrEqual(1.8);
      expect(calculation.summary).toMatch(/IOB 1,3 j/);
      // Flat glucose with much more IOB: the floor (half of carbs / ICR) holds the dose.
      const flat = computeDoseCalculation({ iob_floor: true, now, carbs_g: 30, icr_g_per_u: ICR, step: 0.1, data: forecast({ glucose: 170, iob: 4, isf: 150 }), forecast_nudge: false });
      expect(flat).toMatchObject({ default_u: 1.8, iob_floor_u: 1.8 });
    });

    // FAIL: with a falling trend (≥10 mg/dL in 15 min) the half floor is off by design (dose-calculator.v4: "not when
    // glucose falls"), so a large IOB still takes the meal dose far below half: 170 ↘ with IOB 3 gives 0,9 j for 30 g.
    it.fails('M8: with 170 ↘ and IOB 3 j the meal dose is still at least half of carbs / ICR (1,8 j)', () => {
      const calculation = computeDoseCalculation({ iob_floor: true, now, carbs_g: 30, icr_g_per_u: ICR, step: 0.1, data: forecast({ glucose: 170, per5: -5, iob: 3, isf: 150 }), forecast_nudge: false });
      expect(calculation.default_u).toBeGreaterThanOrEqual(1.8);
    });

    // FAIL: the card names a bolus only within 15 min (RECENT_BOLUS) and never who gave it; 45 min ago, 0,8 j by the
    // father is not on the card (IOB only stands in the calculator's line).
    it.fails('M8: the card says the father gave 0,8 j 45 min ago', async () => {
      const { instance } = card(data, { last_bolus: { at: minutesAgo(45), units: 0.8 } });
      const result = await instance.propose(mealArgs(30, 'Obiad')) as { card: { warnings: string[] } };
      expect(result.card.warnings.join(' ')).toMatch(/0,8 j.*45 min/);
    });
  });

  // ---------------------------------------------------------------- M14
  describe('M14: a snack between meals', () => {
    const data = forecast({ glucose: 130, iob: 0.6, isf: 150 });

    it('M14: 10 g gives about 1,2 j, the calculator lowers it but not below 0,6 j; carbs alone can be sent', async () => {
      const calculation = computeDoseCalculation({ iob_floor: true, now, carbs_g: 10, icr_g_per_u: ICR, step: 0.1, data, forecast_nudge: false });
      // 10 / 8,3 + (130 − 100) / 150 − 0,6 = 0,8 j, with the reason.
      expect(calculation).toMatchObject({ icr_dose_u: 1.2, default_u: 0.8, limited_by: 'CALCULATOR' });
      expect(calculation.short_summary).toMatch(/aktywna insulina|IOB/i);
      // The Bolus tab: the calculator's dose pre-filled; 10 g with 0 j has no block (carbs only).
      const service = new RemoteCommandsService(new MemoryStore(), async () => cardContext(data) as never);
      // On the server the forecast nudge (dose-calculator.v3) takes it halfway back up while Trio's line stays flat: 1 j.
      const form = await service.preview('p1', { carbs_g: 10, insulin_u: null, bolus_step: 0.1, dose_default: 'CALCULATOR' }, now);
      expect(form).toMatchObject({ insulin_u: 1, icr_insulin_u: 1.2, blocks: [], dose_calculation: { limited_by: 'FORECAST' } });
      expect(form.insulin_u).toBeGreaterThanOrEqual(0.6);
      const carbsOnly = await service.preview('p1', { carbs_g: 10, insulin_u: 0, bolus_step: 0.1 }, now);
      expect(carbsOnly).toMatchObject({ insulin_u: 0, blocks: [] });
      expect(carbsOnly.warnings.filter((warning) => warning.severity === 'DANGER')).toEqual([]);
    });
  });

  // ---------------------------------------------------------------- M20
  describe('M20: the second part opened late, after the father gave 0,6 j', () => {
    const mealStart = '2026-11-10T10:30:00.000Z';
    const openedAt = new Date('2026-11-10T11:40:00.000Z');
    const therapy8 = { ...therapy, carb_ratio_g_per_u: [['00:00', 8]] as Array<[string, number]> };
    const part = plan({ carbs_g: 9, dose_carbs_g: 9, planned_insulin_u: 1.1, icr_g_per_u: 8, due_at: '2026-11-10T11:09:00.000Z', status: 'NOTIFIED' });
    const actions = [
      { id: 'own', started_at: '2026-11-10T10:30:30.000Z', bolus_units: 3.6, carbs_g: 30, meal_record_id: 'meal-1' },
      { id: 'dad', started_at: '2026-11-10T11:20:00.000Z', bolus_units: 0.6, carbs_g: 0, meal_record_id: null },
    ];

    it('M20: the push and the card name every bolus since the meal, take the father\'s 0,6 j off, the grams agree', () => {
      const since = bolusesSinceMealForPart({ actions, used: new Set(['own']), meal_record_id: 'meal-1', meal_started_at: mealStart, now: openedAt });
      expect(since.map((action) => action.id)).toEqual(['dad']);
      const deduction = partDeductionU(since, 8);
      expect(deduction).toBeCloseTo(0.6, 5);
      const given = givenSinceMeal({ mealStartedAt: mealStart, now: openedAt, timeZone: 'Europe/Warsaw', actions: since, senders: new Map([['dad', 'Tata']]), loopName: 'Trio', caregiverCount: 2 });
      expect(given.line).toBe('⚠️ Od 11:30 podano już 0,6 j (12:20, Tata).');
      const estimate = estimatePlannedBolus({
        plan: part, meal_started_at: mealStart, now_iso: openedAt.toISOString(), therapy: therapy8, events: [], step: 0.1, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt,
        manual_insulin_u: deduction, forecast: forecast({ glucose: 150, per5: -5, iob: 1.6, at: openedAt }),
      });
      // 9 g / 8 = 1,1 j − 0,6 j given by hand = 0,5 j; glucose 150 ↘ above target: the calculator lowers nothing.
      expect(estimate).toMatchObject({ insulin_for_carbs_u: 1.1, manual_insulin_subtracted_u: 0.6, insulin_u: 0.5 });
      const push = plannedBolusPushContent({ description: 'Zupa i podwieczorek', carbs_g: part.carbs_g, estimate_u: estimate.insulin_u, low_glucose: null, given_line: given.line, calculator_line: plannedBolusCalculatorLine(estimate) });
      expect(push.title).toBe('⚠️ Druga część bolusa · 9 g');
      expect(push.body).toContain('Od 11:30 podano już 0,6 j (12:20, Tata). Karta odejmie je od dawki');
      // The card's summary carries the same grams as the push's title.
      expect(toPlannedBolusSummary(part, null)).toMatchObject({ carbs_g: 9, dose_carbs_g: 9 });
    });

    it('M20: more given by hand than the part needs: the part\'s dose is 0 j', () => {
      const estimate = estimatePlannedBolus({ plan: part, meal_started_at: mealStart, now_iso: openedAt.toISOString(), therapy: therapy8, events: [], step: 0.1, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt, manual_insulin_u: 1.5 });
      expect(estimate.insulin_u).toBe(0);
    });
  });

  // ---------------------------------------------------------------- M26
  describe('M26: fast carbs while falling instead of the snack bolus', () => {
    // 72 ↓↓ (−3/min), IOB 1,5 j: Trio's line under 70 within minutes.
    const data = forecast({ glucose: 72, per5: -15, iob: 1.5, isf: 150, eventual: 40, curve: [72, 62, 54, 48, 44, 41, 40] });

    it('M26: the snack card gives fast carbs first (even grams, 0 j), the snack without insulin now and its bolus after the drop', async () => {
      const { instance, stored } = card(data);
      const result = await instance.propose(mealArgs(15, 'Podwieczorek')) as Record<string, any>;
      expect(result).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 15, insulin_u: 0 }, dose_calculation: { default_u: 0, limited_by: 'CARBS_FIRST' } });
      const fast = result.advice.fast_carbs_first;
      expect(fast.carbs_g % 2).toBe(0);
      expect(fast.message).toMatch(/szybkich węglowodanów/);
      // The fast carbs are not the snack's: the card's carbs stay the snack's 15 g, its bolus waits for the drop to stop.
      expect(stored[0].carbs_g).toBe(15);
      expect(stored[0].split).toMatchObject({ kind: 'DEFERRED_INSULIN', trigger: 'GLUCOSE_STOPPED_FALLING' });
    });
  });

  // ---------------------------------------------------------------- D1
  describe('D1: a pre-bolus with glucose steady in range', () => {
    const data = forecast({ glucose: 130, iob: 0.1, isf: 150 });

    it('D1: the planned meal card gives the whole 3,6 j now, without warnings', async () => {
      const { instance } = card(data);
      const result = await instance.propose(mealArgs(30, 'Obiad: zupa i makaron')) as Record<string, any>;
      expect(result).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 30, insulin_u: 3.6, dose_from_icr: 3.6, warnings: [] } });
      expect(result.dose_calculation.limited_by).toBe('ICR');
    });

    it('D1: the Bolus tab 5 min later with the same 30 g warns that the meal was sent (DANGER)', async () => {
      const store = new MemoryStore();
      const sentAt = new Date(now.getTime() - 5 * 60_000);
      const service = new RemoteCommandsService(store, async () => cardContext(data) as never);
      const first = await service.authorize('p1', 'u-mama', { source: 'BOLUS_SCREEN', carbs_g: 30, insulin_u: 3.6, bolus_step: 0.1, device_id: 'd1', meal: { description: 'Obiad: zupa i makaron', items: null, macros: null }, acknowledged_warnings: [] } as never, sentAt);
      await service.reportSent('p1', 'u-mama', first.id, { accepted: true }, sentAt);
      await service.reportReply('p1', 'u-mama', first.id, { success: true, message: 'Bolus started' }, sentAt);
      const preview = await service.preview('p1', { carbs_g: 30, insulin_u: 3.6, bolus_step: 0.1, dose_default: 'CALCULATOR' }, now);
      expect(preview.warnings.find((warning) => warning.code === 'ALREADY_SENT_FOR_MEAL')).toMatchObject({ severity: 'DANGER', message: expect.stringContaining('5 min temu wysłano z zakładki Bolus 30 g i 3,6 j') });
    });

    // FAIL: the Bolus tab still pre-fills a full meal dose for the same 30 g (the form knows no meal; only a DANGER
    // warning to acknowledge), not 0 j or a question about new grams; "Do tego posiłku: …" is only on the meal's page.
    it('D1: the Bolus tab does not propose 3,6 j a second time (0 j by default)', async () => {
      const store = new MemoryStore();
      const sentAt = new Date(now.getTime() - 5 * 60_000);
      const service = new RemoteCommandsService(store, async () => cardContext(data) as never);
      const first = await service.authorize('p1', 'u-mama', { source: 'BOLUS_SCREEN', carbs_g: 30, insulin_u: 3.6, bolus_step: 0.1, device_id: 'd1', meal: { description: 'Obiad', items: null, macros: null }, acknowledged_warnings: [] } as never, sentAt);
      await service.reportSent('p1', 'u-mama', first.id, { accepted: true }, sentAt);
      const preview = await service.preview('p1', { carbs_g: 30, insulin_u: null, bolus_step: 0.1, dose_default: 'CALCULATOR' }, now);
      expect(preview.insulin_u).toBe(0);
    });
  });

  // ---------------------------------------------------------------- D7
  describe('D7: the second part while glucose falls', () => {
    const due = new Date('2026-11-10T13:00:00.000Z');
    // 105 ↘ −2/min, IOB 2,0 j, Trio's forecast 60.
    const data = forecast({ glucose: 105, per5: -10, iob: 2, isf: 150, eventual: 60, curve: [105, 95, 86, 78, 70, 64, 60], at: due });
    const part = plan({ carbs_g: 15, dose_carbs_g: 15, planned_insulin_u: 1.8, due_at: due.toISOString(), meal_carbs_g: 45 });

    it('D7: the part\'s dose is taken to 0 j (carbs first) and the push says why', () => {
      const estimate = estimatePlannedBolus({ plan: part, meal_started_at: '2026-11-10T11:30:00.000Z', now_iso: due.toISOString(), therapy, events: [], step: 0.1, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt, forecast: data });
      expect(estimate).toMatchObject({ dose_before_calculator_u: 1.8, insulin_u: 0 });
      expect(estimate.dose_calculation?.limited_by).toBe('CARBS_FIRST');
      expect(plannedBolusCalculatorLine(estimate)).toMatch(/najpierw węglowodany/i);
    });

    // FAIL: a part at a time comes at its time whatever glucose does (AFTER_MINUTES is READY); the push opens with no
    // warning (low_glucose only below 100, 105 here) and no "Pomiń" / "gdy przestanie spadać" in it.
    it.fails('D7: a timed part waits (or warns in its title) while glucose falls towards a low', () => {
      const readiness = plannedBolusReadiness({ now: due, trigger: 'AFTER_MINUTES', due_at: part.due_at, force_at: null, glucose: { value: 105, at: minutesAgo(1, due) }, slope_per_min: -2, forecast_min_mgdl: 70 });
      const push = plannedBolusPushContent({ description: 'Pizza', carbs_g: 15, estimate_u: 0, low_glucose: null, readiness });
      expect(readiness.state === 'WAIT' || push.title.startsWith('⚠️')).toBe(true);
    });
  });

  // ---------------------------------------------------------------- D13
  describe('D13: a second helping after the bolus', () => {
    const actions = [{ purpose: 'NEW_MEAL', carbs_g: 25, bolus_units: 3.0 }];

    it('D13: only the new 10 g are said, as the second part; the dose is computed when due (1,2 j)', () => {
      const short = mealDoseShortfall({ actions, meal_carbs_g: 35, icr_g_per_u: ICR, step: 0.1 })!;
      expect(short).toMatchObject({ carbs_g: 10, uncovered_g: 10, insulin_u: 1.2 });
      // The part (as planMealShortfall stores it) when due: 10 g / 8,3 = 1,2 j; glucose 160 ↗ lowers nothing.
      const part = plan({ kind: 'SPLIT', first_carbs_g: 25, first_insulin_u: 3, carbs_g: 10, dose_carbs_g: 10, planned_insulin_u: 1.2, meal_carbs_g: null });
      const estimate = estimatePlannedBolus({ plan: part, meal_started_at: '2026-11-10T11:00:00.000Z', now_iso: now.toISOString(), therapy, events: [], step: 0.1, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt, forecast: forecast({ glucose: 160, per5: 5, iob: 2.6 }) });
      expect(estimate.insulin_u).toBe(1.2);
    });
  });

  // ---------------------------------------------------------------- D19
  describe('D19: a bedtime snack', () => {
    const at = new Date('2026-11-10T20:30:00.000Z'); // 21:30 in Warsaw
    const data = forecast({ glucose: 110, per5: -5, iob: 0.8, isf: 150, at, timezone: 'Europe/Warsaw' });

    it('D19: 12 g of milk gives a lowered dose (below 1,4 j; v3\'s nudge takes it to 1 j while Trio\'s line is flat)', async () => {
      const { instance, stored } = card(data, {}, at);
      const result = await instance.propose(mealArgs(12, 'Mleko')) as Record<string, any>;
      expect(result.card).toMatchObject({ carbs_g: 12, dose_from_icr: 1.4 });
      expect(result.card.insulin_u).toBeLessThan(1.4);
      expect(result.card.insulin_u).toBeGreaterThanOrEqual(0.7);
      expect(stored[0].split ?? null).toBeNull();
    });

    // NOT SUPPORTED: no night warning on a meal card (card-advice.v2 dropped the night line), no check push for the
    // caregiver on duty.
    it.fails('D19: the card warns about the night risk', async () => {
      const { instance } = card(data, {}, at);
      const result = await instance.propose(mealArgs(12, 'Mleko')) as { card: { warnings: string[] } };
      expect(result.card.warnings.join(' ')).toMatch(/noc/i);
    });
  });

  // ---------------------------------------------------------------- D25
  describe('D25: a temporary target active in Trio', () => {
    const data = forecast({ glucose: 135, iob: 0.3, isf: 150, target: 100, loopTarget: 150 });

    it('D25: the calculator aims at the temporary target 150 (no correction, a small lowering); by ICR no negative correction', () => {
      const calculation = computeDoseCalculation({ iob_floor: true, now, carbs_g: 20, icr_g_per_u: ICR, step: 0.1, data, forecast_nudge: false });
      expect(calculation.breakdown).toMatchObject({ target_mgdl: 150, correction_u: -0.1 });
      // 20 / 8,3 − 0,1 − 0,3 = 2,0 j of 2,4 j.
      expect(calculation).toMatchObject({ icr_dose_u: 2.4, default_u: 2, limited_by: 'CALCULATOR' });
    });

    it('D25: with the ICR as the default the card keeps 2,4 j', async () => {
      const stored: NewBolusProposal[] = [];
      const instance = new BolusProposalSession({
        patientId: 'p1', conversationId: 'c1', userMessageId: 'm1', doseRequested: true, now: () => now, doseBasis: 'ICR',
        context: async () => cardContext(data) as never,
        store: { insert: async (proposal) => { stored.push(proposal); return { ...proposal, id: 'b1', status: 'PROPOSED', created_at: now.toISOString() }; } },
      });
      await instance.propose(mealArgs(20, 'Kanapka'));
      expect(stored[0].insulin_u).toBe(2.4);
    });

    // FAIL: nothing on the card names the active temporary target ("Aktywny cel 150 do HH:MM"); the target is only a
    // number inside the calculator's formula, and the server does not know when it ends.
    it.fails('D25: the card says the temporary target is active', async () => {
      const { instance } = card(data);
      const result = await instance.propose(mealArgs(20, 'Kanapka')) as Record<string, any>;
      expect(`${result.card.warnings.join(' ')} ${result.dose_calculation.summary}`).toMatch(/[Cc]el (tymczasowy )?150/);
    });
  });

  // ---------------------------------------------------------------- D31
  describe('D31: the rest of a lowered dose at a time chosen by hand', () => {
    // 30 g, ICR 12 = 2,5 j; IOB 1,5 j and glucose falling lower it.
    const data: MealForecastData = {
      ...forecast({ glucose: 110, per5: -4, iob: 1.5, isf: 60, eventual: 85, curve: [110, 104, 98, 93, 89, 86, 85] }),
    };
    const ctx = { ...cardContext(data), icr_g_per_u: 12, pump_bolus_step: 0.05 };
    const make = (stored: NewBolusProposal[]) => new BolusProposalSession({
      patientId: 'p1', conversationId: 'c1', userMessageId: 'm1', doseRequested: true, now: () => now, doseBasis: 'CALCULATOR',
      context: async () => ctx as never,
      store: { insert: async (proposal) => { stored.push(proposal); return { ...proposal, id: `b${stored.length}`, status: 'PROPOSED', created_at: now.toISOString() }; } },
    });

    it('D31: the rest in 45 min is stored as grams with no fixed dose (computed when due); "gdy przestanie spadać" is offered while falling', async () => {
      const stored: NewBolusProposal[] = [];
      await make(stored).propose(mealArgs(30, 'Obiad'));
      const first = stored[0];
      expect(first.insulin_u).toBeLessThan(2.5);
      const offer = first.card_advice!.rest_offer!;
      expect(offer).toMatchObject({ falling: true, current: null });
      expect(offer.rest_u).toBeCloseTo(2.5 - first.insulin_u, 5);
      await make(stored).propose(restLaterArgs(first as never, { trigger: 'AFTER_MINUTES', minutes: 45 })!);
      const withRest = stored[1];
      expect(withRest.insulin_u).toBe(first.insulin_u);
      expect(withRest.card_advice!.rest_offer!.current).toEqual({ trigger: 'AFTER_MINUTES', minutes: 45 });
      const parts = [withRest.split!, ...(withRest.split!.more_parts ?? [])];
      expect(parts).toHaveLength(1);
      // M18 (2026-11-10): the rest doses the whole card less the insulin the card gave (subtract_card_insulin), so a
      // dose raised by hand leaves a smaller rest; its estimate is still the offer's rest.
      expect(parts[0]).toMatchObject({ later_after_minutes: 45, later_carbs_g: 0, subtract_card_insulin: true });
      expect(parts[0].later_insulin_u).toBeCloseTo(offer.rest_u, 1);
      expect(parts[0].fixed_insulin_u ?? null).toBeNull();
      // The other choice: "gdy przestanie spadać" instead of a fixed time.
      await make(stored).propose(restLaterArgs(withRest as never, { trigger: 'GLUCOSE_STOPPED_FALLING' })!);
      expect(stored[2].split).toMatchObject({ trigger: 'GLUCOSE_STOPPED_FALLING' });
    });

    it('D31: when due while glucose falls, the rest\'s dose is lowered by the calculator, not the stored estimate', () => {
      const due = new Date(now.getTime() + 45 * 60_000);
      const rest = plan({ kind: 'DEFERRED_INSULIN', first_carbs_g: 30, first_insulin_u: 1.3, carbs_g: 0, dose_carbs_g: 14, planned_insulin_u: 1.2, icr_g_per_u: 12, due_at: due.toISOString() });
      const falling = forecast({ glucose: 100, per5: -10, iob: 1.8, isf: 60, eventual: 55, curve: [100, 90, 80, 72, 64, 58, 55], at: due });
      const estimate = estimatePlannedBolus({ plan: rest, meal_started_at: now.toISOString(), now_iso: due.toISOString(), therapy: { ...therapy, carb_ratio_g_per_u: [['00:00', 12]] }, events: [], step: 0.05, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt, forecast: falling });
      expect(estimate.dose_before_calculator_u).toBeCloseTo(1.15, 5);
      expect(estimate.insulin_u).toBe(0);
    });
  });
});
