import { describe, expect, it } from 'vitest';
import { settleSameTurnAnswer } from './dose-one-turn';

const card = (fields: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  tool_name: 'propose_bolus',
  result: { status: 'PROPOSED', card: { option: null, insulin_u: 2, warnings: [], ...fields }, ...extra },
});
const answer = (text = 'Karta poniżej.', options: Array<{ key: string }> = []) => ({ assistant_message: text, answer_options: options, follow_up_candidates: [], conversation_title: null });

describe('settleSameTurnAnswer', () => {
  it('keeps an answer whose cards were proposed', () => {
    const verdict = settleSameTurnAnswer(answer(), [card()]);
    expect(verdict).toMatchObject({ accepted: true, warning_added: false, answer: { assistant_message: 'Karta poniżej.' } });
  });

  it('adds the most severe warning a card without options has and the text does not mention', () => {
    const verdict = settleSameTurnAnswer(answer(), [card({ warnings: ['Glukoza już spada.', '[!!] Prognoza: 55 mg/dL.'] })]);
    expect(verdict).toMatchObject({ accepted: true, warning_added: true, answer: { assistant_message: 'Karta poniżej.\n\n⚠️ Prognoza: 55 mg/dL.' } });
  });

  it('adds nothing when the text has its warning or the answer has options', () => {
    expect(settleSameTurnAnswer(answer('⚠️ Uwaga na spadek.'), [card({ warnings: ['Glukoza już spada.'] })])).toMatchObject({ accepted: true, warning_added: false });
    expect(settleSameTurnAnswer(answer('Wybierz.', [{ key: 'A' }]), [card({ option: 'A', warnings: ['Glukoza już spada.'] })])).toMatchObject({ accepted: true, warning_added: false });
  });

  it.each([
    ['a card the server did not prepare', answer(), [{ tool_name: 'propose_bolus', result: { status: 'NEEDS_DOSE' } }], 'propose_bolus:NEEDS_DOSE'],
    ['a tool whose result the answer needed', answer(), [{ tool_name: 'search_food', result: { status: 'FOUND' } }], 'TOOL:search_food'],
    ['a note the text must say', answer(), [card({}, { dose_above_formula: 'x' })], 'dose_above_formula'],
    ['a split the server does not advise', answer('Wybierz.', [{ key: 'A' }]), [card({ option: 'A' }, { split_advice: { advised: false } })], 'SPLIT_NOT_ADVISED'],
    ['a card of an option not offered', answer('Wybierz.', [{ key: 'A' }]), [card({ option: 'B' })], 'CARD_OPTION_UNKNOWN'],
    ['a card with an option in an answer without options', answer(), [card({ option: 'A' })], 'CARD_OPTION_WITHOUT_OPTIONS'],
    ['every option deferring the dose', answer('Wybierz.', [{ key: 'A' }, { key: 'B' }]), [card({ option: 'A', insulin_u: 0 }, { deferred_for_low: 'x' }), card({ option: 'B', insulin_u: 0 }, { deferred_for_low: 'x' })], 'STANDARD_OPTION_MISSING'],
    ['an empty text', answer(' '), [card()], 'NO_TEXT'],
  ])('asks again after %s', (_name, written, results, reason) => {
    expect(settleSameTurnAnswer(written, results)).toEqual({ accepted: false, reason });
  });

  it('keeps options when one of them still gives insulin now', () => {
    const results = [card({ option: 'A', insulin_u: 0 }, { deferred_for_low: 'x' }), card({ option: 'B', insulin_u: 2.5 })];
    expect(settleSameTurnAnswer(answer('Wybierz.', [{ key: 'A' }, { key: 'B' }]), results)).toMatchObject({ accepted: true });
  });
});
