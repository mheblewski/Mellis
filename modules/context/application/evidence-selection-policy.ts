import { createHash } from 'node:crypto';

export type EvidenceLevel = 'L1' | 'L2' | 'L3' | 'L4';

export type EvidenceSelectionMode =
  | 'SUMMARY_ONLY'
  | 'SUMMARY_PLUS_REFERENCES'
  | 'TARGETED_RECONSTRUCTION'
  | 'AUTHORITATIVE_FULL_EVIDENCE';

export type EvidenceFamily =
  | 'CURRENT_STATE'
  | 'GLUCOSE_SUMMARY'
  | 'GLUCOSE_DETAIL'
  | 'INSULIN_SUMMARY'
  | 'INSULIN_DETAIL'
  | 'MEAL_SUMMARY'
  | 'MEAL_DETAIL'
  | 'ACTIVITY_SUMMARY'
  | 'ACTIVITY_DETAIL'
  | 'HYPO_SUMMARY'
  | 'HYPO_DETAIL'
  | 'RANGE_FACTS'
  | 'PATTERN_EVIDENCE'
  | 'HISTORICAL_EVIDENCE'
  | 'MEMORY_EVIDENCE'
  | 'SIGNIFICANT_PERIODS'
  | 'TARGETED_WINDOWS'
  | 'CONVERSATION_CONTEXT'
  | 'PROVENANCE';

export type EvidenceRole =
  | 'REQUIRED'
  | 'REQUIRED_IF_AVAILABLE'
  | 'OPTIONAL'
  | 'EXCLUDED_BY_DEFAULT'
  | 'NOT_SELECTED';

export type SelectionState =
  | 'AVAILABLE'
  | 'AVAILABLE_WITH_RELATION'
  | 'PARTIAL'
  | 'UNRESOLVED'
  | 'NOT_SELECTED'
  | 'EXCLUDED'
  | 'MISSING'
  | 'UNKNOWN';

export type RelationshipStatus = 'CLOSED' | 'PARTIAL' | 'OPEN' | 'NEEDS_DOMAIN_SEMANTICS';

export type RelationshipContract =
  | 'MEAL_GLUCOSE'
  | 'HYPO_GLUCOSE'
  | 'HYPO_INSULIN'
  | 'PATTERN_MEAL_CASE'
  | 'PATTERN_INSULIN'
  | 'MEMORY_CURRENT';

export interface EvidenceSelectionInput {
  task_type: string;
  request_kind?: 'DIRECT_RESPONSE' | 'ANALYSIS_REQUEST';
  asks_why?: boolean;
  asks_for_exact_sequence?: boolean;
  requires_exact_local_evidence?: boolean;
  references_event?: boolean;
  references_meal?: boolean;
  references_insulin?: boolean;
  references_activity?: boolean;
  references_pattern?: boolean;
  references_historical_cases?: boolean;
  references_memory?: boolean;
  range_profile?: 'SINGLE_DAY' | 'SHORT_RANGE' | 'MEDIUM_RANGE' | 'LONG_RANGE' | 'EXTENDED_RANGE';
  user_message_text?: string;
}

export interface EvidenceFamilyDefinition {
  semantic_purpose: string;
  default_level: EvidenceLevel;
  role_by_default: EvidenceRole;
}

export interface RelationshipDefinition {
  status: RelationshipStatus;
  required_families: readonly EvidenceFamily[];
  note: string;
}

export interface EvidenceSelectionBundle {
  policy_version: 'evidence-selection-policy.v1';
  task_type: string;
  selection_profile:
    | 'CONVERSATION_DIRECT_RESPONSE'
    | 'CONVERSATION_TIME_RANGE_ANALYSIS'
    | 'ANALYSIS_FOLLOW_UP'
    | 'MEAL_ANALYSIS'
    | 'PATTERN_REEVALUATE'
    | 'MEMORY_REEVALUATE'
    | 'RECOMMENDATION_GENERATION';
  selection_mode: EvidenceSelectionMode;
  requested_level: EvidenceLevel;
  effective_level: EvidenceLevel;
  decision_state: SelectionState;
  required: readonly EvidenceFamily[];
  optional: readonly EvidenceFamily[];
  excluded_by_default: readonly EvidenceFamily[];
  relationship_requirements: readonly RelationshipContract[];
  family_states: Partial<Record<EvidenceFamily, SelectionState>>;
  unresolved_reasons: readonly string[];
  escalation_conditions: readonly string[];
  max_safe_detail: EvidenceLevel;
  rationale: string;
  replay_metadata_minimum: readonly string[];
  material_input_hash: string;
}

