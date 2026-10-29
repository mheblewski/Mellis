import { createHash } from 'node:crypto';
import {
  CONVERSATION_DIRECT_RESPONSE_TASK_TYPE,
  CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE,
  type AiContextPackage,
  type AiTask,
  type DirectResponseContextRecord,
  type TimeRangeAnalysisContextRecord,
} from '@modules/ai-gateway/domain/ai-gateway';
import type { ContextPackageRecord } from '@modules/context/domain/context-package';
import {
  EVIDENCE_FAMILY_DEFINITIONS,
  type EvidenceFamily,
  type EvidenceSelectionBundle,
  type SelectionState,
} from './evidence-selection-policy';
import {
  evaluateEvidenceSelectionShadowSafe,
  type EvidenceSelectionShadowResult,
} from './evidence-selection-shadow';
import { canonicalJson } from '@shared/utils/canonical-json';

export const COMPACT_DELIVERY_ARTIFACT_VERSION = 'compact-delivery-artifact.v1' as const;

const MAX_FAMILY_REFS = 256;

type ContextLike = AiContextPackage;

type OmissionReasonCode =
  | 'NOT_SELECTED'
  | 'EXCLUDED'
  | 'MISSING'
  | 'UNKNOWN'
  | 'UNRESOLVED_RELATIONSHIP'
  | 'UNAVAILABLE'
  | 'UNSELECTED_BY_POLICY';

export interface CompactFamilyDecision {
  family: EvidenceFamily;
  represented: boolean;
  selected: boolean;
  semantic_state: SelectionState | 'UNAVAILABLE';
  omission_reason_code: OmissionReasonCode | null;
  omission_reason: string | null;
  represented_by_selected_summary: boolean;
  retrievable_via_escalation: boolean;
  policy_allows_omission: boolean;
}

export interface CompactSelectedFamilyPayload {
  family: EvidenceFamily;
  semantic_purpose: string;
  evidence_kind: 'SUMMARY' | 'REFERENCE' | 'TARGETED_DETAIL' | 'PROVENANCE' | 'CONTEXT' | 'STATE';
  ref_count: number;
  refs: string[];
  payload: Record<string, unknown>;
}

export interface CompactDeliveryArtifactV1 {
  artifact_version: typeof COMPACT_DELIVERY_ARTIFACT_VERSION;
  task_identity: string;
  execution_identity: {
    task_id: string;
    task_type: string;
    task_version: string;
    prompt_version: string;
    output_schema_version: string;
    model_policy_version: string;
    correlation_id: string;
    patient_id: string | null;
    trigger_id: string | null;
    analysis_id: string | null;
    created_at: string;
  };
  context_package: {
    id: string;
    version: string;
    hash: string;
  };
  policy: {
    task_evidence_policy_version: string;
    evidence_selection_policy_version: string;
    evidence_relationship_semantics_version: string;
    selection_profile: string;
    selected_level: string;
    default_level: string;
    status: string;
  };
  selected_families: EvidenceFamily[];
  selected_payloads: CompactSelectedFamilyPayload[];
  selected_evidence_refs: string[];
  omitted_families: Array<{
    family: EvidenceFamily;
    reason_code: OmissionReasonCode;
    reason: string;
  }>;
  family_decisions: CompactFamilyDecision[];
  relationship_decisions: Array<{ relationship: string; status: string }>;
  unresolved_reasons: string[];
  unknown_states: string[];
  missing_states: string[];
  excluded_states: string[];
  not_selected_states: string[];
  omitted_evidence_refs: string[];
  provenance: {
    refs: string[];
    count: number;
    bytes: number;
    deterministic_ordering_key: string;
  };
  deterministic_replay_metadata: {
    artifact_version: typeof COMPACT_DELIVERY_ARTIFACT_VERSION;
    source_context_package_hash: string;
    source_context_package_version: string;
    source_task_identity: string;
    selection_material_hash: string;
    input_material_hash: string;
    policy_versions: {
      task_evidence_policy_version: string;
      evidence_selection_policy_version: string;
      evidence_relationship_semantics_version: string;
    };
  };
  artifact_content_hash: string;
  artifact_bytes: number;
}

