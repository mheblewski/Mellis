import { describe, expect, it, vi } from 'vitest';
import { GLUCOSE_FORECAST_CALIBRATION } from '@modules/glucose-forecast/application/forecast-calibration';
import { ApiService } from '../../../apps/api/src/application/api.service';
import { BolusProposalSession, PROPOSE_BOLUS_TOOL_DEFINITION, restLaterArgs, toBolusProposalView, type NewBolusProposal } from '../application/bolus-proposal-tool';
import { calculatorHeldBackU, mealDoseShortfall } from '../application/split-bolus';
import type { MealForecastData } from '../application/meal-dose-forecast';
import { RemoteCommandsService, type RemoteCommandRequest } from '../application/remote-commands.service';
import type { NewRemoteCommand, RemoteCommandRecord, RemoteCommandStore } from '../application/remote-command-record';
import { canTransitionRemoteCommand, IN_FLIGHT_STATUSES, type RemoteCommandStatus } from '../application/remote-command-status';
import { ConflictError, ValidationError } from '@shared/errors/app-error';

class MemoryStore implements RemoteCommandStore {
  rows: RemoteCommandRecord[] = [];
  syncRequests: Array<{ commandId: string; at: string[] }> = [];
  async requestNightscoutSync(_patientId: string, commandId: string, at: string[]) { this.syncRequests.push({ commandId, at }); }
  async insert(command: NewRemoteCommand): Promise<RemoteCommandRecord> {
    if (this.rows.some((row) => row.patient_id === command.patient_id && IN_FLIGHT_STATUSES.has(row.status))) throw new ConflictError('COMMAND_IN_FLIGHT');
    const record: RemoteCommandRecord = { ...command, id: `00000000-0000-4000-8000-00000000000${this.rows.length + 1}`, status: 'AUTHORIZED', trio_message: null, status_message: null, authorized_at: new Date(Date.parse(command.send_deadline) - 120_000).toISOString(), sent_at: null, answered_at: null, loop_action_id: null, meal_record_id: null, matched_at: null };
    this.rows.push(record);
    return record;
  }
  async get(patientId: string, id: string) { return this.rows.find((row) => row.patient_id === patientId && row.id === id) ?? null; }
  async list(patientId: string) { return this.rows.filter((row) => row.patient_id === patientId); }
  async findInFlight(patientId: string) { return this.rows.find((row) => row.patient_id === patientId && IN_FLIGHT_STATUSES.has(row.status)) ?? null; }
  async recordSentAt(patientId: string, id: string, at: string) { const row = await this.get(patientId, id); if (row && !row.sent_at) row.sent_at = at; }
  async listForProposal(patientId: string, proposalId: string) { return this.rows.filter((row) => row.patient_id === patientId && row.proposal_id === proposalId); }
  async listForPlannedBolus(patientId: string, planId: string) { return this.rows.filter((row) => row.patient_id === patientId && row.planned_bolus_id === planId); }
  async listWbtForMeal(patientId: string, mealId: string) { return this.rows.filter((row) => row.patient_id === patientId && row.purpose === 'WBT' && row.target_meal_record_id === mealId); }
  async findRecentWithInsulin(patientId: string, since: string) {
    return this.rows.filter((row) => row.patient_id === patientId && row.insulin_u > 0 && ['SENT', 'TRIO_ACCEPTED', 'SUCCEEDED', 'NO_REPLY', 'UNCERTAIN'].includes(row.status) && (row.sent_at ?? row.authorized_at) >= since).at(-1) ?? null;
  }
  async transition(patientId: string, id: string, to: RemoteCommandStatus, fields: Record<string, unknown>) {
    const row = await this.get(patientId, id);
    if (!row || !canTransitionRemoteCommand(row.status, to)) return null;
    Object.assign(row, { status: to }, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
    return row;
  }
  async recordLateReply(patientId: string, id: string, fields: { trio_message: string; status_message: string; answered_at: string }) {
    const row = await this.get(patientId, id);
    if (!row || row.status !== 'SUCCEEDED' || row.trio_message !== null) return null;
    Object.assign(row, fields);
    return row;
  }
}
async function send(service: RemoteCommandsService, req: RemoteCommandRequest, at: Date) {
  const p = await service.preview('p1', { carbs_g: req.carbs_g, insulin_u: req.insulin_u, bolus_step: req.bolus_step, proposal_id: req.proposal_id ?? null, ...(req.meal_in_minutes ? { meal_in_minutes: req.meal_in_minutes } : {}) }, at);
  return service.authorize('p1', 'u1', { ...req, acknowledged_warnings: p.warnings.map((w) => w.key), low_glucose_confirmed: true } as RemoteCommandRequest, at);
}
const bolusTab = (overrides: Partial<RemoteCommandRequest> = {}): RemoteCommandRequest => ({ source: 'BOLUS_SCREEN', carbs_g: 30, insulin_u: 3.6, bolus_step: 0.05, device_id: 'mama-iphone', meal: null, acknowledged_warnings: [], ...overrides });


const now = new Date('2026-11-10T11:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const noCalibration = { ...GLUCOSE_FORECAST_CALIBRATION, version: 'test-none', shrink_by_minutes: { 5: 1 } };

function forecast(o: { glucose: number; per5?: number; iob?: number; cob?: number; isf?: number; target?: number; curve?: number[]; carbsReq?: number | null }): MealForecastData {
  const per5 = o.per5 ?? 0;
  return {
    readings: [3, 2, 1, 0].map((back) => ({ at: minutesAgo(1 + back * 5), value: o.glucose - per5 * back })),
    prediction: {
      source: 'OPENAPS', system: 'TRIO', computed_at: minutesAgo(1), bg: o.glucose, carbs_req_g: o.carbsReq ?? null, insulin_req_u: null,
      iob_u: o.iob ?? 0, cob_g: o.cob ?? 0, isf_mgdl_per_u: o.isf ?? 250, icr_g_per_u: 8.3, eventual_bg: (o.curve ?? [o.glucose]).at(-1)!, target_mgdl: o.target ?? 110,
      curves: { IOB: o.curve ?? Array(7).fill(o.glucose) },
    },
    profile_isf: o.isf ?? 250, profile_target: o.target ?? 110, profile_target_high: null, profile_units: 'mg/dl', calibration: noCalibration,
  } as MealForecastData;
}

function ctx(f: MealForecastData, extra: Record<string, unknown> = {}) {
  const last = f.readings.at(-1)!;
  const prev = f.readings.at(-2)!;
  return {
    now: now.toISOString(),
    glucose: { value: last.value, observed_at: last.at, delta: last.value - prev.value },
    lowest_recent_glucose: Math.min(...f.readings.map((r) => r.value)),
    loop: { iob_units: f.prediction!.iob_u, cob_grams: f.prediction!.cob_g, observed_at: minutesAgo(1) },
    last_bolus: null,
    icr_g_per_u: 8.3,
    bolus_history_known: true,
    recent_insulin: null,
    meal_forecast: f,
    ...extra,
  } as any;
}

function cardSession(c: any, opts: { doseBasis?: 'ICR' | 'CALCULATOR'; phoneLimits?: { max_bolus_u: number; max_carbs_g: number } } = {}) {
  const stored: NewBolusProposal[] = [];
  const instance = new BolusProposalSession({
    patientId: 'p1', conversationId: 'c1', userMessageId: 'm1', doseRequested: true, now: () => now,
    ...(opts.doseBasis ? { doseBasis: opts.doseBasis } : {}), ...(opts.phoneLimits ? { phoneLimits: opts.phoneLimits } : {}),
    context: async () => c,
    store: { insert: async (p) => { stored.push(p); return { ...p, id: `b${stored.length}`, status: 'PROPOSED', created_at: now.toISOString() }; } },
  });
  return { instance, stored };
}

const meal = (carbs: number, name: string, extra: Record<string, unknown> = {}) => ({
  purpose: 'MEAL', carbs_g: carbs, insulin_u: null, reduce_for_drop: false, add_correction: false, eating_now: false,
  meal_description: name, items: null, use_advised_split: 'NO', option: null, reason: 'x', later: null, ...extra,
});


const brief = (r: any, stored: NewBolusProposal[]) => JSON.stringify({ card: { ...r.card, forecast_chart: undefined }, dose: r.dose_calculation, advice: r.advice, phone: r.phone_limit, variants: stored.at(-1)?.card_advice?.variants?.map((v) => ({ kind: v.kind, label: v.label, now: v.insulin_now_u, later: v.later, ack: v.needs_ack, t: v.ack_text })), rest: stored.at(-1)?.card_advice?.rest_offer, warnings: stored.at(-1)?.warnings }, null, 1);
 (from: number, to: number, steps: number) => Array.from({ length: steps + 1 }, (_, i) => Math.round(from + (to - from) * i / steps));
const curve = (from: number, to: number, steps: number) => Array.from({ length: steps + 1 }, (_, i) => Math.round(from + (to - from) * i / steps));
const STATE_LABELS = /WYSOKO|NISKO|hiperglikemi|hipoglikemi|chory|choroba/i;

// The planned meal's card (card A without the model): ApiService with repositories stubbed, as
// apps/api/src/application/api.service.meal-plan-bolus-card.spec.ts does.
const PATIENT = '11111111-1111-4111-8111-111111111111';
const ENTRY = '22222222-2222-4222-8222-222222222222';
const MAMA = { user_id: '33333333-3333-4333-8333-333333333333' } as any;
function planned(f: MealForecastData, options: { title?: string; items: Array<{ name: string; carbs_g: number; protein_g: number; fat_g: number }>; doseBasis?: 'ICR' | 'CALCULATOR'; extra?: Record<string, unknown> }) {
  const api = new ApiService({} as any, {} as any) as any;
  const inserted: any[] = [];
  let next = 0;
  api.assertCanSendRemoteCommands = vi.fn(async () => undefined);
  api.assertCanWritePatient = vi.fn(async () => undefined);
  api.userDoseBasis = vi.fn(async () => options.doseBasis ?? 'CALCULATOR');
  const entry = { id: ENTRY, kind: 'MEAL', status: 'PLANNED', planned_at: now.toISOString(), title: options.title ?? 'Zupa i podwieczorek', items: options.items, dose_answer: null, given_meal_id: null };
  api.mealPlans = { getEntry: vi.fn(async () => entry), replaceItems: vi.fn(async (_p: string, _e: string, items: unknown) => ({ ...entry, items })) };
  api.plannedBoluses = { summariesForProposals: vi.fn(async () => new Map()) };
  api.bolusProposals = {
    listForMealPlanEntry: vi.fn(async () => []),
    discardUnsentForMealPlanEntry: vi.fn(async () => undefined),
    insert: vi.fn(async (proposal: any) => { const record = { ...proposal, id: `55555555-5555-4555-8555-55555555555${++next}`, status: 'PROPOSED', created_at: new Date().toISOString() }; inserted.push(record); return record; }),
    discard: vi.fn(async () => undefined),
  };
  api.remoteCommandContext = vi.fn(async () => ({ ...ctx(f, options.extra), forecast_inputs: {} }));
  return { api: api as ApiService, raw: api, inserted };
}
async function atNow<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  try { return await run(); } finally { vi.useRealTimers(); }
}

describe('grupa 5: scenariusze mamy i diabetologa (dawka do posiłku)', () => {
  it('M5: glukoza 85 ↓ (−3/min), IOB 0,8 j, podwieczorek 15 g z planu: najpierw szybkie węgle, 0 j, bolus gdy przestanie spadać, cała dawka tylko z pytaniem', async () => {
    const f = forecast({ glucose: 85, per5: -15, iob: 0.8, curve: [85, 72, 62, 54, 48, 44, 42], carbsReq: 10 });
    const { api, inserted } = planned(f, { title: 'Podwieczorek', items: [{ name: 'Jogurt z bananem', carbs_g: 15, protein_g: 3, fat_g: 3 }] });
    const result = await atNow(() => api.mealPlanBolusCard(MAMA, PATIENT, ENTRY, { items: [{ name: 'Jogurt z bananem', carbs_g: 15, protein_g: 3, fat_g: 3 }] }));
    const card = inserted[0];
    // One action now: the meal's carbs with 0 j, fast carbs advised on the card, the meal's dose when the drop stops.
    expect(card).toMatchObject({ carbs_g: 15, insulin_u: 0, split: { kind: 'DEFERRED_INSULIN', trigger: 'GLUCOSE_STOPPED_FALLING' } });
    expect(card.card_advice.fast_carbs_first).toMatchObject({ carbs_g: 4, level: 'PREDICTED_LOW' });
    expect(card.card_advice.fast_carbs_first.message).toMatch(/najpierw 4 g szybkich węglowodanów/);
    expect(card.card_advice.dose_calculation).toMatchObject({ default_u: 0, limited_by: 'CARBS_FIRST' });
    expect(result.proposal).toMatchObject({ insulin_u: 0, fast_carbs_first: { carbs_g: 4 } });
    // The whole dose is a button, never one tap: it asks first and names the forecast (42, below 54).
    const full = card.card_advice.variants.find((v: any) => v.kind === 'FULL_BOLUS_NOW');
    expect(full).toMatchObject({ insulin_now_u: 1.8, needs_ack: true });
    expect(full.ack_text).toMatch(/spadek do ok\. 42/);
    expect(card.card_advice.variants.every((v: any) => v.insulin_now_u === 0 || v.needs_ack)).toBe(true);
  });

  it('M11: zapomniany bolus po obiedzie 30 g zjedzonym 40 min temu, 210 ↗, IOB 0,9 j: dawka bez dzielenia, nie za dużo', async () => {
    const f = forecast({ glucose: 210, per5: 8, iob: 0.9, curve: curve(210, 190, 12) });
    // Chat card, calculator: 30 / 8,3 = 3,6 j lowered for the SMB already given (IOB 0,9), never above 3,6 j.
    const calc = cardSession(ctx(f), { doseBasis: 'CALCULATOR' });
    await calc.instance.propose(meal(30, 'Obiad', { eating_now: true }));
    expect(calc.stored[0].insulin_u).toBeLessThanOrEqual(3.6);
    expect(calc.stored[0].insulin_u).toBeGreaterThanOrEqual(3.6 - 0.9);
    expect(calc.stored[0].split).toBeNull();
    const icr = cardSession(ctx(f), { doseBasis: 'ICR' });
    await icr.instance.propose(meal(30, 'Obiad', { eating_now: true }));
    expect(icr.stored[0]).toMatchObject({ insulin_u: 3.6, split: null });
  });

  it('M11: godziny posiłku nie da się cofnąć (11:40): ani zakładka Bolus, ani karta czatu nie przyjmują czasu w przeszłości', async () => {
    const f = forecast({ glucose: 210, per5: 8, iob: 0.9, curve: curve(210, 190, 12) });
    const service = new RemoteCommandsService(new MemoryStore(), async () => ctx(f));
    // meal_in_minutes dates the carbs only ahead (1–30 min); 40 min back is refused.
    await expect(service.authorize('p1', 'u1', bolusTab({ carbs_g: 30, insulin_u: 3.6, meal_in_minutes: -40 }), now)).rejects.toBeInstanceOf(ValidationError);
    // propose_bolus has no field for when the meal was eaten (only eating_now): the carbs are dated now in Trio.
    const props = Object.keys((PROPOSE_BOLUS_TOOL_DEFINITION.input_schema as any).properties);
    expect(props.some((name) => /eaten|meal_at|started|minutes_ago|time/.test(name))).toBe(false);
  });

  it('M17: karta z planu 21 g, potem 11 g; IOB 1,1 j, 124 →, prognoza Trio bez karty 39: jedno ostrzeżenie, po podaniu czat nie mówi „brakuje”', async () => {
    const f = forecast({ glucose: 124, per5: 0, iob: 1.1, curve: curve(124, 39, 20) });
    const s = cardSession(ctx(f), { doseBasis: 'CALCULATOR' });
    await s.instance.propose(meal(21, 'Zupa i podwieczorek'));
    await s.instance.propose(meal(11, 'Zupa i podwieczorek'));
    const card = s.stored[1];
    expect(card).toMatchObject({ carbs_g: 11, icr_insulin_u: 1.3 });
    // Exactly one forecast line on the card.
    expect(card.warnings.filter((w) => w.code === 'FORECAST_LOW')).toHaveLength(1);
    // The dose by ICR is one button away.
    expect(card.card_advice!.variants!.find((v) => v.kind === 'ICR_DOSE' || v.kind === 'FULL_BOLUS_NOW')).toMatchObject({ insulin_now_u: 1.3 });
    // Sent with the card's own dose: what the calculator held back is no "brakuje" in the meal chat.
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, async () => ctx(f));
    await send(service, bolusTab({ carbs_g: 11, insulin_u: card.insulin_u }), now);
    const held = calculatorHeldBackU(store.rows.map((row) => ({ ...row, status: 'SUCCEEDED' })));
    expect(held).toBeGreaterThan(0);
    expect(mealDoseShortfall({ actions: [{ purpose: 'NEW_MEAL', carbs_g: 11, bolus_units: card.insulin_u }], meal_carbs_g: 11, icr_g_per_u: 8.3, held_back_u: held })).toBeNull();
  });

  // BŁĄD: iob_floor (dose-calculator.v4) nie działa, gdy Trio prognozuje spadek (warunek !drop), a właśnie tak było 10.11 (prognoza 39):
  // karta 11 g daje 0,25 j zamiast co najmniej połowy 1,3 j = 0,65 j.
  it('M17: kalkulator przy samym IOB nie schodzi poniżej połowy z przelicznika (0,65 j) także przy prognozie Trio 39', async () => {
    const f = forecast({ glucose: 124, per5: 0, iob: 1.1, curve: curve(124, 39, 20) });
    const s = cardSession(ctx(f), { doseBasis: 'CALCULATOR' });
    await s.instance.propose(meal(11, 'Zupa i podwieczorek'));
    expect(s.stored[0].insulin_u).toBeGreaterThanOrEqual(0.65);
  });

  // BŁĄD: przy prognozie Trio 39 przycisk z całą dawką (1,3 j) nie pyta (needs_ack false): prognoza „bez jedzenia” nie liczy się jako ryzyko wariantu.
  it('M17: przycisk z całą dawką przy prognozie 39 pyta przed podmianą karty', async () => {
    const f = forecast({ glucose: 124, per5: 0, iob: 1.1, curve: curve(124, 39, 20) });
    const s = cardSession(ctx(f), { doseBasis: 'CALCULATOR' });
    await s.instance.propose(meal(11, 'Zupa i podwieczorek'));
    const full = s.stored[0].card_advice!.variants!.find((v) => v.kind === 'ICR_DOSE' || v.kind === 'FULL_BOLUS_NOW')!;
    expect(full.needs_ack).toBe(true);
  });

  it('M23: choroba, 210 ↗, obiad z planu 30 g, zje ok. 10 g: mała dawka teraz, „doszło X g” potem, bez etykiet stanu', async () => {
    const f = forecast({ glucose: 210, per5: 6, iob: 0.4, curve: curve(210, 200, 12) });
    const { api, inserted } = planned(f, { title: 'Obiad', items: [{ name: 'Zupa pomidorowa z makaronem', carbs_g: 30, protein_g: 5, fat_g: 4 }] });
    // The phone sends the portion set on the plate (a third), not the whole plan.
    await atNow(() => api.mealPlanBolusCard(MAMA, PATIENT, ENTRY, { items: [{ name: 'Zupa pomidorowa z makaronem', carbs_g: 10, protein_g: 2, fat_g: 1 }] }));
    expect(inserted[0]).toMatchObject({ carbs_g: 10 });
    expect(inserted[0].insulin_u).toBeLessThanOrEqual(1.2);
    expect(inserted[0].insulin_u).toBeGreaterThan(0);
    expect(inserted[0].warnings.map((w: any) => w.message).join(' ')).not.toMatch(STATE_LABELS);
    // He ate 15 g more: the meal chat says it in grams and plans the rest.
    const short = mealDoseShortfall({ actions: [{ purpose: 'NEW_MEAL', carbs_g: 10, bolus_units: inserted[0].insulin_u }], meal_carbs_g: 25, icr_g_per_u: 8.3 });
    expect(short).toMatchObject({ carbs_g: 15 });
  });

  it('M29: Trio zapisało 20 g, odrzuciło 2,4 j: czerwone tylko przy pewnej odmowie, „Podaj sam bolus” bez węgli, węgle nigdy drugi raz', async () => {
    const f = forecast({ glucose: 140, per5: 0, iob: 0.3, curve: Array(13).fill(140) });
    const store = new MemoryStore();
    let c = ctx(f);
    const service = new RemoteCommandsService(store, async () => c);
    const first = await send(service, bolusTab({ carbs_g: 20, insulin_u: 2.4 }), now);
    await service.reportSent('p1', 'u1', first.id, { accepted: true }, now);
    const partial = await service.reportReply('p1', 'u1', first.id, { success: false, message: 'Command rejected: bolus amount (2.4 units) exceeds the maximum allowed (2 units).' }, now);
    expect(partial).toMatchObject({ status: 'PARTIAL', status_message: expect.stringMatching(/^Węglowodany zapisane w Trio, bolus odrzucony/) });
    const later = new Date(now.getTime() + 10 * 60_000);
    c = ctx(forecast({ glucose: 150, per5: 2, iob: 0.3, cob: 18, curve: Array(13).fill(150) }));
    // The carbs again: refused; the bolus alone: goes, and joins the meal the carbs made.
    await expect(service.authorize('p1', 'u1', bolusTab({ carbs_g: 20, insulin_u: 2, follows_command_id: first.id }), later)).rejects.toThrow(/Węglowodany są już w Trio/);
    const retry = await send(service, bolusTab({ carbs_g: 0, insulin_u: 2, follows_command_id: first.id }), later);
    expect(retry).toMatchObject({ carbs_g: 0, insulin_u: 2, follows_command_id: first.id });
    // A garbled pump answer is never the red state: UNCERTAIN, no retry.
    const store2 = new MemoryStore();
    const service2 = new RemoteCommandsService(store2, async () => ctx(f));
    const garbled = await send(service2, bolusTab({ carbs_g: 20, insulin_u: 2.4 }), now);
    await service2.reportSent('p1', 'u1', garbled.id, { accepted: true }, now);
    expect((await service2.reportReply('p1', 'u1', garbled.id, { success: false, message: 'Błąd! Bolus nie powiódł się z powodu błędu: Bolus mógł się nie udać: Nieprawidłowa odpowiedź podczas PumpMessage(carelink, bolus)' }, now)).status).toBe('UNCERTAIN');
  });

  // BŁĄD: po PARTIAL ponowienie „Podaj sam bolus” 10 min później z tą samą dawką 2,4 j (iOS prepareRetry przepisuje insulin_u
  // z komendy) przechodzi bez żadnego ostrzeżenia, choć Trio właśnie odmówiło, bo max bolus to 2 j, a kalkulator na żywo
  // (COB 18 g, IOB) daje 2,05 j: dawka nie jest przeliczana na upływ czasu ani na limit z odpowiedzi Trio.
  it.fails('M29: ponowienie samego bolusa po 10 min jest przeliczone (limit Trio 2 j, czas) albo ostrzega', async () => {
    const f = forecast({ glucose: 140, per5: 0, iob: 0.3, curve: Array(13).fill(140) });
    const store = new MemoryStore();
    let c = ctx(f);
    const service = new RemoteCommandsService(store, async () => c);
    const first = await send(service, bolusTab({ carbs_g: 20, insulin_u: 2.4 }), now);
    await service.reportSent('p1', 'u1', first.id, { accepted: true }, now);
    await service.reportReply('p1', 'u1', first.id, { success: false, message: 'Command rejected: bolus amount (2.4 units) exceeds the maximum allowed (2 units).' }, now);
    const later = new Date(now.getTime() + 10 * 60_000);
    c = ctx(forecast({ glucose: 150, per5: 2, iob: 0.3, cob: 18, curve: Array(13).fill(150) }));
    const preview = await service.preview('p1', { carbs_g: 0, insulin_u: 2.4, bolus_step: 0.05 }, later);
    expect(preview.warnings.length).toBeGreaterThan(0);
  });

  it('D4: 260 →, IOB 0,2 j, 30 g, cel 110, ISF 250, ICR 8,3: 3,6 j z przelicznika, kalkulator 4 j z rozbiciem, korekta 0,4 j na życzenie', async () => {
    const f = forecast({ glucose: 260, per5: 0, iob: 0.2, curve: Array(13).fill(260) });
    // Bolus tab: the calculator never raises (lowering only, the loop corrects): 3,6 j, the formula 4 j shown.
    const service = new RemoteCommandsService(new MemoryStore(), async () => ctx(f));
    const preview = await service.preview('p1', { carbs_g: 30, insulin_u: null, bolus_step: 0.05, dose_default: 'CALCULATOR' }, now);
    expect(preview.insulin_u).toBe(3.6);
    expect(preview.dose_calculation).toMatchObject({ calculator_u: 4, default_u: 3.6, limited_by: 'ICR', formula: '30 g / ICR 8,3 + (260 − 110) / 250 − IOB 0,2 j = 4 j' });
    expect(preview.warnings.map((w) => w.code)).not.toContain('LOW_GLUCOSE');
    // Chat card: the correction is offered with its breakdown and added only when asked: 3,6 + 0,4 = 4 j.
    const plain = cardSession(ctx(f), { doseBasis: 'CALCULATOR' });
    const offered: any = await plain.instance.propose(meal(30, 'Obiad'));
    expect(offered).toMatchObject({ card: { insulin_u: 3.6 }, advice: { correction: { dose_u: 0.4, breakdown: '(260 − 110) / 250 − IOB 0,2 j = 0,4 j', on_this_card: false } } });
    const asked: any = await cardSession(ctx(f)).instance.propose(meal(30, 'Obiad', { add_correction: true }));
    expect(asked.card.insulin_u).toBe(4);
    // ICR setting: 3,6 j, the calculator's 4 j shown next to it.
    const icr = cardSession(ctx(f), { doseBasis: 'ICR' });
    await icr.instance.propose(meal(30, 'Obiad'));
    expect(icr.stored[0].insulin_u).toBe(3.6);
    // Above 250 for 2 h the chat card (worker context with high_safety) says to check ketones and the site.
    const highFor2h = Array.from({ length: 25 }, (_, i) => ({ at: minutesAgo(120 - i * 5), value: 262 }));
    const chat: any = await cardSession(ctx(f, { high_safety: { readings: highFor2h, boluses: [], carbs: [] } })).instance.propose(meal(30, 'Obiad'));
    expect(chat.card.warnings.join(' ')).toMatch(/zmierz ketony i rozważ wymianę wkłucia/);
  });

  // BŁĄD (brak): podpowiedź ketony/wkłucie przy >250 przez 2 h jest tylko na karcie czatu (worker podaje high_safety);
  // zakładka Bolus (preview) i karta zaplanowanego posiłku jej nie mają.
  it.fails('D4: zakładka Bolus przy >250 od 2 h podpowiada ketony/wkłucie', async () => {
    const f = forecast({ glucose: 260, per5: 0, iob: 0.2, curve: Array(13).fill(260) });
    f.readings = Array.from({ length: 25 }, (_, i) => ({ at: minutesAgo(120 - i * 5), value: 262 }));
    const service = new RemoteCommandsService(new MemoryStore(), async () => ({ ...ctx(f), forecast_inputs: { readings: f.readings, prediction: null, profile_isf: 250, profile_units: 'mg/dL', dia_hours: 6 } }));
    const preview = await service.preview('p1', { carbs_g: 30, insulin_u: null, bolus_step: 0.05, dose_default: 'CALCULATOR' }, now);
    expect(preview.warnings.map((w) => w.message).join(' ')).toMatch(/ketony/);
  });

  it('D10: 80 g (9,6 j), max bolus na telefonie 5 j: karta ostrzega, że telefon nie wyśle; plan „5 j teraz + reszta za 40 min” mieści się w limicie', async () => {
    const f = forecast({ glucose: 150, per5: 0, iob: 0.5, curve: Array(13).fill(150) });
    const limits = { max_bolus_u: 5, max_carbs_g: 100 };
    const s = cardSession(ctx(f), { phoneLimits: limits });
    const whole: any = await s.instance.propose(meal(80, 'Tort urodzinowy'));
    expect(whole.card.insulin_u).toBeGreaterThan(5);
    expect(whole.card.warnings.join(' ')).toMatch(/więcej niż limit bolusa na tym telefonie \(5 j\): telefon jej nie wyśle/);
    // The caregiver's (model's) own 5 j now: the rest's reminder covers the rest, each part confirmed on its own.
    const own = cardSession(ctx(f), { phoneLimits: limits });
    await own.instance.propose(meal(80, 'Tort urodzinowy', { insulin_u: 5 }));
    const args = restLaterArgs(own.stored[0] as never, { trigger: 'AFTER_MINUTES', minutes: 40 })!;
    expect(args).not.toBeNull();
    await own.instance.propose(args);
    const split = own.stored[1].split as any;
    expect(own.stored[1].insulin_u).toBe(5);
    expect(split).toMatchObject({ kind: 'DEFERRED_INSULIN', later_after_minutes: 40 });
    expect(split.later_insulin_u).toBeLessThanOrEqual(5);
    expect(5 + split.later_insulin_u).toBeCloseTo(9.6, 0);
    expect(own.stored[1].warnings.map((w) => w.code)).not.toContain('PHONE_LIMIT');
  });

  // BŁĄD (brak): karta 9,45 j przy limicie 5 j sama nie proponuje podziału w limicie (warianty: „Z przelicznika 9,6 j”,
  // „Dawka później 9,6 j”); karta zaplanowanego posiłku nie zna nawet limitu telefonu (mealPlanCardSession bez phoneLimits).
  it.fails('D10: karta ponad limit sama proponuje wariant „część teraz w limicie, reszta później”', async () => {
    const f = forecast({ glucose: 150, per5: 0, iob: 0.5, curve: Array(13).fill(150) });
    const s = cardSession(ctx(f), { phoneLimits: { max_bolus_u: 5, max_carbs_g: 100 } });
    await s.instance.propose(meal(80, 'Tort urodzinowy'));
    const variants = s.stored[0].card_advice!.variants ?? [];
    expect(variants.some((v) => v.insulin_now_u > 0 && v.insulin_now_u <= 5 && v.later.length > 0 && v.later.every((part) => (part.insulin_u ?? 0) <= 5))).toBe(true);
  });

  it('D16: hipo 58 o 10:00, 8 g ratunkowych; 10:20 glukoza 85 ↗, drugie śniadanie 20 g: 2,4 j, bez 8 g, „spadła do 58”', async () => {
    const f = forecast({ glucose: 85, per5: 5, iob: 0.3, cob: 8, curve: curve(85, 110, 12) });
    const s = cardSession(ctx(f, { lowest_recent_glucose: 58 }), { doseBasis: 'CALCULATOR' });
    const result: any = await s.instance.propose(meal(20, 'Drugie śniadanie'));
    // The rescue 8 g (COB) never raise the meal dose above 20 / 8,3 = 2,4 j.
    expect(result.card).toMatchObject({ carbs_g: 20, insulin_u: 2.4 });
    expect(result.dose_calculation.default_u).toBeLessThanOrEqual(2.4);
    expect(s.stored[0].warnings.find((w) => w.code === 'LOW_GLUCOSE')?.message).toBe('Glukoza spadła do 58 mg/dL w ostatnich 30 min: insulina może pogłębić niedocukrzenie.');
    // No pre-bolus: no variant gives insulin before the meal.
    expect(s.stored[0].split).toBeNull();
  });

  it('D22: 0,6 j bez odpowiedzi (OrangeLink rozłączony): blokada drugiego polecenia; po niewyraźnej odpowiedzi bez ponowienia i z ostrzeżeniem „sprawdź w pompie”', async () => {
    const f = forecast({ glucose: 160, per5: 0, iob: 0.5, curve: Array(13).fill(160) });
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, async () => ctx(f));
    const first = await send(service, bolusTab({ carbs_g: 0, insulin_u: 0.6 }), now);
    await service.reportSent('p1', 'u1', first.id, { accepted: true }, now);
    const minute = new Date(now.getTime() + 60_000);
    // 60 s with no answer: the command is in flight, nothing else goes.
    const blocked = await service.preview('p1', { carbs_g: 0, insulin_u: 0.6, bolus_step: 0.05 }, minute);
    expect(blocked.blocks.map((b) => b.code)).toContain('COMMAND_IN_FLIGHT');
    await expect(service.authorize('p1', 'u1', bolusTab({ carbs_g: 0, insulin_u: 0.6 }), minute)).rejects.toThrow(/REMOTE_COMMAND_BLOCKED|COMMAND_IN_FLIGHT/);
    // The garbled answer: UNCERTAIN (not red), no retry of the same command.
    expect((await service.reportReply('p1', 'u1', first.id, { success: false, message: 'Bolus mógł się nie udać: Nieprawidłowa odpowiedź podczas PumpMessage(carelink, bolus)' }, minute)).status).toBe('UNCERTAIN');
    await expect(service.authorize('p1', 'u1', bolusTab({ carbs_g: 0, insulin_u: 0.6, follows_command_id: first.id }), minute)).rejects.toThrow(/Only a command Trio refused/);
    const next = await service.preview('p1', { carbs_g: 0, insulin_u: 0.6, bolus_step: 0.05 }, new Date(now.getTime() + 2 * 60_000));
    expect(next.warnings.find((w) => w.code === 'UNCONFIRMED_REMOTE_BOLUS')?.message).toMatch(/Sprawdź historię bolusów w pompie: jeśli go tam nie ma, brakującą insulinę podaj w zakładce Bolus/);
  });

