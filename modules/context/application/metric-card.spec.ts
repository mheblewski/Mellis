import { describe, expect, it } from 'vitest';
import { dailyInsulinCardValue, dailyInsulinPeriodLabel, metricCardKind, sanitizeMetricCard, type DailyInsulinCardDay } from './metric-card';
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
    expect(dailyInsulinPeriodLabel(3)).toBe('średnio na dobę · 3 pełne dni');
    expect(dailyInsulinPeriodLabel(5)).toBe('średnio na dobę · 5 pełnych dni');
    expect(dailyInsulinPeriodLabel(12)).toBe('średnio na dobę · 12 pełnych dni');
    expect(dailyInsulinPeriodLabel(22)).toBe('średnio na dobę · 22 pełne dni');
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

describe('daily insulin card for the period a question names', () => {
  // Thursday 2026-11-05, noon: a window of 7 complete days plus today so far; each day's total tells it apart.
  const nowIso = '2026-11-05T12:00:00.000Z';
  const today = '2026-11-05';
  const day = (date: string, total: number, overrides: Partial<DailyInsulinCardDay> = {}): DailyInsulinCardDay => ({
    date,
    complete: true,
    status: 'KNOWN',
    bolus_units: total - 2,
    smb_units: 1,
    basal_units: 1,
    total_units: total,
    ...overrides,
  });
  const week = [
    day('2026-10-29', 10),
    day('2026-10-30', 11),
    day('2026-10-31', 12),
    day('2026-11-01', 13),
    day('2026-11-02', 14),
    day('2026-11-03', 15),
    day('2026-11-04', 16),
    day(today, 5, { complete: false }),
  ];
  const value = (question: string, days: DailyInsulinCardDay[] = week) =>
    dailyInsulinCardValue(days, readMessagePeriod(question, nowIso, 'UTC'), today);

  it('shows the named day alone, not the average of the window', () => {
    expect(value('Jakie było wczoraj ddi?')).toEqual({ period_label: 'wczoraj · 4 listopada', total_units: 16, bolus_units: 14, smb_units: 1, basal_units: 1 });
    expect(value('Jakie DDI przedwczoraj?')).toMatchObject({ period_label: 'przedwczoraj · 3 listopada', total_units: 15 });
    expect(value('Jakie DDI w poniedziałek?')).toMatchObject({ period_label: '2 listopada', total_units: 14 });
    expect(value('DDI 30 października')).toMatchObject({ period_label: '30 października', total_units: 11 });
  });

  it('shows no card for a named day that is partial or unknown', () => {
    expect(value('Jakie DDI dzisiaj?')).toBeNull();
    const unknown = week.map((entry) => (entry.date === '2026-11-04' ? { ...entry, status: 'BASAL_UNKNOWN', total_units: null } : entry));
    expect(value('Jakie było wczoraj ddi?', unknown)).toBeNull();
    expect(value('Jakie było wczoraj ddi?', week.filter((entry) => entry.date !== '2026-11-04'))).toBeNull();
  });

  it('averages exactly the counted days, however large the window', () => {
    expect(value('Jakie DDI z ostatnich 3 dni?')).toMatchObject({ period_label: 'średnio na dobę · 3 pełne dni', total_units: 15 });
    expect(value('Jakie DDI z ostatnich 5 dni?')).toMatchObject({ period_label: 'średnio na dobę · 5 pełnych dni', total_units: 14 });
  });

  it('labels the days a counted average really covers', () => {
    const gap = week.map((entry) => (entry.date === '2026-11-03' ? { ...entry, status: 'DOSE_UNKNOWN', total_units: null } : entry));
    expect(value('Jakie DDI z ostatnich 3 dni?', gap)).toMatchObject({ period_label: 'średnio na dobę · 2 pełne dni', total_units: 15 });
  });

  it('keeps the average of the complete days when no period is named', () => {
    expect(value('Jakie DDI?')).toMatchObject({ period_label: 'średnio na dobę · 7 pełnych dni', total_units: 13 });
    expect(value('Jakie DDI?', [day(today, 5, { complete: false })])).toBeNull();
  });

  it('shows no card when one value cannot answer the question', () => {
    expect(value('DDI wczoraj i przedwczoraj')).toBeNull();
    expect(value('DDI z ostatnich 24 godzin')).toBeNull();
    expect(value('DDI tej nocy')).toBeNull();
    expect(value('DDI w weekend')).toBeNull();
    expect(value('Porównaj DDI z wczoraj z ostatnimi 7 dniami')).toBeNull();
  });
});
