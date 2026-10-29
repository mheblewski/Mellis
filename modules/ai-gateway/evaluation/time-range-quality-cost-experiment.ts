import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { writeEvalArtifact } from './eval-artifact-output';
import { canonicalJson } from '@shared/utils/canonical-json';
import { AiGatewayService } from '@modules/ai-gateway/application/ai-gateway.service';
import { createConversationTimeRangeAnalysisTask } from '@modules/ai-gateway/application/ai-task';
import {
  AiExecutionError,
  AiExecutionResult,
  AiProvider,
  AiProviderInput,
  AiProviderResponse,
  AICostEstimate,
  AIUsage,
  TimeRangeAnalysisContextRecord,
} from '@modules/ai-gateway/domain/ai-gateway';
import {
  assessEvidenceAvailability,
  buildTimeRangeEvidenceGroundTruth,
  compareRubricEvaluations,
  TIME_RANGE_EVIDENCE_RUBRIC_VERSION,
  type EvidenceAvailability,
  type GroundTruthStatus,
  type RubricCriterionDelta,
  type RubricCriterionId,
  type RubricEvaluation,
  type TimeRangeEvidenceGroundTruth,
} from './time-range-evidence-rubric';
import { gradeTimeRangeAnswerV2, TIME_RANGE_EVIDENCE_RUBRIC_V2_VERSION } from './time-range-evidence-rubric-v2';

/** Version of the seven paired history scenarios below; bump it whenever their context or expectations change. */
export const HISTORY_COMPARISON_FIXTURE_VERSION = 'history-comparison-scenarios.v2';

export type StrategyId = 'SEQUENTIAL_PROGRESSIVE' | 'BATCHED' | 'CONTROL_CURRENT';
export type FixtureId = 'fixture-progressive-valuable-v2' | 'fixture-progressive-valuable' | 'fixture-all-relevant';
export type QualityGrade = 'PASS' | 'PARTIAL' | 'FAIL' | 'UNRESOLVED';

export type QualityDimensionId =
  | 'glucose_trajectory'
  | 'insulin_evidence'
  | 'basal_evidence'
  | 'cross_domain_relationship'
  | 'unknown_semantics'
  | 'provenance_grounding'
  | 'final_conclusion'
  | 'unnecessary_assumptions';

export interface FixtureGoldenExpectations {
  fixture_id: FixtureId;
  fixture_version: string;
  required_facts: string[];
  forbidden_claims: string[];
  required_relationships: string[];
  required_unknowns: string[];
  acceptable_conclusions: string[];
}

export interface TimeRangeFixture {
  fixture_id: FixtureId;
  fixture_version: string;
  description: string;
  question: string;
  timezone: string;
  range_start: string;
  range_end: string;
  patient_id: string;
  context_package_id: string;
  context: Record<string, unknown>;
  golden: FixtureGoldenExpectations;
}

interface ProviderCallCapture {
  call_number: number;
  request_bytes: number;
  request_hash: string;
  tool_results: Array<{
    tool_name: string;
    call_id: string;
    result_hash: string;
    result_bytes: number;
  }>;
  tool_calls_requested: string[];
  usage: AIUsage | null;
  estimated_cost: AICostEstimate | null;
}

export interface QualityDimensionResult {
  dimension: QualityDimensionId;
  grade: QualityGrade;
  score: number;
  max_score: number;
  details: string[];
}

interface RunResult {
  fixture_id: FixtureId;
  fixture_version: string;
  strategy: StrategyId;
  run_number: number;
  model: string;
  task_type: string;
  provider_calls: ProviderCallCapture[];
  provider_call_count: number;
  usage_sum: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cached_input_tokens: number;
    reasoning_tokens: number;
  };
  serialized_request_bytes_sum: number;
  tool_result_bytes_sum: number;
  duplicated_tool_result_bytes: number;
  provider_cost_sum: number | null;
  tool_call_count: number;
  tool_sequence: string[];
  assistant_message: string;
  quality_dimensions: QualityDimensionResult[];
}

interface StrategyAggregate {
  strategy: StrategyId;
  runs: number;
  provider_calls_avg: number;
  input_tokens_avg: number;
  output_tokens_avg: number;
  total_tokens_avg: number;
  total_request_bytes_avg: number;
  tool_result_bytes_avg: number;
  duplicated_tool_result_bytes_avg: number;
  cost_avg: number | null;
  quality_dimension_summary: Record<QualityDimensionId, { pass: number; partial: number; fail: number; unresolved: number }>;
  notes: string;
}

export interface TimeRangeQualityCostExperimentReport {
  report_version: 'time-range-quality-cost-experiment.v1';
  generated_at: string;
  model: string;
  task: string;
  run_count_per_strategy: number;
  fixtures: TimeRangeFixture[];
  strategies: Array<{ id: StrategyId; description: string }>;
  runs: RunResult[];
  strategy_aggregates: StrategyAggregate[];
  architecture_conclusions: {
    sequential_quality_advantage: string;
    batching_quality_impact: string;
    batching_safe_situations: string;
    sequential_preferred_situations: string;
    retransmission_justification: string;
    recommended_direction: 'MOSTLY_SEQUENTIAL' | 'MOSTLY_BATCHED' | 'HYBRID_ADAPTIVE';
    hybrid_rules_if_applicable: string[];
  };
  limitations: string[];
}

export type HistoryComparisonVariant = 'history_off' | 'history_on';

export interface HistoricalContextEvidenceSummary {
  summary: string;
  case_count: number;
  source_refs: string[];
  therapy_resolution_context?: {
    status: 'CONFIRMED' | 'NON_CONFIRMED' | 'UNAVAILABLE';
    evidence_note: string;
  };
}

export interface HistoryComparisonScenario {
  scenario_id: string;
  source_kind: 'SYNTHETIC';
  fixture_version: string;
  name: string;
  description: string;
  base_context: TimeRangeAnalysisContextRecord;
  historical_evidence: HistoricalContextEvidenceSummary | null;
  quality_expectations: {
    should_flag_missing_macros: boolean;
    should_flag_later_meal_or_confounders: boolean;
    should_avoid_forced_insulin_meal_attribution: boolean;
    has_unconfirmed_historical_icr_risk: boolean;
    history_expected_to_help: boolean;
  };
}

export interface HistoryComparisonUsage {
  total_serialized_bytes: number;
  sections: Array<{
    section_name: string;
    serialized_bytes: number;
  }>;
}

export interface HistoryComparisonVariantResult {
  variant: HistoryComparisonVariant;
  status: 'SUCCEEDED' | 'FAILED';
  assistant_message: string;
  execution_path: 'AiGatewayService.execute';
  provider_kind: 'deterministic' | 'test' | 'live' | 'unknown';
  real_model_used: boolean | null;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
  output_schema_version: string | null;
  usage: AIUsage | null;
  estimated_cost: AICostEstimate | null;
  provider_latency_ms: number | null;
  serialized_input_bytes: number | null;
  context_package_usage: HistoryComparisonUsage | null;
  quality: {
    evaluation_mode: 'HEURISTIC_RULE_BASED';
    evaluation_method: 'heuristic_text';
    clinical_validation: 'none';
    grading_limitations: string[];
    criteria: Array<{
      criterion_id:
      | 'history_information_usefulness'
      | 'uncertainty_and_provenance'
      | 'missing_macros_not_zero'
      | 'later_meals_or_confounders'
      | 'no_forced_insulin_meal_attribution'
      | 'unconfirmed_historical_icr_not_promoted'
      | 'history_no_help_or_harm_signal';
      grade: 'PASS' | 'PARTIAL' | 'FAIL' | 'NOT_APPLICABLE';
      note: string;
    }>;
  };
  /** Evidence-based rubric (time-range-evidence-rubric); null when the variant failed. */
  evidence_rubric: RubricEvaluation | null;
  /** Whether the facts each criterion needs reached the model, separate from answer correctness. */
  evidence_availability: Record<RubricCriterionId, EvidenceAvailability> | null;
  /** Tool calls the provider requested across all calls of this variant (continuations included). */
  tool_call_count: number;
  error: {
    code: string;
    message: string;
    diagnostics?: {
      validator_rule_id: string;
      validated_field: 'assistant_message';
      redacted_excerpt: string | null;
      full_assistant_message_local_debug?: string;
    };
  } | null;
}

export interface HistoryComparisonInputInvariant {
  strict_input_invariant: {
    source: 'provider_generate_all_calls';
    off_call_count: number;
    on_call_count: number;
    strict_hashes_off: string[];
    strict_hashes_on: string[];
    differing_fields: string[];
    identical: boolean | 'unknown';
  };
  normalized_input_invariant: {
    source: 'provider_generate_all_calls';
    normalized_fields: string[];
    normalized_hashes_off: string[];
    normalized_hashes_on: string[];
    differing_fields_before_normalization: string[];
    differing_fields_after_normalization: string[];
    identical: boolean | 'unknown';
  };
  without_history_hash_off: string;
  without_history_hash_on: string;
  identical_without_history: boolean;
  history_off_preserves_current_evidence: boolean;
}

export interface HistoryCriterionDelta {
  criterion_id: HistoryComparisonVariantResult['quality']['criteria'][number]['criterion_id'];
  off_grade: HistoryComparisonVariantResult['quality']['criteria'][number]['grade'] | 'MISSING';
  on_grade: HistoryComparisonVariantResult['quality']['criteria'][number]['grade'] | 'MISSING';
  delta: 'improve' | 'degrade' | 'no_change' | 'not_comparable';
}

export interface HistoryEvidenceComparisonResult {
  scenario_id: string;
  scenario_name: string;
  source_kind: 'SYNTHETIC';
  pair_status: 'COMPLETE' | 'INCOMPLETE';
  input_invariant: HistoryComparisonInputInvariant;
  history_off: HistoryComparisonVariantResult;
  history_on: HistoryComparisonVariantResult;
  quality_pairwise_delta: HistoryCriterionDelta[];
  evidence_ground_truth: {
    rubric_version: typeof TIME_RANGE_EVIDENCE_RUBRIC_VERSION;
    fixture_version: string;
    criteria: Record<RubricCriterionId, { status: GroundTruthStatus; missing_evidence: string[] }>;
    anomalies: string[];
  };
  evidence_rubric_delta: RubricCriterionDelta[];
}

export interface HistoryEvidenceComparisonExperimentReport {
  report_version: 'history-evidence-comparison.v1';
  generated_at: string;
  scenarios: HistoryEvidenceComparisonResult[];
  summary: {
    total_pairs: number;
    complete_pairs: number;
    incomplete_pairs: number;
    failed_variants: number;
    metrics_availability: {
      usage_tokens_pairs: number;
      estimated_cost_pairs: number;
      provider_latency_pairs: number;
      context_size_pairs: number;
    };
    pairwise_delta_summary: {
      improve: number;
      degrade: number;
      no_change: number;
      not_comparable: number;
    };
    evidence_rubric_version: typeof TIME_RANGE_EVIDENCE_RUBRIC_V2_VERSION;
    evidence_rubric_delta_summary: {
      improve: number;
      degrade: number;
      no_change: number;
      not_comparable: number;
    };
  };
  limitations: string[];
  evaluation_notes: {
    synthetic_data_only: true;
    model_as_judge_used: false;
    objective_truth_claimed: false;
  };
}

interface HistoryComparisonExperimentOptions {
  provider?: AiProvider;
  timeout_ms?: number;
  context_mutator?: (args: {
    scenario: HistoryComparisonScenario;
    variant: HistoryComparisonVariant;
    context: TimeRangeAnalysisContextRecord;
  }) => TimeRangeAnalysisContextRecord;
}

interface HistoryComparisonProviderInputCapture {
  call_count: number;
  all_call_inputs: AiProviderInput[];
}

interface ExperimentOptions {
  runs_per_strategy: number;
  output_json_path?: string;
  output_md_path?: string;
}

const MODEL_NAME = 'deterministic-quality-cost-model-v1';
const TASK_TYPE = 'CONVERSATION_TIME_RANGE_ANALYSIS';

function isProgressiveFixtureId(fixtureId: FixtureId): boolean {
  return fixtureId === 'fixture-progressive-valuable-v2' || fixtureId === 'fixture-progressive-valuable';
}

function sha(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function usageFromIo(inputBytes: number, outputText: string): AIUsage {
  const inputTokens = Math.max(1, Math.ceil(inputBytes / 4));
  const outputTokens = Math.max(1, Math.ceil(Buffer.byteLength(outputText, 'utf8') / 4));
  const reasoning = Math.max(1, Math.floor(outputTokens * 0.2));
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    cached_input_tokens: 0,
    reasoning_tokens: reasoning,
  };
}

function costFromUsage(usage: AIUsage): AICostEstimate {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  const reasoning = usage.reasoning_tokens ?? 0;
  const inputCost = (input / 1000) * 0.004;
  const outputCost = (output / 1000) * 0.01;
  const cachedCost = (cached / 1000) * 0;
  const reasoningCost = (reasoning / 1000) * 0.003;
  return {
    estimated_cost: Number((inputCost + outputCost + reasoningCost).toFixed(8)),
    currency: 'USD',
    pricing_version: 'synthetic-pricing.v1',
    input_cost: Number(inputCost.toFixed(8)),
    output_cost: Number(outputCost.toFixed(8)),
    cached_input_cost: Number(cachedCost.toFixed(8)),
    reasoning_cost: Number(reasoningCost.toFixed(8)),
  };
}

