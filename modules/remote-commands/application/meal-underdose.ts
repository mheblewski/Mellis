/**
 * meal-underdose.v1 (2026-11-10): a meal given clearly less insulin than carbs / ICR, with glucose climbing
 * fast and nothing planned for the rest. Backtest: 8 times in 30 days, and every
 * time the caregiver later topped up by hand; in half of them the rule comes 4–20 min before the top-up.
 */
/**
 * MEAL_UNDERDOSE_ENABLED: the push runs only where it is switched on. Off by default (owner 2026-11-10): tried on one
 * family's data only, so it stays with that family until its pushes have been counted against the doses given after.
 */
export function isMealUnderdoseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.MEAL_UNDERDOSE_ENABLED ?? '').trim());
}

export const MEAL_UNDERDOSE_POLICY = {
  /** Given below this share of carbs / ICR. */
  max_given_share: 0.8,
  /** And at least this much insulin missing. */
  min_short_u: 0.4,
  min_minutes: 30,
  max_minutes: 120,
  min_glucose_mgdl: 180,
  min_rise_mgdl: 40,
  /** mg/dl per minute over the last 15 min. */
  min_slope_mgdl_min: 1.5,
  /** The meal's own dose: manual boluses this close to the meal start. */
  dose_window_before_min: 20,
  dose_window_after_min: 15,
  /** A reading this old still counts as "now" / "15 min ago". */
  reading_tolerance_min: 7,
} as const;

export interface MealUnderdoseInput {
  meal_started_at: string;
  meal_carbs_g: number | null;
  icr_g_per_u: number | null;
  /** Manual (not loop SMB) boluses from 20 min before the meal up to now. */
  boluses: Array<{ started_at: string; units: number }>;
  /** Insulin the calculator held back on purpose (calculatorHeldBackU): a decision, never a shortfall. */
  held_back_u?: number;
  /** A planned later part or a SECOND_DOSE reminder for this meal: the rest is already taken care of. */
  rest_planned: boolean;
  /** Glucose readings around the meal (any order). */
  readings: Array<{ at: string; mgdl: number }>;
  now: Date;
}

export interface MealUnderdose {
  given_u: number;
  icr_dose_u: number;
  short_u: number;
  glucose_mgdl: number;
  start_mgdl: number;
  slope_mgdl_min: number;
  minutes_after: number;
}

function readingAt(readings: Array<{ at: number; mgdl: number }>, atMs: number, toleranceMs: number): number | null {
  let best: { at: number; mgdl: number } | null = null;
  for (const reading of readings) {
    const distance = Math.abs(reading.at - atMs);
    if (distance <= toleranceMs && (!best || distance < Math.abs(best.at - atMs))) best = reading;
  }
  return best ? best.mgdl : null;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export function detectMealUnderdose(input: MealUnderdoseInput): MealUnderdose | null {
  const policy = MEAL_UNDERDOSE_POLICY;
  if (input.rest_planned) return null;
  if (input.meal_carbs_g === null || !(input.meal_carbs_g > 0) || !input.icr_g_per_u || input.icr_g_per_u <= 0) return null;
  const startMs = Date.parse(input.meal_started_at);
  const nowMs = input.now.getTime();
  if (!Number.isFinite(startMs)) return null;
  const minutes = (nowMs - startMs) / 60_000;
  if (minutes < policy.min_minutes || minutes > policy.max_minutes) return null;

  const minute = 60_000;
  let given = 0;
  for (const bolus of input.boluses) {
    const at = Date.parse(bolus.started_at);
    if (!Number.isFinite(at) || !(bolus.units > 0)) continue;
    if (at >= startMs - policy.dose_window_before_min * minute && at <= startMs + policy.dose_window_after_min * minute) given += bolus.units;
    // Any bolus after the meal's own dose: the caregiver already topped up (4 of 8 backtest cases).
    else if (at > startMs + policy.dose_window_after_min * minute && at <= nowMs) return null;
  }
  // No meal insulin at all is a different situation (carbs only, a deferred dose): not this rule.
  if (!(given > 0)) return null;
  const icrDose = input.meal_carbs_g / input.icr_g_per_u;
  const covered = given + Math.max(0, input.held_back_u ?? 0);
  const short = icrDose - covered;
  if (covered >= policy.max_given_share * icrDose || short < policy.min_short_u) return null;

  const readings = input.readings.map((r) => ({ at: Date.parse(r.at), mgdl: r.mgdl })).filter((r) => Number.isFinite(r.at) && Number.isFinite(r.mgdl));
  const tolerance = policy.reading_tolerance_min * minute;
  const start = readingAt(readings, startMs, tolerance);
  const current = readingAt(readings, nowMs, tolerance);
  const before = readingAt(readings, nowMs - 15 * minute, tolerance);
  if (start === null || current === null || before === null) return null;
  const slope = (current - before) / 15;
  if (current < policy.min_glucose_mgdl || current - start < policy.min_rise_mgdl || slope < policy.min_slope_mgdl_min) return null;
  return {
    given_u: round2(given),
    icr_dose_u: round2(icrDose),
    short_u: round2(short),
    glucose_mgdl: Math.round(current),
    start_mgdl: Math.round(start),
    slope_mgdl_min: Math.round(slope * 10) / 10,
    minutes_after: Math.round(minutes),
  };
}

const units = (value: number) => (Math.round(value * 10) / 10).toFixed(1).replace('.', ',');

/** Push: "Do obiadu podano 1,5 j z 3,2 j. Glukoza 214 i rośnie. Dotknij, aby policzyć resztę." */
export function mealUnderdosePush(args: { meal_name: string | null; found: MealUnderdose; patient_name?: string | null }): { title: string; body: string } {
  const meal = args.meal_name?.trim() ? `Do posiłku „${args.meal_name.trim()}”` : 'Do posiłku';
  return {
    title: args.patient_name ? `${args.patient_name}: dawka mniejsza niż z przelicznika` : 'Dawka mniejsza niż z przelicznika',
    body: `${meal} podano ${units(args.found.given_u)} j z ${units(args.found.icr_dose_u)} j. Glukoza ${args.found.glucose_mgdl} i rośnie. Dotknij, aby policzyć resztę.`,
  };
}
