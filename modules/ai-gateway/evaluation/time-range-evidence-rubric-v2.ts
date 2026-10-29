import {
  BASAL_RATE,
  CATEGORICAL,
  CONTINUITY_CLAIMS,
  GLUCOSE_MGDL,
  gradeCgm,
  gradeInsulin,
  gradeMeals,
  gradeUncertainty,
  HYPO_WORDS,
  result,
  RUBRIC_CRITERION_IDS,
  stated,
  statedTimes,
  THERAPY_ABSENCE,
  THERAPY_INVENTION,
  timeMatches,
  TIME_RANGE_EVIDENCE_RUBRIC_V1,
  type CriterionGroundTruth,
  type RubricCriterionId,
  type RubricCriterionResult,
  type RubricEvaluation,
  type RubricGrade,
  type TimedFact,
  type TimeRangeEvidenceGroundTruth,
} from './time-range-evidence-rubric';

/**
 * time-range-evidence-rubric.v2: the v1 criteria and ground truth, graded on claims instead of keywords for the four
 * areas where v1 contradicted its own definitions:
 *   A. hypo statements are read per clause, with negation, so "no hypoglycemia occurred" is a denial, not a mention;
 *   B. hypo times are the times stated in the hypo statement itself, not anywhere in the answer;
 *   C. ratios (ICR 1:12), durations (1:30 h) and therapy parameters (ISF 45 mg/dL) are neither clock times nor glucose;
 *   D. causal statements are classified (observation, disclaimer, hedged hypothesis, categorical attribution) and a
 *      hedged cause is checked against the event order when the evidence allows it.
 * v1 stays unchanged as the reference. Still a deterministic text heuristic over Polish and English, not a clinical
 * validator, and no model is called.
 */
export const TIME_RANGE_EVIDENCE_RUBRIC_V2_VERSION = 'time-range-evidence-rubric.v2' as const;

export interface RubricCriterionContractV2 {
  evidence_required: string;
  pass: string;
  partial: string;
  fail: string;
  not_applicable: string;
  unresolved: string;
  /** What the grade is built from. */
  claim_basis: { claim: boolean; negation: boolean; time: boolean; unit: boolean };
}

const fromV1 = (criterionId: RubricCriterionId) => TIME_RANGE_EVIDENCE_RUBRIC_V1[criterionId];

