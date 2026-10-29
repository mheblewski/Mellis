import { createHash } from 'crypto';
import { canonicalJson } from '@shared/utils/canonical-json';
import {
  CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE,
  type ContextPackageUsage,
  type TimeRangeAnalysisContextRecord,
} from '@modules/ai-gateway/domain/ai-gateway';
import {
  buildDailyAnalyticalSummaryV1,
  buildGlucoseSemanticSummaryV1,
  type DailyAnalyticalSummaryV1,
  type GlucoseSemanticSummaryV1,
} from './evidence-summary-design-contract';
import {
  EnvironmentContextPackageBudgetPolicySource,
  type ContextPackageBudgetPolicySourceEnvironment,
} from './context-package-budget-policy-source';

// Shadow-only L1 candidate for TODAY analysis. Nothing in this module is sent to the provider.
export const TODAY_COMPACT_EVIDENCE_VIEW_VERSION = 'today-compact-evidence-view.v1' as const;
export const TODAY_COMPACT_EVIDENCE_VIEW_POLICY_VERSION = 'today-compact-evidence-view-policy.v1' as const;
export const TODAY_COMPACT_EVIDENCE_SHADOW_VERSION = 'today-compact-evidence-shadow.v1' as const;
export const MAX_LISTED_REFS_PER_GROUP = 32;

export type CompactRefsStatus = 'COMPLETE' | 'EMPTY' | 'OMITTED_DUE_TO_BUDGET';

export interface CompactReferenceGroup {
  source_section: string;
  total_count: number;
  listed_ref_count: number;
  refs_status: CompactRefsStatus;
  ref_set_digest: string | null;
}

export interface CompactInsulinTypeGroup extends CompactReferenceGroup {
  event_type: string;
}

export interface TodayCompactEvidenceViewV1 {
  view_version: typeof TODAY_COMPACT_EVIDENCE_VIEW_VERSION;
  policy: {
    view_policy_version: typeof TODAY_COMPACT_EVIDENCE_VIEW_POLICY_VERSION;
    daily_analytical_summary_version: DailyAnalyticalSummaryV1['model_version'];
    glucose_semantic_summary_version: GlucoseSemanticSummaryV1['model_version'];
    selection_policy_version: string;
    max_listed_refs_per_group: number;
    serialization: 'canonical-json';
  };
  source_context: {
    context_package_id: string;
    context_package_version: string;
    content_hash: string;
  };
  patient_ref: {
    patient_id: string;
  };
  scope: {
    evidence_channel: 'CURRENT_RANGE';
    range_type: string;
    timezone: string;
    range_start: string;
    range_end: string;
    requested_at: string;
  };
  daily_summary: DailyAnalyticalSummaryV1;
  glucose_evidence_status: GlucoseSemanticSummaryV1['evidence_status'];
  current_state_iob: number | 'UNKNOWN' | null;
  summary_consistency: {
    status: 'CONSISTENT' | 'MISMATCH';
    mismatched_fields: string[];
  };
  references: {
    glucose_events: CompactReferenceGroup;
    insulin_treatment_events: CompactReferenceGroup & { by_type: CompactInsulinTypeGroup[] };
    meal_events: CompactReferenceGroup & { refs: string[] };
    activity_events: CompactReferenceGroup;
    hypo_episodes: CompactReferenceGroup;
    range_event_facts: CompactReferenceGroup & { refs: string[] };
  };
  significant_periods: {
    status: 'UNAVAILABLE';
    reason: 'L2_CANDIDATE_ASSEMBLY_NOT_IN_TODAY_RUNTIME';
  };
  historical_evidence: {
    evidence_channel: 'HISTORICAL';
    status: 'NOT_SELECTED' | 'MISSING';
    reason: string;
  };
  semantics: {
    omitted_refs_are_not_absence: true;
    empty_section_is_not_proof_of_absence: true;
    current_state_is_point_in_time_snapshot: true;
  };
  provenance: {
    source_section: 'provenance.source_refs';
    source_ref_count: number;
    source_ref_set_digest: string | null;
  };
}

export class CompactEvidenceViewPatientMismatchError extends Error {
  constructor() {
    super('COMPACT_EVIDENCE_VIEW_PATIENT_MISMATCH');
    this.name = 'CompactEvidenceViewPatientMismatchError';
  }
}

