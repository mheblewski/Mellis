import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONTEXT_PACKAGE_BUDGET_POLICY,
  EnvironmentContextPackageBudgetPolicySource,
  type ContextPackageBudgetPolicyMode,
} from './context-package-budget-policy-source';

describe('ContextPackageBudgetPolicySource', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to shadow-safe mode with a non-enforcing budget policy', () => {
    const source = new EnvironmentContextPackageBudgetPolicySource({});
    const resolved = source.resolve();

    expect(resolved.mode).toBe('shadow');
    expect(resolved.runtime_is_shadow).toBe(true);
    expect(resolved.policy).toEqual(DEFAULT_CONTEXT_PACKAGE_BUDGET_POLICY);
    expect(resolved.policy.global_limit_bytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(resolved.policy.required_sections).toContain('provenance');
    expect(resolved.policy.reduction_order).toEqual([
      'CURRENT_EVIDENCE_DUPLICATE_GROUPING',
      'CONVERSATION_CONTEXT',
      'EVENT_CONTEXT_FACTS',
      'HISTORICAL_EVIDENCE_DETAIL',
      'HISTORICAL_EVIDENCE_CASE_COUNT',
      'PATTERN_EVIDENCE',
      'MEMORY_EVIDENCE',
      'PROVENANCE_COMPACTION',
      'OPTIONAL_METADATA_COMPACTION',
    ]);
  });

  it('accepts an explicit global limit from env', () => {
    const resolved = new EnvironmentContextPackageBudgetPolicySource({
      GLUCO_MIND_CONTEXT_BUDGET_MODE: ' Shadow ',
      GLUCO_MIND_CONTEXT_BUDGET_GLOBAL_LIMIT_BYTES: '512000',
    }).resolve();

    expect(resolved.mode).toBe('shadow');
    expect(resolved.policy.global_limit_bytes).toBe(512000);
  });

  it('falls back to shadow with a warning for an unsupported mode instead of failing every analysis', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const value of ['invalid-mode', 'enforce']) {
      const resolved = new EnvironmentContextPackageBudgetPolicySource({ GLUCO_MIND_CONTEXT_BUDGET_MODE: value }).resolve();
      expect(resolved.mode, value).toBe('shadow');
      expect(resolved.policy).toEqual(DEFAULT_CONTEXT_PACKAGE_BUDGET_POLICY);
    }
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('context_budget_mode_unsupported');
  });

  it('ignores an invalid global limit with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const resolved = new EnvironmentContextPackageBudgetPolicySource({ GLUCO_MIND_CONTEXT_BUDGET_GLOBAL_LIMIT_BYTES: '-5' }).resolve();
    expect(resolved.policy.global_limit_bytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('allows the off mode for explicit non-enforcement policy states', () => {
    const source = new EnvironmentContextPackageBudgetPolicySource({
      GLUCO_MIND_CONTEXT_BUDGET_MODE: 'off' as ContextPackageBudgetPolicyMode,
    });

    const resolved = source.resolve();
    expect(resolved.mode).toBe('off');
    expect(resolved.runtime_is_shadow).toBe(false);
  });
});
