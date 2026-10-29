import { describe, expect, it, vi } from 'vitest';
import { ConflictError, StaleWriteError, ValidationError } from '@shared/errors/app-error';
import {
  buildMealActionProposal,
  buildUndoRequest,
  type BuiltMealAction,
  type MealActionEntryState,
  type MealActionMealState,
  type MealActionRequest,
} from './application/meal-action-policy';
import {
  ConversationMealActionsService,
  toMealActionView,
  type MealActionRecord,
  type MealActionStore,
  type MealActionWriters,
} from './application/conversation-meal-actions.service';

const MEAL = '22222222-2222-4222-8222-222222222222';
const OTHER_MEAL = '66666666-6666-4666-8666-666666666666';
const CARB = '33333333-3333-4333-8333-333333333333';
const ACTION = '77777777-7777-4777-8777-777777777777';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '88888888-8888-4888-8888-888888888888';
const USER_MESSAGE = '99999999-9999-4999-8999-999999999999';
const CAREGIVER = '44444444-4444-4444-8444-444444444444';
const TZ = 'Europe/Warsaw';

const SKYR = { name: 'Skyr naturalny', grams: 150, carbs_g: 6, protein_g: 16.5, fat_g: 0, source: 'DIABCALC' as const };

function meal(overrides: Partial<MealActionMealState> = {}): MealActionMealState {
  return {
    meal_id: MEAL,
    started_at: '2026-10-19T11:10:00.000Z',
    status: 'CONFIRMED',
    description: 'Skyr naturalny (150 g)',
    items: [SKYR],
    carbs_g: 6,
    protein_g: 16.5,
    fat_g: 0,
    content_revision: 4,
    loop_carbs_g: 10,
    wbt_reminder_enabled: false,
    ...overrides,
  };
}

function loopEntry(overrides: Partial<MealActionEntryState> = {}): MealActionEntryState {
  return {
    carb_event_id: CARB,
    loop_action_id: ACTION,
    occurred_at: '2026-10-19T11:10:00.000Z',
    carbs_g: 10,
    bolus_units: 1.2,
    kind: 'MEAL',
    purpose: 'NEW_MEAL',
    purpose_meal_id: MEAL,
    purpose_meal_label: 'Skyr naturalny (150 g)',
    meal: { meal_id: MEAL, label: 'Skyr naturalny (150 g)', is_anchor: true, entry_count: 1, has_content: true, dependants: 0 },
    ...overrides,
  };
}

const PANCAKES = [
  { name: 'Naleśnik', grams: 120, carbs_g: 34.2, protein_g: 7.8, fat_g: 8.4, source: 'DIABCALC' },
  { name: 'Twaróg półtłusty', grams: 60, carbs_g: 2.1, protein_g: 11.1, fat_g: 2.4, source: 'DIABCALC' },
];

function built(result: ReturnType<typeof buildMealActionProposal>): BuiltMealAction {
  if (!result.ok) throw new Error(`expected a proposal, got ${result.code}: ${result.problem}`);
  return result.action;
}

