import { ValidationError } from '@shared/errors/app-error';
import { WBT_REMINDER_DELAY_MINUTES } from '@modules/meal-wbt/application/wbt-policy';
import { GLUCOSE_FORECAST_POLICY } from '@modules/glucose-forecast/application/glucose-forecast';

/**
 * Reminders set with a dose from the Bolus tab (bolus-reminders.v1, owner decision 2026-10-25, migration 073). The
 * caregiver taps "Przypomnij" next to the dose: WBT at +150 min, and/or a second dose when glucose starts rising or
 * after some minutes. A second dose is never computed: the Bolus tab says nothing about the meal, so the push only says
 * it is time, with the current glucose. The reminders are created once the loop's entries arrive and the dose becomes a
 * meal (the reconciler), timed from the loop's entry.
 */

export type BolusReminderRequest =
  | { kind: 'WBT' }
  | { kind: 'SECOND_DOSE'; trigger: 'GLUCOSE_RISING' }
  | { kind: 'SECOND_DOSE'; trigger: 'AFTER_MINUTES'; minutes: number };

export const BOLUS_REMINDER_POLICY = {
  version: 'bolus-reminders.v1',
  min_minutes: 5,
  max_minutes: 240,
  /** GLUCOSE_RISING is watched this long from when it was set, then lapses quietly (no push). */
  rising_wait_minutes: 60,
  /** "Rising": three readings at least ~5 min apart spanning 10 min (9.5 with the CGM's jitter), each higher, ≥ 3 mg/dL in all. */
  rising_readings: 3,
  rising_min_gap_minutes: 4.5,
  rising_min_span_minutes: 9.5,
  rising_min_total_mgdl: 3,
  /** A reading older than this is no current glucose (the same age the forecast takes as fresh). */
  /** One freshness rule for glucose everywhere (the forecast's). */
  fresh_reading_minutes: GLUCOSE_FORECAST_POLICY.max_reading_age_minutes,
  /** A timed second dose not sent by then (the worker was down, the loop's entry came late) lapses quietly. */
  timed_max_late_minutes: 30,
} as const;

/** The POST body's `reminders`: absent or null → none; anything malformed is refused. */
export function parseBolusReminders(raw: unknown): BolusReminderRequest[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw new ValidationError('reminders must be an array');
  if (raw.length === 0) return null;
  const out: BolusReminderRequest[] = [];
  for (const item of raw) {
    const entry = (item ?? {}) as Record<string, unknown>;
    if (typeof item !== 'object' || Array.isArray(item)) throw new ValidationError('reminders: each reminder is an object');
    if (entry.kind === 'WBT') {
      out.push({ kind: 'WBT' });
    } else if (entry.kind === 'SECOND_DOSE' && entry.trigger === 'GLUCOSE_RISING') {
      out.push({ kind: 'SECOND_DOSE', trigger: 'GLUCOSE_RISING' });
    } else if (entry.kind === 'SECOND_DOSE' && entry.trigger === 'AFTER_MINUTES') {
      const minutes = entry.minutes;
      if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < BOLUS_REMINDER_POLICY.min_minutes || minutes > BOLUS_REMINDER_POLICY.max_minutes) {
        throw new ValidationError(`reminders: minutes must be whole minutes ${BOLUS_REMINDER_POLICY.min_minutes}-${BOLUS_REMINDER_POLICY.max_minutes}`);
      }
      out.push({ kind: 'SECOND_DOSE', trigger: 'AFTER_MINUTES', minutes });
    } else {
      throw new ValidationError('reminders: kind must be WBT, or SECOND_DOSE with trigger GLUCOSE_RISING or AFTER_MINUTES');
    }
  }
  if (out.filter((reminder) => reminder.kind === 'WBT').length > 1 || out.filter((reminder) => reminder.kind === 'SECOND_DOSE').length > 1) {
    throw new ValidationError('reminders: at most one WBT and one SECOND_DOSE');
  }
  return out;
}

/** Stored JSON back to requests (a row written before validation changed is ignored rather than failing the match). */
export function readBolusReminders(value: unknown): BolusReminderRequest[] | null {
  try {
    return parseBolusReminders(value);
  } catch {
    return null;
  }
}

