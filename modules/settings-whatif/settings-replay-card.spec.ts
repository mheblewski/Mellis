import { describe, expect, it } from 'vitest';
import { buildSettingsReplayCard, plural, sanitizeSettingsReplayCard } from './application/settings-replay-card';
import { windowOutcome, type DayRun } from './application/settings-replay';
import type { CheckedReplay } from './application/settings-search';

const run = (date: string, obs: number[], sim: number[]): DayRun => ({ date, obs, sim, extra_u: 0, smb_count_change: 0, rescues_removed: 0 });

function checked(runs: DayRun[], window = { from: '00:00', to: '10:00' }): CheckedReplay {
  const now = windowOutcome(runs, 'obs');
  const after = windowOutcome(runs, 'sim');
  return {
    main: { status: 'OK', version: 'settings-replay.v1', change: { setting: 'BASAL', from: '00:00', to: '01:00', value: 0.1 }, window, insulin_effect_scale: 1, runs, skipped: [{ date: '2026-10-25', reason: 'CLOCK_CHANGE' }], now, after, extra_u_median: 0, meals: 0, meal_dose_change_u: null },
    half_effect: { now, after },
    without_two_days: { now, after },
  };
}

describe('plural', () => {
  it('follows Polish number forms', () => {
    expect([1, 2, 4, 5, 12, 13, 22, 25].map((n) => plural(n, 'noc', 'noce', 'nocy'))).toEqual(['noc', 'noce', 'noce', 'nocy', 'nocy', 'nocy', 'noce', 'nocy']);
  });
});

describe('buildSettingsReplayCard', () => {
  it('writes the verdict, rows and labels the way the mockup shows', () => {
    const high = Array(20).fill(220);
    const runs = [
      run('2026-10-16', [...high, 120], [...Array(10).fill(150), ...Array(10).fill(60), 120]),
      run('2026-10-17', [...high, 120], [...high, 120]),
    ];
    const card = buildSettingsReplayCard({ checked: checked(runs), change: { setting: 'BASAL', from: '00:00', to: '01:00', value: 0.1 }, now_value: 0.05, check_date: '2026-11-29' });
    expect(card.setting_label).toBe('Baza 0:00–1:00');
    expect(card.now_label).toBe('teraz 0,05 j/h · +0,05 j na godzinę');
    expect(card.value_label).toBe('0,10 j/h');
    expect(card.window_label).toBe('Noc 0:00–10:00 · 2 noce');
    expect(card.verdict.text).toBe('Spadków przybywa, krótsze wzrosty.');
    expect(card.rows.map((r) => `${r.label}: ${r.days_text} · ${r.minutes_text} ${r.tone}`)).toEqual([
      'Poniżej 54: 0 → 0 nocy · 0 → 0 min NONE',
      'Poniżej 70: 0 → 1 · 0 → 50 min COST',
      'Ponad 1 h powyżej 180: 2 → 1 · 200 → 100 min GAIN',
      'Powyżej 250: 0 → 0 · 0 → 0 min NONE',
    ]);
    expect(card.confidence).toBe('Do 29.11 liczby pokazują tylko kierunek.');
    expect(card.details).toContain('Bez: 25.10 (zmiana czasu).');
    expect(card.lows_not_worse).toBe(false);
    expect(sanitizeSettingsReplayCard(JSON.parse(JSON.stringify(card)))).toEqual(card);
  });

  it('says "Bez wyraźnej zmiany." and counts days outside the night', () => {
    const runs = [run('2026-10-16', [120, 130], [121, 131])];
    const card = buildSettingsReplayCard({ checked: checked(runs, { from: '09:30', to: '22:00' }), change: { setting: 'TARGET', from: '09:30', to: '18:00', value: 100 }, now_value: 110, check_date: null });
    expect(card.verdict.text).toBe('Bez wyraźnej zmiany.');
    expect(card.window_label).toBe('Dzień 9:30–22:00 · 1 dzień');
    expect(card.now_label).toBe('teraz 110 mg/dl');
    expect(card.confidence).toMatch(/^Wpływu insuliny nie sprawdzono/);
  });
});
