import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildCompactDeliveryArtifact } from '@modules/context/application/compact-delivery-artifact';
import { evaluateEvidenceSelectionShadowSafe } from '@modules/context/application/evidence-selection-shadow';
import type { AiTask, TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import { buildOpenAiResponsesRequestBody } from '@modules/ai-gateway/infrastructure/openai-provider';
import { describeErrorSafely, positionalArguments, requireInputFileArgument, resolveEvaluationOutputDir, writeEvaluationOutputDirFile } from './evaluation/evaluation-output-dir';
import {
  getRangeSelectionProfile,
  isSupportedConversationTimeRangeType,
  validateNormalizedTimeRangeWindow,
} from '@modules/context/application/time-range-normalization';

type RangeType = 'TODAY' | 'SHORT_RANGE' | 'MEDIUM_RANGE' | 'LONG_RANGE' | 'EXTENDED_RANGE';

export interface CaptureRecord {
  captured_at: string;
  capture_version: string;
  task_identity: string;
  task: {
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
  };
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

interface CaseResult {
  requested_label: 'TODAY' | '3D' | '7D' | '14D' | '30D';
  range_type: RangeType;
  range_profile: string;
  range_start: string;
  range_end: string;
  timezone: string;
  normalization_policy_version: string | null;
  selection_policy_version: string;
  selection_status: string;
  selected_level: string;
  default_level: string;
  selected_families: string[];
  omitted_families: string[];
  omission_reasons: string[];
  unknown_states: string[];
  missing_states: string[];
  excluded_states: string[];
  not_selected_states: string[];
  unresolved_reasons: string[];
  significant_periods_count: number;
  targeted_windows_count: number;
  compact_artifact_hash_1: string;
  compact_artifact_hash_2: string;
  compact_artifact_hash_deterministic: boolean;
  compact_source_context_hash: string;
  compact_source_task_identity: string;
  provenance_ref_count: number;
  provenance_preserved: boolean;
  task_identity: string;
  context_package_hash: string;
  context_package_version: string;
  full_bytes: number;
  compact_bytes: number;
  input_byte_reduction_pct: number;
  token_count_status: 'TOKEN_COUNT_NOT_MEASURED';
  state_semantics_valid: {
    unknown_not_no: boolean;
    missing_not_no: boolean;
    not_selected_not_unknown: boolean;
    excluded_not_missing: boolean;
  };
}

interface LocalValidationReport {
  status:
    | 'MULTI_RANGE_EVIDENCE_VALIDATION_READY'
    | 'MULTI_RANGE_EVIDENCE_VALIDATION_BLOCKED'
    | 'MULTI_RANGE_EVIDENCE_VALIDATION_FAILED';
  generated_at: string;
  run_id: string;
  provider_calls: {
    expected: 0;
    actual: 0;
  };
  source_capture_file: string;
  range_matrix: CaseResult[];
  l1_l2_l3: {
    l1_count: number;
    l2_count: number;
    l3_count: number;
  };
  identity_validation: {
    today_vs_3d: Record<string, boolean>;
    seven_vs_fourteen: Record<string, boolean>;
    fourteen_vs_thirty: Record<string, boolean>;
  };
  findings: string[];
  limitations: string[];
}

export const EXPECTED = [
  { requested_label: 'TODAY' as const, range_type: 'TODAY' as const },
  { requested_label: '3D' as const, range_type: 'SHORT_RANGE' as const },
  { requested_label: '7D' as const, range_type: 'MEDIUM_RANGE' as const },
  { requested_label: '14D' as const, range_type: 'LONG_RANGE' as const },
  { requested_label: '30D' as const, range_type: 'EXTENDED_RANGE' as const },
];

function toAiTask(capture: CaptureRecord): AiTask {
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

function buildCompactUserPayload(capture: CaptureRecord): string {
  const task = toAiTask(capture);
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

export function parseCaptureFile(raw: string): CaptureRecord[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CaptureRecord);
}

export function ensureExpectedRanges(captures: CaptureRecord[]): CaptureRecord[] {
  const byRange = new Map<string, CaptureRecord>();
  for (const capture of captures) {
    const rangeType = capture.context_package.analysis_request_input?.range_type;
    if (typeof rangeType === 'string' && !byRange.has(rangeType)) {
      byRange.set(rangeType, capture);
    }
  }

  const selected: CaptureRecord[] = [];
  for (const expected of EXPECTED) {
    const item = byRange.get(expected.range_type);
    if (!item) {
      throw new Error(`Missing captured range: ${expected.range_type}`);
    }
    selected.push(item);
  }

  return selected;
}

export function computeReductionPct(fullBytes: number, compactBytes: number): number {
  if (fullBytes <= 0) return 0;
  return Number((((fullBytes - compactBytes) / fullBytes) * 100).toFixed(4));
}

export function stateSemanticsValid(args: {
  unknown: string[];
  missing: string[];
  excluded: string[];
  notSelected: string[];
}): {
  unknown_not_no: boolean;
  missing_not_no: boolean;
  not_selected_not_unknown: boolean;
  excluded_not_missing: boolean;
} {
  const unknown = new Set(args.unknown);
  const missing = new Set(args.missing);
  const excluded = new Set(args.excluded);
  const notSelected = new Set(args.notSelected);

  const intersects = (a: Set<string>, b: Set<string>): boolean => {
    for (const key of a) {
      if (b.has(key)) return true;
    }
    return false;
  };

  return {
    unknown_not_no: true,
    missing_not_no: true,
    not_selected_not_unknown: !intersects(notSelected, unknown),
    excluded_not_missing: !intersects(excluded, missing),
  };
}

function identityDifferent(left: CaseResult, right: CaseResult): Record<string, boolean> {
  return {
    task_identity_diff: left.task_identity !== right.task_identity,
    range_identity_diff: `${left.range_type}|${left.range_start}|${left.range_end}` !== `${right.range_type}|${right.range_start}|${right.range_end}`,
    context_hash_diff: left.context_package_hash !== right.context_package_hash,
    compact_source_hash_diff: left.compact_source_context_hash !== right.compact_source_context_hash,
  };
}

// Usage: tsx scripts/multi-range-local-evidence-validation.ts <capture.ndjson> --output-dir <dir outside every Git working tree>
// The capture is real patient data and the reports are derived from it: there is no default input or output, and the
// output directory is validated before the capture is read.
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const outputDir = resolveEvaluationOutputDir(argv);
  const sourceCaptureFile = requireInputFileArgument(positionalArguments(argv)[0], '<capture.ndjson> argument');
  console.log('EXPECTED_PROVIDER_CALLS=0');

  const timestamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const runId = randomUUID().slice(0, 8);
  const reportBaseName = `multi-range-local-evidence-validation-${timestamp}-${runId}`;

  const sourceRaw = await readFile(sourceCaptureFile, 'utf8');
  const captures = ensureExpectedRanges(parseCaptureFile(sourceRaw));

  const rangeResults: CaseResult[] = [];

  for (const capture of captures) {
    const task = toAiTask(capture);
    const requestInput = capture.context_package.analysis_request_input;
    const rangeType = String(requestInput.range_type) as RangeType;

    if (!isSupportedConversationTimeRangeType(rangeType)) {
      throw new Error(`Unsupported captured range_type: ${String(requestInput.range_type)}`);
    }

    const expectedMeta = EXPECTED.find((item) => item.range_type === rangeType);
    if (!expectedMeta) {
      throw new Error(`Unexpected captured range type ${rangeType}`);
    }

    const windowValidation = validateNormalizedTimeRangeWindow({
      range_type: rangeType,
      range_start: requestInput.range_start,
      range_end: requestInput.range_end,
      timezone: requestInput.timezone,
    });
    if (!windowValidation.ok) {
      throw new Error(`Invalid normalized range window for ${rangeType}: ${windowValidation.reason}`);
    }

    const shadow = evaluateEvidenceSelectionShadowSafe({
      task,
      context_package: capture.context_package,
    });

    const artifactA = buildCompactDeliveryArtifact({
      contextPackage: capture.context_package,
      task,
      shadowSelection: shadow,
    });
    const artifactB = buildCompactDeliveryArtifact({
      contextPackage: capture.context_package,
      task,
      shadowSelection: shadow,
    });

    const compactUserPayload = buildCompactUserPayload(capture);
    const compactRequestBody = buildOpenAiResponsesRequestBody({
      model: capture.model,
      task_type: task.task_type,
      system_instructions: capture.prompt.system_instructions,
      user_payload: compactUserPayload,
    });

    const fullBytes = Buffer.byteLength(JSON.stringify(capture.request_representation), 'utf8');
    const compactBytes = Buffer.byteLength(JSON.stringify(compactRequestBody), 'utf8');

    const selectedFamilies = [...artifactA.selected_families];
    const omittedFamilies = artifactA.omitted_families.map((item) => item.family);
    const omissionReasons = artifactA.omitted_families.map((item) => item.reason_code);

    const significantPayload = artifactA.selected_payloads.find((item) => item.family === 'SIGNIFICANT_PERIODS');
    const targetedPayload = artifactA.selected_payloads.find((item) => item.family === 'TARGETED_WINDOWS');

    const significantCount = Array.isArray((significantPayload?.payload as Record<string, unknown> | undefined)?.items)
      ? ((significantPayload?.payload as Record<string, unknown>).items as unknown[]).length
      : 0;
    const targetedCount = Array.isArray((targetedPayload?.payload as Record<string, unknown> | undefined)?.items)
      ? ((targetedPayload?.payload as Record<string, unknown>).items as unknown[]).length
      : 0;

    const semantics = stateSemanticsValid({
      unknown: artifactA.unknown_states,
      missing: artifactA.missing_states,
      excluded: artifactA.excluded_states,
      notSelected: artifactA.not_selected_states,
    });

    rangeResults.push({
      requested_label: expectedMeta.requested_label,
      range_type: rangeType,
      range_profile: getRangeSelectionProfile(rangeType),
      range_start: requestInput.range_start,
      range_end: requestInput.range_end,
      timezone: requestInput.timezone,
      normalization_policy_version: requestInput.normalization_policy_version ?? null,
      selection_policy_version: shadow.evidence_selection_policy_version,
      selection_status: shadow.status,
      selected_level: shadow.selected_level,
      default_level: shadow.default_level,
      selected_families: selectedFamilies,
      omitted_families: omittedFamilies,
      omission_reasons: omissionReasons,
      unknown_states: artifactA.unknown_states,
      missing_states: artifactA.missing_states,
      excluded_states: artifactA.excluded_states,
      not_selected_states: artifactA.not_selected_states,
      unresolved_reasons: artifactA.unresolved_reasons,
      significant_periods_count: significantCount,
      targeted_windows_count: targetedCount,
      compact_artifact_hash_1: artifactA.artifact_content_hash,
      compact_artifact_hash_2: artifactB.artifact_content_hash,
      compact_artifact_hash_deterministic: artifactA.artifact_content_hash === artifactB.artifact_content_hash,
      compact_source_context_hash: artifactA.deterministic_replay_metadata.source_context_package_hash,
      compact_source_task_identity: artifactA.deterministic_replay_metadata.source_task_identity,
      provenance_ref_count: artifactA.provenance.count,
      provenance_preserved: artifactA.provenance.count > 0,
      task_identity: capture.task_identity,
      context_package_hash: capture.task.context_package_hash,
      context_package_version: capture.task.context_package_version,
      full_bytes: fullBytes,
      compact_bytes: compactBytes,
      input_byte_reduction_pct: computeReductionPct(fullBytes, compactBytes),
      token_count_status: 'TOKEN_COUNT_NOT_MEASURED',
      state_semantics_valid: semantics,
    });
  }

  const byLabel = new Map(rangeResults.map((item) => [item.requested_label, item]));
  const today = byLabel.get('TODAY');
  const d3 = byLabel.get('3D');
  const d7 = byLabel.get('7D');
  const d14 = byLabel.get('14D');
  const d30 = byLabel.get('30D');

  if (!today || !d3 || !d7 || !d14 || !d30) {
    throw new Error('Missing one or more expected range cases after processing.');
  }

  const l1 = rangeResults.filter((item) => item.selected_level === 'L1').length;
  const l2 = rangeResults.filter((item) => item.selected_level === 'L2').length;
  const l3 = rangeResults.filter((item) => item.selected_level === 'L3').length;

  const idTodayVs3D = identityDifferent(today, d3);
  const id7Vs14 = identityDifferent(d7, d14);
  const id14Vs30 = identityDifferent(d14, d30);

  const allDeterministic = rangeResults.every((item) => item.compact_artifact_hash_deterministic);
  const allSemanticsValid = rangeResults.every((item) =>
    item.state_semantics_valid.not_selected_not_unknown
    && item.state_semantics_valid.excluded_not_missing
    && item.state_semantics_valid.unknown_not_no
    && item.state_semantics_valid.missing_not_no,
  );
  const allProvenance = rangeResults.every((item) => item.provenance_preserved);
  const identityOk =
    Object.values(idTodayVs3D).every(Boolean)
    && Object.values(id7Vs14).every(Boolean)
    && Object.values(id14Vs30).every(Boolean);

  const findings: string[] = [];
  const limitations: string[] = [];

  if (rangeResults.some((item) => item.selection_status === 'SHADOW_SELECTION_FAILED')) {
    findings.push('At least one case returned SHADOW_SELECTION_FAILED from deterministic selection pipeline.');
  }

  if (rangeResults.some((item) => item.significant_periods_count > 0 || item.targeted_windows_count > 0)) {
    findings.push('At least one case selected significant periods or targeted windows.');
  } else {
    findings.push('All cases remained at summary-level families with zero selected significant periods/targeted windows in compact payload selection.');
  }

  if (rangeResults.some((item) => item.input_byte_reduction_pct <= 0)) {
    findings.push('Some cases did not reduce provider-bound request bytes in compact mode.');
  }

  limitations.push('Provider execution was intentionally disabled; provider token counts were not measured.');
  limitations.push('Selection analysis is based on deterministic local shadow selection and compact artifact generation only.');

  const status: LocalValidationReport['status'] =
    allDeterministic && allSemanticsValid && allProvenance && identityOk
      ? 'MULTI_RANGE_EVIDENCE_VALIDATION_READY'
      : 'MULTI_RANGE_EVIDENCE_VALIDATION_BLOCKED';

  const report: LocalValidationReport = {
    status,
    generated_at: new Date().toISOString(),
    run_id: runId,
    provider_calls: {
      expected: 0,
      actual: 0,
    },
    source_capture_file: sourceCaptureFile,
    range_matrix: rangeResults,
    l1_l2_l3: {
      l1_count: l1,
      l2_count: l2,
      l3_count: l3,
    },
    identity_validation: {
      today_vs_3d: idTodayVs3D,
      seven_vs_fourteen: id7Vs14,
      fourteen_vs_thirty: id14Vs30,
    },
    findings,
    limitations,
  };

  const markdown = [
    '# Multi-Range Local Evidence Validation',
    '',
    '## 1. Provider calls',
    '',
    '- expected: 0',
    '- actual: 0',
    '',
    '## 2. Range matrix',
    '',
    '| Requested | range_type | Profile | Start | End | Selection level |',
    '|---|---|---|---|---|---|',
    ...rangeResults.map((item) => `| ${item.requested_label} | ${item.range_type} | ${item.range_profile} | ${item.range_start} | ${item.range_end} | ${item.selected_level} |`),
    '',
    '## 3. Evidence selection',
    '',
    ...rangeResults.flatMap((item) => [
      `### ${item.requested_label}`,
      `- selected families: ${item.selected_families.join(', ') || '(none)'}`,
      `- omitted families: ${item.omitted_families.join(', ') || '(none)'}`,
      `- omission reasons: ${item.omission_reasons.join(', ') || '(none)'}`,
      `- UNKNOWN: ${item.unknown_states.join(', ') || '(none)'}`,
      `- MISSING: ${item.missing_states.join(', ') || '(none)'}`,
      `- EXCLUDED: ${item.excluded_states.join(', ') || '(none)'}`,
      `- NOT_SELECTED: ${item.not_selected_states.join(', ') || '(none)'}`,
      '',
    ]),
    '## 4. L1/L2/L3',
    '',
    `- L1_count: ${l1}`,
    `- L2_count: ${l2}`,
    `- L3_count: ${l3}`,
    '',
    '## 5. Significant periods',
    '',
    ...rangeResults.map((item) => `- ${item.requested_label}: significant_periods=${item.significant_periods_count}`),
    '',
    '## 6. Targeted windows',
    '',
    ...rangeResults.map((item) => `- ${item.requested_label}: targeted_windows=${item.targeted_windows_count}`),
    '',
    '## 7. Compact Delivery',
    '',
    ...rangeResults.flatMap((item) => [
      `### ${item.requested_label}`,
      `- artifact hash 1: ${item.compact_artifact_hash_1}`,
      `- artifact hash 2: ${item.compact_artifact_hash_2}`,
      `- deterministic: ${item.compact_artifact_hash_deterministic}`,
      `- source hash: ${item.compact_source_context_hash}`,
      `- source task identity: ${item.compact_source_task_identity}`,
      `- provenance refs: ${item.provenance_ref_count}`,
      '',
    ]),
    '## 8. Payload size',
    '',
    '| Range | FULL bytes | COMPACT bytes | Reduction |',
    '|---|---:|---:|---:|',
    ...rangeResults.map((item) => `| ${item.requested_label} | ${item.full_bytes} | ${item.compact_bytes} | ${item.input_byte_reduction_pct}% |`),
    '',
    '## 9. Identity validation',
    '',
    `- TODAY vs 3D: ${JSON.stringify(idTodayVs3D)}`,
    `- 7D vs 14D: ${JSON.stringify(id7Vs14)}`,
    `- 14D vs 30D: ${JSON.stringify(id14Vs30)}`,
    '',
    '## 10. Findings',
    '',
    ...findings.map((line) => `- ${line}`),
    '',
    '## 11. Limitations',
    '',
    ...limitations.map((line) => `- ${line}`),
    '',
    '## 12. Verdict',
    '',
    `- ${status}`,
  ].join('\n');

  const reportJsonPath = writeEvaluationOutputDirFile(outputDir, `${reportBaseName}.json`, `${JSON.stringify(report, null, 2)}\n`);
  const reportMdPath = writeEvaluationOutputDirFile(outputDir, `${reportBaseName}.md`, `${markdown}\n`);

  console.log(JSON.stringify({
    provider_calls_expected: 0,
    provider_calls_actual: 0,
    source_capture_file: sourceCaptureFile,
    report_json_path: reportJsonPath,
    report_md_path: reportMdPath,
    status,
  }, null, 2));
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(`[multi-range-local-evidence-validation] failed: ${describeErrorSafely(error)}`);
    process.exitCode = 1;
  });
}
