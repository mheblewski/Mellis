import { afterEach, describe, expect, it, vi } from 'vitest';
import { computePlanRisk, planSituation, riskWarning } from './application/card-advice';
import { parseLoopPrediction } from '@modules/loop-system/application/loop-prediction';
import type { MealForecastData } from './application/meal-dose-forecast';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const minutes = (value: number) => new Date(NOW.getTime() + value * 60_000).toISOString();

function data(curve: number[]): MealForecastData {
  return {
    readings: [150, 147, 144, curve[0]].map((value, index) => ({ at: minutes(-1 - (3 - index) * 5), value })),
    prediction: parseLoopPrediction({
      observed_at: minutes(-1),
      raw_payload: { device: 'Trio', openaps: { suggested: { bg: curve[0], deliverAt: minutes(-1), IOB: 0.8, COB: 0, ISF: 45, CR: 10, eventualBG: curve.at(-1), predBGs: { IOB: curve } } } },
    }),
    profile_isf: 45,
    profile_target: 100,
    profile_units: 'mg/dL',
    dia_hours: 6,
  };
}

const flat = [140, 138, 136, 134, 132, 130, 128, 127, 126, 125];
const falling = [72, 66, 60, 55, 50, 46, 43, 40, 39, 39];

describe("a card's forecast risk without a dose line (bolus-forecast.v7, the default)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('a dose by ICR on a steady forecast: no risk', () => {
    const risk = computePlanRisk({ now: NOW, data: data(flat), carbs_g: 45, insulin_u: 4.5, icr_g_per_u: 10 })!;
    expect(risk).toMatchObject({ level: 'NONE', min_mgdl: 125, basis: 'LOOP_WITHOUT_DOSE' });
    expect(riskWarning(risk, { carbs_g: 45, insulin_u: 4.5 })).toBeNull();
  });

  it("too much insulin: the loop's end value with the dose's full effect, named as such", () => {
    const risk = computePlanRisk({ now: NOW, data: data(flat), carbs_g: 0, insulin_u: 2, icr_g_per_u: 10 })!;
    expect(risk).toMatchObject({ level: 'VERY_LOW', basis: 'DOSE_TOTAL', min_in_minutes: 180, baseline_min_mgdl: 125 });
    const warning = riskWarning(risk, { carbs_g: 0, insulin_u: 2 })!;
    expect(warning.severity).toBe('DANGER');
    expect(warning.message).toBe('Trio za ok. 3 h plus pełne działanie tej karty: ok. 39 (zakłada, że pętla nic więcej nie zmieni, prognoza testowa).');
  });

  it("the loop's own forecast going low with a carbs card: a situation line, no warning (card-advice.v2)", () => {
    const risk = computePlanRisk({ now: NOW, data: data(falling), carbs_g: 15, insulin_u: 0, icr_g_per_u: 10 })!;
    expect(risk.basis).toBe('LOOP_WITHOUT_DOSE');
    expect(risk.level).toBe('VERY_LOW');
    expect(riskWarning(risk, { carbs_g: 15, insulin_u: 0 })).toBeNull();
    const situation = planSituation(risk, { carbs_g: 15, insulin_u: 0 })!;
    expect(situation.text).toMatch(/^Bez tej karty Trio przewiduje spadek do ok\. \d+ za/);
    expect(situation.text).toContain('Węglowodany z karty go łagodzą.');
    // Insulin now on top of that low: the card's own warning, as before.
    expect(planSituation(risk, { carbs_g: 15, insulin_u: 1 })).toBeNull();
    // Review 2026-11-10: red only when below 54 within the hour; later, the loop's forecast without food is a plain line.
    const warning = riskWarning(risk, { carbs_g: 15, insulin_u: 1 })!;
    expect(warning.severity).toBe(risk.min_mgdl < 54 && risk.min_in_minutes <= 60 ? 'DANGER' : 'WARNING');
  });

  it("the loop's own forecast going low with insulin alone: still the card's warning", () => {
    const risk = computePlanRisk({ now: NOW, data: data(falling), carbs_g: 0, insulin_u: 0.5, icr_g_per_u: 10 })!;
    expect(planSituation(risk, { carbs_g: 0, insulin_u: 0.5 })).toBeNull();
    expect(riskWarning(risk, { carbs_g: 0, insulin_u: 0.5 })).not.toBeNull();
  });

  it('a card with carbs is red only below 54 within the hour; insulin alone below 54 always (review 2026-11-10)', () => {
    const soon = { policy_version: 'card-advice.v2', min_mgdl: 50, min_in_minutes: 40, level: 'VERY_LOW' as const, baseline_min_mgdl: 110, basis: 'WITH_DOSE' as const, loop_name: 'Trio' };
    expect(riskWarning(soon, { carbs_g: 30, insulin_u: 4 })!.severity).toBe('DANGER');
    // 10.11, 11:12: the loop's 45 in 3 h without food, on a card with 11 g: a plain line, no "ciężkiego", no "mg/dL".
    const without = { ...soon, min_mgdl: 45, min_in_minutes: 180, basis: 'LOOP_WITHOUT_DOSE' as const };
    expect(riskWarning(without, { carbs_g: 11, insulin_u: 1.3 })).toMatchObject({ severity: 'WARNING', message: 'Bez jedzenia Trio przewiduje spadek do ok. 45 za ok. 3 h (prognoza testowa).' });
  });

  it('the worst case of a card with carbs is at most a warning', () => {
    const risk = { policy_version: 'card-advice.v2', min_mgdl: 48, min_in_minutes: 180, level: 'VERY_LOW' as const, baseline_min_mgdl: 110, basis: 'DOSE_TOTAL' as const, loop_name: 'Trio' };
    expect(riskWarning(risk, { carbs_g: 30, insulin_u: 4 })!.severity).toBe('WARNING');
    expect(riskWarning(risk, { carbs_g: 0, insulin_u: 4 })!.severity).toBe('DANGER');
  });

  it('with FORECAST_CALIBRATION=fitted-v1 the line with the card decides, as before', () => {
    vi.stubEnv('FORECAST_CALIBRATION', 'fitted-v1');
    const risk = computePlanRisk({ now: NOW, data: data(flat), carbs_g: 0, insulin_u: 2, icr_g_per_u: 10 })!;
    expect(risk.basis).toBe('WITH_DOSE');
    expect(riskWarning(risk, { carbs_g: 0, insulin_u: 2 })!.message).toMatch(/^Z tą kartą prognoza spada/);
  });
});
