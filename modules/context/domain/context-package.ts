import { ConfidenceLevel } from '@shared/primitives/confidence';
import { UnknownValue } from '@shared/primitives/unknown';

// Value sets of the memory_evidence section stored in older packages (the memory engine itself is gone).
type MemoryFamily = 'PATIENT_FACT' | 'PATIENT_PREFERENCE' | 'RECURRING_CONTEXT' | 'CONFIRMED_BEHAVIOR';
type MemoryLifecycleStatus = 'CANDIDATE' | 'ACTIVE' | 'UNCERTAIN' | 'INVALIDATED' | 'ARCHIVED';
type MemoryKnowledgeStatus = 'KNOWN' | 'UNKNOWN' | 'MISSING';
type MemoryTemporalApplicability = 'CURRENT' | 'HISTORICAL' | 'FUTURE_APPLICABLE' | 'UNKNOWN';
type MemoryTherapyCompatibility = 'COMPATIBLE' | 'DIFFERENT' | 'UNKNOWN' | 'NOT_APPLICABLE';

export interface ContextPackageTask {
  /** Who the hypo-triggered package was built for; no AI task consumes this package shape any more. */
  task_type: string;
  prompt_version: string;
  output_schema_version: string;
}

export interface ContextPackageTrigger {
  trigger_id: string;
  trigger_type: 'HYPO_DETECTED';
  trigger_rule_version: string;
  created_at: string;
  source_event_id: string;
}

export interface ContextPackageHypoEpisode {
  episode_id: string;
  episode_state: 'OPEN' | 'CLOSED';
  episode_severity: 'L1' | 'L2';
  episode_started_at: string;
  episode_ended_at: string | UnknownValue;
  start_reading_id: string;
  latest_reading_id: string;
}

export interface ContextPackageGlucoseEvidence {
  reading_id: string;
  source_record_id: string;
  observed_at: string;
  recorded_at: string;
  glucose_value: number;
  glucose_unit: 'mg/dL';
  classification: 'NORMAL' | 'L1' | 'L2' | 'UNKNOWN';
  relation_to_episode: 'PRE_START' | 'START' | 'ONGOING' | 'LATEST';
  validity: 'VALID' | 'INVALID' | 'DUPLICATE' | 'UNKNOWN';
  provenance_ref: string;
}

export interface ContextPackageCurrentState {
  state_version: string;
  as_of: string;
  current_glucose: number | UnknownValue;
  trend: 'UP' | 'DOWN' | 'FLAT' | 'DOUBLE_UP' | 'DOUBLE_DOWN' | UnknownValue;
  glucose_rate_of_change: number | UnknownValue;
  iob: number | UnknownValue;
  recent_insulin: Array<{
    event_id: string;
    value: number;
    unit: 'U';
    kind: 'BOLUS' | 'BASAL' | 'TEMP_BASAL' | 'UNKNOWN';
    occurred_at: string;
  }>;
  recent_meal: null | { event_id: string; occurred_at: string; carbs: number | UnknownValue };
  recent_activity: null | { event_id: string; occurred_at: string; activity_type: string | UnknownValue };
  recent_sleep: null | { event_id: string; occurred_at: string };
  recent_illness: null | { event_id: string; occurred_at: string };
  active_therapy_ref: string;
}

export interface ContextPackageTherapy {
  therapy_id: string;
  therapy_version: string;
  active_profile_id: string;
  basal_schedule: Record<string, unknown> | UnknownValue;
  icr_schedule: Record<string, unknown> | UnknownValue;
  isf_schedule: Record<string, unknown> | UnknownValue;
  target_schedule: Record<string, unknown> | UnknownValue;
  dia: number | UnknownValue;
  automation_mode: string | UnknownValue;
}

export interface ContextPackageConversationMessage {
  message_id: string;
  role: 'SYSTEM' | 'USER' | 'ASSISTANT';
  created_at: string;
  content: string;
  provenance_ref: string;
  message_type?: 'CONTEXT_QUESTION' | 'CONTEXT_ANSWER' | 'ANALYSIS_SUMMARY' | 'RECOMMENDATION' | 'OTHER';
  answer?: {
    type: 'YES' | 'NO' | 'UNKNOWN' | 'TEXT';
    text?: string | null;
    value?: boolean | null;
  };
}

