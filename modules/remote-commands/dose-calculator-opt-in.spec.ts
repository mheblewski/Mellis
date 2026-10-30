import { describe, expect, it } from 'vitest';
import { GLUCOSE_FORECAST_CALIBRATION } from '@modules/glucose-forecast/application/forecast-calibration';
import {
  computeDoseCalculation,
  dangerReferenceU,
  doseAboveCalculatorWarning,
  doseExceedsFormula,
  DOSE_CALCULATOR_POLICY,
  type DoseOptInInput,
} from './application/dose-calculator';
import { evaluateRemoteCommand, roundDownToStep, type RemoteCommandContext } from './application/remote-command-policy';
import { RemoteCommandsService } from './application/remote-commands.service';
import type { NewRemoteCommand, RemoteCommandRecord, RemoteCommandStore } from './application/remote-command-record';
import type { MealForecastData } from './application/meal-dose-forecast';

/**
 * dose-calculator.v2 (Mellis 1.0.2): the opt-in higher dose behind the Bolus tab's ± button. Half a correction, capped
 * at 1 U, rounded down; offered only when every gate is clear, never as the default, and never while the calculator
 * lowered the dose.
 */
const now = new Date('2026-10-29T12:00:00.000Z'); // 13:00 in Warsaw
const night = new Date('2026-10-29T02:00:00.000Z'); // 03:00 in Warsaw
const minutesAgo = (minutes: number, from = now) => new Date(from.getTime() - minutes * 60_000).toISOString();
const noCalibration = { ...GLUCOSE_FORECAST_CALIBRATION, version: 'test-none', shrink_by_minutes: { 5: 1 } };

function data(options: {
  at?: Date;
  glucose?: number;
  /** mg/dL per 5 min over the last 15 min. */
  per5?: number;
  iob?: number | null;
  cob?: number;
  isf?: number;
  target?: number;
  minPred?: number | null;
  loopAgeMinutes?: number;
  readingAgeMinutes?: number;
  /** Readings older than the last 15 min (oldest first), for the 30-min look back. */
  earlier?: Array<{ minutesAgo: number; value: number }>;
  curve?: number[];
} = {}): MealForecastData {
  const at = options.at ?? now;
  const glucose = options.glucose ?? 210;
  const per5 = options.per5 ?? 0;
  const age = options.readingAgeMinutes ?? 1;
  const recent = [3, 2, 1, 0].map((back) => ({ at: minutesAgo(age + back * 5, at), value: glucose - per5 * back }));
  const earlier = (options.earlier ?? []).map((reading) => ({ at: minutesAgo(reading.minutesAgo, at), value: reading.value }));
  const readings = [...earlier, ...recent];
  return {
    readings: readings.filter((reading) => Date.parse(reading.at) >= at.getTime() - 40 * 60_000),
    history_readings: readings,
    prediction: {
      source: 'OPENAPS',
      system: 'TRIO',
      computed_at: minutesAgo(options.loopAgeMinutes ?? 1, at),
      bg: glucose,
      carbs_req_g: null,
      iob_u: options.iob === undefined ? 0 : options.iob,
      cob_g: options.cob ?? 0,
      isf_mgdl_per_u: options.isf ?? 100,
      icr_g_per_u: 10,
      eventual_bg: glucose,
      target_mgdl: options.target ?? 100,
      min_pred_bg: options.minPred === undefined ? 160 : options.minPred,
      curves: { IOB: options.curve ?? [glucose, glucose, glucose, glucose, glucose, glucose, glucose] },
    },
    profile_isf: options.isf ?? 100,
    profile_target: options.target ?? 100,
    profile_target_high: null,
    profile_units: 'mg/dl',
    timezone: 'Europe/Warsaw',
    calibration: noCalibration,
  };
}

const clear: DoseOptInInput = { recent_doses: [], recent_carbs: { last_at: null }, recent_guard: { last_at: null } };

