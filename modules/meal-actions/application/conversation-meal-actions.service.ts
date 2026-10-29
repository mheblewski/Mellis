import { ConflictError, NotFoundError, StaleWriteError, ValidationError } from '@shared/errors/app-error';
import { itemsMatchTotals, type MealItem } from '@modules/meal-candidates/application/meal-items';
import { fatProteinUnitsOf } from '@modules/meal-wbt/application/wbt-policy';
import type { LoopActionPurpose } from '@modules/loop-actions/application/loop-action-policy';
import {
  buildMealActionProposal,
  buildUndoRequest,
  type BuiltMealAction,
  type CarbKind,
  type MealActionAfter,
  type MealActionBefore,
  type MealActionBuildResult,
  type MealActionEntryState,
  type MealActionMealState,
  type MealActionRequest,
  type MealActionStatus,
  type MealActionTargetMeal,
  type MealActionWarning,
  type MealContentView,
} from './meal-action-policy';

/**
 * Meal changes prepared in a conversation (conversation-meal-actions.v1): the AI proposes, a caregiver confirms, and
 * only then is the meal written, through the same writes as the meals tab. Every write is checked against what the
 * card showed: a change prepared on a meal or entry that changed since is marked STALE and nothing is written.
 */

/** The stored change, as the storage returns it. */
export interface MealActionRecord {
  id: string;
  patient_id: string;
  conversation_id: string;
  user_message_id: string;
  operation: MealActionRequest['operation'];
  meal_record_id: string | null;
  carb_event_id: string | null;
  loop_action_id: string | null;
  title: string;
  before: MealActionBefore;
  after: MealActionAfter;
  undoable: boolean;
  warnings: MealActionWarning[];
  base_content_revision: number | null;
  status: MealActionStatus;
  reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  applied_content_revision: number | null;
  undone_at: string | null;
  created_at: string;
}

type ContentEdit = { description?: string | null; items?: MealItem[] | null; macros?: { carbs_g: number | null; protein_g: number | null; fat_g: number | null } };

export interface MealActionStore {
  insertProposal(args: { patientId: string; conversationId: string; userMessageId: string; action: BuiltMealAction; reason: string | null }): Promise<MealActionRecord>;
  get(patientId: string, conversationId: string, actionId: string): Promise<MealActionRecord | null>;
  claim(actionId: string): Promise<MealActionRecord | null>;
  release(actionId: string): Promise<void>;
  finishApplying(actionId: string, status: 'APPLIED' | 'STALE', userId: string, appliedContentRevision?: number | null): Promise<void>;
  reject(actionId: string, userId: string): Promise<boolean>;
  markStale(actionId: string): Promise<boolean>;
  applyContent(args: { action: MealActionRecord; identity: string; userId: string; edit: ContentEdit; note: string; after?: MealActionAfter }): Promise<number>;
  undoContent(args: { action: MealActionRecord; identity: string; userId: string; edit: ContentEdit; note: string }): Promise<void>;
  markUndone(action: MealActionRecord, userId: string, note: string | null): Promise<boolean>;
  addMealChatNote(action: MealActionRecord, mealRecordId: string, userId: string, note: string): Promise<void>;
  loadMealState(patientId: string, mealRecordId: string): Promise<{ identity: string; state: MealActionMealState } | null>;
  loadTargetMeal(patientId: string, mealRecordId: string): Promise<MealActionTargetMeal | null>;
  loadEntryState(patientId: string, ref: { loopActionId?: string | null; carbEventId?: string | null }): Promise<MealActionEntryState | null>;
}

/** The meals tab's own writes, used unchanged so a change from a conversation gets the same rules and side effects. */
export interface MealActionWriters {
  /** Throws StaleWriteError when the action's answer is no longer `expected`. */
  assignLoopAction(args: { patientId: string; actionId: string; purpose: LoopActionPurpose | null; mealRecordId: string | null; userId: string; expected: { purpose: LoopActionPurpose | null; mealRecordId: string | null } }): Promise<void>;
  setCarbEntryKind(args: { patientId: string; eventId: string; kind: CarbKind; userId: string }): Promise<void>;
  detachCarbEntry(args: { patientId: string; eventId: string; userId: string }): Promise<void>;
  setWbtReminder(args: { patientId: string; mealRecordId: string; enabled: boolean; userId: string }): Promise<void>;
  /** After the meal's values changed: the AUTO WBT reminder follows them, as after a save in the meals tab. */
  afterMealValuesChanged(args: { patientId: string; mealRecordId: string; identity: string }): Promise<void>;
}