export function buildTodayCompactEvidenceViewV1(input: {
  context: TimeRangeAnalysisContextRecord;
  expected_patient_id: string;
}): TodayCompactEvidenceViewV1 {
  const { context } = input;
  const patientId = context.patient_ref?.patient_id;
  if (!patientId || patientId !== input.expected_patient_id) {
    throw new CompactEvidenceViewPatientMismatchError();
  }

  const evidence = context.analytical_evidence;
  const timeRange = {
    start_at: context.analysis_request_input.range_start,
    end_at: context.analysis_request_input.range_end,
  };

  const glucoseRefs = evidence.glucose_events.map(readEventRef);
  const insulinRefs = evidence.insulin_treatment_events.map(readEventRef);
  const mealRefs = evidence.meal_events.map(readEventRef);
  const activityRefs = evidence.activity_events.map(readEventRef);
  const hypoRefs = evidence.hypo_episodes.map((episode) => readStringField(episode, 'episode_id'));
  const factRefs = evidence.range_event_facts.map((fact) => readStringField(fact, 'fact_id'));

  const glucoseGroup = buildReferenceGroup('analytical_evidence.glucose_events', glucoseRefs);
  const insulinGroup = buildReferenceGroup('analytical_evidence.insulin_treatment_events', insulinRefs);
  const insulinByType = buildInsulinTypeGroups(evidence.insulin_treatment_events);
  const mealGroup = buildReferenceGroup('analytical_evidence.meal_events', mealRefs);
  const activityGroup = buildReferenceGroup('analytical_evidence.activity_events', activityRefs);
  const hypoGroup = buildReferenceGroup('analytical_evidence.hypo_episodes', hypoRefs);
  const factGroup = buildReferenceGroup('analytical_evidence.range_event_facts', factRefs);

  const listedInsulinRefs = insulinByType
    .filter((group) => group.refs_status === 'COMPLETE')
    .flatMap((group) => sortedUniqueRefs(
      evidence.insulin_treatment_events
        .filter((event) => readStringField(event, 'type') === group.event_type)
        .map(readEventRef),
    ));

  const glucoseSemantic = buildGlucoseSemanticSummaryV1({
    time_range: timeRange,
    glucose_events: evidence.glucose_events.map(toGlucoseSemanticInput),
    hypo_episode_refs: hypoGroup.refs_status === 'COMPLETE' ? sortedUniqueRefs(hypoRefs) : [],
    derivation_policy_version: TODAY_COMPACT_EVIDENCE_VIEW_POLICY_VERSION,
    selection_policy_version: context.provenance.selection_policy_version,
    evidence_status: {
      glucose_data: evidence.glucose_events.length > 0 ? 'KNOWN' : 'MISSING',
      known_hypo_episodes: 'KNOWN',
      // TODAY runtime does not evaluate evidence exclusions, so their presence is unknown.
      excluded_evidence: 'UNKNOWN',
    },
  });

  const snapshot = context.current_state_snapshot ?? null;
  const dailySummary = buildDailyAnalyticalSummaryV1({
    time_range: timeRange,
    glucose_summary: glucoseSemantic.glucose_summary,
    insulin_treatment_count: evidence.insulin_treatment_events.length,
    insulin_event_refs: listedInsulinRefs,
    meal_count: evidence.meal_events.length,
    // TODAY context carries CARB_ENTRY events, not meal cases; meal event refs live in references.meal_events.
    meal_case_refs: [],
    carbohydrate_total: null,
    hypo_episode_count: evidence.hypo_episodes.length,
    episode_refs: hypoGroup.refs_status === 'COMPLETE' ? sortedUniqueRefs(hypoRefs) : [],
    current_state: snapshot
      ? {
          current_glucose: snapshot.current_glucose,
          trend: snapshot.trend,
          as_of: snapshot.as_of ?? null,
        }
      : null,
    missing_sections: [...(evidence.summaries.missing_sections ?? [])].sort(),
    excluded_sections: [],
    significant_period_refs: [],
    source_refs: [`context_package:${context.context_package_id}`],
    derivation_policy_version: TODAY_COMPACT_EVIDENCE_VIEW_POLICY_VERSION,
    selection_policy_version: context.provenance.selection_policy_version,
  });

  const sourceRefs = sortedUniqueRefs(context.provenance.source_refs ?? []);
  const hasHistoricalEvidence = context.historical_evidence !== null && context.historical_evidence !== undefined;

  return {
    view_version: TODAY_COMPACT_EVIDENCE_VIEW_VERSION,
    policy: {
      view_policy_version: TODAY_COMPACT_EVIDENCE_VIEW_POLICY_VERSION,
      daily_analytical_summary_version: dailySummary.model_version,
      glucose_semantic_summary_version: glucoseSemantic.model_version,
      selection_policy_version: context.provenance.selection_policy_version,
      max_listed_refs_per_group: MAX_LISTED_REFS_PER_GROUP,
      serialization: 'canonical-json',
    },
    source_context: {
      context_package_id: context.context_package_id,
      context_package_version: context.context_package_version,
      content_hash: context.content_hash,
    },
    patient_ref: { patient_id: patientId },
    scope: {
      evidence_channel: 'CURRENT_RANGE',
      range_type: context.analysis_request_input.range_type,
      timezone: context.analysis_request_input.timezone,
      range_start: context.analysis_request_input.range_start,
      range_end: context.analysis_request_input.range_end,
      requested_at: context.analysis_request_input.requested_at,
    },
    daily_summary: dailySummary,
    glucose_evidence_status: glucoseSemantic.evidence_status,
    current_state_iob: snapshot ? snapshot.iob : null,
    summary_consistency: checkSummaryConsistency(context, glucoseSemantic),
    references: {
      glucose_events: glucoseGroup,
      insulin_treatment_events: { ...insulinGroup, by_type: insulinByType },
      meal_events: { ...mealGroup, refs: mealGroup.refs_status === 'COMPLETE' ? sortedUniqueRefs(mealRefs) : [] },
      activity_events: activityGroup,
      hypo_episodes: hypoGroup,
      range_event_facts: { ...factGroup, refs: factGroup.refs_status === 'COMPLETE' ? sortedUniqueRefs(factRefs) : [] },
    },
    significant_periods: {
      status: 'UNAVAILABLE',
      reason: 'L2_CANDIDATE_ASSEMBLY_NOT_IN_TODAY_RUNTIME',
    },
    historical_evidence: hasHistoricalEvidence
      ? { evidence_channel: 'HISTORICAL', status: 'NOT_SELECTED', reason: 'L1_CURRENT_RANGE_VIEW_EXCLUDES_HISTORICAL_CHANNEL' }
      : { evidence_channel: 'HISTORICAL', status: 'MISSING', reason: 'NO_HISTORICAL_EVIDENCE_IN_CONTEXT' },
    semantics: {
      omitted_refs_are_not_absence: true,
      empty_section_is_not_proof_of_absence: true,
      current_state_is_point_in_time_snapshot: true,
    },
    provenance: {
      source_section: 'provenance.source_refs',
      source_ref_count: sourceRefs.length,
      source_ref_set_digest: digestRefs(sourceRefs),
    },
  };
}

