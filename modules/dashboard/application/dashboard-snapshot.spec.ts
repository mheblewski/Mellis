import { describe, expect, it } from 'vitest';
import { buildDashboard, type DashboardGlucoseReading } from './dashboard-snapshot';

const NOW = new Date('2026-10-17T12:41:00.000Z');

function reading(minutesAgo: number, value: number, direction: string | null = 'Flat'): DashboardGlucoseReading {
  return { at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(), value, direction };
}

function build(readings: DashboardGlucoseReading[], raw_payload: Record<string, unknown> | null = null) {
  return buildDashboard({
    patientId: 'patient-1',
    now: NOW,
    readings,
    deviceStatus: raw_payload ? { observed_at: '2026-10-17T12:39:00.000Z', raw_payload } : null,
    careEvents: { site_changed_at: '2026-10-16T09:10:00.000Z', sensor_started_at: '2026-10-12T15:30:00.000Z' },
  });
}

describe('buildDashboard', () => {
  it('shows the latest reading with its direction and the change against the reading 5 minutes earlier', () => {
    const dashboard = build([reading(13, 110), reading(8, 115), reading(3, 124, 'FortyFiveUp')]);

    expect(dashboard.glucose).toEqual({
      value: 124,
      unit: 'mg/dL',
      direction: 'FortyFiveUp',
      observed_at: '2026-10-17T12:38:00.000Z',
      delta: 9,
    });
    expect(dashboard.readings.map((point) => point.value)).toEqual([110, 115, 124]);
  });

  it('scales the change to 5 minutes for a 1-minute CGM and for a gap', () => {
    expect(build([reading(6, 100), reading(5, 101), reading(1, 105)]).glucose?.delta).toBe(5);
    expect(build([reading(11, 100), reading(1, 120)]).glucose?.delta).toBe(10);
  });

  it('leaves the change unknown without a reading 2.5–15 minutes earlier', () => {
    expect(build([reading(40, 100), reading(1, 120)]).glucose?.delta).toBeNull();
    expect(build([reading(1, 120)]).glucose?.delta).toBeNull();
  });

  it('computes 24 h time in range (70–180) with low and high shares that add up to 100', () => {
    const readings = [
      reading(25 * 60, 40),
      reading(600, 65), reading(500, 69),
      ...Array.from({ length: 14 }, (_, index) => reading(400 - index * 5, 70 + index * 8)),
      reading(100, 181), reading(90, 250), reading(80, 300), reading(70, 200),
    ];
    const tir = build(readings).time_in_range;

    expect(tir).toEqual({ hours: 24, readings_count: 20, low_percent: 10, in_range_percent: 70, high_percent: 20 });
  });

  it('drops readings older than 24 h and duplicated timestamps', () => {
    const dashboard = build([reading(24 * 60 + 1, 300), reading(10, 120), reading(10, 120), reading(5, 125)]);

    expect(dashboard.readings).toHaveLength(2);
    expect(dashboard.time_in_range?.readings_count).toBe(2);
  });

  it('reads Trio pump battery, reservoir and last contact', () => {
    const dashboard = build([reading(3, 124)], {
      pump: { clock: '2026-10-17T12:37:15.474Z', battery: { percent: 51 }, reservoir: 69.4 },
    });

    expect(dashboard.pump).toEqual({
      battery_percent: 51,
      reservoir_units: 69.4,
      reservoir_full_units: null,
      reservoir_hours_left: null,
      // Without a usage estimate or a fill: the fixed 25/10 U.
      reservoir_level: 'normal',
      last_read_at: '2026-10-17T12:37:15.474Z',
    });
  });

  it('says how long the reservoir lasts at the average daily insulin, and colours it by that', () => {
    const withUsage = (units: number, averageDailyInsulinUnits: number | null, filled: number | null = 180) => buildDashboard({
      patientId: 'patient-1', now: NOW, readings: [], loopStatus: null,
      deviceStatus: { observed_at: '2026-10-17T12:39:00.000Z', raw_payload: { pump: { reservoir: units } } },
      careEvents: { site_changed_at: null, sensor_started_at: null, reservoir_changed_at: null, reservoir_filled_units: filled },
      averageDailyInsulinUnits,
    }).pump;

    expect(withUsage(22, 12)).toMatchObject({ reservoir_hours_left: 44, reservoir_level: 'normal' });
    expect(withUsage(10, 12)).toMatchObject({ reservoir_hours_left: 20, reservoir_level: 'warning' });
    expect(withUsage(3, 12)).toMatchObject({ reservoir_hours_left: 6, reservoir_level: 'alarm' });
    // No estimate: percent of the fill (15 % / 7 %).
    expect(withUsage(22, null)).toMatchObject({ reservoir_hours_left: null, reservoir_level: 'warning' });
    expect(withUsage(12, null)).toMatchObject({ reservoir_hours_left: null, reservoir_level: 'alarm' });
    // Neither: the old 25/10 U.
    expect(withUsage(22, null, null)).toMatchObject({ reservoir_hours_left: null, reservoir_level: 'warning' });
  });

  it('takes the level after the last reservoir change as the full reservoir, never below the current level', () => {
    const withFill = (filled: number) => buildDashboard({
      patientId: 'patient-1', now: NOW, readings: [], loopStatus: null,
      deviceStatus: { observed_at: '2026-10-17T12:39:00.000Z', raw_payload: { pump: { reservoir: 69.4 } } },
      careEvents: { site_changed_at: null, sensor_started_at: null, reservoir_changed_at: '2026-10-14T10:51:44.000Z', reservoir_filled_units: filled },
    });

    expect(withFill(180).pump?.reservoir_full_units).toBe(180);
    expect(withFill(60).pump?.reservoir_full_units).toBe(69.4);
  });

  it('falls back to the upload time without a pump clock and drops Omnipod "50+ U" magic numbers', () => {
    const dashboard = build([reading(3, 124)], { pump: { reservoir: 3995 } });

    expect(dashboard.pump).toEqual({ battery_percent: null, reservoir_units: null, reservoir_full_units: null, reservoir_hours_left: null, reservoir_level: null, last_read_at: '2026-10-17T12:39:00.000Z' });
  });

  it('reads IOB and COB from Trio (openaps, the suggestion wins for COB) and from Loop', () => {
    const at = '2026-10-17T12:39:00.000Z';
    const trio = buildDashboard({
      patientId: 'patient-1', now: NOW, readings: [], deviceStatus: null, careEvents: null,
      loopStatus: { observed_at: at, raw_payload: { openaps: { iob: { iob: 1.5039999999999996 }, enacted: { COB: 6 }, suggested: { COB: 5.6 } } } },
    });
    expect(trio.loop).toEqual({ iob_units: 1.5, cob_grams: 6, observed_at: at });

    const loop = buildDashboard({
      patientId: 'patient-1', now: NOW, readings: [], deviceStatus: null, careEvents: null,
      loopStatus: { observed_at: at, raw_payload: { loop: { iob: { iob: 0.853 }, cob: { cob: 12.4 } } } },
    });
    expect(loop.loop).toEqual({ iob_units: 0.85, cob_grams: 12, observed_at: at });

    const none = buildDashboard({
      patientId: 'patient-1', now: NOW, readings: [], deviceStatus: null, careEvents: null,
      loopStatus: { observed_at: at, raw_payload: { openaps: {} } },
    });
    expect(none.loop).toBeNull();
  });

  it('returns empty sections when nothing was synced', () => {
    const dashboard = buildDashboard({ patientId: 'patient-1', now: NOW, readings: [], deviceStatus: null, careEvents: null });

    expect(dashboard).toMatchObject({
      glucose: null,
      readings: [],
      time_in_range: null,
      pump: null,
      loop: null,
      site_changed_at: null,
      sensor_started_at: null,
    });
  });
});
