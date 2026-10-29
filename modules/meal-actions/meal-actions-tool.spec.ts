import { describe, expect, it, vi } from 'vitest';
import { finalizeMealActionAnswer, MealActionsToolSession, type MealActionsCatalog } from './application/meal-actions-tool';
import { continuesMealAssistant, isMealActionsEnabled, isMealEditRequest } from './application/meal-edit-intent';
import type { MealActionCatalogEntry, MealActionMealState } from './application/meal-action-policy';
import type { MealActionRecord } from './application/conversation-meal-actions.service';

const LUNCH = '1a2b3c4d-0000-4000-8000-000000000001';
const SNACK = '9f8e7d6c-0000-4000-8000-000000000002';
const LUNCH_CARB = 'aaaa1111-0000-4000-8000-000000000003';
const ADD_ON_CARB = 'bbbb2222-0000-4000-8000-000000000004';
const ADD_ON_ACTION = 'cccc3333-0000-4000-8000-000000000005';
const NOW = new Date('2026-10-19T12:30:00.000Z');

function meal(id: string, startedAt: string, description: string): MealActionMealState {
  return {
    meal_id: id,
    started_at: startedAt,
    status: 'CONFIRMED',
    description,
    items: null,
    carbs_g: 30,
    protein_g: 10,
    fat_g: 8,
    content_revision: 2,
    loop_carbs_g: 30,
    wbt_reminder_enabled: false,
  };
}

const ENTRIES: MealActionCatalogEntry[] = [
  { carb_event_id: ADD_ON_CARB, loop_action_id: ADD_ON_ACTION, occurred_at: '2026-10-19T11:30:00.000Z', carbs_g: 15, bolus_units: null, kind: 'MEAL', purpose: null, purpose_meal_id: null, meal_id: null },
  { carb_event_id: LUNCH_CARB, loop_action_id: null, occurred_at: '2026-10-19T11:10:00.000Z', carbs_g: 30, bolus_units: null, kind: 'MEAL', purpose: null, purpose_meal_id: null, meal_id: LUNCH },
];

function session(overrides: { meals?: MealActionMealState[]; mealChangeRequested?: boolean } = {}) {
  const catalog: MealActionsCatalog & Record<string, ReturnType<typeof vi.fn>> = {
    listMealStatesBetween: vi.fn(async () => overrides.meals ?? [meal(LUNCH, '2026-10-19T11:10:00.000Z', 'Zupa pomidorowa'), meal(SNACK, '2026-10-18T14:00:00.000Z', 'Jabłko')]),
    listEntriesBetween: vi.fn(async () => ENTRIES),
    listForConversation: vi.fn(async () => [{ title: 'Zmiana posiłku · Zupa', status: 'APPLIED', meal_record_id: LUNCH } as MealActionRecord]),
  } as any;
  const propose = vi.fn(async (args: any) => ({
    status: 'PROPOSED' as const,
    action: {
      id: 'action-1',
      title: 'Zmiana posiłku · Zupa pomidorowa (13:10)',
      before: { kind: 'CONTENT', description: 'Zupa pomidorowa', carbs_g: 30 },
      after: { kind: 'CONTENT', description: 'Naleśnik (120 g)', carbs_g: 34.2, edit: { macros: {} } },
      warnings: [{ code: 'LOOP_CARBS_DIFFER', message: 'Pętla dostała 30 g.' }],
      request: args.request,
    } as unknown as MealActionRecord,
  }));
  const tools = new MealActionsToolSession({
    patientId: 'patient-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    service: { propose } as any,
    catalog,
    mealChangeRequested: overrides.mealChangeRequested ?? true,
    now: () => NOW,
    timeZone: 'Europe/Warsaw',
  });
  return { tools, catalog, propose };
}

describe('get_meals', () => {
  it('lists meals and loop entries by short handles, with the changes of this conversation', async () => {
    const { tools, catalog } = session();
    const result = await tools.getMeals({ days_back: null }) as any;

    expect(result.meals.map((entry: any) => [entry.meal, entry.time, entry.description])).toEqual([['M1a2b3c', '13:10', 'Zupa pomidorowa'], ['M9f8e7d', '16:00', 'Jabłko']]);
    expect(result.meals[0]).toMatchObject({ wbt: 1.1, loop_carbs_g: 30, entries: ['Eaaaa11'] });
    expect(result.entries).toEqual([
      { entry: 'Ebbbb22', date: '2026-10-19', time: '13:30', carbs_g: 15, bolus_units: null, answer: 'UNANSWERED', meal: null },
      { entry: 'Eaaaa11', date: '2026-10-19', time: '13:10', carbs_g: 30, bolus_units: null, answer: 'MEAL', meal: 'M1a2b3c' },
    ]);
    expect(result.changes_in_this_conversation).toEqual([{ title: 'Zmiana posiłku · Zupa', status: 'APPLIED', meal: 'M1a2b3c' }]);
    expect(result.now_local).toBe('2026-10-19 14:30');
    // Two days by default: from shortly before yesterday's local midnight.
    expect(Date.parse(catalog.listMealStatesBetween.mock.calls[0][1])).toBeLessThanOrEqual(Date.parse('2026-10-17T22:00:00.000Z'));
    expect(tools.used).toBe(true);
  });

  it('keeps every handle unique when two ids start the same', async () => {
    const twin = '1a2b3c99-0000-4000-8000-000000000009';
    const { tools } = session({ meals: [meal(LUNCH, '2026-10-19T11:10:00.000Z', 'Zupa'), meal(twin, '2026-10-19T08:00:00.000Z', 'Owsianka')] });
    const result = await tools.getMeals({ days_back: 1 }) as any;
    expect(result.meals.map((entry: any) => entry.meal)).toEqual(['M1a2b3c', 'M1a2b3c99']);
  });
});