export function serializeTodayCompactEvidenceView(view: TodayCompactEvidenceViewV1): string {
  return canonicalJson(view);
}

export interface CompactSizeComparison {
  baseline: 'FULL_AI_BOUND_CONTEXT' | 'FULL_ANALYTICAL_EVIDENCE' | 'PRODUCTION_USER_PAYLOAD';
  baseline_bytes: number;
  compact_bytes: number;
  delta_bytes: number;
  reduction_pct: number;
}

export interface TodayCompactEvidenceShadowMeasurement {
  shadow_version: typeof TODAY_COMPACT_EVIDENCE_SHADOW_VERSION;
  status: 'MEASURED' | 'FAILED';
  sent_to_provider: false;
  view_version: typeof TODAY_COMPACT_EVIDENCE_VIEW_VERSION;
  policy_versions: {
    view_policy_version: string;
    daily_analytical_summary_version: string;
    glucose_semantic_summary_version: string;
    selection_policy_version: string | null;
  };
  context_package_id: string | null;
  context_package_hash: string | null;
  range_type: string | null;
  compact_view_hash: string | null;
  bytes: {
    basis: 'UTF8_BYTES';
    compact_view: number | null;
    full_ai_bound_context: number | null;
    full_analytical_evidence: number | null;
    production_user_payload: number | null;
    provider_serialized_input_last_call: number | null;
  };
  comparisons: CompactSizeComparison[];
  tokens: {
    provider_input_tokens_last_call: number | null;
    provider_input_tokens_kind: 'AUTHORITATIVE_PROVIDER_USAGE' | 'UNAVAILABLE';
    compact_view_tokens: null;
    compact_view_tokens_kind: 'UNAVAILABLE_NO_LOCAL_TOKENIZER';
  };
  included_sections: string[];
  included_facts: {
    glucose_count: number;
    usable_glucose_count: number;
    insulin_treatment_count: number;
    meal_count: number;
    hypo_episode_count: number;
    listed_ref_count: number;
    omitted_due_to_budget_ref_count: number;
  } | null;
  summary_consistency_status: 'CONSISTENT' | 'MISMATCH' | null;
  telemetry_bounded: true;
  failed_reason?: string;
}

