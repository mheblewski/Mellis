import { isTrustedMealRecord, type MealRecordStatus } from '@modules/meal-candidates/application/meal-record-trust';
import { describeMealItems, itemsMatchTotals, sanitizeMealItems, sumMealItems, type MealItem } from '@modules/meal-candidates/application/meal-items';
import { fatProteinUnitsOf } from '@modules/meal-wbt/application/wbt-policy';
import {
  assignmentProblem,
  carbKindForPurpose,
  isLoopActionPurpose,
  localTime,
  type LoopActionPurpose,
} from '@modules/loop-actions/application/loop-action-policy';
import { LOOP_ACTION_TIME_ZONE, mealLabel } from '@modules/loop-actions/application/loop-action-views';

/**
 * Meal changes prepared in a conversation (conversation-meal-actions.v1, the conversation-meal-actions plan).
 * Pure. The AI asks for a change; this decides whether it is possible, what the meal looks like before and after, what
 * the caregiver must be warned about and whether "Cofnij" can restore it. Nothing here writes: the change is applied
 * only when a caregiver confirms its card (PROPOSE != EXECUTE, AI_CONTRACT.md §4).
 */

const MEAL_ACTION_POLICY_VERSION = 'conversation-meal-actions.v1';

export const MEAL_ACTION_OPERATIONS = ['REPLACE_CONTENT', 'UPDATE_MACROS', 'UPDATE_DESCRIPTION', 'SET_PURPOSE', 'DETACH_ENTRY', 'SET_WBT_REMINDER'] as const;
export type MealActionOperation = (typeof MEAL_ACTION_OPERATIONS)[number];

export type MealActionStatus = 'PROPOSED' | 'APPLYING' | 'APPLIED' | 'REJECTED' | 'SUPERSEDED' | 'STALE' | 'DISCARDED' | 'UNDONE';

export type CarbKind = 'MEAL' | 'CORRECTION_CARBS' | 'HYPO_TREATMENT' | 'IGNORED' | 'FAT_PROTEIN_UNITS';

/** A meal as the change sees it; macros are what the meals tab shows (an AI proposal for AI_PROPOSED). */
export interface MealActionMealState {
  meal_id: string;
  started_at: string;
  status: MealRecordStatus;
  description: string | null;
  items: MealItem[] | null;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  content_revision: number;
  /** Carbs the loop was told (the meal's carb entries in Nightscout); never changed here. */
  loop_carbs_g: number | null;
  /** The meal's WBT reminder, null when there is none. */
  wbt_reminder_enabled: boolean | null;
}

/** A carb entry and/or bolus from the loop: a loop action (loop-actions.v1) or an older carb entry without one. */
export interface MealActionEntryState {
  carb_event_id: string | null;
  loop_action_id: string | null;
  occurred_at: string;
  carbs_g: number | null;
  bolus_units: number | null;
  /** carb_entry_kinds of the carb entry (MEAL when none). */
  kind: CarbKind;
  /** The loop action's answer; null when unanswered or for an entry without a loop action. */
  purpose: LoopActionPurpose | null;
  purpose_meal_id: string | null;
  purpose_meal_label: string | null;
  /** The meal the carb entry belongs to (as its first entry or joined), if any. */
  meal: {
    meal_id: string;
    label: string;
    is_anchor: boolean;
    entry_count: number;
    /** It has a description, items or values the caregiver would lose. */
    has_content: boolean;
    /** Loop actions that added to it (add-ons, WBT): a meal with them cannot be removed. */
    dependants: number;
    /** Later doses still planned for it, or card commands that made it: a meal with them cannot be removed. */
    planned_doses?: number;
  } | null;
}

/** One loop entry in the list the AI picks from (get_meals): a carb entry and/or a loop action. */
export interface MealActionCatalogEntry {
  carb_event_id: string | null;
  loop_action_id: string | null;
  occurred_at: string;
  carbs_g: number | null;
  bolus_units: number | null;
  kind: CarbKind;
  purpose: LoopActionPurpose | null;
  purpose_meal_id: string | null;
  /** The meal the carb entry belongs to (as its first entry or joined). */
  meal_id: string | null;
}

export interface MealActionTargetMeal {
  meal_id: string;
  label: string;
  status: MealRecordStatus;
}

