import { describe, expect, it } from 'vitest';
import { RemoteCommandReconciler } from './application/remote-command-reconciler';
import type { MatchableLoopAction } from './application/remote-command-matching';
import type { RemoteCommandRecord } from './application/remote-command-record';

const command = (overrides: Partial<RemoteCommandRecord> = {}): RemoteCommandRecord => ({
  id: 'c1', patient_id: 'p1', user_id: 'u1', device_id: 'd1', source: 'BOLUS_SCREEN', conversation_id: null, proposal_id: null,
  follows_command_id: null, carbs_g: 46, insulin_u: 4.6, bolus_step: 0.05, icr_g_per_u: 10, icr_insulin_u: 4.6, meal_payload: null, context: {} as never, warnings: [],
  policy_version: 'remote-commands.v1', status: 'SUCCEEDED', trio_message: null, status_message: null,
  authorized_at: '2026-10-19T12:00:00.000Z', send_deadline: '2026-10-19T12:02:00.000Z', sent_at: '2026-10-19T12:00:05.000Z', answered_at: null,
  loop_action_id: null, meal_record_id: null, matched_at: null, purpose: null, target_meal_record_id: null, planned_bolus_id: null, split_plan: null,
  ...overrides,
});
const action = (overrides: Partial<MatchableLoopAction> = {}): MatchableLoopAction & { meal_record_id: string | null } => ({
  id: 'a1', started_at: '2026-10-19T12:00:20.000Z', purpose: null, carbs_g: 46, bolus_units: 4.6, meal_record_id: null, ...overrides,
});

function setup(commands: RemoteCommandRecord[], actions: Array<MatchableLoopAction & { meal_record_id: string | null }>, options: { failReminders?: boolean } = {}) {
  const assigned: Array<{ actionId: string; purpose: string }> = [];
  const reminders: Array<{ commandId: string; kinds: string[]; mealId: string; entryAt: string }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  const joined: Array<[string, string]> = [];
  const ranges: Array<[string, string]> = [];
  const reconciler = new RemoteCommandReconciler({
    commands: {
      applyDeadlines: async () => [],
      listPatientsWithUnmatched: async () => (commands.some((item) => !item.loop_action_id) ? ['p1'] : []),
      listUnmatched: async () => commands.filter((item) => !item.loop_action_id && item.status !== 'REJECTED'),
      listMatchedWithInsulinSince: async () => [],
      markMatched: async (_p, id, match) => { Object.assign(commands.find((item) => item.id === id)!, { loop_action_id: match.loop_action_id, meal_record_id: match.meal_record_id }); },
      addMealNote: async (_command, _meal, content) => { notes.push(content); },
      get: async (_p, id) => commands.find((item) => item.id === id) ?? null,
    },
    loopActions: {
      listActionsBetween: async (_p, fromIso, toIso) => { ranges.push([fromIso, toIso]); return actions; },
      assign: async (args) => { assigned.push({ actionId: args.actionId, purpose: args.purpose }); },
      getAction: async () => ({ meal_record_id: 'meal-1' }),
      joinBolusToAction: async (_p, source, target) => { joined.push([source, target]); return true; },
    },
    meals: { findMealIdentityById: async () => 'identity-1', editContent: async () => 1 },
    bolusTabReminders: {
      createForMeal: async (created, requested, mealId, entryAt) => {
        if (options.failReminders) throw new Error('db down');
        reminders.push({ commandId: created.id, kinds: requested.map((reminder) => reminder.kind), mealId, entryAt });
      },
    },
    log: (event) => { logs.push(event); },
  });
  return { reconciler, assigned, notes, joined, reminders, logs, ranges };
}

