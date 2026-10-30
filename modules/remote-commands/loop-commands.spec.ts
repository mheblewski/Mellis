import { describe, expect, it } from 'vitest';
import { ConflictError, ValidationError } from '@shared/errors/app-error';
import { toTherapyContextEvent } from '@modules/integrations/nightscout/application/therapy-context-events';
import { classifyLoopReply, describeLoopReply, loopRemoteAddress, readLoopRemoteAddress, translateLoopReason } from './application/loop-reply';
import { readLoopRemoteTarget } from './application/loop-remote-target';
import { RemoteCommandReconciler } from './application/remote-command-reconciler';
import { RemoteCommandsService, type RemoteCommandRequest } from './application/remote-commands.service';
import type { NewRemoteCommand, RemoteCommandRecord, RemoteCommandStore } from './application/remote-command-record';
import { canTransitionRemoteCommand, IN_FLIGHT_STATUSES, type RemoteCommandStatus } from './application/remote-command-status';
import type { RemoteCommandContext } from './application/remote-command-policy';

const COMMAND_ID = '00000000-0000-4000-8000-000000000001';

describe('Loop\'s answers (loop-reply)', () => {
  it('settles a meal in two steps: carbs confirmed keep it waiting for the bolus, a refused bolus leaves the carbs', () => {
    const meal = { carbs_g: 40, insulin_u: 4 };
    expect(classifyLoopReply({ step: 'carbs', success: true, ...meal })).toBe('TRIO_ACCEPTED');
    expect(classifyLoopReply({ step: 'carbs', success: false, ...meal })).toBe('REJECTED');
    expect(classifyLoopReply({ step: 'bolus', success: true, ...meal })).toBe('SUCCEEDED');
    expect(classifyLoopReply({ step: 'bolus', success: false, ...meal })).toBe('PARTIAL');
    // Carbs alone and a bolus alone are settled by their only answer.
    expect(classifyLoopReply({ step: 'carbs', success: true, carbs_g: 15, insulin_u: 0 })).toBe('SUCCEEDED');
    expect(classifyLoopReply({ step: 'bolus', success: false, carbs_g: 0, insulin_u: 1 })).toBe('REJECTED');
  });

  it('says Loop\'s reasons in Polish, from its own wording', () => {
    expect(translateLoopReason('Command failed: Exceeds maximum allowed bolus in settings')).toBe('bolus przekracza maksymalny bolus w Loopie');
    expect(translateLoopReason('Error: Password 123456 was already used. Wait for a new password for each command.')).toBe('kod jednorazowy był już użyty');
    expect(translateLoopReason('Error: Password sent at 3:05 has expired. Only the last 2 passwords are accepted. See LoopDocs for troubleshooting.')).toContain('kod jednorazowy wygasł');
    expect(translateLoopReason('Error: Password is incorrect: 123456.')).toContain('zły kod jednorazowy');
    expect(translateLoopReason('Expired')).toBe('polecenie dotarło za późno');
    // Unknown (or already Polish) text stays as Loop wrote it.
    expect(translateLoopReason('Command failed: Pompa nie odpowiada')).toBe('Pompa nie odpowiada');
    expect(describeLoopReply('PARTIAL', 'Command failed: Exceeds maximum allowed bolus in settings', 4)).toBe('Węglowodany zapisane w Loopie, bolus odrzucony: bolus przekracza maksymalny bolus w Loopie');
    expect(describeLoopReply('TRIO_ACCEPTED', 'Carbs entry of 40.0 g delivered successfully', 4)).toBe('Węglowodany zapisane w Loopie, wysyłam bolus…');
  });

  it('names a push by command and step in its remote-address, and reads only its own', () => {
    expect(loopRemoteAddress(COMMAND_ID, 'bolus')).toBe(`Mellis:${COMMAND_ID}:bolus`);
    expect(readLoopRemoteAddress(`Mellis:${COMMAND_ID}:bolus`)).toEqual({ command_id: COMMAND_ID, step: 'bolus' });
    expect(readLoopRemoteAddress('LoopFollow')).toBeNull();
    expect(readLoopRemoteAddress(`Mellis:${COMMAND_ID}`)).toBeNull();
  });
});

