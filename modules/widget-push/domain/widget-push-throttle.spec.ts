import { describe, expect, it } from 'vitest';
import { decideWidgetPush, glucoseLevel, type WidgetPushStateSnapshot } from './widget-push-throttle';

const NOW = new Date('2026-11-03T10:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function state(overrides: Partial<WidgetPushStateSnapshot> = {}): WidgetPushStateSnapshot {
  return { last_reading_at: minutesAgo(6), last_pushed_at: minutesAgo(6), last_value: 120, last_level: 'in_range', ...overrides };
}

function decide(value: number, s: WidgetPushStateSnapshot | null, tokenLastPushedAt: string | null = null, at = minutesAgo(1)) {
  return decideWidgetPush({ reading: { at, value }, state: s, tokenLastPushedAt, now: NOW });
}

describe('glucoseLevel', () => {
  it('classes the edges', () => {
    expect([53, 54, 69, 70, 180, 181, 250, 251].map(glucoseLevel)).toEqual([
      'urgent_low', 'low', 'low', 'in_range', 'in_range', 'high', 'high', 'very_high',
    ]);
  });
});

describe('decideWidgetPush', () => {
  it('pushes the first reading of a new token+patient', () => {
    expect(decide(120, null)).toEqual({ push: true, reason: 'first', level: 'in_range', priority: 5 });
  });

  it('never twice for the same reading, and never for an older one', () => {
    expect(decide(40, state({ last_reading_at: minutesAgo(1) }))).toMatchObject({ push: false, reason: 'same_reading' });
    expect(decide(200, state({ last_reading_at: minutesAgo(1) }), null, minutesAgo(3))).toMatchObject({ push: false, reason: 'older_reading' });
  });

  it('pushes a level change at once', () => {
    expect(decide(185, state({ last_value: 178 }))).toEqual({ push: true, reason: 'level_change', level: 'high', priority: 5 });
    expect(decide(68, state({ last_value: 72 }))).toMatchObject({ push: true, reason: 'level_change', level: 'low' });
  });

  it('pushes every new reading within a level, however small the change', () => {
    expect(decide(130, state())).toMatchObject({ push: true, reason: 'new_reading', priority: 5 });
    expect(decide(121, state())).toMatchObject({ push: true, reason: 'new_reading', priority: 5 });
  });

  it('holds back a push within 4 min of the token\'s last push for any patient', () => {
    expect(decide(150, state(), minutesAgo(3))).toEqual({ push: false, reason: 'token_cap', level: 'in_range' });
    expect(decide(150, state(), minutesAgo(4))).toMatchObject({ push: true, reason: 'new_reading' });
    expect(decide(200, state(), minutesAgo(1))).toMatchObject({ push: false, reason: 'token_cap' });
    expect(decide(120, null, minutesAgo(1))).toMatchObject({ push: false, reason: 'token_cap' });
  });

  it('pushes entering <54 at once at priority 10, past the token cap, but not again while it stays there', () => {
    expect(decide(52, state({ last_value: 58, last_level: 'low' }), minutesAgo(1))).toEqual({ push: true, reason: 'urgent_low', level: 'urgent_low', priority: 10 });
    expect(decide(50, null, minutesAgo(1))).toMatchObject({ push: true, reason: 'urgent_low', priority: 10 });
    // Already urgent: the ordinary rules (and the cap) apply.
    expect(decide(51, state({ last_value: 52, last_level: 'urgent_low' }), minutesAgo(1))).toMatchObject({ push: false, reason: 'token_cap' });
    expect(decide(40, state({ last_value: 52, last_level: 'urgent_low' }), minutesAgo(1))).toMatchObject({ push: false, reason: 'token_cap' });
    // Leaving urgent low is a level change (priority 5).
    expect(decide(56, state({ last_value: 52, last_level: 'urgent_low' }))).toMatchObject({ push: true, reason: 'level_change', priority: 5 });
  });

  it('treats a pair with only skipped readings as never pushed', () => {
    expect(decide(120, state({ last_pushed_at: null, last_value: null, last_level: null }))).toMatchObject({ push: true, reason: 'first' });
  });
});
