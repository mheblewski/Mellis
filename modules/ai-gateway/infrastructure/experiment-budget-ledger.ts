import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { assertEvaluationCaptureOutsideRepository, describePath } from './evaluation-capture-path';

/**
 * Durable budget of one AI experiment, shared by every job, process and entry point that uses the same ledger file.
 * Every paid call reserves its worst-case cost here before the request is sent; the reservation is charged at that
 * worst case until the call is settled with a known actual cost. A call whose outcome is unknown (timeout, network
 * error, crash after the reservation) stays charged at its worst case, so the ledger can only over-count.
 *
 * Local file, no database: an exclusive lock file serialises writers across processes and each write replaces the
 * ledger atomically (write to a temporary file, fsync, rename). Fails closed: a missing, unreadable, malformed or
 * locked ledger refuses the reservation. The file lives outside every Git working tree and is created only by
 * initializeExperimentBudgetLedger, never implicitly, so a wrong path cannot silently start a fresh budget.
 */

export const EXPERIMENT_BUDGET_LEDGER_VERSION = 'ai-experiment-budget-ledger.v1' as const;

export interface ExperimentBudgetReservationRecord {
  reservation_id: string;
  reserved_at: string;
  max_cost: number;
  status: 'RESERVED' | 'SETTLED' | 'OUTCOME_UNKNOWN';
  actual_cost: number | null;
  settled_at: string | null;
  label: string | null;
}

/**
 * A monthly budget (self-hosted Mellis, "miesięczny limit AI"): total_budget and max_calls apply per calendar month in
 * `time_zone`. The first read or write in a new month starts it over: settled reservations of the old month go into
 * `history` (last 12 months), reservations still open (a call in flight at midnight) count in the new month.
 */
export interface ExperimentBudgetPeriod {
  kind: 'MONTHLY';
  /** IANA time zone the month is counted in (the server's TZ). */
  time_zone: string;
  /** The month being counted, "YYYY-MM" in time_zone. */
  month: string;
}

export interface ExperimentBudgetMonthSummary {
  month: string;
  total_budget: number;
  charged: number;
  calls: number;
}

export interface ExperimentBudgetLedgerFile {
  version: typeof EXPERIMENT_BUDGET_LEDGER_VERSION;
  experiment_id: string;
  currency: string;
  total_budget: number;
  max_calls: number;
  created_at: string;
  reservations: ExperimentBudgetReservationRecord[];
  /** Settled reservations folded out of `reservations` to keep the file small: they still count (calls and cost). */
  archived?: { calls: number; charged: number };
  /** Absent: one budget for the ledger's whole life (evaluations, older servers). */
  period?: ExperimentBudgetPeriod;
  history?: ExperimentBudgetMonthSummary[];
}

/** Months kept in `history` of a monthly ledger. */
const MONTH_HISTORY_LENGTH = 12;

/** Settled reservations kept one by one; older ones are folded into `archived` on the next write. */
const MAX_KEPT_SETTLED_RESERVATIONS = 200;
/** A lock is held for one read and write (milliseconds): a busy one is waited for this long, retried every 25 ms. */
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 25;
/** A lock older than this was left by a process that died while holding it: it is removed. */
const STALE_LOCK_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export type ExperimentBudgetRefusalReason =
  | 'LEDGER_UNAVAILABLE'
  | 'CURRENCY_MISMATCH'
  | 'EXPERIMENT_CALL_LIMIT_REACHED'
  | 'EXPERIMENT_BUDGET_EXCEEDED';

export type ExperimentBudgetDecision =
  | { allowed: true; reservation_id: string; charged_before: number; charged_after: number; calls_after: number }
  | { allowed: false; reason: ExperimentBudgetRefusalReason; detail: string };

export interface ExperimentBudgetLedger {
  /** Read-only check that one more call could be reserved at all (calls left, budget not exhausted). */
  precheck(args: { currency: string }): ExperimentBudgetDecision | { allowed: true };
  reserve(args: { max_cost: number; currency: string; label?: string | null }): ExperimentBudgetDecision;
  settle(args: { reservation_id: string; actual_cost: number | null }): void;
}

