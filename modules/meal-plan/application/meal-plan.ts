import { ValidationError } from '@shared/errors/app-error';

/**
 * Meals known ahead (meal-plan.v1): the pure rules. A planned meal is not a meal record: it has no dose (computed when
 * its page opens) and nothing that reads meals sees it. Plan: the product plan.
 */
export const MEAL_PLAN_POLICY = {
  version: 'meal-plan.v1',
  default_lead_minutes: 20,
  min_lead_minutes: 5,
  max_lead_minutes: 60,
  /** A bolus since this long before the meal counts as its dose: no reminder, no missed-dose push. */
  dose_window_before_minutes: 30,
  /** The one push about a meal with no dose. */
  missed_after_minutes: 10,
  /** After this the missed-dose push would only confuse: it is dropped. */
  missed_until_minutes: 120,
  max_entries: 60,
  max_ahead_days: 35,
  max_title_length: 80,
  max_items: 12,
  max_item_length: 80,
  /**
   * The push before an activity, only when something may need doing. Glucose under 120: AID consensus (Phillip 2023,
   * table 12: 10-20 g at the start or 10 minutes before). Falling under 150: our choice, the drop continues in the 30 minutes.
   */
  movement_alert_lead_minutes: 30,
  movement_low_mgdl: 120,
  movement_falling_mgdl: 150,
  /** "Czy obiad został zjedzony?": this long after the meal, while glucose has not risen. */
  eaten_check_after_minutes: 25,
  eaten_check_until_minutes: 90,
  /** Not rising: at most this much above the reading at the meal's time. */
  eaten_check_rise_mgdl: 10,
  /** "Nie wiem": the second and last question. */
  eaten_ask_again_minutes: 15,
} as const;

export type MealPlanEntryKind = 'MEAL' | 'MOVEMENT';
export type MealPlanEntryStatus = 'PLANNED' | 'SKIPPED' | 'REMOVED';

export interface MealPlanItem {
  name: string;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
}

export interface MealPlanEntry {
  id: string;
  plan_id: string;
  patient_id: string;
  kind: MealPlanEntryKind;
  title: string;
  planned_at: string;
  items: MealPlanItem[];
  status: MealPlanEntryStatus;
  lead_minutes: number;
  reminder_sent_at: string | null;
  missed_sent_at: string | null;
  /** Whether the bolus given near the meal was for it. */
  dose_answer: MealPlanDoseAnswer | null;
  eaten_asked_at: string | null;
  eaten_asked_again_at: string | null;
  eaten_answer: MealPlanEatenAnswer | null;
  eaten_answered_at: string | null;
  /** Skipped by "Bez przypomnień do…". */
  paused: boolean;
  /** Portions as a phone set them (opaque: the phones' own format); null until one did. */
  plate?: Record<string, unknown> | null;
  /** The dishes were changed in the planned meal's chat (the menu's own are kept apart). */
  menu_changed?: boolean;
}

/**
 * The carbs of a planned meal as the phones' plate sets them (MealPlanPlate as Swift encodes it: a food's portion is
 * {"whole":{}}, {"half":{}}, {"none":{}} or {"grams":{"_0":12}}; a food eaten instead without grams is unknown).
 * Null when a food's grams are not known.
 */
export function plannedMealCarbs(entry: Pick<MealPlanEntry, 'items' | 'plate'>): number | null {
  const plate = (entry.plate ?? {}) as { foods?: Record<string, { portion?: Record<string, unknown>; replacedBy?: string | null }>; added?: Array<{ carbs_g?: number | null }> };
  let total = 0;
  for (const item of entry.items) {
    const food = plate.foods?.[item.name];
    const portion = food?.portion ?? { whole: {} };
    if ('none' in portion) continue;
    if ('grams' in portion) {
      const grams = Number((portion.grams as Record<string, unknown> | null)?._0);
      if (!Number.isFinite(grams)) return null;
      total += grams;
      continue;
    }
    if (food?.replacedBy) return null;
    if (item.carbs_g === null) return null;
    total += 'half' in portion ? item.carbs_g / 2 : item.carbs_g;
  }
  for (const added of plate.added ?? []) total += Number(added.carbs_g ?? 0) || 0;
  return Math.round(total);
}

export type MealPlanDoseAnswer = 'THIS_MEAL' | 'OTHER';
export type MealPlanEatenAnswer = 'YES' | 'PART' | 'NO' | 'UNKNOWN';

export interface NewMealPlanEntry {
  kind: MealPlanEntryKind;
  title: string;
  planned_at: string;
  items: MealPlanItem[];
}

export interface NewMealPlan {
  lead_minutes: number;
  entries: NewMealPlanEntry[];
}

