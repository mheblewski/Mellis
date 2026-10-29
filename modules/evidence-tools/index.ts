import { createHash } from 'node:crypto';
import { canonicalJson } from '@shared/utils/canonical-json';
import { buildGlucoseSemanticSummaryV1 } from '@modules/context/application/evidence-summary-design-contract';
import { computeGlucoseTimeInRange } from '@modules/context/application/glucose-time-in-range';
import { makeLocalMinuteOfDay } from './daily-insulin-totals';

export type EvidenceToolStatus =
  | 'KNOWN'
  | 'UNKNOWN'
  | 'MISSING'
  | 'EXCLUDED'
  | 'NOT_SELECTED'
  | 'INSUFFICIENT_DATA'
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'OUT_OF_RANGE'
  | 'BUDGET_EXCEEDED'
  | 'PARTIAL_DATA'
  | 'FAILED';

export type EvidenceDetailLevel = 'SUMMARY' | 'SIGNIFICANT_EVENTS' | 'DETAIL' | 'TRAJECTORY';

export type EvidenceToolName =
  | 'get_glucose_evidence'
  | 'get_insulin_evidence'
  | 'get_basal_evidence'
  | 'get_meal_evidence'
  | 'get_activity_evidence'
  | 'get_loop_evidence'
  | 'get_therapy_profile';

export interface EvidenceTimeRange {
  from: string;
  to: string;
}

export interface EvidenceToolRequest {
  tool: EvidenceToolName;
  patient_id: string;
  time_range?: EvidenceTimeRange | null;
  detail_level?: EvidenceDetailLevel;
  task_context?: Record<string, unknown>;
  constraints?: {
    max_range_ms?: number;
    max_result_tokens?: number;
    [key: string]: unknown;
  };
}

export interface EvidenceCoverage {
  status: 'KNOWN' | 'PARTIAL' | 'MISSING' | 'UNKNOWN';
  range: EvidenceTimeRange | null;
  covered_range: EvidenceTimeRange | null;
  gaps: Array<EvidenceTimeRange>;
}

export interface EvidenceProvenance {
  patient_id: string;
  request_hash: string;
  compiler_version: string;
  evidence_version: string;
  source_refs: string[];
  request: EvidenceToolRequest;
}

export type ProcessingStepType =
  | 'ANALYZING_REQUEST'
  | 'REQUESTING_EVIDENCE'
  | 'ANALYZING_EVIDENCE'
  | 'GENERATING_RESPONSE'
  | 'COMPLETED'
  | 'FAILED';

export type ProcessingStepStatus = 'STARTED' | 'SUCCEEDED' | 'FAILED';

export interface EvidenceProcessingStep {
  executionId: string;
  sequence: number;
  type: ProcessingStepType;
  status: ProcessingStepStatus;
  label: string;
  tool?: EvidenceToolName;
  timeRange?: EvidenceTimeRange | null;
  detail?: string | null;
  startedAt: string;
  completedAt?: string | null;
}

export interface EvidenceToolProcessingObserver {
  onStep: (step: EvidenceProcessingStep) => void | Promise<void>;
}

export interface EvidenceToolResponse {
  tool: EvidenceToolName;
  status: EvidenceToolStatus;
  evidence: Record<string, unknown>;
  coverage: EvidenceCoverage;
  limitations: string[];
  provenance: EvidenceProvenance;
  compiler_version: string;
  content_hash: string;
}

export interface EvidenceToolValidationError {
  status: EvidenceToolStatus;
  reason: string;
}

export type EvidenceToolValidationResult =
  | {
      ok: true;
      request: EvidenceToolRequest;
    }
  | {
      ok: false;
      error: EvidenceToolValidationError;
    };

export interface EvidenceToolDefinition {
  name: EvidenceToolName;
  description: string;
  detail_levels: readonly EvidenceDetailLevel[];
  max_range_ms: number;
  default_detail_level: EvidenceDetailLevel;
}

export interface InitialEvidenceViewInput {
  task_type: string;
  patient_id: string;
  range?: EvidenceTimeRange | null;
  current_state?: {
    as_of?: string;
    current_glucose?: number | null;
    trend?: string | null;
  } | null;
  significant_glucose_events?: Array<{
    label?: string;
    start?: string;
    end?: string;
    minimum?: number | null;
    maximum?: number | null;
  }>;
  known_treatment_events?: Array<{
    kind?: string;
    occurred_at?: string;
    amount?: number | null;
    unit?: string | null;
  }>;
  evidence_capability_summary?: string[];
  provenance?: Record<string, unknown>;
}

export interface InitialEvidenceView {
  evidence_view_version: 'initial-evidence-view.v1';
  initial_context_summary: {
    task_type: string;
    patient_id: string;
    range: EvidenceTimeRange | null;
    current_glucose: number | null;
    trend: string | null;
    as_of: string | null;
  };
  significant_glucose_events: Array<Record<string, unknown>>;
  known_treatment_events: Array<Record<string, unknown>>;
  tools_available: EvidenceToolDefinition[];
  evidence_capability_summary: string[];
  instruction: string;
  provenance: Record<string, unknown>;
}

export interface EvidenceSession {
  session_version: 'evidence-session.v1';
  task: string;
  patient_id: string;
  initial_evidence_identity: string;
  available_tools: EvidenceToolName[];
  tool_call_order: EvidenceToolName[];
  tool_calls: Array<{
    tool: EvidenceToolName;
    request_hash: string;
    result_status: EvidenceToolStatus;
    result_hash: string;
    compiler_version: string;
    result_size_tokens: number | null;
  }>;
  budget: {
    max_calls: number;
    total_budget_tokens: number;
    remaining_budget_tokens: number;
  };
}

export const EVIDENCE_TOOL_COMPILER_VERSION = 'evidence-tools.v1';
export const EVIDENCE_TOOL_RESPONSE_VERSION = 'evidence-tool-response.v1';
export const EVIDENCE_TOOL_DEFAULT_MAX_RANGE_MS = 24 * 60 * 60 * 1000;

const EVIDENCE_TOOL_NAMES: ReadonlyArray<EvidenceToolName> = [
  'get_glucose_evidence',
  'get_insulin_evidence',
  'get_basal_evidence',
  'get_meal_evidence',
  'get_activity_evidence',
  'get_loop_evidence',
  'get_therapy_profile',
];

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function buildEvidenceProcessingStep(args: {
  executionId: string;
  sequence: number;
  type: ProcessingStepType;
  status: ProcessingStepStatus;
  label: string;
  tool?: EvidenceToolName;
  timeRange?: EvidenceTimeRange | null;
  detail?: string | null;
  startedAt: string;
  completedAt?: string | null;
}): EvidenceProcessingStep {
  return {
    executionId: args.executionId,
    sequence: args.sequence,
    type: args.type,
    status: args.status,
    label: args.label,
    tool: args.tool,
    timeRange: args.timeRange ?? null,
    detail: args.detail ?? null,
    startedAt: args.startedAt,
    completedAt: args.completedAt ?? null,
  };
}

function describeEvidenceToolLabel(tool: EvidenceToolName): string {
  switch (tool) {
    case 'get_glucose_evidence':
      return 'Sprawdzam glikemię';
    case 'get_insulin_evidence':
      return 'Sprawdzam insulinę';
    case 'get_basal_evidence':
      return 'Sprawdzam bazal';
    case 'get_meal_evidence':
      return 'Sprawdzam posiłki';
    case 'get_activity_evidence':
      return 'Sprawdzam aktywność';
    case 'get_loop_evidence':
      return 'Sprawdzam działanie algorytmu';
    case 'get_therapy_profile':
      return 'Sprawdzam ustawienia terapii';
    default:
      return 'Sprawdzam dane';
  }
}