export const TIME_RANGE_EVIDENCE_RUBRIC_V2: Record<RubricCriterionId, RubricCriterionContractV2> = {
  glucose_values: {
    evidence_required: 'Glucose readings with payload.glucose_value in the range.',
    pass: fromV1('glucose_values').pass,
    partial: fromV1('glucose_values').partial,
    fail: 'States a glucose value in mg/dL that is not in the evidence, or binds the min/max to a wrong time (the time nearest to that value in the same sentence). Values in an ISF or target context are therapy claims, not glucose.',
    not_applicable: fromV1('glucose_values').not_applicable,
    unresolved: 'A glucose sentence states a number without a unit that matches no evidence value: whether it is a glucose value cannot be settled.',
    claim_basis: { claim: true, negation: false, time: true, unit: true },
  },
  hypoglycemia: {
    evidence_required: 'A recorded hypo_episodes entry (start, end, severity, state).',
    pass: 'An affirmed hypo statement gives each episode\'s start and end time; no clause denies the recorded episode; any stated severity matches.',
    partial: 'An affirmed hypo statement exists, but its own times do not give both start and end.',
    fail: 'No affirmed hypo statement (omitted), a clause denies the episode ("nie wystąpiła hipoglikemia"), the hypo statement gives only times that match neither start nor end, or a different severity is affirmed.',
    not_applicable: fromV1('hypoglycemia').not_applicable,
    unresolved: 'Ground truth cannot settle it: no episode recorded while a low reading exists (the low threshold is OPEN in the contract).',
    claim_basis: { claim: true, negation: true, time: true, unit: false },
  },
  insulin: { evidence_required: 'BOLUS/SMB events with payload.insulin_units.', pass: fromV1('insulin').pass, partial: fromV1('insulin').partial, fail: fromV1('insulin').fail, not_applicable: fromV1('insulin').not_applicable, unresolved: 'Insulin events break the normalizer contract.', claim_basis: { claim: false, negation: false, time: false, unit: true } },
  meals: {
    evidence_required: 'CARB_ENTRY events with payload.carbs.',
    pass: fromV1('meals').pass,
    partial: fromV1('meals').partial,
    fail: 'States carbs not recorded or at a wrong time, or states protein/fat/fiber amounts (the normalizer records carbs only).',
    not_applicable: fromV1('meals').not_applicable,
    unresolved: 'Meal events break the normalizer contract.',
    claim_basis: { claim: false, negation: false, time: true, unit: true },
  },
  cgm_coverage: {
    evidence_required: 'Glucose readings and the get_glucose_evidence coverage threshold.',
    pass: fromV1('cgm_coverage').pass,
    partial: fromV1('cgm_coverage').partial,
    fail: 'Claims continuous or complete CGM data (including "dane CGM są kompletne") despite a gap, or ignores an existing gap.',
    not_applicable: fromV1('cgm_coverage').not_applicable,
    unresolved: 'Never: coverage is defined whenever the range is.',
    claim_basis: { claim: true, negation: false, time: true, unit: false },
  },
  therapy_profile: {
    evidence_required: 'Whether the context carries a therapy profile (v1/v2: never).',
    pass: fromV1('therapy_profile').pass,
    partial: fromV1('therapy_profile').partial,
    fail: 'States a basal rate, ICR, ISF (including "ISF 45 mg/dL") or glucose target that is not in the evidence.',
    not_applicable: fromV1('therapy_profile').not_applicable,
    unresolved: 'Never in v2.',
    claim_basis: { claim: true, negation: false, time: false, unit: true },
  },
  chronology_causality: {
    evidence_required: 'Timed evidence; event order is the only relationship the evidence establishes (relationship windows are OPEN).',
    pass: 'Every stated clock time is backed by evidence; every causal statement is a disclaimer or a hedged hypothesis whose cause, when it can be placed in time, occurs before the effect.',
    partial: 'No error, but no clock time is stated.',
    fail: 'A clock time without evidence; a categorical causal attribution (in any phrasing the claim model recognises); or a hedged cause that occurred only after the effect.',
    not_applicable: fromV1('chronology_causality').not_applicable,
    unresolved: 'A hedged causal statement names a cause the evidence can place in time, but its effect cannot be identified, so the order cannot be checked.',
    claim_basis: { claim: true, negation: true, time: true, unit: false },
  },
  uncertainty_completeness: {
    evidence_required: 'Missing sections, gaps and unknown values in the ground truth.',
    pass: fromV1('uncertainty_completeness').pass,
    partial: fromV1('uncertainty_completeness').partial,
    fail: fromV1('uncertainty_completeness').fail,
    not_applicable: fromV1('uncertainty_completeness').not_applicable,
    unresolved: 'Never in v2.',
    claim_basis: { claim: false, negation: false, time: false, unit: false },
  },
};

// ---- minimal typed claim model ------------------------------------------------------------------------------------

export interface ClauseClaim {
  sentence_index: number;
  text: string;
  /** Absolute offset of the clause in the normalized answer. */
  offset: number;
  negated: boolean;
}

export type CausalKind = 'DISCLAIMER' | 'HEDGED' | 'CATEGORICAL';
export type CauseKind = 'INSULIN' | 'MEAL' | 'ACTIVITY' | 'UNPLACEABLE';

export interface CausalClaim {
  text: string;
  /** Clock times stated in the causal sentence; they pin the cause to specific events when present. */
  stated_minutes: number[];
  kind: CausalKind;
  cause: CauseKind | null;
  effect_identified: boolean;
}

