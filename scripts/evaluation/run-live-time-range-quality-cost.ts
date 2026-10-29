import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTimeRangeQualityCostFixtures,
  evaluateTimeRangeQualityRubric,
  type QualityDimensionResult,
  type StrategyId,
  type TimeRangeFixture,
} from '@modules/ai-gateway/evaluation/time-range-quality-cost-experiment';
import { OpenAiProvider } from '@modules/ai-gateway/infrastructure/openai-provider';
import { resolveOpenAiCostGuardFromEnv } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { createConversationTimeRangeAnalysisTask } from '@modules/ai-gateway/application/ai-task';
import type { AiProviderInput, AiProviderResponse, AIUsage, AICostEstimate } from '@modules/ai-gateway/domain/ai-gateway';
import { buildTimeRangeAnalysisEvidenceToolPrompt } from '@modules/ai-gateway/application/time-range-analysis-prompt';
import { buildInitialEvidenceView, createEvidenceToolRegistry } from '@modules/evidence-tools';
import { canonicalJson } from '@shared/utils/canonical-json';

interface LiveToolCallRecord {
  sequence: number;
  tool_name: string;
  arguments: Record<string, unknown>;
  refinement_kind: 'INITIAL' | 'IDENTICAL' | 'REFINED_RANGE' | 'REFINED_DETAIL' | 'DIFFERENT_SELECTION';
}

interface LiveProviderCall {
  call_number: number;
  request_bytes: number;
  request_fingerprint: string | null;
  usage: AIUsage | null;
  estimated_cost: AICostEstimate | null;
  supplied_tool_results: Array<{
    tool_name: string;
    call_id: string;
    result_hash: string;
    result_bytes: number;
  }>;
}

type RunFailureStage =
  | 'BEFORE_PROVIDER_CALL'
  | 'PROVIDER_REQUEST'
  | 'PROVIDER_RESPONSE'
  | 'TOOL_CALL_PARSE'
  | 'TOOL_EXECUTION'
  | 'NEXT_PROVIDER_TURN'
  | 'FINAL_RESPONSE'
  | 'OUTPUT_VALIDATION'
  | 'UNKNOWN';

interface ProviderAttemptRecord {
  attempt_number: number;
  stage: RunFailureStage | null;
  response_id: string | null;
  output_item_types: string[];
  function_call_names: string[];
  function_call_count: number;
  function_call_arguments: Array<Record<string, unknown>>;
  has_output_text: boolean;
  http_status: number | null;
  error_name: string | null;
  error_type: string | null;
  error_code: string | null;
  error_message: string | null;
  retryable: boolean | null;
}

interface LiveRunResult {
  run_id: string;
  fixture_id: string;
  fixture_version: string;
  strategy: 'SEQUENTIAL_PROGRESSIVE' | 'BATCHED';
  run_number: number;
  status: 'COMPLETED' | 'FAILED';
  failure_reason: string | null;
  model: string;
  prompt_version: string;
  output_schema_version: string;
  provider_call_count: number;
  provider_calls: LiveProviderCall[];
  provider_attempts: ProviderAttemptRecord[];
  failure_stage: RunFailureStage;
  tool_sequence: string[];
  tool_calls: LiveToolCallRecord[];
  assistant_message: string | null;
  usage_sum: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
  };
  cost_sum: number | null;
  serialized_request_bytes_sum: number;
  tool_result_bytes_sum: number;
  duplicated_tool_result_bytes: number;
  quality_dimensions: QualityDimensionResult[];
}

interface LiveExperimentReport {
  report_version: 'time-range-live-quality-cost.v1';
  generated_at: string;
  model: string;
  runs_per_strategy: number;
  fixtures: Array<{ fixture_id: string; fixture_version: string; description: string }>;
  strategies: Array<'SEQUENTIAL_PROGRESSIVE' | 'BATCHED'>;
  planned_runs: number;
  max_possible_provider_calls: number;
  completed_runs: number;
  failed_runs: number;
  total_live_provider_calls: number;
  runs: LiveRunResult[];
  aggregate: Record<string, unknown>;
  synthetic_comparison: {
    replicated: string[];
    not_replicated: string[];
    uncertain: string[];
  };
  architecture_conclusion: {
    outcome: 'SEQUENTIAL_PREFERRED' | 'BATCHED_PREFERRED' | 'HYBRID_ADAPTIVE' | 'INSUFFICIENT_EVIDENCE';
    answers: Array<{ question: string; answer: string }>;
    recommended_next_experiment: string;
  };
}

function mustEnableLiveRun(): void {
  if (process.env.AI_RUN_LIVE_EVALUATION !== '1') {
    throw new Error('AI_RUN_LIVE_EVALUATION=1 is required. Live provider evaluation is opt-in only.');
  }
}

function parseRunsPerStrategy(): number {
  const raw = process.env.AI_LIVE_RUNS_PER_STRATEGY?.trim();
  if (!raw) {
    return 2;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2) {
    throw new Error('AI_LIVE_RUNS_PER_STRATEGY must be an integer in [1, 2].');
  }
  return parsed;
}

function parseTimeoutMs(): number {
  const parsed = Number(process.env.OPENAI_TIMEOUT_MS ?? '30000');
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('OPENAI_TIMEOUT_MS must be a positive integer.');
  }
  return parsed;
}

function parseNullablePrice(value: string | undefined): number | null {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.length) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseNullableText(value: string | undefined): string | null {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function createProvider(): OpenAiProvider {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for live evaluation.');
  }

  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-terra';
  const timeoutMs = parseTimeoutMs();

  const pricing = {
    input_per_1k_tokens: parseNullablePrice(process.env.OPENAI_PRICING_INPUT_PER_1K_TOKENS),
    output_per_1k_tokens: parseNullablePrice(process.env.OPENAI_PRICING_OUTPUT_PER_1K_TOKENS),
    cached_input_per_1k_tokens: parseNullablePrice(process.env.OPENAI_PRICING_CACHED_INPUT_PER_1K_TOKENS),
    reasoning_per_1k_tokens: parseNullablePrice(process.env.OPENAI_PRICING_REASONING_PER_1K_TOKENS),
    currency: parseNullableText(process.env.OPENAI_PRICING_CURRENCY),
    pricing_version: parseNullableText(process.env.OPENAI_PRICING_VERSION),
  };
  const hasFullPricing = Object.values(pricing).every((value) => value !== null);

  // The real client needs the cost guard and the durable experiment budget; resolve throws when they are missing.
  const guard = resolveOpenAiCostGuardFromEnv(process.env);
  return new OpenAiProvider({
    apiKey,
    model,
    timeoutMs,
    pricing: hasFullPricing ? pricing : guard.pricing,
    costGuard: guard.costGuard,
    budgetLedger: guard.budgetLedger,
  });
}