class ExperimentProvider implements AiProvider {
  readonly calls: ProviderCallCapture[] = [];

  constructor(
    private readonly fixture: TimeRangeFixture,
    private readonly strategy: StrategyId,
    private readonly runNumber: number,
  ) {}

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    const snapshot = JSON.parse(JSON.stringify(input)) as AiProviderInput;
    const callNumber = this.calls.length + 1;

    const toolResults = snapshot.tool_runtime?.tool_results ?? [];
    const toolCallsRequested = toolResults.map((entry) => entry.tool_name);
    const requestBytes = bytes(snapshot);
    const requestHash = sha(snapshot);

    const response = this.buildResponse(callNumber, snapshot);
    const usage = response.usage ?? null;
    const estimatedCost = response.estimated_cost ?? null;

    this.calls.push({
      call_number: callNumber,
      request_bytes: requestBytes,
      request_hash: requestHash,
      tool_results: toolResults.map((toolResult) => {
        const resultHash = typeof toolResult.result.content_hash === 'string'
          ? String(toolResult.result.content_hash)
          : sha(toolResult.result);
        return {
          tool_name: toolResult.tool_name,
          call_id: toolResult.call_id,
          result_hash: resultHash,
          result_bytes: bytes(toolResult.result),
        };
      }),
      tool_calls_requested: toolCallsRequested,
      usage,
      estimated_cost: estimatedCost,
    });

    return response;
  }

  private buildResponse(callNumber: number, input: AiProviderInput): AiProviderResponse {
    const toolResults = input.tool_runtime?.tool_results ?? [];

    if (this.strategy === 'CONTROL_CURRENT') {
      if (callNumber === 1) {
        return this.toolCallResponse(callNumber, {
          call_id: `${this.fixture.fixture_id}-${this.runNumber}-ctrl-glucose`,
          tool_name: 'get_glucose_evidence',
          arguments: {
            time_range: { from: this.fixture.range_start, to: this.fixture.range_end },
            detail_level: 'DETAIL',
          },
        });
      }
      return this.finalResponse(callNumber, toolResults, false);
    }

    if (this.strategy === 'BATCHED') {
      if (callNumber === 1) {
        return this.multiToolCallResponse(callNumber, [
          {
            call_id: `${this.fixture.fixture_id}-${this.runNumber}-batch-glucose`,
            tool_name: 'get_glucose_evidence',
            arguments: {
              time_range: { from: this.fixture.range_start, to: this.fixture.range_end },
              detail_level: 'DETAIL',
            },
          },
          {
            call_id: `${this.fixture.fixture_id}-${this.runNumber}-batch-insulin`,
            tool_name: 'get_insulin_evidence',
            arguments: {
              time_range: { from: this.fixture.range_start, to: this.fixture.range_end },
              detail_level: 'DETAIL',
            },
          },
          {
            call_id: `${this.fixture.fixture_id}-${this.runNumber}-batch-basal`,
            tool_name: 'get_basal_evidence',
            arguments: {
              time_range: { from: this.fixture.range_start, to: this.fixture.range_end },
              detail_level: 'DETAIL',
            },
          },
        ]);
      }
      return this.finalResponse(callNumber, toolResults, true);
    }

    const hasGlucose = toolResults.some((entry) => entry.tool_name === 'get_glucose_evidence');
    const hasInsulin = toolResults.some((entry) => entry.tool_name === 'get_insulin_evidence');
    const hasBasal = toolResults.some((entry) => entry.tool_name === 'get_basal_evidence');

    if (!hasGlucose) {
      return this.toolCallResponse(callNumber, {
        call_id: `${this.fixture.fixture_id}-${this.runNumber}-seq-glucose`,
        tool_name: 'get_glucose_evidence',
        arguments: {
          time_range: { from: this.fixture.range_start, to: this.fixture.range_end },
          detail_level: 'DETAIL',
        },
      });
    }

    if (!hasInsulin) {
      return this.toolCallResponse(callNumber, {
        call_id: `${this.fixture.fixture_id}-${this.runNumber}-seq-insulin`,
        tool_name: 'get_insulin_evidence',
        arguments: {
          time_range: { from: this.fixture.range_start, to: this.fixture.range_end },
          detail_level: 'DETAIL',
        },
      });
    }

    if (this.fixture.fixture_id === 'fixture-all-relevant' && !hasBasal) {
      return this.toolCallResponse(callNumber, {
        call_id: `${this.fixture.fixture_id}-${this.runNumber}-seq-basal`,
        tool_name: 'get_basal_evidence',
        arguments: {
          time_range: { from: this.fixture.range_start, to: this.fixture.range_end },
          detail_level: 'DETAIL',
        },
      });
    }

    return this.finalResponse(callNumber, toolResults, true);
  }

  private toolCallResponse(callNumber: number, toolCall: NonNullable<AiProviderResponse['tool_call']>): AiProviderResponse {
    const usage = usageFromIo(500 + callNumber * 20, JSON.stringify(toolCall));
    return {
      provider: 'experiment-provider',
      model: MODEL_NAME,
      raw_output: {},
      tool_call: toolCall,
      tool_calls: [toolCall],
      usage,
      estimated_cost: costFromUsage(usage),
      received_at: new Date().toISOString(),
    };
  }

  private multiToolCallResponse(callNumber: number, toolCalls: NonNullable<AiProviderResponse['tool_calls']>): AiProviderResponse {
    const usage = usageFromIo(600 + callNumber * 20, JSON.stringify(toolCalls));
    return {
      provider: 'experiment-provider',
      model: MODEL_NAME,
      raw_output: {},
      tool_call: toolCalls[0] ?? null,
      tool_calls: toolCalls,
      usage,
      estimated_cost: costFromUsage(usage),
      received_at: new Date().toISOString(),
    };
  }

  private finalResponse(callNumber: number, toolResults: NonNullable<AiProviderInput['tool_runtime']>['tool_results'], allowBasalConclusion: boolean): AiProviderResponse {
    const hasGlucose = toolResults.some((entry) => entry.tool_name === 'get_glucose_evidence');
    const hasInsulin = toolResults.some((entry) => entry.tool_name === 'get_insulin_evidence');
    const hasBasal = toolResults.some((entry) => entry.tool_name === 'get_basal_evidence');

    const messageLines: string[] = [];
    if (isProgressiveFixtureId(this.fixture.fixture_id)) {
      messageLines.push('GLUCOSE_TRAJECTORY: minimum 67 mg/dL around 09:42 after a decline from 132 mg/dL near 09:12.');
      messageLines.push('INSULIN_EVIDENCE: bolus 1.6U at 09:08 is close to the decline window.');
      if (hasBasal && allowBasalConclusion) {
        messageLines.push('BASAL_EVIDENCE: temp basal 0.95 U/h at 09:20 for 40 minutes versus planned 0.65 U/h, but effect remains uncertain.');
      } else {
        messageLines.push('BASAL_EVIDENCE: not required for primary explanation in this fixture.');
      }
      messageLines.push('RELATIONSHIP: decline is consistent with insulin timing, without proving single-cause attribution.');
      messageLines.push('UNKNOWN: activity context remains UNKNOWN for this period.');
      if (hasGlucose) {
        messageLines.push('GROUNDING: source-record/gf1 source-record/gf4');
      }
      if (hasInsulin) {
        messageLines.push('GROUNDING: source-record/if1');
      }
      messageLines.push('CONCLUSION: likely insulin pressure with residual uncertainty about other confounders.');
    } else {
      messageLines.push('GLUCOSE_TRAJECTORY: minimum 49 mg/dL near 11:59 with a rapid decline from 118 mg/dL at 11:38.');
      messageLines.push('INSULIN_EVIDENCE: bolus 3.7U at 11:20 and bolus 1.0U at 11:45 are both relevant.');
      if (hasBasal) {
        messageLines.push('BASAL_EVIDENCE: temp basal 1.1 U/h from 11:25 to 12:00 overlaps the decline window.');
      } else {
        messageLines.push('BASAL_EVIDENCE: missing; this limits certainty about basal contribution.');
      }
      messageLines.push('RELATIONSHIP: glucose drop likely reflects combined insulin and basal pressure; avoid deterministic single-cause claim.');
      messageLines.push('UNKNOWN: activity context remains UNKNOWN and lacks affirmative activity evidence.');
      messageLines.push('GROUNDING: source-record/ga1 source-record/ga4 source-record/ia1 source-record/ba1');
      messageLines.push('CONCLUSION: high-risk multi-factor low episode requiring caution and data-complete follow-up.');
    }

    if (this.strategy === 'CONTROL_CURRENT') {
      messageLines.push('LIMITATION: control strategy had only glucose tool access in current production path.');
    }

    const assistantMessage = messageLines.join(' ');
    const usage = usageFromIo(900 + callNumber * 40 + bytes(toolResults), assistantMessage);

    return {
      provider: 'experiment-provider',
      model: MODEL_NAME,
      raw_output: {
        assistant_message: assistantMessage,
      },
      usage,
      estimated_cost: costFromUsage(usage),
      received_at: new Date().toISOString(),
    };
  }
}

