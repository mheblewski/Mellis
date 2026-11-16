import { describe, expect, it } from 'vitest';
import type { PatternResult } from './application/pattern-detectors';
import { duePatternPush, isPatternKey, isPatternNew, mergeStates, nightPushText, nightPushWindow, patternChatInstructions, patternKey, patternPushText, patternText, type PatternState } from './application/pattern-states';

const DAY = 86_400_000;
// Sunday 15 Nov 2026, 18:30 in Warsaw (UTC+1)
const SUNDAY_EVENING = Date.UTC(2026, 10, 15, 17, 30);
const MONDAY_MORNING = Date.UTC(2026, 10, 16, 7, 30);

function result(id: PatternResult['id'], stats: PatternResult['stats'] = {}, shown = true): PatternResult {
  return { id, shown, failed: [], sentence: `zdanie ${id}`, stats, episodes: [{ at: SUNDAY_EVENING - DAY, date: '2026-11-14', note: 'najniżej 62' }] };
}

describe('patternKey', () => {
  it('adds the hours of a pattern of one time of day', () => {
    expect(patternKey(result('MEAL_RISES_SAME_TIME', { block: '18:00–24:00' }))).toBe('MEAL_RISES_SAME_TIME.1800-2400');
    expect(patternKey(result('DAY_LOWS_WITHOUT_FOOD', { block: 6 }))).toBe('DAY_LOWS_WITHOUT_FOOD.6');
    expect(patternKey(result('SETTING_CHECK'))).toBe('SETTING_CHECK');
    expect(isPatternKey('MEAL_RISES_SAME_TIME.1800-2400')).toBe(true);
    expect(isPatternKey('../x')).toBe(false);
  });
});

describe('mergeStates', () => {
  it('keeps the first sighting and the push, and keeps patterns gone tonight as not shown', () => {
    const first = mergeStates([], [result('SETTING_CHECK'), result('NIGHT_LOWS', {}, false)], SUNDAY_EVENING - 7 * DAY);
    expect(first.map((s) => s.pattern_key)).toEqual(['SETTING_CHECK']);
    const notified = first.map((s) => ({ ...s, notified_at: new Date(SUNDAY_EVENING - 7 * DAY).toISOString(), notified_severity: 1, revision: 0 }));
    const next = mergeStates(notified, [result('FOLLOW_UP_PORTIONS', { rate: 50, base: 30 })], SUNDAY_EVENING);
    const old = next.find((s) => s.pattern_key === 'SETTING_CHECK')!;
    expect(old.shown).toBe(false);
    expect(old.notified_at).not.toBeNull();
    expect(next.find((s) => s.pattern_key === 'FOLLOW_UP_PORTIONS')!.severity).toBe(20);
  });

  it('keeps one card when the day lows window slides by an hour, a new one when it moves far', () => {
    const first = mergeStates([], [result('DAY_LOWS_WITHOUT_FOOD', { block: 9, days: 4 })], SUNDAY_EVENING - DAY)
      .map((s) => ({ ...s, notified_at: new Date(SUNDAY_EVENING - DAY).toISOString(), notified_severity: 4 }));
    const slid = mergeStates(first, [result('DAY_LOWS_WITHOUT_FOOD', { block: 10, days: 4 })], SUNDAY_EVENING);
    expect(slid.map((s) => [s.pattern_key, s.shown])).toEqual([['DAY_LOWS_WITHOUT_FOOD.9', true]]);
    expect(slid[0].result.stats.block).toBe(10);
    expect(slid[0].notified_at).not.toBeNull();
    const far = mergeStates(slid, [result('DAY_LOWS_WITHOUT_FOOD', { block: 18, days: 3 })], SUNDAY_EVENING + DAY);
    expect(far.map((s) => [s.pattern_key, s.shown])).toEqual([['DAY_LOWS_WITHOUT_FOOD.18', true], ['DAY_LOWS_WITHOUT_FOOD.9', false]]);
  });

  it('starts a pattern again as new when it comes back long after its push', () => {
    const gone: PatternState = { ...mergeStates([], [result('MEAL_RISES_SAME_TIME')], SUNDAY_EVENING - 40 * DAY)[0], shown: false, notified_at: new Date(SUNDAY_EVENING - 40 * DAY).toISOString(), notified_severity: 1, revision: 3 };
    const back = mergeStates([gone], [result('MEAL_RISES_SAME_TIME')], SUNDAY_EVENING)[0];
    expect(Date.parse(back.first_shown_at!)).toBe(SUNDAY_EVENING);
    expect(duePatternPush([back], SUNDAY_EVENING, 'Europe/Warsaw', 120)?.reason).toBe('NEW');
  });
});

