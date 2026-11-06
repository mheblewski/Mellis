import { describe, expect, it } from 'vitest';
import { dailyInsulinPeriodLabel, metricCardKind, sanitizeMetricCard } from './metric-card';
import { readMessagePeriod } from './time-range-normalization';

describe('metric card', () => {
  it.each([
    ['Jaki czas w zakresie z ostatnich czternastu dni?', 'TIME_IN_RANGE'],
    ['Jaki TIR z 7 dni?', 'TIME_IN_RANGE'],
    ['ile procent w zakresie w tym tygodniu', 'TIME_IN_RANGE'],
    ['Ile było w zakresie dzisiaj?', 'TIME_IN_RANGE'],
    ['Jakie DDI z ostatnich 14 dni?', 'DAILY_INSULIN'],
    ['Jaka jest dawka dobowa?', 'DAILY_INSULIN'],
    ['Ile insuliny średnio na dobę?', 'DAILY_INSULIN'],
    ['Czy 120 jest w zakresie?', null],
    ['Dlaczego cukier rośnie po obiedzie?', null],
    ['Ile insuliny podać na obiad?', null],
  ])('reads what "%s" asks for', (question, kind) => {
    expect(metricCardKind(question)).toBe(kind);
  });

  it('a card for 7 or 14 days needs exactly that period in the question', () => {
    const named = (message: string) => readMessagePeriod(message, '2026-11-05T12:00:00.000Z', 'UTC').named?.daysBack;
    expect(named('TIR z ostatnich czternastu dni')).toBe(14);
    expect(named('TIR z ostatnich 7 dni')).toBe(7);
    expect(named('TIR z ostatnich 5 dni')).toBe(5);
  });

  it('labels the days an average covers', () => {
    expect(dailyInsulinPeriodLabel(14)).toBe('średnio na dobę · 14 pełnych dni');
    expect(dailyInsulinPeriodLabel(1)).toBe('średnio na dobę · 1 pełny dzień');
  });

  it('passes only whole cards on to the app', () => {
    const counts = { very_low: 1, low: 2, in_range: 90, high: 6, very_high: 1 };
    expect(sanitizeMetricCard({ kind: 'TIME_IN_RANGE', period_label: 'dziś', counts, extra: 'x' })).toEqual({ kind: 'TIME_IN_RANGE', period_label: 'dziś', counts });
    expect(sanitizeMetricCard({ kind: 'TIME_IN_RANGE', period_label: 'dziś', counts: { ...counts, low: -1 } })).toBeNull();
    expect(sanitizeMetricCard({ kind: 'TIME_IN_RANGE', period_label: 'dziś', counts: { very_low: 0, low: 0, in_range: 0, high: 0, very_high: 0 } })).toBeNull();
    expect(sanitizeMetricCard({ kind: 'DAILY_INSULIN', period_label: 'x', total_units: 14.2, bolus_units: 5.6, smb_units: 2.6, basal_units: 6 })).toMatchObject({ total_units: 14.2 });
    expect(sanitizeMetricCard({ kind: 'DAILY_INSULIN', period_label: 'x', total_units: 0, bolus_units: 0, smb_units: 0, basal_units: 0 })).toBeNull();
    expect(sanitizeMetricCard({ kind: 'OTHER', period_label: 'x' })).toBeNull();
    expect(sanitizeMetricCard(null)).toBeNull();
  });
});