export const EVIDENCE_FAMILY_DEFINITIONS: Record<EvidenceFamily, EvidenceFamilyDefinition> = {
  CURRENT_STATE: {
    semantic_purpose: 'Current patient state and trend snapshot.',
    default_level: 'L1',
    role_by_default: 'REQUIRED',
  },
  GLUCOSE_SUMMARY: {
    semantic_purpose: 'Summary-level glucose behavior for selected range.',
    default_level: 'L1',
    role_by_default: 'REQUIRED',
  },
  GLUCOSE_DETAIL: {
    semantic_purpose: 'Dense local glucose sequence for exact reconstruction.',
    default_level: 'L3',
    role_by_default: 'OPTIONAL',
  },
  INSULIN_SUMMARY: {
    semantic_purpose: 'Summary of insulin timing and counts.',
    default_level: 'L1',
    role_by_default: 'OPTIONAL',
  },
  INSULIN_DETAIL: {
    semantic_purpose: 'Local insulin event detail selected by deterministic relationship eligibility.',
    default_level: 'L3',
    role_by_default: 'OPTIONAL',
  },
  MEAL_SUMMARY: {
    semantic_purpose: 'Summary-level meal context.',
    default_level: 'L1',
    role_by_default: 'OPTIONAL',
  },
  MEAL_DETAIL: {
    semantic_purpose: 'Meal-case detail for local meal reconstruction.',
    default_level: 'L3',
    role_by_default: 'OPTIONAL',
  },
  ACTIVITY_SUMMARY: {
    semantic_purpose: 'Summary-level activity evidence.',
    default_level: 'L1',
    role_by_default: 'OPTIONAL',
  },
  ACTIVITY_DETAIL: {
    semantic_purpose: 'Local activity detail tied to a bounded task question.',
    default_level: 'L3',
    role_by_default: 'OPTIONAL',
  },
  HYPO_SUMMARY: {
    semantic_purpose: 'Hypo episode anchor summary evidence.',
    default_level: 'L1',
    role_by_default: 'OPTIONAL',
  },
  HYPO_DETAIL: {
    semantic_purpose: 'Hypo event-level local detail.',
    default_level: 'L3',
    role_by_default: 'OPTIONAL',
  },
  RANGE_FACTS: {
    semantic_purpose: 'Range-level semantic facts selected for explanation.',
    default_level: 'L1',
    role_by_default: 'REQUIRED_IF_AVAILABLE',
  },
  PATTERN_EVIDENCE: {
    semantic_purpose: 'Pattern-engine evidence references.',
    default_level: 'L2',
    role_by_default: 'OPTIONAL',
  },
  HISTORICAL_EVIDENCE: {
    semantic_purpose: 'Historical evidence references separated from current evidence.',
    default_level: 'L2',
    role_by_default: 'OPTIONAL',
  },
  MEMORY_EVIDENCE: {
    semantic_purpose: 'Memory applicability evidence with provenance.',
    default_level: 'L2',
    role_by_default: 'OPTIONAL',
  },
  SIGNIFICANT_PERIODS: {
    semantic_purpose: 'Selected significant periods requiring attention.',
    default_level: 'L2',
    role_by_default: 'OPTIONAL',
  },
  TARGETED_WINDOWS: {
    semantic_purpose: 'Deterministic local windows for exact evidence retrieval.',
    default_level: 'L3',
    role_by_default: 'OPTIONAL',
  },
  CONVERSATION_CONTEXT: {
    semantic_purpose: 'Conversation intent and scope.',
    default_level: 'L1',
    role_by_default: 'REQUIRED',
  },
  PROVENANCE: {
    semantic_purpose: 'Audit metadata; must not be dropped for budget reasons.',
    default_level: 'L4',
    role_by_default: 'REQUIRED',
  },
};

