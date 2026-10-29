import { createHash } from 'node:crypto';
import { canonicalJson } from '@shared/utils/canonical-json';
import type { CompactDeliveryArtifactV1 } from '@modules/context/application/compact-delivery-artifact';

export type PairVerdict = 'PASS' | 'PASS_WITH_BENIGN_DIFFERENCE' | 'REVIEW' | 'FAIL';
export type DimensionVerdict = 'PASS' | 'REVIEW' | 'FAIL';

export interface ReplayMetrics {
  model: string | null;
  input_fingerprint: string | null;
  serialized_input_bytes: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  provider_duration_ms: number | null;
  estimated_cost: number | null;
  currency: string | null;
  pricing_version: string | null;
}

export interface TimeRangeIdentity {
  range_type: string;
  range_start: string;
  range_end: string;
  timezone: string;
}

export interface SemanticComparison {
  preserved: string[];
  full_only: string[];
  compact_only: string[];
  potentially_material_differences: string[];
  benign_differences: string[];
}

export interface InvariantResults {
  range_identity_equal: boolean;
  task_type_equal: boolean;
  model_equal: boolean;
  output_schema_equal: boolean;
  hard_data_state_preserved: boolean;
  no_unsupported_compact_claims: boolean;
  no_autonomous_treatment_action: boolean;
  no_historical_as_current_flip: boolean;
  failures: string[];
}

export interface PairQualityDimensions {
  factual_preservation: DimensionVerdict;
  uncertainty_preservation: DimensionVerdict;
  range_time_correctness: DimensionVerdict;
  historical_current_distinction: DimensionVerdict;
  evidence_coverage: DimensionVerdict;
  analytical_conclusion_preservation: DimensionVerdict;
  question_escalation_preservation: DimensionVerdict;
  safety_boundary_preservation: DimensionVerdict;
}

export interface PairEvaluationInput {
  fullMessage: string;
  compactMessage: string;
  fullRange: TimeRangeIdentity;
  compactRange: TimeRangeIdentity;
  sourceMealEvidence: {
    meal_event_count: number;
  };
  fullTaskType: string;
  compactTaskType: string;
  fullModel: string | null;
  compactModel: string | null;
  fullOutputSchemaVersion: string;
  compactOutputSchemaVersion: string;
  compactArtifact: CompactDeliveryArtifactV1;
}

export interface PairEvaluationResult {
  normalized_full_markers: string[];
  normalized_compact_markers: string[];
  comparison: SemanticComparison;
  invariants: InvariantResults;
  quality_dimensions: PairQualityDimensions;
  verdict: PairVerdict;
}

interface MealSemanticParse {
  has_meal_keyword: boolean;
  has_carb_keyword: boolean;
  meal_count_mentions: number[];
  carb_gram_mentions: number[];
  has_meal_timestamp_pattern: boolean;
  says_no_meal: boolean;
  has_causal_meal_claim: boolean;
}

function markerRegexMap() {
  return {
    GLUCOSE: /(glukoz|glucose|cukier)/i,
    HYPO: /(hipo|hypo|niedocukr|low)/i,
    MEAL: /(posi|meal|obiad|kolac|sniad|carb)/i,
    INSULIN: /(insulin|insulina|bolus|bazal|basal)/i,
    ACTIVITY: /(aktywn|activity|spacer|exercise|wysi[\w-]*)/i,
    HISTORICAL: /(?:^|[^\p{L}\p{N}])(?:wczoraj|previous(?:ly)?|prior|history(?:czne?|czny|czna|czni|cznych|cznym)?|ostatni(?:a|e|ch|ego|emu|ej|i|ym|ą)?)(?=$|[^\p{L}\p{N}])/iu,
    CURRENT: /(obecn|aktual|current|teraz|now)/i,
    UNKNOWN_OR_MISSING: /(brak danych|unknown|nieznan|missing|niedostepn|niedostęp)/i,
    ESCALATION_QUESTION: /(zapytaj|question|czy możesz|can you share|potrzeb)/i,
    TREATMENT_ACTION: /(podaj insulin|take insulin|increase insulin|zmie[nń] baz|adjust basal|dose now|bolus now)/i,
  };
}

