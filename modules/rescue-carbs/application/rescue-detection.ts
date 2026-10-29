import type { GlucosePoint } from '@modules/glucose-forecast/application/cgm-trend';
import {
  bestCurve,
  buildGlucoseForecast,
  cgmProjection,
  firstCrossing,
  loopCurve,
  lowestWithin,
  mainLoopCurve,
  minutesUntil,
  type ForecastCurveName,
  type GlucoseForecast,
} from '@modules/glucose-forecast/application/glucose-forecast';
import { activeForecastCalibration, calibratedLoopCurve, calibrationApplies, type ForecastCalibration } from '@modules/glucose-forecast/application/forecast-calibration';
import type { LoopPrediction } from '@modules/loop-system/application/loop-prediction';

/**
 * Is a low coming (rescue-carbs.v1, the rescue-carbs plan)? One evaluation of the newest CGM readings and
 * the loop's forecast. Thresholds and horizons are the sourced ones (70 / 54 mg/dL, 20–30 min, Trio's carbsReq); the
 * exact cutoffs below are design choices to tune on the child's alerts and their outcomes.
 */

export const RESCUE_DETECTION_POLICY = {
  version: 'rescue-carbs.v1',
  low_mgdl: 70,
  urgent_mgdl: 54,
  /** Glucose and forecasts at or above this for 15 min close an alert (10 mg/dL hysteresis). */
  clear_mgdl: 80,
  /** Reading and loop freshness (10 min, the loop's calculation within 7 min of the newest reading): glucose-forecast.v1. */
  min_readings: 3,
  min_readings_window_minutes: 20,
  /** How far ahead the forecast curves are read: 6 steps of 5 min. */
  horizon_minutes: 30,
  /** Trio's carbsReq that counts as "carbs needed". */
  min_carbs_req_g: 3,
  /** CGM-only fallback: glucose + slope × this < 70. */
  cgm_projection_minutes: 20,
  /**
   * Carbs logged this recently: wait for them to act (recheck after 15 min). Owner decision 2026-10-26: a predicted low
   * waits for any carbs, a low now (< 70) only for rescue carbs (HYPO_TREATMENT; a meal acts too slowly), and < 54
   * never waits.
   */
  recent_carbs_minutes: 15,
} as const;

export type RescueLevel = 'PREDICTED_LOW' | 'LOW_NOW' | 'URGENT_LOW';
export type RescueTriggerSource = 'TRIO_CARBS_REQ' | 'TRIO_PREDICTION' | 'CGM_TREND' | 'CGM_LOW';

export type RescueReading = GlucosePoint;

export interface RescueDetectionInput {
  now: Date;
  /** CGM readings, oldest first (the last ~40 min are enough). */
  readings: RescueReading[];
  prediction: LoopPrediction | null;
  /** Newest eaten carb entry (loop or GlucoMind, a meal or rescue carbs) at or before now, if any. */
  last_carbs_at: string | null;
  /**
   * Newest rescue carbs (HYPO_TREATMENT) at or before now. Undefined: the kind is unknown (the offline backtest), so
   * last_carbs_at may be rescue carbs and holds a low now back as before.
   */
  last_hypo_treatment_at?: string | null;
}

export interface RescueEvaluation {
  policy_version: string;
  evaluated_at: string;
  status: 'TRIGGER' | 'CLEAR' | 'SUPPRESSED' | 'NO_DATA';
  level: RescueLevel | null;
  trigger_source: RescueTriggerSource | null;
  suppressed_reason: 'RECENT_CARBS' | 'RISING' | null;
  no_data_reason: 'NO_READINGS' | 'STALE_READING' | 'TOO_FEW_READINGS' | null;
  glucose: RescueReading | null;
  delta_per_5min: number | null;
  /** mg/dL per minute over the last ~15 min (oref's short average delta). */
  slope_per_min: number | null;
  /** Whether the loop's forecast was fresh enough to be used. */
  loop_used: boolean;
  carbs_req_g: number | null;
  /** Lowest forecast within the horizon (the curve that triggered, else the CGM projection). */
  predicted_min_mgdl: number | null;
  predicted_low_at: string | null;
  minutes_to_low: number | null;
  /** The curve behind the forecast: which one and its points within the horizon. */
  curve: { name: ForecastCurveName | 'CGM'; includes_cob: boolean; points: RescueReading[] } | null;
  /** Glucose and every forecast used are >= 80: counts towards closing an alert. */
  clear: boolean;
  /**
   * rescue-carbs.v2 only (absent in v1): the early signals behind a PREDICTED_LOW, and whether it is confirmed (the
   * calibrated forecast crosses 70 within 30 min, or the CGM itself is falling). Only a confirmed one is pushed.
   */
  signals?: RescueSignal[];
  confirmed?: boolean;
  confirmation?: 'CALIBRATED_FORECAST' | 'CGM_FALLING' | null;
  /** The (calibrated, FORECAST_CALIBRATION) forecast's lowest point within 30 min and its first point below 70; without a calibration the loop's own curve. */
  calibrated_min_mgdl?: number | null;
  calibrated_low_at?: string | null;
  calibration_version?: string | null;
}

