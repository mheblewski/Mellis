import { describe, expect, it, vi } from 'vitest';
import { BOLUS_PROPOSAL_INSTRUCTIONS, BolusProposalSession, sentCommandView, finalizeBolusAnswer, proposesDose, isDoseRequest, settleAnswerCards, toBolusProposalView, type BolusProposalRecord, type NewBolusProposal } from './application/bolus-proposal-tool';
import { FITTED_V1_FORECAST_CALIBRATION } from '@modules/glucose-forecast/application/forecast-calibration';
import type { MealForecastData } from './application/meal-dose-forecast';
import type { RemoteCommandContext } from './application/remote-command-policy';

const now = new Date('2026-10-19T12:00:00.000Z');
const context = (overrides: Partial<RemoteCommandContext> = {}): Omit<RemoteCommandContext, 'in_flight_command_id' | 'recent_remote_bolus'> => ({
  now: now.toISOString(),
  glucose: { value: 150, observed_at: '2026-10-19T11:57:00.000Z', delta: 2 },
  lowest_recent_glucose: 140,
  loop: { iob_units: 0.4, cob_grams: 0, observed_at: '2026-10-19T11:56:00.000Z' },
  last_bolus: null,
  icr_g_per_u: 12,
  bolus_history_known: false,
  ...overrides,
});

function session(ctx = context()) {
  const stored: NewBolusProposal[] = [];
  const instance = new BolusProposalSession({
    patientId: 'p1',
    conversationId: 'c1',
    userMessageId: 'm1',
    doseRequested: true,
    now: () => now,
    context: async () => ctx,
    store: {
      insert: async (proposal) => {
        stored.push(proposal);
        return { ...proposal, id: 'b1', status: 'PROPOSED', created_at: now.toISOString() };
      },
    },
  });
  return { instance, stored };
}

const meal = {
  purpose: 'MEAL',
  carbs_g: 46,
  insulin_u: null,
  reduce_for_drop: false,
  add_correction: false,
  eating_now: false,
  meal_description: 'Naleśniki z serem ×2',
  items: [{ name: 'Naleśnik z serem', grams: 240, carbs_g: 46, protein_g: 22, fat_g: 14, source: 'DIABCALC' }],
  reason: 'Obiad: dwa naleśniki z serem.',
  later: null,
};
const correctionArgs = { purpose: 'CORRECTION', carbs_g: 0, insulin_u: null, reduce_for_drop: false, add_correction: false, eating_now: false, meal_description: null, items: null, reason: 'Korekta', later: null };

