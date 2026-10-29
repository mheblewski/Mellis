import { config as loadDotenv } from 'dotenv';
import { createGuardedOpenAiClientFromEnv, type OpenAiResponsesTransport } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { canonicalJson } from '@shared/utils/canonical-json';
import { buildExactInputFingerprint, buildPricingEstimate, normalizeAIUsage } from '@modules/ai-gateway/application/ai-observability';
import { buildOpenAiResponsesRequestBody } from '@modules/ai-gateway/infrastructure/openai-provider';
import { buildCompactDeliveryArtifact, type CompactDeliveryArtifactV1 } from '@modules/context/application/compact-delivery-artifact';
import type { AiTask, TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import {
  calculateMetricReduction,
  evaluatePair,
  type PairVerdict,
  type ReplayMetrics,
} from './evaluation/time-range-dual-replay-evaluator';
import { describeErrorSafely, writeEvaluationOutputDirFile } from './evaluation/evaluation-output-dir';
import { ReplayArgumentError, captureForReport, parseReplayArguments } from './evaluation/replay-cli';

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
  report_generated_at: string;
  cases: Array<{ task_identity: string }>;
}

interface InvocationResult {
  request: Record<string, unknown>;
  metrics: ReplayMetrics;
  output: Record<string, unknown> | null;
  raw_text_output: string | null;
  error: { message: string; code: string | null; status: number | null } | null;
}

interface SelectedCase {
  capture: CaptureRecord;
  source_capture_run_id: string;
  source_capture_file: string;
  evidence_features: {
    has_meals: boolean;
    has_insulin: boolean;
    has_hypo: boolean;
    has_unknown_or_missing: boolean;
    has_significant_periods: boolean;
    selected_level: string | null;
    selected_families_count: number;
    omitted_families_count: number;
    relationship_decisions_count: number;
    source_total_events: number;
  };
}

