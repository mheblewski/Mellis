import { createHash } from 'crypto';
import { canonicalJson } from '@shared/utils/canonical-json';
import {
  CONVERSATION_DIRECT_RESPONSE_TASK_TYPE,
  CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE,
  type AiContextPackage,
  type AiTask,
  type ContextPackageUsage,
  type DirectResponseContextRecord,
  type TimeRangeAnalysisContextRecord,
} from '@modules/ai-gateway/domain/ai-gateway';
import type { ContextPackageRecord } from '@modules/context/domain/context-package';
import {
  selectEvidenceBundle,
  type EvidenceFamily,
  type SelectionState,
} from './evidence-selection-policy';

const TASK_EVIDENCE_POLICY_VERSION = 'task-evidence-policy.v1' as const;
const EVIDENCE_SELECTION_POLICY_VERSION = 'evidence-selection-policy.v1' as const;
const EVIDENCE_RELATIONSHIP_SEMANTICS_VERSION = 'evidence-relationship-semantics.v1' as const;
const MAX_REFS_PER_FAMILY = 32;
const MAX_UNKNOWN_ITEMS = 32;
const SHADOW_CONTEXT_VERSION = 'evidence-selection-shadow.v1' as const;

type ContextLike = AiContextPackage;

export type ShadowSelectionStatus =
  | 'AVAILABLE'
  | 'AVAILABLE_WITH_RELATION'
  | 'PARTIAL'
  | 'UNRESOLVED'
  | 'SHADOW_SELECTION_FAILED';

export function isSuccessfulShadowSelectionStatus(
  status: string | null | undefined,
): status is 'AVAILABLE' | 'AVAILABLE_WITH_RELATION' {
  return status === 'AVAILABLE' || status === 'AVAILABLE_WITH_RELATION';
}

export interface EvidenceSelectionShadowResult {
  shadow_version: typeof SHADOW_CONTEXT_VERSION;
  task_type: string;
  task_identity: string;
  patient_id: string | null;
  context_package_id: string;
  context_package_version: string;
  context_package_hash: string;
  evidence_representation_version: string;
  task_evidence_policy_version: string;
  evidence_selection_policy_version: string;
  evidence_relationship_semantics_version: string;
  selection_profile: string;
  default_level: string;
  selected_level: string;
  status: ShadowSelectionStatus;
  selected_evidence_families: EvidenceFamily[];
  selected_evidence_ref_count: number;
  selected_evidence_refs_sample: string[];
  omitted_evidence_ref_count: number;
  omitted_evidence_refs_sample: string[];
  relationship_decisions: Array<{
    relationship: string;
    status: string;
  }>;
  unresolved_reasons: string[];
  unknowns: string[];
  missing: string[];
  excluded: string[];
  not_selected: string[];
  provenance_refs_sample: string[];
  input_material_hash: string;
  selection_material_hash: string;
  current_payload_bytes: number;
  current_payload_tokens: number | null;
  current_payload_tokens_kind: 'AUTHORITATIVE' | 'UNAVAILABLE';
  shadow_payload_bytes: number;
  shadow_payload_tokens_estimate: number | null;
  shadow_payload_tokens_kind: 'ESTIMATED_FROM_CURRENT' | 'UNAVAILABLE';
  bytes_saved: number;
  bytes_reduction_pct: number;
  token_reduction_estimate: number | null;
  token_reduction_pct_estimate: number | null;
  family_counts: Partial<Record<EvidenceFamily, number>>;
  telemetry_bounded: true;
  failed_reason?: string;
}

interface FamilyInventoryEntry {
  mapped: boolean;
  count: number;
  refs: string[];
}

type FamilyInventory = Record<EvidenceFamily, FamilyInventoryEntry>;