describe('propose_bolus', () => {
  it('computes the dose from carbs / ICR on the server, rounded down, and stores the meal', async () => {
    const { instance, stored } = session();
    const result = await instance.propose(meal);
    expect(result).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 46, insulin_u: 3.8, dose_from_icr: 3.8, icr_g_per_u: 12 } });
    expect(stored[0]).toMatchObject({ purpose: 'MEAL', carbs_g: 46, insulin_u: 3.8, expires_at: '2026-10-19T12:15:00.000Z' });
    expect(stored[0].meal_payload).toMatchObject({ description: 'Naleśniki z serem ×2', macros: { carbs_g: 46, protein_g: 22, fat_g: 14 } });
    expect(instance.proposed).toHaveLength(1);
  });

  it("rounds the card's dose to the pump's step Trio reports (30 g / 8 = 3,7 j at 0,1, not 3,75)", async () => {
    const fries = { ...meal, carbs_g: 30, items: null, meal_description: 'Małe frytki' };
    const pump = session(context({ icr_g_per_u: 8, pump_bolus_step: 0.1 }));
    expect(await pump.instance.propose(fries)).toMatchObject({ status: 'PROPOSED', card: { insulin_u: 3.7, dose_from_icr: 3.7 } });
    const unknown = session(context({ icr_g_per_u: 8 }));
    expect(await unknown.instance.propose(fries)).toMatchObject({ status: 'PROPOSED', card: { insulin_u: 3.75 } });
  });

  it("keeps the caregiver's own dose exactly, lower or higher than carbs / ICR (bolus-proposals.v4)", async () => {
    const lower = await session().instance.propose({ ...meal, insulin_u: 2.53, reason: 'Po wysiłku mniej.' });
    expect(lower).toMatchObject({ status: 'PROPOSED', card: { insulin_u: 2.5, dose_from_icr: 3.8, warnings: [] } });
    const { instance, stored } = session();
    const higher = await instance.propose({ ...meal, insulin_u: 5.03, reason: 'Opiekun: z korektą.' });
    expect(higher).toMatchObject({ status: 'PROPOSED', card: { insulin_u: 5 } });
    expect(stored[0].insulin_u).toBe(5);
    // Above carbs / ICR by more than 20% the card keeps the ICR warning: the dose may be the model's own sum.
    expect((higher as any).card.warnings.join(' ')).toMatch(/Dawka różni się od przelicznika/);
  });

  it('warns on the card and to the model about a bolus given minutes ago, in Nightscout or sent remotely', async () => {
    const given = await session(context({ bolus_history_known: true, last_bolus: { at: '2026-10-19T11:55:00.000Z', units: 3 } })).instance.propose(meal) as any;
    expect(given.card.warnings.join(' ')).toMatch(/Bolus 3 j podano 5 min temu/);
    const remote = await session({ ...context(), recent_remote_bolus: { at: '2026-10-19T11:50:00.000Z', units: 2.5, status: 'SUCCEEDED' } } as any).instance.propose(meal) as any;
    expect(remote.card.warnings.join(' ')).toMatch(/Zdalny bolus 2,5 j wysłano 10 min temu/);
  });

  it('warns when the card is above the asking phone\'s own send limits', async () => {
    const instance = new BolusProposalSession({
      patientId: 'p1', conversationId: 'c1', userMessageId: 'm1', doseRequested: true, now: () => now,
      context: async () => context(), phoneLimits: { max_bolus_u: 3, max_carbs_g: 40 },
      store: { insert: async (proposal) => ({ ...proposal, id: 'b1', status: 'PROPOSED', created_at: now.toISOString() }) },
    });
    const result: any = await instance.propose(meal);
    expect(result.card.warnings.join(' ')).toMatch(/3,8 j to więcej niż limit bolusa na tym telefonie \(3 j\); 46 g to więcej niż limit węglowodanów na tym telefonie \(40 g\): telefon jej nie wyśle/);
    expect(result.phone_limit).toMatchObject({ max_bolus_u: 3, max_carbs_g: 40 });
    // Without the limits (older apps): nothing.
    expect(((await session().instance.propose(meal)) as any).phone_limit).toBeUndefined();
  });

  it('prepares the card near a low with the warning (the caregiver decides); without an ICR it asks for the dose', async () => {
    const { instance, stored } = session(context({ glucose: { value: 64, observed_at: '2026-10-19T11:58:00.000Z', delta: -3 } }));
    const result = await instance.propose(meal);
    expect(result).toMatchObject({ status: 'PROPOSED', card: { warnings: ['Glukoza 64 mg/dL: insulina może pogłębić niedocukrzenie.'] } });
    expect(stored).toHaveLength(1);
    const noIcr = session(context({ icr_g_per_u: null }));
    expect(await noIcr.instance.propose(meal)).toMatchObject({ status: 'NEEDS_DOSE', reason: 'Brak przelicznika węglowodanów (ICR) z profilu w Nightscout.' });
    expect(await noIcr.instance.propose({ ...meal, insulin_u: 3 })).toMatchObject({ status: 'PROPOSED', card: { insulin_u: 3 } });
  });

  it('a new card for an option replaces its earlier card of the same purpose (answer-options.v1)', async () => {
    const discarded: string[] = [];
    let next = 0;
    const instance = new BolusProposalSession({
      patientId: 'p1', conversationId: 'c1', userMessageId: 'm1', doseRequested: true, now: () => now, context: async () => context(),
      store: {
        insert: async (proposal) => ({ ...proposal, id: `b${++next}`, status: 'PROPOSED', created_at: now.toISOString() }),
        discard: async (_patientId, id) => { discarded.push(id); },
      },
    });
    await instance.propose({ ...meal, option: 'A' });
    await instance.propose({ ...meal, option: 'B' });
    expect(await instance.propose({ ...meal, carbs_g: 30, option: 'A' })).toMatchObject({ status: 'PROPOSED', note_replaced: expect.stringContaining('option A') });
    expect(discarded).toEqual(['b1']);
    expect(instance.proposed.map((card) => [card.id, card.option_key])).toEqual([['b2', 'B'], ['b3', 'A']]);
    // Without options a new card for the same meal replaces the earlier one too; another meal's card stays.
    await instance.propose({ ...meal, option: null });
    await instance.propose({ ...meal, carbs_g: 40, option: null });
    expect(instance.proposed.filter((card) => card.option_key === null).map((card) => card.carbs_g)).toEqual([40]);
    await instance.propose({ ...meal, meal_description: 'Deser', option: null });
    expect(instance.proposed.filter((card) => card.option_key === null)).toHaveLength(2);
  });

  it('makes the advised split exactly when asked, and says when no split is advised (split-advice.v1)', async () => {
    const fatty = { ...meal, carbs_g: 34, meal_description: 'Frytki i nuggetsy', items: [{ name: 'Frytki i nuggetsy', grams: 160, carbs_g: 34, protein_g: 18, fat_g: 20, source: 'ESTIMATE' }] };
    const { instance, stored } = session();
    const result = await instance.propose({ ...fatty, use_advised_split: 'ADVISED' });
    expect(result).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 20 }, split_advice: { advised: true, now_percent: 60, after_minutes: 90, later_carbs_g: 14, on_this_card: true } });
    expect(stored[0].split).toMatchObject({ kind: 'SPLIT', later_carbs_g: 14, later_after_minutes: 90 });
    // Without it the whole meal is one card, with the advice in the result.
    expect(await session().instance.propose(fatty)).toMatchObject({ card: { carbs_g: 34 }, split_advice: { advised: true, on_this_card: false } });
    // A lean meal: no split to make.
    expect(await session().instance.propose({ ...meal, use_advised_split: 'ADVISED' })).toMatchObject({ status: 'INVALID', problem: expect.stringContaining('no split is advised') });
    expect(await session().instance.propose({ ...fatty, use_advised_split: 'ADVISED', insulin_u: 3 })).toMatchObject({ status: 'INVALID' });
    // The split is of the whole meal: only the "now" grams with the whole meal's items would leave the rest unplanned.
    expect(await session().instance.propose({ ...fatty, carbs_g: 20, use_advised_split: 'ADVISED' })).toMatchObject({ status: 'INVALID', problem: expect.stringContaining('whole meal') });
  });

  it('refuses requests that do not make a card', async () => {
    const { instance } = session();
    expect(await instance.propose({ ...meal, carbs_g: 0 })).toMatchObject({ status: 'INVALID' });
    expect(await instance.propose({ ...meal, purpose: 'PRE_BOLUS', carbs_g: 0, insulin_u: null })).toMatchObject({ status: 'INVALID' });
    expect(await instance.propose({ ...meal, carbs_g: 46.5 })).toMatchObject({ status: 'INVALID' });
    expect(await instance.propose({ ...meal, purpose: 'GIVE_ALL' })).toMatchObject({ status: 'INVALID' });
    expect(await instance.propose({ ...correctionArgs, later: { trigger: 'AFTER_MINUTES', after_minutes: 60, threshold_mgdl: null, carbs_g: 0, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null } })).toMatchObject({ status: 'INVALID' });
  });

  it("gives the caregiver's own correction; without data the server asks for the dose instead of refusing", async () => {
    const { instance, stored } = session();
    expect(await instance.propose(correctionArgs)).toMatchObject({ status: 'NEEDS_DOSE' });
    expect(stored).toHaveLength(0);
    expect(await instance.propose({ ...correctionArgs, insulin_u: 1 })).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 0, insulin_u: 1 } });
    // Correction carbs alone stay possible.
    expect(await instance.propose({ ...correctionArgs, carbs_g: 10, reason: 'Dosłodzenie' })).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 10, insulin_u: 0 } });
    // Carbs with a dose are a meal, and a pre-bolus has no carbs yet: the meal checks must not be skipped.
    expect(await instance.propose({ ...correctionArgs, carbs_g: 10, insulin_u: 1 })).toMatchObject({ status: 'INVALID' });
    expect(await instance.propose({ ...correctionArgs, purpose: 'PRE_BOLUS', carbs_g: 20, insulin_u: 1 })).toMatchObject({ status: 'INVALID' });
  });
});

