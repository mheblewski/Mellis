import { describe, expect, it } from 'vitest';
import { BOLUS_FORECAST_POLICY, carbsAbsorbed, computeBolusForecast, insulinOnBoard } from './application/bolus-forecast';
import { parseLoopPrediction, type LoopPrediction } from '@modules/loop-system/application/loop-prediction';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const minutes = (value: number) => new Date(NOW.getTime() + value * 60_000).toISOString();

/** CGM every 5 min ending at `endAt` minutes from NOW, values oldest first. */
function cgm(values: number[], endAt = -1) {
  return values.map((value, index) => ({ at: minutes(endAt - (values.length - 1 - index) * 5), value }));
}

function trio(predBGs: Record<string, number[]>, extra: Record<string, unknown> = {}, at = minutes(-1)): LoopPrediction {
  return parseLoopPrediction({
    observed_at: at,
    raw_payload: { openaps: { suggested: { bg: 140, deliverAt: at, IOB: 0.8, COB: 0, ISF: 45, CR: 10, eventualBG: 125, predBGs, ...extra } } },
  })!;
}

const inputs = (overrides: Partial<Parameters<typeof computeBolusForecast>[0]> = {}) => ({
  now: NOW,
  readings: cgm([150, 147, 144, 140]),
  prediction: trio({ IOB: [140, 138, 136, 134, 132, 130, 128, 127, 126, 125] }),
  profile_isf: 40,
  profile_units: 'mg/dL',
  dia_hours: 6,
  icr_g_per_u: 10,
  carbs_g: 0,
  insulin_u: 0,
  ...overrides,
});

describe('insulin and carb curves (bolus-forecast.v3)', () => {
  it("follows oref's exponential curve: all of a dose before it, none after DIA, about half by 2 hours", () => {
    expect(insulinOnBoard(-5, 360, 75)).toBe(1);
    expect(insulinOnBoard(0, 360, 75)).toBe(1);
    expect(insulinOnBoard(360, 360, 75)).toBe(0);
    expect(insulinOnBoard(120, 360, 75)).toBeGreaterThan(0.4);
    expect(insulinOnBoard(120, 360, 75)).toBeLessThan(0.6);
    expect(insulinOnBoard(60, 360, 75)).toBeGreaterThan(insulinOnBoard(90, 360, 75));
  });

  it('absorbs carbs front-loaded from when they are eaten (Hovorka, t_max 40): half by ~67 minutes', () => {
    expect(carbsAbsorbed(0)).toBe(0);
    expect(carbsAbsorbed(-10)).toBe(0);
    expect(carbsAbsorbed(67)).toBeCloseTo(0.5, 1);
    expect(carbsAbsorbed(40) - carbsAbsorbed(30)).toBeGreaterThan(carbsAbsorbed(130) - carbsAbsorbed(120));
    expect(carbsAbsorbed(180)).toBeGreaterThan(0.93);
  });
});