/** "4,5" / "45" / "0,05": Polish decimals without trailing zeros. */
export function plNumber(value: number): string {
  return String(Math.round(value * 100) / 100).replace('.', ',');
}

export function localTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pl-PL', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** "Druga dawka · 45 g · 4,5 j o 18:05": the push title, stored as the care reminder's note. */
export function secondDoseTitle(carbsG: number, insulinU: number, entryAtIso: string, timeZone: string): string {
  return `Druga dawka · ${plNumber(carbsG)} g · ${plNumber(insulinU)} j o ${localTime(entryAtIso, timeZone)}`;
}

/**
 * The second dose's push title, made when it is sent: what the meal's bolus really delivered (a bolus
 * the pump refused has no units) and the meal's carbs now ("Druga dawka · 35 g · 4,5 j o 18:05"); the body says when the
 * meal changed since ("Posiłek zmieniony: 45→35 g.") or the bolus was not given. Null without the meal's own entry: the
 * stored note is used.
 */
export function secondDoseTitleAtSend(args: {
  /** The meal's own loop entry (its NEW_MEAL action): when, the carbs sent and the insulin delivered. */
  entry: { started_at: string; carbs_g: number | null; bolus_units: number | null } | null;
  meal_carbs_g: number | null;
  time_zone: string;
}): { title: string; lines: string[] } | null {
  const entry = args.entry;
  if (!entry || entry.carbs_g === null || !(entry.carbs_g > 0)) return null;
  const sent = Math.round(entry.carbs_g);
  const now = args.meal_carbs_g !== null && args.meal_carbs_g > 0 ? Math.round(args.meal_carbs_g) : sent;
  const units = (entry.bolus_units ?? 0) > 0 ? ` · ${plNumber(entry.bolus_units!)} j` : '';
  return {
    title: `Druga dawka · ${plNumber(now)} g${units} o ${localTime(entry.started_at, args.time_zone)}`,
    lines: [
      ...(now !== sent ? [`Posiłek zmieniony: ${plNumber(sent)}→${plNumber(now)} g.`] : []),
      ...(units ? [] : ['Bolus do posiłku nie został podany.']),
    ],
  };
}

/**
 * The dose a second dose's reminder asks for, given before it came (audit 2026-10-26, the meal journal's rule): a bolus
 * assigned to the meal as an add-on or a correction after the reminder was set. Null: not given.
 */
export function secondDoseGivenBefore<T extends { id: string; started_at: string; purpose: string | null; meal_record_id: string | null; bolus_units: number | null }>(args: {
  reminder: { created_at: string; meal_record_id?: string | null };
  actions: T[];
  /** Loop actions that already answered another reminder. */
  used?: Set<string>;
}): T | null {
  const setMs = Date.parse(args.reminder.created_at);
  return args.actions
    .filter((action) => (action.purpose === 'MEAL_ADDITION' || action.purpose === 'CORRECTION')
      && action.meal_record_id === args.reminder.meal_record_id
      && (action.bolus_units ?? 0) > 0
      && Date.parse(action.started_at) >= setMs
      && !args.used?.has(action.id))
    .sort((left, right) => Date.parse(left.started_at) - Date.parse(right.started_at))[0] ?? null;
}

/**
 * When a meal's WBT reminder may come after its second dose (audit 2026-10-26: never two insulin reminders at once, the
 * rule split parts already follow): not while the second dose is still to come; an hour after it was given; half an hour
 * after it came unanswered. Null: no second dose holds it.
 */
export function wbtWaitForSecondDose(
  reminders: Array<{ kind?: string | null; status: string; fired_at: string | null; dose_given_at?: string | null }>,
  options: { given_gap_minutes: number; unanswered_gap_minutes: number },
): { state: 'OPEN' } | { state: 'NOT_BEFORE'; at: string } | null {
  let notBeforeMs: number | null = null;
  for (const reminder of reminders.filter((candidate) => candidate.kind === 'SECOND_DOSE')) {
    if (reminder.status === 'ACTIVE') return { state: 'OPEN' };
    const at = reminder.dose_given_at
      ? Date.parse(reminder.dose_given_at) + options.given_gap_minutes * 60_000
      : reminder.status === 'FIRED' && reminder.fired_at ? Date.parse(reminder.fired_at) + options.unanswered_gap_minutes * 60_000 : null;
    if (at !== null && Number.isFinite(at)) notBeforeMs = Math.max(notBeforeMs ?? at, at);
  }
  return notBeforeMs === null ? null : { state: 'NOT_BEFORE', at: new Date(notBeforeMs).toISOString() };
}

