export type EvidenceState = 'KNOWN' | 'UNKNOWN' | 'MISSING' | 'EXCLUDED' | 'NOT_SELECTED';

export interface GlucoseSemanticSummaryV1 {
  model_version: 'glucose-semantic-summary.v1';
  time_range: {
    start_at: string;
    end_at: string;
  };
  glucose_summary: {
    glucose_count: number;
    usable_glucose_count: number;
    unknown_count: number;
    missing_count: number;
    glucose_min: number | null;
    glucose_max: number | null;
    glucose_avg: number | null;
    coverage_status: 'HAS_USABLE_GLUCOSE_DATA' | 'PARTIAL_DATA' | 'NO_USABLE_GLUCOSE_DATA';
  };
  semantic_anchors: {
    hypo_episode_refs: string[];
    source_boundary_refs: string[];
    protected_event_refs: string[];
  };
  evidence_status: {
    glucose_data: EvidenceState;
    known_hypo_episodes: EvidenceState;
    excluded_evidence: 'NONE' | 'PRESENT' | 'UNKNOWN';
  };
  provenance: {
    source_refs: string[];
    derivation_policy_version: string;
    selection_policy_version: string;
  };
}

export interface DailyAnalyticalSummaryV1 {
  model_version: 'daily-analytical-summary.v1';
  time_range: {
    start_at: string;
    end_at: string;
  };
  glucose: Omit<GlucoseSemanticSummaryV1['glucose_summary'], 'glucose_count'> & {
    glucose_count: number;
  };
  insulin: {
    insulin_treatment_count: number;
    insulin_event_refs: string[];
    total_summary_available: boolean;
  };
  meals: {
    meal_count: number;
    meal_case_refs: string[];
    carbohydrate_total: number | null;
  };
  hypo: {
    hypo_episode_count: number;
    episode_refs: string[];
  };
  current_state: {
    current_glucose: number | 'UNKNOWN';
    trend: string | 'UNKNOWN';
    as_of: string | null;
  } | null;
  data_quality: {
    missing_sections: string[];
    excluded_sections: string[];
  };
  significant_period_refs: string[];
  provenance: {
    source_refs: string[];
    derivation_policy_version: string;
    selection_policy_version: string;
  };
}

export function buildGlucoseSemanticSummaryV1(input: {
  time_range: { start_at: string; end_at: string };
  glucose_events: Array<{ event_id?: string | null; source_record_id?: string | null; validity?: string | null; glucose_value?: number | string | null; }>; 
  hypo_episode_refs?: string[];
  source_boundary_refs?: string[];
  protected_event_refs?: string[];
  source_refs?: string[];
  derivation_policy_version?: string;
  selection_policy_version?: string;
  evidence_status?: Partial<GlucoseSemanticSummaryV1['evidence_status']>;
}): GlucoseSemanticSummaryV1 {
  const normalized = Array.isArray(input.glucose_events) ? input.glucose_events : [];
  // A reading of 0 or below is a sensor error, not a glucose value: left out of min/max/avg as TIR leaves it out
  // (computeGlucoseTimeInRange).
  const numericValues = normalized
    .map((event) => {
      const candidate = event.glucose_value;
      if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        const value = Number(candidate);
        if (Number.isFinite(value)) return value;
      }
      return null;
    })
    .filter((value): value is number => value !== null && value > 0);

  const unknownCount = normalized.filter((event) => {
    const value = String(event.glucose_value ?? '').trim().toUpperCase();
    const validity = String(event.validity ?? '').trim().toUpperCase();
    return value === 'UNKNOWN' || validity === 'UNKNOWN';
  }).length;

  const missingCount = normalized.filter((event) => {
    const value = String(event.glucose_value ?? '').trim().toUpperCase();
    const validity = String(event.validity ?? '').trim().toUpperCase();
    return value === 'MISSING' || validity === 'MISSING';
  }).length;

  const summary: {
    glucose_count: number;
    usable_glucose_count: number;
    unknown_count: number;
    missing_count: number;
    glucose_min: number | null;
    glucose_max: number | null;
    glucose_avg: number | null;
    coverage_status: 'HAS_USABLE_GLUCOSE_DATA' | 'PARTIAL_DATA' | 'NO_USABLE_GLUCOSE_DATA';
  } = {
    glucose_count: normalized.length,
    usable_glucose_count: numericValues.length,
    unknown_count: unknownCount,
    missing_count: missingCount,
    glucose_min: numericValues.length > 0 ? Math.min(...numericValues) : null,
    glucose_max: numericValues.length > 0 ? Math.max(...numericValues) : null,
    glucose_avg: numericValues.length > 0 ? Number((numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length).toFixed(2)) : null,
    coverage_status: numericValues.length > 0
      ? (unknownCount + missingCount > 0 ? 'PARTIAL_DATA' : 'HAS_USABLE_GLUCOSE_DATA')
      : 'NO_USABLE_GLUCOSE_DATA',
  };

  return {
    model_version: 'glucose-semantic-summary.v1',
    time_range: input.time_range,
    glucose_summary: summary,
    semantic_anchors: {
      hypo_episode_refs: Array.from(new Set((input.hypo_episode_refs ?? []).filter(Boolean))),
      source_boundary_refs: Array.from(new Set((input.source_boundary_refs ?? []).filter(Boolean))),
      protected_event_refs: Array.from(new Set((input.protected_event_refs ?? []).filter(Boolean))),
    },
    evidence_status: {
      glucose_data: input.evidence_status?.glucose_data ?? 'KNOWN',
      known_hypo_episodes: input.evidence_status?.known_hypo_episodes ?? 'KNOWN',
      excluded_evidence: input.evidence_status?.excluded_evidence ?? 'NONE',
    },
    provenance: {
      source_refs: Array.from(new Set((input.source_refs ?? []).filter(Boolean))),
      derivation_policy_version: input.derivation_policy_version ?? 'glucose-ai-evidence-view.v1',
      selection_policy_version: input.selection_policy_version ?? 'conversation-time-range-context-selection.v1',
    },
  };
}

