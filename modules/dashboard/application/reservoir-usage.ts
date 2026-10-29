import { localDayWindows } from '@modules/context/application/time-range-normalization';
import { buildDailyInsulinTotals, type InsulinDeliveryEvent } from '@modules/evidence-tools/daily-insulin-totals';

/**
 * How much insulin the patient uses a day, for "na ile wystarczy insuliny w zbiorniku" (reservoir-usage.v1). The
 * average total daily insulin (boluses incl. remote and manual ones, SMBs and the delivered basal incl. temp basals,
 * by the same rule as the AI's daily totals, buildDailyInsulinTotals) of the most recent full local days of the last
 * 7 (today, still running, never counts). A day counts only when:
 *  - it is a whole local day and its total is KNOWN (no dose without an amount, no minute of unknown basal rate);
 *  - it has no data gap: no stretch longer than 6 h without any bolus, SMB or temp basal (a loop sets temp basals
 *    every few minutes; hours with nothing at all mean the phone or the upload was off, and the profile basal filled
 *    in for those hours would only be a guess);
 *  - its total is above 0.
 * At least 2 such days are needed, else there is no estimate (the app then falls back to the reservoir's percent).
 */
export const RESERVOIR_USAGE_POLICY = {
  version: 'reservoir-usage.v1',
  lookback_days: 7,
  min_valid_days: 2,
  max_event_gap_hours: 6,
  /** The average changes slowly: recomputed at most hourly. */
  cache_ms: 60 * 60_000,
  /** After a failed read the dashboard goes without an estimate for a while instead of asking on every refresh. */
  retry_after_failure_ms: 10 * 60_000,
  /** Temp basals running at a day's start began up to this long before it. */
  events_lead_ms: 6 * 60 * 60_000,
} as const;

export interface DailyInsulinUsage {
  /** Average total daily insulin (U/day) over the valid days, two decimals. */
  average_daily_units: number;
  /** The local dates averaged, oldest first. */
  dates: string[];
  /** Full days looked at (up to 7). */
  days_considered: number;
}

/** The full local days the estimate looks at and the event range to read for them; null when there are none. */
export function usageWindow(now: Date, timezone: string): { days: Array<{ date: string; from: string; to: string; complete: boolean }>; eventsFrom: string; eventsTo: string } | null {
  const lookbackMs = (RESERVOIR_USAGE_POLICY.lookback_days + 2) * 86_400_000;
  const days = localDayWindows(new Date(now.getTime() - lookbackMs).toISOString(), now.toISOString(), timezone)
    .filter((day) => day.complete)
    .slice(-RESERVOIR_USAGE_POLICY.lookback_days);
  if (days.length === 0) return null;
  return {
    days,
    eventsFrom: new Date(Date.parse(days[0].from) - RESERVOIR_USAGE_POLICY.events_lead_ms).toISOString(),
    eventsTo: days[days.length - 1].to,
  };
}

export function estimateDailyInsulinUsage(args: {
  now: Date;
  timezone: string;
  events: InsulinDeliveryEvent[];
  basalSchedule: Array<[string, number]> | null | undefined;
}): DailyInsulinUsage | null {
  const window = usageWindow(args.now, args.timezone);
  if (!window) return null;
  const totals = buildDailyInsulinTotals({
    days: window.days,
    events: args.events,
    basalSchedule: args.basalSchedule,
    profileTimezone: args.timezone,
  });
  const eventTimes = args.events
    .filter((event) => ['BOLUS', 'SMB', 'TEMP_BASAL'].includes(String(event.type).toUpperCase()))
    .map((event) => Date.parse(event.occurred_at))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const valid = totals.days.filter((day) => day.complete
    && day.status === 'KNOWN'
    && day.total_units !== null
    && day.total_units > 0
    && !hasDataGap(eventTimes, Date.parse(day.from), Date.parse(day.to)));
  if (valid.length < RESERVOIR_USAGE_POLICY.min_valid_days) return null;
  const sum = valid.reduce((total, day) => total + (day.total_units as number), 0);
  return {
    average_daily_units: Math.round((sum / valid.length) * 100) / 100,
    dates: valid.map((day) => day.date),
    days_considered: window.days.length,
  };
}

/** A stretch longer than the allowed gap without any insulin event inside [from, to), the day's edges included. */
function hasDataGap(sortedTimes: number[], fromMs: number, toMs: number): boolean {
  const maxGapMs = RESERVOIR_USAGE_POLICY.max_event_gap_hours * 3_600_000;
  let previous = fromMs;
  for (const time of sortedTimes) {
    if (time < fromMs) continue;
    if (time >= toMs) break;
    if (time - previous > maxGapMs) return true;
    previous = time;
  }
  return toMs - previous > maxGapMs;
}

/** The reads the estimate needs (PostgresGlucoMindRepository). */
export interface ReservoirUsageSource {
  listInsulinDeliveryEventsByRange(args: { patientId: string; startAtIso: string; endAtIso: string }): Promise<InsulinDeliveryEvent[]>;
  getTherapyProfileAt(patientId: string, atIso: string): Promise<{ status: string; basal_u_per_h?: unknown; timezone?: string | null }>;
}

const DEFAULT_TIMEZONE = 'Europe/Warsaw';

/**
 * The estimate per patient, cached for an hour (a failed read for 10 minutes). Fails open: null when it cannot be
 * computed, and the dashboard falls back to the reservoir's percent.
 */
export class ReservoirUsageEstimator {
  private readonly cache = new Map<string, { value: DailyInsulinUsage | null; expiresAtMs: number }>();
  private readonly pending = new Map<string, Promise<DailyInsulinUsage | null>>();

  constructor(private readonly source: ReservoirUsageSource) {}

  async usage(patientId: string, now: Date): Promise<DailyInsulinUsage | null> {
    const cached = this.cache.get(patientId);
    if (cached && cached.expiresAtMs > now.getTime()) return cached.value;
    const running = this.pending.get(patientId);
    if (running) return running;
    const read = this.compute(patientId, now)
      .then((value) => {
        this.cache.set(patientId, { value, expiresAtMs: now.getTime() + RESERVOIR_USAGE_POLICY.cache_ms });
        return value;
      })
      .catch(() => {
        this.cache.set(patientId, { value: null, expiresAtMs: now.getTime() + RESERVOIR_USAGE_POLICY.retry_after_failure_ms });
        return null;
      })
      .finally(() => this.pending.delete(patientId));
    this.pending.set(patientId, read);
    return read;
  }

  private async compute(patientId: string, now: Date): Promise<DailyInsulinUsage | null> {
    const profile = await this.source.getTherapyProfileAt(patientId, now.toISOString());
    const timezone = profile.timezone && isValidTimeZone(profile.timezone) ? profile.timezone : DEFAULT_TIMEZONE;
    const window = usageWindow(now, timezone);
    if (!window) return null;
    const events = await this.source.listInsulinDeliveryEventsByRange({ patientId, startAtIso: window.eventsFrom, endAtIso: window.eventsTo });
    return estimateDailyInsulinUsage({
      now,
      timezone,
      events,
      basalSchedule: profile.status === 'KNOWN' ? (profile.basal_u_per_h as Array<[string, number]>) : null,
    });
  }
}

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
