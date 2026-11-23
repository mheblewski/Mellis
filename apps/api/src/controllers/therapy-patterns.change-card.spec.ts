import { describe, expect, it } from 'vitest';
import { changeTone, TherapyPatternsApi } from './therapy-patterns.controller';

describe('change card colours (owner 2026-11-23)', () => {
  it('colours a number only when it moved by a fifth and by the row minimum; lower is better', () => {
    expect(changeTone(0.4, 1.4, 0.3)).toBe('WORSE');
    expect(changeTone(5.1, 4.5, 1)).toBeNull(); // 0.6 points
    expect(changeTone(26, 15, 3)).toBe('BETTER');
    expect(changeTone(22, 20, 3)).toBeNull();
    expect(changeTone(0.9, 5.2, 1)).toBe('WORSE');
    expect(changeTone(40, 34, 3)).toBeNull(); // 6 points but only 15 %
    expect(changeTone(0, 1.2, 1)).toBe('WORSE');
  });
});

describe('change card sections', () => {
  const api = Object.create(TherapyPatternsApi.prototype) as { changeCard(state: unknown): Record<string, any> };
  const state = (groups: unknown[]) => ({
    pattern_key: 'CHANGE_CHECK.2026-11-06', pattern_id: 'CHANGE_CHECK', shown: true,
    result: {
      id: 'CHANGE_CHECK', shown: true, failed: [], sentence: '', episodes: [],
      stats: { date: '2026-11-06', day: 14, of: 14, after_days: 14 },
      lines: ['ICR 9:30–18:00|7,7|8,3', 'ICR 18:00–24:00|7,1|6,8'],
      groups,
    },
  });
  const period = (very_low: number, tbr: number, tar: number, tar250: number, very_low_days = 0) => ({ days: 14, very_low_days, very_low, tbr, tar, tar250 });

  it('four toned rows, the setting and its values apart, and the two mean lines', () => {
    const card = api.changeCard(state([{
      direction: 'MORE', hours: '18:00–3:00', windows: [[1080, 1620]],
      before: period(0.4, 5.1, 26, 5.7), after: period(1.4, 4.5, 15, 3.5, 3),
      profile: { before: [[1080, 133], [1620, 133]], after: [[1080, 121], [1620, 128]] },
    }]));
    const s = card.sections[0];
    expect(s.changes).toEqual([{ label: 'Przelicznik 18:00–24:00', before: '7,1', after: '6,8' }]);
    expect(s.direction_label).toBe('więcej insuliny');
    expect(s.rows).toEqual([
      { label: 'Poniżej 54', before: '0,4%', after: '1,4%', tone: 'WORSE' },
      { label: 'Poniżej 70', before: '5,1%', after: '4,5%', tone: null },
      { label: 'Powyżej 180', before: '26%', after: '15%', tone: 'BETTER' },
      { label: 'Powyżej 250', before: '5,7%', after: '3,5%', tone: 'BETTER' },
    ]);
    expect(s.chart).toEqual({ from_minute: 1080, to_minute: 1620, before: [[1080, 133], [1620, 133]], after: [[1080, 121], [1620, 128]] });
    expect(card.note).toMatch(/^Zielony: lepiej niż przed, czerwony: gorzej\./);
    expect(card.safety).toContain('częściej spadała poniżej 54');
  });

  it('a result counted before 2026-11-23 keeps its two rows, no chart and the old note', () => {
    const card = api.changeCard(state([{ direction: 'MORE', hours: '18:00–3:00', before: { days: 14, very_low_days: 0, tbr: 5.1, tar: 26 }, after: { days: 14, very_low_days: 3, tbr: 4.5, tar: 15 } }]));
    expect(card.sections[0].rows.map((r: { label: string }) => r.label)).toEqual(['Dni poniżej 54', 'Czas poniżej 70']);
    expect(card.sections[0].chart).toBeNull();
    expect(card.note).toMatch(/^Bez oceny/);
  });
});