export interface ContextPackageConversationContext {
  thread_id: string;
  thread_state_version: string;
  messages: ContextPackageConversationMessage[];
  awaiting_user_answer: boolean;
}

export interface ContextPackageProvenance {
  trigger_id: string;
  source_event_id: string;
  source_record_ids: string[];
  current_state_version: string;
  therapy_version: string;
  conversation_thread_version: string;
  pattern_selection_policy_version?: string;
  memory_selection_policy_version?: string;
}

export interface ContextPackageEventContextFact {
  fact_key: string;
  fact_name: string;
  fact_type: string;
  scope: 'EVENT';
  value: unknown;
  value_type: string;
  knowledge_status: 'KNOWN' | 'UNKNOWN' | 'INSUFFICIENT' | 'STALE' | 'CONTRADICTED';
  validity: 'VALID' | 'INVALID' | 'STALE' | 'CONTRADICTED';
  confidence: ConfidenceLevel;
  status: 'ACTIVE' | 'SUPERSEDED' | 'REJECTED' | 'ARCHIVED' | 'INACTIVE';
  source: {
    source_type: string;
    source_ref: string;
    source_event_id: string;
    source_conversation_id: string;
    source_question_id: string;
    related_episode_id: string | null;
    related_trigger_id: string | null;
    observed_at: string;
    recorded_at: string;
  };
}

export interface CurrentEvidenceSection {
  task: ContextPackageTask;
  trigger: ContextPackageTrigger;
  hypo_episode: ContextPackageHypoEpisode;
  glucose_evidence: ContextPackageGlucoseEvidence[];
  current_state_snapshot: ContextPackageCurrentState;
  active_therapy_snapshot: ContextPackageTherapy;
  conversation_context: ContextPackageConversationContext;
  event_context_facts: ContextPackageEventContextFact[];
}

export interface ContextSelectionPolicy {
  task_bounded: true;
  episode_bounded: true;
  thread_bounded: true;
  no_memory: boolean;
  no_knowledge: true;
  no_full_history: true;
}

export interface HistoricalEvidenceCaseRecord {
  case_reference?: Record<string, unknown>;
  dimension_assessment?: Array<Record<string, unknown>>;
  therapy_relevance?: Record<string, unknown>;
  temporal_relevance?: Record<string, unknown>;
  relevance_explanation?: Record<string, unknown>;
  key_differences?: Array<Record<string, unknown>>;
  unknown_or_missing_dimensions?: unknown[];
  selection_rationale?: Record<string, unknown>;
}

export type HistoricalContextRetrievalStatus = 'SUCCESS' | 'NO_KNOWLEDGE' | 'FAILED_RETRYABLE' | 'FAILED_TERMINAL' | 'UNKNOWN';

export interface HistoricalContextEvidence {
  historical_context_result_version: string;
  retrieval_run_id: string;
  retrieval_timestamp: string;
  selection_policy_version: string;
  current_reference_id: string;
  selected_cases: HistoricalEvidenceCaseRecord[];
  retrieval_status: HistoricalContextRetrievalStatus;
  freshness_status?: EvidenceFreshnessStatus;
  freshness_reason_code?: string;
  rejected_cases_audit?: Array<Record<string, unknown>>;
  provenance: {
    policy_version: string;
    retrieval_timestamp: string;
    retrieval_run_id: string;
  };
}

export interface PatternSelectionCandidate {
  pattern_id: string;
  patient_id: string;
  pattern_identity: string;
  pattern_family: string;
  pattern_semantic_version: number;
  lifecycle_status: 'ACTIVE' | 'CANDIDATE' | 'WEAKENED' | 'INVALIDATED' | 'ARCHIVED';
  summary: string;
  match_dimensions?: string[];
  material_differences?: string[];
  supporting_case_refs?: string[];
  counterexample_case_refs?: string[];
  therapy_compatibility: 'compatible' | 'different' | 'unknown';
  unknowns_and_missing?: string[];
  provenance?: Record<string, unknown>;
  supersedes_pattern_id?: string | null;
  superseded_by_pattern_id?: string | null;
}