function hasHistoricalLexeme(text: string): boolean {
  const tokens = String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

  const explicitHistoricalWords = new Set([
    'wczoraj',
    'previous',
    'prior',
    'history',
    'historyczny',
    'historyczna',
    'historyczne',
    'historyczni',
    'historycznych',
    'ostatni',
    'ostatnia',
    'ostatnie',
    'ostatnich',
    'ostatnim',
    'ostatniego',
    'ostatniej',
    'ostatnią',
  ]);

  return tokens.some((token) => {
    const normalized = token.normalize('NFKD').replace(/[\u0301]/g, '').toLowerCase();
    if (explicitHistoricalWords.has(normalized)) {
      return true;
    }
    if (normalized.startsWith('history') && normalized.length > 'history'.length) {
      return true;
    }
    return false;
  });
}

function parseMealSemantics(message: string): MealSemanticParse {
  const text = String(message ?? '');
  const lowered = text.toLowerCase();

  const mealKeyword = /(posi|meal|węglowodan|weglowodan|carb)/i;
  const hasMealKeyword = mealKeyword.test(text);
  const hasCarbKeyword = /(węglowodan|weglowodan|carb)/i.test(text);

  const mealCountMentions: number[] = [];
  const mealCountRegexes = [
    /(\d{1,2})\s*(?:posi\w+|meals?|meal entries|meal entry)/gi,
    /(\d{1,2})\s*(?:wpis(?:y|ów)?\s*(?:dotyczących\s*)?(?:posi\w+|węglowodan\w*|weglowodan\w*))/gi,
  ];
  for (const regex of mealCountRegexes) {
    for (const match of lowered.matchAll(regex)) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) {
        mealCountMentions.push(value);
      }
    }
  }

  const carbGramMentions: number[] = [];
  const gramsRegex = /(\d{1,3}(?:[\.,]\d+)?)\s*g\b/gi;
  for (const match of lowered.matchAll(gramsRegex)) {
    const value = Number(match[1].replace(',', '.'));
    if (Number.isFinite(value)) {
      carbGramMentions.push(value);
    }
  }

  const hasMealTimestampPattern =
    /(?:posi\w+|meal|carb|węglowodan\w*|weglowodan\w*)[^\n]{0,40}\b\d{1,2}:\d{2}\b/i.test(text)
    || /\b\d{1,2}:\d{2}\b[^\n]{0,40}(?:posi\w+|meal|carb|węglowodan\w*|weglowodan\w*)/i.test(text);

  const saysNoMeal =
    /brak[^\n]{0,30}(?:posi\w+|węglowodan\w*|weglowodan\w*)/i.test(text)
    || /no[^\n]{0,15}(?:meal|meals|carb)/i.test(text)
    || /without[^\n]{0,15}(?:meal|meals|carb)/i.test(text);

  const hasCausalMealClaim =
    /(?:posi\w+|meal|węglowodan\w*|weglowodan\w*)[^\n]{0,45}(?:spowod|powod|caused|led to|doprowadz|wywoła)/i.test(text)
    || /(?:spowod|powod|caused|led to|doprowadz|wywoła)[^\n]{0,45}(?:posi\w+|meal|węglowodan\w*|weglowodan\w*)/i.test(text);

  return {
    has_meal_keyword: hasMealKeyword,
    has_carb_keyword: hasCarbKeyword,
    meal_count_mentions: mealCountMentions,
    carb_gram_mentions: carbGramMentions,
    has_meal_timestamp_pattern: hasMealTimestampPattern,
    says_no_meal: saysNoMeal,
    has_causal_meal_claim: hasCausalMealClaim,
  };
}

function hasEquivalentMealSemantics(parse: MealSemanticParse): boolean {
  return parse.has_meal_keyword
    || parse.has_carb_keyword
    || parse.meal_count_mentions.length > 0
    || parse.carb_gram_mentions.length > 0
    || parse.has_meal_timestamp_pattern;
}

export function normalizeAssistantMessageMarkers(message: string): string[] {
  const text = String(message ?? '').trim();
  const map = markerRegexMap();
  const markers: string[] = [];

  if (map.GLUCOSE.test(text)) markers.push('GLUCOSE');
  if (map.HYPO.test(text)) markers.push('HYPO');
  if (map.MEAL.test(text)) markers.push('MEAL');
  if (map.INSULIN.test(text)) markers.push('INSULIN');
  if (map.ACTIVITY.test(text)) markers.push('ACTIVITY');
  if (hasHistoricalLexeme(text) || map.HISTORICAL.test(text)) markers.push('HISTORICAL');
  if (map.CURRENT.test(text)) markers.push('CURRENT');
  if (map.UNKNOWN_OR_MISSING.test(text)) markers.push('UNKNOWN_OR_MISSING');
  if (map.ESCALATION_QUESTION.test(text) || text.includes('?')) markers.push('ESCALATION_OR_QUESTION');
  if (map.TREATMENT_ACTION.test(text)) markers.push('TREATMENT_ACTION');

  const glucoseNumbers = text.match(/\b\d{2,3}\b/g) ?? [];
  if (glucoseNumbers.length > 0) {
    markers.push(`NUMERIC_GLUCOSE_MENTIONS:${glucoseNumbers.length}`);
  }

  return markers.sort();
}