export type MealActionRequest =
  | { operation: 'REPLACE_CONTENT'; meal_id: string; items: unknown; description?: string | null }
  | { operation: 'UPDATE_MACROS'; meal_id: string; carbs_g?: number | null; protein_g?: number | null; fat_g?: number | null }
  | { operation: 'UPDATE_DESCRIPTION'; meal_id: string; description: string }
  | {
    operation: 'SET_PURPOSE';
    carb_event_id?: string | null;
    loop_action_id?: string | null;
    purpose: unknown;
    target_meal_id?: string | null;
    /** NEW_MEAL only: what the new meal was (items, or values with a description); saved with it on "Zatwierdź". */
    items?: unknown;
    description?: string | null;
    carbs_g?: number | null;
    protein_g?: number | null;
    fat_g?: number | null;
  }
  | { operation: 'DETACH_ENTRY'; meal_id: string; carb_event_id: string }
  | { operation: 'SET_WBT_REMINDER'; meal_id: string; enabled: boolean };

export interface MealActionWarning {
  code: 'LOOP_CARBS_DIFFER' | 'MEAL_WILL_BE_DELETED' | 'ITEMS_DROPPED' | 'MEAL_ENTRIES_SPLIT' | 'MEAL_HIDDEN' | 'NOT_UNDOABLE';
  message: string;
}

/** Content of a meal shown on the card ("było" and "będzie"). */
export interface MealContentView {
  description: string | null;
  items: MealItem[] | null;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  fat_protein_units: number | null;
}

export interface MealPurposeView {
  purpose: LoopActionPurpose | null;
  carb_kind: CarbKind;
  meal_id: string | null;
  label: string;
}

export type MealActionBefore =
  | ({ kind: 'CONTENT'; status: MealRecordStatus } & MealContentView)
  | ({ kind: 'PURPOSE' } & MealPurposeView)
  | { kind: 'MEMBERSHIP'; meal_id: string; label: string }
  | { kind: 'WBT_REMINDER'; enabled: boolean | null };

export interface MealContentEdit {
  description?: string | null;
  items?: MealItem[] | null;
  macros?: { carbs_g: number | null; protein_g: number | null; fat_g: number | null };
}

export type MealActionAfter =
  | ({ kind: 'CONTENT' } & MealContentView & { edit: MealContentEdit })
  /** `content`: a loop entry made a meal of its own together with what was eaten (written to the new meal). */
  | ({ kind: 'PURPOSE' } & MealPurposeView & { content?: MealContentView & { edit: MealContentEdit } })
  | { kind: 'MEMBERSHIP'; meal_id: null; label: string }
  | { kind: 'WBT_REMINDER'; enabled: boolean };

export interface BuiltMealAction {
  operation: MealActionOperation;
  meal_record_id: string | null;
  carb_event_id: string | null;
  loop_action_id: string | null;
  before: MealActionBefore;
  payload: { title: string; after: MealActionAfter; undoable: boolean; policy_version: string };
  warnings: MealActionWarning[];
  /** Revision of the meal the change was prepared on (content changes); applying refuses a newer meal. */
  base_content_revision: number | null;
}

export type MealActionBuildResult = { ok: true; action: BuiltMealAction } | { ok: false; code: 'INVALID' | 'NO_CHANGE'; problem: string };

export interface MealActionBuildInput {
  request: MealActionRequest;
  meal?: MealActionMealState | null;
  entry?: MealActionEntryState | null;
  target_meal?: MealActionTargetMeal | null;
  time_zone?: string;
}

const PURPOSE_LABELS: Record<LoopActionPurpose, string> = {
  NEW_MEAL: 'osobny posiłek',
  MEAL_ADDITION: 'dokładka',
  WBT: 'WBT',
  CORRECTION: 'węgle korekcyjne',
  PRE_BOLUS: 'bolus przed posiłkiem',
  HYPO_TREATMENT: 'leczenie hipo',
  IGNORED: 'usunięty wpis',
};

const KIND_LABELS: Record<CarbKind, string> = {
  MEAL: 'posiłek',
  CORRECTION_CARBS: 'węgle korekcyjne',
  HYPO_TREATMENT: 'leczenie hipo',
  IGNORED: 'usunięty wpis',
  FAT_PROTEIN_UNITS: 'WBT',
};