export function evaluateEvidenceSelectionShadowSafe(args: {
  task: AiTask;
  context_package: ContextLike;
}): EvidenceSelectionShadowResult {
  try {
    return evaluateEvidenceSelectionShadow(args);
  } catch (error) {
    const context = args.context_package as unknown as Record<string, unknown>;
    const failedReason = error instanceof Error ? error.message : String(error);

    return {
      shadow_version: SHADOW_CONTEXT_VERSION,
      task_type: args.task.task_type,
      task_identity: buildStableHash(args.task),
      patient_id: args.task.patient_id ?? null,
      context_package_id: String(context.context_package_id ?? 'UNKNOWN'),
      context_package_version: String(context.context_package_version ?? 'UNKNOWN'),
      context_package_hash: String(context.content_hash ?? 'UNKNOWN'),
      evidence_representation_version: String(context.context_package_version ?? 'UNKNOWN'),
      task_evidence_policy_version: TASK_EVIDENCE_POLICY_VERSION,
      evidence_selection_policy_version: EVIDENCE_SELECTION_POLICY_VERSION,
      evidence_relationship_semantics_version: EVIDENCE_RELATIONSHIP_SEMANTICS_VERSION,
      selection_profile: 'UNKNOWN',
      default_level: 'UNKNOWN',
      selected_level: 'UNKNOWN',
      status: 'SHADOW_SELECTION_FAILED',
      selected_evidence_families: [],
      selected_evidence_ref_count: 0,
      selected_evidence_refs_sample: [],
      omitted_evidence_ref_count: 0,
      omitted_evidence_refs_sample: [],
      relationship_decisions: [],
      unresolved_reasons: ['SHADOW_SELECTION_FAILED'],
      unknowns: [failedReason.slice(0, 256)],
      missing: [],
      excluded: [],
      not_selected: [],
      provenance_refs_sample: [],
      input_material_hash: buildStableHash({ task: args.task.task_type, context_package_id: context.context_package_id ?? null }),
      selection_material_hash: buildStableHash({ status: 'SHADOW_SELECTION_FAILED', reason: failedReason }),
      current_payload_bytes: 0,
      current_payload_tokens: null,
      current_payload_tokens_kind: 'UNAVAILABLE',
      shadow_payload_bytes: 0,
      shadow_payload_tokens_estimate: null,
      shadow_payload_tokens_kind: 'UNAVAILABLE',
      bytes_saved: 0,
      bytes_reduction_pct: 0,
      token_reduction_estimate: null,
      token_reduction_pct_estimate: null,
      family_counts: {},
      telemetry_bounded: true,
      failed_reason: failedReason.slice(0, 256),
    };
  }
}

export function finalizeShadowWithProviderMetrics(args: {
  shadow: EvidenceSelectionShadowResult;
  current_payload_bytes: number | null;
  current_payload_tokens: number | null;
}): EvidenceSelectionShadowResult {
  const currentBytes = Number.isFinite(args.current_payload_bytes ?? NaN)
    ? Number(args.current_payload_bytes)
    : args.shadow.current_payload_bytes;
  const currentTokens = Number.isFinite(args.current_payload_tokens ?? NaN)
    ? Number(args.current_payload_tokens)
    : null;

  const bytesSaved = Math.max(0, currentBytes - args.shadow.shadow_payload_bytes);
  const bytesReductionPct = currentBytes > 0 ? Number(((bytesSaved / currentBytes) * 100).toFixed(4)) : 0;

  let shadowPayloadTokenEstimate: number | null = null;
  let tokenReductionEstimate: number | null = null;
  let tokenReductionPctEstimate: number | null = null;

  if (currentTokens !== null && currentBytes > 0) {
    shadowPayloadTokenEstimate = Math.max(
      0,
      Math.round((currentTokens / currentBytes) * args.shadow.shadow_payload_bytes),
    );
    tokenReductionEstimate = Math.max(0, currentTokens - shadowPayloadTokenEstimate);
    tokenReductionPctEstimate = currentTokens > 0
      ? Number(((tokenReductionEstimate / currentTokens) * 100).toFixed(4))
      : 0;
  }

  return {
    ...args.shadow,
    current_payload_bytes: currentBytes,
    current_payload_tokens: currentTokens,
    current_payload_tokens_kind: currentTokens !== null ? 'AUTHORITATIVE' : 'UNAVAILABLE',
    shadow_payload_tokens_estimate: shadowPayloadTokenEstimate,
    shadow_payload_tokens_kind: shadowPayloadTokenEstimate !== null ? 'ESTIMATED_FROM_CURRENT' : 'UNAVAILABLE',
    bytes_saved: bytesSaved,
    bytes_reduction_pct: bytesReductionPct,
    token_reduction_estimate: tokenReductionEstimate,
    token_reduction_pct_estimate: tokenReductionPctEstimate,
  };
}

