import { CGM_FLOOR_MGDL, type GlucosePoint } from './cgm-trend';
import { activeForecastProfile, type BolusChartCalibration } from './forecast-calibration';
import { buildGlucoseForecast, GLUCOSE_THRESHOLDS, mainLoopCurve } from './glucose-forecast';
import { isfToMgdl } from './isf-units';
import type { LoopPrediction } from '@modules/loop-system/application/loop-prediction';

/**
 * The Bolus tab's chart (bolus-forecast.v7, versions below): the glucose 3 hours ahead without the typed dose and with it, as Loop and
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
 * v7 (the owner's decision): with FORECAST_CALIBRATION unset or `none` (the default) the chart draws ONLY the loop's
 * own forecast (`dose_line: 'LOOP_ONLY'`, `with_dose` null): uncalibrated, the dose line drew a correctly dosed meal
 * rising ~50 mg/dL at ~105 min and still +38 at 3 h (fast textbook carbs against slow insulin), which misled more than
 * it helped. The loop's forecast does not include a dose not yet given, so the app labels the line "bez tej dawki". A
 * dose is then checked by its full effect, the loop bolus calculators' arithmetic: the loop's value at the horizon +
 * carbs × ISF / ICR − insulin × ISF (`total_with_dose`), never drawn as a curve. With `fitted-v1` the dose line is
 * drawn as before (`dose_line: 'MODEL'`).
 *
 * Dose line (excess-insulin.v1, the owner's decision 2026-10-30): next to the loop's own line a dashed "z tą dawką" =
 * that line minus the effect of the insulin ABOVE the carbs on the form only (excess = dose − carbs / ICR, the
 * calculator's ICR and rounding; 0 g: the whole dose; below the ICR dose the line rises), spread over time by the
 * insulin curve above (excessInsulinLine). No carb model: the loop's line already holds what it knows, and a dose
 * matching the carbs adds nothing it does not. The Bolus tab's "Po tej dawce ok. X" is this line's lowest point
 * (`with_excess_min`), so the warning and the chart never disagree. Only on the LOOP_ONLY chart, and only when the dose
 * differs from the ICR dose by at least one pump step.
 *
 * The line assumes the loop changes nothing more after the dose (as Loop's does): Trio will cut or add insulin, so what
 * happens is usually flatter. Nothing here blocks or warns: a chat card's FORECAST_LOW warning is card-advice.ts reading
 * this line (riskWarning), and it is acknowledged in the card's confirmation like every other warning.
 */

export const BOLUS_FORECAST_POLICY = {
  version: 'bolus-forecast.v7',
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
  /** The dashed "z tą dawką" line's model (the field older apps ignore). */
  excess_policy: 'excess-insulin.v1',
  /** The pump step when the caller gives none: the dashed line needs a difference of at least one. */
  default_bolus_step: 0.05,
} as const;

export type BolusForecastBaseline = 'LOOP' | 'CGM_TREND' | 'FLAT';

/** MODEL: with_dose is Mellis' own line with the dose (fitted-v1); LOOP_ONLY: only the line without it (default, v7). */
export type BolusForecastDoseLine = 'MODEL' | 'LOOP_ONLY';

