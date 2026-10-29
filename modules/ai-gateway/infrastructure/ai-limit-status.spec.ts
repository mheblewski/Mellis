import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAiLimitStatus } from './ai-limit-status';
import { FileExperimentBudgetLedger, initializeExperimentBudgetLedger } from './experiment-budget-ledger';

describe('readAiLimitStatus (capabilities.ai)', () => {
  it('says nothing without paid AI or a ledger', () => {
    expect(readAiLimitStatus({ AI_PROVIDER: 'fake', AI_EXPERIMENT_BUDGET_LEDGER_PATH: '/tmp/x.json' })).toBeNull();
    expect(readAiLimitStatus({ AI_PROVIDER: 'openai' })).toBeNull();
  });

  it('reads the monthly limit: reached once less than one call is left, starting over next month', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mellis-limit-')), 'ledger.json');
    let now = '2026-10-15T10:00:00.000Z';
    initializeExperimentBudgetLedger(path, { experiment_id: 'mellis', currency: 'USD', total_budget: 1, max_calls: 1000, now, monthly_time_zone: 'Europe/Warsaw' });
    const env = { AI_PROVIDER: 'anthropic', AI_EXPERIMENT_BUDGET_LEDGER_PATH: path, AI_EXPERIMENT_MAX_COST: '0.5' };
    expect(readAiLimitStatus(env, () => now)).toEqual({ limit_reached: false, resets_at: '2026-10-31T23:00:00.000Z' });
    const ledger = new FileExperimentBudgetLedger(path, () => now);
    const reservation = ledger.reserve({ max_cost: 0.5, currency: 'USD' }) as { reservation_id: string };
    ledger.settle({ reservation_id: reservation.reservation_id, actual_cost: 0.6 });
    expect(readAiLimitStatus(env, () => now)).toEqual({ limit_reached: true, resets_at: '2026-10-31T23:00:00.000Z' });
    now = '2026-11-01T00:30:00.000Z';
    expect(readAiLimitStatus(env, () => now)).toEqual({ limit_reached: false, resets_at: '2026-11-30T23:00:00.000Z' });
  });

  it('a missing ledger is not "reached" (the worker refuses and the answer says why)', () => {
    expect(readAiLimitStatus({ AI_PROVIDER: 'openai', AI_EXPERIMENT_BUDGET_LEDGER_PATH: '/nonexistent/mellis/ledger.json' })).toEqual({ limit_reached: false, resets_at: null });
  });
});
