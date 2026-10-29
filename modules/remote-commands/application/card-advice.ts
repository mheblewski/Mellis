import { computeBolusForecast } from '@modules/glucose-forecast/application/bolus-forecast';
import { buildGlucoseForecast, type GlucoseForecast } from '@modules/glucose-forecast/application/glucose-forecast';
import { isfToMgdl } from '@modules/glucose-forecast/application/isf-units';
import { LOOP_ACTION_TIME_ZONE } from '@modules/loop-actions/application/loop-action-views';
import { scheduleValueAt } from '@modules/meal-wbt/application/wbt-policy';
import type { MealForecastData } from './meal-dose-forecast';
import { formatUnits, roundDownToStep, type RemoteCommandEvaluation } from './remote-command-policy';
import { DEFERRED_BOLUS_POLICY, LATER_PLAN_POLICY } from './split-bolus';
import { FALLING_FAST_MGDL_PER_MIN } from '@shared/primitives/glucose-rules';
import { agree, capitalized, loopSystemNames } from '@modules/loop-system/domain/loop-system';

/**
 * What a bolus card says about the caregiver's own plan (card-advice.v1: GlucoMind advises,
 * the caregiver decides). Nothing here changes the card's numbers or blocks it:
 *
 * - the risk: the bolus forecast (bolus-forecast.v3) with exactly the card's carbs and insulin; its lowest point below
 *   70 mg/dL is a warning, below 54 a strong one. The line assumes the loop does nothing more, so it errs low.
 *   Without a dose line (bolus-forecast.v7, the default): the lower of the loop's own forecast (without the card) and
 *   its value at the end plus the card's full effect (`basis`).
 * - a correction the caregiver asks for: (glucose − target) / ISF − IOB, the textbook formula of the loops' own bolus
 *   calculators, with Trio's target, ISF and IOB of its newest calculation (the profile's when Trio has none).
 * - warnings a correction carries: Trio already adds insulin itself, glucose is falling, night.
 */

const CARD_ADVICE_POLICY = {
  version: 'card-advice.v1',
  risk_low_mgdl: 70,
  risk_very_low_mgdl: 54,
  default_target_mgdl: 100,
  min_target_mgdl: 80,
  max_target_mgdl: 180,
  /** A target below this is taken as mmol/L. */
  mmol_below: 25,
  /** mg/dL per minute (the shared "falling fast", ↓). */
  falling_slope_per_min: FALLING_FAST_MGDL_PER_MIN,
  night_start: '22:00',
  night_end: '06:00',
} as const;

export type CardWarning = RemoteCommandEvaluation['warnings'][number];

export type RiskLevel = 'NONE' | 'LOW' | 'VERY_LOW';

/**
 * What the lowest point is: WITH_DOSE the line with the card (fitted-v1's model); LOOP_WITHOUT_DOSE the loop's own
 * forecast, which does not include the card; DOSE_TOTAL the loop's forecast at its end plus the card's full effect
 * (carbs × ISF / ICR − insulin × ISF), when the loop's forecast alone stays higher.
 */
export type RiskBasis = 'WITH_DOSE' | 'LOOP_WITHOUT_DOSE' | 'DOSE_TOTAL';

export interface PlanRisk {
  policy_version: string;
  /** The lowest point of the forecast with the card's carbs and insulin within 3 h, and when. */
  min_mgdl: number;
  min_in_minutes: number;
  level: RiskLevel;
  /** The same without the card (what happens if nothing is given). */
  baseline_min_mgdl: number;
  basis: RiskBasis;
  /** The loop the line without the card comes from ("Trio", "Loop"); null for the CGM trend. */
  loop_name: string | null;
}

/** The forecast with exactly the card's carbs and insulin; null without a fresh reading. */
export function computePlanRisk(input: {
  now: Date;
  data: MealForecastData | null;
  carbs_g: number;
  insulin_u: number;
  icr_g_per_u: number | null;
  /** When the carbs are eaten, minutes from now (0: already eating). */
  meal_in_minutes?: number | null;
  /** Much fat or protein for the carbs: the carbs absorb later (bolus-forecast.v4). */
  fatty_meal?: boolean;
}): PlanRisk | null {
  if (!input.data) return null;
  const chart = computeBolusForecast({
    now: input.now,
    readings: input.data.readings,
    prediction: input.data.prediction,
    profile_isf: input.data.profile_isf,
    profile_units: input.data.profile_units,
    dia_hours: input.data.dia_hours ?? null,
    carbs_g: input.carbs_g,
    insulin_u: input.insulin_u,
    icr_g_per_u: input.icr_g_per_u,
    meal_in_minutes: input.meal_in_minutes ?? null,
    fatty_meal: input.fatty_meal === true,
  });
  if (!chart) return null;
  return riskOf({ baseline: chart.baseline, with_dose: chart.with_dose, total: chart.total_with_dose, step_minutes: chart.step_minutes, loop_name: loopNameOf(chart.baseline_source, input.data) });
}

