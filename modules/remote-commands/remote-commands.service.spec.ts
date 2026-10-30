import { describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, ValidationError } from '@shared/errors/app-error';
import { RemoteCommandsService, type RemoteCommandRequest } from './application/remote-commands.service';
import type { NewRemoteCommand, RemoteCommandRecord, RemoteCommandStore } from './application/remote-command-record';
import { canTransitionRemoteCommand, IN_FLIGHT_STATUSES, type RemoteCommandStatus } from './application/remote-command-status';
import type { RemoteCommandContext } from './application/remote-command-policy';

class MemoryStore implements RemoteCommandStore {
  rows: RemoteCommandRecord[] = [];
  syncRequests: Array<{ commandId: string; at: string[] }> = [];
  failSync = false;
  async requestNightscoutSync(_patientId: string, commandId: string, at: string[]) {
    if (this.failSync) throw new Error('db down');
    this.syncRequests.push({ commandId, at });
  }
  async insert(command: NewRemoteCommand): Promise<RemoteCommandRecord> {
    if (this.rows.some((row) => row.patient_id === command.patient_id && IN_FLIGHT_STATUSES.has(row.status))) throw new ConflictError('COMMAND_IN_FLIGHT');
    if (command.proposal_id && this.rows.some((row) => row.proposal_id === command.proposal_id && !['EXPIRED', 'SEND_FAILED', 'REJECTED', 'PARTIAL'].includes(row.status))) throw new ConflictError('PROPOSAL_ALREADY_SENT');
    const record: RemoteCommandRecord = { ...command, id: `00000000-0000-4000-8000-00000000000${this.rows.length + 1}`, status: 'AUTHORIZED', trio_message: null, status_message: null, authorized_at: new Date(Date.parse(command.send_deadline) - 120_000).toISOString(), sent_at: null, answered_at: null, loop_action_id: null, meal_record_id: null, matched_at: null };
    this.rows.push(record);
    return record;
  }
  async get(patientId: string, id: string) { return this.rows.find((row) => row.patient_id === patientId && row.id === id) ?? null; }
  async list(patientId: string) { return this.rows.filter((row) => row.patient_id === patientId); }
  async findInFlight(patientId: string) { return this.rows.find((row) => row.patient_id === patientId && IN_FLIGHT_STATUSES.has(row.status)) ?? null; }
  async recordSentAt(patientId: string, id: string, at: string) {
    const row = await this.get(patientId, id);
    if (row && !row.sent_at) row.sent_at = at;
  }
  async listForProposal(patientId: string, proposalId: string) {
    return this.rows.filter((row) => row.patient_id === patientId && row.proposal_id === proposalId);
  }
  async listForPlannedBolus(patientId: string, planId: string) {
    return this.rows.filter((row) => row.patient_id === patientId && row.planned_bolus_id === planId);
  }
  async listWbtForMeal(patientId: string, mealId: string) {
    return this.rows.filter((row) => row.patient_id === patientId && row.purpose === 'WBT' && row.target_meal_record_id === mealId);
  }
  async findRecentWithInsulin(patientId: string, since: string) {
    return this.rows.filter((row) => row.patient_id === patientId && row.insulin_u > 0 && ['SENT', 'TRIO_ACCEPTED', 'SUCCEEDED', 'NO_REPLY'].includes(row.status) && (row.sent_at ?? row.authorized_at) >= since).at(-1) ?? null;
  }
  async transition(patientId: string, id: string, to: RemoteCommandStatus, fields: Record<string, unknown>) {
    const row = await this.get(patientId, id);
    if (!row || !canTransitionRemoteCommand(row.status, to)) return null;
    Object.assign(row, { status: to }, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
    return row;
  }
}

const now = new Date('2026-10-19T12:00:00.000Z');
const baseContext = (): Omit<RemoteCommandContext, 'in_flight_command_id' | 'recent_remote_bolus'> => ({
  now: now.toISOString(),
  glucose: { value: 140, observed_at: '2026-10-19T11:57:00.000Z', delta: 1 },
  lowest_recent_glucose: 130,
  loop: { iob_units: 0.5, cob_grams: 0, observed_at: '2026-10-19T11:56:00.000Z' },
  last_bolus: { at: '2026-10-19T11:50:00.000Z', units: 1 },
  icr_g_per_u: 10,
  bolus_history_known: true,
});
const request = (overrides: Partial<RemoteCommandRequest> = {}): RemoteCommandRequest => ({
  source: 'BOLUS_SCREEN',
  carbs_g: 46,
  insulin_u: 4.6,
  bolus_step: 0.05,
  device_id: 'device-1',
  meal: { description: 'Naleśniki z serem', items: [{ name: 'Naleśnik', grams: 120, carbs_g: 46, protein_g: 12, fat_g: 9, source: 'DIABCALC' }], macros: { carbs_g: 46, protein_g: 12, fat_g: 9 } },
  acknowledged_warnings: ['RECENT_BOLUS:2026-10-19T11:50:00.000Z:1'],
  ...overrides,
});

describe('RemoteCommandsService', () => {
  it('prefills the dose from carbs / ICR and shows what needs a second look', async () => {
    const service = new RemoteCommandsService(new MemoryStore(), async () => baseContext());
    const preview = await service.preview('p1', { carbs_g: 46, insulin_u: null, bolus_step: 0.05 }, now);
    expect(preview).toMatchObject({ insulin_u: 4.6, icr_insulin_u: 4.6, icr_g_per_u: 10, blocks: [] });
    expect(preview.warnings.map((warning) => warning.code)).toEqual(['RECENT_BOLUS']);
  });

  it('takes the ICR of the time a meal eaten later is dated in Trio, and gives that time to the phone', async () => {
    const asked: Array<string | null> = [];
    // ICR 10 until 12:10, 8 from then on.
    const service = new RemoteCommandsService(new MemoryStore(), async (_patientId, _now, carbsAt) => {
      asked.push(carbsAt?.toISOString() ?? null);
      return { ...baseContext(), icr_g_per_u: carbsAt && carbsAt.getTime() >= Date.parse('2026-10-19T12:10:00.000Z') ? 8 : 10, ...(carbsAt ? { carbs_at: carbsAt.toISOString() } : {}) };
    });
    const preview = await service.preview('p1', { carbs_g: 48, insulin_u: null, bolus_step: 0.05, meal_in_minutes: 15 }, now);
    expect(preview).toMatchObject({ icr_g_per_u: 8, insulin_u: 6, context: { carbs_at: '2026-10-19T12:15:00.000Z' } });
    // Without carbs nothing is dated.
    await service.preview('p1', { carbs_g: 0, insulin_u: 1, bolus_step: 0.05, meal_in_minutes: 15 }, now);
    expect(asked.at(-1)).toBeNull();
    const command = await service.authorize('p1', 'u1', request({ carbs_g: 48, insulin_u: 6, meal_in_minutes: 15 }), now);
    expect(command).toMatchObject({ icr_g_per_u: 8, carbs_at: '2026-10-19T12:15:00.000Z' });
    const plain = await new RemoteCommandsService(new MemoryStore(), async () => baseContext()).authorize('p1', 'u1', request(), now);
    expect(plain.carbs_at).toBeNull();
  });

  it('dates the carbs later only for a Bolus tab meal, within the longest delay', async () => {
    const service = new RemoteCommandsService(new MemoryStore(), async () => baseContext());
    await expect(service.authorize('p1', 'u1', request({ carbs_g: 0, insulin_u: 1, meal_in_minutes: 15 }), now)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.authorize('p1', 'u1', request({ meal_in_minutes: 45 }), now)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.authorize('p1', 'u1', request({ meal_in_minutes: 2.5 }), now)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.authorize('p1', 'u1', request({ source: 'NEW_MEAL', meal_in_minutes: 15 }), now)).rejects.toBeInstanceOf(ValidationError);
  });

  it("draws the form's chart from the forecast inputs and never stores them with a command", async () => {
    const store = new MemoryStore();
    const forecastInputs = {
      readings: [{ at: '2026-10-19T11:52:00.000Z', value: 142 }, { at: '2026-10-19T11:57:00.000Z', value: 140 }],
      prediction: null,
      profile_isf: 45,
      profile_units: 'mg/dL',
      dia_hours: 6,
    };
    const service = new RemoteCommandsService(store, async () => ({ ...baseContext(), forecast_inputs: forecastInputs }));
    const preview = await service.preview('p1', { carbs_g: 46, insulin_u: null, bolus_step: 0.05 }, now);
    expect(preview.forecast).toMatchObject({ start: '2026-10-19T11:57:00.000Z', carbs_g: 46, insulin_u: 4.6, baseline_source: 'CGM_TREND' });
    // By default only the line without the dose is drawn (bolus-forecast.v7); the dose is checked by its full effect.
    expect(preview.forecast).toMatchObject({ dose_line: 'LOOP_ONLY', with_dose: null });
    expect(preview.forecast?.total_with_dose).not.toBeNull();
    expect(preview.context).not.toHaveProperty('forecast_inputs');
    await service.authorize('p1', 'u1', request(), now);
    expect(store.rows[0].context).not.toHaveProperty('forecast_inputs');
    expect((await new RemoteCommandsService(new MemoryStore(), async () => baseContext()).preview('p1', { carbs_g: 0, insulin_u: 1, bolus_step: 0.05 }, now)).forecast).toBeNull();
  });

  it('draws the dashed "z tą dawką" line from the insulin above the calculator\'s carbs / ICR dose (excess-insulin.v1)', async () => {
    const forecastInputs = {
      readings: [{ at: '2026-10-19T11:52:00.000Z', value: 111 }, { at: '2026-10-19T11:57:00.000Z', value: 111 }],
      prediction: null,
      profile_isf: 100,
      profile_units: 'mg/dL',
      dia_hours: 6,
    };
    const service = new RemoteCommandsService(new MemoryStore(), async () => ({ ...baseContext(), icr_g_per_u: 8, forecast_inputs: forecastInputs }));
    // The owner's case: 1 g (1 / 8 = 0,125 → 0,1 j at the 0,05 step), 1 j typed: 0,9 j above the carbs.
    const owner = (await service.preview('p1', { carbs_g: 1, insulin_u: 1, bolus_step: 0.05 }, now)).forecast!;
    expect(owner).toMatchObject({ dose_line: 'LOOP_ONLY', excess_policy: 'excess-insulin.v1', excess_insulin_u: 0.9, excess_step_u: 0.05 });
    expect(owner.with_excess_min).toBe(Math.min(...owner.with_excess!));
    expect(owner.with_excess_min).toBeLessThan(70);
    // The ICR dose itself: no dashed line.
    expect((await service.preview('p1', { carbs_g: 40, insulin_u: null, bolus_step: 0.05 }, now)).forecast).toMatchObject({ insulin_u: 5, excess_insulin_u: 0, with_excess: null });
    // Under the ICR dose: above the loop's line.
    const below = (await service.preview('p1', { carbs_g: 40, insulin_u: 4.5, bolus_step: 0.05 }, now)).forecast!;
    expect(below.excess_insulin_u).toBe(-0.5);
    expect(below.with_excess!.at(-1)).toBeGreaterThan(below.baseline.at(-1)!);
  });

  it('authorizes a confirmed command with the meal it is for, once at a time', async () => {
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, async () => baseContext());
    const command = await service.authorize('p1', 'u1', request(), now);
    expect(command).toMatchObject({ status: 'AUTHORIZED', carbs_g: 46, insulin_u: 4.6, sent_by_me: true, meal_description: 'Naleśniki z serem', send_deadline: '2026-10-19T12:02:00.000Z' });
    expect(store.rows[0].meal_payload?.items?.[0].name).toBe('Naleśnik');
    // The second caregiver cannot send while the first command waits for Trio.
    await expect(service.authorize('p1', 'u2', request(), now)).rejects.toThrow(/COMMAND_IN_FLIGHT|Poprzednie polecenie/);
  });

  it('refuses a command whose warnings changed since the confirmation or that is blocked', async () => {
    const service = new RemoteCommandsService(new MemoryStore(), async () => baseContext());
    await expect(service.authorize('p1', 'u1', request({ acknowledged_warnings: [] }), now)).rejects.toThrow(/REMOTE_COMMAND_WARNINGS_CHANGED/);
    // A low is a warning the caregiver must have seen, not a block.
    const low = new RemoteCommandsService(new MemoryStore(), async () => ({ ...baseContext(), glucose: { value: 64, observed_at: '2026-10-19T11:58:00.000Z', delta: -4 } }));
    await expect(low.authorize('p1', 'u1', request(), now)).rejects.toThrow(/REMOTE_COMMAND_WARNINGS_CHANGED/);
    const lowPreview = await low.preview('p1', { carbs_g: 46, insulin_u: 4.6, bolus_step: 0.05 }, now);
    expect(lowPreview.blocks).toEqual([]);
    // Insulin below 70 also needs the separate low confirmation (review H1).
    await expect(low.authorize('p1', 'u1', request({ acknowledged_warnings: lowPreview.warnings.map((warning) => warning.key) }), now)).rejects.toThrow(/LOW_GLUCOSE_CONFIRMATION_REQUIRED/);
    await expect(low.authorize('p1', 'u1', request({ acknowledged_warnings: lowPreview.warnings.map((warning) => warning.key), low_glucose_confirmed: true }), now)).resolves.toMatchObject({ status: 'AUTHORIZED' });
    await expect(service.authorize('p1', 'u1', request({ carbs_g: 46.5 }), now)).rejects.toThrow(/REMOTE_COMMAND_BLOCKED/);
    await expect(service.authorize('p1', 'u1', request({ bolus_step: 0.2 }), now)).rejects.toBeInstanceOf(ValidationError);
  });

  it("follows the sender's reports: sent, Trio accepted, bolus started", async () => {
    const service = new RemoteCommandsService(new MemoryStore(), async () => baseContext());
    const { id } = await service.authorize('p1', 'u1', request(), now);
    expect((await service.reportSent('p1', 'u1', id, { accepted: true }, now)).status_message).toBe('Polecenie wysłane, czekam na odpowiedź Trio.');
    expect((await service.reportReply('p1', 'u1', id, { success: true, message: 'Initiating bolus...' }, now)).status).toBe('TRIO_ACCEPTED');
    const done = await service.reportReply('p1', 'u1', id, { success: true, message: 'Bolus started' }, now);
    expect(done).toMatchObject({ status: 'SUCCEEDED', status_message: 'Bolus podany' });
    // A late duplicate answer changes nothing.
    expect((await service.reportReply('p1', 'u1', id, { success: false, message: 'Command rejected: whatever' }, now)).status).toBe('SUCCEEDED');
    await expect(service.reportReply('p1', 'u2', id, { success: true, message: 'Bolus started' }, now)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rounds with the pump's step Trio reports and refuses a dose the pump cannot deliver", async () => {
    const service = new RemoteCommandsService(new MemoryStore(), async () => ({ ...baseContext(), icr_g_per_u: 8, pump_bolus_step: 0.1 }));
    const preview = await service.preview('p1', { carbs_g: 30, insulin_u: null, bolus_step: 0.05 }, now);
    expect(preview).toMatchObject({ insulin_u: 3.7, icr_insulin_u: 3.7, bolus_step: 0.1, bolus_step_source: 'PUMP' });
    const keys = (await service.preview('p1', { carbs_g: 30, insulin_u: 3.75, bolus_step: 0.05 }, now)).warnings.map((warning) => warning.key);
    await expect(service.authorize('p1', 'u1', request({ carbs_g: 30, insulin_u: 3.75, bolus_step: 0.05, acknowledged_warnings: keys }), now)).rejects.toThrow(/REMOTE_COMMAND_BLOCKED/);
    const settingsOnly = new RemoteCommandsService(new MemoryStore(), async () => ({ ...baseContext(), icr_g_per_u: 8 }));
    expect(await settingsOnly.preview('p1', { carbs_g: 30, insulin_u: null, bolus_step: 0.05 }, now)).toMatchObject({ insulin_u: 3.75, bolus_step: 0.05, bolus_step_source: 'SETTINGS' });
  });

  it('stores a WBT command from the WBT window for its meal, with no meal of its own', async () => {
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, async () => baseContext());
    const mealId = '11111111-1111-4111-8111-111111111111';
    const keys = (await service.preview('p1', { carbs_g: 15, insulin_u: 1.5, bolus_step: 0.05 }, now)).warnings.map((warning) => warning.key);
    const view = await service.authorize('p1', 'u1', request({ source: 'WBT_SCREEN', carbs_g: 15, insulin_u: 1.5, wbt_meal_id: mealId, acknowledged_warnings: keys }), now);
    expect(view).toMatchObject({ source: 'WBT_SCREEN', purpose: 'WBT', target_meal_record_id: mealId });
    expect(store.rows[0].meal_payload).toBeNull();
    await expect(service.authorize('p1', 'u1', request({ source: 'WBT_SCREEN', acknowledged_warnings: keys }), now)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.authorize('p1', 'u1', request({ wbt_meal_id: mealId }), now)).rejects.toBeInstanceOf(ValidationError);
  });

  it("never sends a meal's WBT carbs-equivalent twice: after PARTIAL only the bolus goes, also after a failed or refused retry", async () => {
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, async () => baseContext());
    const mealId = '11111111-1111-4111-8111-111111111111';
    const otherMealId = '44444444-4444-4444-8444-444444444444';
    const wbt = (overrides: Partial<RemoteCommandRequest> = {}) => request({ source: 'WBT_SCREEN', carbs_g: 15, insulin_u: 1.5, wbt_meal_id: mealId, meal: null, acknowledged_warnings: ['RECENT_BOLUS:2026-10-19T11:50:00.000Z:1'], ...overrides });
    const bolusOnly = { carbs_g: 0, insulin_u: 1.5, acknowledged_warnings: ['RECENT_BOLUS:2026-10-19T11:50:00.000Z:1', 'INSULIN_WITHOUT_CARBS:1.5'] };
    const first = await service.authorize('p1', 'u1', wbt(), now);
    await service.reportSent('p1', 'u1', first.id, { accepted: true }, now);
    await service.reportReply('p1', 'u1', first.id, { success: false, message: 'Command rejected: bolus amount (1.5 units) exceeds the maximum allowed (1 units).' }, now);
    expect(store.rows[0].status).toBe('PARTIAL');

    // Trio kept the 15 g: a fresh WBT for the meal may not carry them again; the bolus alone goes.
    await expect(service.authorize('p1', 'u1', wbt(), now)).rejects.toThrow(/Węglowodany są już w Trio/);
    const retry = await service.authorize('p1', 'u1', wbt(bolusOnly), now);
    await service.reportSent('p1', 'u1', retry.id, { accepted: false, message: 'Nie udało się wysłać polecenia.' }, now);
    await expect(service.authorize('p1', 'u1', wbt(), now)).rejects.toThrow(/Węglowodany są już w Trio/);
    const second = await service.authorize('p1', 'u1', wbt(bolusOnly), now);
    await service.reportReply('p1', 'u1', second.id, { success: false, message: 'Command rejected: Max IOB' }, now);
    expect(store.rows[2].status).toBe('REJECTED');
    await expect(service.authorize('p1', 'u1', wbt(), now)).rejects.toThrow(/Węglowodany są już w Trio/);

    // Another meal's WBT is its own.
    const other = await service.authorize('p1', 'u1', wbt({ wbt_meal_id: otherMealId }), now);
    expect(other).toMatchObject({ carbs_g: 15, target_meal_record_id: otherMealId });
  });