export class ExperimentBudgetLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExperimentBudgetLedgerError';
  }
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function parseLedger(raw: string): ExperimentBudgetLedgerFile {
  const parsed = JSON.parse(raw) as Partial<ExperimentBudgetLedgerFile>;
  const valid = parsed
    && parsed.version === EXPERIMENT_BUDGET_LEDGER_VERSION
    && typeof parsed.experiment_id === 'string' && parsed.experiment_id.length > 0
    && typeof parsed.currency === 'string' && parsed.currency.length > 0
    && isPositiveFinite(parsed.total_budget)
    && Number.isInteger(parsed.max_calls) && (parsed.max_calls as number) > 0
    && Array.isArray(parsed.reservations)
    && (parsed.archived === undefined || (parsed.archived !== null && Number.isInteger(parsed.archived.calls) && parsed.archived.calls >= 0
      && typeof parsed.archived.charged === 'number' && Number.isFinite(parsed.archived.charged) && parsed.archived.charged >= 0))
    && parsed.reservations.every((entry) => entry
      && typeof entry.reservation_id === 'string'
      && isPositiveFinite(entry.max_cost)
      && ['RESERVED', 'SETTLED', 'OUTCOME_UNKNOWN'].includes(entry.status)
      && (entry.actual_cost === null || (typeof entry.actual_cost === 'number' && Number.isFinite(entry.actual_cost) && entry.actual_cost >= 0)))
    && (parsed.period === undefined || (parsed.period !== null && parsed.period.kind === 'MONTHLY'
      && isValidTimeZone(parsed.period.time_zone) && typeof parsed.period.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(parsed.period.month)))
    && (parsed.history === undefined || Array.isArray(parsed.history));
  if (!valid) {
    throw new ExperimentBudgetLedgerError('Experiment budget ledger is malformed');
  }
  return parsed as ExperimentBudgetLedgerFile;
}