describe('meal action policy', () => {
  it('replaces a meal with new items: totals are their sum, the description names them, the loop gap is shown', () => {
    const action = built(buildMealActionProposal({ request: { operation: 'REPLACE_CONTENT', meal_id: MEAL, items: PANCAKES }, meal: meal(), time_zone: TZ }));

    expect(action.payload.after).toMatchObject({
      kind: 'CONTENT',
      description: 'Naleśnik (120 g), Twaróg półtłusty (60 g)',
      carbs_g: 36.3,
      protein_g: 18.9,
      fat_g: 10.8,
      fat_protein_units: 1.7,
    });
    expect(action.before).toMatchObject({ kind: 'CONTENT', status: 'CONFIRMED', carbs_g: 6, description: 'Skyr naturalny (150 g)' });
    expect(action.base_content_revision).toBe(4);
    expect(action.payload.title).toBe('Zmiana posiłku · Skyr naturalny (150 g) (13:10)');
    expect(action.payload.undoable).toBe(true);
    expect(action.warnings.map((warning) => warning.code)).toEqual(['LOOP_CARBS_DIFFER']);
    expect(action.warnings[0].message).toContain('Pętla dostała 10 g');
  });

  it('refuses broken items instead of reading them as zero', () => {
    const negative = buildMealActionProposal({ request: { operation: 'REPLACE_CONTENT', meal_id: MEAL, items: [{ ...SKYR, carbs_g: -5 }] }, meal: meal() });
    const missing = buildMealActionProposal({ request: { operation: 'REPLACE_CONTENT', meal_id: MEAL, items: [{ name: 'Chleb', grams: 50 }] }, meal: meal() });
    const empty = buildMealActionProposal({ request: { operation: 'REPLACE_CONTENT', meal_id: MEAL, items: [] }, meal: meal() });
    expect([negative.ok, missing.ok, empty.ok]).toEqual([false, false, false]);
  });

  it('an unconfirmed meal cannot be undone back to "no values"', () => {
    const action = built(buildMealActionProposal({
      request: { operation: 'REPLACE_CONTENT', meal_id: MEAL, items: PANCAKES },
      meal: meal({ status: 'AWAITING_DESCRIPTION', description: null, items: null, carbs_g: null, protein_g: null, fat_g: null }),
    }));
    expect(action.payload.undoable).toBe(false);
    expect(action.warnings.map((warning) => warning.code)).toContain('NOT_UNDOABLE');
  });

  it('a partial values change keeps the values it does not name and drops items that no longer add up', () => {
    const action = built(buildMealActionProposal({ request: { operation: 'UPDATE_MACROS', meal_id: MEAL, fat_g: 20 }, meal: meal() }));
    expect(action.payload.after).toMatchObject({ carbs_g: 6, protein_g: 16.5, fat_g: 20, items: null });
    expect(action.warnings.map((warning) => warning.code)).toContain('ITEMS_DROPPED');
  });

  it('the same values on a confirmed meal are no change, on an unconfirmed one they confirm it', () => {
    expect(buildMealActionProposal({ request: { operation: 'UPDATE_MACROS', meal_id: MEAL, carbs_g: 6 }, meal: meal() })).toMatchObject({ ok: false, code: 'NO_CHANGE' });
    expect(buildMealActionProposal({ request: { operation: 'UPDATE_MACROS', meal_id: MEAL, carbs_g: 6 }, meal: meal({ status: 'AI_PROPOSED' }) }).ok).toBe(true);
  });

  it('a cancelled meal or a meal of another id cannot be changed', () => {
    expect(buildMealActionProposal({ request: { operation: 'UPDATE_DESCRIPTION', meal_id: MEAL, description: 'Obiad' }, meal: meal({ status: 'CANCELLED' }) }).ok).toBe(false);
    expect(buildMealActionProposal({ request: { operation: 'UPDATE_DESCRIPTION', meal_id: OTHER_MEAL, description: 'Obiad' }, meal: meal() }).ok).toBe(false);
  });

  it('turning a loop meal into correction carbs warns that the meal goes away and offers no undo', () => {
    const action = built(buildMealActionProposal({ request: { operation: 'SET_PURPOSE', loop_action_id: ACTION, purpose: 'CORRECTION' }, entry: loopEntry(), time_zone: TZ }));
    expect(action.before).toMatchObject({ kind: 'PURPOSE', purpose: 'NEW_MEAL', meal_id: MEAL });
    expect(action.payload.after).toMatchObject({ kind: 'PURPOSE', purpose: 'CORRECTION', carb_kind: 'CORRECTION_CARBS', label: 'węgle korekcyjne' });
    expect(action.warnings.map((warning) => warning.code)).toEqual(['MEAL_WILL_BE_DELETED', 'NOT_UNDOABLE']);
    expect(action.payload.title).toBe('Wpis z pętli o 13:10 (10 g węglowodanów i 1,2 j. bolusa)');
  });

  it('a loop meal with a later dose still planned (or sent from a card) cannot be taken back', () => {
    const planned = loopEntry({ meal: { meal_id: MEAL, label: 'Pizza', is_anchor: true, entry_count: 1, has_content: true, dependants: 0, planned_doses: 1 } });
    expect(buildMealActionProposal({ request: { operation: 'SET_PURPOSE', loop_action_id: ACTION, purpose: 'CORRECTION' }, entry: planned })).toMatchObject({ ok: false, code: 'INVALID', problem: expect.stringContaining('later dose') });
  });

  it('a loop meal with add-ons cannot be taken back', () => {
    const result = buildMealActionProposal({
      request: { operation: 'SET_PURPOSE', loop_action_id: ACTION, purpose: 'IGNORED' },
      entry: loopEntry({ meal: { meal_id: MEAL, label: 'Obiad', is_anchor: true, entry_count: 2, has_content: true, dependants: 1 } }),
    });
    expect(result).toMatchObject({ ok: false, code: 'INVALID' });
  });

  it('an add-on or WBT names its meal, which must exist', () => {
    const unanswered = loopEntry({ purpose: null, purpose_meal_id: null, purpose_meal_label: null, meal: null });
    expect(buildMealActionProposal({ request: { operation: 'SET_PURPOSE', loop_action_id: ACTION, purpose: 'MEAL_ADDITION' }, entry: unanswered }).ok).toBe(false);
    expect(buildMealActionProposal({ request: { operation: 'SET_PURPOSE', loop_action_id: ACTION, purpose: 'WBT', target_meal_id: OTHER_MEAL }, entry: unanswered, target_meal: null }).ok).toBe(false);
    const wbt = built(buildMealActionProposal({
      request: { operation: 'SET_PURPOSE', loop_action_id: ACTION, purpose: 'WBT', target_meal_id: OTHER_MEAL },
      entry: unanswered,
      target_meal: { meal_id: OTHER_MEAL, label: 'Obiad', status: 'CONFIRMED' },
    }));
    expect(wbt.payload.after).toMatchObject({ purpose: 'WBT', meal_id: OTHER_MEAL, label: 'WBT do: Obiad' });
    expect(wbt.before).toMatchObject({ purpose: null, label: 'bez odpowiedzi' });
    expect(wbt.payload.undoable).toBe(true);
  });

  it('a loop entry made a meal of its own carries what was eaten; values alone are enough; nothing named keeps it empty', () => {
    const unanswered = loopEntry({ purpose: null, purpose_meal_id: null, purpose_meal_label: null, meal: null, carbs_g: 10 });
    const croissant = [{ name: 'Croissant maślany', grams: 30, carbs_g: 13, protein_g: 2.5, fat_g: 6, source: 'DIABCALC' }];
    const withItems = built(buildMealActionProposal({ request: { operation: 'SET_PURPOSE', loop_action_id: ACTION, purpose: 'NEW_MEAL', items: croissant, description: 'Pół croissanta maślanego' }, entry: unanswered, time_zone: TZ }));
    expect(withItems.payload.after).toMatchObject({
      kind: 'PURPOSE',
      purpose: 'NEW_MEAL',
      label: 'osobny posiłek: Pół croissanta maślanego (W 13 g · B 2,5 g · T 6 g)',
      content: { description: 'Pół croissanta maślanego', carbs_g: 13, protein_g: 2.5, fat_g: 6, edit: { description: 'Pół croissanta maślanego', macros: { carbs_g: 13, protein_g: 2.5, fat_g: 6 } } },
    });
    // 13 g against the loop's 10 g is within the 5 g tolerance: no warning about the loop entry.
    expect(withItems.warnings.map((warning) => warning.code)).not.toContain('LOOP_CARBS_DIFFER');

    const values = built(buildMealActionProposal({ request: { operation: 'SET_PURPOSE', loop_action_id: ACTION, purpose: 'NEW_MEAL', description: 'Croissant', carbs_g: 26, protein_g: 5, fat_g: 12 }, entry: unanswered }));
    expect(values.payload.after).toMatchObject({ content: { edit: { description: 'Croissant', items: null, macros: { carbs_g: 26, protein_g: 5, fat_g: 12 } } } });
    expect(values.warnings.map((warning) => warning.code)).toContain('LOOP_CARBS_DIFFER');

    const empty = built(buildMealActionProposal({ request: { operation: 'SET_PURPOSE', loop_action_id: ACTION, purpose: 'NEW_MEAL' }, entry: unanswered }));
    expect(empty.payload.after).toEqual(expect.not.objectContaining({ content: expect.anything() }));
    expect(empty.payload.after).toMatchObject({ label: 'osobny posiłek' });

    expect(buildMealActionProposal({ request: { operation: 'SET_PURPOSE', loop_action_id: ACTION, purpose: 'NEW_MEAL', items: [{ name: 'x' }] }, entry: unanswered })).toMatchObject({ ok: false, code: 'INVALID' });
  });

  it('the same answer again is no change', () => {
    expect(buildMealActionProposal({ request: { operation: 'SET_PURPOSE', loop_action_id: ACTION, purpose: 'NEW_MEAL' }, entry: loopEntry() })).toMatchObject({ ok: false, code: 'NO_CHANGE' });
  });

  it('an older carb entry only changes kind; marking the first entry of a meal with others splits them off', () => {
    const legacy = loopEntry({ loop_action_id: null, purpose: null, purpose_meal_id: null, purpose_meal_label: null, bolus_units: null, meal: { meal_id: MEAL, label: 'Obiad', is_anchor: true, entry_count: 2, has_content: true, dependants: 0 } });
    expect(buildMealActionProposal({ request: { operation: 'SET_PURPOSE', carb_event_id: CARB, purpose: 'MEAL_ADDITION', target_meal_id: null }, entry: legacy }).ok).toBe(false);
    const hypo = built(buildMealActionProposal({ request: { operation: 'SET_PURPOSE', carb_event_id: CARB, purpose: 'HYPO_TREATMENT' }, entry: legacy }));
    expect(hypo.before).toMatchObject({ carb_kind: 'MEAL', label: 'posiłek' });
    expect(hypo.payload.after).toMatchObject({ carb_kind: 'HYPO_TREATMENT', label: 'leczenie hipo' });
    expect(hypo.warnings.map((warning) => warning.code)).toEqual(['MEAL_ENTRIES_SPLIT', 'NOT_UNDOABLE']);
  });

  it('only a joined older entry can be taken out of its meal', () => {
    const joined = loopEntry({ loop_action_id: null, purpose: null, meal: { meal_id: MEAL, label: 'Obiad', is_anchor: false, entry_count: 2, has_content: true, dependants: 0 } });
    const detach = (entry: MealActionEntryState) => buildMealActionProposal({ request: { operation: 'DETACH_ENTRY', meal_id: MEAL, carb_event_id: CARB }, meal: meal(), entry });
    expect(built(detach(joined)).payload.undoable).toBe(false);
    expect(detach({ ...joined, meal: { ...joined.meal!, is_anchor: true } }).ok).toBe(false);
    expect(detach(loopEntry({ meal: { ...joined.meal! } })).ok).toBe(false);
  });

  it('the WBT reminder switch is no change when it already is so', () => {
    expect(buildMealActionProposal({ request: { operation: 'SET_WBT_REMINDER', meal_id: MEAL, enabled: false }, meal: meal() })).toMatchObject({ ok: false, code: 'NO_CHANGE' });
    expect(built(buildMealActionProposal({ request: { operation: 'SET_WBT_REMINDER', meal_id: MEAL, enabled: true }, meal: meal({ wbt_reminder_enabled: null }) })).payload.undoable).toBe(false);
  });

  it('undo of a content change restores the previous description, items and values', () => {
    const action = built(buildMealActionProposal({ request: { operation: 'REPLACE_CONTENT', meal_id: MEAL, items: PANCAKES }, meal: meal() }));
    expect(buildUndoRequest(action.operation, action.before, action.payload.after)).toEqual({
      kind: 'CONTENT',
      edit: { description: 'Skyr naturalny (150 g)', items: [SKYR], macros: { carbs_g: 6, protein_g: 16.5, fat_g: 0 } },
    });
  });
});