/** Values a caregiver changed with "Popraw" before confirming a content change. */
export interface EditedMealContent {
  description?: unknown;
  carbs_g?: unknown;
  protein_g?: unknown;
  fat_g?: unknown;
}

export type ProposeResult =
  | { status: 'PROPOSED'; action: MealActionRecord }
  | { status: 'INVALID' | 'NO_CHANGE'; problem: string };

const formatGrams = (value: number | null) => (value === null ? '?' : `${(Math.round(value * 10) / 10).toString().replace('.', ',')} g`);

function describeContent(view: MealContentView): string {
  const values = `W ${formatGrams(view.carbs_g)} · B ${formatGrams(view.protein_g)} · T ${formatGrams(view.fat_g)}`;
  return view.description ? `${view.description} (${values})` : values;
}

function isStaleOutcome(error: unknown): boolean {
  return error instanceof StaleWriteError || error instanceof ConflictError || error instanceof NotFoundError;
}

export class ConversationMealActionsService {
  constructor(private readonly store: MealActionStore, private readonly writers: MealActionWriters) {}

  /**
   * Prepares a change for a card (the AI's propose_meal_change). Reads the current meal / entry, decides whether the
   * change is possible and stores it as PROPOSED; nothing is written to the meal.
   */
  async propose(args: { patientId: string; conversationId: string; userMessageId: string; request: MealActionRequest; reason?: string | null; timeZone?: string }): Promise<ProposeResult> {
    const built = await this.build(args.patientId, args.request, args.timeZone);
    if (!built.ok) return { status: built.code, problem: built.problem };
    const action = await this.store.insertProposal({
      patientId: args.patientId,
      conversationId: args.conversationId,
      userMessageId: args.userMessageId,
      action: built.action,
      reason: typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : null,
    });
    return { status: 'PROPOSED', action };
  }

  /** Builds the card for a request from the current state, without storing it. */
  async build(patientId: string, request: MealActionRequest, timeZone?: string): Promise<MealActionBuildResult> {
    if (request.operation === 'SET_PURPOSE') {
      const entry = await this.store.loadEntryState(patientId, { loopActionId: request.loop_action_id ?? null, carbEventId: request.carb_event_id ?? null });
      const target = request.target_meal_id ? await this.store.loadTargetMeal(patientId, request.target_meal_id) : null;
      return buildMealActionProposal({ request, entry, target_meal: target, time_zone: timeZone });
    }
    const meal = await this.store.loadMealState(patientId, request.meal_id);
    const entry = request.operation === 'DETACH_ENTRY' ? await this.store.loadEntryState(patientId, { carbEventId: request.carb_event_id }) : null;
    return buildMealActionProposal({ request, meal: meal?.state ?? null, entry, time_zone: timeZone });
  }

  /**
   * The caregiver confirmed the card. Applying twice is a no-op; a change on an outdated meal or entry becomes STALE
   * (returned, not thrown, so the card shows why). `edited` are the values changed with "Popraw" (content changes).
   */
  async apply(args: { patientId: string; conversationId: string; actionId: string; userId: string; edited?: EditedMealContent | null }): Promise<MealActionRecord> {
    const current = await this.requireAction(args.patientId, args.conversationId, args.actionId);
    if (current.status === 'APPLIED') return current;
    if (current.status !== 'PROPOSED' && current.status !== 'APPLYING') {
      throw new ConflictError(`MEAL_ACTION_CLOSED: the change is ${current.status}`);
    }
    const action = await this.store.claim(current.id);
    if (!action) {
      const now = await this.requireAction(args.patientId, args.conversationId, args.actionId);
      if (now.status === 'APPLIED' || now.status === 'STALE') return now;
      throw new ConflictError(`MEAL_ACTION_CLOSED: the change is ${now.status}`);
    }
    if (args.edited && action.after.kind !== 'CONTENT') {
      await this.store.release(action.id);
      throw new ValidationError('Only a change of the meal content can be edited before confirming');
    }

    try {
      switch (action.after.kind) {
        case 'CONTENT':
          await this.applyContent(action, args.userId, args.edited ?? null);
          break;
        case 'PURPOSE':
          await this.applyPurpose(action, args.userId);
          break;
        case 'MEMBERSHIP':
          if (!action.carb_event_id) throw new NotFoundError('Carb entry not found');
          await this.writers.detachCarbEntry({ patientId: action.patient_id, eventId: action.carb_event_id, userId: args.userId });
          await this.store.finishApplying(action.id, 'APPLIED', args.userId);
          break;
        case 'WBT_REMINDER':
          await this.applyWbtReminder(action, args.userId);
          break;
      }
    } catch (error) {
      if (isStaleOutcome(error)) {
        await this.store.markStale(action.id);
      } else {
        await this.store.release(action.id);
        throw error;
      }
    }
    return this.requireAction(args.patientId, args.conversationId, args.actionId);
  }