describe('propose_meal_change', () => {
  it('resolves handles to ids and never passes the model\'s own ids on', async () => {
    const { tools, propose } = session();
    await tools.getMeals({ days_back: 2 });
    const items = [{ name: 'Naleśnik', grams: 120, carbs_g: 34.2, protein_g: 7.8, fat_g: 8.4, source: 'DIABCALC' }];
    const result = await tools.proposeChange({ operation: 'REPLACE_CONTENT', meal: 'm1A2B3C', entry: null, items, description: null, carbs_g: null, protein_g: null, fat_g: null, purpose: null, target_meal: null, enabled: null, reason: 'Zjadł naleśniki zamiast zupy.' }) as any;

    expect(propose).toHaveBeenCalledWith(expect.objectContaining({
      patientId: 'patient-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      request: { operation: 'REPLACE_CONTENT', meal_id: LUNCH, items, description: null },
      reason: 'Zjadł naleśniki zamiast zupy.',
    }));
    expect(result).toMatchObject({ status: 'PROPOSED', card: { title: 'Zmiana posiłku · Zupa pomidorowa (13:10)', warnings: ['Pętla dostała 30 g.'] } });
    expect(result.card.after).not.toHaveProperty('edit');
    expect(result.note).toContain('Nothing is saved');
    expect(tools.proposed).toHaveLength(1);
  });

  it('a purpose names the loop entry and its meal; values not named stay null (kept)', async () => {
    const { tools, propose } = session();
    await tools.getMeals({ days_back: 1 });
    await tools.proposeChange({ operation: 'SET_PURPOSE', meal: null, entry: 'Ebbbb22', items: null, description: null, carbs_g: null, protein_g: null, fat_g: null, purpose: 'MEAL_ADDITION', target_meal: 'M1a2b3c', enabled: null, reason: 'Dokładka do zupy.' });
    expect(propose.mock.calls[0][0].request).toEqual({ operation: 'SET_PURPOSE', carb_event_id: ADD_ON_CARB, loop_action_id: ADD_ON_ACTION, purpose: 'MEAL_ADDITION', target_meal_id: LUNCH });

    // Content is passed on only for an entry made a meal of its own.
    expect(propose.mock.calls[0][0].request).not.toHaveProperty('description');
    await tools.proposeChange({ operation: 'SET_PURPOSE', meal: null, entry: 'Ebbbb22', items: null, description: 'Croissant', carbs_g: 13, protein_g: 2.5, fat_g: 6, purpose: 'NEW_MEAL', target_meal: null, enabled: null, reason: 'To był croissant.' });
    expect(propose.mock.calls[1][0].request).toEqual({ operation: 'SET_PURPOSE', carb_event_id: ADD_ON_CARB, loop_action_id: ADD_ON_ACTION, purpose: 'NEW_MEAL', target_meal_id: null, items: null, description: 'Croissant', carbs_g: 13, protein_g: 2.5, fat_g: 6 });
    propose.mockClear();

    await tools.proposeChange({ operation: 'UPDATE_MACROS', meal: 'M1a2b3c', entry: null, items: null, description: null, carbs_g: null, protein_g: null, fat_g: 20, purpose: null, target_meal: null, enabled: null, reason: 'Tłuszczu było 20 g.' });
    expect(propose.mock.calls[0][0].request).toEqual({ operation: 'UPDATE_MACROS', meal_id: LUNCH, carbs_g: undefined, protein_g: undefined, fat_g: 20 });
  });

  it('an unknown handle is INVALID and nothing is proposed; a handle from an earlier answer is looked up over the week', async () => {
    const { tools, propose, catalog } = session();
    const unknown = await tools.proposeChange({ operation: 'UPDATE_DESCRIPTION', meal: 'M000000', entry: null, items: null, description: 'Obiad', carbs_g: null, protein_g: null, fat_g: null, purpose: null, target_meal: null, enabled: null, reason: '' });
    expect(unknown).toMatchObject({ status: 'INVALID' });
    expect(propose).not.toHaveBeenCalled();
    expect(catalog.listMealStatesBetween).toHaveBeenCalledTimes(1);

    const { tools: later, propose: laterPropose } = session();
    await later.proposeChange({ operation: 'UPDATE_DESCRIPTION', meal: 'M9f8e7d', entry: null, items: null, description: 'Jabłko i gruszka', carbs_g: null, protein_g: null, fat_g: null, purpose: null, target_meal: null, enabled: null, reason: '' });
    expect(laterPropose.mock.calls[0][0].request).toEqual({ operation: 'UPDATE_DESCRIPTION', meal_id: SNACK, description: 'Jabłko i gruszka' });
  });

  it('reports a refused change back to the model', async () => {
    const { tools, propose } = session();
    propose.mockResolvedValueOnce({ status: 'NO_CHANGE', problem: 'the meal already looks like this' } as any);
    await tools.getMeals({ days_back: 1 });
    await expect(tools.proposeChange({ operation: 'SET_WBT_REMINDER', meal: 'M1a2b3c', entry: null, items: null, description: null, carbs_g: null, protein_g: null, fat_g: null, purpose: null, target_meal: null, enabled: false, reason: '' }))
      .resolves.toEqual({ tool: 'propose_meal_change', status: 'NO_CHANGE', problem: 'the meal already looks like this' });
  });
});

