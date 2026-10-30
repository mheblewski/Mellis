import { buildGlucoseForecast, type GlucoseForecast } from '@modules/glucose-forecast/application/glucose-forecast';
import { LOOP_ACTION_TIME_ZONE } from '@modules/loop-actions/application/loop-action-views';
import { isfToMgdl } from '@modules/glucose-forecast/application/isf-units';
import { bolusChartBaseline, excessInsulinLine } from '@modules/glucose-forecast/application/bolus-forecast';
import { capitalized, loopSystemNames } from '@modules/loop-system/domain/loop-system';
import { computeFastCarbsFirst, computeMealDoseAdjustment, type FastCarbsFirst, type MealDoseAdjustment, type MealForecastData } from './meal-dose-forecast';
import { formatUnits, roundDownToStep } from './remote-command-policy';

/**
 * The dose a meal bolus starts from (dose-calculator.v1, owner-approved after a dose review 2026-10-29): the loop-style
 * bolus calculator, used ONLY TO LOWER the carbs / ICR dose. One function for every place a dose is pre-filled or
 * proposed: the Bolus tab, chat MEAL cards, a split meal's later part and a deferred bolus. No AI.
 *
 *   calculator = (carbs + COB) / ICR  +  (glucose + 15-min trend − target) / ISF  −  IOB
 *   default    = clamp(min(carbs / ICR, calculator, dose lowered for a drop), 0, carbs / ICR), rounded down to the pump step
 *   glucose < 70 mg/dL now, or a low now or within ~30 min (rescue-carbs.v2): default 0 U, carbs first
 *
 * It is Trio's own bolus calculator (BolusCalculationManager, Trio 1.0.2: correction + trend + (COB + carbs) / CR − IOB,
 * knowledge/correction-up/devices/trio-bolus-calculator-correction-code.md) without its upward side: the result never
 * exceeds carbs / ICR, so it never adds a correction on its own (a correction is added only when the caregiver asks for
 * it, as before). Choices:
 *
 * - COB of earlier carbs IS added (as Trio does). Their boluses are in IOB; without COB, every meal eaten within ~2 h
 *   of another (common: a snack after a meal) would lose the earlier meal's bolus a second time, and many such doses
 *   would fall to 0 U. COB is capped at Trio's maxCOB 120 g. Counting COB can only make the lowering smaller, never
 *   the dose above carbs / ICR (the min).
 * - Negative IOB (basal suspended or lowered) is taken as 0: the loop lowered basal because glucose was heading low,
 *   so it is never a reason for more insulin (Trio adds it back; the min would cap it at carbs / ICR anyway).
 * - Trio's "Recommended Bolus Percentage" (80% by default) is not applied: it would lower every dose by a fifth, which
 *   nobody asked for. Trio's super bolus and reduced bolus are not modelled either.
 * - The trend is the CGM's short average slope (oref's short_avgdelta, ~15 min) × 15 min, Trio's 15–20 min delta.
 * - Only fresh data: a reading of the last 15 min and the loop's calculation for it (glucose-forecast.v1, the same
 *   rule as the card's correction). Without them the calculator is not used and the dose stays carbs / ICR (said why).
 * - ISF and target: the loop's newest calculation (autosens, temporary targets: Trio's current target), else the
 *   profile's at now: the middle of target_low..target_high (Trio corrects to the range, not to its lower edge; review
 *   2026-10-29, L5), target_low alone when the profile has no upper edge. A target is clamped to 80–250 mg/dL: a high
 *   temporary target (exercise 200) is kept, since it only lowers the dose; a value below 40 or above 400 is not a
 *   target (a unit or data error) and the next one is used, else 100. mmol/L as the existing helpers read it
 *   (isfToMgdl; targets below 25).
 * - The danger reference (doseExceedsFormula) is the calculator, but never above carbs / ICR + max(0, correction − IOB):
 *   COB may lower nothing there and cannot inflate it, so 120 g of lingering COB never switches the check off (M5).
 * - A reading below 70 that is no longer fresh (up to 40 min, the data window) is taken as carbs first too (L1): the
 *   default is 0 U and insulin needs the separate low confirmation.
 * - The falling-glucose reduction (meal-dose-forecast.v3) is applied without the model asking for it: min() of both.
 *
 * A later part of a meal (split part 2, deferred bolus) passes `later_part`: its dose already took off the loop's extra
 * insulin, manual boluses and the card's insulin since the meal, so IOB and COB are not counted again (they hold the
 * meal's own first part); only a glucose below target or falling (the negative correction), the drop reduction and
 * the carbs-first rule lower it.
 */

/**
 * dose-calculator.v2 (Mellis 1.0.2): everything above is unchanged,
 * and a HIGHER dose may be offered on top, never pre-filled. The caregiver opts in with the Bolus tab's ± button:
 *
 *   0 g (a correction): higher = 0,5 × max(0, (glucose + 15-min trend − target) / ISF − max(IOB, 0)), no COB, ≤ 1 U
 *   a meal:             higher = carbs / ICR + 0,5 × max(0, (glucose − target) / ISF − max(IOB, 0)), no trend or COB,
 *                       the extra ≤ 1 U
 *
 * rounded down to the pump step, offered only when it adds at least one step. Half: at very low basal rates a loop may
 * give no SMBs at all, so a correction is left to the caregiver, and a full correction (or the loop's insulinReq) on
 * top of the loop is the riskier choice. Never offered while the default is lowered (that mode
 * wins), and not when any gate holds (OptInGate): glucose < 150 (00:00–06:00 in the profile's time zone: < 180); the
 * 15-min trend < 0 (a meal: outside 0..+30); a bolus, remote bolus or SMB of ≥ 0,1 U in the last 90 min (or the
 * history unknown); carbs in the last 2 h (0 g only; or unknown); glucose or the loop older than 15 min; the loop's
 * minPredBG < 54 (a meal: < 100; unknown: not offered); carbs first / a low near; within 30 min after a fall (15-min
 * trend ≤ −10), a reading below 70 or a sent dose the drop or carbs-first rule lowered (or a rescue); a later part of a
 * meal; the calculator unavailable. Only callers that pass `opt_in` (the Bolus tab) get it.
 *
 * The danger reference follows the chosen source: a dose up to the higher value is not "above the calculator" by
 * itself (doseAboveCalculatorWarning holds it against max(reference, higher)); anything above still warns as before.
 */
/**
 * dose-calculator.v3 (T4b, owner-approved 2026-10-30 after the target-dose backtest): when the loop-style calculator
 * alone lowered the dose (limited_by CALCULATOR: no drop, not carbs first, not a later part) and the loop's forecast is
 * fresh (the Bolus chart's line from the loop, baseline_source LOOP), the default moves halfway from the calculator's
 * dose v1 towards d2, the largest dose (pump steps, v1..carbs / ICR) whose dashed "z tą dawką" line — the chart's own
 * (bolusChartBaseline + excessInsulinLine: the same ISF, DIA, insulin curve and dose lag) — stays at or above
 * min(target, the newest reading) for 0–180 min:
 *
 *   default = roundDownToStep(v1 + (d2 − v1) / 2), within v1..carbs / ICR   (limited_by FORECAST)
 *
 * The loop's IOB forecast already holds what the loop knows (IOB, COB): v1 counts IOB once more, which on the owner's
 * meals lowered small doses to almost nothing while the loop's line stayed in range. Never above carbs / ICR, never
 * below v1; the falling, drop and carbs-first rules win (they never get here). The danger reference is at least this
 * default; the opt-in higher dose stays off (DOSE_LOWERED) as for CALCULATOR.
 */
