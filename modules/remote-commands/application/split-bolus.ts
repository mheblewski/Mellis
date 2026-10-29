import { calculatorUnavailableWarning, safeDoseCalculation, type DoseCalculation } from './dose-calculator';
import type { MealForecastData } from './meal-dose-forecast';
import { BOLUS_REMINDER_POLICY, GIVEN_SINCE_OWN_BOLUS_MINUTES, GIVEN_SINCE_WINDOW_HOURS } from './bolus-reminders';
import { deliveredBasalSegments, type InsulinDeliveryEvent } from '@modules/evidence-tools/daily-insulin-totals';
import { formatUnits, roundDownToStep } from './remote-command-policy';
import { GLUCOSE_FORECAST_POLICY } from '@modules/glucose-forecast/application/glucose-forecast';

/**
 * Split meal boluses (the split-bolus plan). A meal high in fat or protein absorbs slowly: its full dose
 * up front can cause an early low and leaves a late rise (Campbell 2016: 130% up front gave lows in 60%; Lopez 2017:
 * children need at least 60% of the dose up front; the chat recommends, the caregiver decides). The chat card then gives part of the meal's CARBS with their
 * insulin now and plans the rest for later. Carbs are split with the insulin because Trio's SMBs would cover carbs
 * entered at once. The second part's dose is recomputed when it is due: the deferred carbs
 * divided by the ICR valid then, minus the insulin the loop added above the scheduled basal since the meal (SMBs and
 * higher temp basals; the oref1 docs: subtract what the loop already gave), never below 0, rounded down.
 */

export const SPLIT_BOLUS_POLICY = {
  version: 'split-bolus.v1',
  /** A part nobody gave this long after it was due (or after its reminder came anyway) expires. */
  expire_after_due_minutes: 120,
  /** The WBT reminder comes at least this long after the second part was given (never two doses within an hour). */
  wbt_min_gap_minutes: 60,
} as const;

/**
 * A deferred meal bolus (deferred-bolus.v1): when glucose is low or falling before a meal,
 * the carbs go to Trio now with no insulin and the dose comes later, once glucose has stopped falling. Its readiness
 * rule (below) is the GLUCOSE_STOPPED_FALLING trigger of a later plan. Sources: Pettus & Edelman 2017 (eat first,
 * insulin once glucose levels off), DirecNet 2008 (bolus when > 80 mg/dL), Danne 2003 (a post-meal bolus is safe in
 * children).
 */
export const DEFERRED_BOLUS_POLICY = {
  version: 'deferred-bolus.v1',
  /** The reminder is checked from this long after the meal start. */
  min_wait_minutes: 15,
  /** Ready: the newest reading (at most this old) at or above this, not falling faster, no low forecast. */
  /** One freshness rule for glucose everywhere (the forecast's). */
  max_reading_age_minutes: GLUCOSE_FORECAST_POLICY.max_reading_age_minutes,
  ready_min_glucose_mgdl: 80,
  /** mg/dL per minute (oref's short average); -1 ≈ "↘" slowing to flat. */
  ready_min_slope_per_min: -1,
  /** The calibrated forecast must stay at or above this within the next 30 min. */
  ready_min_forecast_mgdl: 80,
  /** Not ready this long after the meal start: the reminder comes anyway, telling to check glucose first. */
  force_after_minutes: 60,
} as const;

/**
 * Later parts the caregiver plans on a chat card (later-plan.v1: the agent prepares exactly
 * the plan the caregiver asks for). The card gives its carbs and insulin now; the later part either sends more carbs
 * with their dose (SPLIT) or only insulin for carbs already sent (DEFERRED_INSULIN). Its reminder comes after a time or
 * when glucose has stopped falling, starts rising or goes above a threshold; a glucose condition that is not met within
 * the waiting time reminds anyway, saying so. The dose is computed when it is due: the carbs it is for (minus the grams
 * that covered a drop, when asked) / ICR then, minus the loop's extra insulin since the meal, minus the insulin the card
 * already gave for the same carbs; or a fixed dose the caregiver named.
 */
export const LATER_PLAN_POLICY = {
  version: 'later-plan.v1',
  max_after_minutes: 1440,
  /** Glucose triggers are checked from this long after the meal unless the plan says otherwise. */
  default_glucose_check_after_minutes: 15,
  /** GLUCOSE_RISING works as the Bolus tab's "Przypomnij": checked at once, watched for an hour,
   *  and when glucose never rose it lapses quietly (no push). */
  default_rising_check_after_minutes: 0,
  default_rising_wait_minutes: BOLUS_REMINDER_POLICY.rising_wait_minutes,
  /** How long a glucose condition is waited for before the reminder comes anyway. */
  default_wait_minutes: 180,
  min_wait_minutes: 15,
  max_wait_minutes: 1440,
  /** Rising on the card's chart: mg/dL per minute over the last ~15 min (≈ +2.5 per 5 min). The reminder itself takes
   *  the Bolus tab's rule (bolus-reminders.ts glucoseRisingForSecondDose). */
  rising_min_slope_per_min: 0.5,
  min_threshold_mgdl: 70,
  max_threshold_mgdl: 400,
} as const;

export type SplitPlanKind = 'SPLIT' | 'DEFERRED_INSULIN';
export type LaterTrigger = 'AFTER_MINUTES' | 'GLUCOSE_STOPPED_FALLING' | 'GLUCOSE_RISING' | 'GLUCOSE_ABOVE';
const LATER_TRIGGERS: LaterTrigger[] = ['AFTER_MINUTES', 'GLUCOSE_STOPPED_FALLING', 'GLUCOSE_RISING', 'GLUCOSE_ABOVE'];

/** The plan stored with a card (bolus_proposals.split) and copied to its first command (remote_commands.split_plan). */
export interface SplitPlan {
  /** SPLIT (absent on older cards): more carbs and their dose later. DEFERRED_INSULIN: only the dose later. */
  kind?: SplitPlanKind;
  policy_version: string;
  now_percent: number;
  later_after_minutes: number;
  total_carbs_g: number;
  total_insulin_u: number;
  /** Carbs and dose given now are the card's own carbs_g and insulin_u. */
  later_carbs_g: number;
  /** The later dose as estimated now (recomputed when due). */
  later_insulin_u: number;
  /** later-plan.v1 (absent on older plans: SPLIT after a time, DEFERRED_INSULIN when glucose stops falling). */
  trigger?: LaterTrigger;
  threshold_mgdl?: number | null;
  /** The carbs the later dose is for; null: the later carbs (SPLIT) or the card's carbs (DEFERRED_INSULIN). */
  dose_carbs_g?: number | null;
  /** A dose the caregiver named for later; null: computed when due. */
  fixed_insulin_u?: number | null;
  /** Grams that covered a drop, taken off the carbs the later dose is for. */
  drop_cover_g?: number | null;
  /** Glucose triggers: how long the condition is waited for before the reminder comes anyway. */
  wait_minutes?: number | null;
  /** This part's dose takes off the card's insulin (decided once in computeLaterPlans; absent on older plans). */
  subtract_card_insulin?: boolean;
  /** Further later parts of the same card (e.g. half the dose in 10 min, the rest of the carbs in 60 min), each with
   * its own reminder; absent: one later part. */
  more_parts?: SplitPlan[];
}

/** Every later part of a stored plan, in order. */
export function planParts(plan: SplitPlan | null): SplitPlan[] {
  if (!plan) return [];
  const { more_parts: more, ...first } = plan;
  return [first, ...(more ?? [])];
}

