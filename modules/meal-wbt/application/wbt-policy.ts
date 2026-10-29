/**
 * WBT (fat-protein units) follow-up policy, as agreed with the owner (2026-10-16):
 * - 1 WBT = 100 kcal from protein (4 kcal/g) and fat (9 kcal/g) (Pańkowska);
 * - the reminder is switched on automatically when a meal has >= 1.5 WBT, or >= 18 g fat, or >= 20 g protein
 *   (ISPAD 2022 gives no gram threshold; adult studies use ~35-40 g fat / 25-40 g protein, lowered for a child);
 * - the reminder fires 2.5 h after the meal start (the protein/fat rise appears ~3-5 h after a meal);
 * - without enough history the standard dose is WBT x (10 g / ICR) x 30%: 30% of the insulin for 1 carb unit
 *   (10 g) per WBT (Pańkowska's 100% and the later 50% caused more hypos; +30% in Paterson 2020);
 * - personal history counts from MIN_HISTORY_CASES earlier meals with a WBT dose and a known glucose response.
 * Decision support only: the caregiver decides.
 */

/** v2 (owner decision 2026-10-26): every WBT dose rounds DOWN to 0.05 U, as all other doses do (v1 rounded to nearest). */
export const WBT_POLICY_VERSION = 'wbt-policy.v2';
const WBT_AUTO_MIN_UNITS = 1.5;
const WBT_AUTO_MIN_FAT_G = 18;
const WBT_AUTO_MIN_PROTEIN_G = 20;
export const WBT_REMINDER_DELAY_MINUTES = 150;
export const WBT_STANDARD_FACTOR = 0.3;
/**
 * The safety bounds of a WBT dose, one set for both paths (owner decision 2026-10-26): the screen's suggestion clamps to
 * them; the chat card, where the caregiver's own dose comes first, only warns (advisor, not guard).
 */
export const WBT_DOSE_BOUNDS = {
  /** Below this glucose (mg/dL) no WBT insulin. */
  no_insulin_below_mgdl: 90,
  /** Never more than this many times the standard dose. */
  max_standard_multiple: 2,
} as const;
export const WBT_MIN_HISTORY_CASES = 3;

export function fatProteinUnitsOf(proteinG: number | null, fatG: number | null): number | null {
  if (proteinG === null && fatG === null) return null;
  return Math.round((((proteinG ?? 0) * 4 + (fatG ?? 0) * 9) / 100) * 10) / 10;
}

/** Whether the WBT reminder should be on for these macros (AUTO). */
export function shouldRemindAboutWbt(macros: { protein_g: number | null; fat_g: number | null }): boolean {
  const units = fatProteinUnitsOf(macros.protein_g, macros.fat_g) ?? 0;
  return units >= WBT_AUTO_MIN_UNITS || (macros.fat_g ?? 0) >= WBT_AUTO_MIN_FAT_G || (macros.protein_g ?? 0) >= WBT_AUTO_MIN_PROTEIN_G;
}

export function wbtReminderAt(mealStartedAtIso: string): string {
  return new Date(Date.parse(mealStartedAtIso) + WBT_REMINDER_DELAY_MINUTES * 60_000).toISOString();
}

/**
 * A reminder this long past its time is never sent: the worker skips it as stale (a server outage), and a write that
 * would schedule one this late stores it MISSED instead (owner decision 2026-10-26: protein or fat added long after
 * the time, no push, the meal page asks to check whether WBT is still needed).
 */
export const WBT_REMINDER_STALE_AFTER_MINUTES = 120;

export type WbtReminderStatus = 'SCHEDULED' | 'SENT' | 'SKIPPED' | 'MISSED';

/** What a WBT reminder's schedule is made of (meal_wbt_reminders). */
export interface WbtReminderSchedule {
  enabled: boolean;
  source: 'AUTO' | 'MANUAL';
  remind_at: string;
  status: WbtReminderStatus;
  /** A split bolus's second part postponed it to no earlier than this (migration 081). */
  not_before: string | null;
}

/**
 * The reminder after a write (audit 2026-10-26). AUTO follows the macros unless the caregiver chose MANUALly; MANUAL is
 * the caregiver's (or a Bolus tab dose's) choice; MEAL_MOVED only follows the meal's new start. While not yet settled
 * (SCHEDULED or MISSED) the time is always 2.5 h after the meal's start, or the postponement when later, so it moves
 * earlier with the meal too. A time already beyond the stale window becomes MISSED when this write is what put it
 * there (switched on, or moved); an unchanged SCHEDULED one is left for the worker. Null: no row and nothing to write.
 */
