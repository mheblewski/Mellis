import type { JournalReminder } from './meal-journal';

/**
 * "Scal" in the Meals tab (meal-merge.v1, owner 2026-11-01): several meals of the journal become one. Pure: the API
 * reads the meals, this file decides which one the others join and what the merged meal keeps, and the repository
 * moves the rows.
 *
 * - Content (a description, values, items or a photo): when exactly one meal has it, the merged meal keeps it, its carbs
 *   grown by the other meals' carbs; when several have their own, it is reset and the caregiver enters it again (the
 *   app asks first); when none has any, there is nothing to keep.
 * - A split meal (a later part or second dose still to come): with one, the caregiver keeps its plan or goes to the
 *   chat for a new split (the app asks); with more than one, the merge is refused (two plans cannot become one).
 * - WBT: the meals' WBT suggestions are dropped, so the next one is worked out from the whole merged meal.
 */

export const MEAL_MERGE_POLICY = {
  version: 'meal-merge.v1',
  min_meals: 2,
  max_meals: 8,
  /**
   * Meals further apart than this are not one meal (owner 2026-11-01): the meal page's chart covers this much, and no
   * meal's boluses are given over a longer time.
   */
  max_span_hours: 4,
} as const;

export interface MergeCandidate {
  meal_id: string;
  started_at: string;
  /** A description, values (confirmed or an AI proposal), items or a photo of its own. */
  has_content: boolean;
  /** A later part or a second dose still to come (waiting or due now). */
  split_open: boolean;
  /** The loop's carb entries of the meal (what it adds to a kept meal's carbs). */
  source_carbs_g: number | null;
}

export type MergeContent = 'NONE' | 'KEPT' | 'RESET';
export type MergeSplitChoice = 'KEEP' | 'RESPLIT';

export type MergeRefusalCode = 'MEAL_MERGE_TOO_FEW' | 'MEAL_MERGE_TOO_MANY' | 'MEAL_MERGE_TOO_FAR_APART' | 'MEAL_MERGE_SEVERAL_SPLIT';

export type MergePlan =
  | {
    ok: true;
    /** The meal the others join (it keeps its id). */
    target_id: string;
    /** The others, deleted once their rows moved. */
    source_ids: string[];
    content: MergeContent;
    /** The one meal whose content is kept (KEPT only). */
    content_meal_id: string | null;
    /** The one split meal (it is the target), or null. */
    split_meal_id: string | null;
    /**
     * Grams added to carbs stored on the kept meal (the content meal, else the target), when it has stored ones: the
     * other meals' carb entries. Carbs read from the loop's entries need nothing (the entries move).
     */
    added_carbs_g: number;
  }
  | { ok: false; code: MergeRefusalCode; message: string };

export const MEAL_MERGE_MESSAGES: Record<MergeRefusalCode, string> = {
  MEAL_MERGE_TOO_FEW: 'Zaznacz co najmniej dwa posiłki, żeby je scalić.',
  MEAL_MERGE_TOO_MANY: `Naraz można scalić najwyżej ${MEAL_MERGE_POLICY.max_meals} posiłków.`,
  MEAL_MERGE_TOO_FAR_APART: `Scalić można tylko posiłki, które zmieszczą się w ${MEAL_MERGE_POLICY.max_span_hours} godzinach. Między pierwszym a ostatnim z zaznaczonych posiłków minęło więcej czasu.`,
  MEAL_MERGE_SEVERAL_SPLIT: 'Więcej niż jeden z zaznaczonych posiłków ma rozłożony bolus z kolejną częścią do podania. Takich posiłków nie można scalić. Najpierw pomiń kolejne części we wszystkich posiłkach poza jednym.',
};

/** Ids as given, without repeats (a double tap must not count a meal twice). */
export function parseMergeMealIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) return null;
  return [...new Set(raw as string[])];
}

export function parseSplitChoice(raw: unknown): MergeSplitChoice | null | 'INVALID' {
  if (raw === undefined || raw === null) return null;
  return raw === 'KEEP' || raw === 'RESPLIT' ? raw : 'INVALID';
}

interface MealContentFacts {
  description: string | null;
  has_photo: boolean;
  items?: unknown[] | null;
  macros: Record<'carbs' | 'protein' | 'fat', { grams: number | null; origin: string | null }>;
}

/**
 * The meal has content of its own: a description, a photo, items, or values a caregiver or the AI gave. Carbs only
 * copied from the loop's entry (NIGHTSCOUT_ENTRY) are the loop's, not content.
 */
export function mealHasContent(record: MealContentFacts): boolean {
  if (record.description?.trim() || record.has_photo || (record.items?.length ?? 0) > 0) return true;
  return Object.values(record.macros).some((value) => value.grams !== null && value.origin !== null && value.origin !== 'NIGHTSCOUT_ENTRY');
}

/** A later part or second dose still to come: the meal's bolus is split. */
export function hasOpenSplit(reminders: Pick<JournalReminder, 'kind' | 'status'>[]): boolean {
  return reminders.some((reminder) => (reminder.kind === 'PLANNED_PART' || reminder.kind === 'SECOND_DOSE')
    && (reminder.status === 'WAITING' || reminder.status === 'DUE_NOW'));
}

export function planMealMerge(candidates: MergeCandidate[]): MergePlan {
  const refuse = (code: MergeRefusalCode): MergePlan => ({ ok: false, code, message: MEAL_MERGE_MESSAGES[code] });
  if (candidates.length < MEAL_MERGE_POLICY.min_meals) return refuse('MEAL_MERGE_TOO_FEW');
  if (candidates.length > MEAL_MERGE_POLICY.max_meals) return refuse('MEAL_MERGE_TOO_MANY');
  const byStart = [...candidates].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at) || a.meal_id.localeCompare(b.meal_id));
  const spanMs = Date.parse(byStart[byStart.length - 1].started_at) - Date.parse(byStart[0].started_at);
  if (spanMs > MEAL_MERGE_POLICY.max_span_hours * 3_600_000) return refuse('MEAL_MERGE_TOO_FAR_APART');
  const split = byStart.filter((meal) => meal.split_open);
  if (split.length > 1) return refuse('MEAL_MERGE_SEVERAL_SPLIT');

  const withContent = byStart.filter((meal) => meal.has_content);
  const content: MergeContent = withContent.length === 0 ? 'NONE' : withContent.length === 1 ? 'KEPT' : 'RESET';
  const contentMeal = content === 'KEPT' ? withContent[0] : null;
  // The split meal keeps its id (its plan and pushes point at it); else the one whose content stays; else the earliest.
  const target = split[0] ?? contentMeal ?? byStart[0];
  const kept = contentMeal ?? target;
  const addedCarbs = content === 'RESET'
    ? 0
    : byStart.filter((meal) => meal.meal_id !== kept.meal_id).reduce((sum, meal) => sum + (meal.source_carbs_g ?? 0), 0);
  return {
    ok: true,
    target_id: target.meal_id,
    source_ids: byStart.filter((meal) => meal.meal_id !== target.meal_id).map((meal) => meal.meal_id),
    content,
    content_meal_id: contentMeal?.meal_id ?? null,
    split_meal_id: split[0]?.meal_id ?? null,
    added_carbs_g: Math.round(addedCarbs * 10) / 10,
  };
}
