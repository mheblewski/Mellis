import { describe, expect, it } from 'vitest';
import { bolusChartBaseline, computeBolusForecast, excessInsulinLine } from '@modules/glucose-forecast/application/bolus-forecast';
import { insulinCurveFromLoopInsulinType } from '@modules/glucose-forecast/application/insulin-curve';
import { scheduleValueAt } from '@modules/meal-wbt/application/wbt-policy';
import { computeDoseCalculation, dangerReferenceU, doseAboveCalculatorWarning } from './application/dose-calculator';
import { mealForecastDataFrom, type MealForecastData } from './application/meal-dose-forecast';

/**
 * dose-calculator.v3 (T4b): the default moves halfway from the calculator's v1 to the largest dose whose dashed line
 * (the Bolus chart's own) stays at or above min(target, the newest reading) for 3 hours.
 */

/** A typical case (fictional settings: ICR 7, ISF 115, DIA 9 h): 90 mg/dL +8 / 5 min, IOB 1,1, COB 0, 10 g. */
function ownersCase(isf = 115) {
  const now = new Date('2026-10-30T20:15:30Z');
  const at = (min: number) => new Date(now.getTime() - 30_000 + min * 60_000).toISOString();
  const readings = [-30, -25, -20, -15, -10, -5, 0].map((m) => ({ at: at(m), value: 90 + (m / 5) * 8 }));
  // Trio's IOB curve: 90, up to ~120 at 50 min, down to ~63 at 180 min, ~55 at 240.
  const iobCurve = Array.from({ length: 49 }, (_, i) => {
    const t = i * 5;
    return Math.round(t <= 50 ? 90 + 30 * Math.sin((t / 50) * Math.PI / 2) : t <= 180 ? 120 - 57 * ((t - 50) / 130) ** 1.2 : 63 - 8 * ((t - 180) / 60));
  });
  const ztCurve = iobCurve.map((v, i) => Math.max(39, v - i));
  const status = { observed_at: at(-1), raw_payload: { device: 'Trio', openaps: { suggested: { bg: 90, COB: 0, IOB: 1.1, ISF: isf, CR: 7, current_target: 110, eventualBG: 63, deliverAt: at(-1), timestamp: at(-1), reason: 'minPredBG 63, minGuardBG 63', predBGs: { IOB: iobCurve, ZT: ztCurve, UAM: iobCurve } } } } };
  const therapy = { units: 'mg/dl', timezone: 'Europe/Warsaw', dia_hours: 9, carb_ratio_g_per_u: [['00:00', 7]] as Array<[string, number]>, sensitivity_per_u: [['00:00', 115]] as Array<[string, number]>, target_low: [['00:00', 110]] as Array<[string, number]>, target_high: [['00:00', 110]] as Array<[string, number]> };
  const icr = scheduleValueAt(therapy.carb_ratio_g_per_u, now.toISOString(), therapy.timezone)!;
  const data = mealForecastDataFrom({ now, readings, loopStatus: status, therapy, lastCarbsAt: null });
  return { now, icr, data };
}

const calc = (input: { now: Date; icr: number; data: MealForecastData }, carbs = 10, extra: { nudge?: boolean; step?: number } = {}) =>
  computeDoseCalculation({ now: input.now, carbs_g: carbs, icr_g_per_u: input.icr, step: extra.step ?? 0.1, data: input.data, forecast_nudge: extra.nudge });