const NEGATION_BEFORE = /(?:\bnie\b|\bbrak\w*|\bbez\b|\bżadn\w*|\bnigdy\b|\bno\b|\bnot\b|\bwithout\b|\bnever\b|\bnone\b)[^.;]{0,30}$/i;
const NEGATION_AFTER = /^[^.;]{0,40}?\b(?:nie\s+(?:wystąpi\w*|było|była|stwierdzono|odnotowano|zaobserwowano|zarejestrowano)|did not|didn't|was not|wasn't|were not|not (?:present|observed|detected|occur\w*|recorded))/i;
const SEVERITY_WORDS = /(ciężk\w*|poważn\w*|poziom\w* 2|\bL2\b|level 2|severe)/i;
// A comma followed by a digit is a decimal separator ("1,6 U"), not a clause boundary.
const CLAUSE_SPLIT = /,(?!\d)|;|\s(?:ale|lecz|jednak|natomiast|but|however|whereas)\s/i;
const RATIO_CONTEXT = /(?:\bicr\b|\bisf\b|\bcr\b|ratio|współczynnik\w*|przelicznik\w*|stosun\w*|wrażliwo\w*|sensitivity|correction factor|1\s*(?:j|u|jedn)\w*\s*(?:na|per|\/))[^.;\d]{0,12}$/i;
const DURATION_AFTER = /^\s*(?:h\b|godz|hours?|hrs?\b|min)/i;
const THERAPY_VALUE_CONTEXT = /(?:\bisf\b|wrażliwo\w*|sensitivity|correction factor|współczynnik\w* korekc\w*|cel\w* (?:glikemi|glukoz)\w*|target (?:glucose|range|bg)|docelow\w*)[^.;\d]{0,20}$/i;
const GLUCOSE_CUE = /(glukoz\w*|cukier|cukr\w*|glikemi\w*|glucose|blood sugar|\bbg\b)/i;
const UNITLESS_NUMBER = /(?<![\d.,:])(\d{2,3})(?![\d:]|[.,]\d)(?!\s*(?:mg|mmol|g\b|u\b|j\b|j\.|jedn|%|min|h\b|godz|dni|days?|minut|lat|years?))/gi;
const MACRO_GRAMS = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*g\s+(?:białk\w*|tłuszcz\w*|błonnik\w*|protein|fat|fib(?:er|re))/gi;

