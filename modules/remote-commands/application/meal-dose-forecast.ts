import { LOOP_ACTION_TIME_ZONE } from '@modules/loop-actions/application/loop-action-views';
import { scheduleValueAt } from '@modules/meal-wbt/application/wbt-policy';
import { projectLinear } from '@modules/glucose-forecast/application/cgm-trend';
import { activeForecastCalibration, calibratedLoopCurve, calibrationApplies, type ForecastCalibration } from '@modules/glucose-forecast/application/forecast-calibration';
import { buildGlucoseForecast, lowestWithin, mainLoopCurve, type GlucoseForecast } from '@modules/glucose-forecast/application/glucose-forecast';
import { isfToMgdl } from '@modules/glucose-forecast/application/isf-units';
import { parseLoopPrediction, type LoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { capitalized, loopSystemNames } from '@modules/loop-system/domain/loop-system';
import { evaluateRescueNeedV2 } from '@modules/rescue-carbs/application/rescue-detection';
import { computeRescueDose } from '@modules/rescue-carbs/application/rescue-dose';
import { formatUnits, roundDownToStep } from './remote-command-policy';
import { FALLING_FAST_MGDL_PER_MIN } from '@shared/primitives/glucose-rules';

/**
 * A meal bolus lowered for a falling glucose (meal-dose-forecast.v3): when the loop forecasts
 * glucose below target, part of the meal's carbs covers the drop and gets no insulin; the rest gets carbs / ICR. The
 * insulin is reduced, not always dropped: only a drop the whole meal covers leaves the carbs alone (0 U). The carbs still
 * go to Trio, which adds insulin itself (SMB) if the forecast rises above target. No AI.
 *
 *   covered = max((target − forecast +90 min) / CSF,    the loop's forecast in 1.5 h against Trio's current target
 *                 (safety − early low) / CSF,           Trio's raw lowest point within 60 min against a safety limit (Loop's way)
 *                 Trio's carbsReq)
 *   dose    = (carbs − covered) / ICR, rounded down to the pump step, never below 0;  CSF = ISF / ICR
 *
 * v3 (an offline backtest on one patient's data): where v2 lowered the dose for Trio's eventualBG, that eventualBG ran
 * far below the CGM 1.5–3 h later, so the forecast at +90 min stands for it. That forecast is the loop's own main curve
 * unless FORECAST_CALIBRATION=fitted-v1 shrinks it (forecast-calibration.ts; fitted on that one patient). The early term
 * always stays on the raw curve: its 60-min minimum was close to the real one and caught most dips below 80.
 *
 * Without a fresh forecast from Trio: CGM + 30 min × slope while falling, against the target (trend-arrow tables).
 * This is the below-target correction of Trio's, Loop's, AAPS's, CamAPS's and Omnipod 5's calculators, counted once
 * from the loop's own forecast (sources: the bolus-reduction literature review in knowledge/).
 *
 * A low now or within ~30 min (rescue-carbs.v1 detection) is pointed out separately: a meal raises glucose too slowly,
 * fast carbs come first (computeFastCarbsFirst). The meal's dose does not count on them: if they are not given, the
 * dose is still safe; if they are, the loop corrects the later rise.
 */

const MEAL_DOSE_FORECAST_POLICY = {
  version: 'meal-dose-forecast.v3',
  /** Trio's current target, else the profile's target_low, within these bounds (temp targets for exercise count). */
  default_target_mgdl: 100,
  min_target_mgdl: 80,
  max_target_mgdl: 180,
  /** The early part of Trio's curve is held against this limit, not the full target (Loop's Glucose Safety Limit). */
  safety_mgdl: 80,
  /** How far the early part of Trio's curve is read. */
  horizon_minutes: 60,
  /** The forecast this far ahead (calibrated only with FORECAST_CALIBRATION) stands for the eventual glucose (v2: Trio's eventualBG). */
  eventual_horizon_minutes: 90,
  /** Without Trio's forecast: glucose + slope × this, only while the last readings fall. */
  cgm_projection_minutes: 30,
  /** Reading and loop freshness (10 min, the loop's calculation within 7 min of the newest reading): glucose-forecast.v1. */
  /** Fewer grams covering the drop change nothing. */
  min_covered_g: 2,
  /** Falling this fast (mg/dL per min, ↓) at or below this glucose: the bolus at the end of the meal. */
  fast_fall_per_min: FALLING_FAST_MGDL_PER_MIN,
  fast_fall_max_glucose_mgdl: 150,
  /** A forecast is never taken lower than this (CGM floor). */
  floor_mgdl: 39,
  /** A target below this is taken as mmol/L (an ISF is read by isfToMgdl). */
  mmol_below: 25,
} as const;

export interface MealForecastData {
  /** CGM readings, oldest first (the last ~40 min are enough). */
  readings: Array<{ at: string; value: number }>;
  prediction: LoopPrediction | null;
  /** The therapy profile's ISF and target (target_low) at now, in the profile's units. */
  profile_isf: number | null;
  profile_target: number | null;
  /** The profile's target_high at now: the dose calculator aims at the middle of the range (dose-calculator.v1, L5). */
  profile_target_high?: number | null;
  profile_units: string | null;
  /** The profile's insulin action time (the card's risk forecast); null: the forecast's default. */
  dia_hours?: number | null;
  /** Newest carbs eaten in the last 15 min (loop or GlucoMind): fast carbs may already be working. */
  last_carbs_at?: string | null;
  /** Offline only (specs, replays): another calibration than FORECAST_CALIBRATION's. */
  calibration?: ForecastCalibration;
}

/** TRIO_EVENTUAL: v2's records only (Trio's eventualBG); v3 uses CALIBRATED_EVENTUAL. */
export type MealDoseForecastBasis = 'CALIBRATED_EVENTUAL' | 'TRIO_EVENTUAL' | 'TRIO_EARLY_LOW' | 'TRIO_CARBS_REQ' | 'CGM_TREND';

export interface MealDoseAdjustment {
  policy_version: string;
  basis: MealDoseForecastBasis;
  glucose_mgdl: number;
  /** The forecast the dose was lowered for: the calibrated +90 min forecast, the early low, or the CGM projection. */
  forecast_low_mgdl: number;
  /** What it was held against: the target (eventual, CGM) or the safety limit (early low). */
  target_mgdl: number;
  isf_mgdl_per_u: number;
  icr_g_per_u: number;
  trio_carbs_req_g: number | null;
  /** Grams of the meal that cover the drop (may be more than the meal). */
  covered_carbs_g: number;
  /** The dose before (carbs / ICR) and after the reduction. */
  dose_before_u: number;
  dose_u: number;
  reduced_by_u: number;
  /** Glucose falls fast (↓↓) near target: the bolus at the end of the meal, not at its start. */
  give_at_meal_end: boolean;
  /** Polish sentences for the card: why, and when to give it. */
  summary: string;
  /** The calibration behind CALIBRATED_EVENTUAL (v3). */
  calibration_version?: string | null;
}

/** The newest reading (≤ 10 min) and Trio's forecast if it belongs to it; null without a recent reading. */
function forecastView(now: Date, data: MealForecastData): GlucoseForecast | null {
  // v2 has always kept readings with the same timestamp; kept so the card's dose does not change.
  const forecast = buildGlucoseForecast({ now, readings: data.readings, prediction: data.prediction, keep_duplicate_readings: true });
  return forecast.reading_fresh ? forecast : null;
}

export function computeMealDoseAdjustment(input: {
  now: Date;
  carbs_g: number;
  /** The carbs' dose this would replace (carbs / ICR, rounded to the step). */
  dose_u: number;
  icr_g_per_u: number | null;
  step: number;
  data: MealForecastData | null;
}): MealDoseAdjustment | null {
  const policy = MEAL_DOSE_FORECAST_POLICY;
  const { data, now } = input;
  const icr = input.icr_g_per_u;
  if (!data || !icr || !(icr > 0) || !(input.carbs_g > 0) || !(input.dose_u > 0)) return null;
  const view = forecastView(now, data);
  if (!view) return null;
  const { loop, slope_per_min: slope } = view;
  const latest = view.glucose!;

  const isf = isfToMgdl(loop?.isf_mgdl_per_u, data.profile_units) ?? isfToMgdl(data.profile_isf, data.profile_units);
  if (!isf || !(isf > 0)) return null;
  const target = [mgdl(loop?.target_mgdl ?? null, null), mgdl(data.profile_target, data.profile_units)]
    .find((value) => value !== null && value >= policy.min_target_mgdl && value <= policy.max_target_mgdl);
  const targetMgdl = target !== undefined && target !== null ? Math.round(target) : policy.default_target_mgdl;
  const csf = isf / icr;
  const floor = (value: number) => Math.max(policy.floor_mgdl, Math.round(value));

  type Candidate = { basis: MealDoseForecastBasis; grams: number; low: number; against: number };
  const candidates: Candidate[] = [];
  if (loop) {
    // oref's main curve: with the carbs still absorbing while there are any, else insulin and the current trend.
    const early = floor(Math.min(latest.value, lowestWithin(mainLoopCurve(view, policy.horizon_minutes))?.value ?? Infinity));
    // Trio's eventualBG runs far too low; the forecast at +90 min (calibrated only when switched on) stands for it.
    const calibration = data.calibration ?? activeForecastCalibration();
    const calibrated = calibratedLoopCurve(view, policy.eventual_horizon_minutes, calibration);
    if (calibrated.length > 0) {
      const eventual = floor(calibrated.at(-1)!.value);
      candidates.push({ basis: 'CALIBRATED_EVENTUAL', grams: (targetMgdl - eventual) / csf, low: eventual, against: targetMgdl });
    }
    candidates.push({ basis: 'TRIO_EARLY_LOW', grams: (policy.safety_mgdl - early) / csf, low: early, against: policy.safety_mgdl });
    if (loop.carbs_req_g !== null && loop.carbs_req_g > 0) {
      candidates.push({ basis: 'TRIO_CARBS_REQ', grams: loop.carbs_req_g, low: early, against: policy.safety_mgdl });
    }
  } else {
    const projected = view.falling && slope !== null && slope < 0 ? projectLinear(latest.value, slope, policy.cgm_projection_minutes) : floor(latest.value);
    candidates.push({ basis: 'CGM_TREND', grams: (targetMgdl - projected) / csf, low: projected, against: targetMgdl });
  }
  // The largest need wins; on a tie the earlier entry (the +90 min forecast before the early low, before carbsReq).
  const best = candidates.reduce((top, candidate) => (Math.round(candidate.grams) > Math.round(top.grams) ? candidate : top));
  const covered = Math.round(best.grams);
  if (covered < policy.min_covered_g) return null;

  const dose = roundDownToStep(Math.max(0, input.carbs_g - covered) / icr, input.step);
  if (dose >= input.dose_u) return null;
  const reducedBy = Math.round((input.dose_u - dose) * 100) / 100;
  const giveAtEnd = slope !== null && slope <= policy.fast_fall_per_min && latest.value <= policy.fast_fall_max_glucose_mgdl;

  const loopName = loopSystemNames(loop?.system ?? 'UNKNOWN');
  const why = best.basis === 'TRIO_CARBS_REQ'
    ? `${capitalized(loopName.nominative)} liczy, że potrzeba ${covered} g węglowodanów`
    : best.basis === 'CALIBRATED_EVENTUAL'
      ? `Za ok. 1,5 h prognoza ok. ${best.low} mg/dL (cel ${best.against})`
      : best.basis === 'CGM_TREND'
        ? best.low === latest.value
          ? `Glukoza ${latest.value} mg/dL, poniżej celu ${best.against}`
          : `Glukoza spada: za ${policy.cgm_projection_minutes} min ok. ${best.low} mg/dL (trend CGM, cel ${best.against})`
        : best.low === latest.value
          ? `Glukoza ${latest.value} mg/dL`
          : `${capitalized(loopName.nominative)} prognozuje spadek do ${best.low} mg/dL w ciągu godziny`;
  const amount = dose === 0
    ? `${why}, więc ${covered >= input.carbs_g ? 'cały posiłek' : `${covered} g z ${input.carbs_g} g`} pokryje spadek: bez insuliny teraz, bolus po sprawdzeniu glukozy.`
    : `${why}, więc ${covered} g z posiłku pokryje spadek: insulina tylko na pozostałe ${input.carbs_g - covered} g (mniej o ${formatUnits(reducedBy)} j).`;
  const timing = dose === 0
    ? ''
    : giveAtEnd
      ? ' Glukoza szybko spada: podaj bolus na koniec posiłku albo po kontroli za 15–20 min.'
      : ' Podaj na początku posiłku, nie wcześniej.';

  return {
    policy_version: policy.version,
    basis: best.basis,
    glucose_mgdl: latest.value,
    forecast_low_mgdl: best.low,
    target_mgdl: best.against,
    isf_mgdl_per_u: Math.round(isf * 10) / 10,
    icr_g_per_u: icr,
    trio_carbs_req_g: loop?.carbs_req_g ?? null,
    covered_carbs_g: covered,
    dose_before_u: input.dose_u,
    dose_u: dose,
    reduced_by_u: reducedBy,
    give_at_meal_end: giveAtEnd && dose > 0,
    summary: amount + timing,
    calibration_version: best.basis === 'CALIBRATED_EVENTUAL' && calibrationApplies(view, data.calibration ?? activeForecastCalibration()) ? (data.calibration ?? activeForecastCalibration()).version : null,
  };
}

export interface FastCarbsFirst {
  /** The rescue dose (rescue-dose.v2): Trio's carbsReq or the formula, at most one portion; null when it cannot be computed (no ISF/ICR). */
  carbs_g: number | null;
  level: 'PREDICTED_LOW' | 'LOW_NOW' | 'URGENT_LOW';
  glucose_mgdl: number;
  minutes_to_low: number | null;
  /** One Polish sentence for the card. */
  message: string;
}

/**
 * A low now or forecast within ~30 min, by the rescue alert's own detection (rescue-carbs.v2: a predicted low counts
 * only when confirmed, as for the push): the meal raises glucose too slowly, so fast carbs first is the advice. Since
 * card-advice.v1 it is advice the chat offers as an option, never a plan forced on the card.
 */
export function computeFastCarbsFirst(input: { now: Date; icr_g_per_u: number | null; data: MealForecastData | null }): FastCarbsFirst | null {
  const { data, now } = input;
  if (!data) return null;
  const view = forecastView(now, data);
  if (!view) return null;
  const evaluation = evaluateRescueNeedV2({ now, readings: view.readings, prediction: data.prediction, last_carbs_at: data.last_carbs_at ?? null, calibration: data.calibration });
  if (evaluation.status !== 'TRIGGER' || !evaluation.level || !evaluation.glucose) return null;
  if (evaluation.level === 'PREDICTED_LOW' && !evaluation.confirmed) return null;
  const dose = computeRescueDose({
    evaluation,
    loop: evaluation.loop_used ? data.prediction : null,
    profile: { isf: data.profile_isf, icr_g_per_u: input.icr_g_per_u, units: data.profile_units },
  });
  const grams = dose.carbs_g;
  const glucose = evaluation.glucose.value;
  const what = grams !== null ? `${grams} g szybkich węglowodanów (sok, glukoza)` : 'szybkie węglowodany (sok, glukoza)';
  const when = evaluation.level === 'PREDICTED_LOW'
    ? `Glukoza ${glucose} mg/dL spadnie poniżej 70${evaluation.minutes_to_low !== null ? ` za ok. ${evaluation.minutes_to_low} min` : ''}`
    : `Glukoza ${glucose} mg/dL`;
  return {
    carbs_g: grams,
    level: evaluation.level,
    glucose_mgdl: glucose,
    minutes_to_low: evaluation.minutes_to_low,
    message: `${when}: polecam najpierw ${what}, bo posiłek podnosi glukozę za wolno.`,
  };
}

/** Reads a stored adjustment back (null for anything else). */
export function readMealDoseAdjustment(raw: unknown): MealDoseAdjustment | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.summary !== 'string' || !Number.isFinite(value.dose_u) || !Number.isFinite(value.reduced_by_u)) return null;
  return value as unknown as MealDoseAdjustment;
}