export function attachShadowToContextPackageUsage(args: {
  usage: ContextPackageUsage;
  shadow: EvidenceSelectionShadowResult;
}): ContextPackageUsage {
  const shadowSummary = {
    shadow_version: args.shadow.shadow_version,
    status: args.shadow.status,
    selection_profile: args.shadow.selection_profile,
    selected_level: args.shadow.selected_level,
    selected_evidence_families: args.shadow.selected_evidence_families,
    selected_evidence_ref_count: args.shadow.selected_evidence_ref_count,
    omitted_evidence_ref_count: args.shadow.omitted_evidence_ref_count,
    unresolved_reasons: args.shadow.unresolved_reasons,
    bytes_saved: args.shadow.bytes_saved,
    bytes_reduction_pct: args.shadow.bytes_reduction_pct,
    token_reduction_estimate: args.shadow.token_reduction_estimate,
    token_reduction_pct_estimate: args.shadow.token_reduction_pct_estimate,
    selection_material_hash: args.shadow.selection_material_hash,
    telemetry_bounded: true,
  };

  const shadowSectionBytes = Buffer.byteLength(canonicalJson(shadowSummary), 'utf8');

  return {
    ...args.usage,
    total_serialized_bytes: args.usage.total_serialized_bytes,
    sections: [
      ...args.usage.sections,
      {
        section_name: 'shadow_selection',
        serialized_bytes: shadowSectionBytes,
      },
    ],
    shadow_selection: shadowSummary,
  };
}

function evaluateEvidenceSelectionShadow(args: {
  task: AiTask;
  context_package: ContextLike;
}): EvidenceSelectionShadowResult {
  const context = args.context_package as unknown as Record<string, unknown>;
  const inventory = buildFamilyInventory(args.context_package);
  const evidenceSelectionInput = mapShadowInput(args.task, args.context_package, inventory);
  const selection = selectEvidenceBundle(evidenceSelectionInput);

  const selectedFamilies = uniqueFamilies([
    ...selection.required,
    ...selection.optional.filter((family) => {
      const item = inventory[family];
      return item?.mapped && item.count > 0;
    }),
  ]);

  const selectedRefs = selectedFamilies.flatMap((family) => inventory[family]?.refs ?? []);

  const omittedFamilies = Object.entries(inventory)
    .filter(([family, item]) => item.mapped && item.count > 0 && !selectedFamilies.includes(family as EvidenceFamily))
    .map(([family]) => family as EvidenceFamily);
  const omittedRefs = omittedFamilies.flatMap((family) => inventory[family]?.refs ?? []);

  const unknownFamilies = Object.entries(inventory)
    .filter(([, item]) => !item.mapped)
    .map(([family]) => `${family}:UNMAPPED`)
    .slice(0, MAX_UNKNOWN_ITEMS);

  const missing = collectFamiliesByState(selection.family_states, 'MISSING');
  const excluded = collectFamiliesByState(selection.family_states, 'EXCLUDED');
  const notSelected = collectFamiliesByState(selection.family_states, 'NOT_SELECTED');

  const currentPayloadBytes = Buffer.byteLength(canonicalJson(args.context_package), 'utf8');
  const shadowProjection = {
    selected_families: selectedFamilies,
    selected_refs: selectedRefs,
    unresolved_reasons: [...selection.unresolved_reasons],
    relationship_requirements: selection.relationship_requirements,
    selection_mode: selection.selection_mode,
    selected_level: selection.effective_level,
  };
  const shadowPayloadBytes = Buffer.byteLength(canonicalJson(shadowProjection), 'utf8');

  const provenanceRefs = extractProvenanceRefs(args.context_package);

  const inputMaterialHash = buildStableHash({
    task_type: args.task.task_type,
    task_identity: buildStableHash(args.task),
    context_package_hash: String(context.content_hash ?? ''),
    context_package_version: String(context.context_package_version ?? ''),
    task_evidence_policy_version: TASK_EVIDENCE_POLICY_VERSION,
    evidence_selection_policy_version: EVIDENCE_SELECTION_POLICY_VERSION,
    evidence_relationship_semantics_version: EVIDENCE_RELATIONSHIP_SEMANTICS_VERSION,
  });

  const selectionMaterialHash = buildStableHash({
    selected_families: selectedFamilies,
    selected_refs: selectedRefs,
    omitted_refs: omittedRefs,
    unresolved_reasons: [...selection.unresolved_reasons],
    family_states: selection.family_states,
    decision_state: selection.decision_state,
  });

  return {
    shadow_version: SHADOW_CONTEXT_VERSION,
    task_type: args.task.task_type,
    task_identity: buildStableHash(args.task),
    patient_id: args.task.patient_id ?? null,
    context_package_id: String(context.context_package_id ?? ''),
    context_package_version: String(context.context_package_version ?? ''),
    context_package_hash: String(context.content_hash ?? ''),
    evidence_representation_version: String(context.context_package_version ?? ''),
    task_evidence_policy_version: TASK_EVIDENCE_POLICY_VERSION,
    evidence_selection_policy_version: EVIDENCE_SELECTION_POLICY_VERSION,
    evidence_relationship_semantics_version: EVIDENCE_RELATIONSHIP_SEMANTICS_VERSION,
    selection_profile: selection.selection_profile,
    default_level: selection.requested_level,
    selected_level: selection.effective_level,
    status: mapDecisionState(selection.decision_state),
    selected_evidence_families: selectedFamilies,
    selected_evidence_ref_count: selectedRefs.length,
    selected_evidence_refs_sample: selectedRefs.slice(0, MAX_REFS_PER_FAMILY),
    omitted_evidence_ref_count: omittedRefs.length,
    omitted_evidence_refs_sample: omittedRefs.slice(0, MAX_REFS_PER_FAMILY),
    relationship_decisions: selection.relationship_requirements.map((relationship) => ({
      relationship,
      status: relationshipStatusFromName(relationship),
    })),
    unresolved_reasons: [...selection.unresolved_reasons],
    unknowns: unknownFamilies,
    missing,
    excluded,
    not_selected: notSelected,
    provenance_refs_sample: provenanceRefs.slice(0, MAX_REFS_PER_FAMILY),
    input_material_hash: inputMaterialHash,
    selection_material_hash: selectionMaterialHash,
    current_payload_bytes: currentPayloadBytes,
    current_payload_tokens: null,
    current_payload_tokens_kind: 'UNAVAILABLE',
    shadow_payload_bytes: shadowPayloadBytes,
    shadow_payload_tokens_estimate: null,
    shadow_payload_tokens_kind: 'UNAVAILABLE',
    bytes_saved: Math.max(0, currentPayloadBytes - shadowPayloadBytes),
    bytes_reduction_pct: currentPayloadBytes > 0
      ? Number((((currentPayloadBytes - shadowPayloadBytes) / currentPayloadBytes) * 100).toFixed(4))
      : 0,
    token_reduction_estimate: null,
    token_reduction_pct_estimate: null,
    family_counts: collectFamilyCounts(inventory),
    telemetry_bounded: true,
  };
}

