/**
 * Trust model for meal records (meal-record-trust.v1). Pure; the worker applies selectMealsForAiContext when it
 * builds time-range analysis context (see the meal-history-epoch-v1 design note).
 *
 * Only caregiver-confirmed or caregiver-corrected records are trusted history. An AI macro proposal is never
 * a fact until the caregiver accepts it: an unconfirmed meal keeps its observed Nightscout carbohydrates, and its
 * protein and fat are UNKNOWN, never zero and never reconstructed. Nothing here may be used as input for insulin dosing.
 */

import type { MealItem } from './meal-items';

const MEAL_RECORD_TRUST_VERSION = 'meal-record-trust.v1';

export type MealRecordStatus =
  /** New-history meal; the caregiver has not described it yet. */
  | 'AWAITING_DESCRIPTION'
  /** Caregiver text or photo stored; no macro proposal yet. */
  | 'DESCRIBED'
  /** AI proposed macros; pending caregiver review. */
  | 'AI_PROPOSED'
  /** Caregiver accepted the proposal unchanged. */
  | 'CONFIRMED'
  /** Caregiver entered or edited the values. */
  | 'CORRECTED'
  /** Caregiver said this was not a meal / dismissed it. */
  | 'CANCELLED'
  /** Review window closed without confirmation. */
  | 'INCOMPLETE';

export type MacroOrigin = 'NIGHTSCOUT_ENTRY' | 'AI_PROPOSAL' | 'CAREGIVER';

export interface MacroValue {
  grams: number | null;
  origin: MacroOrigin | null;
}

export interface MealRecord {
  meal_identity: string;
  status: MealRecordStatus;
  /** An entry or its source record has an ACTIVE evidence exclusion (resolved at read time, revocable). */
  evidence_excluded?: boolean;
  started_at: string;
  /** Sum of the meal's Nightscout carbohydrate entries: observed source data, independent of the status. */
  source_carbs_g: number | null;
  description: string | null;
  has_photo: boolean;
  /** Id of the unconfirmed AI proposal the caregiver must confirm (AI_PROPOSED only). */
  pending_proposal_id?: string | null;
  /** Current values; for AI_PROPOSED these are the unconfirmed proposal. */
  macros: { carbs: MacroValue; protein: MacroValue; fat: MacroValue };
  /** Counts caregiver content changes (042_live_updates.sql); a save may name it to be refused when outdated. */
  content_revision?: number;
  /** What the meal consisted of (043), when known: set with the values it adds up to, cleared when they diverge. */
  items?: MealItem[] | null;
}

const TRANSITIONS: Record<MealRecordStatus, readonly MealRecordStatus[]> = {
  AWAITING_DESCRIPTION: ['DESCRIBED', 'CORRECTED', 'CANCELLED', 'INCOMPLETE'],
  DESCRIBED: ['AI_PROPOSED', 'CORRECTED', 'CANCELLED', 'INCOMPLETE'],
  AI_PROPOSED: ['AI_PROPOSED', 'CONFIRMED', 'CORRECTED', 'CANCELLED', 'INCOMPLETE'],
  CONFIRMED: ['CORRECTED', 'CANCELLED'],
  CORRECTED: ['CORRECTED', 'CANCELLED'],
  CANCELLED: [],
  INCOMPLETE: ['DESCRIBED', 'CORRECTED', 'CANCELLED'],
};