/** What the reconciler creates for a Bolus tab meal. */
export interface BolusTabReminderPlan {
  /** The meal's WBT reminder time (MANUAL, enabled); null without a WBT reminder. */
  wbt_remind_at: string | null;
  second_dose: { note: string; trigger: 'AT_TIME' | 'GLUCOSE_RISING'; due_at: string; wait_until: string | null } | null;
}

/**
 * Timed from the loop's entry (when the meal started); GLUCOSE_RISING is checked from now on and watched until an hour
 * after the caregiver set it (the command's authorization), so a late match does not watch longer.
 */
export function planBolusTabReminders(args: {
  reminders: BolusReminderRequest[];
  carbs_g: number;
  insulin_u: number;
  entry_at: string;
  set_at: string;
  now: Date;
  time_zone: string;
}): BolusTabReminderPlan {
  const entryMs = Date.parse(args.entry_at);
  const wbt = args.reminders.some((reminder) => reminder.kind === 'WBT');
  const second = args.reminders.find((reminder) => reminder.kind === 'SECOND_DOSE');
  const note = secondDoseTitle(args.carbs_g, args.insulin_u, args.entry_at, args.time_zone);
  let secondDose: BolusTabReminderPlan['second_dose'] = null;
  if (second && second.kind === 'SECOND_DOSE') {
    secondDose = second.trigger === 'AFTER_MINUTES'
      ? { note, trigger: 'AT_TIME', due_at: new Date(entryMs + second.minutes * 60_000).toISOString(), wait_until: null }
      : {
        note,
        trigger: 'GLUCOSE_RISING',
        due_at: args.now.toISOString(),
        wait_until: new Date(Math.max(Date.parse(args.set_at) + BOLUS_REMINDER_POLICY.rising_wait_minutes * 60_000, args.now.getTime())).toISOString(),
      };
  }
  return {
    wbt_remind_at: wbt ? new Date(entryMs + WBT_REMINDER_DELAY_MINUTES * 60_000).toISOString() : null,
    second_dose: secondDose,
  };
}

/**
 * Whether glucose is rising for a second dose: the newest reading is fresh and it and the two before it (each at least
 * a few minutes earlier, so a 1-minute CGM counts like a 5-minute one) span ~10 minutes, each higher than the one
 * before, by at least 3 mg/dL in all.
 */
export function glucoseRisingForSecondDose(readings: Array<{ at: string; value: number }>, now: Date): boolean {
  const policy = BOLUS_REMINDER_POLICY;
  const sorted = readings
    .filter((reading) => Number.isFinite(reading.value) && Date.parse(reading.at) <= now.getTime() + 60_000)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const newest = sorted[0];
  if (!newest || now.getTime() - Date.parse(newest.at) > policy.fresh_reading_minutes * 60_000) return false;
  const picked = [newest];
  for (const reading of sorted.slice(1)) {
    if (picked.length === policy.rising_readings) break;
    if (Date.parse(picked[picked.length - 1].at) - Date.parse(reading.at) >= policy.rising_min_gap_minutes * 60_000) picked.push(reading);
  }
  if (picked.length < policy.rising_readings) return false;
  const [latest, middle, oldest] = picked;
  if (Date.parse(latest.at) - Date.parse(oldest.at) < policy.rising_min_span_minutes * 60_000) return false;
  return middle.value > oldest.value && latest.value > middle.value && latest.value - oldest.value >= policy.rising_min_total_mgdl;
}

export type SecondDoseReadiness = { state: 'WAIT' } | { state: 'EXPIRED' } | { state: 'READY' };