/** Purposes an older carb entry (no loop action) can be given, as carb entry kinds. */
const LEGACY_PURPOSE_KINDS: Partial<Record<LoopActionPurpose, CarbKind>> = {
  NEW_MEAL: 'MEAL',
  CORRECTION: 'CORRECTION_CARBS',
  HYPO_TREATMENT: 'HYPO_TREATMENT',
  WBT: 'FAT_PROTEIN_UNITS',
  IGNORED: 'IGNORED',
};

const formatGrams = (value: number) => `${(Math.round(value * 10) / 10).toString().replace('.', ',')} g`;

function invalid(problem: string): MealActionBuildResult {
  return { ok: false, code: 'INVALID', problem };
}

function noChange(problem: string): MealActionBuildResult {
  return { ok: false, code: 'NO_CHANGE', problem };
}

function contentView(meal: Pick<MealActionMealState, 'description' | 'items' | 'carbs_g' | 'protein_g' | 'fat_g'>): MealContentView {
  return {
    description: meal.description,
    items: meal.items,
    carbs_g: meal.carbs_g,
    protein_g: meal.protein_g,
    fat_g: meal.fat_g,
    fat_protein_units: meal.protein_g === null && meal.fat_g === null ? null : fatProteinUnitsOf(meal.protein_g, meal.fat_g),
  };
}

function sameContent(a: MealContentView, b: MealContentView): boolean {
  return (a.description ?? '') === (b.description ?? '')
    && JSON.stringify(a.items ?? null) === JSON.stringify(b.items ?? null)
    && a.carbs_g === b.carbs_g && a.protein_g === b.protein_g && a.fat_g === b.fat_g;
}

function editableMealProblem(meal: MealActionMealState): string | null {
  if (meal.status === 'CANCELLED') return 'this meal was cancelled and cannot be edited';
  return null;
}

/** The loop was told a different amount of carbs: shown so the caregiver can decide about a correction. */
function loopCarbsWarning(meal: MealActionMealState, carbs: number | null): MealActionWarning | null {
  if (meal.loop_carbs_g === null || carbs === null) return null;
  const difference = carbs - meal.loop_carbs_g;
  if (Math.abs(difference) < Math.max(5, meal.loop_carbs_g * 0.1)) return null;
  const direction = difference > 0 ? 'więcej' : 'mniej';
  return {
    code: 'LOOP_CARBS_DIFFER',
    message: `Pętla dostała ${formatGrams(meal.loop_carbs_g)} węglowodanów, a zjedzone to ${formatGrams(carbs)} (${formatGrams(Math.abs(difference))} ${direction}). Wpisu w pętli to nie zmienia.`,
  };
}

const NOT_UNDOABLE: MealActionWarning = { code: 'NOT_UNDOABLE', message: 'Tej zmiany nie da się cofnąć jednym przyciskiem.' };

function contentAction(
  meal: MealActionMealState,
  operation: 'REPLACE_CONTENT' | 'UPDATE_MACROS' | 'UPDATE_DESCRIPTION',
  edit: { description?: string | null; items?: MealItem[] | null; macros?: { carbs_g: number | null; protein_g: number | null; fat_g: number | null } },
  title: string,
  warnings: MealActionWarning[],
): MealActionBuildResult {
  const before = contentView(meal);
  const values = edit.macros ?? { carbs_g: meal.carbs_g, protein_g: meal.protein_g, fat_g: meal.fat_g };
  const items = edit.items !== undefined
    ? edit.items
    : edit.macros
      ? (meal.items && itemsMatchTotals(meal.items, edit.macros) ? meal.items : null)
      : meal.items;
  const after = contentView({
    description: edit.description !== undefined ? edit.description : meal.description,
    items,
    ...values,
  });
  if (sameContent(before, after) && (!edit.macros || isTrustedMealRecord(meal))) {
    return noChange('the meal already looks like this');
  }
  if (meal.items && items === null && edit.items === undefined) {
    warnings.push({ code: 'ITEMS_DROPPED', message: 'Lista składników zostanie usunięta, bo nie zgadza się z nowymi wartościami.' });
  }
  const carbsWarning = loopCarbsWarning(meal, after.carbs_g);
  if (carbsWarning && after.carbs_g !== before.carbs_g) warnings.push(carbsWarning);
  // "Cofnij" restores the caregiver's previous values; an unconfirmed meal has none to go back to.
  const undoable = operation === 'UPDATE_DESCRIPTION' ? meal.description !== null : isTrustedMealRecord(meal);
  if (!undoable) warnings.push(NOT_UNDOABLE);
  return {
    ok: true,
    action: {
      operation,
      meal_record_id: meal.meal_id,
      carb_event_id: null,
      loop_action_id: null,
      before: { kind: 'CONTENT', status: meal.status, ...before },
      payload: { title, after: { kind: 'CONTENT', ...after, edit }, undoable, policy_version: MEAL_ACTION_POLICY_VERSION },
      warnings,
      base_content_revision: meal.content_revision,
    },
  };
}