const calc = (carbs: number, forecast: MealForecastData, optIn: DoseOptInInput | null = clear, extra: { at?: Date; step?: number; later?: boolean } = {}) =>
  computeDoseCalculation({ now: extra.at ?? now, carbs_g: carbs, icr_g_per_u: 10, step: extra.step ?? 0.1, data: forecast, opt_in: optIn, later_part: extra.later ? { dose_u: 2 } : undefined });

describe('dose-calculator.v2: the opt-in higher dose', () => {
  it('is version 3 (v2 + the forecast nudge) and offers nothing to callers that do not ask (cards, parts, WBT)', () => {
    const result = calc(0, data({ per5: 4, iob: 0.3 }), null);
    expect(result.policy_version).toBe('dose-calculator.v3');
    expect(result).toMatchObject({ higher_u: null, higher_gate: 'NOT_REQUESTED', default_u: 0 });
  });

  it('0 g: half of (glucose + trend − target) / ISF − IOB, rounded down to the step', () => {
    // (210 + 12 − 100) / 100 − 0,3 = 0,92; half 0,46 → 0,4 j.
    const result = calc(0, data({ per5: 4, iob: 0.3 }));
    expect(result).toMatchObject({ default_u: 0, higher_u: 0.4, higher_reason_code: 'CORRECTION_ONLY', higher_gate: null });
    expect(result.higher_breakdown).toMatchObject({ base_u: 0, glucose_mgdl: 210, trend_mgdl: 12, target_mgdl: 100, isf_mgdl_per_u: 100, iob_subtracted_u: 0.3, full_correction_u: 0.92, half_u: 0.46, extra_u: 0.4, capped: false, fraction: 0.5 });
    expect(result.higher_summary).toBe('Korekta: +0,4 j (połowa wyliczenia: glukoza 210 i rośnie, aktywna insulina 0,3 j)');
    expect(result.higher_formula).toBe('Korekta: 0,5 × ((210 + 12 − 100) / 100 − IOB 0,3 j) = 0,46 j → 0,4 j');
  });

  it('0 g: never counts COB, and a slow rise is not said', () => {
    const result = calc(0, data({ per5: 1, iob: 0, cob: 40 }));
    // (210 + 3 − 100) / 100 = 1,13; half 0,565 → 0,5 j (COB 40 g adds nothing).
    expect(result.higher_u).toBe(0.5);
    expect(result.higher_summary).toBe('Korekta: +0,5 j (połowa wyliczenia: glukoza 210)');
  });

  it('caps the extra at 1 U', () => {
    const result = calc(0, data({ glucose: 350, isf: 50, iob: 0 }));
    expect(result.higher_u).toBe(1);
    expect(result.higher_breakdown).toMatchObject({ half_u: 2.5, capped: true, extra_u: 1 });
    expect(result.higher_formula).toContain('najwyżej 1 j');
  });

  it('a meal: carbs / ICR plus half of (glucose − target) / ISF − IOB, no trend, no COB', () => {
    // 30 g / 10 = 3 j; (190 − 100) / 100 − 0,1 = 0,8 → 0,4 j; the trend +6 / 15 min is not counted.
    const result = calc(30, data({ glucose: 190, per5: 2, iob: 0.1, cob: 20 }));
    expect(result).toMatchObject({ default_u: 3, limited_by: 'ICR', higher_u: 3.4, higher_reason_code: 'MEAL_TOP_UP' });
    expect(result.higher_breakdown).toMatchObject({ base_u: 3, trend_mgdl: null, extra_u: 0.4 });
    expect(result.higher_summary).toBe('+0,4 j korekty do przelicznika (glukoza 190, aktywna insulina 0,1 j)');
    expect(result.higher_formula).toBe('30 g / ICR 10 = 3 j; korekta: 0,5 × ((190 − 100) / 100 − IOB 0,1 j) = 0,4 j → 0,4 j; razem 3,4 j');
  });

  it('the lower mode wins: no higher dose while the calculator lowered the default', () => {
    const result = calc(30, data({ glucose: 190, iob: 2 }));
    // v3: the loop's flat line at 190 moves the calculator's default halfway to carbs / ICR (FORECAST): still lowered.
    expect(result.limited_by).toBe('FORECAST');
    expect(result).toMatchObject({ higher_u: null, higher_gate: 'DOSE_LOWERED' });
    const v1Only = computeDoseCalculation({ now, carbs_g: 30, icr_g_per_u: 10, step: 0.1, data: data({ glucose: 190, iob: 2 }), opt_in: clear, forecast_nudge: false });
    expect(v1Only).toMatchObject({ limited_by: 'CALCULATOR', higher_u: null, higher_gate: 'DOSE_LOWERED' });
  });

  it('is offered only from one pump step', () => {
    // (152 − 100) / 100 − 0,4 = 0,12; half 0,06 < 0,1.
    expect(calc(0, data({ glucose: 152, iob: 0.4 }))).toMatchObject({ higher_u: null, higher_gate: 'BELOW_STEP' });
    expect(calc(0, data({ glucose: 152, iob: 0.4 }), clear, { step: 0.05 })).toMatchObject({ higher_u: 0.05 });
  });

  describe('gates', () => {
    const cases: Array<[string, () => ReturnType<typeof calc>, string]> = [
      ['glucose below 150 by day', () => calc(0, data({ glucose: 149 })), 'GLUCOSE_BELOW_THRESHOLD'],
      ['glucose below 180 at night (03:00 in the profile zone)', () => calc(0, data({ at: night, glucose: 175 }), clear, { at: night }), 'GLUCOSE_BELOW_THRESHOLD'],
      ['a falling trend (0 g)', () => calc(0, data({ per5: -1 })), 'TREND'],
      ['a meal rising faster than +30 / 15 min', () => calc(30, data({ glucose: 190, per5: 11 })), 'TREND'],
      ['a meal with a falling trend', () => calc(30, data({ glucose: 190, per5: -1 })), 'TREND'],
      ['a bolus 60 min ago', () => calc(0, data(), { ...clear, recent_doses: [{ at: minutesAgo(60), units: 0.5 }] }), 'RECENT_INSULIN'],
      ['an SMB of 0,1 U 80 min ago', () => calc(0, data(), { ...clear, recent_doses: [{ at: minutesAgo(80), units: 0.1 }] }), 'RECENT_INSULIN'],
      ['an unknown bolus history', () => calc(0, data(), { ...clear, recent_doses: null }), 'RECENT_INSULIN'],
      ['carbs 100 min ago (0 g)', () => calc(0, data(), { ...clear, recent_carbs: { last_at: minutesAgo(100) } }), 'RECENT_CARBS'],
      ['unknown carbs (0 g)', () => calc(0, data(), { ...clear, recent_carbs: null }), 'RECENT_CARBS'],
      ['a stale reading', () => calc(0, data({ readingAgeMinutes: 16 })), 'STALE_DATA'],
      ['a stale loop', () => calc(0, data({ loopAgeMinutes: 16 })), 'STALE_DATA'],
      ['minPredBG below 54 (0 g)', () => calc(0, data({ minPred: 50 })), 'LOOP_FORECAST_LOW'],
      ['minPredBG below 100 (a meal)', () => calc(30, data({ glucose: 190, minPred: 95 })), 'LOOP_FORECAST_LOW'],
      ['no minPredBG and no curve', () => { const forecast = data({ minPred: null }); forecast.prediction!.curves = {}; return calc(0, forecast); }, 'LOOP_FORECAST_LOW'],
      ['a fall 20 min ago', () => calc(0, data({ earlier: [{ minutesAgo: 35, value: 260 }, { minutesAgo: 30, value: 245 }, { minutesAgo: 25, value: 225 }, { minutesAgo: 20, value: 205 }] })), 'RECENT_FALL_OR_LOW'],
      ['a reading below 70 25 min ago', () => calc(0, data({ earlier: [{ minutesAgo: 25, value: 66 }] })), 'RECENT_FALL_OR_LOW'],
      ['a lowered or rescue command 20 min ago', () => calc(0, data(), { ...clear, recent_guard: { last_at: minutesAgo(20) } }), 'RECENT_FALL_OR_LOW'],
      ['an unknown command history', () => calc(0, data(), { ...clear, recent_guard: null }), 'RECENT_FALL_OR_LOW'],
      ['a later part of a meal', () => calc(0, data(), clear, { later: true }), 'LATER_PART'],
      ['carbs first (a low near)', () => calc(0, data({ glucose: 210, curve: [210, 150, 90, 60, 50, 45, 45] })), 'CARBS_FIRST'],
    ];
    for (const [name, run, gate] of cases) {
      it(`none for ${name}`, () => {
        const result = run();
        expect(result.higher_u, name).toBeNull();
        expect(result.higher_gate, name).toBe(gate);
      });
    }

    it('lets through what the gates leave open', () => {
      expect(calc(0, data({ glucose: 150 })).higher_u).toBe(0.2); // 150 by day; half of 0,5
      expect(calc(0, data({ at: night, glucose: 180 }), clear, { at: night }).higher_u).toBe(0.4);
      expect(calc(0, data(), { ...clear, recent_doses: [{ at: minutesAgo(80), units: 0.05 }, { at: minutesAgo(95), units: 3 }] }).higher_u).toBe(0.5);
      expect(calc(30, data({ glucose: 190 }), { ...clear, recent_carbs: { last_at: minutesAgo(10) } }).higher_u).toBe(3.4); // the meal's own carbs
      expect(calc(30, data({ glucose: 190, per5: 10 })).higher_u).toBe(3.4); // +30 / 15 min still in
      expect(calc(0, data({ minPred: 54 })).higher_u).toBe(0.5);
      expect(calc(0, data({ earlier: [{ minutesAgo: 35, value: 66 }] })).higher_u).toBe(0.5); // the low before the 30 min
    });
  });

  describe('danger checks follow the chosen source', () => {
    it('the higher dose itself never warns DOSE_ABOVE_CALCULATOR, more than it still does', () => {
      const correction = calc(0, data({ glucose: 350, isf: 50, iob: 0 }));
      expect(doseAboveCalculatorWarning(correction.higher_u!, correction)).toBeNull();
      const meal = calc(30, data({ glucose: 190, iob: 0.1 }));
      expect(dangerReferenceU(meal)).toBeGreaterThanOrEqual(meal.higher_u!);
      expect(doseAboveCalculatorWarning(meal.higher_u!, meal)).toBeNull();
      expect(doseAboveCalculatorWarning(round2(dangerReferenceU(meal)! + 1), meal)).toMatchObject({ code: 'DOSE_ABOVE_CALCULATOR' });
    });

    it('the higher dose is the reference when it is above the calculator\'s (no warning by itself, above it warns)', () => {
      const meal = calc(30, data({ glucose: 190, iob: 0.1 }));
      const lowReference = { ...meal, reference_u: 2 };
      expect(dangerReferenceU(lowReference)).toBe(3.4);
      expect(doseAboveCalculatorWarning(3.4, lowReference)).toBeNull();
      const above = doseAboveCalculatorWarning(4.3, lowReference)!;
      expect(above).toMatchObject({ code: 'DOSE_ABOVE_CALCULATOR', key: 'DOSE_ABOVE_CALCULATOR:4.3:3.4' });
      expect(above.message).toContain('dawka z połową korekty: 3,4 j');
    });

    it('up to the higher dose is no DOSE_DIFFERS_FROM_ICR, above it is', () => {
      const context: RemoteCommandContext = { now: now.toISOString(), glucose: { value: 190, observed_at: minutesAgo(1), delta: 0 }, lowest_recent_glucose: 190, loop: { iob_units: 0.1, cob_grams: 0, observed_at: minutesAgo(1) }, last_bolus: null, bolus_history_known: true, recent_remote_bolus: null, icr_g_per_u: 10, in_flight_command_id: null };
      const codes = (insulin: number, higher: number | null) => evaluateRemoteCommand({ carbs_g: 30, insulin_u: insulin, bolus_step: 0.1, context, calculator_default_u: 3, calculator_higher_u: higher }).warnings.map((warning) => warning.code);
      expect(codes(4, 4)).not.toContain('DOSE_DIFFERS_FROM_ICR');
      expect(codes(4, null)).toContain('DOSE_DIFFERS_FROM_ICR');
      expect(codes(4.1, 4)).toContain('DOSE_DIFFERS_FROM_ICR');
    });
  });
});