/** The loop's name for texts when the line without the card is its forecast. */
function loopNameOf(source: string, data: MealForecastData | null): string | null {
  if (source !== 'LOOP') return null;
  return capitalized(loopSystemNames(data?.prediction?.system ?? 'UNKNOWN').nominative);
}

/** The lowest point of the line with the dose, or (without one) of the loop's line and its end plus the dose's effect. */
function riskOf(input: { baseline: number[]; with_dose: number[] | null; total: number | null; step_minutes: number; loop_name: string | null }): PlanRisk {
  const series = input.with_dose ?? input.baseline;
  let minIndex = 0;
  series.forEach((value, index) => {
    if (value < series[minIndex]) minIndex = index;
  });
  let min = series[minIndex];
  let minutes = minIndex * input.step_minutes;
  let basis: RiskBasis = input.with_dose ? 'WITH_DOSE' : 'LOOP_WITHOUT_DOSE';
  if (!input.with_dose && input.total !== null && input.total < min) {
    min = input.total;
    minutes = (input.baseline.length - 1) * input.step_minutes;
    basis = 'DOSE_TOTAL';
  }
  const policy = CARD_ADVICE_POLICY;
  return {
    policy_version: policy.version,
    min_mgdl: min,
    min_in_minutes: minutes,
    level: min < policy.risk_very_low_mgdl ? 'VERY_LOW' : min < policy.risk_low_mgdl ? 'LOW' : 'NONE',
    baseline_min_mgdl: Math.min(...input.baseline),
    basis,
    loop_name: input.loop_name,
  };
}

/**
 * The chart behind a card's chart button (card-forecast.v1): the glucose with the whole plan (the dose
 * now and every later part at its time) and without it, and the plan's steps as markers. A later part waiting for a
 * glucose condition is drawn at its earliest time. WBT is a marker only: its insulin is for the protein and fat's late
 * rise, which the forecast does not draw, so it would show a drop that does not come. A picture, never a check.
 */
export interface CardForecastChart {
  policy_version: 'card-forecast.v1';
  start: string;
  step_minutes: number;
  /** Without the card: the loop's own forecast (or the CGM trend). */
  baseline: number[];
  /** As the bolus chart's (bolus-forecast.v7): LOOP_ONLY never draws a line with the plan. */
  dose_line: 'MODEL' | 'LOOP_ONLY';
  /** With the whole plan; null when the ISF or ICR is unknown or dose_line is LOOP_ONLY. */
  with_plan: number[] | null;
  /** The baseline's end plus the whole plan's full effect (carbs × ISF / ICR − insulin × ISF); null without ISF/ICR. */
  total_with_plan: number | null;
  /** The loop whose forecast the baseline is ("Trio", "Loop"); null for the CGM trend. */
  loop_name: string | null;
  band: number[];
  events: Array<{ at_minutes: number; kind: 'NOW' | 'LATER' | 'WBT'; carbs_g: number; insulin_u: number; conditional: boolean }>;
}

