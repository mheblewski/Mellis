import { describe, expect, it } from 'vitest';
import { evaluateRemoteCommand, insulinForCarbs, pumpBolusStep, roundDownToStep, type RemoteCommandContext } from './application/remote-command-policy';
import { canTransitionRemoteCommand, classifyTrioReply, describeTrioReply, translateTrioReason } from './application/remote-command-status';

const now = '2026-10-19T12:00:00.000Z';
const minutesAgo = (minutes: number) => new Date(Date.parse(now) - minutes * 60_000).toISOString();
const context = (overrides: Partial<RemoteCommandContext> = {}): RemoteCommandContext => ({
  now,
  glucose: { value: 140, observed_at: minutesAgo(3), delta: 2 },
  lowest_recent_glucose: 120,
  loop: { iob_units: 0.8, cob_grams: 0, observed_at: minutesAgo(4) },
  last_bolus: { at: minutesAgo(180), units: 3 },
  icr_g_per_u: 10,
  in_flight_command_id: null,
  bolus_history_known: true,
  recent_remote_bolus: null,
  ...overrides,
});
const evaluate = (carbs: number, insulin: number, ctx = context()) => evaluateRemoteCommand({ carbs_g: carbs, insulin_u: insulin, bolus_step: 0.05, context: ctx });
const codes = (items: Array<{ code: string }>) => items.map((item) => item.code);

describe('dose from carbs', () => {
  it('rounds down to the pump step, never up', () => {
    expect(roundDownToStep(4.56, 0.05)).toBe(4.55);
    expect(roundDownToStep(4.55, 0.05)).toBe(4.55);
    expect(roundDownToStep(4.59, 0.1)).toBe(4.5);
    expect(roundDownToStep(0.04, 0.05)).toBe(0);
    expect(insulinForCarbs(46, 10, 0.05)).toBe(4.6);
    expect(insulinForCarbs(46, 12, 0.05)).toBe(3.8);
    expect(insulinForCarbs(46, null, 0.05)).toBeNull();
    expect(insulinForCarbs(0, 10, 0.05)).toBeNull();
  });
});

