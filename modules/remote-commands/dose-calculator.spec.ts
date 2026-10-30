import { describe, expect, it } from 'vitest';
import { GLUCOSE_FORECAST_CALIBRATION } from '@modules/glucose-forecast/application/forecast-calibration';
import {
  calculatorFormula,
  calculatorUnavailableWarning,
  computeDoseCalculation,
  lowGlucoseGate,
  safeDoseCalculation,
  withRemoteBoluses,
  doseAboveCalculatorWarning,
  doseExceedsFormula,
  doseSafetyWarnings,
  insulinWhileLowWarning,
  recentInsulinFrom,
  recentInsulinWarning,
  recentInsulinWindowMinutes,
  withRemoteBolus,
} from './application/dose-calculator';
import { mealForecastDataFrom, type MealForecastData } from './application/meal-dose-forecast';
import { remoteCommandContextFrom } from './application/remote-command-context';

const now = new Date('2026-10-29T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
/** Read without calibration so the numbers stay with the curve (as the card specs do). */
const noCalibration = { ...GLUCOSE_FORECAST_CALIBRATION, version: 'test-none', shrink_by_minutes: { 5: 1 } };

function data(options: {
  glucose?: number;
  /** mg/dL per 5 min, over the last 15 min. */
  per5?: number;
  iob?: number | null;
  cob?: number;
  isf?: number;
  target?: number;
  /** The loop's own target (default: `target`); null: the loop names none. */
  loopTarget?: number | null;
  targetHigh?: number | null;
  units?: string;
  loopAgeMinutes?: number;
  readingAgeMinutes?: number;
  eventual?: number | null;
  insulinReq?: number | null;
  /** The loop's IOB curve (default: flat at the glucose). */
  curve?: number[];
  noLoop?: boolean;
} = {}): MealForecastData {
  const glucose = options.glucose ?? 150;
  const per5 = options.per5 ?? 0;
  const age = options.readingAgeMinutes ?? 1;
  const readings = [3, 2, 1, 0].map((stepsBack) => ({ at: minutesAgo(age + stepsBack * 5), value: glucose - per5 * stepsBack }));
  return {
    readings,
    prediction: options.noLoop ? null : {
      source: 'OPENAPS',
      system: 'TRIO',
      computed_at: minutesAgo(options.loopAgeMinutes ?? 1),
      bg: glucose,
      carbs_req_g: null,
      insulin_req_u: options.insulinReq ?? null,
      iob_u: options.iob === undefined ? 0 : options.iob,
      cob_g: options.cob ?? 0,
      isf_mgdl_per_u: options.isf ?? 100,
      icr_g_per_u: 10,
      eventual_bg: options.eventual ?? glucose,
      target_mgdl: options.loopTarget === null ? null : options.loopTarget ?? options.target ?? 100,
      curves: { IOB: options.curve ?? [glucose, glucose, glucose, glucose, glucose, glucose, glucose] },
    },
    profile_isf: options.isf ?? 100,
    profile_target: options.target ?? 100,
    profile_target_high: options.targetHigh ?? null,
    profile_units: options.units ?? 'mg/dl',
    calibration: noCalibration,
  };
}

const calc = (carbs: number, forecast: MealForecastData | null, extra: { icr?: number | null; step?: number } = {}) =>
  computeDoseCalculation({ now, carbs_g: carbs, icr_g_per_u: extra.icr === undefined ? 10 : extra.icr, step: extra.step ?? 0.05, data: forecast });

describe('dose-calculator.v1: the loop-style calculator, lowering only', () => {
  it('keeps carbs / ICR when the calculator asks for more (no automatic correction upwards)', () => {
    // 30 / 10 + (150 − 100) / 100 − IOB 0,3 = 3,2 j > 3 j.
    const result = calc(30, data({ glucose: 150, iob: 0.3 }));
    expect(result).toMatchObject({ icr_dose_u: 3, calculator_u: 3.2, default_u: 3, limited_by: 'ICR', calculated: true, reference_u: 3.2 });
    expect(result.breakdown).toMatchObject({ carbs_u: 3, correction_u: 0.5, iob_subtracted_u: 0.3, target_mgdl: 100, isf_mgdl_per_u: 100 });
    expect(result.summary).toBe('Z przelicznika 3 j · kalkulator pętli 3,2 j (IOB 0,3 j, glukoza 150).');
  });

  it('lowers the dose for insulin on board: 30 / 10 + (120 − 100) / 100 − IOB 2 = 1,2 j', () => {
    const result = calc(30, data({ glucose: 120, iob: 2 }));
    expect(result).toMatchObject({ icr_dose_u: 3, calculator_u: 1.2, default_u: 1.2, limited_by: 'CALCULATOR', reference_u: 1.2 });
    expect(result.summary).toBe('Kalkulator pętli: 1,2 j zamiast 3 j z przelicznika — IOB 2 j, glukoza 120.');
    expect(calculatorFormula(result)).toBe('30 g / ICR 10 + (120 − 100) / 100 − IOB 2 j = 1,2 j');
    // The ICR dose sent anyway is dangerously above it: 3 − 1,2 = 1,8 j ≥ max(0,5, 25%).
    expect(doseAboveCalculatorWarning(3, result)).toMatchObject({ code: 'DOSE_ABOVE_CALCULATOR', severity: 'DANGER', key: 'DOSE_ABOVE_CALCULATOR:3:1.2' });
    expect(doseAboveCalculatorWarning(3, result)!.message).toContain('kalkulator pętli: 30 g / ICR 10 + (120 − 100) / 100 − IOB 2 j = 1,2 j');
    expect(doseAboveCalculatorWarning(1.6, result)).toBeNull();
  });

  it('counts a falling trend over 15 min and the drop reduction, the lower one wins', () => {
    // −10 mg/dL per 5 min: 110 − 30 = 80 in 15 min; Trio's curve goes down to 75.
    const result = calc(30, data({ glucose: 110, per5: -10, iob: 0.5, curve: [110, 102, 95, 88, 82, 78, 75] }));
    expect(result.breakdown).toMatchObject({ trend_mgdl: -30, projected_mgdl: 80, correction_u: -0.2 });
    expect(result.calculator_u).toBe(2.3);
    expect(result.default_u).toBeLessThanOrEqual(2.3);
    if (result.drop) expect(result.default_u).toBeLessThanOrEqual(result.drop.dose_u);
    expect(result.summary).toMatch(/spada|spadek/);
  });

  it('takes the dose to 0 below 70 mg/dL (carbs first) and asks for a separate confirmation of any insulin', () => {
    const result = calc(30, data({ glucose: 65, iob: 0.2 }));
    expect(result).toMatchObject({ default_u: 0, limited_by: 'CARBS_FIRST', reference_u: 0, carbs_first: { glucose_mgdl: 65 } });
    expect(result.summary).toMatch(/^Najpierw węglowodany: glukoza 65 mg\/dL, insulina 0 j \(z przelicznika 3 j\)\.$/);
    expect(insulinWhileLowWarning(1, result)).toMatchObject({ code: 'INSULIN_WHILE_LOW', severity: 'DANGER' });
    expect(insulinWhileLowWarning(0, result)).toBeNull();
    // Only the low warning: the dose checks say nothing more while carbs come first.
    expect(doseSafetyWarnings({ insulin_u: 3, calculation: result, recent: null }).map((warning) => warning.code)).toEqual(['INSULIN_WHILE_LOW']);
  });

  it('falls back to carbs / ICR without the loop\'s fresh IOB or a fresh reading, and says why', () => {
    const staleLoop = calc(30, data({ glucose: 120, iob: 2, loopAgeMinutes: 30 }));
    expect(staleLoop).toMatchObject({ calculated: false, calculator_u: null, default_u: 3, limited_by: 'ICR', fallback_reason: 'brak aktualnego IOB z Trio', reference_u: null });
    expect(staleLoop.summary).toBe('Z przelicznika 3 j · kalkulator pętli niedostępny: brak aktualnego IOB z Trio.');
    const staleReading = calc(30, data({ glucose: 120, iob: 2, readingAgeMinutes: 20, loopAgeMinutes: 20 }));
    expect(staleReading).toMatchObject({ calculated: false, default_u: 3, fallback_reason: 'brak świeżego odczytu glukozy' });
    expect(calc(30, null)).toMatchObject({ calculated: false, default_u: 3, fallback_reason: 'brak danych glukozy i pętli' });
    // No ICR: nothing to pre-fill.
    expect(calc(30, data({ iob: 0 }), { icr: null })).toMatchObject({ icr_dose_u: null, default_u: 0 });
  });

  it('reads mmol/L ISF and targets as the other helpers do (×18)', () => {
    // ISF 5,5 mmol/L per U = 99 mg/dL, target 5,5 mmol/L = 99 mg/dL.
    const result = calc(30, data({ glucose: 135, iob: 1, isf: 5.5, target: 5.5, units: 'mmol' }));
    expect(result.breakdown).toMatchObject({ isf_mgdl_per_u: 99, target_mgdl: 99 });
    // 3 + (135 − 99) / 99 − 1 = 2,36 → 2,35 j.
    expect(result.calculator_u).toBe(2.35);
  });

  it('rounds down to the pump step', () => {
    // 25 / 10 + 0 − IOB 0,32 = 2,18 j.
    expect(calc(25, data({ glucose: 100, iob: 0.32 }), { step: 0.05 }).default_u).toBe(2.15);
    expect(calc(25, data({ glucose: 100, iob: 0.32 }), { step: 0.1 }).default_u).toBe(2.1);
    expect(calc(25, data({ glucose: 100, iob: 0.32 }), { step: 0.1 }).icr_dose_u).toBe(2.5);
  });

  it('never adds insulin for a negative IOB; counts COB of earlier carbs up to 120 g', () => {
    expect(calc(30, data({ glucose: 100, iob: -1 })).calculator_u).toBe(3);
    // COB 20 g of an earlier meal with its bolus in IOB 2 j: (30 + 20) / 10 − 2 = 3 j, carbs / ICR stays.
    expect(calc(30, data({ glucose: 100, iob: 2, cob: 20 }))).toMatchObject({ calculator_u: 3, default_u: 3, limited_by: 'ICR' });
    expect(calc(10, data({ glucose: 100, iob: 0, cob: 500 })).breakdown).toMatchObject({ cob_g: 120, cob_u: 12 });
  });

  it("names the loop's own lower need while a dose is proposed (eventualBG below target, insulinReq below 0)", () => {
    const eventual = calc(30, data({ glucose: 120, iob: 0.5, eventual: 85 }));
    expect(eventual.loop_signal).toEqual({ system_name: 'Trio', insulin_req_u: null, eventual_mgdl: 85, target_mgdl: 100 });
    expect(eventual.summary).toContain('Trio: prognoza 85 mg/dL, poniżej celu 100');
    const insulinReq = calc(30, data({ glucose: 120, iob: 1.5, insulinReq: -0.4 }));
    expect(insulinReq.summary).toContain('Trio: insulinReq −0,4 j');
    expect(calc(30, data({ glucose: 120, iob: 0.5 })).loop_signal).toBeNull();
  });

  it('a later part: IOB and COB are not counted again (its dose took them off); only a low or falling glucose lowers it', () => {
    const later = (forecast: MealForecastData, dose: number) => computeDoseCalculation({ now, carbs_g: 0, icr_g_per_u: 10, step: 0.05, data: forecast, later_part: { dose_u: dose } });
    expect(later(data({ glucose: 180, iob: 3, cob: 40 }), 1.5)).toMatchObject({ default_u: 1.5, limited_by: 'ICR', breakdown: { iob_u: null, cob_g: 0, iob_subtracted_u: 0 } });
    // 1,5 + (90 − 30 − 100) / 100 = 1,1 j.
    const falling = later(data({ glucose: 90, per5: -10, iob: 3 }), 1.5);
    expect(falling.calculator_u).toBe(1.1);
    expect(falling.default_u).toBeLessThanOrEqual(1.1);
    expect(falling.summary).toMatch(/z planu/);
    expect(later(data({ glucose: 66 }), 1.5)).toMatchObject({ default_u: 0, limited_by: 'CARBS_FIRST' });
  });

  it('property: the default never exceeds carbs / ICR, never goes below 0, and never exceeds the calculator or the drop', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let index = 0; index < 600; index += 1) {
      const glucose = Math.round(45 + random() * 300);
      const per5 = Math.round(-15 + random() * 30);
      const forecast = data({
        glucose,
        per5,
        iob: random() < 0.1 ? null : Math.round((-1 + random() * 6) * 100) / 100,
        cob: Math.round(random() * 80),
        isf: random() < 0.2 ? Math.round((1.5 + random() * 8) * 10) / 10 : Math.round(30 + random() * 200),
        target: random() < 0.2 ? 5.5 : Math.round(80 + random() * 60),
        units: random() < 0.2 ? 'mmol' : 'mg/dl',
        loopAgeMinutes: random() < 0.15 ? 40 : 1,
        curve: Array.from({ length: 19 }, (_, step) => Math.max(40, glucose + per5 * step * (random() < 0.5 ? 1 : 0.5))),
      });
      const carbs = Math.round(random() * 120);
      const icr = Math.round((3 + random() * 25) * 10) / 10;
      const step = random() < 0.5 ? 0.05 : 0.1;
      const result = calc(carbs, forecast, { icr, step });
      const icrDose = result.icr_dose_u ?? 0;
      expect(result.default_u).toBeGreaterThanOrEqual(0);
      expect(result.default_u).toBeLessThanOrEqual(icrDose + 1e-9);
      if (result.calculator_u !== null) expect(result.default_u).toBeLessThanOrEqual(result.calculator_u + 1e-9);
      if (result.drop) expect(result.default_u).toBeLessThanOrEqual(result.drop.dose_u + 1e-9);
      // Every default is a dose the pump can give.
      expect(Math.abs(Math.round(result.default_u / step) * step - result.default_u)).toBeLessThan(1e-6);
    }
  });
});

