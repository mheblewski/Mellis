import { describe, expect, it } from 'vitest';
import { generateWatchToken, isWatchTokenShape, normalizeWatchDeviceLabel, parseWatchGlanceHours, sha256Hex, watchGlancePatient } from './watch-glance';

describe('Watch tokens', () => {
  it('are gmw_ + 43 base64url characters, distinct every time', () => {
    const a = generateWatchToken();
    const b = generateWatchToken();
    expect(a).toMatch(/^gmw_[A-Za-z0-9_-]{43}$/);
    expect(isWatchTokenShape(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(isWatchTokenShape('gmw_short')).toBe(false);
    expect(isWatchTokenShape('eyJhbGciOiJSUzI1NiJ9.x.y')).toBe(false);
    expect(sha256Hex(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('device labels are trimmed to 40 characters and empty ones dropped', () => {
    expect(normalizeWatchDeviceLabel(' fenix7 ')).toBe('fenix7');
    expect(normalizeWatchDeviceLabel('x'.repeat(60))).toHaveLength(40);
    expect(normalizeWatchDeviceLabel('a\u0000b')).toBe('ab');
    expect(normalizeWatchDeviceLabel('   ')).toBeNull();
    expect(normalizeWatchDeviceLabel(7)).toBeNull();
  });
});

describe('watchGlancePatient', () => {
  it('maps the dashboard reading and IOB/COB, rounded', () => {
    expect(watchGlancePatient('p-1', 'Ania', {
      glucose: { value: 112.4, unit: 'mg/dL', direction: 'FortyFiveUp', observed_at: '2026-11-03T10:00:30.000Z', delta: 3.6 },
      loop: { iob_units: 1.4567, cob_grams: 17.6, observed_at: '2026-11-03T10:00:00.000Z' },
    })).toEqual({ id: 'p-1', n: 'Ania', v: 112, dir: 'FortyFiveUp', dl: 4, at: 1793700030, iob: 1.46, cob: 18 });
  });

  it('leaves unknown values null', () => {
    expect(watchGlancePatient('p-2', 'A', null)).toEqual({ id: 'p-2', n: 'A', v: null, dir: null, dl: null, at: null, iob: null, cob: null });
    expect(watchGlancePatient('p-2', 'A', {
      glucose: { value: 90, unit: 'mg/dL', direction: null, observed_at: '2026-11-03T10:00:00.000Z', delta: null },
      loop: { iob_units: null, cob_grams: 0, observed_at: '2026-11-03T10:00:00.000Z' },
    })).toEqual({ id: 'p-2', n: 'A', v: 90, dir: null, dl: null, at: 1793700000, iob: null, cob: 0 });
  });
});

describe('watch glance history (chart)', () => {
  it('parses ?hours as whole hours 1-3 and ignores anything else', () => {
    expect(parseWatchGlanceHours(undefined)).toBeNull();
    expect(parseWatchGlanceHours('')).toBeNull();
    expect(parseWatchGlanceHours('abc')).toBeNull();
    expect(parseWatchGlanceHours('0')).toBeNull();
    expect(parseWatchGlanceHours('2')).toBe(2);
    expect(parseWatchGlanceHours('9')).toBe(3);
    expect(parseWatchGlanceHours('0.4')).toBe(1);
  });

  it('adds the last hours of readings, oldest first, only when asked', () => {
    const now = new Date('2026-11-03T12:00:00Z');
    const dashboard = {
      glucose: null,
      loop: null,
      readings: [
        { at: '2026-11-03T11:55:00Z', value: 120.4 },
        { at: '2026-11-03T09:30:00Z', value: 90 },
        { at: '2026-11-03T10:05:00Z', value: 100 },
      ],
    };
    expect(watchGlancePatient('p', 'Ania', dashboard as never).r).toBeUndefined();
    expect(watchGlancePatient('p', 'Ania', dashboard as never, { historyHours: 2, now }).r).toEqual([
      [Math.floor(Date.parse('2026-11-03T10:05:00Z') / 1000), 100],
      [Math.floor(Date.parse('2026-11-03T11:55:00Z') / 1000), 120],
    ]);
  });
});