function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function buildEvidenceToolContext(fixture: TimeRangeFixture): Record<string, unknown> {
  const context = fixture.context;
  const analyticalEvidence = (context.analytical_evidence ?? {}) as Record<string, unknown>;
  const glucoseEvents = Array.isArray(analyticalEvidence.glucose_events) ? analyticalEvidence.glucose_events : [];

  const glucoseEvidence = glucoseEvents.map((event, index) => {
    const record = event as Record<string, unknown>;
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const observedAt = String(record.occurred_at ?? record.observed_at ?? fixture.range_start);
    return {
      reading_id: String(record.event_id ?? `g-${index + 1}`),
      source_record_id: String(record.event_id ?? `g-${index + 1}`),
      observed_at: observedAt,
      recorded_at: observedAt,
      glucose_value: Number(payload.glucose_value ?? payload.sgv ?? 0),
      glucose_unit: 'mg/dL',
      classification: 'UNKNOWN',
      relation_to_episode: 'LATEST',
      validity: 'VALID',
      provenance_ref: String(record.provenance_ref ?? record.event_id ?? `source-record/g-${index + 1}`),
    };
  });

  return {
    patient_ref: context.patient_ref,
    glucose_evidence: glucoseEvidence,
    insulin_treatment_events: analyticalEvidence.insulin_treatment_events ?? [],
    treatment_events: analyticalEvidence.insulin_treatment_events ?? [],
    temp_basal_events: analyticalEvidence.insulin_treatment_events ?? [],
    current_state_snapshot: context.current_state_snapshot ?? null,
    active_therapy_snapshot: context.active_therapy_snapshot ?? null,
    event_context_facts: analyticalEvidence.range_event_facts ?? [],
  };
}

function buildAvailableToolDefinitions() {
  return [
    {
      name: 'get_glucose_evidence',
      description: 'Return deterministic semantic glucose evidence for a selected time range.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          time_range: {
            type: 'object',
            additionalProperties: false,
            properties: { from: { type: 'string' }, to: { type: 'string' } },
            required: ['from', 'to'],
          },
          detail_level: {
            type: 'string',
            enum: ['SUMMARY', 'SIGNIFICANT_EVENTS', 'DETAIL', 'TRAJECTORY'],
          },
        },
        required: ['time_range', 'detail_level'],
      },
    },
    {
      name: 'get_insulin_evidence',
      description: 'Return deterministic semantic insulin evidence for a selected time range.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          time_range: {
            type: 'object',
            additionalProperties: false,
            properties: { from: { type: 'string' }, to: { type: 'string' } },
            required: ['from', 'to'],
          },
          detail_level: {
            type: 'string',
            enum: ['SUMMARY', 'SIGNIFICANT_EVENTS', 'DETAIL'],
          },
        },
        required: ['time_range', 'detail_level'],
      },
    },
    {
      name: 'get_basal_evidence',
      description: 'Return deterministic semantic basal evidence for a selected time range.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          time_range: {
            type: 'object',
            additionalProperties: false,
            properties: { from: { type: 'string' }, to: { type: 'string' } },
            required: ['from', 'to'],
          },
          detail_level: {
            type: 'string',
            enum: ['SUMMARY', 'DETAIL'],
          },
        },
        required: ['time_range', 'detail_level'],
      },
    },
  ] as const;
}

function normalizeToolArguments(fixture: TimeRangeFixture, toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const fallbackRange = { from: fixture.range_start, to: fixture.range_end };
  const range = (args.time_range ?? {}) as Record<string, unknown>;
  const from = typeof range.from === 'string' ? range.from : fallbackRange.from;
  const to = typeof range.to === 'string' ? range.to : fallbackRange.to;

  const detailRaw = typeof args.detail_level === 'string' ? args.detail_level : 'SUMMARY';
  const allowed = toolName === 'get_glucose_evidence'
    ? new Set(['SUMMARY', 'SIGNIFICANT_EVENTS', 'DETAIL', 'TRAJECTORY'])
    : toolName === 'get_insulin_evidence'
      ? new Set(['SUMMARY', 'SIGNIFICANT_EVENTS', 'DETAIL'])
      : new Set(['SUMMARY', 'DETAIL']);
  const detailLevel = allowed.has(detailRaw) ? detailRaw : 'SUMMARY';

  return {
    time_range: { from, to },
    detail_level: detailLevel,
  };
}

function classifyRefinement(previous: Record<string, unknown> | null, current: Record<string, unknown>): LiveToolCallRecord['refinement_kind'] {
  if (!previous) {
    return 'INITIAL';
  }
  const prevCanonical = canonicalJson(previous);
  const currCanonical = canonicalJson(current);
  if (prevCanonical === currCanonical) {
    return 'IDENTICAL';
  }

  const prevRange = (previous.time_range ?? {}) as Record<string, unknown>;
  const currRange = (current.time_range ?? {}) as Record<string, unknown>;
  const prevDetail = String(previous.detail_level ?? '');
  const currDetail = String(current.detail_level ?? '');

  const rangeChanged = prevRange.from !== currRange.from || prevRange.to !== currRange.to;
  const detailChanged = prevDetail !== currDetail;

  if (rangeChanged && !detailChanged) {
    return 'REFINED_RANGE';
  }
  if (detailChanged && !rangeChanged) {
    return 'REFINED_DETAIL';
  }
  return 'DIFFERENT_SELECTION';
}

function summarizeUsage(calls: LiveProviderCall[]): LiveRunResult['usage_sum'] {
  return calls.reduce((acc, call) => ({
    input_tokens: acc.input_tokens + (call.usage?.input_tokens ?? 0),
    output_tokens: acc.output_tokens + (call.usage?.output_tokens ?? 0),
    cached_input_tokens: acc.cached_input_tokens + (call.usage?.cached_input_tokens ?? 0),
    reasoning_tokens: acc.reasoning_tokens + (call.usage?.reasoning_tokens ?? 0),
    total_tokens: acc.total_tokens + (call.usage?.total_tokens ?? 0),
  }), {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
  });
}

