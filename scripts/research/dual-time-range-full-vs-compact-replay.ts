import { config as loadDotenv } from 'dotenv';
import { createGuardedOpenAiClientFromEnv, type OpenAiResponsesTransport } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { canonicalJson } from '@shared/utils/canonical-json';
import { buildExactInputFingerprint, buildPricingEstimate, normalizeAIUsage } from '@modules/ai-gateway/application/ai-observability';
import { buildOpenAiResponsesRequestBody } from '@modules/ai-gateway/infrastructure/openai-provider';
import { buildCompactDeliveryArtifact } from '@modules/context/application/compact-delivery-artifact';
import type { AiTask, TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import {
  buildAggregateRollup,
  calculateMetricReduction,
  evaluatePair,
  renderMarkdownSummary,
  type PairVerdict,
  type ReplayMetrics,
} from '../evaluation/time-range-dual-replay-evaluator';
import { describeErrorSafely, writeEvaluationOutputDirFile } from '../evaluation/evaluation-output-dir';
import { ReplayArgumentError, captureForReport, parseReplayArguments } from '../evaluation/replay-cli';

interface CaptureTaskEnvelope {
  task_id: string;
  task_type: string;
  task_version: string;
  prompt_version: string;
  output_schema_version: string;
  model_policy_version: string;
  context_package_id: string;
  context_package_version: string;
  context_package_hash: string;
  correlation_id: string;
  created_at: string;
}

interface CaptureRecord {
  captured_at: string;
  capture_version: string;
  task_identity: string;
  task: CaptureTaskEnvelope;
  provider: string;
  model: string;
  model_fingerprint: string;
  prompt: {
    system_instructions: string;
    user_payload: string;
  };
  context_package: TimeRangeAnalysisContextRecord;
  request_representation: Record<string, unknown>;
  serialized_input_bytes: number;
  input_fingerprint: string;
}

interface ReadyReport {
  status: string;
  run_id: string;
  capture_file_path: string;
  cases: Array<{ task_identity: string }>;
}

interface InvocationResult {
  request: Record<string, unknown>;
  metrics: ReplayMetrics;
  output: Record<string, unknown> | null;
  raw_text_output: string | null;
  error: { message: string; code: string | null; status: number | null } | null;
}

interface CaseReport {
  case_id: string;
  source_capture_id: string;
  source_task_identity: string;
  task_type: string;
  range: {
    range_type: string;
    range_start: string;
    range_end: string;
    timezone: string;
  };
  full: InvocationResult;
  compact: InvocationResult;
  metric_reduction: ReturnType<typeof calculateMetricReduction>;
  semantic_comparison: ReturnType<typeof evaluatePair>['comparison'];
  invariant_results: ReturnType<typeof evaluatePair>['invariants'];
  quality_dimensions: ReturnType<typeof evaluatePair>['quality_dimensions'];
  verdict: PairVerdict;
}

function parseNullablePrice(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function extractOutputText(response: Record<string, unknown>): string | null {
  const outputText = response.output_text;
  if (typeof outputText === 'string' && outputText.trim()) {
    return outputText;
  }

  const output = response.output;
  if (!Array.isArray(output)) {
    return null;
  }

  for (const item of output) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (!part || typeof part !== 'object') {
        continue;
      }

      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string' && record.text.trim()) {
        return record.text;
      }
    }
  }

  return null;
}

function toAiTask(task: CaptureTaskEnvelope, context: TimeRangeAnalysisContextRecord): AiTask {
  return {
    task_id: task.task_id,
    task_type: task.task_type as AiTask['task_type'],
    task_version: task.task_version,
    context_package_id: task.context_package_id,
    context_package_version: task.context_package_version,
    context_package_hash: task.context_package_hash,
    prompt_version: task.prompt_version,
    output_schema_version: task.output_schema_version,
    model_policy_version: task.model_policy_version,
    correlation_id: task.correlation_id,
    created_at: task.created_at,
    patient_id: String(context.patient_ref?.patient_id ?? ''),
  };
}