describe('duePatternPush', () => {
  const states = mergeStates([], [result('MEAL_RISES_SAME_TIME', { block: '18:00–24:00', meals: 20, rises: 10, base: 20 }), result('DAY_LOWS_WITHOUT_FOOD', { block: 6, days: 4 })], SUNDAY_EVENING - 3_600_000);

  it('sends one pattern on Sunday evening, lows first', () => {
    const due = duePatternPush(states, SUNDAY_EVENING, 'Europe/Warsaw', 120)!;
    expect(due.state.pattern_id).toBe('DAY_LOWS_WITHOUT_FOOD');
    expect(patternPushText(due.state, due.reason)).toEqual({ title: 'Nowy wzorzec: spadki między 6 a 9 bez jedzenia', body: 'zdanie DAY_LOWS_WITHOUT_FOOD' });
  });

  it('skips a new pattern every owner has opened, names the day it was found, still sends a worse one', () => {
    const lows = (s: PatternState) => s.pattern_id === 'DAY_LOWS_WITHOUT_FOOD';
    expect(duePatternPush(states, SUNDAY_EVENING, 'Europe/Warsaw', 120, lows)!.state.pattern_id).toBe('MEAL_RISES_SAME_TIME');
    expect(duePatternPush(states, SUNDAY_EVENING, 'Europe/Warsaw', 120, () => true)).toBeNull();
    const sinceFriday = states.map((s) => ({ ...s, first_shown_at: new Date(SUNDAY_EVENING - 2 * DAY - 9 * 3_600_000).toISOString() }));
    const due = duePatternPush(sinceFriday, SUNDAY_EVENING, 'Europe/Warsaw', 120)!;
    expect(patternPushText(due.state, due.reason, SUNDAY_EVENING, 'Europe/Warsaw').title).toBe('Wzorzec od 13.11: spadki między 6 a 9 bez jedzenia');
    expect(patternPushText(states[1], 'NEW', SUNDAY_EVENING, 'Europe/Warsaw').title).toMatch(/^Nowy wzorzec: /);
    const old = new Date(SUNDAY_EVENING - 14 * DAY).toISOString();
    const worse = sinceFriday.map((s) => ({ ...s, first_shown_at: new Date(SUNDAY_EVENING - 20 * DAY).toISOString(), notified_at: old, notified_severity: lows(s) ? 2 : s.severity }));
    expect(duePatternPush(worse, SUNDAY_EVENING, 'Europe/Warsaw', 120, () => true)?.reason).toBe('WORSE');
  });

  it('waits outside Sunday evening, during a low, without a reading, and after a push this week', () => {
    expect(duePatternPush(states, SUNDAY_EVENING + 4 * 3_600_000, 'Europe/Warsaw', 120)).toBeNull();
    expect(duePatternPush(states, SUNDAY_EVENING, 'Europe/Warsaw', 65)).toBeNull();
    expect(duePatternPush(states, SUNDAY_EVENING, 'Europe/Warsaw', null)).toBeNull();
    const sent = states.map((s, i) => (i === 0 ? { ...s, notified_at: new Date(SUNDAY_EVENING - 2 * DAY).toISOString(), notified_severity: s.severity } : s));
    expect(duePatternPush(sent, SUNDAY_EVENING, 'Europe/Warsaw', 120)).toBeNull();
  });

  it('never hides lows, skips another dismissed pattern and sends a worse one again', () => {
    const hidden = new Date(SUNDAY_EVENING + 10 * DAY).toISOString();
    const lowsHidden = states.map((s) => ({ ...s, dismissed_until: hidden }));
    expect(duePatternPush(lowsHidden, SUNDAY_EVENING, 'Europe/Warsaw', 120)!.state.pattern_id).toBe('DAY_LOWS_WITHOUT_FOOD');
    expect(duePatternPush(lowsHidden.filter((s) => s.pattern_id === 'MEAL_RISES_SAME_TIME'), SUNDAY_EVENING, 'Europe/Warsaw', 120)).toBeNull();
    const old = new Date(SUNDAY_EVENING - 14 * DAY).toISOString();
    const worse = states.map((s) => ({ ...s, first_shown_at: new Date(SUNDAY_EVENING - 20 * DAY).toISOString(), notified_at: old, notified_severity: s.pattern_id === 'DAY_LOWS_WITHOUT_FOOD' ? 2 : s.severity }));
    const due = duePatternPush(worse, SUNDAY_EVENING, 'Europe/Warsaw', 120)!;
    expect(due.reason).toBe('WORSE');
    expect(patternPushText(due.state, due.reason).title).toBe('Wzorzec powtarza się częściej: spadki między 6 a 9 bez jedzenia');
  });

  it('never counts a morning push or a report-only pattern for the weekly one', () => {
    const report = mergeStates([], [result('SETTING_CHECK', { facts: 1 }), result('RESCUE_REBOUND', { treated: 5, rebound: 3 })], SUNDAY_EVENING - DAY);
    expect(duePatternPush(report, SUNDAY_EVENING, 'Europe/Warsaw', 120)).toBeNull();
    // only the weekly push is a pattern's notified_at; nothing pushes on a Monday morning
    expect(duePatternPush(states, MONDAY_MORNING, 'Europe/Warsaw', 120)).toBeNull();
  });

  it('says last night\'s low in the morning push, facts only', () => {
    const low = { date: '2026-11-16', startMs: MONDAY_MORNING - 5 * 3_600_000, nadir: 48, nadirMs: MONDAY_MORNING - 4.5 * 3_600_000, minutes: 25 };
    expect(nightPushText(low, 'Europe/Warsaw')).toEqual({ title: 'Ostatniej nocy glukoza spadła poniżej 54', body: 'Najniżej 48 o 4:00, poniżej 54 przez 25 min.' });
    expect(nightPushWindow(MONDAY_MORNING, 'Europe/Warsaw', 110)).toBe(true);
    expect(nightPushWindow(MONDAY_MORNING, 'Europe/Warsaw', 62)).toBe(false);
    expect(nightPushWindow(Date.UTC(2026, 10, 16, 11, 30), 'Europe/Warsaw', 110)).toBe(false);
  });

  it('never pushes a single night under 54 (a card only)', () => {
    const single = mergeStates([], [result('NIGHT_LOWS', { nights: 1, very_low_nights: 1, single: 1, last_very_low_at: MONDAY_MORNING - 5 * 3_600_000 })], SUNDAY_EVENING - DAY);
    expect(duePatternPush(single, MONDAY_MORNING, 'Europe/Warsaw', 110)).toBeNull();
    expect(duePatternPush(single, SUNDAY_EVENING, 'Europe/Warsaw', 110)).toBeNull();
    expect(patternText(single[0].result).title).toBe('Noc poniżej 54');
  });
});