function mapDecisionState(state: SelectionState): ShadowSelectionStatus {
  if (isSuccessfulShadowSelectionStatus(state)) {
    return state;
  }
  if (state === 'PARTIAL') {
    return 'PARTIAL';
  }
  return 'UNRESOLVED';
}

function mapShadowInput(task: AiTask, contextPackage: ContextLike, inventory: FamilyInventory): Parameters<typeof selectEvidenceBundle>[0] {
  const messageText = extractMessageText(contextPackage);
  const normalizedMessage = messageText.toLowerCase();

  const asksWhy = /\bwhy\b|\bdlaczego\b|\bczemu\b/.test(normalizedMessage);
  const asksForExactSequence = /\bexact\b|\bdoklad|dokład|\bsequence\b|\bkrok po kroku\b/.test(normalizedMessage);

  const requestKind = task.task_type === CONVERSATION_DIRECT_RESPONSE_TASK_TYPE
    ? 'DIRECT_RESPONSE'
    : 'ANALYSIS_REQUEST';

  // Keep task-type routing authoritative for core runtime tasks.
  // Evidence references still inform family selection inside the chosen profile,
  // but should not remap TODAY/direct tasks into different profiles.
  const lockProfileByTaskType = task.task_type === CONVERSATION_DIRECT_RESPONSE_TASK_TYPE;

  const referencesEvent = task.task_type === CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE
    ? (inventory.SIGNIFICANT_PERIODS.count > 0 || inventory.TARGETED_WINDOWS.count > 0 || inventory.HYPO_SUMMARY.count > 0)
    : inventory.HYPO_SUMMARY.count > 0;

  return {
    task_type: task.task_type,
    request_kind: requestKind,
    asks_why: asksWhy,
    asks_for_exact_sequence: asksForExactSequence,
    requires_exact_local_evidence: asksForExactSequence,
    references_event: lockProfileByTaskType ? false : referencesEvent,
    references_meal: lockProfileByTaskType ? false : inventory.MEAL_SUMMARY.count > 0,
    references_insulin: lockProfileByTaskType ? false : inventory.INSULIN_SUMMARY.count > 0,
    references_activity: lockProfileByTaskType ? false : inventory.ACTIVITY_SUMMARY.count > 0,
    references_pattern: lockProfileByTaskType ? false : inventory.PATTERN_EVIDENCE.count > 0,
    references_historical_cases: lockProfileByTaskType ? false : inventory.HISTORICAL_EVIDENCE.count > 0,
    references_memory: lockProfileByTaskType ? false : inventory.MEMORY_EVIDENCE.count > 0,
    user_message_text: messageText,
  };
}