export function measureTodayCompactEvidenceShadow(input: {
  context: TimeRangeAnalysisContextRecord;
  expected_patient_id: string;
  production_user_payload?: string | null;
  provider_serialized_input_bytes?: number | null;
  provider_input_tokens?: number | null;
}): TodayCompactEvidenceShadowMeasurement {
  const providerTokens = finiteOrNull(input.provider_input_tokens);
  const tokens: TodayCompactEvidenceShadowMeasurement['tokens'] = {
    provider_input_tokens_last_call: providerTokens,
    provider_input_tokens_kind: providerTokens !== null ? 'AUTHORITATIVE_PROVIDER_USAGE' : 'UNAVAILABLE',
    compact_view_tokens: null,
    compact_view_tokens_kind: 'UNAVAILABLE_NO_LOCAL_TOKENIZER',
  };

  try {
    const view = buildTodayCompactEvidenceViewV1({
      context: input.context,
      expected_patient_id: input.expected_patient_id,
    });
    const serializedView = serializeTodayCompactEvidenceView(view);
    const compactBytes = Buffer.byteLength(serializedView, 'utf8');
    const fullContextBytes = Buffer.byteLength(canonicalJson(input.context), 'utf8');
    const fullEvidenceBytes = Buffer.byteLength(canonicalJson(input.context.analytical_evidence), 'utf8');
    const productionPayloadBytes = typeof input.production_user_payload === 'string'
      ? Buffer.byteLength(input.production_user_payload, 'utf8')
      : null;

    const comparisons: CompactSizeComparison[] = [
      compareSize('FULL_AI_BOUND_CONTEXT', fullContextBytes, compactBytes),
      compareSize('FULL_ANALYTICAL_EVIDENCE', fullEvidenceBytes, compactBytes),
    ];
    if (productionPayloadBytes !== null) {
      comparisons.push(compareSize('PRODUCTION_USER_PAYLOAD', productionPayloadBytes, compactBytes));
    }

    const groups = [
      view.references.glucose_events,
      ...view.references.insulin_treatment_events.by_type,
      view.references.meal_events,
      view.references.activity_events,
      view.references.hypo_episodes,
      view.references.range_event_facts,
    ];

    return {
      shadow_version: TODAY_COMPACT_EVIDENCE_SHADOW_VERSION,
      status: 'MEASURED',
      sent_to_provider: false,
      view_version: TODAY_COMPACT_EVIDENCE_VIEW_VERSION,
      policy_versions: {
        view_policy_version: view.policy.view_policy_version,
        daily_analytical_summary_version: view.policy.daily_analytical_summary_version,
        glucose_semantic_summary_version: view.policy.glucose_semantic_summary_version,
        selection_policy_version: view.policy.selection_policy_version,
      },
      context_package_id: input.context.context_package_id,
      context_package_hash: input.context.content_hash,
      range_type: input.context.analysis_request_input.range_type,
      compact_view_hash: `sha256:${createHash('sha256').update(serializedView).digest('hex')}`,
      bytes: {
        basis: 'UTF8_BYTES',
        compact_view: compactBytes,
        full_ai_bound_context: fullContextBytes,
        full_analytical_evidence: fullEvidenceBytes,
        production_user_payload: productionPayloadBytes,
        provider_serialized_input_last_call: finiteOrNull(input.provider_serialized_input_bytes),
      },
      comparisons,
      tokens,
      included_sections: Object.keys(view).sort(),
      included_facts: {
        glucose_count: view.daily_summary.glucose.glucose_count,
        usable_glucose_count: view.daily_summary.glucose.usable_glucose_count,
        insulin_treatment_count: view.daily_summary.insulin.insulin_treatment_count,
        meal_count: view.daily_summary.meals.meal_count,
        hypo_episode_count: view.daily_summary.hypo.hypo_episode_count,
        listed_ref_count: groups.reduce((sum, group) => sum + group.listed_ref_count, 0),
        omitted_due_to_budget_ref_count: groups
          .filter((group) => group.refs_status === 'OMITTED_DUE_TO_BUDGET')
          .reduce((sum, group) => sum + group.total_count, 0),
      },
      summary_consistency_status: view.summary_consistency.status,
      telemetry_bounded: true,
    };
  } catch (error) {
    return {
      shadow_version: TODAY_COMPACT_EVIDENCE_SHADOW_VERSION,
      status: 'FAILED',
      sent_to_provider: false,
      view_version: TODAY_COMPACT_EVIDENCE_VIEW_VERSION,
      policy_versions: {
        view_policy_version: TODAY_COMPACT_EVIDENCE_VIEW_POLICY_VERSION,
        daily_analytical_summary_version: 'daily-analytical-summary.v1',
        glucose_semantic_summary_version: 'glucose-semantic-summary.v1',
        selection_policy_version: null,
      },
      context_package_id: typeof input.context?.context_package_id === 'string' ? input.context.context_package_id : null,
      context_package_hash: typeof input.context?.content_hash === 'string' ? input.context.content_hash : null,
      range_type: null,
      compact_view_hash: null,
      bytes: {
        basis: 'UTF8_BYTES',
        compact_view: null,
        full_ai_bound_context: null,
        full_analytical_evidence: null,
        production_user_payload: null,
        provider_serialized_input_last_call: null,
      },
      comparisons: [],
      tokens,
      included_sections: [],
      included_facts: null,
      summary_consistency_status: null,
      telemetry_bounded: true,
      failed_reason: (error instanceof Error ? error.message : String(error)).slice(0, 256),
    };
  }
}

