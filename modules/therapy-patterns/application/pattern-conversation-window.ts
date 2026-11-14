import { localInstant, localParts } from '@modules/settings-insights/application/settings-insights-common';
import { CHANGE_CHECK_POLICY } from './change-check';
import { THERAPY_PATTERNS_POLICY } from './pattern-detectors';
import type { PatternState } from './pattern-states';

/** The local date `days` calendar days before a YYYY-MM-DD date (whole days across a DST change). */
function daysBefore(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - days)).toISOString().slice(0, 10);
}

/**
 * Where the analysed period of a pattern's conversation ("Omów z Mellis", "Rozmowa o zmianie") starts when a question
 * names no period (2026-11-11: "Co jeszcze zmieniło się w tych tygodniach?" got today only, and the days the model
 * asked for came back NOT_SELECTED). The change card: its 14 days before the change, the day of the change and the days
 * after it. Any other pattern: the 14 days it was found in. The caller rounds it up to a range type (a 20-day period
 * becomes the 30-day one) and caps it at what an analysis holds.
 */
export function patternConversationStartMs(state: Pick<PatternState, 'pattern_id' | 'result'>, requestedAtIso: string, timezone: string): number | null {
  const requestedMs = Date.parse(requestedAtIso);
  if (!Number.isFinite(requestedMs)) return null;
  if (state.pattern_id === 'CHANGE_CHECK') {
    const date = state.result?.stats?.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const startMs = localInstant(daysBefore(date, CHANGE_CHECK_POLICY.beforeDays), 0, timezone);
    return Number.isFinite(startMs) && startMs < requestedMs ? startMs : null;
  }
  const today = localParts(requestedMs, timezone).date;
  const startMs = localInstant(daysBefore(today, THERAPY_PATTERNS_POLICY.window_days), 0, timezone);
  return Number.isFinite(startMs) ? startMs : null;
}