describe('dose-calculator.v1: dangerous doses and recent insulin', () => {
  it('a dose is dangerous at max(0,5 j, 25% of the formula) above it, not for small differences', () => {
    expect(doseExceedsFormula(1.4, 1)).toBe(false);
    expect(doseExceedsFormula(1.5, 1)).toBe(true);
    expect(doseExceedsFormula(4.9, 4)).toBe(false);
    expect(doseExceedsFormula(5, 4)).toBe(true);
    expect(doseExceedsFormula(0.45, 0)).toBe(false);
    expect(doseExceedsFormula(0.5, 0)).toBe(true);
    expect(doseExceedsFormula(3, null)).toBe(false);
  });

  it('counts manual boluses and SMBs of the window, and a remote bolus Nightscout does not show yet', () => {
    expect(recentInsulinWindowMinutes(null)).toBe(120);
    expect(recentInsulinWindowMinutes(6)).toBe(120);
    expect(recentInsulinWindowMinutes(5)).toBe(100);
    expect(recentInsulinWindowMinutes(3)).toBe(90);
    const recent = recentInsulinFrom({
      now,
      window_minutes: 120,
      boluses: [{ at: minutesAgo(150), units: 2 }, { at: minutesAgo(60), units: 0.8 }],
      smbs: [{ at: minutesAgo(40), units: 0.3 }, { at: minutesAgo(20), units: 0.2 }],
    });
    // Nightscout's boluses from the window's start minus 10 min are kept for matching remote boluses (the 150-min one is not).
    expect(recent).toEqual({ window_minutes: 120, total_u: 1.3, manual_u: 0.8, smb_u: 0.5, remote_u: 0, newest_at: minutesAgo(20), boluses: [{ at: minutesAgo(60), units: 0.8 }], smbs: [{ at: minutesAgo(40), units: 0.3 }, { at: minutesAgo(20), units: 0.2 }] });
    const withRemote = withRemoteBolus(recent, { at: minutesAgo(5), units: 1 }, now, [{ at: minutesAgo(60), units: 0.8 }]);
    expect(withRemote).toMatchObject({ total_u: 2.3, remote_u: 1, newest_at: minutesAgo(5) });
    // Already in Nightscout: counted once.
    expect(withRemoteBolus(recent, { at: minutesAgo(61), units: 0.8 }, now, [{ at: minutesAgo(60), units: 0.8 }])).toBe(recent);
  });

  it('warns about recent insulin only when the calculator could not count it, or the dose is still above it', () => {
    const recent = recentInsulinFrom({ now, window_minutes: 120, boluses: [{ at: minutesAgo(50), units: 1.2 }], smbs: [{ at: minutesAgo(20), units: 0.4 }] })!;
    const blind = calc(30, data({ glucose: 140, iob: 2, loopAgeMinutes: 40 }));
    expect(recentInsulinWarning(3, blind, recent)).toMatchObject({ code: 'RECENT_INSULIN', severity: 'DANGER' });
    expect(recentInsulinWarning(3, blind, recent)!.message).toContain('W ostatnich 120 min podano 1,6 j (bolusy 1,2 j, SMB 0,4 j).');
    const counted = calc(30, data({ glucose: 140, iob: 1.6 }));
    // 3 + 0,4 − 1,6 = 1,8 j: the default needs no warning, a little more does, far more is the calculator's warning.
    expect(recentInsulinWarning(1.8, counted, recent)).toBeNull();
    expect(recentInsulinWarning(2, counted, recent)).toMatchObject({ code: 'RECENT_INSULIN' });
    const both = doseSafetyWarnings({ insulin_u: 3, calculation: counted, recent });
    expect(both.map((warning) => warning.code)).toEqual(['DOSE_ABOVE_CALCULATOR']);
    expect(both[0].message).toContain('W ostatnich 120 min podano 1,6 j');
    // Less than 1 j in the window: nothing.
    expect(recentInsulinWarning(3, blind, { ...recent, total_u: 0.6 })).toBeNull();
    // A pre-bolus: only the low check.
    expect(doseSafetyWarnings({ insulin_u: 3, calculation: counted, recent, calculator_checks: false })).toEqual([]);
  });
});