class Store implements RemoteCommandStore {
  rows: RemoteCommandRecord[] = [];
  constructor(private readonly recent: RemoteCommandRecord[] = []) {}
  async insert(command: NewRemoteCommand): Promise<RemoteCommandRecord> {
    const record = { ...command, id: `00000000-0000-4000-8000-${String(this.rows.length + 1).padStart(12, '0')}`, status: 'AUTHORIZED', trio_message: null, status_message: null, authorized_at: now.toISOString(), sent_at: null, answered_at: null, loop_action_id: null, meal_record_id: null, matched_at: null } as RemoteCommandRecord;
    this.rows.push(record);
    return record;
  }
  async get() { return null; }
  async list() { return []; }
  async findInFlight() { return null; }
  async recordSentAt() {}
  async listForProposal() { return []; }
  async listForPlannedBolus() { return []; }
  async listWbtForMeal() { return []; }
  async findRecentWithInsulin() { return null; }
  async transition() { return null; }
  async listRecent() { return this.recent; }
  async listRecentMealBoluses() { return []; }
}

const baseContext = (glucose: number): Omit<RemoteCommandContext, 'in_flight_command_id' | 'recent_remote_bolus'> => ({
  now: now.toISOString(),
  glucose: { value: glucose, observed_at: minutesAgo(1), delta: 0 },
  lowest_recent_glucose: glucose,
  loop: { iob_units: 0.1, cob_grams: 0, observed_at: minutesAgo(1) },
  last_bolus: null,
  icr_g_per_u: 10,
  bolus_history_known: true,
  pump_bolus_step: 0.1,
  recent_insulin: { window_minutes: 120, total_u: 0, manual_u: 0, smb_u: 0, remote_u: 0, newest_at: null, boluses: [], smbs: [] },
  recent_remote_boluses: [],
});