export const DOSE_CALCULATOR_POLICY = {
  version: 'dose-calculator.v3',
  /** dose-calculator.v3: the forecast nudge's window (the chart's 3 hours) and share of the way to d2. */
  forecast_nudge: { horizon_minutes: 180, fraction: 0.5 },
  trend_minutes: 15,
  default_target_mgdl: 100,
  /** A target is clamped to this range (a high temporary target only lowers the dose). */
  min_target_mgdl: 80,
  max_target_mgdl: 250,
  /** Outside this a "target" is a data or unit error: the next candidate (or the default) is used. */
  absurd_target_below_mgdl: 40,
  absurd_target_above_mgdl: 400,
  /** A stale reading below 70 within this many minutes still means carbs first (the gate outside the calculator). */
  stale_low_max_minutes: 60,
  /** A target below this is taken as mmol/L. */
  mmol_below: 25,
  /** Trio's maxCOB default. */
  max_cob_g: 120,
  /** Below this glucose (mg/dL) the default is 0 U: carbs first. */
  carbs_first_below_mgdl: 70,
  /** A dose this much above the formula is dangerous: max(0.5 U, 25% of the formula). */
  danger_min_u: 0.5,
  danger_ratio: 0.25,
  /** Recent insulin (manual, remote and SMB) counted for a second dose: DIA / 3 within 90–120 min, 120 without DIA. */
  recent_insulin_default_minutes: 120,
  recent_insulin_min_minutes: 90,
  recent_insulin_max_minutes: 120,
  /** At least this much insulin in that window counts as "recent insulin". */
  recent_insulin_min_u: 1,
  /** A trend of this many mg/dL in 15 min is said ("i spada", "i rośnie"). */
  trend_said_mgdl: 10,
  /** dose-calculator.v2: the opt-in higher dose (see above). */
  opt_in: {
    fraction: 0.5,
    max_extra_u: 1,
    min_glucose_mgdl: 150,
    night_min_glucose_mgdl: 180,
    /** Local hours [from, to) of the night threshold, in the profile's time zone. */
    night_from_hour: 0,
    night_to_hour: 6,
    /** A meal: the 15-min trend must be within this range (mg/dL per 15 min). */
    meal_trend_min_mgdl: 0,
    meal_trend_max_mgdl: 30,
    recent_dose_minutes: 90,
    recent_dose_min_u: 0.1,
    recent_carbs_minutes: 120,
    max_data_age_minutes: 15,
    correction_min_pred_mgdl: 54,
    meal_min_pred_mgdl: 100,
    guard_lookback_minutes: 30,
    /** A 15-min trend this low in the look back is a fall (the falling-glucose rule). */
    guard_fall_mgdl: -10,
    guard_low_mgdl: 70,
  },
} as const;

export type DoseLimitedBy = 'ICR' | 'CALCULATOR' | 'FORECAST' | 'DROP' | 'CARBS_FIRST';
export type CarbsFirstLevel = FastCarbsFirst['level'] | 'BELOW_70' | 'STALE_LOW';

export interface DoseCalculatorBreakdown {
  /** Carbs / ICR, unrounded (a later part: its dose as estimated before the calculator). */
  carbs_u: number;
  cob_g: number;
  cob_u: number;
  glucose_mgdl: number;
  /** Trend over the next 15 min, mg/dL (negative: falling). */
  trend_mgdl: number;
  projected_mgdl: number;
  target_mgdl: number;
  isf_mgdl_per_u: number;
  /** (projected − target) / ISF. */
  correction_u: number;
  /** The loop's IOB; null for a later part (not counted again). */
  iob_u: number | null;
  /** What was taken off for IOB (never negative). */
  iob_subtracted_u: number;
  /** The whole sum before rounding (may be negative). */
  raw_u: number;
}

export interface DoseCalculation {
  policy_version: string;
  carbs_g: number;
  icr_g_per_u: number | null;
  /** Carbs / ICR rounded down to the step; null without carbs or ICR (a later part: its estimate). */
  icr_dose_u: number | null;
  /** The calculator could be used (fresh glucose, the loop's fresh IOB, an ISF). */
  calculated: boolean;
  /** Polish: why the calculator was not used (null when it was). */
  fallback_reason: string | null;
  /** The calculator rounded down to the step, never below 0; null when not used. */
  calculator_u: number | null;
  breakdown: DoseCalculatorBreakdown | null;
  /** The falling-glucose reduction (meal-dose-forecast.v3) when it lowers carbs / ICR. */
  drop: { dose_u: number; covered_carbs_g: number; forecast_low_mgdl: number; target_mgdl: number; summary: string; give_at_meal_end: boolean } | null;
  /** Glucose below 70 (fresh, or the newest reading stale: STALE_LOW) or a low near: insulin waits, carbs first. */
  carbs_first: { glucose_mgdl: number; level: CarbsFirstLevel; carbs_g: number | null; message: string; reading_age_minutes?: number | null } | null;
  /** The dose pre-filled or proposed: never above icr_dose_u. */
  default_u: number;
  limited_by: DoseLimitedBy;
  /** The loop itself says less is needed (oref's insulinReq < 0 or eventualBG below target) while a dose is proposed. */
  loop_signal: { system_name: string; insulin_req_u: number | null; eventual_mgdl: number | null; target_mgdl: number } | null;
  /**
   * What a dose is held against for the danger check (doseExceedsFormula): the calculator without the cap at carbs /
   * ICR (a caregiver's correction on top is not "above the formula" when the data call for it), but never above carbs
   * / ICR + max(0, correction − IOB) (COB cannot inflate it), lowered for a drop; 0 while carbs come first; null when
   * nothing could be computed.
   */
  reference_u: number | null;
  /** The reference was capped at carbs / ICR + net correction (COB would have raised it). */
  reference_capped?: boolean;
  /**
   * dose-calculator.v3: the forecast nudge, when it was worked out (limited_by CALCULATOR and a fresh loop line): v1,
   * d2 and the lowest point of the dashed line at the new default; null otherwise.
   */
  forecast_nudge?: { v1_u: number; d2_u: number; default_u: number; floor_mgdl: number; line_min_mgdl: number } | null;
  /** One Polish line for under the dose (the whole explanation; the app's info popover). */
  summary: string;
  /**
   * The line under the dose: only how much and why it differs from carbs / ICR ("↓ 0,3 j mniej niż z przelicznika
   * (3,85 j): aktywna insulina"); "Z przelicznika" when it does not (owner 2026-10-29).
   */
  short_summary?: string;
  /** The one main reason the default is below carbs / ICR; null when it is not lowered. */
  reason_code?: DoseLoweredReason | null;
  /** How much below carbs / ICR the default is; null when it is not lowered. */
  lowered_by_u?: number | null;
  /** The calculator spelled out ("30 g / ICR 10 + (120 − 100) / 100 − IOB 2 j = 1,2 j"); null when not used. */
  formula?: string | null;
  /**
   * dose-calculator.v2: the opt-in higher dose (never the default): the whole dose with half a correction, rounded down
   * to the step; null when not offered (`higher_gate` says why). Older apps ignore it.
   */
  higher_u?: number | null;
  higher_reason_code?: HigherReasonCode | null;
  higher_breakdown?: HigherBreakdown | null;
  /**
   * Polish, the higher dose's reasoning, shown behind the app's info button: "Korekta: +0,2 j (połowa wyliczenia: …)".
   * The app's line under the dose is its own short one ("+0,2 j korekty (połowa)").
   */
  higher_summary?: string | null;
  /** The higher dose spelled out, behind the info button. */
  higher_formula?: string | null;
  /** Why no higher dose is offered (the first gate that holds); null when it is. */
  higher_gate?: OptInGate | null;
}

export type HigherReasonCode = 'CORRECTION_ONLY' | 'MEAL_TOP_UP';

export type OptInGate =
  | 'NOT_REQUESTED'
  | 'LATER_PART'
  | 'CALCULATOR_UNAVAILABLE'
  | 'DOSE_LOWERED'
  | 'CARBS_FIRST'
  | 'STALE_DATA'
  | 'GLUCOSE_BELOW_THRESHOLD'
  | 'TREND'
  | 'RECENT_INSULIN'
  | 'RECENT_CARBS'
  | 'LOOP_FORECAST_LOW'
  | 'RECENT_FALL_OR_LOW'
  | 'BELOW_STEP';

export interface HigherBreakdown {
  /** carbs / ICR rounded down to the step (0 at 0 g). */
  base_u: number;
  glucose_mgdl: number;
  /** The 15-min trend counted (0 g only; a meal counts none: null). */
  trend_mgdl: number | null;
  target_mgdl: number;
  isf_mgdl_per_u: number;
  iob_subtracted_u: number;
  /** (glucose [+ trend] − target) / ISF − IOB, unrounded (may be negative). */
  full_correction_u: number;
  fraction: number;
  /** fraction × max(0, full), before the cap and the rounding. */
  half_u: number;
  cap_u: number;
  capped: boolean;
  /** What is added to base_u: half_u capped and rounded down to the step. */
  extra_u: number;
}

/**
 * The opt-in's data beyond the calculator's (dose-calculator.v2): passed only where a higher dose may be offered (the
 * Bolus tab). Null fields are unknown, and unknown never offers it.
 */
export interface DoseOptInInput {
  /** Boluses (manual and remote) and SMBs of at least the last 90 min. */
  recent_doses: Array<{ at: string; units: number }> | null;
  /** The newest carbs entered (any kind except ignored, or sent from Mellis) in the last 2 h: null when none. */
  recent_carbs: { last_at: string | null } | null;
  /** The newest dose the drop or carbs-first rule lowered, or rescue carbs, in the last 30 min: null when none. */
  recent_guard: { last_at: string | null } | null;
}

export interface DoseCalculatorInput {
  now: Date;
  carbs_g: number;
  /** ICR at the meal's time (g/U). */
  icr_g_per_u: number | null;
  step: number;
  data: MealForecastData | null;
  /** A later part of a meal: its dose estimated by the planned-bolus rules (null: no ICR). */
  later_part?: { dose_u: number | null } | null;
  /** dose-calculator.v2: the opt-in higher dose's data; absent: none offered. */
  opt_in?: DoseOptInInput | null;
  /** Offline only (specs of v1's arithmetic, backtests): false leaves out v3's forecast nudge. */
  forecast_nudge?: boolean;
}

