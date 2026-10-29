export type EvidenceLevel = 'L1' | 'L2' | 'L3' | 'L4';
export type EvidenceProfileId =
  | 'DIRECT_RESPONSE'
  | 'CURRENT_STATE'
  | 'GENERAL_TIME_RANGE_ANALYSIS'
  | 'EVENT_INVESTIGATION'
  | 'MEAL_ANALYSIS'
  | 'PATTERN_ANALYSIS'
  | 'HISTORICAL_COMPARISON';

export type EvidenceSectionRole =
  | 'REQUIRED'
  | 'OPTIONAL'
  | 'NOT_APPLICABLE'
  | 'L2_ONLY'
  | 'L3_ONLY'
  | 'PROHIBITED';

export type RangeSelectionProfileId = 'SINGLE_DAY' | 'SHORT_RANGE' | 'MEDIUM_RANGE' | 'LONG_RANGE' | 'EXTENDED_RANGE';

export interface TaskEvidenceSelectionInput {
  task_type: string;
  request_type?: 'DIRECT_RESPONSE' | 'ANALYSIS_REQUEST' | 'INVESTIGATION_REQUIRED';
  range_profile?: RangeSelectionProfileId;
  asks_why?: boolean;
  event_reference?: boolean;
  meal_reference?: boolean;
  pattern_reference?: boolean;
  historical_reference?: boolean;
  asks_for_current_state?: boolean;
  requires_exact_trajectory?: boolean;
  requires_local_reconstruction?: boolean;
  memory_relevant?: boolean;
  user_message_text?: string;
}

export interface EvidenceProfileDecision {
  policy_version: 'task-evidence-policy.v1';
  evidence_profile: EvidenceProfileId;
  default_level: EvidenceLevel;
  required_sections: readonly string[];
  optional_sections: readonly string[];
  l2_eligibility: readonly string[];
  l3_eligibility: readonly string[];
  escalation_conditions: readonly string[];
  soft_token_target: string;
  operational_ceiling: string;
  forbidden_sections: readonly string[];
  rationale: string;
}

export const TASK_EVIDENCE_POLICY_VERSION = 'task-evidence-policy.v1' as const;

export const TASK_TO_PROFILE_MAP_V1: Record<string, EvidenceProfileId> = {
  CONVERSATION_DIRECT_RESPONSE: 'DIRECT_RESPONSE',
  conversation_direct_response: 'DIRECT_RESPONSE',
  'conversation.direct_response': 'DIRECT_RESPONSE',
  CONVERSATION_TIME_RANGE_ANALYSIS: 'GENERAL_TIME_RANGE_ANALYSIS',
  conversation_time_range_analysis: 'GENERAL_TIME_RANGE_ANALYSIS',
  'conversation.time_range_analysis': 'GENERAL_TIME_RANGE_ANALYSIS',
  analysis_follow_up: 'CURRENT_STATE',
  'analysis.follow_up': 'CURRENT_STATE',
  triggering_hypo_detection: 'EVENT_INVESTIGATION',
  'triggering.hypo_detection': 'EVENT_INVESTIGATION',
  direct_response: 'DIRECT_RESPONSE',
  analysis_request: 'GENERAL_TIME_RANGE_ANALYSIS',
};

