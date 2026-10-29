import type { AiRuntimeToolDefinition } from '@modules/ai-gateway/domain/ai-gateway';
import { localTime, isLoopActionPurpose } from '@modules/loop-actions/application/loop-action-policy';
import { LOOP_ACTION_TIME_ZONE } from '@modules/loop-actions/application/loop-action-views';
import { fatProteinUnitsOf } from '@modules/meal-wbt/application/wbt-policy';
import type { ConversationMealActionsService, MealActionRecord } from './conversation-meal-actions.service';
import {
  MEAL_ACTION_OPERATIONS,
  type MealActionCatalogEntry,
  type MealActionMealState,
  type MealActionOperation,
  type MealActionRequest,
} from './meal-action-policy';

/**
 * get_meals and propose_meal_change: the main chat's tools for the meals module (conversation-meal-actions.v1). The
 * model reads the patient's recent meals and loop entries by short handles (M…, E…) and prepares changes; the handles
 * are resolved here, so the model can only name a meal or entry it was shown. propose_meal_change never writes: it
 * stores a card the caregiver confirms in the app.
 */

export const GET_MEALS_TOOL_NAME = 'get_meals';
export const PROPOSE_MEAL_CHANGE_TOOL_NAME = 'propose_meal_change';
export const MEAL_ACTIONS_TOOL_POLICY_VERSION = 'meal-actions-tool.v1';
export const MAX_GET_MEALS_CALLS_PER_ANSWER = 2;
/** A change of the meal and, e.g., its WBT reminder or the entry of an add-on in one answer. */
export const MAX_PROPOSE_MEAL_CHANGE_CALLS_PER_ANSWER = 3;
const DEFAULT_DAYS_BACK = 2;
const MAX_DAYS_BACK = 7;

const NULLABLE_NUMBER = { type: ['number', 'null'] } as const;

export const GET_MEALS_TOOL_DEFINITION: AiRuntimeToolDefinition = {
  name: GET_MEALS_TOOL_NAME,
  description: `The patient's meals and loop entries of the last days (newest first), as the meals tab shows them: each meal with a handle (M…), time, status, description, items, carbohydrates/protein/fat, WBT, the carbs the loop was told and its entries; each loop entry with a handle (E…), time, carbs and bolus, and what it was for. Also the meal changes already prepared in this conversation and their state. Call it before any propose_meal_change.`,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      days_back: { type: ['integer', 'null'], description: `Days to list, 1-${MAX_DAYS_BACK} (null: ${DEFAULT_DAYS_BACK}). Today counts as day 1.` },
    },
    required: ['days_back'],
  },
};