/** The loop-style calculator, lowering only (see above). */
export function computeDoseCalculation(input: DoseCalculatorInput): DoseCalculation {
  const policy = DOSE_CALCULATOR_POLICY;
  const { now, data, step } = input;
  const carbs = Number.isFinite(input.carbs_g) && input.carbs_g > 0 ? input.carbs_g : 0;
  const icr = input.icr_g_per_u !== null && input.icr_g_per_u > 0 ? input.icr_g_per_u : null;
  const laterPart = input.later_part !== undefined && input.later_part !== null;
  const icrDose = laterPart
    ? input.later_part!.dose_u
    : carbs > 0 && icr ? roundDownToStep(carbs / icr, step) : null;
  const view = data ? buildGlucoseForecast({ now, readings: data.readings, prediction: data.prediction }) : null;
  const glucose = view?.reading_fresh ? view.glucose : null;
  const staleLow = view && !view.reading_fresh && view.glucose && view.glucose.value < policy.carbs_first_below_mgdl
    && view.reading_age_minutes !== null && view.reading_age_minutes <= policy.stale_low_max_minutes
    ? { value: view.glucose.value, age: Math.round(view.reading_age_minutes) }
    : null;

  // Change 2: glucose below 70 now, or a low now or within ~30 min (the rescue alert's detection): carbs first.
  const fast = data ? computeFastCarbsFirst({ now, icr_g_per_u: icr, data }) : null;
  const carbsFirst: DoseCalculation['carbs_first'] = fast
    ? { glucose_mgdl: fast.glucose_mgdl, level: fast.level, carbs_g: fast.carbs_g, message: fast.message }
    : glucose && glucose.value < policy.carbs_first_below_mgdl
      ? { glucose_mgdl: glucose.value, level: 'BELOW_70', carbs_g: null, message: `Glukoza ${glucose.value} mg/dL: najpierw szybkie węglowodany, insulina po wzroście glukozy.` }
      : staleLow
        ? { glucose_mgdl: staleLow.value, level: 'STALE_LOW', carbs_g: null, reading_age_minutes: staleLow.age, message: `Ostatni odczyt niski i nieaktualny (${staleLow.value} mg/dL sprzed ${staleLow.age} min): najpierw szybkie węglowodany, insulina po wzroście glukozy.` }
        : null;

  // Change 1: the calculator.
  let breakdown: DoseCalculatorBreakdown | null = null;
  let fallback: string | null = null;
  let exact: { isf: number; target: number; trend: number; iob: number } | null = null;
  const loopName = loopSystemNames(view?.loop?.system ?? data?.prediction?.system ?? 'UNKNOWN');
  if (!data || !view) {
    fallback = 'brak danych glukozy i pętli';
  } else if (!glucose) {
    fallback = 'brak świeżego odczytu glukozy';
  } else {
    const isf = isfToMgdl(view.loop?.isf_mgdl_per_u, data.profile_units) ?? isfToMgdl(data.profile_isf, data.profile_units);
    const iob = view.loop?.iob_u ?? null;
    if (!isf || !(isf > 0)) {
      fallback = 'brak współczynnika wrażliwości (ISF)';
    } else if (!laterPart && iob === null) {
      fallback = `brak aktualnego IOB z ${loopName.genitive}`;
    } else if (!laterPart && carbs > 0 && !icr) {
      fallback = 'brak przelicznika (ICR)';
    } else if (laterPart && icrDose === null) {
      fallback = 'brak przelicznika (ICR)';
    } else {
      const target = targetMgdl(view, data);
      const trend = view.slope_per_min !== null ? view.slope_per_min * policy.trend_minutes : 0;
      const projected = glucose.value + trend;
      const correction = (projected - target) / isf;
      const cob = laterPart ? 0 : Math.min(policy.max_cob_g, Math.max(0, view.loop?.cob_g ?? 0));
      const carbsU = laterPart ? icrDose! : icr ? carbs / icr : 0;
      const cobU = icr ? cob / icr : 0;
      const iobSubtracted = laterPart ? 0 : Math.max(0, iob ?? 0);
      const raw = carbsU + cobU + correction - iobSubtracted;
      exact = { isf, target, trend, iob: iobSubtracted };
      breakdown = {
        carbs_u: round2(carbsU),
        cob_g: Math.round(cob),
        cob_u: round2(cobU),
        glucose_mgdl: glucose.value,
        trend_mgdl: Math.round(trend),
        projected_mgdl: Math.round(projected),
        target_mgdl: target,
        isf_mgdl_per_u: Math.round(isf * 10) / 10,
        correction_u: round2(correction),
        iob_u: laterPart ? null : iob,
        iob_subtracted_u: round2(iobSubtracted),
        raw_u: round2(raw),
      };
    }
  }
  const calculatorU = breakdown ? roundDownToStep(Math.max(0, breakdown.raw_u), step) : null;

  // The falling-glucose reduction of the carbs (or of the later part's own carbs).
  const dropCarbs = laterPart ? (icrDose !== null && icr ? icrDose * icr : 0) : carbs;
  const dropAdjustment: MealDoseAdjustment | null = icrDose !== null && icrDose > 0 && dropCarbs > 0
    ? computeMealDoseAdjustment({ now, carbs_g: Math.round(dropCarbs), dose_u: icrDose, icr_g_per_u: icr, step, data })
    : null;
  const drop: DoseCalculation['drop'] = dropAdjustment
    ? { dose_u: dropAdjustment.dose_u, covered_carbs_g: dropAdjustment.covered_carbs_g, forecast_low_mgdl: dropAdjustment.forecast_low_mgdl, target_mgdl: dropAdjustment.target_mgdl, summary: dropAdjustment.summary, give_at_meal_end: dropAdjustment.give_at_meal_end }
    : null;

  // The default: never above carbs / ICR.
  let defaultU = icrDose ?? 0;
  let limitedBy: DoseLimitedBy = 'ICR';
  if (icrDose !== null) {
    if (calculatorU !== null && calculatorU < defaultU - 1e-9) {
      defaultU = calculatorU;
      limitedBy = 'CALCULATOR';
    }
    if (drop && drop.dose_u < defaultU - 1e-9) {
      defaultU = drop.dose_u;
      limitedBy = 'DROP';
    }
  }
  if (carbsFirst) {
    defaultU = 0;
    limitedBy = 'CARBS_FIRST';
  }
  defaultU = Math.max(0, Math.min(defaultU, icrDose ?? 0));

  // dose-calculator.v3: halfway to the dose whose dashed line stays at or above the target (see the policy).
  let forecastNudge: DoseCalculation['forecast_nudge'] = null;
  if (input.forecast_nudge !== false && limitedBy === 'CALCULATOR' && !drop && !carbsFirst && !laterPart && exact && icrDose !== null && data && breakdown) {
    forecastNudge = forecastNudgeOf({ now, data, step, v1: defaultU, icr_dose_u: icrDose, isf: exact.isf, target: exact.target });
    if (forecastNudge && forecastNudge.default_u > defaultU + 1e-9) {
      defaultU = forecastNudge.default_u;
      limitedBy = 'FORECAST';
    }
  }

  // The formula a dose is held against (danger check): the calculator not capped at carbs / ICR (a correction the data
  // call for is not "above the formula"), but never above carbs / ICR + max(0, correction − IOB): COB lowers nothing
  // here and cannot raise it (M5). Lowered for a drop; 0 when carbs come first. Without the calculator: the drop's
  // dose, else nothing to hold it against.
  let reference: number | null = calculatorU;
  let referenceCapped = false;
  if (breakdown && calculatorU !== null) {
    const cap = (icrDose ?? 0) + Math.max(0, breakdown.correction_u - breakdown.iob_subtracted_u);
    if (cap < calculatorU - 1e-9) {
      reference = round2(Math.max(0, cap));
      referenceCapped = true;
    }
  }
  if (drop) reference = reference === null ? drop.dose_u : Math.min(reference, drop.dose_u);
  if (carbsFirst) reference = 0;
  // v3: the danger check never warns about its own default.
  const referenceFromForecast = limitedBy === 'FORECAST' && (reference === null || reference < defaultU - 1e-9);
  if (referenceFromForecast) reference = defaultU;

  const loopSignal = view?.loop && defaultU > 0 ? loopSignalOf(view, data!, loopName) : null;
  const result: Omit<DoseCalculation, 'summary'> = {
    policy_version: policy.version,
    carbs_g: carbs,
    icr_g_per_u: icr,
    icr_dose_u: icrDose,
    calculated: breakdown !== null,
    fallback_reason: breakdown ? null : fallback,
    calculator_u: calculatorU,
    breakdown,
    drop,
    carbs_first: carbsFirst,
    default_u: round2(defaultU),
    limited_by: limitedBy,
    loop_signal: loopSignal,
    reference_u: reference === null ? null : round2(reference),
    reference_capped: referenceCapped && !referenceFromForecast && !carbsFirst && !(drop && reference !== null && drop.dose_u <= reference + 1e-9),
    forecast_nudge: forecastNudge,
  };
  const reasonCode = loweredReasonOf(result);
  const withSummary = {
    ...result,
    summary: summaryOf(result, laterPart),
    reason_code: reasonCode,
    lowered_by_u: icrDose !== null && reasonCode ? round2(icrDose - result.default_u) : null,
  };
  const higher = higherDoseOf({ input, view, carbs, icr, icrDose, laterPart, exact, calculation: withSummary });
  return { ...withSummary, short_summary: shortSummaryOf(withSummary, laterPart, capitalized(loopName.nominative)), formula: calculatorFormula(withSummary), ...higher };
}

