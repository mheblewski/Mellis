import { describe, expect, it } from 'vitest';
import { parseLoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { correctionWarnings } from '@modules/remote-commands/application/card-advice';
import { evaluateRescueNeedV2 } from '@modules/rescue-carbs/application/rescue-detection';
import { calibratedLoopCurve, calibrationApplies, FITTED_V1_FORECAST_CALIBRATION } from './application/forecast-calibration';
import { buildGlucoseForecast } from './application/glucose-forecast';

/** Loop's forecast (one combined curve, carbs included) next to Trio's: the calibration fitted on Trio stays Trio's. */
const NOW = new Date('2026-10-28T12:00:00.000Z');
const minutes = (value: number) => new Date(NOW.getTime() + value * 60_000).toISOString();
const readings = [140, 136, 132, 128, 124].map((value, index) => ({ at: minutes(-1 - (4 - index) * 5), value }));

function loop(values: number[], extra: Record<string, unknown> = {}) {
  return parseLoopPrediction({
    observed_at: minutes(-1),
    raw_payload: { device: 'loop://iPhone', loop: { name: 'Loop', timestamp: minutes(-1), iob: { iob: 2 }, cob: { cob: 20 }, predicted: { startDate: minutes(-1), values }, ...extra } },
  });
}

function trio(values: number[]) {
  return parseLoopPrediction({ observed_at: minutes(-1), raw_payload: { device: 'Trio', openaps: { suggested: { deliverAt: minutes(-1), bg: values[0], IOB: 2, COB: 0, eventualBG: values.at(-1), predBGs: { IOB: values } } } } });
}

describe('Loop\'s forecast', () => {
  it('is used unscaled: the calibration was fitted on Trio\'s curves', () => {
    const falling = Array.from({ length: 25 }, (_, index) => 124 - index * 3);
    const loopForecast = buildGlucoseForecast({ now: NOW, readings, prediction: loop(falling) });
    const trioForecast = buildGlucoseForecast({ now: NOW, readings, prediction: trio(falling) });
    // By default nothing is scaled; with the opt-in fitted-v1 only Trio's curve.
    expect([calibrationApplies(loopForecast), calibrationApplies(trioForecast)]).toEqual([false, false]);
    expect(calibratedLoopCurve(trioForecast, 60).at(-1)!.value).toBe(falling[12]);
    const fitted = FITTED_V1_FORECAST_CALIBRATION;
    expect([calibrationApplies(loopForecast, fitted), calibrationApplies(trioForecast, fitted)]).toEqual([false, true]);
    expect(calibratedLoopCurve(loopForecast, 60, fitted).at(-1)?.value).toBe(falling[12]);
    expect(calibratedLoopCurve(trioForecast, 60, fitted).at(-1)!.value).toBeGreaterThan(falling[12]);
  });

  it('already counts the carbs still absorbing: the rescue dose does not credit COB again', () => {
    const forecast = buildGlucoseForecast({ now: NOW, readings, prediction: loop(Array.from({ length: 13 }, (_, index) => 124 - index * 5)) });
    expect(forecast.main_includes_cob).toBe(true);
    const evaluation = evaluateRescueNeedV2({ now: NOW, readings, prediction: forecast.loop, last_carbs_at: null });
    expect(evaluation.curve?.includes_cob).toBe(true);
    // The calibration is not Loop's: it is not named as the one used.
    expect(evaluation.calibration_version ?? null).toBeNull();
  });

  it('warns that a correction stacks on Loop\'s own bolus recommendation, naming Loop', () => {
    const prediction = loop([240, 238, 236], { recommendedBolus: 1.2 });
    const warnings = correctionWarnings({ now: NOW, data: { readings: [{ at: minutes(-1), value: 240 }], prediction, profile_isf: 50, profile_target: 100, profile_units: 'mg/dL' }, timezone: 'Europe/Warsaw' });
    expect(warnings.find((warning) => warning.code === 'CORRECTION_STACKING')?.message).toBe('Loop sam dokłada insulinę na ten poziom (zalecany bolus 1,2 j): korekta z karty sumuje się z nią.');
  });
});