/**
 * Runtime entry point used by the AI Gateway. Returns null when the task is not a TODAY
 * time-range analysis or when the context budget mode is `off`. Never throws.
 */
export function evaluateTodayCompactEvidenceShadow(input: {
  task_type: string;
  task_patient_id: string | null | undefined;
  context: unknown;
  env: ContextPackageBudgetPolicySourceEnvironment;
  production_user_payload: string | null;
  provider_serialized_input_bytes: number | null | undefined;
  provider_input_tokens: number | null | undefined;
}): TodayCompactEvidenceShadowMeasurement | null {
  if (input.task_type !== CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE) {
    return null;
  }

  const context = input.context as TimeRangeAnalysisContextRecord;
  if (context?.analysis_request_input?.range_type !== 'TODAY') {
    return null;
  }

  try {
    if (new EnvironmentContextPackageBudgetPolicySource(input.env).resolve().mode === 'off') {
      return null;
    }
  } catch {
    return null;
  }

  return measureTodayCompactEvidenceShadow({
    context,
    expected_patient_id: input.task_patient_id ?? '',
    production_user_payload: input.production_user_payload,
    provider_serialized_input_bytes: input.provider_serialized_input_bytes,
    provider_input_tokens: input.provider_input_tokens,
  });
}

export function attachCompactEvidenceShadowToUsage(args: {
  usage: ContextPackageUsage;
  measurement: TodayCompactEvidenceShadowMeasurement | null;
}): ContextPackageUsage {
  if (!args.measurement) {
    return args.usage;
  }

  return {
    ...args.usage,
    compact_evidence_shadow: args.measurement as unknown as Record<string, unknown>,
  };
}