export function canTransitionMealRecord(from: MealRecordStatus, to: MealRecordStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTrustedMealRecord(record: Pick<MealRecord, 'status'>): boolean {
  return record.status === 'CONFIRMED' || record.status === 'CORRECTED';
}

export type ContextKnowledgeStatus = 'KNOWN' | 'UNKNOWN' | 'MISSING';
export type ContextOrigin = 'OBSERVED' | 'REPORTED' | 'INFERRED';

export interface ContextMacro {
  value: number | null;
  knowledge_status: ContextKnowledgeStatus;
  origin: ContextOrigin | null;
  /** Unconfirmed AI proposal, kept apart from `value` so it is never read as a fact. */
  unconfirmed_proposal_g?: number;
  /** For caregiver-confirmed values: who produced the number (an accepted AI estimate stays distinguishable). */
  value_source?: MacroOrigin;
}

export interface MealContextItem {
  meal_identity: string;
  started_at: string;
  record_status: MealRecordStatus;
  trusted: boolean;
  description: string | null;
  source_carbs_g: number | null;
  carbs: ContextMacro;
  protein: ContextMacro;
  fat: ContextMacro;
}

const UNKNOWN_MACRO: ContextMacro = { value: null, knowledge_status: 'UNKNOWN', origin: null };

function trustedMacro(value: MacroValue): ContextMacro {
  if (value.grams === null || !Number.isFinite(value.grams)) return { ...UNKNOWN_MACRO };
  const known: ContextMacro = { value: value.grams, knowledge_status: 'KNOWN', origin: value.origin === 'NIGHTSCOUT_ENTRY' ? 'OBSERVED' : 'REPORTED' };
  return value.origin ? { ...known, value_source: value.origin } : known;
}

function proposedMacro(value: MacroValue): ContextMacro {
  if (value.grams === null || !Number.isFinite(value.grams)) return { ...UNKNOWN_MACRO };
  return { value: null, knowledge_status: 'UNKNOWN', origin: 'INFERRED', unconfirmed_proposal_g: value.grams };
}

function sourceCarbs(record: MealRecord): ContextMacro {
  return record.source_carbs_g === null ? { ...UNKNOWN_MACRO } : { value: record.source_carbs_g, knowledge_status: 'KNOWN', origin: 'OBSERVED' };
}

/** Context view of one meal record, or null when it must not reach AI context (cancelled or evidence-excluded). */
export function toMealContextItem(record: MealRecord): MealContextItem | null {
  if (record.status === 'CANCELLED' || record.evidence_excluded) return null;
  const base = {
    meal_identity: record.meal_identity,
    started_at: record.started_at,
    record_status: record.status,
    trusted: isTrustedMealRecord(record),
    source_carbs_g: record.source_carbs_g,
  };

  if (isTrustedMealRecord(record)) {
    return { ...base, description: record.description, carbs: trustedMacro(record.macros.carbs), protein: trustedMacro(record.macros.protein), fat: trustedMacro(record.macros.fat) };
  }
  if (record.status === 'AI_PROPOSED') {
    return { ...base, description: record.description, carbs: sourceCarbs(record), protein: proposedMacro(record.macros.protein), fat: proposedMacro(record.macros.fat) };
  }
  return {
    ...base,
    description: record.description,
    carbs: sourceCarbs(record),
    protein: { ...UNKNOWN_MACRO },
    fat: { ...UNKNOWN_MACRO },
  };
}

export interface MealContextSelection {
  policy_version: string;
  /** Caregiver-confirmed/corrected new-history meals: usable as facts. */
  trusted: MealContextItem[];
  /** New-history meals without confirmation: macros UNKNOWN, proposals flagged as unconfirmed. */
  unconfirmed: MealContextItem[];
  excluded_count: number;
}

export function selectMealsForAiContext(records: readonly MealRecord[]): MealContextSelection {
  const selection: MealContextSelection = { policy_version: MEAL_RECORD_TRUST_VERSION, trusted: [], unconfirmed: [], excluded_count: 0 };
  const ordered = [...records].sort((left, right) => left.started_at.localeCompare(right.started_at) || left.meal_identity.localeCompare(right.meal_identity));
  for (const record of ordered) {
    const item = toMealContextItem(record);
    if (!item) {
      selection.excluded_count += 1;
    } else if (item.trusted) {
      selection.trusted.push(item);
    } else {
      selection.unconfirmed.push(item);
    }
  }
  return selection;
}