function extractMessageText(contextPackage: ContextLike): string {
  const context = contextPackage as unknown as Record<string, unknown>;

  if (typeof (context.direct_response_input as Record<string, unknown> | undefined)?.user_message_text === 'string') {
    return String((context.direct_response_input as Record<string, unknown>).user_message_text);
  }

  if (typeof (context.analysis_request_input as Record<string, unknown> | undefined)?.user_message_text === 'string') {
    return String((context.analysis_request_input as Record<string, unknown>).user_message_text);
  }

  const messages = ((context.conversation_context as Record<string, unknown> | undefined)?.messages ?? []) as Array<Record<string, unknown>>;
  const latestUser = [...messages].reverse().find((message) => String(message.role ?? '') === 'USER');
  return latestUser ? String(latestUser.content ?? '') : '';
}

function buildFamilyInventory(contextPackage: ContextLike): FamilyInventory {
  const base = emptyInventory();
  const context = contextPackage as unknown as Record<string, unknown>;
  const version = String(context.context_package_version ?? '');

  if (version === 'conversation-context.v1') {
    mapDirectResponseInventory(base, context as unknown as DirectResponseContextRecord);
    return base;
  }

  if (version === 'conversation-time-range-context.v1') {
    mapTimeRangeInventory(base, context as unknown as TimeRangeAnalysisContextRecord);
    return base;
  }

  mapHypoContextInventory(base, context as unknown as ContextPackageRecord);
  return base;
}

function mapDirectResponseInventory(inventory: FamilyInventory, context: DirectResponseContextRecord): void {
  inventory.CURRENT_STATE = {
    mapped: true,
    count: context.current_state_snapshot ? 1 : 0,
    refs: context.current_state_snapshot ? [context.current_state_snapshot.as_of] : [],
  };
  inventory.CONVERSATION_CONTEXT = {
    mapped: true,
    count: context.conversation_context.messages.length,
    refs: context.conversation_context.messages.map((message) => message.message_id).slice(0, MAX_REFS_PER_FAMILY),
  };
  inventory.PROVENANCE = {
    mapped: true,
    count: context.provenance.source_refs.length,
    refs: context.provenance.source_refs.slice(0, MAX_REFS_PER_FAMILY),
  };
}

