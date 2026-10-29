import { describe, expect, it } from 'vitest';
import { formatReservoirDuration, reservoirStatus } from './reservoir-level';

describe('reservoirStatus (reservoir-level.v1)', () => {
  it('uses the hours left at the average use: yellow under 24 h, red under 8 h', () => {
    // 48 U a day = 2 U/h.
    expect(reservoirStatus({ units: 100, fullUnits: 200, averageDailyUnits: 48 })).toEqual({ hours_left: 50, level: 'normal', basis: 'USAGE' });
    expect(reservoirStatus({ units: 47, fullUnits: 200, averageDailyUnits: 48 })).toEqual({ hours_left: 23.5, level: 'warning', basis: 'USAGE' });
    expect(reservoirStatus({ units: 48, fullUnits: 200, averageDailyUnits: 48 })?.level).toBe('normal');
    expect(reservoirStatus({ units: 15, fullUnits: 200, averageDailyUnits: 48 })).toEqual({ hours_left: 7.5, level: 'alarm', basis: 'USAGE' });
    // A small daily dose: 22 U still last 2 days, so no yellow at the old fixed 25 U.
    expect(reservoirStatus({ units: 22, fullUnits: 150, averageDailyUnits: 10 })).toEqual({ hours_left: 52.8, level: 'normal', basis: 'USAGE' });
  });

  it('falls back to the percent of the fill, then to the fixed units', () => {
    expect(reservoirStatus({ units: 20, fullUnits: 200, averageDailyUnits: null })).toEqual({ hours_left: null, level: 'warning', basis: 'PERCENT' });
    expect(reservoirStatus({ units: 13, fullUnits: 200, averageDailyUnits: null })?.level).toBe('alarm');
    expect(reservoirStatus({ units: 30, fullUnits: 200, averageDailyUnits: null })?.level).toBe('normal');
    expect(reservoirStatus({ units: 24, fullUnits: null, averageDailyUnits: null })).toEqual({ hours_left: null, level: 'warning', basis: 'UNITS' });
    expect(reservoirStatus({ units: 9, fullUnits: 0, averageDailyUnits: 0 })).toEqual({ hours_left: null, level: 'alarm', basis: 'UNITS' });
    expect(reservoirStatus({ units: 25, fullUnits: null, averageDailyUnits: null })?.level).toBe('normal');
    expect(reservoirStatus({ units: null, fullUnits: 200, averageDailyUnits: 30 })).toBeNull();
  });
});

describe('formatReservoirDuration', () => {
  it('says days from 48 h, hours below, rounded down', () => {
    expect(formatReservoirDuration(52.8)).toBe('na ok. 2 dni');
    expect(formatReservoirDuration(48)).toBe('na ok. 2 dni');
    expect(formatReservoirDuration(130)).toBe('na ok. 5 dni');
    expect(formatReservoirDuration(47.9)).toBe('na ok. 47 godz.');
    expect(formatReservoirDuration(14.6)).toBe('na ok. 14 godz.');
    expect(formatReservoirDuration(1)).toBe('na ok. 1 godz.');
    expect(formatReservoirDuration(0.4)).toBe('na mniej niż 1 godz.');
  });
});