  /** The caregiver declined the card. Declining twice is a no-op. */
  async reject(args: { patientId: string; conversationId: string; actionId: string; userId: string }): Promise<MealActionRecord> {
    const current = await this.requireAction(args.patientId, args.conversationId, args.actionId);
    if (current.status === 'REJECTED') return current;
    if (!(await this.store.reject(current.id, args.userId))) {
      const now = await this.requireAction(args.patientId, args.conversationId, args.actionId);
      if (now.status === 'REJECTED') return now;
      throw new ConflictError(`MEAL_ACTION_CLOSED: the change is ${now.status}`);
    }
    return this.requireAction(args.patientId, args.conversationId, args.actionId);
  }

  /**
   * "Cofnij" on a confirmed card: restores what it replaced. Refused (STALE_WRITE) when the meal or entry changed again
   * after the change, so a later edit of the other caregiver is never undone with it.
   */
  async undo(args: { patientId: string; conversationId: string; actionId: string; userId: string }): Promise<MealActionRecord> {
    const action = await this.requireAction(args.patientId, args.conversationId, args.actionId);
    if (action.status === 'UNDONE') return action;
    if (action.status !== 'APPLIED') throw new ConflictError(`MEAL_ACTION_NOT_APPLIED: the change is ${action.status}`);
    const undo = action.undoable ? buildUndoRequest(action.operation, action.before, action.after) : null;
    if (!undo) throw new ConflictError('MEAL_ACTION_NOT_UNDOABLE: this change cannot be undone here');
    const note = `Cofnięto zmianę z Rozmów: ${action.title}.`;

    if (undo.kind === 'CONTENT') {
      const meal = action.meal_record_id ? await this.store.loadMealState(action.patient_id, action.meal_record_id) : null;
      if (!meal) throw new StaleWriteError('MEAL_CHANGED: the meal no longer exists');
      await this.store.undoContent({ action, identity: meal.identity, userId: args.userId, edit: undo.edit, note });
      if (undo.edit.macros) await this.writers.afterMealValuesChanged({ patientId: action.patient_id, mealRecordId: meal.state.meal_id, identity: meal.identity });
    } else if (undo.kind === 'PURPOSE') {
      if (action.loop_action_id) {
        await this.writers.assignLoopAction({
          patientId: action.patient_id,
          actionId: action.loop_action_id,
          purpose: undo.purpose,
          mealRecordId: undo.meal_id,
          userId: args.userId,
          expected: { purpose: undo.expected_purpose, mealRecordId: undo.expected_meal_id },
        });
      } else {
        const entry = await this.store.loadEntryState(action.patient_id, { carbEventId: action.carb_event_id });
        if (!entry?.carb_event_id || entry.kind !== undo.expected_carb_kind) throw new StaleWriteError('CARB_ENTRY_CHANGED: the entry was changed again');
        await this.writers.setCarbEntryKind({ patientId: action.patient_id, eventId: entry.carb_event_id, kind: undo.carb_kind, userId: args.userId });
      }
      await this.store.markUndone(action, args.userId, note);
    } else {
      const meal = action.meal_record_id ? await this.store.loadMealState(action.patient_id, action.meal_record_id) : null;
      if (!meal || meal.state.wbt_reminder_enabled !== (action.after.kind === 'WBT_REMINDER' ? action.after.enabled : null)) {
        throw new StaleWriteError('WBT_REMINDER_CHANGED: the reminder was changed again');
      }
      await this.writers.setWbtReminder({ patientId: action.patient_id, mealRecordId: meal.state.meal_id, enabled: undo.enabled, userId: args.userId });
      await this.store.markUndone(action, args.userId, note);
    }
    return this.requireAction(args.patientId, args.conversationId, args.actionId);
  }

