import { describe, expect, it } from 'vitest';
import { ANSWER_READY_FALLBACK_BODY, answerPushBody, QUESTION_PUSH_FALLBACK_BODY, questionPushBody } from './answer-push-text';

describe('answerPushBody', () => {
  it('turns the Markdown answer into one plain line', () => {
    const content = '## Teraz\n\n**Glukoza 142 mg/dL** i stabilna.\n\n- IOB: 1,2 U\n- [Źródło](https://example.com) mówi, że `nic` nie trzeba.';
    expect(answerPushBody(content)).toBe('Teraz Glukoza 142 mg/dL i stabilna. IOB: 1,2 U Źródło mówi, że nic nie trzeba.');
  });

  it('cuts a long answer at a word and adds an ellipsis', () => {
    const content = 'Spadek po obiedzie wynika najpewniej z dużej dawki przed posiłkiem oraz aktywności po południu, '.repeat(4);
    const body = answerPushBody(content, 80);
    expect(body.length).toBeLessThanOrEqual(81);
    expect(body.endsWith('…')).toBe(true);
    expect(body).not.toMatch(/[\s,]…$/);
    expect(content.startsWith(body.slice(0, -1))).toBe(true);
  });

  it('keeps a short answer whole and says something for an empty one', () => {
    expect(answerPushBody('Tak, możesz.')).toBe('Tak, możesz.');
    expect(answerPushBody('  \n**  **\n')).toBe(ANSWER_READY_FALLBACK_BODY);
  });

  it('hides an answer that names a dose behind the tap line', () => {
    expect(ANSWER_READY_FALLBACK_BODY).toBe('Dotknij, aby przeczytać odpowiedź.');
    for (const content of ['Podaj teraz 2 j na obiad.', 'Wystarczy 1,5 j.', 'Daj 15 g szybkich węglowodanów.', 'Proponuję 2j teraz.', 'Baza 0,5 j/h wystarczy.']) {
      expect(answerPushBody(content)).toBe(ANSWER_READY_FALLBACK_BODY);
    }
    // A dose just past the cut counts too, so no cut dose reaches the lock screen.
    expect(answerPushBody(`${'słowo '.repeat(13)}podaj 2 j`, 80)).toBe(ANSWER_READY_FALLBACK_BODY);
    expect(answerPushBody('Glukoza 142 i stabilna, za 2 godz. sprawdź jeszcze raz.')).toBe('Glukoza 142 i stabilna, za 2 godz. sprawdź jeszcze raz.');
    expect(answerPushBody('Zjadł 100 gramów makaronu.')).toBe('Zjadł 100 gramów makaronu.');
  });
});

describe('questionPushBody', () => {
  it('shows the question cut near 120 characters, or the fallback', () => {
    expect(questionPushBody('Czy był **ruch** przed spadkiem?')).toBe('Czy był ruch przed spadkiem?');
    const long = questionPushBody('Czy przed spadkiem było coś jeszcze, '.repeat(6));
    expect(long.length).toBeLessThanOrEqual(121);
    expect(long.endsWith('…')).toBe(true);
    expect(questionPushBody(undefined)).toBe(QUESTION_PUSH_FALLBACK_BODY);
    expect(questionPushBody('   ')).toBe(QUESTION_PUSH_FALLBACK_BODY);
  });
});