function mgdl(value: number | null, units: string | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return /mmol/i.test(units ?? '') || value < MEAL_DOSE_FORECAST_POLICY.mmol_below ? Math.round(value * 18) : value;
}

/** The forecast data from synced readings, the newest loop status and the therapy profile valid now. */
export function mealForecastDataFrom(input: {
  now: Date;
  readings: Array<{ at: string; value: number }>;
  loopStatus: { observed_at: string; raw_payload: Record<string, unknown> } | null;
  therapy: { units: string | null; timezone: string | null; sensitivity_per_u: Array<[string, number]> | null; target_low: Array<[string, number]> | null; target_high?: Array<[string, number]> | null; dia_hours?: number | null };
  lastCarbsAt?: string | null;
}): MealForecastData {
  const nowIso = input.now.toISOString();
  const timezone = input.therapy.timezone ?? LOOP_ACTION_TIME_ZONE;
  const sinceMs = input.now.getTime() - 40 * 60_000;
  return {
    readings: input.readings.filter((reading) => Date.parse(reading.at) >= sinceMs).map((reading) => ({ at: reading.at, value: reading.value })),
    prediction: parseLoopPrediction(input.loopStatus),
    profile_isf: scheduleValueAt(input.therapy.sensitivity_per_u, nowIso, timezone),
    profile_target: scheduleValueAt(input.therapy.target_low, nowIso, timezone),
    profile_target_high: input.therapy.target_high ? scheduleValueAt(input.therapy.target_high, nowIso, timezone) : null,
    profile_units: input.therapy.units,
    dia_hours: typeof input.therapy.dia_hours === 'number' && input.therapy.dia_hours > 0 ? input.therapy.dia_hours : null,
    last_carbs_at: input.lastCarbsAt ?? null,
  };
}
