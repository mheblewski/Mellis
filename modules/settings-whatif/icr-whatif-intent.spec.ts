import { describe, expect, it } from 'vitest';
import { icrBlocks, readIcrWhatIfIntent } from './application/icr-whatif-intent';

const SCHEDULE: Array<[string, number]> = [['00:00', 10], ['06:00', 5], ['09:30', 8.3], ['18:00', 6.8]];

describe('icrBlocks', () => {
  it('names each block by the time of day of its middle', () => {
    expect(icrBlocks(SCHEDULE).map((b) => [b.start, b.end, b.part])).toEqual([
      ['00:00', '06:00', 'NIGHT'], ['06:00', '09:30', 'MORNING'], ['09:30', '18:00', 'DAY'], ['18:00', '24:00', 'EVENING'],
    ]);
  });
});

describe('readIcrWhatIfIntent (icr-whatif-intent.v1)', () => {
  it('asks for the time of day when the named value is not in the settings, keeping the proportion', () => {
    const intent = readIcrWhatIfIntent('Chcę zmienić ICR z 4 na 5, sprawdź czy to ma sens', SCHEDULE);
    expect(intent).toEqual({
      kind: 'ASK_TIME',
      message: 'W ustawieniach nie ma ICR 4. Obecnie: rano 5 (6:00–9:30), w dzień 8,3 (9:30–18:00), wieczorem 6,8 (18:00–24:00), w nocy 10 (0:00–6:00). Którą porę przeliczyć o tę samą proporcję co 4 → 5?',
      chips: ['Rano 5 → 6,3', 'W dzień 8,3 → 10,4', 'Wieczorem 6,8 → 8,5', 'W nocy 10 → 12,5', 'Wszystkie pory: 20% mniej insuliny', 'Podam inną wartość'],
    });
  });

  it('replays the blocks that have the named value', () => {
    const intent = readIcrWhatIfIntent('przelicznik węglowodanów z 5 na 6', SCHEDULE);
    expect(intent).toMatchObject({ kind: 'REPLAY', scope: { kind: 'BLOCK', start: '06:00' }, ratio: 1.2, title: 'ICR rano 5 → 6' });
  });

  it('replays a named time of day with a new value only', () => {
    expect(readIcrWhatIfIntent('A gdyby ICR wieczorem było na 8,5?', SCHEDULE)).toMatchObject({ kind: 'REPLAY', scope: { kind: 'BLOCK', start: '18:00' }, title: 'ICR wieczorem 6,8 → 8,5' });
  });

  it('reads percent changes of insulin, all times when no time of day is named', () => {
    const all = readIcrWhatIfIntent('Sprawdź ICR o 20% mniej insuliny', SCHEDULE);
    expect(all).toMatchObject({ kind: 'REPLAY', scope: { kind: 'ALL' }, title: 'Wszystkie pory: 20% mniej insuliny na węgle' });
    expect(all && all.kind === 'REPLAY' ? all.ratio : 0).toBeCloseTo(1.25, 9);
    const more = readIcrWhatIfIntent('ICR rano o 10% więcej insuliny', SCHEDULE);
    expect(more).toMatchObject({ kind: 'REPLAY', scope: { kind: 'BLOCK', start: '06:00' } });
    expect(more && more.kind === 'REPLAY' ? more.ratio : 0).toBeCloseTo(1 / 1.1, 9);
  });

  it('understands its own chips only right after an ask-first reply', () => {
    expect(readIcrWhatIfIntent('Rano 5 → 6,3', SCHEDULE)).toBeNull();
    expect(readIcrWhatIfIntent('Rano 5 → 6,3', SCHEDULE, { afterAsk: true })).toMatchObject({ kind: 'REPLAY', scope: { kind: 'BLOCK', start: '06:00' }, title: 'ICR rano 5 → 6,3' });
    const all = readIcrWhatIfIntent('Wszystkie pory: 20% mniej insuliny', SCHEDULE, { afterAsk: true });
    expect(all).toMatchObject({ kind: 'REPLAY', scope: { kind: 'ALL' } });
    expect(readIcrWhatIfIntent('Podam inną wartość', SCHEDULE, { afterAsk: true })).toMatchObject({ kind: 'ASK_VALUE' });
  });

  it('leaves other questions and other settings to the chat', () => {
    expect(readIcrWhatIfIntent('Jak minęła noc?', SCHEDULE)).toBeNull();
    expect(readIcrWhatIfIntent('Czy zmienić ISF z 120 na 100?', SCHEDULE)).toBeNull();
    expect(readIcrWhatIfIntent('Co to jest ICR?', SCHEDULE)).toBeNull();
    expect(readIcrWhatIfIntent('ICR z 4 na 5', null)).toBeNull();
    expect(readIcrWhatIfIntent('ISF 120 → 100', SCHEDULE, { afterAsk: true })).toBeNull();
  });

  it('asks again when a named time of day has another value than the one given', () => {
    expect(readIcrWhatIfIntent('ICR rano z 4 na 5', SCHEDULE)).toMatchObject({ kind: 'ASK_TIME' });
  });

  it('replays several blocks with the same value together', () => {
    const schedule: Array<[string, number]> = [['00:00', 10], ['06:00', 6], ['12:00', 8], ['18:00', 6]];
    expect(readIcrWhatIfIntent('ICR z 6 na 7', schedule)).toMatchObject({ kind: 'REPLAY', scope: { kind: 'BLOCKS', starts: ['06:00', '18:00'] }, title: 'ICR 6 → 7 · 6 → 7' });
  });

  it('reads a follow-up that names only the value, taking the setting and the time of day from earlier messages', () => {
    const earlier = ['Jaki mamy icr na śniadanie?'];
    expect(readIcrWhatIfIntent('A co jakby go zmienić na 5,5?', SCHEDULE, { earlierUserMessages: earlier })).toMatchObject({ kind: 'REPLAY', scope: { kind: 'BLOCK', start: '06:00' }, title: 'ICR rano 5 → 5,5' });
    expect(readIcrWhatIfIntent('A gdyby o 10% mniej insuliny?', SCHEDULE, { earlierUserMessages: ['Jaki ICR wieczorem?'] })).toMatchObject({ kind: 'REPLAY', scope: { kind: 'BLOCK', start: '18:00' } });
    expect(readIcrWhatIfIntent('A co jakby go zmienić na 5,5?', SCHEDULE, { earlierUserMessages: ['Jak minęła noc?'] })).toBeNull();
    expect(readIcrWhatIfIntent('A ISF na 100?', SCHEDULE, { earlierUserMessages: earlier })).toBeNull();
    expect(readIcrWhatIfIntent('Zjadł na 5 rano', SCHEDULE, { earlierUserMessages: ['Pytałem o ICR wczoraj', 'x', 'y'] })).toBeNull();
  });
});
