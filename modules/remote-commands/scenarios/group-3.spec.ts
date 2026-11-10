import { describe, expect, it, vi } from 'vitest';
import { ConflictError, ValidationError } from '@shared/errors/app-error';
import { FITTED_V1_FORECAST_CALIBRATION } from '@modules/glucose-forecast/application/forecast-calibration';
import { scheduleValueAt } from '@modules/meal-wbt/application/wbt-policy';
import { mealPlanPushDecision } from '@modules/meal-plan/application/meal-plan';
import { buildRescuePushText } from '@modules/rescue-carbs/application/rescue-carb-alert.service';
import { runMealChatReplyJob, type MealChatReplyDeps } from '@modules/meal-chat/application/meal-chat-reply.job';
import type { MealChatMessage } from '@infra/db/postgres-meal-chat.repository';
import { BolusProposalSession, toBolusProposalView, type NewBolusProposal } from '../application/bolus-proposal-tool';
import type { MealForecastData } from '../application/meal-dose-forecast';
import type { RemoteCommandContext } from '../application/remote-command-policy';
import type { NewRemoteCommand, RemoteCommandRecord, RemoteCommandStore } from '../application/remote-command-record';
import { RemoteCommandsService, type RemoteCommandRequest } from '../application/remote-commands.service';
import { canTransitionRemoteCommand, IN_FLIGHT_STATUSES, type RemoteCommandStatus } from '../application/remote-command-status';
import { plannedBolusReadinessFrom } from '../application/deferred-bolus';
import { givenSinceMeal } from '../application/bolus-reminders';
import {
  bolusesSinceMealForPart,
  pendingRemoteDosesAsActions,
  calculatorHeldBackU,
  estimatePlannedBolus,
  mealDoseShortfall,
  partDeductionU,
  plannedBolusDueAt,
  plannedBolusExpiresAtMs,
  plannedBolusForceAt,
  plannedBolusPushContent,
  plannedBolusReadiness,
  plannedDoseCarbs,
  type PlannedBolusRecord,
} from '../application/split-bolus';
import { ApiService } from '../../../apps/api/src/application/api.service';

/*
 * Grupa 3 scenariuszy od mamy dziecka z T1D i diabetologa (2026-11-10): każdy test nosi id scenariusza.
 * it.fails: test opisuje zachowanie oczekiwane przez mamę / diabetologa, którego serwer dziś nie daje (zgłoszone jako FAIL).
 */

const ICR = 8.3;
const now = new Date('2026-11-10T10:30:00.000Z'); // 11:30 w Warszawie
const at = (minutesFromNow: number, from = now) => new Date(from.getTime() + minutesFromNow * 60_000).toISOString();
const ago = (minutes: number, from = now) => at(-minutes, from);

/** Odczyty co 5 min (najstarszy pierwszy) i krzywa IOB Trio; kalibracja wyłączona, żeby liczby szły za krzywą. */
function forecast(values: number[], iob: number, curve: number[], from = now, cob = 0): MealForecastData {
  return {
    readings: values.map((value, index) => ({ at: ago((values.length - 1 - index) * 5 + 1, from), value })),
    prediction: {
      source: 'OPENAPS', system: 'TRIO', computed_at: ago(1, from), bg: values.at(-1)!, carbs_req_g: null, iob_u: iob, cob_g: cob,
      isf_mgdl_per_u: 100, icr_g_per_u: ICR, eventual_bg: curve.at(-1)!, target_mgdl: 100, curves: { IOB: curve },
    } as never,
    profile_isf: 100,
    profile_target: 100,
    profile_units: 'mg/dl',
    calibration: { ...FITTED_V1_FORECAST_CALIBRATION, version: 'test-none', shrink_by_minutes: { 5: 1 } },
  };
}

type Ctx = Omit<RemoteCommandContext, 'in_flight_command_id' | 'recent_remote_bolus'> & { meal_forecast?: MealForecastData | null };
const context = (overrides: Partial<Ctx> = {}, from = now): Ctx => ({
  now: from.toISOString(),
  glucose: { value: 130, observed_at: ago(1, from), delta: 0 },
  lowest_recent_glucose: 125,
  loop: { iob_units: 0.3, cob_grams: 0, observed_at: ago(1, from) },
  last_bolus: null,
  icr_g_per_u: ICR,
  bolus_history_known: true,
  ...overrides,
});

function chatSession(ctx: Ctx, doseBasis: 'ICR' | 'CALCULATOR' = 'ICR', at = now) {
  const stored: NewBolusProposal[] = [];
  let next = 0;
  const instance = new BolusProposalSession({
    patientId: 'p1', conversationId: 'c1', userMessageId: 'm1', doseRequested: true, now: () => at, doseBasis, context: async () => ctx,
    store: { insert: async (proposal) => { stored.push(proposal); return { ...proposal, id: `b${++next}`, status: 'PROPOSED', created_at: at.toISOString() }; } },
  });
  return { instance, stored };
}

const mealArgs = (carbs: number, items: Array<{ name: string; carbs_g: number; protein_g: number; fat_g: number }>, extra: Record<string, unknown> = {}) => ({
  purpose: 'MEAL', carbs_g: carbs, insulin_u: null, reduce_for_drop: false, add_correction: false, eating_now: false, later: null, use_advised_split: 'NO', option: null,
  meal_description: 'Obiad', reason: null,
  items: items.map((item) => ({ ...item, grams: null, source: 'ESTIMATE' })),
  ...extra,
});