export const RELATIONSHIP_SEMANTICS: Record<RelationshipContract, RelationshipDefinition> = {
  MEAL_GLUCOSE: {
    status: 'PARTIAL',
    required_families: ['MEAL_SUMMARY', 'GLUCOSE_SUMMARY'],
    note: 'MealCase is authoritative as summary anchor, but universal meal-targeted glucose window semantics are not closed.',
  },
  HYPO_GLUCOSE: {
    status: 'CLOSED',
    required_families: ['HYPO_SUMMARY', 'GLUCOSE_SUMMARY'],
    note: 'Hypo episode anchor semantics are closed for retrieval.',
  },
  HYPO_INSULIN: {
    status: 'CLOSED',
    required_families: ['HYPO_SUMMARY', 'INSULIN_DETAIL'],
    note: 'Closed for observational retrieval eligibility only; no insulin causality claims and no TEMP_BASAL overlap precedence resolution.',
  },
  PATTERN_MEAL_CASE: {
    status: 'CLOSED',
    required_families: ['PATTERN_EVIDENCE', 'MEAL_SUMMARY'],
    note: 'Pattern support/counterexample linkage to meal cases is persisted and authoritative.',
  },
  PATTERN_INSULIN: {
    status: 'PARTIAL',
    required_families: ['PATTERN_EVIDENCE', 'INSULIN_SUMMARY'],
    note: 'Pattern-scoped insulin timing semantics exist but are not universal selection semantics.',
  },
  MEMORY_CURRENT: {
    status: 'PARTIAL',
    required_families: ['MEMORY_EVIDENCE', 'CURRENT_STATE'],
    note: 'Memory relevance is applicability-scoped and not universally current by default.',
  },
};

function uniqueFamilies(families: EvidenceFamily[]): EvidenceFamily[] {
  return [...new Set(families)];
}

function buildMaterialInputHash(input: EvidenceSelectionInput, profile: string): string {
  const ordered = {
    asks_for_exact_sequence: Boolean(input.asks_for_exact_sequence),
    asks_why: Boolean(input.asks_why),
    profile,
    range_profile: input.range_profile ?? null,
    references_activity: Boolean(input.references_activity),
    references_event: Boolean(input.references_event),
    references_historical_cases: Boolean(input.references_historical_cases),
    references_insulin: Boolean(input.references_insulin),
    references_meal: Boolean(input.references_meal),
    references_memory: Boolean(input.references_memory),
    references_pattern: Boolean(input.references_pattern),
    request_kind: input.request_kind ?? null,
    requires_exact_local_evidence: Boolean(input.requires_exact_local_evidence),
    task_type: String(input.task_type ?? '').trim(),
    user_message_text: input.user_message_text ?? null,
  };

  return `sha256:${createHash('sha256').update(JSON.stringify(ordered)).digest('hex')}`;
}

function isExactEvidenceRequested(input: EvidenceSelectionInput): boolean {
  return Boolean(
    input.asks_for_exact_sequence ||
      input.requires_exact_local_evidence ||
      (input.asks_why && input.references_event),
  );
}