function mapTimeRangeInventory(inventory: FamilyInventory, context: TimeRangeAnalysisContextRecord): void {
  const analytical = context.analytical_evidence;

  const glucoseRefs = analytical.glucose_events
    .map((event) => String(event.event_id ?? ''))
    .filter((ref) => ref.length > 0);
  const insulinRefs = analytical.insulin_treatment_events
    .map((event) => String(event.event_id ?? ''))
    .filter((ref) => ref.length > 0);
  const mealRefs = analytical.meal_events
    .map((event) => String(event.event_id ?? ''))
    .filter((ref) => ref.length > 0);
  const activityRefs = analytical.activity_events
    .map((event) => String(event.event_id ?? ''))
    .filter((ref) => ref.length > 0);
  const hypoRefs = analytical.hypo_episodes
    .map((episode) => String(episode.episode_id ?? ''))
    .filter((ref) => ref.length > 0);
  const rangeFactRefs = analytical.range_event_facts
    .map((fact) => String(fact.fact_id ?? ''))
    .filter((ref) => ref.length > 0);

  const significantGlucoseRefs = analytical.glucose_events
    .filter((event) => {
      // The same fields, in the same order, as the worker reads a reading (Nightscout's raw sgv last); 0 or below is a
      // sensor error, not a low.
      const payload = event.payload as Record<string, unknown> | undefined;
      const rawSgv = (payload?.raw_payload as Record<string, unknown> | undefined)?.sgv;
      const glucose = [payload?.glucose_value, payload?.glucose, rawSgv].find((value) => typeof value === 'number');
      if (typeof glucose !== 'number' || !Number.isFinite(glucose) || glucose <= 0) {
        return false;
      }
      return glucose < 70 || glucose > 180;
    })
    .map((event) => String(event.event_id ?? ''))
    .filter((ref) => ref.length > 0);

  const significantRangeFactRefs = analytical.range_event_facts
    .filter((fact) => {
      const key = String(fact.fact_key ?? '').toLowerCase();
      return /hypo|hyper|excursion|spike|drop|significant/.test(key);
    })
    .map((fact) => String(fact.fact_id ?? ''))
    .filter((ref) => ref.length > 0);

  const significantPeriodRefs = uniqueStableRefs([
    ...hypoRefs,
    ...significantGlucoseRefs,
    ...significantRangeFactRefs,
  ]);

  const targetedWindowRefs = uniqueStableRefs([
    ...significantGlucoseRefs,
    ...glucoseRefs,
  ]).slice(0, MAX_REFS_PER_FAMILY);

  inventory.CURRENT_STATE = {
    mapped: true,
    count: context.current_state_snapshot ? 1 : 0,
    refs: context.current_state_snapshot ? [context.current_state_snapshot.as_of] : [],
  };

  inventory.CONVERSATION_CONTEXT = {
    mapped: true,
    count: context.conversation_context.messages.length,
    refs: context.conversation_context.messages.map((message) => message.message_id).slice(0, MAX_REFS_PER_FAMILY),
  };

  inventory.GLUCOSE_SUMMARY = {
    mapped: true,
    count: analytical.summaries.glucose_count,
    refs: glucoseRefs.slice(0, MAX_REFS_PER_FAMILY),
  };
  inventory.GLUCOSE_DETAIL = {
    mapped: true,
    count: analytical.glucose_events.length,
    refs: glucoseRefs.slice(0, MAX_REFS_PER_FAMILY),
  };

  inventory.INSULIN_SUMMARY = {
    mapped: true,
    count: analytical.summaries.insulin_treatment_count,
    refs: insulinRefs.slice(0, MAX_REFS_PER_FAMILY),
  };
  inventory.INSULIN_DETAIL = {
    mapped: true,
    count: analytical.insulin_treatment_events.length,
    refs: insulinRefs.slice(0, MAX_REFS_PER_FAMILY),
  };

  inventory.MEAL_SUMMARY = {
    mapped: true,
    count: analytical.summaries.meal_count,
    refs: mealRefs.slice(0, MAX_REFS_PER_FAMILY),
  };
  inventory.MEAL_DETAIL = {
    mapped: true,
    count: analytical.meal_events.length,
    refs: mealRefs.slice(0, MAX_REFS_PER_FAMILY),
  };

  inventory.ACTIVITY_SUMMARY = {
    mapped: true,
    count: analytical.summaries.activity_count,
    refs: activityRefs.slice(0, MAX_REFS_PER_FAMILY),
  };
  inventory.ACTIVITY_DETAIL = {
    mapped: true,
    count: analytical.activity_events.length,
    refs: activityRefs.slice(0, MAX_REFS_PER_FAMILY),
  };

  inventory.HYPO_SUMMARY = {
    mapped: true,
    count: analytical.summaries.hypo_episode_count,
    refs: hypoRefs.slice(0, MAX_REFS_PER_FAMILY),
  };
  inventory.HYPO_DETAIL = {
    mapped: true,
    count: analytical.hypo_episodes.length,
    refs: hypoRefs.slice(0, MAX_REFS_PER_FAMILY),
  };

  inventory.RANGE_FACTS = {
    mapped: true,
    count: analytical.range_event_facts.length,
    refs: rangeFactRefs.slice(0, MAX_REFS_PER_FAMILY),
  };

  inventory.SIGNIFICANT_PERIODS = {
    mapped: true,
    count: significantPeriodRefs.length,
    refs: significantPeriodRefs.slice(0, MAX_REFS_PER_FAMILY),
  };

  inventory.TARGETED_WINDOWS = {
    mapped: true,
    count: targetedWindowRefs.length,
    refs: targetedWindowRefs,
  };

  inventory.PROVENANCE = {
    mapped: true,
    count: context.provenance.source_refs.length,
    refs: context.provenance.source_refs.slice(0, MAX_REFS_PER_FAMILY),
  };
}