describe('propose_bolus with a falling glucose (advice, card-advice.v1)', () => {
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  // Trio's curve ends at 70 mg/dL, read without calibration (w = 1) so the numbers stay with the curve;
  // ISF 60, ICR 12 → CSF 5, so (100 − 70) / 5 = 6 g cover the drop.
  const falling: MealForecastData = {
    readings: [122, 118, 114, 110].map((value, index) => ({ at: minutesAgo((3 - index) * 5 + 1), value })),
    prediction: {
      source: 'OPENAPS', system: 'TRIO', computed_at: minutesAgo(1), bg: 110, carbs_req_g: null, iob_u: 1.5, cob_g: 0, isf_mgdl_per_u: 60, icr_g_per_u: 12, eventual_bg: 70,
      curves: { IOB: [110, 102, 94, 86, 78, 72, 70] },
    },
    profile_isf: 60,
    profile_target: 100,
    profile_units: 'mg/dl',
    calibration: { ...FITTED_V1_FORECAST_CALIBRATION, version: 'test-none', shrink_by_minutes: { 5: 1 } },
  };
  const fallingSession = (forecast: MealForecastData = falling) => {
    const stored: NewBolusProposal[] = [];
    const instance = new BolusProposalSession({
      patientId: 'p1', conversationId: 'c1', userMessageId: 'm1', doseRequested: true, now: () => now,
      context: async () => ({ ...context({ glucose: { value: 110, observed_at: minutesAgo(1), delta: -4 } }), meal_forecast: forecast }),
      store: { insert: async (proposal) => { stored.push(proposal); return { ...proposal, id: 'b1', status: 'PROPOSED', created_at: now.toISOString() }; } },
    });
    return { instance, stored };
  };

  it('offers the dose lowered for the drop and puts it on the card only when the plan asks (46 g − 6 g) / 12 = 3,3 j', async () => {
    const offered = await fallingSession().instance.propose(meal);
    expect(offered).toMatchObject({ status: 'PROPOSED', card: { insulin_u: 3.8 }, advice: { reduce_for_drop: { dose_u: 3.3, covered_carbs_g: 6, on_this_card: false } } });
    const { instance, stored } = fallingSession();
    const result = await instance.propose({ ...meal, reduce_for_drop: true });
    expect(result).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 46, insulin_u: 3.3, dose_from_icr: 3.8 }, advice: { reduce_for_drop: { on_this_card: true } } });
    // On purpose below the ratio: no "differs from ICR" warning.
    expect((result.card as { warnings: string[] }).warnings.join(' ')).not.toMatch(/przelicznika/);
    expect(stored[0]).toMatchObject({ carbs_g: 46, insulin_u: 3.3, dose_adjustment: { basis: 'CALIBRATED_EVENTUAL', dose_before_u: 3.8, dose_u: 3.3 } });
    const view = toBolusProposalView({ ...stored[0], id: 'b1', status: 'PROPOSED', created_at: now.toISOString() }, null, 'u1', now);
    expect(view.dose_adjustment).toEqual({
      summary: 'Za ok. 1,5 h prognoza ok. 70 mg/dL (cel 100), więc 6 g z posiłku pokryje spadek: insulina tylko na pozostałe 40 g (mniej o 0,5 j). Podaj na początku posiłku, nie wcześniej.',
      reduced_by_u: 0.5, covered_carbs_g: 6, forecast_low_mgdl: 70, target_mgdl: 100,
    });
    expect(view.risk).not.toBeNull();
  });

  it('keeps the chart of the whole plan behind the card: the dose now, the later part where its condition is met, longer than 3 h', async () => {
    const { instance, stored } = fallingSession();
    await instance.propose({
      ...meal,
      carbs_g: 23,
      insulin_u: 0,
      later: { trigger: 'GLUCOSE_STOPPED_FALLING', after_minutes: 30, threshold_mgdl: null, carbs_g: 0, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null },
    });
    const chart = stored[0].card_advice?.forecast_chart;
    expect(chart).toMatchObject({ policy_version: 'card-forecast.v1', step_minutes: 5, events: [
      { at_minutes: 0, kind: 'NOW', carbs_g: 23, insulin_u: 0, conditional: false },
      // Waiting for the drop to stop: drawn where the line stops falling, here at its earliest 30 min (the 23 g at the
      // textbook ISF / ICR stop the drop at once). The 23 g card reads the 46 g items' proportions (not their whole
      // fat), so the meal is not a fatty one here.
      { at_minutes: 30, kind: 'LATER', carbs_g: 0, insulin_u: 1.9, conditional: true },
      // The meal's protein and fat: the WBT reminder as a marker (not drawn into the line).
      { at_minutes: 150, kind: 'WBT', carbs_g: 0, insulin_u: 0.5, conditional: false },
    ] });
    // Up to 150 min after the last step (WBT at 150), every 5 min.
    expect(chart!.with_plan).toHaveLength(61);
    // The later dose pulls the line down from the carbs-only rise.
    const view = toBolusProposalView({ ...stored[0], id: 'b1', status: 'PROPOSED', created_at: now.toISOString() }, null, 'u1', now);
    expect(view.forecast_chart?.events).toHaveLength(3);
    // "prognoza min." on the card is the chart's lowest point.
    expect(view.risk?.min_mgdl).toBe(Math.min(...chart!.with_plan!));
  });

  it('with FORECAST_CALIBRATION=fitted-v1 (carbs × 0.7) draws the later part where the slower line stops falling', async () => {
    vi.stubEnv('FORECAST_CALIBRATION', 'fitted-v1');
    try {
      const { instance, stored } = fallingSession();
      await instance.propose({
        ...meal,
        carbs_g: 23,
        insulin_u: 0,
        later: { trigger: 'GLUCOSE_STOPPED_FALLING', after_minutes: 30, threshold_mgdl: null, carbs_g: 0, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null },
      });
      expect(stored[0].card_advice?.forecast_chart?.events[1]).toMatchObject({ at_minutes: 35, kind: 'LATER', insulin_u: 1.9 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("prepares the caregiver's plan exactly: half the carbs now, no insulin, the bolus when glucose rises minus what covered the drop", async () => {
    const { instance, stored } = fallingSession();
    const result = await instance.propose({
      ...meal,
      carbs_g: 23,
      insulin_u: 0,
      eating_now: true,
      reason: 'Połowa węgli teraz, bo nie wiadomo, czy zje całość.',
      later: { trigger: 'GLUCOSE_RISING', after_minutes: null, threshold_mgdl: null, carbs_g: 0, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: true, wait_minutes: null },
    });
    // (23 g − 6 g that cover the drop) / 12 = 1,4 j later; the reminder waits up to 3 h for the rise.
    expect(result).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 23, insulin_u: 0, later: [{ kind: 'DEFERRED_INSULIN', trigger: 'GLUCOSE_RISING', after_minutes: 0, carbs_g: 0, insulin_u_estimate: 1.4, wait_minutes: 60 }] } });
    expect(stored[0].split).toMatchObject({ kind: 'DEFERRED_INSULIN', now_percent: 100, total_carbs_g: 23, later_carbs_g: 0, drop_cover_g: 6, trigger: 'GLUCOSE_RISING' });
    expect(stored[0].dose_adjustment).toBeNull();
  });

  it('plans a split as the caregiver set it: 32 g now with their dose, 14 g after 60 min', async () => {
    const { instance, stored } = fallingSession();
    const result = await instance.propose({ ...meal, carbs_g: 32, later: { trigger: 'AFTER_MINUTES', after_minutes: 60, threshold_mgdl: null, carbs_g: 14, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null } });
    expect(result).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 32, insulin_u: 2.65, later: [{ kind: 'SPLIT', trigger: 'AFTER_MINUTES', after_minutes: 60, carbs_g: 14, insulin_u_estimate: 1.15 }] } });
    expect(stored[0].split).toMatchObject({ kind: 'SPLIT', now_percent: 70, total_carbs_g: 46, total_insulin_u: 3.8, wait_minutes: null });
  });

  it('with a confirmed low ahead advises fast carbs first and warns on a card that still gives insulin now', async () => {
    // Uncalibrated, the curve crosses 70 within 30 min: confirmed (rescue-carbs.v2), Trio asks for 8 g.
    const steep = { ...falling, prediction: { ...falling.prediction!, carbs_req_g: 8, curves: { IOB: [110, 100, 90, 80, 72, 66, 60] } } };
    const message = 'Glukoza 110 mg/dL spadnie poniżej 70 za ok. 24 min: polecam najpierw 8 g szybkich węglowodanów (sok, glukoza), bo posiłek podnosi glukozę za wolno.';
    const withInsulin = await fallingSession(steep).instance.propose(meal);
    expect(withInsulin).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 46, insulin_u: 3.8 }, advice: { fast_carbs_first: { carbs_g: 8, message } } });
    expect((withInsulin.card as { warnings: string[] }).warnings).toContain(message);
    // The recommended plan: the meal's carbs now, the bolus when glucose has stopped falling.
    const { instance, stored } = fallingSession(steep);
    const deferred = await instance.propose({ ...meal, insulin_u: 0, later: { trigger: 'GLUCOSE_STOPPED_FALLING', after_minutes: null, threshold_mgdl: null, carbs_g: 0, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null } });
    expect((deferred.card as { warnings: string[] }).warnings).not.toContain(message);
    expect(stored[0].split).toMatchObject({ kind: 'DEFERRED_INSULIN', total_carbs_g: 46, later_insulin_u: 3.8, trigger: 'GLUCOSE_STOPPED_FALLING' });
  });

  it('says a correction is not needed when the insulin on board covers it, and adds one only when asked', async () => {
    expect(await fallingSession().instance.propose(correctionArgs)).toMatchObject({ status: 'NO_DOSE_NEEDED', breakdown: '(110 − 100) / 60 − IOB 1,5 j = 0 j' });
    const high: MealForecastData = {
      ...falling,
      readings: [236, 240, 244, 248].map((value, index) => ({ at: minutesAgo((3 - index) * 5 + 1), value })),
      prediction: { ...falling.prediction!, bg: 248, iob_u: 0.5, insulin_req_u: 1.2, eventual_bg: 230, curves: { IOB: [248, 246, 244, 240, 236, 232, 230] } },
    };
    const plain = await fallingSession(high).instance.propose(meal);
    expect(plain).toMatchObject({ card: { insulin_u: 3.8 }, advice: { correction: { dose_u: 1.95, breakdown: '(248 − 100) / 60 − IOB 0,5 j = 1,95 j', on_this_card: false } } });
    const { instance, stored } = fallingSession(high);
    const asked = await instance.propose({ ...meal, add_correction: true });
    expect(asked).toMatchObject({ card: { insulin_u: 5.75 }, advice: { correction: { on_this_card: true } } });
    expect((asked.card as { warnings: string[] }).warnings.join(' ')).toMatch(/Trio samo dokłada insulinę/);
    const view = toBolusProposalView({ ...stored[0], id: 'b1', status: 'PROPOSED', created_at: now.toISOString() }, null, 'u1', now);
    expect(view.correction).toEqual({ dose_u: 1.95, breakdown: '(248 − 100) / 60 − IOB 0,5 j = 1,95 j' });
  });

  it('computes no correction without Trio\'s fresh IOB, and a negative IOB never adds insulin (review 2026-10-22)', async () => {
    const high: MealForecastData = {
      ...falling,
      readings: [236, 240, 244, 248].map((value, index) => ({ at: minutesAgo((3 - index) * 5 + 1), value })),
      prediction: { ...falling.prediction!, bg: 248, iob_u: 0.5, insulin_req_u: 1.2, eventual_bg: 230, curves: { IOB: [248, 246, 244, 240, 236, 232, 230] } },
    };
    const stale = { ...high, prediction: { ...high.prediction!, computed_at: minutesAgo(30) } };
    expect(await fallingSession(stale).instance.propose(correctionArgs)).toMatchObject({ status: 'NEEDS_DOSE', reason: expect.stringContaining('Brak aktualnego IOB') });
    const negative = { ...high, prediction: { ...high.prediction!, iob_u: -0.4 } };
    expect(await fallingSession(negative).instance.propose(correctionArgs)).toMatchObject({ status: 'PROPOSED', card: { insulin_u: 2.45 } });
  });
});