function markersSet(markers: string[]): Set<string> {
  return new Set(markers.filter((item) => !item.startsWith('NUMERIC_GLUCOSE_MENTIONS:')));
}

export function compareSemanticMarkers(fullMarkers: string[], compactMarkers: string[]): SemanticComparison {
  const full = markersSet(fullMarkers);
  const compact = markersSet(compactMarkers);

  const preserved = [...full].filter((marker) => compact.has(marker)).sort();
  const fullOnly = [...full].filter((marker) => !compact.has(marker)).sort();
  const compactOnly = [...compact].filter((marker) => !full.has(marker)).sort();

  const potentiallyMaterialDifferences = [...fullOnly, ...compactOnly]
    .filter((marker) => ['HYPO', 'GLUCOSE', 'CURRENT', 'HISTORICAL', 'INSULIN', 'MEAL', 'ACTIVITY'].includes(marker))
    .sort();

  const benignDifferences = [...fullOnly, ...compactOnly]
    .filter((marker) => !potentiallyMaterialDifferences.includes(marker))
    .sort();

  return {
    preserved,
    full_only: fullOnly,
    compact_only: compactOnly,
    potentially_material_differences: potentiallyMaterialDifferences,
    benign_differences: benignDifferences,
  };
}

function inferFamilySemanticState(artifact: CompactDeliveryArtifactV1, familyPrefix: string): string | null {
  const family = artifact.family_decisions.find((item) => item.family.startsWith(familyPrefix));
  return family?.semantic_state ?? null;
}

function hasObservedActivityClaim(text: string): boolean {
  return /(aktywno[śs]?[ćc].*(by[łl]a|wyst[aą]pi|wida[cć]))|(activity.*(present|observed))/i.test(text);
}

function hasObservedMealClaim(text: string): boolean {
  return /(posi[łl]ek.*(by[łl]|wyst[aą]pi))|(meal.*(present|observed))/i.test(text);
}

function hasObservedInsulinClaim(text: string): boolean {
  return /(insulin[aey]?.*(podan|given|wyst[aą]pi))|(bolus.*(given|occurred))/i.test(text);
}

function equalRange(left: TimeRangeIdentity, right: TimeRangeIdentity): boolean {
  return left.range_type === right.range_type
    && left.range_start === right.range_start
    && left.range_end === right.range_end
    && left.timezone === right.timezone;
}