describe('patternChatInstructions', () => {
  it('carries the pattern and the rules', () => {
    const text = patternChatInstructions(mergeStates([], [result('FOLLOW_UP_PORTIONS', { rate: 50, base: 30 })], SUNDAY_EVENING)[0]);
    expect(text).toContain('zdanie FOLLOW_UP_PORTIONS');
    expect(text).toContain('przyczyną jest');
    expect(text).toContain('never');
    expect(text).toContain('LOWS FIRST');
    expect(text).toContain('nie mogła dać mikrobolusa');
    expect(text).toContain('nie zalecenie');
    expect(text).toContain('NOT "WYRAŹNY"');
  });
});

describe('patternText', () => {
  it('names the hours in the title', () => {
    expect(patternText(result('MEAL_RISES_SAME_TIME', { from_minute: 1080, to_minute: 1440 })).title).toBe('Wzrosty po posiłkach wieczorem (18–24)');
    expect(patternText(result('LOWS_AFTER_MEAL_BOLUS', { block: 12, about_bolus: 1 })).title).toBe('Spadki po bolusie do posiłku');
    expect(patternText(result('LOWS_AFTER_MEAL_BOLUS', { about_bolus: 0 })).title).toBe('Spadki w ciągu dnia');
    expect(patternKey(result('LOWS_AFTER_MEAL_BOLUS', { block: 12 }))).toBe('LOWS_AFTER_MEAL_BOLUS');
    expect(patternKey(result('TIME_BELOW_GOAL', { block: 18 }))).toBe('TIME_BELOW_GOAL');
    // the title names the goal missed; held by the hysteresis inside both goals: "blisko celu" (round 4)
    expect(patternText(result('TIME_BELOW_GOAL', { share_below_70: 5.2, share_below_54: 0.4 })).title).toBe('Czas poniżej 70 ponad cel');
    expect(patternText(result('TIME_BELOW_GOAL', { share_below_70: 3.0, share_below_54: 1.4 })).title).toBe('Czas poniżej 54 ponad cel');
    expect(patternText(result('TIME_BELOW_GOAL', { share_below_70: 3.0, share_below_54: 1.4 })).visit).toBe('czas poniżej 54: 1,4% (cel: poniżej 1%). Zmiany dawek omów z poradnią.');
    expect(patternText(result('TIME_BELOW_GOAL', { share_below_70: 5.2, share_below_54: 1.4 })).title).toBe('Czas poniżej 70 i 54 ponad cel');
    expect(patternText(result('TIME_BELOW_GOAL', { share_below_70: 3.7, share_below_54: 0.3 })).title).toBe('Czas poniżej 70 blisko celu');
    expect(patternText(result('TIME_BELOW_GOAL', { share_below_70: 3.0, share_below_54: 0.9 })).title).toBe('Czas poniżej 70 blisko celu');
    expect(patternText(result('MEAL_RISES_SAME_TIME', { from_minute: 1080, to_minute: 1440, low_days: 9 })).visit).toBe('wzrosty i spadki wieczorem razem: przelicznik i wrażliwość na insulinę.');
  });

  it('brings the settings card back only when a setting changes', () => {
    const settings = (stats: PatternResult['stats']) => ({ ...result('SETTING_CHECK', stats), lines: ['a', 'b'] });
    const [first] = mergeStates([], [settings({ dia_hours: 10, facts: 2 })], SUNDAY_EVENING - DAY);
    const discussed = { ...first, dismissed_until: new Date(SUNDAY_EVENING + 300 * DAY).toISOString() };
    expect(mergeStates([discussed], [settings({ dia_hours: 10, facts: 2 })], SUNDAY_EVENING)[0].dismissed_until).not.toBeNull();
    expect(mergeStates([discussed], [settings({ dia_hours: 6, facts: 2 })], SUNDAY_EVENING)[0].dismissed_until).toBeNull();
    expect(patternPushText(first, 'NEW')).toEqual({ title: 'Nowy wzorzec: ustawienia do omówienia', body: '2 ustawienia Trio warto omówić w poradni.' });
  });
});

