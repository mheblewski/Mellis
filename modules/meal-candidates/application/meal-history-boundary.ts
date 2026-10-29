/**
 * Meal history epoch (meal-history-epoch.v1): the audited boundary from which meals are kept as caregiver-verified
 * history. Stored per patient in meal_history_epochs (migration 027), created with scripts/create-meal-history-epoch.ts.
 * Meals are no longer collected automatically: each one starts from a loop action the caregiver (or the chat) says is
 * a meal (postgres-loop-actions.repository.ts createMeal), or from an entry detached out of a meal.
 */

/** The meal identity scheme of the epoch (meal:<version>:<epoch>:<anchor>); the version is part of every identity. */
export const NEW_MEAL_ASSIGNMENT_POLICY = {
  version: 'new-meal-assignment.v1',
} as const;

export type NewMealAssignmentPolicy = {
  version: string;
};