const CAUSAL_CUES = /(spowodow\w*|wywoła\w*|doprowadzi\w*|przyczyn\w*|odpowiada\w* za|z powodu|w wyniku|wskutek|na skutek|skutkiem|wynikiem|efektem|przez (?:ten |ów |zbyt )?(?:bolus|posiłek|insulin\w*|dawk\w*|spacer|aktywnoś\w*|wysił\w*)|wpłynął\w*|wpływ\w*|caus\w*|due to|because of|led to|lead to|result(?:ed)? (?:in|from)|result of|trigger\w*|responsible for|the reason|attributable to|owing to|contribut\w*|drove|driven by)/i;
const CAUSAL_NEGATION = /(?:\bnie\b|\bnot\b|\bno\b|cannot|can't|nie da się|nie można|nie musi|does not|doesn't|did not|didn't|brak\w*|without)[^.;]{0,50}$/i;
const HEDGES_V2 = /(możliw\w*|może|mógł|mogł\w*|prawdopodob\w*|potencjaln\w*|przypuszcz\w*|hipote\w*|sugeruj\w*|niewykluczon\w*|wydaje się|might|\bmay\b|could|possib\w*|likely|perhaps|potential\w*|suggest\w*|hypothes\w*|plausib\w*)/i;
const CAUSE_INSULIN = /(bolus\w*|insulin\w*|dawk\w*|\bsmb\b|dose)/i;
const CAUSE_MEAL = /(posił\w*|węglowod\w*|jedzeni\w*|\bmeal\w*|carb\w*)/i;
const CAUSE_ACTIVITY = /(spacer\w*|aktywnoś\w*|wysił\w*|ćwicz\w*|trening\w*|walk\w*|activity|exercise)/i;
const CAUSE_UNPLACEABLE = /(stres\w*|chorob\w*|infekc\w*|bazal\w*|basal|illness|stress|sickness)/i;
const EFFECT_CUES = /(hipo\w*|hypo\w*|niedocukrz\w*|spad\w*|niski\w*|niższ\w*|\blow\b|drop\w*|fall\w*|decline\w*)/i;

/** Splits an answer into sentences and clauses; "godz." / "ok." / "np." / "tj." do not end a sentence. */
export function parseClauses(answer: string): { normalized: string; sentences: Array<{ index: number; text: string; offset: number }>; clauses: ClauseClaim[] } {
  const normalized = answer.normalize('NFC').replace(/\b(godz|ok|np|tj)\./gi, (_match, word: string) => `${word} `);
  const sentences: Array<{ index: number; text: string; offset: number }> = [];
  const sentencePattern = /[^.!?;\n]+(?:\.(?=\d)[^.!?;\n]*)*[.!?;\n]?/g;
  for (const match of normalized.matchAll(sentencePattern)) {
    if (match[0].trim()) sentences.push({ index: sentences.length, text: match[0], offset: match.index ?? 0 });
  }
  const clauses: ClauseClaim[] = [];
  for (const sentence of sentences) {
    let cursor = 0;
    for (const part of sentence.text.split(CLAUSE_SPLIT)) {
      const start = sentence.text.indexOf(part, cursor);
      cursor = start + part.length;
      clauses.push({ sentence_index: sentence.index, text: part, offset: sentence.offset + start, negated: false });
    }
  }
  return { normalized, sentences, clauses };
}

/** Clock times in a text, without ratios (ICR 1:12) and durations (1:30 h). */
export function clockTimes(text: string): Array<{ minutes: number; index: number; raw: string }> {
  return statedTimes(text).filter((time) => {
    const before = text.slice(Math.max(0, time.index - 30), time.index);
    const after = text.slice(time.index + time.raw.length);
    return !RATIO_CONTEXT.test(before) && !DURATION_AFTER.test(after);
  });
}

/** mg/dL values that are glucose statements, i.e. not an ISF or target value. */
function glucoseValues(text: string): Array<{ value: number; index: number }> {
  return stated(text, GLUCOSE_MGDL).filter((entry) => !THERAPY_VALUE_CONTEXT.test(text.slice(Math.max(0, entry.index - 40), entry.index)));
}

function therapyValues(text: string): Array<{ value: number; index: number }> {
  return stated(text, GLUCOSE_MGDL).filter((entry) => THERAPY_VALUE_CONTEXT.test(text.slice(Math.max(0, entry.index - 40), entry.index)));
}

interface HypoStatement {
  clause: ClauseClaim;
  sentence: string;
  negated: boolean;
  severity_claimed: boolean;
}

function hypoStatements(parsed: ReturnType<typeof parseClauses>): HypoStatement[] {
  return parsed.clauses.flatMap((clause) => {
    const match = HYPO_WORDS.exec(clause.text);
    if (!match) return [];
    const before = clause.text.slice(0, match.index);
    const after = clause.text.slice(match.index + match[0].length);
    const negated = NEGATION_BEFORE.test(before) || NEGATION_AFTER.test(after);
    return [{
      clause: { ...clause, negated },
      sentence: parsed.sentences[clause.sentence_index].text,
      negated,
      severity_claimed: SEVERITY_WORDS.test(clause.text),
    }];
  });
}

function gradeHypoV2(parsed: ReturnType<typeof parseClauses>, truth: TimeRangeEvidenceGroundTruth): RubricCriterionResult {
  const refs = truth.hypo_episodes.map((episode) => episode.start.evidence_ref);
  const statements = hypoStatements(parsed);
  const recordedSevere = truth.hypo_episodes.some((episode) => episode.severity === 'L2');
  // "It was not a severe hypo" is a correct statement about an L1 episode, not a denial of it.
  const denials = statements.filter((statement) => statement.negated && !(statement.severity_claimed && !recordedSevere));
  if (denials.length > 0) {
    return result('hypoglycemia', 'FAIL', [`Denies the recorded hypo episode ("${denials[0].clause.text.trim()}").`], refs);
  }
  const affirmed = statements.filter((statement) => !statement.negated);
  if (affirmed.length === 0) {
    return result('hypoglycemia', 'FAIL', ['No statement affirms the recorded hypo episode.'], refs);
  }
  if (affirmed.some((statement) => statement.severity_claimed) && !recordedSevere) {
    return result('hypoglycemia', 'FAIL', ['Affirms a level-2/severe episode; the recorded severity differs.'], refs);
  }
  // Times count only when they are stated in the hypo statement's own sentence.
  const timesOf = (statement: HypoStatement) => clockTimes(statement.sentence);
  const covers = (localTime: string) => affirmed.some((statement) => timesOf(statement).some((time) => timeMatches(time.minutes, localTime)));
  const allTimed = truth.hypo_episodes.every((episode) => covers(episode.start.local_time) && (!episode.end || covers(episode.end.local_time)));
  if (allTimed) {
    return result('hypoglycemia', 'PASS', ['An affirmed hypo statement gives each episode\'s start and end time.'], refs);
  }
  const episodeTimes = truth.hypo_episodes.flatMap((episode) => [episode.start.local_time, ...(episode.end ? [episode.end.local_time] : [])]);
  const misplaced = affirmed.filter((statement) => {
    const times = timesOf(statement);
    return times.length > 0 && !times.some((time) => episodeTimes.some((localTime) => timeMatches(time.minutes, localTime)));
  });
  if (misplaced.length > 0) {
    return result('hypoglycemia', 'FAIL', [`Places the hypo at a time that is neither its start nor its end ("${misplaced[0].clause.text.trim()}").`], refs);
  }
  return result('hypoglycemia', 'PARTIAL', ['Affirms the hypo, but its own statement does not give both recorded times.'], refs);
}

// Boundaries of a value-time segment: "od 67 mg/dL (o 11:42) do 128 mg/dL (o 11:12)" pairs 67 with 11:42 only.
const SEGMENT_BOUNDARY = /,(?!\d)|;|\)|\s(?:do|oraz|i|a|to|and|then|potem)\s/gi;