function buildCompactUserPayload(capture: CaptureRecord): string {
  const task = toAiTask(capture.task, capture.context_package);
  const compact = buildCompactDeliveryArtifact({
    contextPackage: capture.context_package,
    task,
  });

  const recentMessages = capture.context_package.conversation_context.messages
    .slice(-12)
    .map((message) => ({
      role: message.role,
      message_type: message.message_type ?? 'OTHER',
      content: message.content,
      created_at: message.created_at,
    }));

  const payload = {
    task: {
      task_type: task.task_type,
      task_version: task.task_version,
      prompt_version: task.prompt_version,
      output_schema_version: task.output_schema_version,
      correlation_id: task.correlation_id,
    },
    patient_ref: capture.context_package.patient_ref,
    analysis_request_input: capture.context_package.analysis_request_input,
    conversation_context: {
      thread_id: capture.context_package.conversation_context.thread_id,
      thread_state_version: capture.context_package.conversation_context.thread_state_version,
      recent_messages: recentMessages,
    },
    current_state_snapshot: capture.context_package.current_state_snapshot ?? null,
    compact_delivery_artifact: compact,
    compact_semantic_contract: {
      preserve_task_intent: true,
      preserve_range_semantics: true,
      preserve_current_vs_historical_semantics: true,
      preserve_unknown_missing_excluded_not_selected_semantics: true,
      preserve_provenance_and_relationship_decisions: true,
      no_therapy_recommendations: true,
      no_insulin_dosing_guidance: true,
      no_chain_of_thought: true,
    },
  };

  return JSON.stringify(payload);
}

async function invokeOpenAi(args: {
  client: OpenAiResponsesTransport;
  requestBody: Record<string, unknown>;
  timeoutMs: number;
  pricing: {
    input_per_1k_tokens: number | null;
    output_per_1k_tokens: number | null;
    cached_input_per_1k_tokens: number | null;
    reasoning_per_1k_tokens: number | null;
    currency: string | null;
    pricing_version: string | null;
  } | null;
}): Promise<InvocationResult> {
  const started = Date.now();
  const requestFingerprint = buildExactInputFingerprint(args.requestBody);
  const requestBytes = Buffer.byteLength(JSON.stringify(args.requestBody), 'utf8');

  try {
    const response = await args.client.responses.create(args.requestBody, { timeout: args.timeoutMs });
    const rawRecord = response as unknown as Record<string, unknown>;
    const outputText = extractOutputText(rawRecord);
    const output = outputText ? JSON.parse(outputText) as Record<string, unknown> : null;
    const usage = normalizeAIUsage(rawRecord.usage ?? null);
    const estimatedCost = usage && args.pricing
      ? buildPricingEstimate({ provider: 'openai', model: String(args.requestBody.model ?? ''), usage, pricing: args.pricing })
      : null;

    return {
      request: args.requestBody,
      metrics: {
        model: typeof args.requestBody.model === 'string' ? args.requestBody.model : null,
        input_fingerprint: requestFingerprint,
        serialized_input_bytes: requestBytes,
        input_tokens: usage?.input_tokens ?? null,
        output_tokens: usage?.output_tokens ?? null,
        total_tokens: usage?.total_tokens ?? null,
        cached_input_tokens: usage?.cached_input_tokens ?? null,
        reasoning_tokens: usage?.reasoning_tokens ?? null,
        provider_duration_ms: Date.now() - started,
        estimated_cost: estimatedCost?.estimated_cost ?? null,
        currency: estimatedCost?.currency ?? null,
        pricing_version: estimatedCost?.pricing_version ?? null,
      },
      output,
      raw_text_output: outputText,
      error: null,
    };
  } catch (error) {
    const record = error as { message?: string; code?: string; status?: number };
    return {
      request: args.requestBody,
      metrics: {
        model: typeof args.requestBody.model === 'string' ? args.requestBody.model : null,
        input_fingerprint: requestFingerprint,
        serialized_input_bytes: requestBytes,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        cached_input_tokens: null,
        reasoning_tokens: null,
        provider_duration_ms: Date.now() - started,
        estimated_cost: null,
        currency: null,
        pricing_version: null,
      },
      output: null,
      raw_text_output: null,
      error: {
        message: record?.message ?? String(error),
        code: record?.code ? String(record.code) : null,
        status: Number.isFinite(record?.status) ? Number(record.status) : null,
      },
    };
  }
}

/**
 * The explicitly given fresh capture report (formerly: the newest READY report found under artifacts/evaluation).
 * The same READY and case-count requirement applies.
 */
async function loadReadyCaptureReport(reportPath: string): Promise<ReadyReport> {
  const parsed = JSON.parse(await readFile(reportPath, 'utf8')) as ReadyReport;
  if (parsed.status === 'FRESH_TIME_RANGE_CAPTURE_READY' && Array.isArray(parsed.cases) && parsed.cases.length >= 2) {
    return parsed;
  }

  throw new ReplayArgumentError(`Capture report ${JSON.stringify(basename(reportPath))} is not a READY fresh capture report with at least 2 cases.`);
}

function percentileNumbers(values: Array<number | null>): { average: number | null; median: number | null } {
  const numbers = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (numbers.length === 0) {
    return { average: null, median: null };
  }

  const average = Number((numbers.reduce((acc, value) => acc + value, 0) / numbers.length).toFixed(4));
  const mid = Math.floor(numbers.length / 2);
  const medianValue = numbers.length % 2 === 0
    ? (numbers[mid - 1] + numbers[mid]) / 2
    : numbers[mid];

  return { average, median: Number(medianValue.toFixed(4)) };
}

