import { describe, expect, it } from 'vitest';
import { buildDashboardTimeInRange, parseDashboardTimeInRangeDays } from './dashboard-time-in-range';

const NOW = new Date('2026-10-23T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

describe('parseDashboardTimeInRangeDays', () => {
  it('accepts 1, 7 and 14 only', () => {
    expect(parseDashboardTimeInRangeDays('1')).toBe(1);
    expect(parseDashboardTimeInRangeDays('7')).toBe(7);
    expect(parseDashboardTimeInRangeDays('14')).toBe(14);
    for (const raw of ['30', '0', '7.5', '', undefined, 'abc']) {
      expect(typeof parseDashboardTimeInRangeDays(raw)).toBe('string');
    }
  });
});

describe('buildDashboardTimeInRange', () => {
  it('counts the readings of the period in five bands, each timestamp once', () => {
    const response = buildDashboardTimeInRange({
      patientId: 'p1',
      days: 7,
      now: NOW,
      readings: [
        { at: at(10), value: 54, direction: null },
        { at: at(15), value: 55, direction: null },
        { at: at(20), value: 69.6, direction: null },
        { at: at(25), value: 180, direction: null },
        { at: at(25), value: 180, direction: null },
        { at: at(30), value: 181, direction: null },
        { at: at(35), value: 250, direction: null },
        { at: at(40), value: 251, direction: null },
        { at: at(7 * 24 * 60 + 5), value: 300, direction: null },
        { at: at(45), value: 0, direction: null },
      ],
    });

    expect(response).toMatchObject({
      patient_id: 'p1',
      days: 7,
      from: '2026-10-16T12:00:00.000Z',
      to: '2026-10-23T12:00:00.000Z',
      readings_count: 7,
      counts: { very_low: 1, low: 1, in_range: 2, high: 2, very_high: 1 },
    });
  });

  it('measures the sensor coverage in 5-minute slots, so a 1-minute CGM does not count five times', () => {
    const everyMinuteForHalfADay = Array.from({ length: 12 * 60 }, (_, index) => ({ at: at(index), value: 120, direction: null }));
    const response = buildDashboardTimeInRange({ patientId: 'p1', days: 1, now: NOW, readings: everyMinuteForHalfADay });

    expect(response.readings_count).toBe(720);
    expect(response.sensor_coverage_percent).toBe(50);
  });
});