/** Offline variants of v2 (the backtest); production passes none. */
export interface RescueV2PolicyOverrides {
  cgm_confirm_minutes?: number;
  cgm_trend_with_loop?: boolean;
  /** Confirm by the calibrated forecast only. */
  calibrated_only?: boolean;
  /** The calibrated forecast confirms below this within 30 min (default 70). */
  calibrated_confirm_mgdl?: number;
}

/** rescue-carbs.v2's early signals: each starts the PENDING step, none pushes alone. */
export type RescueSignal = 'TRIO_CARBS_REQ' | 'TRIO_ZT' | 'CALIBRATED_FORECAST' | 'CGM_TREND';

/**
 * rescue-carbs.v2: Trio's raw signals keep the early warning, the forecast (the loop's own curve, or the calibrated one
 * with FORECAST_CALIBRATION=fitted-v1) or the CGM confirms it before a push. LOW_NOW / URGENT_LOW, suppression, the curve and the
 * predicted minimum (what rescue-dose.v2 and the push text read) are v1's.
 */
export const RESCUE_DETECTION_POLICY_V2 = {
  ...RESCUE_DETECTION_POLICY,
  version: 'rescue-carbs.v2',
  /** "The CGM itself is falling" towards a low: the last two changes negative and glucose + slope × this < 70. */
  cgm_confirm_minutes: 30,
  /** CGM trend counts as an early signal also with a fresh loop forecast. */
  cgm_trend_with_loop: true,
} as const;

interface RescueAssessment {
  base: RescueEvaluation;
  /** Set when there is no usable data: the evaluation to return as is. */
  done: RescueEvaluation | null;
  forecast: GlucoseForecast;
  latest: RescueReading;
  delta: number | null;
  slope: number | null;
  projection: number | null;
  zt: RescueReading[];
  main: RescueReading[];
  common: Pick<RescueEvaluation, 'glucose' | 'delta_per_5min' | 'slope_per_min' | 'loop_used' | 'carbs_req_g'>;
  forecastPart: Pick<RescueEvaluation, 'predicted_min_mgdl' | 'predicted_low_at' | 'minutes_to_low' | 'curve'>;
  clear: boolean;
}

/** The data checks, CGM trend and Trio's curves both versions read. */
function assess(input: RescueDetectionInput, version: string): RescueAssessment | RescueEvaluation {
  const policy = RESCUE_DETECTION_POLICY;
  const forecast = buildGlucoseForecast({ now: input.now, readings: input.readings, prediction: input.prediction });
  const readings = forecast.readings;
  const base: RescueEvaluation = {
    policy_version: version,
    evaluated_at: input.now.toISOString(),
    status: 'NO_DATA',
    level: null,
    trigger_source: null,
    suppressed_reason: null,
    no_data_reason: null,
    glucose: null,
    delta_per_5min: null,
    slope_per_min: null,
    loop_used: false,
    carbs_req_g: null,
    predicted_min_mgdl: null,
    predicted_low_at: null,
    minutes_to_low: null,
    curve: null,
    clear: false,
  };
  const latest = forecast.glucose;
  if (!latest) return { ...base, no_data_reason: 'NO_READINGS' };
  const latestMs = Date.parse(latest.at);
  if (!forecast.reading_fresh) return { ...base, glucose: latest, no_data_reason: 'STALE_READING' };
  const windowReadings = readings.filter((reading) => latestMs - Date.parse(reading.at) <= policy.min_readings_window_minutes * 60_000);
  if (windowReadings.length < policy.min_readings) return { ...base, glucose: latest, no_data_reason: 'TOO_FEW_READINGS' };

  const delta = forecast.delta_per_5min;
  const slope = forecast.slope_per_min;
  const projection = cgmProjection(forecast, policy.cgm_projection_minutes);
  const loop = forecast.loop;

  // oref's own curves: insulin-only with basal suspended (ZT), and the main one (COB while carbs absorb, else IOB).
  const zt = loopCurve(forecast, 'ZT', policy.horizon_minutes);
  const main = mainLoopCurve(forecast, policy.horizon_minutes);
  const common = {
    glucose: latest,
    delta_per_5min: delta,
    slope_per_min: slope === null ? null : Math.round(slope * 100) / 100,
    loop_used: loop !== null,
    carbs_req_g: loop?.carbs_req_g ?? null,
  };
  const picked = bestCurve(forecast, policy.horizon_minutes);
  const low = lowCrossing(picked.points);
  const forecastPart = {
    predicted_min_mgdl: lowestWithin(picked.points)?.value ?? null,
    predicted_low_at: low?.at ?? null,
    minutes_to_low: minutesUntil(low, input.now),
    curve: { name: picked.name, includes_cob: picked.name !== 'CGM' && forecast.main_includes_cob, points: picked.points },
  };
  const clear = latest.value >= policy.clear_mgdl
    && (forecastPart.predicted_min_mgdl === null || forecastPart.predicted_min_mgdl >= policy.clear_mgdl)
    && (projection === null || projection >= policy.clear_mgdl);
  return { base, done: null, forecast, latest, delta, slope, projection, zt, main, common, forecastPart, clear };
}

