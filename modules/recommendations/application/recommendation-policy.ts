export type RecommendationV1Status = 'READY' | 'INSUFFICIENT_DATA' | 'NO_ACTIONABLE_RECOMMENDATION' | 'REJECTED' | 'ARCHIVED';
export type RecommendationV1Type = 'CLARIFY' | 'OBSERVE' | 'CONSIDER_ACTION' | 'NO_ACTION';

/**
 * The analyses a recommendation is derived from carry no question and no proposal (the hypo questions and the AI
 * proposal were removed), so the decision rests on the evidence alone and is always NO_ACTION. Rule names R3 and R7-R9
 * keep the numbering stored in recommendations.provenance.decision_rule.
 */
export type RecommendationDecisionInput = {
  analysisStatus: 'COMPLETED' | 'INSUFFICIENT_DATA' | string;
  facts: unknown[];
  uncertainty: Record<string, unknown> | null;
};

export type RecommendationDecision = {
  status: Extract<RecommendationV1Status, 'READY' | 'INSUFFICIENT_DATA' | 'NO_ACTIONABLE_RECOMMENDATION'>;
  recommendationType: Extract<RecommendationV1Type, 'NO_ACTION'>;
  rule: 'R3' | 'R7' | 'R8' | 'R9' | 'FALLBACK';
  meaningfulEvidence: boolean;
  unresolvedBlocker: boolean;
};

export function deriveRecommendationDecision(input: RecommendationDecisionInput): RecommendationDecision {
  const meaningfulEvidence = extractFactSourceRefs(input.facts).size > 0;
  const unresolvedBlocker = isUnresolvedBlocker({
    analysisStatus: input.analysisStatus,
    uncertainty: input.uncertainty,
    meaningfulEvidence,
  });

  const base = { recommendationType: 'NO_ACTION' as const, meaningfulEvidence, unresolvedBlocker };

  if (input.analysisStatus === 'INSUFFICIENT_DATA' && !meaningfulEvidence) {
    return { status: 'INSUFFICIENT_DATA', rule: 'R3', ...base };
  }

  if (input.analysisStatus === 'COMPLETED' && meaningfulEvidence && !unresolvedBlocker) {
    return { status: 'READY', rule: 'R7', ...base };
  }

  if (input.analysisStatus === 'COMPLETED' && !meaningfulEvidence) {
    return { status: 'INSUFFICIENT_DATA', rule: 'R8', ...base };
  }

  if (input.analysisStatus === 'COMPLETED' && meaningfulEvidence && unresolvedBlocker) {
    return { status: 'INSUFFICIENT_DATA', rule: 'R9', ...base };
  }

  return { status: 'NO_ACTIONABLE_RECOMMENDATION', rule: 'FALLBACK', ...base };
}

function extractFactSourceRefs(facts: unknown[]): Set<string> {
  const refs = new Set<string>();
  for (const fact of facts) {
    const sourceRefs = (fact as { source_refs?: unknown }).source_refs;
    if (!Array.isArray(sourceRefs)) {
      continue;
    }

    for (const sourceRef of sourceRefs) {
      if (typeof sourceRef === 'string' && sourceRef.length > 0) {
        refs.add(sourceRef);
      }
    }
  }

  return refs;
}

function isUnresolvedBlocker(args: {
  analysisStatus: string;
  uncertainty: Record<string, unknown> | null;
  meaningfulEvidence: boolean;
}): boolean {
  if (args.analysisStatus === 'INSUFFICIENT_DATA') {
    return true;
  }

  if (!args.meaningfulEvidence) {
    return true;
  }

  const explicitFlag = args.uncertainty?.material_unresolved_blocker;
  if (typeof explicitFlag === 'boolean') {
    return explicitFlag;
  }

  return false;
}