export const TASK_EVIDENCE_PROFILES_V1: Record<EvidenceProfileId, Omit<EvidenceProfileDecision, 'policy_version' | 'evidence_profile'>> = {
  DIRECT_RESPONSE: {
    default_level: 'L1',
    required_sections: ['current_state', 'current_trend', 'data_quality'],
    optional_sections: ['recent_glucose_summary'],
    l2_eligibility: ['specific_period_ref'],
    l3_eligibility: ['local_window_around_user_reference'],
    escalation_conditions: ['user asks why', 'user references a specific event or period', 'current state is ambiguous'],
    soft_token_target: '~100-500 tokens',
    operational_ceiling: '~1k tokens unless a narrow explanation requires more context',
    forbidden_sections: ['full_day_glucose_events', 'full_day_insulin_events', 'raw_event_dump', 'full_history'],
    rationale: 'Direct-response questions should only receive the current state and the minimum context required to answer a short factual question.',
  },
  CURRENT_STATE: {
    default_level: 'L1',
    required_sections: ['current_state', 'current_trend', 'recent_glucose_summary', 'data_quality'],
    optional_sections: ['recent_hypo_summary'],
    l2_eligibility: ['recent_significant_period_ref'],
    l3_eligibility: ['local_window_around_recent_inflection'],
    escalation_conditions: ['trend requires local event reconstruction', 'recent glucose change is ambiguous', 'user asks what caused the current condition'],
    soft_token_target: '~300-1k tokens',
    operational_ceiling: '~3k tokens for a narrow local interpretation',
    forbidden_sections: ['full_day_raw_events', 'full_history_as_current_context'],
    rationale: 'Current-state analysis does not require a full-day raw stream; it only needs current status and a bounded local explanation context.',
  },
  GENERAL_TIME_RANGE_ANALYSIS: {
    default_level: 'L1',
    required_sections: ['current_state', 'glucose_summary', 'insulin_summary', 'meal_summary', 'data_quality', 'significant_period_refs'],
    optional_sections: ['activity_summary', 'hypo_summary', 'historical_context_summary'],
    l2_eligibility: ['significant_periods', 'major_excursion_anchor', 'hypo_anchor', 'meal_anchor'],
    l3_eligibility: ['targeted_event_window', 'episode_reconstruction_window'],
    escalation_conditions: ['summary contains unresolved evidence', 'user asks why a period behaved as it did', 'specific event explanation is requested'],
    soft_token_target: '~1k-5k tokens',
    operational_ceiling: '~8k-15k tokens for an unusually complex day or range',
    forbidden_sections: ['raw_event_dump', 'full_day_insulin_stream_when_summary_is_sufficient', 'full_history_without_task_need'],
    rationale: 'General time-range analysis should start with a summary and only add anchors or local windows when the question becomes event-specific.',
  },
  EVENT_INVESTIGATION: {
    default_level: 'L2',
    required_sections: ['current_state', 'glucose_summary', 'hypo_summary', 'event_window_summary', 'significant_period_refs'],
    optional_sections: ['insulin_summary', 'meal_summary', 'activity_summary'],
    l2_eligibility: ['event_anchor', 'hypo_anchor', 'meal_anchor', 'relevant_recent_period'],
    l3_eligibility: ['exact_glucose_trajectory', 'meal_insulin_glucose_window', 'local_hypo_reconstruction_window'],
    escalation_conditions: ['user asks why', 'specific event time is referenced', 'exact local trajectory is needed', 'insulin-meal-glucose relationship requires reconstruction'],
    soft_token_target: '~2k-8k tokens',
    operational_ceiling: '~10k tokens for a single difficult episode cluster',
    forbidden_sections: ['full_day_raw_events', 'irrelevant_contemporaneous_events'],
    rationale: 'Event investigation should begin at the semantically relevant event anchor rather than send the whole day as context.',
  },
  MEAL_ANALYSIS: {
    default_level: 'L2',
    required_sections: ['meal_summary', 'meal_case_refs', 'recent_glucose_summary', 'insulin_summary'],
    optional_sections: ['activity_summary', 'current_state'],
    l2_eligibility: ['meal_anchor', 'post_meal_glucose_window', 'relevant_insulin_events'],
    l3_eligibility: ['meal_reconstruction_window', 'meal_plus_insulin_plus_glucose_detail'],
    escalation_conditions: ['meal response is unclear', 'user asks why a meal caused a spike or low', 'exact meal timing matters'],
    soft_token_target: '~1k-5k tokens',
    operational_ceiling: '~8k tokens for a meal with multiple associated events',
    forbidden_sections: ['all_meals_in_the_day_when_only_one_meal_is_relevant', 'unrelated_history'],
    rationale: 'Meal analysis requires a meal anchor and minimal surrounding glucose/insulin context, not the whole raw day.',
  },
  PATTERN_ANALYSIS: {
    default_level: 'L1',
    required_sections: ['pattern_summary', 'range_summary', 'coverage_quality', 'significant_period_refs'],
    optional_sections: ['historical_context_summary', 'memory_summary'],
    l2_eligibility: ['pattern_period_anchor', 'repeated_event_anchor'],
    l3_eligibility: ['pattern_reconstruction_window', 'comparison_window'],
    escalation_conditions: ['pattern needs repeated-window comparison', 'user asks for causal explanation of a recurring pattern', 'macro pattern requires exact event alignment'],
    soft_token_target: '~3k-15k tokens',
    operational_ceiling: 'task-justified, not hard-coded; larger only when the pattern question truly requires it',
    forbidden_sections: ['raw_history_dump', 'pattern_evidence_without_pattern_context'],
    rationale: 'Pattern questions should compare a compact pattern summary and selected windows, not flood the model with raw historical events.',
  },
  HISTORICAL_COMPARISON: {
    default_level: 'L1',
    required_sections: ['current_summary', 'historical_summary', 'data_quality', 'comparison_anchor_refs'],
    optional_sections: ['historical_context_summary', 'memory_summary'],
    l2_eligibility: ['comparison_significant_periods', 'anchor_comparison'],
    l3_eligibility: ['exact_temporal_comparison_window'],
    escalation_conditions: ['comparison requires exact temporal alignment', 'user asks why one period differs from another'],
    soft_token_target: '~2k-10k tokens',
    operational_ceiling: '~15k tokens for a carefully bounded multi-range comparison',
    forbidden_sections: ['treating_historical_events_as_current_events', 'full_raw_history_without_comparison_need'],
    rationale: 'Historical comparison should compare compact summaries first and only escalate to exact windows when the question requires difference analysis.',
  },
};