describe('dose-calculator.v3: halfway to the dose the loop\'s forecast allows (T4b)', () => {
  it("the owner's case: v1 0,3 j, d2 1 j, default 0,6 j (peak 75), never above carbs / ICR 1,4 j", () => {
    const owner = ownersCase();
    const v1 = calc(owner, 10, { nudge: false });
    expect(v1).toMatchObject({ icr_dose_u: 1.4, default_u: 0.3, limited_by: 'CALCULATOR' });
    const v3 = calc(owner);
    expect(v3).toMatchObject({ policy_version: 'dose-calculator.v3', icr_dose_u: 1.4, default_u: 0.6, limited_by: 'FORECAST', reason_code: 'ACTIVE_INSULIN', lowered_by_u: 0.8 });
    expect(v3.forecast_nudge).toMatchObject({ v1_u: 0.3, default_u: 0.6, floor_mgdl: 90 });
    expect(v3.forecast_nudge!.d2_u).toBeGreaterThanOrEqual(0.9);
    expect(v3.forecast_nudge!.d2_u).toBeLessThanOrEqual(1.4);
    // One short line under the dose; the details only in the summary (ⓘ).
    expect(v3.short_summary).toBe('↓ 0,8 j mniej niż z przelicznika (1,4 j): IOB i prognoza pętli');
    expect(v3.summary).toContain('połowa drogi od kalkulatora pętli (0,3 j');
    // The danger check never warns about its own default; the opt-in higher dose stays off.
    expect(v3.reference_u).toBeGreaterThanOrEqual(0.6);
    expect(doseAboveCalculatorWarning(0.6, v3)).toBeNull();
    expect(dangerReferenceU(v3)).toBeGreaterThanOrEqual(v3.default_u);
  });

  it('reads the line exactly as the Bolus chart draws it (the same baseline, ISF, curve and dose lag)', () => {
    const owner = ownersCase();
    const v3 = calc(owner);
    const chart = computeBolusForecast({ now: owner.now, readings: owner.data.readings, prediction: owner.data.prediction, profile_isf: owner.data.profile_isf, profile_units: owner.data.profile_units, dia_hours: owner.data.dia_hours ?? null, carbs_g: 10, insulin_u: v3.default_u, icr_g_per_u: owner.icr, icr_insulin_u: v3.icr_dose_u, bolus_step: 0.1 })!;
    const base = bolusChartBaseline({ now: owner.now, readings: owner.data.readings, prediction: owner.data.prediction })!;
    expect(base.baseline).toEqual(chart.baseline);
    expect(base.baseline_source).toBe('LOOP');
    expect(Math.min(...chart.with_excess!)).toBe(v3.forecast_nudge!.line_min_mgdl);
    // At d2 the dashed line holds the floor; one step more and it does not (the largest such dose), unless d2 is carbs / ICR.
    const line = (dose: number) => Math.min(...excessInsulinLine({ baseline: base.baseline, step_minutes: 5, dose_lag_minutes: base.dose_lag_minutes, excess_u: dose - 1.4, isf_mgdl: 115, dia_hours: 9 }));
    const { d2_u: d2, floor_mgdl: floor } = v3.forecast_nudge!;
    expect(line(d2)).toBeGreaterThanOrEqual(floor);
    if (d2 < 1.4) expect(line(Math.round((d2 + 0.1) * 100) / 100)).toBeLessThan(floor);
  });

  it("uses the loop's insulin curve (the chart's peak): Fiasp's 55 min moves d2 and the default", () => {
    const owner = ownersCase();
    const fiasp = calc({ ...owner, data: { ...owner.data, insulin_curve: insulinCurveFromLoopInsulinType('Fiasp') } });
    // The insulin left out (1,4 − d j) stops lowering the line sooner, so the early dip is shallower: 0,7 j.
    expect(fiasp).toMatchObject({ default_u: 0.7, limited_by: 'FORECAST' });
    expect(fiasp.forecast_nudge!.d2_u).toBeGreaterThan(calc(owner).forecast_nudge!.d2_u);
  });

  it('applies only to the calculator\'s lowering with a fresh loop line: not without the loop\'s curve, nor for a later part', () => {
    const owner = ownersCase();
    const noCurve: MealForecastData = { ...owner.data, prediction: owner.data.prediction ? { ...owner.data.prediction, curves: {} } : null };
    expect(calc({ ...owner, data: noCurve })).toMatchObject({ default_u: 0.3, limited_by: 'CALCULATOR', forecast_nudge: null });
    const later = computeDoseCalculation({ now: owner.now, carbs_g: 0, icr_g_per_u: owner.icr, step: 0.1, data: owner.data, later_part: { dose_u: 1.4 } });
    expect(later.limited_by).not.toBe('FORECAST');
    expect(later.forecast_nudge ?? null).toBeNull();
  });

  it('property: never above carbs / ICR, never below v1; carbs first and the falling rules win', () => {
    for (const isf of [60, 90, 120, 190]) {
      for (const carbs of [5, 10, 20, 40, 80]) {
        for (const step of [0.05, 0.1]) {
          const owner = ownersCase(isf);
          const v1 = calc(owner, carbs, { nudge: false, step });
          const v3 = calc(owner, carbs, { step });
          expect(v3.default_u).toBeLessThanOrEqual((v3.icr_dose_u ?? 0) + 1e-9);
          expect(v3.default_u).toBeGreaterThanOrEqual(v1.default_u - 1e-9);
          if (v1.limited_by !== 'CALCULATOR') expect(v3.default_u).toBe(v1.default_u);
          if (v3.limited_by === 'FORECAST') expect(v3.reference_u!).toBeGreaterThanOrEqual(v3.default_u - 1e-9);
        }
      }
    }
    // A reading below 70: carbs first, 0 j, whatever the loop's line.
    const low = ownersCase();
    const lowData: MealForecastData = { ...low.data, readings: low.data.readings.map((reading, index, all) => index === all.length - 1 ? { ...reading, value: 65 } : reading) };
    expect(calc({ ...low, data: lowData })).toMatchObject({ default_u: 0, limited_by: 'CARBS_FIRST' });
  });
});
