import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARBS_COUNTED_STATUSES, INSULIN_COUNTED_STATUSES, MATCHABLE_STATUSES, REACHED_TRIO_STATUSES, REMOTE_COMMAND_STATUSES } from './remote-command-status';
import { calculatorHeldBackU, pendingRemoteDosesAsActions } from './split-bolus';

// Every status, and what each dose sum must do with it (owner 2026-11-10: one rule, no drift between places).
const EXPECTED: Record<string, { insulin: boolean; carbs: boolean }> = {
  AUTHORIZED: { insulin: true, carbs: true },
  SENT: { insulin: true, carbs: true },
  TRIO_ACCEPTED: { insulin: true, carbs: true },
  SUCCEEDED: { insulin: true, carbs: true },
  NO_REPLY: { insulin: true, carbs: true },
  // Never turns REJECTED: counted until Nightscout or the pump check says otherwise.
  UNCERTAIN: { insulin: true, carbs: true },
  // Carbs kept, bolus refused.
  PARTIAL: { insulin: false, carbs: true },
  REJECTED: { insulin: false, carbs: false },
  SEND_FAILED: { insulin: false, carbs: false },
  EXPIRED: { insulin: false, carbs: false },
};

describe('remote command status lists', () => {
  it('names every status', () => {
    expect([...REMOTE_COMMAND_STATUSES].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s: insulin and carbs counted as expected', (status, expected) => {
    expect(INSULIN_COUNTED_STATUSES.includes(status as never)).toBe(expected.insulin);
    expect(CARBS_COUNTED_STATUSES.includes(status as never)).toBe(expected.carbs);
    // The database's own sets: reached Trio is insulin counted without the not-yet-sent AUTHORIZED.
    expect(REACHED_TRIO_STATUSES.includes(status as never)).toBe(expected.insulin && status !== 'AUTHORIZED');
    expect(MATCHABLE_STATUSES.includes(status as never)).toBe(expected.carbs && status !== 'AUTHORIZED');
  });

  it.each(Object.entries(EXPECTED))('%s: the part and the held-back sum follow the insulin list', (status, expected) => {
    const pending = pendingRemoteDosesAsActions([{ id: 'c1', status, insulin_u: 1, carbs_g: 10, authorized_at: '2026-11-10T12:00:00.000Z' }]);
    expect(pending.length).toBe(expected.insulin ? 1 : 0);
    const held = calculatorHeldBackU([{ status, icr_insulin_u: 2, context: { dose_calculation: { default_u: 1.5 } } }]);
    expect(held).toBe(expected.insulin ? 0.5 : 0);
  });

  it('the database reads the lists, not its own copies', () => {
    const sql = readFileSync(resolve(__dirname, '../../../infra/db/postgres-remote-commands.repository.ts'), 'utf8');
    expect(sql).not.toMatch(/status IN \('SENT', 'TRIO_ACCEPTED', 'SUCCEEDED'/);
    expect(sql).not.toMatch(/status IN \('AUTHORIZED', 'SENT', 'TRIO_ACCEPTED'\)/);
  });
});