const lowCrossing = (points: RescueReading[]): RescueReading | null => firstCrossing(points, RESCUE_DETECTION_POLICY.low_mgdl, 'BELOW');

/** A low now from the CGM value (both versions). */
function lowNow(latest: RescueReading): { level: RescueLevel; source: RescueTriggerSource } | null {
  const policy = RESCUE_DETECTION_POLICY;
  if (latest.value < policy.urgent_mgdl) return { level: 'URGENT_LOW', source: 'CGM_LOW' };
  if (latest.value < policy.low_mgdl) return { level: 'LOW_NOW', source: 'CGM_LOW' };
  return null;
}

/** Recent carbs (by level and kind) and a turn upwards hold a flag back (both versions). */
function suppress(input: RescueDetectionInput, assessment: RescueAssessment, evaluation: RescueEvaluation): RescueEvaluation {
  const policy = RESCUE_DETECTION_POLICY;
  const nowMs = input.now.getTime();
  const { delta, slope, projection, latest } = assessment;
  const recent = (iso: string | null | undefined): boolean => {
    const carbsMs = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(carbsMs) && nowMs - carbsMs >= 0 && nowMs - carbsMs < policy.recent_carbs_minutes * 60_000;
  };
  // Owner decision 2026-10-26: < 54 is never held back; < 70 right after a meal is pushed (only rescue carbs wait).
  const holdingCarbs = evaluation.level === 'URGENT_LOW'
    ? false
    : evaluation.level === 'LOW_NOW'
      ? recent(input.last_hypo_treatment_at === undefined ? input.last_carbs_at : input.last_hypo_treatment_at)
      : recent(input.last_carbs_at);
  if (holdingCarbs) return { ...evaluation, status: 'SUPPRESSED', suppressed_reason: 'RECENT_CARBS' };
  // Already turning up: a forecast low that the readings no longer support, or a mild low clearly recovering.
  const rising = delta !== null && delta > 0;
  if (evaluation.level === 'PREDICTED_LOW' && rising && projection !== null && projection >= policy.low_mgdl) {
    return { ...evaluation, status: 'SUPPRESSED', suppressed_reason: 'RISING' };
  }
  if (evaluation.level === 'LOW_NOW' && delta !== null && delta >= 2 && slope !== null && latest.value + slope * 15 >= 75) {
    return { ...evaluation, status: 'SUPPRESSED', suppressed_reason: 'RISING' };
  }
  return evaluation;
}

export function evaluateRescueNeed(input: RescueDetectionInput): RescueEvaluation {
  const policy = RESCUE_DETECTION_POLICY;
  const assessment = assess(input, policy.version);
  if (!('done' in assessment)) return assessment;
  const { base, common, forecastPart, clear, latest, forecast, zt, main, projection } = assessment;
  const loop = forecast.loop;

  let level: RescueLevel | null = null;
  let source: RescueTriggerSource | null = null;
  const now = lowNow(latest);
  if (now) {
    ({ level, source } = now);
  } else if (loop && loop.source === 'OPENAPS') {
    // v1 reads oref's own signals; Loop has neither carbsReq nor a zero-temp curve, so it falls to the CGM trend.
    if ((loop.carbs_req_g ?? 0) >= policy.min_carbs_req_g) {
      level = 'PREDICTED_LOW';
      source = 'TRIO_CARBS_REQ';
    } else if (zt.length > 1 && lowCrossing(zt) && main.length > 1 && lowCrossing(main)) {
      // A low even with basal suspended: the loop alone cannot prevent it.
      level = 'PREDICTED_LOW';
      source = 'TRIO_PREDICTION';
    }
  } else if (projection !== null && projection < policy.low_mgdl && forecast.falling) {
    level = 'PREDICTED_LOW';
    source = 'CGM_TREND';
  }

  if (!level) return { ...base, ...common, ...forecastPart, status: 'CLEAR', clear };
  return suppress(input, assessment, { ...base, ...common, ...forecastPart, status: 'TRIGGER', level, trigger_source: source, clear: false });
}

