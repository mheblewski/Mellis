import { describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '@shared/errors/app-error';
import { ApiService } from './api.service';

// The one way to change a bolus card (POST bolus-cards/{id}/change, owner 2026-11-10): the rest's reminder (REST_LATER)
// and a variant, found from the card itself; and scenario D28, a changed plate or accepted chat stops the old card.
// Ported to release/1.0 by hand, so these pin the routes, not only the card logic. Offline, repositories stubbed.

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const ENTRY = '66666666-6666-4666-8666-666666666666';
const CARD = '44444444-4444-4444-8444-444444444444';
const NEW_CARD = '55555555-5555-4555-8555-555555555555';
const CAREGIVER = { user_id: '33333333-3333-4333-8333-333333333333' } as any;

const mealArgs = {
  purpose: 'MEAL', carbs_g: 46, insulin_u: null, reduce_for_drop: false, add_correction: false, eating_now: false,
  meal_description: 'Makaron', items: [{ name: 'Makaron', grams: 200, carbs_g: 46, protein_g: 8, fat_g: 2, source: 'ESTIMATE' }],
  reason: 'Obiad.', later: null, standard_plan: false, use_advised_split: 'NO', option: null,
};

// A card that gave half of carbs / ICR now (1,9 of 3,8 j) and offers the rest's reminder.
function lowered(overrides: Record<string, unknown> = {}, command: unknown = null) {
  const now = Date.now();
  return {
    proposal: {
      id: CARD, patient_id: PATIENT, conversation_id: CONVERSATION, meal_plan_entry_id: null, user_message_id: 'u1', purpose: 'MEAL', carbs_g: 46, insulin_u: 1.9,
      icr_g_per_u: 12, icr_insulin_u: 3.8, meal_payload: { description: 'Makaron', items: mealArgs.items, macros: null }, reason: null, warnings: [],
      split: null, dose_adjustment: null, option_key: null, status: 'PROPOSED',
      card_advice: {
        policy_version: 'card-advice.v2', risk: null, correction: null, fast_carbs_first: null, reduce_for_drop: null, plan_args: mealArgs,
        card_args: { ...mealArgs, insulin_u: 1.9 },
        rest_offer: { rest_u: 1.9, rest_carbs_g: 23, falling: false, current: null },
        variants: [
          { kind: 'BOLUS_LATER', label: 'Dawka później', carbs_now_g: 46, insulin_now_u: 0, later: [], risk: null, needs_ack: false, ack_text: null, args: { ...mealArgs, insulin_u: 0, later: [{ trigger: 'AFTER_MINUTES', after_minutes: 20, threshold_mgdl: null, carbs_g: 0, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null }] } },
        ],
      },
      expires_at: new Date(now + 10 * 60_000).toISOString(), created_at: new Date(now - 60_000).toISOString(),
      ...overrides,
    },
    command,
  };
}

function setup(cards: Array<ReturnType<typeof lowered>>) {
  const api = new ApiService({} as any, {} as any) as any;
  const inserted: any[] = [];
  api.assertCanSendRemoteCommands = vi.fn(async () => undefined);
  api.assertCanWritePatient = vi.fn(async () => undefined);
  api.bolusProposals = {
    get: vi.fn(async (_patient: string, id: string) => cards.find((card) => card.proposal.id === id)?.proposal ?? null),
    listForConversation: vi.fn(async () => cards),
    insert: vi.fn(async (proposal: any) => { const record = { ...proposal, id: NEW_CARD, status: 'PROPOSED', created_at: new Date().toISOString() }; inserted.push(record); return record; }),
    discard: vi.fn(async () => undefined),
    discardUnsentForMealPlanEntry: vi.fn(async () => undefined),
  };
  api.remoteCommandContext = vi.fn(async (_patientId: string, now: Date) => ({
    now: now.toISOString(),
    glucose: { value: 150, observed_at: new Date(now.getTime() - 3 * 60_000).toISOString(), delta: 2 },
    lowest_recent_glucose: 140,
    loop: { iob_units: 0, cob_grams: 0, observed_at: new Date(now.getTime() - 4 * 60_000).toISOString() },
    last_bolus: null,
    icr_g_per_u: 12,
    bolus_history_known: false,
    forecast_inputs: {},
    meal_forecast: null,
  }));
  return { api: api as ApiService, raw: api, inserted };
}

describe('changing a bolus card by its own id (bolus-cards/{id}/change)', () => {
  it('REST_LATER in 30 min: the same dose now, the rest as the one later part, the old card taken back', async () => {
    const { api, raw, inserted } = setup([lowered()]);
    const result = await api.changeBolusCard(CAREGIVER, PATIENT, CARD, { kind: 'REST_LATER', rest: { trigger: 'AFTER_MINUTES', minutes: 30 } });
    expect(raw.bolusProposals.get).toHaveBeenCalledWith(PATIENT, CARD);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ conversation_id: CONVERSATION, user_message_id: 'u1', carbs_g: 46, insulin_u: 1.9 });
    expect(inserted[0].split).toBeTruthy();
    expect(JSON.stringify(inserted[0].split)).toContain('"later_after_minutes":30');
    expect(raw.bolusProposals.discard).toHaveBeenCalledWith(PATIENT, CARD);
    expect(result.proposal).toMatchObject({ id: NEW_CARD, insulin_u: 1.9, state: 'PROPOSED' });
  });

  it('REST_LATER without a reminder: the same dose now and no later part', async () => {
    const { api, inserted } = setup([lowered()]);
    await api.changeBolusCard(CAREGIVER, PATIENT, CARD, { kind: 'REST_LATER', rest: null });
    expect(inserted[0]).toMatchObject({ insulin_u: 1.9, split: null });
  });

  it('refuses a rest time outside its range, a card without a rest, a sent card and an expired one', async () => {
    await expect(setup([lowered()]).api.changeBolusCard(CAREGIVER, PATIENT, CARD, { kind: 'REST_LATER', rest: { trigger: 'AFTER_MINUTES', minutes: 4 } })).rejects.toBeInstanceOf(ValidationError);
    const noRest = lowered();
    delete (noRest.proposal.card_advice as Record<string, unknown>).rest_offer;
    await expect(setup([noRest]).api.changeBolusCard(CAREGIVER, PATIENT, CARD, { kind: 'REST_LATER', rest: null })).rejects.toBeInstanceOf(ValidationError);
    const sent = lowered({}, { id: 'rc1', status: 'SUCCEEDED', status_message: null, carbs_g: 46, insulin_u: 1.9, authorized_at: new Date().toISOString() });
    await expect(setup([sent]).api.changeBolusCard(CAREGIVER, PATIENT, CARD, { kind: 'REST_LATER', rest: null })).rejects.toBeInstanceOf(ConflictError);
    const expired = lowered({ expires_at: new Date(Date.now() - 1_000).toISOString() });
    await expect(setup([expired]).api.changeBolusCard(CAREGIVER, PATIENT, CARD, { kind: 'REST_LATER', rest: null })).rejects.toBeInstanceOf(ConflictError);
  });

  it('a variant through the same route, and an unknown card is not found', async () => {
    const { api, inserted } = setup([lowered()]);
    await api.changeBolusCard(CAREGIVER, PATIENT, CARD, { kind: 'BOLUS_LATER' });
    expect(inserted[0]).toMatchObject({ conversation_id: CONVERSATION, insulin_u: 0 });
    await expect(setup([]).api.changeBolusCard(CAREGIVER, PATIENT, CARD, { kind: 'BOLUS_LATER' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(setup([lowered()]).api.changeBolusCard(CAREGIVER, PATIENT, CARD, { kind: 'NO_SUCH' })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('later-time.v1: the later dose at the caregiver\'s time', () => {
  const withLater = (minutes: number) => lowered({
    split: { kind: 'SPLIT', trigger: 'AFTER_MINUTES', later_after_minutes: minutes },
    card_advice: { ...lowered().proposal.card_advice, card_args: { ...mealArgs, insulin_u: 1.9, later: [{ trigger: 'AFTER_MINUTES', after_minutes: 90, threshold_mgdl: null, carbs_g: 0, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null }] } },
  });

  it('moves the later dose of a card and keeps the dose now', async () => {
    const { api, raw, inserted } = setup([withLater(90)]);
    await api.changeBolusCard(CAREGIVER, PATIENT, CARD, { kind: 'LATER_TIME', minutes: 120 });
    expect(inserted[0]).toMatchObject({ insulin_u: 1.9 });
    expect(JSON.stringify(inserted[0].split)).toContain('"later_after_minutes":120');
    expect(raw.bolusProposals.discard).toHaveBeenCalledWith(PATIENT, CARD);
  });

  it('refuses a time out of range and a card without a later dose', async () => {
    await expect(setup([withLater(90)]).api.changeBolusCard(CAREGIVER, PATIENT, CARD, { kind: 'LATER_TIME', minutes: 10 })).rejects.toBeInstanceOf(ValidationError);
    const plain = lowered();
    (plain.proposal.card_advice as Record<string, unknown>).card_args = { ...mealArgs, insulin_u: 1.9, later: null };
    await expect(setup([plain]).api.changeBolusCard(CAREGIVER, PATIENT, CARD, { kind: 'LATER_TIME', minutes: 120 })).rejects.toBeInstanceOf(ValidationError);
  });

  it('an advised split keeps its parts and takes the new time', async () => {
    const { laterTimeArgs } = await import('@modules/remote-commands/application/bolus-proposal-tool');
    const advised = { card_advice: { policy_version: 'card-advice.v2', risk: null, card_args: { ...mealArgs, use_advised_split: 'ADVISED' } } } as never;
    expect(laterTimeArgs(advised, 60)).toMatchObject({ use_advised_split: 'ADVISED', split_after_minutes: 60 });
  });

  it('a sent card\'s scheduled part moves to minutes after the meal; a part whose reminder came does not', async () => {
    const { api, raw } = setup([]);
    const MEAL = '77777777-7777-4777-8777-777777777777';
    const PART = '88888888-8888-4888-8888-888888888888';
    raw.assertCanWritePatient = vi.fn(async () => undefined);
    raw.resolveMealIdentity = vi.fn(async () => 'identity');
    raw.mealRecordRepository = { getMealRecord: vi.fn(async () => ({ started_at: '2026-11-10T17:43:00.000Z' })) };
    raw.plannedBolusRepository = { get: vi.fn(async () => ({ id: PART, meal_record_id: MEAL })), moveTo: vi.fn(async () => true) };
    raw.plannedBolusView = vi.fn(async () => ({ ok: true }));
    await api.moveMealPlannedBolus(CAREGIVER, PATIENT, MEAL, { planned_bolus_id: PART, minutes_after_meal: 120 });
    expect(raw.plannedBolusRepository.moveTo).toHaveBeenCalledWith(PATIENT, PART, '2026-11-10T19:43:00.000Z', 120);
    raw.plannedBolusRepository.moveTo = vi.fn(async () => false);
    await expect(api.moveMealPlannedBolus(CAREGIVER, PATIENT, MEAL, { planned_bolus_id: PART, minutes_after_meal: 120 })).rejects.toBeInstanceOf(ConflictError);
    await expect(api.moveMealPlannedBolus(CAREGIVER, PATIENT, MEAL, { planned_bolus_id: PART, minutes_after_meal: 5 })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('scenario D28: the planned meal card made for the old plate stops', () => {
  const entry = (plate: unknown) => ({ id: ENTRY, kind: 'MEAL', status: 'PLANNED', planned_at: new Date().toISOString(), title: 'Obiad', items: [{ name: 'Zupa', carbs_g: 10, protein_g: 1, fat_g: 1 }, { name: 'Kotlet', carbs_g: 20, protein_g: 10, fat_g: 8 }], plate, dose_answer: null });

  function planSetup(before: unknown, after: unknown) {
    const { api, raw } = setup([]);
    raw.mealPlans = { getEntry: vi.fn(async () => entry(before)), setPlate: vi.fn(async () => entry(after)) };
    raw.withMealPlanGiven = vi.fn(async (_patient: string, value: unknown) => ({ ...(value as object), given: null }));
    return { api, raw };
  }

  it('other grams on the plate discard the unsent card', async () => {
    const { api, raw } = planSetup(null, { foods: { Kotlet: { portion: { half: {} } } } });
    await api.setMealPlanPlate(CAREGIVER, PATIENT, ENTRY, { plate: { foods: { Kotlet: { portion: { half: {} } } } } });
    expect(raw.bolusProposals.discardUnsentForMealPlanEntry).toHaveBeenCalledWith(PATIENT, ENTRY);
  });

  it('the same grams keep the card', async () => {
    const { api, raw } = planSetup(null, { foods: {} });
    await api.setMealPlanPlate(CAREGIVER, PATIENT, ENTRY, { plate: { foods: {} } });
    expect(raw.bolusProposals.discardUnsentForMealPlanEntry).not.toHaveBeenCalled();
  });
});