/** In-memory store: the meal / entry state the test sets, and the change rows the service writes. */
function fakeStore(state: { meal?: MealActionMealState; entry?: MealActionEntryState }) {
  const rows = new Map<string, MealActionRecord>();
  let next = 0;
  const store = {
    rows,
    insertProposal: vi.fn(async ({ action, reason, userMessageId }: { action: BuiltMealAction; reason: string | null; userMessageId: string }) => {
      const id = `00000000-0000-4000-8000-00000000000${next++}`;
      const row: MealActionRecord = {
        id,
        patient_id: PATIENT,
        conversation_id: CONVERSATION,
        user_message_id: userMessageId,
        operation: action.operation,
        meal_record_id: action.meal_record_id,
        carb_event_id: action.carb_event_id,
        loop_action_id: action.loop_action_id,
        title: action.payload.title,
        before: action.before,
        after: action.payload.after,
        undoable: action.payload.undoable,
        warnings: action.warnings,
        base_content_revision: action.base_content_revision,
        status: 'PROPOSED',
        reason,
        decided_by: null,
        decided_at: null,
        applied_content_revision: null,
        undone_at: null,
        created_at: '2026-10-19T12:00:00.000Z',
      };
      rows.set(id, row);
      return row;
    }),
    get: vi.fn(async (_p: string, _c: string, id: string) => (rows.has(id) ? { ...rows.get(id)! } : null)),
    claim: vi.fn(async (id: string) => {
      const row = rows.get(id);
      if (!row || row.status !== 'PROPOSED') return null;
      row.status = 'APPLYING';
      return { ...row };
    }),
    release: vi.fn(async (id: string) => { const row = rows.get(id)!; if (row.status === 'APPLYING') row.status = 'PROPOSED'; }),
    finishApplying: vi.fn(async (id: string, status: 'APPLIED' | 'STALE') => { rows.get(id)!.status = status; }),
    reject: vi.fn(async (id: string) => { const row = rows.get(id)!; if (row.status !== 'PROPOSED') return false; row.status = 'REJECTED'; return true; }),
    markStale: vi.fn(async (id: string) => { rows.get(id)!.status = 'STALE'; return true; }),
    applyContent: vi.fn(async ({ action, after }: { action: MealActionRecord; after?: MealActionRecord['after'] }) => {
      const row = rows.get(action.id)!;
      row.status = 'APPLIED';
      row.applied_content_revision = 5;
      if (after) row.after = after;
      return 5;
    }),
    undoContent: vi.fn(async ({ action }: { action: MealActionRecord }) => { rows.get(action.id)!.status = 'UNDONE'; }),
    markUndone: vi.fn(async (action: MealActionRecord) => { rows.get(action.id)!.status = 'UNDONE'; return true; }),
    addMealChatNote: vi.fn(async () => undefined),
    loadMealState: vi.fn(async () => (state.meal ? { identity: 'meal:identity', state: state.meal } : null)),
    loadTargetMeal: vi.fn(async (_p: string, id: string) => (id === OTHER_MEAL ? { meal_id: OTHER_MEAL, label: 'Obiad', status: 'CONFIRMED' as const } : null)),
    loadEntryState: vi.fn(async () => state.entry ?? null),
  };
  return store;
}