export function createTimeRangeQualityCostFixtures(): TimeRangeFixture[] {
  const fixtureA: TimeRangeFixture = {
    fixture_id: 'fixture-progressive-valuable-v2',
    fixture_version: 'time-range-fixture.v1',
    description: 'Progressive information-value case: glucose enables first-pass analysis, insulin narrows hypothesis, basal refines confidence.',
    question: 'Explain what likely drove the low episode and what remains uncertain after reviewing all relevant contributors.',
    timezone: 'Europe/Warsaw',
    range_start: '2026-10-08T09:00:00.000Z',
    range_end: '2026-10-08T10:00:00.000Z',
    patient_id: 'patient-quality-cost-1',
    context_package_id: 'fixture-progressive-valuable-v2-cp',
    context: {
      context_package_id: 'fixture-progressive-valuable-v2-cp',
      context_package_version: 'conversation-time-range-context.v1',
      content_hash: 'sha256:fixture-progressive-valuable-v2-cp',
      created_at: '2026-10-08T10:00:00.000Z',
      patient_ref: { patient_id: 'patient-quality-cost-1' },
      analysis_request_input: {
        user_message_id: 'msg-f1-v2',
        user_message_text: 'Please explain the low episode, likely contributors, and what remains uncertain.',
        range_type: 'TODAY',
        timezone: 'Europe/Warsaw',
        range_start: '2026-10-08T09:00:00.000Z',
        range_end: '2026-10-08T10:00:00.000Z',
        requested_at: '2026-10-08T10:00:00.000Z',
      },
      conversation_context: {
        thread_id: 'thread-f1-v2',
        thread_state_version: 'thread-f1-v2',
        awaiting_user_answer: false,
        messages: [],
      },
      current_state_snapshot: {
        as_of: '2026-10-08T10:00:00.000Z',
        current_glucose: 104,
        trend: 'UP',
        iob: 0.5,
        recent_insulin: [],
      },
      active_therapy_snapshot: {
        therapy_id: 'therapy-f1-v2',
        therapy_version: 'therapy-f1-v2.v1',
        active_profile_id: 'profile-f1-v2',
        basal_schedule: {
          '00:00': { rate: 0.55 },
          '08:00': { rate: 0.65 },
        },
        icr_schedule: {},
        isf_schedule: {},
        target_schedule: {},
        dia: 6,
        automation_mode: 'OFF',
      },
      analytical_evidence: {
        glucose_events: [
          { event_id: 'gf1', occurred_at: '2026-10-08T09:12:00.000Z', payload: { glucose_value: 132 }, provenance_ref: 'source-record/gf1' },
          { event_id: 'gf2', occurred_at: '2026-10-08T09:24:00.000Z', payload: { glucose_value: 101 }, provenance_ref: 'source-record/gf2' },
          { event_id: 'gf3', occurred_at: '2026-10-08T09:33:00.000Z', payload: { glucose_value: 79 }, provenance_ref: 'source-record/gf3' },
          { event_id: 'gf4', occurred_at: '2026-10-08T09:42:00.000Z', payload: { glucose_value: 67 }, provenance_ref: 'source-record/gf4' },
          { event_id: 'gf5', occurred_at: '2026-10-08T09:57:00.000Z', payload: { glucose_value: 104 }, provenance_ref: 'source-record/gf5' },
        ],
        insulin_treatment_events: [
          {
            event_id: 'if0',
            occurred_at: '2026-10-08T08:05:00.000Z',
            kind: 'BOLUS',
            amount: 0.4,
            unit: 'U',
            provenance_ref: 'source-record/if0',
          },
          {
            event_id: 'if0b',
            occurred_at: '2026-10-08T08:40:00.000Z',
            kind: 'BOLUS',
            amount: 0.3,
            unit: 'U',
            provenance_ref: 'source-record/if0b',
          },
          {
            event_id: 'if1',
            occurred_at: '2026-10-08T09:08:00.000Z',
            kind: 'BOLUS',
            amount: 1.6,
            unit: 'U',
            provenance_ref: 'source-record/if1',
          },
          {
            event_id: 'bf1',
            occurred_at: '2026-10-08T09:20:00.000Z',
            kind: 'TEMP_BASAL',
            rate: 0.95,
            duration_minutes: 40,
            unit: 'U/h',
            provenance_ref: 'source-record/bf1',
          },
        ],
        meal_events: [
          {
            event_id: 'mf1',
            occurred_at: '2026-10-08T08:55:00.000Z',
            payload: { carbs_grams: 38 },
            provenance_ref: 'source-record/mf1',
          },
        ],
        activity_events: [],
        hypo_episodes: [],
        range_event_facts: [],
        summaries: {
          total_events: 10,
          glucose_count: 5,
          insulin_treatment_count: 4,
          meal_count: 1,
          activity_count: 0,
          hypo_episode_count: 0,
          glucose_min: 67,
          glucose_max: 132,
          glucose_avg: 96,
          missing_sections: ['activity_events'],
        },
      },
      provenance: {
        source_refs: ['msg-f1'],
        selection_policy_version: 'conversation-time-range-selector.v1',
      },
    },
    golden: {
      fixture_id: 'fixture-progressive-valuable-v2',
      fixture_version: 'time-range-fixture.v1',
      required_facts: ['minimum 67 mg/dL', 'bolus 1.6U at 09:08', 'temp basal 0.95 U/h'],
      forbidden_claims: ['no activity', 'definitive single cause', 'meal absent'],
      required_relationships: ['consistent with insulin timing', 'without proving single-cause attribution'],
      required_unknowns: ['activity context remains UNKNOWN'],
      acceptable_conclusions: ['likely insulin pressure with residual uncertainty'],
    },
  };

  const fixtureB: TimeRangeFixture = {
    fixture_id: 'fixture-all-relevant',
    fixture_version: 'time-range-fixture.v1',
    description: 'All three evidence domains are relevant from the start.',
    question: 'Explain the severe low and all materially relevant contributors.',
    timezone: 'Europe/Warsaw',
    range_start: '2026-10-08T11:20:00.000Z',
    range_end: '2026-10-08T12:10:00.000Z',
    patient_id: 'patient-quality-cost-2',
    context_package_id: 'fixture-all-relevant-cp',
    context: {
      context_package_id: 'fixture-all-relevant-cp',
      context_package_version: 'conversation-time-range-context.v1',
      content_hash: 'sha256:fixture-all-relevant-cp',
      created_at: '2026-10-08T12:10:00.000Z',
      patient_ref: { patient_id: 'patient-quality-cost-2' },
      analysis_request_input: {
        user_message_id: 'msg-f2',
        user_message_text: 'Please explain severe low contributors.',
        range_type: 'TODAY',
        timezone: 'Europe/Warsaw',
        range_start: '2026-10-08T11:20:00.000Z',
        range_end: '2026-10-08T12:10:00.000Z',
        requested_at: '2026-10-08T12:10:00.000Z',
      },
      conversation_context: {
        thread_id: 'thread-f2',
        thread_state_version: 'thread-f2-v1',
        awaiting_user_answer: false,
        messages: [],
      },
      current_state_snapshot: {
        as_of: '2026-10-08T12:10:00.000Z',
        current_glucose: 82,
        trend: 'UP',
        iob: 0.3,
        recent_insulin: [
          {
            event_id: 'ia1',
            kind: 'BOLUS',
            amount: 3.7,
            unit: 'U',
            occurred_at: '2026-10-08T11:20:00.000Z',
            provenance_ref: 'source-record/ia1',
          },
          {
            event_id: 'ia2',
            kind: 'BOLUS',
            amount: 1.0,
            unit: 'U',
            occurred_at: '2026-10-08T11:45:00.000Z',
            provenance_ref: 'source-record/ia2',
          },
          {
            event_id: 'ba1',
            kind: 'TEMP_BASAL',
            rate: 1.1,
            duration_minutes: 35,
            unit: 'U/h',
            occurred_at: '2026-10-08T11:25:00.000Z',
            provenance_ref: 'source-record/ba1',
          },
        ],
      },
      active_therapy_snapshot: {
        therapy_id: 'therapy-f2',
        therapy_version: 'therapy-f2.v1',
        active_profile_id: 'profile-f2',
        basal_schedule: {
          '00:00': { rate: 0.75 },
          '11:00': { rate: 0.9 },
        },
        icr_schedule: {},
        isf_schedule: {},
        target_schedule: {},
        dia: 6,
        automation_mode: 'OFF',
      },
      analytical_evidence: {
        glucose_events: [
          { event_id: 'ga1', occurred_at: '2026-10-08T11:38:00.000Z', payload: { glucose_value: 118 }, provenance_ref: 'source-record/ga1' },
          { event_id: 'ga2', occurred_at: '2026-10-08T11:46:00.000Z', payload: { glucose_value: 95 }, provenance_ref: 'source-record/ga2' },
          { event_id: 'ga3', occurred_at: '2026-10-08T11:52:00.000Z', payload: { glucose_value: 74 }, provenance_ref: 'source-record/ga3' },
          { event_id: 'ga4', occurred_at: '2026-10-08T11:59:00.000Z', payload: { glucose_value: 49 }, provenance_ref: 'source-record/ga4' },
          { event_id: 'ga5', occurred_at: '2026-10-08T12:05:00.000Z', payload: { glucose_value: 82 }, provenance_ref: 'source-record/ga5' },
        ],
        insulin_treatment_events: [
          {
            event_id: 'ia1',
            occurred_at: '2026-10-08T11:20:00.000Z',
            kind: 'BOLUS',
            amount: 3.7,
            unit: 'U',
            provenance_ref: 'source-record/ia1',
          },
          {
            event_id: 'ia2',
            occurred_at: '2026-10-08T11:45:00.000Z',
            kind: 'BOLUS',
            amount: 1.0,
            unit: 'U',
            provenance_ref: 'source-record/ia2',
          },
          {
            event_id: 'ba1',
            occurred_at: '2026-10-08T11:25:00.000Z',
            kind: 'TEMP_BASAL',
            rate: 1.1,
            duration_minutes: 35,
            unit: 'U/h',
            provenance_ref: 'source-record/ba1',
          },
        ],
        meal_events: [
          {
            event_id: 'ma1',
            occurred_at: '2026-10-08T11:18:00.000Z',
            payload: { carbs_grams: 20 },
            provenance_ref: 'source-record/ma1',
          },
        ],
        activity_events: [],
        hypo_episodes: [],
        range_event_facts: [],
        summaries: {
          total_events: 9,
          glucose_count: 5,
          insulin_treatment_count: 3,
          meal_count: 1,
          activity_count: 0,
          hypo_episode_count: 0,
          glucose_min: 49,
          glucose_max: 118,
          glucose_avg: 84,
          missing_sections: ['activity_events'],
        },
      },
      provenance: {
        source_refs: ['msg-f2'],
        selection_policy_version: 'conversation-time-range-selector.v1',
      },
    },
    golden: {
      fixture_id: 'fixture-all-relevant',
      fixture_version: 'time-range-fixture.v1',
      required_facts: ['minimum 49 mg/dL', 'bolus 3.7U at 11:20', 'temp basal 1.1 U/h'],
      forbidden_claims: ['activity present', 'no insulin contribution', 'basal irrelevant'],
      required_relationships: ['combined insulin and basal pressure'],
      required_unknowns: ['activity context remains UNKNOWN'],
      acceptable_conclusions: ['high-risk multi-factor low episode'],
    },
  };

  return [fixtureA, fixtureB];
}

export function evaluateTimeRangeQualityRubric(message: string, fixture: TimeRangeFixture): QualityDimensionResult[] {
  const text = normalizeForGrading(message);

  const hasAny = (patterns: RegExp[]) => patterns.some((pattern) => pattern.test(text));
  const hasNumber = (value: number) => new RegExp(`(?:^|\\D)${String(value).replace('.', '\\.')}\\b`).test(text);
  const hasTime = (time: string) => text.includes(time.toLowerCase());

  const lowWords = [/\blow\b/, /\bhypo\w*/];
  const declineWords = [/\bdeclin\w*/i, /\bfell\b/, /\bdrop\w*/];
  const insulinWords = [/\binsulin\b/, /\bbolus\b/];
  const basalWords = [/\bbasal\b/, /\btemp\s+basal\b/];
  const uncertaintyWords = [/\bunknown\b/, /\buncertain\b/, /\bcannot\s+establish\b/, /\bnot\s+enough\s+information\b/, /\binsufficient\b/];
  const contributorWords = [/\bcontribut\w*/i, /\brelated\b/, /\bconsistent\b/, /\boverlap\w*/];

  const dims: QualityDimensionResult[] = [];

  const expectedMin = isProgressiveFixtureId(fixture.fixture_id) ? 67 : 49;
  const expectedHigh = isProgressiveFixtureId(fixture.fixture_id) ? 132 : 118;
  const glucoseSignals = [
    hasNumber(expectedMin) && hasAny(lowWords),
    hasNumber(expectedHigh) && hasAny(declineWords),
  ];
  const glucoseContradiction = hasAny([/\bno\s+low\b/, /\bnormal\s+throughout\b/]);
  dims.push({
    dimension: 'glucose_trajectory',
    grade: glucoseContradiction
      ? 'FAIL'
      : glucoseSignals.every(Boolean)
        ? 'PASS'
        : glucoseSignals.some(Boolean)
          ? 'PARTIAL'
          : 'UNRESOLVED',
    score: glucoseSignals.filter(Boolean).length,
    max_score: glucoseSignals.length,
    details: [
      `mentions low around ${expectedMin} mg/dL`,
      `describes decline from about ${expectedHigh} mg/dL`,
    ],
  });

  const insulinSignals = isProgressiveFixtureId(fixture.fixture_id)
    ? [hasNumber(1.6) && hasTime('09:08') && hasAny(insulinWords)]
    : [
      hasNumber(3.7) && hasTime('11:20') && hasAny(insulinWords),
      hasNumber(1.0) && hasTime('11:45') && hasAny(insulinWords),
    ];
  const insulinContradiction = hasAny([/\bno\s+insulin\s+contribution\b/, /\binsulin\s+did\s+not\s+contribute\b/]);
  dims.push({
    dimension: 'insulin_evidence',
    grade: insulinContradiction
      ? 'FAIL'
      : insulinSignals.every(Boolean)
        ? 'PASS'
        : insulinSignals.some(Boolean)
          ? 'PARTIAL'
          : 'UNRESOLVED',
    score: insulinSignals.filter(Boolean).length,
    max_score: insulinSignals.length,
    details: isProgressiveFixtureId(fixture.fixture_id)
      ? ['captures 1.6U bolus around 09:08 as relevant evidence']
      : ['captures 3.7U bolus around 11:20', 'captures 1.0U bolus around 11:45'],
  });

  const basalSignals = isProgressiveFixtureId(fixture.fixture_id)
    ? [
      hasAny(basalWords) && (hasNumber(0.95) || hasNumber(0.65)),
      hasAny(uncertaintyWords),
    ]
    : [hasAny(basalWords) && hasNumber(1.1)];
  const basalContradiction = hasAny([/\bbasal\b.*\birrelevant\b/, /\bno\s+basal\s+contribution\b/]);
  dims.push({
    dimension: 'basal_evidence',
    grade: basalContradiction
      ? 'FAIL'
      : basalSignals.every(Boolean)
        ? 'PASS'
        : basalSignals.some(Boolean)
          ? 'PARTIAL'
          : 'UNRESOLVED',
    score: basalSignals.filter(Boolean).length,
    max_score: basalSignals.length,
    details: isProgressiveFixtureId(fixture.fixture_id)
      ? ['mentions basal context (actual or planned) and uncertainty of causal impact']
      : ['mentions temp basal around 1.1 U/h as contributor'],
  });

  const relationshipSignals = [
    hasAny(contributorWords) && hasAny(insulinWords),
    hasAny(uncertaintyWords),
    fixture.fixture_id === 'fixture-all-relevant' ? hasAny(basalWords) : true,
  ];
  dims.push({
    dimension: 'cross_domain_relationship',
    grade: relationshipSignals.every(Boolean)
      ? 'PASS'
      : relationshipSignals.filter(Boolean).length >= 2
        ? 'PARTIAL'
        : 'UNRESOLVED',
    score: relationshipSignals.filter(Boolean).length,
    max_score: relationshipSignals.length,
    details: fixture.golden.required_relationships,
  });

  const unknownSignals = [
    hasAny([/\bunknown\b/, /\bmissing\b/, /\bunavailable\b/, /\bnot\s+available\b/]),
    hasAny([/\bactivity\b/, /\bmeal\b/, /\bcarb\w*/]),
  ];
  const unknownContradiction = hasAny([/\bactivity\b.*\b(occurred|present|confirmed|caused)\b/])
    && !hasAny([/\bunknown\b/, /\bunavailable\b/, /\bnot\s+available\b/]);
  dims.push({
    dimension: 'unknown_semantics',
    grade: unknownContradiction
      ? 'FAIL'
      : unknownSignals.every(Boolean)
        ? 'PASS'
        : unknownSignals.some(Boolean)
          ? 'PARTIAL'
          : 'UNRESOLVED',
    score: unknownSignals.filter(Boolean).length,
    max_score: unknownSignals.length,
    details: ['appropriately communicates unknown or missing confounders'],
  });

  const provenanceSignals = [
    hasAny([/\b\d+\s*(mg\/dl|u\/h|u)\b/]),
    hasAny([/\b\d{1,2}:\d{2}\b/]),
    hasAny(insulinWords) || hasAny(basalWords) || hasAny(lowWords),
  ];
  dims.push({
    dimension: 'provenance_grounding',
    grade: provenanceSignals.every(Boolean)
      ? 'PASS'
      : provenanceSignals.filter(Boolean).length >= 2
        ? 'PARTIAL'
        : 'UNRESOLVED',
    score: provenanceSignals.filter(Boolean).length,
    max_score: provenanceSignals.length,
    details: ['uses concrete observed anchors (values, timing, and domain context) without requiring technical source IDs'],
  });

  const conclusionSignals = isProgressiveFixtureId(fixture.fixture_id)
    ? [
      hasAny([/\blikely\b/, /\bprobabl\w*/]),
      hasAny(insulinWords),
      hasAny([/\bdeclin\w*/i, /\blow\b/, /\bhypo\w*/]),
    ]
    : [
      hasAny([/\bhigh\s*-?\s*risk\b/, /\bsevere\b/, /\bmulti\s*-?\s*factor\b/]),
      hasAny(insulinWords),
      hasAny(basalWords),
    ];
  dims.push({
    dimension: 'final_conclusion',
    grade: conclusionSignals.every(Boolean)
      ? 'PASS'
      : conclusionSignals.filter(Boolean).length >= 2
        ? 'PARTIAL'
        : 'UNRESOLVED',
    score: conclusionSignals.filter(Boolean).length,
    max_score: conclusionSignals.length,
    details: fixture.golden.acceptable_conclusions,
  });

  const forbiddenPatterns = isProgressiveFixtureId(fixture.fixture_id)
    ? [
      /\bno\s+activity\b/,
      /\bdefinitive\s+single\s+cause\b/,
      /\bsolely\s+due\s+to\b/,
      /\bmeal\s+(is\s+)?absent\b/,
      /\bno\s+meal\b/,
    ]
    : [
      /\bactivity\s+(is\s+)?present\b/,
      /\bno\s+insulin\s+contribution\b/,
      /\binsulin\s+did\s+not\s+contribute\b/,
      /\bbasal\s+is\s+irrelevant\b/,
      /\bno\s+basal\s+effect\b/,
    ];
  const hasForbidden = hasAny(forbiddenPatterns);
  dims.push({
    dimension: 'unnecessary_assumptions',
    grade: hasForbidden ? 'FAIL' : 'PASS',
    score: hasForbidden ? 0 : 1,
    max_score: 1,
    details: fixture.golden.forbidden_claims,
  });

  return dims;
}

