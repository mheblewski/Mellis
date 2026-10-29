import { describe, expect, it } from 'vitest';
import { ConflictError, ValidationError } from '@shared/errors/app-error';
import type { RemoteCommandContext } from './application/remote-command-policy';
import type { NewRemoteCommand, RemoteCommandRecord, RemoteCommandStore } from './application/remote-command-record';
import { RemoteCommandsService } from './application/remote-commands.service';
import { matchRemoteCommand } from './application/remote-command-matching';

const now = new Date('2026-10-22T12:00:00.000Z');
const context = async (): Promise<Omit<RemoteCommandContext, 'in_flight_command_id' | 'recent_remote_bolus'>> => ({
  now: now.toISOString(),
  glucose: { value: 68, observed_at: '2026-10-22T11:58:00.000Z', delta: -4 },
  lowest_recent_glucose: 68,
  loop: { iob_units: 1.2, cob_grams: 0, observed_at: '2026-10-22T11:57:00.000Z' },
  last_bolus: null,
  icr_g_per_u: 10,
  bolus_history_known: true,
});

class Store implements Partial<RemoteCommandStore> {
  rows: RemoteCommandRecord[] = [];
  async insert(command: NewRemoteCommand): Promise<RemoteCommandRecord> {
    const record = { ...command, id: `cmd-${this.rows.length + 1}`, status: 'AUTHORIZED', trio_message: null, status_message: null, authorized_at: now.toISOString(), sent_at: null, answered_at: null, loop_action_id: null, meal_record_id: null, matched_at: null } as RemoteCommandRecord;
    this.rows.push(record);
    return record;
  }
  async findInFlight() { return null; }
  async findRecentWithInsulin() { return null; }
  async listForProposal() { return []; }
}

const rescueLink = (state: { treated?: boolean } = {}) => {
  const reserved: Array<Record<string, unknown>> = [];
  return {
    reserved,
    checkAvailable: async ({ alertId }: { alertId: string | null }) => (state.treated ? { status: 'ALREADY_LOGGED' as const, logged_by: 'Ewa' } : { status: 'OK' as const, alert_id: alertId }),
    reserveForCommand: async (args: Record<string, unknown>) => { reserved.push(args); return { alert_id: (args.alertId as string | null) ?? null, reserved: true }; },
  };
};

const request = { source: 'RESCUE_CARBS' as const, carbs_g: 8, insulin_u: 0, bolus_step: 0.05, device_id: 'd1', acknowledged_warnings: [], rescue_alert_id: 'a1' };

describe('rescue carbs to Trio (migration 064)', () => {
  it('withdraws the command when the card was logged meanwhile, and refuses another option of the same answer', async () => {
    const store = new Store() as Store & { transitions?: string[] };
    store.transitions = [];
    (store as unknown as { transition: (p: string, id: string, to: string) => Promise<null> }).transition = async (_p, _id, to) => { store.transitions!.push(to); return null; };
    const late = { ...rescueLink(), reserveForCommand: async () => ({ alert_id: null, reserved: false }) };
    const service = new RemoteCommandsService(store as unknown as RemoteCommandStore, context, null, null, late);
    await expect(service.authorize('p1', 'u1', { ...request, rescue_alert_id: null, rescue_proposal_id: '11111111-1111-4111-8111-111111111111' }, now)).rejects.toThrow('RESCUE_ALREADY_LOGGED');
    expect(store.transitions).toEqual(['SEND_FAILED']);

    const taken = new RemoteCommandsService(new Store() as unknown as RemoteCommandStore, context, null, null, { ...rescueLink(), takenOtherOption: async () => 'A' });
    await expect(taken.authorize('p1', 'u1', { ...request, rescue_alert_id: null, rescue_proposal_id: '11111111-1111-4111-8111-111111111111' }, now)).rejects.toThrow('Wybrano już opcję A');
    await expect(taken.authorize('p1', 'u1', { ...request, carbs_g: 60 }, now)).rejects.toThrow('at most 50 g');
  });

  it('sends carbs alone as a hypo treatment (no meal) and marks the alert treated by the command', async () => {
    const store = new Store();
    const rescue = rescueLink();
    const service = new RemoteCommandsService(store as unknown as RemoteCommandStore, context, null, null, rescue);
    const view = await service.authorize('p1', 'u1', { ...request, meal: { description: 'Sok' } }, now);
    expect(view).toMatchObject({ purpose: 'HYPO_TREATMENT', carbs_g: 8, insulin_u: 0 });
    expect(store.rows[0]).toMatchObject({ purpose: 'HYPO_TREATMENT', meal_payload: null, rescue_alert_id: 'a1', rescue_proposal_id: null });
    expect(rescue.reserved).toEqual([{ patientId: 'p1', commandId: 'cmd-1', alertId: 'a1', proposalId: null, carbsG: 8, atIso: now.toISOString(), userId: 'u1' }]);
  });

  it('refuses insulin, a second treatment, and rescue fields on other commands', async () => {
    const service = new RemoteCommandsService(new Store() as unknown as RemoteCommandStore, context, null, null, rescueLink());
    await expect(service.authorize('p1', 'u1', { ...request, insulin_u: 0.5 }, now)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.authorize('p1', 'u1', { ...request, source: 'BOLUS_SCREEN' }, now)).rejects.toBeInstanceOf(ValidationError);
    const treated = new RemoteCommandsService(new Store() as unknown as RemoteCommandStore, context, null, null, rescueLink({ treated: true }));
    await expect(treated.authorize('p1', 'u1', request, now)).rejects.toThrow('Dosłodzenie jest już zapisane (Ewa).');
    await expect(treated.authorize('p1', 'u1', request, now)).rejects.toBeInstanceOf(ConflictError);
    const without = new RemoteCommandsService(new Store() as unknown as RemoteCommandStore, context);
    await expect(without.authorize('p1', 'u1', request, now)).rejects.toBeInstanceOf(ValidationError);
  });

  it('matches its Trio entry as a hypo treatment, never a meal', () => {
    const command = { id: 'cmd-1', carbs_g: 8, insulin_u: 0, status: 'SENT', purpose: 'HYPO_TREATMENT', authorized_at: now.toISOString() } as RemoteCommandRecord;
    const match = matchRemoteCommand(command, [{ id: 'la1', started_at: '2026-10-22T12:00:20.000Z', purpose: null, carbs_g: 8, bolus_units: null, carb_event_id: 'e1' }], '2026-10-22T12:01:00.000Z');
    expect(match).toEqual({ loop_action_id: 'la1', purpose: 'HYPO_TREATMENT', settled_status: 'SUCCEEDED', status_message: 'Dosłodzenie zapisane w Trio (widoczne w Nightscout)' });
  });
});
