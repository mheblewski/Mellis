import { describe, expect, it } from 'vitest';
import {
  BOLUS_FORECAST_POLICY,
  computeBolusForecast,
  excessInsulinEffect,
  excessInsulinLine,
  excessInsulinUnits,
  insulinCurveDiaMinutes,
} from './application/bolus-forecast';
import { CGM_FLOOR_MGDL } from './application/cgm-trend';
import { insulinCurveFromLoopInsulinType, insulinCurveFromTrioPreferences } from './application/insulin-curve';
import { FORECAST_PROFILES } from './application/forecast-calibration';
import { parseLoopPrediction, type LoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { insulinForCarbs } from '@modules/remote-commands/application/remote-command-policy';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const minutes = (value: number) => new Date(NOW.getTime() + value * 60_000).toISOString();
const cgm = (values: number[], endAt = -1) => values.map((value, index) => ({ at: minutes(endAt - (values.length - 1 - index) * 5), value }));

/** Trio's forecast flat at `value` (the owner's case: ~111 for 3 hours). */
function flatTrio(value: number, isf = 100, cr = 8): LoopPrediction {
  const at = minutes(-1);
  return parseLoopPrediction({
    observed_at: at,
    raw_payload: { openaps: { suggested: { bg: value, deliverAt: at, IOB: 0.2, COB: 0, ISF: isf, CR: cr, eventualBG: value, predBGs: { IOB: Array(48).fill(value) } } } },
  })!;
}

/** The Bolus tab's preview inputs: the calculator's ICR dose (insulinForCarbs) and the pump step. */
const form = (carbs: number, insulin: number, overrides: Partial<Parameters<typeof computeBolusForecast>[0]> = {}) => ({
  now: NOW,
  readings: cgm([111, 111, 111, 111]),
  prediction: flatTrio(111),
  profile_isf: 100,
  profile_units: 'mg/dL',
  dia_hours: 6,
  icr_g_per_u: 8,
  carbs_g: carbs,
  insulin_u: insulin,
  icr_insulin_u: insulinForCarbs(carbs, 8, 0.05),
  bolus_step: 0.05,
  ...overrides,
});

describe('the excess insulin (excess-insulin.v1)', () => {
  it('is the dose minus the calculator\'s carbs / ICR dose; 0 g: the whole dose; no ICR dose with carbs: unknown', () => {
    // 1 g / ICR 8 = 0.125 j, rounded down to the 0.05 step as the calculator does: 0.1 j.
    expect(insulinForCarbs(1, 8, 0.05)).toBe(0.1);
    expect(excessInsulinUnits(1, 1, 0.1)).toBe(0.9);
    expect(excessInsulinUnits(1.5, 0, null)).toBe(1.5);
    expect(excessInsulinUnits(4, 40, 5)).toBe(-1);
    expect(excessInsulinUnits(4, 40, null)).toBeNull();
  });
});

describe("the excess insulin's effect over time", () => {
  const curve = (t: number, dia = 6) => excessInsulinEffect(t, { excess_u: 1, isf_mgdl: 100, dia_hours: dia });

  it('is nothing before the dose, grows slowly then fast (peak 75 min), and is the whole excess × ISF after DIA', () => {
    expect(curve(-10)).toBe(0);
    expect(curve(0)).toBe(0);
    expect(curve(30)).toBeGreaterThan(0);
    expect(curve(30)).toBeLessThan(10);
    // The steepest part around the peak, slower after.
    expect(curve(80) - curve(70)).toBeGreaterThan(curve(30) - curve(20));
    expect(curve(80) - curve(70)).toBeGreaterThan(curve(250) - curve(240));
    expect(curve(360)).toBe(100);
    expect(curve(500)).toBe(100);
    // Monotonic.
    for (let t = 0; t < 360; t += 5) expect(curve(t + 5)).toBeGreaterThanOrEqual(curve(t));
  });

  it("takes the profile's DIA (within Trio's 5–10 h, 6 h without one): a longer DIA acts later", () => {
    expect(insulinCurveDiaMinutes(8)).toBe(480);
    expect(insulinCurveDiaMinutes(3)).toBe(300);
    expect(insulinCurveDiaMinutes(12)).toBe(600);
    expect(insulinCurveDiaMinutes(null)).toBe(360);
    expect(curve(180, 8)).toBeLessThan(curve(180, 5));
    expect(curve(180, 6)).toBeCloseTo(79.2, 0);
    expect(curve(480, 8)).toBe(100);
  });

  it('is negative for a dose below the ICR dose (the line rises), the mirror of a positive excess', () => {
    const below = excessInsulinEffect(120, { excess_u: -0.5, isf_mgdl: 100, dia_hours: 6 });
    expect(below).toBeLessThan(0);
    expect(below).toBeCloseTo(-curve(120) / 2, 6);
  });

  it('is subtracted from every point of the line the chart draws (rounded, held at the CGM floor)', () => {
    const baseline = [150, 150, 148, 146, 144];
    const line = excessInsulinLine({ baseline, step_minutes: 60, dose_lag_minutes: 0, excess_u: 1, isf_mgdl: 100, dia_hours: 6 });
    expect(line[0]).toBe(150);
    expect(line.map((value, index) => baseline[index] - value)).toEqual([0, 22, 55, 79, 96].map((_, index) => Math.round(curve(index * 60))));
    expect(excessInsulinLine({ baseline: [60, 60], step_minutes: 300, dose_lag_minutes: 0, excess_u: 2, isf_mgdl: 100, dia_hours: 5 })).toEqual([60, CGM_FLOOR_MGDL]);
  });
});

describe('the dashed "z tą dawką" line on the Bolus chart', () => {
  it("the owner's case: 1 g, 1 j typed, Trio flat at 111 — the line drops by the 0.9 j excess, its minimum is the warning's value", () => {
    const chart = computeBolusForecast(form(1, 1))!;
    expect(chart).toMatchObject({ dose_line: 'LOOP_ONLY', excess_policy: 'excess-insulin.v2', excess_insulin_u: 0.9, excess_step_u: 0.05 });
    expect(chart.baseline.every((value) => value === 111)).toBe(true);
    const line = chart.with_excess!;
    expect(line).toHaveLength(chart.baseline.length);
    expect(line[0]).toBe(111);
    // Flat loop line minus a growing effect: falling all the way, lowest at the end of the 3 hours.
    for (let index = 1; index < line.length; index += 1) expect(line[index]).toBeLessThanOrEqual(line[index - 1]);
    const expected = Math.round(111 - excessInsulinEffect(180 - 1, { excess_u: 0.9, isf_mgdl: 100, dia_hours: 6 }));
    expect(line.at(-1)).toBe(expected);
    expect(expected).toBeGreaterThan(35);
    expect(expected).toBeLessThan(45);
    // "Po tej dawce ok. X" = the line's lowest point (one computation).
    expect(chart.with_excess_min).toBe(Math.min(...line));
    expect(chart.with_excess_min).toBe(expected);
  });

  it('a dose at the ICR dose: no dashed line (one line, as before)', () => {
    const chart = computeBolusForecast(form(40, 5))!;
    expect(chart.excess_insulin_u).toBe(0);
    expect(chart.with_excess).toBeNull();
    expect(chart.with_excess_min).toBeNull();
    // Less than one pump step off: still none; a full step: drawn.
    expect(computeBolusForecast(form(41, 5.1))!.with_excess).toBeNull(); // 41 / 8 = 5.125 → 5.1
    expect(computeBolusForecast(form(40, 5.05))!.with_excess).not.toBeNull();
    expect(computeBolusForecast(form(40, 5.05, { bolus_step: 0.1 }))!.with_excess).toBeNull();
    expect(computeBolusForecast(form(40, 5.1, { bolus_step: 0.1 }))!.with_excess).not.toBeNull();
  });

  it('a dose below the ICR dose: the dashed line runs slightly above the loop\'s', () => {
    const chart = computeBolusForecast(form(40, 4.5))!;
    expect(chart.excess_insulin_u).toBe(-0.5);
    const line = chart.with_excess!;
    line.forEach((value, index) => expect(value).toBeGreaterThanOrEqual(chart.baseline[index]));
    expect(line.at(-1)! - chart.baseline.at(-1)!).toBe(Math.round(0.5 * excessInsulinEffect(179, { excess_u: 1, isf_mgdl: 100, dia_hours: 6 })));
    expect(chart.with_excess_min).toBe(111);
  });

  it('0 g: the whole dose is excess (a correction)', () => {
    const chart = computeBolusForecast(form(0, 0.5))!;
    expect(chart.excess_insulin_u).toBe(0.5);
    expect(chart.with_excess!.at(-1)).toBe(Math.round(111 - excessInsulinEffect(179, { excess_u: 0.5, isf_mgdl: 100, dia_hours: 6 })));
  });

  it('follows the loop line the chart draws (a falling one too), and the DIA of the profile', () => {
    const falling = parseLoopPrediction({
      observed_at: minutes(-1),
      raw_payload: { openaps: { suggested: { bg: 140, deliverAt: minutes(-1), IOB: 1, COB: 0, ISF: 100, CR: 8, eventualBG: 90, predBGs: { IOB: Array.from({ length: 37 }, (_, index) => 140 - index) } } } },
    })!;
    const chart = computeBolusForecast(form(0, 1, { readings: cgm([150, 147, 144, 140]), prediction: falling }))!;
    chart.with_excess!.forEach((value, index) => {
      expect(value).toBe(Math.max(CGM_FLOOR_MGDL, Math.round(chart.baseline[index] - excessInsulinEffect(index * 5 - 1, { excess_u: 1, isf_mgdl: 100, dia_hours: 6 }))));
    });
    const longDia = computeBolusForecast(form(0, 0.5, { dia_hours: 9 }))!;
    const shortDia = computeBolusForecast(form(0, 0.5, { dia_hours: 5 }))!;
    expect(longDia.with_excess_min!).toBeGreaterThan(shortDia.with_excess_min!);
  });

  it('none without an ICR dose from the caller (cards), without ISF, with nothing typed, or on the MODEL chart', () => {
    const { icr_insulin_u: _icr, ...card } = form(1, 1);
    expect(computeBolusForecast(card)!).toMatchObject({ with_excess: null, excess_insulin_u: null });
    expect(computeBolusForecast(form(40, 6, { icr_insulin_u: null }))!.with_excess).toBeNull();
    expect(computeBolusForecast(form(0, 0))!.with_excess).toBeNull();
    const noIsf = computeBolusForecast(form(0, 1, { profile_isf: null, prediction: null }))!;
    expect(noIsf.with_excess).toBeNull();
    const model = computeBolusForecast(form(1, 1, { calibration: { ...FORECAST_PROFILES.none.bolus_chart, draw_dose_line: true } }))!;
    expect(model.with_excess).toBeNull();
    expect(BOLUS_FORECAST_POLICY.excess_policy).toBe('excess-insulin.v2');
  });
});

describe('carbs with the dose field empty (excess-insulin.v2)', () => {
  it('draws the line rising by carbs × ISF / ICR at DIA, spread by the same curve', () => {
    const chart = computeBolusForecast(form(10, 0, { horizon_minutes: 360 }))!;
    // 10 g / ICR 8 = 1.25 j, unrounded (the calculator's 1.25 j here too), shown to 2 places.
    expect(chart.excess_insulin_u).toBe(-1.25);
    const line = chart.with_excess!;
    expect(line).toHaveLength(chart.baseline.length);
    expect(line[0]).toBe(111);
    for (let index = 1; index < line.length; index += 1) expect(line[index]).toBeGreaterThanOrEqual(line[index - 1]);
    // The full 10 × 100 / 8 = 125 mg/dL at DIA (6 h); the last point is 359 min after the dose.
    expect(-excessInsulinEffect(360, { excess_u: -10 / 8, isf_mgdl: 100, dia_hours: 6 })).toBeCloseTo(125, 9);
    expect(line.at(-1)! - chart.baseline.at(-1)!).toBe(Math.round(-excessInsulinEffect(359, { excess_u: -1.25, isf_mgdl: 100, dia_hours: 6 })));
    expect(line.at(-1)! - chart.baseline.at(-1)!).toBeGreaterThanOrEqual(124);
    // The same curve as any excess: point by point the loop's line minus the (negative) effect.
    line.forEach((value, index) => expect(value).toBe(Math.round(111 - excessInsulinEffect(index * 5 - 1, { excess_u: -1.25, isf_mgdl: 100, dia_hours: 6 }))));
  });

  it('uses the carbs / ICR unrounded (not the calculator\'s step-rounded dose)', () => {
    // 1 g / 8 = 0.125 j: the calculator's 0.1 j would rise 10 mg/dL at DIA, the carbs rise 12.5.
    const chart = computeBolusForecast(form(1, 0, { horizon_minutes: 360 }))!;
    expect(chart.excess_insulin_u).toBe(-0.13);
    expect(chart.with_excess!.at(-1)! - 111).toBe(Math.round(-excessInsulinEffect(359, { excess_u: -0.125, isf_mgdl: 100, dia_hours: 6 })));
    expect(excessInsulinUnits(0, 1, 0.1, 8)).toBe(-0.125);
    expect(excessInsulinUnits(0, 1, 0.1)).toBe(-0.1);
  });

  it('none with nothing typed, carbs below one pump step of insulin, or no ICR', () => {
    expect(computeBolusForecast(form(0, 0))!.with_excess).toBeNull();
    // 0.3 g / 8 = 0.04 j < 0.05: no line.
    expect(computeBolusForecast(form(0.3, 0))!.with_excess).toBeNull();
    expect(computeBolusForecast(form(10, 0, { icr_insulin_u: null }))!.with_excess).toBeNull();
    // A positive excess only warns ("Po tej dawce"); the carbs-only line's minimum is the loop's start.
    expect(computeBolusForecast(form(10, 0))!.with_excess_min).toBe(111);
  });
});

describe('the insulin curve (insulin-curve.v1)', () => {
  it("maps Trio's preferences as oref: rapid-acting 75, ultra-rapid 55, bilinear 75, a custom peak within oref's range", () => {
    expect(insulinCurveFromTrioPreferences({ curve: 'rapid-acting' })).toMatchObject({ curve: 'rapid-acting', peak_minutes: 75, source: 'TRIO_PREFERENCES', custom_peak: false });
    expect(insulinCurveFromTrioPreferences({ curve: 'ultra-rapid', useCustomPeakTime: false, insulinPeakTime: 40 })).toMatchObject({ peak_minutes: 55, custom_peak: false });
    expect(insulinCurveFromTrioPreferences({ curve: 'bilinear', useCustomPeakTime: true, insulinPeakTime: 60 })).toMatchObject({ curve: 'bilinear', peak_minutes: 75, custom_peak: false });
    expect(insulinCurveFromTrioPreferences({ curve: 'rapid-acting', useCustomPeakTime: true, insulinPeakTime: 65 })).toMatchObject({ peak_minutes: 65, custom_peak: true });
    expect(insulinCurveFromTrioPreferences({ curve: 'ultra-rapid', useCustomPeakTime: true, insulinPeakTime: 45 })).toMatchObject({ peak_minutes: 45, custom_peak: true });
    // oref's limits: rapid-acting 50-120, ultra-rapid 35-100.
    expect(insulinCurveFromTrioPreferences({ curve: 'rapid-acting', useCustomPeakTime: true, insulinPeakTime: 30 })!.peak_minutes).toBe(50);
    expect(insulinCurveFromTrioPreferences({ curve: 'ultra-rapid', useCustomPeakTime: true, insulinPeakTime: 150 })!.peak_minutes).toBe(100);
    expect(insulinCurveFromTrioPreferences({ curve: 'unknown' })).toBeNull();
    expect(insulinCurveFromTrioPreferences(null)).toBeNull();
  });

  it("maps Loop's insulinType as Loop's models: Fiasp / Lyumjev 55, Afrezza 29, Novolog / Humalog / Apidra rapid-acting 75 (child 65)", () => {
    expect(insulinCurveFromLoopInsulinType('Novolog')).toMatchObject({ curve: 'rapid-acting', peak_minutes: 75, source: 'LOOP_INSULIN_TYPE', insulin_type: 'Novolog' });
    expect(insulinCurveFromLoopInsulinType('Humalog', { child: true })).toMatchObject({ curve: 'rapid-acting-child', peak_minutes: 65 });
    expect(insulinCurveFromLoopInsulinType('Fiasp')).toMatchObject({ curve: 'ultra-rapid', peak_minutes: 55 });
    expect(insulinCurveFromLoopInsulinType('Lyumjev')).toMatchObject({ curve: 'ultra-rapid', peak_minutes: 55 });
    expect(insulinCurveFromLoopInsulinType('Afrezza')).toMatchObject({ curve: 'afrezza', peak_minutes: 29 });
    expect(insulinCurveFromLoopInsulinType('Something')).toBeNull();
    expect(insulinCurveFromLoopInsulinType(undefined)).toBeNull();
  });

  it('the chart uses the curve given and says which; without one: rapid-acting 75 min (DEFAULT)', () => {
    const fallback = computeBolusForecast(form(1, 1))!;
    expect(fallback).toMatchObject({ insulin_peak_min: 75, insulin_curve: 'rapid-acting', insulin_curve_source: 'DEFAULT', insulin_type: null, insulin_dia_hours: 6 });
    const fiasp = computeBolusForecast(form(1, 1, { insulin_curve: insulinCurveFromLoopInsulinType('Fiasp') }))!;
    expect(fiasp).toMatchObject({ insulin_peak_min: 55, insulin_curve: 'ultra-rapid', insulin_curve_source: 'LOOP_INSULIN_TYPE', insulin_type: 'Fiasp' });
    // A faster curve acts earlier: lower at 1 h, the same at DIA.
    const at = 60 / 5;
    expect(fiasp.with_excess![at]).toBeLessThan(fallback.with_excess![at]);
    fiasp.with_excess!.forEach((value, index) => {
      expect(value).toBe(Math.max(CGM_FLOOR_MGDL, Math.round(111 - excessInsulinEffect(index * 5 - 1, { excess_u: 0.9, isf_mgdl: 100, dia_hours: 6, peak_minutes: 55 }))));
    });
    // The MODEL chart's dose line uses the same peak.
    const model = (curve?: ReturnType<typeof insulinCurveFromTrioPreferences>) => computeBolusForecast(form(0, 1, { insulin_curve: curve, calibration: { ...FORECAST_PROFILES.none.bolus_chart, draw_dose_line: true } }))!.with_dose!;
    expect(model(insulinCurveFromTrioPreferences({ curve: 'ultra-rapid' }))[at]).toBeLessThan(model()[at]);
    expect(computeBolusForecast(form(1, 1, { dia_hours: 12 }))!.insulin_dia_hours).toBe(10);
  });
});