function normalizeForGrading(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeUsage(calls: ProviderCallCapture[]): RunResult['usage_sum'] {
  return calls.reduce((acc, call) => {
    const usage = call.usage;
    return {
      input_tokens: acc.input_tokens + (usage?.input_tokens ?? 0),
      output_tokens: acc.output_tokens + (usage?.output_tokens ?? 0),
      total_tokens: acc.total_tokens + (usage?.total_tokens ?? 0),
      cached_input_tokens: acc.cached_input_tokens + (usage?.cached_input_tokens ?? 0),
      reasoning_tokens: acc.reasoning_tokens + (usage?.reasoning_tokens ?? 0),
    };
  }, {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cached_input_tokens: 0,
    reasoning_tokens: 0,
  });
}

function computeToolReplay(calls: ProviderCallCapture[]): { total: number; duplicated: number } {
  const seen = new Set<string>();
  let total = 0;
  let duplicated = 0;

  for (const call of calls) {
    for (const result of call.tool_results) {
      total += result.result_bytes;
      const key = `${result.tool_name}:${result.result_hash}`;
      if (seen.has(key)) {
        duplicated += result.result_bytes;
      } else {
        seen.add(key);
      }
    }
  }

  return { total, duplicated };
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

function toMarkdown(report: TimeRangeQualityCostExperimentReport): string {
  const lines: string[] = [];
  lines.push('# Time-Range Quality vs Cost Experiment');
  lines.push('');
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`model: ${report.model}`);
  lines.push(`task: ${report.task}`);
  lines.push(`runs_per_strategy: ${report.run_count_per_strategy}`);
  lines.push('');
  lines.push('## 1. Fixture definitions');
  for (const fixture of report.fixtures) {
    lines.push(`- ${fixture.fixture_id} (${fixture.fixture_version}): ${fixture.description}`);
  }
  lines.push('');
  lines.push('## 2. Strategy definitions');
  for (const strategy of report.strategies) {
    lines.push(`- ${strategy.id}: ${strategy.description}`);
  }
  lines.push('');
  lines.push('## 3. Tool sequences');
  for (const run of report.runs) {
    lines.push(`- ${run.fixture_id} | ${run.strategy} | run ${run.run_number}: [${run.tool_sequence.join(', ')}]`);
  }
  lines.push('');
  lines.push('## 4. Provider calls');
  for (const run of report.runs) {
    lines.push(`- ${run.fixture_id} | ${run.strategy} | run ${run.run_number}: provider_calls=${run.provider_call_count}`);
  }
  lines.push('');
  lines.push('## 5. Token usage');
  for (const run of report.runs) {
    lines.push(`- ${run.fixture_id} | ${run.strategy} | run ${run.run_number}: input=${run.usage_sum.input_tokens}, output=${run.usage_sum.output_tokens}, total=${run.usage_sum.total_tokens}, cached=${run.usage_sum.cached_input_tokens}, reasoning=${run.usage_sum.reasoning_tokens}`);
  }
  lines.push('');
  lines.push('## 6. Byte usage');
  for (const run of report.runs) {
    lines.push(`- ${run.fixture_id} | ${run.strategy} | run ${run.run_number}: request_bytes=${run.serialized_request_bytes_sum}, tool_result_bytes=${run.tool_result_bytes_sum}, duplicated_tool_result_bytes=${run.duplicated_tool_result_bytes}`);
  }
  lines.push('');
  lines.push('## 7. Cost');
  for (const run of report.runs) {
    lines.push(`- ${run.fixture_id} | ${run.strategy} | run ${run.run_number}: cost=${run.provider_cost_sum === null ? 'UNAVAILABLE' : run.provider_cost_sum.toFixed(8)}`);
  }
  lines.push('');
  lines.push('## 8. Semantic quality scores');
  for (const run of report.runs) {
    lines.push(`- ${run.fixture_id} | ${run.strategy} | run ${run.run_number}`);
    for (const dimension of run.quality_dimensions) {
      lines.push(`  - ${dimension.dimension}: ${dimension.grade} (${dimension.score}/${dimension.max_score})`);
    }
  }
  lines.push('');
  lines.push('## 9. Missing/incorrect facts');
  for (const run of report.runs) {
    const failing = run.quality_dimensions.filter((dimension) => dimension.grade !== 'PASS');
    if (failing.length === 0) {
      lines.push(`- ${run.fixture_id} | ${run.strategy} | run ${run.run_number}: none`);
      continue;
    }
    lines.push(`- ${run.fixture_id} | ${run.strategy} | run ${run.run_number}: ${failing.map((dimension) => `${dimension.dimension}:${dimension.grade}`).join(', ')}`);
  }
  lines.push('');
  lines.push('## 10. Unsupported claims');
  for (const run of report.runs) {
    const unsupported = run.quality_dimensions.find((dimension) => dimension.dimension === 'unnecessary_assumptions');
    lines.push(`- ${run.fixture_id} | ${run.strategy} | run ${run.run_number}: ${unsupported?.grade ?? 'UNKNOWN'}`);
  }
  lines.push('');
  lines.push('## 11. Progressive disclosure behavior');
  lines.push('- Sequential strategy records actual chosen tool sequence per run without forcing all tools.');
  lines.push('');
  lines.push('## 12. Sequential vs batched comparison');
  for (const aggregate of report.strategy_aggregates) {
    lines.push(`- ${aggregate.strategy}: provider_calls_avg=${aggregate.provider_calls_avg}, input_tokens_avg=${aggregate.input_tokens_avg}, duplicated_tool_result_bytes_avg=${aggregate.duplicated_tool_result_bytes_avg}`);
  }
  lines.push('');
  lines.push('## 13. Quality/cost tradeoff');
  lines.push('- Use the summary table and per-dimension grades to balance analytical quality against input token and replay cost.');
  lines.push('');
  lines.push('## Summary Table');
  lines.push('| Strategy | Quality (pass/partial/fail by dimension) | Input Tokens Avg | Output Tokens Avg | Cost Avg | Tool Calls Avg | Provider Calls Avg | Retransmission Avg (bytes) | Notes |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const aggregate of report.strategy_aggregates) {
    const dimSummary = Object.entries(aggregate.quality_dimension_summary)
      .map(([dimension, counts]) => `${dimension}:P${counts.pass}/Pa${counts.partial}/F${counts.fail}/U${counts.unresolved}`)
      .join('; ');
    lines.push(`| ${aggregate.strategy} | ${dimSummary} | ${aggregate.input_tokens_avg} | ${aggregate.output_tokens_avg} | ${aggregate.cost_avg === null ? 'UNAVAILABLE' : aggregate.cost_avg.toFixed(8)} | n/a | ${aggregate.provider_calls_avg} | ${aggregate.duplicated_tool_result_bytes_avg} | ${aggregate.notes} |`);
  }
  lines.push('');
  lines.push('## Architectural Conclusion');
  lines.push(`1. Sequential quality advantage: ${report.architecture_conclusions.sequential_quality_advantage}`);
  lines.push(`2. Batching quality impact: ${report.architecture_conclusions.batching_quality_impact}`);
  lines.push(`3. Batching safe situations: ${report.architecture_conclusions.batching_safe_situations}`);
  lines.push(`4. Sequential preferred situations: ${report.architecture_conclusions.sequential_preferred_situations}`);
  lines.push(`5. Retransmission justification for Evidence Session: ${report.architecture_conclusions.retransmission_justification}`);
  lines.push(`6. Recommended direction: ${report.architecture_conclusions.recommended_direction}`);
  lines.push(`7. Hybrid deterministic rules: ${report.architecture_conclusions.hybrid_rules_if_applicable.join(' | ')}`);

  return `${lines.join('\n')}\n`;
}

function computeStrategyAggregates(runs: RunResult[]): StrategyAggregate[] {
  const grouped = new Map<StrategyId, RunResult[]>();
  for (const run of runs) {
    const list = grouped.get(run.strategy) ?? [];
    list.push(run);
    grouped.set(run.strategy, list);
  }

  const ordered: StrategyId[] = ['SEQUENTIAL_PROGRESSIVE', 'BATCHED', 'CONTROL_CURRENT'];
  return ordered.map((strategy) => {
    const strategyRuns = grouped.get(strategy) ?? [];
    const qualityDimensionSummary: StrategyAggregate['quality_dimension_summary'] = {
      glucose_trajectory: { pass: 0, partial: 0, fail: 0, unresolved: 0 },
      insulin_evidence: { pass: 0, partial: 0, fail: 0, unresolved: 0 },
      basal_evidence: { pass: 0, partial: 0, fail: 0, unresolved: 0 },
      cross_domain_relationship: { pass: 0, partial: 0, fail: 0, unresolved: 0 },
      unknown_semantics: { pass: 0, partial: 0, fail: 0, unresolved: 0 },
      provenance_grounding: { pass: 0, partial: 0, fail: 0, unresolved: 0 },
      final_conclusion: { pass: 0, partial: 0, fail: 0, unresolved: 0 },
      unnecessary_assumptions: { pass: 0, partial: 0, fail: 0, unresolved: 0 },
    };

    for (const run of strategyRuns) {
      for (const dimension of run.quality_dimensions) {
        if (dimension.grade === 'PASS') {
          qualityDimensionSummary[dimension.dimension].pass += 1;
        } else if (dimension.grade === 'PARTIAL') {
          qualityDimensionSummary[dimension.dimension].partial += 1;
        } else if (dimension.grade === 'UNRESOLVED') {
          qualityDimensionSummary[dimension.dimension].unresolved += 1;
        } else {
          qualityDimensionSummary[dimension.dimension].fail += 1;
        }
      }
    }

    return {
      strategy,
      runs: strategyRuns.length,
      provider_calls_avg: average(strategyRuns.map((run) => run.provider_call_count)),
      input_tokens_avg: average(strategyRuns.map((run) => run.usage_sum.input_tokens)),
      output_tokens_avg: average(strategyRuns.map((run) => run.usage_sum.output_tokens)),
      total_tokens_avg: average(strategyRuns.map((run) => run.usage_sum.total_tokens)),
      total_request_bytes_avg: average(strategyRuns.map((run) => run.serialized_request_bytes_sum)),
      tool_result_bytes_avg: average(strategyRuns.map((run) => run.tool_result_bytes_sum)),
      duplicated_tool_result_bytes_avg: average(strategyRuns.map((run) => run.duplicated_tool_result_bytes)),
      cost_avg: strategyRuns.some((run) => run.provider_cost_sum === null)
        ? null
        : average(strategyRuns.map((run) => run.provider_cost_sum ?? 0)),
      quality_dimension_summary: qualityDimensionSummary,
      notes: strategy === 'SEQUENTIAL_PROGRESSIVE'
        ? 'Progressive retrieval; tool path determined by prior evidence.'
        : strategy === 'BATCHED'
          ? 'All three tools returned in one retrieval turn.'
          : 'Current production single-tool control.',
    };
  });
}

function buildArchitectureConclusions(aggregates: StrategyAggregate[]): TimeRangeQualityCostExperimentReport['architecture_conclusions'] {
  const sequential = aggregates.find((entry) => entry.strategy === 'SEQUENTIAL_PROGRESSIVE');
  const batched = aggregates.find((entry) => entry.strategy === 'BATCHED');

  const seqFails = sequential
    ? Object.values(sequential.quality_dimension_summary).reduce((sum, counts) => sum + counts.fail, 0)
    : 0;
  const batchedFails = batched
    ? Object.values(batched.quality_dimension_summary).reduce((sum, counts) => sum + counts.fail, 0)
    : 0;

  const seqAdvantage = seqFails < batchedFails
    ? 'Sequential showed lower deterministic failure count in this harness.'
    : seqFails === batchedFails
      ? 'No deterministic quality advantage detected for sequential in this harness.'
      : 'Sequential showed higher deterministic failure count in this harness.';

  const batchImpact = batchedFails > seqFails
    ? 'Batching reduced cost but introduced quality losses on at least one dimension.'
    : batchedFails === seqFails
      ? 'Batching did not lose deterministic quality in this fixture set.'
      : 'Batching outperformed sequential on deterministic quality in this fixture set.';

  const retransmissionHigh = (sequential?.duplicated_tool_result_bytes_avg ?? 0) > (batched?.duplicated_tool_result_bytes_avg ?? 0);

  return {
    sequential_quality_advantage: seqAdvantage,
    batching_quality_impact: batchImpact,
    batching_safe_situations: 'When deterministic rubric dimensions remain PASS/PARTIAL and no forbidden claims are introduced.',
    sequential_preferred_situations: 'When fixture semantics are conditional and later tool relevance depends on earlier findings.',
    retransmission_justification: retransmissionHigh
      ? 'Yes. Sequential replay overhead is measurably larger and justifies future Evidence Session exploration.'
      : 'Not from this run alone. Replay overhead was not materially larger.',
    recommended_direction: 'HYBRID_ADAPTIVE',
    hybrid_rules_if_applicable: [
      'Batch when all required domains are known upfront by request type and fixture profile.',
      'Use sequential when unknown/confounder semantics require conditional evidence expansion.',
      'Abort batching for profiles with strict provenance or uncertainty-sensitive conclusions.',
    ],
  };
}

async function runSingle(args: {
  fixture: TimeRangeFixture;
  strategy: StrategyId;
  runNumber: number;
}): Promise<RunResult> {
  const provider = new ExperimentProvider(args.fixture, args.strategy, args.runNumber);
  const gateway = new AiGatewayService(provider);

  const contextPackage = args.fixture.context;
  const task = createConversationTimeRangeAnalysisTask({
    task_id: `${args.fixture.fixture_id}-${args.strategy}-${args.runNumber}`,
    context_package_id: String(contextPackage.context_package_id),
    context_package_version: String(contextPackage.context_package_version),
    context_package_hash: String(contextPackage.content_hash),
    correlation_id: `${args.fixture.fixture_id}-${args.strategy}`,
    created_at: '2026-10-08T12:20:00.000Z',
    patient_id: args.fixture.patient_id,
  });

  const previousMainFlag = process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
  process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = '1';

  try {
    const execution = await gateway.execute({
      task,
      context_package: contextPackage as any,
      timeout_ms: 3000,
    });

    const calls = provider.calls;
    const usage = summarizeUsage(calls);
    const replay = computeToolReplay(calls);
    const toolSequence = (execution.metadata.evidence_tool_calls ?? []).map((entry) => entry.tool_name);

    const assistantMessage = String((execution.result as { assistant_message: string }).assistant_message ?? '');
    const qualityDimensions = evaluateTimeRangeQualityRubric(assistantMessage, args.fixture);

    const costEntries = calls.map((call) => call.estimated_cost?.estimated_cost).filter((value): value is number => typeof value === 'number');
    const providerCostSum = costEntries.length === calls.length
      ? Number(costEntries.reduce((sum, value) => sum + value, 0).toFixed(8))
      : null;

    return {
      fixture_id: args.fixture.fixture_id,
      fixture_version: args.fixture.fixture_version,
      strategy: args.strategy,
      run_number: args.runNumber,
      model: MODEL_NAME,
      task_type: TASK_TYPE,
      provider_calls: calls,
      provider_call_count: calls.length,
      usage_sum: usage,
      serialized_request_bytes_sum: calls.reduce((sum, call) => sum + call.request_bytes, 0),
      tool_result_bytes_sum: replay.total,
      duplicated_tool_result_bytes: replay.duplicated,
      provider_cost_sum: providerCostSum,
      tool_call_count: toolSequence.length,
      tool_sequence: toolSequence,
      assistant_message: assistantMessage,
      quality_dimensions: qualityDimensions,
    };
  } finally {
    if (previousMainFlag === undefined) {
      delete process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
    } else {
      process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = previousMainFlag;
    }
  }
}

export async function runTimeRangeQualityCostExperiment(options: ExperimentOptions): Promise<TimeRangeQualityCostExperimentReport> {
  const fixtures = createTimeRangeQualityCostFixtures();
  const strategies: StrategyId[] = ['SEQUENTIAL_PROGRESSIVE', 'BATCHED', 'CONTROL_CURRENT'];
  const runs: RunResult[] = [];

  for (const fixture of fixtures) {
    for (const strategy of strategies) {
      for (let runNumber = 1; runNumber <= options.runs_per_strategy; runNumber += 1) {
        runs.push(await runSingle({ fixture, strategy, runNumber }));
      }
    }
  }

  const aggregates = computeStrategyAggregates(runs);
  const report: TimeRangeQualityCostExperimentReport = {
    report_version: 'time-range-quality-cost-experiment.v1',
    generated_at: new Date().toISOString(),
    model: MODEL_NAME,
    task: TASK_TYPE,
    run_count_per_strategy: options.runs_per_strategy,
    fixtures,
    strategies: [
      {
        id: 'SEQUENTIAL_PROGRESSIVE',
        description: 'Model requests tools progressively based on earlier tool outputs.',
      },
      {
        id: 'BATCHED',
        description: 'Model receives glucose+insulin+basal tool outputs in one retrieval turn.',
      },
      {
        id: 'CONTROL_CURRENT',
        description: 'Current single-tool control path with glucose tool only.',
      },
    ],
    runs,
    strategy_aggregates: aggregates,
    architecture_conclusions: buildArchitectureConclusions(aggregates),
    limitations: [
      'Provider in this harness is deterministic and synthetic; token and cost figures are provider-reported simulation values.',
      'Deterministic rubric is first-layer judge; no secondary LLM-only judge is used for pass/fail.',
    ],
  };

  const outputJson = options.output_json_path ?? resolve(process.cwd(), 'artifacts/evaluation/time-range-quality-cost-experiment.json');
  const outputMd = options.output_md_path ?? resolve(process.cwd(), 'artifacts/evaluation/time-range-quality-cost-experiment.md');
  writeEvalArtifact(outputJson, `${JSON.stringify(report, null, 2)}\n`);
  writeEvalArtifact(outputMd, toMarkdown(report));

  return report;
}

function cloneContext(context: TimeRangeAnalysisContextRecord): TimeRangeAnalysisContextRecord {
  return JSON.parse(JSON.stringify(context)) as TimeRangeAnalysisContextRecord;
}

function canonicalHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function stripHistoricalEvidence(context: TimeRangeAnalysisContextRecord): Record<string, unknown> {
  const clone = cloneContext(context) as unknown as Record<string, unknown>;
  delete clone.historical_evidence;
  // content_hash naturally differs between ON/OFF variants once history is toggled;
  // remove it to assert payload equality on semantic input fields.
  delete clone.content_hash;
  return clone;
}

function toHistoricalEvidence(summary: HistoricalContextEvidenceSummary, scenarioId: string): NonNullable<TimeRangeAnalysisContextRecord['historical_evidence']> {
  return {
    historical_context_result_version: 'history-evaluation.synthetic.v1',
    retrieval_run_id: `${scenarioId}-history-run`,
    retrieval_timestamp: '2026-10-08T12:00:00.000Z',
    selection_policy_version: 'history-evaluation.synthetic.v1',
    current_reference_id: `${scenarioId}-current-reference`,
    selected_cases: [
      {
        case_reference: {
          summary: summary.summary,
          case_count: summary.case_count,
          source_refs: summary.source_refs,
        },
        therapy_relevance: {
          historical_icr_status: summary.therapy_resolution_context?.status ?? 'UNAVAILABLE',
          note: summary.therapy_resolution_context?.evidence_note ?? 'No therapy-resolution annotation available.',
        },
      },
    ],
    retrieval_status: 'SUCCESS',
    provenance: {
      policy_version: 'history-evaluation.synthetic.v1',
      retrieval_timestamp: '2026-10-08T12:00:00.000Z',
      retrieval_run_id: `${scenarioId}-history-run`,
    },
  };
}

class DeterministicHistoryComparisonProvider implements AiProvider {
  readonly history_evaluation_provider_kind = 'deterministic' as const;
  readonly history_evaluation_real_model_used = false as const;

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    const payload = JSON.parse(input.prompt.user_payload) as Record<string, unknown>;
    const analyticalEvidence = (payload.analytical_evidence ?? {}) as Record<string, unknown>;
    const mealEvents = Array.isArray(analyticalEvidence.meal_events)
      ? analyticalEvidence.meal_events as Array<Record<string, unknown>>
      : [];
    const insulinEvents = Array.isArray(analyticalEvidence.insulin_treatment_events)
      ? analyticalEvidence.insulin_treatment_events as Array<Record<string, unknown>>
      : [];
    const activityEvents = Array.isArray(analyticalEvidence.activity_events)
      ? analyticalEvidence.activity_events as Array<Record<string, unknown>>
      : [];

    const historicalEvidence = (payload.historical_evidence ?? null) as Record<string, unknown> | null;
    const selectedCases = Array.isArray(historicalEvidence?.selected_cases)
      ? historicalEvidence?.selected_cases as Array<Record<string, unknown>>
      : [];
    const firstCase = selectedCases[0] ?? null;
    const therapyRelevance = (firstCase?.therapy_relevance ?? {}) as Record<string, unknown>;
    const historicalIcrStatus = String(therapyRelevance.historical_icr_status ?? 'UNAVAILABLE').toUpperCase();

    const hasMissingMacros = mealEvents.some((event) => {
      const payloadRecord = (event.payload ?? {}) as Record<string, unknown>;
      return !('protein_grams' in payloadRecord) || !('fat_grams' in payloadRecord) || !('fiber_grams' in payloadRecord);
    });
    const hasLaterMealOrConfounder = mealEvents.length > 1 || activityEvents.length > 0;

    const lines: string[] = [
      `provider-generated summary for ${input.task.task_id}.`,
      `Current evidence reviewed: insulin events=${insulinEvents.length}, meal events=${mealEvents.length}, activity events=${activityEvents.length}.`,
      'Insulin timing may contribute, but attribution to a single meal is not confirmed.',
      'Provenance and uncertainty are preserved; unknowns remain explicitly unknown.',
    ];

    if (hasMissingMacros) {
      lines.push('Meal macro composition is missing/unknown and is not treated as zero values.');
    }
    if (hasLaterMealOrConfounder) {
      lines.push('Later meals and confounding factors are considered in interpretation.');
    }

    if (historicalEvidence) {
      lines.push('Prior similar patterns were considered as supplemental clinical context.');
      if (historicalIcrStatus === 'NON_CONFIRMED' || historicalIcrStatus === 'UNAVAILABLE') {
        lines.push('Historical ICR signal is not confirmed at event-time and is not promoted to certainty.');
      }
      if (historicalIcrStatus === 'CONFIRMED') {
        lines.push('Historical therapy pattern is supportive, while current-episode causality remains bounded by available evidence.');
      }
      const caseCount = Number(((firstCase?.case_reference ?? {}) as Record<string, unknown>).case_count ?? 0);
      if (caseCount === 0) {
        lines.push('No comparable prior pattern was available for this episode.');
      }
    } else {
      lines.push('No comparable prior pattern was available for this episode.');
    }

    return {
      provider: 'deterministic-history-comparison-provider',
      model: MODEL_NAME,
      response_id: `resp-${input.task.task_id}`,
      raw_output: {
        assistant_message: lines.join(' '),
      },
      received_at: new Date().toISOString(),
      usage: null,
      estimated_cost: null,
      serialized_input_bytes: bytes(input),
      provider_latency_ms: null,
    };
  }
}

