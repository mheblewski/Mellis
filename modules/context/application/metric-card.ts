import { plainText, type MessagePeriod } from './time-range-normalization';
import { sanitizeIcrWhatIfCard, type IcrWhatIfCard } from '@modules/settings-whatif/application/icr-whatif-card';

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
  | { kind: 'DAILY_INSULIN'; period_label: string; total_units: number; bolus_units: number; smb_units: number; basal_units: number }
  /** "Przeliczenie zmiany" (icr-whatif-card.v1); older apps show no card for it, only the text. */
  | { kind: 'SETTING_WHATIF'; period_label: string; whatif: IcrWhatIfCard };

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
  if (days === 1) return 'średnio na dobę · 1 pełny dzień';
  const lastDigit = days % 10;
  const lastTwo = days % 100;
  const few = lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14);
  return `średnio na dobę · ${days} ${few ? 'pełne' : 'pełnych'} dni`;
}

/** One local day of the daily insulin totals, as far as the card needs it. */
export interface DailyInsulinCardDay {
  date: string;
  complete: boolean;
  status: string;
  bolus_units: number | null;
  smb_units: number | null;
  basal_units: number | null;
  total_units: number | null;
}

export interface DailyInsulinCardValue {
  period_label: string;
  total_units: number;
  bolus_units: number;
  smb_units: number;
  basal_units: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isWholeKnownDay = (day: DailyInsulinCardDay) => day.complete && day.status === 'KNOWN';

function namedDayLabel(date: string, todayDate: string): string {
  const named = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00.000Z`));
  const daysBack = Math.round((Date.parse(todayDate) - Date.parse(date)) / DAY_MS);
  if (daysBack === 1) return `wczoraj · ${named}`;
  if (daysBack === 2) return `przedwczoraj · ${named}`;
  return named;
}

function averageOf(days: DailyInsulinCardDay[], period_label: string): DailyInsulinCardValue {
  const average = (pick: (day: DailyInsulinCardDay) => number | null) =>
    Math.round((days.reduce((sum, day) => sum + (pick(day) ?? 0), 0) / days.length) * 100) / 100;
  return {
    period_label,
    total_units: average((day) => day.total_units),
    bolus_units: average((day) => day.bolus_units),
    smb_units: average((day) => day.smb_units),
    basal_units: average((day) => day.basal_units),
  };
}

/**
 * The daily insulin a card may show for a question: exactly the period the question names, not the whole window of data
 * (a question about yesterday holds 3 complete days). Null when one card cannot say it truthfully: a day that is not
 * complete or known (today so far), hours, a night, or several separately named days the question may be comparing.
 * The model still answers these in text from the same totals.
 */
export function dailyInsulinCardValue(days: DailyInsulinCardDay[], period: MessagePeriod, todayDate: string): DailyInsulinCardValue | null {
  if (period.beyondReach || period.named?.sinceMs != null) return null;
  const { focusDates, namesCount, named } = period;

  if (focusDates.length > 0) {
    // One count next to one named day is two periods; several days without a count (a weekend, "wczoraj i przedwczoraj") may be a comparison.
    if (focusDates.length === 1 ? namesCount : !namesCount) return null;
    const focused = focusDates.map((date) => days.find((day) => day.date === date));
    if (!focused.every((day): day is DailyInsulinCardDay => day !== undefined && isWholeKnownDay(day))) return null;
    return averageOf(focused, focused.length === 1 ? namedDayLabel(focused[0].date, todayDate) : dailyInsulinPeriodLabel(focused.length));
  }

  let covered = days.filter(isWholeKnownDay);
  if (namesCount && named) {
    // The last N complete days before today; a smaller window kept for them would show fewer, and says so.
    const lastDays = days.filter((day) => day.complete && day.date < todayDate).slice(-named.daysBack);
    covered = named.daysBack > 0 ? lastDays.filter(isWholeKnownDay) : [];
  } else if (named) {
    return null; // A period without days of its own, such as the last night.
  }
  return covered.length > 0 ? averageOf(covered, dailyInsulinPeriodLabel(covered.length)) : null;
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
  if (card.kind === 'SETTING_WHATIF') {
    const whatif = sanitizeIcrWhatIfCard(card.whatif);
    return whatif ? { kind: 'SETTING_WHATIF', period_label: card.period_label, whatif } : null;
  }
  return null;
}