describe('a WBT command on the WBT window card', () => {
  it('is saved to its meal like a meal command, also as insulin alone', () => {
    const now = new Date('2026-10-19T19:00:30.000Z');
    const command = { id: 'rc1', status: 'SUCCEEDED', status_message: 'Bolus podany', carbs_g: 0, insulin_u: 1.25, meal_record_id: null, user_id: 'u1', authorized_at: '2026-10-19T19:00:00.000Z', follows_command_id: null, purpose: 'WBT' as const };
    expect(sentCommandView(command, 'u1', now)).toMatchObject({ meal_state: 'SAVING', sent_by_me: true, retry_until: null });
    expect(sentCommandView({ ...command, meal_record_id: 'm1' }, 'u2', now)).toMatchObject({ meal_state: 'SAVED', sent_by_me: false });
    expect(sentCommandView({ ...command, purpose: null }, 'u1', now).meal_state).toBe('NONE');
  });
});

describe('bolus card instructions', () => {
  it("put the caregiver's own plan first: prepare it exactly, warn once, never argue", () => {
    expect(BOLUS_PROPOSAL_INSTRUCTIONS).toMatch(/OWN PLAN COMES FIRST/);
    expect(BOLUS_PROPOSAL_INSTRUCTIONS).toMatch(/Do not argue/);
    expect(BOLUS_PROPOSAL_INSTRUCTIONS).toMatch(/once, in one plain sentence starting with "⚠️"/);
    expect(BOLUS_PROPOSAL_INSTRUCTIONS).toMatch(/2–3 options/);
    expect(BOLUS_PROPOSAL_INSTRUCTIONS).toMatch(/jeśli chcesz dodać korektę do karty, napisz/);
  });

  it('treat a dose question about a food as a new portion, not the same food logged hours ago', () => {
    expect(BOLUS_PROPOSAL_INSTRUCTIONS).toMatch(/portion eaten now/);
    expect(BOLUS_PROPOSAL_INSTRUCTIONS).toMatch(/previous portion, not this one/);
  });
});

