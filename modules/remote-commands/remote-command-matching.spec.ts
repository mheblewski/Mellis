import { describe, expect, it } from 'vitest';
import { findLateBolusAction, matchRemoteCommand, type MatchableLoopAction } from './application/remote-command-matching';
import type { RemoteCommandRecord } from './application/remote-command-record';

const command = (overrides: Partial<RemoteCommandRecord> = {}): RemoteCommandRecord => ({
  id: 'c1', patient_id: 'p1', user_id: 'u1', device_id: 'd1', source: 'BOLUS_SCREEN', conversation_id: null, proposal_id: null,
  follows_command_id: null, carbs_g: 46, insulin_u: 4.6, bolus_step: 0.05, icr_g_per_u: 10, icr_insulin_u: 4.6, meal_payload: null, context: {} as never, warnings: [],
  policy_version: 'remote-commands.v1', status: 'SUCCEEDED', trio_message: null, status_message: null,
  authorized_at: '2026-10-19T12:00:00.000Z', send_deadline: '2026-10-19T12:02:00.000Z', sent_at: '2026-10-19T12:00:05.000Z', answered_at: null,
  loop_action_id: null, meal_record_id: null, matched_at: null, purpose: null, target_meal_record_id: null,
  ...overrides,
});
const action = (overrides: Partial<MatchableLoopAction> = {}): MatchableLoopAction => ({ id: 'a1', started_at: '2026-10-19T12:00:20.000Z', purpose: null, carbs_g: 46, bolus_units: 4.6, ...overrides });
const at = '2026-10-19T12:01:00.000Z';

describe('matching a command to the loop action it produced', () => {
  it('links the same carbs and bolus as a new meal', () => {
    expect(matchRemoteCommand(command(), [action()], at)).toEqual({ loop_action_id: 'a1', purpose: 'NEW_MEAL', settled_status: null, status_message: null });
    // From the WBT window: the same entries are the meal's WBT.
    expect(matchRemoteCommand(command({ source: 'WBT_SCREEN', purpose: 'WBT', target_meal_record_id: 'm1' }), [action()], at)?.purpose).toBe('WBT');
    // A correction card's carbs are correction carbs, not a new meal.
    expect(matchRemoteCommand(command({ source: 'CHAT_CARD', card_purpose: 'CORRECTION', insulin_u: 0 }), [action({ bolus_units: null })], at)?.purpose).toBe('CORRECTION');
  });

  it('settles a command still waiting for Trio from what Nightscout shows', () => {
    expect(matchRemoteCommand(command({ status: 'NO_REPLY' }), [action()], at)?.settled_status).toBe('SUCCEEDED');
    // Carbs alone two minutes later: linked (no "na co to było?" push) but not settled, the bolus may still come.
    const carbsOnly = matchRemoteCommand(command({ status: 'NO_REPLY' }), [action({ bolus_units: null })], '2026-10-19T12:02:30.000Z');
    expect(carbsOnly).toMatchObject({ settled_status: null, purpose: 'NEW_MEAL' });
  });

  it('waits for the bolus to join the carbs before linking, unless Trio confirmed the bolus', () => {
    expect(matchRemoteCommand(command({ status: 'SENT' }), [action({ bolus_units: null })], at)).toBeNull();
    // "Bolus started" came back: the meal is saved from the carbs now, the bolus joins it when it syncs.
    expect(matchRemoteCommand(command(), [action({ bolus_units: null })], at)).toMatchObject({ loop_action_id: 'a1', purpose: 'NEW_MEAL', settled_status: null });
    // Trio refused the bolus: the carbs alone are the command's entry.
    expect(matchRemoteCommand(command({ status: 'PARTIAL' }), [action({ bolus_units: null })], at)?.loop_action_id).toBe('a1');
  });

  it('links a correction bolus without carbs', () => {
    expect(matchRemoteCommand(command({ carbs_g: 0, insulin_u: 1.5 }), [action({ carbs_g: null, bolus_units: 1.5 })], at)?.purpose).toBe('CORRECTION');
  });

  it('leaves other actions to the caregiver', () => {
    expect(matchRemoteCommand(command(), [action({ carbs_g: 45 })], at)).toBeNull();
    expect(matchRemoteCommand(command(), [action({ bolus_units: 4.0 })], at)).toBeNull();
    expect(matchRemoteCommand(command(), [action({ purpose: 'NEW_MEAL' })], at)).toBeNull();
    expect(matchRemoteCommand(command(), [action({ started_at: '2026-10-19T11:55:00.000Z' })], at)).toBeNull();
    expect(matchRemoteCommand(command(), [action({ started_at: '2026-10-19T12:25:00.000Z' })], at)).toBeNull();
  });

  it('never takes an action another command is matched to (a Bolus tab dose leaves it without a purpose)', () => {
    // The same dose sent again 25 s later: the earlier dose's carbs and bolus are not this command's.
    const earlier = action({ id: 'earlier', started_at: '2026-10-19T11:59:35.000Z', linked_to_command: true });
    expect(matchRemoteCommand(command({ status: 'SENT' }), [earlier], at)).toBeNull();
    expect(matchRemoteCommand(command({ status: 'SENT' }), [earlier, action({ id: 'own' })], at)).toMatchObject({ loop_action_id: 'own', settled_status: 'SUCCEEDED' });
  });

  it('takes the action closest to the command', () => {
    const far = action({ id: 'far', started_at: '2026-10-19T12:10:00.000Z' });
    const near = action({ id: 'near', started_at: '2026-10-19T12:00:30.000Z' });
    expect(matchRemoteCommand(command(), [far, near], at)?.loop_action_id).toBe('near');
  });
});

