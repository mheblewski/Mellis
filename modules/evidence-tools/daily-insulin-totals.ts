/**
 * Deterministic daily insulin totals (TDD) for the local days of a range: boluses, SMBs and the basal the loop actually
 * delivered. Delivered basal is the recorded temp basals (each runs for its duration or until the next one starts) and
 * the profile basal in the gaps between them. A minute whose rate cannot be known (temp basal without a usable rate or
 * duration, no profile) makes that day's basal and total unknown: an unknown amount is never counted as 0.
 */

export const DAILY_INSULIN_TOTALS_POLICY_VERSION = 'daily-insulin-totals.v1' as const;

export interface DailyInsulinTotalsDay {
  date: string;
  from: string;
  to: string;
  /** false: the day is clipped (today so far, or the range starts after its midnight); not a full-day total. */
  complete: boolean;
  /** NOT_IMPORTED: the day is older than the Nightscout history Mellis holds (nightscout-history.v1): unknown, not basal only. */
  status: 'KNOWN' | 'BASAL_UNKNOWN' | 'DOSE_UNKNOWN' | 'NOT_SELECTED' | 'NOT_IMPORTED';
  bolus_units: number | null;
  smb_units: number | null;
  basal_units: number | null;
  total_units: number | null;
  bolus_count: number;
  smb_count: number;
  basal_minutes: { temp_basal: number; profile: number; unknown: number };
}

export interface DailyInsulinTotals {
  policy_version: typeof DAILY_INSULIN_TOTALS_POLICY_VERSION;
  note: string;
  /** Averages over complete days with KNOWN status only; null when there is no such day. */
  complete_day_average: { days: number; bolus_units: number; smb_units: number; basal_units: number; total_units: number } | null;
  days: DailyInsulinTotalsDay[];
}

export interface InsulinDeliveryEvent {
  event_id?: string;
  type: string;
  occurred_at: string;
  payload?: Record<string, unknown> | null;
}

const MINUTE_MS = 60 * 1000;