export function selectTaskEvidenceProfile(input: TaskEvidenceSelectionInput): EvidenceProfileDecision {
  const taskType = String(input.task_type ?? '').trim();
  const directOverride = input.request_type === 'DIRECT_RESPONSE' || /direct[_ -]?response/i.test(taskType) || /direct_response/i.test(taskType);
  const currentStateIntent = input.asks_for_current_state || /current[_ -]?state/i.test(taskType) || /trend/i.test(taskType) || /current/i.test(input.user_message_text ?? '');
  const eventIntent = input.event_reference || input.asks_why || /hypo|why|dlaczego|spadek|drop|event/i.test(taskType) || /dlaczego|spadek|hipo|przyczyna|co si|what happened/i.test(input.user_message_text ?? '');
  const mealIntent = input.meal_reference || /meal|posi|obiad|kolacja|breakfast|dinner|meal/i.test(taskType) || /posi|obiad|kolacja|sniadanie|meal/i.test(input.user_message_text ?? '');
  const patternIntent = input.pattern_reference || /pattern|wzorzec|repeated|powtarz|trend|habit/i.test(taskType) || /wzorzec|powtarz|habit|pattern/i.test(input.user_message_text ?? '');
  const historicalIntent = input.historical_reference || /historical|history|compare|porown|wczoraj|ostatnie|last|comparison/i.test(taskType) || /porown|wczoraj|ostatnie|compare|history/i.test(input.user_message_text ?? '');

  let profile: EvidenceProfileId = TASK_TO_PROFILE_MAP_V1[taskType] ?? 'GENERAL_TIME_RANGE_ANALYSIS';

  if (directOverride) {
    profile = 'DIRECT_RESPONSE';
  } else if (currentStateIntent && !eventIntent && !mealIntent && !patternIntent && !historicalIntent) {
    profile = 'CURRENT_STATE';
  } else if (eventIntent) {
    profile = 'EVENT_INVESTIGATION';
  } else if (mealIntent) {
    profile = 'MEAL_ANALYSIS';
  } else if (patternIntent) {
    profile = 'PATTERN_ANALYSIS';
  } else if (historicalIntent) {
    profile = 'HISTORICAL_COMPARISON';
  } else if (taskType.includes('TIME_RANGE') || taskType.includes('time_range') || input.range_profile) {
    profile = 'GENERAL_TIME_RANGE_ANALYSIS';
  }

  const basePolicy = TASK_EVIDENCE_PROFILES_V1[profile];
  const policy = {
    ...basePolicy,
    required_sections: [...basePolicy.required_sections],
    optional_sections: [...basePolicy.optional_sections],
    l2_eligibility: [...basePolicy.l2_eligibility],
    l3_eligibility: [...basePolicy.l3_eligibility],
    escalation_conditions: [...basePolicy.escalation_conditions],
    forbidden_sections: [...basePolicy.forbidden_sections],
  };

  if (input.requires_exact_trajectory || input.requires_local_reconstruction) {
    policy.l3_eligibility = ['exact_glucose_trajectory', 'exact_temporal_reconstruction'];
  }

  return {
    policy_version: TASK_EVIDENCE_POLICY_VERSION,
    evidence_profile: profile,
    default_level: policy.default_level,
    required_sections: policy.required_sections,
    optional_sections: policy.optional_sections,
    l2_eligibility: policy.l2_eligibility,
    l3_eligibility: policy.l3_eligibility,
    escalation_conditions: policy.escalation_conditions,
    soft_token_target: policy.soft_token_target,
    operational_ceiling: policy.operational_ceiling,
    forbidden_sections: policy.forbidden_sections,
    rationale: policy.rationale,
  };
}