export type EvidenceFreshnessStatus = 'CURRENT' | 'STALE' | 'UNKNOWN' | 'NOT_APPLICABLE' | 'PENDING_REFRESH' | 'FAILED_TO_REFRESH';

export interface PatternEvidenceSelectedPattern {
  pattern_id: string;
  patient_id: string;
  pattern_identity: string;
  pattern_family: string;
  pattern_semantic_version: number;
  lifecycle_status: PatternSelectionCandidate['lifecycle_status'];
  summary: string;
  match_dimensions: string[];
  material_differences: string[];
  supporting_case_refs: string[];
  counterexample_case_refs: string[];
  therapy_compatibility: PatternSelectionCandidate['therapy_compatibility'];
  unknowns_and_missing: string[];
  provenance: Record<string, unknown>;
  freshness_status?: EvidenceFreshnessStatus;
  freshness_reason_code?: string;
}

export interface PatternEvidenceSection {
  section_version: 'pattern-evidence.v1';
  selection_policy_version: string;
  selected_patterns: PatternEvidenceSelectedPattern[];
}

export interface MemoryEvidenceSelectedMemory {
  memory_id: string;
  patient_id: string;
  memory_identity: string;
  memory_family: MemoryFamily;
  semantic_version: number;
  lifecycle_status: MemoryLifecycleStatus;
  knowledge_status: MemoryKnowledgeStatus;
  claim: string;
  temporal_applicability: MemoryTemporalApplicability;
  therapy_compatibility: MemoryTherapyCompatibility;
  evidence_refs: string[];
  contradiction_refs: string[];
  provenance: Record<string, unknown>;
  freshness_status?: EvidenceFreshnessStatus;
  freshness_reason_code?: string;
}

export interface MemoryEvidenceSection {
  section_version: 'memory-evidence.v1';
  selection_policy_version: string;
  selected_memories: MemoryEvidenceSelectedMemory[];
  selected_memory_count: number;
}

export type ContextPackageSourceVersions = {
  nightscout_sync_cursor: string;
  current_state_version: string;
  therapy_version: string;
  trigger_rule_version: string;
  conversation_thread_version: string;
  package_version: 'context-package.v1' | 'context-package.v2' | 'context-package.v3';
  pattern_selection_policy_version?: string;
  memory_selection_policy_version?: string;
};

export interface ContextPackageV1 {
  context_package_id: string;
  context_package_version: 'context-package.v1';
  content_hash: string;
  created_at: string;
  created_for_job_id: string;
  package_status: 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA';
  task: ContextPackageTask;
  patient_ref: {
    patient_id: string;
  };
  trigger: ContextPackageTrigger;
  hypo_episode: ContextPackageHypoEpisode;
  glucose_evidence: ContextPackageGlucoseEvidence[];
  current_state_snapshot: ContextPackageCurrentState;
  active_therapy_snapshot: ContextPackageTherapy;
  conversation_context: ContextPackageConversationContext;
  event_context_facts: ContextPackageEventContextFact[];
  current_evidence?: CurrentEvidenceSection | null;
  historical_evidence?: HistoricalContextEvidence | null;
  pattern_evidence?: never;
  provenance: ContextPackageProvenance;
  source_versions: ContextPackageSourceVersions;
  selection_policy: ContextSelectionPolicy;
}

export interface ContextPackageV2 extends Omit<ContextPackageV1, 'context_package_version' | 'pattern_evidence' | 'source_versions'> {
  context_package_version: 'context-package.v2';
  pattern_evidence?: PatternEvidenceSection | null;
  source_versions: ContextPackageSourceVersions;
}

export interface ContextPackageV3 extends Omit<ContextPackageV2, 'context_package_version' | 'source_versions'> {
  context_package_version: 'context-package.v3';
  pattern_evidence?: PatternEvidenceSection | null;
  memory_evidence?: MemoryEvidenceSection | null;
  source_versions: ContextPackageSourceVersions;
}

export type ContextPackageRecord = ContextPackageV1 | ContextPackageV2 | ContextPackageV3;