describe('computeBolusForecast', () => {
  it("starts at the newest reading and follows the loop's own curve without a dose (its IOB and COB as Trio draws them)", () => {
    const chart = computeBolusForecast(inputs())!;
    expect(chart).toMatchObject({ start: minutes(-1), step_minutes: 5, baseline_source: 'LOOP', with_dose: null, low_at: null });
    expect(chart.baseline).toHaveLength(BOLUS_FORECAST_POLICY.horizon_minutes / 5 + 1);
    expect(chart.baseline[0]).toBe(140);
    // Trio's curve to 125, its last value held.
    expect(chart.baseline.slice(0, 4)).toEqual([140, 138, 136, 134]);
    expect(chart.baseline.at(-1)).toBe(125);
    expect(chart.band[0]).toBe(0);
    expect(chart.band[6]).toBe(Math.round(BOLUS_FORECAST_POLICY.band_mae_30_mgdl));
  });

  it("adds the dose with the loop's ISF and ICR: a dose by ICR rises above the line without it, then comes back", () => {
    // DIA 10 h as in the patient's profile: 45 g × 45/10 = 202 mg/dL of carbs, about 6% of it shows as the bump.
    const chart = computeBolusForecast(inputs({ carbs_g: 45, insulin_u: 4.5, dia_hours: 10 }))!;
    const withDose = chart.with_dose!;
    expect(withDose[0]).toBe(140);
    const above = withDose.map((value, index) => value - chart.baseline[index]);
    const peak = Math.max(...above);
    const peakAt = above.indexOf(peak) * 5;
    expect(peak).toBeGreaterThan(10);
    expect(peakAt).toBeGreaterThanOrEqual(60);
    expect(peakAt).toBeLessThanOrEqual(110);
    expect(above.at(-1)!).toBeLessThan(peak / 2);
    expect(chart).toMatchObject({ carbs_g: 45, insulin_u: 4.5, meal_in_minutes: 10 });
  });

  it('puts the carbs off on the chart when the meal is later ("Posiłek za 15 min"): lower at first, the same insulin', () => {
    const now = computeBolusForecast(inputs({ carbs_g: 45, insulin_u: 4.5, dia_hours: 10 }))!;
    const later = computeBolusForecast(inputs({ carbs_g: 45, insulin_u: 4.5, dia_hours: 10, meal_in_minutes: 15 }))!;
    expect(later.meal_in_minutes).toBe(15);
    expect(later.with_dose![6]).toBeLessThan(now.with_dose![6]);
    expect(later.with_dose![12]).toBeLessThan(now.with_dose![12]);
    expect(later.baseline).toEqual(now.baseline);
    expect(computeBolusForecast(inputs({ carbs_g: 45, insulin_u: 4.5, meal_in_minutes: 500 }))!.meal_in_minutes).toBe(60);
  });

  it('starts a fatty meal\'s carbs 15 min later (bolus-forecast.v4): lower in the first hour, the same in the end', () => {
    const lean = computeBolusForecast(inputs({ carbs_g: 45, insulin_u: 4.5, dia_hours: 10 }))!;
    const fatty = computeBolusForecast(inputs({ carbs_g: 45, insulin_u: 4.5, dia_hours: 10, fatty_meal: true }))!;
    expect(fatty.policy_version).toBe('bolus-forecast.v5');
    expect(fatty.with_dose![12]).toBeLessThan(lean.with_dose![12]);
    expect(Math.min(...fatty.with_dose!)).toBeLessThanOrEqual(Math.min(...lean.with_dose!));
    expect(fatty.meal_in_minutes).toBe(lean.meal_in_minutes);
  });

  it('flags the first point below 70 and whether the dose causes it', () => {
    const tooMuch = computeBolusForecast(inputs({ carbs_g: 0, insulin_u: 3 }))!;
    expect(tooMuch.low_at).not.toBeNull();
    expect(tooMuch.low_from_dose).toBe(true);
    const lowAnyway = computeBolusForecast(inputs({
      readings: cgm([90, 84, 78, 72]),
      prediction: trio({ IOB: [72, 66, 60, 55, 50, 46, 43, 40, 39, 39] }, { bg: 72 }),
      carbs_g: 10,
      insulin_u: 0,
    }))!;
    expect(lowAnyway.low_from_dose).toBe(false);
  });

  it('carries the CGM trend for 30 minutes without a fresh loop forecast, then stays flat', () => {
    const chart = computeBolusForecast(inputs({ prediction: trio({ IOB: [140, 130] }, {}, minutes(-15)) }))!;
    expect(chart.baseline_source).toBe('CGM_TREND');
    expect(chart.baseline[6]).toBe(chart.baseline.at(-1));
    expect(chart.baseline[6]).toBeLessThan(140);
  });

  it("uses the profile's ISF (mmol/L converted) when the loop has none", () => {
    const chart = computeBolusForecast(inputs({ prediction: null, profile_isf: 2.5, profile_units: 'mmol/L', insulin_u: 1 }))!;
    expect(chart.baseline_source).toBe('CGM_TREND');
    // 1 U × 45 mg/dL per U, about 3/4 of it acted by 3 hours (DIA 6 h).
    expect(chart.baseline.at(-1)! - chart.with_dose!.at(-1)!).toBeGreaterThan(30);
    expect(chart.baseline.at(-1)! - chart.with_dose!.at(-1)!).toBeLessThanOrEqual(45);
  });

  it("reads the loop's ISF and a mg/dL profile ISF of 15–25 with the same rule as the dose reduction", () => {
    const dropOf = (chart: ReturnType<typeof computeBolusForecast>) => chart!.baseline.at(-1)! - chart!.with_dose!.at(-1)!;
    const mgdl = dropOf(computeBolusForecast(inputs({ insulin_u: 1 })));
    // oref prints a mmol/L user's ISF in mmol/L: 2.5 is 45 mg/dL per U, the same drop as the mg/dL ISF of 45.
    expect(dropOf(computeBolusForecast(inputs({ prediction: trio({ IOB: [140, 138, 136, 134, 132, 130, 128, 127, 126, 125] }, { ISF: 2.5 }), profile_units: 'mmol', insulin_u: 1 })))).toBe(mgdl);
    // A mg/dL profile ISF of 20 stays 20 (was 20 on the chart but 360 in the dose reduction).
    const twenty = dropOf(computeBolusForecast(inputs({ prediction: null, profile_isf: 20, profile_units: 'mg/dl', insulin_u: 1 })));
    expect(twenty).toBeGreaterThan(10);
    expect(twenty).toBeLessThanOrEqual(20);
  });

  it('draws no dose line without an ISF or, for carbs, an ICR; and no chart without a fresh reading', () => {
    expect(computeBolusForecast(inputs({ prediction: null, profile_isf: null, insulin_u: 2 }))!.with_dose).toBeNull();
    expect(computeBolusForecast(inputs({ prediction: trio({ IOB: [140, 139] }, { CR: undefined }), icr_g_per_u: null, carbs_g: 20 }))!.with_dose).toBeNull();
    expect(computeBolusForecast(inputs({ readings: cgm([140, 138], -16) }))).toBeNull();
  });
});

describe('baseline with an unannounced-meal curve (bolus-forecast.v5)', () => {
  it('draws the line without the dose halfway between the main curve and UAM', () => {
    const iob = [140, 130, 120, 110, 100, 90, 80, 70, 60, 50];
    const uam = [140, 140, 140, 140, 140, 140, 140, 140, 140, 140];
    const both = computeBolusForecast(inputs({ prediction: trio({ IOB: iob, UAM: uam }) }))!;
    const mainOnly = computeBolusForecast(inputs({ prediction: trio({ IOB: iob }) }))!;
    // 45 min out: the main curve alone has fallen 90, the mean 45.
    expect(mainOnly.baseline[0] - mainOnly.baseline[9]).toBe(90);
    expect(both.baseline[0] - both.baseline[9]).toBe(45);
  });
});