  it("gives a meal's WBT once: refused outright it goes again whole, given (or maybe given) it is not sent again", async () => {
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, async () => baseContext());
    const mealId = '11111111-1111-4111-8111-111111111111';
    const wbt = (overrides: Partial<RemoteCommandRequest> = {}) => request({ source: 'WBT_SCREEN', carbs_g: 15, insulin_u: 1.5, wbt_meal_id: mealId, meal: null, acknowledged_warnings: ['RECENT_BOLUS:2026-10-19T11:50:00.000Z:1'], ...overrides });
    const first = await service.authorize('p1', 'u1', wbt(), now);
    await service.reportReply('p1', 'u1', first.id, { success: false, message: 'Command rejected: shared secret mismatch' }, now);
    expect(store.rows[0].status).toBe('REJECTED');

    // Nothing reached Trio: the whole WBT goes again.
    const second = await service.authorize('p1', 'u1', wbt(), now);
    await service.reportSent('p1', 'u1', second.id, { accepted: true }, now);
    store.rows[1].status = 'NO_REPLY';
    // It may have been given: not again, not even the bolus alone (a late refusal frees it).
    await expect(service.authorize('p1', 'u1', wbt(), now)).rejects.toThrow(/WBT_ALREADY_SENT/);
    await expect(service.authorize('p1', 'u1', wbt({ carbs_g: 0, acknowledged_warnings: ['RECENT_BOLUS:2026-10-19T11:50:00.000Z:1', 'INSULIN_WITHOUT_CARBS:1.5'] }), now)).rejects.toThrow(/WBT_ALREADY_SENT/);
    await service.reportReply('p1', 'u1', second.id, { success: false, message: 'Command rejected: newer carb entries' }, now);
    const third = await service.authorize('p1', 'u1', wbt(), now);
    await service.reportReply('p1', 'u1', third.id, { success: true, message: 'Bolus started' }, now);
    expect(store.rows[2].status).toBe('SUCCEEDED');
    await expect(service.authorize('p1', 'u1', wbt(), now)).rejects.toThrow(/WBT_ALREADY_SENT/);
    await expect(service.authorize('p1', 'u1', wbt(), now)).rejects.toBeInstanceOf(ConflictError);
  });

  it('reads Nightscout again 3, 10 and 25 s after Trio stored something, so the meal does not wait for the minute', async () => {
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, async () => baseContext());
    const { id } = await service.authorize('p1', 'u1', request(), now);
    await service.reportSent('p1', 'u1', id, { accepted: true }, now);
    await service.reportReply('p1', 'u1', id, { success: true, message: 'Initiating bolus...' }, now);
    expect(store.syncRequests).toEqual([{ commandId: id, at: ['2026-10-19T12:00:03.000Z', '2026-10-19T12:00:10.000Z', '2026-10-19T12:00:25.000Z'] }]);
    await service.reportReply('p1', 'u1', id, { success: true, message: 'Bolus started' }, now);
    expect(store.syncRequests).toHaveLength(2);
    // A late duplicate changes nothing and queues nothing.
    await service.reportReply('p1', 'u1', id, { success: true, message: 'Bolus started' }, now);
    expect(store.syncRequests).toHaveLength(2);

    // A correction refused outright: nothing reached Nightscout. A failed queue never fails the reply.
    const refused = new MemoryStore();
    const other = new RemoteCommandsService(refused, async () => baseContext());
    const second = await other.authorize('p1', 'u1', request({ carbs_g: 0, insulin_u: 1, meal: null }), now);
    await other.reportReply('p1', 'u1', second.id, { success: false, message: 'Command rejected: Max IOB' }, now);
    expect(refused.syncRequests).toEqual([]);
    const failing = new MemoryStore();
    failing.failSync = true;
    const third = new RemoteCommandsService(failing, async () => baseContext());
    const sent = await third.authorize('p1', 'u1', request(), now);
    await expect(third.reportReply('p1', 'u1', sent.id, { success: true, message: 'Bolus started' }, now)).resolves.toMatchObject({ status: 'SUCCEEDED' });
  });

  it('accepts a code-only acknowledgement no more, and lets a dose after an unconfirmed remote bolus go only when acknowledged', async () => {
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, async () => baseContext());
    await expect(service.authorize('p1', 'u1', request({ acknowledged_warnings: ['RECENT_BOLUS'] }), now)).rejects.toThrow(/WARNINGS_CHANGED/);
    const { id } = await service.authorize('p1', 'u1', request(), now);
    await service.reportSent('p1', 'u1', id, { accepted: true }, now);
    store.rows[0].status = 'NO_REPLY';
    await expect(service.authorize('p1', 'u2', request(), now)).rejects.toThrow(/MÓGŁ zostać podany/);
    const preview = await service.preview('p1', { carbs_g: 46, insulin_u: 4.6, bolus_step: 0.05 }, now);
    const keys = preview.warnings.map((warning) => warning.key);
    await expect(service.authorize('p1', 'u2', request({ acknowledged_warnings: keys }), now)).resolves.toMatchObject({ status: 'AUTHORIZED' });
  });

  it('takes Trio\'s answer before the "sent" report and keeps a late "sent" report as a time only', async () => {
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, async () => baseContext());
    const { id } = await service.authorize('p1', 'u1', request(), now);
    expect((await service.reportReply('p1', 'u1', id, { success: true, message: 'Initiating bolus...' }, now)).status).toBe('TRIO_ACCEPTED');
    store.rows[0].status = 'NO_REPLY';
    store.rows[0].sent_at = null;
    expect((await service.reportSent('p1', 'u1', id, { accepted: true }, now)).status).toBe('NO_REPLY');
    expect(store.rows[0].sent_at).toBe(now.toISOString());
  });

  it('records an APNs refusal as not sent, so the next command may go', async () => {
    const service = new RemoteCommandsService(new MemoryStore(), async () => baseContext());
    const { id } = await service.authorize('p1', 'u1', request(), now);
    const failed = await service.reportSent('p1', 'u1', id, { accepted: false, message: 'Nie udało się wysłać: klucz APNs nie pasuje' }, now);
    expect(failed).toMatchObject({ status: 'SEND_FAILED', status_message: 'Nie udało się wysłać: klucz APNs nie pasuje' });
    await expect(service.authorize('p1', 'u1', request(), now)).resolves.toMatchObject({ status: 'AUTHORIZED' });
  });

  it('sends from a chat card only while it is valid and in its own conversation', async () => {
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const proposalId = '22222222-2222-4222-8222-222222222222';
    let expiresAt = '2026-10-19T12:10:00.000Z';
    const proposals = { get: async (_patientId: string, id: string) => (id === proposalId ? { conversation_id: conversationId, status: 'PROPOSED', expires_at: expiresAt } : null) };
    const service = new RemoteCommandsService(new MemoryStore(), async () => baseContext(), proposals);
    await expect(service.authorize('p1', 'u1', request({ source: 'CHAT_CARD', proposal_id: proposalId, conversation_id: '33333333-3333-4333-8333-333333333333' }), now)).rejects.toBeInstanceOf(ValidationError);
    expiresAt = '2026-10-19T11:59:00.000Z';
    await expect(service.authorize('p1', 'u1', request({ source: 'CHAT_CARD', proposal_id: proposalId, conversation_id: conversationId }), now)).rejects.toThrow(/PROPOSAL_EXPIRED/);
    expiresAt = '2026-10-19T12:10:00.000Z';
    await expect(service.authorize('p1', 'u1', request({ source: 'CHAT_CARD', proposal_id: proposalId, conversation_id: conversationId }), now)).resolves.toMatchObject({ proposal_id: proposalId });
    await expect(new RemoteCommandsService(new MemoryStore(), async () => baseContext()).authorize('p1', 'u1', request({ proposal_id: proposalId, conversation_id: conversationId }), now)).rejects.toBeInstanceOf(ValidationError);
  });

  it("shows a card's own warnings in its confirmation and needs them acknowledged (a build that did not show them still sends)", async () => {
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const proposalId = '22222222-2222-4222-8222-222222222222';
    const forecastLow = { code: 'FORECAST_LOW' as const, key: 'FORECAST_LOW:2026-10-19T11:57:00.000Z', severity: 'WARNING' as const, message: 'Prognoza z tą kartą schodzi do 62 mg/dL.' };
    const live = { code: 'RECENT_BOLUS' as const, key: 'RECENT_BOLUS:2026-10-19T11:50:00.000Z:1', message: 'Bolus 1 j 10 min temu.' };
    const proposals = { get: async () => ({ conversation_id: conversationId, status: 'PROPOSED', expires_at: '2026-10-19T12:10:00.000Z', carbs_g: 46, insulin_u: 4.6, warnings: [forecastLow, live] }) };
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, async () => baseContext(), proposals as never);

    const preview = await service.preview('p1', { carbs_g: 46, insulin_u: 4.6, bolus_step: 0.05, proposal_id: proposalId }, now);
    expect(preview.warnings.map((warning) => warning.key)).toEqual(['RECENT_BOLUS:2026-10-19T11:50:00.000Z:1', forecastLow.key]);
    expect((await service.preview('p1', { carbs_g: 46, insulin_u: 4.6, bolus_step: 0.05 }, now)).warnings.map((warning) => warning.code)).toEqual(['RECENT_BOLUS']);
    // Other amounts than the card's: its warnings were for the card's dose, so they are not the confirmation's.
    const changed = await service.preview('p1', { carbs_g: 46, insulin_u: 3, bolus_step: 0.05, proposal_id: proposalId }, now);
    expect(changed.warnings.map((warning) => warning.code)).not.toContain('FORECAST_LOW');
    await expect(new RemoteCommandsService(new MemoryStore(), async () => baseContext(), proposals as never).authorize('p1', 'u1', request({ source: 'CHAT_CARD', proposal_id: proposalId, conversation_id: conversationId, insulin_u: 3, card_warnings_shown: true, acknowledged_warnings: changed.warnings.map((warning) => warning.key) }), now)).resolves.toMatchObject({ insulin_u: 3 });

    const card = { source: 'CHAT_CARD' as const, proposal_id: proposalId, conversation_id: conversationId };
    await expect(service.authorize('p1', 'u1', request({ ...card, card_warnings_shown: true }), now)).rejects.toThrow(/REMOTE_COMMAND_WARNINGS_CHANGED: Prognoza/);
    const sent = await service.authorize('p1', 'u1', request({ ...card, card_warnings_shown: true, acknowledged_warnings: [live.key, forecastLow.key] }), now);
    expect(sent.warnings.map((warning) => warning.code)).toEqual(['RECENT_BOLUS', 'FORECAST_LOW']);

    const legacy = new RemoteCommandsService(new MemoryStore(), async () => baseContext(), proposals as never);
    await expect(legacy.authorize('p1', 'u1', request(card), now)).resolves.toMatchObject({ proposal_id: proposalId });
  });

  it('retries a refused card: the bolus alone after PARTIAL, within 30 minutes, only the newest refusal', async () => {
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const proposalId = '22222222-2222-4222-8222-222222222222';
    const proposals = { get: async () => ({ conversation_id: conversationId, status: 'PROPOSED', expires_at: '2026-10-19T12:10:00.000Z' }) };
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, async () => baseContext(), proposals);
    const card = { source: 'CHAT_CARD' as const, proposal_id: proposalId, conversation_id: conversationId };
    const first = await service.authorize('p1', 'u1', request(card), now);
    await service.reportSent('p1', 'u1', first.id, { accepted: true }, now);
    await service.reportReply('p1', 'u1', first.id, { success: false, message: 'Command rejected: bolus amount (4.6 units) exceeds the maximum allowed (2 units).' }, now);
    expect(store.rows[0].status).toBe('PARTIAL');

    // Not a plain second send, and never the carbs again.
    await expect(service.authorize('p1', 'u1', request(card), now)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.authorize('p1', 'u1', request({ ...card, follows_command_id: first.id }), now)).rejects.toThrow(/Węglowodany są już w Trio/);
    const later = new Date(now.getTime() + 31 * 60_000);
    await expect(service.authorize('p1', 'u1', request({ ...card, carbs_g: 0, insulin_u: 2, follows_command_id: first.id, acknowledged_warnings: [] }), later)).rejects.toThrow(/RETRY_TOO_LATE/);

    // The card expired meanwhile (12:10), the retry still goes (its values are checked again).
    const soon = new Date(now.getTime() + 12 * 60_000);
    const retry = await service.authorize('p1', 'u1', request({ ...card, carbs_g: 0, insulin_u: 2, follows_command_id: first.id, acknowledged_warnings: ['RECENT_BOLUS:2026-10-19T11:50:00.000Z:1', 'INSULIN_WITHOUT_CARBS:2'] }), soon);
    expect(retry).toMatchObject({ follows_command_id: first.id, carbs_g: 0, insulin_u: 2 });
  });

  it('a retry after Trio stored nothing (REJECTED) brings the carbs and the card\'s later plan; a bolus-only retry does not', async () => {
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const proposalId = '22222222-2222-4222-8222-222222222222';
    const split = { kind: 'DEFERRED_INSULIN', later_carbs_g: 0, later_after_minutes: 180 };
    const proposals = { get: async () => ({ conversation_id: conversationId, status: 'PROPOSED', expires_at: '2026-10-19T12:10:00.000Z', split }) };
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, async () => baseContext(), proposals as never);
    const card = { source: 'CHAT_CARD' as const, proposal_id: proposalId, conversation_id: conversationId };
    const first = await service.authorize('p1', 'u1', request({ ...card, carbs_g: 40, insulin_u: 0, acknowledged_warnings: [] }), now);
    expect(store.rows[0].split_plan).toEqual(split);
    await service.reportReply('p1', 'u1', first.id, { success: false, message: 'Command rejected: message is too old' }, now);
    expect(store.rows[0].status).toBe('REJECTED');
    const retry = await service.authorize('p1', 'u1', request({ ...card, carbs_g: 40, insulin_u: 0, follows_command_id: first.id, acknowledged_warnings: [] }), now);
    expect(retry).toMatchObject({ follows_command_id: first.id, carbs_g: 40 });
    expect(store.rows[1].split_plan).toEqual(split);
  });

  it('never sends the carbs again after PARTIAL, also when the bolus-only retry failed to send or was refused', async () => {
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const proposalId = '22222222-2222-4222-8222-222222222222';
    const proposals = { get: async () => ({ conversation_id: conversationId, status: 'PROPOSED', expires_at: '2026-10-19T12:10:00.000Z' }) };
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, async () => baseContext(), proposals);
    const card = { source: 'CHAT_CARD' as const, proposal_id: proposalId, conversation_id: conversationId };
    const bolusOnly = { carbs_g: 0, insulin_u: 2, acknowledged_warnings: ['RECENT_BOLUS:2026-10-19T11:50:00.000Z:1', 'INSULIN_WITHOUT_CARBS:2'] };
    const first = await service.authorize('p1', 'u1', request(card), now);
    await service.reportReply('p1', 'u1', first.id, { success: false, message: 'Command rejected: bolus amount (4.6 units) exceeds the maximum allowed (2 units).' }, now);
    expect(store.rows[0].status).toBe('PARTIAL');

    // The bolus-only retry never left the phone: the newest command of the card is now SEND_FAILED.
    const failed = await service.authorize('p1', 'u1', request({ ...card, ...bolusOnly, follows_command_id: first.id }), now);
    await service.reportSent('p1', 'u1', failed.id, { accepted: false, message: 'APNs' }, now);
    expect(store.rows[1].status).toBe('SEND_FAILED');

    // The whole card again (the carbs a second time) is refused, with or without the failed retry named.
    await expect(service.authorize('p1', 'u1', request(card), now)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.authorize('p1', 'u1', request({ ...card, follows_command_id: failed.id }), now)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.authorize('p1', 'u1', request({ ...card, follows_command_id: first.id }), now)).rejects.toThrow(/Węglowodany są już w Trio/);
    // The bolus alone, retrying the PARTIAL command, still goes.
    const second = await service.authorize('p1', 'u1', request({ ...card, ...bolusOnly, follows_command_id: first.id }), now);
    expect(second).toMatchObject({ follows_command_id: first.id, carbs_g: 0, insulin_u: 2 });

    // Trio refuses that one too: only its retry may go, and never with the carbs the first command left in Trio.
    await service.reportReply('p1', 'u1', second.id, { success: false, message: 'Command rejected: would exceed max IOB (3 units). Current IOB: 2.5' }, now);
    expect(store.rows[2].status).toBe('REJECTED');
    await expect(service.authorize('p1', 'u1', request({ ...card, ...bolusOnly, follows_command_id: first.id }), now)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.authorize('p1', 'u1', request({ ...card, follows_command_id: second.id }), now)).rejects.toThrow(/Węglowodany są już w Trio/);
    await expect(service.authorize('p1', 'u1', request({ ...card, ...bolusOnly, insulin_u: 1, acknowledged_warnings: [...bolusOnly.acknowledged_warnings, 'INSULIN_WITHOUT_CARBS:1'], follows_command_id: second.id }), now)).resolves.toMatchObject({ follows_command_id: second.id, carbs_g: 0 });
  });

  it('never sends the carbs of a Bolus tab command again through a chain of refused retries', async () => {
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, async () => baseContext());
    const first = await service.authorize('p1', 'u1', request(), now);
    await service.reportReply('p1', 'u1', first.id, { success: false, message: 'Command rejected: bolus amount (4.6 units) exceeds the maximum allowed (2 units).' }, now);
    const retry = await service.authorize('p1', 'u1', request({ carbs_g: 0, insulin_u: 2, follows_command_id: first.id, acknowledged_warnings: ['RECENT_BOLUS:2026-10-19T11:50:00.000Z:1', 'INSULIN_WITHOUT_CARBS:2'] }), now);
    await service.reportReply('p1', 'u1', retry.id, { success: false, message: 'Command rejected: would exceed max IOB (3 units). Current IOB: 2.5' }, now);
    expect(store.rows.map((row) => row.status)).toEqual(['PARTIAL', 'REJECTED']);
    await expect(service.authorize('p1', 'u1', request({ follows_command_id: retry.id }), now)).rejects.toThrow(/Węglowodany są już w Trio/);
  });
});

