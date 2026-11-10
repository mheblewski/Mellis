import { Pool } from 'pg';
import type { GlucosePoint } from '@modules/glucose-forecast/application/cgm-trend';
import { buildLowRiskRows, firstOfRuns, fitLowRisk, lowRiskScore, LOW_RISK_POLICY, type LowRiskParams, type LowRiskRows } from '@modules/glucose-forecast/application/low-risk';

/**
 * Offline test (research_notes/Predykcja glukozy lepsza niż pętle/niskie_wlasne_alarmy_plan_testu.md, conditions written
 * before any run): does low-risk.v1, refitted daily, lose warnings when lows are stopped after an alert, and does leaving
 * out "no low" rows near pushed alerts (fitLowRisk's alert_times_ms) repair it? Reads a LOCAL restore only and prints
 * aggregates: no patient-level rows leave the process.
 *
 *   DATABASE_URL=postgres:///glucomind_YYYYMMDD PATIENT_ID_PREFIX=xxxx npx tsx scripts/evaluation/low-risk-own-alarms-test.ts
 */
export const OWN_ALARMS_TEST = {
  test_days: 14,
  episode_gap_minutes: 30,
  very_low_mgdl: 54,
  /** An episode is warned by an alarm this long before its start. */
  warned_from_minutes: 60,
  warned_to_minutes: 15,
  /** A real pushed alert this long before an episode makes it a candidate for "stopped". */
  alert_before_from_minutes: 60,
  alert_before_to_minutes: 5,
  averted_floor_mgdl: 72,
  /** A false alarm with a real alert this near may be a stopped low. */
  near_alert_before_minutes: 45,
  near_alert_after_minutes: 60,
  bootstrap_draws: 2_000,
} as const;

const MINUTE = 60_000;

export interface Episode {
  start_ms: number;
  end_ms: number;
  very_low: boolean;
}

/** A reading below 70 when the one before it below 70 was at least 30 min earlier starts an episode. Readings oldest first. */
export function lowEpisodes(readings: GlucosePoint[]): Episode[] {
  const out: Episode[] = [];
  for (const reading of readings) {
    if (!(reading.value > 38) || reading.value >= LOW_RISK_POLICY.low_mgdl) continue;
    const at = Date.parse(reading.at);
    const last = out.at(-1);
    if (last && at - last.end_ms < OWN_ALARMS_TEST.episode_gap_minutes * MINUTE) {
      last.end_ms = at;
      last.very_low ||= reading.value < OWN_ALARMS_TEST.very_low_mgdl;
    } else {
      out.push({ start_ms: at, end_ms: at, very_low: reading.value < OWN_ALARMS_TEST.very_low_mgdl });
    }
  }
  return out;
}

/** Every second episode (in time order) that a real alert was pushed 60-5 min before: the ones the test pretends were stopped. */
export function episodesToAvert(episodes: Episode[], alertTimesMs: number[]): Episode[] {
  const { alert_before_from_minutes: from, alert_before_to_minutes: to } = OWN_ALARMS_TEST;
  const alerted = episodes.filter((episode) => alertTimesMs.some((at) => at >= episode.start_ms - from * MINUTE && at <= episode.start_ms - to * MINUTE));
  return alerted.filter((_, index) => index % 2 === 0);
}

/** The readings with those episodes lifted to at least 72: a history in which they did not happen. */
export function avertedReadings(readings: GlucosePoint[], averted: Episode[]): GlucosePoint[] {
  return readings.map((reading) => {
    const at = Date.parse(reading.at);
    const inside = reading.value > 38 && averted.some((episode) => at >= episode.start_ms && at <= episode.end_ms);
    return inside ? { at: reading.at, value: Math.max(reading.value, OWN_ALARMS_TEST.averted_floor_mgdl) } : reading;
  });
}

export interface VariantScore {
  variant: string;
  episodes: number;
  warned: number;
  very_low_episodes: number;
  very_low_warned: number;
  alarms_per_day: number;
  false_per_day: number;
  false_without_real_alert_per_day: number;
  /** Mean threshold and rows left out over the daily fits. */
  mean_threshold: number;
  mean_censored_rows: number | null;
  fits: number;
  /** Per test day, for the day bootstrap: [episodes, warned, alarms]. */
  by_day: Array<[number, number, number]>;
}

