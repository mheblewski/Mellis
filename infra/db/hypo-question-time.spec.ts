import { describe, expect, it } from 'vitest';
import { buildHypoEpisodeQuestionPrefix, formatIsoToLocalHourMinute } from './postgres-glucomind.repository';

describe('formatIsoToLocalHourMinute (hypo question text)', () => {
  it('shows the time on the Polish clock, not UTC (summer and winter time)', () => {
    expect(formatIsoToLocalHourMinute('2026-10-15T15:08:00.000Z', 'Europe/Warsaw')).toBe('17:08');
    expect(formatIsoToLocalHourMinute('2026-12-15T15:08:00.000Z', 'Europe/Warsaw')).toBe('16:08');
  });

  it('returns null for an invalid timestamp', () => {
    expect(formatIsoToLocalHourMinute('not-a-date', 'Europe/Warsaw')).toBeNull();
  });
});

describe('buildHypoEpisodeQuestionPrefix', () => {
  it('describes a finished episode in one Polish sentence', () => {
    expect(buildHypoEpisodeQuestionPrefix({ startedAtLabel: '17:08', isOngoing: false, durationMinutes: 25, minimumGlucoseMgdl: 62 }))
      .toBe('Hipoglikemia około 17:08 — trwała 25 min, najniżej 62 mg/dL.');
  });

  it('leaves out what is not known', () => {
    expect(buildHypoEpisodeQuestionPrefix({ startedAtLabel: '17:08', isOngoing: false, durationMinutes: null, minimumGlucoseMgdl: null }))
      .toBe('Hipoglikemia około 17:08.');
    expect(buildHypoEpisodeQuestionPrefix({ startedAtLabel: null, isOngoing: false, durationMinutes: null, minimumGlucoseMgdl: null })).toBe('');
  });
});