describe('answer text and card agree', () => {
  const withCard = { used: true, proposed: [{} as BolusProposalRecord] };
  it('adds how to give a dose written without a card', () => {
    const text = '**Propozycja:** 4,5 j na obiad.';
    expect(finalizeBolusAnswer(text, { used: false, proposed: [] })).toMatchObject({ corrected: true, kind: 'BOLUS_DOSE_WITHOUT_CARD' });
    expect(finalizeBolusAnswer(text, { used: false, proposed: [] }).text).toMatch(/przygotuj bolus/);
    expect(finalizeBolusAnswer('Podałem bolus 2 j.', withCard)).toMatchObject({ corrected: true, kind: 'BOLUS_GIVEN_CLAIM' });
    expect(finalizeBolusAnswer(text, withCard)).toEqual({ text, corrected: false });
    expect(finalizeBolusAnswer(text, null)).toEqual({ text, corrected: false });
    // The card tool failed: a dose in the text still gets the note, pointing to the Bolus tab.
    expect(finalizeBolusAnswer(text, { used: true, failed: true, proposed: [] }).text).toMatch(/zakładki Bolus/);
  });

  it('marks a session whose card could not be prepared', async () => {
    const { instance } = session();
    (instance as any).deps.context = async () => { throw new Error('db down'); };
    await expect(instance.propose(meal)).rejects.toThrow('db down');
    expect(instance.failed).toBe(true);
  });

  it('adds nothing when the answer proposes no dose or tried to prepare a card', () => {
    const refused = '**Propozycja:** brak, bo glukoza to **76 mg/dl** ze strzałką mocno w dół, przy **0,69 j IOB** i **28 g COB**.';
    expect(proposesDose(refused)).toBe(false);
    expect(finalizeBolusAnswer(refused, { used: false, proposed: [] })).toEqual({ text: refused, corrected: false });
    expect(proposesDose('**Propozycja:** nie podawaj teraz insuliny (IOB 1,2 j).')).toBe(false);
    expect(proposesDose('**Propozycja:** poczekaj 20 min.')).toBe(false);
    expect(proposesDose('**Propozycja:** 1 j korekty, IOB 0,7 j aktywnej.')).toBe(true);
    expect(proposesDose('**Propozycja:** 2,5 jednostki na kanapkę.')).toBe(true);
    expect(proposesDose('IOB 0,7 j. Bez propozycji.')).toBe(false);
    // propose_bolus was called and refused (e.g. low glucose): the answer says why, no note.
    const dose = '**Propozycja:** 4,5 j na obiad.';
    expect(finalizeBolusAnswer(dose, { used: true, proposed: [] })).toEqual({ text: dose, corrected: false });
  });

  it('does not ask to write "przygotuj bolus" when the caregiver just asked for one', () => {
    const dose = '**Propozycja:** 4,5 j na obiad.';
    const result = finalizeBolusAnswer(dose, { used: false, proposed: [], dose_requested: true });
    expect(result.corrected).toBe(true);
    expect(result.text).not.toMatch(/przygotuj bolus/);
    expect(result.text).toMatch(/zakładki Bolus/);
  });

  it('corrects a claim that insulin was given', () => {
    expect(finalizeBolusAnswer('Podałem bolus 4 j.', withCard).text).toMatch(/Nic nie zostało podane/);
  });
});