  // RÓŻNICA Z OCZEKIWANIEM: po UNCERTAIN serwer pozwala od razu na kolejną dawkę po potwierdzeniu ostrzeżenia (świadoma
  // decyzja, RemoteCommandSender.swift: "a new dose is always possible"); diabetolog oczekuje wyłączenia „Podaj” do potwierdzenia lub 15 min.
  it('D22: po niepewnym bolusie kolejna dawka w ciągu 15 min jest zablokowana do potwierdzenia z NS/Trio', async () => {
    const f = forecast({ glucose: 160, per5: 0, iob: 0.5, curve: Array(13).fill(160) });
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, async () => ctx(f));
    const first = await send(service, bolusTab({ carbs_g: 0, insulin_u: 0.6 }), now);
    await service.reportSent('p1', 'u1', first.id, { accepted: true }, now);
    await service.reportReply('p1', 'u1', first.id, { success: false, message: 'Bolus mógł się nie udać: Nieprawidłowa odpowiedź podczas PumpMessage(carelink, bolus)' }, now);
    const at = new Date(now.getTime() + 60_000);
    await expect(send(service, bolusTab({ carbs_g: 0, insulin_u: 0.6 }), at)).rejects.toThrow();
  });

  it('D28: nowa karta 11 g unieważnia starą 21 g; starej nie da się podać', async () => {
    const f = forecast({ glucose: 124, per5: 0, iob: 1.1, curve: curve(124, 39, 20) });
    const items21 = [{ name: 'Zupa jarzynowa', carbs_g: 11, protein_g: 2, fat_g: 2 }, { name: 'Kisiel', carbs_g: 10, protein_g: 0, fat_g: 0 }];
    const { api, raw, inserted } = planned(f, { items: items21 });
    await atNow(() => api.mealPlanBolusCard(MAMA, PATIENT, ENTRY, { items: items21 }));
    await atNow(() => api.mealPlanBolusCard(MAMA, PATIENT, ENTRY, { items: [items21[0]] }));
    expect(inserted.map((card) => card.carbs_g)).toEqual([21, 11]);
    // Every new card first discards the meal's unsent cards: one active card.
    expect(raw.bolusProposals.discardUnsentForMealPlanEntry).toHaveBeenCalledTimes(2);
    expect(raw.bolusProposals.discardUnsentForMealPlanEntry.mock.invocationCallOrder[1]).toBeLessThan(raw.bolusProposals.insert.mock.invocationCallOrder[1]);
    // The old card (discarded) cannot be given, e.g. from the other parent's phone still showing it.
    const old = { ...inserted[0], status: 'DISCARDED' };
    const service = new RemoteCommandsService(new MemoryStore(), async () => ctx(f), { get: async () => old } as never);
    await expect(service.authorize('p1', 'u1', bolusTab({ source: 'CHAT_CARD', carbs_g: 21, insulin_u: old.insulin_u, proposal_id: old.id, conversation_id: null } as never), now)).rejects.toThrow(/PROPOSAL_REPLACED/);
  });

  // BŁĄD: „Zatwierdź” zmiany w czacie zaplanowanego posiłku (acceptMealPlanChatProposal) zmienia dania, ale nie unieważnia
  // karty 21 g: zostaje PROPOSED (do 15 min), dopóki któryś telefon nie poprosi o nową kartę; drugi opiekun może ją podać.
  it('D28: zatwierdzenie porcji 11 g w czacie od razu unieważnia kartę 21 g', async () => {
    const f = forecast({ glucose: 124, per5: 0, iob: 1.1, curve: curve(124, 39, 20) });
    const { api, raw } = planned(f, { items: [{ name: 'Zupa jarzynowa', carbs_g: 11, protein_g: 2, fat_g: 2 }, { name: 'Kisiel', carbs_g: 10, protein_g: 0, fat_g: 0 }] });
    raw.mealPlanChat = { getMessage: vi.fn(async () => ({ id: 'm', role: 'ASSISTANT', proposal: { items: [{ name: 'Zupa jarzynowa', grams: 250, carbs_g: 11, protein_g: 2, fat_g: 2 }] } })), markAccepted: vi.fn(async () => undefined) };
    raw.loadMealPlanChat = vi.fn(async () => ({}));
    await api.acceptMealPlanChatProposal(MAMA, PATIENT, ENTRY, '66666666-6666-4666-8666-666666666666');
    expect(raw.mealPlans.replaceItems).toHaveBeenCalled();
    expect(raw.bolusProposals.discardUnsentForMealPlanEntry).toHaveBeenCalledWith(PATIENT, ENTRY);
  });
});