export const PROPOSE_MEAL_CHANGE_TOOL_DEFINITION: AiRuntimeToolDefinition = {
  name: PROPOSE_MEAL_CHANGE_TOOL_NAME,
  description: 'Prepares one change of the meals module for the caregiver to confirm. Nothing is saved: the app shows a card with the change (before → after) and the buttons Zatwierdź / Popraw / Odrzuć. Returns PROPOSED with the card, INVALID with the problem, or NO_CHANGE.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      operation: {
        type: 'string',
        enum: [...MEAL_ACTION_OPERATIONS],
        description: 'REPLACE_CONTENT: the meal consisted of other food (new full item list; totals are computed from the items). UPDATE_MACROS: only some values change (others keep theirs). UPDATE_DESCRIPTION: only the name/description. SET_PURPOSE: what a loop entry was for. DETACH_ENTRY: a joined older entry was a separate meal. SET_WBT_REMINDER: WBT reminder on/off.',
      },
      meal: { type: ['string', 'null'], description: 'Handle of the meal (M…) for REPLACE_CONTENT, UPDATE_MACROS, UPDATE_DESCRIPTION, DETACH_ENTRY, SET_WBT_REMINDER; else null.' },
      entry: { type: ['string', 'null'], description: 'Handle of the loop entry (E…) for SET_PURPOSE and DETACH_ENTRY; else null.' },
      items: {
        type: ['array', 'null'],
        description: 'REPLACE_CONTENT, and SET_PURPOSE with NEW_MEAL: every item of the meal as eaten (the whole meal, not only what changed); else null.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            grams: NULLABLE_NUMBER,
            carbs_g: { type: 'number' },
            protein_g: { type: 'number' },
            fat_g: { type: 'number' },
            source: { type: 'string', enum: ['DIABCALC', 'ESTIMATE'] },
          },
          required: ['name', 'grams', 'carbs_g', 'protein_g', 'fat_g', 'source'],
        },
      },
      description: { type: ['string', 'null'], description: 'UPDATE_DESCRIPTION: the new description. REPLACE_CONTENT and SET_PURPOSE NEW_MEAL: optional short name (null: built from the items). Else null.' },
      carbs_g: { ...NULLABLE_NUMBER, description: 'UPDATE_MACROS: new carbohydrates in grams, null to keep. SET_PURPOSE NEW_MEAL without items: the meal\'s carbohydrates.' },
      protein_g: { ...NULLABLE_NUMBER, description: 'UPDATE_MACROS: new protein in grams, null to keep. SET_PURPOSE NEW_MEAL without items: the meal\'s protein.' },
      fat_g: { ...NULLABLE_NUMBER, description: 'UPDATE_MACROS: new fat in grams, null to keep. SET_PURPOSE NEW_MEAL without items: the meal\'s fat.' },
      purpose: {
        type: ['string', 'null'],
        enum: ['NEW_MEAL', 'MEAL_ADDITION', 'WBT', 'CORRECTION', 'PRE_BOLUS', 'HYPO_TREATMENT', 'IGNORED', null],
        description: 'SET_PURPOSE: NEW_MEAL (a meal of its own), MEAL_ADDITION (add-on to target_meal), WBT (fat-protein units for target_meal), CORRECTION (correction carbs / correction bolus, optionally after target_meal), PRE_BOLUS (bolus before a meal), HYPO_TREATMENT, IGNORED (delete the entry in Mellis). Else null.',
      },
      target_meal: { type: ['string', 'null'], description: 'SET_PURPOSE with MEAL_ADDITION, WBT or CORRECTION: handle of the meal (M…); else null.' },
      enabled: { type: ['boolean', 'null'], description: 'SET_WBT_REMINDER: true to remind, false not to; else null.' },
      reason: { type: 'string', description: 'One short Polish sentence for the card: what the caregiver said that this change follows.' },
    },
    required: ['operation', 'meal', 'entry', 'items', 'description', 'carbs_g', 'protein_g', 'fat_g', 'purpose', 'target_meal', 'enabled', 'reason'],
  },
};

export const MEAL_ACTIONS_INSTRUCTIONS = [
  'MEALS MODULE: in this reply you can read and change the patient\'s meals (this overrides any statement above that meals are not loaded or that you must not ask questions).',
  'When the caregiver says a meal was different, ate something else or only part of it, has other values, was not a meal (correction carbs, hypo treatment, WBT, an add-on, a duplicate to delete), or asks to switch a WBT reminder: call get_meals first and pick the meal or entry by its time and description. When two or more fit ("ostatni posiłek" with a meal and an add-on close together), ask which one, naming their times, and do not propose yet.',
  'For a different meal: recognise every component and its grams; look products up with search_food (one call with all components) and compute each item: value_per_100g × grams / 100, source DIABCALC or ESTIMATE. When the carbohydrates are uncertain by more than about 20% because a portion or amount is missing, ask one short question first. When the caregiver names the foods and their amounts, do not ask about details: take the typical plain product (plain pancakes, regular jam, ordinary bread) and say so in one phrase. Then call propose_meal_change with REPLACE_CONTENT and the whole meal as eaten. "Zjadł połowę" scales every item of the meal\'s items. A change of only some values is UPDATE_MACROS.',
  'A loop entry that was a meal of its own (SET_PURPOSE NEW_MEAL): when you know what was eaten (from this conversation or the caregiver), pass it in the same call: items (looked up or computed as above) and optionally description; without items, description with carbs_g/protein_g/fat_g. The meal is created and described in one step on "Zatwierdź"; a meal created without them waits for a description.',
  'propose_meal_change never saves anything. After PROPOSED, say in one or two sentences what the card changes (before → after, with W/B/T) and that it is saved only after "Zatwierdź" on the card. Never write that you saved, changed, deleted or updated something. When INVALID, fix the request if you can, otherwise tell the caregiver why it is not possible. Typed confirmations ("tak", "zapisz") do not save: point to the "Zatwierdź" button on the card.',
  'The loop\'s own entries (carbs entered in the loop app, boluses, times) are never changed by Mellis. When the eaten carbohydrates differ from what the loop was told, say so; a correction can be suggested only under the dosing rules, as something to consider.',
  'Never show handles (M…, E…), ids or tool names to the caregiver: name meals by time and description.',
].join('\n');