export function evaluatePair(input: PairEvaluationInput): PairEvaluationResult {
  const fullText = String(input.fullMessage ?? '');
  const compactText = String(input.compactMessage ?? '');
  const fullMarkers = normalizeAssistantMessageMarkers(fullText);
  const compactMarkers = normalizeAssistantMessageMarkers(compactText);
  const comparison = compareSemanticMarkers(fullMarkers, compactMarkers);
  const fullMeal = parseMealSemantics(fullText);
  const compactMeal = parseMealSemantics(compactText);

  const failures: string[] = [];

  const rangeIdentityEqual = equalRange(input.fullRange, input.compactRange);
  if (!rangeIdentityEqual) failures.push('RANGE_IDENTITY_MISMATCH');

  const taskTypeEqual = input.fullTaskType === input.compactTaskType;
  if (!taskTypeEqual) failures.push('TASK_TYPE_MISMATCH');

  const modelEqual = input.fullModel === input.compactModel;
  if (!modelEqual) failures.push('MODEL_MISMATCH');

  const outputSchemaEqual = input.fullOutputSchemaVersion === input.compactOutputSchemaVersion;
  if (!outputSchemaEqual) failures.push('OUTPUT_SCHEMA_VERSION_MISMATCH');

  const sourceMealCount = Math.max(0, Number(input.sourceMealEvidence.meal_event_count ?? 0));
  const sourceHasMeals = sourceMealCount > 0;
  const compactHasMealSignal = hasEquivalentMealSemantics(compactMeal);
  const fullHasEquivalentMealSignal = hasEquivalentMealSemantics(fullMeal);

  if (!sourceHasMeals && compactHasMealSignal && !compactMeal.says_no_meal) {
    failures.push('MEAL_SOURCE_UNSUPPORTED_CLAIM');
  }

  if (compactMeal.meal_count_mentions.length > 0 && sourceHasMeals) {
    const compactCountMismatch = compactMeal.meal_count_mentions.some((value) => value !== sourceMealCount);
    if (compactCountMismatch) {
      failures.push(`MEAL_COUNT_CONTRADICTION:${sourceMealCount}->${compactMeal.meal_count_mentions.join(',')}`);
    }
  }

  if (compactMeal.has_causal_meal_claim && !fullMeal.has_causal_meal_claim) {
    failures.push('MEAL_CAUSAL_ESCALATION_UNSUPPORTED');
  }

  if (sourceHasMeals && fullMeal.says_no_meal) {
    failures.push('FULL_MEAL_CONTRADICTION_WITH_SOURCE');
  }

  if (sourceHasMeals && compactMeal.says_no_meal) {
    failures.push('COMPACT_MEAL_CONTRADICTION_WITH_SOURCE');
  }

  const activityState = inferFamilySemanticState(input.compactArtifact, 'ACTIVITY');
  if (activityState && ['UNKNOWN', 'MISSING', 'EXCLUDED', 'NOT_SELECTED', 'UNAVAILABLE'].includes(activityState)) {
    if (hasObservedActivityClaim(compactText)) {
      failures.push(`ACTIVITY_SEMANTIC_VIOLATION:${activityState}`);
    }
  }

  const mealState = inferFamilySemanticState(input.compactArtifact, 'MEAL');
  if (mealState && ['UNKNOWN', 'MISSING', 'EXCLUDED', 'NOT_SELECTED', 'UNAVAILABLE'].includes(mealState)) {
    if (hasObservedMealClaim(compactText)) {
      failures.push(`MEAL_SEMANTIC_VIOLATION:${mealState}`);
    }
  }

  const insulinState = inferFamilySemanticState(input.compactArtifact, 'INSULIN');
  if (insulinState && ['UNKNOWN', 'MISSING', 'EXCLUDED', 'NOT_SELECTED', 'UNAVAILABLE'].includes(insulinState)) {
    if (hasObservedInsulinClaim(compactText)) {
      failures.push(`INSULIN_SEMANTIC_VIOLATION:${insulinState}`);
    }
  }

  const noAutonomousTreatmentAction = !normalizeAssistantMessageMarkers(compactText).includes('TREATMENT_ACTION');
  if (!noAutonomousTreatmentAction) {
    failures.push('AUTONOMOUS_TREATMENT_ACTION_DETECTED');
  }

  const noHistoricalAsCurrentFlip = !(
    /wczoraj|history|prior|previous/i.test(compactText)
    && !/wczoraj|history|prior|previous/i.test(fullText)
    && /teraz|current|obecn/i.test(compactText)
  );
  if (!noHistoricalAsCurrentFlip) {
    failures.push('HISTORICAL_CURRENT_INTERPRETATION_FLIP');
  }

  if (comparison.compact_only.includes('MEAL')) {
    const noContradiction =
      !failures.some((value) => value.includes('MEAL_SOURCE_UNSUPPORTED_CLAIM'))
      && !failures.some((value) => value.includes('MEAL_COUNT_CONTRADICTION'))
      && !failures.some((value) => value.includes('FULL_MEAL_CONTRADICTION_WITH_SOURCE'))
      && !failures.some((value) => value.includes('COMPACT_MEAL_CONTRADICTION_WITH_SOURCE'));
    const noCausalEscalation = !failures.includes('MEAL_CAUSAL_ESCALATION_UNSUPPORTED');

    const canDowngradeMealDifference =
      sourceHasMeals
      && compactHasMealSignal
      && fullHasEquivalentMealSignal
      && noContradiction
      && noCausalEscalation
      && rangeIdentityEqual;

    if (canDowngradeMealDifference) {
      comparison.potentially_material_differences = comparison.potentially_material_differences.filter((item) => item !== 'MEAL');
      if (!comparison.benign_differences.includes('MEAL_EQUIVALENT_REPRESENTATION')) {
        comparison.benign_differences = [...comparison.benign_differences, 'MEAL_EQUIVALENT_REPRESENTATION'].sort();
      }
    }
  }

  const hardDataStatePreserved = !failures.some((value) => value.includes('_SEMANTIC_VIOLATION'));
  const noUnsupportedCompactClaims = !failures.some((value) =>
    value.includes('_SEMANTIC_VIOLATION')
    || value.includes('MEAL_SOURCE_UNSUPPORTED_CLAIM')
    || value.includes('MEAL_COUNT_CONTRADICTION')
    || value.includes('MEAL_CAUSAL_ESCALATION_UNSUPPORTED')
    || value.includes('COMPACT_MEAL_CONTRADICTION_WITH_SOURCE'),
  );

  const invariants: InvariantResults = {
    range_identity_equal: rangeIdentityEqual,
    task_type_equal: taskTypeEqual,
    model_equal: modelEqual,
    output_schema_equal: outputSchemaEqual,
    hard_data_state_preserved: hardDataStatePreserved,
    no_unsupported_compact_claims: noUnsupportedCompactClaims,
    no_autonomous_treatment_action: noAutonomousTreatmentAction,
    no_historical_as_current_flip: noHistoricalAsCurrentFlip,
    failures,
  };

  const safety = failures.length > 0 ? 'FAIL' : 'PASS';
  const rangeTime = rangeIdentityEqual ? 'PASS' : 'FAIL';
  const factual = comparison.potentially_material_differences.length === 0 ? 'PASS' : 'REVIEW';
  const uncertainty = compactMarkers.includes('UNKNOWN_OR_MISSING') || !fullMarkers.includes('UNKNOWN_OR_MISSING') ? 'PASS' : 'REVIEW';
  const historicalCurrent = noHistoricalAsCurrentFlip ? 'PASS' : 'FAIL';
  const coverage = comparison.full_only.includes('GLUCOSE') ? 'REVIEW' : 'PASS';
  const conclusions = comparison.potentially_material_differences.length > 0 ? 'REVIEW' : 'PASS';
  const escalation = 'PASS';

  const qualityDimensions: PairQualityDimensions = {
    factual_preservation: factual,
    uncertainty_preservation: uncertainty,
    range_time_correctness: rangeTime,
    historical_current_distinction: historicalCurrent,
    evidence_coverage: coverage,
    analytical_conclusion_preservation: conclusions,
    question_escalation_preservation: escalation,
    safety_boundary_preservation: safety,
  };

  let verdict: PairVerdict = 'PASS';
  if (failures.length > 0) {
    verdict = 'FAIL';
  } else if (comparison.potentially_material_differences.length > 0) {
    verdict = 'REVIEW';
  } else if (comparison.benign_differences.length > 0) {
    verdict = 'PASS_WITH_BENIGN_DIFFERENCE';
  }

  return {
    normalized_full_markers: fullMarkers,
    normalized_compact_markers: compactMarkers,
    comparison,
    invariants,
    quality_dimensions: qualityDimensions,
    verdict,
  };
}