/**
 * The carbs of a card's whole meal: what its command sent now plus the carbs its later parts will send (owner
 * 2026-10-26: the meal holds the whole meal, so its items match and a change of it reaches the parts still to come).
 */
export function plannedMealCarbs(commandCarbsG: number, plan: SplitPlan | null): number {
  return commandCarbsG + planParts(plan)
    .filter((part) => part.kind !== 'DEFERRED_INSULIN' && part.later_carbs_g > 0)
    .reduce((sum, part) => sum + part.later_carbs_g, 0);
}

/**
 * The whole meal's carbs a card's parts were made for, from the parts themselves (what the first command sent plus the
 * later carbs of its split parts): the baseline of a meal change when the card knew no item macros (audit 2026-10-26:
 * the first carb edit of such a meal used to be its baseline, so it never reached the parts).
 */
export function cardMealCarbs(parts: Array<Pick<PlannedBolusRecord, 'kind' | 'first_carbs_g' | 'carbs_g' | 'meal_change_g'>>): number | null {
  if (parts.length === 0) return null;
  return parts[0].first_carbs_g + parts
    .filter((part) => part.kind !== 'DEFERRED_INSULIN')
    .reduce((sum, part) => sum + Math.max(0, part.carbs_g - (part.meal_change_g ?? 0)), 0);
}

/** At most this many later parts on one card. */
export const MAX_LATER_PARTS = 3;

export interface LaterRequest {
  trigger: LaterTrigger;
  after_minutes: number;
  threshold_mgdl: number | null;
  carbs_g: number;
  dose_carbs_g: number | null;
  insulin_u: number | null;
  subtract_drop_cover: boolean;
  wait_minutes: number | null;
}

/** Validates the model's `later` (null = nothing later). */
export function parseLaterRequest(value: unknown): LaterRequest | { problem: string } | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return { problem: 'later must be an object or null' };
  const raw = value as Record<string, unknown>;
  const policy = LATER_PLAN_POLICY;
  const trigger = raw.trigger as LaterTrigger;
  if (!LATER_TRIGGERS.includes(trigger)) return { problem: `later.trigger must be one of ${LATER_TRIGGERS.join(', ')}` };
  const glucoseTrigger = trigger !== 'AFTER_MINUTES';
  const after = raw.after_minutes === null || raw.after_minutes === undefined
    ? (trigger === 'GLUCOSE_RISING' ? policy.default_rising_check_after_minutes : glucoseTrigger ? policy.default_glucose_check_after_minutes : NaN)
    : Number(raw.after_minutes);
  if (!Number.isInteger(after) || after < 0 || after > policy.max_after_minutes) return { problem: `later.after_minutes must be whole minutes 0-${policy.max_after_minutes} (required for AFTER_MINUTES)` };
  const threshold = raw.threshold_mgdl === null || raw.threshold_mgdl === undefined ? null : Number(raw.threshold_mgdl);
  if (trigger === 'GLUCOSE_ABOVE' && (threshold === null || !Number.isInteger(threshold) || threshold < policy.min_threshold_mgdl || threshold > policy.max_threshold_mgdl)) {
    return { problem: `later.threshold_mgdl must be whole mg/dL ${policy.min_threshold_mgdl}-${policy.max_threshold_mgdl} for GLUCOSE_ABOVE` };
  }
  const carbs = raw.carbs_g === null || raw.carbs_g === undefined ? 0 : Number(raw.carbs_g);
  if (!Number.isInteger(carbs) || carbs < 0 || carbs > 300) return { problem: 'later.carbs_g must be whole grams 0-300' };
  const doseCarbs = raw.dose_carbs_g === null || raw.dose_carbs_g === undefined ? null : Number(raw.dose_carbs_g);
  if (doseCarbs !== null && (!Number.isInteger(doseCarbs) || doseCarbs < 0 || doseCarbs > 300)) return { problem: 'later.dose_carbs_g must be whole grams 0-300 or null' };
  const insulin = raw.insulin_u === null || raw.insulin_u === undefined ? null : Number(raw.insulin_u);
  if (insulin !== null && (!Number.isFinite(insulin) || insulin < 0 || insulin > 30)) return { problem: 'later.insulin_u must be 0-30 units or null' };
  const wait = raw.wait_minutes === null || raw.wait_minutes === undefined ? null : Number(raw.wait_minutes);
  if (wait !== null && (!Number.isInteger(wait) || wait < policy.min_wait_minutes || wait > policy.max_wait_minutes)) return { problem: `later.wait_minutes must be whole minutes ${policy.min_wait_minutes}-${policy.max_wait_minutes} or null` };
  return {
    trigger,
    after_minutes: after,
    threshold_mgdl: trigger === 'GLUCOSE_ABOVE' ? threshold : null,
    carbs_g: carbs,
    dose_carbs_g: doseCarbs,
    insulin_u: insulin,
    subtract_drop_cover: raw.subtract_drop_cover === true,
    wait_minutes: glucoseTrigger ? (wait ?? (trigger === 'GLUCOSE_RISING' ? policy.default_rising_wait_minutes : policy.default_wait_minutes)) : null,
  };
}

/**
 * The plan for a card: what is given now is the card's own carbs and insulin, untouched. The later dose is estimated
 * now the way it will be computed when due (from the ICR now and without the loop's future insulin).
 */
export function computeLaterPlan(args: {
  card_carbs_g: number;
  card_insulin_u: number;
  request: LaterRequest;
  icr_g_per_u: number | null;
  /** Grams of the meal that cover the drop now (meal-dose-forecast); used only with subtract_drop_cover. */
  drop_cover_g: number | null;
  step: number;
  /** This part's dose takes off the card's insulin (computeLaterPlans decides it for one part only). */
  subtract_card_insulin?: boolean;
}): { plan: SplitPlan } | { problem: string } {
  const { request } = args;
  const kind: SplitPlanKind = request.carbs_g > 0 ? 'SPLIT' : 'DEFERRED_INSULIN';
  const doseCarbs = request.dose_carbs_g ?? (kind === 'SPLIT' ? request.carbs_g : args.card_carbs_g);
  if (kind === 'DEFERRED_INSULIN' && args.card_carbs_g <= 0) return { problem: 'a later dose for carbs needs the carbs on this card (carbs_g > 0); for anything else use a reminder' };
  if (kind === 'DEFERRED_INSULIN' && doseCarbs <= 0 && !(request.insulin_u !== null && request.insulin_u > 0)) return { problem: 'later needs carbs_g, dose_carbs_g or insulin_u' };
  const dropCover = request.subtract_drop_cover ? Math.max(0, args.drop_cover_g ?? 0) : null;
  // One part alone: a dose for the card's own carbs takes off the card's insulin.
  const subtractsCard = args.subtract_card_insulin ?? dosesCardCarbs(request, args.card_carbs_g);
  const estimate = request.insulin_u !== null
    ? roundDownToStep(request.insulin_u, args.step)
    : args.icr_g_per_u
      ? roundDownToStep(Math.max(0, (Math.max(0, doseCarbs - (dropCover ?? 0)) / args.icr_g_per_u) - (subtractsCard ? args.card_insulin_u : 0)), args.step)
      : 0;
  // The stored plan holds at most 30 U (migration 060): a larger later dose is refused here, not lost at the insert.
  if (estimate > MAX_LATER_INSULIN_U) return { problem: `the later dose would be ${estimate} U, over ${MAX_LATER_INSULIN_U} U; split it into more parts or ask the caregiver` };
  const totalCarbs = args.card_carbs_g + request.carbs_g;
  return {
    plan: {
      kind,
      policy_version: LATER_PLAN_POLICY.version,
      now_percent: kind === 'SPLIT' ? Math.min(99, Math.max(1, Math.round((args.card_carbs_g / totalCarbs) * 100))) : 100,
      later_after_minutes: request.after_minutes,
      total_carbs_g: totalCarbs,
      total_insulin_u: Math.round((args.card_insulin_u + estimate) * 100) / 100,
      later_carbs_g: request.carbs_g,
      later_insulin_u: estimate,
      trigger: request.trigger,
      threshold_mgdl: request.threshold_mgdl,
      dose_carbs_g: request.dose_carbs_g,
      fixed_insulin_u: request.insulin_u === null ? null : roundDownToStep(request.insulin_u, args.step),
      drop_cover_g: dropCover,
      wait_minutes: request.wait_minutes,
      subtract_card_insulin: subtractsCard,
    },
  };
}