function warnedBy(alarms: number[], episode: Episode): boolean {
  const { warned_from_minutes: from, warned_to_minutes: to } = OWN_ALARMS_TEST;
  return alarms.some((at) => at >= episode.start_ms - from * MINUTE && at <= episode.start_ms - to * MINUTE);
}

/**
 * One variant, walk-forward: at the start of each test day the model is fitted on `trainRows` (the history it would
 * have seen, real or with stopped lows) and that day's REAL rows are scored with it.
 */
export function scoreVariant(input: {
  variant: string;
  realRows: LowRiskRows;
  trainRows: LowRiskRows;
  testDays: string[];
  episodes: Episode[];
  realAlertTimesMs: number[];
  /** Given: the fit leaves out "no low" rows near these. */
  censorAlertTimesMs?: number[];
  /** One fit before the first test day, kept for all of them. */
  frozen?: boolean;
}): VariantScore {
  const { realRows, trainRows, testDays } = input;
  const dayStart = new Map<string, number>();
  for (let i = 0; i < realRows.count; i += 1) if (!dayStart.has(realRows.days[i])) dayStart.set(realRows.days[i], realRows.times[i]);
  const warnings: number[] = [];
  const thresholds: number[] = [];
  const censored: number[] = [];
  let params: LowRiskParams | null = null;
  let fits = 0;
  for (const day of testDays) {
    const start = dayStart.get(day);
    if (start === undefined) continue;
    if (!params || !input.frozen) {
      const fitted = fitLowRisk(trainRows, new Date(start), input.censorAlertTimesMs ? { alert_times_ms: input.censorAlertTimesMs } : {});
      // As on the server: a fit that cannot be made keeps the one before it.
      if (fitted) {
        params = fitted;
        fits += 1;
        thresholds.push(fitted.threshold);
        if (fitted.censored_rows !== undefined) censored.push(fitted.censored_rows);
      }
    }
    if (!params) continue;
    for (let i = 0; i < realRows.count; i += 1) {
      if (realRows.days[i] !== day || realRows.values[i] < LOW_RISK_POLICY.low_mgdl) continue;
      if (lowRiskScore(params, realRows.features[i]) >= params.threshold) warnings.push(realRows.times[i]);
    }
  }
  const alarms = firstOfRuns(warnings.sort((a, b) => a - b));
  const lowTimes: number[] = [];
  for (let i = 0; i < realRows.count; i += 1) if (realRows.values[i] < LOW_RISK_POLICY.low_mgdl) lowTimes.push(realRows.times[i]);
  const dayOf = (ms: number): string | null => {
    let found: string | null = null;
    for (const day of testDays) {
      const start = dayStart.get(day);
      if (start !== undefined && start <= ms) found = day;
    }
    return found;
  };
  const lastDayEnd = (() => {
    let end = -Infinity;
    for (let i = 0; i < realRows.count; i += 1) if (realRows.days[i] === testDays.at(-1)) end = realRows.times[i];
    return end;
  })();
  const firstStart = dayStart.get(testDays[0]) ?? Infinity;
  const tested = input.episodes.filter((episode) => episode.start_ms >= firstStart && episode.start_ms <= lastDayEnd);
  const isFalse = (at: number) => !lowTimes.some((low) => low > at && low <= at + LOW_RISK_POLICY.false_alarm_minutes * MINUTE);
  const nearRealAlert = (at: number) => input.realAlertTimesMs.some((alert) => alert >= at - OWN_ALARMS_TEST.near_alert_before_minutes * MINUTE && alert <= at + OWN_ALARMS_TEST.near_alert_after_minutes * MINUTE);
  const falseAlarms = alarms.filter(isFalse);
  const days = testDays.filter((day) => dayStart.has(day));
  const mean = (values: number[]) => (values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN);
  const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
  return {
    variant: input.variant,
    episodes: tested.length,
    warned: tested.filter((episode) => warnedBy(alarms, episode)).length,
    very_low_episodes: tested.filter((episode) => episode.very_low).length,
    very_low_warned: tested.filter((episode) => episode.very_low && warnedBy(alarms, episode)).length,
    alarms_per_day: round(alarms.length / days.length),
    false_per_day: round(falseAlarms.length / days.length),
    false_without_real_alert_per_day: round(falseAlarms.filter((at) => !nearRealAlert(at)).length / days.length),
    mean_threshold: round(mean(thresholds), 4),
    mean_censored_rows: censored.length > 0 ? Math.round(mean(censored)) : null,
    fits,
    by_day: days.map((day) => {
      const ofDay = tested.filter((episode) => dayOf(episode.start_ms) === day);
      return [ofDay.length, ofDay.filter((episode) => warnedBy(alarms, episode)).length, alarms.filter((at) => dayOf(at) === day).length];
    }),
  };
}