describe('RemoteCommandsService dose safety (dose-calculator.v1)', () => {
  const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  /** Readings and Trio's calculation behind the calculator: glucose 120 flat, IOB as given, ISF 100, target 100. */
  const forecast = (options: { glucose?: number; iob?: number; loopAge?: number } = {}) => {
    const glucose = options.glucose ?? 120;
    return {
      readings: [16, 11, 6, 1].map((minutes) => ({ at: at(minutes), value: glucose })),
      prediction: {
        source: 'OPENAPS' as const, system: 'TRIO' as const, computed_at: at(options.loopAge ?? 1), bg: glucose, carbs_req_g: null, iob_u: options.iob ?? 2.6, cob_g: 0,
        isf_mgdl_per_u: 100, icr_g_per_u: 10, eventual_bg: glucose, target_mgdl: 100, curves: { IOB: [glucose, glucose, glucose, glucose, glucose, glucose, glucose] },
      },
      profile_isf: 100,
      profile_target: 100,
      profile_units: 'mg/dl',
    };
  };
  const contextWith = (options: Parameters<typeof forecast>[0] = {}, extra: Partial<RemoteCommandContext> = {}) => async () => ({
    ...baseContext(),
    glucose: { value: options.glucose ?? 120, observed_at: at(1), delta: 0 },
    lowest_recent_glucose: options.glucose ?? 120,
    last_bolus: null,
    ...extra,
    meal_forecast: forecast(options),
  });
  const plain = { acknowledged_warnings: [] as string[] };

  it('pre-fills the calculator\'s lower dose for builds that ask for it; older builds keep carbs / ICR with a DANGER warning', async () => {
    const service = new RemoteCommandsService(new MemoryStore(), contextWith());
    // 46 / 10 + (120 − 100) / 100 − IOB 2,6 = 2,2 j instead of 4,6 j.
    const current = await service.preview('p1', { carbs_g: 46, insulin_u: null, bolus_step: 0.05, dose_default: 'CALCULATOR' }, now);
    expect(current).toMatchObject({ insulin_u: 2.2, icr_insulin_u: 4.6, dose_calculation: { default_u: 2.2, icr_dose_u: 4.6, limited_by: 'CALCULATOR', calculator_u: 2.2 } });
    expect(current.dose_calculation?.summary).toBe('Kalkulator pętli: 2,2 j zamiast 4,6 j z przelicznika — IOB 2,6 j, glukoza 120.');
    // Lowered by the calculator: not "differs from ICR", and no dose warning.
    expect(current.warnings.map((warning) => warning.code)).toEqual([]);
    const older = await service.preview('p1', { carbs_g: 46, insulin_u: null, bolus_step: 0.05 }, now);
    expect(older.insulin_u).toBe(4.6);
    expect(older.warnings.map((warning) => [warning.code, warning.severity])).toEqual([['DOSE_ABOVE_CALCULATOR', 'DANGER']]);
    expect(older.warnings[0].message).toBe('4,6 j to o 2,4 j więcej, niż wychodzi z danych (kalkulator pętli: 46 g / ICR 10 + (120 − 100) / 100 − IOB 2,6 j = 2,2 j). Większa dawka grozi niedocukrzeniem.');
  });

  it('re-checks on live data when the dose is authorized: a dose dangerously above the calculator needs its warning acknowledged', async () => {
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, contextWith());
    await expect(service.authorize('p1', 'u1', request({ ...plain }), now)).rejects.toThrow(/REMOTE_COMMAND_WARNINGS_CHANGED: 4,6 j to o 2,4 j więcej/);
    const sent = await service.authorize('p1', 'u1', request({ acknowledged_warnings: ['DOSE_ABOVE_CALCULATOR:4.6:2.2'] }), now);
    expect(sent.warnings.map((warning) => warning.code)).toEqual(['DOSE_ABOVE_CALCULATOR']);
    expect(store.rows[0].context.dose_calculation).toMatchObject({ default_u: 2.2, reference_u: 2.2 });
    expect(store.rows[0].context).not.toHaveProperty('meal_forecast');
    // The calculator's own dose, or a little more, needs nothing.
    await expect(new RemoteCommandsService(new MemoryStore(), contextWith()).authorize('p1', 'u1', request({ insulin_u: 2.2, ...plain }), now)).resolves.toMatchObject({ insulin_u: 2.2 });
    await expect(new RemoteCommandsService(new MemoryStore(), contextWith()).authorize('p1', 'u1', request({ insulin_u: 2.6, ...plain }), now)).resolves.toMatchObject({ insulin_u: 2.6 });
  });

  it('below 70 mg/dL pre-fills 0 j and any insulin needs the separate low confirmation', async () => {
    const service = new RemoteCommandsService(new MemoryStore(), contextWith({ glucose: 64, iob: 0.2 }));
    const preview = await service.preview('p1', { carbs_g: 20, insulin_u: null, bolus_step: 0.05, dose_default: 'CALCULATOR' }, now);
    expect(preview).toMatchObject({ insulin_u: 0, dose_calculation: { default_u: 0, limited_by: 'CARBS_FIRST' } });
    const withInsulin = await service.preview('p1', { carbs_g: 20, insulin_u: 1, bolus_step: 0.05 }, now);
    expect(withInsulin.warnings.map((warning) => warning.code)).toEqual(['LOW_GLUCOSE', 'INSULIN_WHILE_LOW']);
    await expect(service.authorize('p1', 'u1', request({ carbs_g: 20, insulin_u: 1, acknowledged_warnings: [withInsulin.warnings[0].key] }), now)).rejects.toThrow(/najpierw węglowodany/);
    // Acknowledged with the slide only (every build sends the key): refused until the separate alert confirms (review H1).
    const allKeys = withInsulin.warnings.map((warning) => warning.key);
    await expect(service.authorize('p1', 'u1', request({ carbs_g: 20, insulin_u: 1, acknowledged_warnings: allKeys }), now)).rejects.toThrow('LOW_GLUCOSE_CONFIRMATION_REQUIRED: Glukoza jest niska: najpierw węglowodany. Aby mimo to podać insulinę, zaktualizuj aplikację i potwierdź osobno.');
    await expect(service.authorize('p1', 'u1', request({ carbs_g: 20, insulin_u: 1, acknowledged_warnings: allKeys, low_glucose_confirmed: false }), now)).rejects.toBeInstanceOf(ConflictError);
    await expect(service.authorize('p1', 'u1', request({ carbs_g: 20, insulin_u: 1, acknowledged_warnings: allKeys, low_glucose_confirmed: true }), now)).resolves.toMatchObject({ insulin_u: 1 });
    // Carbs alone need nothing.
    await expect(new RemoteCommandsService(new MemoryStore(), contextWith({ glucose: 64 })).authorize('p1', 'u1', request({ carbs_g: 20, insulin_u: 0, ...plain }), now)).resolves.toMatchObject({ insulin_u: 0 });
  });

  it('points out recent insulin the calculator could not count (no fresh IOB), SMBs included', async () => {
    const recent = { window_minutes: 120, total_u: 1.6, manual_u: 1.2, smb_u: 0.4, remote_u: 0, newest_at: at(20) };
    const service = new RemoteCommandsService(new MemoryStore(), contextWith({ loopAge: 40 }, { recent_insulin: recent }));
    const preview = await service.preview('p1', { carbs_g: 46, insulin_u: null, bolus_step: 0.05, dose_default: 'CALCULATOR' }, now);
    expect(preview).toMatchObject({ insulin_u: 4.6, dose_calculation: { calculated: false, fallback_reason: 'brak aktualnego IOB z Trio' } });
    const recentWarning = preview.warnings.find((warning) => warning.code === 'RECENT_INSULIN');
    expect(recentWarning?.message).toBe('W ostatnich 120 min podano 1,6 j (bolusy 1,2 j, SMB 0,4 j). Brak aktualnego IOB z Trio, więc dawki nie da się sprawdzić z insuliną aktywną: sprawdź, czy ta dawka nie powtarza już podanej.');
  });

  it('points out the same meal sent with a bolus from another screen or conversation, acknowledged when sent', async () => {
    class MealStore extends MemoryStore {
      async listRecentMealBoluses(patientId: string, since: string) {
        return this.rows.filter((row) => row.patient_id === patientId && row.carbs_g > 0 && row.insulin_u > 0 && row.authorized_at >= since);
      }
    }
    const store = new MealStore();
    const service = new RemoteCommandsService(store, contextWith({ iob: 0 }));
    const first = await service.authorize('p1', 'u1', request({ ...plain, insulin_u: 4.6 }), new Date(now.getTime() - 30 * 60_000));
    const sentAt = new Date(now.getTime() - 30 * 60_000);
    await service.reportSent('p1', 'u1', first.id, { accepted: true }, sentAt);
    await service.reportReply('p1', 'u1', first.id, { success: true, message: 'Bolus started' }, sentAt);
    const preview = await service.preview('p1', { carbs_g: 46, insulin_u: 4.6, bolus_step: 0.05, source: 'BOLUS_SCREEN' }, now);
    const same = preview.warnings.find((warning) => warning.code === 'ALREADY_SENT_FOR_MEAL');
    expect(same).toMatchObject({ severity: 'DANGER', key: `ALREADY_SENT_FOR_MEAL:command:${first.id}:${sentAt.toISOString()}` });
    // The same remote bolus is not said twice (RECENT_REMOTE_BOLUS).
    expect(preview.warnings.map((warning) => warning.code)).toEqual(['ALREADY_SENT_FOR_MEAL']);
    expect(same?.message).toBe('30 min temu wysłano z zakładki Bolus 46 g i 4,6 j (Naleśniki z serem). Jeśli to ten sam posiłek, ta dawka poda insulinę drugi raz.');
    await expect(service.authorize('p1', 'u1', request({ ...plain }), now)).rejects.toThrow(/REMOTE_COMMAND_WARNINGS_CHANGED: 30 min temu/);
    await expect(service.authorize('p1', 'u1', request({ acknowledged_warnings: [same!.key] }), now)).resolves.toMatchObject({ carbs_g: 46 });
    // Other carbs and another name: another meal.
    const other = await service.preview('p1', { carbs_g: 20, insulin_u: 2, bolus_step: 0.05 }, new Date(now.getTime() + 5 * 60_000));
    expect(other.warnings.map((warning) => warning.code)).not.toContain('ALREADY_SENT_FOR_MEAL');
  });

  it("requires the live dose warning with a card's own (DOSE_ABOVE_FORMULA said once, the live one kept); only a pre-bolus or WBT without carbs skips the calculator", async () => {
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const proposalId = '22222222-2222-4222-8222-222222222222';
    const formula = { code: 'DOSE_ABOVE_FORMULA' as const, key: 'DOSE_ABOVE_FORMULA:MEAL:4.6:2.2', severity: 'DANGER' as const, message: 'Dawka 4,6 j jest o 2,4 j większa, niż wychodzi z danych.' };
    let purpose = 'MEAL';
    const proposals = { get: async () => ({ conversation_id: conversationId, status: 'PROPOSED', expires_at: '2026-10-19T12:10:00.000Z', carbs_g: purpose === 'MEAL' ? 46 : 0, insulin_u: purpose === 'MEAL' ? 4.6 : 2, warnings: purpose === 'MEAL' ? [formula] : [], purpose }) };
    const service = new RemoteCommandsService(new MemoryStore(), contextWith(), proposals as never);
    const preview = await service.preview('p1', { carbs_g: 46, insulin_u: 4.6, bolus_step: 0.05, proposal_id: proposalId }, now);
    // The live warning is what is shown and acknowledged (review H2); the card's, saying the same, is left out.
    expect(preview.warnings.map((warning) => warning.key)).toEqual(['DOSE_ABOVE_CALCULATOR:4.6:2.2']);
    const card = { source: 'CHAT_CARD' as const, proposal_id: proposalId, conversation_id: conversationId, card_warnings_shown: true };
    await expect(service.authorize('p1', 'u1', request({ ...card, ...plain }), now)).rejects.toThrow(/REMOTE_COMMAND_WARNINGS_CHANGED: 4,6 j to o 2,4 j/);
    // The card's frozen warning alone no longer stands for the live one.
    await expect(service.authorize('p1', 'u1', request({ ...card, acknowledged_warnings: [formula.key] }), now)).rejects.toThrow(/REMOTE_COMMAND_WARNINGS_CHANGED: 4,6 j to o 2,4 j/);
    await expect(service.authorize('p1', 'u1', request({ ...card, acknowledged_warnings: ['DOSE_ABOVE_CALCULATOR:4.6:2.2'] }), now)).resolves.toMatchObject({ insulin_u: 4.6 });
    // PRE_BOLUS: insulin before carbs entered later is not compared with a calculator without them.
    purpose = 'PRE_BOLUS';
    const pre = await new RemoteCommandsService(new MemoryStore(), contextWith(), proposals as never).preview('p1', { carbs_g: 0, insulin_u: 2, bolus_step: 0.05, proposal_id: proposalId }, now);
    expect(pre.warnings.map((warning) => warning.code)).toEqual([]);
    // WBT insulin alone (fat and protein) is not held against the calculator either; insulin while low still is.
    const wbt = await new RemoteCommandsService(new MemoryStore(), contextWith()).preview('p1', { carbs_g: 0, insulin_u: 1, bolus_step: 0.05, source: 'WBT_SCREEN' }, now);
    expect(wbt.warnings.map((warning) => warning.code)).not.toContain('DOSE_ABOVE_CALCULATOR');
    // With carbs (its carbs-equivalent) it is, for those carbs (review M1): 10 / 10 + 0,2 − IOB 2,6 → 0 j.
    const wbtCarbs = await new RemoteCommandsService(new MemoryStore(), contextWith()).preview('p1', { carbs_g: 10, insulin_u: 1, bolus_step: 0.05, source: 'WBT_SCREEN' }, now);
    expect(wbtCarbs.warnings.map((warning) => warning.code)).toContain('DOSE_ABOVE_CALCULATOR');
    const wbtLow = await new RemoteCommandsService(new MemoryStore(), contextWith({ glucose: 64 })).preview('p1', { carbs_g: 10, insulin_u: 1, bolus_step: 0.05, source: 'WBT_SCREEN' }, now);
    expect(wbtLow.warnings.map((warning) => warning.code)).toContain('INSULIN_WHILE_LOW');
    // The same insulin alone from the Bolus tab is a correction: (120 − 100) / 100 − IOB 2,6 = 0 j.
    const correction = await new RemoteCommandsService(new MemoryStore(), contextWith()).preview('p1', { carbs_g: 0, insulin_u: 2, bolus_step: 0.05 }, now);
    expect(correction.warnings.map((warning) => warning.code)).toEqual(['DOSE_ABOVE_CALCULATOR']);
  });
});

