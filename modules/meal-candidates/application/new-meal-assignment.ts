import { NEW_MEAL_ASSIGNMENT_POLICY, type NewMealAssignmentPolicy } from './meal-history-boundary';

/**
 * Identity of a meal record (new-meal-assignment.v1): fixed when the meal starts from its anchor carb entry and never
 * changed. meal_records_identity_derived (migration 027) checks the same formula.
 */
export function buildNewMealId(epochId: string, anchorEventId: string, policy: NewMealAssignmentPolicy = NEW_MEAL_ASSIGNMENT_POLICY): string {
  return `meal:${policy.version}:${epochId}:${anchorEventId}`;
}