describe('dose-calculator.v1: review fixes 2026-10-29', () => {
  it('M3: keeps a high temporary target (exercise 200) instead of discarding it; clamps to 80–250; skips absurd values', () => {
    // Trio's temporary target 200: (150 − 200) / 100 = −0,5 j; 30 / 10 − 0,5 = 2,5 j (before: target 100, 3 j).
    const exercise = calc(30, data({ glucose: 150, iob: 0, loopTarget: 200 }));
    expect(exercise.breakdown).toMatchObject({ target_mgdl: 200, correction_u: -0.5 });
    expect(exercise).toMatchObject({ calculator_u: 2.5, default_u: 2.5, limited_by: 'CALCULATOR' });
    // 300 is clamped to 250; 70 is raised to 80.
    expect(calc(30, data({ glucose: 150, loopTarget: 300 })).breakdown?.target_mgdl).toBe(250);
    expect(calc(30, data({ glucose: 150, loopTarget: 70, target: 70 })).breakdown?.target_mgdl).toBe(80);
    // Absurd values (a unit error, 1000 mg/dL) are skipped: the next candidate (the profile 110), else 100.
    expect(calc(30, data({ glucose: 150, loopTarget: 1000, target: 110 })).breakdown?.target_mgdl).toBe(110);
    expect(calc(30, data({ glucose: 150, loopTarget: 1000, target: 1000 })).breakdown?.target_mgdl).toBe(100);
  });

  it('L5: without the loop\'s target, the middle of the profile range (target_low alone without target_high)', () => {
    expect(calc(30, data({ glucose: 150, loopTarget: null, target: 100, targetHigh: 120 })).breakdown?.target_mgdl).toBe(110);
    expect(calc(30, data({ glucose: 150, loopTarget: null, target: 100 })).breakdown?.target_mgdl).toBe(100);
    // mmol/L profile: 5,5..6,5 → 99..117 → 108.
    expect(calc(30, data({ glucose: 150, loopTarget: null, target: 5.5, targetHigh: 6.5, units: 'mmol', isf: 5.5 })).breakdown?.target_mgdl).toBe(108);
    // The loop's current target wins over the profile.
    expect(calc(30, data({ glucose: 150, loopTarget: 130, target: 100, targetHigh: 120 })).breakdown?.target_mgdl).toBe(130);
    // mealForecastDataFrom reads target_high at now.
    const forecast = mealForecastDataFrom({ now, readings: [], loopStatus: null, therapy: { units: 'mg/dl', timezone: 'UTC', sensitivity_per_u: [['00:00', 100]], target_low: [['00:00', 100]], target_high: [['00:00', 130]] } });
    expect(forecast).toMatchObject({ profile_target: 100, profile_target_high: 130 });
  });

  it('M5: lingering COB cannot inflate the danger reference (30 g, ICR 10, COB 120, IOB 0,5: 14 j is DANGER)', () => {
    const result = calc(30, data({ glucose: 100, iob: 0.5, cob: 120 }));
    // The calculator says 3 + 12 + 0 − 0,5 = 14,5 j, but the reference is carbs / ICR + max(0, correction − IOB) = 3 j.
    expect(result).toMatchObject({ calculator_u: 14.5, default_u: 3, reference_u: 3, reference_capped: true });
    const warning = doseAboveCalculatorWarning(14, result);
    expect(warning).toMatchObject({ code: 'DOSE_ABOVE_CALCULATOR', severity: 'DANGER', key: 'DOSE_ABOVE_CALCULATOR:14:3' });
    expect(warning!.message).toBe('14 j to o 11 j więcej, niż wychodzi z danych (przelicznik 30 g / ICR 10 = 3 j; COB 120 g nie podnosi tej granicy). Większa dawka grozi niedocukrzeniem.');
    // A correction the data call for still counts: glucose 250, IOB 0,5: 3 + (250 − 100) / 100 − 0,5 = 4 j.
    const high = calc(30, data({ glucose: 250, iob: 0.5, cob: 120 }));
    expect(high.reference_u).toBe(4);
    expect(doseAboveCalculatorWarning(4.4, high)).toBeNull();
    expect(doseAboveCalculatorWarning(5, high)).not.toBeNull();
    // Without COB nothing changes: the reference is the calculator.
    expect(calc(30, data({ glucose: 150, iob: 0.3 }))).toMatchObject({ reference_u: 3.2, reference_capped: false });
    // A caregiver's correction while IOB covers it stays DANGER (owner 2026-10-29): 150, IOB 2, 0 g → reference 0.
    const covered = calc(0, data({ glucose: 150, iob: 2, cob: 40 }));
    expect(covered.reference_u).toBe(0);
    expect(doseAboveCalculatorWarning(1, covered)).not.toBeNull();
  });

  it('L1: a stale reading below 70 is carbs first too: default 0 j, and insulin needs the low confirmation', () => {
    const result = calc(30, data({ glucose: 64, iob: 0.2, readingAgeMinutes: 22, loopAgeMinutes: 22 }));
    expect(result).toMatchObject({ default_u: 0, limited_by: 'CARBS_FIRST', reference_u: 0, carbs_first: { level: 'STALE_LOW', glucose_mgdl: 64, reading_age_minutes: 22 } });
    expect(result.summary).toBe('Najpierw węglowodany: ostatni odczyt niski i nieaktualny (64 mg/dL sprzed 22 min), insulina 0 j (z przelicznika 3 j).');
    expect(insulinWhileLowWarning(1, result)).toMatchObject({ code: 'INSULIN_WHILE_LOW', key: 'INSULIN_WHILE_LOW:STALE_LOW:64' });
    expect(insulinWhileLowWarning(1, result)!.message).toMatch(/^Ostatni odczyt glukozy 64 mg\/dL jest niski i nieaktualny: najpierw węglowodany/);
    // A stale reading at or above 70 is still only "calculator unavailable".
    expect(calc(30, data({ glucose: 90, iob: 0.2, readingAgeMinutes: 22, loopAgeMinutes: 22 }))).toMatchObject({ default_u: 3, limited_by: 'ICR', carbs_first: null });
  });

  it('M4: the below-70 gate works from the command\'s glucose without the calculator; a thrown calculator is logged and acknowledged', () => {
    expect(lowGlucoseGate({ value: 65, observed_at: minutesAgo(3) }, now)).toEqual({ level: 'BELOW_70', glucose_mgdl: 65 });
    expect(lowGlucoseGate({ value: 65, observed_at: minutesAgo(45) }, now)).toEqual({ level: 'STALE_LOW', glucose_mgdl: 65 });
    expect(lowGlucoseGate({ value: 65, observed_at: minutesAgo(90) }, now)).toBeNull();
    expect(lowGlucoseGate({ value: 70, observed_at: minutesAgo(3) }, now)).toBeNull();
    expect(lowGlucoseGate(null, now)).toBeNull();
    // No calculation at all (it threw): the low still holds insulin back; otherwise CALCULATOR_UNAVAILABLE is acknowledged.
    expect(doseSafetyWarnings({ insulin_u: 2, calculation: null, recent: null, glucose: { value: 62, observed_at: minutesAgo(2) }, now, calculator_failed: true }).map((warning) => warning.key)).toEqual(['INSULIN_WHILE_LOW:BELOW_70:62']);
    expect(doseSafetyWarnings({ insulin_u: 2, calculation: null, recent: null, glucose: { value: 120, observed_at: minutesAgo(2) }, now, calculator_failed: true })).toEqual([calculatorUnavailableWarning()]);
    expect(calculatorUnavailableWarning().message).toBe('Kalkulator dawki niedostępny — sprawdź dawkę ręcznie.');
    // Carbs alone: nothing.
    expect(doseSafetyWarnings({ insulin_u: 0, calculation: null, recent: null, glucose: { value: 62, observed_at: minutesAgo(2) }, now, calculator_failed: true })).toEqual([]);
    const logged: string[] = [];
    const original = console.warn;
    console.warn = (line: string) => { logged.push(line); };
    try {
      const broken = { ...data(), readings: null } as unknown as MealForecastData;
      const result = safeDoseCalculation({ now, carbs_g: 30, icr_g_per_u: 10, step: 0.05, data: broken }, { where: 'spec', patient_id: 'p1' });
      expect(result).toEqual({ calculation: null, failed: true });
    } finally {
      console.warn = original;
    }
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0])).toEqual({ event: 'dose_safety_check_failed', where: 'spec', patient_id: 'p1', id: null, error_class: 'TypeError' });
  });

  it('L3: every remote bolus of the window that Nightscout does not show yet is counted, each Nightscout bolus matched once', () => {
    const recent = recentInsulinFrom({ now, window_minutes: 120, boluses: [{ at: minutesAgo(61), units: 2 }], smbs: [] })!;
    // Two remote boluses of 2 j (60 and 20 min ago): one is in Nightscout, the other not yet; 100 min ago: counted too.
    const result = withRemoteBoluses(recent, [{ at: minutesAgo(60), units: 2 }, { at: minutesAgo(20), units: 2 }, { at: minutesAgo(100), units: 1 }], now);
    expect(result).toMatchObject({ total_u: 5, manual_u: 2, remote_u: 3, newest_at: minutesAgo(20) });
    // Outside the window: not counted.
    expect(withRemoteBoluses(recent, [{ at: minutesAgo(130), units: 1 }], now)).toBe(recent);
    // Without anything from Nightscout.
    expect(withRemoteBoluses(null, [{ at: minutesAgo(10), units: 1.5 }], now)).toMatchObject({ window_minutes: 120, total_u: 1.5, remote_u: 1.5 });
  });
});