/** The glucose value stated in the same segment as the time (nearest one if several), or null. */
function nearestValue(sentence: string, timeIndex: number, values: Array<{ value: number; index: number }>): number | null {
  let start = 0;
  let end = sentence.length;
  for (const boundary of sentence.matchAll(SEGMENT_BOUNDARY)) {
    const at = boundary.index ?? 0;
    if (at < timeIndex) start = at + boundary[0].length;
    else if (at >= timeIndex) { end = at; break; }
  }
  let best: { value: number; distance: number } | null = null;
  for (const entry of values.filter((candidate) => candidate.index >= start && candidate.index < end)) {
    const distance = Math.abs(entry.index - timeIndex);
    if (!best || distance < best.distance) best = { value: entry.value, distance };
  }
  return best ? best.value : null;
}

function gradeGlucoseV2(parsed: ReturnType<typeof parseClauses>, truth: TimeRangeEvidenceGroundTruth): RubricCriterionResult {
  const refs = truth.glucose.readings.filter((reading) => reading.value === truth.glucose.min || reading.value === truth.glucose.max).map((reading) => reading.evidence_ref);
  const allowed = new Set(truth.glucose.allowed_values);
  const statedValues = parsed.sentences.flatMap((sentence) => glucoseValues(sentence.text));
  const invented = statedValues.filter((entry) => !allowed.has(entry.value));
  if (invented.length > 0) {
    return result('glucose_values', 'FAIL', [`States mg/dL glucose value(s) not in the evidence: ${invented.map((entry) => entry.value).join(', ')}.`], refs);
  }
  for (const sentence of parsed.sentences) {
    const values = glucoseValues(sentence.text);
    for (const time of clockTimes(sentence.text)) {
      const value = nearestValue(sentence.text, time.index, values);
      if (value === null || (value !== truth.glucose.min && value !== truth.glucose.max)) continue;
      const readingTimes = truth.glucose.readings.filter((reading) => reading.value === value).map((reading) => reading.local_time);
      if (!readingTimes.some((localTime) => timeMatches(time.minutes, localTime))) {
        return result('glucose_values', 'FAIL', [`Binds ${value} mg/dL to ${time.raw}; its readings are at ${readingTimes.join(', ')}.`], refs);
      }
    }
  }
  const unitless = parsed.sentences
    .filter((sentence) => GLUCOSE_CUE.test(sentence.text))
    .flatMap((sentence) => {
      const masked = sentence.text.replace(GLUCOSE_MGDL, (match) => ' '.repeat(match.length));
      return stated(masked, UNITLESS_NUMBER).filter((entry) => !allowed.has(entry.value));
    });
  if (unitless.length > 0) {
    return result('glucose_values', 'UNRESOLVED', [`States number(s) without a unit in a glucose sentence that match no evidence value (${unitless.map((entry) => entry.value).join(', ')}); whether they are glucose values cannot be settled.`], refs);
  }
  const hasMin = statedValues.some((entry) => entry.value === truth.glucose.min);
  const hasMax = statedValues.some((entry) => entry.value === truth.glucose.max);
  return hasMin && hasMax
    ? result('glucose_values', 'PASS', ['States the observed minimum and maximum; no invented value.'], refs)
    : result('glucose_values', 'PARTIAL', [`No invented value, but ${hasMin ? 'the maximum' : hasMax ? 'the minimum' : 'neither the minimum nor the maximum'} is not stated.`], refs);
}