function finite(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Same rule as the basal evidence tool: rate and absolute that disagree leave the delivered rate unknown. */
function tempBasalRate(payload: Record<string, unknown>): number | null {
  const rate = finite(payload.rate);
  const absolute = finite(payload.absolute);
  if (rate !== null && absolute !== null && rate !== absolute) return null;
  const value = absolute ?? rate;
  return value !== null && value >= 0 ? value : null;
}

/** Profile basal schedule [HH:MM, U/h] as minutes of day, sorted; null when unusable. */
function parseSchedule(schedule: Array<[string, number]> | null | undefined): Array<{ minute: number; rate: number }> | null {
  if (!Array.isArray(schedule) || schedule.length === 0) return null;
  const entries = schedule
    .map(([time, rate]) => {
      const match = /^(\d{1,2}):(\d{2})/.exec(String(time));
      const value = finite(rate);
      if (!match || value === null || value < 0) return null;
      return { minute: Number(match[1]) * 60 + Number(match[2]), rate: value };
    })
    .filter((entry): entry is { minute: number; rate: number } => entry !== null)
    .sort((left, right) => left.minute - right.minute);
  return entries.length > 0 ? entries : null;
}

/** Minute of day in `timezone`, cached per UTC quarter hour (offsets change on whole quarter hours at most). */
export function makeLocalMinuteOfDay(timezone: string): (ms: number) => number | null {
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch {
    return () => null;
  }
  const cache = new Map<number, number>();
  return (ms: number) => {
    const quarter = Math.floor(ms / (15 * MINUTE_MS));
    let base = cache.get(quarter);
    if (base === undefined) {
      const parts = formatter!.formatToParts(new Date(quarter * 15 * MINUTE_MS));
      base = Number(parts.find((part) => part.type === 'hour')?.value) * 60 + Number(parts.find((part) => part.type === 'minute')?.value);
      cache.set(quarter, base);
    }
    return (base + Math.floor((ms - quarter * 15 * MINUTE_MS) / MINUTE_MS)) % 1440;
  };
}

export function buildDailyInsulinTotals(args: {
  days: Array<{ date: string; from: string; to: string; complete: boolean }>;
  /** BOLUS, SMB and TEMP_BASAL events of the range (other types are ignored), including temp basals started shortly before it. */
  events: InsulinDeliveryEvent[];
  basalSchedule: Array<[string, number]> | null | undefined;
  /** Timezone of the profile schedule (the profile's own, else the request's). */
  profileTimezone: string;
  /**
   * When the event selection was cut by its row limit (it keeps the most recent events): data before this instant was
   * not selected, so every day starting before it is NOT_SELECTED.
   */
  selectedFrom?: string | null;
  /**
   * The Nightscout history is complete in Mellis only from this instant (still importing, or older than the import):
   * every day starting before it is NOT_IMPORTED, never "profile basal only".
   */
  importedFrom?: string | null;
}): DailyInsulinTotals {
  const schedule = parseSchedule(args.basalSchedule);
  const localMinute = makeLocalMinuteOfDay(args.profileTimezone);
  const profileRateAt = (ms: number): number | null => {
    if (!schedule) return null;
    const minute = localMinute(ms);
    if (minute === null) return null;
    let rate = schedule[schedule.length - 1].rate;
    for (const entry of schedule) {
      if (entry.minute <= minute) rate = entry.rate;
    }
    return rate;
  };

  const seen = new Set<string>();
  const events = args.events
    .filter((event) => {
      const id = typeof event.event_id === 'string' && event.event_id.length > 0 ? event.event_id : null;
      if (id === null) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((event) => ({ ...event, at: Date.parse(event.occurred_at), type: String(event.type).toUpperCase(), payload: (event.payload ?? {}) as Record<string, unknown> }))
    .filter((event) => Number.isFinite(event.at))
    .sort((left, right) => left.at - right.at);

  // Temp basal segments: each runs for its duration, cut short by the next temp basal (a duration of 0 cancels).
  const temps = events.filter((event) => event.type === 'TEMP_BASAL');
  const segments = temps.map((event, index) => {
    const duration = finite(event.payload.duration_minutes ?? event.payload.duration);
    const nextAt = temps[index + 1]?.at ?? Number.POSITIVE_INFINITY;
    const end = duration === null ? nextAt : Math.min(event.at + duration * MINUTE_MS, nextAt);
    // A temp basal without a duration and without a following one has no known end: unknown until the range end.
    return { start: event.at, end, rate: duration === null && !Number.isFinite(nextAt) ? null : tempBasalRate(event.payload) };
  }).filter((segment) => segment.end > segment.start);

  const selectedFromMs = args.selectedFrom ? Date.parse(args.selectedFrom) : Number.NaN;
  const importedFromMs = args.importedFrom ? Date.parse(args.importedFrom) : Number.NaN;
  const unknownDay = (day: (typeof args.days)[number], status: 'NOT_SELECTED' | 'NOT_IMPORTED'): DailyInsulinTotalsDay => ({ ...day, status, bolus_units: null, smb_units: null, basal_units: null, total_units: null, bolus_count: 0, smb_count: 0, basal_minutes: { temp_basal: 0, profile: 0, unknown: 0 } });

  const days = args.days.map((day): DailyInsulinTotalsDay => {
    const fromMs = Date.parse(day.from);
    const toMs = Date.parse(day.to);
    if (Number.isFinite(importedFromMs) && fromMs < importedFromMs) return unknownDay(day, 'NOT_IMPORTED');
    if (Number.isFinite(selectedFromMs) && fromMs < selectedFromMs) return unknownDay(day, 'NOT_SELECTED');

    const doses = events.filter((event) => (event.type === 'BOLUS' || event.type === 'SMB') && event.at >= fromMs && event.at < toMs);
    const sumOf = (type: 'BOLUS' | 'SMB'): { units: number | null; count: number } => {
      const amounts = doses.filter((event) => event.type === type).map((event) => finite(event.payload.insulin_units ?? event.payload.insulin));
      return { units: amounts.some((amount) => amount === null) ? null : round2(amounts.reduce<number>((sum, amount) => sum + (amount as number), 0)), count: amounts.length };
    };
    const bolus = sumOf('BOLUS');
    const smb = sumOf('SMB');

    // Delivered basal, minute by minute (rate at the middle of each minute; error well below 0.01 U a day).
    let basal = 0;
    const minutes = { temp_basal: 0, profile: 0, unknown: 0 };
    let segmentIndex = 0;
    for (let at = fromMs; at < toMs; at += MINUTE_MS) {
      const stepMs = Math.min(MINUTE_MS, toMs - at);
      const mid = at + stepMs / 2;
      while (segmentIndex < segments.length && segments[segmentIndex].end <= mid) segmentIndex += 1;
      const segment = segments[segmentIndex] && segments[segmentIndex].start <= mid ? segments[segmentIndex] : null;
      const rate = segment ? segment.rate : profileRateAt(mid);
      if (rate === null) {
        minutes.unknown += stepMs / MINUTE_MS;
        continue;
      }
      if (segment) minutes.temp_basal += stepMs / MINUTE_MS;
      else minutes.profile += stepMs / MINUTE_MS;
      basal += rate * (stepMs / (60 * MINUTE_MS));
    }
    const basalUnits = minutes.unknown > 0 ? null : round2(basal);
    const total = bolus.units === null || smb.units === null || basalUnits === null ? null : round2(bolus.units + smb.units + basalUnits);
    return {
      ...day,
      status: bolus.units === null || smb.units === null ? 'DOSE_UNKNOWN' : basalUnits === null ? 'BASAL_UNKNOWN' : 'KNOWN',
      bolus_units: bolus.units,
      smb_units: smb.units,
      basal_units: basalUnits,
      total_units: total,
      bolus_count: bolus.count,
      smb_count: smb.count,
      basal_minutes: { temp_basal: Math.round(minutes.temp_basal), profile: Math.round(minutes.profile), unknown: Math.round(minutes.unknown) },
    };
  });

  const full = days.filter((day) => day.complete && day.status === 'KNOWN');
  const average = (pick: (day: DailyInsulinTotalsDay) => number | null) => round2(full.reduce((sum, day) => sum + (pick(day) as number), 0) / full.length);
  return {
    policy_version: DAILY_INSULIN_TOTALS_POLICY_VERSION,
    note: 'Daily insulin totals (TDD) per local day: bolus + SMB + delivered basal. Delivered basal = the loop\'s recorded temp basals plus the profile basal in the gaps between them (a profile percentage switch is not visible). complete=false marks a partial day (today so far): never average it with full days, report it separately. complete_day_average uses only complete days with status KNOWN. status BASAL_UNKNOWN/DOSE_UNKNOWN/NOT_SELECTED/NOT_IMPORTED: that day\'s total is unknown, not zero (NOT_IMPORTED: older than the Nightscout history Mellis holds).',
    complete_day_average: full.length === 0 ? null : {
      days: full.length,
      bolus_units: average((day) => day.bolus_units),
      smb_units: average((day) => day.smb_units),
      basal_units: average((day) => day.basal_units),
      total_units: average((day) => day.total_units),
    },
    days,
  };
}

export interface BasalSegment {
  start: string;
  end: string;
  /** U/h delivered; null when unknown (temp basal without a usable rate, no profile). */
  rate: number | null;
  source: 'TEMP_BASAL' | 'PROFILE' | 'UNKNOWN';
}

/**
 * Delivered basal over [from, to) as runs of one rate, by the same rule as the daily totals: recorded temp basals
 * (each for its duration or until the next one) and the profile basal in the gaps. For drawing the basal on a chart.
 */
export function deliveredBasalSegments(args: {
  from: string;
  to: string;
  /** TEMP_BASAL events (others are ignored), including ones started shortly before `from`. */
  events: InsulinDeliveryEvent[];
  basalSchedule: Array<[string, number]> | null | undefined;
  profileTimezone: string;
}): BasalSegment[] {
  const schedule = parseSchedule(args.basalSchedule);
  const localMinute = makeLocalMinuteOfDay(args.profileTimezone);
  const profileRateAt = (ms: number): number | null => {
    if (!schedule) return null;
    const minute = localMinute(ms);
    if (minute === null) return null;
    let rate = schedule[schedule.length - 1].rate;
    for (const entry of schedule) {
      if (entry.minute <= minute) rate = entry.rate;
    }
    return rate;
  };
  const temps = args.events
    .filter((event) => String(event.type).toUpperCase() === 'TEMP_BASAL')
    .map((event) => ({ at: Date.parse(event.occurred_at), payload: (event.payload ?? {}) as Record<string, unknown> }))
    .filter((event) => Number.isFinite(event.at))
    .sort((left, right) => left.at - right.at);
  const segments = temps.map((event, index) => {
    const duration = finite(event.payload.duration_minutes ?? event.payload.duration);
    const nextAt = temps[index + 1]?.at ?? Number.POSITIVE_INFINITY;
    const end = duration === null ? nextAt : Math.min(event.at + duration * MINUTE_MS, nextAt);
    return { start: event.at, end, rate: duration === null && !Number.isFinite(nextAt) ? null : tempBasalRate(event.payload) };
  }).filter((segment) => segment.end > segment.start);

  const fromMs = Date.parse(args.from);
  const toMs = Date.parse(args.to);
  const runs: Array<{ start: number; end: number; rate: number | null; source: BasalSegment['source'] }> = [];
  let segmentIndex = 0;
  for (let at = fromMs; at < toMs; at += MINUTE_MS) {
    const end = Math.min(at + MINUTE_MS, toMs);
    const mid = (at + end) / 2;
    while (segmentIndex < segments.length && segments[segmentIndex].end <= mid) segmentIndex += 1;
    const segment = segments[segmentIndex] && segments[segmentIndex].start <= mid ? segments[segmentIndex] : null;
    const rate = segment ? segment.rate : profileRateAt(mid);
    const source: BasalSegment['source'] = rate === null ? 'UNKNOWN' : segment ? 'TEMP_BASAL' : 'PROFILE';
    const last = runs[runs.length - 1];
    if (last && last.rate === rate && last.source === source && last.end === at) {
      last.end = end;
    } else {
      runs.push({ start: at, end, rate, source });
    }
  }
  return runs.map((run) => ({
    start: new Date(run.start).toISOString(),
    end: new Date(run.end).toISOString(),
    rate: run.rate === null ? null : round2(run.rate),
    source: run.source,
  }));
}
