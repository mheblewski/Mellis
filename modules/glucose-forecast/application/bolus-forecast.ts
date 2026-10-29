import { CGM_FLOOR_MGDL, type GlucosePoint } from './cgm-trend';
import { activeForecastProfile, type BolusChartCalibration } from './forecast-calibration';
import { buildGlucoseForecast, GLUCOSE_THRESHOLDS, mainLoopCurve } from './glucose-forecast';
import { isfToMgdl } from './isf-units';
import type { LoopPrediction } from '@modules/loop-system/application/loop-prediction';

/**
 * The Bolus tab's chart (bolus-forecast.v6, versions below): the glucose 3 hours ahead without the typed dose and with it, as Loop and
 * Trio show on their bolus screens. Without the dose: the loop's main curve as Trio draws it (COB while carbs absorb,
 * else IOB: both hold the current IOB, COB holds the current COB too), moved to start at the newest reading; without a
 * fresh loop forecast, the CGM trend for 30 min, then flat. With the dose: that line plus the insulin (oref's
 * exponential curve × ISF) and the carbs (Hovorka's two-compartment gut model × ISF / ICR).
 *
 * The new carbs reach the blood front-loaded (Hovorka 2004, t_max 40 min; ~50% absorbed by 67 min, as tracer studies
 * show) from when they are eaten: 10 min after the bolus (the usual pre-bolus), or 15 min from now with "Posiłek za
 * 15 min" (v3; the chart only, the command is unchanged).
 *
 * v6: the patient-fitted parts (the carbs' effect × 0.7, a fatty meal's carbs 15 min later, the baseline as the mean of
 * the main and UAM curves, the narrower band) moved to the FORECAST_CALIBRATION switch (forecast-calibration.ts) and
 * are off by default: the chart is the loop's own forecast plus the textbook dose effect. With `fitted-v1` they are back
 * as v5 drew them (fitted on one patient's meals and loop calculations; see FORECAST_PROFILES).
 *
 * The line assumes the loop changes nothing more after the dose (as Loop's does): Trio will cut or add insulin, so what
 * happens is usually flatter. Nothing here blocks or warns: a chat card's FORECAST_LOW warning is card-advice.ts reading
 * this line (riskWarning), and it is acknowledged in the card's confirmation like every other warning.
 */

export const BOLUS_FORECAST_POLICY = {
  version: 'bolus-forecast.v6',
  horizon_minutes: 180,
  step_minutes: 5,
  /** Hovorka's gut model: absorption peaks at t_max after the carbs are eaten (one time for every meal). */
  carb_tmax_minutes: 40,
  /** The meal starts this long after the bolus unless the form says when (the usual pre-bolus). */
  default_meal_in_minutes: 10,
  /** The latest a meal may be put off on the chart ("Posiłek za 15 min"). */
  max_meal_in_minutes: 60,
  /** oref's exponential curve for rapid-acting insulin; DIA from the therapy profile, at least Trio's 5 h. */
  insulin_peak_minutes: 75,
  default_dia_hours: 6,
  min_dia_hours: 5,
  max_dia_hours: 10,
  /** Without a fresh loop forecast the CGM slope is carried this far, then the line stays flat. */
  cgm_trend_minutes: 30,
  low_mgdl: GLUCOSE_THRESHOLDS.low_mgdl,
} as const;

export type BolusForecastBaseline = 'LOOP' | 'CGM_TREND' | 'FLAT';

export interface BolusForecastChart {
  policy_version: string;
  /** The newest reading: every series starts there, one value per step. */
  start: string;
  step_minutes: number;
  baseline_source: BolusForecastBaseline;
  /** Without the typed dose, mg/dL. */
  baseline: number[];
  /** With the typed carbs and insulin; null when nothing is typed or the ISF is unknown. */
  with_dose: number[] | null;
  /** Half-width of the uncertainty band around with_dose (or baseline), mg/dL. */
  band: number[];
  /** First point of with_dose below 70 mg/dL, and whether the line without the dose stays above it. */
  low_at: string | null;
  low_from_dose: boolean;
  carbs_g: number;
  insulin_u: number;
  /** When the carbs are eaten, minutes after the bolus (v3). */
  meal_in_minutes: number;
}

export interface BolusForecastInputs {
  /** CGM readings (the last ~40 min are enough), any order. */
  readings: GlucosePoint[];
  prediction: LoopPrediction | null;
  /** The therapy profile's ISF at now and its units; used when the loop's own is missing. */
  profile_isf: number | null;
  profile_units: string | null;
  dia_hours: number | null;
}

