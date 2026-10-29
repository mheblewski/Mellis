import { CGM_FLOOR_MGDL, type GlucosePoint } from './cgm-trend';
import type { LoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { GLUCOSE_FORECAST_POLICY, mainLoopCurve, type GlucoseForecast } from './glucose-forecast';

/**
 * One switch for every forecast correction (env FORECAST_CALIBRATION): rescue alerts (rescue-detection), the meal dose
 * for a falling glucose (meal-dose-forecast), deferred and planned bolus parts, care reminders and the bolus forecast
 * chart (Bolus tab, chat cards) all read the active profile here.
 *
 * - unset / `none` (the default for everyone): the loop's own forecast (Trio/Loop) as it is — no shrink of its curve,
 *   the carbs' effect at ISF / ICR (× 1), no extra delay for fatty meals, the chart's baseline = the loop's main curve.
 * - `fitted-v1`: coefficients fitted on ONE patient's data (Trio, a local backup of ~6 days, 1700 calculations, and his
 *   bolused meals). Dopasowane do jednego pacjenta, włączaj tylko u niego: on another person they may make the forecast
 *   too flat (fewer low warnings) or too late.
 *
 * An unknown value fails at startup (assertForecastCalibrationEnv) instead of silently picking one.
 */

export type ForecastCalibrationId = 'none' | 'fitted-v1';

/**
 * Shrink of the loop's main curve: the forecast is glucose + w × (the main curve's change), one w per horizon. Fitted by
 * least squares on device statuses and CGM (scripts/evaluation/glucose-forecast-calibration-fit.ts on a local restore).
 * Fitted on oref (Trio) curves only: Loop's single curve is another model and is never scaled (`source`).
 */
export interface ForecastCalibration {
  version: string;
  /** The forecasts it was fitted on; another source's curve is not scaled; null scales nothing. */
  source: LoopPrediction['source'] | null;
  method: 'SHRINK' | 'NONE';
  /** The curve whose change is scaled: COB while carbs absorb, else IOB. */
  curve: 'MAIN';
  fitted_at: string | null;
  data_window: { source: string; days: number; calculations: number } | null;
  /** Held-out check (leave one day out): MAIN vs calibrated MAE at +30 min, mg/dL. */
  validation: { mae_main_30: number; mae_calibrated_30: number };
  /** w by minutes ahead (5-min steps); beyond the last one the last w holds; empty: w = 1. */
  shrink_by_minutes: Record<number, number>;
}

/** The bolus forecast chart's patient-fitted parts (bolus-forecast.ts). */
export interface BolusChartCalibration {
  /** The carbs' effect relative to ISF / ICR (1 = textbook). */
  carb_effect_scale: number;
  /** A fatty meal starts absorbing this much later, min (0 = no extra delay). */
  fatty_meal_delay_minutes: number;
  /** Baseline = mean of the loop's main and unannounced-meal (UAM) curves instead of the main curve alone. */
  baseline_uam_mean: boolean;
  /** Half-width of the chart's band at +30 min (the forecast's error there), growing with √time. */
  band_mae_30_mgdl: number;
}

export interface ForecastProfile {
  id: ForecastCalibrationId;
  calibration: ForecastCalibration;
  bolus_chart: BolusChartCalibration;
}

/** The loop's own forecast, untouched. */
export const NO_FORECAST_CALIBRATION: ForecastCalibration = {
  version: 'none',
  source: null,
  method: 'NONE',
  curve: 'MAIN',
  fitted_at: null,
  data_window: null,
  validation: { mae_main_30: 25.4, mae_calibrated_30: 25.4 },
  shrink_by_minutes: {},
};

/** Fitted on one patient (Trio): opt-in only, FORECAST_CALIBRATION=fitted-v1. */
export const FITTED_V1_FORECAST_CALIBRATION: ForecastCalibration = {
  version: 'glucose-forecast-calibration.v1',
  source: 'OPENAPS',
  method: 'SHRINK',
  curve: 'MAIN',
  fitted_at: '2026-10',
  data_window: { source: 'local backup', days: 6, calculations: 1700 },
  validation: { mae_main_30: 25.4, mae_calibrated_30: 21.9 },
  shrink_by_minutes: {
    5: 0.608, 10: 0.5, 15: 0.463, 20: 0.451, 25: 0.43, 30: 0.402,
    35: 0.384, 40: 0.368, 45: 0.353, 50: 0.336, 55: 0.32, 60: 0.3,
    65: 0.281, 70: 0.26, 75: 0.231, 80: 0.204, 85: 0.182, 90: 0.163,
    95: 0.147, 100: 0.135, 105: 0.131, 110: 0.129, 115: 0.128, 120: 0.126,
  },
};

export const FORECAST_PROFILES: Record<ForecastCalibrationId, ForecastProfile> = {
  none: {
    id: 'none',
    calibration: NO_FORECAST_CALIBRATION,
    bolus_chart: { carb_effect_scale: 1, fatty_meal_delay_minutes: 0, baseline_uam_mean: false, band_mae_30_mgdl: NO_FORECAST_CALIBRATION.validation.mae_main_30 },
  },
  'fitted-v1': {
    id: 'fitted-v1',
    calibration: FITTED_V1_FORECAST_CALIBRATION,
    // Fitted with the insulin curve on one patient's bolused meals (leave-one-out over 3 h), the fatty-meal delay on his
    // meals with macros, the UAM mean on his loop calculations without a dose in the next 2 h.
    bolus_chart: { carb_effect_scale: 0.7, fatty_meal_delay_minutes: 15, baseline_uam_mean: true, band_mae_30_mgdl: FITTED_V1_FORECAST_CALIBRATION.validation.mae_calibrated_30 },
  },
};

export class ForecastCalibrationConfigError extends Error {}

/** The profile FORECAST_CALIBRATION names; unset or empty = none. Throws on an unknown value. */
export function forecastProfileFromEnv(env: NodeJS.ProcessEnv = process.env): ForecastProfile {
  const raw = String(env.FORECAST_CALIBRATION ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'none') return FORECAST_PROFILES.none;
  if (raw === 'fitted-v1') return FORECAST_PROFILES['fitted-v1'];
  throw new ForecastCalibrationConfigError(`FORECAST_CALIBRATION must be empty, "none" or "fitted-v1" (got "${raw}")`);
}

/** Called at API and worker startup: a typo stops the process instead of falling back silently. */
export function assertForecastCalibrationEnv(env: NodeJS.ProcessEnv = process.env): ForecastCalibrationId {
  return forecastProfileFromEnv(env).id;
}

/** The active profile (read on every call, so a spec can stub the env). */
export function activeForecastProfile(): ForecastProfile {
  return forecastProfileFromEnv(process.env);
}

/** The active shrink calibration: NO_FORECAST_CALIBRATION unless FORECAST_CALIBRATION=fitted-v1. */
export function activeForecastCalibration(): ForecastCalibration {
  return activeForecastProfile().calibration;
}

/** w for a horizon: the fitted one at that step, else the nearest fitted step below (the last one beyond the table). */
export function shrinkAt(calibration: ForecastCalibration, minutes: number): number {
  const steps = Object.keys(calibration.shrink_by_minutes).map(Number).sort((a, b) => a - b);
  const step = [...steps].reverse().find((candidate) => candidate <= minutes) ?? steps[0];
  return step === undefined ? 1 : calibration.shrink_by_minutes[step];
}

/** Whether the calibration scales this forecast's curve (it was fitted on the same kind of forecast). */
export function calibrationApplies(forecast: GlucoseForecast, calibration: ForecastCalibration = activeForecastCalibration()): boolean {
  return calibration.source !== null && forecast.loop?.source === calibration.source;
}

/**
 * The main loop curve with its change scaled per horizon (as is without a calibration), 5-min points from the
 * calculation up to the horizon (a trimmed flat tail holds its last value); [] without a fresh loop forecast. A curve
 * the calibration was not fitted on (Loop's) comes back unscaled.
 */
export function calibratedLoopCurve(forecast: GlucoseForecast, horizonMinutes: number, calibration: ForecastCalibration = activeForecastCalibration()): GlucosePoint[] {
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