function gramsValue(value: unknown, name: string): { value: number | null | undefined } | { problem: string } {
  if (value === undefined) return { value: undefined };
  if (value === null) return { value: null };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000) return { problem: `${name} must be a number between 0 and 1000` };
  return { value: Math.round(value * 10) / 10 };
}

/** How an entry's purpose reads on the card; an older entry (no loop action) is named by its kind. */
function purposeView(purpose: LoopActionPurpose | null, kind: CarbKind, mealId: string | null, mealLabelText: string | null, isLoopAction: boolean): MealPurposeView {
  const name = purpose ? PURPOSE_LABELS[purpose] : isLoopAction ? 'bez odpowiedzi' : KIND_LABELS[kind];
  return { purpose, carb_kind: kind, meal_id: mealId, label: mealLabelText && (purpose === 'MEAL_ADDITION' || purpose === 'WBT' || purpose === 'CORRECTION') ? `${name} do: ${mealLabelText}` : name };
}

function entryTitle(entry: MealActionEntryState, timeZone: string): string {
  const what = [
    entry.carbs_g !== null ? `${formatGrams(entry.carbs_g)} węglowodanów` : null,
    entry.bolus_units !== null ? `${(Math.round(entry.bolus_units * 100) / 100).toString().replace('.', ',')} j. bolusa` : null,
  ].filter(Boolean).join(' i ');
  return `Wpis z pętli o ${localTime(entry.occurred_at, timeZone)}${what ? ` (${what})` : ''}`;
}

/**
 * What a loop entry made a meal of its own was, when the request names it: the items (totals computed from them) or the
 * values, with an optional description. Null when nothing is named (the meal waits for a description, as before).
 */
function newMealContent(request: Extract<MealActionRequest, { operation: 'SET_PURPOSE' }>): { content: (MealContentView & { edit: MealContentEdit }) | null } | { problem: string } {
  const explicit = typeof request.description === 'string' ? request.description.replace(/\s+/g, ' ').trim() : '';
  if (explicit.length > 2000) return { problem: 'description must be at most 2000 characters' };
  if (Array.isArray(request.items) && request.items.length > 0) {
    const sanitized = sanitizeMealItems(request.items);
    if ('problem' in sanitized) return { problem: sanitized.problem };
    const edit: MealContentEdit = { description: explicit || describeMealItems(sanitized.items), items: sanitized.items, macros: sumMealItems(sanitized.items) };
    return { content: { ...contentView({ description: edit.description!, items: sanitized.items, ...edit.macros! }), edit } };
  }
  const carbs = gramsValue(request.carbs_g ?? undefined, 'carbs_g');
  const protein = gramsValue(request.protein_g ?? undefined, 'protein_g');
  const fat = gramsValue(request.fat_g ?? undefined, 'fat_g');
  for (const value of [carbs, protein, fat]) if ('problem' in value) return { problem: value.problem };
  const given = (value: typeof carbs) => ('value' in value ? value.value ?? null : null);
  const macros = { carbs_g: given(carbs), protein_g: given(protein), fat_g: given(fat) };
  const hasValues = macros.carbs_g !== null || macros.protein_g !== null || macros.fat_g !== null;
  if (!hasValues && !explicit) return { content: null };
  const edit: MealContentEdit = hasValues ? { description: explicit || null, items: null, macros } : { description: explicit };
  return { content: { ...contentView({ description: explicit || null, items: null, ...macros }), edit } };
}

/** "Pół croissanta (W 13 g · B 2,5 g · T 6 g)" for the card's line. */
function contentLabel(view: MealContentView): string {
  const grams = (value: number | null) => (value === null ? '?' : formatGrams(value));
  const values = view.carbs_g === null && view.protein_g === null && view.fat_g === null
    ? null
    : `W ${grams(view.carbs_g)} · B ${grams(view.protein_g)} · T ${grams(view.fat_g)}`;
  if (view.description && values) return `${view.description} (${values})`;
  return view.description ?? values ?? '';
}

