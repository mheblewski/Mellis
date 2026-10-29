import { WBT_REMINDER_DELAY_MINUTES } from './wbt-policy';

/**
 * One earlier meal with insulin given for its protein and fat (WBT) and the late glucose response: the personal
 * evidence for a WBT dose. WBT insulin = carbs logged as WBT in the loop (0.5-6 h after the meal start), each divided
 * by the ICR active when it was logged (the loop doses it with that ICR, not the one of the meal), plus other manual
 * boluses 1.5-4.5 h after the meal start (the usual time of a WBT bolus); the bolus delivered for a WBT carb entry
 * itself is not counted twice. An entry the caregiver assigned elsewhere (another meal's bolus or WBT, a correction, a
 * hypo treatment) is not this meal's WBT; unassigned boluses without carbs still count.
 */

/** The loop action an event belongs to (payload.loop_action, from loop_action_events); absent before loop actions. */
export interface WbtEventAssignment {
  purpose: string | null;
  meal_identity: string | null;
  has_carbs: boolean;
}

/** Whether an entry inside the meal's WBT windows was assigned to something else than this meal's WBT. */
function assignedElsewhere(event: WbtHistoryEvent, mealIdentity: string): boolean {
  const assignment = event.payload.loop_action as WbtEventAssignment | undefined;
  if (!assignment) return false;
  if (assignment.purpose === 'WBT') return assignment.meal_identity !== null && assignment.meal_identity !== mealIdentity;
  if (assignment.purpose === null) return event.type === 'BOLUS' && assignment.has_carbs;
  return true;
}

/**
 * Whether the event is this meal's WBT dose: a loop entry answered WBT for this meal (carbs or a bolus alone); an
 * older carb entry without a loop action counts by its kind. Another meal's WBT never does.
 */
export function isMealWbtDose(event: WbtHistoryEvent, mealIdentity: string): boolean {
  const assignment = event.payload.loop_action as WbtEventAssignment | undefined;
  if (assignment) return assignment.purpose === 'WBT' && assignment.meal_identity === mealIdentity;
  return event.type === 'CARB_ENTRY' && event.payload.carb_kind === 'FAT_PROTEIN_UNITS';
}

