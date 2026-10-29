import { ACTIVITY_BEFORE_DROP_CANDIDATE, ADDITIONAL_CARBOHYDRATES_CANDIDATE, canUseEventScopedFact } from './hypo-question-candidates';

import {
  shouldSkipUserClarificationQuestion,
  type ConversationContextResolution,
} from './conversation-context-resolver';

export type InvestigationEventFamily = 'HYPO' | 'USER';
export type InvestigationDecision = 'ASK_NOW' | 'ASK_LATER' | 'FINISH';
export type UserMessageCapability = 'DIRECT_RESPONSE' | 'INVESTIGATION_REQUIRED' | 'ANALYSIS_REQUEST';
export type InvestigationState =
  | 'NEW'
  | 'OPEN'
  | 'QUESTION_PENDING'
  | 'RE_EVALUATING'
  | 'FINISHED_NO_QUESTION'
  | 'FINISHED_ASK_LATER'
  | 'RESOLVED'
  | 'CLOSED';
export type FactKnowledgeStatus = 'MISSING' | 'KNOWN' | 'UNKNOWN';

export type InvestigationCandidate = {
  candidate_id: string;
  version: string;
  event_family: InvestigationEventFamily;
  fact_key: string;
  fact_name: string;
  fact_type: string;
  question_type: string;
  question_text: string;
  reason: string;
  expected_answer_types: Array<'YES' | 'NO' | 'UNKNOWN' | 'TEXT'>;
  expected_information_gain: 'HIGH' | 'MODERATE' | 'LOW';
  priority: 'HIGH' | 'LOW';
  selection_rank: number;
  enabled: boolean;
};

export function getCandidateRegistry(
  eventFamily: InvestigationEventFamily,
  conversationContext?: ConversationContextResolution | null,
): InvestigationCandidate[] {
  if (eventFamily === 'USER') {
    if (conversationContext && shouldSkipUserClarificationQuestion(conversationContext)) {
      return [];
    }

    return [
      {
        candidate_id: 'time_window_context',
        version: 'user-question-candidate.v1',
        event_family: eventFamily,
        fact_key: 'time_window_context',
        fact_name: 'Time window and context clarification',
        fact_type: 'CAREGIVER_CONTEXT',
        question_type: 'CONTEXT_QUESTION',
        question_text: 'Czy możesz doprecyzować, jakiego okresu dotyczy pytanie i które zdarzenia są najważniejsze?',
        reason: 'Generic USER investigation needs explicit time window/context before deeper analysis.',
        expected_answer_types: ['UNKNOWN', 'TEXT'],
        expected_information_gain: 'HIGH',
        priority: 'HIGH',
        selection_rank: 10,
        enabled: true,
      },
    ];
  }

  // A hypo asks no question cards any more (nothing is asked after the fact).
  return [];
}

/** The question cards hypos used to ask; kept so an answer to a card still open in an old app build is stored. */
function getLegacyHypoCandidates(): InvestigationCandidate[] {
  const eventFamily: InvestigationEventFamily = 'HYPO';
  const candidates = [
    {
      candidate_id: ACTIVITY_BEFORE_DROP_CANDIDATE.question_id,
      version: ACTIVITY_BEFORE_DROP_CANDIDATE.version,
      event_family: eventFamily,
      fact_key: ACTIVITY_BEFORE_DROP_CANDIDATE.fact_key,
      fact_name: ACTIVITY_BEFORE_DROP_CANDIDATE.fact_name,
      fact_type: ACTIVITY_BEFORE_DROP_CANDIDATE.fact_type,
      question_type: ACTIVITY_BEFORE_DROP_CANDIDATE.question_type,
      question_text: ACTIVITY_BEFORE_DROP_CANDIDATE.text,
      reason: ACTIVITY_BEFORE_DROP_CANDIDATE.reason,
      expected_answer_types: ACTIVITY_BEFORE_DROP_CANDIDATE.expected_answer_types,
      expected_information_gain: ACTIVITY_BEFORE_DROP_CANDIDATE.expected_information_gain,
      priority: 'HIGH',
      selection_rank: 10,
      enabled: true,
    },
    {
      candidate_id: ADDITIONAL_CARBOHYDRATES_CANDIDATE.question_id,
      version: ADDITIONAL_CARBOHYDRATES_CANDIDATE.version,
      event_family: eventFamily,
      fact_key: ADDITIONAL_CARBOHYDRATES_CANDIDATE.fact_key,
      fact_name: ADDITIONAL_CARBOHYDRATES_CANDIDATE.fact_name,
      fact_type: ADDITIONAL_CARBOHYDRATES_CANDIDATE.fact_type,
      question_type: ADDITIONAL_CARBOHYDRATES_CANDIDATE.question_type,
      question_text: ADDITIONAL_CARBOHYDRATES_CANDIDATE.text,
      reason: ADDITIONAL_CARBOHYDRATES_CANDIDATE.reason,
      expected_answer_types: ADDITIONAL_CARBOHYDRATES_CANDIDATE.expected_answer_types,
      expected_information_gain: ADDITIONAL_CARBOHYDRATES_CANDIDATE.expected_information_gain,
      priority: 'HIGH',
      selection_rank: 20,
      enabled: true,
    },
  ] as const;

  return candidates.map((candidate) => ({ ...candidate }));
}

