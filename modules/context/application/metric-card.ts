import { plainText } from './time-range-normalization';

/**
 * The card above an answer that asks for one value (chat-metric-card.v1): its numbers are counted by code, so the answer
 * cannot give another value than the app's own screens; the model only writes the text under it.
 */
export interface GlucoseBandCounts {
  very_low: number;
  low: number;
  in_range: number;
  high: number;
  very_high: number;
}

export type MetricCard =
  | { kind: 'TIME_IN_RANGE'; period_label: string; counts: GlucoseBandCounts }
  | { kind: 'DAILY_INSULIN'; period_label: string; total_units: number; bolus_units: number; smb_units: number; basal_units: number };

const TIME_IN_RANGE_QUESTION = /\btir\b|\bczas\w*\s+w\s+zakres\w*|\bprocent\w*\s+(?:czasu\s+)?w\s+zakres\w*|\bile\s+(?:\w+\s+){0,3}w\s+zakres\w*/;
const DAILY_INSULIN_QUESTION = /\b(?:ddi|tdd)\b|\bdawk\w*\s+dobow\w*|\bdobow\w*\s+dawk\w*|\bile\s+insuliny\s+(?:\w+\s+){0,3}(?:na\s+dobe|dziennie|na\s+dzien)\b|\binsuliny\s+na\s+dobe\b/;

/** What a question asks for, read from its words; null for any other question. */
export function metricCardKind(question: string): MetricCard['kind'] | null {
  const text = plainText(question);
  if (TIME_IN_RANGE_QUESTION.test(text)) return 'TIME_IN_RANGE';
  if (DAILY_INSULIN_QUESTION.test(text)) return 'DAILY_INSULIN';
  return null;
}

/** "średnio na dobę · 14 pełnych dni": the days the average really covers. */
export function dailyInsulinPeriodLabel(days: number): string {
  return `średnio na dobę · ${days === 1 ? '1 pełny dzień' : `${days} pełnych dni`}`;
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isUnits = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** A stored card as the app may read it; null for anything else (older or damaged metadata). */
export function sanitizeMetricCard(value: unknown): MetricCard | null {
  if (typeof value !== 'object' || value === null) return null;
  const card = value as Record<string, unknown>;
  if (typeof card.period_label !== 'string' || !card.period_label) return null;
  if (card.kind === 'TIME_IN_RANGE') {
    const counts = card.counts as Record<string, unknown> | null | undefined;
    if (!counts || ![counts.very_low, counts.low, counts.in_range, counts.high, counts.very_high].every(isCount)) return null;
    const bands = counts as unknown as GlucoseBandCounts;
    if (bands.very_low + bands.low + bands.in_range + bands.high + bands.very_high === 0) return null;
    return {
      kind: 'TIME_IN_RANGE',
      period_label: card.period_label,
      counts: { very_low: bands.very_low, low: bands.low, in_range: bands.in_range, high: bands.high, very_high: bands.very_high },
    };
  }
  if (card.kind === 'DAILY_INSULIN') {
    const { total_units: total, bolus_units: bolus, smb_units: smb, basal_units: basal } = card;
    if (![total, bolus, smb, basal].every(isUnits) || (total as number) <= 0) return null;
    return {
      kind: 'DAILY_INSULIN',
      period_label: card.period_label,
      total_units: total as number,
      bolus_units: bolus as number,
      smb_units: smb as number,
      basal_units: basal as number,
    };
  }
  return null;
}