interface CaseReport {
  case_id: string;
  source_capture_id: string;
  source_capture_run_id: string;
  source_capture_file: string;
  source_task_identity: string;
  task_type: string;
  range: {
    range_type: string;
    range_start: string;
    range_end: string;
    timezone: string;
    hours_covered: number;
  };
  full: InvocationResult;
  compact: InvocationResult;
  metric_reduction: ReturnType<typeof calculateMetricReduction>;
  semantic_comparison: ReturnType<typeof evaluatePair>['comparison'];
  invariant_results: ReturnType<typeof evaluatePair>['invariants'];
  quality_dimensions: ReturnType<typeof evaluatePair>['quality_dimensions'];
  verdict: PairVerdict;
  review_classification: {
    difference_markers: string[];
    classification: 'REAL_REGRESSION' | 'BENIGN_DIFFERENCE' | 'COMPARATOR_LIMITATION' | 'NO_REVIEW';
    notes: string;
  };
  evidence_coverage: {
    source_evidence_sections: Record<string, number>;
    has_significant_periods: boolean;
    selected_families: string[];
    omitted_families: string[];
    omission_reasons: string[];
    relationship_decisions_count: number;
    unknown_states: string[];
    missing_states: string[];
    excluded_states: string[];
    not_selected_states: string[];
    selected_level: string | null;
    default_level: string | null;
    unresolved_reasons: string[];
  };
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

function percentileNumbers(values: Array<number | null>): { average: number | null; median: number | null; min: number | null; max: number | null } {
  const numbers = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (numbers.length === 0) {
    return { average: null, median: null, min: null, max: null };
  }

  const average = Number((numbers.reduce((acc, value) => acc + value, 0) / numbers.length).toFixed(4));
  const mid = Math.floor(numbers.length / 2);
  const medianValue = numbers.length % 2 === 0
    ? (numbers[mid - 1] + numbers[mid]) / 2
    : numbers[mid];

  return {
    average,
    median: Number(medianValue.toFixed(4)),
    min: Number(numbers[0].toFixed(4)),
    max: Number(numbers[numbers.length - 1].toFixed(4)),
  };
}

function getLevelRank(level: string | null): number {
  if (level === 'L3') return 3;
  if (level === 'L2') return 2;
  if (level === 'L1') return 1;
  return 0;
}

function shapeFeatures(capture: CaptureRecord, compact: CompactDeliveryArtifactV1) {
  const evidence = capture.context_package.analytical_evidence;
  const unknownStates = compact.unknown_states ?? [];
  const missingSections = evidence?.summaries?.missing_sections ?? [];
  const selectedLevel = compact.policy?.selected_level ?? null;

  return {
    has_meals: Array.isArray(evidence.meal_events) && evidence.meal_events.length > 0,
    has_insulin: Array.isArray(evidence.insulin_treatment_events) && evidence.insulin_treatment_events.length > 0,
    has_hypo: Array.isArray(evidence.hypo_episodes) && evidence.hypo_episodes.length > 0,
    has_unknown_or_missing: unknownStates.length > 0 || missingSections.length > 0,
    has_significant_periods: Array.isArray((evidence as Record<string, unknown>).significant_periods)
      && ((evidence as Record<string, unknown>).significant_periods as unknown[]).length > 0,
    selected_level: selectedLevel,
    selected_families_count: compact.selected_families.length,
    omitted_families_count: compact.omitted_families.length,
    relationship_decisions_count: compact.relationship_decisions.length,
    source_total_events: Number(evidence?.summaries?.total_events ?? 0),
  };
}

function diversityDistance(a: SelectedCase, b: SelectedCase): number {
  let score = 0;
  const fa = a.evidence_features;
  const fb = b.evidence_features;
  if (fa.has_meals !== fb.has_meals) score += 1;
  if (fa.has_insulin !== fb.has_insulin) score += 1;
  if (fa.has_hypo !== fb.has_hypo) score += 1;
  if (fa.has_unknown_or_missing !== fb.has_unknown_or_missing) score += 1;
  if (fa.has_significant_periods !== fb.has_significant_periods) score += 1;
  score += Math.abs(getLevelRank(fa.selected_level) - getLevelRank(fb.selected_level)) * 0.5;
  score += Math.min(2, Math.abs(fa.source_total_events - fb.source_total_events) / 200);
  score += Math.min(1.5, Math.abs(fa.omitted_families_count - fb.omitted_families_count) / 2);
  return Number(score.toFixed(4));
}

function pickDiverseCases(cases: SelectedCase[], count: number): SelectedCase[] {
  if (cases.length <= count) {
    return cases;
  }

  const sorted = [...cases].sort((a, b) => b.evidence_features.source_total_events - a.evidence_features.source_total_events);
  const picked: SelectedCase[] = [sorted[0]];

  while (picked.length < count) {
    let bestIndex = -1;
    let bestScore = -Infinity;

    for (let index = 0; index < sorted.length; index += 1) {
      const candidate = sorted[index];
      if (picked.some((item) => item.capture.task_identity === candidate.capture.task_identity)) {
        continue;
      }

      const minDistance = Math.min(...picked.map((item) => diversityDistance(item, candidate)));
      const tieBreaker = candidate.evidence_features.source_total_events / 10_000;
      const score = minDistance + tieBreaker;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex < 0) {
      break;
    }

    picked.push(sorted[bestIndex]);
  }

  return picked.slice(0, count);
}

/**
 * Cases from the explicitly given capture reports (formerly: every fresh-time-range-capture-report-*.json under
 * artifacts/evaluation). Reports are visited in the same order as before (by file name, newest name first), non-READY
 * reports are skipped, and each READY report's capture must have been given with --capture.
 */
async function loadReadyCaptures(captureReports: readonly string[], captures: readonly string[]): Promise<SelectedCase[]> {
  const readyReportFiles = [...captureReports].sort((left, right) => (basename(left) < basename(right) ? -1 : basename(left) > basename(right) ? 1 : 0));

  const all: SelectedCase[] = [];

  for (let index = readyReportFiles.length - 1; index >= 0; index -= 1) {
    const reportPath = readyReportFiles[index];
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as ReadyReport;
    if (report.status !== 'FRESH_TIME_RANGE_CAPTURE_READY') {
      continue;
    }

    const capturePath = captureForReport(report.capture_file_path, captures, reportPath);
    const lines = (await readFile(capturePath, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const line of lines) {
      const capture = JSON.parse(line) as CaptureRecord;
      if (capture.task.task_type !== 'CONVERSATION_TIME_RANGE_ANALYSIS') {
        continue;
      }
      if (!capture.request_representation || !capture.input_fingerprint || !capture.serialized_input_bytes) {
        continue;
      }

      const task = toAiTask(capture.task, capture.context_package);
      const compact = buildCompactDeliveryArtifact({ contextPackage: capture.context_package, task });
      if (compact.deterministic_replay_metadata.source_context_package_hash !== capture.task.context_package_hash) {
        continue;
      }

      all.push({
        capture,
        source_capture_run_id: report.run_id,
        source_capture_file: capturePath,
        evidence_features: shapeFeatures(capture, compact),
      });
    }
  }

  const deduped = new Map<string, SelectedCase>();
  for (const row of all) {
    if (!deduped.has(row.capture.task_identity)) {
      deduped.set(row.capture.task_identity, row);
    }
  }
  return [...deduped.values()];
}

function classifyReview(args: {
  verdict: PairVerdict;
  failures: string[];
  material: string[];
}): CaseReport['review_classification'] {
  if (args.verdict !== 'REVIEW') {
    return {
      difference_markers: [],
      classification: 'NO_REVIEW',
      notes: 'No REVIEW verdict for this case.',
    };
  }

  if (args.failures.length > 0) {
    return {
      difference_markers: args.material,
      classification: 'REAL_REGRESSION',
      notes: `REVIEW accompanied by invariant failures: ${args.failures.join(', ')}`,
    };
  }

  return {
    difference_markers: args.material,
    classification: 'COMPARATOR_LIMITATION',
    notes: 'REVIEW without invariant failures; requires forensic confirmation before reclassification.',
  };
}

function hoursCovered(startIso: string, endIso: string): number {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }
  return Number((((end - start) / 3_600_000)).toFixed(2));
}

function buildMarkdown(args: {
  experimentId: string;
  generatedAt: string;
  provider: string;
  model: string | null;
  sourceRuns: string[];
  cases: CaseReport[];
  aggregate: Record<string, unknown>;
  verdict: 'READY_FOR_PRODUCTION_EVALUATION' | 'READY_FOR_LARGER_EVALUATION' | 'NOT_READY';
  verdictReason: string;
  constraintsNote: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Expanded TIME_RANGE FULL vs COMPACT Replay (${args.experimentId})`);
  lines.push('');
  lines.push('## Experiment');
  lines.push(`- Provider: ${args.provider}`);
  lines.push(`- Model: ${args.model ?? 'unknown'}`);
  lines.push(`- Case count: ${args.cases.length}`);
  lines.push(`- Generated at: ${args.generatedAt}`);
  lines.push(`- Source capture runs: ${args.sourceRuns.join(', ')}`);
  lines.push(`- Note: ${args.constraintsNote}`);
  lines.push('');
  lines.push('## Case matrix');
  lines.push('| Case | Range | Evidence size | FULL tokens | COMPACT tokens | Reduction | Quality | Invariants |');
  lines.push('|------|-------|---------------|-------------|----------------|-----------|---------|------------|');
  for (const row of args.cases) {
    lines.push(`| ${row.case_id} | ${row.range.range_type} (${row.range.hours_covered}h) | ${row.evidence_coverage.source_evidence_sections.total_events} events | ${row.full.metrics.input_tokens ?? 'NA'} | ${row.compact.metrics.input_tokens ?? 'NA'} | ${row.metric_reduction.input_token_reduction_pct ?? 'NA'}% | ${row.verdict} | ${row.invariant_results.failures.length === 0 ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('');
  lines.push('## Evidence coverage');
  for (const row of args.cases) {
    lines.push(`### ${row.case_id}`);
    lines.push(`- Selected families: ${row.evidence_coverage.selected_families.join(', ') || 'none'}`);
    lines.push(`- Omitted families: ${row.evidence_coverage.omitted_families.join(', ') || 'none'}`);
    lines.push(`- Omission reasons: ${row.evidence_coverage.omission_reasons.join(', ') || 'none'}`);
    lines.push(`- Relationship decisions: ${row.evidence_coverage.relationship_decisions_count}`);
    lines.push(`- Unknown states: ${row.evidence_coverage.unknown_states.join(', ') || 'none'}`);
    lines.push(`- Missing states: ${row.evidence_coverage.missing_states.join(', ') || 'none'}`);
    lines.push(`- Excluded states: ${row.evidence_coverage.excluded_states.join(', ') || 'none'}`);
    lines.push(`- Not selected states: ${row.evidence_coverage.not_selected_states.join(', ') || 'none'}`);
    lines.push(`- Selected level: ${row.evidence_coverage.selected_level ?? 'unknown'} (default ${row.evidence_coverage.default_level ?? 'unknown'})`);
  }
  lines.push('');
  lines.push('## Semantic differences');
  for (const row of args.cases) {
    lines.push(`- ${row.case_id}: material=[${row.semantic_comparison.potentially_material_differences.join(', ')}], benign=[${row.semantic_comparison.benign_differences.join(', ')}], review_classification=${row.review_classification.classification}`);
  }
  lines.push('');
  lines.push('## Economics');
  lines.push(`- Aggregate: ${JSON.stringify(args.aggregate)}`);
  lines.push('');
  lines.push('## Verdict');
  lines.push(`- ${args.verdict}`);
  lines.push(`- Reason: ${args.verdictReason}`);
  lines.push('- This is still a small evaluation sample. It does not prove production-wide quality. It validates that Compact Delivery is promising enough for the next evaluation stage.');

  return `${lines.join('\n')}\n`;
}

// Usage: tsx scripts/dual-time-range-expanded-replay.ts --capture-report <report.json> --capture <capture.ndjson>
//   [--capture-report ... --capture ...] --output-dir <dir outside every Git working tree>
// Live and paid: two provider calls per selected case. Inputs are read only; reports go only to the validated --output-dir.
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // Paths first: before .env is loaded, credentials are read, the client is built or any capture is read.
  const { outputDir, captureReports, captures } = parseReplayArguments(argv, { single: false });
  loadDotenv();

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for expanded replay.');
  }

  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS ?? '30000');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('OPENAI_TIMEOUT_MS must be a positive integer');
  }

  const minCases = 5;

  const pricing = {
    input_per_1k_tokens: parseNullablePrice(process.env.OPENAI_PRICING_INPUT_PER_1K_TOKENS),
    output_per_1k_tokens: parseNullablePrice(process.env.OPENAI_PRICING_OUTPUT_PER_1K_TOKENS),
    cached_input_per_1k_tokens: parseNullablePrice(process.env.OPENAI_PRICING_CACHED_INPUT_PER_1K_TOKENS),
    reasoning_per_1k_tokens: parseNullablePrice(process.env.OPENAI_PRICING_REASONING_PER_1K_TOKENS),
    currency: parseNullableText(process.env.OPENAI_PRICING_CURRENCY),
    pricing_version: parseNullableText(process.env.OPENAI_PRICING_VERSION),
  };
  const hasPricing = Object.values(pricing).some((value) => value !== null);

  const available = await loadReadyCaptures(captureReports, captures);
  if (available.length < minCases) {
    throw new Error(`Found ${available.length} READY captured TIME_RANGE cases; need at least ${minCases}.`);
  }

  const selected = pickDiverseCases(available, minCases);
  if (selected.length < minCases) {
    throw new Error(`Selected ${selected.length} cases after diversity pass; need ${minCases}.`);
  }

  // Same cost guard and durable experiment budget as the worker; refuses to start without them.
  const client = createGuardedOpenAiClientFromEnv(process.env, apiKey);
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;

  const caseReports: CaseReport[] = [];

  for (let index = 0; index < selected.length; index += 1) {
    const picked = selected[index];
    const capture = picked.capture;

    if (!capture.request_representation || !capture.input_fingerprint || !capture.serialized_input_bytes || !capture.task_identity) {
      throw new Error(`Prerequisite validation failed for case ${capture.task_identity}: missing capture fields.`);
    }
    if (!capture.model || !capture.task.output_schema_version || !capture.context_package) {
      throw new Error(`Prerequisite validation failed for case ${capture.task_identity}: missing model/schema/context.`);
    }

    const task = toAiTask(capture.task, capture.context_package);
    const compactArtifact = buildCompactDeliveryArtifact({ contextPackage: capture.context_package, task });
    if (compactArtifact.deterministic_replay_metadata.source_context_package_hash !== capture.task.context_package_hash) {
      throw new Error(`Compact source linkage mismatch for case ${capture.task_identity}`);
    }

    const fullRequest = capture.request_representation;
    const compactRequest = buildOpenAiResponsesRequestBody({
      model: capture.model,
      task_type: capture.task.task_type,
      system_instructions: capture.prompt.system_instructions,
      user_payload: buildCompactUserPayload(capture),
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
    const reviewClassification = classifyReview({
      verdict: pairEval.verdict,
      failures: pairEval.invariants.failures,
      material: pairEval.comparison.potentially_material_differences,
    });

    const omissionReasons = Array.from(new Set(
      compactArtifact.family_decisions
        .map((item) => item.omission_reason_code)
        .filter((item): item is string => Boolean(item)),
    )).sort();

    caseReports.push({
      case_id: `time-range-case-${index + 1}`,
      source_capture_id: `${capture.captured_at}:${capture.task_identity}`,
      source_capture_run_id: picked.source_capture_run_id,
      source_capture_file: picked.source_capture_file,
      source_task_identity: capture.task_identity,
      task_type: capture.task.task_type,
      range: {
        range_type: capture.context_package.analysis_request_input.range_type,
        range_start: capture.context_package.analysis_request_input.range_start,
        range_end: capture.context_package.analysis_request_input.range_end,
        timezone: capture.context_package.analysis_request_input.timezone,
        hours_covered: hoursCovered(
          capture.context_package.analysis_request_input.range_start,
          capture.context_package.analysis_request_input.range_end,
        ),
      },
      full: fullResult,
      compact: compactResult,
      metric_reduction: reduction,
      semantic_comparison: pairEval.comparison,
      invariant_results: pairEval.invariants,
      quality_dimensions: pairEval.quality_dimensions,
      verdict: pairEval.verdict,
      review_classification: reviewClassification,
      evidence_coverage: {
        source_evidence_sections: {
          total_events: Number(capture.context_package.analytical_evidence?.summaries?.total_events ?? 0),
          glucose_events: Number(capture.context_package.analytical_evidence?.summaries?.glucose_count ?? 0),
          insulin_treatment_events: Number(capture.context_package.analytical_evidence?.summaries?.insulin_treatment_count ?? 0),
          meal_events: Number(capture.context_package.analytical_evidence?.summaries?.meal_count ?? 0),
          activity_events: Number(capture.context_package.analytical_evidence?.summaries?.activity_count ?? 0),
          hypo_episodes: Number(capture.context_package.analytical_evidence?.summaries?.hypo_episode_count ?? 0),
        },
        has_significant_periods: picked.evidence_features.has_significant_periods,
        selected_families: compactArtifact.selected_families,
        omitted_families: compactArtifact.omitted_families,
        omission_reasons: omissionReasons,
        relationship_decisions_count: compactArtifact.relationship_decisions.length,
        unknown_states: compactArtifact.unknown_states,
        missing_states: compactArtifact.missing_states,
        excluded_states: compactArtifact.excluded_states,
        not_selected_states: compactArtifact.not_selected_states,
        selected_level: compactArtifact.policy.selected_level,
        default_level: compactArtifact.policy.default_level,
        unresolved_reasons: compactArtifact.unresolved_reasons,
      },
    });
  }

  const byteStats = percentileNumbers(caseReports.map((item) => item.metric_reduction.input_byte_reduction_pct));
  const inputTokenStats = percentileNumbers(caseReports.map((item) => item.metric_reduction.input_token_reduction_pct));
  const totalTokenStats = percentileNumbers(caseReports.map((item) => item.metric_reduction.total_token_reduction_pct));
  const outputTokenDeltas = caseReports
    .map((item) => item.metric_reduction.output_token_delta)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  const invariantFailures = caseReports.reduce((acc, item) => acc + item.invariant_results.failures.length, 0);
  const semanticFailCount = caseReports.filter((item) => item.verdict === 'FAIL').length;
  const reviewCount = caseReports.filter((item) => item.verdict === 'REVIEW').length;
  const passCount = caseReports.filter((item) => item.verdict === 'PASS').length;
  const passBenignCount = caseReports.filter((item) => item.verdict === 'PASS_WITH_BENIGN_DIFFERENCE').length;
  const materialDifferenceCount = caseReports.reduce((acc, item) => acc + item.semantic_comparison.potentially_material_differences.length, 0);
  const benignDifferenceCount = caseReports.reduce((acc, item) => acc + item.semantic_comparison.benign_differences.length, 0);

  const unsupportedCompactClaims = caseReports.some((item) => !item.invariant_results.no_unsupported_compact_claims);
  const currentHistoricalErrors = caseReports.some((item) => !item.invariant_results.no_historical_as_current_flip);
  const uncertaintyCorruption = caseReports.some((item) => !item.invariant_results.hard_data_state_preserved);
  const safetyBoundaryRegression = caseReports.some((item) => !item.invariant_results.no_autonomous_treatment_action);

  const substantialReduction = (byteStats.average ?? 0) > 0 && (inputTokenStats.average ?? 0) > 0;

  let verdict: 'READY_FOR_PRODUCTION_EVALUATION' | 'READY_FOR_LARGER_EVALUATION' | 'NOT_READY' = 'NOT_READY';
  let verdictReason = 'Hard gate failed.';

  if (
    invariantFailures === 0
    && semanticFailCount === 0
    && materialDifferenceCount === 0
    && !unsupportedCompactClaims
    && !currentHistoricalErrors
    && !uncertaintyCorruption
    && !safetyBoundaryRegression
    && substantialReduction
  ) {
    verdict = 'READY_FOR_PRODUCTION_EVALUATION';
    verdictReason = 'All hard invariants passed, no material semantic issues observed, and substantial reductions persisted.';
  } else if (
    invariantFailures === 0
    && semanticFailCount === 0
    && !unsupportedCompactClaims
    && !currentHistoricalErrors
    && !uncertaintyCorruption
    && !safetyBoundaryRegression
    && substantialReduction
  ) {
    verdict = 'READY_FOR_LARGER_EVALUATION';
    verdictReason = 'Hard invariants passed and no safety regressions; remaining non-fail issues require broader evaluation.';
  }

  const sourceRuns = Array.from(new Set(caseReports.map((item) => item.source_capture_run_id))).sort();
  const sourceRunFiles = Array.from(new Set(caseReports.map((item) => item.source_capture_file))).sort();

  const aggregate = {
    case_count: caseReports.length,
    full_calls: caseReports.length,
    compact_calls: caseReports.length,
    invariant_failures: invariantFailures,
    semantic_fail_count: semanticFailCount,
    review_count: reviewCount,
    pass_count: passCount,
    pass_with_benign_difference_count: passBenignCount,
    material_difference_count: materialDifferenceCount,
    benign_difference_count: benignDifferenceCount,
    average_input_byte_reduction_pct: byteStats.average,
    median_input_byte_reduction_pct: byteStats.median,
    min_input_byte_reduction_pct: byteStats.min,
    max_input_byte_reduction_pct: byteStats.max,
    average_input_token_reduction_pct: inputTokenStats.average,
    median_input_token_reduction_pct: inputTokenStats.median,
    min_input_token_reduction_pct: inputTokenStats.min,
    max_input_token_reduction_pct: inputTokenStats.max,
    average_total_token_reduction_pct: totalTokenStats.average,
    median_total_token_reduction_pct: totalTokenStats.median,
    output_token_delta_distribution: {
      min: outputTokenDeltas.length > 0 ? outputTokenDeltas[0] : null,
      max: outputTokenDeltas.length > 0 ? outputTokenDeltas[outputTokenDeltas.length - 1] : null,
      values: outputTokenDeltas,
    },
    coverage_counts: {
      with_unknown_or_missing: caseReports.filter((item) => item.evidence_coverage.unknown_states.length > 0 || item.evidence_coverage.missing_states.length > 0).length,
      with_meals: caseReports.filter((item) => item.evidence_coverage.source_evidence_sections.meal_events > 0).length,
      with_insulin_evidence: caseReports.filter((item) => item.evidence_coverage.source_evidence_sections.insulin_treatment_events > 0).length,
      with_hypo_evidence: caseReports.filter((item) => item.evidence_coverage.source_evidence_sections.hypo_episodes > 0).length,
      with_significant_periods: caseReports.filter((item) => item.evidence_coverage.has_significant_periods).length,
      with_l2_or_l3_escalation: caseReports.filter((item) => ['L2', 'L3'].includes(item.evidence_coverage.selected_level ?? '')).length,
    },
  };

  const experimentId = `dual-time-range-expanded-replay-${runId}`;
  const generatedAt = new Date().toISOString();
  const jsonReport = {
    experiment: {
      experiment_id: experimentId,
      generated_at: generatedAt,
      mode: 'EVALUATION_ONLY',
      source_capture_runs: sourceRuns,
      source_capture_files: sourceRunFiles,
      calls: {
        full: caseReports.length,
        compact: caseReports.length,
      },
      constraints: {
        production_compact_delivery_modified: false,
        production_evidence_selection_policy_modified: false,
        context_package_contract_modified: false,
        prompt_or_task_semantics_modified: false,
      },
      limitation_note: 'Current product flow supports TODAY range type only in this environment; expanded batch used diverse real TODAY windows/evidence shapes from fresh captures.',
    },
    provider: 'openai',
    model: caseReports[0]?.full.metrics.model ?? null,
    cases: caseReports,
    aggregate,
    verdict,
    verdict_reason: verdictReason,
    cost_availability: hasPricing ? 'AVAILABLE_IF_PROVIDER_USAGE_PRESENT' : 'COST_UNAVAILABLE',
  };

  const markdown = buildMarkdown({
    experimentId,
    generatedAt,
    provider: 'openai',
    model: caseReports[0]?.full.metrics.model ?? null,
    sourceRuns,
    cases: caseReports,
    aggregate,
    verdict,
    verdictReason,
    constraintsNote: 'Current product path exposes TODAY range only; this run preserves requirement of real, distinct cases via semantic/evidence-shape diversity.',
  });

  const jsonPath = writeEvaluationOutputDirFile(outputDir, `${experimentId}.json`, `${JSON.stringify(jsonReport, null, 2)}\n`);
  const mdPath = writeEvaluationOutputDirFile(outputDir, `${experimentId}.md`, markdown);

  console.log(JSON.stringify({
    status: 'DUAL_TIME_RANGE_EXPANDED_REPLAY_COMPLETED',
    experiment_id: experimentId,
    json_report_path: jsonPath,
    markdown_report_path: mdPath,
    case_count: caseReports.length,
    full_calls: caseReports.length,
    compact_calls: caseReports.length,
    verdict,
    report_hash: buildExactInputFingerprint(JSON.parse(canonicalJson(jsonReport))),
  }, null, 2));
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(`[dual-time-range-expanded-replay] failed: ${describeErrorSafely(error, [ReplayArgumentError])}`);
    process.exitCode = 1;
  });
}