export function determineFactKnowledgeStatus(fact: Record<string, unknown> | null): FactKnowledgeStatus {
  if (!fact) {
    return 'MISSING';
  }

  if (!canUseEventScopedFact(fact)) {
    return 'MISSING';
  }

  const knowledgeStatus = String(fact.knowledge_status ?? '').toUpperCase();
  if (knowledgeStatus === 'UNKNOWN') {
    return 'UNKNOWN';
  }

  return 'KNOWN';
}

export function getAllowedCandidatesForEvent(args: {
  eventFamily: InvestigationEventFamily;
  activeQuestionId?: string | null;
  eventFacts: Array<Record<string, unknown>>;
}): InvestigationCandidate[] {
  const registry = getCandidateRegistry(args.eventFamily);

  return registry
    .filter((candidate) => {
    if (!candidate.enabled) {
      return false;
    }

    const fact = args.eventFacts.find((entry) => String(entry.fact_key ?? '') === candidate.fact_key);
    if (fact && canUseEventScopedFact(fact)) {
      return false;
    }

    if (args.activeQuestionId && args.activeQuestionId === candidate.candidate_id) {
      return false;
    }

    return true;
    })
    .sort((left, right) => left.selection_rank - right.selection_rank);
}

export function createInvestigationCandidateFromQuestionId(questionId: string): InvestigationCandidate | null {
  return [...getLegacyHypoCandidates(), ...getCandidateRegistry('USER')]
    .find((candidate) => candidate.candidate_id === questionId) ?? null;
}

const DIRECT_RESPONSE_SIGNALS = [
  'co oznacza',
  'what does',
  'jak działa',
  'jakie są',
  'czy to normalne',
  'what is',
  'define',
  'po co',
  'czy zapiszesz',
  'czy zapiszecie',
  'czy to bedzie zapisane',
  'czy to będzie zapisane',
  'czy zapisujecie',
  'zapis do bazy',
  'zapisane do bazy',
  'w tej rozmowie',
  'tylko w tej rozmowie',
  'czy to trafia do bazy',
  'czy to zostanie zapisane',
  'czy zapiszesz ten posilek',
  'czy zapiszesz ten posiłek',
  'czy zapiszecie ten posilek',
  'czy zapiszecie ten posiłek',
  'privacy',
  'prywat',
  'retencj',
  'gdzie to jest zapisane',
  'gdzie to zapisujecie',
  'czy zapisujecie to na stale',
  'czy zapisujecie to na stałe',
];

/**
 * Definition and privacy wordings of DIRECT_RESPONSE_SIGNALS that are general on their own. "jakie są", "czy to
 * normalne" and "po co" are left out: "Jakie są cukry?", "Czy to normalne, że tak spada?" and "Po co pętla wstrzymała
 * bazę?" are about the patient (DEFINITION_PATTERN keeps "jakie są objawy…" and "po co jest…").
 */
const GENERAL_SIGNALS = DIRECT_RESPONSE_SIGNALS.filter((signal) => !['jakie są', 'czy to normalne', 'po co'].includes(signal));

/**
 * The message asks about the patient's own data (glucose, insulin, carbs/meals, hypo/hyper, a clock time, "pokaż" /
 * "porównaj"), unless it is a general question ("co oznacza", "jak działa", privacy). Such a message must be answered
 * with patient evidence, never by a direct reply that has none loaded.
 */