  private async applyContent(action: MealActionRecord, userId: string, edited: EditedMealContent | null): Promise<void> {
    if (action.after.kind !== 'CONTENT' || !action.meal_record_id) throw new NotFoundError('Meal not found');
    const meal = await this.store.loadMealState(action.patient_id, action.meal_record_id);
    if (!meal) throw new NotFoundError('Meal not found');
    const { edit, after } = edited ? editedContent(action.operation, action.after, edited) : { edit: action.after.edit, after: undefined };
    const shown = after ?? action.after;
    await this.store.applyContent({
      action,
      identity: meal.identity,
      userId,
      edit,
      note: `Zmiana z Rozmów: ${action.title}. Teraz: ${describeContent(shown as MealContentView)}.`,
      ...(after ? { after } : {}),
    });
    if (edit.macros) await this.writers.afterMealValuesChanged({ patientId: action.patient_id, mealRecordId: meal.state.meal_id, identity: meal.identity });
  }

  private async applyPurpose(action: MealActionRecord, userId: string): Promise<void> {
    if (action.before.kind !== 'PURPOSE' || action.after.kind !== 'PURPOSE') throw new ValidationError('Not a purpose change');
    if (action.loop_action_id) {
      await this.writers.assignLoopAction({
        patientId: action.patient_id,
        actionId: action.loop_action_id,
        purpose: action.after.purpose,
        mealRecordId: action.after.meal_id,
        userId,
        expected: { purpose: action.before.purpose, mealRecordId: action.before.meal_id },
      });
      const content = action.after.content;
      if (content && action.after.purpose === 'NEW_MEAL') {
        // The meal exists only now: what was eaten is saved into it, with its note, in the same step as the card.
        const created = await this.store.loadEntryState(action.patient_id, { loopActionId: action.loop_action_id });
        const mealId = created?.purpose === 'NEW_MEAL' ? created.purpose_meal_id : null;
        const meal = mealId ? await this.store.loadMealState(action.patient_id, mealId) : null;
        if (!meal) throw new StaleWriteError('LOOP_ACTION_CHANGED: the entry is no longer a meal of its own');
        // A retry after a failed save finds the meal made already: described meanwhile (the other caregiver), it is
        // not overwritten.
        const described = meal.state.description !== null || meal.state.carbs_g !== null || meal.state.protein_g !== null || meal.state.fat_g !== null;
        if (described) throw new StaleWriteError('MEAL_CHANGED: the new meal was described meanwhile');
        await this.store.applyContent({
          action: { ...action, meal_record_id: meal.state.meal_id, base_content_revision: meal.state.content_revision },
          identity: meal.identity,
          userId,
          edit: content.edit,
          note: `Zmiana z Rozmów: ${action.title} — osobny posiłek: ${describeContent(content)}.`,
          after: { ...action.after, meal_id: meal.state.meal_id },
        });
        if (content.edit.macros) await this.writers.afterMealValuesChanged({ patientId: action.patient_id, mealRecordId: meal.state.meal_id, identity: meal.identity });
        return;
      }
    } else {
      const entry = await this.store.loadEntryState(action.patient_id, { carbEventId: action.carb_event_id });
      if (!entry?.carb_event_id || entry.loop_action_id || entry.kind !== action.before.carb_kind) {
        throw new StaleWriteError('CARB_ENTRY_CHANGED: the entry changed after the change was prepared');
      }
      await this.writers.setCarbEntryKind({ patientId: action.patient_id, eventId: entry.carb_event_id, kind: action.after.carb_kind, userId });
    }
    await this.store.finishApplying(action.id, 'APPLIED', userId);
    const noteMeal = action.after.meal_id ?? action.meal_record_id;
    if (noteMeal) await this.store.addMealChatNote(action, noteMeal, userId, `Zmiana z Rozmów: ${action.title} — teraz: ${action.after.label}.`);
  }