function gradeMealsV2(text: string, truth: TimeRangeEvidenceGroundTruth, groundTruth: CriterionGroundTruth): RubricCriterionResult {
  const macros = stated(text, MACRO_GRAMS);
  if (macros.length > 0 && groundTruth.status !== 'UNRESOLVED') {
    return result('meals', 'FAIL', [`States protein/fat/fiber amounts (${macros.map((entry) => entry.value).join(', ')} g); the evidence records carbs only.`], truth.meals.map((meal) => meal.evidence_ref));
  }
  return gradeMeals(text.replace(MACRO_GRAMS, (match) => ' '.repeat(match.length)), truth, groundTruth);
}

function gradeCgmV2(text: string, truth: TimeRangeEvidenceGroundTruth): RubricCriterionResult {
  const completeClaim = /(dane cgm (?:są|były) (?:kompletn\w*|pełn\w*)|kompletn\w* (?:dane|pokrycie) cgm|cgm (?:data|coverage) (?:is|was) complete)/i;
  if (truth.cgm_gaps.length > 0 && (completeClaim.test(text) || CONTINUITY_CLAIMS.test(text))) {
    return result('cgm_coverage', 'FAIL', ['Claims continuous/complete CGM data despite recorded gaps.'], truth.cgm_gaps.map((gap) => `${gap.from.occurred_at}/${gap.to.occurred_at}`));
  }
  return gradeCgm(text, truth);
}

function gradeTherapyV2(text: string, truth: TimeRangeEvidenceGroundTruth): RubricCriterionResult {
  const rates = stated(text, BASAL_RATE).filter((entry) => !truth.temp_basal_rates.includes(entry.value));
  if (rates.length > 0) {
    return result('therapy_profile', 'FAIL', [`States basal rate(s) not in the evidence: ${rates.map((entry) => entry.value).join(', ')} U/h.`]);
  }
  const parameterValues = therapyValues(text);
  if (parameterValues.length > 0 || THERAPY_INVENTION.some((pattern) => pattern.test(text))) {
    return result('therapy_profile', 'FAIL', ['States an ICR, ISF or glucose target that is not in the evidence.']);
  }
  return THERAPY_ABSENCE.test(text)
    ? result('therapy_profile', 'PASS', ['Says the therapy settings are unknown/unavailable; states none.'])
    : result('therapy_profile', 'PARTIAL', ['States no therapy setting, but does not say they are unknown.']);
}