/**
 * dose-calculator.v3: v1 + half the way to d2 (the largest dose, in pump steps up to carbs / ICR, whose dashed line
 * stays ≥ min(target, newest reading) over 0–180 min), rounded down to the step. Null without the loop's fresh line.
 */
function forecastNudgeOf(args: { now: Date; data: MealForecastData; step: number; v1: number; icr_dose_u: number; isf: number; target: number }): NonNullable<DoseCalculation['forecast_nudge']> | null {
  const policy = DOSE_CALCULATOR_POLICY.forecast_nudge;
  const line = bolusChartBaseline({ now: args.now, readings: args.data.readings, prediction: args.data.prediction });
  if (!line || line.baseline_source !== 'LOOP') return null;
  const stepU = Number.isFinite(args.step) && args.step > 0 ? args.step : 0.05;
  const points = Math.floor(policy.horizon_minutes / 5) + 1;
  const floor = Math.min(args.target, line.baseline[0]);
  const lineMin = (dose: number) => Math.min(...excessInsulinLine({
    baseline: line.baseline.slice(0, points),
    step_minutes: 5,
    dose_lag_minutes: line.dose_lag_minutes,
    excess_u: dose - args.icr_dose_u,
    isf_mgdl: args.isf,
    dia_hours: args.data.dia_hours ?? null,
    peak_minutes: args.data.insulin_curve?.peak_minutes,
  }));
  // In hundredths: 0.3 + 0.1 steps never drift past carbs / ICR.
  const toH = (units: number) => Math.round(units * 100);
  const stepH = Math.round(stepU * 100);
  let d2H = toH(args.v1);
  for (let doseH = toH(args.v1); doseH <= toH(args.icr_dose_u); doseH += stepH) {
    if (lineMin(doseH / 100) >= floor) d2H = doseH;
  }
  const d2 = d2H / 100;
  const nudged = Math.min(args.icr_dose_u, Math.max(args.v1, roundDownToStep(args.v1 + (d2 - args.v1) * policy.fraction, stepU)));
  return { v1_u: round2(args.v1), d2_u: round2(d2), default_u: round2(nudged), floor_mgdl: Math.round(floor), line_min_mgdl: Math.round(lineMin(nudged)) };
}

type HigherFields = Pick<DoseCalculation, 'higher_u' | 'higher_reason_code' | 'higher_breakdown' | 'higher_summary' | 'higher_formula' | 'higher_gate'>;

/** The opt-in higher dose (dose-calculator.v2) or the first gate that holds. */
function higherDoseOf(args: {
  input: DoseCalculatorInput;
  view: GlucoseForecast | null;
  carbs: number;
  icr: number | null;
  icrDose: number | null;
  laterPart: boolean;
  exact: { isf: number; target: number; trend: number; iob: number } | null;
  calculation: Omit<DoseCalculation, 'short_summary' | 'formula'>;
}): HigherFields {
  const gate = optInGateOf(args);
  if (gate) return { higher_u: null, higher_reason_code: null, higher_breakdown: null, higher_summary: null, higher_formula: null, higher_gate: gate };
  const policy = DOSE_CALCULATOR_POLICY.opt_in;
  const { input, carbs, exact } = args;
  const glucose = args.view!.glucose!.value;
  const meal = carbs > 0;
  const base = meal ? args.icrDose ?? 0 : 0;
  const trend = meal ? null : exact!.trend;
  const full = (glucose + (trend ?? 0) - exact!.target) / exact!.isf - exact!.iob;
  const half = policy.fraction * Math.max(0, full);
  const capped = half > policy.max_extra_u + 1e-9;
  const extra = roundDownToStep(Math.min(policy.max_extra_u, half), input.step);
  const stepU = Number.isFinite(input.step) && input.step > 0 ? input.step : 0.05;
  if (!(extra >= stepU - 1e-9)) return { higher_u: null, higher_reason_code: null, higher_breakdown: null, higher_summary: null, higher_formula: null, higher_gate: 'BELOW_STEP' };
  const breakdown: HigherBreakdown = {
    base_u: round2(base),
    glucose_mgdl: glucose,
    trend_mgdl: trend === null ? null : Math.round(trend),
    target_mgdl: exact!.target,
    isf_mgdl_per_u: Math.round(exact!.isf * 10) / 10,
    iob_subtracted_u: round2(exact!.iob),
    full_correction_u: round2(full),
    fraction: policy.fraction,
    half_u: round2(half),
    cap_u: policy.max_extra_u,
    capped,
    extra_u: round2(extra),
  };
  const higher = round2(base + extra);
  return {
    higher_u: higher,
    higher_reason_code: meal ? 'MEAL_TOP_UP' : 'CORRECTION_ONLY',
    higher_breakdown: breakdown,
    higher_summary: higherSummaryOf(breakdown, meal),
    higher_formula: higherFormulaOf(breakdown, meal, carbs, args.icr, higher),
    higher_gate: null,
  };
}

/** The first gate that holds for the opt-in higher dose (null: it may be offered). */
function optInGateOf(args: Parameters<typeof higherDoseOf>[0]): OptInGate | null {
  const policy = DOSE_CALCULATOR_POLICY.opt_in;
  const { input, view, carbs, calculation } = args;
  const opt = input.opt_in;
  if (!opt) return 'NOT_REQUESTED';
  if (args.laterPart) return 'LATER_PART';
  const maxAge = policy.max_data_age_minutes;
  const loop = view?.loop ?? null;
  // Glucose or the loop older than 15 min (said before "calculator unavailable", which it also causes).
  if (view && (!view.glucose || !view.reading_fresh || view.reading_age_minutes === null || view.reading_age_minutes > maxAge
    || !loop || view.loop_age_minutes === null || view.loop_age_minutes > maxAge)) return 'STALE_DATA';
  if (!calculation.calculated || !args.exact || !view?.glucose) return 'CALCULATOR_UNAVAILABLE';
  if (calculation.carbs_first) return 'CARBS_FIRST';
  const meal = carbs > 0;
  if (meal && (args.icrDose === null || !args.icr)) return 'CALCULATOR_UNAVAILABLE';
  // The lower mode wins: a default below carbs / ICR (or a drop) is never topped up.
  if (meal && (calculation.default_u < (args.icrDose ?? 0) - 1e-9 || calculation.limited_by !== 'ICR' || calculation.drop)) return 'DOSE_LOWERED';
  const nowMs = input.now.getTime();
  const glucose = view.glucose.value;
  const threshold = isNight(input.now, input.data?.timezone ?? LOOP_ACTION_TIME_ZONE) ? policy.night_min_glucose_mgdl : policy.min_glucose_mgdl;
  if (glucose < threshold) return 'GLUCOSE_BELOW_THRESHOLD';
  if (view.slope_per_min === null) return 'TREND';
  const trend = view.slope_per_min * DOSE_CALCULATOR_POLICY.trend_minutes;
  if (meal ? trend < policy.meal_trend_min_mgdl - 1e-9 || trend > policy.meal_trend_max_mgdl + 1e-9 : trend < -1e-9) return 'TREND';
  const since = (minutes: number) => nowMs - minutes * 60_000;
  const within = (iso: string | null | undefined, minutes: number) => {
    const atMs = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(atMs) && atMs >= since(minutes) && atMs <= nowMs + 60_000;
  };
  if (!opt.recent_doses) return 'RECENT_INSULIN';
  if (opt.recent_doses.some((dose) => Number.isFinite(dose.units) && dose.units >= policy.recent_dose_min_u - 1e-9 && within(dose.at, policy.recent_dose_minutes))) return 'RECENT_INSULIN';
  if (!meal && (!opt.recent_carbs || within(opt.recent_carbs.last_at, policy.recent_carbs_minutes))) return 'RECENT_CARBS';
  const minPred = minPredMgdl(view, input.data?.profile_units ?? null);
  if (minPred === null || minPred < (meal ? policy.meal_min_pred_mgdl : policy.correction_min_pred_mgdl)) return 'LOOP_FORECAST_LOW';
  if (!opt.recent_guard || within(opt.recent_guard.last_at, policy.guard_lookback_minutes) || recentFallOrLow(input)) return 'RECENT_FALL_OR_LOW';
  return null;
}