class MemoryStore implements RemoteCommandStore {
  rows: RemoteCommandRecord[] = [];
  async insert(command: NewRemoteCommand): Promise<RemoteCommandRecord> {
    if (this.rows.some((row) => row.patient_id === command.patient_id && IN_FLIGHT_STATUSES.has(row.status))) throw new ConflictError('COMMAND_IN_FLIGHT');
    const record: RemoteCommandRecord = { ...command, id: `00000000-0000-4000-8000-00000000000${this.rows.length + 1}`, status: 'AUTHORIZED', trio_message: null, status_message: null, authorized_at: new Date(Date.parse(command.send_deadline) - 120_000).toISOString(), sent_at: null, answered_at: null, loop_action_id: null, meal_record_id: null, matched_at: null };
    this.rows.push(record);
    return record;
  }
  async get(patientId: string, id: string) { return this.rows.find((row) => row.patient_id === patientId && row.id === id) ?? null; }
  async list(patientId: string) { return this.rows.filter((row) => row.patient_id === patientId); }
  async findInFlight(patientId: string) { return this.rows.find((row) => row.patient_id === patientId && IN_FLIGHT_STATUSES.has(row.status)) ?? null; }
  async recordSentAt() {}
  async listForProposal(patientId: string, proposalId: string) { return this.rows.filter((row) => row.proposal_id === proposalId); }
  async listForPlannedBolus(patientId: string, planId: string) { return this.rows.filter((row) => row.planned_bolus_id === planId); }
  async listWbtForMeal() { return []; }
  async findRecentWithInsulin(patientId: string, since: string) {
    return this.rows.filter((row) => row.insulin_u > 0 && ['SENT', 'TRIO_ACCEPTED', 'SUCCEEDED', 'NO_REPLY', 'UNCERTAIN'].includes(row.status) && (row.sent_at ?? row.authorized_at) >= since).at(-1) ?? null;
  }
  async listRecentMealBoluses(patientId: string, since: string) {
    return this.rows.filter((row) => row.carbs_g > 0 && row.insulin_u > 0 && row.authorized_at >= since);
  }
  async transition(patientId: string, id: string, to: RemoteCommandStatus, fields: Record<string, unknown>) {
    const row = await this.get(patientId, id);
    if (!row || !canTransitionRemoteCommand(row.status, to)) return null;
    Object.assign(row, { status: to }, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
    return row;
  }
}

const PLAN_CARD = '44444444-4444-4444-8444-444444444444';
/** The planned meal's card as RemoteCommandsService reads it (no conversation). */
const planCardStore = (card: { carbs_g: number; insulin_u: number; split?: unknown; description?: string }, expiresAt = at(15)) => ({
  get: async () => ({ conversation_id: null, status: 'PROPOSED', expires_at: expiresAt, carbs_g: card.carbs_g, insulin_u: card.insulin_u, warnings: [], purpose: 'MEAL', split: (card.split ?? null) as never, meal_payload: { description: card.description ?? 'Obiad', items: null, macros: null } }),
});
const commandRequest = (overrides: Partial<RemoteCommandRequest>): RemoteCommandRequest => ({
  source: 'BOLUS_SCREEN', carbs_g: 30, insulin_u: 3.6, bolus_step: 0.05, device_id: 'phone-dad', acknowledged_warnings: [], ...overrides,
});

/** A planned part as the store keeps it. */
function part(overrides: Partial<PlannedBolusRecord> = {}): PlannedBolusRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111', kind: 'SPLIT', patient_id: 'p1', meal_record_id: 'm1', proposal_id: 'b1', conversation_id: 'c1',
    first_command_id: 'cmd-1', first_carbs_g: 18, first_insulin_u: 2.15, carbs_g: 12, planned_insulin_u: 1.4, icr_g_per_u: ICR, now_percent: 60, delay_minutes: 30,
    due_at: at(30), status: 'SCHEDULED', notified_at: null, resolved_at: null, resolved_by_user_id: null, resolved_by_name: null,
    given_command_id: null, given_loop_action_id: null, given_insulin_u: null, created_at: now.toISOString(),
    trigger: 'AFTER_MINUTES', threshold_mgdl: null, dose_carbs_g: null, fixed_insulin_u: null, drop_cover_g: null, subtract_first_insulin: false, wait_until: null,
    ...overrides,
  };
}
const therapy = { timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', ICR]] as Array<[string, number]>, basal_u_per_h: null };

/** ApiService with only what the planned meal's card reads (as api.service.meal-plan-bolus-card.spec.ts). */
const ENTRY = '22222222-2222-4222-8222-222222222222';
const CAREGIVER = { user_id: '33333333-3333-4333-8333-333333333333' } as never;
function planApi(ctx: (at: Date) => Ctx, dishes: Array<{ name: string; carbs_g: number; protein_g: number | null; fat_g: number | null }>) {
  const api = new ApiService({} as never, {} as never) as any;
  const inserted: any[] = [];
  api.assertCanSendRemoteCommands = vi.fn(async () => undefined);
  api.userDoseBasis = vi.fn(async () => 'ICR');
  api.mealPlans = { getEntry: vi.fn(async (_p: string, id: string) => (id === ENTRY ? { id: ENTRY, kind: 'MEAL', status: 'PLANNED', title: 'Obiad', items: dishes, planned_at: '2026-11-10T10:30:00.000Z', dose_answer: null } : null)) };
  api.plannedBoluses = { summariesForProposals: vi.fn(async () => new Map()) };
  api.bolusProposals = {
    listForMealPlanEntry: vi.fn(async () => []),
    discardUnsentForMealPlanEntry: vi.fn(async () => undefined),
    insert: vi.fn(async (proposal: any) => { const record = { ...proposal, id: '55555555-5555-4555-8555-55555555555' + inserted.length, status: 'PROPOSED', created_at: new Date().toISOString() }; inserted.push(record); return record; }),
    discard: vi.fn(async () => undefined),
  };
  api.remoteCommandContext = vi.fn(async (_patient: string, at: Date) => ({ ...ctx(at), forecast_inputs: {} }));
  return { api: api as ApiService, inserted };
}

describe('Grupa 3: scenariusze mamy i diabetologa', () => {
  // ───────────────────────────── M3 ─────────────────────────────
  it('M3: niejadek przez czat — 60% teraz, reszta po 30 min przeliczana przy otwarciu (ICR teraz − SMB), push z tymi samymi gramami', async () => {
    const dinner = [{ name: 'Obiad', carbs_g: 30, protein_g: 10, fat_g: 6 }];
    const { instance, stored } = chatSession(context({ meal_forecast: forecast([130, 130, 130, 130], 0.3, [130, 128, 126, 124, 122, 120, 118]) }));
    const later = { trigger: 'AFTER_MINUTES', after_minutes: 30, threshold_mgdl: null, carbs_g: 12, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null };
    const card: any = await instance.propose(mealArgs(18, dinner, { later }));
    // 18 g / 8,3 = 2,15 j teraz (ok. 60%), 12 g ≈ 1,4 j za 30 min.
    expect(card).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 18, insulin_u: 2.15, later: [{ kind: 'SPLIT', carbs_g: 12, insulin_u_estimate: 1.4, after_minutes: 30 }], whole_plan: { carbs_g: 30 } } });
    expect(stored[0].split).toMatchObject({ now_percent: 60, later_carbs_g: 12 });
    // Przy otwarciu: 12 g / 8,3 = 1,44 j minus SMB 0,3 j z pętli od posiłku = 1,1 j.
    const meal = now.toISOString();
    const open = estimatePlannedBolus({
      plan: part(), meal_started_at: meal, now_iso: at(31), therapy, step: 0.05, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt,
      events: [{ type: 'SMB', occurred_at: at(15), payload: { insulin_units: 0.3 } } as never],
    });
    expect(open).toMatchObject({ insulin_for_carbs_u: 1.4, smb_u: 0.3, insulin_u: 1.1 });
    // Push: te same gramy co plan (12 g), bez jednostek na ekranie blokady.
    const push = plannedBolusPushContent({ description: 'Obiad', carbs_g: part().carbs_g, estimate_u: open.insulin_u, low_glucose: null });
    expect(push).toEqual({ title: 'Druga część bolusa · 12 g', body: 'Obiad. Dotknij, aby sprawdzić dawkę.' });
    expect(plannedDoseCarbs(part())).toBe(12);
  });

  // Błąd/brak: karta z planu (i karta A) dla zwykłego obiadu 30 g nie ma przycisku „Podziel” / „Więcej później”;
  // jedyny wariant to „Dawka później” (cała dawka za 20 min). Podział dostaje tylko posiłek tłusty (split-advice).
  it.fails('M3: karta z planu dla chudego obiadu oferuje „Podziel” / część teraz, resztę później', async () => {
    const { api, inserted } = planApi((at) => context({ glucose: { value: 130, observed_at: ago(1, at), delta: 0 }, meal_forecast: forecast([130, 130, 130, 130], 0.3, [130, 128, 126, 124, 122, 120, 118], at) }), [{ name: 'Obiad', carbs_g: 30, protein_g: 10, fat_g: 6 }]);
    await api.mealPlanBolusCard(CAREGIVER, 'p1', ENTRY, { items: [{ name: 'Obiad', carbs_g: 30, protein_g: 10, fat_g: 6 }] });
    const kinds = (inserted[0].card_advice.variants ?? []).map((variant: { kind: string }) => variant.kind);
    expect(kinds).toEqual(['BOLUS_LATER']); // stan dzisiejszy
    expect(kinds.some((kind: string) => kind === 'SPLIT' || kind === 'MORE_LATER' || kind === 'HALF_NOW')).toBe(true);
  });

  // Błąd/brak: pytanie „Ile zostało na talerzu?” i połowa części działają tylko dla potrawy z notatką
  // (card-food-notes.v1). Zwykła druga część przy portion=HALF jest liczona w całości (12 g, nie 6 g).
  it.fails('M3: „połowa zostało” zmniejsza zwykłą drugą część proporcjonalnie', async () => {
    const api = new ApiService({} as never, {} as never) as any;
    const plan = part();
    const seen: PlannedBolusRecord[] = [];
    api.assertCanReadPatient = vi.fn(async () => undefined);
    api.resolveMealIdentity = vi.fn(async () => 'meal:identity');
    api.plannedBolusRepository = { get: vi.fn(async () => plan), latestForMeal: vi.fn(async () => plan) };
    api.bolusProposals = { get: vi.fn(async () => ({ id: 'b1', card_advice: { policy_version: 'card-advice.v2' } })) };
    api.loadMealView = vi.fn(async () => ({ started_at: now.toISOString() }));
    api.remoteCommandRepository = { latestForPlannedBolus: vi.fn(async () => null) };
    api.plannedPartEstimate = vi.fn(async (_p: string, given: PlannedBolusRecord) => { seen.push(given); return { insulin_u: roundTo(given.carbs_g / ICR) }; });
    const result = await (api as ApiService).getMealPlannedBolus(CAREGIVER, 'p1', 'm1', plan.id, 'HALF');
    expect(seen[0].carbs_g).toBe(12); // stan dzisiejszy: cała część
    expect((result as any).planned_bolus.food_note).toBeUndefined(); // stan dzisiejszy: pytania o talerz nie ma
    expect(seen[0].carbs_g).toBe(6);
  });

  // ───────────────────────────── M9 ─────────────────────────────
  it('M9: dwa telefony — drugi bolus na ten sam obiad jest zablokowany w locie, potem wymaga potwierdzenia ostrzeżenia DANGER', async () => {
    const store = new MemoryStore();
    const ctx = async () => context();
    const mom = new RemoteCommandsService(store, ctx, planCardStore({ carbs_g: 30, insulin_u: 3.6 }) as never);
    const sentAt = now;
    const momCommand = await mom.authorize('p1', 'mom', commandRequest({ source: 'CHAT_CARD', proposal_id: PLAN_CARD, conversation_id: null, device_id: 'phone-mom', meal: { description: 'Obiad', items: null, macros: null } as never }), sentAt);
    // 30 s później, polecenie mamy czeka na odpowiedź Trio: telefon taty nie może wysłać.
    const dadTime = new Date(now.getTime() + 30_000);
    const dad = new RemoteCommandsService(store, ctx);
    const inFlight = await dad.preview('p1', { carbs_g: 30, insulin_u: null, bolus_step: 0.05 }, dadTime);
    expect(inFlight.blocks.map((block) => block.code)).toEqual(['COMMAND_IN_FLIGHT']);
    await expect(dad.authorize('p1', 'dad', commandRequest({}), dadTime)).rejects.toThrow(/REMOTE_COMMAND_BLOCKED|COMMAND_IN_FLIGHT/);
    // Trio potwierdza bolus mamy; tata widzi DANGER i bez potwierdzenia nie wyśle.
    await mom.reportSent('p1', 'mom', momCommand.id, { accepted: true }, sentAt);
    await mom.reportReply('p1', 'mom', momCommand.id, { success: true, message: 'Bolus started' }, sentAt);
    // D1 (2026-11-10): with nothing typed the form starts at 0 j; the dose typed (3,6 j) gets the DANGER.
    expect((await dad.preview('p1', { carbs_g: 30, insulin_u: null, bolus_step: 0.05 }, dadTime)).insulin_u).toBe(0);
    const after = await dad.preview('p1', { carbs_g: 30, insulin_u: 3.6, bolus_step: 0.05 }, dadTime);
    const same = after.warnings.find((warning) => warning.code === 'ALREADY_SENT_FOR_MEAL');
    expect(same).toMatchObject({ severity: 'DANGER' });
    expect(same!.message).toMatch(/\d+ min temu wysłano .*30 g i 3,6 j \(Obiad\)\. Jeśli to ten sam posiłek, ta dawka poda insulinę drugi raz\./);
    await expect(dad.authorize('p1', 'dad', commandRequest({}), dadTime)).rejects.toThrow(/REMOTE_COMMAND_WARNINGS_CHANGED/);
    // Push planu na drugi telefon nie wychodzi, gdy bolus już podano (meal-plan.v1).
    const entry = { kind: 'MEAL' as const, status: 'PLANNED' as const, planned_at: at(20), lead_minutes: 20, reminder_sent_at: null, missed_sent_at: null };
    expect(mealPlanPushDecision(entry, now, true)).toEqual({ action: 'CLOSE_REMINDER' });
  });

  // Błąd: ostrzeżenie taty nie mówi, kto podał (mama), a o karcie ze strony zaplanowanego posiłku mówi „z rozmowy”.
  it.fails('M9: ostrzeżenie na telefonie taty mówi, kto podał i skąd („Mama podała 3,6 j na Obiad”)', async () => {
    const store = new MemoryStore();
    const mom = new RemoteCommandsService(store, async () => context(), planCardStore({ carbs_g: 30, insulin_u: 3.6 }) as never);
    const command = await mom.authorize('p1', 'mom', commandRequest({ source: 'CHAT_CARD', proposal_id: PLAN_CARD, conversation_id: null, device_id: 'phone-mom', meal: { description: 'Obiad', items: null, macros: null } as never }), now);
    await mom.reportSent('p1', 'mom', command.id, { accepted: true }, now);
    await mom.reportReply('p1', 'mom', command.id, { success: true, message: 'Bolus started' }, now);
    const preview = await new RemoteCommandsService(store, async () => context()).preview('p1', { carbs_g: 30, insulin_u: null, bolus_step: 0.05 }, new Date(now.getTime() + 30_000));
    const message = preview.warnings.find((warning) => warning.code === 'ALREADY_SENT_FOR_MEAL')!.message;
    expect(message).toContain('z rozmowy'); // stan dzisiejszy: karta z planu opisana jako „z rozmowy”, bez osoby
    expect(message).not.toContain('z rozmowy');
    expect(message).toMatch(/Mama|mom/);
  });

  // ───────────────────────────── M15 ─────────────────────────────
  it('M15: karta z planu jest dostępna 25 min przed godziną z planu, liczona na teraz, a push o 11:10 nie przychodzi po podaniu o 11:05', async () => {
    const early = new Date('2026-11-10T10:05:00.000Z'); // 11:05 w Warszawie, plan 11:30
    vi.useFakeTimers({ now: early, toFake: ['Date'] });
    try {
      const { api, inserted } = planApi((at) => context({ glucose: { value: 125, observed_at: ago(1, at), delta: 0 }, meal_forecast: forecast([125, 125, 125, 125], 0.3, [125, 124, 123, 122, 121, 120, 119], at) }, at), [{ name: 'Obiad', carbs_g: 30, protein_g: 10, fat_g: 6 }]);
      const result = await api.mealPlanBolusCard(CAREGIVER, 'p1', ENTRY, { items: [{ name: 'Obiad', carbs_g: 30, protein_g: 10, fat_g: 6 }] });
      expect(result.proposal).toMatchObject({ carbs_g: 30, insulin_u: 3.6, state: 'PROPOSED' });
      expect(inserted[0].created_at ?? early.toISOString()).toBeTruthy();
      expect(Date.parse(inserted[0].expires_at)).toBeGreaterThan(early.getTime());
    } finally {
      vi.useRealTimers();
    }
    const entry = { kind: 'MEAL' as const, status: 'PLANNED' as const, planned_at: '2026-11-10T10:30:00.000Z', lead_minutes: 20, reminder_sent_at: null, missed_sent_at: null };
    // 11:10: bolus z 11:05 mieści się w oknie (30 min przed planem) → push przed posiłkiem zamknięty bez wysyłki.
    expect(mealPlanPushDecision(entry, new Date('2026-11-10T10:10:00.000Z'), true)).toEqual({ action: 'CLOSE_REMINDER' });
    // 11:40: push „nie podano bolusa” też nie idzie.
    expect(mealPlanPushDecision({ ...entry, reminder_sent_at: '2026-11-10T10:10:00.000Z' }, new Date('2026-11-10T10:40:00.000Z'), true)).toEqual({ action: 'CLOSE_MISSED' });
  });

  // ───────────────────────────── M21 ─────────────────────────────
  it('M21: reszta „gdy przestanie spadać” — push dopiero przy płaskim trendzie, nie przy spadku', () => {
    const meal = ago(30);
    const plan = part({ kind: 'DEFERRED_INSULIN', carbs_g: 0, dose_carbs_g: 13, trigger: 'GLUCOSE_STOPPED_FALLING', due_at: ago(15), wait_until: at(165) });
    const readiness = (values: number[]) => plannedBolusReadinessFrom({ now, plan, meal_started_at: meal, readings: values.map((value, index) => ({ at: ago((values.length - 1 - index) * 5 + 1), value })), loopStatus: null });
    expect(readiness([117, 110, 102, 95])).toMatchObject({ state: 'WAIT', reason: 'FALLING' });
    expect(readiness([95, 95, 96, 96])).toMatchObject({ state: 'READY', trigger: 'GLUCOSE_STOPPED_FALLING', glucose_mgdl: 96 });
    // Poniżej 80 nawet płasko: czeka.
    expect(readiness([78, 78, 78, 78])).toMatchObject({ state: 'WAIT', reason: 'LOW' });
    // Push mówi, że warunek jest spełniony.
    expect(plannedBolusPushContent({ description: 'Obiad', carbs_g: 13, estimate_u: 1.5, low_glucose: 96 < 100 ? 96 : null, kind: 'DEFERRED_INSULIN', readiness: { state: 'READY', trigger: 'GLUCOSE_STOPPED_FALLING', glucose_mgdl: 96 } }).body)
      .toContain('Glukoza 96 przestała spadać.');
  });

  // Błąd (bez świeżej prognozy Trio, np. przerwa w danych pętli): 110 → 104 → 99 → 95 (−4…−6 na 5 min, strzałka ↘)
  // daje READY, bo średnie nachylenie −0,9 mg/dL/min mieści się w progu −1. Ostatni odczyt nadal spada, a jeden
  // „płaski” odczyt po spadku (110, 102, 96, 96) też wystarcza; mama oczekuje min. 2 płaskich/rosnących odczytów.
  it.fails('M21: wciąż spadająca glukoza 95 ↘ nie uruchamia pushu części', () => {
    const plan = part({ kind: 'DEFERRED_INSULIN', carbs_g: 0, dose_carbs_g: 13, trigger: 'GLUCOSE_STOPPED_FALLING', due_at: ago(15), wait_until: at(165) });
    const readiness = (values: number[]) => plannedBolusReadinessFrom({ now, plan, meal_started_at: ago(30), readings: values.map((value, index) => ({ at: ago((values.length - 1 - index) * 5 + 1), value })), loopStatus: null });
    expect(readiness([110, 104, 99, 95])).toMatchObject({ state: 'READY', slope_per_min: -0.9 }); // stan dzisiejszy
    expect(readiness([110, 104, 99, 95]).state).toBe('WAIT');
    expect(readiness([110, 102, 96, 96]).state).toBe('WAIT');
  });

  // Błąd: gdy glukoza nie przestaje spadać, po czasie oczekiwania (180 min, nie 2 h) push i tak przychodzi
  // („nadal spada. Sprawdź glukozę, zanim podasz.”) z kartą dawki, a część wygasa dopiero 2 h później (5 h od due).
  it.fails('M21: po 2 h bez zatrzymania spadku część wygasa i push nie proponuje insuliny', () => {
    const due = ago(0);
    const plan = part({ kind: 'DEFERRED_INSULIN', carbs_g: 0, dose_carbs_g: 13, trigger: 'GLUCOSE_STOPPED_FALLING', due_at: due, wait_until: at(180), status: 'SCHEDULED' });
    const force = plannedBolusForceAt(plan, ago(15));
    const later = new Date(Date.parse(due) + 185 * 60_000);
    const state = plannedBolusReadiness({ now: later, trigger: 'GLUCOSE_STOPPED_FALLING', due_at: due, force_at: force, glucose: { value: 90, at: ago(1, later) }, slope_per_min: -2, forecast_min_mgdl: 75 });
    expect(state).toMatchObject({ state: 'FORCED', reason: 'FALLING' }); // stan dzisiejszy
    expect(plannedBolusExpiresAtMs(plan, ago(15)) - Date.parse(due)).toBe(300 * 60_000); // stan dzisiejszy: 5 h
    expect(plannedBolusExpiresAtMs(plan, ago(15)) - Date.parse(due)).toBeLessThanOrEqual(120 * 60_000);
  });

  // ───────────────────────────── M27 ─────────────────────────────
  it('M27: karta części przy szybkim spadku liczy 0 j (spójnie z propozycją węgli), a nie dawkę z planu', () => {
    const t = new Date('2026-11-10T11:09:00.000Z');
    const falling = forecast([222, 204, 186, 168], 2.2, [168, 150, 132, 114, 96, 80, 66], t);
    const estimate = estimatePlannedBolus({ plan: part({ carbs_g: 4, dose_carbs_g: 9 }), forecast: falling, meal_started_at: '2026-11-10T10:16:12Z', now_iso: t.toISOString(), therapy, events: [], step: 0.05, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt });
    expect(estimate.dose_before_calculator_u).toBe(1.05);
    expect(estimate.insulin_u).toBeLessThan(estimate.dose_before_calculator_u!);
  });

  // Błąd/brak: push szybkich węgli 14 min po bolusie części nie wspomina niedawnego bolusa ani IOB.
  it.fails('M27: push szybkich węgli pokazuje kontekst niedawnego bolusa (np. „O 12:09 podano 1,1 j”)', () => {
    const push = buildRescuePushText({
      evaluation: { level: 'PREDICTED_LOW', glucose: { value: 168, at: '2026-11-10T11:23:00.000Z' }, delta_per_5min: -18, predicted_low_at: '2026-11-10T11:55:00.000Z' } as never,
      proposal: { carbs_g: 4, iob_u: 2.2 } as never,
      reminder: false,
      timezone: 'Europe/Warsaw',
    });
    expect(push.title).toBe('168 −18 · możliwe niedocukrzenie');
    expect(push.body).toBe('Ok. 12:55 glukoza może spaść poniżej 70. Mellis proponuje 4 g szybkich węglowodanów.'); // stan dzisiejszy
    expect(push.body).toMatch(/bolus|podano|insulin/i);
  });

  // ───────────────────────────── D2 ─────────────────────────────
  it('D2: spadek przed posiłkiem — karta z planu: najpierw 4 g szybkich węgli, 0 j teraz, dawka gdy przestanie spadać; „Cała dawka teraz · 3 j” tylko po pytaniu', async () => {
    // Port to release/1.0: this line's planned meal card is only made in its dose window, so the test runs at the meal's time.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    try {
      const falling = (at: Date) => context({ glucose: { value: 92, observed_at: ago(1, at), delta: -15 }, lowest_recent_glucose: 92, loop: { iob_units: 1, cob_grams: 0, observed_at: ago(1, at) }, meal_forecast: forecast([137, 122, 107, 92], 1, [92, 80, 70, 62, 56, 52, 50], at) }, at);
      const { api, inserted } = planApi(falling, [{ name: 'Obiad', carbs_g: 25, protein_g: 8, fat_g: 5 }]);
      const result = await api.mealPlanBolusCard(CAREGIVER, 'p1', ENTRY, { items: [{ name: 'Obiad', carbs_g: 25, protein_g: 8, fat_g: 5 }] });
      const card = inserted[0];
      expect(card).toMatchObject({ carbs_g: 25, insulin_u: 0 });
      expect(card.card_advice.fast_carbs_first).toMatchObject({ level: 'PREDICTED_LOW', glucose_mgdl: 92 });
      expect(card.card_advice.fast_carbs_first.carbs_g).toBeGreaterThan(0);
      expect(card.split).toMatchObject({ kind: 'DEFERRED_INSULIN', trigger: 'GLUCOSE_STOPPED_FALLING', later_insulin_u: 3, wait_minutes: 180 });
      expect(result.proposal).toMatchObject({ insulin_u: 0 });
      const variants = card.card_advice.variants.map((variant: any) => [variant.kind, variant.label, variant.needs_ack]);
      expect(variants).toEqual([['HALF_NOW', 'Połowa dawki teraz · 1,5 j', true], ['FULL_BOLUS_NOW', 'Cała dawka teraz · 3 j', true]]);
      const full = card.card_advice.variants.find((variant: any) => variant.kind === 'FULL_BOLUS_NOW');
      expect(full.risk.min_mgdl).toBeLessThan(70);
      expect(full.ack_text).toMatch(/przewiduje spadek do ok\. \d+/);
    } finally {
      vi.useRealTimers();
    }
  });

  // ───────────────────────────── D8 ─────────────────────────────
  it('D8: pizza 45 g / 25 g tłuszczu / 20 g białka — 60% teraz (3,25 j), reszta 18 g ≈ 2,15 j za 90 min, razem 5,4 j; plan idzie z poleceniem i push o czasie', async () => {
    const flat = context({ glucose: { value: 120, observed_at: ago(1), delta: 0 }, loop: { iob_units: 0, cob_grams: 0, observed_at: ago(1) }, meal_forecast: forecast([120, 120, 120, 120], 0, [120, 120, 120, 120, 120, 120, 120]) });
    const { instance, stored } = chatSession(flat);
    const pizza = mealArgs(45, [{ name: 'Pizza 2 kawałki', carbs_g: 45, protein_g: 20, fat_g: 25 }], { meal_description: 'Pizza', use_advised_split: 'ADVISED' });
    const result: any = await instance.propose(pizza);
    expect(result).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 27, insulin_u: 3.25, later: [{ kind: 'SPLIT', carbs_g: 18, insulin_u_estimate: 2.15, after_minutes: 90 }], whole_plan: { carbs_g: 45, insulin_u_estimate: 5.4 } }, split_advice: { advised: true, now_percent: 60, after_minutes: 90 } });
    const variants = stored[0].card_advice!.variants!.map((variant) => [variant.kind, variant.label]);
    expect(variants).toEqual([['ALL_NOW', 'Bez podziału · 5,4 j']]);
    // Polecenie z karty niesie plan (z niego powstaje planned_boluses przy zapisie posiłku).
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, async () => flat, { get: async () => ({ conversation_id: 'c1', status: 'PROPOSED', expires_at: at(15), carbs_g: 27, insulin_u: 3.25, split: stored[0].split, warnings: [], purpose: 'MEAL', meal_payload: { description: 'Pizza', items: null, macros: null } }) } as never);
    const preview = await service.preview('p1', { carbs_g: 27, insulin_u: 3.25, bolus_step: 0.05, proposal_id: PLAN_CARD }, now);
    await service.authorize('p1', 'u1', commandRequest({ source: 'CHAT_CARD', proposal_id: PLAN_CARD, conversation_id: 'c1', carbs_g: 27, insulin_u: 3.25, acknowledged_warnings: preview.warnings.map((warning) => warning.key) }), now);
    expect(store.rows[0].split_plan).toMatchObject({ later_carbs_g: 18, later_after_minutes: 90, trigger: 'AFTER_MINUTES' });
    // Druga część: due = start posiłku + 90 min, push w tym momencie.
    const due = plannedBolusDueAt(now.toISOString(), 90);
    expect(due).toBe(at(90));
    expect(plannedBolusReadiness({ now: new Date(due), trigger: 'AFTER_MINUTES', due_at: due, force_at: null, glucose: null, slope_per_min: null, forecast_min_mgdl: null })).toMatchObject({ state: 'READY' });
    expect(plannedBolusReadiness({ now: new Date(Date.parse(due) - 60_000), trigger: 'AFTER_MINUTES', due_at: due, force_at: null, glucose: null, slope_per_min: null, forecast_min_mgdl: null })).toMatchObject({ state: 'WAIT', reason: 'TOO_EARLY' });
    expect(plannedBolusPushContent({ description: 'Pizza', carbs_g: 18, estimate_u: 2.15, low_glucose: null }).title).toBe('Druga część bolusa · 18 g');
  });

  // ───────────────────────────── D14 ─────────────────────────────
  describe('D14: powtórka 10.11 (11 g, ICR 8,3, glukoza 124 →, IOB 1,1 j, karta 0,3 j, podano ręcznie 0,7 j)', () => {
    const t1116 = new Date('2026-11-10T10:16:00.000Z');
    const ctx1116 = context({ glucose: { value: 124, observed_at: ago(1, t1116), delta: 0 }, lowest_recent_glucose: 124, loop: { iob_units: 1.1, cob_grams: 0, observed_at: ago(1, t1116) }, meal_forecast: forecast([124, 125, 124, 124], 1.1, [124, 110, 95, 80, 65, 50, 39], t1116) }, t1116);

    async function sendFromCard() {
      const store = new MemoryStore();
      const service = new RemoteCommandsService(store, async () => ctx1116, planCardStore({ carbs_g: 11, insulin_u: 0.3, description: 'Zupa i podwieczorek' }, at(15, t1116)) as never);
      const preview = await service.preview('p1', { carbs_g: 11, insulin_u: 0.7, bolus_step: 0.05, proposal_id: PLAN_CARD }, t1116);
      await service.authorize('p1', 'ola', commandRequest({ source: 'CHAT_CARD', proposal_id: PLAN_CARD, conversation_id: null, carbs_g: 11, insulin_u: 0.7, acknowledged_warnings: preview.warnings.map((warning) => warning.key), low_glucose_confirmed: true }), t1116);
      await service.reportSent('p1', 'ola', store.rows[0].id, { accepted: true }, t1116);
      await service.reportReply('p1', 'ola', store.rows[0].id, { success: true, message: 'Bolus started' }, t1116);
      return store.rows[0];
    }
    const shortfallFor = (command: RemoteCommandRecord) => async (_p: string, _m: string, carbs: number) =>
      mealDoseShortfall({ actions: [{ purpose: 'NEW_MEAL', carbs_g: 11, bolus_units: 0.7 }], meal_carbs_g: carbs, icr_g_per_u: ICR, step: 0.05, held_back_u: calculatorHeldBackU([command]) });


    function chatDeps(command: RemoteCommandRecord, messages: MealChatMessage[], reply: string) {
      const inserted: Array<{ content: string; proposal: unknown }> = [];
      const deps: MealChatReplyDeps = {
        findMealIdentityById: vi.fn(async () => 'meal:identity'),
        getMealRecord: vi.fn(async () => ({ status: 'CONFIRMED', started_at: '2026-11-10T10:16:12Z', source_carbs_g: 11, description: 'Zupa i podwieczorek', macros: { carbs: { grams: 11 }, protein: { grams: 2 }, fat: { grams: 2 } } } as never)),
        recordAiProposal: vi.fn(async () => 'proposal-1'),
        listMessages: vi.fn(async () => messages),
        hasReply: vi.fn(async () => false),
        insertAssistantMessage: vi.fn(async (args) => { inserted.push(args as never); }),
        readPhoto: vi.fn(async () => null),
        responder: { providerName: 'stub', respond: vi.fn(async () => ({ reply, question: null, proposal: { carbs_g: 11, protein_g: 2, fat_g: 2, items: [] } as never, short_name: null })) },
        shortfallFor: shortfallFor(command),
      };
      return { deps, inserted };
    }
    const msg = (id: string, role: 'USER' | 'ASSISTANT', content: string): MealChatMessage => ({ id, role, content, photo_ids: [], proposal: null, question: null, author_display_name: null, reply_to_message_id: null, created_at: '2026-11-10T10:53:00.000Z' } as MealChatMessage);
    const modelReply = 'Nie liczę dawek insuliny, bo nie widzę glukozy ani insuliny aktywnej. Całe 11 g jest już w pętli. Jeśli było jeszcze coś do jedzenia, napisz co.';

    it('D14: czat posiłku na „dajmy mu kolejną dawkę” i „Ok zatwierdzam” — bez „brakuje”, bez drugiej części, bez powtórzeń', async () => {
      const command = await sendFromCard();
      const first = chatDeps(command, [msg('u1', 'USER', 'Dajmy mu kolejną dawkę')], modelReply);
      await runMealChatReplyJob(first.deps, { patient_id: 'p1', meal_record_id: 'm1', user_message_id: 'u1' });
      const second = chatDeps(command, [msg('u1', 'USER', 'Dajmy mu kolejną dawkę'), msg('a1', 'ASSISTANT', first.inserted[0].content), msg('u2', 'USER', 'Ok zatwierdzam')], modelReply);
      await runMealChatReplyJob(second.deps, { patient_id: 'p1', meal_record_id: 'm1', user_message_id: 'u2' });
      for (const reply of [first.inserted[0], second.inserted[0]]) {
        expect(reply.content).not.toMatch(/brakuje/i);
        expect(reply.content).not.toMatch(/drugą część bolusa/);
        expect((reply.proposal as { rest?: unknown }).rest).toBeUndefined();
      }
      const lines = [first.inserted[0].content, second.inserted[0].content].join('\n').split(/\n+/);
      expect(lines.filter((line) => /Po zatwierdzeniu Mellis zapisze/.test(line))).toHaveLength(0);
    });

    // Brak: czat nie mówi „Podano 0,7 j do 11 g. Pełna dawka ok. 1,3 j. Mniej podano celowo…” i nie ma przycisku
    // „Przelicz dawkę” (synteza przeglądu, UX 1). Odpowiedź to tylko tekst modelu.
    it.fails('D14: czat mówi, ile podano i jaka jest pełna dawka, i oddaje sprawę przyciskowi „Przelicz dawkę”', async () => {
      const command = await sendFromCard();
      const chat = chatDeps(command, [msg('u1', 'USER', 'Dajmy mu kolejną dawkę')], modelReply);
      await runMealChatReplyJob(chat.deps, { patient_id: 'p1', meal_record_id: 'm1', user_message_id: 'u1' });
      expect(chat.inserted[0].content).toBe(modelReply); // stan dzisiejszy
      expect(chat.inserted[0].content).toMatch(/Podano 0,7 j do 11 g\. Pełna dawka (z przelicznika to )?ok\. 1,3 j\. Mniej podano celowo/);
      expect(JSON.stringify(chat.inserted[0])).toContain('Przelicz dawkę');
    });
  });

  // ───────────────────────────── D20 ─────────────────────────────
  it('D20: opóźniony bolus — zakładka Bolus nie przyjmuje „zjedzone 40 min temu”; dawka 30 g przy 220 ↗ nie jest obniżana za trend', async () => {
    const high = context({ glucose: { value: 220, observed_at: ago(1), delta: 15 }, lowest_recent_glucose: 175, loop: { iob_units: 0.9, cob_grams: 0, observed_at: ago(1) }, meal_forecast: forecast([175, 190, 205, 220], 0.9, [220, 235, 250, 260, 265, 268, 270]) });
    const service = new RemoteCommandsService(new MemoryStore(), async () => high);
    // Brak godziny posiłku w przeszłości: meal_in_minutes tylko 1–30 (w przód).
    await expect(service.authorize('p1', 'u1', commandRequest({ carbs_g: 30, insulin_u: 2.7, meal_in_minutes: -40 }), now)).rejects.toBeInstanceOf(ValidationError);
    const preview = await service.preview('p1', { carbs_g: 30, insulin_u: null, bolus_step: 0.05, dose_default: 'CALCULATOR' }, now);
    // Kalkulator tylko obniża: przy 220 ↗ korekta przewyższa IOB, więc zostaje 30 g / 8,3 = 3,6 j (nie 3,6 − SMB 0,9 = 2,7 j).
    expect(preview.insulin_u).toBe(3.6);
    expect(preview.dose_calculation?.limited_by).toBe('ICR');
  });

  // ───────────────────────────── D26 ─────────────────────────────
  describe('D26: push drugiej części zgodny z kartą (10.11: reszta 4 g, od 11:16 podano 0,6 j z 5 g i 0,6 j bez węgli)', () => {
    const mealStart = '2026-11-10T10:16:12Z';
    const t1209 = new Date('2026-11-10T11:09:00Z');
    const actions = [
      { id: 'own', started_at: '2026-11-10T10:16:24Z', bolus_units: 0.7, carbs_g: 11, meal_record_id: 'm1' },
      { id: 'a', started_at: '2026-11-10T10:54:43Z', bolus_units: 0.6, carbs_g: 5, meal_record_id: null },
      { id: 'b', started_at: '2026-11-10T10:55:26Z', bolus_units: 0.6, carbs_g: null, meal_record_id: null },
    ];
    const plan = part({ carbs_g: 4, dose_carbs_g: 9, first_carbs_g: 11, first_insulin_u: 0.7, planned_insulin_u: 1.1, due_at: t1209.toISOString() });

    /** As the worker composes the push (worker.service.ts processPlannedBoluses: title from carbs_g > 0, line from every bolus since the meal). */
    function pushNow() {
      const since = bolusesSinceMealForPart({ actions, used: new Set(['own']), meal_record_id: 'm1', meal_started_at: mealStart, now: t1209 });
      const given = givenSinceMeal({ mealStartedAt: mealStart, now: t1209, timeZone: 'Europe/Warsaw', actions: since, senders: new Map([['a', 'Ewa']]), loopName: 'Trio', caregiverCount: 2 });
      const deduction = partDeductionU(since, plan.icr_g_per_u);
      const card = estimatePlannedBolus({ plan, meal_started_at: mealStart, now_iso: t1209.toISOString(), therapy, events: [], step: 0.05, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt, manual_insulin_u: deduction > 0 ? deduction : null });
      const push = plannedBolusPushContent({ description: 'Zupa i podwieczorek', carbs_g: plan.carbs_g > 0 ? plan.carbs_g : plannedDoseCarbs(plan), estimate_u: card.insulin_u, low_glucose: null, kind: plan.kind, given_line: given.line });
      return { given, card, push };
    }

    it('D26: tytuł 4 g (nie 9 g), „Od 11:16 podano już 1,2 j” z bolusem z węglami', () => {
      const { given, push, card } = pushNow();
      expect(push.title).toBe('⚠️ Druga część bolusa · 4 g');
      expect(given.total_u).toBe(1.2);
      expect(push.body).toContain('Od 11:16 podano już 1,2 j (11:54 0,6 j Ewa, 11:55 0,6 j Trio).');
      // Karta: 9 g / 8,3 = 1,05 j minus to, co dano ponad własne węgle (0,6 j bez węgli) = 0,45 j.
      expect(card).toMatchObject({ dose_carbs_g: 9, insulin_for_carbs_u: 1.05, manual_insulin_subtracted_u: 0.6, insulin_u: 0.45 });
    });

    // Naprawione 2026-11-10: push mówi, ile karta odejmie (0,6 j), i jest to dokładnie to, co odejmuje karta.
    it('D26: to, co push każe odjąć, równa się temu, co odejmuje karta', () => {
      const { card } = pushNow();
      const since = bolusesSinceMealForPart({ actions, used: new Set(['own']), meal_record_id: 'm1', meal_started_at: mealStart, now: t1209 });
      const given = givenSinceMeal({ mealStartedAt: mealStart, now: t1209, timeZone: 'Europe/Warsaw', actions: since, senders: new Map([['a', 'Ewa']]), loopName: 'Trio', caregiverCount: 2 });
      const push = plannedBolusPushContent({ description: 'Zupa i podwieczorek', carbs_g: 4, estimate_u: card.insulin_u, low_glucose: null, kind: plan.kind, given_line: given.line, deducted_u: partDeductionU(since, plan.icr_g_per_u) });
      expect(push.body).toContain('Karta odejmie od dawki 0,6 j');
      expect(card.manual_insulin_subtracted_u).toBe(0.6);
    });

    // Naprawione 2026-11-10: polecenie z Mellis, którego jeszcze nie ma w Nightscout (UNCERTAIN), liczy się jak bolus.
    it('D26: niepewny bolus z Mellis (jeszcze nie w Nightscout) jest wliczony do „podano już”', () => {
      const pending = pendingRemoteDosesAsActions([{ id: 'cmd-uncertain', status: 'UNCERTAIN', insulin_u: 0.6, carbs_g: 0, authorized_at: '2026-11-10T10:55:26Z' }]);
      const since = bolusesSinceMealForPart({ actions: [...actions.slice(0, 2), ...pending], used: new Set(['own']), meal_record_id: 'm1', meal_started_at: mealStart, now: t1209 });
      expect(since.reduce((sum, action) => sum + (action.bolus_units ?? 0), 0)).toBeCloseTo(1.2, 5);
      expect(partDeductionU(since, plan.icr_g_per_u)).toBeCloseTo(0.6, 2);
    });
  });
});

function roundTo(value: number): number {
  return Math.floor(value * 20) / 20;
}