function resolveProviderOrigin(provider: AiProvider): {
  provider_kind: HistoryComparisonVariantResult['provider_kind'];
  real_model_used: boolean | null;
} {
  if (provider instanceof DeterministicHistoryComparisonProvider) {
    return {
      provider_kind: 'deterministic',
      real_model_used: false,
    };
  }

  const typedProvider = provider as Partial<{
    history_evaluation_provider_kind: 'deterministic' | 'test' | 'live' | 'unknown';
    history_evaluation_real_model_used: boolean | null;
  }>;

  if (typedProvider.history_evaluation_provider_kind === 'deterministic') {
    return {
      provider_kind: 'deterministic',
      real_model_used: typedProvider.history_evaluation_real_model_used ?? false,
    };
  }

  if (typedProvider.history_evaluation_provider_kind === 'test') {
    return {
      provider_kind: 'test',
      real_model_used: typedProvider.history_evaluation_real_model_used ?? false,
    };
  }

  if (typedProvider.history_evaluation_provider_kind === 'live') {
    return {
      provider_kind: 'live',
      real_model_used: typedProvider.history_evaluation_real_model_used ?? true,
    };
  }

  if (typedProvider.history_evaluation_provider_kind === 'unknown') {
    return {
      provider_kind: 'unknown',
      real_model_used: typedProvider.history_evaluation_real_model_used ?? null,
    };
  }

  return {
    provider_kind: 'unknown',
    real_model_used: null,
  };
}

