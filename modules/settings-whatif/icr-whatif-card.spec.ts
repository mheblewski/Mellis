import { describe, expect, it } from 'vitest';
import { sanitizeMetricCard } from '@modules/context/application/metric-card';
import { buildIcrWhatIfCard, tooFewMealsMessage } from './application/icr-whatif-card';
import type { WhatIfGroup, WhatIfResult } from './application/icr-whatif';

const SCHEDULE: Array<[string, number]> = [['00:00', 10], ['06:00', 5], ['09:30', 8.3], ['18:00', 6.8]];

function group(key: string, meals: number, below: [number, number], above: [number, number]): WhatIfGroup {
  const summary = (b: number, a: number) => ({
    meals, bands: { below_54: 0, from_54_to_70: b, in_range: 1 - a - b, from_180_to_250: a, above_250: 0 },
    time_below_70: b, time_above_180: a, mean_mgdl: 150, meals_with_drop_below_70: 10, meals_with_drop_below_54: 2, meals_above_180_over_1h: 12, meals_above_250: 5,
  });
  return { key, icr_now: null, icr_after: null, meals, dose_change_u_per_meal: -0.351, loop_change_u_per_meal: 0.1, rescues_removed: 0, now: summary(below[0], above[0]), after: summary(below[1], above[1]), meals_high_then_low: 7 };
}

function result(total: WhatIfGroup, blocks: WhatIfGroup[], scope: WhatIfResult & { status: 'OK' } extends infer R ? R extends { scope: infer S } ? S : never : never): WhatIfResult {
  return { status: 'OK', version: 'icr-whatif.v1', ratio: 1.25, scope, total, blocks, night: null, small_sample: total.meals < 50, first_meal_ms: Date.UTC(2026, 9, 9, 8), last_meal_ms: Date.UTC(2026, 10, 8, 18) };
}

describe('buildIcrWhatIfCard (icr-whatif-card.v1)', () => {
  const morning = group('06:00', 32, [0.041, 0.012], [0.225, 0.416]);
  const day = group('09:30', 122, [0.045, 0.014], [0.272, 0.383]);
  const evening = group('18:00', 36, [0.051, 0.006], [0.299, 0.398]);
  const all = result(group('ALL', 190, [0.045, 0.012], [0.269, 0.392]), [morning, day, evening], { kind: 'ALL' });

  it('rounds once, labels the scope and dates, and marks the best trade-off among blocks with enough meals', () => {
    const card = buildIcrWhatIfCard({ title: 'Wszystkie pory: 20% mniej insuliny na węgle', scoped: all, all, schedule: SCHEDULE, timeZone: 'Europe/Warsaw' })!;
    expect(card).toMatchObject({
      scope_label: 'Wszystkie pory', dose_change_u_per_meal: -0.35, meals: 190, time_below_70: { now: 4.5, after: 1.2 }, time_above_180: { now: 26.9, after: 39.2 },
      from_label: '9.10', to_label: '8.11', best_block: '18:00', meals_high_then_low: 7,
    });
    expect(card.blocks.map((b) => [b.label, b.icr_now, b.icr_after])).toEqual([['Rano', 5, 6.3], ['W dzień', 8.3, 10.4], ['Wieczorem', 6.8, 8.5]]);
  });

  it('compares the named time with the others replayed at the same ratio', () => {
    const scoped = result(morning, [morning], { kind: 'BLOCK', start: '06:00' });
    const card = buildIcrWhatIfCard({ title: 'ICR rano 5 → 6,3', scoped, all, schedule: SCHEDULE, timeZone: 'UTC' })!;
    expect(card.scope_label).toBe('Rano, 6:00–9:30');
    expect(card.small_sample).toBe(true);
    expect(card.blocks).toHaveLength(3);
    expect(card.best_block).toBe('18:00');
  });

  it('never calls a block with too few meals the best, and needs two to compare', () => {
    const tiny = group('18:00', 8, [0.05, 0.0], [0.3, 0.3]);
    const card = buildIcrWhatIfCard({ title: 't', scoped: all, all: result(all.status === 'OK' ? all.total : morning, [morning, tiny], { kind: 'ALL' }), schedule: SCHEDULE, timeZone: 'UTC' })!;
    expect(card.blocks.find((b) => b.start === '18:00')?.small).toBe(true);
    expect(card.best_block).toBeNull();
  });

  it('travels as a metric card and survives the sanitizer', () => {
    const whatif = buildIcrWhatIfCard({ title: 't', scoped: all, all, schedule: SCHEDULE, timeZone: 'UTC' })!;
    expect(sanitizeMetricCard({ kind: 'SETTING_WHATIF', period_label: '9.10–8.11', whatif })).toMatchObject({ kind: 'SETTING_WHATIF', whatif: { meals: 190 } });
    expect(sanitizeMetricCard({ kind: 'SETTING_WHATIF', period_label: 'x', whatif: { version: 'other' } })).toBeNull();
  });

  it('gives no card without a result, and a plain reply for too few meals', () => {
    expect(buildIcrWhatIfCard({ title: 't', scoped: { status: 'TOO_FEW_MEALS', version: 'icr-whatif.v1', meals: 3 }, all: null, schedule: SCHEDULE, timeZone: 'UTC' })).toBeNull();
    expect(tooFewMealsMessage('Wszystkie pory', 3)).toBe('W ostatnich 31 dniach jest za mało posiłków z bolusem, żeby to przeliczyć (3, potrzeba co najmniej 20). Spróbuj innej pory albo wróć do tego za kilka tygodni.');
  });
});
