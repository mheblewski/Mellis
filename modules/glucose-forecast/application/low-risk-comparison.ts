import { LOW_RISK_POLICY } from './low-risk';

/**
 * The two ways of warning about a low, measured on the same readings (low-comparison.v1, owner 2026-11-09): the
 * low-risk model's alarms against the rescue rules' confirmed predicted lows (rescue-carbs.v2), both taken as "the first
 * warning of a run". Shown under the prediction experiment's switch once ready, so a second person's data can say
 * whether the model is worth alerting from. The numbers are rough by nature: whichever way is live gets its alerts
 * acted on, and a low stopped by carbs counts against the alert that stopped it.
 */
export const LOW_COMPARISON_POLICY = {
  version: 'low-comparison.v1',
  episode_gap_minutes: 30,
  /** A low is warned of by an alert this long before its first reading below 70. */
  warned_from_minutes: 60,
  warned_to_minutes: 15,
  /** Readings further apart than this are a gap: the time between them is not counted. */
  max_step_minutes: 10,
  /** Ready with two weeks and 20 lows, or with four weeks and 10 (someone with few lows). */
  ready: { min_days: 14, min_lows: 20 },
  ready_late: { min_days: 28, min_lows: 10 },
  recompute_after_hours: 20,
} as const;

const MINUTE = 60_000;

export interface LowComparisonRow {
  reading_at: string;
  glucose_mgdl: number;
  /** The model's warning for this reading. */
  alarm: boolean;
  /** The rules' warning for this reading; null: not recorded (rows from before the comparison). */
  rules_warning: boolean | null;
}

export interface LowComparisonSide {
  /** Lows with an alert 60-15 min before them. */
  lows_warned: number;
  alerts_per_day: number;
  /** Alerts with no reading below 70 in the hour after them. */
  alerts_without_low_per_day: number;
}

export interface LowComparison {
  policy_version: string;
  from: string | null;
  to: string | null;
  /** Days of readings with both verdicts, gaps left out. */
  days: number;
  lows: number;
  model: LowComparisonSide;
  rules: LowComparisonSide;
  /** Which of the two sends the alerts now. */
  live_source: 'MODEL' | 'RULES';
  ready: boolean;
}

/** The first warning of each run, runs broken by a pause longer than the model's quiet time. */
function alerts(times: number[]): number[] {
  const out: number[] = [];
  let last = -Infinity;
  for (const at of times) {
    if (at - last > LOW_RISK_POLICY.quiet_minutes * MINUTE) out.push(at);
    last = at;
  }
  return out;
}

export function compareLowWarnings(input: { rows: LowComparisonRow[]; live_source: 'MODEL' | 'RULES' }): LowComparison {
  const policy = LOW_COMPARISON_POLICY;
  const rows = input.rows
    .filter((row) => row.rules_warning !== null && Number.isFinite(Date.parse(row.reading_at)))
    .map((row) => ({ at: Date.parse(row.reading_at), glucose: row.glucose_mgdl, model: row.alarm, rules: row.rules_warning === true }))
    .sort((a, b) => a.at - b.at);
  let covered = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const step = rows[i].at - rows[i - 1].at;
    if (step <= policy.max_step_minutes * MINUTE) covered += step;
  }
  const days = covered / 86_400_000;
  const lowTimes = rows.filter((row) => row.glucose < LOW_RISK_POLICY.low_mgdl).map((row) => row.at);
  const starts: number[] = [];
  let lastLow = -Infinity;
  for (const at of lowTimes) {
    if (at - lastLow >= policy.episode_gap_minutes * MINUTE) starts.push(at);
    lastLow = at;
  }
  // A low right after a gap could not have been warned of by either way: it is left out.
  const lows = starts.filter((start) => rows.some((row) => row.at >= start - policy.warned_from_minutes * MINUTE && row.at <= start - policy.warned_to_minutes * MINUTE));
  const side = (warnings: number[]): LowComparisonSide => {
    const sent = alerts(warnings);
    const warned = lows.filter((start) => sent.some((at) => at >= start - policy.warned_from_minutes * MINUTE && at <= start - policy.warned_to_minutes * MINUTE)).length;
    const withoutLow = sent.filter((at) => !lowTimes.some((low) => low > at && low <= at + LOW_RISK_POLICY.false_alarm_minutes * MINUTE)).length;
    const perDay = (count: number) => (days > 0 ? Math.round((count / days) * 10) / 10 : 0);
    return { lows_warned: warned, alerts_per_day: perDay(sent.length), alerts_without_low_per_day: perDay(withoutLow) };
  };
  const enough = (rule: { min_days: number; min_lows: number }) => days >= rule.min_days && lows.length >= rule.min_lows;
  return {
    policy_version: policy.version,
    from: rows.length > 0 ? new Date(rows[0].at).toISOString() : null,
    to: rows.length > 0 ? new Date(rows[rows.length - 1].at).toISOString() : null,
    days: Math.round(days * 10) / 10,
    lows: lows.length,
    model: side(rows.filter((row) => row.model).map((row) => row.at)),
    rules: side(rows.filter((row) => row.rules).map((row) => row.at)),
    live_source: input.live_source,
    ready: enough(policy.ready) || enough(policy.ready_late),
  };
}

/** The push when the comparison is first ready. The owner asked for the result to be passed on to him (testers know him). */
export function lowComparisonPushText(): { title: string; body: string } {
  return {
    title: 'Porównanie ostrzeżeń przed spadkiem jest gotowe',
    body: 'Wynik jest w Ustawieniach, w funkcjach eksperymentalnych. Przekaż go Mateuszowi.',
  };
}