describe('remote command checks', () => {
  it("uses the pump's reported step when GlucoMind can round to it", () => {
    expect(pumpBolusStep(0.1)).toBe(0.1);
    expect(pumpBolusStep(0.05)).toBe(0.05);
    expect(pumpBolusStep(0.025)).toBe(0.05);
    expect(pumpBolusStep(0.5)).toBeNull();
    expect(pumpBolusStep(0.03)).toBeNull();
    expect(pumpBolusStep(null)).toBeNull();
    expect(pumpBolusStep(undefined)).toBeNull();
    expect(pumpBolusStep(0)).toBeNull();
  });

  it('lets a usual meal bolus through with no warnings', () => {
    expect(evaluate(46, 4.6)).toEqual({ icr_insulin_u: 4.6, blocks: [], warnings: [] });
  });

  it('never blocks insulin over the patient\'s data: a low, missing glucose, a stale loop or no ICR are warnings', () => {
    const check = (input: Partial<RemoteCommandContext>) => {
      const result = evaluate(46, 4.6, context(input));
      expect(result.blocks).toEqual([]);
      return codes(result.warnings);
    };
    expect(check({ glucose: null })).toEqual(['NO_GLUCOSE']);
    expect(check({ glucose: { value: 140, observed_at: minutesAgo(31), delta: null } })).toEqual(['GLUCOSE_STALE']);
    expect(check({ loop: { iob_units: 1, cob_grams: 0, observed_at: minutesAgo(40) } })).toEqual(['LOOP_STALE']);
    expect(check({ loop: null })).toEqual(['LOOP_STALE']);
    expect(check({ glucose: { value: 65, observed_at: minutesAgo(2), delta: -3 } })).toEqual(['LOW_GLUCOSE']);
    expect(check({ lowest_recent_glucose: 62 })).toEqual(['LOW_GLUCOSE']);
    expect(check({ icr_g_per_u: null })).toEqual(['NO_THERAPY_PROFILE']);
    expect(check({ bolus_history_known: false })).toEqual(['INSULIN_HISTORY_UNAVAILABLE']);
    // The screenshot of 2026-10-19: 70 mg/dL after a dip and no loop report for 30+ min: both said, nothing blocked.
    expect(check({ glucose: { value: 70, observed_at: minutesAgo(4), delta: 2 }, lowest_recent_glucose: 66, loop: { iob_units: 0.69, cob_grams: 28, observed_at: minutesAgo(35) } })).toEqual(['LOW_GLUCOSE', 'LOOP_STALE']);
    expect(evaluate(46, 4.6, context({ glucose: { value: 65, observed_at: minutesAgo(2), delta: -3 } })).warnings[0].message).toBe('Glukoza 65 mg/dL: insulina może pogłębić niedocukrzenie.');
  });

  it('still blocks amounts that cannot be sent and a second command while one waits for Trio', () => {
    expect(codes(evaluate(46.5, 4.6).blocks)).toEqual(['INVALID_AMOUNTS']);
    expect(codes(evaluate(46, 4.6, context({ in_flight_command_id: 'rc1' })).blocks)).toEqual(['COMMAND_IN_FLIGHT']);
  });

  it('allows carbs alone near a low (hypo treatment)', () => {
    expect(evaluate(15, 0, context({ glucose: { value: 60, observed_at: minutesAgo(2), delta: -5 }, lowest_recent_glucose: 58 }))).toEqual({ icr_insulin_u: 1.5, blocks: [], warnings: [] });
  });

  it('warns about what the caregiver should see before confirming', () => {
    expect(codes(evaluate(46, 4.6, context({ glucose: { value: 140, observed_at: minutesAgo(20), delta: null } })).warnings)).toEqual(['GLUCOSE_OLD']);
    expect(codes(evaluate(46, 4.6, context({ glucose: { value: 150, observed_at: minutesAgo(2), delta: -12 } })).warnings)).toEqual(['GLUCOSE_FALLING_OR_LOW']);
    expect(codes(evaluate(46, 4.6, context({ last_bolus: { at: minutesAgo(10), units: 2 } })).warnings)).toEqual(['RECENT_BOLUS']);
    expect(codes(evaluate(46, 6, context()).warnings)).toEqual(['DOSE_DIFFERS_FROM_ICR']);
    expect(codes(evaluate(0, 1, context()).warnings)).toEqual([]);
    expect(evaluate(46, 6).warnings[0].message).toBe('Dawka różni się od przelicznika: 46 g / ICR 10 = 4,6 j.');
  });

  it('points out an unconfirmed or recent remote bolus', () => {
    const unconfirmed = evaluate(46, 4.6, context({ recent_remote_bolus: { at: minutesAgo(5), units: 4, status: 'NO_REPLY' } }));
    expect(codes(unconfirmed.blocks)).toEqual([]);
    expect(codes(unconfirmed.warnings)).toEqual(['UNCONFIRMED_REMOTE_BOLUS']);
    expect(unconfirmed.warnings[0].message).toMatch(/MÓGŁ zostać podany/);
    expect(codes(evaluate(46, 4.6, context({ recent_remote_bolus: { at: minutesAgo(5), units: 4, status: 'SUCCEEDED' } })).warnings)).toEqual(['RECENT_REMOTE_BOLUS']);
    expect(codes(evaluate(46, 4.6, context({ recent_remote_bolus: { at: minutesAgo(40), units: 4, status: 'NO_REPLY' } })).warnings)).toEqual([]);
    expect(codes(evaluate(20, 0, context({ bolus_history_known: false, recent_remote_bolus: { at: minutesAgo(5), units: 4, status: 'NO_REPLY' } })).warnings)).toEqual([]);
  });

  it('says a remote bolus once when Nightscout already shows it', () => {
    const remote = { at: minutesAgo(9), units: 4.6, status: 'SUCCEEDED' };
    expect(codes(evaluate(0, 0.7, context({ recent_remote_bolus: remote, last_bolus: { at: minutesAgo(9), units: 4.6 } })).warnings)).toEqual(['RECENT_BOLUS']);
    // Not in Nightscout yet: the command is the only trace.
    expect(codes(evaluate(0, 0.7, context({ recent_remote_bolus: remote, last_bolus: { at: minutesAgo(60), units: 2 } })).warnings)).toEqual(['RECENT_REMOTE_BOLUS']);
    // Unanswered but visible in Nightscout: given, said once.
    expect(codes(evaluate(0, 0.7, context({ recent_remote_bolus: { ...remote, status: 'NO_REPLY' }, last_bolus: { at: minutesAgo(8), units: 4.6 } })).warnings)).toEqual(['RECENT_BOLUS']);
  });

  it('names each warning with the data it is about', () => {
    const first = evaluate(46, 4.6, context({ last_bolus: { at: minutesAgo(10), units: 1 } })).warnings[0].key;
    const second = evaluate(46, 4.6, context({ last_bolus: { at: minutesAgo(2), units: 5 } })).warnings[0].key;
    expect(first).not.toEqual(second);
  });

  it('refuses amounts the pump or the patient cannot take and a second command while one is waiting', () => {
    expect(codes(evaluate(0, 0).blocks)).toEqual(['INVALID_AMOUNTS']);
    expect(codes(evaluate(46.5, 4.6).blocks)).toEqual(['INVALID_AMOUNTS']);
    expect(codes(evaluate(46, 4.62).blocks)).toEqual(['INVALID_AMOUNTS']);
    expect(codes(evaluate(46, 31).blocks)).toEqual(['INVALID_AMOUNTS']);
    expect(codes(evaluate(46, 4.6, context({ in_flight_command_id: 'c1' })).blocks)).toEqual(['COMMAND_IN_FLIGHT']);
  });
});