/** planned_boluses.planned_insulin_u's limit (060_deferred_meal_bolus.sql). */
const MAX_LATER_INSULIN_U = 30;

/**
 * A later dose for the card's own carbs: dose_carbs_g absent or the card's grams, and no dose named by the caregiver;
 * or a later part with carbs whose dose_carbs_g also covers carbs of this card (more grams than its own).
 */
function dosesCardCarbs(request: LaterRequest, cardCarbs: number): boolean {
  if (request.insulin_u !== null) return false;
  if (request.carbs_g > 0) return cardCarbsDosed(request, cardCarbs) > 0;
  return request.dose_carbs_g === null || request.dose_carbs_g === cardCarbs;
}

/** Grams of this card's carbs a later dose computes insulin for (0 for a dose named in units). */
function cardCarbsDosed(request: LaterRequest, cardCarbs: number): number {
  if (request.insulin_u !== null) return 0;
  if (request.carbs_g > 0) return Math.max(0, (request.dose_carbs_g ?? request.carbs_g) - request.carbs_g);
  return request.dose_carbs_g ?? cardCarbs;
}

/** The whole plan (the card and every later part) at most this much: each part alone is checked against 30 U / 300 g. */
export const MAX_PLAN_INSULIN_U = 30;
export const MAX_PLAN_CARBS_G = 300;

/**
 * Several later parts for one card: each computed like computeLaterPlan; the card's insulin is taken off only the
 * first computed dose for the card's own carbs (never twice). Totals cover the whole plan.
 */
export function computeLaterPlans(args: Omit<Parameters<typeof computeLaterPlan>[0], 'request'> & { requests: LaterRequest[] }): { plan: SplitPlan } | { problem: string } {
  if (args.requests.length === 0) return { problem: 'later is empty' };
  if (args.requests.length > MAX_LATER_PARTS) return { problem: `at most ${MAX_LATER_PARTS} later parts` };
  // Later doses computed for this card's carbs must not cover more grams than the card has (two parts each dosing the
  // whole meal would give its dose twice): name dose_carbs_g per part so they add up.
  const dosedCarbs = args.requests.reduce((total, request) => total + cardCarbsDosed(request, args.card_carbs_g), 0);
  if (dosedCarbs > args.card_carbs_g) {
    return { problem: `the later doses are for ${dosedCarbs} g but this card has ${args.card_carbs_g} g: give each later dose its own dose_carbs_g so they add up to at most ${args.card_carbs_g} g` };
  }
  const parts: SplitPlan[] = [];
  // The card's insulin is taken off exactly one later dose: the first one computed for the card's own carbs. The plan
  // stores the decision, so the dose computed when due takes off the same (planned-bolus.service createForMeal).
  let cardInsulinTaken = false;
  for (const request of args.requests) {
    const takesOff = !cardInsulinTaken && dosesCardCarbs(request, args.card_carbs_g);
    if (takesOff) cardInsulinTaken = true;
    const computed = computeLaterPlan({ ...args, request, subtract_card_insulin: takesOff });
    if ('problem' in computed) return computed;
    parts.push(computed.plan);
  }
  const laterCarbs = parts.reduce((total, part) => total + part.later_carbs_g, 0);
  const laterInsulin = parts.reduce((total, part) => total + part.later_insulin_u, 0);
  const totalCarbs = args.card_carbs_g + laterCarbs;
  const totals = {
    total_carbs_g: totalCarbs,
    total_insulin_u: Math.round((args.card_insulin_u + laterInsulin) * 100) / 100,
  };
  if (totals.total_insulin_u > MAX_PLAN_INSULIN_U) return { problem: `the whole plan would be ${totals.total_insulin_u} U, over ${MAX_PLAN_INSULIN_U} U: ask the caregiver` };
  if (totals.total_carbs_g > MAX_PLAN_CARBS_G) return { problem: `the whole plan would be ${totals.total_carbs_g} g, over ${MAX_PLAN_CARBS_G} g: ask the caregiver` };
  const [first, ...more] = parts.map((part) => ({ ...part, ...totals }));
  return { plan: more.length > 0 ? { ...first, more_parts: more } : first };
}

/** The trigger of a plan (older plans: a time for SPLIT, glucose stopped falling for DEFERRED_INSULIN). */
export function planTrigger(plan: { kind?: SplitPlanKind; trigger?: LaterTrigger | null }): LaterTrigger {
  return plan.trigger ?? (plan.kind === 'DEFERRED_INSULIN' ? 'GLUCOSE_STOPPED_FALLING' : 'AFTER_MINUTES');
}

