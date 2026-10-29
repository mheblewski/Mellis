import { describe, expect, it } from 'vitest';
import { answerToolScope } from './answer-tool-scope';

const scope = (text: string, extra: Partial<Parameters<typeof answerToolScope>[0]> = {}) => answerToolScope({ text, hasPhotos: false, previousAnswerHadCards: false, specialConversation: false, ...extra });

describe('answer tool scope (answer-tool-scope.v1)', () => {
  it.each([
    'Przeanalizuj mi ostatnie 7 dni pod kątem hipoglikemii',
    'Jak wyglądał wczorajszy dzień?',
    'Co to jest WBT?',
    'Jaki był TIR w tym tygodniu?',
  ])('leaves the card tools out of a look back or general question: %s', (text) => {
    expect(scope(text).cards).toBe(false);
  });

  it.each([
    'Ile podać na obiad, 50 g węgli?',
    'Daj 2 j korekty',
    'Spada do 65, co robić?',
    'Przypomnij mi o bolusie za 30 min',
    'Zje pizzę, ile insuliny?',
    'Dlaczego teraz rośnie?',
  ])('keeps the card tools when a dose, food or now is named: %s', (text) => {
    expect(scope(text).cards).toBe(true);
  });

  it('keeps everything for a photo, a reply to cards and a special conversation, whatever the wording', () => {
    for (const extra of [{ hasPhotos: true }, { previousAnswerHadCards: true }, { specialConversation: true }]) {
      expect(scope('Przeanalizuj mi ostatnie 7 dni', extra)).toEqual({ cards: true, meals: true });
    }
  });

  it('keeps the meal tools for a look back at meals', () => {
    expect(scope('Co jadł wczoraj na obiad?')).toEqual({ cards: false, meals: true });
    expect(scope('Przeanalizuj ostatnie 7 dni')).toEqual({ cards: false, meals: false });
  });
});