/** 95% interval of b − a by drawing whole days again: warned episodes and alarms a day. */
export function dayBootstrap(a: VariantScore, b: VariantScore, seed = 20261109): { warned: [number, number]; alarms_per_day: [number, number] } {
  const days = a.by_day.length;
  let state = seed;
  const next = () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
  const warned: number[] = [];
  const alarms: number[] = [];
  for (let draw = 0; draw < OWN_ALARMS_TEST.bootstrap_draws; draw += 1) {
    let warnedDiff = 0;
    let alarmDiff = 0;
    for (let k = 0; k < days; k += 1) {
      const day = Math.min(days - 1, Math.floor(next() * days));
      warnedDiff += b.by_day[day][1] - a.by_day[day][1];
      alarmDiff += b.by_day[day][2] - a.by_day[day][2];
    }
    warned.push(warnedDiff);
    alarms.push(alarmDiff / days);
  }
  const interval = (values: number[]): [number, number] => {
    const sorted = [...values].sort((x, y) => x - y);
    const at = (share: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * share)))];
    return [Math.round(at(0.025) * 100) / 100, Math.round(at(0.975) * 100) / 100];
  };
  return { warned: interval(warned), alarms_per_day: interval(alarms) };
}

/** The plan's three conditions, read from the scores. */
export function verdict(scores: Record<'A0' | 'A1' | 'B0' | 'B1', VariantScore>): { problem_matters: boolean; fix_costs_little: boolean; fix_recovers: boolean; worth_shipping: boolean } {
  const { A0, A1, B0, B1 } = scores;
  const lost = A0.warned - A1.warned;
  const problem = lost >= 2 || A1.alarms_per_day <= A0.alarms_per_day * 0.85;
  const cost = B0.warned >= A0.warned && B0.very_low_warned >= A0.very_low_warned && B0.alarms_per_day <= A0.alarms_per_day * 1.25;
  const recovers = lost > 0 && B1.warned - A1.warned >= lost / 2;
  return { problem_matters: problem, fix_costs_little: cost, fix_recovers: recovers, worth_shipping: problem && cost && recovers };
}

/** The last `count` whole days: the newest day is left out, a copy usually ends inside it. */
export function lastWholeDays(days: string[], count: number): string[] {
  const unique = [...new Set(days)].sort();
  return unique.slice(0, -1).slice(-count);
}

export function runOwnAlarmsTest(input: { readings: GlucosePoint[]; carbTimesMs: number[]; alertTimesMs: number[] }) {
  const readings = [...input.readings].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const realRows = buildLowRiskRows(readings, input.carbTimesMs);
  const episodes = lowEpisodes(readings);
  const averted = episodesToAvert(episodes, input.alertTimesMs);
  const avertedRows = buildLowRiskRows(avertedReadings(readings, averted), input.carbTimesMs);
  const testDays = lastWholeDays(realRows.days, OWN_ALARMS_TEST.test_days);
  const common = { realRows, testDays, episodes, realAlertTimesMs: input.alertTimesMs };
  const scores = {
    A0: scoreVariant({ ...common, variant: 'A0 today, real history', trainRows: realRows }),
    A1: scoreVariant({ ...common, variant: 'A1 today, stopped lows', trainRows: avertedRows }),
    B0: scoreVariant({ ...common, variant: 'B0 censored, real history', trainRows: realRows, censorAlertTimesMs: input.alertTimesMs }),
    B1: scoreVariant({ ...common, variant: 'B1 censored, stopped lows', trainRows: avertedRows, censorAlertTimesMs: input.alertTimesMs }),
  };
  const frozen = {
    Z0: scoreVariant({ ...common, variant: 'Z0 frozen, real history', trainRows: realRows, frozen: true }),
    Z1: scoreVariant({ ...common, variant: 'Z1 frozen, stopped lows', trainRows: avertedRows, frozen: true }),
  };
  const strip = ({ by_day: _days, ...rest }: VariantScore) => rest;
  return {
    test_days: testDays.length,
    first_test_day: testDays[0] ?? null,
    last_test_day: testDays.at(-1) ?? null,
    readings: readings.length,
    real_alerts: input.alertTimesMs.length,
    episodes_all: episodes.length,
    episodes_stopped_in_history_1: averted.length,
    scores: [...Object.values(scores), ...Object.values(frozen)].map(strip),
    intervals_95: {
      'A1 - A0': dayBootstrap(scores.A0, scores.A1),
      'B0 - A0': dayBootstrap(scores.A0, scores.B0),
      'B1 - A1': dayBootstrap(scores.A1, scores.B1),
    },
    verdict: verdict(scores),
  };
}

