import { CGM_FLOOR_MGDL, cleanReadings, deltaPerFiveMinutes, lastTwoFalling, projectLinear, shortAverageSlope, type GlucosePoint } from './cgm-trend';
import type { LoopPrediction, LoopPredictionCurves } from '@modules/loop-system/application/loop-prediction';
import { CURRENT_READING_MAX_AGE_MINUTES } from '@shared/primitives/glucose-rules';

/**
 * One normalized glucose forecast (glucose-forecast.v1): the newest CGM reading and its trend, and the loop's own
 * forecast when it is fresh and belongs to that reading. Rescue carbs (rescue-carbs.v1) and the meal bolus card
 * (meal-dose-forecast.v3) read it; hypo and hyper prediction are meant to. Nothing here is a clinical decision: the
 * callers hold the thresholds they act on.
 *
 * Trio / AAPS (oref) curves are 5-min steps from the calculation time and end early once they flatten (oref drops
 * repeated tail values), so a curve's last value holds after its end. Loop's single curve is read as IOB.
 */

export const GLUCOSE_FORECAST_POLICY = {
  version: 'glucose-forecast.v1',
  /** The newest reading must be this recent for anything to be forecast. */
  max_reading_age_minutes: CURRENT_READING_MAX_AGE_MINUTES,
  /** The loop's calculation must be this recent... */
  max_loop_age_minutes: CURRENT_READING_MAX_AGE_MINUTES,
  /** ...and belong to the newest reading (Trio computes right after each one). */
  max_loop_reading_skew_minutes: 7,
  step_minutes: 5,
} as const;

/** The usual thresholds a forecast is held against, mg/dL. */
export const GLUCOSE_THRESHOLDS = { low_mgdl: 70, high_mgdl: 180, very_high_mgdl: 250 } as const;

export type ForecastCurveName = keyof LoopPredictionCurves;
export type ForecastSource = LoopPrediction['source'] | 'CGM_TREND' | 'NONE';
export type LoopForecastState = 'FRESH' | 'STALE' | 'NOT_FOR_READING' | 'NONE';

export interface GlucoseForecast {
  policy_version: string;
  now: string;
  /** Valid readings, oldest first. */
  readings: GlucosePoint[];
  glucose: GlucosePoint | null;
  reading_age_minutes: number | null;
  reading_fresh: boolean;
  delta_per_5min: number | null;
  /** mg/dL per minute over the last ~15 min (oref's short average delta), unrounded. */
  slope_per_min: number | null;
  /** The last two reading-to-reading changes are negative. */
  falling: boolean;
  /** The loop's forecast when fresh, else null (see loop_state). */
  loop: LoopPrediction | null;
  loop_state: LoopForecastState;
  loop_age_minutes: number | null;
  /** Where the forecast curve comes from: the loop when fresh, else the CGM trend, else nothing. */
  source: ForecastSource;
  /** oref's main curve: COB while carbs absorb, else IOB (Loop's single curve). */
  main_curve: ForecastCurveName | null;
  /** The main curve already counts the carbs still absorbing: oref's COB curve, or Loop's (it always does). */
  main_includes_cob: boolean;
  eventual_mgdl: number | null;
  target_mgdl: number | null;
  carbs_req_g: number | null;
  insulin_req_u: number | null;
  /** Loop's bolus recommendation (Loop only). */
  recommended_bolus_u: number | null;
}

export function buildGlucoseForecast(input: {
  now: Date;
  readings: GlucosePoint[];
  prediction: LoopPrediction | null;
  /** Keep readings with the same timestamp (the meal card's behaviour since meal-dose-forecast.v2); otherwise the first one wins. */
  keep_duplicate_readings?: boolean;
}): GlucoseForecast {
  const policy = GLUCOSE_FORECAST_POLICY;
  const nowMs = input.now.getTime();
  const readings = cleanReadings(input.readings, input.now, { keep_duplicates: input.keep_duplicate_readings });
  const glucose = readings.at(-1) ?? null;
  const latestMs = glucose ? Date.parse(glucose.at) : NaN;
  const readingAge = glucose ? (nowMs - latestMs) / 60_000 : null;
  const slope = shortAverageSlope(readings);

  const prediction = input.prediction;
  const computedMs = prediction ? Date.parse(prediction.computed_at) : NaN;
  const loopState: LoopForecastState = !prediction
    ? 'NONE'
    : !Number.isFinite(computedMs) || nowMs - computedMs > policy.max_loop_age_minutes * 60_000
      ? 'STALE'
      : !glucose || Math.abs(computedMs - latestMs) > policy.max_loop_reading_skew_minutes * 60_000
        ? 'NOT_FOR_READING'
        : 'FRESH';
  const loop = loopState === 'FRESH' ? prediction : null;
  const mainCurve = loop ? mainCurveName(loop) : null;
  const mainValues = mainCurve ? loop!.curves[mainCurve]! : [];

  return {
    policy_version: policy.version,
    now: input.now.toISOString(),
    readings,
    glucose,
    reading_age_minutes: readingAge === null ? null : Math.round(readingAge * 10) / 10,
    reading_fresh: readingAge !== null && readingAge <= policy.max_reading_age_minutes,
    delta_per_5min: deltaPerFiveMinutes(readings),
    slope_per_min: slope,
    falling: lastTwoFalling(readings),
    loop,
    loop_state: loopState,
    loop_age_minutes: prediction && Number.isFinite(computedMs) ? Math.round(((nowMs - computedMs) / 60_000) * 10) / 10 : null,
    source: loop ? loop.source : glucose && slope !== null ? 'CGM_TREND' : 'NONE',
    main_curve: mainCurve,
    main_includes_cob: mainCurve === 'COB' || (mainCurve !== null && loop?.source === 'LOOP'),
    eventual_mgdl: loop ? loop.eventual_bg ?? mainValues.at(-1) ?? null : null,
    target_mgdl: loop?.target_mgdl ?? null,
    carbs_req_g: loop?.carbs_req_g ?? null,
    insulin_req_u: loop?.insulin_req_u ?? null,
    recommended_bolus_u: loop?.recommended_bolus_u ?? null,
  };
}