describe('dose-calculator.v2 in the remote-command service', () => {
  const forecast = { ...data({ glucose: 190, iob: 0.1 }), last_carbs_2h_at: null };
  const service = (recent: RemoteCommandRecord[] = [], context = baseContext(190), meal = forecast) => new RemoteCommandsService(new Store(recent), async () => ({ ...context, meal_forecast: meal }));

  it('the Bolus tab gets the higher dose, a chat card or a WBT does not', async () => {
    const tab = await service().preview('p1', { carbs_g: 30, insulin_u: null, bolus_step: 0.1, dose_default: 'CALCULATOR' }, now);
    expect(tab.insulin_u).toBe(3);
    expect(tab.dose_calculation).toMatchObject({ default_u: 3, higher_u: 3.4, higher_reason_code: 'MEAL_TOP_UP' });
    const wbt = await service().preview('p1', { carbs_g: 30, insulin_u: null, bolus_step: 0.1, source: 'WBT_SCREEN' }, now);
    expect(wbt.dose_calculation).toMatchObject({ higher_u: null, higher_gate: 'NOT_REQUESTED' });
  });

  it('sending the higher dose needs no warning about it; above it still warns', async () => {
    const preview = await service().preview('p1', { carbs_g: 30, insulin_u: 3.4, bolus_step: 0.1 }, now);
    expect(preview.warnings.map((warning) => warning.code)).toEqual([]);
    await expect(service().authorize('p1', 'u1', { source: 'BOLUS_SCREEN', carbs_g: 30, insulin_u: 3.4, bolus_step: 0.1, device_id: 'd', acknowledged_warnings: [] }, now)).resolves.toMatchObject({ insulin_u: 3.4 });
    // The reference is 3,8 j (calculator); 5 j is 1,2 j above it (≥ 25 %), as before v2.
    const more = await service().preview('p1', { carbs_g: 30, insulin_u: 5, bolus_step: 0.1 }, now);
    expect(more.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(['DOSE_DIFFERS_FROM_ICR', 'DOSE_ABOVE_CALCULATOR']));
  });

  it('0 g: the correction alone, and an insulin-only dose is sent as before', async () => {
    const zero = { ...data({ glucose: 210, per5: 4, iob: 0.3 }), last_carbs_2h_at: null };
    const context = { ...baseContext(210), loop: { iob_units: 0.3, cob_grams: 0, observed_at: minutesAgo(1) } };
    const empty = await service([], context, zero).preview('p1', { carbs_g: 0, insulin_u: null, bolus_step: 0.1 }, now);
    expect(empty.dose_calculation).toMatchObject({ default_u: 0, higher_u: 0.4, higher_reason_code: 'CORRECTION_ONLY' });
    await expect(service([], context, zero).authorize('p1', 'u1', { source: 'BOLUS_SCREEN', carbs_g: 0, insulin_u: 0.4, bolus_step: 0.1, device_id: 'd', acknowledged_warnings: [] }, now)).resolves.toMatchObject({ insulin_u: 0.4, carbs_g: 0 });
  });

  it('a carbs command or a lowered dose of the last minutes, or unknown carbs, holds it back', async () => {
    const zero = { ...data({ glucose: 210, per5: 4, iob: 0.3 }), last_carbs_2h_at: null };
    const carbsCommand = { id: 'c1', carbs_g: 20, insulin_u: 0, status: 'SUCCEEDED', source: 'BOLUS_SCREEN', purpose: null, authorized_at: minutesAgo(50), sent_at: minutesAgo(50), context: null } as unknown as RemoteCommandRecord;
    const dropped = { id: 'c2', carbs_g: 0, insulin_u: 0.5, status: 'SUCCEEDED', source: 'BOLUS_SCREEN', purpose: null, authorized_at: minutesAgo(20), sent_at: minutesAgo(20), context: { dose_calculation: { limited_by: 'DROP', drop: { dose_u: 0.5 } } } } as unknown as RemoteCommandRecord;
    expect((await service([carbsCommand], baseContext(210), zero).preview('p1', { carbs_g: 0, insulin_u: null, bolus_step: 0.1 }, now)).dose_calculation?.higher_gate).toBe('RECENT_CARBS');
    expect((await service([dropped], baseContext(210), zero).preview('p1', { carbs_g: 0, insulin_u: null, bolus_step: 0.1 }, now)).dose_calculation?.higher_gate).toBe('RECENT_INSULIN');
    const { last_carbs_2h_at: _unknown, ...unread } = zero;
    expect((await service([], baseContext(210), unread).preview('p1', { carbs_g: 0, insulin_u: null, bolus_step: 0.1 }, now)).dose_calculation?.higher_gate).toBe('RECENT_CARBS');
    const rescue = { ...dropped, insulin_u: 0, carbs_g: 0, source: 'RESCUE_CARBS', context: null } as unknown as RemoteCommandRecord;
    expect((await service([rescue], baseContext(210), zero).preview('p1', { carbs_g: 0, insulin_u: null, bolus_step: 0.1 }, now)).dose_calculation?.higher_gate).toBe('RECENT_FALL_OR_LOW');
  });
});

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

