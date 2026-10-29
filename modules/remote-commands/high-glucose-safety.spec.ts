import { describe, expect, it } from 'vitest';
import { detectHighDespiteInsulin } from './application/high-glucose-safety';

const now = new Date('2026-10-22T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const every5 = (from: number, value: (minutesAgo: number) => number) => Array.from({ length: from / 5 + 1 }, (_, index) => {
  const ago = from - index * 5;
  return { at: minutesAgo(ago), value: value(ago) };
});

describe('a high despite insulin (high-glucose-safety.v1)', () => {
  it('points out glucose above 250 for 2 hours', () => {
    const result = detectHighDespiteInsulin({ now, readings: every5(120, () => 270), boluses: [], carbs: [] });
    expect(result).toMatchObject({ kind: 'SUSTAINED_HIGH' });
    expect(result!.message).toMatch(/^Glukoza powyżej 250 mg\/dL od 2 godzin mimo pętli\. Sprawdź glukometrem, zmierz ketony/);
  });

  it('points out a correction that did not lower glucose by 50 in its first hour', () => {
    const readings = every5(150, (ago) => (ago >= 90 ? 240 : 225));
    expect(detectHighDespiteInsulin({ now, readings, boluses: [{ at: minutesAgo(90), units: 1.5 }], carbs: [] })).toMatchObject({ kind: 'CORRECTION_NO_EFFECT' });
    // A meal bolus (carbs with it) is not a correction.
    expect(detectHighDespiteInsulin({ now, readings, boluses: [{ at: minutesAgo(90), units: 1.5 }], carbs: [{ at: minutesAgo(92), grams: 40 }] })).toBeNull();
  });

  it('says nothing about an ordinary high', () => {
    expect(detectHighDespiteInsulin({ now, readings: every5(120, (ago) => (ago > 60 ? 180 : 260)), boluses: [], carbs: [] })).toBeNull();
  });
});