export function buildCompactDeliveryArtifact(args: {
  contextPackage: ContextLike;
  task: AiTask;
  shadowSelection?: EvidenceSelectionShadowResult;
  policy?: EvidenceSelectionBundle;
}): CompactDeliveryArtifactV1 {
  const shadow = args.shadowSelection ?? evaluateEvidenceSelectionShadowSafe({
    task: args.task,
    context_package: args.contextPackage,
  });

  const familyRefs = buildFamilyRefMap(args.contextPackage);
  const selectedFamilies = [...new Set(shadow.selected_evidence_families)] as EvidenceFamily[];
  const selectedSet = new Set(selectedFamilies);

  const allFamilies = Object.keys(EVIDENCE_FAMILY_DEFINITIONS) as EvidenceFamily[];
  const stateMap = buildFamilyStateMap(shadow);

  const selectedPayloads = selectedFamilies
    .map((family) => buildSelectedFamilyPayload(args.contextPackage, family, familyRefs[family]?.refs ?? []))
    .sort((left, right) => left.family.localeCompare(right.family));

  const selectedEvidenceRefs = uniqueStable(
    selectedFamilies.flatMap((family) => familyRefs[family]?.refs ?? []),
  );

  const omittedRefs = uniqueStable(
    allFamilies
      .filter((family) => !selectedSet.has(family))
      .flatMap((family) => familyRefs[family]?.refs ?? []),
  );

  const familyDecisions = allFamilies
    .map((family) => buildFamilyDecision({
      family,
      represented: (familyRefs[family]?.count ?? 0) > 0,
      selected: selectedSet.has(family),
      state: stateMap[family] ?? null,
      hasUnresolvedRelationship: shadow.unresolved_reasons.length > 0,
    }))
    .sort((left, right) => left.family.localeCompare(right.family));

  const omittedFamilies = familyDecisions
    .filter((decision) => !decision.selected)
    .filter((decision) => decision.omission_reason_code !== null)
    .map((decision) => ({
      family: decision.family,
      reason_code: decision.omission_reason_code as OmissionReasonCode,
      reason: decision.omission_reason as string,
    }));

  const provenanceRefs = uniqueStable([
    ...(familyRefs.PROVENANCE?.refs ?? []),
    ...shadow.provenance_refs_sample,
  ]);

  const deterministicOrderingKey = buildStableHash({
    task_identity: shadow.task_identity,
    context_package_hash: shadow.context_package_hash,
    selected_families: selectedFamilies,
    selected_refs: selectedEvidenceRefs,
    omitted_families: omittedFamilies,
    provenance_refs: provenanceRefs,
  });

  const artifactWithoutHash = {
    artifact_version: COMPACT_DELIVERY_ARTIFACT_VERSION,
    task_identity: shadow.task_identity,
    execution_identity: {
      task_id: args.task.task_id,
      task_type: args.task.task_type,
      task_version: args.task.task_version,
      prompt_version: args.task.prompt_version,
      output_schema_version: args.task.output_schema_version,
      model_policy_version: args.task.model_policy_version,
      correlation_id: args.task.correlation_id,
      patient_id: args.task.patient_id ?? null,
      trigger_id: args.task.trigger_id ?? null,
      analysis_id: args.task.analysis_id ?? null,
      created_at: args.task.created_at,
    },
    context_package: {
      id: shadow.context_package_id,
      version: shadow.context_package_version,
      hash: shadow.context_package_hash,
    },
    policy: {
      task_evidence_policy_version: shadow.task_evidence_policy_version,
      evidence_selection_policy_version: shadow.evidence_selection_policy_version,
      evidence_relationship_semantics_version: shadow.evidence_relationship_semantics_version,
      selection_profile: shadow.selection_profile,
      selected_level: shadow.selected_level,
      default_level: shadow.default_level,
      status: shadow.status,
    },
    selected_families: selectedFamilies,
    selected_payloads: selectedPayloads,
    selected_evidence_refs: selectedEvidenceRefs,
    omitted_families: omittedFamilies,
    family_decisions: familyDecisions,
    relationship_decisions: shadow.relationship_decisions,
    unresolved_reasons: shadow.unresolved_reasons,
    unknown_states: shadow.unknowns,
    missing_states: shadow.missing,
    excluded_states: shadow.excluded,
    not_selected_states: shadow.not_selected,
    omitted_evidence_refs: omittedRefs,
    provenance: {
      refs: provenanceRefs,
      count: provenanceRefs.length,
      bytes: Buffer.byteLength(canonicalJson(provenanceRefs), 'utf8'),
      deterministic_ordering_key: deterministicOrderingKey,
    },
    deterministic_replay_metadata: {
      artifact_version: COMPACT_DELIVERY_ARTIFACT_VERSION,
      source_context_package_hash: shadow.context_package_hash,
      source_context_package_version: shadow.context_package_version,
      source_task_identity: shadow.task_identity,
      selection_material_hash: shadow.selection_material_hash,
      input_material_hash: shadow.input_material_hash,
      policy_versions: {
        task_evidence_policy_version: shadow.task_evidence_policy_version,
        evidence_selection_policy_version: shadow.evidence_selection_policy_version,
        evidence_relationship_semantics_version: shadow.evidence_relationship_semantics_version,
      },
    },
  } satisfies Omit<CompactDeliveryArtifactV1, 'artifact_content_hash' | 'artifact_bytes'>;

  const artifactContentHash = buildStableHash(artifactWithoutHash);
  const artifact: CompactDeliveryArtifactV1 = {
    ...artifactWithoutHash,
    artifact_content_hash: artifactContentHash,
    artifact_bytes: Buffer.byteLength(canonicalJson({ ...artifactWithoutHash, artifact_content_hash: artifactContentHash }), 'utf8'),
  };

  return artifact;
}