export function computeCardForecastChart(input: {
  now: Date;
  data: MealForecastData | null;
  carbs_g: number;
  insulin_u: number;
  icr_g_per_u: number | null;
  meal_in_minutes?: number | null;
  fatty_meal?: boolean;
  later: Array<{ at_minutes: number; carbs_g: number; insulin_u: number; trigger: CardLaterTrigger; threshold_mgdl: number | null; wait_minutes: number | null }>;
  wbt: { at_minutes: number; insulin_u: number } | null;
}): CardForecastChart | null {
  if (!input.data) return null;
  const data = input.data;
  const draw = (later: Array<{ at_minutes: number; carbs_g: number; insulin_u: number }>, horizon: number) => computeBolusForecast({
    now: input.now,
    readings: data.readings,
    prediction: data.prediction,
    profile_isf: data.profile_isf,
    profile_units: data.profile_units,
    dia_hours: data.dia_hours ?? null,
    carbs_g: input.carbs_g,
    insulin_u: input.insulin_u,
    icr_g_per_u: input.icr_g_per_u,
    meal_in_minutes: input.meal_in_minutes ?? null,
    fatty_meal: input.fatty_meal === true,
    later_doses: later,
    horizon_minutes: horizon,
  });
  // A part waiting for glucose goes where the line drawn so far meets its condition (the reminder's rule), else where
  // its wait ends and the reminder comes anyway: never at its earliest time while glucose still falls (MODEL only).
  const placed: Array<{ at_minutes: number; carbs_g: number; insulin_u: number; conditional: boolean }> = [];
  for (const part of input.later) {
    if (part.trigger === 'AFTER_MINUTES') {
      placed.push({ at_minutes: part.at_minutes, carbs_g: part.carbs_g, insulin_u: part.insulin_u, conditional: false });
      continue;
    }
    const wait = part.wait_minutes ?? 180;
    const sofar = draw(placed, Math.min(360, part.at_minutes + wait));
    // Without a line with the plan (LOOP_ONLY) nothing says when the condition is met (the loop's line does not
    // include the card's carbs): the part goes at its earliest time, labelled as such.
    if (sofar?.dose_line === 'LOOP_ONLY') {
      placed.push({ at_minutes: part.at_minutes, carbs_g: part.carbs_g, insulin_u: part.insulin_u, conditional: true });
      continue;
    }
    const line = sofar ? sofar.with_dose ?? sofar.baseline : [];
    const step = sofar?.step_minutes ?? 5;
    const from = Math.ceil(part.at_minutes / step);
    let met = -1;
    for (let index = from; index < line.length - 1; index += 1) {
      const slope = (line[index + 1] - line[index]) / step;
      const ready = part.trigger === 'GLUCOSE_STOPPED_FALLING'
        ? line[index] >= DEFERRED_BOLUS_POLICY_CHART.ready_min_glucose_mgdl && slope >= DEFERRED_BOLUS_POLICY_CHART.ready_min_slope_per_min
        : part.trigger === 'GLUCOSE_RISING'
          ? slope >= DEFERRED_BOLUS_POLICY_CHART.rising_min_slope_per_min
          : part.threshold_mgdl !== null && line[index] >= part.threshold_mgdl;
      if (ready) {
        met = index;
        break;
      }
    }
    placed.push({ at_minutes: met >= 0 ? met * step : part.at_minutes + wait, carbs_g: part.carbs_g, insulin_u: part.insulin_u, conditional: true });
  }
  const lastEvent = Math.max(0, ...placed.map((part) => part.at_minutes), input.wbt?.at_minutes ?? 0);
  const chart = draw(placed, lastEvent + 150);
  if (!chart) return null;
  return {
    policy_version: 'card-forecast.v1',
    start: chart.start,
    step_minutes: chart.step_minutes,
    baseline: chart.baseline,
    dose_line: chart.dose_line,
    with_plan: chart.with_dose,
    total_with_plan: chart.total_with_dose,
    loop_name: loopNameOf(chart.baseline_source, data),
    band: chart.band,
    events: [
      { at_minutes: 0, kind: 'NOW', carbs_g: input.carbs_g, insulin_u: input.insulin_u, conditional: false },
      ...placed.map((part) => ({ ...part, kind: 'LATER' as const })),
      ...(input.wbt ? [{ at_minutes: input.wbt.at_minutes, kind: 'WBT' as const, carbs_g: 0, insulin_u: input.wbt.insulin_u, conditional: false }] : []),
    ],
  };
}

/**
 * The risk on the card from its plan chart: the lowest point of the line with the whole plan (what the chart shows), so
 * "prognoza min." and the chart never disagree. Without a dose line (LOOP_ONLY): the loop's line (what the chart shows)
 * or its end plus the whole plan's effect. Null without a line with the plan in MODEL mode.
 */
