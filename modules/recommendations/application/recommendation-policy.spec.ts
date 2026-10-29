import { describe, expect, it } from 'vitest';
import { deriveRecommendationDecision } from './recommendation-policy';

function completedBase() {
  return {
    analysisStatus: 'COMPLETED' as const,
    facts: [{ fact_id: 'f1', source_refs: ['evt-1'] }],
    uncertainty: { level: 'LOW', summary: 'bounded' },
  };
}

describe('Recommendation v1 deterministic policy', () => {
  it('R3: insufficient analysis with no meaningful evidence -> INSUFFICIENT_DATA', () => {
    const decision = deriveRecommendationDecision({
      ...completedBase(),
      analysisStatus: 'INSUFFICIENT_DATA',
      facts: [],
    });

    expect(decision.rule).toBe('R3');
    expect(decision.status).toBe('INSUFFICIENT_DATA');
    expect(decision.recommendationType).toBe('NO_ACTION');
  });

  it('R3: the time-range answer (no facts, material blocker) -> INSUFFICIENT_DATA', () => {
    const decision = deriveRecommendationDecision({
      analysisStatus: 'INSUFFICIENT_DATA',
      facts: [],
      uncertainty: { material_unresolved_blocker: true },
    });

    expect(decision).toEqual({ status: 'INSUFFICIENT_DATA', recommendationType: 'NO_ACTION', rule: 'R3', meaningfulEvidence: false, unresolvedBlocker: true });
  });

  it('R7: meaningful evidence and no blocker -> READY + NO_ACTION', () => {
    const decision = deriveRecommendationDecision(completedBase());

    expect(decision.rule).toBe('R7');
    expect(decision.status).toBe('READY');
    expect(decision.recommendationType).toBe('NO_ACTION');
  });

  it('R8: no meaningful evidence -> INSUFFICIENT_DATA', () => {
    const decision = deriveRecommendationDecision({
      ...completedBase(),
      facts: [],
    });

    expect(decision.rule).toBe('R8');
    expect(decision.status).toBe('INSUFFICIENT_DATA');
  });

  it('R8: facts without source refs are no meaningful evidence', () => {
    const decision = deriveRecommendationDecision({
      ...completedBase(),
      facts: [{ fact_id: 'f1', source_refs: [''] }, { fact_id: 'f2' }],
    });

    expect(decision.rule).toBe('R8');
    expect(decision.meaningfulEvidence).toBe(false);
  });

  it('R9: meaningful evidence with explicit unresolved blocker -> INSUFFICIENT_DATA', () => {
    const decision = deriveRecommendationDecision({
      ...completedBase(),
      uncertainty: { level: 'HIGH', summary: 'material unknown', material_unresolved_blocker: true },
    });

    expect(decision.rule).toBe('R9');
    expect(decision.status).toBe('INSUFFICIENT_DATA');
  });

  it('identical input produces identical type/status', () => {
    const input = completedBase();

    const left = deriveRecommendationDecision(input);
    const right = deriveRecommendationDecision(input);

    expect(left).toEqual(right);
  });

  it('defensive fallback returns NO_ACTIONABLE_RECOMMENDATION + NO_ACTION', () => {
    const decision = deriveRecommendationDecision({
      ...completedBase(),
      analysisStatus: 'ARCHIVED',
      uncertainty: { level: 'LOW', summary: 'not applicable' },
    });

    expect(decision.rule).toBe('FALLBACK');
    expect(decision.status).toBe('NO_ACTIONABLE_RECOMMENDATION');
    expect(decision.recommendationType).toBe('NO_ACTION');
  });

  it('an insufficient analysis that still has evidence falls back to NO_ACTIONABLE_RECOMMENDATION', () => {
    const decision = deriveRecommendationDecision({ ...completedBase(), analysisStatus: 'INSUFFICIENT_DATA' });

    expect(decision.rule).toBe('FALLBACK');
    expect(decision.status).toBe('NO_ACTIONABLE_RECOMMENDATION');
  });
});
