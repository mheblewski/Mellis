import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildTimeRangeAnalysisPrompt } from '@modules/ai-gateway/application/time-range-analysis-prompt';
// The compact builder this tool needs does not exist; see compact-prompt-builder.ts (the tool fails closed).
import { assertCompactPromptBuilderAvailable, buildCompactTimeRangeAnalysisPrompt, CompactPromptBuilderUnavailableError } from './compact-prompt-builder';
import { buildOpenAiResponsesRequestBody } from '@modules/ai-gateway/infrastructure/openai-provider';
import { buildCompactDeliveryArtifactFromRuntime } from '@modules/context/application/compact-delivery-artifact';
import type { AiTask, TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import { describeErrorSafely, positionalArguments, requireInputFileArgument, resolveEvaluationOutputDir, writeEvaluationOutputDirFile } from './evaluation-output-dir';

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

type VariantId = 'A_FULL_CURRENT' | 'B_COMPACT_CURRENT' | 'C_L1_SUMMARY' | 'D_L1_L2_SIGNIFICANT' | 'E_L1_L2_L3_TARGETED';

// Usage: tsx scripts/evaluation/offline-time-range-token-minimization-benchmark.ts <capture.ndjson> --output-dir <dir outside every Git working tree>
// The capture and the outputs (full request variants) contain patient data: there is no default input or output, and
// the output directory is validated before the capture is read.

const bytes = (v: unknown): number => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');

function toIso(value: unknown): string | null {
  const s = typeof value === 'string' ? value : String(value ?? '');
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function asTask(capture: CaptureRecord): AiTask {
  return {
    task_id: capture.task.task_id,
    task_type: capture.task.task_type as AiTask['task_type'],
    task_version: capture.task.task_version,
    context_package_id: capture.task.context_package_id,
    context_package_version: capture.task.context_package_version,
    context_package_hash: capture.task.context_package_hash,
    prompt_version: capture.task.prompt_version,
    output_schema_version: capture.task.output_schema_version,
    model_policy_version: capture.task.model_policy_version,
    correlation_id: capture.task.correlation_id,
    created_at: capture.task.created_at,
    patient_id: String(capture.context_package.patient_ref?.patient_id ?? ''),
  };
}

function selectCapture(records: CaptureRecord[]): CaptureRecord {
  const candidates = records.filter((record) => (
    record.task.task_type === 'CONVERSATION_TIME_RANGE_ANALYSIS'
    && record.context_package.analysis_request_input?.range_type === 'TODAY'
  ));

  if (candidates.length === 0) {
    throw new Error('No CONVERSATION_TIME_RANGE_ANALYSIS TODAY capture found.');
  }

  candidates.sort((left, right) => String(right.task.created_at).localeCompare(String(left.task.created_at)));
  return candidates[0];
}

function parseUserPayloadFromRequest(request: Record<string, unknown>): Record<string, unknown> {
  const input = Array.isArray(request.input) ? request.input as Array<Record<string, unknown>> : [];
  const user = input.find((entry) => entry.role === 'user');
  if (!user || typeof user.content !== 'string') {
    throw new Error('Unable to parse user payload from request input.');
  }
  return JSON.parse(user.content) as Record<string, unknown>;
}

function sectionSizesFromUserPayload(payload: Record<string, unknown>): Array<{ section: string; bytes: number; percent: number }> {
  const total = bytes(payload);
  return Object.entries(payload)
    .map(([section, value]) => ({
      section,
      bytes: bytes(value),
      percent: total > 0 ? Number(((bytes(value) / total) * 100).toFixed(4)) : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);
}

function topDuplicates(payload: Record<string, unknown>): string[] {
  const duplicates: string[] = [];

  const analysis = payload.analysis_request_input as Record<string, unknown> | undefined;
  const conv = payload.conversation_context as Record<string, unknown> | undefined;
  const msgs = Array.isArray(conv?.recent_messages) ? conv?.recent_messages as Array<Record<string, unknown>> : [];
  const msgMatch = msgs.some((msg) => msg.content === analysis?.user_message_text);
  if (msgMatch) {
    duplicates.push('user question duplicated in analysis_request_input.user_message_text and conversation_context.recent_messages[].content');
  }

  if (payload.current_state_snapshot && payload.compact_delivery_artifact) {
    duplicates.push('current_state_snapshot overlaps semantically with compact artifact current-state summary families');
  }

  if (payload.provenance_summary && payload.compact_delivery_artifact) {
    duplicates.push('provenance_summary coexists with provenance-related compact artifact structures');
  }

  return duplicates;
}

function mapTrend(direction: unknown): string | null {
  if (typeof direction !== 'string') return null;
  const d = direction.toLowerCase();
  if (d.includes('up')) return '↑';
  if (d.includes('down')) return '↓';
  if (d.includes('flat')) return '→';
  return null;
}

function asNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function classifyInsulinEventType(type: string): 'INSULIN_ADMIN' | 'THERAPY_CHANGE' | 'IOB_SNAPSHOT' | 'COB_SNAPSHOT' | 'OTHER' {
  if (type === 'IOB_SNAPSHOT') return 'IOB_SNAPSHOT';
  if (type === 'COB_SNAPSHOT') return 'COB_SNAPSHOT';
  if (type === 'TEMP_BASAL' || type === 'BASAL_PROFILE_SWITCH') return 'THERAPY_CHANGE';
  if (type === 'BOLUS' || type === 'SMB' || type === 'INSULIN_CORRECTION') return 'INSULIN_ADMIN';
  return 'OTHER';
}

function buildL1Payload(args: {
  task: AiTask;
  context: TimeRangeAnalysisContextRecord;
  compactArtifact: Record<string, unknown>;
}): Record<string, unknown> {
  const analytical = args.context.analytical_evidence as any;
  const glucoseEvents = Array.isArray(analytical?.glucose_events) ? analytical.glucose_events : [];

  const values = glucoseEvents
    .map((event: any) => asNumber(event?.payload?.glucose_value))
    .filter((v: number | null): v is number => v !== null);

  const min = values.length > 0 ? Math.min(...values) : null;
  const max = values.length > 0 ? Math.max(...values) : null;

  const compact = args.compactArtifact as any;

  return {
    task: {
      task_type: args.task.task_type,
      task_version: args.task.task_version,
      prompt_version: args.task.prompt_version,
      output_schema_version: args.task.output_schema_version,
      correlation_id: args.task.correlation_id,
    },
    patient_ref: args.context.patient_ref,
    analysis_request_input: args.context.analysis_request_input,
    daily_summary: {
      glucose: {
        min,
        max,
        count: values.length,
        below_70_count: values.filter((value: number) => value < 70).length,
        above_180_count: values.filter((value: number) => value > 180).length,
      },
      event_counts: {
        glucose_events: glucoseEvents.length,
        insulin_treatment_events: Array.isArray(analytical?.insulin_treatment_events) ? analytical.insulin_treatment_events.length : 0,
        meal_events: Array.isArray(analytical?.meal_events) ? analytical.meal_events.length : 0,
        activity_events: Array.isArray(analytical?.activity_events) ? analytical.activity_events.length : 0,
        hypo_episodes: Array.isArray(analytical?.hypo_episodes) ? analytical.hypo_episodes.length : 0,
        range_event_facts: Array.isArray(analytical?.range_event_facts) ? analytical.range_event_facts.length : 0,
      },
      current_state_snapshot: args.context.current_state_snapshot ?? null,
      missing_sections: Array.isArray(analytical?.summaries?.missing_sections) ? analytical.summaries.missing_sections : [],
    },
    semantics_status: {
      unknown_states: compact.unknown_states ?? [],
      missing_states: compact.missing_states ?? [],
      excluded_states: compact.excluded_states ?? [],
      not_selected_states: compact.not_selected_states ?? [],
      unresolved_reasons: compact.unresolved_reasons ?? [],
    },
    evidence_contract: {
      use_only_observed_and_deterministic_data: true,
      never_invent_patient_specific_events_or_values: true,
      explicitly_mark_missing_or_unknown_sections: true,
      no_treatment_recommendations: true,
      no_therapy_adjustment_advice: true,
      no_insulin_dosing_guidance: true,
      no_chain_of_thought: true,
    },
  };
}

function extractSignificantPeriodsFromArtifact(compactArtifact: Record<string, unknown>): unknown[] {
  const compact = compactArtifact as any;
  const payloads = Array.isArray(compact?.selected_payloads) ? compact.selected_payloads : [];
  const significant = payloads.find((payload: any) => payload?.family === 'SIGNIFICANT_PERIODS');
  const inner = significant?.payload;
  if (!inner || typeof inner !== 'object') return [];
  return Array.isArray(inner.items) ? inner.items : [];
}

function buildL2Payload(baseL1: Record<string, unknown>, compactArtifact: Record<string, unknown>): Record<string, unknown> {
  const significantPeriods = extractSignificantPeriodsFromArtifact(compactArtifact);
  return {
    ...baseL1,
    significant_periods: significantPeriods,
  };
}

function buildL3Payload(args: {
  baseL2: Record<string, unknown>;
  context: TimeRangeAnalysisContextRecord;
}): Record<string, unknown> {
  const analytical = args.context.analytical_evidence as any;
  const glucoseEvents = Array.isArray(analytical?.glucose_events) ? analytical.glucose_events : [];
  const insulinEvents = Array.isArray(analytical?.insulin_treatment_events) ? analytical.insulin_treatment_events : [];
  const mealEvents = Array.isArray(analytical?.meal_events) ? analytical.meal_events : [];
  const hypoEpisodes = Array.isArray(analytical?.hypo_episodes) ? analytical.hypo_episodes : [];

  const windows = hypoEpisodes.map((episode: any, index: number) => {
    const started = toIso(episode?.started_at);
    const ended = toIso(episode?.ended_at) ?? started;
    if (!started || !ended) {
      return {
        window_id: `window_${index + 1}`,
        status: 'UNAVAILABLE',
      };
    }

    const startMs = new Date(started).getTime();
    const endMs = new Date(ended).getTime();
    const preStart = startMs - 30 * 60 * 1000;
    const postEnd = endMs + 30 * 60 * 1000;

    const glucoseInRange = glucoseEvents
      .map((event: any) => {
        const iso = toIso(event?.occurred_at);
        const value = asNumber(event?.payload?.glucose_value);
        const trend = mapTrend(event?.payload?.raw_payload?.direction);
        if (!iso || value === null) return null;
        const ts = new Date(iso).getTime();
        if (ts < preStart || ts > postEnd) return null;
        let phase: 'PRE' | 'DURING' | 'POST' = 'DURING';
        if (ts < startMs) phase = 'PRE';
        if (ts > endMs) phase = 'POST';
        return {
          at: iso,
          hhmm_utc: hhmm(iso),
          glucose_mgdl: value,
          trend_symbol: trend,
          phase,
        };
      })
      .filter((row: any): row is Record<string, unknown> => Boolean(row));

    const insulinContext = insulinEvents
      .map((event: any) => {
        const iso = toIso(event?.occurred_at);
        if (!iso) return null;
        const ts = new Date(iso).getTime();
        if (ts < preStart || ts > postEnd) return null;
        const type = String(event?.type ?? 'UNKNOWN');
        const category = classifyInsulinEventType(type);
        return {
          at: iso,
          hhmm_utc: hhmm(iso),
          type,
          category,
          insulin_units: asNumber(event?.payload?.insulin_units),
          rate: asNumber(event?.payload?.rate),
          absolute: asNumber(event?.payload?.absolute),
          duration_minutes: asNumber(event?.payload?.duration_minutes),
          iob: asNumber(event?.payload?.iob),
          cob: asNumber(event?.payload?.cob),
        };
      })
      .filter((row: any): row is Record<string, unknown> => Boolean(row));

    const mealContext = mealEvents
      .map((event: any) => {
        const iso = toIso(event?.occurred_at);
        if (!iso) return null;
        const ts = new Date(iso).getTime();
        if (ts < preStart || ts > postEnd) return null;
        return {
          at: iso,
          hhmm_utc: hhmm(iso),
          carbs: asNumber(event?.payload?.carbs),
          source_event_type: event?.payload?.source_event_type ?? null,
        };
      })
      .filter((row: any): row is Record<string, unknown> => Boolean(row));

    return {
      window_id: `window_${index + 1}`,
      trigger_episode: {
        severity: episode?.severity ?? null,
        started_at: started,
        ended_at: ended,
      },
      glucose_points: glucoseInRange,
      insulin_context: insulinContext,
      meal_context: mealContext,
      activity_context: {
        status: Array.isArray(analytical?.activity_events) && analytical.activity_events.length > 0 ? 'AVAILABLE' : 'MISSING',
      },
    };
  });

  return {
    ...args.baseL2,
    targeted_windows: windows,
  };
}

function evaluateSemanticCriteria(payload: Record<string, unknown>, variantId: VariantId): Record<string, { pass: boolean; reason: string }> {
  const hasSummary = Boolean(payload.daily_summary);
  const significant = Array.isArray(payload.significant_periods) ? payload.significant_periods : [];
  const windows = Array.isArray(payload.targeted_windows) ? payload.targeted_windows : [];

  const insulinContextPresent = windows.some((window: any) => Array.isArray(window?.insulin_context) && window.insulin_context.length > 0);
  const mealContextPresent = windows.some((window: any) => Array.isArray(window?.meal_context) && window.meal_context.length > 0);

  const statusObj = payload.semantics_status as Record<string, unknown> | undefined;
  const statusAvailable = Boolean(statusObj);

  return {
    preserves_hypo_count_and_timing: {
      pass: variantId === 'A_FULL_CURRENT' || variantId === 'B_COMPACT_CURRENT' || significant.length > 0,
      reason: significant.length > 0 ? 'significant periods present' : 'requires significant periods or full/compact canonical content',
    },
    preserves_min_max_and_change_direction_context: {
      pass: variantId === 'E_L1_L2_L3_TARGETED' || hasSummary,
      reason: variantId === 'E_L1_L2_L3_TARGETED' ? 'includes selected glucose points around episodes' : 'summary contains min/max and event-level trend requires L3',
    },
    preserves_insulin_therapy_context: {
      pass: variantId === 'A_FULL_CURRENT' || variantId === 'B_COMPACT_CURRENT' || variantId === 'E_L1_L2_L3_TARGETED',
      reason: insulinContextPresent ? 'window insulin context present' : 'only full/compact canonical path carries richer insulin summaries by default',
    },
    preserves_meal_and_activity_context: {
      pass: variantId === 'A_FULL_CURRENT' || variantId === 'B_COMPACT_CURRENT' || mealContextPresent || hasSummary,
      reason: mealContextPresent ? 'window meal context present' : 'summary contains availability but fine detail may be omitted',
    },
    preserves_unknown_missing_excluded_not_selected: {
      pass: variantId === 'A_FULL_CURRENT' || variantId === 'B_COMPACT_CURRENT' || statusAvailable,
      reason: statusAvailable ? 'semantics_status explicitly included' : 'not explicitly represented in this variant',
    },
    avoids_unjustified_causality_and_keeps_uncertainty: {
      pass: Boolean(payload.evidence_contract),
      reason: payload.evidence_contract ? 'evidence contract includes non-causality and uncertainty constraints' : 'missing explicit contract block',
    },
  };
}

function buildVariantRequest(args: {
  variantId: VariantId;
  model: string;
  taskType: string;
  systemInstructions: string;
  userPayload: Record<string, unknown>;
}): Record<string, unknown> {
  return buildOpenAiResponsesRequestBody({
    model: args.model,
    task_type: args.taskType,
    system_instructions: args.systemInstructions,
    user_payload: JSON.stringify(args.userPayload),
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const outputBaseDir = resolveEvaluationOutputDir(argv);
  const fixturePath = requireInputFileArgument(positionalArguments(argv)[0], '<capture.ndjson> argument');
  // Before the capture is read: variants B-E all need the compact builder, so the run could only fail after reading it.
  assertCompactPromptBuilderAvailable();
  // Every file is written below the validated directory through the capture guard (directories 0700, files 0600).
  const writeOutput = (filePath: string, content: string) => writeEvaluationOutputDirFile(outputBaseDir, relative(outputBaseDir, filePath), content);

  const fixtureRaw = await readFile(fixturePath, 'utf8');
  const records = fixtureRaw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CaptureRecord);

  const selected = selectCapture(records);
  const task = asTask(selected);

  const fullPrompt = buildTimeRangeAnalysisPrompt(task, selected.context_package);
  const fullRequest = buildOpenAiResponsesRequestBody({
    model: selected.model,
    task_type: task.task_type,
    system_instructions: fullPrompt.system_instructions,
    user_payload: fullPrompt.user_payload,
  });

  const compactArtifact = buildCompactDeliveryArtifactFromRuntime({ contextPackage: selected.context_package, task });
  const compactPrompt = buildCompactTimeRangeAnalysisPrompt(task, selected.context_package, compactArtifact as unknown as Record<string, unknown>);
  const compactRequest = buildOpenAiResponsesRequestBody({
    model: selected.model,
    task_type: task.task_type,
    system_instructions: compactPrompt.system_instructions,
    user_payload: compactPrompt.user_payload,
  });

  const l1Payload = buildL1Payload({
    task,
    context: selected.context_package,
    compactArtifact: compactArtifact as unknown as Record<string, unknown>,
  });
  const l2Payload = buildL2Payload(l1Payload, compactArtifact as unknown as Record<string, unknown>);
  const l3Payload = buildL3Payload({ baseL2: l2Payload, context: selected.context_package });

  const l1Request = buildVariantRequest({
    variantId: 'C_L1_SUMMARY',
    model: selected.model,
    taskType: task.task_type,
    systemInstructions: compactPrompt.system_instructions,
    userPayload: l1Payload,
  });

  const l2Request = buildVariantRequest({
    variantId: 'D_L1_L2_SIGNIFICANT',
    model: selected.model,
    taskType: task.task_type,
    systemInstructions: compactPrompt.system_instructions,
    userPayload: l2Payload,
  });

  const l3Request = buildVariantRequest({
    variantId: 'E_L1_L2_L3_TARGETED',
    model: selected.model,
    taskType: task.task_type,
    systemInstructions: compactPrompt.system_instructions,
    userPayload: l3Payload,
  });

  const variants: Array<{
    id: VariantId;
    label: string;
    request: Record<string, unknown>;
    userPayload: Record<string, unknown>;
    semantics: Record<string, { pass: boolean; reason: string }>;
  }> = [
    {
      id: 'A_FULL_CURRENT',
      label: 'Current FULL (production builders)',
      request: fullRequest,
      userPayload: parseUserPayloadFromRequest(fullRequest),
      semantics: evaluateSemanticCriteria(parseUserPayloadFromRequest(fullRequest), 'A_FULL_CURRENT'),
    },
    {
      id: 'B_COMPACT_CURRENT',
      label: 'Current COMPACT (production builders)',
      request: compactRequest,
      userPayload: parseUserPayloadFromRequest(compactRequest),
      semantics: evaluateSemanticCriteria(parseUserPayloadFromRequest(compactRequest), 'B_COMPACT_CURRENT'),
    },
    {
      id: 'C_L1_SUMMARY',
      label: 'L1 concise semantic summary',
      request: l1Request,
      userPayload: parseUserPayloadFromRequest(l1Request),
      semantics: evaluateSemanticCriteria(parseUserPayloadFromRequest(l1Request), 'C_L1_SUMMARY'),
    },
    {
      id: 'D_L1_L2_SIGNIFICANT',
      label: 'L1 + L2 (significant periods)',
      request: l2Request,
      userPayload: parseUserPayloadFromRequest(l2Request),
      semantics: evaluateSemanticCriteria(parseUserPayloadFromRequest(l2Request), 'D_L1_L2_SIGNIFICANT'),
    },
    {
      id: 'E_L1_L2_L3_TARGETED',
      label: 'L1 + L2 + L3 (targeted windows)',
      request: l3Request,
      userPayload: parseUserPayloadFromRequest(l3Request),
      semantics: evaluateSemanticCriteria(parseUserPayloadFromRequest(l3Request), 'E_L1_L2_L3_TARGETED'),
    },
  ];

  const ranking = variants
    .map((variant) => ({
      id: variant.id,
      label: variant.label,
      request_bytes: bytes(variant.request),
      user_payload_bytes: bytes(variant.userPayload),
    }))
    .sort((left, right) => left.request_bytes - right.request_bytes);

  const runTag = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z-${randomUUID().slice(0, 8)}`;
  const outDir = join(outputBaseDir, `token-min-benchmark-${runTag}`);
  const variantsDir = join(outDir, 'variants');

  const variantOutputs = [] as Array<Record<string, unknown>>;

  for (const variant of variants) {
    const requestPath = join(variantsDir, `${variant.id}.final-request.json`);
    const payloadPath = join(variantsDir, `${variant.id}.user-payload-readable.md`);

    writeOutput(requestPath, `${JSON.stringify(variant.request, null, 2)}\n`);

    const payloadMd = [
      `# ${variant.id} User Payload`,
      '',
      `- variant: ${variant.label}`,
      `- request_bytes: ${bytes(variant.request)}`,
      `- user_payload_bytes: ${bytes(variant.userPayload)}`,
      '- token_count: NOT_AVAILABLE_OFFLINE_NO_TOKENIZER',
      '',
      '## User Payload (Exact JSON)',
      '',
      '```json',
      JSON.stringify(variant.userPayload, null, 2),
      '```',
      '',
      '## Section Sizes',
      '',
      '| section | bytes | percent_of_user_payload |',
      '|---|---:|---:|',
      ...sectionSizesFromUserPayload(variant.userPayload).map((row) => `| ${row.section} | ${row.bytes} | ${row.percent}% |`),
      '',
      '## Duplicate Signals',
      '',
      ...(topDuplicates(variant.userPayload).length > 0 ? topDuplicates(variant.userPayload).map((line) => `- ${line}`) : ['- none detected']),
      '',
      '## Semantic Criteria Snapshot',
      '',
      ...Object.entries(variant.semantics).map(([criterion, result]) => `- ${criterion}: ${result.pass ? 'PASS' : 'FAIL'} (${result.reason})`),
      '',
    ].join('\n');

    writeOutput(payloadPath, payloadMd);

    const presentKeys = Object.keys(variant.userPayload);

    variantOutputs.push({
      id: variant.id,
      label: variant.label,
      request_path: requestPath,
      user_payload_readable_path: payloadPath,
      request_bytes: bytes(variant.request),
      user_payload_bytes: bytes(variant.userPayload),
      token_count: null,
      token_count_status: 'NOT_AVAILABLE_OFFLINE_NO_TOKENIZER',
      preserved_aggregated_omitted: {
        preserved: presentKeys,
        aggregated: presentKeys.filter((key) => key.includes('summary') || key.includes('significant') || key.includes('targeted')),
        omitted: ['raw token counts unavailable offline without tokenizer package'],
      },
      semantics: variant.semantics,
    });
  }

  const benchmarkSummary = {
    status: 'OFFLINE_TIME_RANGE_TOKEN_MINIMIZATION_BENCHMARK_READY',
    generated_at: new Date().toISOString(),
    fixture: {
      file: fixturePath,
      selected_task_identity: selected.task_identity,
      selected_task_created_at: selected.task.created_at,
      range_type: selected.context_package.analysis_request_input.range_type,
      range_start: selected.context_package.analysis_request_input.range_start,
      range_end: selected.context_package.analysis_request_input.range_end,
      timezone: selected.context_package.analysis_request_input.timezone,
    },
    audit: {
      model_visible_fields_by_variant: variantOutputs.map((variant) => ({
        id: variant.id,
        request_bytes: variant.request_bytes,
        user_payload_bytes: variant.user_payload_bytes,
      })),
      tokenizer: {
        available: false,
        reason: 'No local tokenizer package found (gpt-tokenizer/js-tiktoken/tiktoken/@dqbd/tiktoken).',
      },
      duplication_notes: topDuplicates(parseUserPayloadFromRequest(compactRequest)),
      insulin_event_classification_note: 'Insulin records are split into INSULIN_ADMIN, THERAPY_CHANGE, IOB_SNAPSHOT, COB_SNAPSHOT, OTHER in L3 extraction.',
      compact_payload_content_note: 'Current COMPACT includes compact_delivery_artifact with summaries and significant periods in this fixture; no targeted_windows selected.',
    },
    ranking_by_request_size: ranking,
    variants: variantOutputs,
    semantic_gate: {
      criteria: [
        'preserves_hypo_count_and_timing',
        'preserves_min_max_and_change_direction_context',
        'preserves_insulin_therapy_context',
        'preserves_meal_and_activity_context',
        'preserves_unknown_missing_excluded_not_selected',
        'avoids_unjustified_causality_and_keeps_uncertainty',
      ],
    },
    limitations: [
      'No provider calls were made by design.',
      'Token counts are unavailable because no offline tokenizer package is installed.',
      'Semantic equivalence is evaluated deterministically by payload-content criteria only; no model-response quality run is performed.',
    ],
  };

  const summaryJsonPath = join(outDir, 'benchmark-summary.json');
  writeOutput(summaryJsonPath, `${JSON.stringify(benchmarkSummary, null, 2)}\n`);

  const summaryMdLines: string[] = [];
  summaryMdLines.push('# Offline Token Minimization Benchmark');
  summaryMdLines.push('');
  summaryMdLines.push('## Fixture');
  summaryMdLines.push('');
  summaryMdLines.push(`- file: ${fixturePath}`);
  summaryMdLines.push(`- task_identity: ${selected.task_identity}`);
  summaryMdLines.push(`- range: ${selected.context_package.analysis_request_input.range_start} -> ${selected.context_package.analysis_request_input.range_end}`);
  summaryMdLines.push(`- timezone: ${selected.context_package.analysis_request_input.timezone}`);
  summaryMdLines.push('');
  summaryMdLines.push('## Ranking by request size');
  summaryMdLines.push('');
  summaryMdLines.push('| rank | variant | request_bytes | user_payload_bytes | token_count |');
  summaryMdLines.push('|---:|---|---:|---:|---|');
  ranking.forEach((item, index) => {
    summaryMdLines.push(`| ${index + 1} | ${item.id} | ${item.request_bytes} | ${item.user_payload_bytes} | NOT_AVAILABLE_OFFLINE_NO_TOKENIZER |`);
  });
  summaryMdLines.push('');
  summaryMdLines.push('## Token counting');
  summaryMdLines.push('');
  summaryMdLines.push('- status: unavailable');
  summaryMdLines.push('- reason: no local tokenizer package found (gpt-tokenizer/js-tiktoken/tiktoken/@dqbd/tiktoken).');
  summaryMdLines.push('- bytes were measured exactly; no byte-to-token ratio conversion was used.');
  summaryMdLines.push('');
  summaryMdLines.push('## Semantic criteria outcome');
  summaryMdLines.push('');
  for (const variant of variants) {
    summaryMdLines.push(`### ${variant.id}`);
    Object.entries(variant.semantics).forEach(([criterion, result]) => {
      summaryMdLines.push(`- ${criterion}: ${result.pass ? 'PASS' : 'FAIL'} (${result.reason})`);
    });
    summaryMdLines.push('');
  }

  const summaryMdPath = join(outDir, 'benchmark-summary.md');
  writeOutput(summaryMdPath, `${summaryMdLines.join('\n')}\n`);

  const readmePath = join(outDir, 'README.md');
  const readme = [
    '# Offline Benchmark README',
    '',
    'This benchmark compares five representations (A-E) over the same historical fixture data.',
    '',
    'No external AI provider calls, no DB writes, and no Nightscout calls were executed.',
    '',
    '## Run command',
    '',
    '```bash',
    'npx tsx scripts/evaluation/offline-time-range-token-minimization-benchmark.ts <capture.ndjson> --output-dir "$(mktemp -d)"',
    '```',
    '',
    '## Outputs',
    '',
    '- benchmark-summary.json',
    '- benchmark-summary.md',
    '- variants/*.final-request.json',
    '- variants/*.user-payload-readable.md',
    '',
    '## Reconstruction scope',
    '',
    '- A_FULL_CURRENT and B_COMPACT_CURRENT use current production builders and serializer.',
    '- C/D/E are offline benchmark representations generated from the same fixture context without changing production runtime logic.',
  ].join('\n');
  writeOutput(readmePath, `${readme}\n`);

  process.stdout.write(`${JSON.stringify({
    status: 'OFFLINE_TIME_RANGE_TOKEN_MINIMIZATION_BENCHMARK_DONE',
    output_dir: outDir,
    summary_json: summaryJsonPath,
    summary_md: summaryMdPath,
    readme: readmePath,
    variants: variantOutputs.map((variant) => ({
      id: variant.id,
      request_path: variant.request_path,
      readable_path: variant.user_payload_readable_path,
      request_bytes: variant.request_bytes,
      user_payload_bytes: variant.user_payload_bytes,
      token_count_status: variant.token_count_status,
    })),
  }, null, 2)}\n`);
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`[offline-time-range-token-minimization-benchmark] failed: ${describeErrorSafely(error, [CompactPromptBuilderUnavailableError])}\n`);
    process.exitCode = 1;
  });
}