function buildFamilyDecision(args: {
  family: EvidenceFamily;
  represented: boolean;
  selected: boolean;
  state: SelectionState | null;
  hasUnresolvedRelationship: boolean;
}): CompactFamilyDecision {
  if (args.selected) {
    return {
      family: args.family,
      represented: args.represented,
      selected: true,
      semantic_state: args.state ?? 'AVAILABLE',
      omission_reason_code: null,
      omission_reason: null,
      represented_by_selected_summary: true,
      retrievable_via_escalation: false,
      policy_allows_omission: true,
    };
  }

  if (!args.represented) {
    return {
      family: args.family,
      represented: false,
      selected: false,
      semantic_state: 'UNAVAILABLE',
      omission_reason_code: 'UNAVAILABLE',
      omission_reason: 'Family has no authoritative evidence in the source context package.',
      represented_by_selected_summary: false,
      retrievable_via_escalation: false,
      policy_allows_omission: true,
    };
  }

  const state = args.state;
  if (state === 'EXCLUDED') {
    return {
      family: args.family,
      represented: true,
      selected: false,
      semantic_state: 'EXCLUDED',
      omission_reason_code: 'EXCLUDED',
      omission_reason: 'Family was explicitly excluded by authoritative eligibility semantics.',
      represented_by_selected_summary: false,
      retrievable_via_escalation: false,
      policy_allows_omission: true,
    };
  }

  if (state === 'MISSING') {
    return {
      family: args.family,
      represented: true,
      selected: false,
      semantic_state: 'MISSING',
      omission_reason_code: 'MISSING',
      omission_reason: 'Expected family evidence is missing from source evidence.',
      represented_by_selected_summary: false,
      retrievable_via_escalation: false,
      policy_allows_omission: true,
    };
  }

  if (state === 'UNKNOWN') {
    return {
      family: args.family,
      represented: true,
      selected: false,
      semantic_state: 'UNKNOWN',
      omission_reason_code: 'UNKNOWN',
      omission_reason: 'Family state is unknown and cannot be safely collapsed into no-event.',
      represented_by_selected_summary: false,
      retrievable_via_escalation: false,
      policy_allows_omission: true,
    };
  }

  if (state === 'NOT_SELECTED') {
    return {
      family: args.family,
      represented: true,
      selected: false,
      semantic_state: 'NOT_SELECTED',
      omission_reason_code: 'NOT_SELECTED',
      omission_reason: 'Family is present but intentionally not selected by the current task policy level.',
      represented_by_selected_summary: true,
      retrievable_via_escalation: true,
      policy_allows_omission: true,
    };
  }

  if (args.hasUnresolvedRelationship || state === 'UNRESOLVED' || state === 'PARTIAL') {
    return {
      family: args.family,
      represented: true,
      selected: false,
      semantic_state: state ?? 'UNRESOLVED',
      omission_reason_code: 'UNRESOLVED_RELATIONSHIP',
      omission_reason: 'Family omission is tied to unresolved or partial relationship semantics.',
      represented_by_selected_summary: false,
      retrievable_via_escalation: false,
      policy_allows_omission: true,
    };
  }

  return {
    family: args.family,
    represented: true,
    selected: false,
    semantic_state: state ?? 'AVAILABLE',
    omission_reason_code: 'UNSELECTED_BY_POLICY',
    omission_reason: 'Family is present but omitted by deterministic policy for the selected delivery level.',
    represented_by_selected_summary: true,
    retrievable_via_escalation: true,
    policy_allows_omission: true,
  };
}