describe('a command from the Bolus tab', () => {
  it('leaves its loop action for the caregiver to answer (no meal is saved)', async () => {
    const commands = [command()];
    const { reconciler, assigned, notes } = setup(commands, [action()]);
    await reconciler.run('2026-10-19T12:01:00.000Z');
    expect(assigned).toEqual([]);
    expect(notes).toEqual([]);
    // Still linked: the command is settled and a late bolus joins its action.
    expect(commands[0]).toMatchObject({ loop_action_id: 'a1', meal_record_id: null });
  });

  it('reads the actions up to the carbs of a meal eaten later (dated ahead of now)', async () => {
    const commands = [command({ context: { carbs_at: '2026-10-19T12:15:00.000Z' } as never })];
    const { reconciler, ranges } = setup(commands, [action({ started_at: '2026-10-19T12:15:00.000Z', bolus_units: null })]);
    await reconciler.run('2026-10-19T12:01:00.000Z');
    expect(ranges[0][1]).toBe('2026-10-19T12:16:00.000Z');
    expect(commands[0].loop_action_id).toBe('a1');
  });

  it('leaves a bolus alone unassigned too (it may be a correction or a pre-bolus)', async () => {
    const commands = [command({ carbs_g: 0, insulin_u: 1.5 })];
    const { reconciler, assigned } = setup(commands, [action({ carbs_g: null, bolus_units: 1.5 })]);
    await reconciler.run('2026-10-19T12:01:00.000Z');
    expect(assigned).toEqual([]);
    expect(commands[0].loop_action_id).toBe('a1');
  });

  it('keeps a retry of a refused Bolus tab command unassigned', async () => {
    const commands = [
      command({ id: 'c0', status: 'REJECTED', authorized_at: '2026-10-19T11:58:00.000Z' }),
      command({ id: 'c1', follows_command_id: 'c0' }),
    ];
    const { reconciler, assigned } = setup(commands, [action()]);
    await reconciler.run('2026-10-19T12:01:00.000Z');
    expect(assigned).toEqual([]);
    expect(commands[1].loop_action_id).toBe('a1');
  });

  it('joins the bolus retried after "carbs stored, bolus refused" to the carbs entry', async () => {
    const commands = [
      command({ id: 'c0', status: 'PARTIAL', loop_action_id: 'a0', authorized_at: '2026-10-19T11:58:00.000Z' }),
      command({ id: 'c1', follows_command_id: 'c0', carbs_g: 0 }),
    ];
    const { reconciler, assigned, joined } = setup(commands, [action({ carbs_g: null })]);
    await reconciler.run('2026-10-19T12:01:00.000Z');
    expect(joined).toEqual([['a1', 'a0']]);
    expect(assigned).toEqual([]);
  });
});

describe('a command from the Bolus tab ticked "Zapisz jako posiłek" (migration 089)', () => {
  it('becomes a meal with its note and no reminders', async () => {
    const commands = [command({ create_meal: true })];
    const { reconciler, assigned, notes, reminders } = setup(commands, [action()]);
    await reconciler.run('2026-10-19T12:01:00.000Z');
    expect(assigned).toEqual([{ actionId: 'a1', purpose: 'NEW_MEAL' }]);
    expect(notes).toEqual(['Posiłek zapisany z zakładki Bolus: 46 g węglowodanów, 4,6 j insuliny wysłane do Trio.']);
    expect(reminders).toEqual([]);
    expect(commands[0]).toMatchObject({ loop_action_id: 'a1', meal_record_id: 'meal-1' });
  });

  it('a retry keeps the tick of the refused command', async () => {
    const commands = [
      command({ id: 'c0', status: 'REJECTED', authorized_at: '2026-10-19T11:58:00.000Z', create_meal: true }),
      command({ id: 'c1', follows_command_id: 'c0' }),
    ];
    const { reconciler, assigned } = setup(commands, [action()]);
    await reconciler.run('2026-10-19T12:01:00.000Z');
    expect(assigned).toEqual([{ actionId: 'a1', purpose: 'NEW_MEAL' }]);
  });
});