describe('Trio answers', () => {
  it('reads the stages of a bolus', () => {
    expect(classifyTrioReply({ success: true, message: 'Initiating bolus...', carbs_g: 46, insulin_u: 4.6 })).toBe('TRIO_ACCEPTED');
    expect(classifyTrioReply({ success: true, message: 'Bolus started', carbs_g: 46, insulin_u: 4.6 })).toBe('SUCCEEDED');
    expect(classifyTrioReply({ success: true, message: 'Meal logged', carbs_g: 20, insulin_u: 0 })).toBe('SUCCEEDED');
    // With insulin only "Bolus started" is final, wherever it is in the text.
    expect(classifyTrioReply({ success: true, message: 'Meal logged', carbs_g: 20, insulin_u: 2 })).toBe('TRIO_ACCEPTED');
    expect(classifyTrioReply({ success: true, message: 'Command Successful: Bolus started', carbs_g: 20, insulin_u: 2 })).toBe('SUCCEEDED');
  });

  it('knows when the carbs stayed in Trio although the bolus was refused', () => {
    const maxIob = 'Command rejected: bolus amount (4.6 units) would exceed max IOB (5 units). Current IOB: 1.2 units. Details: User: GlucoMind.';
    expect(classifyTrioReply({ success: false, message: maxIob, carbs_g: 46, insulin_u: 4.6 })).toBe('PARTIAL');
    expect(classifyTrioReply({ success: false, message: maxIob, carbs_g: 0, insulin_u: 4.6 })).toBe('REJECTED');
    expect(classifyTrioReply({ success: false, message: 'Command rejected: carbs amount (120g) exceeds the maximum allowed (100g).', carbs_g: 120, insulin_u: 10 })).toBe('REJECTED');
    expect(classifyTrioReply({ success: false, message: 'Command rejected: the message is too old (sent 700 seconds ago).', carbs_g: 46, insulin_u: 4.6 })).toBe('REJECTED');
  });

  it('says it in Polish', () => {
    expect(describeTrioReply('SUCCEEDED', 'Bolus started', 4.6)).toBe('Bolus podany');
    expect(describeTrioReply('REJECTED', 'Command rejected: bolus amount (12 units) exceeds the maximum allowed (10 units).', 12)).toBe('Błąd: bolus 12 j przekracza maksymalny bolus w Trio (10 j)');
    expect(describeTrioReply('PARTIAL', 'Command rejected: current IOB is not available.', 4)).toBe('Węglowodany zapisane w Trio, bolus odrzucony: Trio nie zna aktualnego IOB');
    expect(translateTrioReason('Something new happened')).toBe('Something new happened');
  });

  it('moves only forward', () => {
    expect(canTransitionRemoteCommand('AUTHORIZED', 'SENT')).toBe(true);
    expect(canTransitionRemoteCommand('NO_REPLY', 'SUCCEEDED')).toBe(true);
    expect(canTransitionRemoteCommand('NO_REPLY', 'TRIO_ACCEPTED')).toBe(false);
    // Trio's answer before the phone's "sent" report.
    expect(canTransitionRemoteCommand('AUTHORIZED', 'TRIO_ACCEPTED')).toBe(true);
    expect(canTransitionRemoteCommand('AUTHORIZED', 'EXPIRED')).toBe(false);
    expect(canTransitionRemoteCommand('SUCCEEDED', 'REJECTED')).toBe(false);
    expect(canTransitionRemoteCommand('SEND_FAILED', 'SENT')).toBe(false);
  });
});