export interface WbtHistoryEvent {
  type: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface WbtCase {
  case_id: string;
  started_at: string;
  local_time: string | null;
  description: string | null;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  fat_protein_units: number | null;
  /** ICR at the meal start. */
  icr_g_per_u: number | null;
  /** Carbs logged as WBT in the loop for this meal. */
  wbt_carbs_logged_g: number;
  /** Manual boluses 1.5-4.5 h after the meal. */
  late_bolus_units: number;
  /** Insulin attributed to WBT: each WBT carb entry / ICR at its time + late boluses. */
  wbt_insulin_units: number | null;
  /** Minutes after the meal start when the WBT insulin started (first WBT carb entry or late bolus). */
  wbt_given_minutes_after: number | null;
  glucose_at_reminder_mgdl: number | null;
  late_peak_mgdl: number | null;
  late_peak_minutes_after: number | null;
  glucose_4h_mgdl: number | null;
  glucose_5h_mgdl: number | null;
  glucose_6h_mgdl: number | null;
  late_min_mgdl: number | null;
  hypo_after_reminder: boolean | null;
  /** COMPLETE, or PARTIAL / NO_GLUCOSE when CGM readings are missing between 2.5 h and 6 h. */
  data_status: 'COMPLETE' | 'PARTIAL' | 'NO_GLUCOSE';
}

const glucoseOf = (event: WbtHistoryEvent): number | null => {
  const raw = (event.payload.raw_payload ?? {}) as Record<string, unknown>;
  const value = [event.payload.glucose_value, raw.sgv].find((candidate) => typeof candidate === 'number');
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const numberOr = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

const minutesSince = (startedAt: string, event: WbtHistoryEvent) => Math.round((Date.parse(event.occurred_at) - Date.parse(startedAt)) / 60_000);

/** Carb entries marked as WBT and logged 0.5-6 h after the meal start. */
function wbtCarbEntries(startedAt: string, events: WbtHistoryEvent[]): WbtHistoryEvent[] {
  return events.filter((event) => event.type === 'CARB_ENTRY' && event.payload.carb_kind === 'FAT_PROTEIN_UNITS'
    && minutesSince(startedAt, event) >= 30 && minutesSince(startedAt, event) <= 360);
}

/** ICR at the meal start and at each WBT carb entry of the meal, resolved up front for computeWbtCase. */
export async function wbtIcrLookup(
  startedAt: string,
  events: WbtHistoryEvent[],
  icrAt: (iso: string) => Promise<number | null>,
): Promise<(iso: string) => number | null> {
  const moments = [...new Set([startedAt, ...wbtCarbEntries(startedAt, events).map((event) => event.occurred_at)])];
  const icrs = new Map<string, number | null>();
  for (const iso of moments) icrs.set(iso, await icrAt(iso));
  return (iso) => icrs.get(iso) ?? null;
}

/** WBT insulin and late glucose response of a meal from the events of [start, start + 6 h]. */
export function computeWbtCase(args: {
  case_id: string;
  started_at: string;
  local_time: string | null;
  description: string | null;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  fat_protein_units: number | null;
  /** ICR active at a moment (the meal start and each WBT carb entry), see wbtIcrLookup. */
  icr_at: (iso: string) => number | null;
  events: WbtHistoryEvent[];
}): WbtCase {
  const minutesAfter = (event: WbtHistoryEvent) => minutesSince(args.started_at, event);

  // case_id is the meal's identity. Trio sometimes uploads one bolus twice (two Nightscout ids, the same time to the
  // millisecond and the same dose): counted once, and not at all when one copy was assigned elsewhere.
  const bolusKey = (event: WbtHistoryEvent) => `${Date.parse(event.occurred_at)}:${numberOr(event.payload.insulin_units ?? event.payload.insulin, 0)}`;
  const elsewhere = new Set(args.events.filter((event) => event.type === 'BOLUS' && assignedElsewhere(event, args.case_id)).map(bolusKey));
  const seenBoluses = new Set<string>();
  const events = args.events.filter((event) => !assignedElsewhere(event, args.case_id)).filter((event) => {
    if (event.type !== 'BOLUS') return true;
    const key = bolusKey(event);
    if (elsewhere.has(key) || seenBoluses.has(key)) return false;
    seenBoluses.add(key);
    return true;
  });
  const wbtEntries = wbtCarbEntries(args.started_at, events);
  // A bolus up to 20 min after a WBT carb entry is the loop's (or the pump's) answer to it: already counted as carbs / ICR.
  const answersWbtEntry = (bolus: WbtHistoryEvent) => wbtEntries.some((entry) => {
    const gap = minutesAfter(bolus) - minutesAfter(entry);
    return gap >= -2 && gap <= 20;
  });
  const lateBoluses = events.filter((event) => event.type === 'BOLUS' && minutesAfter(event) >= 90 && minutesAfter(event) <= 270 && !answersWbtEntry(event));
  const wbtCarbs = wbtEntries.reduce((total, event) => total + numberOr(event.payload.carbs, 0), 0);
  const lateUnits = lateBoluses.reduce((total, event) => total + numberOr(event.payload.insulin_units ?? event.payload.insulin, 0), 0);
  // The loop doses a WBT carb entry with the ICR active when it was logged.
  const convertible = wbtEntries
    .map((event) => ({ carbs: numberOr(event.payload.carbs, 0), icr: args.icr_at(event.occurred_at) }))
    .filter((entry): entry is { carbs: number; icr: number } => entry.carbs > 0 && entry.icr !== null && entry.icr > 0);
  const carbUnits = convertible.reduce((total, entry) => total + entry.carbs / entry.icr, 0);
  const insulin = convertible.length > 0 ? carbUnits + lateUnits : (lateUnits > 0 ? lateUnits : null);
  const givenAt = [...wbtEntries, ...lateBoluses].map(minutesAfter).sort((left, right) => left - right)[0] ?? null;

  const readings = args.events
    .map((event) => ({ value: glucoseOf(event), minutes: minutesAfter(event), type: event.type }))
    .filter((reading): reading is { value: number; minutes: number; type: string } => reading.value !== null && reading.type.startsWith('GLUCOSE'))
    .filter((reading) => reading.minutes >= WBT_REMINDER_DELAY_MINUTES - 10 && reading.minutes <= 360)
    .sort((left, right) => left.minutes - right.minutes);
  const near = (minutes: number) => readings
    .filter((reading) => Math.abs(reading.minutes - minutes) <= 10)
    .sort((left, right) => Math.abs(left.minutes - minutes) - Math.abs(right.minutes - minutes))[0]?.value ?? null;
  const late = readings.filter((reading) => reading.minutes >= WBT_REMINDER_DELAY_MINUTES);
  const peak = late.reduce<(typeof late)[number] | null>((best, reading) => (best === null || reading.value > best.value ? reading : best), null);
  const minimum = late.reduce<number | null>((low, reading) => (low === null || reading.value < low ? reading.value : low), null);
  // 2.5-6 h of CGM every 5 min is ~42 readings.
  const dataStatus = late.length === 0 ? 'NO_GLUCOSE' : late.length >= 21 ? 'COMPLETE' : 'PARTIAL';
  const round = (value: number) => Math.round(value * 100) / 100;

  return {
    case_id: args.case_id,
    started_at: args.started_at,
    local_time: args.local_time,
    description: args.description,
    carbs_g: args.carbs_g,
    protein_g: args.protein_g,
    fat_g: args.fat_g,
    fat_protein_units: args.fat_protein_units,
    icr_g_per_u: args.icr_at(args.started_at),
    wbt_carbs_logged_g: round(wbtCarbs),
    late_bolus_units: round(lateUnits),
    wbt_insulin_units: insulin === null ? null : round(insulin),
    wbt_given_minutes_after: givenAt,
    glucose_at_reminder_mgdl: near(WBT_REMINDER_DELAY_MINUTES),
    late_peak_mgdl: peak?.value ?? null,
    late_peak_minutes_after: peak?.minutes ?? null,
    glucose_4h_mgdl: near(240),
    glucose_5h_mgdl: near(300),
    glucose_6h_mgdl: near(360),
    late_min_mgdl: minimum,
    hypo_after_reminder: minimum === null ? null : minimum < 70,
    data_status: dataStatus,
  };
}

/** A case is usable evidence when a WBT dose was given and the late glucose response is known. */
export function isUsableWbtCase(wbtCase: WbtCase): boolean {
  return wbtCase.wbt_insulin_units !== null && wbtCase.wbt_insulin_units > 0 && wbtCase.data_status !== 'NO_GLUCOSE';
}