describe('RemoteCommandsService dose safety: review fixes 2026-10-29', () => {
  const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const forecast = (options: { glucose?: number; iob?: number; cob?: number; loopAge?: number; per5?: number; lastCarbsAt?: string | null } = {}) => {
    const glucose = options.glucose ?? 120;
    const per5 = options.per5 ?? 0;
    return {
      readings: [3, 2, 1, 0].map((back) => ({ at: at(1 + back * 5), value: glucose - per5 * back })),
      prediction: {
        source: 'OPENAPS' as const, system: 'TRIO' as const, computed_at: at(options.loopAge ?? 1), bg: glucose, carbs_req_g: null, iob_u: options.iob ?? 2.6, cob_g: options.cob ?? 0,
        isf_mgdl_per_u: 100, icr_g_per_u: 10, eventual_bg: glucose, target_mgdl: 100, curves: { IOB: [glucose, glucose, glucose, glucose, glucose, glucose, glucose] },
      },
      profile_isf: 100,
      profile_target: 100,
      profile_units: 'mg/dl',
      last_carbs_at: options.lastCarbsAt ?? null,
    };
  };
  const contextWith = (options: Parameters<typeof forecast>[0] = {}, extra: Partial<RemoteCommandContext> = {}) => async () => ({
    ...baseContext(),
    glucose: { value: options.glucose ?? 120, observed_at: at(1), delta: options.per5 ?? 0 },
    lowest_recent_glucose: options.glucose ?? 120,
    last_bolus: null,
    ...extra,
    meal_forecast: forecast(options),
  });
  const plain = { acknowledged_warnings: [] as string[] };
  class RecentStore extends MemoryStore {
    failRecent = false;
    failMeals = false;
    async listRecent(patientId: string, since: string) {
      if (this.failRecent) throw new Error('db down');
      return this.rows.filter((row) => row.patient_id === patientId && row.authorized_at >= since).reverse();
    }
    async listRecentMealBoluses(patientId: string, since: string) {
      if (this.failMeals) throw new Error('db down');
      return this.rows.filter((row) => row.patient_id === patientId && row.carbs_g > 0 && row.insulin_u > 0 && row.authorized_at >= since);
    }
  }
  const quietly = async <T>(run: () => Promise<T>): Promise<{ result: T; logged: string[] }> => {
    const logged: string[] = [];
    const original = console.warn;
    console.warn = (line: string) => { logged.push(line); };
    try {
      return { result: await run(), logged };
    } finally {
      console.warn = original;
    }
  };

  it('H1: a low that appears only at authorization is shown again first (not "update the app"); carbs alone are never held', async () => {
    let glucose = 120;
    const service = new RemoteCommandsService(new MemoryStore(), async () => contextWith({ glucose, iob: 0 })());
    const preview = await service.preview('p1', { carbs_g: 20, insulin_u: 2, bolus_step: 0.05 }, now);
    expect(preview.warnings.map((warning) => warning.code)).toEqual([]);
    glucose = 66;
    await expect(service.authorize('p1', 'u1', request({ carbs_g: 20, insulin_u: 2, ...plain }), now)).rejects.toThrow(/REMOTE_COMMAND_WARNINGS_CHANGED: .*najpierw węglowodany/);
    await expect(service.authorize('p1', 'u1', request({ carbs_g: 20, insulin_u: 0, ...plain, meal: null }), now)).resolves.toMatchObject({ insulin_u: 0 });
  });

  it('H2: the live warnings are required from builds without card_warnings_shown too', async () => {
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const proposalId = '22222222-2222-4222-8222-222222222222';
    const proposals = { get: async () => ({ conversation_id: conversationId, status: 'PROPOSED', expires_at: '2026-10-19T12:10:00.000Z', carbs_g: 46, insulin_u: 4.6, warnings: [], purpose: 'MEAL' }) };
    const service = new RemoteCommandsService(new MemoryStore(), contextWith(), proposals as never);
    // An old build (no card_warnings_shown) that acknowledged nothing live: refused with the live dose warning.
    const old = { source: 'CHAT_CARD' as const, proposal_id: proposalId, conversation_id: conversationId };
    await expect(service.authorize('p1', 'u1', request({ ...old, ...plain }), now)).rejects.toThrow(/REMOTE_COMMAND_WARNINGS_CHANGED: 4,6 j to o 2,4 j/);
    await expect(service.authorize('p1', 'u1', request({ ...old, acknowledged_warnings: ['DOSE_ABOVE_CALCULATOR:4.6:2.2'] }), now)).resolves.toMatchObject({ insulin_u: 4.6 });
  });

  it('H2: a reference that moved between the card and the authorization (an SMB given meanwhile) is acknowledged anew', async () => {
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const proposalId = '22222222-2222-4222-8222-222222222222';
    const formula = { code: 'DOSE_ABOVE_FORMULA' as const, key: 'DOSE_ABOVE_FORMULA:MEAL:4.6:2.2', severity: 'DANGER' as const, message: 'Dawka 4,6 j jest o 2,4 j większa, niż wychodzi z danych.' };
    const proposals = { get: async () => ({ conversation_id: conversationId, status: 'PROPOSED', expires_at: '2026-10-19T12:10:00.000Z', carbs_g: 46, insulin_u: 4.6, warnings: [formula], purpose: 'MEAL' }) };
    let iob = 2.6;
    const service = new RemoteCommandsService(new MemoryStore(), async () => contextWith({ iob })(), proposals as never);
    const preview = await service.preview('p1', { carbs_g: 46, insulin_u: 4.6, bolus_step: 0.05, proposal_id: proposalId }, now);
    const shown = preview.warnings.map((warning) => warning.key);
    expect(shown).toEqual(['DOSE_ABOVE_CALCULATOR:4.6:2.2']);
    // An SMB of 0,5 j meanwhile: IOB 3,1 j, the calculator 1,7 j.
    iob = 3.1;
    const card = { source: 'CHAT_CARD' as const, proposal_id: proposalId, conversation_id: conversationId, card_warnings_shown: true };
    await expect(service.authorize('p1', 'u1', request({ ...card, acknowledged_warnings: [...shown, formula.key] }), now)).rejects.toThrow(/REMOTE_COMMAND_WARNINGS_CHANGED: 4,6 j to o 2,9 j więcej.*= 1,7 j/);
    await expect(service.authorize('p1', 'u1', request({ ...card, acknowledged_warnings: ['DOSE_ABOVE_CALCULATOR:4.6:1.7'] }), now)).resolves.toMatchObject({ insulin_u: 4.6 });
  });

  it('M1: an edited pre-bolus card with carbs is held against the calculator; without carbs it is not', async () => {
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const proposalId = '22222222-2222-4222-8222-222222222222';
    const proposals = { get: async () => ({ conversation_id: conversationId, status: 'PROPOSED', expires_at: '2026-10-19T12:10:00.000Z', carbs_g: 0, insulin_u: 2, warnings: [], purpose: 'PRE_BOLUS' }) };
    const service = new RemoteCommandsService(new MemoryStore(), contextWith(), proposals as never);
    const edited = await service.preview('p1', { carbs_g: 30, insulin_u: 3, bolus_step: 0.05, proposal_id: proposalId }, now);
    // 30 / 10 + 0,2 − 2,6 = 0,6 j: 3 j is far above.
    expect(edited.warnings.map((warning) => warning.code)).toContain('DOSE_ABOVE_CALCULATOR');
    const card = { source: 'CHAT_CARD' as const, proposal_id: proposalId, conversation_id: conversationId, card_warnings_shown: true };
    await expect(service.authorize('p1', 'u1', request({ ...card, carbs_g: 30, insulin_u: 3, acknowledged_warnings: edited.warnings.filter((warning) => warning.code !== 'DOSE_ABOVE_CALCULATOR').map((warning) => warning.key) }), now)).rejects.toThrow(/REMOTE_COMMAND_WARNINGS_CHANGED/);
    const unedited = await service.preview('p1', { carbs_g: 0, insulin_u: 2, bolus_step: 0.05, proposal_id: proposalId }, now);
    expect(unedited.warnings.map((warning) => warning.code)).not.toContain('DOSE_ABOVE_CALCULATOR');
  });

  it('M2: a planned part is held against the server\'s own later-part estimate (split 3,6 + 2,4 j), DANGER only above it', async () => {
    const planId = '33333333-3333-4333-8333-333333333333';
    const plan = { id: planId, status: 'SCHEDULED', meal_record_id: '44444444-4444-4444-8444-444444444444', planned_insulin_u: 2.4, fixed_insulin_u: null } as never;
    const plans = { get: async () => plan };
    // Part 1 (3,6 j) is in IOB 3,4 j and 10 g COB remain: the full calculator would say 0 j for part 2.
    const estimator = async () => 2.4;
    const service = new RemoteCommandsService(new MemoryStore(), contextWith({ iob: 3.4, cob: 10 }), null, plans, null, estimator);
    const part = { source: 'PLANNED_BOLUS' as const, planned_bolus_id: planId, carbs_g: 0, insulin_u: 2.4, meal: null };
    const preview = await service.preview('p1', { carbs_g: 0, insulin_u: 2.4, bolus_step: 0.05, source: 'PLANNED_BOLUS', planned_bolus_id: planId }, now);
    expect(preview.warnings.map((warning) => warning.code)).not.toContain('DOSE_ABOVE_CALCULATOR');
    // 2,4 + (120 − 100) / 100 = 2,6 j: the part's own dose needs no danger acknowledgement.
    expect(preview.dose_calculation).toMatchObject({ default_u: 2.4, reference_u: 2.6, breakdown: { iob_u: null, cob_g: 0 } });
    await expect(service.authorize('p1', 'u1', request({ ...part, acknowledged_warnings: preview.warnings.map((warning) => warning.key) }), now)).resolves.toMatchObject({ insulin_u: 2.4 });
    // 3,4 j is 0,8 j above it: DANGER.
    const more = await new RemoteCommandsService(new MemoryStore(), contextWith({ iob: 3.4, cob: 10 }), null, plans, null, estimator).preview('p1', { carbs_g: 0, insulin_u: 3.4, bolus_step: 0.05, source: 'PLANNED_BOLUS', planned_bolus_id: planId }, now);
    expect(more.warnings.find((warning) => warning.code === 'DOSE_ABOVE_CALCULATOR')?.key).toBe('DOSE_ABOVE_CALCULATOR:3.4:2.6');
    // Without an estimator: the part's planned dose is the reference.
    const plain2 = await new RemoteCommandsService(new MemoryStore(), contextWith({ iob: 3.4, cob: 10 }), null, plans).preview('p1', { carbs_g: 0, insulin_u: 2.4, bolus_step: 0.05, source: 'PLANNED_BOLUS', planned_bolus_id: planId }, now);
    expect(plain2.dose_calculation?.reference_u).toBe(2.6);
  });

  it('M4: a calculator that throws is logged and needs CALCULATOR_UNAVAILABLE acknowledged; the below-70 gate still holds', async () => {
    const broken = (glucose: number) => async () => ({ ...baseContext(), glucose: { value: glucose, observed_at: at(2), delta: 0 }, lowest_recent_glucose: glucose, last_bolus: null, meal_forecast: { readings: null } as never });
    const { result: preview, logged } = await quietly(() => new RemoteCommandsService(new MemoryStore(), broken(130)).preview('p1', { carbs_g: 30, insulin_u: 3, bolus_step: 0.05 }, now));
    expect(preview.warnings.map((warning) => warning.code)).toEqual(['CALCULATOR_UNAVAILABLE']);
    expect(preview.warnings[0].message).toBe('Kalkulator dawki niedostępny — sprawdź dawkę ręcznie.');
    expect(JSON.parse(logged[0])).toMatchObject({ event: 'dose_safety_check_failed', where: 'remote-commands.preview', patient_id: 'p1', error_class: 'TypeError' });
    expect(logged[0]).not.toMatch(/130/);
    const { result: refused } = await quietly(() => new RemoteCommandsService(new MemoryStore(), broken(130)).authorize('p1', 'u1', request({ carbs_g: 30, insulin_u: 3, ...plain }), now).catch((error) => error));
    expect(String(refused)).toMatch(/REMOTE_COMMAND_WARNINGS_CHANGED: Kalkulator dawki niedostępny/);
    const { result: ok } = await quietly(() => new RemoteCommandsService(new MemoryStore(), broken(130)).authorize('p1', 'u1', request({ carbs_g: 30, insulin_u: 3, acknowledged_warnings: ['CALCULATOR_UNAVAILABLE'] }), now));
    expect(ok.insulin_u).toBe(3);
    // Below 70 with the calculator broken: INSULIN_WHILE_LOW from the command's glucose, and the separate confirmation.
    const { result: low } = await quietly(() => new RemoteCommandsService(new MemoryStore(), broken(62)).preview('p1', { carbs_g: 30, insulin_u: 3, bolus_step: 0.05 }, now));
    expect(low.warnings.map((warning) => warning.key)).toContain('INSULIN_WHILE_LOW:BELOW_70:62');
    const keys = low.warnings.map((warning) => warning.key);
    const { result: lowRefused } = await quietly(() => new RemoteCommandsService(new MemoryStore(), broken(62)).authorize('p1', 'u1', request({ carbs_g: 30, insulin_u: 3, acknowledged_warnings: keys }), now).catch((error) => error));
    expect(String(lowRefused)).toMatch(/LOW_GLUCOSE_CONFIRMATION_REQUIRED/);
  });

  it('L2: the meal\'s own just-sent carbs (a carbs-only meal command) do not switch the near-low gate off; other carbs do', async () => {
    // 85 mg/dL falling 7 per 5 min: below 70 within ~30 min (the rescue alert's detection).
    const store = new RecentStore();
    const carbsAt = at(5);
    const service = new RemoteCommandsService(store, contextWith({ glucose: 85, per5: -7, iob: 0.3, lastCarbsAt: carbsAt }));
    // Carbs eaten 5 min ago that GlucoMind did not send: fast carbs may be working, no carbs-first.
    const other = await service.preview('p1', { carbs_g: 0, insulin_u: 1, bolus_step: 0.05 }, now);
    expect(other.warnings.map((warning) => warning.code)).not.toContain('INSULIN_WHILE_LOW');
    // The same carbs were this meal's, sent from the Bolus tab without insulin: the gate holds.
    const sent = await new RemoteCommandsService(store, contextWith({ glucose: 120, iob: 0 })).authorize('p1', 'u1', request({ carbs_g: 40, insulin_u: 0, ...plain }), new Date(now.getTime() - 6 * 60_000));
    await service.reportSent('p1', 'u1', sent.id, { accepted: true }, new Date(Date.parse(carbsAt)));
    await service.reportReply('p1', 'u1', sent.id, { success: true, message: 'Carbs added' }, new Date(Date.parse(carbsAt)));
    const own = await service.preview('p1', { carbs_g: 0, insulin_u: 1, bolus_step: 0.05 }, now);
    expect(own.warnings.map((warning) => warning.code)).toContain('INSULIN_WHILE_LOW');
    expect(own.warnings.find((warning) => warning.code === 'INSULIN_WHILE_LOW')?.key).toMatch(/^INSULIN_WHILE_LOW:PREDICTED_LOW:/);
    // The list unreadable: the gate stays on (fail closed), logged.
    store.failRecent = true;
    const { result: unreadable, logged } = await quietly(() => service.preview('p1', { carbs_g: 0, insulin_u: 1, bolus_step: 0.05 }, now));
    expect(unreadable.warnings.map((warning) => warning.code)).toContain('INSULIN_WHILE_LOW');
    expect(logged.some((line) => line.includes('remote-commands.own-meal-carbs'))).toBe(true);
  });

  it('L3: every remote bolus of the recent-insulin window counts, not only the newest of 30 min; each Nightscout bolus once', async () => {
    const store = new RecentStore();
    const recent = { window_minutes: 120, total_u: 2, manual_u: 2, smb_u: 0, remote_u: 0, newest_at: at(80), boluses: [{ at: at(80), units: 2 }] };
    // Two remote boluses that went out 80 and 50 min ago (outside the old 30-min look-back).
    const template = (await new RemoteCommandsService(new MemoryStore(), contextWith({ iob: 0 })).preview('p1', { carbs_g: 0, insulin_u: 1, bolus_step: 0.05 }, now)).context;
    for (const [minutes, units] of [[80, 2], [50, 1.5]] as const) {
      const sentAt = new Date(now.getTime() - minutes * 60_000);
      const row = await store.insert({ patient_id: 'p1', user_id: 'u1', device_id: 'd', source: 'BOLUS_SCREEN', conversation_id: null, proposal_id: null, follows_command_id: null, carbs_g: 0, insulin_u: units, bolus_step: 0.05, icr_g_per_u: 10, icr_insulin_u: null, meal_payload: null, purpose: null, rescue_alert_id: null, rescue_proposal_id: null, target_meal_record_id: null, planned_bolus_id: null, split_plan: null, reminders: null, create_meal: false, context: template, warnings: [], policy_version: 'x', send_deadline: new Date(sentAt.getTime() + 120_000).toISOString() } as never);
      await store.transition('p1', row.id, 'SENT', { sent_at: sentAt.toISOString() });
      await store.transition('p1', row.id, 'SUCCEEDED', {});
    }
    // The loop could not count them (no fresh IOB): the 2 j at 80 min is in Nightscout, the 1,5 j at 50 min not yet.
    const service = new RemoteCommandsService(store, contextWith({ loopAge: 40 }, { recent_insulin: recent }));
    const preview = await service.preview('p1', { carbs_g: 30, insulin_u: 3, bolus_step: 0.05 }, now);
    const warning = preview.warnings.find((item) => item.code === 'RECENT_INSULIN');
    expect(warning?.message).toMatch(/^W ostatnich 120 min podano 3,5 j \(bolusy 2 j, zdalny 1,5 j jeszcze bez Nightscout\)/);
  });

  it('L4: an unreadable same-meal check is logged and acknowledged (fail closed), never silently skipped', async () => {
    const store = new RecentStore();
    store.failMeals = true;
    const service = new RemoteCommandsService(store, contextWith({ iob: 0 }));
    const { result: preview, logged } = await quietly(() => service.preview('p1', { carbs_g: 46, insulin_u: 4.6, bolus_step: 0.05, source: 'BOLUS_SCREEN' }, now));
    expect(preview.warnings.map((warning) => [warning.code, warning.key, warning.severity])).toEqual([['SAME_MEAL_CHECK_UNAVAILABLE', 'SAME_MEAL_CHECK_UNAVAILABLE', 'DANGER']]);
    expect(JSON.parse(logged[0])).toMatchObject({ event: 'dose_safety_check_failed', where: 'remote-commands.same-meal', error_class: 'Error' });
    const { result: refused } = await quietly(() => service.authorize('p1', 'u1', request({ ...plain }), now).catch((error) => error));
    expect(String(refused)).toMatch(/REMOTE_COMMAND_WARNINGS_CHANGED: Nie udało się sprawdzić, czy ten posiłek już wysłano/);
    await quietly(async () => expect(await service.authorize('p1', 'u1', request({ acknowledged_warnings: ['SAME_MEAL_CHECK_UNAVAILABLE'] }), now)).toMatchObject({ insulin_u: 4.6 }));
  });
});