class RecordingAiProvider implements AiProvider {
  readonly capturedInputs: AiProviderInput[] = [];
  readonly capturedOutputs: AiProviderResponse[] = [];

  constructor(private readonly delegate: AiProvider) {}

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    this.capturedInputs.push(JSON.parse(JSON.stringify(input)) as AiProviderInput);
    const output = await this.delegate.generate(input);
    this.capturedOutputs.push(JSON.parse(JSON.stringify(output)) as AiProviderResponse);
    return output;
  }
}

function detectTimeRangeContractRuleId(errorMessage: string): string {
  if (errorMessage === 'Time-range analysis exposes internal context machinery') {
    return 'time_range_internal_context_exposure';
  }
  if (errorMessage === 'Time-range analysis conflates historical context with today observed facts') {
    return 'time_range_historical_today_conflation';
  }
  if (errorMessage === 'Time-range analysis states no activity instead of missing activity evidence') {
    return 'time_range_ambiguous_no_activity';
  }
  return 'unknown';
}

function findRuleExcerpt(args: {
  ruleId: string;
  assistantMessage: string;
}): string | null {
  const patternsByRule: Record<string, RegExp[]> = {
    time_range_ambiguous_no_activity: [
      /\bbrak\s+aktywno(?:ś|s)ci(?:\s+w\s+danych)?\b/i,
      /\bno\s+activity\b/i,
    ],
    time_range_internal_context_exposure: [
      /odnotowano\s+w\s+opisach\s+kontekstowych/i,
      /w\s+opisach\s+kontekstowych/i,
      /wcze(?:ś|s)niej\s+odpowiedzia(?:łeś|las|łaś)/i,
      /w\s+poprzednim\s+pytaniu\s+poda(?:łeś|las|łaś)/i,
      /odpowiedzia(?:łeś|las|łaś),\s*(?:ż|z)e/i,
      /zebrany\s+kontekst\s+wskazuje/i,
      /(?:^|\s)(?:fakt|aktywno(?:ść|sc)|spadek|hipo|posi(?:ł|l)ek|insulin(?:a|y|ę))[^.]{0,90}(?:by(?:ł|l|ła|la|ło|lo|li)?\s+)?zgłoszon(?:a|e|y)?(?:\s|[.,;:]|$)/i,
      /\b(?:stored\s+as\s+context|contextual\s+descriptions|remembered\s+by\s+the\s+system)\b/i,
      /\b(?:reported|recorded|collected|answered|provided)\b[^.]{0,100}\b(?:in|from|via|through)\b[^.]{0,100}\b(?:context|contextual\s+descriptions?|previous\s+answers?|previous\s+questions?|questionnaire|investigation\s+flow|memory)\b/i,
    ],
    time_range_historical_today_conflation: [
      /(?:dzisiaj|dzisiejsz\w*)[^.]{0,140}(?:bo|poniewa(?:ż|z)|na\s+podstawie)[^.]{0,140}(?:wcze(?:ś|s)niej|podobn\w*|historyczn\w*)/i,
    ],
  };

  const patterns = patternsByRule[args.ruleId] ?? [];
  for (const pattern of patterns) {
    const match = pattern.exec(args.assistantMessage);
    if (!match || match.index < 0) {
      continue;
    }

    const start = Math.max(0, match.index - 40);
    const end = Math.min(args.assistantMessage.length, match.index + match[0].length + 40);
    return args.assistantMessage
      .slice(start, end)
      .replace(/\s+/g, ' ')
      .trim();
  }

  return null;
}

function buildContractViolationDiagnostics(args: {
  error: AiExecutionError;
  providerOutputs: AiProviderResponse[];
}): {
  validator_rule_id: string;
  validated_field: 'assistant_message';
  redacted_excerpt: string | null;
  full_assistant_message_local_debug?: string;
} | undefined {
  if (args.error.code !== 'AI_CONTRACT_VIOLATION') {
    return undefined;
  }

  const ruleId = detectTimeRangeContractRuleId(args.error.message);
  const providerText = args.providerOutputs
    .map((output) => output.raw_output)
    .map((raw) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { assistant_message?: unknown }).assistant_message : undefined))
    .find((message) => typeof message === 'string');
  const assistantMessage = (providerText ?? '') as string;

  const includeFullAssistantMessage = process.env.AI_EVAL_INCLUDE_FULL_ASSISTANT_MESSAGE === '1';

  return {
    validator_rule_id: ruleId,
    validated_field: 'assistant_message',
    redacted_excerpt: assistantMessage
      ? findRuleExcerpt({ ruleId, assistantMessage })
      : null,
    ...(includeFullAssistantMessage && assistantMessage
      ? { full_assistant_message_local_debug: assistantMessage }
      : {}),
  };
}

function evaluateHistoryComparisonCriteria(args: {
  message: string;
  variant: HistoryComparisonVariant;
  scenario: HistoryComparisonScenario;
}): HistoryComparisonVariantResult['quality']['criteria'] {
  const text = normalizeForGrading(args.message);
  const includesAny = (patterns: RegExp[]) => patterns.some((pattern) => pattern.test(text));

  const criteria: HistoryComparisonVariantResult['quality']['criteria'] = [];

  const hasHistorySignal = includesAny([/\bhistorical\b/, /\bprior\b/, /\bsimilar\b/]);
  criteria.push({
    criterion_id: 'history_information_usefulness',
    grade: args.variant === 'history_on'
      ? (args.scenario.quality_expectations.history_expected_to_help
        ? (hasHistorySignal ? 'PASS' : 'FAIL')
        : (hasHistorySignal ? 'PARTIAL' : 'PASS'))
      : 'NOT_APPLICABLE',
    note: args.variant === 'history_on'
      ? 'Checks whether historical information was materially represented in the response.'
      : 'OFF variant is baseline without historical evidence.',
  });

  criteria.push({
    criterion_id: 'uncertainty_and_provenance',
    grade: includesAny([/\bunknown\b/, /\bmissing\b/, /\buncertain\b/, /\bprovenance\b/]) ? 'PASS' : 'PARTIAL',
    note: 'Checks that uncertainty/provenance language is preserved.',
  });

  const mentionsMacroUnknown = includesAny([/macro/, /protein/, /fat/, /fiber/]) && includesAny([/unknown/, /missing/, /not treated as zero/]);
  const wrongMacroZero = includesAny([/protein\s*[:=]\s*0\b/, /fat\s*[:=]\s*0\b/, /fiber\s*[:=]\s*0\b/, /treated as zero/]) && !includesAny([/not treated as zero/]);
  criteria.push({
    criterion_id: 'missing_macros_not_zero',
    grade: !args.scenario.quality_expectations.should_flag_missing_macros
      ? 'NOT_APPLICABLE'
      : wrongMacroZero
        ? 'FAIL'
        : mentionsMacroUnknown
          ? 'PASS'
          : 'PARTIAL',
    note: 'Checks that missing macro values are not converted to zero.',
  });

  criteria.push({
    criterion_id: 'later_meals_or_confounders',
    grade: !args.scenario.quality_expectations.should_flag_later_meal_or_confounders
      ? 'NOT_APPLICABLE'
      : includesAny([/later meal/, /confound/, /activity/, /illness/, /stress/])
        ? 'PASS'
        : 'PARTIAL',
    note: 'Checks whether later meals/confounders are acknowledged when expected.',
  });

  const forcedAttribution = includesAny([/solely due to insulin/, /only insulin caused/, /definitive insulin cause/]);
  criteria.push({
    criterion_id: 'no_forced_insulin_meal_attribution',
    grade: args.scenario.quality_expectations.should_avoid_forced_insulin_meal_attribution
      ? (forcedAttribution ? 'FAIL' : 'PASS')
      : 'NOT_APPLICABLE',
    note: 'Checks that insulin-to-meal attribution is not forced beyond evidence.',
  });

  const historicalIcrPromoted = includesAny([/historical icr.*confirmed at event-time/, /historical icr is confirmed/]);
  const historicalIcrGuarded = includesAny([/historical icr.*not confirmed/, /not promoted to certainty/]);
  criteria.push({
    criterion_id: 'unconfirmed_historical_icr_not_promoted',
    grade: !args.scenario.quality_expectations.has_unconfirmed_historical_icr_risk
      ? 'NOT_APPLICABLE'
      : historicalIcrPromoted
        ? 'FAIL'
        : historicalIcrGuarded
          ? 'PASS'
          : 'PARTIAL',
    note: 'Checks guardrail: unconfirmed historical ICR must not be promoted to event-time certainty.',
  });

  const noHelpSignal = includesAny([/did not add a comparable prior signal/, /history did not materially change/]);
  criteria.push({
    criterion_id: 'history_no_help_or_harm_signal',
    grade: args.scenario.quality_expectations.history_expected_to_help
      ? 'NOT_APPLICABLE'
      : noHelpSignal
        ? 'PASS'
        : 'PARTIAL',
    note: 'Checks explicit handling for scenarios where history is not useful.',
  });

  return criteria;
}

function toHistoryUsage(value: AiExecutionResult['metadata']['context_package_usage']): HistoryComparisonUsage | null {
  if (!value) {
    return null;
  }
  return {
    total_serialized_bytes: value.total_serialized_bytes,
    sections: value.sections,
  };
}

function normalizeProviderInputForInvariant(input: AiProviderInput): { normalized: Record<string, unknown>; normalized_fields: string[] } {
  const normalized = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  const normalizedFields: string[] = [];

  const task = (normalized.task ?? {}) as Record<string, unknown>;
  if ('context_package_hash' in task) {
    task.context_package_hash = '__DERIVED_CONTEXT_HASH__';
    normalizedFields.push('task.context_package_hash');
  }

  const contextPackage = (normalized.context_package ?? {}) as Record<string, unknown>;
  if ('content_hash' in contextPackage) {
    contextPackage.content_hash = '__DERIVED_CONTEXT_HASH__';
    normalizedFields.push('context_package.content_hash');
  }
  if ('historical_evidence' in contextPackage) {
    delete contextPackage.historical_evidence;
    normalizedFields.push('context_package.historical_evidence');
  }

  const prompt = (normalized.prompt ?? {}) as Record<string, unknown>;
  if (typeof prompt.user_payload === 'string') {
    try {
      const userPayload = JSON.parse(prompt.user_payload) as Record<string, unknown>;
      if ('historical_evidence' in userPayload) {
        delete userPayload.historical_evidence;
        normalizedFields.push('prompt.user_payload.historical_evidence');
      }
      prompt.user_payload = canonicalJson(userPayload);
    } catch {
      // Keep payload unchanged if it cannot be parsed as JSON.
    }
  }

  return { normalized, normalized_fields: normalizedFields };
}

function collectDiffPaths(a: unknown, b: unknown, basePath = ''): string[] {
  if (a === b) {
    return [];
  }

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray || bIsArray) {
    if (!aIsArray || !bIsArray) {
      return [basePath || '<root>'];
    }
    const diffs: string[] = [];
    if ((a as unknown[]).length !== (b as unknown[]).length) {
      diffs.push(basePath ? `${basePath}.length` : 'length');
    }
    const max = Math.max((a as unknown[]).length, (b as unknown[]).length);
    for (let i = 0; i < max; i += 1) {
      const next = collectDiffPaths((a as unknown[])[i], (b as unknown[])[i], `${basePath}[${i}]`);
      diffs.push(...next);
    }
    return diffs;
  }

  const aIsObject = typeof a === 'object' && a !== null;
  const bIsObject = typeof b === 'object' && b !== null;
  if (!aIsObject || !bIsObject) {
    return [basePath || '<root>'];
  }

  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(aRecord), ...Object.keys(bRecord)]);
  const diffs: string[] = [];
  for (const key of keys) {
    const keyPath = basePath ? `${basePath}.${key}` : key;
    if (!(key in aRecord) || !(key in bRecord)) {
      diffs.push(keyPath);
      continue;
    }
    diffs.push(...collectDiffPaths(aRecord[key], bRecord[key], keyPath));
  }
  return diffs;
}

function computePairwiseCriterionDelta(args: {
  historyOff: HistoryComparisonVariantResult;
  historyOn: HistoryComparisonVariantResult;
}): HistoryCriterionDelta[] {
  const criterionIds: Array<HistoryCriterionDelta['criterion_id']> = [
    'history_information_usefulness',
    'uncertainty_and_provenance',
    'missing_macros_not_zero',
    'later_meals_or_confounders',
    'no_forced_insulin_meal_attribution',
    'unconfirmed_historical_icr_not_promoted',
    'history_no_help_or_harm_signal',
  ];

  const gradeRank: Record<'PASS' | 'PARTIAL' | 'FAIL', number> = {
    PASS: 2,
    PARTIAL: 1,
    FAIL: 0,
  };

  const byId = (criteria: HistoryComparisonVariantResult['quality']['criteria']) => new Map(criteria.map((entry) => [entry.criterion_id, entry]));
  const offMap = byId(args.historyOff.quality.criteria);
  const onMap = byId(args.historyOn.quality.criteria);

  return criterionIds.map((criterionId) => {
    const off = offMap.get(criterionId);
    const on = onMap.get(criterionId);
    const offGrade = off?.grade ?? 'MISSING';
    const onGrade = on?.grade ?? 'MISSING';

    if (args.historyOff.status !== 'SUCCEEDED' || args.historyOn.status !== 'SUCCEEDED') {
      return { criterion_id: criterionId, off_grade: offGrade, on_grade: onGrade, delta: 'not_comparable' };
    }

    if (offGrade === 'MISSING' || onGrade === 'MISSING' || offGrade === 'NOT_APPLICABLE' || onGrade === 'NOT_APPLICABLE') {
      return { criterion_id: criterionId, off_grade: offGrade, on_grade: onGrade, delta: 'not_comparable' };
    }

    const diff = gradeRank[onGrade] - gradeRank[offGrade];
    if (diff > 0) {
      return { criterion_id: criterionId, off_grade: offGrade, on_grade: onGrade, delta: 'improve' };
    }
    if (diff < 0) {
      return { criterion_id: criterionId, off_grade: offGrade, on_grade: onGrade, delta: 'degrade' };
    }
    return { criterion_id: criterionId, off_grade: offGrade, on_grade: onGrade, delta: 'no_change' };
  });
}