export function nextWbtReminderSchedule(
  current: WbtReminderSchedule | null,
  write: { kind: 'AUTO' | 'MANUAL'; enabled: boolean; meal_started_at: string } | { kind: 'MEAL_MOVED'; meal_started_at: string },
  now: Date,
): Omit<WbtReminderSchedule, 'not_before'> | null {
  if (!current && write.kind === 'MEAL_MOVED') return null;
  const source: WbtReminderSchedule['source'] = write.kind === 'MANUAL' ? 'MANUAL' : current?.source ?? 'AUTO';
  const enabled = write.kind === 'MEAL_MOVED' || (write.kind === 'AUTO' && current?.source === 'MANUAL') ? current!.enabled : write.enabled;
  if (current && current.status !== 'SCHEDULED' && current.status !== 'MISSED') {
    return { enabled, source, remind_at: current.remind_at, status: current.status };
  }
  const base = Date.parse(wbtReminderAt(write.meal_started_at));
  const floor = current?.not_before ? Date.parse(current.not_before) : Number.NEGATIVE_INFINITY;
  const remindAtMs = Math.max(base, floor);
  const remindAt = new Date(remindAtMs).toISOString();
  const stale = remindAtMs <= now.getTime() - WBT_REMINDER_STALE_AFTER_MINUTES * 60_000;
  const putThereNow = !current || current.status === 'MISSED' || !current.enabled || Date.parse(current.remind_at) !== remindAtMs;
  return { enabled, source, remind_at: remindAt, status: enabled && stale && putThereNow ? 'MISSED' : 'SCHEDULED' };
}

/** Longest meal name in the WBT push before it is cut with an ellipsis, so it stays on one line of the banner. */
const WBT_REMINDER_NAME_MAX_CHARS = 40;

/**
 * Body of the WBT reminder push: the meal name without gram amounts on the first line (or "Posiłek o HH:MM" when the
 * meal has no description), then the call to open the dose screen.
 */
export function wbtReminderBody(description: string | null, mealStartedAtIso: string, timeZone: string): string {
  const name = (description ?? '')
    .replace(/\s*\(\s*\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l)\s*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const time = new Intl.DateTimeFormat('pl-PL', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(mealStartedAtIso));
  return `${name ? truncateAtWord(name, WBT_REMINDER_NAME_MAX_CHARS) : `Posiłek o ${time}`}\nKliknij, aby ustalić dawkę insuliny`;
}

/**
 * A meal without protein and fat (a Bolus tab dose with a WBT reminder, bolus-reminders.v1) has no WBT dose to work out:
 * the push asks to describe it, or to give the dose by hand.
 */
export const WBT_REMINDER_BODY_WITHOUT_MACROS = 'Opisz posiłek, a policzę dawkę, albo podaj ją sam.';

/** The WBT push body for a meal: today's text when its protein or fat is known, else WBT_REMINDER_BODY_WITHOUT_MACROS. */
export function wbtReminderBodyFor(
  meal: { description: string | null; started_at: string; protein_g: number | null; fat_g: number | null },
  timeZone: string,
  /** Insulin given by hand since the meal's bolus: said only when there was some ("⚠️ Od 18:05 podano już 1,2 j …"). */
  givenWarning: string | null = null,
): string {
  const body = fatProteinUnitsOf(meal.protein_g, meal.fat_g) === null
    ? WBT_REMINDER_BODY_WITHOUT_MACROS
    : wbtReminderBody(meal.description, meal.started_at, timeZone);
  return givenWarning ? `${givenWarning}\n${body}` : body;
}

function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;]+$/, '')}…`;
}

/** A WBT dose rounded down to 0.05 U: rounding never adds insulin (in hundredths, so 0.45 / 0.05 stays 9). */
export function roundDownWbtUnits(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return (Math.floor(Math.floor(value * 100 + 1e-6) / 5) * 5) / 100;
}

/** Standard WBT dose: WBT x (10 / ICR) x 30%, rounded down to 0.05 U; with the carbs to log in the loop instead (dose x ICR). */
export function standardWbtDose(units: number, icrGramsPerUnit: number): { dose_units: number; carbs_equivalent_g: number } {
  const dose = units * (10 / icrGramsPerUnit) * WBT_STANDARD_FACTOR;
  const rounded = roundDownWbtUnits(dose);
  return { dose_units: rounded, carbs_equivalent_g: Math.round(rounded * icrGramsPerUnit) };
}

/** Value of a therapy schedule ([["HH:MM", value], ...]) at a moment, in the profile's time zone. */
export function scheduleValueAt(schedule: Array<[string, number]> | null, iso: string, timeZone: string): number | null {
  if (!schedule || schedule.length === 0) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const minutes = Number(parts.find((part) => part.type === 'hour')?.value) * 60 + Number(parts.find((part) => part.type === 'minute')?.value);
  const toMinutes = (time: string) => {
    const [hour, minute] = time.split(':').map(Number);
    return (hour || 0) * 60 + (minute || 0);
  };
  const sorted = [...schedule].sort((left, right) => toMinutes(left[0]) - toMinutes(right[0]));
  let value = sorted[sorted.length - 1][1];
  for (const [time, entryValue] of sorted) {
    if (toMinutes(time) <= minutes) value = entryValue;
  }
  return value;
}