function purposeAction(input: MealActionBuildInput, request: Extract<MealActionRequest, { operation: 'SET_PURPOSE' }>, timeZone: string): MealActionBuildResult {
  const entry = input.entry;
  if (!entry) return invalid('the loop entry was not found');
  if (!isLoopActionPurpose(request.purpose)) return invalid('purpose must be NEW_MEAL, MEAL_ADDITION, WBT, CORRECTION, PRE_BOLUS, HYPO_TREATMENT or IGNORED');
  const purpose = request.purpose;
  const targetMealId = request.target_meal_id ?? null;
  const target = input.target_meal ?? null;
  if (targetMealId && (!target || target.meal_id !== targetMealId)) return invalid('the meal named for this entry was not found');
  if (target && target.status === 'CANCELLED') return invalid('the meal named for this entry was cancelled');
  const warnings: MealActionWarning[] = [];
  const title = entryTitle(entry, timeZone);

  if (entry.loop_action_id) {
    const problem = assignmentProblem(purpose, targetMealId, entry.carb_event_id !== null, entry.bolus_units !== null);
    if (problem) return invalid(problem);
    if (entry.purpose === purpose && (entry.purpose_meal_id ?? null) === targetMealId) return noChange('the entry already has this purpose');
    if (entry.purpose === 'NEW_MEAL' && purpose === 'NEW_MEAL') return noChange('the entry already is a meal of its own');
    // Taking back a meal (or making one) removes or creates a meal record: its description could be lost, so no undo.
    let undoable = entry.purpose !== 'NEW_MEAL' && purpose !== 'NEW_MEAL';
    if (entry.purpose === 'NEW_MEAL' && entry.meal) {
      if (targetMealId === entry.meal.meal_id) return invalid('an entry cannot be added to the meal it started');
      if (entry.meal.dependants > 0) return invalid('other entries (add-ons or WBT) were added to this meal; they must be moved first');
      if ((entry.meal.planned_doses ?? 0) > 0) return invalid('this meal has a later dose still planned or was sent to the loop from a card; the planned dose must be skipped first, and a meal sent from a card stays');
      warnings.push({
        code: 'MEAL_WILL_BE_DELETED',
        message: entry.meal.has_content
          ? `Posiłek „${entry.meal.label}” zostanie usunięty razem z opisem i wartościami.`
          : `Posiłek „${entry.meal.label}” zostanie usunięty.`,
      });
      undoable = false;
    }
    let content: (MealContentView & { edit: MealContentEdit }) | null = null;
    if (purpose === 'NEW_MEAL') {
      const named = newMealContent(request);
      if ('problem' in named) return invalid(named.problem);
      content = named.content;
      if (content && entry.carbs_g !== null && content.carbs_g !== null) {
        const difference = content.carbs_g - entry.carbs_g;
        if (Math.abs(difference) >= Math.max(5, entry.carbs_g * 0.1)) {
          warnings.push({
            code: 'LOOP_CARBS_DIFFER',
            message: `Pętla dostała ${formatGrams(entry.carbs_g)} węglowodanów, a zjedzone to ${formatGrams(content.carbs_g)} (${formatGrams(Math.abs(difference))} ${difference > 0 ? 'więcej' : 'mniej'}). Wpisu w pętli to nie zmienia.`,
          });
        }
      }
    }
    if (!undoable) warnings.push(NOT_UNDOABLE);
    const after = purposeView(purpose, entry.carb_event_id ? carbKindForPurpose(purpose) : entry.kind, targetMealId, target?.label ?? null, true);
    return {
      ok: true,
      action: {
        operation: 'SET_PURPOSE',
        meal_record_id: targetMealId,
        carb_event_id: entry.carb_event_id,
        loop_action_id: entry.loop_action_id,
        before: { kind: 'PURPOSE', ...purposeView(entry.purpose, entry.kind, entry.purpose_meal_id, entry.purpose_meal_label, true) },
        payload: {
          title,
          after: content
            ? { kind: 'PURPOSE', ...after, label: `${after.label}: ${contentLabel(content)}`, content }
            : { kind: 'PURPOSE', ...after },
          undoable,
          policy_version: MEAL_ACTION_POLICY_VERSION,
        },
        warnings,
        base_content_revision: null,
      },
    };
  }

  // An older carb entry without a loop action: only its kind can change (the meal it joined is kept as it was).
  if (!entry.carb_event_id) return invalid('the loop entry has no carb entry');
  const kind = LEGACY_PURPOSE_KINDS[purpose];
  if (!kind) return invalid(`${purpose} is only possible for loop entries made after loop actions started`);
  if (kind === entry.kind) return noChange('the entry already has this purpose');
  let undoable = true;
  if (kind !== 'MEAL' && entry.meal?.is_anchor) {
    if (entry.meal.entry_count > 1) {
      warnings.push({ code: 'MEAL_ENTRIES_SPLIT', message: `Pozostałe wpisy posiłku „${entry.meal.label}” staną się osobnym posiłkiem.` });
      undoable = false;
    } else if (entry.meal.has_content) {
      warnings.push({ code: 'MEAL_HIDDEN', message: `Posiłek „${entry.meal.label}” zniknie z listy posiłków.` });
    }
  }
  if (!undoable) warnings.push(NOT_UNDOABLE);
  return {
    ok: true,
    action: {
      operation: 'SET_PURPOSE',
      meal_record_id: entry.meal?.meal_id ?? null,
      carb_event_id: entry.carb_event_id,
      loop_action_id: null,
      before: { kind: 'PURPOSE', ...purposeView(null, entry.kind, null, null, false) },
      payload: { title, after: { kind: 'PURPOSE', ...purposeView(null, kind, null, null, false) }, undoable, policy_version: MEAL_ACTION_POLICY_VERSION },
      warnings,
      base_content_revision: null,
    },
  };
}

