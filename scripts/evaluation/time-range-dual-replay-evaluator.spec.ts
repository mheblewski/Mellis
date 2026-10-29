import { describe, expect, it } from 'vitest';
import {
  buildAggregateRollup,
  calculateMetricReduction,
  evaluatePair,
  normalizeAssistantMessageMarkers,
  renderMarkdownSummary,
  stableHash,
} from './time-range-dual-replay-evaluator';
import type { CompactDeliveryArtifactV1 } from '@modules/context/application/compact-delivery-artifact';

function compactArtifactFixture(overrides?: Partial<CompactDeliveryArtifactV1>): CompactDeliveryArtifactV1 {
  const base: CompactDeliveryArtifactV1 = {
    artifact_version: 'compact-delivery-artifact.v1',
    task_identity: 'sha256:task',
    execution_identity: {
      task_id: 'task-1',
      task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
      task_version: 'conversation-time-range-analysis-task.v1',
      prompt_version: 'conversation-time-range-analysis.v1',
      output_schema_version: 'conversation-time-range-analysis-output.v1',
      model_policy_version: 'fake-provider-policy.v1',
      correlation_id: 'corr-1',
      patient_id: 'patient-1',
      trigger_id: null,
      analysis_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
    },
    context_package: {
      id: 'ctx-1',
      version: 'conversation-time-range-context.v1',
      hash: 'sha256:ctx',
    },
    policy: {
      task_evidence_policy_version: 'task-evidence-policy.v1',
      evidence_selection_policy_version: 'evidence-selection-policy.v1',
      evidence_relationship_semantics_version: 'evidence-relationship-semantics.v1',
      selection_profile: 'GENERAL_TIME_RANGE_ANALYSIS',
      selected_level: 'L1',
      default_level: 'L1',
      status: 'AVAILABLE',
    },
    selected_families: ['GLUCOSE_SUMMARY', 'PROVENANCE'],
    selected_payloads: [],
    selected_evidence_refs: [],
    omitted_families: [],
    family_decisions: [
      {
        family: 'ACTIVITY_SUMMARY',
        represented: false,
        selected: false,
        semantic_state: 'UNKNOWN',
        omission_reason_code: 'UNKNOWN',
        omission_reason: 'unknown',
        represented_by_selected_summary: false,
        retrievable_via_escalation: false,
        policy_allows_omission: true,
      },
      {
        family: 'MEAL_SUMMARY',
        represented: true,
        selected: true,
        semantic_state: 'AVAILABLE',
        omission_reason_code: null,
        omission_reason: null,
        represented_by_selected_summary: true,
        retrievable_via_escalation: false,
        policy_allows_omission: true,
      },
      {
        family: 'INSULIN_SUMMARY',
        represented: true,
        selected: true,
        semantic_state: 'AVAILABLE',
        omission_reason_code: null,
        omission_reason: null,
        represented_by_selected_summary: true,
        retrievable_via_escalation: false,
        policy_allows_omission: true,
      },
    ],
    relationship_decisions: [],
    unresolved_reasons: [],
    unknown_states: ['ACTIVITY_SUMMARY:UNKNOWN'],
    missing_states: [],
    excluded_states: [],
    not_selected_states: [],
    omitted_evidence_refs: [],
    provenance: {
      refs: [],
      count: 0,
      bytes: 0,
      deterministic_ordering_key: 'sha256:k',
    },
    deterministic_replay_metadata: {
      artifact_version: 'compact-delivery-artifact.v1',
      source_context_package_hash: 'sha256:ctx',
      source_context_package_version: 'conversation-time-range-context.v1',
      source_task_identity: 'sha256:task',
      selection_material_hash: 'sha256:sel',
      input_material_hash: 'sha256:in',
      policy_versions: {
        task_evidence_policy_version: 'task-evidence-policy.v1',
        evidence_selection_policy_version: 'evidence-selection-policy.v1',
        evidence_relationship_semantics_version: 'evidence-relationship-semantics.v1',
      },
    },
    artifact_content_hash: 'sha256:artifact',
    artifact_bytes: 1234,
  };

  return {
    ...base,
    ...overrides,
    family_decisions: overrides?.family_decisions ?? base.family_decisions,
  };
}

function basePairInput() {
  return {
    fullRange: { range_type: 'TODAY', range_start: '2026-10-07T00:00:00.000Z', range_end: '2026-10-07T23:59:59.999Z', timezone: 'UTC' },
    compactRange: { range_type: 'TODAY', range_start: '2026-10-07T00:00:00.000Z', range_end: '2026-10-07T23:59:59.999Z', timezone: 'UTC' },
    sourceMealEvidence: { meal_event_count: 4 },
    fullTaskType: 'CONVERSATION_TIME_RANGE_ANALYSIS',
    compactTaskType: 'CONVERSATION_TIME_RANGE_ANALYSIS',
    fullModel: 'gpt-5.6-terra',
    compactModel: 'gpt-5.6-terra',
    fullOutputSchemaVersion: 'conversation-time-range-analysis-output.v1',
    compactOutputSchemaVersion: 'conversation-time-range-analysis-output.v1',
    compactArtifact: compactArtifactFixture(),
  } as const;
}

