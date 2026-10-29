import { describe, expect, it } from 'vitest';
import { ANSWER_READY_FALLBACK_BODY, answerPushBody } from './answer-push-text';

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
});