/** Decides whether the requested change is possible and builds its card; never writes. */
export function buildMealActionProposal(input: MealActionBuildInput): MealActionBuildResult {
  const { request } = input;
  const timeZone = input.time_zone ?? LOOP_ACTION_TIME_ZONE;
  if (request.operation === 'SET_PURPOSE') return purposeAction(input, request, timeZone);

  const meal = input.meal;
  if (!meal || meal.meal_id !== request.meal_id) return invalid('the meal was not found');
  const label = mealLabel(meal.description, meal.started_at, timeZone);
  const at = localTime(meal.started_at, timeZone);

  switch (request.operation) {
    case 'REPLACE_CONTENT': {
      const problem = editableMealProblem(meal);
      if (problem) return invalid(problem);
      const sanitized = sanitizeMealItems(request.items);
      if ('problem' in sanitized) return invalid(sanitized.problem);
      const explicit = typeof request.description === 'string' ? request.description.replace(/\s+/g, ' ').trim() : '';
      if (explicit.length > 2000) return invalid('description must be at most 2000 characters');
      const description = explicit || describeMealItems(sanitized.items);
      return contentAction(meal, 'REPLACE_CONTENT', { description, items: sanitized.items, macros: sumMealItems(sanitized.items) }, `Zmiana posiłku · ${label} (${at})`, []);
    }
    case 'UPDATE_MACROS': {
      const problem = editableMealProblem(meal);
      if (problem) return invalid(problem);
      const carbs = gramsValue(request.carbs_g, 'carbs_g');
      const protein = gramsValue(request.protein_g, 'protein_g');
      const fat = gramsValue(request.fat_g, 'fat_g');
      for (const value of [carbs, protein, fat]) if ('problem' in value) return invalid(value.problem);
      const given = (value: typeof carbs) => ('value' in value ? value.value : undefined);
      if (given(carbs) === undefined && given(protein) === undefined && given(fat) === undefined) {
        return invalid('at least one of carbs_g, protein_g or fat_g is required');
      }
      // Values not named keep what the meal has, so "fat was 20 g" does not erase the carbs.
      const macros = {
        carbs_g: given(carbs) === undefined ? meal.carbs_g : given(carbs)!,
        protein_g: given(protein) === undefined ? meal.protein_g : given(protein)!,
        fat_g: given(fat) === undefined ? meal.fat_g : given(fat)!,
      };
      if (macros.carbs_g === null && macros.protein_g === null && macros.fat_g === null) return invalid('the meal would have no values');
      return contentAction(meal, 'UPDATE_MACROS', { macros }, `Poprawka wartości · ${label} (${at})`, []);
    }
    case 'UPDATE_DESCRIPTION': {
      const problem = editableMealProblem(meal);
      if (problem) return invalid(problem);
      const description = typeof request.description === 'string' ? request.description.replace(/\s+/g, ' ').trim() : '';
      if (!description || description.length > 2000) return invalid('description must be 1-2000 characters');
      return contentAction(meal, 'UPDATE_DESCRIPTION', { description }, `Zmiana opisu · ${label} (${at})`, []);
    }
    case 'DETACH_ENTRY': {
      const entry = input.entry;
      if (!entry || entry.carb_event_id !== request.carb_event_id || entry.meal?.meal_id !== meal.meal_id) return invalid('the entry is not part of this meal');
      if (entry.loop_action_id) return invalid('a loop entry becomes a meal of its own with SET_PURPOSE NEW_MEAL');
      if (entry.meal.is_anchor) return invalid('the first entry of a meal cannot be taken out of it');
      return {
        ok: true,
        action: {
          operation: 'DETACH_ENTRY',
          meal_record_id: meal.meal_id,
          carb_event_id: entry.carb_event_id,
          loop_action_id: null,
          before: { kind: 'MEMBERSHIP', meal_id: meal.meal_id, label: `część posiłku: ${label}` },
          payload: { title: entryTitle(entry, timeZone), after: { kind: 'MEMBERSHIP', meal_id: null, label: 'osobny posiłek' }, undoable: false, policy_version: MEAL_ACTION_POLICY_VERSION },
          warnings: [NOT_UNDOABLE],
          base_content_revision: null,
        },
      };
    }
    case 'SET_WBT_REMINDER': {
      if (typeof request.enabled !== 'boolean') return invalid('enabled must be true or false');
      if (meal.wbt_reminder_enabled === request.enabled) return noChange(request.enabled ? 'the WBT reminder is already on' : 'the WBT reminder is already off');
      const undoable = meal.wbt_reminder_enabled !== null;
      return {
        ok: true,
        action: {
          operation: 'SET_WBT_REMINDER',
          meal_record_id: meal.meal_id,
          carb_event_id: null,
          loop_action_id: null,
          before: { kind: 'WBT_REMINDER', enabled: meal.wbt_reminder_enabled },
          payload: { title: `Przypomnienie o WBT · ${label} (${at})`, after: { kind: 'WBT_REMINDER', enabled: request.enabled }, undoable, policy_version: MEAL_ACTION_POLICY_VERSION },
          warnings: undoable ? [] : [NOT_UNDOABLE],
          base_content_revision: null,
        },
      };
    }
  }
}