export function buildDailyAnalyticalSummaryV1(input: {
  time_range: { start_at: string; end_at: string };
  glucose_summary: GlucoseSemanticSummaryV1['glucose_summary'];
  insulin_treatment_count: number;
  insulin_event_refs?: string[];
  meal_count: number;
  meal_case_refs?: string[];
  carbohydrate_total?: number | null;
  hypo_episode_count: number;
  episode_refs?: string[];
  current_state?: {
    current_glucose: number | 'UNKNOWN';
    trend: string | 'UNKNOWN';
    as_of: string | null;
  } | null;
  missing_sections?: string[];
  excluded_sections?: string[];
  significant_period_refs?: string[];
  source_refs?: string[];
  derivation_policy_version?: string;
  selection_policy_version?: string;
}): DailyAnalyticalSummaryV1 {
  return {
    model_version: 'daily-analytical-summary.v1',
    time_range: input.time_range,
    glucose: {
      glucose_count: input.glucose_summary.glucose_count,
      usable_glucose_count: input.glucose_summary.usable_glucose_count,
      unknown_count: input.glucose_summary.unknown_count,
      missing_count: input.glucose_summary.missing_count,
      glucose_min: input.glucose_summary.glucose_min,
      glucose_max: input.glucose_summary.glucose_max,
      glucose_avg: input.glucose_summary.glucose_avg,
      coverage_status: input.glucose_summary.coverage_status,
    },
    insulin: {
      insulin_treatment_count: input.insulin_treatment_count,
      insulin_event_refs: Array.from(new Set((input.insulin_event_refs ?? []).filter(Boolean))),
      total_summary_available: false,
    },
    meals: {
      meal_count: input.meal_count,
      meal_case_refs: Array.from(new Set((input.meal_case_refs ?? []).filter(Boolean))),
      carbohydrate_total: input.carbohydrate_total ?? null,
    },
    hypo: {
      hypo_episode_count: input.hypo_episode_count,
      episode_refs: Array.from(new Set((input.episode_refs ?? []).filter(Boolean))),
    },
    current_state: input.current_state ?? null,
    data_quality: {
      missing_sections: Array.from(new Set((input.missing_sections ?? []).filter(Boolean))),
      excluded_sections: Array.from(new Set((input.excluded_sections ?? []).filter(Boolean))),
    },
    significant_period_refs: Array.from(new Set((input.significant_period_refs ?? []).filter(Boolean))),
    provenance: {
      source_refs: Array.from(new Set((input.source_refs ?? []).filter(Boolean))),
      derivation_policy_version: input.derivation_policy_version ?? 'glucose-ai-evidence-view.v1',
      selection_policy_version: input.selection_policy_version ?? 'conversation-time-range-context-selection.v1',
    },
  };
}
