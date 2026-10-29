import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compactLedger,
  experimentBudgetStatus,
  FileExperimentBudgetLedger,
  monthIn,
  startOfNextMonth,
  initializeExperimentBudgetLedger,
  summarizeExperimentBudget,
} from './experiment-budget-ledger';
import { findRepositoryRoot } from './evaluation-capture-path';

// Offline: a temporary directory outside the repository, synthetic amounts. No database.

describe('FileExperimentBudgetLedger', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'glucomind-ledger-test-'));
    path = join(dir, 'ledger.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const init = (overrides: Partial<{ total_budget: number; max_calls: number; currency: string }> = {}) =>
    initializeExperimentBudgetLedger(path, { experiment_id: 'synthetic-experiment-1', currency: 'USD', total_budget: 0.25, max_calls: 1, ...overrides });

  it('refuses when the ledger was never initialized, instead of starting a fresh budget', () => {
    const ledger = new FileExperimentBudgetLedger(path);
    expect(ledger.reserve({ max_cost: 0.1, currency: 'USD' })).toMatchObject({ allowed: false, reason: 'LEDGER_UNAVAILABLE' });
    expect(existsSync(path)).toBe(false);
  });

  it('never overwrites an existing ledger on initialization', () => {
    init();
    expect(() => init({ total_budget: 100 })).toThrow();
    expect(JSON.parse(readFileSync(path, 'utf8')).total_budget).toBe(0.25);
  });

  it('allows exactly one call in a one-call experiment, across ledger instances (new job, new process)', () => {
    init();
    expect(new FileExperimentBudgetLedger(path).reserve({ max_cost: 0.2, currency: 'USD' })).toMatchObject({ allowed: true, calls_after: 1 });
    // A second, new job reads the same durable file.
    expect(new FileExperimentBudgetLedger(path).precheck({ currency: 'USD' })).toMatchObject({ allowed: false, reason: 'EXPERIMENT_CALL_LIMIT_REACHED' });
    expect(new FileExperimentBudgetLedger(path).reserve({ max_cost: 0.01, currency: 'USD' })).toMatchObject({ allowed: false, reason: 'EXPERIMENT_CALL_LIMIT_REACHED' });
  });

  it('refuses a reservation whose worst case would exceed the total budget, and allows one equal to it', () => {
    init({ max_calls: 5 });
    const ledger = new FileExperimentBudgetLedger(path);
    expect(ledger.reserve({ max_cost: 0.26, currency: 'USD' })).toMatchObject({ allowed: false, reason: 'EXPERIMENT_BUDGET_EXCEEDED' });
    expect(ledger.reserve({ max_cost: 0.25, currency: 'USD' })).toMatchObject({ allowed: true });
    expect(ledger.reserve({ max_cost: 0.000001, currency: 'USD' })).toMatchObject({ allowed: false, reason: 'EXPERIMENT_BUDGET_EXCEEDED' });
  });

  it('charges the worst case until settled with a known cost; an unknown outcome stays at the worst case', () => {
    init({ max_calls: 3 });
    const ledger = new FileExperimentBudgetLedger(path);
    const first = ledger.reserve({ max_cost: 0.1, currency: 'USD' });
    const second = ledger.reserve({ max_cost: 0.1, currency: 'USD' });
    if (!first.allowed || !second.allowed) throw new Error('expected reservations');
    expect(summarizeExperimentBudget(ledger.read()).charged).toBeCloseTo(0.2, 12);
    ledger.settle({ reservation_id: first.reservation_id, actual_cost: 0.02 });
    ledger.settle({ reservation_id: second.reservation_id, actual_cost: null });
    const summary = summarizeExperimentBudget(ledger.read());
    expect(summary.charged).toBeCloseTo(0.12, 12);
    expect(ledger.read().reservations.map((entry) => entry.status)).toEqual(['SETTLED', 'OUTCOME_UNKNOWN']);
  });

  it('refuses a different currency', () => {
    init();
    expect(new FileExperimentBudgetLedger(path).reserve({ max_cost: 0.1, currency: 'EUR' })).toMatchObject({ allowed: false, reason: 'CURRENCY_MISMATCH' });
  });

  it('fails closed on a malformed ledger or while another writer holds the lock', () => {
    init();
    writeFileSync(`${path}.lock`, '');
    expect(new FileExperimentBudgetLedger(path).reserve({ max_cost: 0.1, currency: 'USD' })).toMatchObject({ allowed: false, reason: 'LEDGER_UNAVAILABLE' });
    rmSync(`${path}.lock`);
    writeFileSync(path, '{"version":"ai-experiment-budget-ledger.v1","total_budget":-1}');
    expect(new FileExperimentBudgetLedger(path).reserve({ max_cost: 0.1, currency: 'USD' })).toMatchObject({ allowed: false, reason: 'LEDGER_UNAVAILABLE' });
  });

  it('removes a lock left by a writer that died holding it', () => {
    init();
    writeFileSync(`${path}.lock`, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    expect(new FileExperimentBudgetLedger(path).reserve({ max_cost: 0.1, currency: 'USD' })).toMatchObject({ allowed: true });
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('folds old settled reservations into archived without changing the totals', () => {
    const ledger = init({ total_budget: 100, max_calls: 1000 });
    const entries = Array.from({ length: 5 }, (_, i) => ({ reservation_id: `r${i}`, reserved_at: 't', max_cost: 1, status: 'SETTLED' as const, actual_cost: 0.5, settled_at: 't', label: null }));
    const open = { reservation_id: 'open', reserved_at: 't', max_cost: 2, status: 'RESERVED' as const, actual_cost: null, settled_at: null, label: null };
    const full = { ...ledger, reservations: [entries[0], open, ...entries.slice(1)] };
    const compacted = compactLedger(full, 2);
    expect(compacted.reservations.map((entry) => entry.reservation_id)).toEqual(['open', 'r3', 'r4']);
    expect(compacted.archived).toEqual({ calls: 3, charged: 1.5 });
    expect(summarizeExperimentBudget(compacted)).toEqual(summarizeExperimentBudget(full));
  });

  it('refuses a ledger path inside the repository or relative', () => {
    const repoRoot = findRepositoryRoot(__dirname);
    expect(() => new FileExperimentBudgetLedger(join(String(repoRoot), 'ledger.json'))).toThrow();
    expect(() => new FileExperimentBudgetLedger('ledger.json')).toThrow('absolute');
  });

  describe('monthly budget (mellis: "miesięczny limit AI")', () => {
    const zone = 'Europe/Warsaw';
    let now = '2026-10-31T21:00:00.000Z'; // 22:00 in Warsaw, still October
    const clock = () => now;
    const monthly = (total = 1, maxCalls = 100) =>
      initializeExperimentBudgetLedger(path, { experiment_id: 'mellis', currency: 'USD', total_budget: total, max_calls: maxCalls, now, monthly_time_zone: zone });

    beforeEach(() => {
      now = '2026-10-31T21:00:00.000Z';
    });

    it('counts the calendar month in the server time zone', () => {
      expect(monthIn(new Date('2026-10-31T22:59:59Z'), zone)).toBe('2026-10');
      expect(monthIn(new Date('2026-10-31T23:00:00Z'), zone)).toBe('2026-11'); // midnight CET
      expect(startOfNextMonth('2026-10', zone).toISOString()).toBe('2026-10-31T23:00:00.000Z');
      expect(startOfNextMonth('2026-03', zone).toISOString()).toBe('2026-03-31T22:00:00.000Z'); // CEST
      expect(startOfNextMonth('2026-12', 'UTC').toISOString()).toBe('2027-01-01T00:00:00.000Z');
    });

    it('stops at the limit and starts over at the first call of the next month', () => {
      monthly(1, 100);
      const ledger = new FileExperimentBudgetLedger(path, clock);
      const first = ledger.reserve({ max_cost: 0.6, currency: 'USD' });
      expect(first).toMatchObject({ allowed: true });
      ledger.settle({ reservation_id: (first as { reservation_id: string }).reservation_id, actual_cost: 0.9 });
      expect(ledger.reserve({ max_cost: 0.2, currency: 'USD' })).toMatchObject({ allowed: false, reason: 'EXPERIMENT_BUDGET_EXCEEDED' });
      expect(ledger.status(0.25)).toMatchObject({ period: 'MONTHLY', month: '2026-10', limit_reached: true, resets_at: '2026-10-31T23:00:00.000Z' });

      now = '2026-10-31T23:00:00.000Z';
      expect(ledger.precheck({ currency: 'USD' })).toEqual({ allowed: true });
      expect(ledger.status(0.25)).toMatchObject({ month: '2026-11', charged: 0, calls: 0, limit_reached: false, resets_at: '2026-11-30T23:00:00.000Z' });
      expect(ledger.reserve({ max_cost: 0.2, currency: 'USD' })).toMatchObject({ allowed: true, calls_after: 1 });
      const stored = JSON.parse(readFileSync(path, 'utf8'));
      expect(stored.period).toEqual({ kind: 'MONTHLY', time_zone: zone, month: '2026-11' });
      expect(stored.history).toEqual([{ month: '2026-10', total_budget: 1, charged: 0.9, calls: 1 }]);
    });

    it('carries a call in flight at midnight into the new month', () => {
      monthly(1, 100);
      const ledger = new FileExperimentBudgetLedger(path, clock);
      const open = ledger.reserve({ max_cost: 0.3, currency: 'USD' }) as { reservation_id: string };
      now = '2026-11-02T08:00:00.000Z';
      expect(ledger.status(null)).toMatchObject({ month: '2026-11', charged: 0.3, calls: 1 });
      ledger.settle({ reservation_id: open.reservation_id, actual_cost: 0.1 });
      expect(ledger.status(null)).toMatchObject({ charged: 0.1, calls: 1 });
      expect(JSON.parse(readFileSync(path, 'utf8')).history).toEqual([{ month: '2026-10', total_budget: 1, charged: 0, calls: 0 }]);
    });

    it('changes the limit and keeps the spending; turns a one-off budget into a monthly one', () => {
      init({ total_budget: 5, max_calls: 10 });
      const ledger = new FileExperimentBudgetLedger(path, clock);
      ledger.reserve({ max_cost: 0.25, currency: 'USD' });
      expect(ledger.setLimit({ total_budget: 20, max_calls: 4000, monthly_time_zone: zone })).toMatchObject({ period: 'MONTHLY', month: '2026-10', total_budget: 20, max_calls: 4000, charged: 0.25, calls: 1 });
      expect(ledger.setLimit({ total_budget: 0.2, max_calls: 4000 })).toMatchObject({ period: 'MONTHLY', limit_reached: true });
      expect(() => ledger.setLimit({ total_budget: 0, max_calls: 1 })).toThrow();
    });

    it('reads a one-off ledger as before (no period, no reset)', () => {
      const created = init({ total_budget: 1, max_calls: 2 });
      expect(experimentBudgetStatus(created, new Date('2030-01-01T00:00:00Z'), 0.25)).toMatchObject({ period: 'TOTAL', month: null, resets_at: null, limit_reached: false });
    });

    it('refuses an unknown time zone', () => {
      expect(() => initializeExperimentBudgetLedger(path, { experiment_id: 'mellis', currency: 'USD', total_budget: 1, max_calls: 1, monthly_time_zone: 'Mars/Olympus' })).toThrow('time zone');
    });
  });
});