export interface BolusForecastChart {
  policy_version: string;
  /** The newest reading: every series starts there, one value per step. */
  start: string;
  step_minutes: number;
  baseline_source: BolusForecastBaseline;
  /** Whether with_dose may be drawn at all (v7): LOOP_ONLY never has one. */
  dose_line: BolusForecastDoseLine;
  /** Without the typed dose, mg/dL. */
  baseline: number[];
  /** With the typed carbs and insulin; null when nothing is typed, the ISF is unknown or dose_line is LOOP_ONLY. */
  with_dose: number[] | null;
  /**
   * The line without the dose at its last point plus the dose's (and later parts') full effect: carbs × ISF / ICR −
   * insulin × ISF, mg/dL. The bolus calculators' end value, not a curve; null when nothing is typed or ISF/ICR unknown.
   */
  total_with_dose: number | null;
  /** Half-width of the uncertainty band around with_dose (or baseline), mg/dL. */
  band: number[];
  /**
   * First point of with_dose below 70 mg/dL, and whether the line without the dose stays above it. LOOP_ONLY: the first
   * point of the line without the dose below 70 (the loop's own forecast going low), low_from_dose false.
   */
  low_at: string | null;
  low_from_dose: boolean;
  carbs_g: number;
  insulin_u: number;
  /** When the carbs are eaten, minutes after the bolus (v3). */
  meal_in_minutes: number;
  /** The dashed line's model ('excess-insulin.v1'); its presence tells an app the fields below are computed. */
  excess_policy: typeof BOLUS_FORECAST_POLICY.excess_policy;
  /** Dose − carbs / ICR (the calculator's rounding), U; null when not known (ICR unknown with carbs, nothing typed). */
  excess_insulin_u: number | null;
  /** The pump step the difference was held against. */
  excess_step_u: number;
  /**
   * The loop's line minus the excess insulin's effect (excessInsulinLine), one value per step as `baseline`; null when
   * not drawn: no dose, no ISF, |excess| below one step, a MODEL chart, or a caller that gives no ICR dose (cards).
   */
  with_excess: number[] | null;
  /** The lowest point of with_excess: the value of "Po tej dawce ok. X" (when below 70 and the excess positive). */
  with_excess_min: number | null;
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
  /** Offline only (specs, backtests): another profile's chart parts than FORECAST_CALIBRATION's. */
  calibration?: BolusChartCalibration;
  /**
   * The calculator's carbs / ICR dose for these carbs (insulinForCarbs: the ICR of meal time, rounded down to the step);
   * null with carbs and no ICR. Given only by the Bolus tab's preview: without it there is no dashed line.
   */
  icr_insulin_u?: number | null;
  /** The pump's bolus step (0.05 or 0.1 U). */
  bolus_step?: number | null;
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
  let totalWithDose: number | null = null;
  if (canDose) {
    const totalCarbs = carbs + later.reduce((sum, dose) => sum + Math.max(0, dose.carbs_g), 0);
    const totalInsulin = insulin + later.reduce((sum, dose) => sum + Math.max(0, dose.insulin_u), 0);
    const carbsEffect = totalCarbs > 0 ? fit.carb_effect_scale * totalCarbs * (isf / icr!) : 0;
    totalWithDose = clampGlucose(baseline[baseline.length - 1] + carbsEffect - totalInsulin * isf);
  }
  if (canDose && fit.draw_dose_line) {
    const dia = insulinCurveDiaMinutes(input.dia_hours);
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

  // The dashed "z tą dawką" line (excess-insulin.v1): the loop's line minus the insulin above the carbs.
  const excessStep = input.bolus_step && input.bolus_step > 0 ? input.bolus_step : policy.default_bolus_step;
  const excess = input.icr_insulin_u === undefined ? null : excessInsulinUnits(insulin, carbs, input.icr_insulin_u);
  let withExcess: number[] | null = null;
  if (!fit.draw_dose_line && excess !== null && insulin > 0 && isf !== null && isf > 0 && Math.abs(excess) >= excessStep - 1e-6) {
    withExcess = excessInsulinLine({
      baseline,
      step_minutes: step,
      dose_lag_minutes: (input.now.getTime() - startMs) / 60_000,
      excess_u: excess,
      isf_mgdl: isf,
      dia_hours: input.dia_hours,
    });
  }

  const shown = withDose ?? baseline;
  const lowSeries = fit.draw_dose_line ? withDose : baseline;
  const lowIndex = lowSeries ? lowSeries.findIndex((value, index) => index > 0 && value < policy.low_mgdl) : -1;
  return {
    policy_version: version,
    start: glucose.at,
    step_minutes: step,
    baseline_source: baselineSource,
    dose_line: fit.draw_dose_line ? 'MODEL' : 'LOOP_ONLY',
    baseline,
    with_dose: withDose,
    total_with_dose: totalWithDose,
    band: shown.map((_, index) => Math.round(fit.band_mae_30_mgdl * Math.sqrt(minutesAt(index) / 30))),
    low_at: lowIndex > 0 ? new Date(startMs + minutesAt(lowIndex) * 60_000).toISOString() : null,
    low_from_dose: fit.draw_dose_line && lowIndex > 0 && baseline.every((value) => value >= policy.low_mgdl),
    carbs_g: carbs,
    insulin_u: insulin,
    meal_in_minutes: mealInMinutes(input.meal_in_minutes),
    excess_policy: policy.excess_policy,
    excess_insulin_u: excess,
    excess_step_u: excessStep,
    with_excess: withExcess,
    with_excess_min: withExcess ? Math.min(...withExcess) : null,
  };
}

/**
 * The insulin above the carbs on the form: dose − carbs / ICR, the ICR dose as the calculator rounds it (the caller's
 * `icrInsulinU`, insulinForCarbs). 0 g: the whole dose. Null with carbs and no ICR dose (the ICR is unknown).
 */
export function excessInsulinUnits(insulinU: number, carbsG: number, icrInsulinU: number | null): number | null {
  const insulin = Math.max(0, insulinU);
  if (!(carbsG > 0)) return round2(insulin);
  if (icrInsulinU === null || !Number.isFinite(icrInsulinU)) return null;
  return round2(insulin - Math.max(0, icrInsulinU));
}

/** The DIA the curve uses: the profile's, within Trio's 5 h and 10 h (6 h without one). */
export function insulinCurveDiaMinutes(diaHours: number | null | undefined): number {
  const policy = BOLUS_FORECAST_POLICY;
  const hours = typeof diaHours === 'number' && Number.isFinite(diaHours) && diaHours > 0 ? diaHours : policy.default_dia_hours;
  return Math.min(policy.max_dia_hours, Math.max(policy.min_dia_hours, hours)) * 60;
}

/**
 * The glucose lowered by the excess insulin `minutes` after it is given, mg/dL (negative: raised, for a dose below the
 * ICR dose): excess × ISF × the fraction of it that has acted (oref's exponential curve, the patient's DIA, peak 75 min:
 * no insulin type is known, so rapid-acting's). 0 before the dose, excess × ISF after DIA.
 */
export function excessInsulinEffect(minutes: number, input: { excess_u: number; isf_mgdl: number; dia_hours: number | null | undefined; peak_minutes?: number }): number {
  const dia = insulinCurveDiaMinutes(input.dia_hours);
  const peak = input.peak_minutes ?? BOLUS_FORECAST_POLICY.insulin_peak_minutes;
  return input.excess_u * input.isf_mgdl * (1 - insulinOnBoard(minutes, dia, peak));
}

/**
 * The dashed "z tą dawką" line: each point of the loop's line (the one the chart draws, from the newest reading) minus
 * the excess insulin's effect at that time, rounded and held at the CGM floor as every line here. The dose goes in now,
 * `dose_lag_minutes` after the newest reading. One function for the chart and the warning (`with_excess_min`).
 */
export function excessInsulinLine(input: { baseline: number[]; step_minutes: number; dose_lag_minutes: number; excess_u: number; isf_mgdl: number; dia_hours: number | null | undefined; peak_minutes?: number }): number[] {
  return input.baseline.map((value, index) => clampGlucose(value - excessInsulinEffect(index * input.step_minutes - input.dose_lag_minutes, input)));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
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