function buildSelectedFamilyPayload(
  contextPackage: ContextLike,
  family: EvidenceFamily,
  refs: string[],
): CompactSelectedFamilyPayload {
  const evidenceKind = classifyEvidenceKind(family);

  return {
    family,
    semantic_purpose: EVIDENCE_FAMILY_DEFINITIONS[family].semantic_purpose,
    evidence_kind: evidenceKind,
    ref_count: refs.length,
    refs,
    payload: pickFamilyPayload(contextPackage, family),
  };
}

function classifyEvidenceKind(family: EvidenceFamily): CompactSelectedFamilyPayload['evidence_kind'] {
  if (family === 'PROVENANCE') {
    return 'PROVENANCE';
  }
  if (family === 'CURRENT_STATE') {
    return 'STATE';
  }
  if (family === 'CONVERSATION_CONTEXT') {
    return 'CONTEXT';
  }
  if (family.endsWith('_DETAIL') || family === 'TARGETED_WINDOWS') {
    return 'TARGETED_DETAIL';
  }
  if (family.endsWith('_SUMMARY') || family === 'RANGE_FACTS' || family === 'SIGNIFICANT_PERIODS') {
    return 'SUMMARY';
  }
  return 'REFERENCE';
}

function pickFamilyPayload(contextPackage: ContextLike, family: EvidenceFamily): Record<string, unknown> {
  const context = contextPackage as unknown as Record<string, unknown>;

  if (family === 'CURRENT_STATE') {
    return { current_state_snapshot: context.current_state_snapshot ?? null };
  }

  if (family === 'CONVERSATION_CONTEXT') {
    const messages = ((context.conversation_context as Record<string, unknown> | undefined)?.messages ?? []) as Array<Record<string, unknown>>;
    return {
      conversation: {
        thread_id: (context.conversation_context as Record<string, unknown> | undefined)?.thread_id ?? null,
        thread_state_version: (context.conversation_context as Record<string, unknown> | undefined)?.thread_state_version ?? null,
        awaiting_user_answer: (context.conversation_context as Record<string, unknown> | undefined)?.awaiting_user_answer ?? null,
        messages: messages.map((message) => ({
          message_id: message.message_id ?? null,
          role: message.role ?? null,
          created_at: message.created_at ?? null,
          content: message.content ?? null,
          message_type: message.message_type ?? null,
          provenance_ref: message.provenance_ref ?? null,
          answer: message.answer ?? null,
        })),
      },
    };
  }

  if (family === 'PROVENANCE') {
    return { provenance: context.provenance ?? null };
  }

  const analytical = (context.analytical_evidence as Record<string, unknown> | undefined) ?? null;

  if (family === 'GLUCOSE_SUMMARY') {
    return {
      summaries: analytical ? (analytical.summaries ?? null) : null,
      hypo_episode: context.hypo_episode ?? null,
    };
  }

  if (family === 'INSULIN_SUMMARY') {
    return {
      summaries: analytical ? (analytical.summaries ?? null) : null,
      recent_insulin: (context.current_state_snapshot as Record<string, unknown> | undefined)?.recent_insulin ?? null,
    };
  }

  if (family === 'MEAL_SUMMARY') {
    return {
      summaries: analytical ? (analytical.summaries ?? null) : null,
      recent_meal: (context.current_state_snapshot as Record<string, unknown> | undefined)?.recent_meal ?? null,
    };
  }

  if (family === 'ACTIVITY_SUMMARY') {
    return {
      summaries: analytical ? (analytical.summaries ?? null) : null,
      recent_activity: (context.current_state_snapshot as Record<string, unknown> | undefined)?.recent_activity ?? null,
    };
  }

  if (family === 'HYPO_SUMMARY') {
    return {
      hypo_episode: context.hypo_episode ?? null,
      summary_count: (analytical as Record<string, unknown> | null)?.summaries
        ? ((analytical?.summaries as Record<string, unknown>).hypo_episode_count ?? null)
        : null,
    };
  }

  if (family === 'RANGE_FACTS') {
    return {
      range_event_facts_count: Array.isArray((analytical as Record<string, unknown> | null)?.range_event_facts)
        ? ((analytical?.range_event_facts as unknown[]).length)
        : Array.isArray(context.event_context_facts)
          ? ((context.event_context_facts as unknown[]).length)
          : 0,
    };
  }

  if (family === 'PATTERN_EVIDENCE') {
    return { pattern_evidence: context.pattern_evidence ?? null };
  }

  if (family === 'HISTORICAL_EVIDENCE') {
    return { historical_evidence: context.historical_evidence ?? null };
  }

  if (family === 'MEMORY_EVIDENCE') {
    return { memory_evidence: context.memory_evidence ?? null };
  }

  return {
    family,
    note: 'Family payload is represented by deterministic references only in Compact Delivery Artifact v1.',
  };
}