/** Reads a stored split (jsonb); null when absent or not one this version can use. */
export function readSplitPlan(value: unknown): SplitPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const numbers = ['now_percent', 'later_after_minutes', 'total_carbs_g', 'total_insulin_u', 'later_carbs_g', 'later_insulin_u'] as const;
  if (!numbers.every((key) => typeof raw[key] === 'number' && Number.isFinite(raw[key]))) return null;
  const kind: SplitPlanKind = raw.kind === 'DEFERRED_INSULIN' ? 'DEFERRED_INSULIN' : 'SPLIT';
  if (kind === 'SPLIT' && (raw.later_carbs_g as number) <= 0) return null;
  if (kind === 'DEFERRED_INSULIN' && (raw.total_carbs_g as number) <= 0) return null;
  return {
    kind,
    policy_version: typeof raw.policy_version === 'string' ? raw.policy_version : SPLIT_BOLUS_POLICY.version,
    now_percent: raw.now_percent as number,
    later_after_minutes: raw.later_after_minutes as number,
    total_carbs_g: raw.total_carbs_g as number,
    total_insulin_u: raw.total_insulin_u as number,
    later_carbs_g: raw.later_carbs_g as number,
    later_insulin_u: raw.later_insulin_u as number,
    ...(LATER_TRIGGERS.includes(raw.trigger as LaterTrigger) ? { trigger: raw.trigger as LaterTrigger } : {}),
    ...(numberOrNull(raw.threshold_mgdl) !== null ? { threshold_mgdl: numberOrNull(raw.threshold_mgdl) } : {}),
    ...(numberOrNull(raw.dose_carbs_g) !== null ? { dose_carbs_g: numberOrNull(raw.dose_carbs_g) } : {}),
    ...(numberOrNull(raw.fixed_insulin_u) !== null ? { fixed_insulin_u: numberOrNull(raw.fixed_insulin_u) } : {}),
    ...(numberOrNull(raw.drop_cover_g) !== null ? { drop_cover_g: numberOrNull(raw.drop_cover_g) } : {}),
    ...(numberOrNull(raw.wait_minutes) !== null ? { wait_minutes: numberOrNull(raw.wait_minutes) } : {}),
    ...(typeof raw.subtract_card_insulin === 'boolean' ? { subtract_card_insulin: raw.subtract_card_insulin } : {}),
    ...(Array.isArray(raw.more_parts) && raw.more_parts.length > 0
      ? { more_parts: raw.more_parts.map((part) => readSplitPlan({ ...(part as Record<string, unknown>), more_parts: undefined })).filter((part): part is SplitPlan => part !== null) }
      : {}),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Insulin the loop delivered over [from, to) beyond the profile: SMBs plus the temp basal delivered minus the scheduled
 * basal of the same minutes (a zero temp counts against it). Without the basal profile (or with a gap in it) the temp
 * basal part is unknown: `temp_basal_extra_u` is null and the total holds the SMBs only. Null only for a bad window.
 */
export function loopInsulinAboveBasal(args: {
  from: string;
  to: string;
  /** SMB and TEMP_BASAL events (others are ignored), including temp basals started shortly before `from`. */
  events: InsulinDeliveryEvent[];
  basalSchedule: Array<[string, number]> | null | undefined;
  profileTimezone: string;
}): { smb_u: number; temp_basal_extra_u: number | null; total_u: number } | null {
  const fromMs = Date.parse(args.from);
  const toMs = Date.parse(args.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  const smb = args.events
    .filter((event) => event.type === 'SMB')
    .filter((event) => {
      const at = Date.parse(event.occurred_at);
      return at >= fromMs && at < toMs;
    })
    .reduce((total, event) => total + (finite(event.payload?.insulin_units ?? event.payload?.insulin) ?? 0), 0);
  const units = (segments: ReturnType<typeof deliveredBasalSegments>): number | null => {
    let total = 0;
    for (const segment of segments) {
      if (segment.rate === null) return null;
      total += (segment.rate * (Date.parse(segment.end) - Date.parse(segment.start))) / 3_600_000;
    }
    return total;
  };
  const schedule = args.basalSchedule;
  let tempExtra: number | null = null;
  if (schedule && schedule.length > 0) {
    const temps = args.events.filter((event) => event.type === 'TEMP_BASAL');
    const delivered = units(deliveredBasalSegments({ from: args.from, to: args.to, events: temps, basalSchedule: schedule, profileTimezone: args.profileTimezone }));
    const scheduled = units(deliveredBasalSegments({ from: args.from, to: args.to, events: [], basalSchedule: schedule, profileTimezone: args.profileTimezone }));
    tempExtra = delivered === null || scheduled === null ? null : delivered - scheduled;
  }
  return { smb_u: round2(smb), temp_basal_extra_u: tempExtra === null ? null : round2(tempExtra), total_u: round2(smb + (tempExtra ?? 0)) };
}

/** The carbs a planned part's dose is for: its own (later-plan.v1), the deferred carbs, or the whole meal's. */
export function plannedDoseCarbs(plan: Pick<PlannedBolusRecord, 'kind' | 'carbs_g' | 'first_carbs_g'> & { dose_carbs_g?: number | null }): number {
  if (plan.dose_carbs_g !== null && plan.dose_carbs_g !== undefined) return plan.dose_carbs_g;
  return plan.kind === 'DEFERRED_INSULIN' ? plan.first_carbs_g : plan.carbs_g;
}

/** What a later part becomes after its meal's carbs changed (migrations 076, 077). */
export interface MealChangeUpdate {
  plan_id: string;
  carbs_g: number;
  dose_carbs_g: number | null;
  planned_insulin_u: number;
  meal_carbs_g: number;
  meal_change_g: number;
  /** Nothing left to give for it: the part is cancelled (by the meal change, so it can come back). */
  cancel: boolean;
  /** A part a meal change cancelled has carbs again (the change was undone): it is scheduled again. */
  reopen: boolean;
  /** Grams removed beyond what the later parts held (meal_excess_g). */
  meal_excess_g: number;
}

/**
 * The later parts follow a change of their meal's carbs (carbs removed from the meal before the second
 * part must not leave its dose too big). Carbs removed come off the next part's carbs and the carbs its dose is for (what
 * does not fit, off the part after it); a part with nothing left to give is cancelled. Carbs added first give back what
 * earlier changes took, in the same order (so "Cofnij" restores the parts, a cancelled one included), the rest go to the
 * next open part. A dose the caregiver named stays (its push asks to check it). Parts that do not know their meal's
 * carbs yet take the current ones as their start.
 */
export function mealCarbsChangeUpdates(
  parts: PlannedBolusRecord[],
  mealCarbsG: number,
  step: number,
  options: {
    /** Parts whose command is on its way to the loop: their numbers are what was sent, they do not follow. */
    locked?: Set<string>;
    /** The meal's carbs the parts were made for when none knows them yet (cardMealCarbs; audit 2026-10-26). */
    baseline_when_unknown?: number | null;
  } = {},
): MealChangeUpdate[] {
  const followed = parts
    .filter((part) => !options.locked?.has(part.id))
    .filter((part) => OPEN_PLANNED_BOLUS_STATUSES.includes(part.status) || (part.status === 'CANCELLED' && part.cancelled_by_meal_change === true))
    .sort((a, b) => (a.part_index ?? 0) - (b.part_index ?? 0));
  const known = followed.find((part) => part.meal_carbs_g !== null && part.meal_carbs_g !== undefined);
  const baseline = known ? (known.meal_carbs_g as number) : options.baseline_when_unknown ?? null;
  let remaining = baseline !== null ? Math.round(mealCarbsG - baseline) : 0;
  // Carbs removed beyond the later parts were an excess of insulin already given; carbs that come back undo it first
  // (the reverse order of a removal), so "Cofnij" never adds grams to a part.
  const holder = followed[0];
  const excessBefore = followed.reduce((sum, part) => sum + (part.meal_excess_g ?? 0), 0);
  let excess = excessBefore;
  if (remaining > 0 && excess > 0) {
    const back = Math.min(remaining, excess);
    excess -= back;
    remaining -= back;
  }
  const state = new Map(followed.map((part) => [part.id, { carbs: part.carbs_g, dose: part.dose_carbs_g ?? null, taken: 0 }]));
  const take = (part: PlannedBolusRecord, grams: number): number => {
    const current = state.get(part.id)!;
    let taken: number;
    if (part.kind !== 'DEFERRED_INSULIN') {
      const carbs = Math.max(0, current.carbs + grams);
      taken = carbs - current.carbs;
      current.carbs = carbs;
      if (current.dose !== null) current.dose = Math.max(0, current.dose + taken);
    } else {
      const doseCarbs = current.dose ?? part.first_carbs_g;
      const dose = Math.max(0, doseCarbs + grams);
      taken = dose - doseCarbs;
      current.dose = dose;
    }
    current.taken += taken;
    return taken;
  };
  if (remaining < 0) {
    for (const part of followed) if (remaining < 0) remaining -= take(part, remaining);
    if (remaining < 0) {
      excess += -remaining;
      remaining = 0;
    }
  } else if (remaining > 0) {
    for (const part of followed) {
      const owed = -((part.meal_change_g ?? 0) + state.get(part.id)!.taken);
      if (remaining > 0 && owed > 0) remaining -= take(part, Math.min(remaining, owed));
    }
    const next = followed.find((part) => part.status !== 'CANCELLED') ?? followed[0];
    if (remaining > 0 && next) remaining -= take(next, remaining);
  }
  const updates: MealChangeUpdate[] = [];
  for (const part of followed) {
    const { carbs, dose, taken } = state.get(part.id)!;
    const fixed = part.fixed_insulin_u !== null && part.fixed_insulin_u !== undefined;
    const empty = !fixed && carbs <= 0 && plannedDoseCarbs({ ...part, carbs_g: carbs, dose_carbs_g: dose }) <= 0;
    const cancelled = part.status === 'CANCELLED';
    const planned = taken !== 0 && !fixed && part.icr_g_per_u && part.icr_g_per_u > 0
      ? Math.min(30, roundDownToStep(Math.max(0, part.planned_insulin_u + taken / part.icr_g_per_u), step))
      : part.planned_insulin_u;
    const partExcess = part.id === holder?.id ? excess : part.meal_excess_g ?? 0;
    if (taken === 0 && part.meal_carbs_g === mealCarbsG && partExcess === (part.meal_excess_g ?? 0)) continue;
    updates.push({
      plan_id: part.id,
      carbs_g: carbs,
      dose_carbs_g: dose,
      planned_insulin_u: planned,
      meal_carbs_g: mealCarbsG,
      meal_change_g: (part.meal_change_g ?? 0) + taken,
      cancel: !cancelled && empty && taken < 0,
      reopen: cancelled && !empty,
      meal_excess_g: partExcess,
    });
  }
  return updates;
}

export type ReadinessWaitReason = 'TOO_EARLY' | 'NO_READING' | 'LOW' | 'FALLING' | 'LOW_FORECAST' | 'NOT_RISING' | 'NOT_ABOVE';

export type PlannedBolusReadiness =
  | { state: 'WAIT'; reason: ReadinessWaitReason }
  | { state: 'READY'; trigger: LaterTrigger; glucose_mgdl: number | null }
  | { state: 'FORCED'; trigger: LaterTrigger; glucose_mgdl: number | null; reason: Exclude<ReadinessWaitReason, 'TOO_EARLY'> };

/** When a glucose condition stops being waited for: older deferred plans 60 min after the meal, newer ones their waiting time after due. */
export function plannedBolusForceAt(plan: Pick<PlannedBolusRecord, 'kind' | 'trigger' | 'wait_until'>, mealStartedAt: string): string | null {
  if (planTrigger(plan) === 'AFTER_MINUTES') return null;
  if (plan.wait_until) return plan.wait_until;
  return new Date(Date.parse(mealStartedAt) + DEFERRED_BOLUS_POLICY.force_after_minutes * 60_000).toISOString();
}

/**
 * A plan nobody gave expires this long after it was due, or after its reminder came anyway. A GLUCOSE_RISING plan whose
 * reminder never came lapses when its watching time is over (the Bolus tab's rule).
 */
export function plannedBolusExpiresAtMs(plan: Pick<PlannedBolusRecord, 'kind' | 'trigger' | 'wait_until' | 'due_at' | 'status'>, mealStartedAt: string): number {
  const forceAt = plannedBolusForceAt(plan, mealStartedAt);
  if (planTrigger(plan) === 'GLUCOSE_RISING' && plan.status === 'SCHEDULED' && forceAt) return Date.parse(forceAt);
  const from = Math.max(Date.parse(plan.due_at), forceAt ? Date.parse(forceAt) : 0);
  return from + SPLIT_BOLUS_POLICY.expire_after_due_minutes * 60_000;
}

/**
 * Whether a planned part's reminder should come now. AFTER_MINUTES: at due. GLUCOSE_STOPPED_FALLING (deferred-bolus.v1):
 * >= 80 mg/dL, slope >= -1 mg/dL/min, no calibrated forecast below 80 within 30 min. GLUCOSE_RISING: the Bolus tab's
 * rule (`rising`: three readings over ~10 min, each higher). GLUCOSE_ABOVE: the newest reading at or above the threshold. Glucose conditions are checked from due on
 * and, once `force_at` has passed, the reminder comes anyway, saying why it still waits.
 */
export function plannedBolusReadiness(args: {
  now: Date;
  trigger: LaterTrigger;
  due_at: string;
  force_at: string | null;
  glucose: { value: number; at: string } | null;
  slope_per_min: number | null;
  /** Lowest calibrated forecast within 30 min; null without a fresh loop forecast. */
  forecast_min_mgdl: number | null;
  threshold_mgdl?: number | null;
  /** GLUCOSE_RISING: glucoseRisingForSecondDose on the readings (bolus-reminders.ts). */
  rising?: boolean;
}): PlannedBolusReadiness {
  const policy = DEFERRED_BOLUS_POLICY;
  const nowMs = args.now.getTime();
  if (nowMs < Date.parse(args.due_at)) return { state: 'WAIT', reason: 'TOO_EARLY' };
  const fresh = args.glucose !== null && nowMs - Date.parse(args.glucose.at) <= policy.max_reading_age_minutes * 60_000;
  const glucose = fresh ? args.glucose!.value : null;
  if (args.trigger === 'AFTER_MINUTES') return { state: 'READY', trigger: args.trigger, glucose_mgdl: glucose };
  let reason: Exclude<ReadinessWaitReason, 'TOO_EARLY'> | null;
  if (args.trigger === 'GLUCOSE_RISING') {
    reason = args.rising === true ? null : glucose === null ? 'NO_READING' : 'NOT_RISING';
  } else if (glucose === null) {
    reason = 'NO_READING';
  } else if (args.trigger === 'GLUCOSE_STOPPED_FALLING') {
    reason = glucose < policy.ready_min_glucose_mgdl
      ? 'LOW'
      : args.slope_per_min !== null && args.slope_per_min < policy.ready_min_slope_per_min
        ? 'FALLING'
        : args.forecast_min_mgdl !== null && args.forecast_min_mgdl < policy.ready_min_forecast_mgdl
          ? 'LOW_FORECAST'
          : null;
  } else {
    reason = args.threshold_mgdl !== null && args.threshold_mgdl !== undefined && glucose >= args.threshold_mgdl ? null : 'NOT_ABOVE';
  }
  if (reason === null) return { state: 'READY', trigger: args.trigger, glucose_mgdl: glucose };
  // Never rising: no reminder anyway, the plan lapses (plannedBolusExpiresAtMs).
  if (args.force_at && nowMs >= Date.parse(args.force_at) && args.trigger !== 'GLUCOSE_RISING') return { state: 'FORCED', trigger: args.trigger, glucose_mgdl: glucose, reason };
  return { state: 'WAIT', reason };
}

/** The second part's dose now: deferred carbs / ICR now minus the loop's extra insulin since the meal, floor 0. */
export function secondPartDose(args: { carbs_g: number; icr_g_per_u: number | null; loop_extra_u: number | null; step: number }): {
  insulin_for_carbs_u: number | null;
  loop_extra_u: number;
  insulin_u: number | null;
} {
  const loopExtra = Math.max(0, args.loop_extra_u ?? 0);
  if (!args.icr_g_per_u || args.icr_g_per_u <= 0) return { insulin_for_carbs_u: null, loop_extra_u: round2(loopExtra), insulin_u: null };
  const forCarbs = args.carbs_g / args.icr_g_per_u;
  return {
    insulin_for_carbs_u: roundDownToStep(forCarbs, args.step),
    loop_extra_u: round2(loopExtra),
    insulin_u: roundDownToStep(Math.max(0, forCarbs - loopExtra), args.step),
  };
}

export type PlannedBolusStatus = 'SCHEDULED' | 'NOTIFIED' | 'GIVEN' | 'SKIPPED' | 'EXPIRED' | 'CANCELLED';
export const OPEN_PLANNED_BOLUS_STATUSES: PlannedBolusStatus[] = ['SCHEDULED', 'NOTIFIED'];

export interface PlannedBolusRecord {
  id: string;
  /** SPLIT: the second part of a split meal. DEFERRED_INSULIN: the whole dose of a meal whose carbs went first. */
  kind: SplitPlanKind;
  patient_id: string;
  meal_record_id: string;
  proposal_id: string | null;
  conversation_id: string | null;
  first_command_id: string | null;
  first_carbs_g: number;
  first_insulin_u: number;
  carbs_g: number;
  planned_insulin_u: number;
  icr_g_per_u: number | null;
  now_percent: number;
  delay_minutes: number;
  due_at: string;
  status: PlannedBolusStatus;
  notified_at: string | null;
  resolved_at: string | null;
  resolved_by_user_id: string | null;
  resolved_by_name: string | null;
  given_command_id: string | null;
  given_loop_action_id: string | null;
  given_insulin_u: number | null;
  created_at: string;
  /** later-plan.v1; null on older plans (planTrigger tells theirs). */
  trigger: LaterTrigger | null;
  threshold_mgdl: number | null;
  /** The carbs the dose is for; null: plannedDoseCarbs's older rule. */
  dose_carbs_g: number | null;
  /** A dose the caregiver named; null: computed when due. */
  fixed_insulin_u: number | null;
  /** Grams that covered a drop, taken off the dose's carbs. */
  drop_cover_g: number | null;
  /** The insulin the card gave for the same carbs is taken off (a dose given later for carbs sent with less now). */
  subtract_first_insulin: boolean;
  /** Glucose triggers: when the reminder comes even if the condition is not met; null on older plans. */
  wait_until: string | null;
  /** Which later part of its card (0: the first; migration 066). */
  part_index?: number;
  /** The meal's carbs this part's numbers were made for; null: not known yet (migration 076). */
  meal_carbs_g?: number | null;
  /** Grams of later meal changes this part took (negative: carbs removed); 0: none. */
  meal_change_g?: number;
  /** CANCELLED by a meal change (migration 077): it comes back when the carbs do. */
  cancelled_by_meal_change?: boolean;
  /**
   * Grams the meal lost beyond what its later parts held (migration 080): the insulin already given covered them, so it
   * was too much. Kept on the meal's first followed part; given back first when carbs come back ("Cofnij").
   */
  meal_excess_g?: number;
}

/** When the second part is due: the meal start (the loop's carb entry of the first part) plus the delay. */
export function plannedBolusDueAt(mealStartedAtIso: string, delayMinutes: number): string {
  return new Date(Date.parse(mealStartedAtIso) + delayMinutes * 60_000).toISOString();
}

/** The push: meal name, the carbs and the estimate, and for a glucose condition whether it was met. */
export function plannedBolusPushContent(args: {
  description: string | null;
  carbs_g: number;
  estimate_u: number | null;
  low_glucose: number | null;
  kind?: SplitPlanKind;
  readiness?: PlannedBolusReadiness;
  threshold_mgdl?: number | null;
  /** Grams of meal changes the part took since it was planned (migration 076). */
  meal_change_g?: number;
  /** A dose the caregiver named: it does not follow a meal change. */
  fixed_insulin_u?: number | null;
  /** "⚠️ Od 18:05 podano już 1,2 j (18:20, Trio)." when insulin was given by hand since the meal's bolus (taken off). */
  given_line?: string | null;
  /** dose-calculator.v1: why the dose is lower than planned (the calculator's line); null when it is not. */
  calculator_line?: string | null;
}): { title: string; body: string } {
  const result = plannedBolusPushBody(args);
  const given = args.given_line ? `${args.given_line} ${args.fixed_insulin_u !== null && args.fixed_insulin_u !== undefined ? 'Sprawdź, zanim podasz.' : 'Odjęte od dawki, sprawdź, zanim podasz.'}` : null;
  const change = mealChangeLine(args.meal_change_g ?? 0, args.fixed_insulin_u ?? null);
  const lines = [result.body, args.calculator_line ?? null, given, change].filter((line): line is string => Boolean(line));
  return { title: result.title, body: lines.join('\n') };
}

/**
 * "Posiłek zmniejszono o 10 g więcej, niż zostało w kolejnych częściach bolusa: podana insulina była o ok. 1 j za duża.
 * Sprawdź glukozę." (a warning on the meal and a push).
 */
export function mealExcessLine(excessG: number, excessU: number | null, kind: 'LATER_PARTS' | 'MEAL' = 'LATER_PARTS'): string | null {
  if (!(excessG > 0)) return null;
  const insulin = excessU !== null && excessU > 0 ? `podana insulina była o ok. ${formatUnits(excessU)} j za duża` : 'podana insulina była za duża';
  return kind === 'MEAL'
    ? `Posiłek ma teraz o ${excessG} g węglowodanów mniej, niż było, gdy podano insulinę: ${insulin}. Sprawdź glukozę.`
    : `Posiłek zmniejszono o ${excessG} g więcej, niż zostało w kolejnych częściach bolusa: ${insulin}. Sprawdź glukozę.`;
}

/**
 * Any meal with a bolus: its carb entries that came with insulin (the meal's own and its add-ons)
 * against the meal's carbs now. Carbs below them mean the insulin given was too much: the grams, and the insulin for
 * them in proportion to what was given (a dose reduced on purpose stays reduced). Null: no excess. A split meal's later
 * parts keep their own count (meal_excess_g).
 */
export function mealDoseExcess(args: {
  actions: Array<{ purpose: string | null; carbs_g: number | null; bolus_units: number | null }>;
  meal_carbs_g: number | null;
}): { grams: number; insulin_u: number } | null {
  if (args.meal_carbs_g === null || !Number.isFinite(args.meal_carbs_g)) return null;
  const covered = args.actions.filter((action) => (action.purpose === 'NEW_MEAL' || action.purpose === 'MEAL_ADDITION') && (action.carbs_g ?? 0) > 0 && (action.bolus_units ?? 0) > 0);
  const carbs = covered.reduce((sum, action) => sum + (action.carbs_g ?? 0), 0);
  const insulin = covered.reduce((sum, action) => sum + (action.bolus_units ?? 0), 0);
  const grams = Math.round(carbs - args.meal_carbs_g);
  if (!(carbs > 0) || grams <= 0) return null;
  return { grams, insulin_u: Math.round((insulin * grams / carbs) * 100) / 100 };
}

/** "⚠️ Posiłek zmieniono po zaplanowaniu (−10 g): dawka przeliczona." */
export function mealChangeLine(changeG: number, fixedInsulinU: number | null): string | null {
  if (!changeG) return null;
  const grams = `${changeG > 0 ? '+' : '−'}${Math.abs(changeG)} g`;
  return fixedInsulinU !== null
    ? `⚠️ Posiłek zmieniono po zaplanowaniu (${grams}), a dawka tej części była ustalona z góry: przelicz ją.`
    : `⚠️ Posiłek zmieniono po zaplanowaniu (${grams}): dawka przeliczona.`;
}

function plannedBolusPushBody(args: Parameters<typeof plannedBolusPushContent>[0]): { title: string; body: string } {
  const name = (args.description ?? '').replace(/\s*\(\s*\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l)\s*\)/gi, '').replace(/\s+/g, ' ').trim();
  const shortName = name.length > 40 ? `${name.slice(0, 39).replace(/[\s,;]+$/, '')}…` : name;
  const readiness = args.readiness;
  const glucoseLine = readiness && readiness.state !== 'WAIT' && readiness.trigger !== 'AFTER_MINUTES' ? readinessLine(readiness, args.threshold_mgdl ?? null) : null;
  if (args.kind === 'DEFERRED_INSULIN') {
    const dose = args.estimate_u !== null && args.estimate_u > 0 ? `ok. ${formatUnits(args.estimate_u)} j na ${args.carbs_g} g` : `na ${args.carbs_g} g`;
    const lead = shortName ? `${shortName}: ${dose}` : `Bolus ${dose}`;
    return { title: 'Bolus na posiłek', body: `${lead}\n${glucoseLine ?? 'Kliknij, aby sprawdzić dawkę'}` };
  }
  const amounts = `${args.carbs_g} g${args.estimate_u !== null && args.estimate_u > 0 ? `, ok. ${formatUnits(args.estimate_u)} j` : ''}`;
  const lead = shortName ? `${shortName}: ${amounts}` : `Druga część posiłku: ${amounts}`;
  return {
    title: 'Druga część bolusa',
    body: glucoseLine
      ? `${lead}\n${glucoseLine}`
      : args.low_glucose !== null
        ? `${lead}\nGlukoza ${args.low_glucose} mg/dL: sprawdź, zanim podasz`
        : `${lead}\nKliknij, aby sprawdzić dawkę`,
  };
}

function readinessLine(readiness: Exclude<PlannedBolusReadiness, { state: 'WAIT' }>, threshold: number | null): string {
  const glucose = readiness.glucose_mgdl;
  if (readiness.state === 'READY') {
    if (readiness.trigger === 'GLUCOSE_RISING') return `Glukoza ${glucose} mg/dL rośnie: sprawdź dawkę i podaj`;
    if (readiness.trigger === 'GLUCOSE_ABOVE') return `Glukoza ${glucose} mg/dL${threshold !== null ? `, powyżej ${threshold}` : ''}: sprawdź dawkę i podaj`;
    return `Glukoza ${glucose} mg/dL przestała spadać: sprawdź dawkę i podaj`;
  }
  if (readiness.reason === 'NO_READING') return 'Brak świeżego odczytu glukozy: sprawdź glukozę, zanim podasz';
  if (readiness.reason === 'NOT_RISING') return `Glukoza ${glucose} mg/dL nie zaczęła rosnąć: sprawdź, czy bolus jest jeszcze potrzebny`;
  if (readiness.reason === 'NOT_ABOVE') return `Glukoza ${glucose} mg/dL nie przekroczyła ${threshold ?? 'progu'}: sprawdź, czy bolus jest jeszcze potrzebny`;
  return `Glukoza ${glucose} mg/dL ${readiness.reason === 'LOW' ? 'nadal niska' : readiness.reason === 'FALLING' ? 'nadal spada' : 'może jeszcze spaść'}: sprawdź glukozę, zanim podasz`;
}

/** A plan as the meal JSON carries it (light: no live data). */
export interface PlannedBolusSummary {
  id: string;
  kind: SplitPlanKind;
  status: PlannedBolusStatus;
  due_at: string;
  delay_minutes: number;
  now_percent: number;
  carbs_g: number;
  planned_insulin_u: number;
  first_carbs_g: number;
  first_insulin_u: number;
  resolved_at: string | null;
  resolved_by_name: string | null;
  given_insulin_u: number | null;
  /** A command for it is on its way to Trio (the button is hidden on both phones). */
  sending: boolean;
  /** The meal it belongs to (the switch-off goes through the meal). */
  meal_record_id: string;
  part_index: number;
  /** later-plan.v1: what the reminder waits for. */
  trigger: LaterTrigger;
  threshold_mgdl: number | null;
  wait_until: string | null;
  fixed_insulin_u: number | null;
  /** Grams of meal changes the part took since it was planned (0: none; migration 076). */
  meal_change_g: number;
  /** CANCELLED because the meal's carbs were reduced; it comes back when they are restored (migration 077). */
  cancelled_by_meal_change: boolean;
  /** Grams the meal lost beyond its later parts: the insulin given was too much for them (migration 080). */
  meal_excess_g: number;
  /** The carbs the later dose is for when not only its own (e.g. the carbs now that had no insulin); null: its own. */
  dose_carbs_g: number | null;
}

export function toPlannedBolusSummary(record: PlannedBolusRecord, command: { status: string } | null): PlannedBolusSummary {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    due_at: record.due_at,
    delay_minutes: record.delay_minutes,
    now_percent: record.now_percent,
    carbs_g: record.carbs_g,
    planned_insulin_u: record.planned_insulin_u,
    first_carbs_g: record.first_carbs_g,
    first_insulin_u: record.first_insulin_u,
    resolved_at: record.resolved_at,
    resolved_by_name: record.resolved_by_name,
    given_insulin_u: record.given_insulin_u,
    sending: command !== null && ['AUTHORIZED', 'SENT', 'TRIO_ACCEPTED', 'SUCCEEDED', 'NO_REPLY'].includes(command.status),
    meal_record_id: record.meal_record_id,
    part_index: record.part_index ?? 0,
    trigger: planTrigger(record),
    threshold_mgdl: record.threshold_mgdl,
    wait_until: record.wait_until,
    fixed_insulin_u: record.fixed_insulin_u,
    dose_carbs_g: record.dose_carbs_g ?? null,
    meal_change_g: record.meal_change_g ?? 0,
    cancelled_by_meal_change: record.cancelled_by_meal_change === true,
    meal_excess_g: record.meal_excess_g ?? 0,
  };
}

