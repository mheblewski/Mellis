import { describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError } from '@shared/errors/app-error';
import { ApiService } from './api.service';

// The planned meal's bolus card (card A): the chat's card without a conversation or the model;
// offline, repositories stubbed.

const PATIENT = '11111111-1111-4111-8111-111111111111';
const ENTRY = '22222222-2222-4222-8222-222222222222';
const CARD = '44444444-4444-4444-8444-444444444444';
const CAREGIVER = { user_id: '33333333-3333-4333-8333-333333333333' } as any;
const NEW_ID = '55555555-5555-4555-8555-555555555555';

const dishes = [
  { name: 'Krupnik z kaszą jęczmienną 250 ml', carbs_g: 15, protein_g: 4, fat_g: 3 },
  { name: 'Kisiel owocowy 150 g', carbs_g: 25, protein_g: 0, fat_g: 0 },
];

function setup(options: { cards?: unknown[]; glucose?: number; delta?: number; entry?: Record<string, unknown> } = {}) {
  const entryOverrides = options.entry ?? {};
  const api = new ApiService({} as any, {} as any) as any;
  const inserted: any[] = [];
  api.assertCanSendRemoteCommands = vi.fn(async () => undefined);
  api.mealPlans = { getEntry: vi.fn(async (_patient: string, id: string) => (id === ENTRY ? { id: ENTRY, title: 'Zupa i podwieczorek', items: dishes, kind: 'MEAL', status: 'PLANNED', dose_answer: null, planned_at: new Date(Date.now() + 10 * 60_000).toISOString(), ...entryOverrides } : null)) };
  api.plannedBoluses = { summariesForProposals: vi.fn(async () => new Map()) };
  api.bolusProposals = {
    listForMealPlanEntry: vi.fn(async () => options.cards ?? []),
    discardUnsentForMealPlanEntry: vi.fn(async () => undefined),
    insert: vi.fn(async (proposal: any) => { const record = { ...proposal, id: NEW_ID, status: 'PROPOSED', created_at: new Date().toISOString() }; inserted.push(record); return record; }),
    discard: vi.fn(async () => undefined),
  };
  api.remoteCommandContext = vi.fn(async (_patientId: string, now: Date) => ({
    now: now.toISOString(),
    glucose: { value: options.glucose ?? 150, observed_at: new Date(now.getTime() - 3 * 60_000).toISOString(), delta: options.delta ?? 2 },
    lowest_recent_glucose: options.glucose ?? 140,
    loop: { iob_units: 0, cob_grams: 0, observed_at: new Date(now.getTime() - 4 * 60_000).toISOString() },
    last_bolus: null,
    icr_g_per_u: 8.3,
    bolus_history_known: false,
    forecast_inputs: {},
    meal_forecast: options.glucose !== undefined && options.glucose < 70
      ? { readings: [82, 76, 70, options.glucose].map((value, index) => ({ at: new Date(now.getTime() - ((3 - index) * 5 + 1) * 60_000).toISOString(), value })), prediction: null, profile_isf: 120, profile_target: 100, profile_units: 'mg/dL' }
      : null,
  }));
  return { api: api as ApiService, raw: api, inserted };
}