/** 00:00–06:00 in the profile's time zone (an unknown zone: the home one). */
function isNight(now: Date, timeZone: string): boolean {
  const policy = DOSE_CALCULATOR_POLICY.opt_in;
  let hour: number;
  try {
    hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
  } catch {
    hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: LOOP_ACTION_TIME_ZONE, hour: '2-digit', hourCycle: 'h23' }).format(now));
  }
  return hour >= policy.night_from_hour && hour < policy.night_to_hour;
}

/** The loop's minPredBG (oref's reason text), else the lowest point of its main curve; null when neither is known. */
function minPredMgdl(view: GlucoseForecast, units: string | null): number | null {
  const loop = view.loop;
  if (!loop) return null;
  const printed = loop.min_pred_bg;
  // Printed in the user's units (mmol/L users: mmol/L); zero or below is no forecast to trust.
  if (typeof printed === 'number' && Number.isFinite(printed)) return printed > 0 ? mgdl(printed, units) : 0;
  const curve = view.main_curve ? loop.curves[view.main_curve] ?? [] : [];
  const values = curve.filter((value) => Number.isFinite(value) && value > 0);
  return values.length > 0 ? Math.min(...values) : null;
}

/**
 * A fall (the 15-min trend at or below −10 mg/dL at some reading) or a reading below 70 in the last 30 min: the
 * falling-glucose rule or the hypo guard has just applied, so no correction is offered yet.
 */
function recentFallOrLow(input: DoseCalculatorInput): boolean {
  const policy = DOSE_CALCULATOR_POLICY.opt_in;
  const readings = input.data?.history_readings ?? input.data?.readings ?? [];
  const nowMs = input.now.getTime();
  const fromMs = nowMs - policy.guard_lookback_minutes * 60_000;
  const sorted = readings
    .filter((reading) => Number.isFinite(Date.parse(reading.at)) && Number.isFinite(reading.value) && Date.parse(reading.at) <= nowMs + 60_000)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  for (const reading of sorted) {
    const atMs = Date.parse(reading.at);
    if (atMs < fromMs) continue;
    if (reading.value < policy.guard_low_mgdl) return true;
    const upTo = sorted.filter((other) => Date.parse(other.at) <= atMs);
    const then = buildGlucoseForecast({ now: new Date(atMs), readings: upTo, prediction: null });
    if (then.slope_per_min !== null && then.slope_per_min * DOSE_CALCULATOR_POLICY.trend_minutes <= policy.guard_fall_mgdl + 1e-9) return true;
  }
  return false;
}

/**
 * "Korekta: +0,2 j (połowa wyliczenia: glukoza 210 i rośnie, aktywna insulina 0,3 j)" (0 g);
 * "+0,2 j korekty do przelicznika (glukoza 190, aktywna insulina 0,1 j)" (a meal).
 */
function higherSummaryOf(b: HigherBreakdown, meal: boolean): string {
  const rising = !meal && (b.trend_mgdl ?? 0) >= DOSE_CALCULATOR_POLICY.trend_said_mgdl ? ' i rośnie' : '';
  const iob = b.iob_subtracted_u > 0 ? `, aktywna insulina ${formatUnits(b.iob_subtracted_u)}\u00a0j` : '';
  const extra = `+${formatUnits(b.extra_u)}\u00a0j`;
  return meal
    ? `${extra} korekty do przelicznika (glukoza ${b.glucose_mgdl}${iob})`
    : `Korekta: ${extra} (połowa wyliczenia: glukoza ${b.glucose_mgdl}${rising}${iob})`;
}

/** "0,5 × ((210 + 12 − 100) / 100 − IOB 0,3 j) = 0,46 j → 0,4 j" (and the carbs / ICR before it for a meal). */
function higherFormulaOf(b: HigherBreakdown, meal: boolean, carbs: number, icr: number | null, higher: number): string {
  const trend = b.trend_mgdl !== null && b.trend_mgdl !== 0 ? ` ${b.trend_mgdl > 0 ? '+' : '−'} ${Math.abs(b.trend_mgdl)}` : '';
  const iob = b.iob_subtracted_u > 0 ? ` − IOB ${formatUnits(b.iob_subtracted_u)} j` : '';
  const half = `${formatNumber(b.fraction)} × ((${b.glucose_mgdl}${trend} − ${b.target_mgdl}) / ${formatNumber(b.isf_mgdl_per_u)}${iob}) = ${formatUnits(b.half_u)} j`;
  const cap = b.capped ? `, najwyżej ${formatUnits(b.cap_u)} j` : '';
  const correction = `${half}${cap} → ${formatUnits(b.extra_u)} j`;
  if (!meal) return `Korekta: ${correction}`;
  const base = icr ? `${carbs} g / ICR ${formatNumber(icr)} = ${formatUnits(b.base_u)} j` : `${formatUnits(b.base_u)} j`;
  return `${base}; korekta: ${correction}; razem ${formatUnits(higher)} j`;
}

/**
 * Where the danger reference comes from, for a warning: the drop's dose, the calculator spelled out, or carbs / ICR plus
 * the correction above IOB when COB would have raised it (M5).
 */
export function referenceWhy(calculation: DoseCalculation, withForecast = false): string {
  const reference = calculation.reference_u ?? 0;
  if (calculation.drop && Math.abs(calculation.drop.dose_u - reference) < 1e-9 && (calculation.calculator_u === null || calculation.drop.dose_u <= calculation.calculator_u)) {
    return `dawka obniżona na spadek glukozy: ${formatUnits(reference)} j${withForecast ? ` (prognoza ok. ${calculation.drop.forecast_low_mgdl} mg/dL)` : ''}`;
  }
  const b = calculation.breakdown;
  if (calculation.reference_capped && b) {
    const net = round2(Math.max(0, b.correction_u - b.iob_subtracted_u));
    const base = calculation.icr_dose_u ?? 0;
    const parts = [`${calculation.carbs_g > 0 && calculation.icr_g_per_u ? `${calculation.carbs_g} g / ICR ${formatNumber(calculation.icr_g_per_u)} = ` : ''}${formatUnits(base)} j`];
    if (net > 0) parts.push(`korekta ponad IOB ${formatUnits(net)} j`);
    return `przelicznik ${parts.join(' + ')}; COB ${b.cob_g} g nie podnosi tej granicy`;
  }
  if (calculation.limited_by === 'FORECAST' && calculation.forecast_nudge && Math.abs(calculation.default_u - reference) < 1e-9) {
    return `kalkulator pętli z prognozą pętli: ${formatUnits(reference)} j`;
  }
  const formula = calculatorFormula(calculation);
  return formula ? `kalkulator pętli: ${formula}` : `kalkulator pętli: ${formatUnits(reference)} j`;
}

/**
 * What a dose is held against for "above the calculator": the reference, or the opt-in higher dose when it is above it
 * (dose-calculator.v2: choosing it is not dangerous by itself). Null when nothing could be computed.
 */
export function dangerReferenceU(calculation: DoseCalculation | null): number | null {
  if (!calculation) return null;
  const higher = typeof calculation.higher_u === 'number' && Number.isFinite(calculation.higher_u) ? calculation.higher_u : null;
  if (calculation.reference_u === null) return higher;
  return higher !== null && higher > calculation.reference_u ? higher : calculation.reference_u;
}

/** The dose is dangerously above the formula: by at least max(0.5 U, 25% of the formula). */
export function doseExceedsFormula(doseU: number, referenceU: number | null): boolean {
  if (referenceU === null || !Number.isFinite(doseU) || !(doseU > 0)) return false;
  const policy = DOSE_CALCULATOR_POLICY;
  return doseU - referenceU >= Math.max(policy.danger_min_u, policy.danger_ratio * Math.max(0, referenceU)) - 1e-6;
}