describe('dose-calculator.v1: the line under the dose says how much and why, not values shown elsewhere', () => {
  it('lowered: "↓ X j mniej niż z przelicznika (Y j): <one reason>"; the breakdown stays in summary and formula', () => {
    const iob = calc(30, data({ glucose: 124, iob: 1.85 }));
    expect(iob).toMatchObject({ reason_code: 'ACTIVE_INSULIN', lowered_by_u: 1.65 });
    expect(iob.short_summary).toBe('↓ 1,65\u00a0j mniej niż z przelicznika (3\u00a0j): aktywna insulina');
    expect(iob.short_summary).not.toMatch(/IOB|124/);
    expect(iob.formula).toBe('30 g / ICR 10 + (124 − 100) / 100 − IOB 1,85 j = 1,35 j');
    expect(iob.summary).toContain('IOB 1,85 j, glukoza 124');
    // Below target, no IOB: 30 / 10 + (80 − 100) / 100 = 2,8 j.
    expect(calc(30, data({ glucose: 80, iob: 0 })).short_summary).toBe('↓ 0,2\u00a0j mniej niż z przelicznika (3\u00a0j): glukoza poniżej celu');
    // Falling fast at target: the trend is the main term.
    expect(calc(30, data({ glucose: 140, per5: -15, iob: 0, curve: [140, 140, 140, 140, 140, 140, 140] })).reason_code).toBe('FALLING');
    expect(calc(30, data({ glucose: 65 })).short_summary).toBe('0\u00a0j zamiast 3\u00a0j z przelicznika: niska glukoza — najpierw węglowodany');
    const later = computeDoseCalculation({ now, carbs_g: 0, icr_g_per_u: 10, step: 0.05, data: data({ glucose: 80 }), later_part: { dose_u: 1.5 } });
    expect(later.short_summary).toBe('↓ 0,2\u00a0j mniej niż z planu (1,5\u00a0j): glukoza poniżej celu');
  });

  it('not lowered: a plain "Z przelicznika" (the app shows it grey), or that the calculator was unavailable', () => {
    expect(calc(30, data({ glucose: 150, iob: 0.3 }))).toMatchObject({ short_summary: 'Z przelicznika', reason_code: null, lowered_by_u: null });
    expect(calc(30, data({ loopAgeMinutes: 40 }))).toMatchObject({ short_summary: 'Z przelicznika — kalkulator niedostępny', formula: null });
  });
});