function mapHypoContextInventory(inventory: FamilyInventory, context: ContextPackageRecord): void {
  inventory.CURRENT_STATE = {
    mapped: true,
    count: context.current_state_snapshot ? 1 : 0,
    refs: [context.current_state_snapshot.as_of],
  };

  inventory.CONVERSATION_CONTEXT = {
    mapped: true,
    count: context.conversation_context.messages.length,
    refs: context.conversation_context.messages.map((message) => message.message_id).slice(0, MAX_REFS_PER_FAMILY),
  };

  inventory.HYPO_SUMMARY = {
    mapped: true,
    count: context.hypo_episode ? 1 : 0,
    refs: context.hypo_episode ? [context.hypo_episode.episode_id] : [],
  };

  inventory.HYPO_DETAIL = {
    mapped: true,
    count: context.glucose_evidence.length,
    refs: context.glucose_evidence.map((item) => item.reading_id).slice(0, MAX_REFS_PER_FAMILY),
  };

  inventory.GLUCOSE_SUMMARY = {
    mapped: true,
    count: context.glucose_evidence.length,
    refs: context.glucose_evidence.map((item) => item.reading_id).slice(0, MAX_REFS_PER_FAMILY),
  };

  inventory.GLUCOSE_DETAIL = {
    mapped: true,
    count: context.glucose_evidence.length,
    refs: context.glucose_evidence.map((item) => item.reading_id).slice(0, MAX_REFS_PER_FAMILY),
  };

  const recentInsulin = context.current_state_snapshot.recent_insulin ?? [];
  inventory.INSULIN_SUMMARY = {
    mapped: true,
    count: recentInsulin.length,
    refs: recentInsulin.map((item) => item.event_id).slice(0, MAX_REFS_PER_FAMILY),
  };
  inventory.INSULIN_DETAIL = {
    mapped: true,
    count: recentInsulin.length,
    refs: recentInsulin.map((item) => item.event_id).slice(0, MAX_REFS_PER_FAMILY),
  };

  inventory.MEAL_SUMMARY = {
    mapped: true,
    count: context.current_state_snapshot.recent_meal ? 1 : 0,
    refs: context.current_state_snapshot.recent_meal ? [context.current_state_snapshot.recent_meal.event_id] : [],
  };

  inventory.MEAL_DETAIL = {
    mapped: true,
    count: context.current_state_snapshot.recent_meal ? 1 : 0,
    refs: context.current_state_snapshot.recent_meal ? [context.current_state_snapshot.recent_meal.event_id] : [],
  };

  inventory.ACTIVITY_SUMMARY = {
    mapped: true,
    count: context.current_state_snapshot.recent_activity ? 1 : 0,
    refs: context.current_state_snapshot.recent_activity ? [context.current_state_snapshot.recent_activity.event_id] : [],
  };

  inventory.ACTIVITY_DETAIL = {
    mapped: true,
    count: context.current_state_snapshot.recent_activity ? 1 : 0,
    refs: context.current_state_snapshot.recent_activity ? [context.current_state_snapshot.recent_activity.event_id] : [],
  };

  inventory.RANGE_FACTS = {
    mapped: true,
    count: context.event_context_facts.length,
    refs: context.event_context_facts.map((fact) => fact.source.source_ref).slice(0, MAX_REFS_PER_FAMILY),
  };

  inventory.HISTORICAL_EVIDENCE = {
    mapped: true,
    count: context.historical_evidence?.selected_cases.length ?? 0,
    refs: (context.historical_evidence?.selected_cases ?? [])
      .map((item) => String(item.case_reference?.['id'] ?? ''))
      .filter((ref) => ref.length > 0)
      .slice(0, MAX_REFS_PER_FAMILY),
  };

  inventory.PATTERN_EVIDENCE = {
    mapped: true,
    count: context.pattern_evidence?.selected_patterns.length ?? 0,
    refs: (context.pattern_evidence?.selected_patterns ?? []).map((item) => item.pattern_id).slice(0, MAX_REFS_PER_FAMILY),
  };

  inventory.MEMORY_EVIDENCE = {
    mapped: true,
    count: context.context_package_version === 'context-package.v3'
      ? context.memory_evidence?.selected_memories.length ?? 0
      : 0,
    refs: context.context_package_version === 'context-package.v3'
      ? (context.memory_evidence?.selected_memories ?? []).map((item) => item.memory_id).slice(0, MAX_REFS_PER_FAMILY)
      : [],
  };

  inventory.PROVENANCE = {
    mapped: true,
    count: context.provenance.source_record_ids.length + 2,
    refs: [
      context.provenance.trigger_id,
      context.provenance.source_event_id,
      ...context.provenance.source_record_ids,
    ].slice(0, MAX_REFS_PER_FAMILY),
  };
}

