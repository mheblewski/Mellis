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
    expect(preview.forecast?.with_dose).not.toBeNull();
    expect(preview.context).not.toHaveProperty('forecast_inputs');
    await service.authorize('p1', 'u1', request(), now);
    expect(store.rows[0].context).not.toHaveProperty('forecast_inputs');
    expect((await new RemoteCommandsService(new MemoryStore(), async () => baseContext()).preview('p1', { carbs_g: 0, insulin_u: 1, bolus_step: 0.05 }, now)).forecast).toBeNull();
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
    await expect(low.authorize('p1', 'u1', request({ acknowledged_warnings: lowPreview.warnings.map((warning) => warning.key) }), now)).resolves.toMatchObject({ status: 'AUTHORIZED' });
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