function buildFamilyRefMap(contextPackage: ContextLike): Record<EvidenceFamily, { count: number; refs: string[] }> {
  const map = Object.fromEntries(
    (Object.keys(EVIDENCE_FAMILY_DEFINITIONS) as EvidenceFamily[]).map((family) => [family, { count: 0, refs: [] as string[] }]),
  ) as Record<EvidenceFamily, { count: number; refs: string[] }>;

  const context = contextPackage as unknown as Record<string, unknown>;
  const version = String(context.context_package_version ?? '');

  if (version === 'conversation-context.v1') {
    const direct = contextPackage as DirectResponseContextRecord;
    const directMessages = direct.conversation_context?.messages ?? [];
    const directProvenance = direct.provenance?.source_refs ?? [];
    map.CURRENT_STATE = {
      count: direct.current_state_snapshot ? 1 : 0,
      refs: direct.current_state_snapshot ? [direct.current_state_snapshot.as_of] : [],
    };
    map.CONVERSATION_CONTEXT = {
      count: directMessages.length,
      refs: directMessages.map((message) => message.message_id).slice(0, MAX_FAMILY_REFS),
    };
    map.PROVENANCE = {
      count: directProvenance.length,
      refs: directProvenance.slice(0, MAX_FAMILY_REFS),
    };

    return map;
  }

  if (version === 'conversation-time-range-context.v1') {
    const range = contextPackage as TimeRangeAnalysisContextRecord;
    const toArray = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value)
      ? value as Array<Record<string, unknown>>
      : [];
    const legacySections = (context as { evidence_sections?: Record<string, unknown> }).evidence_sections ?? {};
    const rangeMessages = range.conversation_context?.messages ?? [];
    const rangeProvenance = range.provenance?.source_refs ?? ((context.source_refs as string[] | undefined) ?? []);
    const legacyGlucoseEvents = toArray(legacySections.glucose_events);
    const legacyInsulinEvents = toArray(legacySections.insulin_treatment_events);
    const legacyMealEvents = toArray(legacySections.meal_events);
    const legacyActivityEvents = toArray(legacySections.activity_events);
    const legacyHypoEpisodes = toArray(legacySections.hypo_episodes);
    const legacyRangeFacts = toArray(legacySections.range_event_facts);
    const analytical = range.analytical_evidence ?? {
      glucose_events: legacyGlucoseEvents,
      insulin_treatment_events: legacyInsulinEvents,
      meal_events: legacyMealEvents,
      activity_events: legacyActivityEvents,
      hypo_episodes: legacyHypoEpisodes,
      range_event_facts: legacyRangeFacts,
      summaries: {
        total_events: legacyGlucoseEvents.length
          + legacyInsulinEvents.length
          + legacyMealEvents.length
          + legacyActivityEvents.length
          + legacyHypoEpisodes.length,
        glucose_count: legacyGlucoseEvents.length,
        insulin_treatment_count: legacyInsulinEvents.length,
        meal_count: legacyMealEvents.length,
        activity_count: legacyActivityEvents.length,
        hypo_episode_count: legacyHypoEpisodes.length,
        glucose_min: null,
        glucose_max: null,
        glucose_avg: null,
        missing_sections: [],
      },
    };
    const glucoseEvents = toArray((analytical as Record<string, unknown>).glucose_events);
    const insulinEvents = toArray((analytical as Record<string, unknown>).insulin_treatment_events);
    const mealEvents = toArray((analytical as Record<string, unknown>).meal_events);
    const activityEvents = toArray((analytical as Record<string, unknown>).activity_events);
    const hypoEpisodes = toArray((analytical as Record<string, unknown>).hypo_episodes);
    const rangeFacts = toArray((analytical as Record<string, unknown>).range_event_facts);
    const resolvedGlucoseEvents = glucoseEvents.length > 0 ? glucoseEvents : legacyGlucoseEvents;
    const resolvedInsulinEvents = insulinEvents.length > 0 ? insulinEvents : legacyInsulinEvents;
    const resolvedMealEvents = mealEvents.length > 0 ? mealEvents : legacyMealEvents;
    const resolvedActivityEvents = activityEvents.length > 0 ? activityEvents : legacyActivityEvents;
    const resolvedHypoEpisodes = hypoEpisodes.length > 0 ? hypoEpisodes : legacyHypoEpisodes;
    const resolvedRangeFacts = rangeFacts.length > 0 ? rangeFacts : legacyRangeFacts;
    const summaries = ((analytical as Record<string, unknown>).summaries ?? {}) as Record<string, unknown>;
    map.CURRENT_STATE = {
      count: range.current_state_snapshot ? 1 : 0,
      refs: range.current_state_snapshot ? [range.current_state_snapshot.as_of] : [],
    };
    map.CONVERSATION_CONTEXT = {
      count: rangeMessages.length,
      refs: rangeMessages.map((message) => message.message_id).slice(0, MAX_FAMILY_REFS),
    };

    map.GLUCOSE_SUMMARY = {
      count: Number(summaries.glucose_count ?? resolvedGlucoseEvents.length) || resolvedGlucoseEvents.length,
      refs: resolvedGlucoseEvents
        .map((item) => String(item['event_id'] ?? ''))
        .filter((item) => item.length > 0)
        .slice(0, MAX_FAMILY_REFS),
    };
    map.GLUCOSE_DETAIL = { ...map.GLUCOSE_SUMMARY };

    map.INSULIN_SUMMARY = {
      count: Number(summaries.insulin_treatment_count ?? resolvedInsulinEvents.length) || resolvedInsulinEvents.length,
      refs: resolvedInsulinEvents
        .map((item) => String(item['event_id'] ?? ''))
        .filter((item) => item.length > 0)
        .slice(0, MAX_FAMILY_REFS),
    };
    map.INSULIN_DETAIL = { ...map.INSULIN_SUMMARY };

    map.MEAL_SUMMARY = {
      count: Number(summaries.meal_count ?? resolvedMealEvents.length) || resolvedMealEvents.length,
      refs: resolvedMealEvents
        .map((item) => String(item['event_id'] ?? ''))
        .filter((item) => item.length > 0)
        .slice(0, MAX_FAMILY_REFS),
    };
    map.MEAL_DETAIL = { ...map.MEAL_SUMMARY };

    map.ACTIVITY_SUMMARY = {
      count: Number(summaries.activity_count ?? resolvedActivityEvents.length) || resolvedActivityEvents.length,
      refs: resolvedActivityEvents
        .map((item) => String(item['event_id'] ?? ''))
        .filter((item) => item.length > 0)
        .slice(0, MAX_FAMILY_REFS),
    };
    map.ACTIVITY_DETAIL = { ...map.ACTIVITY_SUMMARY };

    map.HYPO_SUMMARY = {
      count: Number(summaries.hypo_episode_count ?? resolvedHypoEpisodes.length) || resolvedHypoEpisodes.length,
      refs: resolvedHypoEpisodes
        .map((item) => String(item['episode_id'] ?? ''))
        .filter((item) => item.length > 0)
        .slice(0, MAX_FAMILY_REFS),
    };
    map.HYPO_DETAIL = { ...map.HYPO_SUMMARY };

    map.RANGE_FACTS = {
      count: resolvedRangeFacts.length,
      refs: resolvedRangeFacts
        .map((item) => String(item['fact_id'] ?? ''))
        .filter((item) => item.length > 0)
        .slice(0, MAX_FAMILY_REFS),
    };

    map.PROVENANCE = {
      count: rangeProvenance.length,
      refs: rangeProvenance.slice(0, MAX_FAMILY_REFS),
    };

    return map;
  }

  const hypo = contextPackage as ContextPackageRecord;
  const hypoMessages = hypo.conversation_context?.messages ?? [];
  const hypoSourceRecordIds = hypo.provenance?.source_record_ids ?? [];
  map.CURRENT_STATE = {
    count: hypo.current_state_snapshot ? 1 : 0,
    refs: hypo.current_state_snapshot ? [hypo.current_state_snapshot.as_of] : [],
  };
  map.CONVERSATION_CONTEXT = {
    count: hypoMessages.length,
    refs: hypoMessages.map((message) => message.message_id).slice(0, MAX_FAMILY_REFS),
  };
  map.HYPO_SUMMARY = {
    count: hypo.hypo_episode ? 1 : 0,
    refs: hypo.hypo_episode ? [hypo.hypo_episode.episode_id] : [],
  };
  map.GLUCOSE_SUMMARY = {
    count: hypo.glucose_evidence.length,
    refs: hypo.glucose_evidence.map((item) => item.reading_id).slice(0, MAX_FAMILY_REFS),
  };
  map.GLUCOSE_DETAIL = { ...map.GLUCOSE_SUMMARY };
  map.HYPO_DETAIL = { ...map.GLUCOSE_SUMMARY };

  map.INSULIN_SUMMARY = {
    count: hypo.current_state_snapshot.recent_insulin.length,
    refs: hypo.current_state_snapshot.recent_insulin.map((item) => item.event_id).slice(0, MAX_FAMILY_REFS),
  };
  map.INSULIN_DETAIL = { ...map.INSULIN_SUMMARY };

  map.MEAL_SUMMARY = {
    count: hypo.current_state_snapshot.recent_meal ? 1 : 0,
    refs: hypo.current_state_snapshot.recent_meal ? [hypo.current_state_snapshot.recent_meal.event_id] : [],
  };
  map.MEAL_DETAIL = { ...map.MEAL_SUMMARY };

  map.ACTIVITY_SUMMARY = {
    count: hypo.current_state_snapshot.recent_activity ? 1 : 0,
    refs: hypo.current_state_snapshot.recent_activity ? [hypo.current_state_snapshot.recent_activity.event_id] : [],
  };
  map.ACTIVITY_DETAIL = { ...map.ACTIVITY_SUMMARY };

  map.RANGE_FACTS = {
    count: hypo.event_context_facts.length,
    refs: hypo.event_context_facts.map((fact) => fact.source.source_ref).slice(0, MAX_FAMILY_REFS),
  };

  map.PATTERN_EVIDENCE = {
    count: hypo.pattern_evidence?.selected_patterns.length ?? 0,
    refs: (hypo.pattern_evidence?.selected_patterns ?? []).map((item) => item.pattern_id).slice(0, MAX_FAMILY_REFS),
  };

  map.HISTORICAL_EVIDENCE = {
    count: hypo.historical_evidence?.selected_cases.length ?? 0,
    refs: (hypo.historical_evidence?.selected_cases ?? [])
      .map((item) => String(item.case_reference?.['id'] ?? ''))
      .filter((item) => item.length > 0)
      .slice(0, MAX_FAMILY_REFS),
  };

  const selectedMemories = 'memory_evidence' in hypo
    ? (hypo.memory_evidence?.selected_memories ?? [])
    : [];
  map.MEMORY_EVIDENCE = {
    count: selectedMemories.length,
    refs: selectedMemories
      .map((item: { memory_id: string }) => item.memory_id)
      .slice(0, MAX_FAMILY_REFS),
  };

  map.PROVENANCE = {
    count: hypoSourceRecordIds.length + 2,
    refs: [
      hypo.provenance.trigger_id,
      hypo.provenance.source_event_id,
      ...hypoSourceRecordIds,
    ].slice(0, MAX_FAMILY_REFS),
  };

  return map;
}