/**
 * The change that restores what a confirmed change replaced ("Cofnij"), or null when it cannot. It is applied with the
 * same guards: refused when the meal or entry changed again after the change was confirmed.
 */
export function buildUndoRequest(operation: MealActionOperation, before: MealActionBefore, after: MealActionAfter): MealActionUndo | null {
  if (before.kind === 'CONTENT' && after.kind === 'CONTENT') {
    if (operation === 'UPDATE_DESCRIPTION') return before.description === null ? null : { kind: 'CONTENT', edit: { description: before.description } };
    if (!isTrustedMealRecord(before)) return null;
    return {
      kind: 'CONTENT',
      edit: {
        description: before.description,
        items: before.items,
        macros: { carbs_g: before.carbs_g, protein_g: before.protein_g, fat_g: before.fat_g },
      },
    };
  }
  if (before.kind === 'PURPOSE' && after.kind === 'PURPOSE') {
    return { kind: 'PURPOSE', purpose: before.purpose, carb_kind: before.carb_kind, meal_id: before.meal_id, expected_purpose: after.purpose, expected_meal_id: after.meal_id, expected_carb_kind: after.carb_kind };
  }
  if (before.kind === 'WBT_REMINDER' && after.kind === 'WBT_REMINDER') {
    return before.enabled === null ? null : { kind: 'WBT_REMINDER', enabled: before.enabled };
  }
  return null;
}

export type MealActionUndo =
  | { kind: 'CONTENT'; edit: { description?: string | null; items?: MealItem[] | null; macros?: { carbs_g: number | null; protein_g: number | null; fat_g: number | null } } }
  | { kind: 'PURPOSE'; purpose: LoopActionPurpose | null; carb_kind: CarbKind; meal_id: string | null; expected_purpose: LoopActionPurpose | null; expected_meal_id: string | null; expected_carb_kind: CarbKind }
  | { kind: 'WBT_REMINDER'; enabled: boolean };