  private async applyWbtReminder(action: MealActionRecord, userId: string): Promise<void> {
    if (action.before.kind !== 'WBT_REMINDER' || action.after.kind !== 'WBT_REMINDER' || !action.meal_record_id) throw new ValidationError('Not a WBT reminder change');
    const meal = await this.store.loadMealState(action.patient_id, action.meal_record_id);
    if (!meal) throw new NotFoundError('Meal not found');
    if (meal.state.wbt_reminder_enabled !== action.before.enabled) throw new StaleWriteError('WBT_REMINDER_CHANGED: the reminder changed after the change was prepared');
    await this.writers.setWbtReminder({ patientId: action.patient_id, mealRecordId: meal.state.meal_id, enabled: action.after.enabled, userId });
    await this.store.finishApplying(action.id, 'APPLIED', userId);
    await this.store.addMealChatNote(action, meal.state.meal_id, userId, `Zmiana z Rozmów: przypomnienie o WBT ${action.after.enabled ? 'włączone' : 'wyłączone'}.`);
  }

  private async requireAction(patientId: string, conversationId: string, actionId: string): Promise<MealActionRecord> {
    const action = await this.store.get(patientId, conversationId, actionId);
    if (!action) throw new NotFoundError('Meal change not found');
    return action;
  }
}

/**
 * Content after "Popraw": the caregiver's description and values replace the proposed ones; the proposed items stay
 * only while they still add up to the values.
 */
function editedContent(operation: MealActionRecord['operation'], after: Extract<MealActionAfter, { kind: 'CONTENT' }>, edited: EditedMealContent): { edit: ContentEdit; after: MealActionAfter } {
  const grams = (value: unknown, name: string, fallback: number | null): number | null => {
    if (value === undefined) return fallback;
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000) throw new ValidationError(`${name} must be a number between 0 and 1000 or null`);
    return Math.round(value * 10) / 10;
  };
  let description = after.description;
  if (edited.description !== undefined) {
    if (edited.description !== null && typeof edited.description !== 'string') throw new ValidationError('description must be text or null');
    description = typeof edited.description === 'string' ? edited.description.replace(/\s+/g, ' ').trim() || null : null;
    if (description && description.length > 2000) throw new ValidationError('description must be at most 2000 characters');
  }
  // A description change stays one: values typed with it would confirm the meal, which the card did not say.
  if (operation === 'UPDATE_DESCRIPTION') {
    if (!description) throw new ValidationError('description must be 1-2000 characters');
    const edit: ContentEdit = { description };
    return { edit, after: { ...after, description, edit } };
  }
  const macros = {
    carbs_g: grams(edited.carbs_g, 'carbs_g', after.carbs_g),
    protein_g: grams(edited.protein_g, 'protein_g', after.protein_g),
    fat_g: grams(edited.fat_g, 'fat_g', after.fat_g),
  };
  if (macros.carbs_g === null && macros.protein_g === null && macros.fat_g === null) throw new ValidationError('At least one of carbs_g, protein_g or fat_g is required');
  const items = after.items && itemsMatchTotals(after.items, macros) ? after.items : null;
  const edit: ContentEdit = { description, items, macros };
  return {
    edit,
    after: {
      kind: 'CONTENT',
      description,
      items,
      ...macros,
      fat_protein_units: fatProteinUnitsOf(macros.protein_g, macros.fat_g),
      edit,
    },
  };
}

/**
 * A change as the app shows it on its card under the answer that prepared it. `before` and `after` are what the
 * server decided, never text from the model; `can_apply` / `can_undo` say which buttons the card has.
 */
export function toMealActionView(action: MealActionRecord): Record<string, unknown> {
  const { edit: _edit, ...after } = action.after as MealActionAfter & { edit?: unknown };
  if (after.kind === 'PURPOSE' && after.content) {
    const { edit: _contentEdit, ...content } = after.content;
    Object.assign(after, { content });
  }
  const mealId = action.after.kind === 'PURPOSE' ? action.after.meal_id ?? action.meal_record_id : action.meal_record_id;
  return {
    id: action.id,
    user_message_id: action.user_message_id,
    operation: action.operation,
    status: action.status,
    title: action.title,
    reason: action.reason,
    before: action.before,
    after,
    warnings: action.warnings,
    meal_id: mealId,
    carb_event_id: action.carb_event_id,
    loop_action_id: action.loop_action_id,
    can_apply: action.status === 'PROPOSED',
    can_edit: action.status === 'PROPOSED' && action.after.kind === 'CONTENT',
    can_undo: action.status === 'APPLIED' && action.undoable,
    decided_by: action.decided_by,
    decided_at: action.decided_at,
    undone_at: action.undone_at,
    created_at: action.created_at,
  };
}