function formatTimeRangeLabel(range: EvidenceTimeRange | null): string {
  if (!range) {
    return '';
  }
  const start = new Date(range.from);
  const end = new Date(range.to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return '';
  }
  return `${start.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })} ${start.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', hour12: false })}-${end.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

function parseIso(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function getTimeValue(value: Record<string, unknown>): string | null {
  for (const key of ['observed_at', 'occurred_at', 'started_at', 'recorded_at', 'as_of']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

export function evaluateEvidenceToolRequest(
  request: EvidenceToolRequest,
  context: { patient_ref?: { patient_id?: string } | null } | null | undefined,
): EvidenceToolValidationResult {
  if (!EVIDENCE_TOOL_NAMES.includes(request.tool)) {
    return {
      ok: false,
      error: {
        status: 'INVALID_REQUEST',
        reason: `Unsupported tool: ${String(request.tool)}`,
      },
    };
  }

  const patientId = context?.patient_ref?.patient_id ?? null;
  if (patientId && request.patient_id !== patientId) {
    return {
      ok: false,
      error: {
        status: 'UNAUTHORIZED',
        reason: `Patient mismatch: request=${request.patient_id} context=${patientId}`,
      },
    };
  }

  if (request.time_range) {
    const fromMs = parseIso(request.time_range.from);
    const toMs = parseIso(request.time_range.to);
    if (fromMs === null || toMs === null) {
      return {
        ok: false,
        error: {
          status: 'INVALID_REQUEST',
          reason: 'time_range must include valid ISO timestamps',
        },
      };
    }
    if (toMs < fromMs) {
      return {
        ok: false,
        error: {
          status: 'INVALID_REQUEST',
          reason: 'time_range.to must be greater than or equal to time_range.from',
        },
      };
    }

    const maxRangeMs = request.constraints?.max_range_ms ?? EVIDENCE_TOOL_DEFAULT_MAX_RANGE_MS;
    if (toMs - fromMs > maxRangeMs) {
      return {
        ok: false,
        error: {
          status: 'OUT_OF_RANGE',
          reason: `Requested range exceeds max_range_ms=${maxRangeMs}`,
        },
      };
    }
  }

  return { ok: true, request };
}

/**
 * What a tool says for time it was not given records for. The context holds only the selected window (`loaded_range`:
 * the analysed range, from its first selected record when the selection was cut by its row limit); outside it nothing
 * is known, which is neither a sensor gap nor "no insulin / no meal".
 */
export const NOT_SELECTED_LIMITATION = 'NOT_SELECTED: the records of this time were not loaded for this answer (outside the analysed range or cut by its size limit). Their absence here is not a sensor gap and not an absence of insulin, meals or activity: say it was not checked.';

type LoadedRangeScope =
  | { kind: 'IN_RANGE' }
  | { kind: 'OUTSIDE'; loaded: EvidenceTimeRange }
  | { kind: 'CLIPPED'; loaded: EvidenceTimeRange; request: EvidenceToolRequest; notSelected: EvidenceTimeRange[] };

function loadedRangeOf(context: Record<string, unknown> | null | undefined): { from: number; to: number; range: EvidenceTimeRange } | null {
  const loaded = asRecord(context?.loaded_range);
  const from = parseIso(typeof loaded?.from === 'string' ? loaded.from : undefined);
  const to = parseIso(typeof loaded?.to === 'string' ? loaded.to : undefined);
  if (from === null || to === null || to < from) return null;
  return { from, to, range: { from: String(loaded!.from), to: String(loaded!.to) } };
}

/** Where the requested window lies against the loaded window of the context (none set: the context holds it all). */
function scopeToLoadedRange(request: EvidenceToolRequest, context: Record<string, unknown> | null | undefined): LoadedRangeScope {
  const loaded = loadedRangeOf(context);
  const fromMs = parseIso(request.time_range?.from);
  const toMs = parseIso(request.time_range?.to);
  if (!loaded || fromMs === null || toMs === null) return { kind: 'IN_RANGE' };
  if (fromMs >= loaded.from && toMs <= loaded.to) return { kind: 'IN_RANGE' };
  const clippedFrom = Math.max(fromMs, loaded.from);
  const clippedTo = Math.min(toMs, loaded.to);
  if (clippedTo <= clippedFrom) return { kind: 'OUTSIDE', loaded: loaded.range };
  const iso = (ms: number) => new Date(ms).toISOString();
  const notSelected: EvidenceTimeRange[] = [];
  if (fromMs < loaded.from) notSelected.push({ from: request.time_range!.from, to: loaded.range.from });
  if (toMs > loaded.to) notSelected.push({ from: loaded.range.to, to: request.time_range!.to });
  return {
    kind: 'CLIPPED',
    loaded: loaded.range,
    request: { ...request, time_range: { from: iso(clippedFrom), to: iso(clippedTo) } },
    notSelected,
  };
}

/**
 * Runs a tool on the part of the request inside the loaded window. Wholly outside it: NOT_SELECTED. Partly outside: the
 * result of the loaded part (KNOWN becomes PARTIAL_DATA) with the not selected parts listed, never MISSING or zero
 * events for them.
 */
function executeWithinLoadedRange(
  request: EvidenceToolRequest,
  context: Record<string, unknown>,
  run: (scoped: EvidenceToolRequest) => EvidenceToolResponse,
): EvidenceToolResponse {
  const scope = scopeToLoadedRange(request, context);
  if (scope.kind === 'IN_RANGE') return run(request);
  if (scope.kind === 'OUTSIDE') {
    return buildSemanticResponse(
      request,
      'NOT_SELECTED',
      { status: 'NOT_SELECTED', loaded_range: scope.loaded },
      { status: 'UNKNOWN', range: request.time_range ?? null, covered_range: null, gaps: [] },
      [NOT_SELECTED_LIMITATION],
      [],
    );
  }
  const inner = run(scope.request);
  if (['INVALID_REQUEST', 'UNAUTHORIZED', 'OUT_OF_RANGE', 'BUDGET_EXCEEDED', 'FAILED'].includes(inner.status)) return inner;
  return buildSemanticResponse(
    request,
    inner.status === 'KNOWN' ? 'PARTIAL_DATA' : inner.status,
    { ...inner.evidence, loaded_range: scope.loaded, not_selected_ranges: scope.notSelected },
    inner.coverage,
    [...inner.limitations, `Only part of the requested window was loaded (loaded_range); not_selected_ranges: ${NOT_SELECTED_LIMITATION}`],
    inner.provenance.source_refs,
  );
}

function buildSemanticResponse(
  request: EvidenceToolRequest,
  status: EvidenceToolStatus,
  evidence: Record<string, unknown>,
  coverage: EvidenceCoverage,
  limitations: string[] = [],
  sourceRefs: string[] = [],
): EvidenceToolResponse {
  const payload = {
    tool: request.tool,
    status,
    evidence,
    coverage,
    limitations,
    provenance: {
      patient_id: request.patient_id,
      request_hash: canonicalHash(request),
      compiler_version: EVIDENCE_TOOL_COMPILER_VERSION,
      evidence_version: EVIDENCE_TOOL_RESPONSE_VERSION,
      source_refs: sourceRefs,
      request,
    },
  };

  return {
    tool: request.tool,
    status,
    evidence,
    coverage,
    limitations,
    provenance: payload.provenance,
    compiler_version: EVIDENCE_TOOL_COMPILER_VERSION,
    content_hash: canonicalHash(payload),
  };
}

function buildCoverage(
  range: EvidenceTimeRange | null,
  records: Array<Record<string, unknown>>,
): EvidenceCoverage {
  if (!range || records.length === 0) {
    return {
      status: records.length === 0 ? 'MISSING' : 'PARTIAL',
      range,
      covered_range: null,
      gaps: [],
    };
  }

  const coveragePoints = records
    .map((record) => {
      const timeValue = getTimeValue(record);
      return timeValue ? parseIso(timeValue) : null;
    })
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);

  if (coveragePoints.length === 0) {
    return {
      status: 'MISSING',
      range,
      covered_range: null,
      gaps: [{ from: range.from, to: range.to }],
    };
  }

  const coveredStart = coveragePoints[0];
  const coveredEnd = coveragePoints[coveragePoints.length - 1];
  const gaps: Array<EvidenceTimeRange> = [];
  const fromMs = parseIso(range.from) ?? coveredStart;
  const toMs = parseIso(range.to) ?? coveredEnd;

  if (coveredStart > fromMs) {
    gaps.push({ from: range.from, to: new Date(coveredStart).toISOString() });
  }
  if (coveredEnd < toMs) {
    gaps.push({ from: new Date(coveredEnd).toISOString(), to: range.to });
  }

  return {
    status: coveragePoints.length < 2 ? 'PARTIAL' : 'KNOWN',
    range,
    covered_range: {
      from: new Date(coveredStart).toISOString(),
      to: new Date(coveredEnd).toISOString(),
    },
    gaps,
  };
}

/**
 * Largest spacing between CGM observations still treated as continuous coverage. The repository defines no CGM gap
 * policy (the removed evidence-reduction-contract left large gaps OPEN), so this is an explicit choice: common sensors report
 * every 1-5 minutes, and 15 minutes tolerates up to two missed 5-minute readings. A spacing of exactly 15 minutes
 * is continuous; anything longer is a gap. Consequence: outages of 15 minutes or less are not reported.
 */
export const CGM_COVERAGE_GAP_THRESHOLD_MINUTES = 15;

/**
 * Coverage of CGM observations inside the window. Unlike buildCoverage (used for sparse events, where time between
 * two boluses is not missing data), it also reports gaps between consecutive readings. Gap bounds are the observed
 * readings (or the window edge); nothing is interpolated.
 */
export function buildGlucoseCoverage(range: EvidenceTimeRange | null, records: Array<Record<string, unknown>>): EvidenceCoverage {
  const points = records
    .map((record) => {
      const timeValue = getTimeValue(record);
      return timeValue ? parseIso(timeValue) : null;
    })
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);

  if (points.length === 0) {
    return {
      status: 'MISSING',
      range,
      covered_range: null,
      gaps: range ? [{ from: range.from, to: range.to }] : [],
    };
  }

  const thresholdMs = CGM_COVERAGE_GAP_THRESHOLD_MINUTES * 60 * 1000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const gaps: Array<EvidenceTimeRange> = [];
  const fromMs = range ? parseIso(range.from) : null;
  const toMs = range ? parseIso(range.to) : null;

  if (range && fromMs !== null && points[0] - fromMs > thresholdMs) {
    gaps.push({ from: range.from, to: iso(points[0]) });
  }
  for (let index = 1; index < points.length; index += 1) {
    if (points[index] - points[index - 1] > thresholdMs) {
      gaps.push({ from: iso(points[index - 1]), to: iso(points[index]) });
    }
  }
  if (range && toMs !== null && toMs - points[points.length - 1] > thresholdMs) {
    gaps.push({ from: iso(points[points.length - 1]), to: range.to });
  }

  return {
    status: points.length < 2 || gaps.length > 0 ? 'PARTIAL' : 'KNOWN',
    range,
    covered_range: { from: iso(points[0]), to: iso(points[points.length - 1]) },
    gaps,
  };
}

function buildSafeGlucoseL2Anchors(
  records: Array<Record<string, unknown>>,
): Array<{ type: string; observed_at: string | null; glucose_value: number | null; provenance_ref: string | null; }> {
  const valid = records
    .map((record) => ({ record, value: normalizeNumeric(record.glucose_value ?? record.value ?? null) }))
    .filter((entry): entry is { record: Record<string, unknown>; value: number } => entry.value !== null);

  if (valid.length === 0) {
    return [];
  }

  const minEntry = valid.reduce((best, current) => (current.value < best.value ? current : best), valid[0]);
  const maxEntry = valid.reduce((best, current) => (current.value > best.value ? current : best), valid[0]);
  const firstEntry = valid[0];
  const lastEntry = valid[valid.length - 1];

  const anchors = [
    {
      type: 'RANGE_BOUNDARY_START',
      observed_at: getTimeValue(firstEntry.record),
      glucose_value: firstEntry.value,
      provenance_ref: String(firstEntry.record.provenance_ref ?? firstEntry.record.reading_id ?? firstEntry.record.source_record_id ?? 'glucose:unknown'),
    },
    {
      type: 'RANGE_BOUNDARY_END',
      observed_at: getTimeValue(lastEntry.record),
      glucose_value: lastEntry.value,
      provenance_ref: String(lastEntry.record.provenance_ref ?? lastEntry.record.reading_id ?? lastEntry.record.source_record_id ?? 'glucose:unknown'),
    },
    {
      type: 'LOCAL_MINIMUM',
      observed_at: getTimeValue(minEntry.record),
      glucose_value: minEntry.value,
      provenance_ref: String(minEntry.record.provenance_ref ?? minEntry.record.reading_id ?? minEntry.record.source_record_id ?? 'glucose:unknown'),
    },
    {
      type: 'LOCAL_MAXIMUM',
      observed_at: getTimeValue(maxEntry.record),
      glucose_value: maxEntry.value,
      provenance_ref: String(maxEntry.record.provenance_ref ?? maxEntry.record.reading_id ?? maxEntry.record.source_record_id ?? 'glucose:unknown'),
    },
  ];

  return anchors.filter((entry) => entry.observed_at !== null);
}

function normalizeGlucoseWindowContext(
  request: EvidenceToolRequest,
  context: Record<string, unknown>,
): { canonicalPackage: Record<string, unknown>; glucoseRows: Array<Record<string, unknown>> } {
  const glucoseRows = toArray<Record<string, unknown>>(
    context.glucose_evidence as Record<string, unknown> | Record<string, unknown>[] | null | undefined,
  ).filter((row) => row && typeof row === 'object');
  const selectedRows = glucoseRows.filter((row) => {
    const range = request.time_range;
    if (!range) {
      return true;
    }
    const observedAt = getTimeValue(row);
    if (!observedAt) {
      return false;
    }
    const observedMs = parseIso(observedAt);
    const fromMs = parseIso(range.from) ?? Number.NEGATIVE_INFINITY;
    const toMs = parseIso(range.to) ?? Number.POSITIVE_INFINITY;
    return observedMs !== null && observedMs >= fromMs && observedMs <= toMs;
  });

  const sortedRows = [...selectedRows].sort((left, right) => {
    const leftMs = parseIso(getTimeValue(left) ?? '') ?? 0;
    const rightMs = parseIso(getTimeValue(right) ?? '') ?? 0;
    return leftMs - rightMs;
  });

  const range = request.time_range ?? {
    from: sortedRows[0] ? String(getTimeValue(sortedRows[0])) : new Date(0).toISOString(),
    to: sortedRows[sortedRows.length - 1] ? String(getTimeValue(sortedRows[sortedRows.length - 1])) : new Date().toISOString(),
  };

  const canonicalPackage = {
    context_package_id: `evidence-tool:${request.tool}:${request.patient_id}`,
    context_package_version: 'context-package.v1',
    content_hash: canonicalHash({ request, glucoseRows: sortedRows }),
    created_at: new Date().toISOString(),
    created_for_job_id: `evidence-tool-job:${request.patient_id}`,
    package_status: 'COMPLETE',
    task: {
      task_type: String((request.task_context?.task_type as string | undefined) ?? 'CONVERSATION_TIME_RANGE_ANALYSIS'),
      prompt_version: 'evidence-tool.v1',
      output_schema_version: 'evidence-tool-output.v1',
    },
    patient_ref: { patient_id: request.patient_id },
    trigger: {
      trigger_id: `trigger:${request.patient_id}`,
      trigger_type: 'HYPO_DETECTED',
      trigger_rule_version: 'evidence-tool.v1',
      created_at: range.from,
      source_event_id: `source:${request.patient_id}`,
    },
    hypo_episode: {
      episode_id: `episode:${request.patient_id}:${range.from}`,
      episode_state: 'OPEN',
      episode_severity: 'L1',
      episode_started_at: range.from,
      episode_ended_at: range.to,
      start_reading_id: sortedRows[0]?.reading_id ?? 'unknown',
      latest_reading_id: sortedRows[sortedRows.length - 1]?.reading_id ?? 'unknown',
    },
    glucose_evidence: sortedRows,
    current_state_snapshot: {
      state_version: 'evidence-tool.v1',
      as_of: range.to,
      current_glucose: sortedRows[sortedRows.length - 1]?.glucose_value ?? null,
      trend: 'UNKNOWN',
      glucose_rate_of_change: 'UNKNOWN',
      iob: 'UNKNOWN',
      recent_insulin: [],
      recent_meal: null,
      recent_activity: null,
      recent_sleep: null,
      recent_illness: null,
      active_therapy_ref: 'evidence-tool',
    },
    active_therapy_snapshot: context.active_therapy_snapshot ?? {
      therapy_id: 'evidence-tool-therapy',
      therapy_version: 'evidence-tool.v1',
      active_profile_id: 'evidence-tool-profile',
      basal_schedule: {},
      icr_schedule: {},
      isf_schedule: {},
      target_schedule: {},
      dia: null,
      automation_mode: 'UNKNOWN',
    },
    conversation_context: { thread_id: 'evidence-tool-thread', thread_state_version: 'evidence-tool.v1', messages: [], awaiting_user_answer: false },
    event_context_facts: [],
    provenance: {
      trigger_id: `trigger:${request.patient_id}`,
      source_event_id: `source:${request.patient_id}`,
      source_record_ids: sortedRows.map((row) => String(row.source_record_id ?? row.provenance_ref ?? row.reading_id ?? 'unknown')),
      current_state_version: 'evidence-tool.v1',
      therapy_version: 'evidence-tool.v1',
      conversation_thread_version: 'evidence-tool.v1',
    },
    source_versions: {
      nightscout_sync_cursor: 'evidence-tool.v1',
      current_state_version: 'evidence-tool.v1',
      therapy_version: 'evidence-tool.v1',
      trigger_rule_version: 'evidence-tool.v1',
      conversation_thread_version: 'evidence-tool.v1',
      package_version: 'context-package.v1',
    },
    selection_policy: {
      task_bounded: true,
      episode_bounded: true,
      thread_bounded: true,
      no_memory: true,
      no_knowledge: true,
      no_full_history: true,
    },
  };

  return { canonicalPackage, glucoseRows: sortedRows };
}

export const getGlucoseEvidenceTool: {
  readonly name: EvidenceToolName;
  description: string;
  detail_levels: readonly EvidenceDetailLevel[];
  max_range_ms: number;
  default_detail_level: EvidenceDetailLevel;
  execute: (request: EvidenceToolRequest, context: Record<string, unknown>) => EvidenceToolResponse;
} = {
  name: 'get_glucose_evidence',
  description: 'Return compact, semantic glucose evidence for the requested range without exposing raw CGM records.',
  detail_levels: ['SUMMARY', 'SIGNIFICANT_EVENTS', 'DETAIL', 'TRAJECTORY'],
  max_range_ms: 24 * 60 * 60 * 1000,
  default_detail_level: 'SUMMARY',
  execute(request, context) {
    const validation = evaluateEvidenceToolRequest(request, context as { patient_ref?: { patient_id?: string } | null });
    if (!validation.ok) {
      return buildSemanticResponse(
        request,
        validation.error.status,
        { error: validation.error.reason },
        { status: 'MISSING', range: request.time_range ?? null, covered_range: null, gaps: [] },
        [validation.error.reason],
        [],
      );
    }

    if (scopeToLoadedRange(request, context).kind !== 'IN_RANGE') {
      return executeWithinLoadedRange(request, context, (scoped) => getGlucoseEvidenceTool.execute(scoped, context));
    }

    const { glucoseRows } = normalizeGlucoseWindowContext(request, context as Record<string, unknown>);
    const inRange = glucoseRows.length > 0 ? glucoseRows : [];
    if (inRange.length === 0) {
      const emptySummary = buildGlucoseSemanticSummaryV1({
        time_range: {
          start_at: request.time_range?.from ?? new Date(0).toISOString(),
          end_at: request.time_range?.to ?? new Date(0).toISOString(),
        },
        glucose_events: [],
        source_refs: [],
        derivation_policy_version: 'glucose-evidence-delivery-spec.v1',
        selection_policy_version: 'evidence-tool-selection.v1',
        evidence_status: {
          glucose_data: 'MISSING',
          known_hypo_episodes: 'NOT_SELECTED',
          excluded_evidence: 'NONE',
        },
      });

      return buildSemanticResponse(
        request,
        'MISSING',
        {
          summary: {
            minimum_glucose: null,
            maximum_glucose: null,
            average_glucose: null,
            time_in_range: null,
            observation_count: 0,
            trajectory_points: 0,
            coverage_status: emptySummary.glucose_summary.coverage_status,
            unknown_count: 0,
            missing_count: 0,
            semantic_anchors: emptySummary.semantic_anchors,
            evidence_status: emptySummary.evidence_status,
            provenance: emptySummary.provenance,
          },
          significant_periods: [],
          coverage: { status: 'MISSING', range: request.time_range ?? null, covered_range: null, gaps: request.time_range ? [{ from: request.time_range.from, to: request.time_range.to }] : [] },
        },
        { status: 'MISSING', range: request.time_range ?? null, covered_range: null, gaps: request.time_range ? [{ from: request.time_range.from, to: request.time_range.to }] : [] },
        ['No glucose evidence matched the requested range.'],
        [],
      );
    }

    const safeAnchors = buildSafeGlucoseL2Anchors(inRange);
    const semanticSummary = buildGlucoseSemanticSummaryV1({
      time_range: {
        start_at: request.time_range?.from ?? inRange[0] ? String(getTimeValue(inRange[0]) ?? new Date(0).toISOString()) : new Date(0).toISOString(),
        end_at: request.time_range?.to ?? inRange[inRange.length - 1] ? String(getTimeValue(inRange[inRange.length - 1]) ?? new Date().toISOString()) : new Date().toISOString(),
      },
      glucose_events: inRange.map((point) => ({
        event_id: String(point.reading_id ?? point.source_record_id ?? point.event_id ?? point.provenance_ref ?? 'glucose:unknown'),
        source_record_id: String(point.source_record_id ?? point.provenance_ref ?? point.reading_id ?? 'glucose:unknown'),
        validity: String(point.validity ?? 'UNKNOWN'),
        glucose_value: normalizeNumeric(point.glucose_value),
      })),
      hypo_episode_refs: [],
      source_boundary_refs: safeAnchors.map((entry) => entry.provenance_ref ?? '').filter(Boolean),
      protected_event_refs: safeAnchors.map((entry) => String(entry.provenance_ref ?? entry.type)).filter(Boolean),
      source_refs: inRange.map((record) => String(record.provenance_ref ?? record.reading_id ?? record.source_record_id ?? 'glucose:unknown')),
      derivation_policy_version: 'glucose-evidence-delivery-spec.v1',
      selection_policy_version: 'evidence-tool-selection.v1',
      evidence_status: {
        glucose_data: 'KNOWN',
        known_hypo_episodes: 'NOT_SELECTED',
        excluded_evidence: 'NONE',
      },
    });

    const values = inRange.map((point) => Number(point.glucose_value ?? NaN)).filter((value) => Number.isFinite(value));
    const summary = {
      minimum_glucose: semanticSummary.glucose_summary.glucose_min,
      maximum_glucose: semanticSummary.glucose_summary.glucose_max,
      average_glucose: semanticSummary.glucose_summary.glucose_avg,
      time_in_range: computeGlucoseTimeInRange(values, request.time_range ?? null),
      observation_count: semanticSummary.glucose_summary.glucose_count,
      trajectory_points: semanticSummary.glucose_summary.usable_glucose_count,
      coverage_status: semanticSummary.glucose_summary.coverage_status,
      unknown_count: semanticSummary.glucose_summary.unknown_count,
      missing_count: semanticSummary.glucose_summary.missing_count,
      semantic_anchors: semanticSummary.semantic_anchors,
      evidence_status: semanticSummary.evidence_status,
      provenance: semanticSummary.provenance,
    };

    const significantPeriods = safeAnchors.length > 0
      ? safeAnchors.map((anchor) => ({ ...anchor }))
      : [];

    const coverage = buildGlucoseCoverage(request.time_range ?? null, inRange);
    const detailWindow = request.detail_level === 'DETAIL' || request.detail_level === 'TRAJECTORY'
      ? {
          requested_range: request.time_range ?? null,
          observed_range: {
            from: getTimeValue(inRange[0]) ?? request.time_range?.from ?? null,
            to: getTimeValue(inRange[inRange.length - 1]) ?? request.time_range?.to ?? null,
          },
          observations: inRange.map((point) => ({
            observed_at: getTimeValue(point),
            glucose_value: normalizeNumeric(point.glucose_value ?? point.value ?? null),
            unit: 'mg/dL',
            validity: String(point.validity ?? 'UNKNOWN'),
            source_record_id: String(point.source_record_id ?? point.reading_id ?? point.event_id ?? point.provenance_ref ?? 'glucose:unknown'),
            provenance_ref: String(point.provenance_ref ?? point.reading_id ?? point.source_record_id ?? 'glucose:unknown'),
          })),
          coverage,
          gap_count: coverage.gaps.length,
          ordering: 'observed_at ascending, then source_record_id, then provenance_ref',
          notes: ['Exact authoritative observations only. No interpolation, gap bridging, or trend heuristics were applied.'],
        }
      : undefined;

    const evidence = {
      summary,
      significant_periods: significantPeriods,
      coverage,
      trajectory: request.detail_level === 'TRAJECTORY' || request.detail_level === 'DETAIL'
        ? {
            ordered_points: inRange.map((point) => ({
              observed_at: getTimeValue(point),
              glucose_value: Number(point.glucose_value ?? NaN),
              provenance_ref: String(point.provenance_ref ?? point.reading_id ?? point.source_record_id ?? 'glucose:unknown'),
              validity: String(point.validity ?? 'UNKNOWN'),
            })),
            first_glucose_value: values.length > 0 ? values[0] : null,
            minimum_point: values.length > 0 ? {
              observed_at: getTimeValue(inRange.find((point) => Number(point.glucose_value ?? NaN) === Math.min(...values)) ?? inRange[0] ?? {}),
              glucose_value: Math.min(...values),
              provenance_ref: String((inRange.find((point) => Number(point.glucose_value ?? NaN) === Math.min(...values)) ?? inRange[0])?.provenance_ref ?? 'glucose:unknown'),
            } : null,
            last_glucose_value: values.length > 0 ? values[values.length - 1] : null,
            recovery_state: 'UNKNOWN',
            data_quality_boundaries: [],
          }
        : undefined,
      detail_window: detailWindow,
      status: 'KNOWN',
      model: 'glucose-semantic-summary.v1',
    };

    return buildSemanticResponse(
      request,
      'KNOWN',
      evidence,
      coverage,
      [],
      inRange.map((record) => String(record.provenance_ref ?? record.reading_id ?? 'glucose:unknown')),
    );
  },
};

function normalizeNumeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeInsulinEventKind(record: Record<string, unknown>): 'BOLUS' | 'SMB' | 'TEMP_BASAL' | 'UNKNOWN' {
  const payload = asRecord(record.payload);
  const raw = [(record.event_type ?? record.eventType ?? record.type ?? record.kind ?? record.event_kind ?? record.kind ?? record.source_event_type), (record.value_type ?? payload?.type ?? payload?.event_type)]
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .map((item) => item.trim().toUpperCase())
    .find(Boolean);

  if (!raw) {
    return 'UNKNOWN';
  }

  if (raw.includes('SMB')) {
    return 'SMB';
  }
  if (raw.includes('BOLUS')) {
    return 'BOLUS';
  }
  if (raw.includes('TEMP_BASAL') || raw.includes('TEMP')) {
    return 'TEMP_BASAL';
  }
  return 'UNKNOWN';
}

/**
 * Planned basal of the profile over the window: one interval per schedule entry in force, at the profile's local
 * times ("HH:MM" keys in `timezone`, UTC when unknown), across midnights, clipped to the window.
 */
function normalizeBasalScheduleEntries(schedule: unknown, range: EvidenceTimeRange | null, timezone = 'UTC'): Array<{ start: string; end: string; rate: number; unit: string; source: string; profile_id: string | null }> {
  if (!schedule || typeof schedule !== 'object') {
    return [];
  }

  const entries = Object.entries(schedule as Record<string, unknown>)
    .map(([key, value]) => {
      const rate = normalizeNumeric((value as Record<string, unknown>)?.rate ?? value ?? null);
      const match = /^(\d{1,2}):(\d{2})$/.exec(String(key).trim());
      return rate === null || !match ? null : { minute: Number(match[1]) * 60 + Number(match[2]), rate };
    })
    .filter((entry): entry is { minute: number; rate: number } => entry !== null)
    .sort((left, right) => left.minute - right.minute);
  if (entries.length === 0) {
    return [];
  }

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const fromMs = parseIso(range?.from) ?? dayStart.getTime();
  const toMs = parseIso(range?.to) ?? fromMs + 24 * 60 * 60 * 1000;
  const localMinute = makeLocalMinuteOfDay(timezone);
  const entryAt = (ms: number) => {
    const minute = localMinute(ms);
    if (minute === null) return entries.length - 1;
    // Before the first entry of the day the last one of the previous day is in force.
    let index = entries.length - 1;
    entries.forEach((entry, position) => {
      if (entry.minute <= minute) index = position;
    });
    return index;
  };

  const intervals: Array<{ start: string; end: string; rate: number; unit: string; source: string; profile_id: string | null }> = [];
  let startMs = fromMs;
  let current = entryAt(fromMs);
  const minuteMs = 60 * 1000;
  for (let ms = Math.floor(fromMs / minuteMs) * minuteMs + minuteMs; ms < toMs; ms += minuteMs) {
    const index = entryAt(ms);
    if (index !== current) {
      intervals.push({ start: new Date(startMs).toISOString(), end: new Date(ms).toISOString(), rate: entries[current].rate, unit: 'U/h', source: 'PROFILE', profile_id: null });
      startMs = ms;
      current = index;
    }
  }
  intervals.push({ start: new Date(startMs).toISOString(), end: new Date(Math.max(toMs, startMs)).toISOString(), rate: entries[current].rate, unit: 'U/h', source: 'PROFILE', profile_id: null });
  return intervals;
}

function mergeAdjacentTempBasalIntervals(intervals: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (intervals.length === 0) {
    return [];
  }

  const sorted = [...intervals].sort((left, right) => Date.parse(String(left.start ?? 0)) - Date.parse(String(right.start ?? 0)));
  const merged: Array<Record<string, unknown>> = [
    { ...sorted[0] },
  ];

  for (const interval of sorted.slice(1)) {
    const current = merged[merged.length - 1];
    const currentRate = Number(current.rate ?? NaN);
    const nextRate = Number(interval.rate ?? NaN);
    const currentEnd = Date.parse(String(current.end ?? current.start ?? 0));
    const nextStart = Date.parse(String(interval.start ?? 0));

    if (Number.isFinite(currentRate) && Number.isFinite(nextRate) && currentRate === nextRate && nextStart <= currentEnd) {
      current.end = interval.end ?? current.end;
      current.status = current.status ?? interval.status ?? 'VALID';
      current.source_ref = current.source_ref ?? interval.source_ref ?? 'temp-basal:combined';
      continue;
    }

    merged.push({ ...interval });
  }

  return merged;
}

function collectInsulinEventRecords(context: Record<string, unknown>): Array<Record<string, unknown>> {
  const currentState = asRecord(context.current_state_snapshot);
  const sources = [
    toArray<Record<string, unknown>>(currentState?.recent_insulin as Record<string, unknown> | Record<string, unknown>[] | null | undefined),
    toArray<Record<string, unknown>>(context.insulin_treatment_events as Record<string, unknown> | Record<string, unknown>[] | null | undefined),
    toArray<Record<string, unknown>>(context.treatment_events as Record<string, unknown> | Record<string, unknown>[] | null | undefined),
  ];

  // The time-range tool context passes the same event array as insulin_treatment_events and treatment_events. An
  // event is the same event by its event_id (or, without one, by being the same record); distinct events that merely
  // share a time and dose are kept.
  const seenRecords = new Set<Record<string, unknown>>();
  const seenEventIds = new Set<string>();
  const records: Record<string, unknown>[] = [];
  for (const source of sources) {
    for (const record of source) {
      if (!record || typeof record !== 'object' || seenRecords.has(record)) {
        continue;
      }
      const kind = normalizeInsulinEventKind(record as Record<string, unknown>);
      if (kind !== 'BOLUS' && kind !== 'SMB') {
        continue;
      }
      const eventId = typeof record.event_id === 'string' && record.event_id.length > 0 ? record.event_id : null;
      if (eventId !== null && seenEventIds.has(eventId)) {
        continue;
      }
      seenRecords.add(record);
      if (eventId !== null) {
        seenEventIds.add(eventId);
      }
      records.push(record as Record<string, unknown>);
    }
  }

  return records;
}

/**
 * Rate of a temp basal record. Top-level fields keep their existing precedence (rate, absolute, value). Stored events
 * carry the normalized treatment in `payload`: rate and absolute are both kept there, and when they disagree the
 * delivered rate cannot be told apart, so it stays unknown (null) rather than picking one.
 */
function resolveTempBasalRate(record: Record<string, unknown>, payload: Record<string, unknown> | null): number | null {
  const topLevel = normalizeNumeric(record.rate ?? record.absolute ?? record.value ?? null);
  if (topLevel !== null) {
    return topLevel;
  }
  const payloadRate = normalizeNumeric(payload?.rate ?? null);
  const payloadAbsolute = normalizeNumeric(payload?.absolute ?? null);
  if (payloadRate !== null && payloadAbsolute !== null && payloadRate !== payloadAbsolute) {
    return null;
  }
  return payloadRate ?? payloadAbsolute;
}

function collectTempBasalRecords(context: Record<string, unknown>): Array<Record<string, unknown>> {
  const currentState = asRecord(context.current_state_snapshot);
  const sources = [
    toArray<Record<string, unknown>>(currentState?.recent_insulin as Record<string, unknown> | Record<string, unknown>[] | null | undefined),
    toArray<Record<string, unknown>>(context.temp_basal_events as Record<string, unknown> | Record<string, unknown>[] | null | undefined),
    toArray<Record<string, unknown>>(context.treatment_events as Record<string, unknown> | Record<string, unknown>[] | null | undefined),
    toArray<Record<string, unknown>>(context.event_context_facts as Record<string, unknown> | Record<string, unknown>[] | null | undefined)
      .map((fact) => asRecord((fact as Record<string, unknown>).value))
      .filter((value): value is Record<string, unknown> => value !== null),
  ];

  // The time-range tool context passes the same event array as both temp_basal_events and treatment_events.
  const seen = new Set<Record<string, unknown>>();
  const records: Record<string, unknown>[] = [];
  for (const source of sources) {
    for (const record of source) {
      if (!record || typeof record !== 'object' || seen.has(record)) {
        continue;
      }
      const kind = normalizeInsulinEventKind(record as Record<string, unknown>);
      if (kind === 'TEMP_BASAL' || String((record as Record<string, unknown>).kind ?? '').toUpperCase().includes('TEMP')) {
        seen.add(record);
        records.push(record as Record<string, unknown>);
      }
    }
  }

  return records;
}

function collectMealRecords(context: Record<string, unknown>): Array<Record<string, unknown>> {
  const currentState = asRecord(context.current_state_snapshot);
  const factMeals = toArray<Record<string, unknown>>(context.event_context_facts as Record<string, unknown> | Record<string, unknown>[] | null | undefined)
    .filter((fact) => String((fact as Record<string, unknown>).fact_type ?? '').toUpperCase() === 'MEAL')
    .map((fact) => {
      const record = fact as Record<string, unknown>;
      const value = (record.value ?? {}) as Record<string, unknown>;
      const source = (record.source ?? {}) as Record<string, unknown>;
      return {
        event_id: source.source_event_id ?? record.fact_key ?? 'meal:fact',
        occurred_at: value.occurred_at ?? source.observed_at ?? source.recorded_at ?? null,
        carbs: value.carbs ?? null,
        meal_type: value.meal_type ?? null,
        provenance_ref: source.source_ref ?? source.source_event_id ?? record.fact_key ?? 'meal:fact',
        validity: record.validity ?? 'VALID',
      };
    });

  const explicitMeals = [
    ...toArray<Record<string, unknown>>(context.meal_events as Record<string, unknown> | Record<string, unknown>[] | null | undefined),
    ...toArray<Record<string, unknown>>(currentState?.recent_meal as Record<string, unknown> | Record<string, unknown>[] | null | undefined),
  ];

  return [...explicitMeals, ...factMeals];
}

function collectActivityRecords(context: Record<string, unknown>): Array<Record<string, unknown>> {
  const currentState = asRecord(context.current_state_snapshot);
  const factActivities = toArray<Record<string, unknown>>(context.event_context_facts as Record<string, unknown> | Record<string, unknown>[] | null | undefined)
    .filter((fact) => String((fact as Record<string, unknown>).fact_type ?? '').toUpperCase() === 'ACTIVITY')
    .map((fact) => {
      const record = fact as Record<string, unknown>;
      const value = (record.value ?? {}) as Record<string, unknown>;
      const source = (record.source ?? {}) as Record<string, unknown>;
      return {
        event_id: source.source_event_id ?? record.fact_key ?? 'activity:fact',
        occurred_at: value.started_at ?? value.occurred_at ?? source.observed_at ?? source.recorded_at ?? null,
        started_at: value.started_at ?? source.observed_at ?? null,
        ended_at: value.ended_at ?? null,
        duration_minutes: value.duration_minutes ?? null,
        activity_type: value.activity_type ?? null,
        provenance_ref: source.source_ref ?? source.source_event_id ?? record.fact_key ?? 'activity:fact',
        validity: record.validity ?? 'VALID',
      };
    });

  const explicitActivities = [
    ...toArray<Record<string, unknown>>(context.activity_events as Record<string, unknown> | Record<string, unknown>[] | null | undefined),
    ...toArray<Record<string, unknown>>(currentState?.recent_activity as Record<string, unknown> | Record<string, unknown>[] | null | undefined),
  ];

  return [...explicitActivities, ...factActivities];
}

export const MEAL_RECORDS_TRUST_NOTE = 'meal_records.trusted are caregiver-confirmed meals: their description and macros are facts. meal_records.unconfirmed are not confirmed: unknown macros stay unknown and unconfirmed_proposal_g is an unverified AI estimate, never a fact.';

export const FAT_PROTEIN_UNIT_ENTRIES_NOTE = 'fat_protein_unit_entries are carbs logged in the loop only to dose insulin for the protein and fat (WBT) of an earlier meal: they are not food, not a meal of their own and not an unresolved meal, and they are not counted in the carbohydrate events above. linked_meal is the meal each one covers (meal_record: its description, the carbs of all its entries and its macros with their trust status); null when that meal could not be identified.';

interface FatProteinUnitEntry {
  event_id: string;
  occurred_at: string;
  carbs_logged_for_wbt: number | null;
  linked_meal: unknown;
  provenance_ref: string;
}

/** WBT carb entries (carb_kind FAT_PROTEIN_UNITS) logged inside the range, oldest first, with their linked meal. */
function selectFatProteinUnitEntriesInRange(value: unknown, range: { from: string; to: string } | null): FatProteinUnitEntry[] {
  return toArray<Record<string, unknown>>(value as Record<string, unknown>[] | null | undefined)
    .map((event) => ({
      event_id: String(event.event_id ?? ''),
      occurred_at: String(event.occurred_at ?? ''),
      carbs_logged_for_wbt: normalizeNumeric(((event.payload ?? {}) as Record<string, unknown>).carbs ?? null),
      linked_meal: event.linked_meal ?? null,
      provenance_ref: String(event.source_record_id ?? event.event_id ?? 'wbt:unknown'),
    }))
    .filter((entry) => {
      const when = Date.parse(entry.occurred_at);
      if (!Number.isFinite(when)) return false;
      return !range || (when >= Date.parse(range.from) && when <= Date.parse(range.to));
    })
    .sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at));
}

interface MealRecordContextItem {
  meal_identity: string;
  started_at: string;
  [key: string]: unknown;
}

/** Caregiver-confirmed and unconfirmed new-history meals (meal-record-trust.v1) that started inside the range. */
function selectMealRecordsInRange(
  value: unknown,
  range: { from: string; to: string } | null,
): { policy_version: string; trusted: MealRecordContextItem[]; unconfirmed: MealRecordContextItem[] } | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const selection = value as { policy_version?: unknown; trusted?: unknown; unconfirmed?: unknown };
  const inRange = (item: MealRecordContextItem) => {
    if (!range) return true;
    const when = Date.parse(item.started_at);
    return Number.isFinite(when) && when >= Date.parse(range.from) && when <= Date.parse(range.to);
  };
  const trusted = toArray<MealRecordContextItem>(selection.trusted as MealRecordContextItem[] | undefined).filter(inRange);
  const unconfirmed = toArray<MealRecordContextItem>(selection.unconfirmed as MealRecordContextItem[] | undefined).filter(inRange);
  if (trusted.length === 0 && unconfirmed.length === 0) {
    return null;
  }
  return { policy_version: String(selection.policy_version ?? 'meal-record-trust.v1'), trusted, unconfirmed };
}

export const getMealEvidenceTool: {
  readonly name: EvidenceToolName;
  description: string;
  detail_levels: readonly EvidenceDetailLevel[];
  max_range_ms: number;
  default_detail_level: EvidenceDetailLevel;
  execute: (request: EvidenceToolRequest, context: Record<string, unknown>) => EvidenceToolResponse;
} = {
  name: 'get_meal_evidence',
  description: 'Returns compact meal/carbohydrate semantics for the requested range.',
  detail_levels: ['SUMMARY', 'SIGNIFICANT_EVENTS', 'DETAIL'],
  max_range_ms: 24 * 60 * 60 * 1000,
  default_detail_level: 'SUMMARY',
  execute(request, context) {
    const validation = evaluateEvidenceToolRequest(request, context as { patient_ref?: { patient_id?: string } | null });
    if (!validation.ok) {
      return buildSemanticResponse(
        request,
        validation.error.status,
        { error: validation.error.reason },
        { status: 'MISSING', range: request.time_range ?? null, covered_range: null, gaps: [] },
        [validation.error.reason],
        [],
      );
    }

    if (scopeToLoadedRange(request, context).kind !== 'IN_RANGE') {
      return executeWithinLoadedRange(request, context, (scoped) => getMealEvidenceTool.execute(scoped, context));
    }

    const selected = collectMealRecords(context as Record<string, unknown>)
      .filter((record) => {
        const occurredAt = getTimeValue(record as Record<string, unknown>);
        if (!occurredAt) {
          return false;
        }
        if (!request.time_range) {
          return true;
        }
        const when = Date.parse(occurredAt);
        const from = Date.parse(request.time_range.from);
        const to = Date.parse(request.time_range.to);
        return Number.isFinite(when) && Number.isFinite(from) && Number.isFinite(to) && when >= from && when <= to;
      })
      .sort((left, right) => {
        const leftAt = getTimeValue(left as Record<string, unknown>) ?? '1970-01-01T00:00:00.000Z';
        const rightAt = getTimeValue(right as Record<string, unknown>) ?? '1970-01-01T00:00:00.000Z';
        return Date.parse(leftAt) - Date.parse(rightAt);
      });

    const normalized = selected.map((event) => {
      const occurredAt = getTimeValue(event as Record<string, unknown>);
      // Stored CARB_ENTRY events keep the grams and the caregiver-set kind in `payload`.
      const payload = asRecord((event as Record<string, unknown>).payload);
      const carbs = normalizeNumeric((event as Record<string, unknown>).carbs ?? (event as Record<string, unknown>).carbohydrate_amount ?? payload?.carbs ?? null);
      const carbKind = (event as Record<string, unknown>).carb_kind ?? payload?.carb_kind;
      const sourceRef = String((event as Record<string, unknown>).provenance_ref ?? (event as Record<string, unknown>).source_ref ?? (event as Record<string, unknown>).source_record_id ?? (event as Record<string, unknown>).source_event_id ?? (event as Record<string, unknown>).event_id ?? 'meal:unknown');
      return {
        event_id: String((event as Record<string, unknown>).event_id ?? (event as Record<string, unknown>).source_event_id ?? sourceRef),
        occurred_at: occurredAt,
        carbs,
        meal_type: typeof (event as Record<string, unknown>).meal_type === 'string' ? String((event as Record<string, unknown>).meal_type) : null,
        // HYPO_TREATMENT: fast carbs given for a hypo, not a meal.
        ...(typeof carbKind === 'string' ? { carb_kind: carbKind } : {}),
        // Rescue carbs logged in GlucoMind only (rescue-carbs.v1): the loop never got them.
        ...(payload?.entry_source === 'GLUCOMIND' ? { entry_source: 'GLUCOMIND', in_loop: false } : {}),
        validity: String((event as Record<string, unknown>).validity ?? (event as Record<string, unknown>).status ?? 'VALID'),
        provenance_ref: sourceRef,
      };
    });

    const totalCarbs = normalized.reduce((sum, event) => sum + (event.carbs ?? 0), 0);
    const knownCarbEvents = normalized.filter((event) => event.carbs !== null).length;
    // Fast carbs for a hypo are not food eaten as a meal: totals apart, so "ile węgli zjadł" is not inflated.
    const hypoTreatmentCarbs = normalized.filter((event) => event.carb_kind === 'HYPO_TREATMENT').reduce((sum, event) => sum + (event.carbs ?? 0), 0);
    const summary = {
      event_count: normalized.length,
      known_carbohydrate_event_count: knownCarbEvents,
      unknown_carbohydrate_event_count: Math.max(0, normalized.length - knownCarbEvents),
      total_carbs: knownCarbEvents > 0 ? totalCarbs : null,
      total_meal_carbs: knownCarbEvents > 0 ? Math.round((totalCarbs - hypoTreatmentCarbs) * 10) / 10 : null,
      total_hypo_treatment_carbs: knownCarbEvents > 0 ? Math.round(hypoTreatmentCarbs * 10) / 10 : null,
      first_event: normalized[0]?.occurred_at ?? null,
      last_event: normalized[normalized.length - 1]?.occurred_at ?? null,
    };

    const mealRecords = selectMealRecordsInRange((context as Record<string, unknown>).meal_records, request.time_range ?? null);
    const fatProteinUnitEntries = selectFatProteinUnitEntriesInRange((context as Record<string, unknown>).fat_protein_unit_carb_events, request.time_range ?? null);
    const hasEvidence = normalized.length > 0 || mealRecords !== null || fatProteinUnitEntries.length > 0;

    const evidence = {
      summary,
      // Every carb entry at every level (Trio: ~12 a day): a list cut to the first ones read as "no dinner".
      events: normalized,
      associations: {
        insulin_association: 'UNKNOWN',
        activity_association: 'UNKNOWN',
      },
      // Present only when the new meal history has meals in the range; Nightscout events above stay the source of carbs.
      ...(mealRecords ? { meal_records: mealRecords } : {}),
      // WBT entries in the range, each with the meal it covers (which may have started before the range).
      ...(fatProteinUnitEntries.length > 0 ? { fat_protein_unit_entries: fatProteinUnitEntries } : {}),
      status: hasEvidence ? 'KNOWN' : 'MISSING',
      model: 'canonical-treatment-meal-compiler',
    };

    const notes = normalized.length > 0
      ? ['Meal evidence is scoped to deterministic event selection for the requested range.']
      : ['No meal evidence matched the requested range.'];
    if (mealRecords) {
      notes.push(MEAL_RECORDS_TRUST_NOTE);
    }
    if (fatProteinUnitEntries.length > 0) {
      notes.push(FAT_PROTEIN_UNIT_ENTRIES_NOTE);
    }

    return buildSemanticResponse(
      request,
      hasEvidence ? 'KNOWN' : 'MISSING',
      evidence,
      buildCoverage(request.time_range ?? null, selected as Array<Record<string, unknown>>),
      notes,
      [
        ...normalized.map((event) => event.provenance_ref),
        ...(mealRecords ? [...mealRecords.trusted, ...mealRecords.unconfirmed].map((item) => item.meal_identity) : []),
        ...fatProteinUnitEntries.map((entry) => entry.provenance_ref),
      ],
    );
  },
};

export const getActivityEvidenceTool: {
  readonly name: EvidenceToolName;
  description: string;
  detail_levels: readonly EvidenceDetailLevel[];
  max_range_ms: number;
  default_detail_level: EvidenceDetailLevel;
  execute: (request: EvidenceToolRequest, context: Record<string, unknown>) => EvidenceToolResponse;
} = {
  name: 'get_activity_evidence',
  description: 'Returns compact activity semantics for the requested range.',
  detail_levels: ['SUMMARY', 'SIGNIFICANT_EVENTS', 'DETAIL'],
  max_range_ms: 24 * 60 * 60 * 1000,
  default_detail_level: 'SUMMARY',
  execute(request, context) {
    const validation = evaluateEvidenceToolRequest(request, context as { patient_ref?: { patient_id?: string } | null });
    if (!validation.ok) {
      return buildSemanticResponse(
        request,
        validation.error.status,
        { error: validation.error.reason },
        { status: 'MISSING', range: request.time_range ?? null, covered_range: null, gaps: [] },
        [validation.error.reason],
        [],
      );
    }

    if (scopeToLoadedRange(request, context).kind !== 'IN_RANGE') {
      return executeWithinLoadedRange(request, context, (scoped) => getActivityEvidenceTool.execute(scoped, context));
    }

    const selected = collectActivityRecords(context as Record<string, unknown>)
      .filter((record) => {
        const occurredAt = getTimeValue(record as Record<string, unknown>);
        if (!occurredAt) {
          return false;
        }
        if (!request.time_range) {
          return true;
        }
        const when = Date.parse(occurredAt);
        const from = Date.parse(request.time_range.from);
        const to = Date.parse(request.time_range.to);
        return Number.isFinite(when) && Number.isFinite(from) && Number.isFinite(to) && when >= from && when <= to;
      })
      .sort((left, right) => {
        const leftAt = getTimeValue(left as Record<string, unknown>) ?? '1970-01-01T00:00:00.000Z';
        const rightAt = getTimeValue(right as Record<string, unknown>) ?? '1970-01-01T00:00:00.000Z';
        return Date.parse(leftAt) - Date.parse(rightAt);
      });

    const normalized = selected.map((event) => {
      const startedAt = typeof (event as Record<string, unknown>).started_at === 'string'
        ? String((event as Record<string, unknown>).started_at)
        : getTimeValue(event as Record<string, unknown>);
      const endedAt = typeof (event as Record<string, unknown>).ended_at === 'string'
        ? String((event as Record<string, unknown>).ended_at)
        : null;
      const durationMinutes = normalizeNumeric((event as Record<string, unknown>).duration_minutes ?? (event as Record<string, unknown>).duration_min ?? null);
      const sourceRef = String((event as Record<string, unknown>).provenance_ref ?? (event as Record<string, unknown>).source_ref ?? (event as Record<string, unknown>).source_record_id ?? (event as Record<string, unknown>).source_event_id ?? (event as Record<string, unknown>).event_id ?? 'activity:unknown');
      return {
        event_id: String((event as Record<string, unknown>).event_id ?? (event as Record<string, unknown>).source_event_id ?? sourceRef),
        occurred_at: getTimeValue(event as Record<string, unknown>),
        started_at: startedAt,
        ended_at: endedAt,
        duration_minutes: durationMinutes,
        activity_type: typeof (event as Record<string, unknown>).activity_type === 'string' ? String((event as Record<string, unknown>).activity_type) : 'UNKNOWN',
        validity: String((event as Record<string, unknown>).validity ?? (event as Record<string, unknown>).status ?? 'VALID'),
        provenance_ref: sourceRef,
      };
    });

    const totalDuration = normalized.reduce((sum, event) => sum + (event.duration_minutes ?? 0), 0);
    const knownTypeCount = normalized.filter((event) => event.activity_type !== 'UNKNOWN').length;
    const summary = {
      event_count: normalized.length,
      total_duration_minutes: normalized.some((event) => event.duration_minutes !== null) ? totalDuration : null,
      known_activity_type_count: knownTypeCount,
      unknown_activity_type_count: Math.max(0, normalized.length - knownTypeCount),
      first_event: normalized[0]?.occurred_at ?? null,
      last_event: normalized[normalized.length - 1]?.occurred_at ?? null,
    };

    const evidence = {
      summary,
      events: normalized,
      status: normalized.length > 0 ? 'KNOWN' : 'MISSING',
      model: 'canonical-activity-compiler',
    };
    const hasActivityEvidence = normalized.length > 0;
    const activityNotes = normalized.length > 0
      ? ['Activity evidence is bounded to deterministic in-range events.']
      : ['No activity evidence matched the requested range.'];

    return buildSemanticResponse(
      request,
      hasActivityEvidence ? 'KNOWN' : 'MISSING',
      evidence,
      buildCoverage(request.time_range ?? null, selected as Array<Record<string, unknown>>),
      activityNotes,
      normalized.map((event) => event.provenance_ref),
    );
  },
};

export const getInsulinEvidenceTool: {
  readonly name: EvidenceToolName;
  description: string;
  detail_levels: readonly EvidenceDetailLevel[];
  max_range_ms: number;
  default_detail_level: EvidenceDetailLevel;
  execute: (request: EvidenceToolRequest, context: Record<string, unknown>) => EvidenceToolResponse;
} = {
  name: 'get_insulin_evidence',
  description: 'Returns compact insulin treatment semantics without inventing meal or glucose associations.',
  detail_levels: ['SUMMARY', 'SIGNIFICANT_EVENTS', 'DETAIL'],
  max_range_ms: 24 * 60 * 60 * 1000,
  default_detail_level: 'SUMMARY',
  execute(request, context) {
    const validation = evaluateEvidenceToolRequest(request, context as { patient_ref?: { patient_id?: string } | null });
    if (!validation.ok) {
      return buildSemanticResponse(
        request,
        validation.error.status,
        { error: validation.error.reason },
        { status: 'MISSING', range: request.time_range ?? null, covered_range: null, gaps: [] },
        [validation.error.reason],
        [],
      );
    }

    if (scopeToLoadedRange(request, context).kind !== 'IN_RANGE') {
      return executeWithinLoadedRange(request, context, (scoped) => getInsulinEvidenceTool.execute(scoped, context));
    }

    const selected = collectInsulinEventRecords(context as Record<string, unknown>)
      .filter((record) => {
        const occurredAt = getTimeValue(record as Record<string, unknown>); 
        if (!occurredAt) {
          return false;
        }
        if (!request.time_range) {
          return true;
        }
        const when = Date.parse(occurredAt);
        const from = Date.parse(request.time_range.from);
        const to = Date.parse(request.time_range.to);
        return Number.isFinite(when) && Number.isFinite(from) && Number.isFinite(to) && when >= from && when <= to;
      })
      .sort((left, right) => {
        const leftAt = getTimeValue(left as Record<string, unknown>) ?? '1970-01-01T00:00:00.000Z';
        const rightAt = getTimeValue(right as Record<string, unknown>) ?? '1970-01-01T00:00:00.000Z';
        return Date.parse(leftAt) - Date.parse(rightAt);
      });

    const normalized = selected.map((event) => {
      const kind = normalizeInsulinEventKind(event as Record<string, unknown>);
      // Stored BOLUS/SMB events keep the normalized dose in `payload.insulin_units`; a missing dose stays null.
      const payload = asRecord((event as Record<string, unknown>).payload);
      const amount = normalizeNumeric((event as Record<string, unknown>).value ?? (event as Record<string, unknown>).amount ?? (event as Record<string, unknown>).insulin ?? (event as Record<string, unknown>).insulin_units ?? payload?.insulin_units ?? null);
      const occurredAt = getTimeValue(event as Record<string, unknown>);
      const sourceRef = String((event as Record<string, unknown>).provenance_ref ?? (event as Record<string, unknown>).source_ref ?? (event as Record<string, unknown>).source_record_id ?? (event as Record<string, unknown>).source_event_id ?? (event as Record<string, unknown>).event_id ?? 'insulin:unknown');
      return {
        event_id: String((event as Record<string, unknown>).event_id ?? (event as Record<string, unknown>).source_event_id ?? (event as Record<string, unknown>).source_record_id ?? sourceRef),
        event_type: kind,
        kind: kind,
        amount,
        unit: String((event as Record<string, unknown>).unit ?? 'U'),
        occurred_at: occurredAt,
        validity: String((event as Record<string, unknown>).validity ?? (event as Record<string, unknown>).status ?? 'VALID'),
        provenance_ref: sourceRef,
        relationship_to_meal: 'UNKNOWN',
      };
    });

    // A total is only known when every dose in it is known: an unknown dose is never counted as 0.
    const totalOf = (eventType: 'BOLUS' | 'SMB'): number | null => {
      const amounts = normalized.filter((event) => event.event_type === eventType).map((event) => event.amount);
      return amounts.some((amount) => amount === null) ? null : amounts.reduce<number>((sum, amount) => sum + (amount as number), 0);
    };
    const totalBolus = totalOf('BOLUS');
    const totalSmb = totalOf('SMB');
    const unknownDoseCount = normalized.filter((event) => event.amount === null).length;
    const status = unknownDoseCount > 0 ? 'PARTIAL_DATA' : 'KNOWN';
    const summary = {
      total_bolus_insulin: totalBolus,
      total_smb_insulin: totalSmb,
      total_insulin: totalBolus === null || totalSmb === null ? null : totalBolus + totalSmb,
      bolus_count: normalized.filter((event) => event.event_type === 'BOLUS').length,
      smb_count: normalized.filter((event) => event.event_type === 'SMB').length,
      event_count: normalized.length,
      first_event: normalized[0]?.occurred_at ?? null,
      last_event: normalized[normalized.length - 1]?.occurred_at ?? null,
    };

    // SUMMARY lists every bolus (Trio: ~12 a day); SMBs (~30 a day) are only counted and summed there.
    const boluses = normalized.filter((event) => event.event_type === 'BOLUS');
    const listed = request.detail_level === 'DETAIL' || request.detail_level === 'SIGNIFICANT_EVENTS' ? normalized : boluses;
    const evidence = {
      summary,
      events: listed,
      ...(listed.length < normalized.length ? { events_listed: 'BOLUSES_ONLY' } : {}),
      significant_events: boluses.map((event) => ({
        event_id: event.event_id,
        occurred_at: event.occurred_at,
        event_type: event.event_type,
        amount: event.amount,
        unit: event.unit,
        provenance_ref: event.provenance_ref,
      })),
      associations: {
        meal_association: 'UNKNOWN',
        activity_association: 'UNKNOWN',
      },
      status,
      model: 'canonical-treatment-insulin-compiler',
    };

    return buildSemanticResponse(
      request,
      status,
      evidence,
      buildCoverage(request.time_range ?? null, selected as Array<Record<string, unknown>>),
      [
        'Meal and activity association remains explicit UNKNOWN unless deterministically established.',
        ...(listed.length < normalized.length ? ['events lists every bolus; SMBs are only counted and summed in the summary (request SIGNIFICANT_EVENTS or DETAIL for their times).'] : []),
        ...(unknownDoseCount > 0 ? [`Insulin dose is unknown for ${unknownDoseCount} event(s); totals that include them are unknown.`] : []),
      ],
      normalized.map((event) => event.provenance_ref),
    );
  },
};

export const getBasalEvidenceTool: {
  readonly name: EvidenceToolName;
  description: string;
  detail_levels: readonly EvidenceDetailLevel[];
  max_range_ms: number;
  default_detail_level: EvidenceDetailLevel;
  execute: (request: EvidenceToolRequest, context: Record<string, unknown>) => EvidenceToolResponse;
} = {
  name: 'get_basal_evidence',
  description: 'Provides planned basal and meaningful actual/temp basal changes without replacing the continuous basal record with coarse synthetic buckets.',
  detail_levels: ['SUMMARY', 'DETAIL'],
  max_range_ms: 24 * 60 * 60 * 1000,
  default_detail_level: 'SUMMARY',
  execute(request, context) {
    const validation = evaluateEvidenceToolRequest(request, context as { patient_ref?: { patient_id?: string } | null });
    if (!validation.ok) {
      return buildSemanticResponse(
        request,
        validation.error.status,
        { error: validation.error.reason },
        { status: 'MISSING', range: request.time_range ?? null, covered_range: null, gaps: [] },
        [validation.error.reason],
        [],
      );
    }

    if (scopeToLoadedRange(request, context).kind !== 'IN_RANGE') {
      return executeWithinLoadedRange(request, context, (scoped) => getBasalEvidenceTool.execute(scoped, context));
    }

    const therapy = (context?.active_therapy_snapshot ?? null) as Record<string, unknown> | null;

    const scheduledIntervals = normalizeBasalScheduleEntries(therapy?.basal_schedule ?? {}, request.time_range ?? null, typeof therapy?.timezone === 'string' && therapy.timezone ? therapy.timezone : 'UTC')
      .filter((interval) => {
        if (!request.time_range) {
          return true;
        }
        const start = Date.parse(interval.start);
        const end = Date.parse(interval.end);
        const from = Date.parse(request.time_range.from);
        const to = Date.parse(request.time_range.to);
        return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(from) && Number.isFinite(to) && start <= to && end >= from;
      });

    const tempRecords = collectTempBasalRecords(context as Record<string, unknown>)
      .filter((record) => {
        const startedAt = getTimeValue(record as Record<string, unknown>);
        if (!startedAt) {
          return false;
        }
        if (!request.time_range) {
          return true;
        }
        const start = Date.parse(startedAt);
        const from = Date.parse(request.time_range.from);
        const to = Date.parse(request.time_range.to);
        return Number.isFinite(start) && Number.isFinite(from) && Number.isFinite(to) && start >= from && start <= to;
      });
    let unresolvedRateCount = 0;
    const tempEvents = tempRecords
      .map((record) => {
        const startedAt = getTimeValue(record as Record<string, unknown>) ?? request.time_range?.from ?? new Date().toISOString();
        // Stored events keep the normalized treatment fields in `payload` (rate, absolute, duration_minutes).
        const payload = asRecord((record as Record<string, unknown>).payload);
        const durationMs = normalizeNumeric((record as Record<string, unknown>).duration ?? (record as Record<string, unknown>).duration_minutes ?? (record as Record<string, unknown>).duration_ms ?? payload?.duration_minutes ?? null);
        const rate = resolveTempBasalRate(record as Record<string, unknown>, payload);
        if (rate === null) {
          unresolvedRateCount += 1;
        }
        const endAt = durationMs !== null ? new Date(Date.parse(startedAt) + durationMs * 60 * 1000).toISOString() : request.time_range?.to ?? new Date(Date.parse(startedAt) + 60 * 60 * 1000).toISOString();
        return {
          start: startedAt,
          end: endAt,
          // Unknown stays null: a 0 here would read as a suspended basal.
          rate,
          unit: 'U/h',
          status: String((record as Record<string, unknown>).validity ?? (record as Record<string, unknown>).status ?? 'VALID'),
          event_id: String((record as Record<string, unknown>).event_id ?? (record as Record<string, unknown>).source_event_id ?? (record as Record<string, unknown>).source_record_id ?? 'temp-basal:unknown'),
          source_ref: String((record as Record<string, unknown>).provenance_ref ?? (record as Record<string, unknown>).source_ref ?? (record as Record<string, unknown>).source_record_id ?? 'temp-basal:unknown'),
          type: 'TEMP_BASAL',
        };
      });

    const tempIntervals = mergeAdjacentTempBasalIntervals(tempEvents).map((interval) => ({
      event_id: interval.event_id,
      type: 'TEMP_BASAL',
      start: interval.start,
      end: interval.end,
      rate: interval.rate === null || interval.rate === undefined ? null : Number(interval.rate),
      unit: 'U/h',
      status: String(interval.status ?? 'VALID'),
      provenance_ref: String(interval.source_ref ?? 'temp-basal:unknown'),
    }));
    const rateLimitations = unresolvedRateCount > 0
      ? [`Temp basal rate is unknown for ${unresolvedRateCount} record(s): no rate was recorded, or rate and absolute disagree.`]
      : [];

    if (!therapy) {
      // No profile: planned basal is unknown, but recorded temp basal changes are still patient data.
      if (tempIntervals.length === 0) {
        return buildSemanticResponse(
          request,
          'MISSING',
          {
            planned_basal: null,
            actual_temp_basal: [],
            summary: { planned_intervals: 0, temp_intervals: 0 },
          },
          { status: 'MISSING', range: request.time_range ?? null, covered_range: null, gaps: request.time_range ? [{ from: request.time_range.from, to: request.time_range.to }] : [] },
          ['No therapy profile was available for basal interpretation and no temp basal is recorded here: basal delivery in this window is unknown, not zero.'],
          [],
        );
      }
      return buildSemanticResponse(
        request,
        'PARTIAL_DATA',
        {
          planned_basal: null,
          actual_temp_basal: tempIntervals,
          summary: { planned_intervals: 0, temp_intervals: tempIntervals.length },
          temporal_relationship: {
            planned_vs_actual: 'PLANNED_UNKNOWN',
            preserves_boundaries: true,
          },
        },
        buildCoverage(request.time_range ?? null, tempRecords as Array<Record<string, unknown>>),
        ['No therapy profile was available: planned basal is unknown; only recorded temp basal changes are reported.', ...rateLimitations],
        tempIntervals.map((interval) => String(interval.provenance_ref ?? interval.event_id)),
      );
    }

    const evidence = {
      planned_basal: {
        profile_id: String(therapy.active_profile_id ?? therapy.therapy_id ?? 'unknown-profile'),
        version: String(therapy.therapy_version ?? 'unknown-version'),
        intervals: scheduledIntervals,
        source: 'PROFILE',
      },
      actual_temp_basal: tempIntervals,
      summary: {
        planned_intervals: scheduledIntervals.length,
        temp_intervals: tempIntervals.length,
        baseline_profile_id: String(therapy.active_profile_id ?? therapy.therapy_id ?? 'unknown-profile'),
      },
      temporal_relationship: {
        planned_vs_actual: 'SEPARATED',
        preserves_boundaries: true,
      },
      raw_profile: undefined,
      model: 'canonical-therapy-basal-compiler',
    };

    return buildSemanticResponse(
      request,
      'KNOWN',
      evidence,
      // Coverage from the source records: they carry the occurred_at timestamps, the mapped intervals do not.
      buildCoverage(request.time_range ?? null, tempRecords as Array<Record<string, unknown>>),
      [
        'Basal semantics distinguish planned profile intervals from actual temp intervals without exposing raw profile JSON.',
        // Trio sets a temp basal only to deviate from the profile: none recorded means the profile basal ran.
        ...(tempIntervals.length === 0 ? ['No temp basal is recorded in this window: the loop delivered the profile basal (planned_basal.intervals) unless the pump was suspended. This is not an absence of basal insulin.'] : []),
        ...rateLimitations,
      ],
      [
        ...scheduledIntervals.map((interval) => String(interval.profile_id ?? 'profile:basal')),
        ...tempIntervals.map((interval) => String(interval.provenance_ref ?? interval.event_id)),
      ],
    );
  },
};

export const getLoopEvidenceTool: {
  readonly name: EvidenceToolName;
  description: string;
  detail_levels: readonly EvidenceDetailLevel[];
  max_range_ms: number;
  default_detail_level: EvidenceDetailLevel;
  execute: (request: EvidenceToolRequest, context: Record<string, unknown>) => EvidenceToolResponse;
} = {
  name: 'get_loop_evidence',
  description: 'Compiles DeviceStatus semantics into compact loop decisions rather than returning raw system payloads.',
  detail_levels: ['SUMMARY', 'DETAIL'],
  max_range_ms: 6 * 60 * 60 * 1000,
  default_detail_level: 'SUMMARY',
  execute(request, context) {
    const validation = evaluateEvidenceToolRequest(request, context as { patient_ref?: { patient_id?: string } | null });
    if (!validation.ok) {
      return buildSemanticResponse(
        request,
        validation.error.status,
        { error: validation.error.reason },
        { status: 'MISSING', range: request.time_range ?? null, covered_range: null, gaps: [] },
        [validation.error.reason],
        [],
      );
    }

    const currentState = (context?.current_state_snapshot ?? null) as Record<string, unknown> | null;
    if (!currentState) {
      return buildSemanticResponse(
        request,
        'MISSING',
        {
          decisions: [],
          status: 'MISSING',
        },
        { status: 'MISSING', range: request.time_range ?? null, covered_range: null, gaps: request.time_range ? [{ from: request.time_range.from, to: request.time_range.to }] : [] },
        ['No current loop snapshot was available.'],
        [],
      );
    }

    // Only the state at the time of the question is stored: it says nothing about an earlier window.
    const asOfMs = parseIso(typeof currentState.as_of === 'string' ? currentState.as_of : undefined);
    const windowFromMs = parseIso(request.time_range?.from);
    const windowToMs = parseIso(request.time_range?.to);
    if (windowFromMs !== null && windowToMs !== null && (asOfMs === null || asOfMs < windowFromMs || asOfMs > windowToMs)) {
      return buildSemanticResponse(
        request,
        'NOT_SELECTED',
        { decisions: [], status: 'NOT_SELECTED', current_state_as_of: currentState.as_of ?? null },
        { status: 'UNKNOWN', range: request.time_range ?? null, covered_range: null, gaps: [] },
        ['Only the current loop state (as_of) is available; loop decisions, IOB and glucose of this window were not loaded. This is not an absence of loop activity: use the glucose, insulin and basal evidence for this window.'],
        [],
      );
    }

    return buildSemanticResponse(
      request,
      'KNOWN',
      {
        decisions: [{
          observed_at: currentState.as_of ?? null,
          bg: currentState.current_glucose ?? null,
          trend: currentState.trend ?? 'UNKNOWN',
          iob: currentState.iob ?? 'UNKNOWN',
          insulin_requirement: 'UNKNOWN',
          predicted_bg_summary: 'not returned by default',
        }],
      },
      {
        status: 'KNOWN',
        range: request.time_range ?? null,
        covered_range: request.time_range ?? null,
        gaps: [],
      },
      ['Prediction arrays are intentionally omitted by default to keep loop evidence semantic and compact.'],
      ['loop:current'],
    );
  },
};

export const getTherapyProfileTool: {
  readonly name: EvidenceToolName;
  description: string;
  detail_levels: readonly EvidenceDetailLevel[];
  max_range_ms: number;
  default_detail_level: EvidenceDetailLevel;
  execute: (request: EvidenceToolRequest, context: Record<string, unknown>) => EvidenceToolResponse;
} = {
  name: 'get_therapy_profile',
  description: 'Returns the therapy configuration that is semantically relevant to the patient and time window, without exposing raw profile JSON payloads.',
  detail_levels: ['SUMMARY', 'DETAIL'],
  max_range_ms: 24 * 60 * 60 * 1000,
  default_detail_level: 'SUMMARY',
  execute(request, context) {
    const validation = evaluateEvidenceToolRequest(request, context as { patient_ref?: { patient_id?: string } | null });
    if (!validation.ok) {
      return buildSemanticResponse(
        request,
        validation.error.status,
        { error: validation.error.reason },
        { status: 'MISSING', range: request.time_range ?? null, covered_range: null, gaps: [] },
        [validation.error.reason],
        [],
      );
    }

    const therapy = (context?.active_therapy_snapshot ?? null) as Record<string, unknown> | null;
    if (!therapy) {
      const unavailable = context?.therapy_profile_status === 'UNAVAILABLE';
      return buildSemanticResponse(
        request,
        unavailable ? 'UNKNOWN' : 'MISSING',
        {
          profile_id: null,
          planned_basal: null,
          icr: null,
          isf: null,
          target: null,
          dia: null,
        },
        { status: unavailable ? 'UNKNOWN' : 'MISSING', range: request.time_range ?? null, covered_range: null, gaps: request.time_range ? [{ from: request.time_range.from, to: request.time_range.to }] : [] },
        [unavailable
          ? 'The therapy profile could not be read for this answer (lookup failed): its settings are unknown, not absent.'
          : 'No therapy profile was available for that timestamp or period.'],
        [],
      );
    }

    return buildSemanticResponse(
      request,
      'KNOWN',
      {
        profile_id: therapy.active_profile_id ?? therapy.therapy_id ?? null,
        therapy_id: therapy.therapy_id ?? null,
        version: therapy.therapy_version ?? null,
        planned_basal: { schedule: therapy.basal_schedule ?? {} },
        icr: therapy.icr_schedule ?? null,
        isf: therapy.isf_schedule ?? null,
        target: therapy.target_schedule ?? null,
        dia: therapy.dia ?? null,
        timezone: therapy.timezone ?? null,
      },
      {
        status: 'KNOWN',
        range: request.time_range ?? null,
        covered_range: request.time_range ?? null,
        gaps: [],
      },
      ['Actual override ON/OFF events belong to treatment or device evidence rather than the static profile summary.'],
      ['therapy:' + String(therapy.therapy_id ?? 'unknown')],
    );
  },
};

export function createEvidenceToolRegistry(): {
  tools: EvidenceToolDefinition[];
  getByName: (name: string) => EvidenceToolDefinition | undefined;
  execute: (request: EvidenceToolRequest, context: Record<string, unknown>, options?: {
    executionId?: string;
    observer?: EvidenceToolProcessingObserver;
  }) => EvidenceToolResponse;
} {
  const tools: EvidenceToolDefinition[] = [
    {
      name: 'get_glucose_evidence',
      description: getGlucoseEvidenceTool.description,
      detail_levels: [...getGlucoseEvidenceTool.detail_levels],
      max_range_ms: getGlucoseEvidenceTool.max_range_ms,
      default_detail_level: getGlucoseEvidenceTool.default_detail_level,
    },
    {
      name: 'get_insulin_evidence',
      description: getInsulinEvidenceTool.description,
      detail_levels: [...getInsulinEvidenceTool.detail_levels],
      max_range_ms: getInsulinEvidenceTool.max_range_ms,
      default_detail_level: getInsulinEvidenceTool.default_detail_level,
    },
    {
      name: 'get_basal_evidence',
      description: getBasalEvidenceTool.description,
      detail_levels: [...getBasalEvidenceTool.detail_levels],
      max_range_ms: getBasalEvidenceTool.max_range_ms,
      default_detail_level: getBasalEvidenceTool.default_detail_level,
    },
    {
      name: 'get_meal_evidence',
      description: getMealEvidenceTool.description,
      detail_levels: [...getMealEvidenceTool.detail_levels],
      max_range_ms: getMealEvidenceTool.max_range_ms,
      default_detail_level: getMealEvidenceTool.default_detail_level,
    },
    {
      name: 'get_activity_evidence',
      description: getActivityEvidenceTool.description,
      detail_levels: [...getActivityEvidenceTool.detail_levels],
      max_range_ms: getActivityEvidenceTool.max_range_ms,
      default_detail_level: getActivityEvidenceTool.default_detail_level,
    },
    {
      name: 'get_loop_evidence',
      description: getLoopEvidenceTool.description,
      detail_levels: [...getLoopEvidenceTool.detail_levels],
      max_range_ms: getLoopEvidenceTool.max_range_ms,
      default_detail_level: getLoopEvidenceTool.default_detail_level,
    },
    {
      name: 'get_therapy_profile',
      description: getTherapyProfileTool.description,
      detail_levels: [...getTherapyProfileTool.detail_levels],
      max_range_ms: getTherapyProfileTool.max_range_ms,
      default_detail_level: getTherapyProfileTool.default_detail_level,
    },
  ];

  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    tools,
    getByName: (name: string) => byName.get(name as EvidenceToolName),
    execute: (request, context, options) => {
      const toolDefinition = byName.get(request.tool as EvidenceToolName);
      const executionId = options?.executionId ?? `evidence-tool:${request.tool}:${Date.now()}`;
      let sequence = 0;
      const emit = (type: ProcessingStepType, status: ProcessingStepStatus, detail: string | null = null, tool: EvidenceToolName = request.tool) => {
        sequence += 1;
        const now = new Date().toISOString();
        const step = buildEvidenceProcessingStep({
          executionId,
          sequence,
          type,
          status,
          label: type === 'FAILED'
            ? `Nie udało się pobrać danych ${describeEvidenceToolLabel(tool).toLowerCase()}`
            : type === 'REQUESTING_EVIDENCE'
              ? `${describeEvidenceToolLabel(tool)}${request.time_range ? ` · ${formatTimeRangeLabel(request.time_range)}` : ''}`
              : type === 'ANALYZING_EVIDENCE'
                ? `Analizuję dane ${tool.includes('glucose') ? 'glukozy' : tool.includes('insulin') ? 'insuliny' : tool.includes('basal') ? 'bazy' : tool.includes('meal') ? 'posiłków' : tool.includes('activity') ? 'aktywności' : 'terapii'}`
                : detail ?? describeEvidenceToolLabel(tool),
          tool,
          timeRange: request.time_range ?? null,
          detail,
          startedAt: now,
          completedAt: status === 'SUCCEEDED' || status === 'FAILED' ? now : null,
        });
        if (options?.observer) {
          void options.observer.onStep(step);
        }
        return step;
      };

      if (!toolDefinition) {
        emit('REQUESTING_EVIDENCE', 'FAILED', 'Unsupported tool execution', request.tool);
        return buildSemanticResponse(
          request,
          'INVALID_REQUEST',
          { error: `Unsupported tool: ${String(request.tool)}` },
          { status: 'MISSING', range: request.time_range ?? null, covered_range: null, gaps: [] },
          [`Unsupported tool: ${String(request.tool)}`],
          [],
        );
      }

      emit('REQUESTING_EVIDENCE', 'STARTED', 'TARGETED_DETAIL', request.tool);
      const response = (() => {
        switch (request.tool) {
          case 'get_glucose_evidence':
            return getGlucoseEvidenceTool.execute(request, context);
          case 'get_insulin_evidence':
            return getInsulinEvidenceTool.execute(request, context);
          case 'get_basal_evidence':
            return getBasalEvidenceTool.execute(request, context);
          case 'get_meal_evidence':
            return getMealEvidenceTool.execute(request, context);
          case 'get_activity_evidence':
            return getActivityEvidenceTool.execute(request, context);
          case 'get_loop_evidence':
            return getLoopEvidenceTool.execute(request, context);
          case 'get_therapy_profile':
            return getTherapyProfileTool.execute(request, context);
          default:
            return buildSemanticResponse(request, 'FAILED', { error: 'Unreachable tool execution' }, { status: 'MISSING', range: request.time_range ?? null, covered_range: null, gaps: [] }, ['Unreachable tool execution'], []);
        }
      })();

      if (response.status === 'FAILED' || response.status === 'INVALID_REQUEST' || response.status === 'UNAUTHORIZED' || response.status === 'OUT_OF_RANGE' || response.status === 'BUDGET_EXCEEDED') {
        emit('FAILED', 'FAILED', response.limitations[0] ?? 'Tool execution failed', request.tool);
      } else {
        emit('ANALYZING_EVIDENCE', 'SUCCEEDED', 'TARGETED_DETAIL', request.tool);
      }

      return response;
    },
  };
}

export function buildInitialEvidenceView(input: InitialEvidenceViewInput): InitialEvidenceView {
  const registry = createEvidenceToolRegistry();

  return {
    evidence_view_version: 'initial-evidence-view.v1',
    initial_context_summary: {
      task_type: input.task_type,
      patient_id: input.patient_id,
      range: input.range ?? null,
      current_glucose: input.current_state?.current_glucose ?? null,
      trend: input.current_state?.trend ?? null,
      as_of: input.current_state?.as_of ?? null,
    },
    significant_glucose_events: (input.significant_glucose_events ?? []).map((event) => ({
      label: event.label ?? 'SIGNIFICANT_EVENT',
      start: event.start ?? null,
      end: event.end ?? null,
      minimum: event.minimum ?? null,
      maximum: event.maximum ?? null,
    })),
    known_treatment_events: (input.known_treatment_events ?? []).map((event) => ({
      kind: event.kind ?? 'UNKNOWN',
      occurred_at: event.occurred_at ?? null,
      amount: event.amount ?? null,
      unit: event.unit ?? 'U',
    })),
    tools_available: registry.tools,
    evidence_capability_summary: input.evidence_capability_summary ?? registry.tools.map((tool) => tool.name),
    instruction: 'Initial evidence is intentionally incomplete. initial evidence is intentionally incomplete. Additional patient-specific evidence is available through Evidence Tools. Missing initial evidence does not establish absence of the event, and the model should retrieve additional evidence when it may materially change the analysis.',
    provenance: {
      source: 'context-package.v1',
      ...input.provenance,
    },
  };
}

export function createEvidenceSession(args: {
  task: string;
  patient_id: string;
  initial_evidence_identity: string;
  available_tools: EvidenceToolName[];
  tool_calls: Array<{
    tool: EvidenceToolName;
    request_hash: string;
    result_status: EvidenceToolStatus;
    result_hash: string;
    compiler_version: string;
    result_size_tokens: number | null;
  }>;
  budget: {
    max_calls: number;
    total_budget_tokens: number;
  };
}): EvidenceSession {
  return {
    session_version: 'evidence-session.v1',
    task: args.task,
    patient_id: args.patient_id,
    initial_evidence_identity: args.initial_evidence_identity,
    available_tools: args.available_tools,
    tool_call_order: args.tool_calls.map((call) => call.tool),
    tool_calls: args.tool_calls,
    budget: {
      max_calls: args.budget.max_calls,
      total_budget_tokens: args.budget.total_budget_tokens,
      remaining_budget_tokens: Math.max(0, args.budget.total_budget_tokens - args.tool_calls.reduce((sum, call) => sum + (call.result_size_tokens ?? 0), 0)),
    },
  };
}

export default {
  EVIDENCE_TOOL_COMPILER_VERSION,
  EVIDENCE_TOOL_DEFAULT_MAX_RANGE_MS,
  buildInitialEvidenceView,
  createEvidenceSession,
  createEvidenceToolRegistry,
  evaluateEvidenceToolRequest,
  getGlucoseEvidenceTool,
  getInsulinEvidenceTool,
  getBasalEvidenceTool,
  getMealEvidenceTool,
  getActivityEvidenceTool,
  getLoopEvidenceTool,
  getTherapyProfileTool,
};