function baseProfileFromTask(input: EvidenceSelectionInput): EvidenceSelectionBundle['selection_profile'] {
  const lowered = String(input.task_type ?? '').toLowerCase();

  if (input.request_kind === 'DIRECT_RESPONSE' || lowered.includes('direct_response') || lowered.includes('conversation.direct_response')) {
    return 'CONVERSATION_DIRECT_RESPONSE';
  }

  if (lowered.includes('analysis.follow_up') || lowered.includes('analysis_follow_up')) {
    return 'ANALYSIS_FOLLOW_UP';
  }

  if (lowered.includes('meal')) {
    return 'MEAL_ANALYSIS';
  }

  if (lowered.includes('pattern')) {
    return 'PATTERN_REEVALUATE';
  }

  if (lowered.includes('memory')) {
    return 'MEMORY_REEVALUATE';
  }

  if (lowered.includes('recommendation')) {
    return 'RECOMMENDATION_GENERATION';
  }

  if (input.request_kind === 'ANALYSIS_REQUEST' || lowered.includes('time_range') || lowered.includes('conversation.time_range_analysis')) {
    return 'CONVERSATION_TIME_RANGE_ANALYSIS';
  }

  if (input.references_meal) {
    return 'MEAL_ANALYSIS';
  }

  if (input.references_pattern) {
    return 'PATTERN_REEVALUATE';
  }

  if (input.references_memory) {
    return 'MEMORY_REEVALUATE';
  }

  return 'CONVERSATION_TIME_RANGE_ANALYSIS';
}