describe('Loop\'s address (loop-remote-target)', () => {
  const loopProfile = (settings: Record<string, unknown>) => ({ enteredBy: 'Loop', startDate: '2026-10-28T08:00:00Z', isAPNSProduction: false, loopSettings: settings });

  it('is ready with Loop\'s token and bundle; the team comes from a LoopWorkspace bundle id only', () => {
    expect(readLoopRemoteTarget(loopProfile({ deviceToken: 'AB'.repeat(32), bundleIdentifier: 'com.ABCDE12345.loopkit.Loop' }), null))
      .toMatchObject({ status: 'READY', device_token: 'ab'.repeat(32), team_id: 'ABCDE12345', apns_environment: 'sandbox' });
    expect(readLoopRemoteTarget(loopProfile({ deviceToken: 'ab'.repeat(32), bundleIdentifier: 'pl.example.MyLoop' }), null)).toMatchObject({ status: 'READY', team_id: null });
  });

  it('says what is missing: no token yet, not Loop\'s profile (Trio\'s), no profile', () => {
    expect(readLoopRemoteTarget(loopProfile({ bundleIdentifier: 'com.ABCDE12345.loopkit.Loop' }), null).status).toBe('MISSING_TOKEN');
    expect(readLoopRemoteTarget({ bundleIdentifier: 'org.nightscout.X.trio', deviceToken: 'ab'.repeat(32), teamID: 'ABCDE12345', isAPNSProduction: true }, null).status).toBe('NOT_LOOP');
    expect(readLoopRemoteTarget(null, null).status).toBe('NO_PROFILE');
  });
});

describe('a note Loop wrote for a refused push (therapy-context-events)', () => {
  it('keeps the error and the push\'s remote-address, never its JSON', () => {
    const push = JSON.stringify({ 'bolus-entry': 2, otp: '123456', 'remote-address': `Mellis:${COMMAND_ID}:bolus`, encrypted_return_notification: 'x'.repeat(600) });
    const event = toTherapyContextEvent({ _id: 'n1', eventType: 'Note', created_at: '2026-10-28T12:00:30.000Z', enteredBy: 'Bolus Entry (2.0 U)', notes: `Error: Password 123456 was already used. Wait for a new password for each command.\n${push}` } as any);
    expect(event?.details).toEqual({ notes: 'Error: Password 123456 was already used. Wait for a new password for each command.', remote_address: `Mellis:${COMMAND_ID}:bolus` });
    // An ordinary note is kept as it is.
    expect(toTherapyContextEvent({ _id: 'n2', eventType: 'Note', created_at: '2026-10-28T12:00:30.000Z', notes: 'Basen 45 min' } as any)?.details).toEqual({ notes: 'Basen 45 min' });
  });
});