export function computeBolusForecast(input: BolusForecastInputs & {
  now: Date;
  carbs_g: number;
  insulin_u: number;
  /** g/U at now (the form's ICR); the loop's own wins when it has one. */
  icr_g_per_u: number | null;
  /** When the carbs are eaten, minutes after the bolus; the usual pre-bolus when not given. */
  meal_in_minutes?: number | null;
  /** Much fat or protein for the carbs (split-advice.v1 thresholds): the carbs start absorbing later (v4). */
  fatty_meal?: boolean;
  /**
   * A card's later parts (card-forecast.v1): more carbs and insulin `at_minutes` after the dose, the carbs eaten then
   * (a fatty meal's later than that, as the first part's).
   */
  later_doses?: Array<{ at_minutes: number; carbs_g: number; insulin_u: number }>;
  /** Longer than the Bolus tab's 3 h for a card with later parts (at most 6 h). */
  horizon_minutes?: number;
  /** Offline only (specs): another profile's chart parts than FORECAST_CALIBRATION's. */
  calibration?: BolusChartCalibration;
}): BolusForecastChart | null {
  const policy = BOLUS_FORECAST_POLICY;
  const profile = activeForecastProfile();
  const fit = input.calibration ?? profile.bolus_chart;
  const version = input.calibration ? policy.version : profile.id === 'none' ? policy.version : `${policy.version}+${profile.id}`;
  const forecast = buildGlucoseForecast({ now: input.now, readings: input.readings, prediction: input.prediction });
  const glucose = forecast.glucose;
  if (!glucose || !forecast.reading_fresh) return null;

  const step = policy.step_minutes;
  const horizon = Math.min(360, Math.max(policy.horizon_minutes, Math.round(input.horizon_minutes ?? policy.horizon_minutes)));
  const count = Math.floor(horizon / step) + 1;
  const startMs = Date.parse(glucose.at);
  const minutesAt = (index: number) => index * step;

  let baselineSource: BolusForecastBaseline;
  let baselineChange: (minutes: number) => number;
  const loopCurve = baselineLoopCurve(forecast, fit.baseline_uam_mean);
  if (loopCurve.length > 1) {
    // The loop computed a few minutes before or after the newest reading: its change from that reading's time on.
    const lag = (startMs - Date.parse(loopCurve[0].at)) / 60_000;
    const from = valueAt(loopCurve, lag);
    baselineSource = 'LOOP';
    baselineChange = (minutes) => valueAt(loopCurve, lag + minutes) - from;
  } else if (forecast.slope_per_min !== null) {
    const slope = forecast.slope_per_min;
    baselineSource = 'CGM_TREND';
    baselineChange = (minutes) => slope * Math.min(minutes, policy.cgm_trend_minutes);
  } else {
    baselineSource = 'FLAT';
    baselineChange = () => 0;
  }
  const baseline = Array.from({ length: count }, (_, index) => clampGlucose(glucose.value + baselineChange(minutesAt(index))));

  const carbs = Math.max(0, input.carbs_g);
  const insulin = Math.max(0, input.insulin_u);
  const isf = isfToMgdl(input.prediction?.isf_mgdl_per_u, input.profile_units) ?? isfToMgdl(input.profile_isf, input.profile_units);
  const icr = input.prediction?.icr_g_per_u ?? input.icr_g_per_u;
  const later = (input.later_doses ?? []).filter((dose) => dose.carbs_g > 0 || dose.insulin_u > 0);
  const anyCarbs = carbs > 0 || later.some((dose) => dose.carbs_g > 0);
  const canDose = (carbs > 0 || insulin > 0 || later.length > 0) && isf !== null && isf > 0 && (!anyCarbs || (icr !== null && icr > 0));
  let withDose: number[] | null = null;
  if (canDose) {
    const dia = Math.min(policy.max_dia_hours, Math.max(policy.min_dia_hours, input.dia_hours ?? policy.default_dia_hours)) * 60;
    // The dose goes in now; the newest reading may be a few minutes older.
    const doseLag = (input.now.getTime() - startMs) / 60_000;
    const mealIn = mealInMinutes(input.meal_in_minutes) + (input.fatty_meal ? fit.fatty_meal_delay_minutes : 0);
    withDose = Array.from({ length: count }, (_, index) => {
      const sinceDose = minutesAt(index) - doseLag;
      let fromInsulin = insulin * isf * (1 - insulinOnBoard(sinceDose, dia, policy.insulin_peak_minutes));
      let fromCarbs = carbs > 0 ? fit.carb_effect_scale * carbs * (isf / icr!) * carbsAbsorbed(sinceDose - mealIn) : 0;
      for (const dose of later) {
        const sinceLater = sinceDose - dose.at_minutes;
        fromInsulin += Math.max(0, dose.insulin_u) * isf * (1 - insulinOnBoard(sinceLater, dia, policy.insulin_peak_minutes));
        if (dose.carbs_g > 0) {
          fromCarbs += fit.carb_effect_scale * dose.carbs_g * (isf / icr!) * carbsAbsorbed(sinceLater - (input.fatty_meal ? fit.fatty_meal_delay_minutes : 0));
        }
      }
      return clampGlucose(glucose.value + baselineChange(minutesAt(index)) + fromCarbs - fromInsulin);
    });
  }

  const shown = withDose ?? baseline;
  const lowIndex = withDose ? withDose.findIndex((value, index) => index > 0 && value < policy.low_mgdl) : -1;
  return {
    policy_version: version,
    start: glucose.at,
    step_minutes: step,
    baseline_source: baselineSource,
    baseline,
    with_dose: withDose,
    band: shown.map((_, index) => Math.round(fit.band_mae_30_mgdl * Math.sqrt(minutesAt(index) / 30))),
    low_at: lowIndex > 0 ? new Date(startMs + minutesAt(lowIndex) * 60_000).toISOString() : null,
    low_from_dose: lowIndex > 0 && baseline.every((value) => value >= policy.low_mgdl),
    carbs_g: carbs,
    insulin_u: insulin,
    meal_in_minutes: mealInMinutes(input.meal_in_minutes),
  };
}