function extractProvenanceRefs(contextPackage: ContextLike): string[] {
  const context = contextPackage as unknown as Record<string, unknown>;
  const version = String(context.context_package_version ?? '');

  if (version === 'conversation-context.v1') {
    const direct = contextPackage as DirectResponseContextRecord;
    return direct.provenance.source_refs;
  }

  if (version === 'conversation-time-range-context.v1') {
    const range = contextPackage as TimeRangeAnalysisContextRecord;
    return range.provenance.source_refs;
  }

  const hypo = contextPackage as ContextPackageRecord;
  return [
    hypo.provenance.trigger_id,
    hypo.provenance.source_event_id,
    ...hypo.provenance.source_record_ids,
  ];
}

function collectFamiliesByState(
  states: Partial<Record<EvidenceFamily, SelectionState>>,
  target: SelectionState,
): string[] {
  return Object.entries(states)
    .filter(([, value]) => value === target)
    .map(([family]) => family)
    .slice(0, MAX_UNKNOWN_ITEMS);
}

function collectFamilyCounts(inventory: FamilyInventory): Partial<Record<EvidenceFamily, number>> {
  const counts: Partial<Record<EvidenceFamily, number>> = {};
  for (const [family, item] of Object.entries(inventory)) {
    if (item.mapped) {
      counts[family as EvidenceFamily] = item.count;
    }
  }
  return counts;
}

function buildStableHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function relationshipStatusFromName(relationship: string): string {
  if (relationship.includes('HYPO_INSULIN')) {
    return 'CLOSED';
  }
  if (relationship.includes('HYPO_GLUCOSE')) {
    return 'CLOSED';
  }
  if (relationship.includes('PATTERN_MEAL_CASE')) {
    return 'CLOSED';
  }
  if (relationship.includes('MEAL_GLUCOSE')) {
    return 'PARTIAL';
  }
  if (relationship.includes('PATTERN_INSULIN')) {
    return 'PARTIAL';
  }
  if (relationship.includes('MEMORY_CURRENT')) {
    return 'PARTIAL';
  }
  return 'UNKNOWN';
}

function uniqueFamilies(families: EvidenceFamily[]): EvidenceFamily[] {
  return [...new Set(families)];
}

function uniqueStableRefs(refs: string[]): string[] {
  return [...new Set(refs.filter((ref) => ref.length > 0))];
}

function emptyInventory(): FamilyInventory {
  const families: EvidenceFamily[] = [
    'CURRENT_STATE',
    'GLUCOSE_SUMMARY',
    'GLUCOSE_DETAIL',
    'INSULIN_SUMMARY',
    'INSULIN_DETAIL',
    'MEAL_SUMMARY',
    'MEAL_DETAIL',
    'ACTIVITY_SUMMARY',
    'ACTIVITY_DETAIL',
    'HYPO_SUMMARY',
    'HYPO_DETAIL',
    'RANGE_FACTS',
    'PATTERN_EVIDENCE',
    'HISTORICAL_EVIDENCE',
    'MEMORY_EVIDENCE',
    'SIGNIFICANT_PERIODS',
    'TARGETED_WINDOWS',
    'CONVERSATION_CONTEXT',
    'PROVENANCE',
  ];

  const inventory = {} as FamilyInventory;
  for (const family of families) {
    inventory[family] = {
      mapped: false,
      count: 0,
      refs: [],
    };
  }

  return inventory;
}