function summarizeToolReplay(calls: LiveProviderCall[]): { total: number; duplicated: number } {
  const seen = new Set<string>();
  let total = 0;
  let duplicated = 0;

  for (const call of calls) {
    for (const result of call.supplied_tool_results) {
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

function buildProviderAttemptDiagnostic(args: {
  attemptNumber: number;
  stage: RunFailureStage | null;
  response?: AiProviderResponse | null;
  error?: unknown;
}): ProviderAttemptRecord {
  const diagnostics = args.response?.diagnostics ?? null;
  const errorLike = args.error as { name?: unknown; type?: unknown; code?: unknown; message?: unknown; status?: unknown; retryable?: unknown; httpStatus?: unknown; errorName?: unknown; errorType?: unknown; errorCode?: unknown; errorMessage?: unknown } | undefined;

  return {
    attempt_number: args.attemptNumber,
    stage: args.stage,
    response_id: diagnostics?.response_id ?? null,
    output_item_types: diagnostics?.output_item_types ?? [],
    function_call_names: diagnostics?.function_call_names ?? [],
    function_call_count: diagnostics?.function_call_count ?? 0,
    function_call_arguments: diagnostics?.function_call_arguments ?? [],
    has_output_text: diagnostics?.has_output_text ?? false,
    http_status: diagnostics?.http_status ?? (typeof errorLike?.status === 'number' ? errorLike.status : null),
    error_name: diagnostics?.error_name ?? (typeof errorLike?.errorName === 'string' ? errorLike.errorName : typeof errorLike?.name === 'string' ? errorLike.name : null),
    error_type: diagnostics?.error_type ?? (typeof errorLike?.errorType === 'string' ? errorLike.errorType : typeof errorLike?.type === 'string' ? errorLike.type : null),
    error_code: diagnostics?.error_code ?? (typeof errorLike?.errorCode === 'string' ? errorLike.errorCode : typeof errorLike?.code === 'string' ? errorLike.code : null),
    error_message: diagnostics?.error_message ?? (typeof errorLike?.errorMessage === 'string' ? errorLike.errorMessage : typeof errorLike?.message === 'string' ? errorLike.message : null),
    retryable: diagnostics?.retryable ?? (typeof errorLike?.retryable === 'boolean' ? errorLike.retryable : null),
  };
}

function buildInitialEvidence(fixture: TimeRangeFixture) {
  const context = fixture.context;
  const analyticalEvidence = (context.analytical_evidence ?? {}) as Record<string, unknown>;
  const glucoseEvents = Array.isArray(analyticalEvidence.glucose_events) ? analyticalEvidence.glucose_events : [];
  const insulinEvents = Array.isArray(analyticalEvidence.insulin_treatment_events) ? analyticalEvidence.insulin_treatment_events : [];

  const significant = glucoseEvents.slice(0, 3).map((event) => {
    const record = event as Record<string, unknown>;
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    return {
      label: 'GLUCOSE_EVENT',
      start: String(record.occurred_at ?? fixture.range_start),
      end: String(record.occurred_at ?? fixture.range_start),
      minimum: Number(payload.glucose_value ?? payload.sgv ?? 0),
      maximum: Number(payload.glucose_value ?? payload.sgv ?? 0),
    };
  });

  const treatment = insulinEvents.slice(0, 2).map((event) => {
    const record = event as Record<string, unknown>;
    return {
      kind: String(record.kind ?? 'UNKNOWN'),
      occurred_at: String(record.occurred_at ?? fixture.range_start),
      amount: typeof record.amount === 'number' ? record.amount : null,
      unit: typeof record.unit === 'string' ? record.unit : 'U',
    };
  });

  return buildInitialEvidenceView({
    task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
    patient_id: fixture.patient_id,
    range: { from: fixture.range_start, to: fixture.range_end },
    current_state: {
      as_of: String((context.current_state_snapshot as Record<string, unknown> | undefined)?.as_of ?? fixture.range_end),
      current_glucose: Number((context.current_state_snapshot as Record<string, unknown> | undefined)?.current_glucose ?? 0),
      trend: String((context.current_state_snapshot as Record<string, unknown> | undefined)?.trend ?? 'UNKNOWN'),
    },
    significant_glucose_events: significant,
    known_treatment_events: treatment,
    evidence_capability_summary: ['glucose evidence available', 'insulin evidence available', 'basal evidence available'],
    provenance: {
      fixture_id: fixture.fixture_id,
      fixture_version: fixture.fixture_version,
    },
  });
}

function buildProviderInput(args: {
  fixture: TimeRangeFixture;
  strategy: 'SEQUENTIAL_PROGRESSIVE' | 'BATCHED';
  runNumber: number;
  previousResponseId?: string | null;
  toolResults: Array<{ call_id: string; tool_name: string; result: Record<string, unknown> }>;
  availableTools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  maxCallsRemaining: number;
}): AiProviderInput {
  const task = createConversationTimeRangeAnalysisTask({
    task_id: `live-${args.fixture.fixture_id}-${args.strategy}-${args.runNumber}`,
    context_package_id: String(args.fixture.context.context_package_id),
    context_package_version: String(args.fixture.context.context_package_version),
    context_package_hash: String(args.fixture.context.content_hash),
    correlation_id: `live-${args.fixture.fixture_id}-${args.strategy}`,
    created_at: new Date().toISOString(),
    patient_id: args.fixture.patient_id,
  });

  const initialEvidenceView = buildInitialEvidence(args.fixture);
  const prompt = buildTimeRangeAnalysisEvidenceToolPrompt({
    task,
    context: args.fixture.context as any,
    initialEvidenceView,
  });

  return {
    task,
    context_package: args.fixture.context as any,
    previous_response_id: args.previousResponseId ?? null,
    prompt,
    tool_runtime: {
      available_tools: args.availableTools,
      tool_results: args.toolResults,
      max_tool_calls_remaining: args.maxCallsRemaining,
    },
  };
}

async function runSequential(args: {
  fixture: TimeRangeFixture;
  runNumber: number;
  provider: OpenAiProvider;
  maxProviderCallsPerRun: number;
}): Promise<LiveRunResult> {
  const evidenceRegistry = createEvidenceToolRegistry();
  const evidenceContext = buildEvidenceToolContext(args.fixture);
  const toolResults: Array<{ call_id: string; tool_name: string; result: Record<string, unknown> }> = [];
  const toolCalls: LiveToolCallRecord[] = [];
  const previousByTool = new Map<string, Record<string, unknown>>();
  const providerCalls: LiveProviderCall[] = [];
  const providerAttempts: ProviderAttemptRecord[] = [];

  let finalAssistant: string | null = null;
  let failureReason: string | null = null;
  let failureStage: RunFailureStage = 'UNKNOWN';
  let previousResponseId: string | null = null;

  for (let callIndex = 1; callIndex <= args.maxProviderCallsPerRun; callIndex += 1) {
    const input = buildProviderInput({
      fixture: args.fixture,
      strategy: 'SEQUENTIAL_PROGRESSIVE',
      runNumber: args.runNumber,
      previousResponseId,
      toolResults,
      availableTools: [...buildAvailableToolDefinitions()],
      maxCallsRemaining: Math.max(0, args.maxProviderCallsPerRun - callIndex + 1),
    });

    let response: AiProviderResponse;
    try {
      response = await args.provider.generate(input);
      providerAttempts.push(buildProviderAttemptDiagnostic({
        attemptNumber: providerAttempts.length + 1,
        stage: 'PROVIDER_RESPONSE',
        response,
      }));
      previousResponseId = response.response_id ?? null;
      failureStage = 'PROVIDER_RESPONSE';
    } catch (error) {
      const attempt = buildProviderAttemptDiagnostic({
        attemptNumber: providerAttempts.length + 1,
        stage: 'PROVIDER_REQUEST',
        error,
      });
      providerAttempts.push(attempt);
      failureStage = attempt.stage ?? 'UNKNOWN';
      failureReason = attempt.error_message ?? (error instanceof Error ? error.message : String(error));
      break;
    }

    providerCalls.push({
      call_number: callIndex,
      request_bytes: response.serialized_input_bytes ?? byteLength(input),
      request_fingerprint: response.input_fingerprint ?? null,
      usage: response.usage ?? null,
      estimated_cost: response.estimated_cost ?? null,
      supplied_tool_results: toolResults.map((toolResult) => ({
        tool_name: toolResult.tool_name,
        call_id: toolResult.call_id,
        result_hash: typeof toolResult.result.content_hash === 'string' ? String(toolResult.result.content_hash) : hash(toolResult.result),
        result_bytes: byteLength(toolResult.result),
      })),
    });

    const requested = response.tool_calls ?? (response.tool_call ? [response.tool_call] : []);
    if (requested.length === 0) {
      finalAssistant = String((response.raw_output as Record<string, unknown> | null)?.assistant_message ?? '');
      failureStage = finalAssistant ? 'FINAL_RESPONSE' : 'OUTPUT_VALIDATION';
      break;
    }

    for (const toolCall of requested) {
      if (!toolCall || typeof toolCall.tool_name !== 'string') {
        continue;
      }
      if (toolCall.tool_name !== 'get_glucose_evidence' && toolCall.tool_name !== 'get_insulin_evidence' && toolCall.tool_name !== 'get_basal_evidence') {
        failureReason = `Unsupported tool requested in live run: ${toolCall.tool_name}`;
        failureStage = 'TOOL_CALL_PARSE';
        continue;
      }

      const normalized = normalizeToolArguments(args.fixture, toolCall.tool_name, toolCall.arguments ?? {});
      const previous = previousByTool.get(toolCall.tool_name) ?? null;
      const refinement = classifyRefinement(previous, normalized);
      previousByTool.set(toolCall.tool_name, normalized);

      toolCalls.push({
        sequence: toolCalls.length + 1,
        tool_name: toolCall.tool_name,
        arguments: normalized,
        refinement_kind: refinement,
      });

      const request = {
        tool: toolCall.tool_name,
        patient_id: args.fixture.patient_id,
        time_range: normalized.time_range as { from: string; to: string },
        detail_level: String(normalized.detail_level),
        task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
        constraints: { max_range_ms: 24 * 60 * 60 * 1000 },
      };
      try {
        const toolResponse = evidenceRegistry.execute(request as any, evidenceContext, {
          executionId: `live:${args.fixture.fixture_id}:${args.runNumber}`,
        });

        toolResults.push({
        call_id: toolCall.call_id,
        tool_name: toolCall.tool_name,
          result: {
            tool: toolResponse.tool,
            status: toolResponse.status,
            evidence: toolResponse.evidence,
            coverage: toolResponse.coverage,
            limitations: toolResponse.limitations,
            provenance: {
              request_hash: toolResponse.provenance.request_hash,
              compiler_version: toolResponse.provenance.compiler_version,
              evidence_version: toolResponse.provenance.evidence_version,
              source_refs: toolResponse.provenance.source_refs,
            },
            content_hash: toolResponse.content_hash,
          },
        });
      } catch (error) {
        failureStage = 'TOOL_EXECUTION';
        failureReason = error instanceof Error ? error.message : String(error);
        break;
      }
    }
  }

  if (!finalAssistant && !failureReason) {
    failureReason = `No final assistant response after ${args.maxProviderCallsPerRun} provider calls`;
    failureStage = 'FINAL_RESPONSE';
  }

  const usageSum = summarizeUsage(providerCalls);
  const replay = summarizeToolReplay(providerCalls);
  const costs = providerCalls
    .map((call) => call.estimated_cost?.estimated_cost)
    .filter((value): value is number => typeof value === 'number');

  return {
    run_id: `live-${args.fixture.fixture_id}-SEQUENTIAL_PROGRESSIVE-${args.runNumber}`,
    fixture_id: args.fixture.fixture_id,
    fixture_version: args.fixture.fixture_version,
    strategy: 'SEQUENTIAL_PROGRESSIVE',
    run_number: args.runNumber,
    status: finalAssistant ? 'COMPLETED' : 'FAILED',
    failure_reason: finalAssistant ? null : failureReason,
    model: process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-terra',
    prompt_version: 'conversation-time-range-analysis.v1',
    output_schema_version: 'conversation-direct-response-output.v1',
    provider_call_count: providerCalls.length,
    provider_calls: providerCalls,
    provider_attempts: providerAttempts,
    failure_stage: failureStage,
    tool_sequence: toolCalls.map((entry) => entry.tool_name),
    tool_calls: toolCalls,
    assistant_message: finalAssistant,
    usage_sum: usageSum,
    cost_sum: providerCalls.length > 0 && costs.length === providerCalls.length
      ? Number(costs.reduce((sum, value) => sum + value, 0).toFixed(8))
      : null,
    serialized_request_bytes_sum: providerCalls.reduce((sum, call) => sum + call.request_bytes, 0),
    tool_result_bytes_sum: replay.total,
    duplicated_tool_result_bytes: replay.duplicated,
    quality_dimensions: finalAssistant ? evaluateTimeRangeQualityRubric(finalAssistant, args.fixture) : [],
  };
}

export async function runBatched(args: {
  fixture: TimeRangeFixture;
  runNumber: number;
  provider: OpenAiProvider;
}): Promise<LiveRunResult> {
  const evidenceRegistry = createEvidenceToolRegistry();
  const evidenceContext = buildEvidenceToolContext(args.fixture);
  const providerCalls: LiveProviderCall[] = [];
  const providerAttempts: ProviderAttemptRecord[] = [];
  const toolCalls: LiveToolCallRecord[] = [];

  const preloadedToolResults: Array<{ call_id: string; tool_name: string; result: Record<string, unknown> }> = [];
  const turnOneInput = buildProviderInput({
    fixture: args.fixture,
    strategy: 'BATCHED',
    runNumber: args.runNumber,
    previousResponseId: null,
    toolResults: [],
    availableTools: [...buildAvailableToolDefinitions()],
    maxCallsRemaining: 3,
  });

  let turnOneResponse: AiProviderResponse;
  let failureStage: RunFailureStage = 'BEFORE_PROVIDER_CALL';
  try {
    turnOneResponse = await args.provider.generate(turnOneInput);
    providerAttempts.push(buildProviderAttemptDiagnostic({
      attemptNumber: providerAttempts.length + 1,
      stage: 'PROVIDER_RESPONSE',
      response: turnOneResponse,
    }));
    failureStage = 'PROVIDER_RESPONSE';
  } catch (error) {
    const attempt = buildProviderAttemptDiagnostic({
      attemptNumber: providerAttempts.length + 1,
      stage: 'PROVIDER_REQUEST',
      error,
    });
    providerAttempts.push(attempt);
    failureStage = attempt.stage ?? 'UNKNOWN';
    return {
      run_id: `live-${args.fixture.fixture_id}-BATCHED-${args.runNumber}`,
      fixture_id: args.fixture.fixture_id,
      fixture_version: args.fixture.fixture_version,
      strategy: 'BATCHED',
      run_number: args.runNumber,
      status: 'FAILED',
      failure_reason: attempt.error_message ?? (error instanceof Error ? error.message : String(error)),
      model: process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-terra',
      prompt_version: 'conversation-time-range-analysis.v1',
      output_schema_version: 'conversation-direct-response-output.v1',
      provider_call_count: 0,
      provider_calls: [],
      provider_attempts: providerAttempts,
      failure_stage: failureStage,
      tool_sequence: ['get_glucose_evidence', 'get_insulin_evidence', 'get_basal_evidence'],
      tool_calls: [],
      assistant_message: null,
      usage_sum: {
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 0,
      },
      cost_sum: null,
      serialized_request_bytes_sum: 0,
      tool_result_bytes_sum: 0,
      duplicated_tool_result_bytes: 0,
      quality_dimensions: [],
    };
  }

  providerCalls.push({
    call_number: 1,
    request_bytes: turnOneResponse.serialized_input_bytes ?? byteLength(turnOneInput),
    request_fingerprint: turnOneResponse.input_fingerprint ?? null,
    usage: turnOneResponse.usage ?? null,
    estimated_cost: turnOneResponse.estimated_cost ?? null,
    supplied_tool_results: [],
  });

  const requestedToolCalls = turnOneResponse.tool_calls ?? (turnOneResponse.tool_call ? [turnOneResponse.tool_call] : []);
  if (requestedToolCalls.length === 0) {
    return {
      run_id: `live-${args.fixture.fixture_id}-BATCHED-${args.runNumber}`,
      fixture_id: args.fixture.fixture_id,
      fixture_version: args.fixture.fixture_version,
      strategy: 'BATCHED',
      run_number: args.runNumber,
      status: 'FAILED',
      failure_reason: 'BATCHED strategy expected tool calls in turn 1 but received none.',
      model: process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-terra',
      prompt_version: 'conversation-time-range-analysis.v1',
      output_schema_version: 'conversation-direct-response-output.v1',
      provider_call_count: providerCalls.length,
      provider_calls: providerCalls,
      provider_attempts: providerAttempts,
      failure_stage: 'TOOL_CALL_PARSE',
      tool_sequence: ['get_glucose_evidence', 'get_insulin_evidence', 'get_basal_evidence'],
      tool_calls: toolCalls,
      assistant_message: null,
      usage_sum: summarizeUsage(providerCalls),
      cost_sum: null,
      serialized_request_bytes_sum: providerCalls.reduce((sum, call) => sum + call.request_bytes, 0),
      tool_result_bytes_sum: summarizeToolReplay(providerCalls).total,
      duplicated_tool_result_bytes: summarizeToolReplay(providerCalls).duplicated,
      quality_dimensions: [],
    };
  }

  for (const toolCall of requestedToolCalls) {
    if (!toolCall || typeof toolCall.tool_name !== 'string') {
      continue;
    }
    if (toolCall.tool_name !== 'get_glucose_evidence' && toolCall.tool_name !== 'get_insulin_evidence' && toolCall.tool_name !== 'get_basal_evidence') {
      return {
        run_id: `live-${args.fixture.fixture_id}-BATCHED-${args.runNumber}`,
        fixture_id: args.fixture.fixture_id,
        fixture_version: args.fixture.fixture_version,
        strategy: 'BATCHED',
        run_number: args.runNumber,
        status: 'FAILED',
        failure_reason: `Unsupported tool requested in batched run: ${toolCall.tool_name}`,
        model: process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-terra',
        prompt_version: 'conversation-time-range-analysis.v1',
        output_schema_version: 'conversation-direct-response-output.v1',
        provider_call_count: providerCalls.length,
        provider_calls: providerCalls,
        provider_attempts: providerAttempts,
        failure_stage: 'TOOL_CALL_PARSE',
        tool_sequence: ['get_glucose_evidence', 'get_insulin_evidence', 'get_basal_evidence'],
        tool_calls: toolCalls,
        assistant_message: null,
        usage_sum: summarizeUsage(providerCalls),
        cost_sum: null,
        serialized_request_bytes_sum: providerCalls.reduce((sum, call) => sum + call.request_bytes, 0),
        tool_result_bytes_sum: summarizeToolReplay(providerCalls).total,
        duplicated_tool_result_bytes: summarizeToolReplay(providerCalls).duplicated,
        quality_dimensions: [],
      };
    }

    const normalized = normalizeToolArguments(args.fixture, toolCall.tool_name, toolCall.arguments ?? {});
    toolCalls.push({
      sequence: toolCalls.length + 1,
      tool_name: toolCall.tool_name,
      arguments: normalized,
      refinement_kind: 'INITIAL',
    });

    const request = {
      tool: toolCall.tool_name,
      patient_id: args.fixture.patient_id,
      time_range: normalized.time_range as { from: string; to: string },
      detail_level: String(normalized.detail_level),
      task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
      constraints: { max_range_ms: 24 * 60 * 60 * 1000 },
    };

    try {
      const toolResponse = evidenceRegistry.execute(request as any, evidenceContext, {
        executionId: `live:batched:${args.fixture.fixture_id}:${args.runNumber}`,
      });

      preloadedToolResults.push({
        call_id: toolCall.call_id,
        tool_name: toolCall.tool_name,
        result: {
          tool: toolResponse.tool,
          status: toolResponse.status,
          evidence: toolResponse.evidence,
          coverage: toolResponse.coverage,
          limitations: toolResponse.limitations,
          provenance: {
            request_hash: toolResponse.provenance.request_hash,
            compiler_version: toolResponse.provenance.compiler_version,
            evidence_version: toolResponse.provenance.evidence_version,
            source_refs: toolResponse.provenance.source_refs,
          },
          content_hash: toolResponse.content_hash,
        },
      });
    } catch (error) {
      return {
        run_id: `live-${args.fixture.fixture_id}-BATCHED-${args.runNumber}`,
        fixture_id: args.fixture.fixture_id,
        fixture_version: args.fixture.fixture_version,
        strategy: 'BATCHED',
        run_number: args.runNumber,
        status: 'FAILED',
        failure_reason: error instanceof Error ? error.message : String(error),
        model: process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-terra',
        prompt_version: 'conversation-time-range-analysis.v1',
        output_schema_version: 'conversation-direct-response-output.v1',
        provider_call_count: providerCalls.length,
        provider_calls: providerCalls,
        provider_attempts: providerAttempts,
        failure_stage: 'TOOL_EXECUTION',
        tool_sequence: ['get_glucose_evidence', 'get_insulin_evidence', 'get_basal_evidence'],
        tool_calls: toolCalls,
        assistant_message: null,
        usage_sum: summarizeUsage(providerCalls),
        cost_sum: null,
        serialized_request_bytes_sum: providerCalls.reduce((sum, call) => sum + call.request_bytes, 0),
        tool_result_bytes_sum: summarizeToolReplay(providerCalls).total,
        duplicated_tool_result_bytes: summarizeToolReplay(providerCalls).duplicated,
        quality_dimensions: [],
      };
    }
  }

  const turnTwoInput = buildProviderInput({
    fixture: args.fixture,
    strategy: 'BATCHED',
    runNumber: args.runNumber,
    previousResponseId: turnOneResponse.response_id ?? null,
    toolResults: preloadedToolResults,
    availableTools: [],
    maxCallsRemaining: 0,
  });

  let response: AiProviderResponse;
  try {
    response = await args.provider.generate(turnTwoInput);
    providerAttempts.push(buildProviderAttemptDiagnostic({
      attemptNumber: providerAttempts.length + 1,
      stage: 'PROVIDER_RESPONSE',
      response,
    }));
  } catch (error) {
    const attempt = buildProviderAttemptDiagnostic({
      attemptNumber: providerAttempts.length + 1,
      stage: 'PROVIDER_REQUEST',
      error,
    });
    providerAttempts.push(attempt);
    return {
      run_id: `live-${args.fixture.fixture_id}-BATCHED-${args.runNumber}`,
      fixture_id: args.fixture.fixture_id,
      fixture_version: args.fixture.fixture_version,
      strategy: 'BATCHED',
      run_number: args.runNumber,
      status: 'FAILED',
      failure_reason: attempt.error_message ?? (error instanceof Error ? error.message : String(error)),
      model: process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-terra',
      prompt_version: 'conversation-time-range-analysis.v1',
      output_schema_version: 'conversation-direct-response-output.v1',
      provider_call_count: providerCalls.length,
      provider_calls: providerCalls,
      provider_attempts: providerAttempts,
      failure_stage: attempt.stage ?? 'UNKNOWN',
      tool_sequence: ['get_glucose_evidence', 'get_insulin_evidence', 'get_basal_evidence'],
      tool_calls: toolCalls,
      assistant_message: null,
      usage_sum: summarizeUsage(providerCalls),
      cost_sum: null,
      serialized_request_bytes_sum: providerCalls.reduce((sum, call) => sum + call.request_bytes, 0),
      tool_result_bytes_sum: summarizeToolReplay(providerCalls).total,
      duplicated_tool_result_bytes: summarizeToolReplay(providerCalls).duplicated,
      quality_dimensions: [],
    };
  }

  providerCalls.push({
    call_number: 2,
    request_bytes: response.serialized_input_bytes ?? byteLength(turnTwoInput),
    request_fingerprint: response.input_fingerprint ?? null,
    usage: response.usage ?? null,
    estimated_cost: response.estimated_cost ?? null,
    supplied_tool_results: preloadedToolResults.map((entry) => ({
      tool_name: entry.tool_name,
      call_id: entry.call_id,
      result_hash: typeof entry.result.content_hash === 'string' ? String(entry.result.content_hash) : hash(entry.result),
      result_bytes: byteLength(entry.result),
    })),
  });

  const assistant = String((response.raw_output as Record<string, unknown> | null)?.assistant_message ?? '');
  const usageSum = summarizeUsage(providerCalls);
  const replay = summarizeToolReplay(providerCalls);
  const costs = providerCalls
    .map((call) => call.estimated_cost?.estimated_cost)
    .filter((value): value is number => typeof value === 'number');

  return {
    run_id: `live-${args.fixture.fixture_id}-BATCHED-${args.runNumber}`,
    fixture_id: args.fixture.fixture_id,
    fixture_version: args.fixture.fixture_version,
    strategy: 'BATCHED',
    run_number: args.runNumber,
    status: assistant ? 'COMPLETED' : 'FAILED',
    failure_reason: assistant ? null : 'Missing assistant_message in provider output',
    model: process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-terra',
    prompt_version: 'conversation-time-range-analysis.v1',
    output_schema_version: 'conversation-direct-response-output.v1',
    provider_call_count: providerCalls.length,
    provider_calls: providerCalls,
    provider_attempts: providerAttempts,
    failure_stage: assistant ? 'FINAL_RESPONSE' : 'OUTPUT_VALIDATION',
    tool_sequence: toolCalls.map((entry) => entry.tool_name),
    tool_calls: toolCalls,
    assistant_message: assistant,
    usage_sum: usageSum,
    cost_sum: providerCalls.length > 0 && costs.length === providerCalls.length
      ? Number(costs.reduce((sum, value) => sum + value, 0).toFixed(8))
      : null,
    serialized_request_bytes_sum: providerCalls.reduce((sum, call) => sum + call.request_bytes, 0),
    tool_result_bytes_sum: replay.total,
    duplicated_tool_result_bytes: replay.duplicated,
    quality_dimensions: evaluateTimeRangeQualityRubric(assistant, args.fixture),
  };
}

function aggregate(runs: LiveRunResult[]): Record<string, unknown> {
  const strategies: Array<'SEQUENTIAL_PROGRESSIVE' | 'BATCHED'> = ['SEQUENTIAL_PROGRESSIVE', 'BATCHED'];

  const byStrategy = strategies.map((strategy) => {
    const subset = runs.filter((run) => run.strategy === strategy && run.status === 'COMPLETED');
    const count = subset.length;
    const avg = (values: number[]): number | null => values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)) : null;

    const qualitySummary: Record<string, { pass: number; partial: number; fail: number }> = {};
    for (const run of subset) {
      for (const dimension of run.quality_dimensions) {
        const bucket = qualitySummary[dimension.dimension] ?? { pass: 0, partial: 0, fail: 0 };
        if (dimension.grade === 'PASS') bucket.pass += 1;
        if (dimension.grade === 'PARTIAL') bucket.partial += 1;
        if (dimension.grade === 'FAIL') bucket.fail += 1;
        qualitySummary[dimension.dimension] = bucket;
      }
    }

    return {
      strategy,
      completed_runs: count,
      avg_input_tokens: avg(subset.map((run) => run.usage_sum.input_tokens)),
      avg_cached_input_tokens: avg(subset.map((run) => run.usage_sum.cached_input_tokens)),
      avg_output_tokens: avg(subset.map((run) => run.usage_sum.output_tokens)),
      avg_total_tokens: avg(subset.map((run) => run.usage_sum.total_tokens)),
      avg_cost: subset.some((run) => run.cost_sum === null)
        ? 'UNKNOWN'
        : avg(subset.map((run) => run.cost_sum ?? 0)),
      avg_provider_calls: avg(subset.map((run) => run.provider_call_count)),
      avg_duplicated_tool_result_bytes: avg(subset.map((run) => run.duplicated_tool_result_bytes)),
      quality_by_dimension: qualitySummary,
    };
  });

  const seq = byStrategy.find((entry) => entry.strategy === 'SEQUENTIAL_PROGRESSIVE') as Record<string, unknown>;
  const bat = byStrategy.find((entry) => entry.strategy === 'BATCHED') as Record<string, unknown>;

  const numericDelta = (key: string): number | null => {
    const left = seq[key];
    const right = bat[key];
    if (typeof left !== 'number' || typeof right !== 'number') {
      return null;
    }
    return Number((left - right).toFixed(4));
  };

  return {
    by_strategy: byStrategy,
    deltas: {
      input_tokens_sequential_minus_batched: numericDelta('avg_input_tokens'),
      cached_input_sequential_minus_batched: numericDelta('avg_cached_input_tokens'),
      output_tokens_sequential_minus_batched: numericDelta('avg_output_tokens'),
      provider_calls_sequential_minus_batched: numericDelta('avg_provider_calls'),
      duplicated_bytes_sequential_minus_batched: numericDelta('avg_duplicated_tool_result_bytes'),
      cost_sequential_minus_batched: typeof seq.avg_cost === 'number' && typeof bat.avg_cost === 'number'
        ? Number((seq.avg_cost - bat.avg_cost).toFixed(8))
        : 'UNKNOWN',
    },
  };
}

function buildConclusions(runs: LiveRunResult[], aggregateBlock: Record<string, unknown>): LiveExperimentReport['architecture_conclusion'] {
  const completed = runs.filter((run) => run.status === 'COMPLETED');
  const seq = completed.filter((run) => run.strategy === 'SEQUENTIAL_PROGRESSIVE');
  const bat = completed.filter((run) => run.strategy === 'BATCHED');

  if (completed.length === 0) {
    return {
      outcome: 'INSUFFICIENT_EVIDENCE',
      answers: [
        {
          question: '1. Did sequential progressive disclosure show a meaningful quality advantage?',
          answer: 'Not evaluable: no completed live runs.',
        },
        {
          question: '2. Did batching show any quality degradation?',
          answer: 'Not evaluable: no completed live runs.',
        },
        {
          question: '3. Did the real model dynamically select evidence?',
          answer: 'Not observed because no run completed.',
        },
        {
          question: '4. Did the real model perform refinement/re-request?',
          answer: 'Not observed because no run completed.',
        },
        {
          question: '5. How large was the actual cost difference?',
          answer: 'UNKNOWN: no completed live runs and no provider usage telemetry.',
        },
        {
          question: '6. How much repeated input was cached?',
          answer: 'UNKNOWN: no completed live runs and no provider usage telemetry.',
        },
        {
          question: '7. Is retransmission actually a meaningful billed-cost problem?',
          answer: 'Not evaluable in live mode from this sample.',
        },
        {
          question: '8. Does the evidence justify Evidence Session?',
          answer: 'Not evaluable in live mode from this sample.',
        },
        {
          question: '9. Does the evidence justify adaptive batching?',
          answer: 'Not evaluable in live mode from this sample.',
        },
        {
          question: '10. What experiment should happen next if uncertainty remains?',
          answer: 'Resolve provider credentials/quota, rerun the same capped 8-run protocol, then compare with synthetic findings.',
        },
      ],
      recommended_next_experiment: 'Run the exact same capped live protocol after restoring OpenAI authentication and quota.',
    };
  }

  const hasRefinement = seq.some((run) => run.tool_calls.some((call) => call.refinement_kind !== 'INITIAL'));
  const progressiveObserved = seq.some((run) => run.tool_sequence.length >= 2);

  const seqFails = seq.flatMap((run) => run.quality_dimensions).filter((dimension) => dimension.grade === 'FAIL').length;
  const batFails = bat.flatMap((run) => run.quality_dimensions).filter((dimension) => dimension.grade === 'FAIL').length;

  const outcome: LiveExperimentReport['architecture_conclusion']['outcome'] = seq.length === 0 || bat.length === 0
    ? 'INSUFFICIENT_EVIDENCE'
    : seqFails < batFails
      ? 'SEQUENTIAL_PREFERRED'
      : batFails < seqFails
        ? 'BATCHED_PREFERRED'
        : 'HYBRID_ADAPTIVE';

  const answers = [
    {
      question: '1. Did sequential progressive disclosure show a meaningful quality advantage?',
      answer: seqFails < batFails ? 'Yes in this sample.' : seqFails === batFails ? 'No clear advantage in this sample.' : 'No, sequential underperformed in this sample.',
    },
    {
      question: '2. Did batching show any quality degradation?',
      answer: batFails > seqFails ? 'Yes, deterministic rubric failures increased.' : 'No deterministic quality degradation observed in this sample.',
    },
    {
      question: '3. Did the real model dynamically select evidence?',
      answer: progressiveObserved ? 'Yes, sequential runs showed multi-step tool selection.' : 'Not observed in this live sample.',
    },
    {
      question: '4. Did the real model perform refinement/re-request?',
      answer: hasRefinement ? 'Yes, refinement/re-request behavior was observed.' : 'Not observed in this live sample.',
    },
    {
      question: '5. How large was the actual cost difference?',
      answer: `See aggregate deltas in report: ${JSON.stringify((aggregateBlock.deltas ?? {}))}`,
    },
    {
      question: '6. How much repeated input was cached?',
      answer: 'See per-run and aggregate cached_input_tokens; values are provider-reported and not estimated.',
    },
    {
      question: '7. Is retransmission a meaningful billed-cost problem?',
      answer: 'Retransmission byte deltas are included; cost impact depends on provider tokenization and cache behavior.',
    },
    {
      question: '8. Does the evidence justify Evidence Session?',
      answer: outcome === 'HYBRID_ADAPTIVE' ? 'Potentially, but this sample remains small; treat as directional evidence.' : 'Not conclusively from this small sample alone.',
    },
    {
      question: '9. Does the evidence justify adaptive batching?',
      answer: 'Yes as a hypothesis: use strategy choice based on quality rubric sensitivity and domain relevance profile.',
    },
    {
      question: '10. What experiment should happen next if uncertainty remains?',
      answer: 'Repeat this harness on additional real fixtures with the same rubric and strict spend cap, then compare confidence intervals for quality deltas.',
    },
  ];

  return {
    outcome,
    answers,
    recommended_next_experiment: 'Increase fixture diversity while keeping runs capped and compare repeated live samples before architecture changes.',
  };
}

function compareWithSynthetic(runs: LiveRunResult[]): LiveExperimentReport['synthetic_comparison'] {
  const completed = runs.filter((run) => run.status === 'COMPLETED');
  const seq = completed.filter((run) => run.strategy === 'SEQUENTIAL_PROGRESSIVE');
  const bat = completed.filter((run) => run.strategy === 'BATCHED');

  const seqFail = seq.flatMap((run) => run.quality_dimensions).some((dimension) => dimension.grade === 'FAIL');
  const batFail = bat.flatMap((run) => run.quality_dimensions).some((dimension) => dimension.grade === 'FAIL');

  const replicated: string[] = [];
  const notReplicated: string[] = [];
  const uncertain: string[] = [];

  if (completed.length === 0) {
    uncertain.push('No completed live runs; synthetic comparison is not evaluable.');
    return {
      replicated,
      not_replicated: notReplicated,
      uncertain,
    };
  }

  if (!seqFail && !batFail) {
    replicated.push('No deterministic quality loss from batching in this sample.');
  } else {
    notReplicated.push('Synthetic parity on quality did not fully replicate.');
  }

  const seqDup = seq.reduce((sum, run) => sum + run.duplicated_tool_result_bytes, 0);
  const batDup = bat.reduce((sum, run) => sum + run.duplicated_tool_result_bytes, 0);
  if (seqDup > batDup) {
    replicated.push('Sequential showed higher retransmission bytes than batched.');
  } else {
    uncertain.push('Retransmission gap not clearly reproduced in this sample.');
  }

  const dynamic = seq.some((run) => run.tool_sequence.length > 1);
  if (dynamic) {
    replicated.push('Sequential dynamic tool selection was observed.');
  } else {
    uncertain.push('Dynamic progressive selection was not observed in this sample.');
  }

  const refinement = seq.some((run) => run.tool_calls.some((call) => call.refinement_kind !== 'INITIAL'));
  if (!refinement) {
    uncertain.push('Refinement/re-request behavior not observed in this sample.');
  } else {
    replicated.push('Refinement/re-request behavior observed.');
  }

  return {
    replicated,
    not_replicated: notReplicated,
    uncertain,
  };
}

function toMarkdown(report: LiveExperimentReport): string {
  const lines: string[] = [];
  lines.push('# Live Time-Range Quality vs Cost Report');
  lines.push('');
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`model: ${report.model}`);
  lines.push(`planned_runs: ${report.planned_runs}`);
  lines.push(`completed_runs: ${report.completed_runs}`);
  lines.push(`failed_runs: ${report.failed_runs}`);
  lines.push(`total_live_provider_calls: ${report.total_live_provider_calls}`);
  lines.push('');
  lines.push('## Run Table');
  lines.push('| Fixture | Strategy | Run | Tool sequence | Provider calls | Input tokens | Cached input | Output tokens | Cost | Quality summary |');
  lines.push('| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- |');
  for (const run of report.runs) {
    const quality = run.quality_dimensions.map((dimension) => `${dimension.dimension}:${dimension.grade}`).join('; ') || 'FAILED';
    lines.push(`| ${run.fixture_id} | ${run.strategy} | ${run.run_number} | ${run.tool_sequence.join(' -> ') || 'none'} | ${run.provider_call_count} | ${run.usage_sum.input_tokens} | ${run.usage_sum.cached_input_tokens} | ${run.usage_sum.output_tokens} | ${run.cost_sum === null ? 'UNKNOWN' : run.cost_sum.toFixed(8)} | ${quality} |`);
  }
  lines.push('');
  lines.push('## Aggregate');
  lines.push('```json');
  lines.push(JSON.stringify(report.aggregate, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Synthetic Comparison');
  lines.push(`- replicated: ${report.synthetic_comparison.replicated.join(' | ') || 'none'}`);
  lines.push(`- not_replicated: ${report.synthetic_comparison.not_replicated.join(' | ') || 'none'}`);
  lines.push(`- uncertain: ${report.synthetic_comparison.uncertain.join(' | ') || 'none'}`);
  lines.push('');
  lines.push('## Architecture Conclusion');
  lines.push(`- outcome: ${report.architecture_conclusion.outcome}`);
  for (const answer of report.architecture_conclusion.answers) {
    lines.push(`- ${answer.question} ${answer.answer}`);
  }
  lines.push(`- next_experiment: ${report.architecture_conclusion.recommended_next_experiment}`);

  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  mustEnableLiveRun();

  const runsPerStrategy = parseRunsPerStrategy();
  const fixtures = createTimeRangeQualityCostFixtures();
  const strategies: Array<'SEQUENTIAL_PROGRESSIVE' | 'BATCHED'> = ['SEQUENTIAL_PROGRESSIVE', 'BATCHED'];
  const plannedRuns = fixtures.length * strategies.length * runsPerStrategy;
  if (plannedRuns > 8) {
    throw new Error(`Planned live runs ${plannedRuns} exceed hard cap 8.`);
  }

  const maxProviderCallsPerRun = 6;
  const maxPossibleProviderCalls = plannedRuns * maxProviderCallsPerRun;
  console.log(`[live-eval] planned_runs=${plannedRuns}, max_possible_provider_calls=${maxPossibleProviderCalls}`);

  const provider = createProvider();
  const runs: LiveRunResult[] = [];

  for (const fixture of fixtures) {
    for (const strategy of strategies) {
      for (let runNumber = 1; runNumber <= runsPerStrategy; runNumber += 1) {
        console.log(`[live-eval] fixture=${fixture.fixture_id} strategy=${strategy} run=${runNumber}`);
        const result = strategy === 'SEQUENTIAL_PROGRESSIVE'
          ? await runSequential({ fixture, runNumber, provider, maxProviderCallsPerRun })
          : await runBatched({ fixture, runNumber, provider });
        runs.push(result);
      }
    }
  }

  const completedRuns = runs.filter((run) => run.status === 'COMPLETED').length;
  const failedRuns = runs.length - completedRuns;
  const totalLiveProviderCalls = runs.reduce((sum, run) => sum + run.provider_call_count, 0);
  const aggregateBlock = aggregate(runs);

  const report: LiveExperimentReport = {
    report_version: 'time-range-live-quality-cost.v1',
    generated_at: new Date().toISOString(),
    model: process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-terra',
    runs_per_strategy: runsPerStrategy,
    fixtures: fixtures.map((fixture) => ({
      fixture_id: fixture.fixture_id,
      fixture_version: fixture.fixture_version,
      description: fixture.description,
    })),
    strategies,
    planned_runs: plannedRuns,
    max_possible_provider_calls: maxPossibleProviderCalls,
    completed_runs: completedRuns,
    failed_runs: failedRuns,
    total_live_provider_calls: totalLiveProviderCalls,
    runs,
    aggregate: aggregateBlock,
    synthetic_comparison: compareWithSynthetic(runs),
    architecture_conclusion: buildConclusions(runs, aggregateBlock),
  };

  const artifactsDir = join(process.cwd(), 'artifacts', 'evaluation');
  mkdirSync(artifactsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(artifactsDir, `time-range-live-quality-cost-${stamp}.json`);
  const mdPath = join(artifactsDir, `time-range-live-quality-cost-${stamp}.md`);

  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(mdPath, toMarkdown(report), 'utf8');

  console.log(`[live-eval] report_json=${jsonPath}`);
  console.log(`[live-eval] report_md=${mdPath}`);
  console.log(`[live-eval] completed_runs=${completedRuns} failed_runs=${failedRuns} provider_calls=${totalLiveProviderCalls}`);
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[live-eval] failed: ${message}`);
    process.exitCode = 1;
  });
}
