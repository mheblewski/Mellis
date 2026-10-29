import { CGM_FLOOR_MGDL, type GlucosePoint } from './cgm-trend';
import type { LoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { GLUCOSE_FORECAST_POLICY, mainLoopCurve, type GlucoseForecast } from './glucose-forecast';

/**
 * Calibration of the loop's main curve (glucose-forecast-calibration.v1): oref's curves extrapolate the current deviation
 * and overshoot, so only part of the change they forecast happens (backtest 2026-10-21,
 * a local report, not published). The calibrated forecast is glucose + w × (the main curve's
 * change), one w per horizon (SHRINK), fitted by least squares on the patient's own device statuses and CGM.
 *
 * Refit after 2–4 weeks with scripts/evaluation/glucose-forecast-calibration-fit.ts on a local restore of a backup and
 * paste its output here as the next version. One patient so far: the coefficients apply to every patient until a
 * per-patient fit exists.
 *
 * Fitted on oref (Trio) curves only: Loop's single curve is another model (momentum, retrospective correction, carbs
 * included) and is used as it is until a Loop fit exists (`source`).
 */

export interface ForecastCalibration {
  version: string;
  /** The forecasts it was fitted on; another source's curve is not scaled. */
  source: LoopPrediction['source'];
  method: 'SHRINK';
  /** The curve whose change is scaled: COB while carbs absorb, else IOB. */
  curve: 'MAIN';
  fitted_at: string;
  data_window: { source: string; from: string; to: string; days: number; calculations: number };
  /** Held-out check (leave one day out): MAIN vs calibrated MAE at +30 min, mg/dL. */
  validation: { mae_main_30: number; mae_calibrated_30: number };
  /** w by minutes ahead (5-min steps); beyond the last one the last w holds. */
  shrink_by_minutes: Record<number, number>;
}

export const GLUCOSE_FORECAST_CALIBRATION: ForecastCalibration = {
  version: 'glucose-forecast-calibration.v1',
  source: 'OPENAPS',
  method: 'SHRINK',
  curve: 'MAIN',
  fitted_at: '2026-10-21',
  data_window: { source: 'glucomind-20261021T031501Z.dump', from: '2026-10-15T07:18:44.965Z', to: '2026-10-21T03:13:31.438Z', days: 5.83, calculations: 1700 },
  validation: { mae_main_30: 25.4, mae_calibrated_30: 21.9 },
  shrink_by_minutes: {
    5: 0.608, 10: 0.5, 15: 0.463, 20: 0.451, 25: 0.43, 30: 0.402,
    35: 0.384, 40: 0.368, 45: 0.353, 50: 0.336, 55: 0.32, 60: 0.3,
    65: 0.281, 70: 0.26, 75: 0.231, 80: 0.204, 85: 0.182, 90: 0.163,
    95: 0.147, 100: 0.135, 105: 0.131, 110: 0.129, 115: 0.128, 120: 0.126,
  },
};

/** w for a horizon: the fitted one at that step, else the nearest fitted step below (the last one beyond the table). */
export function shrinkAt(calibration: ForecastCalibration, minutes: number): number {
  const steps = Object.keys(calibration.shrink_by_minutes).map(Number).sort((a, b) => a - b);
  const step = [...steps].reverse().find((candidate) => candidate <= minutes) ?? steps[0];
  return step === undefined ? 1 : calibration.shrink_by_minutes[step];
}

/** Whether the calibration scales this forecast's curve (it was fitted on the same kind of forecast). */
export function calibrationApplies(forecast: GlucoseForecast, calibration: ForecastCalibration = GLUCOSE_FORECAST_CALIBRATION): boolean {
  return forecast.loop?.source === calibration.source;
}

/**
 * The main loop curve with its change scaled per horizon, 5-min points from the calculation up to the horizon (a
 * trimmed flat tail holds its last value); [] without a fresh loop forecast. A curve the calibration was not fitted on
 * (Loop's) comes back unscaled.
 */
export function calibratedLoopCurve(forecast: GlucoseForecast, horizonMinutes: number, calibration: ForecastCalibration = GLUCOSE_FORECAST_CALIBRATION): GlucosePoint[] {
  const main = mainLoopCurve(forecast);
  if (main.length === 0) return [];
  const shrink = (minutes: number) => (calibrationApplies(forecast, calibration) ? shrinkAt(calibration, minutes) : 1);
  const step = GLUCOSE_FORECAST_POLICY.step_minutes;
  const startMs = Date.parse(main[0].at);
  const base = main[0].value;
  return Array.from({ length: Math.floor(horizonMinutes / step) + 1 }, (_, index) => {
    const raw = main[Math.min(index, main.length - 1)].value;
    const minutes = index * step;
    return {
      at: new Date(startMs + minutes * 60_000).toISOString(),
      value: index === 0 ? base : Math.max(CGM_FLOOR_MGDL, Math.round(base + shrink(minutes) * (raw - base))),
    };
  });
}