async function executeHistoryVariant(args: {
  scenario: HistoryComparisonScenario;
  variant: HistoryComparisonVariant;
  contextPackage: TimeRangeAnalysisContextRecord;
  provider: AiProvider;
  providerOrigin: ReturnType<typeof resolveProviderOrigin>;
  timeoutMs: number;
  groundTruth: TimeRangeEvidenceGroundTruth;
}): Promise<HistoryComparisonVariantResult & { provider_input_capture: HistoryComparisonProviderInputCapture }> {
  const recordingProvider = new RecordingAiProvider(args.provider);
  const toolCallCount = () => recordingProvider.capturedOutputs
    .reduce((sum, output) => sum + (output.tool_calls?.length ?? (output.tool_call ? 1 : 0)), 0);
  const gateway = new AiGatewayService(recordingProvider);
  const contextHash = canonicalHash(args.contextPackage);
  const task = createConversationTimeRangeAnalysisTask({
    task_id: `${args.scenario.scenario_id}-paired`,
    context_package_id: args.contextPackage.context_package_id,
    context_package_version: args.contextPackage.context_package_version,
    context_package_hash: contextHash,
    correlation_id: `history-comparison-${args.scenario.scenario_id}`,
    created_at: args.contextPackage.created_at,
    patient_id: args.contextPackage.patient_ref.patient_id,
  });

  try {
    const execution = await gateway.execute({
      task,
      context_package: {
        ...args.contextPackage,
        content_hash: contextHash,
      },
      timeout_ms: args.timeoutMs,
    });

    const assistantMessage = String((execution.result as { assistant_message?: unknown }).assistant_message ?? '');
    return {
      variant: args.variant,
      status: 'SUCCEEDED',
      assistant_message: assistantMessage,
      execution_path: 'AiGatewayService.execute',
      provider_kind: args.providerOrigin.provider_kind,
      real_model_used: args.providerOrigin.real_model_used,
      provider: execution.metadata.provider,
      model: execution.metadata.model,
      prompt_version: execution.metadata.prompt_version,
      output_schema_version: execution.metadata.output_schema_version,
      usage: execution.metadata.usage ?? null,
      estimated_cost: execution.metadata.estimated_cost ?? null,
      provider_latency_ms: execution.metadata.provider_latency_ms ?? null,
      serialized_input_bytes: execution.metadata.serialized_input_bytes ?? null,
      context_package_usage: toHistoryUsage(execution.metadata.context_package_usage ?? null),
      quality: {
        evaluation_mode: 'HEURISTIC_RULE_BASED',
        evaluation_method: 'heuristic_text',
        clinical_validation: 'none',
        grading_limitations: [
          'Criteria are regex/text-pattern based and may miss semantic nuance.',
          'Scores reflect heuristic matching, not objective clinical truth.',
          'Some criteria are gated by scenario quality_expectations metadata.',
        ],
        criteria: evaluateHistoryComparisonCriteria({
          message: assistantMessage,
          variant: args.variant,
          scenario: args.scenario,
        }),
      },
      // v2 grades claims (negation, bound times, ratios, causal kinds); v1 stays exported as the reference.
      evidence_rubric: gradeTimeRangeAnswerV2(assistantMessage, args.groundTruth),
      evidence_availability: assessEvidenceAvailability(args.groundTruth, JSON.stringify(recordingProvider.capturedInputs)),
      tool_call_count: toolCallCount(),
      error: null,
      provider_input_capture: {
        call_count: recordingProvider.capturedInputs.length,
        all_call_inputs: recordingProvider.capturedInputs,
      },
    };
  } catch (error) {
    const diagnostics = error instanceof AiExecutionError
      ? buildContractViolationDiagnostics({
        error,
        providerOutputs: recordingProvider.capturedOutputs,
      })
      : undefined;

    return {
      variant: args.variant,
      status: 'FAILED',
      assistant_message: '',
      execution_path: 'AiGatewayService.execute',
      provider_kind: args.providerOrigin.provider_kind,
      real_model_used: args.providerOrigin.real_model_used,
      provider: null,
      model: null,
      prompt_version: null,
      output_schema_version: null,
      usage: null,
      estimated_cost: null,
      provider_latency_ms: null,
      serialized_input_bytes: null,
      context_package_usage: null,
      quality: {
        evaluation_mode: 'HEURISTIC_RULE_BASED',
        evaluation_method: 'heuristic_text',
        clinical_validation: 'none',
        grading_limitations: [
          'Variant failed before scoring; criteria are unavailable.',
          'Heuristic rubric is not a clinical validation method.',
        ],
        criteria: [],
      },
      evidence_rubric: null,
      evidence_availability: null,
      tool_call_count: toolCallCount(),
      error: {
        code: error instanceof AiExecutionError ? error.code : 'UNEXPECTED_ERROR',
        message: error instanceof Error ? error.message : 'Unexpected non-error failure.',
        diagnostics,
      },
      provider_input_capture: {
        call_count: recordingProvider.capturedInputs.length,
        all_call_inputs: recordingProvider.capturedInputs,
      },
    };
  }
}

export function createHistoryComparisonScenarios(): HistoryComparisonScenario[] {
  const baseScenarios: Array<{
    scenario_id: string;
    name: string;
    description: string;
    historical_evidence: HistoricalContextEvidenceSummary | null;
    expectations: HistoryComparisonScenario['quality_expectations'];
  }> = [
    {
      scenario_id: 'history-pair-01',
      name: 'Missed meal with delayed bolus',
      description: 'Recorded L1 low (09:42-10:02) after a 38 g meal at 09:02 and a 1.6 U bolus at 09:08; history describes similar delayed-bolus lows.',
      historical_evidence: {
        summary: 'Three prior similar sessions with delayed meal and bolus overlap produced mild-to-moderate lows within 90 minutes.',
        case_count: 3,
        source_refs: ['history/session-101', 'history/session-129', 'history/session-153'],
        therapy_resolution_context: {
          status: 'CONFIRMED',
          evidence_note: 'Historical therapy evidence confirms timing consistency with delayed meal + bolus pattern.',
        },
      },
      expectations: {
        should_flag_missing_macros: true,
        should_flag_later_meal_or_confounders: true,
        should_avoid_forced_insulin_meal_attribution: true,
        has_unconfirmed_historical_icr_risk: false,
        history_expected_to_help: true,
      },
    },
    {
      scenario_id: 'history-pair-02',
      name: 'Basal over-delivery',
      description: 'History suggests basal drift; the current range has no basal or temp-basal data, so a basal mismatch cannot be observed.',
      historical_evidence: {
        summary: 'Previous basal trend analysis showed elevated overnight basal caused recurrent low excursions after a rate increase.',
        case_count: 2,
        source_refs: ['history/session-211', 'history/session-298'],
        therapy_resolution_context: {
          status: 'CONFIRMED',
          evidence_note: 'Historical therapy evidence supports basal rate drift as a repeatable antecedent.',
        },
      },
      expectations: {
        should_flag_missing_macros: true,
        should_flag_later_meal_or_confounders: true,
        should_avoid_forced_insulin_meal_attribution: true,
        has_unconfirmed_historical_icr_risk: false,
        history_expected_to_help: true,
      },
    },
    {
      scenario_id: 'history-pair-03',
      name: 'Exercise-induced recovery',
      description: 'A walk is recorded at 10:10, after the low ended; history links activity to lows, but no causal link is established here.',
      historical_evidence: {
        summary: 'Prior days with morning activity showed low glucose recoveries after exercise load without insulin miscalculation.',
        case_count: 4,
        source_refs: ['history/session-375', 'history/session-411', 'history/session-447', 'history/session-480'],
        therapy_resolution_context: {
          status: 'NON_CONFIRMED',
          evidence_note: 'Historical context increases confidence but does not confirm causality from therapy timing alone.',
        },
      },
      expectations: {
        should_flag_missing_macros: true,
        should_flag_later_meal_or_confounders: true,
        should_avoid_forced_insulin_meal_attribution: true,
        has_unconfirmed_historical_icr_risk: true,
        history_expected_to_help: true,
      },
    },
    {
      scenario_id: 'history-pair-04',
      name: 'Uncertain carb estimate',
      description: 'Carbs are recorded (38 g, 18 g) without protein or fat; history describes rough carb estimates with the same low pattern.',
      historical_evidence: {
        summary: 'Similar meals with rough carb estimates consistently resemble the same low pattern but continue to show uncertainty.',
        case_count: 3,
        source_refs: ['history/session-520', 'history/session-554', 'history/session-583'],
        therapy_resolution_context: {
          status: 'UNAVAILABLE',
          evidence_note: 'Historical context is available but insufficient to prove the exact carb amount.',
        },
      },
      expectations: {
        should_flag_missing_macros: true,
        should_flag_later_meal_or_confounders: true,
        should_avoid_forced_insulin_meal_attribution: true,
        has_unconfirmed_historical_icr_risk: true,
        history_expected_to_help: true,
      },
    },
    {
      scenario_id: 'history-pair-05',
      name: 'Stress and illness signal',
      description: 'History mentions illness/stress-related lows; the current range has no illness or stress record.',
      historical_evidence: {
        summary: 'Earlier illness or stress events show an elevated probability of low but not a direct causal link in this episode.',
        case_count: 2,
        source_refs: ['history/session-602', 'history/session-647'],
        therapy_resolution_context: {
          status: 'NON_CONFIRMED',
          evidence_note: 'Historical context is suggestive, but not a confirmed event-time causal proof.',
        },
      },
      expectations: {
        should_flag_missing_macros: true,
        should_flag_later_meal_or_confounders: true,
        should_avoid_forced_insulin_meal_attribution: true,
        has_unconfirmed_historical_icr_risk: true,
        history_expected_to_help: true,
      },
    },
    {
      scenario_id: 'history-pair-06',
      name: 'Insulin stacking from separate boluses',
      description: 'History describes insulin stacking; the current range has a single 1.6 U bolus, so stacking is not observed.',
      historical_evidence: {
        summary: 'Earlier insulin-stacking patterns were associated with rapid lows when two boluses were administered within 45 minutes.',
        case_count: 5,
        source_refs: ['history/session-700', 'history/session-742', 'history/session-780', 'history/session-801', 'history/session-833'],
        therapy_resolution_context: {
          status: 'CONFIRMED',
          evidence_note: 'Historical evidence confirms the pattern as a repeatable risk factor for this therapy combination.',
        },
      },
      expectations: {
        should_flag_missing_macros: true,
        should_flag_later_meal_or_confounders: true,
        should_avoid_forced_insulin_meal_attribution: true,
        has_unconfirmed_historical_icr_risk: false,
        history_expected_to_help: true,
      },
    },
    {
      scenario_id: 'history-pair-07',
      name: 'No historical signal',
      description: 'The current episode is isolated; history is weak or non-informative.',
      historical_evidence: {
        summary: 'No similar prior episodes were found in the relevant time window and profile match is weak.',
        case_count: 0,
        source_refs: [],
        therapy_resolution_context: {
          status: 'UNAVAILABLE',
          evidence_note: 'No comparable historical record was available for this episode.',
        },
      },
      expectations: {
        should_flag_missing_macros: true,
        should_flag_later_meal_or_confounders: true,
        should_avoid_forced_insulin_meal_attribution: true,
        has_unconfirmed_historical_icr_risk: true,
        history_expected_to_help: false,
      },
    },
  ];

  return baseScenarios.map((scenario) => {
    const baseContext: TimeRangeAnalysisContextRecord = {
      context_package_id: `${scenario.scenario_id}-cp`,
      context_package_version: 'conversation-time-range-context.v1',
      content_hash: `sha256:${scenario.scenario_id}`,
      created_at: '2026-10-08T12:00:00.000Z',
      patient_ref: { patient_id: `patient-${scenario.scenario_id}` },
      analysis_request_input: {
        user_message_id: `${scenario.scenario_id}-msg`,
        user_message_text: 'Please explain likely contributors and uncertainty for this range.',
        range_type: 'TODAY',
        timezone: 'Europe/Warsaw',
        range_start: '2026-10-08T09:00:00.000Z',
        range_end: '2026-10-08T12:30:00.000Z',
        requested_at: '2026-10-08T12:30:00.000Z',
      },
      conversation_context: {
        thread_id: `thread-${scenario.scenario_id}`,
        thread_state_version: `${scenario.scenario_id}-thread-v1`,
        awaiting_user_answer: false,
        messages: [
          {
            message_id: `${scenario.scenario_id}-m1`,
            role: 'USER',
            created_at: '2026-10-08T12:30:00.000Z',
            // The neutral request only: scenario descriptions are evaluator metadata, not user-reported facts.
            content: 'Please explain likely contributors and uncertainty for this range.',
            provenance_ref: `${scenario.scenario_id}/conversation/m1`,
          },
        ],
      },
      current_state_snapshot: {
        as_of: '2026-10-08T12:30:00.000Z',
        current_glucose: 96,
        trend: 'FLAT',
        iob: 0.4,
      },
      // v2: events in the worker's projection ({ event_id, type, occurred_at, payload, source_record_id }) with the
      // Nightscout normalizer's payload fields; summaries and missing_sections computed as the worker computes them.
      analytical_evidence: {
        glucose_events: [
          { event_id: `${scenario.scenario_id}-g1`, type: 'GLUCOSE_READING_AVAILABLE', occurred_at: '2026-10-08T09:12:00.000Z', payload: { glucose_value: 128, glucose_unit: 'mg/dL' }, source_record_id: `${scenario.scenario_id}-sr-g1` },
          { event_id: `${scenario.scenario_id}-g2`, type: 'GLUCOSE_READING_AVAILABLE', occurred_at: '2026-10-08T09:42:00.000Z', payload: { glucose_value: 67, glucose_unit: 'mg/dL' }, source_record_id: `${scenario.scenario_id}-sr-g2` },
          { event_id: `${scenario.scenario_id}-g3`, type: 'GLUCOSE_READING_AVAILABLE', occurred_at: '2026-10-08T10:02:00.000Z', payload: { glucose_value: 92, glucose_unit: 'mg/dL' }, source_record_id: `${scenario.scenario_id}-sr-g3` },
        ],
        insulin_treatment_events: [
          { event_id: `${scenario.scenario_id}-i1`, type: 'BOLUS', occurred_at: '2026-10-08T09:08:00.000Z', payload: { insulin_units: 1.6, source_event_type: 'Bolus' }, source_record_id: `${scenario.scenario_id}-sr-i1` },
        ],
        // v1 had this meal at 08:55, before the range; it stays before the bolus (meal 09:02, bolus 09:08).
        meal_events: [
          { event_id: `${scenario.scenario_id}-m1`, type: 'CARB_ENTRY', occurred_at: '2026-10-08T09:02:00.000Z', payload: { carbs: 38, source_event_type: 'Carb Correction' }, source_record_id: `${scenario.scenario_id}-sr-m1` },
          { event_id: `${scenario.scenario_id}-m2`, type: 'CARB_ENTRY', occurred_at: '2026-10-08T10:25:00.000Z', payload: { carbs: 18, source_event_type: 'Carb Correction' }, source_record_id: `${scenario.scenario_id}-sr-m2` },
        ],
        // The worker selects activity by type ACTIVITY with payload.activity_type; no normalizer produces it yet.
        activity_events: [
          { event_id: `${scenario.scenario_id}-a1`, type: 'ACTIVITY', occurred_at: '2026-10-08T10:10:00.000Z', payload: { activity_type: 'WALKING' }, source_record_id: `${scenario.scenario_id}-sr-a1` },
        ],
        // Declared explicitly, consistent with hypo.cgm.ada2026.v1: opened by the 67 mg/dL reading (L1: 54-69),
        // closed by the next reading >= 70 (92 mg/dL). Fields as the worker projects hypo_episodes.
        hypo_episodes: [
          { episode_id: `${scenario.scenario_id}-hypo1`, state: 'CLOSED', severity: 'L1', started_at: '2026-10-08T09:42:00.000Z', ended_at: '2026-10-08T10:02:00.000Z', trigger_id: `${scenario.scenario_id}-trigger1` },
        ],
        range_event_facts: [],
        summaries: {
          total_events: 7,
          glucose_count: 3,
          insulin_treatment_count: 1,
          meal_count: 2,
          activity_count: 1,
          hypo_episode_count: 1,
          glucose_min: 67,
          glucose_max: 128,
          glucose_avg: 95.67,
          missing_sections: [],
        },
      },
      provenance: {
        source_refs: ['synthetic-history-eval'],
        selection_policy_version: 'conversation-time-range-selector.v1',
      },
    };

    return {
      scenario_id: scenario.scenario_id,
      source_kind: 'SYNTHETIC' as const,
      fixture_version: HISTORY_COMPARISON_FIXTURE_VERSION,
      name: scenario.name,
      description: scenario.description,
      base_context: {
        ...baseContext,
        content_hash: canonicalHash(baseContext),
      },
      historical_evidence: scenario.historical_evidence,
      quality_expectations: scenario.expectations,
    };
  });
}

