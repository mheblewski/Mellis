/**
 * "Do posiłku: …" on the Bolus tab's given card (meal-attach.v1, owner 2026-11-03): a dose saved as a meal, given less
 * than 3 hours after a bigger meal (more carbs or more insulin), is offered to join that meal (a second helping, the
 * dessert). Pure: the API reads the meals, this file picks the one, and the join itself is "Scal" (meal-merge.v1).
 */

export const MEAL_ATTACH_POLICY = {
  version: 'meal-attach.v1',
  /** How far back an earlier meal may have started. */
  window_hours: 3,
} as const;

export interface AttachMeal {
  meal_id: string;
  started_at: string;
  carbs_g: number | null;
  insulin_total_u: number | null;
}

/**
 * The newest journal meal that started within the window before `meal` and is bigger than it (more carbs or more
 * insulin; a missing value counts as none); null when there is none.
 */
export function pickAttachTarget(meal: AttachMeal, earlier: AttachMeal[]): AttachMeal | null {
  const start = Date.parse(meal.started_at);
  if (!Number.isFinite(start)) return null;
  const from = start - MEAL_ATTACH_POLICY.window_hours * 3_600_000;
  const carbs = meal.carbs_g ?? 0;
  const insulin = meal.insulin_total_u ?? 0;
  const bigger = earlier.filter((other) => {
    const at = Date.parse(other.started_at);
    if (other.meal_id === meal.meal_id || !Number.isFinite(at) || at <= from || at >= start) return false;
    return (other.carbs_g ?? 0) > carbs || (other.insulin_total_u ?? 0) > insulin;
  });
  return bigger.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0] ?? null;
}