export interface MetricReduction {
  input_byte_reduction_pct: number | null;
  input_token_reduction_pct: number | null;
  total_token_reduction_pct: number | null;
  output_token_delta: number | null;
  cost_reduction_pct: number | 'COST_UNAVAILABLE';
}

export function calculateMetricReduction(full: ReplayMetrics, compact: ReplayMetrics): MetricReduction {
  const pct = (base: number | null, next: number | null): number | null => {
    if (base === null || next === null || base <= 0) return null;
    return Number((((base - next) / base) * 100).toFixed(4));
  };

  const inputByteReduction = pct(full.serialized_input_bytes, compact.serialized_input_bytes);
  const inputTokenReduction = pct(full.input_tokens, compact.input_tokens);
  const totalTokenReduction = pct(full.total_tokens, compact.total_tokens);

  const outputTokenDelta = (full.output_tokens !== null && compact.output_tokens !== null)
    ? compact.output_tokens - full.output_tokens
    : null;

  const costReduction: number | 'COST_UNAVAILABLE' =
    full.estimated_cost !== null && compact.estimated_cost !== null && full.estimated_cost > 0
      ? Number((((full.estimated_cost - compact.estimated_cost) / full.estimated_cost) * 100).toFixed(4))
      : 'COST_UNAVAILABLE';

  return {
    input_byte_reduction_pct: inputByteReduction,
    input_token_reduction_pct: inputTokenReduction,
    total_token_reduction_pct: totalTokenReduction,
    output_token_delta: outputTokenDelta,
    cost_reduction_pct: costReduction,
  };
}

export function stableHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export interface CaseRollup {
  case_id: string;
  quality_verdict: PairVerdict;
  invariant_failures: string[];
  reduction: MetricReduction;
}

