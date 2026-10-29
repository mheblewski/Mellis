import { afterEach, describe, expect, it, vi } from 'vitest';
import { computePlanRisk, riskWarning } from './application/card-advice';
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
    expect(warning.message).toBe('Prognoza Trio za ok. 180 min plus pełne działanie tej karty: ok. 39 mg/dL, ryzyko ciężkiego niedocukrzenia (zakłada, że pętla nic więcej nie zmieni).');
  });

  it("the loop's own forecast going low: named as the loop's forecast without the card", () => {
    const risk = computePlanRisk({ now: NOW, data: data(falling), carbs_g: 15, insulin_u: 0, icr_g_per_u: 10 })!;
    expect(risk.basis).toBe('LOOP_WITHOUT_DOSE');
    expect(risk.level).toBe('VERY_LOW');
    expect(riskWarning(risk, { carbs_g: 15, insulin_u: 0 })!.message).toContain('bez tej karty');
  });

  it('with FORECAST_CALIBRATION=fitted-v1 the line with the card decides, as before', () => {
    vi.stubEnv('FORECAST_CALIBRATION', 'fitted-v1');
    const risk = computePlanRisk({ now: NOW, data: data(flat), carbs_g: 0, insulin_u: 2, icr_g_per_u: 10 })!;
    expect(risk.basis).toBe('WITH_DOSE');
    expect(riskWarning(risk, { carbs_g: 0, insulin_u: 2 })!.message).toMatch(/^Prognoza z tą kartą/);
  });
});
