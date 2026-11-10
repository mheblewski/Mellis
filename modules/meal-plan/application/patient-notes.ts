import { ValidationError } from '@shared/errors/app-error';

/**
 * "Co Mellis pamięta" (meal-plan.v1, slice 3e): what caregivers asked to remember about a patient. A plan rule is applied
 * when a plan is read and named on its card; a food note only suggests at a later meal: nobody's note lowers a dose.
 */
export type PatientNoteKind = 'PLAN_RULE' | 'FOOD';
export type PatientNotePortion = 'NONE' | 'HALF';

export interface PatientNote {
  id: string;
  patient_id: string;
  kind: PatientNoteKind;
  text: string;
  food_name: string | null;
  portion: PatientNotePortion | null;
  created_by_name: string | null;
  created_at: string;
  /** Null: offered by the chat, not confirmed; nothing reads it. */
  confirmed_at: string | null;
  proposed_user_message_id: string | null;
}

export const MAX_PATIENT_NOTE_LENGTH = 200;

export function readNoteText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!text) throw new ValidationError('text is required');
  if (text.length > MAX_PATIENT_NOTE_LENGTH) throw new ValidationError(`text is longer than ${MAX_PATIENT_NOTE_LENGTH} characters`);
  return text;
}

/** A food note from a meal's page, with its words made here: "Zwykle zostaje na talerzu: Buraczki". */
export function parseFoodNote(body: unknown): { text: string; food_name: string; portion: PatientNotePortion } {
  const input = (body ?? {}) as Record<string, unknown>;
  const food = typeof input.food_name === 'string' ? input.food_name.trim() : '';
  if (!food || food.length > 80) throw new ValidationError('food_name must have 1-80 characters');
  if (input.portion !== 'NONE' && input.portion !== 'HALF') throw new ValidationError('portion must be NONE or HALF');
  return { food_name: food, portion: input.portion, text: `${input.portion === 'NONE' ? 'Zwykle zostaje na talerzu' : 'Zwykle zjada połowę'}: ${food}` };
}