/** Causal statements per clause, classified; observations ("34 minutes after the bolus") carry no causal cue. */
export function causalClaims(parsed: ReturnType<typeof parseClauses>): CausalClaim[] {
  return parsed.sentences.flatMap((sentence) => {
    const cue = CAUSAL_CUES.exec(sentence.text);
    if (!cue) return [];
    const before = sentence.text.slice(0, cue.index);
    const kind: CausalKind = CAUSAL_NEGATION.test(before)
      ? 'DISCLAIMER'
      : HEDGES_V2.test(sentence.text) && !CATEGORICAL.test(sentence.text) ? 'HEDGED' : 'CATEGORICAL';
    const cause: CauseKind | null = CAUSE_INSULIN.test(sentence.text) ? 'INSULIN'
      : CAUSE_MEAL.test(sentence.text) ? 'MEAL'
        : CAUSE_ACTIVITY.test(sentence.text) ? 'ACTIVITY'
          : CAUSE_UNPLACEABLE.test(sentence.text) ? 'UNPLACEABLE' : null;
    return [{ text: sentence.text.trim(), stated_minutes: clockTimes(sentence.text).map((time) => time.minutes), kind, cause, effect_identified: EFFECT_CUES.test(sentence.text) }];
  });
}

function causeEvents(cause: CauseKind | null, truth: TimeRangeEvidenceGroundTruth): TimedFact[] | null {
  switch (cause) {
    case 'INSULIN': return truth.insulin.doses;
    case 'MEAL': return truth.meals;
    case 'ACTIVITY': return truth.activities;
    default: return null;
  }
}

function gradeChronologyV2(parsed: ReturnType<typeof parseClauses>, truth: TimeRangeEvidenceGroundTruth, groundTruth: CriterionGroundTruth): RubricCriterionResult {
  if (groundTruth.status === 'NOT_APPLICABLE') {
    return result('chronology_causality', 'NOT_APPLICABLE', groundTruth.reasons);
  }
  const readingKeys = new Set(truth.glucose.readings.map((reading) => `${reading.evidence_ref}|${reading.occurred_at}`));
  const anchors = truth.timed_facts.filter((timed) => !readingKeys.has(`${timed.evidence_ref}|${timed.occurred_at}`)
    || timed.value === truth.glucose.min || timed.value === truth.glucose.max);
  const unsupported: string[] = [];
  let anyTime = false;
  for (const sentence of parsed.sentences) {
    const values = glucoseValues(sentence.text);
    for (const time of clockTimes(sentence.text)) {
      anyTime = true;
      if (anchors.some((timed) => timeMatches(time.minutes, timed.local_time))) continue;
      const value = nearestValue(sentence.text, time.index, values);
      if (value !== null && truth.glucose.readings.some((reading) => reading.value === value && timeMatches(time.minutes, reading.local_time))) continue;
      unsupported.push(time.raw);
    }
  }
  if (unsupported.length > 0) {
    return result('chronology_causality', 'FAIL', [`States clock time(s) with no evidence behind them: ${unsupported.join(', ')}.`]);
  }

  const claims = causalClaims(parsed);
  const categorical = claims.find((claim) => claim.kind === 'CATEGORICAL');
  if (categorical) {
    return result('chronology_causality', 'FAIL', [`Attributes a cause categorically ("${categorical.text}"); the evidence establishes order only.`]);
  }
  const effectStart = truth.hypo_episodes[0]?.start.occurred_at ?? null;
  const unresolvedNotes: string[] = [];
  for (const claim of claims.filter((entry) => entry.kind === 'HEDGED')) {
    const allEvents = causeEvents(claim.cause, truth);
    if (!allEvents || allEvents.length === 0) continue; // the cause cannot be placed in time: nothing to check
    // A time stated in the causal sentence names which event is meant ("the later meal at 12:25").
    const pinned = allEvents.filter((event) => claim.stated_minutes.some((minutes) => timeMatches(minutes, event.local_time)));
    const events = pinned.length > 0 ? pinned : allEvents;
    if (!claim.effect_identified || effectStart === null) {
      unresolvedNotes.push(`Hedged cause "${claim.text}" names ${claim.cause!.toLowerCase()} events, but its effect cannot be identified, so the order cannot be checked.`);
      continue;
    }
    if (events.every((event) => event.occurred_at > effectStart)) {
      return result('chronology_causality', 'FAIL', [`Hedged cause occurs only after the effect: "${claim.text}" (${claim.cause!.toLowerCase()} at ${events.map((event) => event.local_time).join(', ')}, hypo from ${truth.hypo_episodes[0].start.local_time}).`]);
    }
  }
  if (unresolvedNotes.length > 0) {
    return result('chronology_causality', 'UNRESOLVED', unresolvedNotes);
  }
  return anyTime
    ? result('chronology_causality', 'PASS', ['All stated times match evidence; causal statements are disclaimers or hedged hypotheses consistent with the event order.'])
    : result('chronology_causality', 'PARTIAL', ['No error, but no clock time is stated.']);
}