describe('the stored answer', () => {
  it('adds one plain sentence when the text claims a meal was saved', () => {
    const proposed = { used: true, proposed: [{} as MealActionRecord] };
    expect(finalizeMealActionAnswer('Zapisałem nowy obiad: W 36 g.', proposed)).toEqual({
      text: 'Zapisałem nowy obiad: W 36 g.\n\nUwaga: zmiana zapisze się dopiero po naciśnięciu „Zatwierdź” na karcie poniżej.',
      corrected: true,
    });
    expect(finalizeMealActionAnswer('Usunąłem ten posiłek.', { used: true, proposed: [] }).text).toContain('nic nie zostało zapisane');
    expect(finalizeMealActionAnswer('Przygotowałem zmianę do zatwierdzenia; zostanie zapisana po „Zatwierdź”.', proposed).corrected).toBe(false);
    expect(finalizeMealActionAnswer('Zapisałem to w notatce.', null).corrected).toBe(false);
  });
});

describe('meal change requests', () => {
  it.each([
    'Zamiast ostatniego posiłku Staś zjadł dwa naleśniki z serem',
    'popraw obiad, tłuszczu było 20 g',
    'to wpisane o 15:00 to były węgle korekcyjne',
    'usuń posiłek z 12:30',
    'zjadł tylko połowę kanapki',
    'zmień opis kolacji na pierogi ruskie',
    'nie przypominaj o WBT do kolacji',
    'to była dokładka do obiadu',
    'Zjadła jednak całą porcję',
    'zapisz ten posiłek jako spaghetti bolognese',
    'te 15 g o 13:30 to było na hipo',
  ])('is a meal change: %s', (text) => {
    expect(isMealEditRequest(text)).toBe(true);
  });

  it.each([
    'ile insuliny na dokładkę?',
    'czy dokładka podniosła cukier?',
    'dlaczego po obiedzie rośnie?',
    'jak zmienić przelicznik na obiad?',
    'jaki był cukier po śniadaniu?',
    'przeanalizuj posiłki z tygodnia',
    'dziękuję!',
    'Co to jest WBT?',
    'Czym są WW?',
  ])('is not a meal change: %s', (text) => {
    expect(isMealEditRequest(text)).toBe(false);
  });

  it('a short reply after an answer working on a meal continues it', () => {
    const messages = [
      { id: 'u1', role: 'USER', content: 'zamiast zupy zjadł naleśniki' },
      { id: 'a1', role: 'ASSISTANT', content: 'Ile sera?', metadata: { meal_assistant: true } },
      { id: 'u2', role: 'USER', content: 'około 50 g' },
    ];
    expect(continuesMealAssistant(messages, 'około 50 g', 'u2')).toBe(true);
    expect(continuesMealAssistant(messages, 'około 50 g')).toBe(true);
    expect(continuesMealAssistant([...messages, { id: 'a2', role: 'ASSISTANT', content: 'Analiza', metadata: {} }], 'a jutro?')).toBe(false);
    expect(continuesMealAssistant(messages, 'x'.repeat(200))).toBe(false);
    // Short, but about the glucose now or a dose: answered with the patient's data, not the meal tools.
    expect(continuesMealAssistant(messages, 'a teraz spada do 60, co robić?')).toBe(false);
    expect(continuesMealAssistant(messages, 'ile insuliny na to?')).toBe(false);
    expect(continuesMealAssistant(messages, 'dlaczego potem spadł?')).toBe(false);
    expect(continuesMealAssistant(messages, 'to było na hipo')).toBe(true);
  });

  it('an analysis that only looked meals up is not a meal answer', async () => {
    const { tools } = session({ mealChangeRequested: false });
    await tools.getMeals({ days_back: null });
    expect(tools.used).toBe(false);
  });

  it('is off unless AI_ENABLE_MEAL_ACTIONS is set', () => {
    expect(isMealActionsEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isMealActionsEnabled({ AI_ENABLE_MEAL_ACTIONS: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isMealActionsEnabled({ AI_ENABLE_MEAL_ACTIONS: 'off' } as NodeJS.ProcessEnv)).toBe(false);
  });
});