describe('dose-calculator.v2 properties (600 random patients)', () => {
  it('default never above carbs / ICR, higher ≤ default + 1 U, absent under every gate, never warned by itself', () => {
    let seed = 29;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const policy = DOSE_CALCULATOR_POLICY.opt_in;
    let offered = 0;
    let gated = 0;
    for (let index = 0; index < 600; index += 1) {
      const at = random() < 0.25 ? night : now;
      const glucose = Math.round(60 + random() * 300);
      const per5 = Math.round(-8 + random() * 16);
      const iob = Math.round((random() * 4 - 0.5) * 100) / 100;
      const cob = Math.round(random() * 60);
      const isf = Math.round(30 + random() * 170);
      const minPred = random() < 0.1 ? null : Math.round(30 + random() * 250);
      const step = random() < 0.5 ? 0.1 : 0.05;
      const carbs = random() < 0.4 ? 0 : Math.round(random() * 90);
      const later = random() < 0.05;
      const stale = random() < 0.08;
      const earlierLow = random() < 0.08;
      const doseAgo = random() < 0.3 ? Math.round(random() * 150) : null;
      const doseUnits = Math.round(random() * 10) / 20;
      const carbsAgo = random() < 0.3 ? Math.round(random() * 180) : null;
      const guardAgo = random() < 0.15 ? Math.round(random() * 60) : null;
      const unknown = random() < 0.1;
      const forecast = data({ at, glucose, per5, iob, cob, isf, minPred, readingAgeMinutes: stale ? 20 : 1, earlier: earlierLow ? [{ minutesAgo: 22, value: 65 }] : [] });
      const optIn: DoseOptInInput = {
        recent_doses: unknown ? null : doseAgo === null ? [] : [{ at: minutesAgo(doseAgo, at), units: doseUnits }],
        recent_carbs: { last_at: carbsAgo === null ? null : minutesAgo(carbsAgo, at) },
        recent_guard: { last_at: guardAgo === null ? null : minutesAgo(guardAgo, at) },
      };
      const result = computeDoseCalculation({ now: at, carbs_g: carbs, icr_g_per_u: 10, step, data: forecast, opt_in: optIn, later_part: later ? { dose_u: 2 } : undefined });
      const icrDose = later ? 2 : carbs > 0 ? roundDownToStep(carbs / 10, step) : 0;

      // The default never goes above carbs / ICR (the v1 property, kept).
      expect(result.default_u, `#${index}`).toBeLessThanOrEqual(icrDose + 1e-9);

      const trend15 = per5 * 3;
      const threshold = at === night ? policy.night_min_glucose_mgdl : policy.min_glucose_mgdl;
      const gates = [
        later,
        stale,
        glucose < threshold,
        carbs > 0 ? trend15 < 0 || trend15 > policy.meal_trend_max_mgdl : trend15 < 0,
        unknown,
        doseAgo !== null && doseAgo <= policy.recent_dose_minutes && doseUnits >= policy.recent_dose_min_u,
        carbs === 0 && carbsAgo !== null && carbsAgo <= policy.recent_carbs_minutes,
        minPred === null ? false : minPred < (carbs > 0 ? policy.meal_min_pred_mgdl : policy.correction_min_pred_mgdl),
        earlierLow,
        guardAgo !== null && guardAgo <= policy.guard_lookback_minutes,
        result.carbs_first !== null,
        carbs > 0 && result.default_u < icrDose - 1e-9,
      ];
      if (gates.some(Boolean)) {
        gated += 1;
        expect(result.higher_u, `#${index} gated: ${gates.map((gate, at) => (gate ? at : null)).filter((gate) => gate !== null).join(',')}`).toBeNull();
        continue;
      }
      if (result.higher_u === null || result.higher_u === undefined) continue;
      offered += 1;
      // Higher ≤ default + 1 U, at least one step above it, on the step grid.
      expect(result.higher_u, `#${index}`).toBeLessThanOrEqual(result.default_u + policy.max_extra_u + 1e-9);
      expect(result.higher_u, `#${index}`).toBeGreaterThanOrEqual(result.default_u + step - 1e-9);
      expect(roundDownToStep(result.higher_u, step), `#${index}`).toBeCloseTo(result.higher_u, 9);
      // Half the correction at most.
      const full = (glucose + (carbs > 0 ? 0 : result.higher_breakdown!.trend_mgdl ?? 0) - result.higher_breakdown!.target_mgdl) / isf - Math.max(0, iob);
      expect(result.higher_u - result.default_u, `#${index}`).toBeLessThanOrEqual(0.5 * Math.max(0, full) + 0.01);
      // Choosing it never warns by itself.
      expect(doseAboveCalculatorWarning(result.higher_u, result), `#${index}`).toBeNull();
      expect(doseExceedsFormula(result.higher_u, dangerReferenceU(result)), `#${index}`).toBe(false);
    }
    expect(offered).toBeGreaterThan(20);
    expect(gated).toBeGreaterThan(200);
  });
});