function mealInMinutes(value: number | null | undefined): number {
  const { default_meal_in_minutes: usual, max_meal_in_minutes: max } = BOLUS_FORECAST_POLICY;
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : usual;
}

/**
 * The loop's main curve; with `uamMean` (fitted-v1 only, v5) the mean of it and the unannounced-meal curve (UAM) where
 * Trio has one — backtested on one patient's loop calculations without a dose in the next 2 h
 * (scripts/evaluation/card-baseline-trend-backtest.ts): a little smaller error at 90/120 min and a few more lows caught.
 */
function baselineLoopCurve(forecast: ReturnType<typeof buildGlucoseForecast>, uamMean: boolean): GlucosePoint[] {
  const main = mainLoopCurve(forecast);
  const uam = forecast.loop?.curves.UAM;
  if (!uamMean || main.length < 2 || !uam || uam.length < 2 || forecast.main_curve === 'UAM') return main;
  return main.map((point, index) => ({ at: point.at, value: (point.value + (uam[index] ?? uam[uam.length - 1])) / 2 }));
}

/** oref's exponential insulin curve: the fraction of a dose still to act `minutes` after it (1 before, 0 after DIA). */
export function insulinOnBoard(minutes: number, diaMinutes: number, peakMinutes: number): number {
  if (minutes <= 0) return 1;
  if (minutes >= diaMinutes) return 0;
  const tau = (peakMinutes * (1 - peakMinutes / diaMinutes)) / (1 - (2 * peakMinutes) / diaMinutes);
  const a = (2 * tau) / diaMinutes;
  const s = 1 / (1 - a + (1 + a) * Math.exp(-diaMinutes / tau));
  return 1 - s * (1 - a) * (((minutes ** 2 / (tau * diaMinutes * (1 - a))) - minutes / tau - 1) * Math.exp(-minutes / tau) + 1);
}

/** The fraction of the carbs absorbed `minutes` after they are eaten: Hovorka's 1 − (1 + t/t_max)·e^(−t/t_max). */
export function carbsAbsorbed(minutes: number): number {
  const tmax = BOLUS_FORECAST_POLICY.carb_tmax_minutes;
  return minutes <= 0 ? 0 : 1 - (1 + minutes / tmax) * Math.exp(-minutes / tmax);
}

/** Linear between 5-min points; the last value holds after the end, the first before the start. */
function valueAt(points: GlucosePoint[], minutes: number): number {
  const position = minutes / BOLUS_FORECAST_POLICY.step_minutes;
  if (position <= 0) return points[0].value;
  const lower = Math.floor(position);
  if (lower >= points.length - 1) return points[points.length - 1].value;
  const fraction = position - lower;
  return points[lower].value + fraction * (points[lower + 1].value - points[lower].value);
}

function clampGlucose(value: number): number {
  return Math.max(CGM_FLOOR_MGDL, Math.round(value));
}