describe('a meal eaten later (Bolus tab "+15 min")', () => {
  // Trio dates the carbs at carbs_at, the bolus now: two actions, outside the loop's grouping window.
  const scheduled = (overrides: Partial<RemoteCommandRecord> = {}) => command({ context: { carbs_at: '2026-10-19T12:15:00.000Z' } as never, ...overrides });
  const carbs = action({ id: 'carbs', bolus_units: null, started_at: '2026-10-19T12:15:00.000Z' });
  const bolus = action({ id: 'bolus', carbs_g: null, started_at: '2026-10-19T12:00:20.000Z' });

  it('links the carbs dated later and settles the command from its own bolus', () => {
    expect(matchRemoteCommand(scheduled({ status: 'NO_REPLY' }), [bolus, carbs], at)).toEqual({ loop_action_id: 'carbs', purpose: 'NEW_MEAL', settled_status: 'SUCCEEDED', status_message: 'Bolus podany (widoczny w Nightscout)' });
    expect(matchRemoteCommand(scheduled(), [bolus, carbs], at)?.loop_action_id).toBe('carbs');
    // Without the bolus in Nightscout nor Trio's "Bolus started": it waits, as for carbs now.
    expect(matchRemoteCommand(scheduled({ status: 'SENT' }), [carbs], at)).toBeNull();
    // The bolus then joins the carbs' action.
    const meal = { ...carbs, purpose: 'NEW_MEAL' as const };
    expect(findLateBolusAction(scheduled({ loop_action_id: 'carbs' }), meal, [meal, bolus])?.id).toBe('bolus');
  });

  it('reaches carbs dated up to the longest delay ahead', () => {
    const later = scheduled({ context: { carbs_at: '2026-10-19T12:30:00.000Z' } as never });
    expect(matchRemoteCommand(later, [action({ id: 'carbs', bolus_units: null, started_at: '2026-10-19T12:30:00.000Z' })], at)?.loop_action_id).toBe('carbs');
    expect(matchRemoteCommand(command(), [action({ id: 'carbs', bolus_units: null, started_at: '2026-10-19T12:30:00.000Z' })], at)).toBeNull();
  });
});

describe('a bolus that synced after its carbs', () => {
  it('is found for the meal saved from the carbs alone', () => {
    const meal = action({ id: 'meal', purpose: 'NEW_MEAL', bolus_units: null });
    const lateBolus = action({ id: 'late', carbs_g: null, bolus_units: 4.6, started_at: '2026-10-19T12:00:40.000Z' });
    expect(findLateBolusAction(command({ loop_action_id: 'meal' }), meal, [meal, lateBolus])?.id).toBe('late');
    expect(findLateBolusAction(command({ loop_action_id: 'meal' }), meal, [meal, { ...lateBolus, bolus_units: 3 }])).toBeNull();
    expect(findLateBolusAction(command({ loop_action_id: 'meal' }), { ...meal, bolus_units: 4.6 }, [meal, lateBolus])).toBeNull();
    expect(findLateBolusAction(command({ loop_action_id: 'meal', status: 'PARTIAL' }), meal, [meal, lateBolus])).toBeNull();
  });
});