/** "30 g / ICR 15 + (95 − 100) / 120 + COB 10 g / 15 − IOB 1,1 j = 1,2 j": the calculator spelled out. */
export function calculatorFormula(calculation: DoseCalculation): string | null {
  const b = calculation.breakdown;
  if (!b || calculation.calculator_u === null) return null;
  const parts: string[] = [];
  const icr = calculation.icr_g_per_u;
  if (calculation.carbs_g > 0 && icr) parts.push(`${calculation.carbs_g} g / ICR ${formatNumber(icr)}`);
  else if (b.iob_u === null && b.carbs_u > 0) parts.push(`${formatUnits(b.carbs_u)} j`);
  if (b.cob_g > 0 && icr) parts.push(`COB ${b.cob_g} g / ${formatNumber(icr)}`);
  const trend = b.trend_mgdl !== 0 ? ` ${b.trend_mgdl > 0 ? '+' : '−'} ${Math.abs(b.trend_mgdl)}` : '';
  parts.push(`(${b.glucose_mgdl}${trend} − ${b.target_mgdl}) / ${formatNumber(b.isf_mgdl_per_u)}`);
  const sum = parts.join(' + ').replace(/\+ \(/g, '+ (');
  const iob = b.iob_subtracted_u > 0 ? ` − IOB ${formatUnits(b.iob_subtracted_u)} j` : '';
  return `${sum}${iob} = ${formatUnits(calculation.calculator_u)} j`;
}

/**
 * The warning for a dose dangerously above the calculator (null when it is not): what the caregiver acknowledges
 * when the dose is sent, with the formula spelled out.
 */
export function doseAboveCalculatorWarning(insulinU: number, calculation: DoseCalculation | null, recent: RecentInsulin | null = null): { code: 'DOSE_ABOVE_CALCULATOR'; key: string; message: string; severity: 'DANGER' } | null {
  if (!calculation || calculation.carbs_first) return null;
  // dose-calculator.v2: the opt-in higher dose is a source of its own (as carbs / ICR is for a lowered default).
  const reference = dangerReferenceU(calculation);
  if (!doseExceedsFormula(insulinU, reference)) return null;
  const higherIsReference = typeof calculation.higher_u === 'number' && reference === calculation.higher_u && reference !== calculation.reference_u;
  const why = higherIsReference ? `dawka z połową korekty: ${formatUnits(reference!)} j` : referenceWhy(calculation, true);
  const recentLine = recent && recent.total_u >= DOSE_CALCULATOR_POLICY.recent_insulin_min_u ? ` W ostatnich ${recent.window_minutes} min podano ${recentInsulinText(recent)}.` : '';
  return {
    code: 'DOSE_ABOVE_CALCULATOR',
    key: `DOSE_ABOVE_CALCULATOR:${insulinU}:${reference}`,
    severity: 'DANGER',
    message: `${formatUnits(insulinU)} j to o ${formatUnits(round2(insulinU - reference!))} j więcej, niż wychodzi z danych (${why}).${recentLine} Większa dawka grozi niedocukrzeniem.`,
  };
}

/** Insulin given in the recent-insulin window: manual boluses, SMBs and a remote bolus not in Nightscout yet. */
export interface RecentInsulin {
  window_minutes: number;
  total_u: number;
  manual_u: number;
  smb_u: number;
  remote_u: number;
  newest_at: string | null;
  /**
   * Nightscout's boluses around the window (its start minus 10 min to now), for matching remote boluses that already
   * reached Nightscout (L3); absent on rows from before.
   */
  boluses?: Array<{ at: string; units: number }>;
  /** Nightscout's SMBs of the window (dose-calculator.v2's opt-in gate); absent on rows from before. */
  smbs?: Array<{ at: string; units: number }>;
}

/** The window for a dose: DIA / 3 within 90–120 min (120 without DIA). */
export function recentInsulinWindowMinutes(diaHours: number | null | undefined): number {
  const policy = DOSE_CALCULATOR_POLICY;
  if (typeof diaHours !== 'number' || !Number.isFinite(diaHours) || diaHours <= 0) return policy.recent_insulin_default_minutes;
  return Math.min(policy.recent_insulin_max_minutes, Math.max(policy.recent_insulin_min_minutes, Math.round((diaHours * 60) / 3)));
}

export function recentInsulinFrom(input: {
  now: Date;
  window_minutes: number;
  boluses: Array<{ at: string; units: number }> | null | undefined;
  smbs: Array<{ at: string; units: number }> | null | undefined;
}): RecentInsulin | null {
  if (!input.boluses && !input.smbs) return null;
  const nowMs = input.now.getTime();
  const fromMs = nowMs - input.window_minutes * 60_000;
  const within = (entry: { at: string; units: number }) => {
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && at >= fromMs && at <= nowMs + 60_000 && Number.isFinite(entry.units) && entry.units > 0;
  };
  const manual = (input.boluses ?? []).filter(within);
  const smbs = (input.smbs ?? []).filter(within);
  const newest = [...manual, ...smbs].map((entry) => entry.at).sort().at(-1) ?? null;
  const manualU = round2(manual.reduce((sum, entry) => sum + entry.units, 0));
  const smbU = round2(smbs.reduce((sum, entry) => sum + entry.units, 0));
  const matchFromMs = fromMs - 10 * 60_000;
  const boluses = (input.boluses ?? [])
    .filter((entry) => {
      const at = Date.parse(entry.at);
      return Number.isFinite(at) && at >= matchFromMs && at <= nowMs + 60_000 && Number.isFinite(entry.units) && entry.units > 0;
    })
    .map((entry) => ({ at: entry.at, units: entry.units }));
  return { window_minutes: input.window_minutes, total_u: round2(manualU + smbU), manual_u: manualU, smb_u: smbU, remote_u: 0, newest_at: newest, boluses, smbs: smbs.map((entry) => ({ at: entry.at, units: entry.units })) };
}

/** "1,6 j (bolusy 1,2 j, SMB 0,4 j)" */
export function recentInsulinText(recent: RecentInsulin): string {
  const parts: string[] = [];
  if (recent.manual_u > 0) parts.push(`bolusy ${formatUnits(recent.manual_u)} j`);
  if (recent.smb_u > 0) parts.push(`SMB ${formatUnits(recent.smb_u)} j`);
  if (recent.remote_u > 0) parts.push(`zdalny ${formatUnits(recent.remote_u)} j jeszcze bez Nightscout`);
  return `${formatUnits(recent.total_u)} j${parts.length > 1 ? ` (${parts.join(', ')})` : parts.length === 1 && recent.smb_u > 0 && recent.manual_u === 0 ? ' (SMB)' : ''}`;
}

/**
 * A second dose while much insulin was given recently (change 4): only when the calculator could not count it (no
 * fresh IOB) or the dose is still above the calculator; a dose the calculator already flags says it in that warning.
 */
export function recentInsulinWarning(insulinU: number, calculation: DoseCalculation | null, recent: RecentInsulin | null): { code: 'RECENT_INSULIN'; key: string; message: string; severity: 'DANGER' } | null {
  if (!(insulinU > 0) || !recent || recent.total_u < DOSE_CALCULATOR_POLICY.recent_insulin_min_u) return null;
  if (calculation?.carbs_first || doseAboveCalculatorWarning(insulinU, calculation, recent)) return null;
  const blind = !calculation || !calculation.calculated;
  const above = calculation?.reference_u !== null && calculation?.reference_u !== undefined && insulinU > calculation.reference_u + 0.05 + 1e-9;
  if (!blind && !above) return null;
  const why = blind
    ? `${calculation?.fallback_reason ? `${capitalized(calculation.fallback_reason)}, więc` : 'Bez aktualnego IOB'} dawki nie da się sprawdzić z insuliną aktywną`
    : `Dawka jest większa niż z kalkulatora pętli (${formatUnits(calculation!.reference_u!)} j)`;
  return {
    code: 'RECENT_INSULIN',
    key: `RECENT_INSULIN:${recent.newest_at ?? 'none'}:${recent.total_u}`,
    severity: 'DANGER',
    message: `W ostatnich ${recent.window_minutes} min podano ${recentInsulinText(recent)}. ${why}: sprawdź, czy ta dawka nie powtarza już podanej.`,
  };
}

/** Insulin while carbs should come first (change 2): sent only after a separate, explicit confirmation. */
export function insulinWhileLowWarning(insulinU: number, calculation: DoseCalculation | null): { code: 'INSULIN_WHILE_LOW'; key: string; message: string; severity: 'DANGER' } | null {
  if (!(insulinU > 0) || !calculation?.carbs_first) return null;
  const first = calculation.carbs_first;
  return lowWarning(insulinU, first.level, first.glucose_mgdl);
}

function lowWarning(insulinU: number, level: CarbsFirstLevel, glucoseMgdl: number): { code: 'INSULIN_WHILE_LOW'; key: string; message: string; severity: 'DANGER' } {
  const what = level === 'PREDICTED_LOW'
    ? 'Za chwilę niedocukrzenie'
    : level === 'STALE_LOW'
      ? `Ostatni odczyt glukozy ${glucoseMgdl} mg/dL jest niski i nieaktualny`
      : `Glukoza ${glucoseMgdl} mg/dL`;
  return {
    code: 'INSULIN_WHILE_LOW',
    key: `INSULIN_WHILE_LOW:${level}:${glucoseMgdl}`,
    severity: 'DANGER',
    message: `${what}: najpierw węglowodany. Insulina teraz (${formatUnits(insulinU)} j) pogłębi niedocukrzenie; podaj ją tylko, jeśli na pewno tego chcesz.`,
  };
}

/**
 * The below-70 gate from the command's own glucose (the dashboard's newest reading), independent of the calculator
 * (M4): it holds when the calculator threw or did not see the reading. Fresh (≤ 15 min): BELOW_70; older, up to
 * stale_low_max_minutes: STALE_LOW. Null at or above 70, without a reading, or older than that.
 */
export function lowGlucoseGate(glucose: { value: number; observed_at: string } | null | undefined, now: Date): { level: 'BELOW_70' | 'STALE_LOW'; glucose_mgdl: number } | null {
  const policy = DOSE_CALCULATOR_POLICY;
  if (!glucose || !Number.isFinite(glucose.value) || glucose.value >= policy.carbs_first_below_mgdl) return null;
  const ageMinutes = (now.getTime() - Date.parse(glucose.observed_at)) / 60_000;
  if (!Number.isFinite(ageMinutes) || ageMinutes > policy.stale_low_max_minutes) return null;
  return { level: ageMinutes <= 15 ? 'BELOW_70' : 'STALE_LOW', glucose_mgdl: Math.round(glucose.value) };
}

export type CalculatorUnavailableWarning = { code: 'CALCULATOR_UNAVAILABLE' | 'SAME_MEAL_CHECK_UNAVAILABLE'; key: string; message: string; severity: 'DANGER' };

/** The calculator threw (M4): the dose was not checked, so the caregiver acknowledges checking it by hand. */
export function calculatorUnavailableWarning(): CalculatorUnavailableWarning & { code: 'CALCULATOR_UNAVAILABLE' } {
  return { code: 'CALCULATOR_UNAVAILABLE', key: 'CALCULATOR_UNAVAILABLE', severity: 'DANGER', message: 'Kalkulator dawki niedostępny — sprawdź dawkę ręcznie.' };
}

/**
 * computeDoseCalculation that never fails its caller, but never silently either (M4): an exception is logged (ids
 * and the error class only, no health data) and reported as `failed`, so the caller adds calculatorUnavailableWarning.
 */
export function safeDoseCalculation(input: DoseCalculatorInput, log: { where: string; patient_id?: string | null; id?: string | null }): { calculation: DoseCalculation | null; failed: boolean } {
  try {
    return { calculation: computeDoseCalculation(input), failed: false };
  } catch (error) {
    logCalculatorFailure(log, error);
    return { calculation: null, failed: true };
  }
}

/** One log line for a failed safety computation: where, ids and the error class (no health data). */
export function logCalculatorFailure(log: { where: string; patient_id?: string | null; id?: string | null }, error: unknown): void {
  console.warn(JSON.stringify({
    event: 'dose_safety_check_failed',
    where: log.where,
    patient_id: log.patient_id ?? null,
    id: log.id ?? null,
    error_class: error instanceof Error ? error.name : typeof error,
  }));
}

function loopSignalOf(view: GlucoseForecast, data: MealForecastData, names: ReturnType<typeof loopSystemNames>): DoseCalculation['loop_signal'] {
  const target = targetMgdl(view, data);
  const insulinReq = view.insulin_req_u;
  const eventual = view.eventual_mgdl !== null ? mgdl(view.eventual_mgdl, null) : null;
  const lowReq = insulinReq !== null && insulinReq < 0;
  const lowEventual = eventual !== null && eventual < target;
  if (!lowReq && !lowEventual) return null;
  return { system_name: names.nominative, insulin_req_u: insulinReq, eventual_mgdl: eventual === null ? null : Math.round(eventual), target_mgdl: target };
}

function summaryOf(calculation: Omit<DoseCalculation, 'summary'>, laterPart: boolean): string {
  const icrDose = calculation.icr_dose_u;
  const fromWhat = laterPart ? 'z planu' : 'z przelicznika';
  const b = calculation.breakdown;
  if (calculation.carbs_first) {
    const first = calculation.carbs_first;
    const what = first.level === 'PREDICTED_LOW'
      ? `glukoza ${first.glucose_mgdl} mg/dL i zaraz spadnie poniżej 70`
      : first.level === 'STALE_LOW'
        ? `ostatni odczyt niski i nieaktualny (${first.glucose_mgdl} mg/dL sprzed ${first.reading_age_minutes ?? '?'} min)`
        : `glukoza ${first.glucose_mgdl} mg/dL`;
    return `Najpierw węglowodany: ${what}, insulina 0 j${icrDose ? ` (${fromWhat} ${formatUnits(icrDose)} j)` : ''}.`;
  }
  if (icrDose === null) {
    if (!b || calculation.calculator_u === null) return calculation.fallback_reason ? `Kalkulator pętli niedostępny: ${calculation.fallback_reason}.` : '';
    return `Kalkulator pętli: ${formatUnits(calculation.calculator_u)} j (${dataWords(b)}).`;
  }
  const signal = calculation.loop_signal ? ` · ${loopSignalWords(calculation.loop_signal)}` : '';
  if (calculation.limited_by === 'DROP' && calculation.drop) {
    return `Mniej na spadek: ${formatUnits(calculation.default_u)} j zamiast ${formatUnits(icrDose)} j ${fromWhat} — prognoza ok. ${calculation.drop.forecast_low_mgdl} mg/dL (cel ${calculation.drop.target_mgdl})${signal}.`;
  }
  if (calculation.limited_by === 'CALCULATOR' && b) {
    return `Kalkulator pętli: ${formatUnits(calculation.default_u)} j zamiast ${formatUnits(icrDose)} j ${fromWhat} — ${dataWords(b)}${signal}.`;
  }
  if (calculation.limited_by === 'FORECAST' && b && calculation.forecast_nudge) {
    const nudge = calculation.forecast_nudge;
    return `${formatUnits(calculation.default_u)} j zamiast ${formatUnits(icrDose)} j ${fromWhat}: połowa drogi od kalkulatora pętli (${formatUnits(nudge.v1_u)} j — ${dataWords(b)}) do ${formatUnits(nudge.d2_u)} j, przy której prognoza pętli z tą dawką nie schodzi poniżej ${nudge.floor_mgdl} mg/dL${signal}.`;
  }
  if (!b || calculation.calculator_u === null) {
    return `${capitalized(fromWhat)} ${formatUnits(icrDose)} j · kalkulator pętli niedostępny: ${calculation.fallback_reason ?? 'brak danych'}.`;
  }
  return `${capitalized(fromWhat)} ${formatUnits(icrDose)} j · kalkulator pętli ${formatUnits(calculation.calculator_u)} j (${dataWords(b)})${signal}.`;
}

/** The one main reason the default is below carbs / ICR (the line under the dose; owner 2026-10-29). */
export type DoseLoweredReason = 'ACTIVE_INSULIN' | 'FALLING' | 'BELOW_TARGET' | 'LOW_CARBS_FIRST' | 'LOOP_FORECAST_LOW';

const LOWERED_REASON_WORDS: Record<Exclude<DoseLoweredReason, 'LOOP_FORECAST_LOW'>, string> = {
  ACTIVE_INSULIN: 'aktywna insulina',
  FALLING: 'glukoza spada',
  BELOW_TARGET: 'glukoza poniżej celu',
  LOW_CARBS_FIRST: 'niska glukoza — najpierw węglowodany',
};

/**
 * Why the default is lower than carbs / ICR, one reason: carbs first; the drop (falling glucose, else the loop's
 * forecast below target); for the calculator its largest lowering term (IOB, or the negative correction: its trend
 * part → falling, its level part → below target). Null when the dose is not lowered.
 */
function loweredReasonOf(calculation: Omit<DoseCalculation, 'summary' | 'short_summary' | 'formula' | 'reason_code' | 'lowered_by_u'>): DoseLoweredReason | null {
  const icrDose = calculation.icr_dose_u;
  if (icrDose === null || !(calculation.default_u < icrDose - 1e-9)) return null;
  if (calculation.carbs_first) return 'LOW_CARBS_FIRST';
  const b = calculation.breakdown;
  const said = DOSE_CALCULATOR_POLICY.trend_said_mgdl;
  if (calculation.limited_by === 'DROP') return b && b.trend_mgdl <= -said ? 'FALLING' : 'LOOP_FORECAST_LOW';
  if (!b) return null;
  const trendU = -b.trend_mgdl / b.isf_mgdl_per_u;
  const levelU = -(b.glucose_mgdl - b.target_mgdl) / b.isf_mgdl_per_u;
  const candidates: Array<[DoseLoweredReason, number]> = [['ACTIVE_INSULIN', b.iob_subtracted_u], ['FALLING', trendU], ['BELOW_TARGET', levelU]];
  return candidates.sort((left, right) => right[1] - left[1])[0][0];
}

/**
 * The line under the dose: only how much and why the dose differs from carbs / ICR, never values the screen already
 * shows (owner 2026-10-29: IOB and glucose are visible elsewhere): "↓ 0,3 j mniej niż z przelicznika (3,85 j): aktywna
 * insulina". Not lowered: "Z przelicznika" (grey in the app). The breakdown (IOB, glucose, trend, target, COB, the
 * formula) is `summary` and `formula`, behind the app's info button.
 */
function shortSummaryOf(calculation: Omit<DoseCalculation, 'short_summary' | 'formula'>, laterPart: boolean, loopName: string): string {
  const icrDose = calculation.icr_dose_u;
  const from = laterPart ? 'z planu' : 'z przelicznika';
  if (icrDose === null) {
    return calculation.calculator_u !== null ? `Kalkulator: ${formatUnits(calculation.calculator_u)} j` : 'Kalkulator niedostępny';
  }
  const reason = calculation.reason_code;
  const lowered = calculation.lowered_by_u ?? 0;
  if (reason && lowered > 0) {
    const words = reason === 'LOOP_FORECAST_LOW' ? `${loopName}: prognoza poniżej celu` : LOWERED_REASON_WORDS[reason];
    // Taken down to nothing: "0 j zamiast 1,6 j z planu: …" reads better than "1,6 j mniej".
    // Non-breaking spaces: "(5,15\u00a0j)" never splits across lines.
    if (calculation.default_u <= 0) return `0\u00a0j zamiast ${formatUnits(icrDose)}\u00a0j ${from}: ${words}`;
    // v3: the forecast nudge keeps its reason, said briefly so the line fits under the dose (details behind ⓘ).
    if (calculation.limited_by === 'FORECAST') {
      const brief = reason === 'ACTIVE_INSULIN' ? 'IOB' : reason === 'FALLING' ? 'spadek' : reason === 'BELOW_TARGET' ? 'glukoza pod celem' : words;
      return `↓ ${formatUnits(lowered)}\u00a0j mniej niż ${from} (${formatUnits(icrDose)}\u00a0j): ${brief} i prognoza pętli`;
    }
    return `↓ ${formatUnits(lowered)}\u00a0j mniej niż ${from} (${formatUnits(icrDose)}\u00a0j): ${words}`;
  }
  const base = laterPart ? 'Z planu' : 'Z przelicznika';
  return calculation.breakdown ? base : `${base} — kalkulator niedostępny`;
}

/** "IOB 1,1 j, glukoza 95 i spada" */
function dataWords(b: DoseCalculatorBreakdown): string {
  const words: string[] = [];
  if (b.iob_u !== null) words.push(`IOB ${formatUnits(b.iob_subtracted_u)} j`);
  if (b.cob_g > 0) words.push(`COB ${b.cob_g} g`);
  const said = DOSE_CALCULATOR_POLICY.trend_said_mgdl;
  const trend = b.trend_mgdl <= -said ? ' i spada' : b.trend_mgdl >= said ? ' i rośnie' : '';
  words.push(`glukoza ${b.glucose_mgdl}${trend}`);
  return words.join(', ');
}

function loopSignalWords(signal: NonNullable<DoseCalculation['loop_signal']>): string {
  const name = capitalized(signal.system_name);
  if (signal.insulin_req_u !== null && signal.insulin_req_u < 0) return `${name}: insulinReq ${formatUnits(signal.insulin_req_u).replace('-', '−')} j`;
  return `${name}: prognoza ${signal.eventual_mgdl} mg/dL, poniżej celu ${signal.target_mgdl}`;
}

/**
 * The target the correction aims at: the loop's current one (temporary targets included), else the middle of the
 * profile's range (target_low alone without target_high). Clamped to 80–250; a value outside 40–400 is skipped.
 */
function targetMgdl(view: GlucoseForecast, data: MealForecastData): number {
  const policy = DOSE_CALCULATOR_POLICY;
  const low = mgdl(data.profile_target, data.profile_units);
  const high = mgdl(data.profile_target_high ?? null, data.profile_units);
  const profile = low !== null && high !== null && high >= low && high <= policy.absurd_target_above_mgdl ? (low + high) / 2 : low;
  const target = [mgdl(view.loop?.target_mgdl ?? null, null), profile]
    .find((value) => value !== null && value >= policy.absurd_target_below_mgdl && value <= policy.absurd_target_above_mgdl);
  if (target === undefined || target === null) return policy.default_target_mgdl;
  return Math.round(Math.min(policy.max_target_mgdl, Math.max(policy.min_target_mgdl, target)));
}

function mgdl(value: number | null, units: string | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return /mmol/i.test(units ?? '') || value < DOSE_CALCULATOR_POLICY.mmol_below ? Math.round(value * 18) : value;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

function formatNumber(value: number): string {
  return String(Math.round(value * 10) / 10).replace('.', ',');
}

export type DoseSafetyWarning = { code: 'DOSE_ABOVE_CALCULATOR' | 'RECENT_INSULIN' | 'INSULIN_WHILE_LOW' | 'CALCULATOR_UNAVAILABLE'; key: string; message: string; severity: 'DANGER' };

/**
 * The live dose checks of a command with insulin (preview and authorization): insulin while carbs come first, a dose
 * dangerously above the calculator, recent insulin the calculator could not count. `calculator_checks` false: only
 * the low check (a pre-bolus, whose carbs come later, is not held against a calculator without them).
 */
export function doseSafetyWarnings(input: {
  insulin_u: number;
  calculation: DoseCalculation | null;
  recent: RecentInsulin | null;
  calculator_checks?: boolean;
  /** The command's own newest reading: the below-70 gate holds without the calculator (M4). */
  glucose?: { value: number; observed_at: string } | null;
  now?: Date;
  /** The calculator threw: CALCULATOR_UNAVAILABLE (acknowledged) instead of its checks. */
  calculator_failed?: boolean;
}): DoseSafetyWarning[] {
  const warnings: DoseSafetyWarning[] = [];
  if (!(input.insulin_u > 0)) return warnings;
  const low = insulinWhileLowWarning(input.insulin_u, input.calculation);
  if (low) return [low];
  const gate = input.now ? lowGlucoseGate(input.glucose, input.now) : null;
  if (gate) return [lowWarning(input.insulin_u, gate.level, gate.glucose_mgdl)];
  if (input.calculator_failed) warnings.push(calculatorUnavailableWarning());
  if (input.calculator_checks === false) return warnings;
  const above = doseAboveCalculatorWarning(input.insulin_u, input.calculation, input.recent);
  if (above) warnings.push(above);
  const recent = recentInsulinWarning(input.insulin_u, input.calculation, input.recent);
  if (recent) warnings.push(recent);
  return warnings;
}

/** The recent insulin with a remote bolus Nightscout does not show yet (it may have been given). */
export function withRemoteBolus(recent: RecentInsulin | null, remote: { at: string; units: number } | null, now: Date, nightscoutBoluses: Array<{ at: string; units: number }> = []): RecentInsulin | null {
  return withRemoteBoluses(recent, remote ? [remote] : [], now, nightscoutBoluses);
}

/**
 * The recent insulin with every remote bolus of the window Nightscout does not show yet (L3: not only the newest, and
 * for the whole window). Each Nightscout bolus (the window's, Nightscout's list on `recent`, and the ones passed)
 * matches at most one remote bolus: the same units (±0,05 j) within 5 min.
 */
export function withRemoteBoluses(recent: RecentInsulin | null, remotes: Array<{ at: string; units: number }>, now: Date, nightscoutBoluses: Array<{ at: string; units: number }> = []): RecentInsulin | null {
  const window = recent?.window_minutes ?? DOSE_CALCULATOR_POLICY.recent_insulin_default_minutes;
  const nowMs = now.getTime();
  const seen = new Set<string>();
  const nightscout = [...(recent?.boluses ?? []), ...nightscoutBoluses]
    .filter((bolus) => {
      const id = `${Date.parse(bolus.at)}:${bolus.units}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((bolus) => ({ atMs: Date.parse(bolus.at), units: bolus.units, used: false }));
  let result = recent;
  for (const remote of [...remotes].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))) {
    if (!(remote.units > 0)) continue;
    const atMs = Date.parse(remote.at);
    if (!Number.isFinite(atMs) || nowMs - atMs > window * 60_000 || atMs > nowMs + 60_000) continue;
    // The same bolus already in Nightscout is counted there (each Nightscout bolus once).
    const match = nightscout.find((bolus) => !bolus.used && Math.abs(bolus.units - remote.units) <= 0.051 && Math.abs(bolus.atMs - atMs) <= 5 * 60_000);
    if (match) {
      match.used = true;
      continue;
    }
    const base: RecentInsulin = result ?? { window_minutes: window, total_u: 0, manual_u: 0, smb_u: 0, remote_u: 0, newest_at: null };
    result = { ...base, remote_u: round2(base.remote_u + remote.units), total_u: round2(base.total_u + remote.units), newest_at: [base.newest_at, remote.at].filter((at): at is string => at !== null).sort().at(-1) ?? remote.at };
  }
  return result;
}