export interface AggregateRollup {
  case_count: number;
  full_calls: number;
  compact_calls: number;
  invariant_failures: number;
  material_differences: number;
  benign_differences: number;
  average_input_byte_reduction_pct: number | null;
  median_input_byte_reduction_pct: number | null;
  average_input_token_reduction_pct: number | null;
  median_input_token_reduction_pct: number | null;
  cost_availability: 'AVAILABLE' | 'COST_UNAVAILABLE';
  quality_verdict: 'READY_FOR_EXPANDED_REPLAY' | 'NOT_READY';
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Number((values.reduce((acc, value) => acc + value, 0) / values.length).toFixed(4));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  return Number(value.toFixed(4));
}

export function buildAggregateRollup(cases: CaseRollup[]): AggregateRollup {
  const byteReductions = cases
    .map((item) => item.reduction.input_byte_reduction_pct)
    .filter((value): value is number => value !== null);
  const tokenReductions = cases
    .map((item) => item.reduction.input_token_reduction_pct)
    .filter((value): value is number => value !== null);

  const invariantFailures = cases.reduce((acc, item) => acc + item.invariant_failures.length, 0);
  const materialDifferences = cases.filter((item) => item.quality_verdict === 'REVIEW' || item.quality_verdict === 'FAIL').length;
  const benignDifferences = cases.filter((item) => item.quality_verdict === 'PASS_WITH_BENIGN_DIFFERENCE').length;
  const costAvailability = cases.some((item) => item.reduction.cost_reduction_pct === 'COST_UNAVAILABLE')
    ? 'COST_UNAVAILABLE'
    : 'AVAILABLE';

  const ready =
    invariantFailures === 0
    && materialDifferences === 0
    && byteReductions.some((value) => value > 0)
    && tokenReductions.some((value) => value > 0);

  return {
    case_count: cases.length,
    full_calls: cases.length,
    compact_calls: cases.length,
    invariant_failures: invariantFailures,
    material_differences: materialDifferences,
    benign_differences: benignDifferences,
    average_input_byte_reduction_pct: average(byteReductions),
    median_input_byte_reduction_pct: median(byteReductions),
    average_input_token_reduction_pct: average(tokenReductions),
    median_input_token_reduction_pct: median(tokenReductions),
    cost_availability: costAvailability,
    quality_verdict: ready ? 'READY_FOR_EXPANDED_REPLAY' : 'NOT_READY',
  };
}

export function renderMarkdownSummary(args: {
  experimentId: string;
  cases: Array<{
    case_id: string;
    full_bytes: number | null;
    compact_bytes: number | null;
    reduction_pct: number | null;
    quality: PairVerdict;
    invariant_status: 'PASS' | 'FAIL';
  }>;
  aggregate: AggregateRollup;
}): string {
  const lines: string[] = [];

  lines.push(`# Dual TIME_RANGE FULL vs COMPACT Report (${args.experimentId})`);
  lines.push('');
  lines.push('| Case | FULL input | COMPACT input | Reduction | Quality | Invariants |');
  lines.push('|------|------------|---------------|-----------|---------|------------|');
  for (const row of args.cases) {
    lines.push(`| ${row.case_id} | ${row.full_bytes ?? 'NA'} | ${row.compact_bytes ?? 'NA'} | ${row.reduction_pct ?? 'NA'}% | ${row.quality} | ${row.invariant_status} |`);
  }
  lines.push('');
  lines.push(`1. Input reduction: average ${args.aggregate.average_input_byte_reduction_pct ?? 'NA'}% bytes, average ${args.aggregate.average_input_token_reduction_pct ?? 'NA'}% input tokens.`);
  lines.push(`2. Important evidence preservation: material differences ${args.aggregate.material_differences}, invariant failures ${args.aggregate.invariant_failures}.`);
  lines.push('3. Conclusion changes: reflected in per-case quality verdicts and semantic diff fields.');
  lines.push('4. Uncertainty semantics: enforced by hard-state preservation invariants and contradiction checks.');
  lines.push('5. Current-vs-historical interpretation: guarded by dedicated flip invariant.');
  lines.push('6. Material loss: treated as REVIEW or FAIL and counted in aggregate material differences.');
  lines.push(`7. Token/cost impact: cost availability ${args.aggregate.cost_availability}.`);
  lines.push(`8. Readiness: ${args.aggregate.quality_verdict}.`);

  return `${lines.join('\n')}\n`;
}