/** Charged amount of one reservation: its actual cost once settled with a known cost, otherwise its worst case. */
function chargeOf(entry: ExperimentBudgetReservationRecord): number {
  return entry.status === 'SETTLED' && entry.actual_cost !== null ? entry.actual_cost : entry.max_cost;
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** "YYYY-MM" of `at` in `timeZone`. */
export function monthIn(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(at);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return `${year}-${month}`;
}

/** Offset of `timeZone` from UTC at `at`, in milliseconds (positive east of Greenwich). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant the month after `month` ("YYYY-MM") starts in `timeZone` (local midnight of its first day). */
export function startOfNextMonth(month: string, timeZone: string): Date {
  const [year, monthNumber] = month.split('-').map(Number);
  const localMidnightAsUtc = Date.UTC(year, monthNumber, 1, 0, 0, 0);
  // Two passes: the offset at the guess, then at the corrected instant (DST changes never fall on midnight of the 1st
  // in the zones Mellis runs in, but the second pass keeps it right anyway).
  let instant = localMidnightAsUtc - zoneOffsetMs(new Date(localMidnightAsUtc), timeZone);
  instant = localMidnightAsUtc - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/**
 * The ledger as it stands at `now`: a monthly ledger whose month has passed starts the current month over (settled
 * reservations summarized into `history`, open ones carried over). Anything else is returned unchanged.
 */
export function rollOverLedger(ledger: ExperimentBudgetLedgerFile, now: Date): ExperimentBudgetLedgerFile {
  const period = ledger.period;
  if (!period) return ledger;
  const current = monthIn(now, period.time_zone);
  if (current <= period.month) return ledger;
  const summary = summarizeExperimentBudget(ledger);
  const open = ledger.reservations.filter((entry) => entry.status === 'RESERVED');
  const openCharged = open.reduce((sum, entry) => sum + entry.max_cost, 0);
  const closed: ExperimentBudgetMonthSummary = {
    month: period.month,
    total_budget: ledger.total_budget,
    charged: Math.round((summary.charged - openCharged) * 1e6) / 1e6,
    calls: summary.calls - open.length,
  };
  return {
    ...ledger,
    period: { ...period, month: current },
    reservations: open,
    archived: { calls: 0, charged: 0 },
    history: [...(ledger.history ?? []), closed].slice(-MONTH_HISTORY_LENGTH),
  };
}

export interface ExperimentBudgetStatus {
  period: 'MONTHLY' | 'TOTAL';
  /** The month counted ("YYYY-MM"); null for a one-off budget. */
  month: string | null;
  currency: string;
  total_budget: number;
  max_calls: number;
  charged: number;
  calls: number;
  remaining_budget: number;
  remaining_calls: number;
  /** No more paid call fits: fewer calls left than one, or less money left than one call's worst case. */
  limit_reached: boolean;
  /** When a monthly budget starts over; null for a one-off budget. */
  resets_at: string | null;
}

/** What the server tool and the app show; `maxCallCost` is AI_EXPERIMENT_MAX_COST (one call's worst case). */
export function experimentBudgetStatus(ledger: ExperimentBudgetLedgerFile, now: Date, maxCallCost: number | null): ExperimentBudgetStatus {
  const current = rollOverLedger(ledger, now);
  const summary = summarizeExperimentBudget(current);
  const reserve = maxCallCost !== null && Number.isFinite(maxCallCost) && maxCallCost > 0 ? maxCallCost : 0;
  return {
    period: current.period ? 'MONTHLY' : 'TOTAL',
    month: current.period?.month ?? null,
    currency: current.currency,
    total_budget: current.total_budget,
    max_calls: current.max_calls,
    charged: Math.round(summary.charged * 1e6) / 1e6,
    calls: summary.calls,
    remaining_budget: Math.round(summary.remaining_budget * 1e6) / 1e6,
    remaining_calls: summary.remaining_calls,
    limit_reached: summary.remaining_calls <= 0 || summary.remaining_budget <= 0 || summary.remaining_budget < reserve,
    resets_at: current.period ? startOfNextMonth(current.period.month, current.period.time_zone).toISOString() : null,
  };
}

export function summarizeExperimentBudget(ledger: ExperimentBudgetLedgerFile): { charged: number; calls: number; remaining_budget: number; remaining_calls: number } {
  const charged = ledger.reservations.reduce((sum, entry) => sum + chargeOf(entry), ledger.archived?.charged ?? 0);
  const calls = ledger.reservations.length + (ledger.archived?.calls ?? 0);
  return {
    charged,
    calls,
    remaining_budget: ledger.total_budget - charged,
    remaining_calls: ledger.max_calls - calls,
  };
}

/** Folds the oldest settled reservations into `archived` (open ones are always kept): totals are unchanged. */
export function compactLedger(ledger: ExperimentBudgetLedgerFile, keepSettled = MAX_KEPT_SETTLED_RESERVATIONS): ExperimentBudgetLedgerFile {
  const settled = ledger.reservations.filter((entry) => entry.status !== 'RESERVED');
  const fold = settled.length - keepSettled;
  if (fold <= 0) return ledger;
  const folded = new Set(settled.slice(0, fold).map((entry) => entry.reservation_id));
  const archived = { calls: ledger.archived?.calls ?? 0, charged: ledger.archived?.charged ?? 0 };
  for (const entry of ledger.reservations) {
    if (!folded.has(entry.reservation_id)) continue;
    archived.calls += 1;
    archived.charged += chargeOf(entry);
  }
  return { ...ledger, archived: { calls: archived.calls, charged: Math.round(archived.charged * 1e6) / 1e6 }, reservations: ledger.reservations.filter((entry) => !folded.has(entry.reservation_id)) };
}

function writeAtomically(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function validateLedgerPath(path: string): string {
  if (!path || !isAbsolute(path)) {
    throw new ExperimentBudgetLedgerError('Experiment budget ledger path must be absolute');
  }
  return assertEvaluationCaptureOutsideRepository(path);
}

/** Creates a new ledger file; refuses to overwrite an existing one. */
export function initializeExperimentBudgetLedger(path: string, args: {
  experiment_id: string;
  currency: string;
  total_budget: number;
  max_calls: number;
  now?: string;
  /** A monthly budget counted in this IANA time zone (total_budget and max_calls per calendar month). */
  monthly_time_zone?: string | null;
}): ExperimentBudgetLedgerFile {
  const target = validateLedgerPath(path);
  if (!args.experiment_id.trim() || !args.currency.trim() || !isPositiveFinite(args.total_budget) || !(Number.isInteger(args.max_calls) && args.max_calls > 0)) {
    throw new ExperimentBudgetLedgerError('Invalid experiment budget: experiment_id, currency, total_budget > 0 and max_calls >= 1 are required');
  }
  if (args.monthly_time_zone !== undefined && args.monthly_time_zone !== null && !isValidTimeZone(args.monthly_time_zone)) {
    throw new ExperimentBudgetLedgerError(`Invalid time zone for a monthly budget: ${args.monthly_time_zone}`);
  }
  const createdAt = args.now ?? new Date().toISOString();
  const ledger: ExperimentBudgetLedgerFile = {
    version: EXPERIMENT_BUDGET_LEDGER_VERSION,
    experiment_id: args.experiment_id.trim(),
    currency: args.currency.trim().toUpperCase(),
    total_budget: args.total_budget,
    max_calls: args.max_calls,
    created_at: createdAt,
    reservations: [],
    ...(args.monthly_time_zone
      ? { period: { kind: 'MONTHLY' as const, time_zone: args.monthly_time_zone, month: monthIn(new Date(createdAt), args.monthly_time_zone) }, history: [] }
      : {}),
  };
  const fd = openSync(target, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(ledger, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return ledger;
}

export class FileExperimentBudgetLedger implements ExperimentBudgetLedger {
  private readonly path: string;
  private readonly lockPath: string;

  constructor(path: string, private readonly clock: () => string = () => new Date().toISOString()) {
    this.path = validateLedgerPath(path);
    this.lockPath = `${this.path}.lock`;
  }

  /** Reads and validates the ledger; throws when it is missing or malformed (used to fail fast at startup). */
  read(): ExperimentBudgetLedgerFile {
    if (!existsSync(this.path)) {
      throw new ExperimentBudgetLedgerError(`Experiment budget ledger not found: ${describePath(this.path)}`);
    }
    return parseLedger(readFileSync(this.path, 'utf8'));
  }

  precheck(args: { currency: string }): ExperimentBudgetDecision | { allowed: true } {
    let ledger: ExperimentBudgetLedgerFile;
    try {
      ledger = this.read();
    } catch (error) {
      return { allowed: false, reason: 'LEDGER_UNAVAILABLE', detail: error instanceof Error ? error.message : String(error) };
    }
    return this.evaluate(rollOverLedger(ledger, new Date(this.clock())), 0, args.currency) ?? { allowed: true };
  }

  /** The budget as it stands now (a new month already started over), for the server tool and the app. */
  status(maxCallCost: number | null): ExperimentBudgetStatus {
    return experimentBudgetStatus(this.read(), new Date(this.clock()), maxCallCost);
  }

  /**
   * Changes the limit and keeps what was spent ("mellis → Zmień ustawienia → Limit AI"). `monthlyTimeZone` turns a
   * one-off budget into a monthly one counted from the current month; a monthly ledger keeps its own zone unless given.
   */
  setLimit(args: { total_budget: number; max_calls: number; monthly_time_zone?: string | null }): ExperimentBudgetStatus {
    if (!isPositiveFinite(args.total_budget) || !(Number.isInteger(args.max_calls) && args.max_calls > 0)) {
      throw new ExperimentBudgetLedgerError('Invalid experiment budget: total_budget > 0 and max_calls >= 1 are required');
    }
    if (args.monthly_time_zone && !isValidTimeZone(args.monthly_time_zone)) {
      throw new ExperimentBudgetLedgerError(`Invalid time zone for a monthly budget: ${args.monthly_time_zone}`);
    }
    const now = new Date(this.clock());
    const decision = this.withLock((ledger) => {
      const zone = args.monthly_time_zone || ledger.period?.time_zone || null;
      const period = zone ? { kind: 'MONTHLY' as const, time_zone: zone, month: ledger.period?.time_zone === zone ? ledger.period.month : monthIn(now, zone) } : undefined;
      const next: ExperimentBudgetLedgerFile = { ...ledger, total_budget: args.total_budget, max_calls: args.max_calls, ...(period ? { period, history: ledger.history ?? [] } : {}) };
      return { decision: { allowed: true, reservation_id: '', charged_before: 0, charged_after: 0, calls_after: 0 }, next };
    });
    if (!decision.allowed) {
      throw new ExperimentBudgetLedgerError(`Experiment budget ledger could not be changed: ${decision.detail}`);
    }
    return this.status(null);
  }

  reserve(args: { max_cost: number; currency: string; label?: string | null }): ExperimentBudgetDecision {
    if (!isPositiveFinite(args.max_cost)) {
      return { allowed: false, reason: 'EXPERIMENT_BUDGET_EXCEEDED', detail: 'Reservation must be a positive finite cost' };
    }
    return this.withLock((ledger) => {
      const refusal = this.evaluate(ledger, args.max_cost, args.currency);
      if (refusal) return { decision: refusal, next: null };
      const before = summarizeExperimentBudget(ledger);
      const reservation: ExperimentBudgetReservationRecord = {
        reservation_id: randomUUID(),
        reserved_at: this.clock(),
        max_cost: args.max_cost,
        status: 'RESERVED',
        actual_cost: null,
        settled_at: null,
        label: args.label ?? null,
      };
      const next = { ...ledger, reservations: [...ledger.reservations, reservation] };
      return {
        decision: {
          allowed: true,
          reservation_id: reservation.reservation_id,
          charged_before: before.charged,
          charged_after: before.charged + args.max_cost,
          calls_after: next.reservations.length,
        },
        next,
      };
    });
  }

  /** Records the outcome. A null actual cost marks the outcome unknown and keeps the worst case charged. */
  settle(args: { reservation_id: string; actual_cost: number | null }): void {
    const decision = this.withLock((ledger) => {
      const next = {
        ...ledger,
        reservations: ledger.reservations.map((entry) => entry.reservation_id !== args.reservation_id
          ? entry
          : {
            ...entry,
            status: args.actual_cost === null ? 'OUTCOME_UNKNOWN' as const : 'SETTLED' as const,
            actual_cost: args.actual_cost,
            settled_at: this.clock(),
          }),
      };
      return { decision: { allowed: true, reservation_id: args.reservation_id, charged_before: 0, charged_after: 0, calls_after: 0 } as const, next };
    });
    if (!decision.allowed) {
      throw new ExperimentBudgetLedgerError(`Experiment budget ledger could not be settled: ${decision.detail}`);
    }
  }

  private evaluate(ledger: ExperimentBudgetLedgerFile, maxCost: number, currency: string): ExperimentBudgetDecision | null {
    if (ledger.currency !== currency.trim().toUpperCase()) {
      return { allowed: false, reason: 'CURRENCY_MISMATCH', detail: `Ledger currency ${ledger.currency} differs from ${currency}` };
    }
    const summary = summarizeExperimentBudget(ledger);
    if (summary.remaining_calls <= 0) {
      return { allowed: false, reason: 'EXPERIMENT_CALL_LIMIT_REACHED', detail: `${summary.calls} of ${ledger.max_calls} calls already reserved` };
    }
    if (summary.remaining_budget <= 0 || summary.charged + maxCost > ledger.total_budget) {
      return { allowed: false, reason: 'EXPERIMENT_BUDGET_EXCEEDED', detail: `charged ${summary.charged} + ${maxCost} exceeds ${ledger.total_budget} ${ledger.currency}` };
    }
    return null;
  }

  /**
   * The lock file, waiting up to LOCK_WAIT_MS while another writer (the API's voice input, another job) holds it. A
   * lock older than STALE_LOCK_MS was left by a writer that died holding it (a container recreated mid-write) and is
   * removed, so AI calls do not stay refused until someone deletes it by hand.
   */
  private acquireLock(): number | Extract<ExperimentBudgetDecision, { allowed: false }> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = openSync(this.lockPath, 'wx', 0o600);
        writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
        return fd;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') return { allowed: false, reason: 'LEDGER_UNAVAILABLE', detail: `Ledger lock failed (${code ?? 'unknown'})` };
      }
      try {
        if (Date.now() - statSync(this.lockPath).mtimeMs > STALE_LOCK_MS) {
          unlinkSync(this.lockPath);
          console.warn(JSON.stringify({ event: 'ai_budget_ledger_stale_lock_removed' }));
          continue;
        }
      } catch {
        // Released between the attempt and the check: try again at once.
        continue;
      }
      if (Date.now() >= deadline) return { allowed: false, reason: 'LEDGER_UNAVAILABLE', detail: 'Experiment budget ledger is locked' };
      sleepSync(LOCK_RETRY_MS);
    }
  }

  private withLock(update: (ledger: ExperimentBudgetLedgerFile) => { decision: ExperimentBudgetDecision; next: ExperimentBudgetLedgerFile | null }): ExperimentBudgetDecision {
    const lockFd = this.acquireLock();
    if (typeof lockFd !== 'number') return lockFd;
    try {
      let stored: ExperimentBudgetLedgerFile;
      try {
        stored = this.read();
      } catch (error) {
        return { allowed: false, reason: 'LEDGER_UNAVAILABLE', detail: error instanceof Error ? error.message : String(error) };
      }
      // A new month starts over before anything is decided, and is written even when nothing else changes.
      const ledger = rollOverLedger(stored, new Date(this.clock()));
      const { decision, next } = update(ledger);
      const toWrite = next ?? (ledger !== stored ? ledger : null);
      if (toWrite) {
        try {
          writeAtomically(this.path, `${JSON.stringify(compactLedger(toWrite), null, 2)}\n`);
        } catch (error) {
          return { allowed: false, reason: 'LEDGER_UNAVAILABLE', detail: `Ledger write failed (${(error as NodeJS.ErrnoException).code ?? 'unknown'})` };
        }
      }
      return decision;
    } finally {
      closeSync(lockFd);
      unlinkSync(this.lockPath);
    }
  }
}
