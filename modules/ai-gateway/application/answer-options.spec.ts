import { describe, expect, it } from 'vitest';
import { readOptionKey, sanitizeAnswerOptions } from './answer-options';

describe('options under an answer (answer-options.v1)', () => {
  it('keeps 2-3 options with distinct keys and exactly one recommended', () => {
    expect(sanitizeAnswerOptions([
      { key: 'A', title: ' Najpierw 3 g,  bolus później ', detail: '15 g do Trio bez insuliny', note: '⚠️ Trzeba dopilnować dawki później', recommended: true },
      { key: 'B', title: 'Mniejsza dawka teraz', detail: '', recommended: false },
      { key: 'B', title: 'Duplikat', detail: 'x', recommended: false },
    ])).toEqual([
      { key: 'A', title: 'Najpierw 3 g, bolus później', detail: '15 g do Trio bez insuliny', note: '⚠️ Trzeba dopilnować dawki później', recommended: true },
      { key: 'B', title: 'Mniejsza dawka teraz', detail: null, note: null, recommended: false },
    ]);
    // None or several marked: the first is the recommended one.
    expect(sanitizeAnswerOptions([{ key: 'A', title: 'a', detail: '', recommended: false }, { key: 'B', title: 'b', detail: '', recommended: false }]).map((option) => option.recommended)).toEqual([true, false]);
    expect(sanitizeAnswerOptions([{ key: 'A', title: 'a', detail: '', recommended: false }, { key: 'B', title: 'b', detail: '', recommended: true }, { key: 'C', title: 'c', detail: '', recommended: true }]).map((option) => option.recommended)).toEqual([false, true, false]);
  });

  it('drops a single option, empty titles and anything that is not a list', () => {
    expect(sanitizeAnswerOptions([{ key: 'A', title: 'Jedyna', detail: '', recommended: true }])).toEqual([]);
    expect(sanitizeAnswerOptions([{ key: 'A', title: ' ', detail: '', recommended: true }, { key: 'D', title: 'x', detail: '', recommended: false }])).toEqual([]);
    expect(sanitizeAnswerOptions('A, B')).toEqual([]);
    expect(sanitizeAnswerOptions([{ key: 'A', title: 'x'.repeat(80), detail: '', recommended: true }, { key: 'B', title: 'b', detail: '', recommended: false }])[0].title).toHaveLength(60);
  });

  it('reads card option keys', () => {
    expect(readOptionKey('b')).toBe('B');
    expect(readOptionKey('D')).toBeNull();
    expect(readOptionKey(null)).toBeNull();
  });
});