describe('dose questions', () => {
  it('recognises a request for a dose to give', () => {
    expect(isDoseRequest('Ile podać na 2 naleśniki z serem?')).toBe(true);
    expect(isDoseRequest('jaką dawkę dać na obiad')).toBe(true);
    expect(isDoseRequest('Przygotuj bolus na kolację')).toBe(true);
    expect(isDoseRequest('ile insuliny na pizzę')).toBe(true);
    expect(isDoseRequest('Jak minęła noc?')).toBe(false);
    expect(isDoseRequest('ile węgli ma banan')).toBe(false);
  });
});

describe('card view', () => {
  const proposal: BolusProposalRecord = {
    id: 'b1', patient_id: 'p1', conversation_id: 'c1', user_message_id: 'm1', purpose: 'MEAL', carbs_g: 46, insulin_u: 3.8,
    icr_g_per_u: 12, icr_insulin_u: 3.8, meal_payload: null, reason: null, warnings: [], split: null, dose_adjustment: null, card_advice: null, status: 'PROPOSED',
    expires_at: '2026-10-19T12:15:00.000Z', created_at: '2026-10-19T12:00:00.000Z',
  };
  it('is usable until it expires, then asks to recalculate; a sent card shows its command', () => {
    expect(toBolusProposalView(proposal, null, 'u1', now).state).toBe('PROPOSED');
    expect(toBolusProposalView(proposal, null, 'u1', new Date('2026-10-19T12:16:00.000Z')).state).toBe('EXPIRED');
    const command = { id: 'rc1', status: 'SUCCEEDED', status_message: 'Bolus podany', carbs_g: 46, insulin_u: 3.8, meal_record_id: 'meal1', user_id: 'u2' };
    expect(toBolusProposalView(proposal, command, 'u1', now)).toMatchObject({ state: 'SENT', command: { meal_record_id: 'meal1', sent_by_me: false } });
    expect(toBolusProposalView(proposal, { ...command, status: 'SEND_FAILED' }, 'u1', now).state).toBe('PROPOSED');
    // Given, the meal not saved yet: the card shows it is being saved, then that it was not found.
    const pending = { ...command, meal_record_id: null, authorized_at: '2026-10-19T11:59:00.000Z' };
    expect(toBolusProposalView(proposal, pending, 'u1', now).command?.meal_state).toBe('SAVING');
    expect(toBolusProposalView(proposal, pending, 'u1', new Date('2026-10-19T12:30:00.000Z')).command?.meal_state).toBe('NOT_FOUND');
    expect(toBolusProposalView(proposal, { ...pending, carbs_g: 0 }, 'u1', now).command?.meal_state).toBe('NONE');
    expect(toBolusProposalView(proposal, command, 'u1', now).command?.meal_state).toBe('SAVED');
  });
});