describe('time-range dual replay evaluator', () => {
  it('normalizes benign wording markers', () => {
    const markers = normalizeAssistantMessageMarkers('Obecnie glukoza rośnie, brak danych o aktywności.');
    expect(markers).toContain('GLUCOSE');
    expect(markers).toContain('CURRENT');
    expect(markers).toContain('UNKNOWN_OR_MISSING');
  });

  it('does not match historical markers inside current-state wording like "ostatnio"', () => {
    const markers = normalizeAssistantMessageMarkers('ostatnio pozostało 1 g aktywnych węglowodanów');
    expect(markers).not.toContain('HISTORICAL');

    const markers2 = normalizeAssistantMessageMarkers('ostatnio było podobnie');
    expect(markers2).not.toContain('HISTORICAL');
  });

  it('matches historical markers at valid lexical boundaries', () => {
    const historicalCases = [
      'ostatni epizod',
      'ostatnia sytuacja',
      'ostatnie dni',
      'wczoraj',
      'previous episode',
      'prior pattern',
    ];

    for (const text of historicalCases) {
      expect(normalizeAssistantMessageMarkers(text)).toContain('HISTORICAL');
    }
  });

  it('passes benign wording differences', () => {
    const result = evaluatePair({
      fullMessage: 'Dziś glukoza wzrasta. Brak danych o aktywności.',
      compactMessage: 'W dzisiejszym zakresie widoczny wzrost glukozy; aktywność pozostaje nieznana.',
      ...basePairInput(),
    });

    expect(result.verdict === 'PASS' || result.verdict === 'PASS_WITH_BENIGN_DIFFERENCE').toBe(true);
    expect(result.invariants.failures.length).toBe(0);
  });

  it('fails when UNKNOWN activity is turned into observed activity', () => {
    const result = evaluatePair({
      fullMessage: 'Brak danych o aktywności.',
      compactMessage: 'Aktywność była obecna i wyraźna po południu.',
      ...basePairInput(),
    });

    expect(result.verdict).toBe('FAIL');
    expect(result.invariants.failures.some((item) => item.includes('ACTIVITY_SEMANTIC_VIOLATION'))).toBe(true);
  });

  it('fails when range identity changes', () => {
    const result = evaluatePair({
      fullMessage: 'Podsumowanie dnia.',
      compactMessage: 'Podsumowanie dnia.',
      ...basePairInput(),
      compactRange: { range_type: 'TODAY', range_start: '2026-10-06T00:00:00.000Z', range_end: '2026-10-06T23:59:59.999Z', timezone: 'UTC' },
    });

    expect(result.verdict).toBe('FAIL');
    expect(result.invariants.failures).toContain('RANGE_IDENTITY_MISMATCH');
  });

  it('treats equivalent carbohydrate count vs meal count as benign when source supports meals', () => {
    const result = evaluatePair({
      fullMessage: 'Recorded 4 carb entries.',
      compactMessage: 'There were 4 meals recorded.',
      ...basePairInput(),
    });

    expect(result.verdict === 'PASS' || result.verdict === 'PASS_WITH_BENIGN_DIFFERENCE').toBe(true);
    expect(result.comparison.potentially_material_differences.includes('MEAL')).toBe(false);
  });

  it('treats carbohydrate gram list vs meal presence as benign when source supports meals', () => {
    const result = evaluatePair({
      fullMessage: 'Wpisy żywieniowe: 30 g, 40 g, 20 g.',
      compactMessage: 'Meal evidence is present.',
      ...basePairInput(),
    });

    expect(result.verdict === 'PASS' || result.verdict === 'PASS_WITH_BENIGN_DIFFERENCE').toBe(true);
    expect(result.comparison.potentially_material_differences.includes('MEAL')).toBe(false);
  });

  it('treats timestamp meal mentions vs count as benign when source supports meals', () => {
    const result = evaluatePair({
      fullMessage: 'Carb entries were logged at 08:00, 12:00 and 18:00.',
      compactMessage: '3 meals were recorded.',
      ...basePairInput(),
      sourceMealEvidence: { meal_event_count: 3 },
    });

    expect(result.verdict === 'PASS' || result.verdict === 'PASS_WITH_BENIGN_DIFFERENCE').toBe(true);
    expect(result.comparison.potentially_material_differences.includes('MEAL')).toBe(false);
  });

  it('keeps compact-only meal material when full has no meal semantics (Case A)', () => {
    const result = evaluatePair({
      fullMessage: 'Glucose remained mostly stable with no additional notable observations.',
      compactMessage: 'There were 4 meals recorded during the day.',
      ...basePairInput(),
    });

    expect(result.verdict).toBe('REVIEW');
    expect(result.comparison.potentially_material_differences).toContain('MEAL');
  });

  it('fails unsupported meal claim when source has no meals (Case B)', () => {
    const result = evaluatePair({
      fullMessage: 'Brak wpisów posiłków.',
      compactMessage: 'There were 4 meals recorded.',
      ...basePairInput(),
      sourceMealEvidence: { meal_event_count: 0 },
    });

    expect(result.verdict).toBe('FAIL');
    expect(result.invariants.failures).toContain('MEAL_SOURCE_UNSUPPORTED_CLAIM');
  });

  it('fails contradictory meal count vs source (Case C)', () => {
    const result = evaluatePair({
      fullMessage: 'Zarejestrowano 4 posiłki.',
      compactMessage: 'Recorded 7 meals during this range.',
      ...basePairInput(),
      sourceMealEvidence: { meal_event_count: 4 },
    });

    expect(result.verdict).toBe('FAIL');
    expect(result.invariants.failures.some((value) => value.includes('MEAL_COUNT_CONTRADICTION'))).toBe(true);
  });

  it('fails unsupported meal causal escalation (Case D)', () => {
    const result = evaluatePair({
      fullMessage: 'Zarejestrowano 4 posiłki.',
      compactMessage: 'The meal caused the glucose excursion.',
      ...basePairInput(),
    });

    expect(result.verdict).toBe('FAIL');
    expect(result.invariants.failures).toContain('MEAL_CAUSAL_ESCALATION_UNSUPPORTED');
  });

  it('preserves UNKNOWN/MISSING semantics while allowing meal equivalence when valid', () => {
    const result = evaluatePair({
      fullMessage: 'Brak danych o aktywności. Recorded 4 carb entries.',
      compactMessage: '4 meals recorded. No activity data available.',
      ...basePairInput(),
    });

    expect(result.invariants.hard_data_state_preserved).toBe(true);
    expect(result.comparison.potentially_material_differences.includes('MEAL')).toBe(false);
  });

  it('calculates metrics with cost unavailable handling', () => {
    const reduction = calculateMetricReduction(
      {
        model: 'gpt-5.6-terra',
        input_fingerprint: 'a',
        serialized_input_bytes: 1000,
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        cached_input_tokens: null,
        reasoning_tokens: null,
        provider_duration_ms: 1000,
        estimated_cost: null,
        currency: null,
        pricing_version: null,
      },
      {
        model: 'gpt-5.6-terra',
        input_fingerprint: 'b',
        serialized_input_bytes: 400,
        input_tokens: 40,
        output_tokens: 45,
        total_tokens: 85,
        cached_input_tokens: null,
        reasoning_tokens: null,
        provider_duration_ms: 900,
        estimated_cost: null,
        currency: null,
        pricing_version: null,
      },
    );

    expect(reduction.input_byte_reduction_pct).toBe(60);
    expect(reduction.input_token_reduction_pct).toBe(60);
    expect(reduction.total_token_reduction_pct).toBeCloseTo(43.3333, 4);
    expect(reduction.output_token_delta).toBe(-5);
    expect(reduction.cost_reduction_pct).toBe('COST_UNAVAILABLE');
  });

  it('generates stable report hash for deterministic report generation checks', () => {
    const payload = { a: 1, b: [2, 3], c: { d: 'x' } };
    const first = stableHash(payload);
    const second = stableHash({ c: { d: 'x' }, b: [2, 3], a: 1 });
    expect(first).toBe(second);
  });

  it('builds aggregate rollup and report markdown deterministically', () => {
    const aggregate = buildAggregateRollup([
      {
        case_id: 'case-1',
        quality_verdict: 'PASS',
        invariant_failures: [],
        reduction: {
          input_byte_reduction_pct: 45,
          input_token_reduction_pct: 40,
          total_token_reduction_pct: 30,
          output_token_delta: -2,
          cost_reduction_pct: 'COST_UNAVAILABLE',
        },
      },
      {
        case_id: 'case-2',
        quality_verdict: 'PASS_WITH_BENIGN_DIFFERENCE',
        invariant_failures: [],
        reduction: {
          input_byte_reduction_pct: 35,
          input_token_reduction_pct: 32,
          total_token_reduction_pct: 25,
          output_token_delta: 1,
          cost_reduction_pct: 'COST_UNAVAILABLE',
        },
      },
    ]);

    expect(aggregate.case_count).toBe(2);
    expect(aggregate.average_input_byte_reduction_pct).toBe(40);
    expect(aggregate.quality_verdict).toBe('READY_FOR_EXPANDED_REPLAY');

    const markdown = renderMarkdownSummary({
      experimentId: 'exp-1',
      cases: [
        { case_id: 'case-1', full_bytes: 1000, compact_bytes: 550, reduction_pct: 45, quality: 'PASS', invariant_status: 'PASS' },
        { case_id: 'case-2', full_bytes: 1000, compact_bytes: 650, reduction_pct: 35, quality: 'PASS_WITH_BENIGN_DIFFERENCE', invariant_status: 'PASS' },
      ],
      aggregate,
    });

    expect(markdown).toContain('Dual TIME_RANGE FULL vs COMPACT Report');
    expect(markdown).toContain('| case-1 |');
    expect(markdown).toContain('READY_FOR_EXPANDED_REPLAY');
  });
});