export class OwnAlarmsTestArgumentError extends Error {}

/** Only a database on this machine: a socket path or localhost. */
export function assertLocalDatabase(url: string | undefined): string {
  if (!url) throw new OwnAlarmsTestArgumentError('DATABASE_URL is required (a local restore)');
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new OwnAlarmsTestArgumentError('DATABASE_URL is not a URL');
  }
  if (!['', 'localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) throw new OwnAlarmsTestArgumentError('DATABASE_URL must point at this machine: this test never reads the server');
  return url;
}

async function main(): Promise<void> {
  const url = assertLocalDatabase(process.env.DATABASE_URL);
  const prefix = String(process.env.PATIENT_ID_PREFIX ?? '').trim();
  if (!/^[0-9a-f]{4,}$/i.test(prefix)) throw new OwnAlarmsTestArgumentError('PATIENT_ID_PREFIX is required (the first characters of the real patient id; never the test patient)');
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query('SET default_transaction_read_only = on');
    const like = `${prefix}%`;
    const patients = await pool.query<{ id: string }>(`SELECT id::text FROM patients WHERE id::text LIKE $1`, [like]);
    if (patients.rows.length !== 1) throw new OwnAlarmsTestArgumentError(`expected one patient for the prefix, found ${patients.rows.length}`);
    const patientId = patients.rows[0].id;
    const readings = await pool.query<{ at: Date; value: number }>(
      `SELECT occurred_at AS at, (payload->>'glucose_value')::float AS value FROM events
        WHERE type = 'GLUCOSE_READING_AVAILABLE' AND patient_id = $1::uuid ORDER BY occurred_at`,
      [patientId],
    );
    // A live entry counts from when it was stored: the model could not have known it earlier.
    const carbs = await pool.query<{ known: Date }>(
      `SELECT CASE WHEN e.event_ingestion_origin = 'LIVE' THEN greatest(e.created_at, e.occurred_at) ELSE e.occurred_at END AS known
         FROM events e LEFT JOIN carb_entry_kinds k ON k.patient_id = e.patient_id AND k.event_id = e.id
        WHERE e.type = 'CARB_ENTRY' AND e.patient_id = $1::uuid AND coalesce(k.kind, 'MEAL') <> 'IGNORED' AND (e.payload->>'carbs')::float > 0`,
      [patientId],
    );
    const alerts = await pool.query<{ at: Date }>(
      `SELECT notified_at AS at FROM rescue_carb_alerts WHERE patient_id = $1::uuid AND notified_at IS NOT NULL
       UNION
       SELECT reading_at FROM prediction_low_scores WHERE patient_id = $1::uuid AND pushed_to > 0`,
      [patientId],
    );
    const result = runOwnAlarmsTest({
      readings: readings.rows.map((row) => ({ at: new Date(row.at).toISOString(), value: Number(row.value) })),
      carbTimesMs: carbs.rows.map((row) => new Date(row.known).getTime()),
      alertTimesMs: alerts.rows.map((row) => new Date(row.at).getTime()).sort((a, b) => a - b),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof OwnAlarmsTestArgumentError ? error.message : error);
    process.exitCode = 1;
  });
}
