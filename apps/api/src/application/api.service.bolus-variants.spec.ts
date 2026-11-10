import { describe, expect, it, vi } from 'vitest';
import { ConflictError, ValidationError } from '@shared/errors/app-error';
import { ApiService } from './api.service';

// card-variants.v1: a variant button replaces the card with the chosen plan, computed again; offline, repositories stubbed.

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const CARD = '44444444-4444-4444-8444-444444444444';
const CAREGIVER = { user_id: '33333333-3333-4333-8333-333333333333' } as any;

const mealArgs = {
  purpose: 'MEAL', carbs_g: 46, insulin_u: null, reduce_for_drop: false, add_correction: false, eating_now: false,
  meal_description: 'Makaron', items: [{ name: 'Makaron', grams: 200, carbs_g: 46, protein_g: 8, fat_g: 2, source: 'ESTIMATE' }],
  reason: 'Obiad.', later: null, standard_plan: false, use_advised_split: 'NO', option: null,
};

function stored(overrides: Record<string, unknown> = {}, command: unknown = null) {
  const now = Date.now();
  return {
    proposal: {
      id: CARD, patient_id: PATIENT, conversation_id: CONVERSATION, user_message_id: 'u1', purpose: 'MEAL', carbs_g: 46, insulin_u: 3.8,
      icr_g_per_u: 12, icr_insulin_u: 3.8, meal_payload: { description: 'Makaron', items: mealArgs.items, macros: null }, reason: null, warnings: [],
      split: null, dose_adjustment: null, option_key: null, status: 'PROPOSED',
      card_advice: { policy_version: 'card-advice.v2', risk: null, correction: null, fast_carbs_first: null, reduce_for_drop: null, plan_args: mealArgs, variants: [
        { kind: 'BOLUS_LATER', label: 'Bolus później', carbs_now_g: 46, insulin_now_u: 0, later: [], risk: null, needs_ack: false, ack_text: null, args: { ...mealArgs, insulin_u: 0, later: [{ trigger: 'AFTER_MINUTES', after_minutes: 20, threshold_mgdl: null, carbs_g: 0, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null }] } },
      ] },
      expires_at: new Date(now + 10 * 60_000).toISOString(), created_at: new Date(now - 60_000).toISOString(),
      ...overrides,
    },
    command,
  };
}

function setup(cards: unknown[]) {
  const api = new ApiService({} as any, {} as any) as any;
  const inserted: any[] = [];
  api.assertCanSendRemoteCommands = vi.fn(async () => undefined);
  api.bolusProposals = {
    listForConversation: vi.fn(async () => cards),
    insert: vi.fn(async (proposal: any) => { const record = { ...proposal, id: '55555555-5555-4555-8555-555555555555', status: 'PROPOSED', created_at: new Date().toISOString() }; inserted.push(record); return record; }),
    discard: vi.fn(async () => undefined),
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

describe('a bolus card variant', () => {
  it('replaces the card with the chosen plan under the same answer and takes the old one back', async () => {
    const { api, raw, inserted } = setup([stored()]);
    const result = await api.chooseBolusCardVariant(CAREGIVER, PATIENT, CONVERSATION, CARD, { kind: 'BOLUS_LATER' });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ user_message_id: 'u1', conversation_id: CONVERSATION, carbs_g: 46, insulin_u: 0 });
    expect(result.proposal).toMatchObject({ id: '55555555-5555-4555-8555-555555555555', carbs_g: 46, insulin_u: 0, state: 'PROPOSED' });
    expect(raw.bolusProposals.discard).toHaveBeenCalledWith(PATIENT, CARD);
  });

  it('offers the way back to the first plan on the switched card, and none once back on it', async () => {
    const { api, inserted } = setup([stored()]);
    await api.chooseBolusCardVariant(CAREGIVER, PATIENT, CONVERSATION, CARD, { kind: 'BOLUS_LATER' });
    const switched = inserted[0];
    expect(switched.card_advice.variants[0]).toMatchObject({ kind: 'RECOMMENDED', label: 'Plan karty', carbs_now_g: 46 });
    expect(switched.card_advice.variants[0].insulin_now_u).toBeGreaterThan(0);
    expect(switched.card_advice.plan_args).toMatchObject({ insulin_u: null, later: null });
    // Back on the recommended plan: its own variants again, no "Plan polecany".
    const back = setup([stored({ id: CARD, insulin_u: 0, card_advice: switched.card_advice })]);
    await back.api.chooseBolusCardVariant(CAREGIVER, PATIENT, CONVERSATION, CARD, { kind: 'RECOMMENDED' });
    const kinds = back.inserted[0].card_advice.variants.map((variant: { kind: string }) => variant.kind);
    expect(kinds).not.toContain('RECOMMENDED');
    expect(kinds).toContain('BOLUS_LATER');
    expect(back.inserted[0].insulin_u).toBeGreaterThan(0);
  });

  it('refuses a card already given, an old card and a variant the card does not have', async () => {
    const sent = setup([stored({}, { id: 'rc1', status: 'SUCCEEDED', status_message: null, carbs_g: 46, insulin_u: 3.8, meal_record_id: null, user_id: CAREGIVER.user_id })]);
    await expect(sent.api.chooseBolusCardVariant(CAREGIVER, PATIENT, CONVERSATION, CARD, { kind: 'BOLUS_LATER' })).rejects.toBeInstanceOf(ConflictError);
    const old = setup([stored({ expires_at: new Date(Date.now() - 60_000).toISOString() })]);
    await expect(old.api.chooseBolusCardVariant(CAREGIVER, PATIENT, CONVERSATION, CARD, { kind: 'BOLUS_LATER' })).rejects.toBeInstanceOf(ConflictError);
    const missing = setup([stored()]);
    await expect(missing.api.chooseBolusCardVariant(CAREGIVER, PATIENT, CONVERSATION, CARD, { kind: 'SPLIT' })).rejects.toBeInstanceOf(ValidationError);
    await expect(missing.api.chooseBolusCardVariant(CAREGIVER, PATIENT, CONVERSATION, CARD, { kind: 'ANYTHING' })).rejects.toBeInstanceOf(ValidationError);
    expect(missing.inserted).toHaveLength(0);
  });
});