function readStringField(record: Record<string, unknown>, field: string): string {
  const value = record?.[field];
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function readEventRef(event: Record<string, unknown>): string {
  return readStringField(event, 'event_id');
}

function sortedUniqueRefs(refs: readonly string[]): string[] {
  return Array.from(new Set(refs.filter((ref) => ref.length > 0))).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function digestRefs(refs: readonly string[]): string | null {
  const normalized = sortedUniqueRefs(refs);
  if (normalized.length === 0) {
    return null;
  }

  return `sha256:${createHash('sha256').update(canonicalJson(normalized)).digest('hex')}`;
}

function buildReferenceGroup(sourceSection: string, refs: readonly string[]): CompactReferenceGroup {
  const normalized = sortedUniqueRefs(refs);
  const totalCount = refs.length;
  const refsStatus: CompactRefsStatus = totalCount === 0
    ? 'EMPTY'
    : normalized.length <= MAX_LISTED_REFS_PER_GROUP
      ? 'COMPLETE'
      : 'OMITTED_DUE_TO_BUDGET';

  return {
    source_section: sourceSection,
    total_count: totalCount,
    listed_ref_count: refsStatus === 'COMPLETE' ? normalized.length : 0,
    refs_status: refsStatus,
    ref_set_digest: digestRefs(normalized),
  };
}

function buildInsulinTypeGroups(events: Array<Record<string, unknown>>): CompactInsulinTypeGroup[] {
  const refsByType = new Map<string, string[]>();
  for (const event of events) {
    const eventType = readStringField(event, 'type') || 'UNKNOWN';
    const refs = refsByType.get(eventType) ?? [];
    refs.push(readEventRef(event));
    refsByType.set(eventType, refs);
  }

  return Array.from(refsByType.keys())
    .sort()
    .map((eventType) => ({
      event_type: eventType,
      ...buildReferenceGroup('analytical_evidence.insulin_treatment_events', refsByType.get(eventType) ?? []),
    }));
}

// Mirrors the worker's numeric glucose extraction so derived min/max/avg stay identical.
function toGlucoseSemanticInput(event: Record<string, unknown>): {
  event_id: string;
  source_record_id: string | null;
  validity: string | null;
  glucose_value: number | string;
} {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const rawPayload = (payload.raw_payload ?? {}) as Record<string, unknown>;
  const candidate = [payload.glucose_value, payload.glucose, rawPayload.sgv]
    .find((value) => typeof value === 'number');
  const numeric = typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
  const declared = typeof payload.glucose_value === 'string' ? payload.glucose_value.trim().toUpperCase() : null;

  return {
    event_id: readEventRef(event),
    source_record_id: typeof event.source_record_id === 'string' ? event.source_record_id : null,
    validity: typeof payload.validity === 'string' ? payload.validity : null,
    // A glucose event without a usable numeric value has an unknown value; it is never treated as absent.
    glucose_value: numeric ?? (declared === 'MISSING' ? 'MISSING' : 'UNKNOWN'),
  };
}

function checkSummaryConsistency(
  context: TimeRangeAnalysisContextRecord,
  glucoseSemantic: GlucoseSemanticSummaryV1,
): TodayCompactEvidenceViewV1['summary_consistency'] {
  const evidence = context.analytical_evidence;
  const summaries = evidence.summaries;
  const checks: Array<[string, unknown, unknown]> = [
    ['glucose_count', summaries.glucose_count, evidence.glucose_events.length],
    ['glucose_min', summaries.glucose_min, glucoseSemantic.glucose_summary.glucose_min],
    ['glucose_max', summaries.glucose_max, glucoseSemantic.glucose_summary.glucose_max],
    ['glucose_avg', summaries.glucose_avg, glucoseSemantic.glucose_summary.glucose_avg],
    ['insulin_treatment_count', summaries.insulin_treatment_count, evidence.insulin_treatment_events.length],
    ['meal_count', summaries.meal_count, evidence.meal_events.length],
    ['activity_count', summaries.activity_count, evidence.activity_events.length],
    ['hypo_episode_count', summaries.hypo_episode_count, evidence.hypo_episodes.length],
  ];
  const mismatched = checks.filter(([, expected, actual]) => expected !== actual).map(([field]) => field);

  return {
    status: mismatched.length === 0 ? 'CONSISTENT' : 'MISMATCH',
    mismatched_fields: mismatched,
  };
}

function compareSize(
  baseline: CompactSizeComparison['baseline'],
  baselineBytes: number,
  compactBytes: number,
): CompactSizeComparison {
  const delta = baselineBytes - compactBytes;
  return {
    baseline,
    baseline_bytes: baselineBytes,
    compact_bytes: compactBytes,
    delta_bytes: delta,
    reduction_pct: baselineBytes > 0 ? Number(((delta / baselineBytes) * 100).toFixed(4)) : 0,
  };
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