/**
 * rescue-carbs.v2: a PREDICTED_LOW flag from any early signal (Trio's carbsReq ≥ 3 g, the zero-temp curve below 70
 * within 30 min, the calibrated forecast below 70, or the CGM trend below 70 in 20 min while falling), confirmed when
 * the calibrated forecast crosses 70 within 30 min or the CGM itself is falling towards a low (the last two readings
 * fall and the CGM trend is below 70 within 30 min). Without a fresh loop forecast only the
 * CGM trend can flag and confirm.
 */
export function evaluateRescueNeedV2(
  input: RescueDetectionInput & { calibration?: ForecastCalibration; policy?: RescueV2PolicyOverrides },
): RescueEvaluation {
  const policy = { ...RESCUE_DETECTION_POLICY_V2, ...input.policy };
  const calibration = input.calibration ?? activeForecastCalibration();
  const assessment = assess(input, policy.version);
  if (!('done' in assessment)) return assessment;
  const { base, common, forecastPart, clear, latest, forecast, zt, projection } = assessment;
  const loop = forecast.loop;

  const calibrated = calibratedLoopCurve(forecast, policy.horizon_minutes, calibration);
  const calibratedLow = lowCrossing(calibrated);
  const confirmProjection = cgmProjection(forecast, policy.cgm_confirm_minutes);
  const cgmFalling = !input.policy?.calibrated_only && forecast.falling && confirmProjection !== null && confirmProjection < policy.low_mgdl;
  const cgmTrend = projection !== null && projection < policy.low_mgdl && forecast.falling;
  const signals: RescueSignal[] = [];
  if (loop && (loop.carbs_req_g ?? 0) >= policy.min_carbs_req_g) signals.push('TRIO_CARBS_REQ');
  if (loop && zt.length > 1 && lowCrossing(zt)) signals.push('TRIO_ZT');
  if (calibratedLow) signals.push('CALIBRATED_FORECAST');
  if (cgmTrend && (!loop || policy.cgm_trend_with_loop)) signals.push('CGM_TREND');
  const confirmBelow = input.policy?.calibrated_confirm_mgdl ?? policy.low_mgdl;
  const calibratedConfirms = calibratedLow !== null || (confirmBelow !== policy.low_mgdl && firstCrossing(calibrated, confirmBelow, 'BELOW') !== null);
  const confirmation = calibratedConfirms ? 'CALIBRATED_FORECAST' as const : cgmFalling ? 'CGM_FALLING' as const : null;
  const v2 = {
    calibrated_min_mgdl: lowestWithin(calibrated)?.value ?? null,
    calibrated_low_at: calibratedLow?.at ?? null,
    calibration_version: calibrated.length > 0 && calibrationApplies(forecast, calibration) ? calibration.version : null,
  };

  const now = lowNow(latest);
  let level: RescueLevel | null = now?.level ?? null;
  let source: RescueTriggerSource | null = now?.source ?? null;
  if (!now && signals.length > 0) {
    level = 'PREDICTED_LOW';
    // The stored trigger_source keeps v1's names (a CHECK in rescue_carb_alerts); `signals` has the detail.
    source = signals[0] === 'TRIO_CARBS_REQ' ? 'TRIO_CARBS_REQ' : signals[0] === 'CGM_TREND' ? 'CGM_TREND' : 'TRIO_PREDICTION';
  }
  const v2Fields = { ...v2, signals, confirmed: level === 'PREDICTED_LOW' ? confirmation !== null : now !== null, confirmation: level === 'PREDICTED_LOW' ? confirmation : null };
  if (!level) return { ...base, ...common, ...forecastPart, status: 'CLEAR', clear: clear && (v2.calibrated_min_mgdl === null || v2.calibrated_min_mgdl >= policy.clear_mgdl), ...v2Fields, confirmed: false };
  return suppress(input, assessment, { ...base, ...common, ...forecastPart, status: 'TRIGGER', level, trigger_source: source, clear: false, ...v2Fields });
}