export async function runHistoryEvidenceComparisonScenario(
  scenario: HistoryComparisonScenario,
  options: HistoryComparisonExperimentOptions = {},
): Promise<HistoryEvidenceComparisonResult> {
  const provider = options.provider ?? new DeterministicHistoryComparisonProvider();
  const providerOrigin = resolveProviderOrigin(provider);
  const timeoutMs = options.timeout_ms ?? 15_000;

  let historyOffContext = cloneContext(scenario.base_context);
  let historyOnContext = cloneContext(scenario.base_context);
  historyOnContext.historical_evidence = scenario.historical_evidence
    ? toHistoricalEvidence(scenario.historical_evidence, scenario.scenario_id)
    : null;

  if (options.context_mutator) {
    historyOffContext = options.context_mutator({
      scenario,
      variant: 'history_off',
      context: historyOffContext,
    });
    historyOnContext = options.context_mutator({
      scenario,
      variant: 'history_on',
      context: historyOnContext,
    });
  }

  const derivedContextHash = canonicalHash(stripHistoricalEvidence(historyOffContext));
  historyOffContext.content_hash = derivedContextHash;
  historyOnContext.content_hash = derivedContextHash;

  const offStripped = stripHistoricalEvidence(historyOffContext);
  const onStripped = stripHistoricalEvidence(historyOnContext);
  const baseStripped = stripHistoricalEvidence(scenario.base_context);

  // Ground truth from the scenario's own current evidence; historical evidence is not observed data for the range.
  const groundTruth = buildTimeRangeEvidenceGroundTruth({
    scenario_id: scenario.scenario_id,
    fixture_version: scenario.fixture_version,
    context: scenario.base_context,
  });

  const historyOff = await executeHistoryVariant({
    scenario,
    variant: 'history_off',
    contextPackage: historyOffContext,
    provider,
    providerOrigin,
    timeoutMs,
    groundTruth,
  });

  const historyOn = await executeHistoryVariant({
    scenario,
    variant: 'history_on',
    contextPackage: historyOnContext,
    provider,
    providerOrigin,
    timeoutMs,
    groundTruth,
  });

  const offInputs = historyOff.provider_input_capture.all_call_inputs;
  const onInputs = historyOn.provider_input_capture.all_call_inputs;
  const strictHashesOff = offInputs.map((entry) => canonicalHash(entry));
  const strictHashesOn = onInputs.map((entry) => canonicalHash(entry));

  const offNormalizedInputs = offInputs.map((entry) => normalizeProviderInputForInvariant(entry));
  const onNormalizedInputs = onInputs.map((entry) => normalizeProviderInputForInvariant(entry));
  const normalizedHashesOff = offNormalizedInputs.map((entry) => canonicalHash(entry.normalized));
  const normalizedHashesOn = onNormalizedInputs.map((entry) => canonicalHash(entry.normalized));

  const strictDiffPaths = collectDiffPaths(offInputs, onInputs);
  const normalizedDiffPaths = collectDiffPaths(
    offNormalizedInputs.map((entry) => entry.normalized),
    onNormalizedInputs.map((entry) => entry.normalized),
  );

  const inputInvariant: HistoryComparisonInputInvariant = {
    strict_input_invariant: {
      source: 'provider_generate_all_calls',
      off_call_count: offInputs.length,
      on_call_count: onInputs.length,
      strict_hashes_off: strictHashesOff,
      strict_hashes_on: strictHashesOn,
      differing_fields: strictDiffPaths,
      identical: offInputs.length === 0 || onInputs.length === 0
        ? 'unknown'
        : strictHashesOff.length === strictHashesOn.length
          && strictHashesOff.every((hash, index) => hash === strictHashesOn[index]),
    },
    normalized_input_invariant: {
      source: 'provider_generate_all_calls',
      normalized_fields: Array.from(new Set([
        ...offNormalizedInputs.flatMap((entry) => entry.normalized_fields),
        ...onNormalizedInputs.flatMap((entry) => entry.normalized_fields),
      ])).sort(),
      normalized_hashes_off: normalizedHashesOff,
      normalized_hashes_on: normalizedHashesOn,
      differing_fields_before_normalization: strictDiffPaths,
      differing_fields_after_normalization: normalizedDiffPaths,
      identical: offInputs.length === 0 || onInputs.length === 0
        ? 'unknown'
        : normalizedHashesOff.length === normalizedHashesOn.length
          && normalizedHashesOff.every((hash, index) => hash === normalizedHashesOn[index]),
    },
    without_history_hash_off: canonicalHash(offStripped),
    without_history_hash_on: canonicalHash(onStripped),
    identical_without_history: canonicalHash(offStripped) === canonicalHash(onStripped),
    history_off_preserves_current_evidence: canonicalHash(offStripped) === canonicalHash(baseStripped),
  };

  const qualityPairwiseDelta = computePairwiseCriterionDelta({
    historyOff,
    historyOn,
  });

  return {
    scenario_id: scenario.scenario_id,
    scenario_name: scenario.name,
    source_kind: scenario.source_kind,
    pair_status: historyOff.status === 'SUCCEEDED' && historyOn.status === 'SUCCEEDED' ? 'COMPLETE' : 'INCOMPLETE',
    input_invariant: inputInvariant,
    history_off: historyOff,
    history_on: historyOn,
    quality_pairwise_delta: qualityPairwiseDelta,
    evidence_ground_truth: {
      rubric_version: groundTruth.rubric_version,
      fixture_version: groundTruth.fixture_version,
      criteria: Object.fromEntries(Object.entries(groundTruth.criteria)
        .map(([criterionId, entry]) => [criterionId, { status: entry.status, missing_evidence: entry.missing_evidence }])) as HistoryEvidenceComparisonResult['evidence_ground_truth']['criteria'],
      anomalies: groundTruth.anomalies,
    },
    // A failed variant has no rubric, so every criterion of that pair is not_comparable.
    evidence_rubric_delta: compareRubricEvaluations(
      historyOff.status === 'SUCCEEDED' ? historyOff.evidence_rubric : null,
      historyOn.status === 'SUCCEEDED' ? historyOn.evidence_rubric : null,
    ),
  };
}

export async function runHistoryEvidenceComparisonExperiment(
  options: HistoryComparisonExperimentOptions = {},
): Promise<HistoryEvidenceComparisonExperimentReport> {
  const scenarios = createHistoryComparisonScenarios();
  const runs = await Promise.all(scenarios.map((scenario) => runHistoryEvidenceComparisonScenario(scenario, options)));

  const completePairs = runs.filter((entry) => entry.pair_status === 'COMPLETE');
  const failedVariants = runs.reduce((sum, entry) => sum
    + (entry.history_off.status === 'FAILED' ? 1 : 0)
    + (entry.history_on.status === 'FAILED' ? 1 : 0), 0);

  const metricsAvailability = {
    usage_tokens_pairs: completePairs.filter((entry) =>
      typeof entry.history_off.usage?.total_tokens === 'number'
      && typeof entry.history_on.usage?.total_tokens === 'number').length,
    estimated_cost_pairs: completePairs.filter((entry) =>
      typeof entry.history_off.estimated_cost?.estimated_cost === 'number'
      && typeof entry.history_on.estimated_cost?.estimated_cost === 'number').length,
    provider_latency_pairs: completePairs.filter((entry) => entry.history_off.provider_latency_ms !== null && entry.history_on.provider_latency_ms !== null).length,
    context_size_pairs: completePairs.filter((entry) => entry.history_off.context_package_usage !== null && entry.history_on.context_package_usage !== null).length,
  };

  const pairwiseDeltaSummary = runs
    .flatMap((entry) => entry.quality_pairwise_delta)
    .reduce((acc, entry) => {
      acc[entry.delta] += 1;
      return acc;
    }, {
      improve: 0,
      degrade: 0,
      no_change: 0,
      not_comparable: 0,
    });

  return {
    report_version: 'history-evidence-comparison.v1',
    generated_at: new Date().toISOString(),
    scenarios: runs,
    summary: {
      total_pairs: runs.length,
      complete_pairs: completePairs.length,
      incomplete_pairs: runs.length - completePairs.length,
      failed_variants: failedVariants,
      metrics_availability: metricsAvailability,
      pairwise_delta_summary: pairwiseDeltaSummary,
      evidence_rubric_version: TIME_RANGE_EVIDENCE_RUBRIC_V2_VERSION,
      evidence_rubric_delta_summary: runs
        .flatMap((entry) => entry.evidence_rubric_delta)
        .reduce((acc, entry) => {
          acc[entry.delta] += 1;
          return acc;
        }, { improve: 0, degrade: 0, no_change: 0, not_comparable: 0 }),
    },
    limitations: [
      'Scenario source_kind is SYNTHETIC for all pairs; no real Nightscout replay representativeness is claimed.',
      'Automated quality grading is heuristic/rule-based and does not establish objective clinical truth.',
      'Provider-reported usage/cost/latency may be unavailable depending on provider implementation.',
    ],
    evaluation_notes: {
      synthetic_data_only: true,
      model_as_judge_used: false,
      objective_truth_claimed: false,
    },
  };
}