class MemoryStore implements RemoteCommandStore {
  rows: RemoteCommandRecord[] = [];
  async requestNightscoutSync() {}
  async insert(command: NewRemoteCommand): Promise<RemoteCommandRecord> {
    if (this.rows.some((row) => row.patient_id === command.patient_id && IN_FLIGHT_STATUSES.has(row.status))) throw new ConflictError('COMMAND_IN_FLIGHT');
    const record = { ...command, id: COMMAND_ID, status: 'AUTHORIZED', trio_message: null, status_message: null, authorized_at: NOW.toISOString(), send_deadline: new Date(NOW.getTime() + 120_000).toISOString(), sent_at: null, answered_at: null, loop_action_id: null, meal_record_id: null, matched_at: null } as RemoteCommandRecord;
    this.rows.push(record);
    return record;
  }
  async get(patientId: string, id: string) { return this.rows.find((row) => row.patient_id === patientId && row.id === id) ?? null; }
  async list(patientId: string) { return this.rows.filter((row) => row.patient_id === patientId); }
  async findInFlight(patientId: string) { return this.rows.find((row) => row.patient_id === patientId && IN_FLIGHT_STATUSES.has(row.status)) ?? null; }
  async recordSentAt() {}
  async listForProposal() { return []; }
  async listForPlannedBolus() { return []; }
  async listWbtForMeal() { return []; }
  async findRecentWithInsulin() { return null; }
  async transition(patientId: string, id: string, to: RemoteCommandStatus, fields: Record<string, unknown>) {
    const row = await this.get(patientId, id);
    if (!row || !canTransitionRemoteCommand(row.status, to)) return null;
    Object.assign(row, { status: to }, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
    return row;
  }
}

const NOW = new Date('2026-10-28T12:00:00.000Z');
const context = (loopSystem: RemoteCommandContext['loop_system']) => async (): Promise<Omit<RemoteCommandContext, 'in_flight_command_id' | 'recent_remote_bolus'>> => ({
  now: NOW.toISOString(),
  glucose: { value: 140, observed_at: '2026-10-28T11:58:00.000Z', delta: 1 },
  lowest_recent_glucose: 130,
  loop: { iob_units: 0.2, cob_grams: 0, observed_at: '2026-10-28T11:58:00.000Z' },
  last_bolus: null,
  icr_g_per_u: 10,
  bolus_history_known: true,
  loop_system: loopSystem,
});
const request = (overrides: Partial<RemoteCommandRequest> = {}): RemoteCommandRequest => ({
  source: 'BOLUS_SCREEN', carbs_g: 40, insulin_u: 4, bolus_step: 0.05, device_id: 'phone-1', acknowledged_warnings: [], ...overrides,
});

describe('remote commands to Loop (RemoteCommandsService)', () => {
  it('authorizes a command only for the driver of the patient\'s loop: an older build never sends Trio\'s command to Loop', async () => {
    const toLoop = new RemoteCommandsService(new MemoryStore(), context('LOOP'));
    await expect(toLoop.authorize('p1', 'u1', request(), NOW)).rejects.toThrow('zaktualizuj aplikację Mellis');
    await expect(toLoop.authorize('p1', 'u1', request({ driver: 'TRIO' }), NOW)).rejects.toBeInstanceOf(ConflictError);
    expect((await toLoop.authorize('p1', 'u1', request({ driver: 'LOOP' }), NOW)).status).toBe('AUTHORIZED');
    const toTrio = new RemoteCommandsService(new MemoryStore(), context('TRIO'));
    await expect(toTrio.authorize('p1', 'u1', request({ driver: 'LOOP' }), NOW)).rejects.toThrow('LOOP_DRIVER_MISMATCH');
    await expect(new RemoteCommandsService(new MemoryStore(), context('AAPS')).authorize('p1', 'u1', request({ driver: 'TRIO' }), NOW)).rejects.toThrow('nie wysyła poleceń do AAPS');
  });

  it('takes Loop\'s answers step by step and names Loop in the status', async () => {
    const store = new MemoryStore();
    const service = new RemoteCommandsService(store, context('LOOP'));
    const command = await service.authorize('p1', 'u1', request({ driver: 'LOOP' }), NOW);
    expect((await service.reportSent('p1', 'u1', command.id, { accepted: true }, NOW)).status_message).toBe('Polecenie wysłane, czekam na odpowiedź Loopa.');
    await expect(service.reportReply('p1', 'u1', command.id, { success: true, message: 'Carbs entry of 40.0 g delivered successfully' }, NOW)).rejects.toBeInstanceOf(ValidationError);
    expect((await service.reportReply('p1', 'u1', command.id, { success: true, message: 'Carbs entry of 40.0 g delivered successfully', step: 'carbs' }, NOW)).status).toBe('TRIO_ACCEPTED');
    const refused = await service.reportReply('p1', 'u1', command.id, { success: false, message: 'Command failed: Exceeds maximum allowed bolus in settings', step: 'bolus' }, NOW);
    expect(refused).toMatchObject({ status: 'PARTIAL', status_message: 'Węglowodany zapisane w Loopie, bolus odrzucony: bolus przekracza maksymalny bolus w Loopie' });
  });

  it('says a withheld bolus was never sent, and a late confirmation of the carbs makes it carbs only', async () => {
    const service = new RemoteCommandsService(new MemoryStore(), context('LOOP'));
    const command = await service.authorize('p1', 'u1', request({ driver: 'LOOP' }), NOW);
    await service.reportSent('p1', 'u1', command.id, { accepted: true }, NOW);
    const withheld = await service.reportReply('p1', 'u1', command.id, { success: false, message: 'Loop nie potwierdził węglowodanów w 90 s', step: 'bolus', withheld: true }, NOW);
    expect(withheld.status).toBe('NO_REPLY');
    expect(withheld.status_message).toContain('bolusu nie wysłano');
    const late = await service.reportReply('p1', 'u1', command.id, { success: false, message: 'Bolus nie został wysłany: Loop potwierdził węglowodany po czasie.', step: 'bolus' }, NOW);
    expect(late.status).toBe('PARTIAL');
    // Only a Loop meal has a bolus to withhold.
    const toTrio = new RemoteCommandsService(new MemoryStore(), context('TRIO'));
    const trio = await toTrio.authorize('p1', 'u1', request(), NOW);
    await expect(toTrio.reportReply('p1', 'u1', trio.id, { success: false, message: 'x', step: 'bolus', withheld: true }, NOW)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('Loop\'s refusal notes (RemoteCommandReconciler)', () => {
  const record = (overrides: Partial<RemoteCommandRecord>): RemoteCommandRecord => ({
    id: COMMAND_ID, patient_id: 'p1', user_id: 'u1', device_id: 'd1', source: 'BOLUS_SCREEN', conversation_id: null, proposal_id: null, follows_command_id: null,
    carbs_g: 40, insulin_u: 4, bolus_step: 0.05, icr_g_per_u: 10, icr_insulin_u: 4, meal_payload: null, context: { loop_system: 'LOOP' } as never, warnings: [],
    policy_version: 'remote-commands.v1', status: 'SENT', trio_message: null, status_message: null, authorized_at: NOW.toISOString(), send_deadline: NOW.toISOString(),
    sent_at: NOW.toISOString(), answered_at: null, loop_action_id: null, meal_record_id: null, matched_at: null, purpose: null, target_meal_record_id: null, planned_bolus_id: null, split_plan: null,
    ...overrides,
  });

  function run(command: RemoteCommandRecord, step: 'carbs' | 'bolus') {
    const store = new MemoryStore();
    store.rows.push(command);
    const reconciler = new RemoteCommandReconciler({
      commands: { applyDeadlines: async () => [], listPatientsWithUnmatched: async () => [], listUnmatched: async () => [], listMatchedWithInsulinSince: async () => [], markMatched: async () => {}, addMealNote: async () => {}, get: (patientId, id) => store.get(patientId, id) },
      loopActions: { listActionsBetween: async () => [], assign: async () => {}, getAction: async () => null, joinBolusToAction: async () => false },
      meals: { findMealIdentityById: async () => null, editContent: async () => 0 },
      loopRefusals: {
        listSince: async () => [{ patient_id: 'p1', remote_address: `Mellis:${COMMAND_ID}:${step}`, notes: 'Error: Password 123456 was already used. Wait for a new password for each command.' }],
        transition: (patientId, id, to, fields) => store.transition(patientId, id, to, fields),
      },
      log: () => {},
    });
    return { store, done: reconciler.run('2026-10-28T12:03:00.000Z') };
  }

  it('settles refused carbs as REJECTED and a refused bolus after confirmed carbs as PARTIAL, with Loop\'s reason', async () => {
    const carbs = run(record({ status: 'SENT' }), 'carbs');
    await carbs.done;
    expect(carbs.store.rows[0]).toMatchObject({ status: 'REJECTED', status_message: 'Błąd: kod jednorazowy był już użyty' });
    const bolus = run(record({ status: 'TRIO_ACCEPTED' }), 'bolus');
    await bolus.done;
    expect(bolus.store.rows[0].status).toBe('PARTIAL');
  });

  it('leaves a Trio command and a settled one as they are', async () => {
    const trio = run(record({ context: { loop_system: 'TRIO' } as never }), 'carbs');
    await trio.done;
    expect(trio.store.rows[0].status).toBe('SENT');
    const settled = run(record({ status: 'SUCCEEDED' }), 'bolus');
    await settled.done;
    expect(settled.store.rows[0].status).toBe('SUCCEEDED');
  });
});
