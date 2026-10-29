import type { AiModelTier, AiTask } from '@modules/ai-gateway/domain/ai-gateway';
import { isCausalQuestion } from '@modules/context/application/conversation-context-resolver';
import { isSocialMessage } from '@modules/context/application/investigation-policy';

/** Version of the tier choice below (the tasks' model_policy_version). */
export const MODEL_ROUTING_POLICY_VERSION = 'model-tier-routing.v1';

export interface ModelTierDecision {
  tier: AiModelTier;
  reason:
    | 'DIRECT_RESPONSE'
    | 'KNOWLEDGE_QUESTION'
    | 'DATA_LOOKUP'
    | 'ANALYTICAL_QUESTION'
    | 'CAUSAL_QUESTION'
    | 'THERAPY_QUESTION'
    | 'PRE_HYPO_EVIDENCE'
    | 'PHOTO_QUESTION'
    | 'MEAL_CHANGE'
    | 'DOSE_REQUEST'
    | 'LONG_RANGE'
    | 'UNCLEAR_DEFAULTS_TO_DEEP'
    | 'OTHER_TASK';
}

/** Asking for interpretation: always the main model. */
const ANALYTICAL_PATTERN = /przeanaliz|analiz|podsumuj|oce[nń]|dlaczego|czemu|przyczyn|wnios|por[oó]wn|wzorz|wzorc|trend|zale[zż]n|ryzyk|normaln|interpret|wyja[sś]ni|co z tego wynika|co o tym s[aą]dzisz|why|analy[sz]|pattern|compare|explain|cause/;
/** Asking for a dose, a correction, timing or a settings change: always the main model. */
const THERAPY_PATTERN = /poda[cć]|dawk|przelicznik|wsp[oó][lł]czynnik|\bicr\b|\bisf\b|prebolus|ustawie[nń]|ile (?:jednost|insulin)|(?:zmieni[cć]|zmniejszy[cć]|zwi[eę]kszy[cć]|obni[zż]y[cć]|podnie[sś][cć]|skorygowa[cć]|zrobi[cć]|da[cć])\s[^?.]{0,30}(?:baz|bolus|korekt|cel|target|insulin)|\bdose|carb ratio|sensitivity/;
/** Asking to show or count recorded data: the light model is enough. */
const LOOKUP_PATTERN = /poka[zż]|\bczy (?:by[lł]|by[lł]a|by[lł]o|by[lł]y)\b|\bile\b|\bjak[iae]\b|\bkiedy\b|o kt[oó]rej|wypisz|\blista\b|sprawd[zź]|podaj|\bshow\b|\blist\b|how much|how many|\bwhen\b/;
const SHORT_RANGE_TYPES = new Set(['TODAY', 'SHORT_RANGE']);
/** A lookup that points at recorded data (show/check, past tense, yesterday/today, a clock time, entries, readings). */
const RECORDED_DATA_PATTERN = /poka[zż]|sprawd[zź]|\bby[lł]|wczoraj|dzi[sś]|\bwtedy\b|\d{1,2}[:.]\d{2}|ostatni|wpis|przebieg|odczyt|\bshow\b|\bwas\b|\bwere\b|yesterday|today/;

/**
 * Deterministic choice of the model tier for one AI execution. Analysis is always on the main model: any analytical or
 * causal wording, pre-hypo evidence or a range longer than three days keeps DEEP, and so does anything unclear. Only
 * conversational direct replies and plain data lookups over a short range use the light model.
 */
export function selectModelTier(args: {
  task: Pick<AiTask, 'task_type'>;
  userMessageText: string | null;
  rangeType?: string | null;
  hasPreHypoEvidence?: boolean;
  /** The reply may search the knowledge base: a question answered from guideline sources goes to the main model. */
  knowledgeToolAvailable?: boolean;
  /** The caregiver attached photos (a meal, a label): reading them is left to the main model. */
  hasPhotos?: boolean;
  /** The caregiver asks to change a meal (conversation-meal-actions.v1): picking the meal and the items needs the main model. */
  mealChangeRequested?: boolean;
  /** The caregiver asks for a dose to give with a bolus card (remote-bolus-trio-plan.md W7): left to the main model. */
  doseRequested?: boolean;
}): ModelTierDecision {
  const text = String(args.userMessageText ?? '').trim().toLowerCase();
  if (args.hasPhotos && (args.task.task_type === 'CONVERSATION_DIRECT_RESPONSE' || args.task.task_type === 'CONVERSATION_TIME_RANGE_ANALYSIS')) {
    return { tier: 'DEEP', reason: 'PHOTO_QUESTION' };
  }
  if (args.mealChangeRequested && (args.task.task_type === 'CONVERSATION_DIRECT_RESPONSE' || args.task.task_type === 'CONVERSATION_TIME_RANGE_ANALYSIS')) {
    return { tier: 'DEEP', reason: 'MEAL_CHANGE' };
  }
  if (args.doseRequested && (args.task.task_type === 'CONVERSATION_DIRECT_RESPONSE' || args.task.task_type === 'CONVERSATION_TIME_RANGE_ANALYSIS')) {
    return { tier: 'DEEP', reason: 'DOSE_REQUEST' };
  }
  if (args.task.task_type === 'CONVERSATION_DIRECT_RESPONSE') {
    // The knowledge probe (2026-10-16) measured source-based answers on the main model; thanks and greetings stay light.
    if (args.knowledgeToolAvailable && text && !isSocialMessage(text)) return { tier: 'DEEP', reason: 'KNOWLEDGE_QUESTION' };
    return { tier: 'LIGHT', reason: 'DIRECT_RESPONSE' };
  }
  if (args.task.task_type === 'CONVERSATION_TIME_RANGE_ANALYSIS' && THERAPY_PATTERN.test(text)) {
    return { tier: 'DEEP', reason: 'THERAPY_QUESTION' };
  }
  if (args.task.task_type !== 'CONVERSATION_TIME_RANGE_ANALYSIS') {
    return { tier: 'DEEP', reason: 'OTHER_TASK' };
  }
  if (args.hasPreHypoEvidence) return { tier: 'DEEP', reason: 'PRE_HYPO_EVIDENCE' };
  if (isCausalQuestion(text)) return { tier: 'DEEP', reason: 'CAUSAL_QUESTION' };
  if (ANALYTICAL_PATTERN.test(text)) return { tier: 'DEEP', reason: 'ANALYTICAL_QUESTION' };
  if (args.rangeType && !SHORT_RANGE_TYPES.has(args.rangeType)) return { tier: 'DEEP', reason: 'LONG_RANGE' };
  if (LOOKUP_PATTERN.test(text)) {
    // With the knowledge base, "kiedy ustawić…", "jak Trio traktuje…" are guideline questions, not data lookups (live
    // check 2026-10-16): only a lookup of recorded data stays on the light model.
    if (args.knowledgeToolAvailable && !RECORDED_DATA_PATTERN.test(text)) return { tier: 'DEEP', reason: 'KNOWLEDGE_QUESTION' };
    return { tier: 'LIGHT', reason: 'DATA_LOOKUP' };
  }
  return { tier: 'DEEP', reason: 'UNCLEAR_DEFAULTS_TO_DEEP' };
}