export function planRiskFromChart(chart: CardForecastChart | null): PlanRisk | null {
  if (chart && chart.dose_line === 'LOOP_ONLY' && chart.baseline.length > 0) {
    return riskOf({ baseline: chart.baseline, with_dose: null, total: chart.total_with_plan, step_minutes: chart.step_minutes, loop_name: chart.loop_name });
  }
  if (!chart || !chart.with_plan || chart.with_plan.length === 0) return null;
  return riskOf({ baseline: chart.baseline, with_dose: chart.with_plan, total: null, step_minutes: chart.step_minutes, loop_name: chart.loop_name });
}

/** The glucose rules of a later part's reminder, for the chart: read from split-bolus.ts, so the two never drift apart. */
const DEFERRED_BOLUS_POLICY_CHART = {
  ready_min_glucose_mgdl: DEFERRED_BOLUS_POLICY.ready_min_glucose_mgdl,
  ready_min_slope_per_min: DEFERRED_BOLUS_POLICY.ready_min_slope_per_min,
  rising_min_slope_per_min: LATER_PLAN_POLICY.rising_min_slope_per_min,
} as const;

export type CardLaterTrigger = 'AFTER_MINUTES' | 'GLUCOSE_STOPPED_FALLING' | 'GLUCOSE_RISING' | 'GLUCOSE_ABOVE';

/** The card's warning for a forecast low; null when there is none. */
export function riskWarning(risk: PlanRisk | null, card: { carbs_g: number; insulin_u: number }): CardWarning | null {
  if (!risk || risk.level === 'NONE') return null;
  const when = risk.min_in_minutes > 0 ? ` za ok. ${risk.min_in_minutes} min` : '';
  const strong = risk.level === 'VERY_LOW';
  const level = strong ? ', ryzyko ciężkiego niedocukrzenia' : ', poniżej 70';
  const forecast = risk.loop_name ? `Prognoza ${risk.loop_name}` : 'Prognoza z trendu CGM';
  const message = risk.basis === 'DOSE_TOTAL'
    ? `${forecast} za ok. ${risk.min_in_minutes} min plus pełne działanie tej karty: ok. ${risk.min_mgdl} mg/dL${level} (zakłada, że pętla nic więcej nie zmieni).`
    : risk.basis === 'LOOP_WITHOUT_DOSE'
      ? `${forecast} bez tej karty: ok. ${risk.min_mgdl} mg/dL${when}${level}.${card.insulin_u > 0 && card.carbs_g === 0 ? ' Insulina z karty obniży ją jeszcze bardziej.' : ''}`
      : `Prognoza z tą kartą: ok. ${risk.min_mgdl} mg/dL${when}${level} (zakłada, że pętla nic więcej nie zmieni).`;
  return {
    code: 'FORECAST_LOW',
    key: `FORECAST_LOW:${risk.basis}:${risk.level}:${risk.min_mgdl}:${card.carbs_g}:${card.insulin_u}`,
    severity: strong ? 'DANGER' : 'WARNING',
    message,
  };
}

export interface CorrectionEstimate {
  /** Rounded down to the step, never below 0. */
  dose_u: number;
  glucose_mgdl: number;
  target_mgdl: number;
  isf_mgdl_per_u: number;
  /** Insulin on board from Trio's newest calculation; null when unknown (then not subtracted). */
  iob_u: number | null;
  /** "(240 − 110) / 80 − IOB 0,5 j = 1,1 j" */
  breakdown: string;
}

/** The correction for the newest reading; a reason (Polish) when it cannot be computed. */
export function computeCorrectionDose(input: { now: Date; data: MealForecastData | null; step: number }): CorrectionEstimate | { missing: string } {
  const view = forecastOf(input.now, input.data);
  if (!view || !view.glucose || !view.reading_fresh) return { missing: 'Brak świeżego odczytu glukozy: korekty nie policzę.' };
  const data = input.data!;
  const isf = isfToMgdl(view.loop?.isf_mgdl_per_u, data.profile_units) ?? isfToMgdl(data.profile_isf, data.profile_units);
  if (!isf || !(isf > 0)) return { missing: `Brak współczynnika wrażliwości (ISF) z ${loopSystemNames(view.loop?.system ?? 'UNKNOWN').genitive} ani z profilu: korekty nie policzę.` };
  const target = targetMgdl(view, data);
  const iob = view.loop?.iob_u ?? null;
  // Without the loop's fresh IOB a correction could stack on insulin still working: none is computed. A negative IOB (less
  // than the basal) never adds insulin.
  if (iob === null) return { missing: `Brak aktualnego IOB z ${loopSystemNames(view.loop?.system ?? 'UNKNOWN').genitive} (dane pętli starsze niż 10 min): korekty nie policzę.` };
  const glucose = view.glucose.value;
  const iobUsed = Math.max(0, iob);
  const raw = (glucose - target) / isf - iobUsed;
  const dose = roundDownToStep(Math.max(0, raw), input.step);
  const iobPart = ` − IOB ${formatUnits(iobUsed)} j`;
  return {
    dose_u: dose,
    glucose_mgdl: glucose,
    target_mgdl: target,
    isf_mgdl_per_u: Math.round(isf * 10) / 10,
    iob_u: iob,
    breakdown: `(${glucose} − ${target}) / ${formatNumber(Math.round(isf * 10) / 10)}${iobPart} = ${formatUnits(dose)} j`,
  };
}