describe('isPatternNew', () => {
  const state = (first: string | null, shown = true) => ({ pattern_key: 'MEAL_RISES_SAME_TIME.1800-2400', pattern_id: 'MEAL_RISES_SAME_TIME', shown, result: result('MEAL_RISES_SAME_TIME'), severity: 1, first_shown_at: first, last_shown_at: first, computed_at: first ?? '', notified_at: null, notified_severity: null, dismissed_until: null, revision: 0 }) as PatternState;
  const first = '2026-11-11T03:00:00.000Z';

  it('stays new until the caregiver opens it, however long that takes', () => {
    expect(isPatternNew(state(first), null, SUNDAY_EVENING + 30 * DAY)).toBe(true);
    expect(isPatternNew(state(first), '2026-11-12T08:00:00.000Z', SUNDAY_EVENING)).toBe(false);
  });

  it('is new again when it came back after the open (a new first_shown_at)', () => {
    expect(isPatternNew(state('2026-12-20T03:00:00.000Z'), '2026-11-12T08:00:00.000Z', SUNDAY_EVENING + 40 * DAY)).toBe(true);
  });

  it('is never new when not shown or never shown', () => {
    expect(isPatternNew(state(first, false), null, SUNDAY_EVENING)).toBe(false);
    expect(isPatternNew(state(null), null, SUNDAY_EVENING)).toBe(false);
  });

  it('without a signed-in caregiver keeps the 7 days', () => {
    expect(isPatternNew(state(first), null, Date.parse(first) + 6 * DAY, false)).toBe(true);
    expect(isPatternNew(state(first), null, Date.parse(first) + 8 * DAY, false)).toBe(false);
  });
});