describe('a command from the Bolus tab with reminders (bolus-reminders.v1)', () => {
  it('becomes a meal with its note and reminders, timed from the loop entry', async () => {
    const commands = [command({ reminders: [{ kind: 'WBT' }, { kind: 'SECOND_DOSE', trigger: 'GLUCOSE_RISING' }] })];
    const { reconciler, assigned, notes, reminders } = setup(commands, [action()]);
    await reconciler.run('2026-10-19T12:01:00.000Z');
    expect(assigned).toEqual([{ actionId: 'a1', purpose: 'NEW_MEAL' }]);
    expect(notes).toEqual(['Posiłek zapisany z zakładki Bolus: 46 g węglowodanów, 4,6 j insuliny wysłane do Trio.']);
    expect(reminders).toEqual([{ commandId: 'c1', kinds: ['WBT', 'SECOND_DOSE'], mealId: 'meal-1', entryAt: '2026-10-19T12:00:20.000Z' }]);
    expect(commands[0]).toMatchObject({ loop_action_id: 'a1', meal_record_id: 'meal-1' });
  });

  it('a retry without its own reminders keeps those of the refused command', async () => {
    const commands = [
      command({ id: 'c0', status: 'REJECTED', authorized_at: '2026-10-19T11:58:00.000Z', reminders: [{ kind: 'SECOND_DOSE', trigger: 'AFTER_MINUTES', minutes: 30 }] }),
      command({ id: 'c1', follows_command_id: 'c0' }),
    ];
    const { reconciler, assigned, reminders } = setup(commands, [action()]);
    await reconciler.run('2026-10-19T12:01:00.000Z');
    expect(assigned).toEqual([{ actionId: 'a1', purpose: 'NEW_MEAL' }]);
    expect(reminders.map((reminder) => [reminder.commandId, reminder.kinds])).toEqual([['c1', ['SECOND_DOSE']]]);
  });

  it('a bolus alone stays unassigned even with reminders (no carbs, no meal)', async () => {
    const commands = [command({ carbs_g: 0, insulin_u: 1.5, reminders: [{ kind: 'WBT' }] })];
    const { reconciler, assigned, reminders } = setup(commands, [action({ carbs_g: null, bolus_units: 1.5 })]);
    await reconciler.run('2026-10-19T12:01:00.000Z');
    expect(assigned).toEqual([]);
    expect(reminders).toEqual([]);
  });

  it('a failure to create the reminders is logged and never blocks the link', async () => {
    const commands = [command({ reminders: [{ kind: 'WBT' }] })];
    const { reconciler, logs } = setup(commands, [action()], { failReminders: true });
    await reconciler.run('2026-10-19T12:01:00.000Z');
    expect(commands[0]).toMatchObject({ loop_action_id: 'a1', meal_record_id: 'meal-1' });
    expect(logs.some((event) => event.event === 'bolus_tab_reminders_failed')).toBe(true);
  });

  it('without reminders nothing changes: no meal, no reminders', async () => {
    const commands = [command()];
    const { reconciler, assigned, reminders } = setup(commands, [action()]);
    await reconciler.run('2026-10-19T12:01:00.000Z');
    expect(assigned).toEqual([]);
    expect(reminders).toEqual([]);
  });
});

describe('a command whose meal the caregiver described', () => {
  it('saves the meal from a chat card at once', async () => {
    const commands = [command({ source: 'CHAT_CARD', proposal_id: 'pr1', conversation_id: 'cv1' })];
    const { reconciler, assigned, notes } = setup(commands, [action()]);
    await reconciler.run('2026-10-19T12:01:00.000Z');
    expect(assigned).toEqual([{ actionId: 'a1', purpose: 'NEW_MEAL' }]);
    expect(notes).toHaveLength(1);
    expect(commands[0].meal_record_id).toBe('meal-1');
  });

  it('treats a retry from the meal page (sent as BOLUS_SCREEN) as the meal\'s own', async () => {
    const commands = [
      command({ id: 'c0', source: 'NEW_MEAL', status: 'REJECTED', authorized_at: '2026-10-19T11:58:00.000Z' }),
      command({ id: 'c1', follows_command_id: 'c0' }),
    ];
    const { reconciler, assigned } = setup(commands, [action()]);
    await reconciler.run('2026-10-19T12:01:00.000Z');
    expect(assigned).toEqual([{ actionId: 'a1', purpose: 'NEW_MEAL' }]);
  });
});