/** oref's main curve: with the carbs still absorbing while there are any, else insulin and the current trend. */
export function mainCurveName(loop: LoopPrediction): ForecastCurveName | null {
  return (loop.cob_g ?? 0) > 0 && loop.curves.COB ? 'COB' : loop.curves.IOB ? 'IOB' : null;
}

/** A loop curve as timed points from its calculation time; within the horizon when given (index 0 included). */
export function loopCurve(forecast: GlucoseForecast, name: ForecastCurveName, horizonMinutes?: number): GlucosePoint[] {
  const loop = forecast.loop;
  const values = loop?.curves[name] ?? [];
  const step = GLUCOSE_FORECAST_POLICY.step_minutes;
  const startMs = loop ? Date.parse(loop.computed_at) : 0;
  return (horizonMinutes === undefined ? values : values.slice(0, Math.floor(horizonMinutes / step) + 1))
    .map((value, index) => ({ at: new Date(startMs + index * step * 60_000).toISOString(), value }));
}

/** The main loop curve (COB or IOB), [] without a fresh loop forecast. */
export function mainLoopCurve(forecast: GlucoseForecast, horizonMinutes?: number): GlucosePoint[] {
  return forecast.main_curve ? loopCurve(forecast, forecast.main_curve, horizonMinutes) : [];
}

/** The newest reading carried forward by the CGM slope in 5-min steps; [] without a slope. */
export function cgmTrendCurve(forecast: GlucoseForecast, horizonMinutes: number): GlucosePoint[] {
  const { glucose, slope_per_min: slope } = forecast;
  if (!glucose || slope === null) return [];
  const step = GLUCOSE_FORECAST_POLICY.step_minutes;
  const latestMs = Date.parse(glucose.at);
  return Array.from({ length: Math.floor(horizonMinutes / step) + 1 }, (_, index) => ({
    at: new Date(latestMs + index * step * 60_000).toISOString(),
    // slope × index × step in this order, so the points round exactly as rescue-carbs.v1's always have.
    value: Math.max(CGM_FLOOR_MGDL, Math.round(glucose.value + slope * index * step)),
  }));
}

/** Glucose + slope × minutes (CGM floor 39), null without a reading or slope. */
export function cgmProjection(forecast: GlucoseForecast, minutes: number): number | null {
  return forecast.glucose && forecast.slope_per_min !== null ? projectLinear(forecast.glucose.value, forecast.slope_per_min, minutes) : null;
}

/** The main loop curve when it has a future point, else the CGM trend (rescue-carbs.v1's choice). */
export function bestCurve(forecast: GlucoseForecast, horizonMinutes: number): { name: ForecastCurveName | 'CGM'; points: GlucosePoint[] } {
  const main = mainLoopCurve(forecast, horizonMinutes);
  return main.length > 1 ? { name: forecast.main_curve!, points: main } : { name: 'CGM', points: cgmTrendCurve(forecast, horizonMinutes) };
}

/** Points up to `horizonMinutes` after the first one. */
function within(points: GlucosePoint[], horizonMinutes?: number): GlucosePoint[] {
  if (horizonMinutes === undefined || points.length === 0) return points;
  const endMs = Date.parse(points[0].at) + horizonMinutes * 60_000;
  return points.filter((point) => Date.parse(point.at) <= endMs);
}

export function lowestWithin(points: GlucosePoint[], horizonMinutes?: number): GlucosePoint | null {
  return within(points, horizonMinutes).reduce<GlucosePoint | null>((low, point) => (!low || point.value < low.value ? point : low), null);
}

/** The first future point (index 0 skipped) below / above the threshold. */
export function firstCrossing(points: GlucosePoint[], threshold: number, direction: 'BELOW' | 'ABOVE'): GlucosePoint | null {
  return points.slice(1).find((point) => (direction === 'BELOW' ? point.value < threshold : point.value > threshold)) ?? null;
}

/** Whole minutes from now to the point, never negative. */
export function minutesUntil(point: GlucosePoint | null, now: Date | string): number | null {
  if (!point) return null;
  const nowMs = typeof now === 'string' ? Date.parse(now) : now.getTime();
  return Math.max(0, Math.round((Date.parse(point.at) - nowMs) / 60_000));
}
