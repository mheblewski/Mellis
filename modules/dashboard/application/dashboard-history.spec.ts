import { describe, expect, it } from 'vitest';
import { buildDashboardHistory, parseDashboardHistoryWindow } from './dashboard-history';

const NOW = new Date('2026-10-23T12:00:00.000Z');

describe('parseDashboardHistoryWindow', () => {
  it('reads from and to, to defaulting to now', () => {
    expect(parseDashboardHistoryWindow('2026-10-22T12:00:00.000Z', '2026-10-23T00:00:00.000Z', NOW)).toEqual({
      from: new Date('2026-10-22T12:00:00.000Z'),
      to: new Date('2026-10-23T00:00:00.000Z'),
    });
    expect(parseDashboardHistoryWindow('2026-10-22T12:00:00.000Z', undefined, NOW)).toEqual({ from: new Date('2026-10-22T12:00:00.000Z'), to: NOW });
  });

  it('caps a window ending in the future at ten minutes past now', () => {
    const window = parseDashboardHistoryWindow('2026-10-23T00:00:00.000Z', '2026-10-24T00:00:00.000Z', NOW);
    expect(window).toEqual({ from: new Date('2026-10-23T00:00:00.000Z'), to: new Date('2026-10-23T12:10:00.000Z') });
  });

  it('rejects missing, reversed, too long and future windows', () => {
    expect(parseDashboardHistoryWindow(undefined, undefined, NOW)).toBe('from is required (ISO date)');
    expect(parseDashboardHistoryWindow('yesterday', undefined, NOW)).toBe('from must be an ISO date');
    expect(parseDashboardHistoryWindow('2026-10-23T00:00:00.000Z', '2026-10-22T00:00:00.000Z', NOW)).toBe('from must be before to');
    expect(parseDashboardHistoryWindow('2026-10-10T00:00:00.000Z', '2026-10-23T00:00:00.000Z', NOW)).toBe('the window may span at most 7 days');
    expect(parseDashboardHistoryWindow('2026-10-23T13:00:00.000Z', '2026-10-23T14:00:00.000Z', NOW)).toBe('from must be in the past');
  });
});

describe('buildDashboardHistory', () => {
  const window = { from: new Date('2026-10-23T08:00:00.000Z'), to: new Date('2026-10-23T09:00:00.000Z') };

  it('keeps one rounded reading per time inside the window, oldest first', () => {
    const history = buildDashboardHistory({
      patientId: 'p1',
      window,
      readings: [
        { at: '2026-10-23T08:10:00.000Z', value: 121.6, direction: null },
        { at: '2026-10-23T08:05:00.000Z', value: 118, direction: null },
        { at: '2026-10-23T08:10:00.000Z', value: 140, direction: null },
        { at: '2026-10-23T07:59:00.000Z', value: 100, direction: null },
        { at: '2026-10-23T09:00:00.000Z', value: 100, direction: null },
        { at: '2026-10-23T08:20:00.000Z', value: 0, direction: null },
      ],
      loopStatuses: [],
      insulin: null,
    });
    expect(history.readings).toEqual([
      { at: '2026-10-23T08:05:00.000Z', value: 118 },
      { at: '2026-10-23T08:10:00.000Z', value: 122 },
    ]);
    expect(history).toMatchObject({ patient_id: 'p1', from: '2026-10-23T08:00:00.000Z', to: '2026-10-23T09:00:00.000Z', insulin: null });
  });

  it('reads IOB and COB from Trio and Loop calculations, skipping those without either', () => {
    const history = buildDashboardHistory({
      patientId: 'p1',
      window,
      readings: [],
      loopStatuses: [
        { observed_at: '2026-10-23T08:11:00.000Z', raw_payload: { loop: { iob: { iob: 0.5 }, cob: { cob: null } } } },
        { observed_at: '2026-10-23T08:06:00.000Z', raw_payload: { openaps: { iob: { iob: 1.234 }, suggested: { COB: 12.4, IOB: 9 } } } },
        { observed_at: '2026-10-23T08:16:00.000Z', raw_payload: { openaps: { iob: { iob: null }, suggested: { IOB: null, COB: null } } } },
      ],
      insulin: null,
    });
    expect(history.loop).toEqual([
      { at: '2026-10-23T08:06:00.000Z', iob_units: 1.23, cob_grams: 12 },
      { at: '2026-10-23T08:11:00.000Z', iob_units: 0.5, cob_grams: null },
    ]);
  });
});