function defaultBundleForProfile(profile: EvidenceSelectionBundle['selection_profile']): Omit<EvidenceSelectionBundle, 'policy_version' | 'task_type' | 'material_input_hash'> {
  switch (profile) {
    case 'CONVERSATION_DIRECT_RESPONSE':
      return {
        selection_profile: profile,
        selection_mode: 'SUMMARY_ONLY',
        requested_level: 'L1',
        effective_level: 'L1',
        decision_state: 'AVAILABLE',
        required: ['CURRENT_STATE', 'CONVERSATION_CONTEXT', 'PROVENANCE'],
        optional: ['GLUCOSE_SUMMARY'],
        excluded_by_default: [
          'GLUCOSE_DETAIL',
          'INSULIN_DETAIL',
          'MEAL_DETAIL',
          'ACTIVITY_DETAIL',
          'PATTERN_EVIDENCE',
          'HISTORICAL_EVIDENCE',
          'MEMORY_EVIDENCE',
          'TARGETED_WINDOWS',
        ],
        relationship_requirements: [],
        family_states: {
          CURRENT_STATE: 'AVAILABLE',
          CONVERSATION_CONTEXT: 'AVAILABLE',
          PROVENANCE: 'AVAILABLE',
          GLUCOSE_SUMMARY: 'NOT_SELECTED',
        },
        unresolved_reasons: [],
        escalation_conditions: [
          'user question requires patient-specific evidence',
          'specific event/time window referenced',
          'exact local sequence required',
        ],
        max_safe_detail: 'L1',
        rationale: 'Direct response stays non-analytical by default and only escalates when user intent requires patient-specific evidence.',
        replay_metadata_minimum: [
          'task_type',
          'policy_version',
          'selection_profile',
          'relationship_contract_version',
          'selected_evidence_refs',
          'omitted_refs',
          'unresolved_reason',
          'exclusion_refs',
          'provenance_refs',
          'deterministic_ordering_key',
          'material_input_hash',
        ],
      };

    case 'CONVERSATION_TIME_RANGE_ANALYSIS':
      return {
        selection_profile: profile,
        selection_mode: 'SUMMARY_PLUS_REFERENCES',
        requested_level: 'L1',
        effective_level: 'L1',
        decision_state: 'AVAILABLE',
        required: ['CURRENT_STATE', 'GLUCOSE_SUMMARY', 'RANGE_FACTS', 'PROVENANCE'],
        optional: ['MEAL_SUMMARY', 'INSULIN_SUMMARY', 'ACTIVITY_SUMMARY', 'SIGNIFICANT_PERIODS'],
        excluded_by_default: ['GLUCOSE_DETAIL', 'TARGETED_WINDOWS', 'INSULIN_DETAIL', 'MEAL_DETAIL', 'ACTIVITY_DETAIL'],
        relationship_requirements: ['MEAL_GLUCOSE'],
        family_states: {
          CURRENT_STATE: 'AVAILABLE',
          GLUCOSE_SUMMARY: 'AVAILABLE',
          RANGE_FACTS: 'AVAILABLE',
          MEAL_SUMMARY: 'PARTIAL',
          INSULIN_SUMMARY: 'PARTIAL',
        },
        unresolved_reasons: [],
        escalation_conditions: [
          'summary is ambiguous',
          'specific event requires local detail',
          'exact local sequence requested',
        ],
        max_safe_detail: 'L2',
        rationale: 'Range analysis stays summary-first and relationship-aware, without implicit local reconstruction.',
        replay_metadata_minimum: [
          'task_type',
          'policy_version',
          'selection_profile',
          'selected_evidence_refs',
          'omitted_refs',
          'exclusion_refs',
          'provenance_refs',
          'material_input_hash',
        ],
      };

    case 'ANALYSIS_FOLLOW_UP':
      return {
        selection_profile: profile,
        selection_mode: 'SUMMARY_PLUS_REFERENCES',
        requested_level: 'L1',
        effective_level: 'L1',
        decision_state: 'AVAILABLE',
        required: ['CURRENT_STATE', 'GLUCOSE_SUMMARY', 'PROVENANCE'],
        optional: ['RANGE_FACTS', 'INSULIN_SUMMARY', 'MEAL_SUMMARY'],
        excluded_by_default: ['GLUCOSE_DETAIL', 'INSULIN_DETAIL', 'MEAL_DETAIL', 'ACTIVITY_DETAIL', 'TARGETED_WINDOWS'],
        relationship_requirements: [],
        family_states: {
          CURRENT_STATE: 'AVAILABLE',
          GLUCOSE_SUMMARY: 'AVAILABLE',
        },
        unresolved_reasons: [],
        escalation_conditions: ['follow-up asks for exact local explanation'],
        max_safe_detail: 'L2',
        rationale: 'Follow-up analysis remains bounded unless a specific unresolved local sequence is requested.',
        replay_metadata_minimum: ['task_type', 'policy_version', 'selection_profile', 'selected_evidence_refs', 'material_input_hash'],
      };

    case 'MEAL_ANALYSIS':
      return {
        selection_profile: profile,
        selection_mode: 'SUMMARY_PLUS_REFERENCES',
        requested_level: 'L2',
        effective_level: 'L2',
        decision_state: 'PARTIAL',
        required: ['MEAL_SUMMARY', 'GLUCOSE_SUMMARY', 'PROVENANCE'],
        optional: ['INSULIN_SUMMARY', 'ACTIVITY_SUMMARY', 'SIGNIFICANT_PERIODS'],
        excluded_by_default: ['GLUCOSE_DETAIL', 'INSULIN_DETAIL', 'MEAL_DETAIL', 'ACTIVITY_DETAIL', 'TARGETED_WINDOWS'],
        relationship_requirements: ['MEAL_GLUCOSE'],
        family_states: {
          MEAL_SUMMARY: 'PARTIAL',
          GLUCOSE_SUMMARY: 'PARTIAL',
          INSULIN_SUMMARY: 'AVAILABLE',
        },
        unresolved_reasons: [],
        escalation_conditions: [
          'meal explanation requires exact local relationship evidence',
          'existing closed relationship/window contract is available',
        ],
        max_safe_detail: 'L2',
        rationale: 'Meal-glucose relationship remains partial, so summary-level selection is safe while universal targeted windows are not.',
        replay_metadata_minimum: [
          'task_type',
          'policy_version',
          'selection_profile',
          'relationship_contract_version',
          'anchor_identity',
          'selected_evidence_refs',
          'omitted_refs',
          'unresolved_reason',
          'material_input_hash',
        ],
      };

    case 'PATTERN_REEVALUATE':
      return {
        selection_profile: profile,
        selection_mode: 'SUMMARY_PLUS_REFERENCES',
        requested_level: 'L2',
        effective_level: 'L2',
        decision_state: 'AVAILABLE_WITH_RELATION',
        required: ['PATTERN_EVIDENCE', 'RANGE_FACTS', 'PROVENANCE'],
        optional: ['MEAL_SUMMARY', 'INSULIN_SUMMARY', 'HISTORICAL_EVIDENCE', 'MEMORY_EVIDENCE', 'SIGNIFICANT_PERIODS'],
        excluded_by_default: ['GLUCOSE_DETAIL', 'INSULIN_DETAIL', 'TARGETED_WINDOWS', 'MEAL_DETAIL'],
        relationship_requirements: ['PATTERN_MEAL_CASE', 'PATTERN_INSULIN'],
        family_states: {
          PATTERN_EVIDENCE: 'AVAILABLE_WITH_RELATION',
          MEAL_SUMMARY: 'AVAILABLE_WITH_RELATION',
          INSULIN_SUMMARY: 'PARTIAL',
        },
        unresolved_reasons: [],
        escalation_conditions: ['pattern comparison requires exact local reconstruction and relationship closure'],
        max_safe_detail: 'L2',
        rationale: 'Pattern-meal linkage is closed; pattern-insulin remains partial and should not force unrestricted detail retrieval.',
        replay_metadata_minimum: ['task_type', 'policy_version', 'selection_profile', 'selected_evidence_refs', 'omitted_refs', 'material_input_hash'],
      };

    case 'MEMORY_REEVALUATE':
      return {
        selection_profile: profile,
        selection_mode: 'SUMMARY_PLUS_REFERENCES',
        requested_level: 'L2',
        effective_level: 'L2',
        decision_state: 'PARTIAL',
        required: ['CURRENT_STATE', 'MEMORY_EVIDENCE', 'PROVENANCE'],
        optional: ['HISTORICAL_EVIDENCE', 'PATTERN_EVIDENCE', 'GLUCOSE_SUMMARY'],
        excluded_by_default: ['GLUCOSE_DETAIL', 'INSULIN_DETAIL', 'TARGETED_WINDOWS', 'MEAL_DETAIL', 'ACTIVITY_DETAIL'],
        relationship_requirements: ['MEMORY_CURRENT'],
        family_states: {
          CURRENT_STATE: 'AVAILABLE',
          MEMORY_EVIDENCE: 'PARTIAL',
        },
        unresolved_reasons: [],
        escalation_conditions: ['memory applicability must be proven for the current context'],
        max_safe_detail: 'L2',
        rationale: 'Memory evidence is constrained by applicability and remains partial for automatic selection.',
        replay_metadata_minimum: ['task_type', 'policy_version', 'selection_profile', 'selected_evidence_refs', 'unresolved_reason', 'material_input_hash'],
      };

    case 'RECOMMENDATION_GENERATION':
      return {
        selection_profile: profile,
        selection_mode: 'SUMMARY_PLUS_REFERENCES',
        requested_level: 'L2',
        effective_level: 'L2',
        decision_state: 'AVAILABLE',
        required: ['CURRENT_STATE', 'GLUCOSE_SUMMARY', 'INSULIN_SUMMARY', 'MEAL_SUMMARY', 'PROVENANCE'],
        optional: ['RANGE_FACTS', 'ACTIVITY_SUMMARY', 'SIGNIFICANT_PERIODS'],
        excluded_by_default: ['GLUCOSE_DETAIL', 'INSULIN_DETAIL', 'MEAL_DETAIL', 'ACTIVITY_DETAIL', 'TARGETED_WINDOWS'],
        relationship_requirements: ['MEAL_GLUCOSE'],
        family_states: {
          CURRENT_STATE: 'AVAILABLE',
          GLUCOSE_SUMMARY: 'AVAILABLE',
          INSULIN_SUMMARY: 'AVAILABLE',
          MEAL_SUMMARY: 'PARTIAL',
        },
        unresolved_reasons: [],
        escalation_conditions: ['recommendation logic explicitly requires exact local evidence and relationship closure'],
        max_safe_detail: 'L2',
        rationale: 'Recommendation generation remains summary-biased and relationship-safe unless exact local retrieval semantics are closed.',
        replay_metadata_minimum: ['task_type', 'policy_version', 'selection_profile', 'selected_evidence_refs', 'material_input_hash'],
      };
  }
}

