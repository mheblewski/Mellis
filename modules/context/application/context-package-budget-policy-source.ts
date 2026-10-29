export type BudgetUnit = 'serialized_bytes';

export type ContextPackageSectionName =
  | 'task'
  | 'patient_ref'
  | 'trigger'
  | 'hypo_episode'
  | 'glucose_evidence'
  | 'current_evidence'
  | 'current_state_snapshot'
  | 'active_therapy_snapshot'
  | 'conversation_context'
  | 'event_context_facts'
  | 'historical_evidence'
  | 'pattern_evidence'
  | 'memory_evidence'
  | 'provenance'
  | 'source_versions'
  | 'selection_policy';

export type BudgetReductionStage =
  | 'CURRENT_EVIDENCE_DUPLICATE_GROUPING'
  | 'CONVERSATION_CONTEXT'
  | 'EVENT_CONTEXT_FACTS'
  | 'HISTORICAL_EVIDENCE_DETAIL'
  | 'HISTORICAL_EVIDENCE_CASE_COUNT'
  | 'PATTERN_EVIDENCE'
  | 'MEMORY_EVIDENCE'
  | 'PROVENANCE_COMPACTION'
  | 'OPTIONAL_METADATA_COMPACTION';

export interface ContextPackageBudgetSectionLimit {
  hard_max_bytes?: number;
  min_preserve_items?: number;
}

export interface ContextPackageBudgetPolicy {
  policy_version: string;
  budget_unit: BudgetUnit;
  global_limit_bytes: number;
  required_sections: ReadonlyArray<ContextPackageSectionName>;
  section_limits?: Partial<Record<ContextPackageSectionName, ContextPackageBudgetSectionLimit>>;
  reduction_order?: ReadonlyArray<BudgetReductionStage>;
}

/**
 * 'shadow' (the default) measures the AI-bound context against the budget without changing it; 'off' skips that.
 * There is no enforcing mode: nothing reduces a context package at runtime.
 */
export type ContextPackageBudgetPolicyMode = 'off' | 'shadow';

const DEFAULT_MODE: ContextPackageBudgetPolicyMode = 'shadow';

export interface ResolvedContextPackageBudgetPolicySource {
  mode: ContextPackageBudgetPolicyMode;
  policy: ContextPackageBudgetPolicy;
  runtime_is_shadow: boolean;
}

export type ContextPackageBudgetPolicySourceEnvironment = Record<string, string | undefined>;

export const REQUIRED_CONTEXT_PACKAGE_BUDGET_SECTIONS: ReadonlyArray<ContextPackageSectionName> = [
  'task',
  'patient_ref',
  'trigger',
  'hypo_episode',
  'glucose_evidence',
  'current_state_snapshot',
  'active_therapy_snapshot',
  'provenance',
  'source_versions',
  'selection_policy',
];

export const DEFAULT_CONTEXT_PACKAGE_BUDGET_REDUCTION_ORDER: ReadonlyArray<BudgetReductionStage> = [
  'CURRENT_EVIDENCE_DUPLICATE_GROUPING',
  'CONVERSATION_CONTEXT',
  'EVENT_CONTEXT_FACTS',
  'HISTORICAL_EVIDENCE_DETAIL',
  'HISTORICAL_EVIDENCE_CASE_COUNT',
  'PATTERN_EVIDENCE',
  'MEMORY_EVIDENCE',
  'PROVENANCE_COMPACTION',
  'OPTIONAL_METADATA_COMPACTION',
];

export const DEFAULT_CONTEXT_PACKAGE_BUDGET_POLICY: ContextPackageBudgetPolicy = {
  policy_version: 'context-package-budget-policy.v1',
  budget_unit: 'serialized_bytes',
  global_limit_bytes: Number.MAX_SAFE_INTEGER,
  required_sections: REQUIRED_CONTEXT_PACKAGE_BUDGET_SECTIONS,
  reduction_order: DEFAULT_CONTEXT_PACKAGE_BUDGET_REDUCTION_ORDER,
};

export class EnvironmentContextPackageBudgetPolicySource {
  constructor(private readonly env: ContextPackageBudgetPolicySourceEnvironment = {}) {}

  resolve(): ResolvedContextPackageBudgetPolicySource {
    const mode = normalizeMode(this.env.GLUCO_MIND_CONTEXT_BUDGET_MODE);
    const configuredGlobalLimit = normalizeGlobalLimit(this.env.GLUCO_MIND_CONTEXT_BUDGET_GLOBAL_LIMIT_BYTES);

    const policy: ContextPackageBudgetPolicy = {
      ...DEFAULT_CONTEXT_PACKAGE_BUDGET_POLICY,
      global_limit_bytes: configuredGlobalLimit,
    };

    return {
      mode,
      policy,
      runtime_is_shadow: mode === 'shadow',
    };
  }

  getMode(): ContextPackageBudgetPolicyMode {
    return this.resolve().mode;
  }

  getPolicy(): ContextPackageBudgetPolicy {
    return this.resolve().policy;
  }
}

/**
 * The configured mode; an unknown value (a typo, or the removed 'enforce') falls back to 'shadow' with a warning. It
 * used to throw, and the worker resolves the mode outside any try: one bad value failed every analysis.
 */
function normalizeMode(value: string | undefined): ContextPackageBudgetPolicyMode {
  if (value === undefined || value.trim().length === 0) {
    return DEFAULT_MODE;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'shadow') {
    return normalized;
  }

  console.warn(JSON.stringify({ event: 'context_budget_mode_unsupported', value, fallback: DEFAULT_MODE, supported: ['off', 'shadow'] }));
  return DEFAULT_MODE;
}

/** The configured global limit; unset or invalid (with a warning) means no limit. */
function normalizeGlobalLimit(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) {
    return Number.MAX_SAFE_INTEGER;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(JSON.stringify({ event: 'context_budget_global_limit_invalid', value, fallback: 'unlimited' }));
    return Number.MAX_SAFE_INTEGER;
  }

  return parsed;
}