export function classifyEvidenceSectionRole(section: string, profile: EvidenceProfileId): EvidenceSectionRole {
  const map: Record<EvidenceProfileId, Record<string, EvidenceSectionRole>> = {
    DIRECT_RESPONSE: {
      current_state: 'REQUIRED',
      current_trend: 'REQUIRED',
      data_quality: 'REQUIRED',
      recent_glucose_summary: 'OPTIONAL',
      full_day_glucose_events: 'PROHIBITED',
      full_history: 'PROHIBITED',
      full_day_insulin_events: 'PROHIBITED',
    },
    CURRENT_STATE: {
      current_state: 'REQUIRED',
      current_trend: 'REQUIRED',
      recent_glucose_summary: 'REQUIRED',
      data_quality: 'REQUIRED',
      recent_hypo_summary: 'OPTIONAL',
      full_day_raw_events: 'PROHIBITED',
    },
    GENERAL_TIME_RANGE_ANALYSIS: {
      current_state: 'REQUIRED',
      glucose_summary: 'REQUIRED',
      insulin_summary: 'REQUIRED',
      meal_summary: 'REQUIRED',
      data_quality: 'REQUIRED',
      significant_period_refs: 'REQUIRED',
      activity_summary: 'OPTIONAL',
      hypo_summary: 'OPTIONAL',
      historical_context_summary: 'OPTIONAL',
      raw_event_dump: 'PROHIBITED',
    },
    EVENT_INVESTIGATION: {
      current_state: 'REQUIRED',
      glucose_summary: 'REQUIRED',
      hypo_summary: 'REQUIRED',
      event_window_summary: 'REQUIRED',
      significant_period_refs: 'REQUIRED',
      insulin_summary: 'OPTIONAL',
      meal_summary: 'OPTIONAL',
      activity_summary: 'OPTIONAL',
      full_day_raw_events: 'PROHIBITED',
      irrelevant_contemporaneous_events: 'PROHIBITED',
    },
    MEAL_ANALYSIS: {
      meal_summary: 'REQUIRED',
      meal_case_refs: 'REQUIRED',
      recent_glucose_summary: 'REQUIRED',
      insulin_summary: 'REQUIRED',
      activity_summary: 'OPTIONAL',
      current_state: 'OPTIONAL',
      all_meals_in_the_day_when_only_one_meal_is_relevant: 'PROHIBITED',
      unrelated_history: 'PROHIBITED',
    },
    PATTERN_ANALYSIS: {
      pattern_summary: 'REQUIRED',
      range_summary: 'REQUIRED',
      coverage_quality: 'REQUIRED',
      significant_period_refs: 'REQUIRED',
      historical_context_summary: 'OPTIONAL',
      memory_summary: 'OPTIONAL',
      raw_history_dump: 'PROHIBITED',
    },
    HISTORICAL_COMPARISON: {
      current_summary: 'REQUIRED',
      historical_summary: 'REQUIRED',
      data_quality: 'REQUIRED',
      comparison_anchor_refs: 'REQUIRED',
      historical_context_summary: 'OPTIONAL',
      memory_summary: 'OPTIONAL',
      treating_historical_events_as_current_events: 'PROHIBITED',
      full_raw_history_without_comparison_need: 'PROHIBITED',
    },
  };

  return map[profile][section] ?? 'NOT_APPLICABLE';
}

export function assertUnknownMissingSemantics(value: 'KNOWN' | 'UNKNOWN' | 'MISSING' | 'EXCLUDED' | 'NOT_SELECTED'): string {
  const semantics: Record<string, string> = {
    KNOWN: 'source evidence exists and is selected for task use',
    UNKNOWN: 'evidence state is genuinely unknown and must not be collapsed into a negative observation',
    MISSING: 'expected evidence is absent from the source and should not be misread as no event',
    EXCLUDED: 'evidence exists but was explicitly excluded by policy',
    NOT_SELECTED: 'evidence is not selected for this task; this is distinct from MISSING or ABSENT',
  };

  return semantics[value] ?? 'UNSPECIFIED';
}