function buildFamilyStateMap(shadow: EvidenceSelectionShadowResult): Partial<Record<EvidenceFamily, SelectionState>> {
  const map: Partial<Record<EvidenceFamily, SelectionState>> = {};

  for (const family of shadow.missing) {
    if (isEvidenceFamily(family)) {
      map[family] = 'MISSING';
    }
  }
  for (const family of shadow.excluded) {
    if (isEvidenceFamily(family)) {
      map[family] = 'EXCLUDED';
    }
  }
  for (const family of shadow.not_selected) {
    if (isEvidenceFamily(family)) {
      map[family] = 'NOT_SELECTED';
    }
  }
  for (const unknown of shadow.unknowns) {
    const [family] = unknown.split(':');
    if (isEvidenceFamily(family)) {
      map[family] = 'UNKNOWN';
    }
  }

  return map;
}

function isEvidenceFamily(value: string): value is EvidenceFamily {
  return Object.prototype.hasOwnProperty.call(EVIDENCE_FAMILY_DEFINITIONS, value);
}

function uniqueStable(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function buildStableHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function buildCompactDeliveryArtifactFromRuntime(args: {
  contextPackage: ContextLike;
  task: AiTask;
}): CompactDeliveryArtifactV1 {
  return buildCompactDeliveryArtifact({
    contextPackage: args.contextPackage,
    task: args.task,
  });
}

export function isCoreTaskFamily(taskType: string): boolean {
  return taskType === CONVERSATION_DIRECT_RESPONSE_TASK_TYPE
    || taskType === CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE;
}