describe('the planned meal bolus card', () => {
  it('is made for the dishes on the phone, belongs to the meal and replaces the unsent cards', async () => {
    const { api, raw, inserted } = setup();
    const result = await api.mealPlanBolusCard(CAREGIVER, PATIENT, ENTRY, { items: dishes });
    expect(raw.bolusProposals.discardUnsentForMealPlanEntry).toHaveBeenCalledWith(PATIENT, ENTRY);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ conversation_id: null, user_message_id: null, meal_plan_entry_id: ENTRY, purpose: 'MEAL', carbs_g: 40 });
    expect(inserted[0].meal_payload.description).toBe('Zupa i podwieczorek');
    expect(inserted[0].insulin_u).toBeGreaterThan(0);
    expect(result.proposal).toMatchObject({ id: NEW_ID, carbs_g: 40, state: 'PROPOSED', fast_carbs_first: null });
  });

  it('gives the meal carbs without insulin and the dose when glucose stops falling, at a low', async () => {
    const { api, inserted } = setup({ glucose: 64, delta: -3 });
    const result = await api.mealPlanBolusCard(CAREGIVER, PATIENT, ENTRY, { items: dishes });
    expect(inserted[0]).toMatchObject({ carbs_g: 40, insulin_u: 0 });
    expect(JSON.stringify(inserted[0].split)).toContain('GLUCOSE_STOPPED_FALLING');
    expect(result.proposal).toMatchObject({ insulin_u: 0 });
  });

  it('returns the card already sent from this meal instead of a new one', async () => {
    const sent = {
      proposal: { ...{ id: CARD, patient_id: PATIENT, conversation_id: null, user_message_id: null, meal_plan_entry_id: ENTRY, purpose: 'MEAL', carbs_g: 40, insulin_u: 0, icr_g_per_u: 8.3, icr_insulin_u: 4.8, meal_payload: { description: 'Zupa i podwieczorek', items: null, macros: null }, reason: null, warnings: [], split: null, dose_adjustment: null, card_advice: null, option_key: null, status: 'PROPOSED' }, expires_at: new Date(Date.now() - 60_000).toISOString(), created_at: new Date(Date.now() - 20 * 60_000).toISOString() },
      command: { id: 'rc1', status: 'SUCCEEDED', status_message: null, carbs_g: 40, insulin_u: 0, meal_record_id: null, user_id: CAREGIVER.user_id, authorized_at: new Date().toISOString() },
    };
    const { api, inserted, raw } = setup({ cards: [sent] });
    const result = await api.mealPlanBolusCard(CAREGIVER, PATIENT, ENTRY, { items: dishes });
    expect(inserted).toHaveLength(0);
    expect(raw.bolusProposals.discardUnsentForMealPlanEntry).not.toHaveBeenCalled();
    expect(result.proposal).toMatchObject({ id: CARD, state: 'SENT' });
  });

  it('makes no new card for a meal already dosed, no longer planned or outside the dose window', async () => {
    const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
    for (const [entry, problem] of [
      [{ dose_answer: 'THIS_MEAL' }, /podano już bolus/],
      [{ status: 'SKIPPED' }, /nie ma już w planie/],
      [{ kind: 'MOVEMENT' }, /nie ma już w planie/],
      [{ planned_at: minutes(24 * 60) }, /od 30 minut przed/],
      [{ planned_at: minutes(-50) }, /od 30 minut przed/],
    ] as const) {
      const { api, inserted } = setup({ entry });
      const answer = await api.mealPlanBolusCard(CAREGIVER, PATIENT, ENTRY, { items: dishes });
      expect(answer.proposal).toBeNull();
      expect(answer.problem).toMatch(problem);
      expect(inserted).toEqual([]);
    }
  });

  it('refuses an unknown meal', async () => {
    const { api } = setup();
    await expect(api.mealPlanBolusCard(CAREGIVER, PATIENT, '99999999-9999-4999-8999-999999999999', { items: dishes })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('switches to a variant without a conversation and refuses a card already given', async () => {
    const first = setup();
    await first.api.mealPlanBolusCard(CAREGIVER, PATIENT, ENTRY, { items: dishes });
    const card = first.inserted[0];
    const kind = card.card_advice.variants[0]?.kind;
    expect(kind).toBeTruthy();
    const { api, inserted, raw } = setup({ cards: [{ proposal: { ...card, id: CARD }, command: null }] });
    const result = await api.chooseMealPlanBolusVariant(CAREGIVER, PATIENT, ENTRY, CARD, { kind });
    expect(inserted[0]).toMatchObject({ conversation_id: null, meal_plan_entry_id: ENTRY });
    expect(raw.bolusProposals.discard).toHaveBeenCalledWith(PATIENT, CARD);
    expect(result.proposal).toMatchObject({ id: NEW_ID });
    const given = setup({ cards: [{ proposal: { ...card, id: CARD }, command: { id: 'rc1', status: 'SUCCEEDED', status_message: null, carbs_g: 40, insulin_u: 4.8, meal_record_id: null, user_id: CAREGIVER.user_id } }] });
    await expect(given.api.chooseMealPlanBolusVariant(CAREGIVER, PATIENT, ENTRY, CARD, { kind })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('a Bolus tab dose given to a planned meal', () => {
  it('names the dose meal after the planned meal, adds its protein and fat and answers the meal as given', async () => {
    const api = new ApiService({} as any, {} as any) as any;
    api.assertCanWritePatient = vi.fn(async () => undefined);
    api.mealPlans = {
      getEntry: vi.fn(async () => ({ id: ENTRY, title: 'Zupa i podwieczorek', items: dishes })),
      setDoseAnswer: vi.fn(async () => ({ id: ENTRY })),
    };
    api.updateMealDescription = vi.fn(async () => ({}));
    api.correctMealMacros = vi.fn(async () => ({}));
    const meal = '66666666-6666-4666-8666-666666666666';
    const result = await (api as ApiService).attachDoseToPlannedMeal(CAREGIVER, PATIENT, ENTRY, { meal_id: meal });
    expect(api.updateMealDescription).toHaveBeenCalledWith(CAREGIVER, PATIENT, meal, { description: 'Zupa i podwieczorek: Krupnik z kaszą jęczmienną 250 ml 15 g, Kisiel owocowy 150 g 25 g' });
    expect(api.correctMealMacros).toHaveBeenCalledWith(CAREGIVER, PATIENT, meal, { protein_g: 4, fat_g: 3 });
    expect(api.mealPlans.setDoseAnswer).toHaveBeenCalledWith(PATIENT, ENTRY, 'THIS_MEAL', CAREGIVER.user_id);
    expect(result).toEqual({ patient_id: PATIENT, meal_name: 'Zupa i podwieczorek' });
  });
});
