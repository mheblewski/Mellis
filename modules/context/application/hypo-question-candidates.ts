export type HypoContextQuestionCandidate = {
  version: 'hypo-question-candidate.v1';
  question_id: string;
  fact_key: string;
  fact_name: string;
  fact_type: 'CAREGIVER_CONTEXT';
  question_type: 'CONTEXT_QUESTION';
  text: string;
  reason: string;
  expected_information_gain: 'HIGH';
  expected_answer_types: Array<'YES' | 'NO' | 'UNKNOWN' | 'TEXT'>;
};

/** One tap answer shown under a question; a TEXT option sends its answer_text as the caregiver's answer. */
export type QuestionAnswerOption = {
  label: string;
  answer_type: 'YES' | 'NO' | 'UNKNOWN' | 'TEXT';
  answer_text?: string;
};

export const ACTIVITY_BEFORE_DROP_CANDIDATE: HypoContextQuestionCandidate = {
  version: 'hypo-question-candidate.v1',
  question_id: 'activity_before_drop',
  fact_key: 'activity_before_drop',
  fact_name: 'Activity before drop',
  fact_type: 'CAREGIVER_CONTEXT',
  question_type: 'CONTEXT_QUESTION',
  text: 'Czy przed spadkiem był ruch lub sport (np. bieganie, WF, zabawa na dworze)?',
  reason: 'A hypo trigger was detected and needs a context response.',
  expected_information_gain: 'HIGH',
  expected_answer_types: ['YES', 'NO', 'UNKNOWN', 'TEXT'],
};

export const ADDITIONAL_CARBOHYDRATES_CANDIDATE: HypoContextQuestionCandidate = {
  version: 'hypo-question-candidate.v1',
  question_id: 'additional_carbohydrates',
  fact_key: 'additional_carbohydrates',
  fact_name: 'Additional carbohydrates around hypo',
  fact_type: 'CAREGIVER_CONTEXT',
  question_type: 'CONTEXT_QUESTION',
  text: 'Ile węglowodanów podano, żeby podnieść cukier?',
  reason: 'A hypo trigger was detected and requires carbohydrate context.',
  expected_information_gain: 'HIGH',
  expected_answer_types: ['YES', 'NO', 'UNKNOWN', 'TEXT'],
};

const YES_NO_UNKNOWN_OPTIONS: QuestionAnswerOption[] = [
  { label: 'Tak', answer_type: 'YES' },
  { label: 'Nie', answer_type: 'NO' },
  { label: 'Nie wiem', answer_type: 'UNKNOWN' },
];

const CARBOHYDRATE_AMOUNTS_G = [2, 4, 6, 8, 10, 15];

const ADDITIONAL_CARBOHYDRATES_OPTIONS: QuestionAnswerOption[] = [
  ...CARBOHYDRATE_AMOUNTS_G.map((grams) => ({
    label: `${grams} g`,
    answer_type: 'TEXT' as const,
    answer_text: `Podano ${grams} g węglowodanów`,
  })),
  { label: 'Nie podano', answer_type: 'NO' },
  { label: 'Nie wiem', answer_type: 'UNKNOWN' },
];

/** Tap answers for a hypo question; null for questions the app answers with its default Tak / Nie / Nie wiem. */
export function getQuestionAnswerOptions(questionId: string): QuestionAnswerOption[] | null {
  if (questionId === ADDITIONAL_CARBOHYDRATES_CANDIDATE.question_id) {
    return ADDITIONAL_CARBOHYDRATES_OPTIONS.map((option) => ({ ...option }));
  }

  if (questionId === ACTIVITY_BEFORE_DROP_CANDIDATE.question_id) {
    return YES_NO_UNKNOWN_OPTIONS.map((option) => ({ ...option }));
  }

  return null;
}

/** The caregiver's answer as it reads in the conversation: Polish words instead of the YES / NO / UNKNOWN codes. */
export function answerDisplayText(answer: { type: 'YES' | 'NO' | 'UNKNOWN' | 'TEXT'; text?: string | null }): string {
  switch (answer.type) {
    case 'YES':
      return 'Tak';
    case 'NO':
      return 'Nie';
    case 'UNKNOWN':
      return 'Nie wiem';
    default:
      return answer.text ?? '';
  }
}

export function canUseEventScopedFact(fact: Record<string, unknown> | null): boolean {
  if (!fact) {
    return false;
  }

  const status = String(fact.status ?? '');
  const validity = String(fact.validity ?? '');
  const knowledgeStatus = String(fact.knowledge_status ?? '');

  if (status !== 'ACTIVE') {
    return false;
  }

  if (validity !== 'VALID') {
    return false;
  }

  return knowledgeStatus === 'KNOWN' || knowledgeStatus === 'UNKNOWN';
}

export function pickLatestUsableEventScopedFact(rows: Array<Record<string, unknown>>): Record<string, unknown> | null {
  for (const row of rows) {
    if (canUseEventScopedFact(row)) {
      return row;
    }
  }

  return null;
}
