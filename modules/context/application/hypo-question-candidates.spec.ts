import { describe, expect, it } from 'vitest';
import { answerDisplayText, canUseEventScopedFact, getQuestionAnswerOptions, pickLatestUsableEventScopedFact } from './hypo-question-candidates';

describe('event-scoped fact usability policy', () => {
  it('matches required usability semantics', () => {
    expect(canUseEventScopedFact(null)).toBe(false);
    expect(canUseEventScopedFact({ knowledge_status: 'KNOWN', validity: 'VALID', status: 'ACTIVE' })).toBe(true);
    expect(canUseEventScopedFact({ knowledge_status: 'UNKNOWN', validity: 'VALID', status: 'ACTIVE' })).toBe(true);
    expect(canUseEventScopedFact({ knowledge_status: 'KNOWN', validity: 'INVALID', status: 'ACTIVE' })).toBe(false);
    expect(canUseEventScopedFact({ knowledge_status: 'KNOWN', validity: 'STALE', status: 'ACTIVE' })).toBe(false);
    expect(canUseEventScopedFact({ knowledge_status: 'KNOWN', validity: 'CONTRADICTED', status: 'ACTIVE' })).toBe(false);
    expect(canUseEventScopedFact({ knowledge_status: 'KNOWN', validity: 'VALID', status: 'SUPERSEDED' })).toBe(false);
    expect(canUseEventScopedFact({ knowledge_status: 'KNOWN', validity: 'VALID', status: 'REJECTED' })).toBe(false);
    expect(canUseEventScopedFact({ knowledge_status: 'KNOWN', validity: 'VALID', status: 'ARCHIVED' })).toBe(false);
    expect(canUseEventScopedFact({ knowledge_status: 'KNOWN', validity: 'VALID', status: 'INACTIVE' })).toBe(false);
  });

  it('picks the latest usable fact from pre-sorted rows', () => {
    const rows = [
      { id: 'newest-invalid', knowledge_status: 'KNOWN', validity: 'INVALID', status: 'ACTIVE' },
      { id: 'newest-stale', knowledge_status: 'KNOWN', validity: 'STALE', status: 'ACTIVE' },
      { id: 'latest-usable-unknown', knowledge_status: 'UNKNOWN', validity: 'VALID', status: 'ACTIVE' },
      { id: 'older-usable-known', knowledge_status: 'KNOWN', validity: 'VALID', status: 'ACTIVE' },
    ];

    const picked = pickLatestUsableEventScopedFact(rows as Array<Record<string, unknown>>);
    expect(picked?.id).toBe('latest-usable-unknown');
  });
});

describe('hypo question answer options', () => {
  it('offers carbohydrate amounts as one-tap answers that read as a sentence in the conversation', () => {
    const options = getQuestionAnswerOptions('additional_carbohydrates') ?? [];
    expect(options.map((option) => option.label)).toEqual(['2 g', '4 g', '6 g', '8 g', '10 g', '15 g', 'Nie podano', 'Nie wiem']);
    expect(options[1]).toEqual({ label: '4 g', answer_type: 'TEXT', answer_text: 'Podano 4 g węglowodanów' });
    expect(options.find((option) => option.label === 'Nie podano')?.answer_type).toBe('NO');
  });

  it('keeps Tak / Nie / Nie wiem for the activity question and nothing for unknown questions', () => {
    expect(getQuestionAnswerOptions('activity_before_drop')?.map((option) => option.label)).toEqual(['Tak', 'Nie', 'Nie wiem']);
    expect(getQuestionAnswerOptions('time_window_context')).toBeNull();
  });

  it('stores Polish words instead of answer codes', () => {
    expect(answerDisplayText({ type: 'YES' })).toBe('Tak');
    expect(answerDisplayText({ type: 'NO' })).toBe('Nie');
    expect(answerDisplayText({ type: 'UNKNOWN' })).toBe('Nie wiem');
    expect(answerDisplayText({ type: 'TEXT', text: 'Podano 4 g węglowodanów' })).toBe('Podano 4 g węglowodanów');
  });
});