// Usage: tsx scripts/dual-time-range-full-vs-compact-replay.ts --capture-report <fresh-time-range-capture-report.json>
//   --capture <capture.ndjson> --output-dir <dir outside every Git working tree>
// Live and paid: two provider calls per case. Inputs are read only; reports go only to the validated --output-dir.
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // Paths first: before .env is loaded, credentials are read, the client is built or any capture is read.
  const { outputDir, captureReports, captures: captureFiles } = parseReplayArguments(argv, { single: true });
  loadDotenv();

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for dual replay.');
  }

  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS ?? '30000');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('OPENAI_TIMEOUT_MS must be a positive integer');
  }

  const pricing = {
    input_per_1k_tokens: parseNullablePrice(process.env.OPENAI_PRICING_INPUT_PER_1K_TOKENS),
    output_per_1k_tokens: parseNullablePrice(process.env.OPENAI_PRICING_OUTPUT_PER_1K_TOKENS),
    cached_input_per_1k_tokens: parseNullablePrice(process.env.OPENAI_PRICING_CACHED_INPUT_PER_1K_TOKENS),
    reasoning_per_1k_tokens: parseNullablePrice(process.env.OPENAI_PRICING_REASONING_PER_1K_TOKENS),
    currency: parseNullableText(process.env.OPENAI_PRICING_CURRENCY),
    pricing_version: parseNullableText(process.env.OPENAI_PRICING_VERSION),
  };
  const hasPricing = Object.values(pricing).some((value) => value !== null);

  const latestReport = await loadReadyCaptureReport(captureReports[0]);
  const captureFile = captureForReport(latestReport.capture_file_path, captureFiles, captureReports[0]);

  const ndjsonLines = (await readFile(captureFile, 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const captures = ndjsonLines
    .map((line) => JSON.parse(line) as CaptureRecord)
    .filter((record) => record.task.task_type === 'CONVERSATION_TIME_RANGE_ANALYSIS');

  const targetTaskIds = new Set(latestReport.cases.slice(0, 2).map((row) => row.task_identity));
  const selected = captures.filter((record) => targetTaskIds.has(record.task_identity)).slice(0, 2);
  if (selected.length !== 2) {
    throw new Error(`Expected 2 TIME_RANGE captured records for latest READY run, found ${selected.length}.`);
  }

  // Same cost guard and durable experiment budget as the worker; refuses to start without them.
  const client = createGuardedOpenAiClientFromEnv(process.env, apiKey);
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;

  const caseReports: CaseReport[] = [];

  for (let index = 0; index < selected.length; index += 1) {
    const capture = selected[index];

    const fullRequest = capture.request_representation;

    const compactUserPayload = buildCompactUserPayload(capture);
    const compactRequest = buildOpenAiResponsesRequestBody({
      model: capture.model,
      task_type: capture.task.task_type,
      system_instructions: capture.prompt.system_instructions,
      user_payload: compactUserPayload,
    });

    const fullResult = await invokeOpenAi({
      client,
      requestBody: fullRequest,
      timeoutMs,
      pricing: hasPricing ? pricing : null,
    });
    const compactResult = await invokeOpenAi({
      client,
      requestBody: compactRequest,
      timeoutMs,
      pricing: hasPricing ? pricing : null,
    });

    const compactArtifact = buildCompactDeliveryArtifact({
      contextPackage: capture.context_package,
      task: toAiTask(capture.task, capture.context_package),
    });

    const pairEval = evaluatePair({
      fullMessage: String((fullResult.output as Record<string, unknown> | null)?.assistant_message ?? ''),
      compactMessage: String((compactResult.output as Record<string, unknown> | null)?.assistant_message ?? ''),
      fullRange: {
        range_type: capture.context_package.analysis_request_input.range_type,
        range_start: capture.context_package.analysis_request_input.range_start,
        range_end: capture.context_package.analysis_request_input.range_end,
        timezone: capture.context_package.analysis_request_input.timezone,
      },
      compactRange: {
        range_type: capture.context_package.analysis_request_input.range_type,
        range_start: capture.context_package.analysis_request_input.range_start,
        range_end: capture.context_package.analysis_request_input.range_end,
        timezone: capture.context_package.analysis_request_input.timezone,
      },
      sourceMealEvidence: {
        meal_event_count: Array.isArray(capture.context_package.analytical_evidence.meal_events)
          ? capture.context_package.analytical_evidence.meal_events.length
          : Number(capture.context_package.analytical_evidence?.summaries?.meal_count ?? 0),
      },
      fullTaskType: capture.task.task_type,
      compactTaskType: capture.task.task_type,
      fullModel: fullResult.metrics.model,
      compactModel: compactResult.metrics.model,
      fullOutputSchemaVersion: capture.task.output_schema_version,
      compactOutputSchemaVersion: capture.task.output_schema_version,
      compactArtifact,
    });

    const reduction = calculateMetricReduction(fullResult.metrics, compactResult.metrics);

    caseReports.push({
      case_id: `time-range-case-${index + 1}`,
      source_capture_id: `${capture.captured_at}:${capture.task_identity}`,
      source_task_identity: capture.task_identity,
      task_type: capture.task.task_type,
      range: {
        range_type: capture.context_package.analysis_request_input.range_type,
        range_start: capture.context_package.analysis_request_input.range_start,
        range_end: capture.context_package.analysis_request_input.range_end,
        timezone: capture.context_package.analysis_request_input.timezone,
      },
      full: fullResult,
      compact: compactResult,
      metric_reduction: reduction,
      semantic_comparison: pairEval.comparison,
      invariant_results: pairEval.invariants,
      quality_dimensions: pairEval.quality_dimensions,
      verdict: pairEval.verdict,
    });
  }

  const aggregate = buildAggregateRollup(caseReports.map((item) => ({
    case_id: item.case_id,
    quality_verdict: item.verdict,
    invariant_failures: item.invariant_results.failures,
    reduction: item.metric_reduction,
  })));

  const byteStats = percentileNumbers(caseReports.map((item) => item.metric_reduction.input_byte_reduction_pct));
  const tokenStats = percentileNumbers(caseReports.map((item) => item.metric_reduction.input_token_reduction_pct));

  const jsonReport = {
    experiment: {
      experiment_id: `dual-time-range-full-vs-compact-${runId}`,
      generated_at: new Date().toISOString(),
      source_capture_run_id: latestReport.run_id,
      source_capture_file: captureFile,
      mode: 'EVALUATION_ONLY',
      calls: {
        full: 2,
        compact: 2,
      },
    },
    provider: 'openai',
    model: selected[0]?.model ?? null,
    full: {
      invocation_count: caseReports.length,
      request_source: 'exact_captured_provider_bound_request',
    },
    compact: {
      invocation_count: caseReports.length,
      request_source: 'deterministic_compact_delivery_artifact_from_same_captured_task_context',
    },
    cases: caseReports,
    comparisons: caseReports.map((item) => ({
      case_id: item.case_id,
      verdict: item.verdict,
      invariants: item.invariant_results,
      semantic_comparison: item.semantic_comparison,
    })),
    aggregate: {
      ...aggregate,
      average_input_reduction_pct: byteStats.average,
      median_input_reduction_pct: byteStats.median,
      average_token_reduction_pct: tokenStats.average,
      median_token_reduction_pct: tokenStats.median,
    },
    verdict: aggregate.quality_verdict,
  };

  const markdown = renderMarkdownSummary({
    experimentId: jsonReport.experiment.experiment_id,
    cases: caseReports.map((item) => ({
      case_id: item.case_id,
      full_bytes: item.full.metrics.serialized_input_bytes,
      compact_bytes: item.compact.metrics.serialized_input_bytes,
      reduction_pct: item.metric_reduction.input_byte_reduction_pct,
      quality: item.verdict,
      invariant_status: item.invariant_results.failures.length === 0 ? 'PASS' : 'FAIL',
    })),
    aggregate,
  });

  const jsonPath = writeEvaluationOutputDirFile(outputDir, `dual-time-range-full-vs-compact-report-${runId}.json`, `${JSON.stringify(jsonReport, null, 2)}\n`);
  const mdPath = writeEvaluationOutputDirFile(outputDir, `dual-time-range-full-vs-compact-report-${runId}.md`, markdown);

  console.log(JSON.stringify({
    status: 'DUAL_TIME_RANGE_REPLAY_COMPLETED',
    experiment_id: jsonReport.experiment.experiment_id,
    source_capture_run_id: latestReport.run_id,
    json_report_path: jsonPath,
    markdown_report_path: mdPath,
    case_count: caseReports.length,
    full_calls: caseReports.length,
    compact_calls: caseReports.length,
    verdict: jsonReport.verdict,
    report_hash: buildExactInputFingerprint(JSON.parse(canonicalJson(jsonReport))),
  }, null, 2));
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(`[dual-time-range-full-vs-compact-replay] failed: ${describeErrorSafely(error, [ReplayArgumentError])}`);
    process.exitCode = 1;
  });
}