describe('changing an earlier plan (the 30% part of a split disappeared)', () => {
  const pizzaItems = [{ name: 'Pizza pepperoni', grams: 125, carbs_g: 40, protein_g: 14, fat_g: 14, source: 'ESTIMATE' }];
  const part = (overrides: Record<string, unknown>) => ({ trigger: 'AFTER_MINUTES', after_minutes: 60, threshold_mgdl: null, carbs_g: 0, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null, ...overrides });
  const pizza = { ...meal, carbs_g: 28, meal_description: 'Pół małej pizzy pepperoni', items: pizzaItems };
  const earlier = {
    id: 'b0', purpose: 'MEAL' as const, carbs_g: 28, created_at: '2026-10-19T11:55:00.000Z', sent: false,
    meal_payload: { description: 'Pół małej pizzy pepperoni', items: null, macros: null },
    split: { kind: 'SPLIT' as const, policy_version: 'later-plan.v1', now_percent: 70, later_after_minutes: 60, total_carbs_g: 40, total_insulin_u: 5, later_carbs_g: 12, later_insulin_u: 1.5 },
  };
  const withEarlier = () => {
    const stored: NewBolusProposal[] = [];
    const instance = new BolusProposalSession({
      patientId: 'p1', conversationId: 'c1', userMessageId: 'm2', doseRequested: true, now: () => now,
      context: async () => context({ icr_g_per_u: 8 }),
      previousCards: async () => [earlier],
      store: { insert: async (proposal) => { stored.push(proposal); return { ...proposal, id: 'b1', status: 'PROPOSED', created_at: now.toISOString() }; } },
    });
    return { instance, stored };
  };

  it('warns when an earlier answer\'s card for the same meal was already sent', async () => {
    const sentCard = { ...earlier, sent: true, sent_at: '2026-10-19T11:56:00.000Z', sent_carbs_g: 28, sent_insulin_u: 3.5 };
    const instance = new BolusProposalSession({
      patientId: 'p1', conversationId: 'c1', userMessageId: 'm2', doseRequested: true, now: () => now,
      context: async () => context({ icr_g_per_u: 8 }),
      previousCards: async () => [sentCard],
      store: { insert: async (proposal) => ({ ...proposal, id: 'b1', status: 'PROPOSED', created_at: now.toISOString() }) },
    });
    const result: any = await instance.propose(pizza);
    expect(result.card.warnings.join(' ')).toMatch(/wysłano już kartę \d+ min temu \(28 g, 3,5 j\)/);
    expect(result.already_sent).toMatchObject({ sent_card: { carbs_g: 28, insulin_u: 3.5 } });
    // Another meal: no warning.
    expect(((await instance.propose({ ...pizza, meal_description: 'Jabłko', items: null, carbs_g: 12 })) as any).already_sent).toBeUndefined();
  });

  it('keeps every part: half the first dose now, the other half in 10 min, the 12 g part still in 60 min', async () => {
    const { instance, stored } = withEarlier();
    const result = await instance.propose({ ...pizza, insulin_u: 1.8, later: [part({ after_minutes: 10, insulin_u: 1.8 }), part({ carbs_g: 12 })] });
    expect(result).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 28, insulin_u: 1.8, warnings: [], later: [{ kind: 'DEFERRED_INSULIN', after_minutes: 10, insulin_u_estimate: 1.8 }, { kind: 'SPLIT', after_minutes: 60, carbs_g: 12, insulin_u_estimate: 1.5 }], whole_plan: { carbs_g: 40 } } });
    expect(result).not.toHaveProperty('earlier_plan');
    expect(stored[0].split).toMatchObject({ kind: 'DEFERRED_INSULIN', fixed_insulin_u: 1.8, more_parts: [{ kind: 'SPLIT', later_carbs_g: 12 }] });
  });

  it('carbs now without insulin and a later part for its own carbs only: the later dose covers the carbs now too', async () => {
    const { instance, stored } = withEarlier();
    const result = await instance.propose({ ...pizza, meal_description: 'Kromka chleba', items: null, carbs_g: 7, insulin_u: 0, later: [part({ trigger: 'GLUCOSE_STOPPED_FALLING', after_minutes: 15, carbs_g: 6 })] });
    expect(stored[0].split).toMatchObject({ kind: 'SPLIT', later_carbs_g: 6, dose_carbs_g: 13 });
    // 13 g / ICR 8 = 1.6 U (was 0.75 U for the 6 g alone).
    expect(result).toMatchObject({ status: 'PROPOSED', card: { later: [{ carbs_g: 6, insulin_u_estimate: 1.6 }], card_carbs_dosed_later: expect.stringContaining('13 g') } });
    // A caregiver's own later dose, or a later dose for the card's carbs, stays as asked.
    const own = await withEarlier().instance.propose({ ...pizza, items: null, carbs_g: 7, insulin_u: 0, later: [part({ after_minutes: 15, carbs_g: 6, insulin_u: 0.5 })] });
    expect(own).not.toHaveProperty('card.card_carbs_dosed_later');
  });

  it('a card without a meal name follows the earlier card only when the conversation has cards of one meal', async () => {
    const unnamed = { ...pizza, meal_description: null, items: null, insulin_u: 1.8, later: [part({ after_minutes: 10, insulin_u: 1.8 })] };
    expect(await withEarlier().instance.propose(unnamed)).toMatchObject({ earlier_plan: { missing_carbs_g: 12 } });
    const dessert = { ...earlier, id: 'b9', meal_payload: { description: 'Lody', items: null, macros: null } };
    const stored: NewBolusProposal[] = [];
    const twoMeals = new BolusProposalSession({
      patientId: 'p1', conversationId: 'c1', userMessageId: 'm2', doseRequested: true, now: () => now,
      context: async () => context({ icr_g_per_u: 8 }),
      previousCards: async () => [earlier, dessert],
      store: { insert: async (proposal) => { stored.push(proposal); return { ...proposal, id: 'b1', status: 'PROPOSED', created_at: now.toISOString() }; } },
    });
    expect(await twoMeals.propose(unnamed)).not.toHaveProperty('earlier_plan');
  });

  it('warns when the new card leaves out grams of the earlier unsent plan for the same meal', async () => {
    const { instance } = withEarlier();
    const result = await instance.propose({ ...pizza, insulin_u: 1.8, later: [part({ after_minutes: 10, insulin_u: 1.8 })] });
    expect((result.card as { warnings: string[] }).warnings).toContain('Poprzednia karta na ten posiłek obejmowała 40 g (28 g teraz, 12 g za 60 min); ta obejmuje 28 g, więc 12 g nie ma w planie.');
    expect(result).toMatchObject({ earlier_plan: { missing_carbs_g: 12 } });
  });

  it('keeps the earlier card\'s items when only the split changes (the half-and-half card lost its WBT)', async () => {
    const stored: NewBolusProposal[] = [];
    const withItems = (cardEarlier: typeof earlier) => new BolusProposalSession({
      patientId: 'p1', conversationId: 'c1', userMessageId: 'm2', doseRequested: true, now: () => now,
      context: async () => context({ icr_g_per_u: 8 }),
      previousCards: async () => [cardEarlier],
      store: { insert: async (proposal) => { stored.push(proposal); return { ...proposal, id: 'b1', status: 'PROPOSED', created_at: now.toISOString() }; } },
    });
    const earlierWithItems = { ...earlier, meal_payload: { description: 'Pół małej pizzy pepperoni Domino’s', items: pizzaItems, macros: { carbs_g: 40, protein_g: 14, fat_g: 14 } } };
    const halves = { ...pizza, meal_description: "Pół małej pizzy pepperoni Domino's", items: null, carbs_g: 20, later: [part({ carbs_g: 20 })] };
    const result = await withItems(earlierWithItems).propose(halves);
    expect(result).toMatchObject({ status: 'PROPOSED', wbt: { units: 1.8 }, items_note: expect.any(String) });
    expect(stored[0].meal_payload).toMatchObject({ items: pizzaItems, macros: { protein_g: 14, fat_g: 14 } });
    // Another amount of the meal: the earlier protein and fat would be wrong, so no items.
    const smaller = await withItems(earlierWithItems).propose({ ...halves, later: [part({ carbs_g: 10 })] });
    expect(smaller).not.toHaveProperty('wbt');
    expect(stored[1].meal_payload).toMatchObject({ items: null, macros: null });
  });

  it("gives the app's WBT rule with a meal card (1,8 WBT × 10 / 8 × 30% ≈ 0,65 j, reminder after 2.5 h)", async () => {
    const result = await session(context({ icr_g_per_u: 8 })).instance.propose(pizza);
    expect(result).toMatchObject({ wbt: { units: 1.8, standard_dose_u: 0.65, reminder: expect.stringMatching(/^automatic/) } });
    // 28 g of the 40 g items: the result says how the items were read.
    expect((result as any).items_note).toMatch(/items add up to 40 g of carbs but this plan gives 28 g/);
  });
});