/** AT_TIME: due at its time. GLUCOSE_RISING: due when rising; past its watching time it lapses (no push). */
export function secondDoseReadiness(args: {
  now: Date;
  reminder: { trigger: string; due_at: string; wait_until: string | null };
  readings: Array<{ at: string; value: number }>;
}): SecondDoseReadiness {
  const nowMs = args.now.getTime();
  if (nowMs < Date.parse(args.reminder.due_at)) return { state: 'WAIT' };
  if (args.reminder.trigger === 'AT_TIME') {
    return nowMs - Date.parse(args.reminder.due_at) > BOLUS_REMINDER_POLICY.timed_max_late_minutes * 60_000 ? { state: 'EXPIRED' } : { state: 'READY' };
  }
  if (glucoseRisingForSecondDose(args.readings, args.now)) return { state: 'READY' };
  if (!args.reminder.wait_until || nowMs >= Date.parse(args.reminder.wait_until)) return { state: 'EXPIRED' };
  return { state: 'WAIT' };
}

/** The current glucose with its arrow, or null without a fresh reading. */
export function currentGlucose(readings: Array<{ at: string; value: number; direction?: string | null }>, now: Date): { value: number; arrow: string | null } | null {
  const sorted = [...readings].filter((reading) => Number.isFinite(reading.value)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const newest = sorted[0];
  if (!newest || now.getTime() - Date.parse(newest.at) > BOLUS_REMINDER_POLICY.fresh_reading_minutes * 60_000) return null;
  // The 5-minute change, as the app computes its arrow when Nightscout sent no direction.
  const newestMs = Date.parse(newest.at);
  const earlier = sorted.find((reading) => {
    const ago = newestMs - Date.parse(reading.at);
    return ago >= 3 * 60_000 && ago <= 7 * 60_000;
  });
  const delta = earlier ? ((newest.value - earlier.value) / (newestMs - Date.parse(earlier.at))) * 5 * 60_000 : null;
  return { value: Math.round(newest.value), arrow: trendArrow(newest.direction ?? null, delta) };
}

/**
 * The trend as one character, the app's rule (GlucoseTrend.swift): Nightscout's direction when it is a known one,
 * else from the change per 5 minutes with Nightscout's cut-offs (5 / 10 / 17.5 mg/dL).
 */
export function trendArrow(direction: string | null, deltaPer5Min: number | null): string | null {
  const arrows: Record<string, string> = { DoubleUp: '⇈', SingleUp: '↑', FortyFiveUp: '↗', Flat: '→', FortyFiveDown: '↘', SingleDown: '↓', DoubleDown: '⇊' };
  if (direction && arrows[direction]) return arrows[direction];
  if (deltaPer5Min === null || !Number.isFinite(deltaPer5Min)) return null;
  if (deltaPer5Min > 17.5) return arrows.DoubleUp;
  if (deltaPer5Min > 10) return arrows.SingleUp;
  if (deltaPer5Min > 5) return arrows.FortyFiveUp;
  if (deltaPer5Min < -17.5) return arrows.DoubleDown;
  if (deltaPer5Min < -10) return arrows.SingleDown;
  if (deltaPer5Min < -5) return arrows.FortyFiveDown;
  return arrows.Flat;
}

/**
 * Title: the stored note ("Druga dawka · 45 g · 4,5 j o 18:05"); body: the glucose, what was given since the meal's bolus
 * and what to do: "Glukoza 141 →. Żaden z opiekunów nie podał jeszcze tej dawki. Dotknij, aby podać." When insulin was given since, the
 * push warns instead of inviting a dose ("Sprawdź, zanim podasz."): the other caregiver may have given it already.
 */
export function secondDosePushContent(
  note: string,
  glucose: { value: number; arrow: string | null } | null,
  given: GivenSinceMeal | null = null,
  /** What changed since the meal's bolus (secondDoseTitleAtSend): each makes the caregiver check before giving. */
  changes: string[] = [],
): { title: string; body: string } {
  const reading = glucose ? `Glukoza ${glucose.value}${glucose.arrow ? ` ${glucose.arrow}` : ''}. ` : '';
  const since = given?.line ? `${given.line} ` : '';
  const changed = changes.length > 0 ? `${changes.join(' ')} ` : '';
  const action = (given && given.doses.length > 0) || changes.length > 0 ? 'Sprawdź, zanim podasz.' : 'Dotknij, aby podać.';
  return { title: note, body: `${reading}${changed}${since}${action}` };
}

/** A dose given by hand after a meal's own bolus: when, how much and who ("Ewa", or "Trio" when entered there). */
export interface DoseGivenSince {
  at: string;
  insulin_u: number;
  by: string;
}

export interface GivenSinceMeal {
  since: string;
  total_u: number;
  doses: DoseGivenSince[];
  /** "⚠️ Od 18:05 podano już 1,2 j (18:20, Ewa)."; nothing given: "Żaden z opiekunów nie podał jeszcze tej dawki." with
   *  more than one caregiver, else empty. */
  line: string;
}

/** Nothing given since the meal's bolus, said only to a patient's several caregivers. */
export const NO_CAREGIVER_GAVE_IT = 'Żaden z opiekunów nie podał jeszcze tej dawki.';

/** The meal's own bolus and its retries are within this long of the meal's start: not "given since". */
export const GIVEN_SINCE_OWN_BOLUS_MINUTES = 2;
/** Only the meal's own hours count (its reminders come within them); later doses belong to other meals. */
export const GIVEN_SINCE_WINDOW_HOURS = 6;
/** Doses named in the line; more are counted ("i 2 inne"). */
const GIVEN_SINCE_LISTED = 3;

/**
 * Insulin given by hand since a meal's bolus (bolus-reminders.v1): every caregiver's dose and every
 * dose entered in the loop, whatever it was for; the loop's SMBs are its own corrections and are left out. Reminders of a
 * second dose or WBT say it, so a dose already given (from the other phone, or in Trio) is not given twice.
 */
export function givenSinceMeal(args: {
  mealStartedAt: string;
  now: Date;
  timeZone: string;
  actions: Array<{ id: string; started_at: string; bolus_units: number | null }>;
  /** Who sent each action from the app (loop action id → display name, null when unnamed); absent: entered in the loop. */
  senders: Map<string, string | null>;
  /** The loop's name for doses entered in it ("Trio", "Loop"; loopSystemNames). */
  loopName: string;
  /** The patient's caregivers: with one, "nothing given" goes unsaid (that caregiver knows it). */
  caregiverCount?: number;
}): GivenSinceMeal {
  const startMs = Date.parse(args.mealStartedAt);
  const fromMs = startMs + GIVEN_SINCE_OWN_BOLUS_MINUTES * 60_000;
  const untilMs = Math.min(args.now.getTime(), startMs + GIVEN_SINCE_WINDOW_HOURS * 3_600_000);
  const doses = args.actions
    .filter((action) => (action.bolus_units ?? 0) > 0)
    .filter((action) => {
      const at = Date.parse(action.started_at);
      return at >= fromMs && at <= untilMs;
    })
    .sort((left, right) => Date.parse(left.started_at) - Date.parse(right.started_at))
    .map((action) => ({
      at: action.started_at,
      insulin_u: Math.round((action.bolus_units ?? 0) * 100) / 100,
      by: args.senders.has(action.id) ? args.senders.get(action.id) ?? 'Mellis' : args.loopName,
    }));
  const total = Math.round(doses.reduce((sum, dose) => sum + dose.insulin_u, 0) * 100) / 100;
  const clock = (iso: string) => new Intl.DateTimeFormat('pl-PL', { timeZone: args.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  const units = (value: number) => String(value).replace('.', ',');
  const since = clock(args.mealStartedAt);
  const line = doses.length === 0
    ? ((args.caregiverCount ?? 1) > 1 ? NO_CAREGIVER_GAVE_IT : '')
    : doses.length === 1
      ? `⚠️ Od ${since} podano już ${units(total)} j (${clock(doses[0].at)}, ${doses[0].by}).`
      : `⚠️ Od ${since} podano już ${units(total)} j (${doses.slice(0, GIVEN_SINCE_LISTED).map((dose) => `${clock(dose.at)} ${units(dose.insulin_u)} j ${dose.by}`).join(', ')}${doses.length > GIVEN_SINCE_LISTED ? ` i ${doses.length - GIVEN_SINCE_LISTED} ${doses.length - GIVEN_SINCE_LISTED === 1 ? 'inna' : 'inne'}` : ''}).`;
  return { since: args.mealStartedAt, total_u: total, doses, line };
}

/** How long after a reminder came a caregiver's dose counts as the one it asked for. */
export const DOSE_GIVEN_WINDOW_MINUTES = 180;

/** A dose sent from the app, with who sent it and what the loop action became. */
export interface AppSentDose {
  /** The loop action (migration 082: one dose answers one reminder). */
  action_id?: string;
  at: string;
  insulin_u: number;
  user_id: string;
  name: string | null;
  /** The loop action's purpose and meal (null: left unassigned, as a Bolus tab dose without reminders is). */
  purpose?: string | null;
  meal_record_id?: string | null;
  carbs_g?: number | null;
}

/**
 * Whether a dose can be the one a meal's reminder asked for: insulin for that meal, never another meal's bolus or a
 * dose with carbs. WBT: assigned to the meal as WBT, or insulin alone left unassigned (given from the Bolus tab). A
 * second dose: insulin alone, unassigned or assigned to the meal as an add-on or a correction.
 */
export function doseFitsReminder(kind: 'SECOND_DOSE' | 'WBT', mealRecordId: string, dose: AppSentDose): boolean {
  const insulinOnly = (dose.carbs_g ?? 0) <= 0;
  const unassigned = !dose.purpose && !dose.meal_record_id;
  if (kind === 'WBT') return (dose.purpose === 'WBT' && dose.meal_record_id === mealRecordId) || (unassigned && insulinOnly);
  if (!insulinOnly) return false;
  return unassigned || ((dose.purpose === 'MEAL_ADDITION' || dose.purpose === 'CORRECTION') && dose.meal_record_id === mealRecordId);
}

/**
 * The dose that answered a reminder: the first one a caregiver sent from the app for that meal (see
 * doseFitsReminder) after the reminder came, within DOSE_GIVEN_WINDOW_MINUTES and before `until` (a second dose's window
 * ends when the meal's WBT reminder came). A dose entered in Trio has no caregiver and tells nobody.
 */
export function doseAnsweringReminder(args: {
  kind: 'SECOND_DOSE' | 'WBT';
  mealRecordId: string;
  firedAt: string;
  until: string | null;
  now: Date;
  doses: AppSentDose[];
  /** Loop actions that already answered a reminder (audit 2026-10-26: one dose answers one reminder). */
  used?: Set<string>;
}): AppSentDose | null {
  const fromMs = Date.parse(args.firedAt);
  const untilMs = Math.min(args.now.getTime(), fromMs + DOSE_GIVEN_WINDOW_MINUTES * 60_000, args.until ? Date.parse(args.until) : Number.POSITIVE_INFINITY);
  const assigned = (dose: AppSentDose) => (dose.meal_record_id === args.mealRecordId ? 0 : 1);
  return args.doses
    .filter((dose) => dose.insulin_u > 0 && doseFitsReminder(args.kind, args.mealRecordId, dose))
    .filter((dose) => !(dose.action_id && args.used?.has(dose.action_id)))
    .filter((dose) => {
      const at = Date.parse(dose.at);
      return at >= fromMs && at <= untilMs;
    })
    // A dose assigned to this meal first: an unassigned one may be for another meal.
    .sort((left, right) => assigned(left) - assigned(right) || Date.parse(left.at) - Date.parse(right.at))[0] ?? null;
}

/**
 * The other caregivers' push ("opiekun" is always masculine): "Druga dawka podana" / "Opiekun Ewa
 * podał drugą dawkę (1,5 j) na posiłek o 18:05"; "WBT podane" / "Opiekun Ewa podał 1,5 j na WBT po posiłku o 18:05".
 */
export function doseGivenPushContent(args: { kind: 'SECOND_DOSE' | 'WBT'; dose: AppSentDose; mealStartedAt: string; timeZone: string }): { title: string; body: string } {
  const clock = new Intl.DateTimeFormat('pl-PL', { timeZone: args.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(args.mealStartedAt));
  const units = `${String(Math.round(args.dose.insulin_u * 100) / 100).replace('.', ',')} j`;
  const who = args.dose.name ? `Opiekun ${args.dose.name}` : 'Inny opiekun';
  return args.kind === 'WBT'
    ? { title: 'WBT podane', body: `${who} podał ${units} na WBT po posiłku o ${clock}` }
    : { title: 'Druga dawka podana', body: `${who} podał drugą dawkę (${units}) na posiłek o ${clock}` };
}