/** The port the AI gateway calls for the two tools; one session per answer. */
export interface MealActionsTools {
  /** True when the caregiver's message is about changing a meal (the answer then uses the main model). */
  readonly meal_change_requested: boolean;
  getMeals(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  proposeChange(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface MealActionsCatalog {
  listMealStatesBetween(patientId: string, fromIso: string, toIso: string): Promise<MealActionMealState[]>;
  listEntriesBetween(patientId: string, fromIso: string, toIso: string): Promise<MealActionCatalogEntry[]>;
  listForConversation(patientId: string, conversationId: string): Promise<MealActionRecord[]>;
}

/**
 * A short stable handle of a meal or entry ("M1a2b3c"): the same in every answer of a conversation, longer only when two
 * ids share their first characters.
 */
function uniqueHandle<T>(prefix: 'M' | 'E', id: string, value: T, known: Map<string, T>, sameAs: (a: T, b: T) => boolean): string {
  const hex = id.replace(/-/g, '').toLowerCase();
  for (let length = 6; length <= hex.length; length += 2) {
    const handle = `${prefix}${hex.slice(0, length)}`;
    const existing = known.get(handle);
    if (existing === undefined || sameAs(existing, value)) {
      known.set(handle, value);
      return handle;
    }
  }
  known.set(`${prefix}${hex}`, value);
  return `${prefix}${hex}`;
}

/** "m1A2b3C" → "M1a2b3c": the model may change the case of a handle. */
function canonicalHandle(handle: unknown): string | null {
  if (typeof handle !== 'string') return null;
  const match = /^\s*([mMeE])([0-9a-fA-F]+)\s*$/.exec(handle);
  return match ? `${match[1].toUpperCase()}${match[2].toLowerCase()}` : null;
}

function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(new Date(iso));
}

/** Start of the local day `days - 1` days before `now` (days_back 1 = today). */
function rangeStart(now: Date, days: number, timeZone: string): Date {
  const start = new Date(now.getTime() - (days - 1) * 86_400_000);
  const localMidnight = new Date(`${localDate(start.toISOString(), timeZone)}T00:00:00Z`);
  // The local midnight in UTC, within a day of DST error: one extra hour back keeps the first meal of the day.
  return new Date(localMidnight.getTime() - 3 * 3_600_000);
}

export interface MealActionsToolSessionDeps {
  patientId: string;
  conversationId: string;
  userMessageId: string;
  service: Pick<ConversationMealActionsService, 'propose'>;
  catalog: MealActionsCatalog;
  mealChangeRequested: boolean;
  now?: () => Date;
  timeZone?: string;
}

/** The two tools for one answer; remembers the handles it showed and whether the answer used them. */
export class MealActionsToolSession implements MealActionsTools {
  readonly meal_change_requested: boolean;
  /**
   * The answer worked on a meal change (a change proposed, or meals listed for a change the caregiver asked for): the next
   * short message continues it (meal_assistant). An analysis that only looked meals up does not count.
   */
  used = false;
  readonly proposed: MealActionRecord[] = [];
  private readonly meals = new Map<string, string>();
  private readonly entries = new Map<string, { carb_event_id: string | null; loop_action_id: string | null }>();
  private readonly timeZone: string;
  private readonly now: () => Date;
  private listedWeek = false;

  constructor(private readonly deps: MealActionsToolSessionDeps) {
    this.meal_change_requested = deps.mealChangeRequested;
    this.timeZone = deps.timeZone ?? LOOP_ACTION_TIME_ZONE;
    this.now = deps.now ?? (() => new Date());
  }

  async getMeals(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.meal_change_requested) this.used = true;
    const requested = Number(args.days_back);
    const days = args.days_back !== null && Number.isInteger(requested) ? Math.min(MAX_DAYS_BACK, Math.max(1, requested)) : DEFAULT_DAYS_BACK;
    const now = this.now();
    return this.listing(rangeStart(now, days, this.timeZone), now, days);
  }

  async proposeChange(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.used = true;
    const operation = String(args.operation ?? '') as MealActionOperation;
    if (!(MEAL_ACTION_OPERATIONS as readonly string[]).includes(operation)) return invalid(`operation must be one of ${MEAL_ACTION_OPERATIONS.join(', ')}`);
    // Handles from an earlier answer of this conversation stay valid: unknown ones are looked up in the last week.
    const unresolved = (args.meal && !this.resolveMeal(args.meal)) || (args.target_meal && !this.resolveMeal(args.target_meal)) || (args.entry && !this.resolveEntry(args.entry));
    if (unresolved && !this.listedWeek) {
      const now = this.now();
      await this.listing(rangeStart(now, MAX_DAYS_BACK, this.timeZone), now, MAX_DAYS_BACK);
    }
    const meal = this.resolveMeal(args.meal);
    const entry = this.resolveEntry(args.entry);
    const numberOrUndefined = (value: unknown) => (value === null || value === undefined ? undefined : value as number);

    let request: MealActionRequest;
    switch (operation) {
      case 'REPLACE_CONTENT':
        if (!meal) return invalid('meal must be a meal handle (M…) from get_meals');
        request = { operation, meal_id: meal, items: args.items, description: typeof args.description === 'string' ? args.description : null };
        break;
      case 'UPDATE_MACROS':
        if (!meal) return invalid('meal must be a meal handle (M…) from get_meals');
        request = { operation, meal_id: meal, carbs_g: numberOrUndefined(args.carbs_g), protein_g: numberOrUndefined(args.protein_g), fat_g: numberOrUndefined(args.fat_g) };
        break;
      case 'UPDATE_DESCRIPTION':
        if (!meal) return invalid('meal must be a meal handle (M…) from get_meals');
        request = { operation, meal_id: meal, description: String(args.description ?? '') };
        break;
      case 'SET_PURPOSE': {
        if (!entry) return invalid('entry must be a loop entry handle (E…) from get_meals');
        if (!isLoopActionPurpose(args.purpose)) return invalid('purpose is required for SET_PURPOSE');
        const target = args.target_meal === null || args.target_meal === undefined ? null : this.resolveMeal(args.target_meal);
        if (args.target_meal && !target) return invalid('target_meal must be a meal handle (M…) from get_meals');
        request = { operation, carb_event_id: entry.carb_event_id, loop_action_id: entry.loop_action_id, purpose: args.purpose, target_meal_id: target };
        // What the new meal was: only for an entry made a meal of its own (other purposes keep no content).
        if (args.purpose === 'NEW_MEAL') {
          Object.assign(request, {
            items: args.items,
            description: typeof args.description === 'string' ? args.description : null,
            carbs_g: numberOrUndefined(args.carbs_g),
            protein_g: numberOrUndefined(args.protein_g),
            fat_g: numberOrUndefined(args.fat_g),
          });
        }
        break;
      }
      case 'DETACH_ENTRY':
        if (!meal || !entry?.carb_event_id) return invalid('meal (M…) and entry (E…) from get_meals are required');
        request = { operation, meal_id: meal, carb_event_id: entry.carb_event_id };
        break;
      case 'SET_WBT_REMINDER':
        if (!meal) return invalid('meal must be a meal handle (M…) from get_meals');
        if (typeof args.enabled !== 'boolean') return invalid('enabled must be true or false');
        request = { operation, meal_id: meal, enabled: args.enabled };
        break;
    }

    const result = await this.deps.service.propose({
      patientId: this.deps.patientId,
      conversationId: this.deps.conversationId,
      userMessageId: this.deps.userMessageId,
      request,
      reason: typeof args.reason === 'string' ? args.reason.slice(0, 300) : null,
      timeZone: this.timeZone,
    });
    if (result.status !== 'PROPOSED') {
      return { tool: PROPOSE_MEAL_CHANGE_TOOL_NAME, status: result.status, problem: result.problem };
    }
    this.proposed.push(result.action);
    return {
      tool: PROPOSE_MEAL_CHANGE_TOOL_NAME,
      status: 'PROPOSED',
      card: {
        title: result.action.title,
        before: compactSide(result.action.before),
        after: compactSide(result.action.after),
        warnings: result.action.warnings.map((warning) => warning.message),
      },
      note: 'The caregiver now sees this card. Nothing is saved until they tap "Zatwierdź"; do not say it is saved.',
    };
  }

  private resolveMeal(handle: unknown): string | null {
    const canonical = canonicalHandle(handle);
    return canonical?.startsWith('M') ? this.meals.get(canonical) ?? null : null;
  }

  private resolveEntry(handle: unknown): { carb_event_id: string | null; loop_action_id: string | null } | null {
    const canonical = canonicalHandle(handle);
    return canonical?.startsWith('E') ? this.entries.get(canonical) ?? null : null;
  }

  private async listing(from: Date, to: Date, days: number): Promise<Record<string, unknown>> {
    if (days >= MAX_DAYS_BACK) this.listedWeek = true;
    const [meals, entries, changes] = await Promise.all([
      this.deps.catalog.listMealStatesBetween(this.deps.patientId, from.toISOString(), to.toISOString()),
      this.deps.catalog.listEntriesBetween(this.deps.patientId, from.toISOString(), to.toISOString()),
      this.deps.catalog.listForConversation(this.deps.patientId, this.deps.conversationId),
    ]);
    const mealHandle = new Map<string, string>();
    for (const meal of meals) {
      mealHandle.set(meal.meal_id, uniqueHandle('M', meal.meal_id, meal.meal_id, this.meals, (a, b) => a === b));
    }
    const entryViews = entries.map((entry) => {
      const ref = { carb_event_id: entry.carb_event_id, loop_action_id: entry.loop_action_id };
      const handle = uniqueHandle('E', entry.carb_event_id ?? entry.loop_action_id ?? '', ref, this.entries, (a, b) => a.carb_event_id === b.carb_event_id && a.loop_action_id === b.loop_action_id);
      const mealId = entry.meal_id ?? entry.purpose_meal_id;
      return {
        entry: handle,
        date: localDate(entry.occurred_at, this.timeZone),
        time: localTime(entry.occurred_at, this.timeZone),
        carbs_g: entry.carbs_g,
        bolus_units: entry.bolus_units,
        // What it was for: the loop action's answer (UNANSWERED when none) or, for older entries, the carb entry kind.
        answer: entry.loop_action_id ? entry.purpose ?? 'UNANSWERED' : entry.kind,
        meal: mealId ? mealHandle.get(mealId) ?? null : null,
      };
    });
    return {
      tool: GET_MEALS_TOOL_NAME,
      status: 'OK',
      days_back: days,
      now_local: `${localDate(to.toISOString(), this.timeZone)} ${localTime(to.toISOString(), this.timeZone)}`,
      meals: meals.map((meal) => ({
        meal: mealHandle.get(meal.meal_id),
        date: localDate(meal.started_at, this.timeZone),
        time: localTime(meal.started_at, this.timeZone),
        status: meal.status,
        description: meal.description,
        items: meal.items,
        carbs_g: meal.carbs_g,
        protein_g: meal.protein_g,
        fat_g: meal.fat_g,
        wbt: meal.protein_g === null && meal.fat_g === null ? null : fatProteinUnitsOf(meal.protein_g, meal.fat_g),
        loop_carbs_g: meal.loop_carbs_g,
        wbt_reminder: meal.wbt_reminder_enabled,
        entries: entryViews.filter((entry) => entry.meal === mealHandle.get(meal.meal_id)).map((entry) => entry.entry),
      })),
      entries: entryViews,
      changes_in_this_conversation: changes
        .filter((change) => change.status !== 'DISCARDED')
        .map((change) => ({ title: change.title, status: change.status, meal: change.meal_record_id ? mealHandle.get(change.meal_record_id) ?? null : null })),
    };
  }
}

function invalid(problem: string): Record<string, unknown> {
  return { tool: PROPOSE_MEAL_CHANGE_TOOL_NAME, status: 'INVALID', problem };
}

/** A card side for the model: the values, without the internal edit. */
function compactSide(side: MealActionRecord['before'] | MealActionRecord['after']): Record<string, unknown> {
  const { edit: _edit, ...rest } = side as Record<string, unknown>;
  if (rest.content && typeof rest.content === 'object') {
    const { edit: _contentEdit, ...content } = rest.content as Record<string, unknown>;
    rest.content = content;
  }
  return rest;
}

/** Meal-change wording that claims a write happened ("zapisałem", "usunąłem posiłek"). */
const CLAIMED_WRITE_PATTERN = /\b(?:zapisa(?:łem|łam|no)|zmieni(?:łem|łam|ono)|zaktualizowa(?:łem|łam|no)|poprawi(?:łem|łam|ono)|usun(?:ąłem|ęłam|ięto)|wprowadzi(?:łem|łam|ono)|edytowa(?:łem|łam|no))\b/i;

/**
 * The answer text as stored. A meal change is saved only by its card: when the text claims a write anyway, one plain
 * sentence makes the state clear instead of discarding the answer.
 */
export function finalizeMealActionAnswer(text: string, session: Pick<MealActionsToolSession, 'used' | 'proposed'> | null): { text: string; corrected: boolean } {
  if (!session?.used || !CLAIMED_WRITE_PATTERN.test(text)) return { text, corrected: false };
  const note = session.proposed.length > 0
    ? 'Uwaga: zmiana zapisze się dopiero po naciśnięciu „Zatwierdź” na karcie poniżej.'
    : 'Uwaga: nic nie zostało zapisane w posiłkach.';
  return { text: `${text.trimEnd()}\n\n${note}`, corrected: true };
}
