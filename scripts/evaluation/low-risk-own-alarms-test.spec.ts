import { describe, expect, it, vi } from 'vitest';

// The script reads a database; the tests use its pure parts on made-up readings.
vi.mock('pg', () => ({ Pool: vi.fn() }));

import { assertLocalDatabase, avertedReadings, episodesToAvert, lastWholeDays, lowEpisodes, runOwnAlarmsTest, verdict, type VariantScore } from './low-risk-own-alarms-test';

const MINUTE = 60_000;
const END = Date.parse('2026-11-07T12:00:00.000Z');

function series(values: number[], step = 5) {
  return values.map((value, index) => ({ at: new Date(END - (values.length - 1 - index) * step * MINUTE).toISOString(), value }));
}

/** A slide below 70 every 5 hours, as in low-risk.spec.ts. */
function history(days: number) {
  const values: number[] = [];
  let seed = 7;
  const noise = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed % 7) - 3;
  };
  for (let i = 0; i < days * 288; i += 1) {
    const phase = i % 60;
    values.push(phase < 40 ? 140 + noise() : phase < 50 ? 140 - (phase - 40) * 8 + noise() : 62 + (phase - 50) * 8 + noise());
  }
  return series(values);
}

describe('lowEpisodes', () => {
  it('joins readings below 70 less than 30 min apart and marks one below 54', () => {
    const readings = series([100, 65, 60, 80, 68, 100, 100, 100, 100, 100, 100, 100, 50, 100]);
    const episodes = lowEpisodes(readings);
    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toEqual({ start_ms: Date.parse(readings[1].at), end_ms: Date.parse(readings[4].at), very_low: false });
    expect(episodes[1].very_low).toBe(true);
  });
});

describe('stopped lows', () => {
  it('takes every second episode with an alert 60-5 min before it, and lifts only those readings', () => {
    const readings = series([100, 100, 100, 60, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 62, 100]);
    const episodes = lowEpisodes(readings);
    const alerts = episodes.map((episode) => episode.start_ms - 10 * MINUTE);
    const averted = episodesToAvert(episodes, alerts);
    expect(averted).toEqual([episodes[0]]);
    expect(episodesToAvert(episodes, [episodes[0].start_ms - 2 * MINUTE, episodes[0].start_ms - 90 * MINUTE])).toEqual([]);
    const lifted = avertedReadings(readings, averted);
    expect(lifted[3].value).toBe(72);
    expect(lifted[16].value).toBe(62);
    expect(lifted.filter((reading, index) => reading.value !== readings[index].value)).toHaveLength(1);
  });
});

describe('lastWholeDays', () => {
  it('leaves out the newest day', () => {
    expect(lastWholeDays(['2026-11-01', '2026-11-02', '2026-11-02', '2026-11-03', '2026-11-04'], 2)).toEqual(['2026-11-02', '2026-11-03']);
  });
});

describe('verdict', () => {
  const score = (warned: number, alarms: number, veryLow = 3): VariantScore => ({ variant: '', episodes: 20, warned, very_low_episodes: 4, very_low_warned: veryLow, alarms_per_day: alarms, false_per_day: 0, false_without_real_alert_per_day: 0, mean_threshold: 0.5, mean_censored_rows: null, fits: 14, by_day: [] });
  it('asks for all three conditions', () => {
    expect(verdict({ A0: score(12, 4), A1: score(9, 3.9), B0: score(12, 4.8), B1: score(11, 4.5) })).toEqual({ problem_matters: true, fix_costs_little: true, fix_recovers: true, worth_shipping: true });
    expect(verdict({ A0: score(12, 4), A1: score(11, 3.9), B0: score(12, 4.8), B1: score(12, 4.5) }).problem_matters).toBe(false);
    expect(verdict({ A0: score(12, 4), A1: score(9, 3.9), B0: score(12, 5.1), B1: score(11, 4.5) }).worth_shipping).toBe(false);
    expect(verdict({ A0: score(12, 4), A1: score(9, 3.9), B0: score(12, 4.8, 2), B1: score(11, 4.5) }).fix_costs_little).toBe(false);
    expect(verdict({ A0: score(12, 4), A1: score(9, 3.9), B0: score(12, 4.8), B1: score(10, 4.5) }).fix_recovers).toBe(false);
  });
});

describe('assertLocalDatabase', () => {
  it('refuses anything but this machine', () => {
    expect(assertLocalDatabase('postgres:///glucomind_family_20261109')).toBe('postgres:///glucomind_family_20261109');
    expect(assertLocalDatabase('postgres://localhost/x')).toBe('postgres://localhost/x');
    expect(() => assertLocalDatabase('postgres://user@mellis.example.com/prod')).toThrow(/this machine/);
    expect(() => assertLocalDatabase(undefined)).toThrow(/required/);
  });
});

describe('runOwnAlarmsTest', () => {
  it('scores every variant on the same real episodes and prints no rows', () => {
    const readings = history(30);
    const alerts = lowEpisodes(readings).map((episode) => episode.start_ms - 20 * MINUTE);
    const result = runOwnAlarmsTest({ readings, carbTimesMs: [], alertTimesMs: alerts });
    expect(result.test_days).toBe(14);
    expect(result.scores).toHaveLength(6);
    expect(new Set(result.scores.map((row) => row.episodes)).size).toBe(1);
    expect(result.scores[0].episodes).toBeGreaterThan(40);
    expect(result.episodes_stopped_in_history_1).toBe(Math.ceil(result.episodes_all / 2));
    const [a0, , b0, , z0] = result.scores;
    expect(a0.fits).toBe(14);
    expect(z0.fits).toBe(1);
    expect(a0.mean_censored_rows).toBeNull();
    expect(b0.mean_censored_rows).toBeGreaterThan(0);
    expect(a0.warned).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('by_day');
  }, 120_000);
});