function finite(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function round2(value: number): number {
  // + 0 turns -0 into 0.
  return Math.round(value * 100) / 100 + 0;
}

/** The therapy profile fields the second part needs (from getTherapyProfileAt). */
export interface SplitTherapyProfile {
  timezone: string | null;
  carb_ratio_g_per_u: Array<[string, number]> | null;
  basal_u_per_h: Array<[string, number]> | null;
}

export interface SecondPartEstimate {
  as_of: string;
  icr_g_per_u: number | null;
  insulin_for_carbs_u: number | null;
  /** SMBs and temp basal above the profile since the meal start (SMBs only when `loop_extra_partial`). */
  loop_extra_u: number | null;
  /** True when the temp basal part is unknown (no basal profile): `loop_extra_u` holds the SMBs only. */
  loop_extra_partial: boolean;
  smb_u: number | null;
  temp_basal_extra_u: number | null;
  /** The dose to give now (rounded down to the step); null without an ICR. */
  insulin_u: number | null;
  /** later-plan.v1: the carbs the dose is for, the grams taken off for a drop, the card's insulin taken off, a named dose. */
  dose_carbs_g?: number;
  drop_cover_g?: number | null;
  first_insulin_subtracted_u?: number | null;
  /** Insulin given by hand since the meal's bolus, taken off (audit 2026-10-26). */
  manual_insulin_subtracted_u?: number | null;
  fixed_insulin_u?: number | null;
  /**
   * dose-calculator.v1: the dose before the calculator lowered it (glucose below target or falling, the drop, carbs
   * first) and the calculator's line; absent without forecast data (older callers).
   */
  dose_before_calculator_u?: number | null;
  dose_calculation?: DoseCalculation | null;
  /** The calculator threw (logged, review M4): the dose was not lowered or checked; the push says so. */
  calculator_failed?: boolean;
}

/** The second part's dose now, from the profile valid now and the loop's insulin since the meal. */
export function estimateSecondPart(args: {
  carbs_g: number;
  meal_started_at: string;
  now_iso: string;
  therapy: SplitTherapyProfile;
  events: InsulinDeliveryEvent[];
  step: number;
  fallback_time_zone: string;
  icr_at: (schedule: Array<[string, number]> | null, iso: string, timeZone: string) => number | null;
  /** Count the loop's extra insulin from here instead of the meal start: an earlier part of the meal was given then and
   * its dose already took off the extra before it (the same SMBs are never taken off twice). */
  loop_extra_from?: string | null;
}): SecondPartEstimate {
  const timeZone = args.therapy.timezone ?? args.fallback_time_zone;
  const icr = args.icr_at(args.therapy.carb_ratio_g_per_u, args.now_iso, timeZone);
  const from = args.loop_extra_from && Date.parse(args.loop_extra_from) > Date.parse(args.meal_started_at) ? args.loop_extra_from : args.meal_started_at;
  const extra = loopInsulinAboveBasal({ from, to: args.now_iso, events: args.events, basalSchedule: args.therapy.basal_u_per_h, profileTimezone: timeZone });
  const dose = secondPartDose({ carbs_g: args.carbs_g, icr_g_per_u: icr, loop_extra_u: extra?.total_u ?? null, step: args.step });
  return {
    as_of: args.now_iso,
    icr_g_per_u: icr,
    insulin_for_carbs_u: dose.insulin_for_carbs_u,
    loop_extra_u: extra ? dose.loop_extra_u : null,
    loop_extra_partial: extra !== null && extra.temp_basal_extra_u === null,
    smb_u: extra?.smb_u ?? null,
    temp_basal_extra_u: extra?.temp_basal_extra_u ?? null,
    insulin_u: dose.insulin_u,
  };
}

/**
 * A planned part's dose now: its carbs (minus the grams that covered a drop) / ICR now, minus the loop's extra insulin
 * since the meal, minus the card's insulin for the same carbs when the plan says so; or the dose the caregiver named.
 */
/** The calculator's line when it lowered a planned part's dose (for the push): how much and why; null otherwise. */
export function plannedBolusCalculatorLine(estimate: Pick<SecondPartEstimate, 'insulin_u' | 'dose_before_calculator_u' | 'dose_calculation' | 'calculator_failed'> | null): string | null {
  if (estimate?.calculator_failed) return calculatorUnavailableWarning().message;
  if (!estimate?.dose_calculation || estimate.insulin_u === null || estimate.dose_before_calculator_u === null || estimate.dose_before_calculator_u === undefined) return null;
  // Only how much and why (owner 2026-10-29: values shown elsewhere stay out of the line).
  return estimate.insulin_u < estimate.dose_before_calculator_u - 1e-9 ? estimate.dose_calculation.short_summary ?? estimate.dose_calculation.summary : null;
}

export function estimatePlannedBolus(args: Omit<Parameters<typeof estimateSecondPart>[0], 'carbs_g'> & {
  plan: Pick<PlannedBolusRecord, 'kind' | 'carbs_g' | 'first_carbs_g' | 'first_insulin_u' | 'dose_carbs_g' | 'drop_cover_g' | 'fixed_insulin_u' | 'subtract_first_insulin'>;
  /** Insulin given by hand since the meal's bolus that no part of the meal accounts for (manualInsulinForPart). */
  manual_insulin_u?: number | null;
  /**
   * The readings, the loop's newest calculation and the profile (mealForecastDataFrom): the later dose is lowered by
   * the loop-style calculator (dose-calculator.v1, lowering only); absent: as before.
   */
  forecast?: MealForecastData | null;
}): SecondPartEstimate {
  const { plan, manual_insulin_u: manualInsulin, forecast, ...rest } = args;
  const doseCarbs = plannedDoseCarbs(plan);
  const dropCover = plan.drop_cover_g ?? null;
  const estimate = estimateSecondPart({ ...rest, carbs_g: Math.max(0, doseCarbs - (dropCover ?? 0)) });
  const subtract = plan.subtract_first_insulin ? Math.max(0, plan.first_insulin_u) : null;
  const fixed = plan.fixed_insulin_u !== null && plan.fixed_insulin_u !== undefined;
  // A dose given by hand is taken off; a dose the caregiver named stays (its push warns instead).
  const manual = !fixed && manualInsulin && manualInsulin > 0 ? Math.round(manualInsulin * 100) / 100 : null;
  const insulin = fixed
    ? plan.fixed_insulin_u!
    : estimate.insulin_u === null
      ? null
      : roundDownToStep(Math.max(0, estimate.insulin_u - (subtract ?? 0) - (manual ?? 0)), rest.step);
  const base = { ...estimate, insulin_u: insulin, dose_carbs_g: doseCarbs, drop_cover_g: dropCover, first_insulin_subtracted_u: subtract, manual_insulin_subtracted_u: manual, fixed_insulin_u: plan.fixed_insulin_u ?? null };
  if (forecast === undefined) return base;
  // A dose the caregiver named stays theirs (the confirmation warns while carbs come first); a computed one is lowered
  // for a glucose below target or falling, a drop, or carbs first, never raised.
  const { calculation, failed } = safeDoseCalculation(
    { now: new Date(rest.now_iso), carbs_g: 0, icr_g_per_u: estimate.icr_g_per_u, step: rest.step, data: forecast, later_part: { dose_u: insulin } },
    { where: 'split-bolus.estimate', id: (plan as { id?: string }).id ?? null },
  );
  if (fixed || insulin === null || !calculation) return { ...base, dose_before_calculator_u: insulin, dose_calculation: calculation, ...(failed ? { calculator_failed: true } : {}) };
  return { ...base, insulin_u: Math.min(insulin, calculation.default_u), dose_before_calculator_u: insulin, dose_calculation: calculation };
}

/**
 * Insulin given by hand for a meal after its own bolus that no part or command of the meal accounts for (audit
 * 2026-10-26: a bolus entered in Trio before the second part was due left the part's push at the full dose). Insulin
 * only: a bolus that came with carbs, or one assigned to another meal, is not this meal's.
 */
export function manualInsulinForPart<T extends { id: string; started_at: string; bolus_units: number | null; carbs_g: number | null; meal_record_id: string | null }>(args: {
  actions: T[];
  /** The meal's own doses (the card's, parts sent from the app or given before: usedLoopActionIds). */
  used: Set<string>;
  meal_record_id: string;
  meal_started_at: string;
  now: Date;
}): T[] {
  const startMs = Date.parse(args.meal_started_at);
  const fromMs = startMs + GIVEN_SINCE_OWN_BOLUS_MINUTES * 60_000;
  const untilMs = Math.min(args.now.getTime(), startMs + GIVEN_SINCE_WINDOW_HOURS * 3_600_000);
  return args.actions.filter((action) => {
    const at = Date.parse(action.started_at);
    return (action.bolus_units ?? 0) > 0 && !((action.carbs_g ?? 0) > 0) && !args.used.has(action.id)
      && (action.meal_record_id === null || action.meal_record_id === args.meal_record_id)
      && at >= fromMs && at <= untilMs;
  });
}