const PATIENT_DATA_PATTERN = /poda[cć]|dawk|korekt|jednost|przelicznik|wsp[oó][lł]czynnik|\bicr\b|\bisf\b|\bbaz(?:a|y|ę|e|ie)\b|prebolus|wzorz|wzorc|powtarza|regularn|cz[eę]sto|zazwyczaj|zwykle|codzienn|ka[zż]d(?:ego|ej|y) (?:dnia|rana|nocy)|pattern|recurr|insulin|bolus|\bsmb\b|bazal|w[eę]gl|\bww\b|posi[lł]k|jedzeni|glukoz|cukr|cukier|glikem|hipo|hiper|niedocukrz|odczyt|pomiar|\bcgm\b|\biob\b|\bcob\b|poka[zż]|por[oó]wnaj|przebieg|trend|wykres|\b\d{1,2}[:.]\d{2}\b/;

const SOCIAL_PHRASE = /^(?:dzi[eę]k(?:i|uj[eę]|uje)(?:\s+(?:wielkie|bardzo|ci|serdeczne|pi[eę]kne))*(?:\s+za\b.*)?|ok(?:ej|ay)?|super|spoko|jasne|dobra|dobrze|rozumiem|thx|thanks|thank you|cze[sś][cć]|hej|siema|dzie[nń] dobry|dobry wiecz[oó]r|dobranoc|jak si[eę] masz|co s[lł]ycha[cć]|jak leci|[sś]wietnie|fajnie|aha|kapuj[eę]|widz[eę]|mi[lł]ego dnia|na razie|pa)$/;

/**
 * Thanks, acknowledgements and greetings: answered directly even in a conversation about the patient's data. Every part
 * between commas must be one ("Cześć, jak się masz?", "Super, dzięki za pomoc"); "Dzięki, a w nocy?" is a question.
 */
export function isSocialMessage(message: string): boolean {
  const parts = String(message ?? '').trim().toLowerCase().split(/[!.?,;:]+/).map((part) => part.trim()).filter((part) => part.length > 0);
  return parts.length > 0 && parts.every((part) => SOCIAL_PHRASE.test(part));
}