export function selectEvidenceBundle(input: EvidenceSelectionInput): EvidenceSelectionBundle {
  const profile = baseProfileFromTask(input);
  const base = defaultBundleForProfile(profile);
  const exactRequested = isExactEvidenceRequested(input);

  let selection_mode = base.selection_mode;
  let effective_level = base.effective_level;
  let decision_state = base.decision_state;

  const required = [...base.required];
  const optional = [...base.optional];
  const excluded_by_default = [...base.excluded_by_default];
  const unresolved_reasons = [...base.unresolved_reasons];
  const family_states: Partial<Record<EvidenceFamily, SelectionState>> = { ...base.family_states };

  if (exactRequested && profile !== 'CONVERSATION_DIRECT_RESPONSE') {
    if (profile === 'MEAL_ANALYSIS') {
      // Meal->glucose remains PARTIAL, so exact universal targeted reconstruction stays unresolved.
      selection_mode = 'SUMMARY_PLUS_REFERENCES';
      effective_level = 'L2';
      decision_state = 'UNRESOLVED';
      unresolved_reasons.push(
        'Exact meal reconstruction requested but MEAL_GLUCOSE relationship remains PARTIAL with no universal closed targeted window contract.',
      );
      family_states.GLUCOSE_DETAIL = 'UNRESOLVED';
      family_states.TARGETED_WINDOWS = 'UNRESOLVED';
    } else {
      selection_mode = 'TARGETED_RECONSTRUCTION';
      effective_level = 'L3';
      decision_state = base.decision_state === 'PARTIAL' ? 'PARTIAL' : 'AVAILABLE';
      required.push('GLUCOSE_DETAIL', 'TARGETED_WINDOWS');
      family_states.GLUCOSE_DETAIL = 'AVAILABLE';
      family_states.TARGETED_WINDOWS = 'AVAILABLE';
    }
  }

  if (profile === 'CONVERSATION_DIRECT_RESPONSE') {
    if (input.references_event || input.references_meal || input.references_insulin) {
      family_states.GLUCOSE_SUMMARY = 'AVAILABLE';
    }
  }

  const bundle: EvidenceSelectionBundle = {
    policy_version: 'evidence-selection-policy.v1',
    task_type: String(input.task_type ?? '').trim(),
    selection_profile: base.selection_profile,
    selection_mode,
    requested_level: base.requested_level,
    effective_level,
    decision_state,
    required: uniqueFamilies(required),
    optional: uniqueFamilies(optional),
    excluded_by_default: uniqueFamilies(excluded_by_default),
    relationship_requirements: base.relationship_requirements,
    family_states,
    unresolved_reasons,
    escalation_conditions: base.escalation_conditions,
    max_safe_detail: base.max_safe_detail,
    rationale: base.rationale,
    replay_metadata_minimum: base.replay_metadata_minimum,
    material_input_hash: buildMaterialInputHash(input, base.selection_profile),
  };

  return bundle;
}

export function relationshipStatusFor(pair: RelationshipContract): RelationshipStatus {
  return RELATIONSHIP_SEMANTICS[pair]?.status ?? 'OPEN';
}

export function assertSelectionStateSemantics(state: SelectionState): string {
  const semantics: Record<SelectionState, string> = {
    AVAILABLE: 'Evidence can be deterministically selected.',
    AVAILABLE_WITH_RELATION: 'Evidence can be deterministically selected because a CLOSED relationship contract establishes eligibility.',
    PARTIAL: 'Some evidence is selectable, but richer relationship semantics are not fully closed.',
    UNRESOLVED: 'Task requires evidence that cannot be deterministically selected with current semantics.',
    NOT_SELECTED: 'Evidence exists but policy intentionally excludes it from the current delivery level.',
    EXCLUDED: 'Evidence is explicitly excluded by authoritative exclusion semantics.',
    MISSING: 'Expected evidence is unavailable.',
    UNKNOWN: 'The relevant fact cannot be established.',
  };

  return semantics[state];
}