describe('settleAnswerCards', () => {
  const kinder = 'Kinder mleczna kanapka FERRERO 28 g';
  const card = (id: string, option_key: 'A' | 'B' | 'C' | null, overrides: Partial<{ purpose: 'MEAL' | 'CORRECTION'; carbs_g: number; insulin_u: number; description: string | null; split: unknown }> = {}) => ({
    id,
    option_key,
    purpose: overrides.purpose ?? ('MEAL' as const),
    carbs_g: overrides.carbs_g ?? 9,
    insulin_u: overrides.insulin_u ?? 1.1,
    meal_payload: overrides.description === null ? null : { description: overrides.description ?? kinder, items: null, macros: { carbs_g: 9, protein_g: 2.3, fat_g: 7.8 } },
    split: (overrides.split ?? null) as never,
  });
  const option = (key: 'A' | 'B' | 'C', recommended = false) => ({ key, title: `Opcja ${key}`, detail: null, note: null, recommended });
  const ids = (cards: Array<{ id: string }>) => cards.map((entry) => entry.id);

  it('drops the older of two identical cards, one tagged B and one untagged (2026-10-23 16:10, Kinder 9 g / 1,1 j)', () => {
    const settled = settleAnswerCards([], [card('b', 'B'), card('plain', null)], []);
    expect(ids(settled.discardBolus)).toEqual(['b']);
    expect(ids(settled.duplicates)).toEqual(['b']);
    expect(settled.options).toEqual([]);
  });

  it('treats meal names that differ only in case and outer spaces as the same meal', () => {
    expect(ids(settleAnswerCards([], [card('1', null), card('2', null, { description: ` ${kinder.toUpperCase()} ` })], []).discardBolus)).toEqual(['1']);
  });

  it('keeps both cards when anything sendable differs: dose, carbs, later parts, meal or purpose', () => {
    const split = { policy_version: 'later-plan.v1', now_percent: 60, later_after_minutes: 60, total_carbs_g: 15, total_insulin_u: 1.8, later_carbs_g: 6, later_insulin_u: 0.7 };
    for (const other of [
      card('2', null, { insulin_u: 0.9 }),
      card('2', null, { carbs_g: 10 }),
      card('2', null, { split }),
      card('2', null, { description: 'Zupa krem z marchewki' }),
      card('2', null, { purpose: 'CORRECTION', description: null }),
    ]) {
      expect(settleAnswerCards([], [card('1', 'B'), other], []).discardBolus).toEqual([]);
    }
  });

  it('compares later parts whatever the order of their keys (a card read back from jsonb)', () => {
    const split = { policy_version: 'later-plan.v1', now_percent: 60, later_after_minutes: 60, total_carbs_g: 15, total_insulin_u: 1.8, later_carbs_g: 6, later_insulin_u: 0.7 };
    const reordered = Object.fromEntries(Object.entries(split).reverse());
    expect(ids(settleAnswerCards([], [card('1', null, { split }), card('2', null, { split: reordered })], []).discardBolus)).toEqual(['1']);
  });

  it('leaves every card of a picker alone, also equal cards of different options, and drops only cards without an option', () => {
    const cards = [card('a1', 'A', { insulin_u: 0 }), card('a2', 'A', { purpose: 'CORRECTION', description: null }), card('b', 'B'), card('c', 'C'), card('loose', null)];
    const settled = settleAnswerCards([option('A', true), option('B'), option('C')], cards, [{ id: 'r', option_key: 'A' }]);
    expect(ids(settled.discardBolus)).toEqual(['loose']);
    expect(settled.discardRescue).toEqual([]);
    expect(settled.duplicates).toEqual([]);
    expect(settled.options.map((entry) => entry.key)).toEqual(['A', 'B', 'C']);
  });

  it('without a picker keeps only the recommended option of several, then drops copies among what is left', () => {
    const settled = settleAnswerCards([], [card('a', 'A'), card('b', 'B', { insulin_u: 2 }), card('plain', null)], [{ id: 'rb', option_key: 'B' }]);
    expect(settled.keptOption).toBe('A');
    expect(ids(settled.discardBolus)).toEqual(['b', 'a']);
    expect(ids(settled.discardRescue)).toEqual(['rb']);
  });
});