/** Lower case without Polish diacritics. */
function plain(message: string): string {
  return String(message ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
}

/** Definitions and how something works ("co to jest WBT?", "jak działa SMB?"). */
const DEFINITION_PATTERN = /\bco to (?:jest|sa|znaczy|za)\b|\bco znaczy\b|\bczym (?:jest|sa|sie rozni\w*)\b|\bna czym polega\b|\bjak (?:to )?dziala\b|\bpo co (?:jest|sa|sluzy|stosuje|uzywa)\w*\b|\bjakie sa\b(?!.*\b(?:cukr\w*|cukier|glukoz\w*|odczyt\w*|wynik\w*|pomiar\w*|sredni\w*|wartosc\w*|dawk\w*|bolus\w*|insulin\w*|tdd|tir)\b)|\bhow does\b/;
/** How-to questions built on an infinitive ("jak liczyć wymienniki?", "co jeść na noc?", "jak często zmieniać wkłucie?"). */
const HOW_TO_START_PATTERN = /^(?:a\s+)?(?:jak|co|ile|kiedy|czym|gdzie|w jaki sposob|czy (?:mozna|trzeba|nalezy|warto|powinno sie))\b/;
const INFINITIVE_PATTERN = /\b\w{2,}(?:ac|ic|yc|ec|uc|sc|zc)\b/g;
const NOT_INFINITIVES = new Set(['wiec', 'koniec', 'palec', 'chlopiec', 'kupiec', 'tablic', 'granic', 'ulic', 'miesiec', 'zajac']);
/**
 * Wording that ties a how-to question to this patient's data: a dose for a meal ("ile podać na pizzę"), a therapy
 * action or setting, the patient as a person ("mu", "synowi"), a current reading ("cukier 250", "rośnie"), a cause
 * ("co mogło je powodować?") or "them" pointing back at what the conversation is about ("je", "ich", "nich").
 */
const PATIENT_TIED_PATTERN = /powod|przyczyn|\b(?:je|ich|nich)\b|\b(?:poda|da|dawk)\w*\s+(?:mu\s+|jej\s+)?(?:na|do)\b|korekt|bolus|insulin|dawk|jednost|przelicznik|\bisf\b|\bicr\b|wspolczynnik|\bbaz(?:a|y|e|ie|owa|owe|owej)\b|bazal|\b(?:mu|jej|synowi|corce|synem|corka|nasz\w*|moj\w*|u niego|u niej|u nas)\b|\b(?:cukier|glukoza|glikemia|bg)\s*(?:jest\s*|ma\s*|wynosi\s*)?\d{2,3}\b|\b\d{2,3}\s*mg|strzalk|\brosnie\b|\bspada\b/;

/**
 * Privacy and storage wordings of GENERAL_SIGNALS: general whatever else the message says ("czy zapiszesz mój posiłek
 * 250 g?"). "w tej rozmowie" alone is not one: "Jak w tej rozmowie pisałem, po kolacji spadł do 50" is about the patient.
 */
const PRIVACY_SIGNALS = GENERAL_SIGNALS.filter((signal) => /zapis|privacy|prywat|retencj|bazy|tylko w tej rozmowie/.test(signal));

/**
 * A definition-like wording pointing at one of this patient's events or readings (2026-10-21 audit: "Co oznacza ten
 * spadek o 14:30?" got a general answer without data): "ten/ta/to/tego … spadek/wynik/odczyt…", a clock time, a
 * reading with its value ("wynik 250", "spadł do 50"), the patient's own setting ("jego bazal"), a reading moving now
 * ("tak rośnie"). Pure definitions ("Co oznacza IOB?", "Jak działa SMB?", "Co to jest bolus przedłużony?") stay general.
 */
const PATIENT_EVENT_PATTERN = new RegExp([
  '\\b(?:ten|ta|tego|tej|tym|te|tych|tamt\\w*)\\s+(?:\\w+\\s+)?(?:spad\\w*|spadk\\w*|skok\\w*|wzrost\\w*|wynik\\w*|odczyt\\w*|pomiar\\w*|hipo\\w*|hiper\\w*|niedocukrz\\w*|alarm\\w*|wykres\\w*|dolek|dolk\\w*|pik(?:u|i|iem)?\\b|cukier|cukr\\w*|glikemi\\w*|strzalk\\w*)',
  '\\b\\d{1,2}[:.]\\d{2}\\b',
  '\\b(?:wynik\\w*|odczyt\\w*|pomiar\\w*|cukier|cukr\\w*|glukoz\\w*|glikemi\\w*|bg)\\s*(?:to\\s+|na\\s+|=\\s*|:\\s*)?\\d{2,3}\\b',
  '\\b(?:spadl\\w*|spadla|wzrosl\\w*|skoczyl\\w*|podskoczyl\\w*|rosl(?:a|o|y)?|zjechal\\w*|siegnal\\w*)\\b',
  '\\b(?:jego|jej|syna|corki)\\s+(?:bazal\\w*|baz(?:a|y|e|ie)|insulin\\w*|cukr\\w*|cukier|glikemi\\w*|wynik\\w*|odczyt\\w*|pomp\\w*|sensor\\w*|ustawien\\w*|przelicznik\\w*|wspolczynnik\\w*|isf|icr|dawk\\w*|bolus\\w*|petl\\w*|trio)\\b|\\b(?:mu|synowi|corce|u niego|u niej)\\b',
  '\\btak\\s+(?:rosnie|spada|skacze|wysoko|nisko)\\b',
].join('|'));

/**
 * General questions that need no patient data: definitions, how something works, how-to questions, the app's privacy and
 * storage. Anything else is a question about the patient (data by default, 2026-10-19). A definition or "jak działa"
 * pointing at the patient's own event, reading or setting is about the patient (PATIENT_EVENT_PATTERN).
 */
export function isGeneralKnowledgeQuestion(message: string): boolean {
  const text = String(message ?? '').trim().toLowerCase();
  if (!text) return false;
  if (PRIVACY_SIGNALS.some((signal) => text.includes(signal))) return true;
  const plainText = plain(text);
  if (PATIENT_EVENT_PATTERN.test(plainText)) return false;
  if (GENERAL_SIGNALS.some((signal) => text.includes(signal))) return true;
  if (DEFINITION_PATTERN.test(plainText)) return true;
  return HOW_TO_START_PATTERN.test(plainText)
    && [...plainText.matchAll(INFINITIVE_PATTERN)].some((match) => !NOT_INFINITIVES.has(match[0]))
    && !PATIENT_TIED_PATTERN.test(plainText);
}

export function isPatientDataQuestion(message: string): boolean {
  const text = String(message ?? '').trim().toLowerCase();
  if (!text || DIRECT_RESPONSE_SIGNALS.some((signal) => text.includes(signal))) {
    return false;
  }
  return PATIENT_DATA_PATTERN.test(text);
}

export function determineUserMessageCapability(message: string): UserMessageCapability {
  const text = String(message ?? '').trim().toLowerCase();
  if (!text) {
    return 'DIRECT_RESPONSE';
  }

  const analysisSignals = [
    'przeanalizuj',
    'analizuj',
    'analiza',
    'dzisiejszy dzień',
    'dzisiejszy dzien',
    'dzisiejszego dnia',
    'ostatnie 24 godziny',
    'podsumuj dzień',
    'podsumuj dzien',
    'jak wyglądał mój dzisiejszy dzień',
    'jak wygladal moj dzisiejszy dzien',
  ];

  if (analysisSignals.some((signal) => text.includes(signal))) {
    return 'ANALYSIS_REQUEST';
  }

  const mealAnalysisSignals = [
    'ile insuliny na',
    'ile insulin na',
    'ile insuliny do',
    'ile insulin do',
    'na ten posiłek',
    'na ten posilek',
    'na ten obiad',
    'na ten lunch',
    'na ten dinner',
    'jak zareagował wcześniej na',
    'jak reagował wcześniej na',
    'jak zareagowal wcześniej na',
    'podobny posiłek',
    'podobny posilek',
    'similar meal',
    'meal response',
    'insulin on meal',
    'what insulin for this meal',
    'how did it respond to a similar meal',
  ];

  if (mealAnalysisSignals.some((signal) => text.includes(signal))) {
    return 'ANALYSIS_REQUEST';
  }

  const directResponseSignals = DIRECT_RESPONSE_SIGNALS;

  if (directResponseSignals.some((signal) => text.includes(signal))) {
    return 'DIRECT_RESPONSE';
  }

  const investigationSignals = [
    'dlaczego',
    'why',
    'po obiedzie',
    'po kolacji',
    'jak długo',
    'wczoraj',
    'cukier',
    'glukoza',
    'insulina',
    'po insulinie',
    'po posiłku',
    'rósł',
    'rosl',
    'spadł',
    'wykres',
  ];

  if (investigationSignals.some((signal) => text.includes(signal))) {
    return 'INVESTIGATION_REQUIRED';
  }

  return text.length < 80 ? 'DIRECT_RESPONSE' : 'INVESTIGATION_REQUIRED';
}

export function evaluateInvestigationDecision(args: {
  eventFamily: InvestigationEventFamily;
  eventFacts: Array<Record<string, unknown>>;
  activeQuestionId?: string | null;
  conversationContext?: ConversationContextResolution | null;
}): { decision: InvestigationDecision; candidate: InvestigationCandidate | null; reason: string } {
  if (args.eventFamily === 'USER' && args.conversationContext && shouldSkipUserClarificationQuestion(args.conversationContext)) {
    return {
      decision: 'FINISH',
      candidate: null,
      reason: 'Conversation context already resolved; no generic clarification question required.',
    };
  }

  const allowed = getAllowedCandidatesForEvent(args);

  if (allowed.length === 0) {
    return {
      decision: 'FINISH',
      candidate: null,
      reason: 'No eligible candidate remains for this event.',
    };
  }

  const candidate = allowed[0];
  const factStatus = determineFactKnowledgeStatus(
    args.eventFacts.find((entry) => String(entry.fact_key ?? '') === candidate.fact_key) ?? null,
  );

  return evaluateCandidateDecision({ candidate, factStatus });
}

export function evaluateCandidateDecision(args: {
  candidate: InvestigationCandidate;
  factStatus: FactKnowledgeStatus;
}): { decision: InvestigationDecision; candidate: InvestigationCandidate | null; reason: string } {
  const { candidate, factStatus } = args;

  if (factStatus === 'MISSING') {
    if (candidate.priority === 'HIGH') {
      return {
        decision: 'ASK_NOW',
        candidate,
        reason: 'Missing fact is relevant and high-value for the current event.',
      };
    }

    return {
      decision: 'ASK_LATER',
      candidate,
      reason: 'Missing fact is relevant but not valuable enough to ask now.',
    };
  }

  if (factStatus === 'UNKNOWN') {
    return {
      decision: 'FINISH',
      candidate: null,
      reason: 'Fact is explicitly UNKNOWN; no additional question is required for v1.',
    };
  }

  return {
    decision: 'FINISH',
    candidate: null,
    reason: 'Fact is already known for this event.',
  };
}