/** What a card with insulin for a high carries: the loop adds insulin itself, glucose falling, night. */
export function correctionWarnings(input: { now: Date; data: MealForecastData | null; timezone: string | null }): CardWarning[] {
  const view = forecastOf(input.now, input.data);
  const warnings: CardWarning[] = [];
  const policy = CARD_ADVICE_POLICY;
  // oref's insulinReq, or Loop's own bolus recommendation: the loop is about to add insulin for this level itself.
  const loopNeed = view?.loop ? (view.insulin_req_u ?? view.recommended_bolus_u ?? 0) : 0;
  if (view?.loop && loopNeed > 0) {
    const names = loopSystemNames(view.loop.system);
    const what = view.insulin_req_u !== null ? `insulinReq ${formatUnits(loopNeed)} j` : `zalecany bolus ${formatUnits(loopNeed)} j`;
    warnings.push({
      code: 'CORRECTION_STACKING',
      key: `CORRECTION_STACKING:${view.loop.computed_at}`,
      severity: 'WARNING',
      message: `${capitalized(names.nominative)} ${agree(names, { m: 'sam', f: 'sama', n: 'samo' })} dokłada insulinę na ten poziom (${what}): korekta z karty sumuje się z nią.`,
    });
  }
  if (view?.glucose && view.slope_per_min !== null && view.slope_per_min <= policy.falling_slope_per_min) {
    warnings.push({
      code: 'CORRECTION_FALLING',
      key: `CORRECTION_FALLING:${view.glucose.at}`,
      severity: 'WARNING',
      message: `Glukoza już spada (${formatNumber(Math.round(view.slope_per_min * 5))} mg/dL na 5 min).`,
    });
  }
  const timezone = input.timezone ?? LOOP_ACTION_TIME_ZONE;
  if (isNight(input.now.toISOString(), timezone)) {
    warnings.push({
      code: 'CORRECTION_NIGHT',
      key: `CORRECTION_NIGHT:${input.now.toISOString().slice(0, 13)}`,
      severity: 'WARNING',
      message: 'Noc: po korekcie warto sprawdzić glukozę, zanim wszyscy zasną.',
    });
  }
  return warnings;
}

/** Whether a time is between 22:00 and 06:00 in the patient's time zone. */
function isNight(iso: string, timezone: string): boolean {
  const schedule: Array<[string, number]> = [['00:00', 1], [CARD_ADVICE_POLICY.night_end, 0], [CARD_ADVICE_POLICY.night_start, 1]];
  return scheduleValueAt(schedule, iso, timezone) === 1;
}

function forecastOf(now: Date, data: MealForecastData | null): GlucoseForecast | null {
  if (!data) return null;
  return buildGlucoseForecast({ now, readings: data.readings, prediction: data.prediction });
}

function targetMgdl(view: GlucoseForecast, data: MealForecastData): number {
  const policy = CARD_ADVICE_POLICY;
  const target = [mgdl(view.loop?.target_mgdl ?? null, null), mgdl(data.profile_target, data.profile_units)]
    .find((value) => value !== null && value >= policy.min_target_mgdl && value <= policy.max_target_mgdl);
  return target !== undefined && target !== null ? Math.round(target) : policy.default_target_mgdl;
}

function mgdl(value: number | null, units: string | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return /mmol/i.test(units ?? '') || value < CARD_ADVICE_POLICY.mmol_below ? Math.round(value * 18) : value;
}

function formatNumber(value: number): string {
  return String(value).replace('.', ',');
}