describe('dose-calculator.v1: schedules at the right time', () => {
  const therapy = {
    units: 'mg/dl',
    timezone: 'Europe/Warsaw',
    dia_hours: 6,
    // Warsaw is UTC+1 on 2026-10-29: 23:50 local = 22:50Z.
    carb_ratio_g_per_u: [['00:00', 10], ['06:00', 8], ['21:00', 12]] as Array<[string, number]>,
    sensitivity_per_u: [['00:00', 150], ['22:00', 120]] as Array<[string, number]>,
    target_low: [['00:00', 110], ['07:00', 100]] as Array<[string, number]>,
  };
  const late = new Date('2026-10-29T22:50:00.000Z');
  const dashboard = { glucose: null, readings: [], loop: null, insulin: null };

  it('takes the ICR of the meal time across midnight, and the ISF and target of now', () => {
    const eatenNow = remoteCommandContextFrom({ now: late, dashboard, therapy, loopStatus: null });
    expect(eatenNow.icr_g_per_u).toBe(12);
    // Eaten 15 min later, after midnight: the 00:00 ratio.
    const afterMidnight = remoteCommandContextFrom({ now: late, dashboard, therapy, loopStatus: null, carbsAt: new Date('2026-10-29T23:05:00.000Z') });
    expect(afterMidnight.icr_g_per_u).toBe(10);
    const forecast = mealForecastDataFrom({ now: late, readings: [], loopStatus: null, therapy });
    expect(forecast).toMatchObject({ profile_isf: 120, profile_target: 100 });
    // At an ICR boundary (06:00 local = 05:00Z) the new ratio applies from that minute.
    expect(remoteCommandContextFrom({ now: new Date('2026-10-30T04:59:00.000Z'), dashboard, therapy, loopStatus: null }).icr_g_per_u).toBe(10);
    expect(remoteCommandContextFrom({ now: new Date('2026-10-30T05:00:00.000Z'), dashboard, therapy, loopStatus: null }).icr_g_per_u).toBe(8);
  });

  it('reads the recent-insulin window from the profile DIA', () => {
    const context = remoteCommandContextFrom({
      now,
      dashboard: { glucose: null, readings: [], loop: null, insulin: { boluses: [{ at: minutesAgo(100), units: 1 }], smbs: [{ at: minutesAgo(10), units: 0.1 }], basal: [] } },
      therapy: { ...therapy, dia_hours: 4.5 },
      loopStatus: null,
    });
    // DIA 4,5 h / 3 = 90 min: the bolus 100 min ago is outside.
    expect(context.recent_insulin).toMatchObject({ window_minutes: 90, total_u: 0.1, manual_u: 0, smb_u: 0.1 });
  });
});
