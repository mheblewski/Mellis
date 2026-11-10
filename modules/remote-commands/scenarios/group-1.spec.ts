import { describe, expect, it, vi } from 'vitest';
import { parseLoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { scheduleValueAt } from '@modules/meal-wbt/application/wbt-policy';
import { withoutDoseHere } from '@modules/meal-chat/application/meal-chat-reply.job';
import { BOLUS_PROPOSAL_INSTRUCTIONS, BolusProposalSession, toBolusProposalView, type NewBolusProposal } from '../application/bolus-proposal-tool';
import type { MealForecastData } from '../application/meal-dose-forecast';
import type { RemoteCommandContext } from '../application/remote-command-policy';
import { RemoteCommandsService } from '../application/remote-commands.service';
import type { NewRemoteCommand, RemoteCommandRecord, RemoteCommandStore } from '../application/remote-command-record';
import {
  calculatorHeldBackU,
  estimatePlannedBolus,
  mealCarbsChangeUpdates,
  mealDoseShortfall,
  plannedBolusCalculatorLine,
  plannedBolusPushContent,
  type PlannedBolusRecord,
} from '../application/split-bolus';
import { ApiService } from '../../../apps/api/src/application/api.service';

// Scenario group 1 (mama + diabetolog): every check runs the server's own logic (card, calculator, parts, meal chat).

const NOW = new Date('2026-11-10T10:25:00.000Z');
const at = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString();
const ICR = 8.3;

/** Trio data as the server reads it: four readings 5 min apart ending `age` min ago and Trio's own IOB curve. */
function trio(options: { glucose: number; per5?: number; iob: number; cob?: number; curve?: number[]; isf?: number; age?: number; loopAge?: number }): MealForecastData {
  const per5 = options.per5 ?? 0;
  const age = options.age ?? 1;
  const curve = options.curve ?? Array.from({ length: 30 }, () => options.glucose);
  return {
    readings: [3, 2, 1, 0].map((back) => ({ at: at(-age - back * 5), value: options.glucose - per5 * back })),
    prediction: parseLoopPrediction({
      observed_at: at(-(options.loopAge ?? 1)),
      raw_payload: { device: 'Trio', openaps: { suggested: { bg: options.glucose, deliverAt: at(-(options.loopAge ?? 1)), IOB: options.iob, COB: options.cob ?? 0, ISF: options.isf ?? 150, CR: ICR, eventualBG: curve.at(-1), predBGs: { IOB: curve } } } },
    }),
    profile_isf: options.isf ?? 150,
    profile_target: 100,
    profile_units: 'mg/dL',
    dia_hours: 6,
  };
}

function context(glucose: number, delta: number, iob: number, forecast: MealForecastData | null, overrides: Partial<RemoteCommandContext> = {}): Omit<RemoteCommandContext, 'in_flight_command_id' | 'recent_remote_bolus'> {
  return {
    now: NOW.toISOString(),
    glucose: { value: glucose, observed_at: at(-1), delta },
    lowest_recent_glucose: glucose,
    loop: { iob_units: iob, cob_grams: 0, observed_at: at(-1) },
    last_bolus: null,
    icr_g_per_u: ICR,
    bolus_history_known: true,
    pump_bolus_step: 0.1,
    meal_forecast: forecast,
    ...overrides,
  } as never;
}

function chatSession(ctx: ReturnType<typeof context>, doseBasis?: 'ICR' | 'CALCULATOR') {
  const stored: NewBolusProposal[] = [];
  const instance = new BolusProposalSession({
    patientId: 'p1', conversationId: 'c1', userMessageId: 'm1', doseRequested: true, now: () => NOW, ...(doseBasis ? { doseBasis } : {}),
    context: async () => ctx,
    store: { insert: async (proposal) => { stored.push(proposal); return { ...proposal, id: `b${stored.length}`, status: 'PROPOSED', created_at: NOW.toISOString() }; } },
  });
  return { instance, stored };
}

const mealArgs = (carbs: number, description: string, items: Array<{ name: string; carbs_g: number; protein_g: number; fat_g: number }>) => ({
  purpose: 'MEAL', carbs_g: carbs, insulin_u: null, reduce_for_drop: false, add_correction: false, eating_now: false,
  meal_description: description, items: items.map((item) => ({ ...item, grams: null, source: 'ESTIMATE' })), reason: description, later: null,
});

// The planned meal's card through ApiService (as api.service.meal-plan-bolus-card.spec.ts), Trio data stubbed.
const PATIENT = '11111111-1111-4111-8111-111111111111';
const ENTRY = '22222222-2222-4222-8222-222222222222';
const MAMA = { user_id: '33333333-3333-4333-8333-333333333333' } as any;
const TATA = { user_id: '77777777-7777-4777-8777-777777777777' } as any;

function planned(ctx: ReturnType<typeof context>, dishes: Array<{ name: string; carbs_g: number; protein_g: number; fat_g: number }>, options: { cards?: unknown[]; basis?: Record<string, 'ICR' | 'CALCULATOR'> } = {}) {
  const api = new ApiService({} as any, {} as any) as any;
  const inserted: any[] = [];
  api.assertCanSendRemoteCommands = vi.fn(async () => undefined);
  api.repository = { getUserDoseBasis: vi.fn(async (userId: string) => options.basis?.[userId] ?? 'ICR') };
  api.mealPlans = { getEntry: vi.fn(async () => ({ id: ENTRY, kind: 'MEAL', status: 'PLANNED', planned_at: new Date().toISOString(), title: 'Obiad', items: dishes, dose_answer: null, given_meal_id: null })), setDoseAnswer: vi.fn(async () => null), setGivenMeal: vi.fn(async () => undefined) };
  api.plannedBoluses = { summariesForProposals: vi.fn(async () => new Map()) };
  api.bolusProposals = {
    listForMealPlanEntry: vi.fn(async () => options.cards ?? []),
    discardUnsentForMealPlanEntry: vi.fn(async () => undefined),
    insert: vi.fn(async (proposal: any) => { const record = { ...proposal, id: '55555555-5555-4555-8555-55555555555' + inserted.length, status: 'PROPOSED', created_at: NOW.toISOString() }; inserted.push(record); return record; }),
    discard: vi.fn(async () => undefined),
  };
  api.remoteCommandContext = vi.fn(async () => ({ ...ctx, forecast_inputs: {} }));
  return { api: api as ApiService, inserted };
}

describe('scenario group 1', () => {
  it('M1', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      // 118 →, IOB 0,2 j, 30 g, ICR 8,3: 30 / 8,3 = 3,61 → 3,6 j at the pump's 0,1 j step.
      const dishes = [{ name: 'Zupa pomidorowa', carbs_g: 10, protein_g: 2, fat_g: 2 }, { name: 'Ziemniaki z kotletem', carbs_g: 20, protein_g: 8, fat_g: 6 }];
      const ctx = context(118, 0, 0.2, trio({ glucose: 118, iob: 0.2 }));
      const mama = planned(ctx, dishes);
      const result: any = await mama.api.mealPlanBolusCard(MAMA, PATIENT, ENTRY, { items: dishes });
      expect(mama.inserted).toHaveLength(1);
      expect(mama.inserted[0]).toMatchObject({ carbs_g: 30, split: null });
      expect(mama.inserted[0].insulin_u).toBe(3.6);
      expect(result.proposal).toMatchObject({ carbs_g: 30, insulin_u: 3.6, state: 'PROPOSED', fast_carbs_first: null });
      // No red warning on the card.
      expect(mama.inserted[0].warnings.filter((warning: any) => warning.severity === 'DANGER')).toEqual([]);
      expect(result.proposal.risk?.level ?? 'NONE').toBe('NONE');
      // Calculator mode on the same data: at most a step below (IOB 0,2 j against a +0,12 j correction).
      const calc = planned(ctx, dishes, { basis: { [MAMA.user_id]: 'CALCULATOR' } });
      await calc.api.mealPlanBolusCard(MAMA, PATIENT, ENTRY, { items: dishes });
      expect(calc.inserted[0].insulin_u).toBeGreaterThanOrEqual(3.5);
      // Tata's phone after mama sent it: the same card comes back as SENT, no second card is made.
      const sent = { proposal: { ...mama.inserted[0], id: '44444444-4444-4444-8444-444444444444', expires_at: at(10) }, command: { id: 'rc1', status: 'SUCCEEDED', status_message: null, carbs_g: 30, insulin_u: 3.6, meal_record_id: '66666666-6666-4666-8666-666666666666', user_id: MAMA.user_id, authorized_at: at(-1) } };
      const tata = planned(ctx, dishes, { cards: [sent] });
      const seen: any = await tata.api.mealPlanBolusCard(TATA, PATIENT, ENTRY, { items: dishes });
      expect(tata.inserted).toHaveLength(0);
      expect(seen.proposal).toMatchObject({ state: 'SENT', insulin_u: 3.6, carbs_g: 30 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('M7', async () => {
    // 11:05 hypo 62, juice 10 g; 11:25 88 ↗ (+4 / 5 min), IOB 0,5 j, Trio COB 8 g from the juice; lunch 30 g.
    const forecast = trio({ glucose: 88, per5: 4, iob: 0.5, cob: 8, curve: [88, 92, 96, 100, 104, 108, 110, 112, 112, 112] });
    const ctx = context(88, 4, 0.5, forecast, { lowest_recent_glucose: 62 });
    const { instance, stored } = chatSession(ctx, 'CALCULATOR');
    const result: any = await instance.propose(mealArgs(30, 'Obiad', [{ name: 'Obiad', carbs_g: 30, protein_g: 6, fat_g: 4 }]));
    expect(result.status).toBe('PROPOSED');
    // Not blocked: the card gives insulin, never above 30 g / ICR (no insulin for the juice's COB).
    expect(stored[0].carbs_g).toBe(30);
    expect(stored[0].insulin_u).toBeGreaterThan(0);
    expect(stored[0].insulin_u).toBeLessThanOrEqual(3.6);
    // The low of 25 min ago is pointed out on the card.
    expect(stored[0].warnings.map((warning) => warning.message).join(' ')).toMatch(/spadła do 62/);
  });

  // Mama expects a lightly lowered or split dose "po niedawnym niedocukrzeniu" after a hypo the glucose is now rising
  // from. The server has no such rule: the calculator gives full carbs / ICR (COB of the juice even pushes it up, the cap
  // keeps it at ICR) and the card says only "Glukoza spadła do 62…". Kept failing on purpose: shows the gap.
  it.fails('M7 (lowered or split after a recent low, with the reason)', async () => {
    const forecast = trio({ glucose: 88, per5: 4, iob: 0.5, cob: 8, curve: [88, 92, 96, 100, 104, 108, 110, 112, 112, 112] });
    const { instance, stored } = chatSession(context(88, 4, 0.5, forecast, { lowest_recent_glucose: 62 }), 'CALCULATOR');
    await instance.propose(mealArgs(30, 'Obiad', [{ name: 'Obiad', carbs_g: 30, protein_g: 6, fat_g: 4 }]));
    const lowered = stored[0].insulin_u < 3.6 || stored[0].split !== null;
    expect(lowered).toBe(true);
    expect(JSON.stringify(stored[0].card_advice)).toMatch(/niedawn|po niedocukrzeniu/i);
  });

  it('M13', async () => {
    // Bolus tab: 25 g of cake and sweets, 150 ↗, IOB 0,5 j: 25 / 8,3 = 3,01 → 3 j.
    const service = new RemoteCommandsService(new MemoryStore(), async () => ({ ...context(150, 3, 0.5, trio({ glucose: 150, per5: 3, iob: 0.5 })), last_bolus: null }) as never);
    const preview: any = await service.preview('p1', { carbs_g: 25, insulin_u: null, bolus_step: 0.1 }, NOW);
    expect(preview.insulin_u).toBe(3);
    expect(preview.blocks).toEqual([]);
    expect(preview.warnings.filter((warning: any) => warning.severity === 'DANGER')).toEqual([]);
    // One dose now: the form has no split for plain sugars; the chat card for a sugary snack gets no split either (asking
    // for the advised split is refused: "no split is advised for this meal").
    const { instance, stored } = chatSession(context(150, 3, 0.5, trio({ glucose: 150, per5: 3, iob: 0.5 })), 'ICR');
    const cake = mealArgs(25, 'Tort i 2 cukierki', [{ name: 'Tort i cukierki', carbs_g: 25, protein_g: 2, fat_g: 6 }]);
    expect(await instance.propose({ ...cake, use_advised_split: 'ADVISED' })).toMatchObject({ status: 'INVALID' });
    await instance.propose(cake);
    expect(stored[0].split).toBeNull();
    expect(stored[0].insulin_u).toBe(3);
  });

  it('M19', () => {
    // 0,7 j on 11 g given; the card held back 1 j on purpose (IOB, forecast): no "brakuje" in the meal chat.
    const held = calculatorHeldBackU([{ status: 'SUCCEEDED', icr_insulin_u: 1.3, context: { dose_calculation: { default_u: 0.3, icr_dose_u: 1.3 } } }]);
    const shortfall = mealDoseShortfall({ actions: [{ purpose: 'NEW_MEAL', carbs_g: 11, bolus_units: 0.7 }], meal_carbs_g: 11, icr_g_per_u: ICR, held_back_u: held });
    expect(shortfall).toBeNull();
    // A model reply naming units gets the pointer to the Bolus tab (where IOB and the forecast are counted).
    expect(withoutDoseHere('Można dać 0,6 j.')).toMatch(/policzy ją zakładka Bolus albo czat Rozmowy/);
  });

  it('M25', () => {
    // 19:00 supper 35 g, first part given; 20:30 the second part (14 g, ~1,7 j) is read again with the glucose then.
    const part = { kind: 'SPLIT' as const, carbs_g: 14, first_carbs_g: 21, first_insulin_u: 2.5, dose_carbs_g: null, drop_cover_g: null, fixed_insulin_u: null, subtract_first_insulin: false };
    const base = {
      meal_started_at: at(-90), now_iso: NOW.toISOString(), events: [], step: 0.05, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt,
      therapy: { timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', ICR]], basal_u_per_h: null } as never,
    };
    const steady = estimatePlannedBolus({ ...base, plan: part, forecast: trio({ glucose: 160, iob: 1, isf: 150 }) });
    expect(steady.insulin_u).toBe(1.65);
    // Falling at night: lower; below 70: 0 j and the push says why.
    const falling = estimatePlannedBolus({ ...base, plan: part, forecast: trio({ glucose: 105, per5: -6, iob: 1.2, curve: [105, 99, 93, 87, 81, 76, 72, 70, 69, 68] }) });
    expect(falling.insulin_u!).toBeLessThan(1.65);
    const low = estimatePlannedBolus({ ...base, plan: part, forecast: trio({ glucose: 66, iob: 1.2 }) });
    expect(low.insulin_u).toBe(0);
    const push = plannedBolusPushContent({ description: 'Kolacja', carbs_g: 14, estimate_u: 0, low_glucose: 66, calculator_line: plannedBolusCalculatorLine(low) });
    expect(push.title).toBe('⚠️ Druga część bolusa · 14 g');
    expect(push.body).toMatch(/najpierw węglowodany/);
  });

  // Mama: "jeśli ryzyko <70 w nocy – propozycja 0 j". Glucose 95 steady now but Trio forecasts 58 within the night: the
  // later part's calculator reads only glucose, trend and the drop, and still gives a dose. Kept failing: shows the gap.
  it('M25 (forecast below 70 later at night gives 0 j)', () => {
    const part = { kind: 'SPLIT' as const, carbs_g: 14, first_carbs_g: 21, first_insulin_u: 2.5, dose_carbs_g: null, drop_cover_g: null, fixed_insulin_u: null, subtract_first_insulin: false };
    const estimate = estimatePlannedBolus({
      meal_started_at: at(-90), now_iso: NOW.toISOString(), events: [], step: 0.05, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt,
      therapy: { timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', ICR]], basal_u_per_h: null } as never,
      plan: part, forecast: trio({ glucose: 110, iob: 1.8, curve: [110, 110, 108, 104, 98, 92, 86, 80, 74, 68, 63, 60, 58, 58, 58, 58, 58, 58, 58, 58, 58, 58, 58, 58, 58, 58, 58, 58, 58, 58] }),
    });
    expect(estimate.insulin_u).toBe(0);
  });

  it('M31', async () => {
    // No Dexcom reading for 20 min: the card has no forecast or calculator, the dose is carbs / ICR, the age is said.
    const old = trio({ glucose: 130, iob: 0.3, age: 20, loopAge: 20 });
    const ctx = context(130, 0, 0.3, old, { glucose: { value: 130, observed_at: at(-20), delta: 0 }, loop: { iob_units: 0.3, cob_grams: 0, observed_at: at(-20) } });
    const { instance, stored } = chatSession(ctx, 'CALCULATOR');
    const result: any = await instance.propose(mealArgs(30, 'Obiad', [{ name: 'Obiad', carbs_g: 30, protein_g: 6, fat_g: 4 }]));
    expect(result.status).toBe('PROPOSED');
    expect(stored[0].insulin_u).toBe(3.6);
    expect(stored[0].warnings.map((warning) => warning.message).join(' ')).toMatch(/Ostatni odczyt glukozy ma 20 min/);
    const calculation: any = stored[0].card_advice?.dose_calculation;
    expect(calculation?.breakdown ?? null).toBeNull();
    // Sending still works once the warning is acknowledged (the Bolus tab's check).
    const service = new RemoteCommandsService(new MemoryStore(), async () => ctx as never);
    const preview: any = await service.preview('p1', { carbs_g: 30, insulin_u: 3.6, bolus_step: 0.1 }, NOW);
    expect(preview.blocks).toEqual([]);
    expect(preview.warnings.map((warning: any) => warning.code)).toContain('GLUCOSE_OLD');
  });

  it('D6', () => {
    // 40 g split 60/40: 24 g with 2,9 j now, 16 g (1,9 j) in 60 min; Trio gave a 0,6 j SMB since; 190 ↗.
    const part = { kind: 'SPLIT' as const, carbs_g: 16, first_carbs_g: 24, first_insulin_u: 2.9, dose_carbs_g: null, drop_cover_g: null, fixed_insulin_u: null, subtract_first_insulin: false };
    const estimate = estimatePlannedBolus({
      meal_started_at: at(-60), now_iso: NOW.toISOString(), step: 0.05, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt,
      therapy: { timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', ICR]], basal_u_per_h: null } as never,
      events: [{ type: 'SMB', occurred_at: at(-30), payload: { insulin_units: 0.6 } }],
      plan: part, forecast: trio({ glucose: 190, per5: 4, iob: 2.4 }),
    });
    // 16 / 8,3 = 1,93 → 1,9 j; − 0,6 j SMB = 1,3 j (rounded down to the 0,05 step).
    expect(estimate).toMatchObject({ smb_u: 0.6, loop_extra_u: 0.6 });
    expect(estimate.insulin_u).toBeCloseTo(1.3, 2);
    // The push names the part's own grams; the card and the push read the same estimate (plannedPartEstimate).
    const push = plannedBolusPushContent({ description: 'Obiad', carbs_g: part.carbs_g, estimate_u: estimate.insulin_u, low_glucose: null, calculator_line: plannedBolusCalculatorLine(estimate) });
    expect(push.title).toBe('Druga część bolusa · 16 g');
  });

  // The diabetologist expects "Od HH:MM podano już 0,6 j (SMB)" in the push: the push's given_line names only boluses
  // given by hand (bolusesSinceMealForPart); the SMB is taken off silently (loop_extra_u). Kept failing: shows the gap.
  it.fails('D6 (the push names the SMB taken off)', () => {
    const part = { kind: 'SPLIT' as const, carbs_g: 16, first_carbs_g: 24, first_insulin_u: 2.9, dose_carbs_g: null, drop_cover_g: null, fixed_insulin_u: null, subtract_first_insulin: false };
    const estimate = estimatePlannedBolus({
      meal_started_at: at(-60), now_iso: NOW.toISOString(), step: 0.05, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt,
      therapy: { timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', ICR]], basal_u_per_h: null } as never,
      events: [{ type: 'SMB', occurred_at: at(-30), payload: { insulin_units: 0.6 } }],
      plan: part, forecast: trio({ glucose: 190, per5: 4, iob: 2.4 }),
    });
    const push = plannedBolusPushContent({ description: 'Obiad', carbs_g: 16, estimate_u: estimate.insulin_u, low_glucose: null, calculator_line: plannedBolusCalculatorLine(estimate) });
    expect(`${push.title} ${push.body}`).toMatch(/SMB|0,6\s?j/);
  });

  it('D12', () => {
    // Split: 20 g with 2,0 j now, 20 g (1,6 j) later; only 20 g eaten: the meal is changed to 20 g.
    const part: PlannedBolusRecord = {
      id: '11111111-1111-4111-8111-111111111111', patient_id: 'p1', meal_record_id: 'm1', proposal_id: 'b1', conversation_id: null,
      first_command_id: 'cmd-1', first_carbs_g: 20, first_insulin_u: 2, carbs_g: 20, planned_insulin_u: 1.6, icr_g_per_u: 12.5, now_percent: 50, delay_minutes: 60,
      due_at: at(30), status: 'SCHEDULED', notified_at: null, resolved_at: null, resolved_by_user_id: null, resolved_by_name: null,
      given_command_id: null, given_loop_action_id: null, given_insulin_u: null, created_at: at(-30),
      trigger: null, threshold_mgdl: null, dose_carbs_g: null, fixed_insulin_u: null, drop_cover_g: null, subtract_first_insulin: false, wait_until: null,
      meal_carbs_g: 40, meal_change_g: 0, cancelled_by_meal_change: false,
    } as PlannedBolusRecord;
    const [update] = mealCarbsChangeUpdates([part], 20, 0.05);
    // The rest is cancelled (the push does not come back), 2,0 j for 20 g at ICR 12,5 is 1,6 j: no excess reported as grams.
    expect(update).toMatchObject({ plan_id: part.id, carbs_g: 0, cancel: true, meal_carbs_g: 20, meal_excess_g: 0 });
  });

  // D12's step "Ile zostało na talerzu? = 20 g" on the second part's card does not exist: the plate question is only for
  // a food counted later (card-food-notes.v1, iOS PlannedBolusView "Nic · Połowa · Wszystko", server portion 'HALF'
  // only). Editing the meal to 20 g (above) is the path that works today.

  it('D18', async () => {
    // 280 → for 3 h, ketones 1,2, vomited once, 15 g: the server still prepares a plain card when the model calls
    // propose_bolus; only the model's prompt and the knowledge base speak about sick days.
    const high = trio({ glucose: 280, iob: 0.8 });
    const { instance, stored } = chatSession(context(280, 0, 0.8, high), 'ICR');
    const result: any = await instance.propose(mealArgs(15, 'Zjadł 15 g, wymiotował', [{ name: 'Sucharki', carbs_g: 15, protein_g: 1, fat_g: 1 }]));
    expect(result.status).toBe('PROPOSED');
    expect(stored[0].insulin_u).toBeGreaterThan(0);
  });

  // Expected: no plain card with ketones and vomiting; a sick-day pointer (infusion site, fluids, the doctor). Nothing in
  // propose_bolus or its instructions knows ketones or vomiting. Kept failing: the feature does not exist.
  it.fails('D18 (sick day: no plain card, ketones and vomiting named)', async () => {
    expect(BOLUS_PROPOSAL_INSTRUCTIONS).toMatch(/keton|wymiot|vomit|sick/i);
  });

  it('D24', async () => {
    // 10.11, 11:10: 124 →, IOB 1,1 j, Trio basal 0 j/h, Trio's line without the card 39 mg/dL in 100 min; 21 g.
    const curve = [124, 124, 122, 118, 112, 104, 96, 88, 80, 72, 66, 60, 55, 50, 46, 43, 41, 40, 39, 39, 39, 39, 39, 39, 39, 39, 39, 39, 39, 39];
    const forecast = trio({ glucose: 124, iob: 1.1, curve, isf: 150 });
    const { instance, stored } = chatSession(context(124, 0, 1.1, forecast), 'CALCULATOR');
    await instance.propose(mealArgs(21, 'Zupa i podwieczorek', [{ name: 'Zupa i podwieczorek', carbs_g: 21, protein_g: 3, fat_g: 2 }]));
    const card = stored[0];
    // 21 / 8,3 = 2,53 → 2,5 j; lowered to 1,5 j (ISF 150: 2,53 + 0,16 − IOB 1,1; the real case's 1,3 j had another ISF).
    expect(card.icr_insulin_u).toBe(2.5);
    expect(card.insulin_u).toBe(1.5);
    // The forecast 39 is on the card for any dose (a WARNING line, grey: review 2026-11-10, below 54 only after 90 min).
    expect(card.warnings.find((warning) => warning.code === 'FORECAST_LOW')).toMatchObject({ message: expect.stringContaining('39') });
    // The why line.
    const calculation: any = card.card_advice!.dose_calculation;
    expect(calculation.summary).toMatch(/zamiast 2,5 j/);
    // The whole dose is a button, asking first.
    const full = card.card_advice!.variants!.find((variant) => variant.kind === 'FULL_BOLUS_NOW' || variant.kind === 'ICR_DOSE');
    expect(full).toMatchObject({ kind: 'ICR_DOSE', label: 'Z przelicznika · 2,5 j', insulin_now_u: 2.5 });
    // The red risk: Trio's own line below 54.
    const view = toBolusProposalView({ ...card, id: 'b1', status: 'PROPOSED', created_at: NOW.toISOString() } as never, null, 'u1', NOW);
    expect(view.risk?.min_mgdl).toBeLessThan(54);
    // A dose typed by hand: the confirmation recomputes the calculator for it on live data (1,5 j as reference).
    const service = new RemoteCommandsService(new MemoryStore(), async () => context(124, 0, 1.1, forecast) as never);
    const typed: any = await service.preview('p1', { carbs_g: 21, insulin_u: 2.5, bolus_step: 0.1 }, NOW);
    expect(typed).toMatchObject({ insulin_u: 2.5, dose_calculation: { default_u: 1.5, icr_dose_u: 2.5 } });
  });

  // "Cała dawka teraz · 2,5 j" should ask before it replaces the card (needs_ack + ack_text with the forecast <54). The
  // variant (ICR_DOSE "Z przelicznika · 2,5 j") does not ask: variantOf skips the question for the loop's forecast without
  // food on a card with carbs (review 2026-11-10 "grey, not red"). Also the confirmation of 2,5 j typed by hand carries no
  // warning about the 39 forecast. Kept failing: the diabetologist's expectation differs from the decision.
  it('D24 (the whole dose asks first)', async () => {
    const curve = [124, 124, 122, 118, 112, 104, 96, 88, 80, 72, 66, 60, 55, 50, 46, 43, 41, 40, 39, 39, 39, 39, 39, 39, 39, 39, 39, 39, 39, 39];
    const { instance, stored } = chatSession(context(124, 0, 1.1, trio({ glucose: 124, iob: 1.1, curve })), 'CALCULATOR');
    await instance.propose(mealArgs(21, 'Zupa i podwieczorek', [{ name: 'Zupa i podwieczorek', carbs_g: 21, protein_g: 3, fat_g: 2 }]));
    const full = stored[0].card_advice!.variants!.find((variant) => variant.insulin_now_u === 2.5)!;
    expect(full.needs_ack).toBe(true);
    expect(full.ack_text).toBeTruthy();
  });

  it('D30', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
    // Mama by ICR, tata by the calculator; 140 →, IOB 1,0 j, 15 g: 15 / 8,3 = 1,8 j.
    const dishes = [{ name: 'Kanapka', carbs_g: 15, protein_g: 3, fat_g: 3 }];
    const ctx = context(140, 0, 1, trio({ glucose: 140, iob: 1 }));
    const basis = { [MAMA.user_id]: 'ICR' as const, [TATA.user_id]: 'CALCULATOR' as const };
    const mama = planned(ctx, dishes, { basis });
    await mama.api.mealPlanBolusCard(MAMA, PATIENT, ENTRY, { items: dishes });
    const tata = planned(ctx, dishes, { basis });
    await tata.api.mealPlanBolusCard(TATA, PATIENT, ENTRY, { items: dishes });
    expect(mama.inserted[0].insulin_u).toBe(1.8);
    expect(mama.inserted[0].card_advice.variants.find((variant: any) => variant.kind === 'CALCULATOR_DOSE')).toBeDefined();
    expect(tata.inserted[0].insulin_u).toBe(1.4);
    expect(tata.inserted[0].insulin_u).toBeGreaterThanOrEqual(0.9); // iob_floor: half of 1,8 j at a flat glucose
    expect(mama.inserted[0].carbs_g).toBe(tata.inserted[0].carbs_g);
    // The low forecast warning shows whatever the basis.
    const curve = [140, 138, 132, 124, 114, 102, 90, 78, 68, 60, 54, 50, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48];
    const lowCtx = context(140, 0, 1, trio({ glucose: 140, iob: 1, curve }));
    const icrLow = chatSession(lowCtx, 'ICR');
    await icrLow.instance.propose(mealArgs(15, 'Kanapka', dishes));
    const calcLow = chatSession(lowCtx, 'CALCULATOR');
    await calcLow.instance.propose(mealArgs(15, 'Kanapka', dishes));
    for (const card of [icrLow.stored[0], calcLow.stored[0]]) {
      const view = toBolusProposalView({ ...card, id: 'b1', status: 'PROPOSED', created_at: NOW.toISOString() } as never, null, 'u1', NOW);
      expect(view.risk?.min_mgdl).toBeLessThan(70);
      expect(view.risk?.level).not.toBe('NONE');
    }
    } finally {
      vi.useRealTimers();
    }
  });

  it('D30 (the ICR card names the insulin on board and offers the calculator dose)', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const dishes = [{ name: 'Kanapka', carbs_g: 15, protein_g: 3, fat_g: 3 }];
      const mama = planned(context(140, 0, 1, trio({ glucose: 140, iob: 1 })), dishes);
      await mama.api.mealPlanBolusCard(MAMA, PATIENT, ENTRY, { items: dishes });
      const calculation = mama.inserted[0].card_advice.dose_calculation;
      // Not a warning, a line under the dose: "Z przelicznika. Kalkulator: 1,4 j (aktywna insulina)", IOB 1 j in the why.
      expect(calculation.short_summary).toMatch(/^Z przelicznika\. Kalkulator: 1,4 j \(aktywna insulina\)/);
      expect(calculation.summary).toMatch(/IOB 1 j/);
      expect(mama.inserted[0].card_advice.variants.find((variant: any) => variant.kind === 'CALCULATOR_DOSE')).toMatchObject({ insulin_now_u: 1.4 });
      expect(mama.inserted[0].warnings.map((warning: any) => warning.code)).not.toContain('RECENT_INSULIN');
    } finally {
      vi.useRealTimers();
    }
  });
});

class MemoryStore implements RemoteCommandStore {
  rows: RemoteCommandRecord[] = [];
  async requestNightscoutSync() {}
  async insert(command: NewRemoteCommand): Promise<RemoteCommandRecord> {
    const record: RemoteCommandRecord = { ...command, id: `00000000-0000-4000-8000-00000000000${this.rows.length + 1}`, status: 'AUTHORIZED', trio_message: null, status_message: null, authorized_at: NOW.toISOString(), sent_at: null, answered_at: null, loop_action_id: null, meal_record_id: null, matched_at: null };
    this.rows.push(record);
    return record;
  }
  async get(patientId: string, id: string) { return this.rows.find((row) => row.patient_id === patientId && row.id === id) ?? null; }
  async list() { return this.rows; }
  async findInFlight() { return null; }
  async recordSentAt() {}
  async listForProposal() { return []; }
  async listForPlannedBolus() { return []; }
  async listWbtForMeal() { return []; }
  async findRecentWithInsulin() { return null; }
  async transition() { return null; }
}