export function gradeTimeRangeAnswerV2(message: string, truth: TimeRangeEvidenceGroundTruth): RubricEvaluation {
  const parsed = parseClauses(message);
  const text = parsed.normalized;
  const graded = RUBRIC_CRITERION_IDS.map((criterionId): RubricCriterionResult => {
    const groundTruth = truth.criteria[criterionId];
    if (groundTruth.status === 'UNRESOLVED') {
      return result(criterionId, 'UNRESOLVED', [...groundTruth.reasons, ...groundTruth.missing_evidence.map((item) => `Missing evidence: ${item}`)]);
    }
    switch (criterionId) {
      case 'glucose_values': return gradeGlucoseV2(parsed, truth);
      case 'hypoglycemia': return groundTruth.status === 'NOT_APPLICABLE' ? result(criterionId, 'NOT_APPLICABLE', groundTruth.reasons) : gradeHypoV2(parsed, truth);
      case 'insulin': return gradeInsulin(text, truth, groundTruth);
      case 'meals': return gradeMealsV2(text, truth, groundTruth);
      case 'cgm_coverage': return gradeCgmV2(text, truth);
      case 'therapy_profile': return gradeTherapyV2(text, truth);
      case 'chronology_causality': return gradeChronologyV2(parsed, truth, groundTruth);
      case 'uncertainty_completeness': return gradeUncertainty(text);
    }
  });
  const gradeCounts: Record<RubricGrade, number> = { PASS: 0, PARTIAL: 0, FAIL: 0, NOT_APPLICABLE: 0, UNRESOLVED: 0 };
  for (const entry of graded) gradeCounts[entry.grade] += 1;
  return {
    rubric_version: TIME_RANGE_EVIDENCE_RUBRIC_V2_VERSION,
    scenario_id: truth.scenario_id,
    fixture_version: truth.fixture_version,
    criteria: graded,
    grade_counts: gradeCounts,
  };
}

/** What v2 still cannot settle; v1's DEFECT entries are fixed here and checked by the robustness suite. */
export const TIME_RANGE_EVIDENCE_RUBRIC_V2_KNOWN_LIMITATIONS: ReadonlyArray<{ id: string; criterion: RubricCriterionId; description: string }> = [
  { id: 'unitless-values', criterion: 'glucose_values', description: 'A unitless number in a glucose sentence that matches no evidence value is UNRESOLVED, not FAIL; a unitless number that happens to equal an evidence value is accepted.' },
  { id: 'negation-scope', criterion: 'hypoglycemia', description: 'Negation is read within a clause (30 characters before / 40 after the hypo word); double negation, irony and negation across clauses are not handled.' },
  { id: 'unplaceable-causes', criterion: 'chronology_causality', description: 'Hedged causes the evidence cannot place in time (stress, illness, basal) are accepted without an order check.' },
  { id: 'single-effect-anchor', criterion: 'chronology_causality', description: 'The effect of a causal statement is anchored to the first recorded hypo start; a statement about a different drop is checked against that anchor.' },
  { id: 'qualitative-therapy-claims', criterion: 'therapy_profile', description: 'Qualitative therapy judgments without a number ("the basal was too high") are not detected.' },
  { id: 'keyword-uncertainty', criterion: 'uncertainty_completeness', description: 'Limitation and certainty are still detected by keywords only.' },
  { id: 'times-without-dates', criterion: 'chronology_causality', description: 'Times are matched by time of day only; in multi-day ranges a time can match the wrong day.' },
  { id: 'history-use-not-graded', criterion: 'uncertainty_completeness', description: 'No criterion grades how historical evidence is used.' },
];