function fakeWriters(): MealActionWriters & Record<string, ReturnType<typeof vi.fn>> {
  return {
    assignLoopAction: vi.fn(async () => undefined),
    setCarbEntryKind: vi.fn(async () => undefined),
    detachCarbEntry: vi.fn(async () => undefined),
    setWbtReminder: vi.fn(async () => undefined),
    afterMealValuesChanged: vi.fn(async () => undefined),
  } as any;
}

async function proposed(service: ConversationMealActionsService, request: MealActionRequest): Promise<MealActionRecord> {
  const result = await service.propose({ patientId: PATIENT, conversationId: CONVERSATION, userMessageId: USER_MESSAGE, request, reason: 'Opiekun napisał, że zjadł naleśniki.' });
  if (result.status !== 'PROPOSED') throw new Error(`expected PROPOSED, got ${result.status}: ${result.problem}`);
  return result.action;
}

const ids = (action: MealActionRecord) => ({ patientId: PATIENT, conversationId: CONVERSATION, actionId: action.id, userId: CAREGIVER });

describe('conversation meal actions service', () => {
  it('writes nothing when proposing; a confirmed content change is saved once, on the revision it was prepared on', async () => {
    const store = fakeStore({ meal: meal() });
    const writers = fakeWriters();
    const service = new ConversationMealActionsService(store as unknown as MealActionStore, writers);
    const action = await proposed(service, { operation: 'REPLACE_CONTENT', meal_id: MEAL, items: PANCAKES });
    expect(store.applyContent).not.toHaveBeenCalled();

    const applied = await service.apply(ids(action));
    expect(applied.status).toBe('APPLIED');
    expect(store.applyContent).toHaveBeenCalledWith(expect.objectContaining({
      identity: 'meal:identity',
      userId: CAREGIVER,
      edit: expect.objectContaining({ description: 'Naleśnik (120 g), Twaróg półtłusty (60 g)', macros: { carbs_g: 36.3, protein_g: 18.9, fat_g: 10.8 } }),
      note: expect.stringContaining('Zmiana z Rozmów: Zmiana posiłku'),
    }));
    expect(writers.afterMealValuesChanged).toHaveBeenCalledWith({ patientId: PATIENT, mealRecordId: MEAL, identity: 'meal:identity' });

    // A second tap (or the other phone) does not save again.
    await service.apply(ids(action));
    expect(store.applyContent).toHaveBeenCalledTimes(1);
  });

  it('a change prepared on an outdated meal becomes STALE and is returned, not thrown', async () => {
    const store = fakeStore({ meal: meal() });
    store.applyContent.mockRejectedValueOnce(new StaleWriteError('MEAL_CHANGED: meal is at revision 5'));
    const service = new ConversationMealActionsService(store as unknown as MealActionStore, fakeWriters());
    const action = await proposed(service, { operation: 'UPDATE_MACROS', meal_id: MEAL, fat_g: 12 });
    await expect(service.apply(ids(action))).resolves.toMatchObject({ status: 'STALE' });
  });

  it('an unexpected failure leaves the card confirmable and reports the error', async () => {
    const store = fakeStore({ meal: meal() });
    store.applyContent.mockRejectedValueOnce(new Error('connection reset'));
    const service = new ConversationMealActionsService(store as unknown as MealActionStore, fakeWriters());
    const action = await proposed(service, { operation: 'UPDATE_MACROS', meal_id: MEAL, fat_g: 12 });
    await expect(service.apply(ids(action))).rejects.toThrow('connection reset');
    expect(store.rows.get(action.id)?.status).toBe('PROPOSED');
  });

  it('"Popraw": the caregiver values are saved and shown, items that no longer add up are dropped', async () => {
    const store = fakeStore({ meal: meal() });
    const service = new ConversationMealActionsService(store as unknown as MealActionStore, fakeWriters());
    const action = await proposed(service, { operation: 'REPLACE_CONTENT', meal_id: MEAL, items: PANCAKES });
    const applied = await service.apply({ ...ids(action), edited: { carbs_g: 40, description: 'Naleśniki z serem' } });
    expect(store.applyContent.mock.calls[0][0].edit).toEqual({ description: 'Naleśniki z serem', items: null, macros: { carbs_g: 40, protein_g: 18.9, fat_g: 10.8 } });
    expect(applied.after).toMatchObject({ description: 'Naleśniki z serem', carbs_g: 40, items: null });
  });

  it('"Popraw" refuses values out of range and keeps the card waiting', async () => {
    const store = fakeStore({ meal: meal() });
    const service = new ConversationMealActionsService(store as unknown as MealActionStore, fakeWriters());
    const action = await proposed(service, { operation: 'REPLACE_CONTENT', meal_id: MEAL, items: PANCAKES });
    await expect(service.apply({ ...ids(action), edited: { carbs_g: 5000 } })).rejects.toBeInstanceOf(ValidationError);
    expect(store.rows.get(action.id)?.status).toBe('PROPOSED');
  });

  it('a loop entry purpose is assigned with the answer the card showed as expected; a different answer meanwhile is STALE', async () => {
    const store = fakeStore({ entry: loopEntry({ purpose: null, purpose_meal_id: null, purpose_meal_label: null, meal: null }) });
    const writers = fakeWriters();
    const service = new ConversationMealActionsService(store as unknown as MealActionStore, writers);
    const action = await proposed(service, { operation: 'SET_PURPOSE', loop_action_id: ACTION, purpose: 'MEAL_ADDITION', target_meal_id: OTHER_MEAL });
    await expect(service.apply(ids(action))).resolves.toMatchObject({ status: 'APPLIED' });
    expect(writers.assignLoopAction).toHaveBeenCalledWith({
      patientId: PATIENT,
      actionId: ACTION,
      purpose: 'MEAL_ADDITION',
      mealRecordId: OTHER_MEAL,
      userId: CAREGIVER,
      expected: { purpose: null, mealRecordId: null },
    });
    expect(store.addMealChatNote).toHaveBeenCalledWith(expect.anything(), OTHER_MEAL, CAREGIVER, expect.stringContaining('dokładka do: Obiad'));

    const second = await proposed(service, { operation: 'SET_PURPOSE', loop_action_id: ACTION, purpose: 'IGNORED' });
    writers.assignLoopAction.mockRejectedValueOnce(new StaleWriteError('LOOP_ACTION_CHANGED'));
    await expect(service.apply(ids(second))).resolves.toMatchObject({ status: 'STALE' });
  });

  it('a loop entry made a meal of its own with what was eaten: the new meal is described on "Zatwierdź"', async () => {
    const state: { meal?: MealActionMealState; entry?: MealActionEntryState } = { entry: loopEntry({ purpose: null, purpose_meal_id: null, purpose_meal_label: null, meal: null }) };
    const store = fakeStore(state);
    const writers = fakeWriters();
    // The loop's write creates the meal: from then on the entry is NEW_MEAL with its meal.
    writers.assignLoopAction.mockImplementation(async () => {
      state.entry = loopEntry();
      state.meal = meal({ status: 'AWAITING_DESCRIPTION', description: null, items: null, carbs_g: null, protein_g: null, fat_g: null, content_revision: 0 });
    });
    const service = new ConversationMealActionsService(store as unknown as MealActionStore, writers);
    const croissant = [{ name: 'Croissant maślany', grams: 30, carbs_g: 13, protein_g: 2.5, fat_g: 6, source: 'DIABCALC' }];
    const action = await proposed(service, { operation: 'SET_PURPOSE', loop_action_id: ACTION, purpose: 'NEW_MEAL', items: croissant, description: 'Pół croissanta maślanego' });
    const applied = await service.apply(ids(action));
    expect(applied.status).toBe('APPLIED');
    expect(store.applyContent).toHaveBeenCalledWith(expect.objectContaining({
      action: expect.objectContaining({ id: action.id, meal_record_id: MEAL }),
      identity: 'meal:identity',
      edit: { description: 'Pół croissanta maślanego', items: [expect.objectContaining({ name: 'Croissant maślany' })], macros: { carbs_g: 13, protein_g: 2.5, fat_g: 6 } },
      note: expect.stringContaining('osobny posiłek: Pół croissanta maślanego (W 13 g · B 2,5 g · T 6 g)'),
    }));
    expect(writers.afterMealValuesChanged).toHaveBeenCalledWith({ patientId: PATIENT, mealRecordId: MEAL, identity: 'meal:identity' });
    expect(store.finishApplying).not.toHaveBeenCalled();
    // The card can open the meal it made; the app never sees the internal edit.
    const view = toMealActionView(applied);
    expect(view.meal_id).toBe(MEAL);
    expect(JSON.stringify(view)).not.toContain('"edit"');
  });

  it('a new meal whose entry was answered otherwise before its content was saved is STALE', async () => {
    const state: { meal?: MealActionMealState; entry?: MealActionEntryState } = { entry: loopEntry({ purpose: null, purpose_meal_id: null, purpose_meal_label: null, meal: null }) };
    const store = fakeStore(state);
    const writers = fakeWriters();
    writers.assignLoopAction.mockImplementation(async () => { state.entry = loopEntry({ purpose: 'IGNORED', purpose_meal_id: null }); });
    const service = new ConversationMealActionsService(store as unknown as MealActionStore, writers);
    const action = await proposed(service, { operation: 'SET_PURPOSE', loop_action_id: ACTION, purpose: 'NEW_MEAL', description: 'Croissant', carbs_g: 13 });
    await expect(service.apply(ids(action))).resolves.toMatchObject({ status: 'STALE' });
    expect(store.applyContent).not.toHaveBeenCalled();
  });

  it('an older entry whose kind changed after the card was prepared is STALE', async () => {
    const entry = loopEntry({ loop_action_id: null, purpose: null, purpose_meal_id: null, purpose_meal_label: null, meal: null });
    const state = { entry };
    const store = fakeStore(state);
    const writers = fakeWriters();
    const service = new ConversationMealActionsService(store as unknown as MealActionStore, writers);
    const action = await proposed(service, { operation: 'SET_PURPOSE', carb_event_id: CARB, purpose: 'CORRECTION' });
    state.entry = { ...entry, kind: 'IGNORED' };
    await expect(service.apply(ids(action))).resolves.toMatchObject({ status: 'STALE' });
    expect(writers.setCarbEntryKind).not.toHaveBeenCalled();
  });

  it('a rejected card cannot be confirmed afterwards', async () => {
    const service = new ConversationMealActionsService(fakeStore({ meal: meal() }) as unknown as MealActionStore, fakeWriters());
    const action = await proposed(service, { operation: 'UPDATE_DESCRIPTION', meal_id: MEAL, description: 'Obiad u babci' });
    await expect(service.reject(ids(action))).resolves.toMatchObject({ status: 'REJECTED' });
    await expect(service.reject(ids(action))).resolves.toMatchObject({ status: 'REJECTED' });
    await expect(service.apply(ids(action))).rejects.toBeInstanceOf(ConflictError);
  });

  it('"Cofnij" restores the previous content; a change without undo refuses it', async () => {
    const store = fakeStore({ meal: meal() });
    const writers = fakeWriters();
    const service = new ConversationMealActionsService(store as unknown as MealActionStore, writers);
    const action = await proposed(service, { operation: 'REPLACE_CONTENT', meal_id: MEAL, items: PANCAKES });
    await service.apply(ids(action));
    await expect(service.undo(ids(action))).resolves.toMatchObject({ status: 'UNDONE' });
    expect(store.undoContent).toHaveBeenCalledWith(expect.objectContaining({
      edit: { description: 'Skyr naturalny (150 g)', items: [SKYR], macros: { carbs_g: 6, protein_g: 16.5, fat_g: 0 } },
      note: expect.stringContaining('Cofnięto zmianę z Rozmów'),
    }));
    expect(writers.afterMealValuesChanged).toHaveBeenCalledTimes(2);

    const loopStore = fakeStore({ entry: loopEntry() });
    const loopService = new ConversationMealActionsService(loopStore as unknown as MealActionStore, fakeWriters());
    const removal = await proposed(loopService, { operation: 'SET_PURPOSE', loop_action_id: ACTION, purpose: 'CORRECTION' });
    await loopService.apply(ids(removal));
    await expect(loopService.undo(ids(removal))).rejects.toBeInstanceOf(ConflictError);
  });

  it('the card view never carries the internal edit and says which buttons it has', async () => {
    const service = new ConversationMealActionsService(fakeStore({ meal: meal() }) as unknown as MealActionStore, fakeWriters());
    const action = await proposed(service, { operation: 'REPLACE_CONTENT', meal_id: MEAL, items: PANCAKES });
    const view = toMealActionView(action);
    expect(view.after).not.toHaveProperty('edit');
    expect(view).toMatchObject({ can_apply: true, can_edit: true, can_undo: false, meal_id: MEAL, reason: 'Opiekun napisał, że zjadł naleśniki.' });
  });

  it('an impossible change is reported back with the reason, nothing is stored', async () => {
    const store = fakeStore({ meal: meal({ status: 'CANCELLED' }) });
    const service = new ConversationMealActionsService(store as unknown as MealActionStore, fakeWriters());
    await expect(service.propose({ patientId: PATIENT, conversationId: CONVERSATION, userMessageId: USER_MESSAGE, request: { operation: 'UPDATE_MACROS', meal_id: MEAL, carbs_g: 30 } }))
      .resolves.toMatchObject({ status: 'INVALID' });
    expect(store.insertProposal).not.toHaveBeenCalled();
  });
});