function grams(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 500) throw new ValidationError(`${field} must be between 0 and 500 g`);
  return value;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ValidationError(`${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ValidationError(`${field} is longer than ${max} characters`);
  return trimmed;
}

/** The dishes of one meal. */
export function parseMealPlanItems(raw: unknown): MealPlanItem[] {
  const rawItems = raw ?? [];
  if (!Array.isArray(rawItems) || rawItems.length > MEAL_PLAN_POLICY.max_items) throw new ValidationError(`items must be a list of at most ${MEAL_PLAN_POLICY.max_items}`);
  return rawItems.map((rawItem) => {
    const item = (rawItem ?? {}) as Record<string, unknown>;
    return {
      name: text(item.name, 'item name', MEAL_PLAN_POLICY.max_item_length),
      carbs_g: grams(item.carbs_g, 'carbs_g'),
      protein_g: grams(item.protein_g, 'protein_g'),
      fat_g: grams(item.fat_g, 'fat_g'),
    };
  });
}

/** The plan as the app or the chat's card sent it; a meal in the past or too far ahead is refused. */
export function parseMealPlanInput(body: unknown, now: Date): NewMealPlan {
  const input = (body ?? {}) as Record<string, unknown>;
  const lead = input.lead_minutes ?? MEAL_PLAN_POLICY.default_lead_minutes;
  if (!Number.isInteger(lead) || (lead as number) < MEAL_PLAN_POLICY.min_lead_minutes || (lead as number) > MEAL_PLAN_POLICY.max_lead_minutes) {
    throw new ValidationError(`lead_minutes must be between ${MEAL_PLAN_POLICY.min_lead_minutes} and ${MEAL_PLAN_POLICY.max_lead_minutes}`);
  }
  if (!Array.isArray(input.entries) || input.entries.length === 0) throw new ValidationError('entries must not be empty');
  if (input.entries.length > MEAL_PLAN_POLICY.max_entries) throw new ValidationError(`a plan has at most ${MEAL_PLAN_POLICY.max_entries} entries`);
  const latest = now.getTime() + MEAL_PLAN_POLICY.max_ahead_days * 24 * 3_600_000;
  const entries = input.entries.map((raw): NewMealPlanEntry => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    if (entry.kind !== 'MEAL' && entry.kind !== 'MOVEMENT') throw new ValidationError('kind must be MEAL or MOVEMENT');
    const plannedMs = typeof entry.planned_at === 'string' ? Date.parse(entry.planned_at) : NaN;
    if (!Number.isFinite(plannedMs)) throw new ValidationError('planned_at must be a date');
    if (plannedMs <= now.getTime()) throw new ValidationError('planned_at must be in the future');
    if (plannedMs > latest) throw new ValidationError(`planned_at must be within ${MEAL_PLAN_POLICY.max_ahead_days} days`);
    return {
      kind: entry.kind,
      title: text(entry.title, 'title', MEAL_PLAN_POLICY.max_title_length),
      planned_at: new Date(plannedMs).toISOString(),
      items: parseMealPlanItems(entry.items),
    };
  });
  return { lead_minutes: lead as number, entries };
}

export type MealPlanPushDecision =
  | { action: 'WAIT' }
  /** Nothing is left to send for this entry. */
  | { action: 'DONE' }
  | { action: 'REMIND' }
  /** The moment passed without a push being due (a dose was given, or it is too late): only the claim is written. */
  | { action: 'CLOSE_REMINDER' }
  | { action: 'MISSED' }
  | { action: 'CLOSE_MISSED' };

/** What the worker does about an entry now. `doseGiven`: a bolus since the dose window opened. */
export function mealPlanPushDecision(entry: Pick<MealPlanEntry, 'kind' | 'status' | 'planned_at' | 'lead_minutes' | 'reminder_sent_at' | 'missed_sent_at'>, now: Date, doseGiven: boolean): MealPlanPushDecision {
  if (entry.kind !== 'MEAL' || entry.status !== 'PLANNED') return { action: 'DONE' };
  const plannedMs = Date.parse(entry.planned_at);
  const nowMs = now.getTime();
  if (!entry.reminder_sent_at) {
    if (nowMs < plannedMs - entry.lead_minutes * 60_000) return { action: 'WAIT' };
    // A worker that was down does not send "za 20 min" after the meal started.
    if (nowMs >= plannedMs || doseGiven) return { action: 'CLOSE_REMINDER' };
    return { action: 'REMIND' };
  }
  if (entry.missed_sent_at) return { action: 'DONE' };
  if (nowMs < plannedMs + MEAL_PLAN_POLICY.missed_after_minutes * 60_000) return { action: 'WAIT' };
  if (doseGiven || nowMs > plannedMs + MEAL_PLAN_POLICY.missed_until_minutes * 60_000) return { action: 'CLOSE_MISSED' };
  return { action: 'MISSED' };
}

/** The bolus that counts as this meal's dose was given at or after this moment. */
export function mealPlanDoseWindowStart(plannedAt: string): string {
  return new Date(Date.parse(plannedAt) - MEAL_PLAN_POLICY.dose_window_before_minutes * 60_000).toISOString();
}

/** A full sentence about glucose, without a dose: a dose in a push goes stale and shows on a locked screen. */
function glucoseSentence(glucose: { value: number; arrow: string | null } | null): string {
  if (!glucose) return 'Brak świeżego odczytu glukozy.';
  if (glucose.arrow && /[↓↘]/.test(glucose.arrow)) return `Glukoza wynosi ${glucose.value} i spada.`;
  if (glucose.arrow && /[↑↗]/.test(glucose.arrow)) return `Glukoza wynosi ${glucose.value} i rośnie.`;
  if (glucose.arrow === '→') return `Glukoza wynosi ${glucose.value} i nie zmienia się.`;
  return `Glukoza wynosi ${glucose.value}.`;
}

/** The meal names whose grammatical gender is known; any other title is spoken of as "posiłek". */
const MEAL_GENDER: Record<string, 'M' | 'F' | 'N'> = {
  obiad: 'M', podwieczorek: 'M', lunch: 'M', deser: 'M',
  kolacja: 'F', przekąska: 'F', zupa: 'F',
  śniadanie: 'N', 'ii śniadanie': 'N', 'drugie śniadanie': 'N',
};

/** "obiad" + "został zjedzony" when the title's gender is known; otherwise "posiłek", which fits any title. */
function mealWords(title: string): { noun: string; gender: 'M' | 'F' | 'N' } {
  const trimmed = title.trim().replace(/\s+/g, ' ');
  const gender = MEAL_GENDER[trimmed.toLocaleLowerCase('pl')];
  if (!gender) return { noun: 'posiłek', gender: 'M' };
  // "Obiad" → "obiad", but "II śniadanie" keeps its capitals.
  const noun = trimmed.length > 1 && trimmed[1] === trimmed[1].toLocaleLowerCase('pl') ? trimmed[0].toLocaleLowerCase('pl') + trimmed.slice(1) : trimmed;
  return { noun, gender };
}

const EATEN = { M: 'został zjedzony', F: 'została zjedzona', N: 'zostało zjedzone' } as const;
const WAS_EATEN = { M: 'był zjedzony', F: 'była zjedzona', N: 'było zjedzone' } as const;

export function mealPlanReminderContent(entry: Pick<MealPlanEntry, 'title'>, clock: string, glucose: { value: number; arrow: string | null } | null): { title: string; body: string } {
  return { title: `${entry.title} o ${clock}`, body: glucoseSentence(glucose) };
}

export function mealPlanMissedContent(entry: Pick<MealPlanEntry, 'title'>, clock: string, glucose: { value: number; arrow: string | null } | null): { title: string; body: string } {
  const meal = mealWords(entry.title);
  return { title: `${entry.title.trim()} ${clock} bez bolusa`, body: `${glucoseSentence(glucose)} Jeśli ${meal.noun} ${WAS_EATEN[meal.gender]}, otwórz i sprawdź dawkę.` };
}

export type MealPlanEatenDecision = { action: 'WAIT' } | { action: 'DONE' } | { action: 'ASK' } | { action: 'ASK_AGAIN' };

/**
 * "Czy obiad został zjedzony?": only after a bolus for this meal, when glucose has not risen, once, and once more after
 * "Nie wiem". `notRising` null: no way to tell from the readings, so nothing is asked on a guess.
 */
export function mealPlanEatenDecision(entry: Pick<MealPlanEntry, 'kind' | 'status' | 'planned_at' | 'dose_answer' | 'eaten_asked_at' | 'eaten_asked_again_at' | 'eaten_answer' | 'eaten_answered_at'>, now: Date, facts: { doseGiven: boolean; notRising: boolean | null }): MealPlanEatenDecision {
  if (entry.kind !== 'MEAL' || entry.status !== 'PLANNED' || entry.dose_answer === 'OTHER') return { action: 'DONE' };
  const nowMs = now.getTime();
  const plannedMs = Date.parse(entry.planned_at);
  if (nowMs > plannedMs + MEAL_PLAN_POLICY.eaten_check_until_minutes * 60_000) return { action: 'DONE' };
  if (entry.eaten_answer === 'UNKNOWN' && entry.eaten_answered_at && !entry.eaten_asked_again_at) {
    return nowMs >= Date.parse(entry.eaten_answered_at) + MEAL_PLAN_POLICY.eaten_ask_again_minutes * 60_000 ? { action: 'ASK_AGAIN' } : { action: 'WAIT' };
  }
  if (entry.eaten_answer || entry.eaten_asked_at) return { action: 'DONE' };
  if (nowMs < plannedMs + MEAL_PLAN_POLICY.eaten_check_after_minutes * 60_000) return { action: 'WAIT' };
  return facts.doseGiven && facts.notRising === true ? { action: 'ASK' } : { action: 'WAIT' };
}

/** The newest fresh reading against the one nearest the meal's time; null without both. */
export function glucoseNotRisingSince(readings: Array<{ at: string; value: number }>, plannedAt: string, now: Date): boolean | null {
  const plannedMs = Date.parse(plannedAt);
  const usable = readings.filter((reading) => Number.isFinite(reading.value));
  const newest = [...usable].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (!newest || now.getTime() - Date.parse(newest.at) > 15 * 60_000) return null;
  const base = usable
    .filter((reading) => Math.abs(Date.parse(reading.at) - plannedMs) <= 15 * 60_000)
    .sort((a, b) => Math.abs(Date.parse(a.at) - plannedMs) - Math.abs(Date.parse(b.at) - plannedMs))[0];
  if (!base || base.at === newest.at) return null;
  return newest.value - base.value <= MEAL_PLAN_POLICY.eaten_check_rise_mgdl;
}

export function mealPlanEatenContent(entry: Pick<MealPlanEntry, 'title'>, glucose: { value: number; arrow: string | null } | null, again: boolean): { title: string; body: string } {
  const meal = mealWords(entry.title);
  // A meal name whose gender is not known keeps its title in front: "Zupa i podwieczorek: czy posiłek został zjedzony?".
  const title = meal.noun === 'posiłek' ? `${entry.title.trim()}: czy posiłek został zjedzony?` : `Czy ${meal.noun} ${EATEN[meal.gender]}?`;
  const fall = glucose?.arrow && /[↓↘]/.test(glucose.arrow) ? ' i spada' : glucose?.arrow === '→' ? ' i nie zmienia się' : '';
  const facts = glucose ? `Bolus podany, a glukoza nie rośnie: ${glucose.value}${fall}.` : 'Bolus podany, a glukoza nie rośnie.';
  return { title, body: again ? `${facts} Sprawdź, jak wygląda sytuacja.` : `${facts} Jeśli ${meal.noun} nie ${EATEN[meal.gender]}, mogą być potrzebne węglowodany.` };
}

export type MealPlanMovementDecision = { action: 'WAIT' } | { action: 'DONE' } | { action: 'ALERT' };

/** Before an activity: silent while glucose is fine, so a later drop in the half hour still gets its one push. */
export function mealPlanMovementDecision(entry: Pick<MealPlanEntry, 'kind' | 'status' | 'planned_at' | 'reminder_sent_at'>, now: Date, glucose: { value: number; arrow: string | null } | null): MealPlanMovementDecision {
  if (entry.kind !== 'MOVEMENT' || entry.status !== 'PLANNED' || entry.reminder_sent_at) return { action: 'DONE' };
  const plannedMs = Date.parse(entry.planned_at);
  if (now.getTime() >= plannedMs) return { action: 'DONE' };
  if (now.getTime() < plannedMs - MEAL_PLAN_POLICY.movement_alert_lead_minutes * 60_000 || !glucose) return { action: 'WAIT' };
  const falling = glucose.arrow !== null && /[↓↘]/.test(glucose.arrow);
  return glucose.value < MEAL_PLAN_POLICY.movement_low_mgdl || (falling && glucose.value < MEAL_PLAN_POLICY.movement_falling_mgdl) ? { action: 'ALERT' } : { action: 'WAIT' };
}

export function mealPlanMovementContent(entry: Pick<MealPlanEntry, 'title'>, clock: string, glucose: { value: number; arrow: string | null }): { title: string; body: string } {
  return { title: `${entry.title} o ${clock}`, body: `${glucoseSentence(glucose)} Przed zajęciami mogą być potrzebne węglowodany.` };
}

/** "Zmień godzinę": a moment still ahead and within the plan's reach; returns it normalized. */
export function parsePlannedAt(value: unknown, now: Date): string {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new ValidationError('planned_at must be a date');
  if (ms <= now.getTime()) throw new ValidationError('planned_at must be in the future');
  if (ms > now.getTime() + MEAL_PLAN_POLICY.max_ahead_days * 86_400_000) throw new ValidationError(`planned_at must be within ${MEAL_PLAN_POLICY.max_ahead_days} days`);
  return new Date(ms).toISOString();
}

/** "Bez przypomnień do…": a moment ahead, within the plan's reach. */
export function parsePauseUntil(value: unknown, now: Date): string {
  return parsePlannedAt(value, now);
}
