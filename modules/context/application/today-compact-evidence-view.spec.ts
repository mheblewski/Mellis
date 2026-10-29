import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@shared/utils/canonical-json';
import {
  MAX_LISTED_REFS_PER_GROUP,
  TODAY_COMPACT_EVIDENCE_VIEW_POLICY_VERSION,
  buildTodayCompactEvidenceViewV1,
  evaluateTodayCompactEvidenceShadow,
  measureTodayCompactEvidenceShadow,
  serializeTodayCompactEvidenceView,
} from './today-compact-evidence-view';
import {
  SYNTHETIC_TODAY_FIXTURE_PROVENANCE,
  createSyntheticTodayContext,
} from './today-compact-evidence-view.fixture';

const PATIENT_A = 'synthetic-patient-a';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

describe('TodayCompactEvidenceViewV1', () => {
  it('produces byte-identical output for the same input and policy', () => {
    const first = serializeTodayCompactEvidenceView(buildTodayCompactEvidenceViewV1({
      context: createSyntheticTodayContext(),
      expected_patient_id: PATIENT_A,
    }));
    const second = serializeTodayCompactEvidenceView(buildTodayCompactEvidenceViewV1({
      context: createSyntheticTodayContext(),
      expected_patient_id: PATIENT_A,
    }));

    expect(second).toBe(first);
    expect(Buffer.byteLength(second, 'utf8')).toBe(Buffer.byteLength(first, 'utf8'));
  });

  it('is independent of evidence array ordering and has stable byte counts and hashes', () => {
    const ordered = createSyntheticTodayContext();
    const shuffled = createSyntheticTodayContext();
    shuffled.analytical_evidence.glucose_events.reverse();
    shuffled.analytical_evidence.insulin_treatment_events.reverse();
    shuffled.analytical_evidence.meal_events.reverse();
    shuffled.analytical_evidence.range_event_facts.reverse();
    shuffled.provenance.source_refs.reverse();

    const a = measureTodayCompactEvidenceShadow({ context: ordered, expected_patient_id: PATIENT_A });
    const b = measureTodayCompactEvidenceShadow({ context: shuffled, expected_patient_id: PATIENT_A });

    expect(a.status).toBe('MEASURED');
    expect(b.compact_view_hash).toBe(a.compact_view_hash);
    expect(b.bytes.compact_view).toBe(a.bytes.compact_view);
    expect(a.bytes.compact_view).toBe(Buffer.byteLength(serializeTodayCompactEvidenceView(
      buildTodayCompactEvidenceViewV1({ context: ordered, expected_patient_id: PATIENT_A }),
    ), 'utf8'));
  });

  it('uses only repository-derived summary facts consistent with the worker summaries', () => {
    const context = createSyntheticTodayContext();
    const view = buildTodayCompactEvidenceViewV1({ context, expected_patient_id: PATIENT_A });
    const summaries = context.analytical_evidence.summaries;

    expect(view.summary_consistency).toEqual({ status: 'CONSISTENT', mismatched_fields: [] });
    expect(view.daily_summary.glucose).toMatchObject({
      glucose_count: 190,
      usable_glucose_count: 190,
      glucose_min: summaries.glucose_min,
      glucose_max: summaries.glucose_max,
      glucose_avg: summaries.glucose_avg,
      coverage_status: 'HAS_USABLE_GLUCOSE_DATA',
    });
    expect(view.daily_summary.insulin).toMatchObject({ insulin_treatment_count: 549, total_summary_available: false });
    expect(view.daily_summary.meals).toEqual({ meal_count: 11, meal_case_refs: [], carbohydrate_total: null });
    expect(view.daily_summary.hypo).toEqual({ hypo_episode_count: 0, episode_refs: [] });
    expect(view.daily_summary.current_state).toEqual({ current_glucose: 132, trend: 'FLAT', as_of: '2026-10-07T19:58:00.000Z' });
    expect(view.current_state_iob).toBe(1.25);
    expect(view.daily_summary.data_quality.missing_sections).toEqual(['activity_events', 'hypo_episodes']);

    const serialized = serializeTodayCompactEvidenceView(view);
    for (const forbidden of ['raw_payload', 'glucose_events":[', 'trend_classification', 'rapid_rise', 'stable_period', 'insulin_total']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('flags a mismatch instead of silently overriding worker summaries', () => {
    const context = createSyntheticTodayContext();
    context.analytical_evidence.summaries.glucose_max = 999;

    const view = buildTodayCompactEvidenceViewV1({ context, expected_patient_id: PATIENT_A });
    expect(view.summary_consistency).toEqual({ status: 'MISMATCH', mismatched_fields: ['glucose_max'] });
  });

  it('preserves UNKNOWN, MISSING, EXCLUDED, NOT_SELECTED and budget-omission semantics', () => {
    const context = createSyntheticTodayContext({ glucoseCount: 6 });
    const glucose = context.analytical_evidence.glucose_events as Array<{ payload: Record<string, unknown> }>;
    glucose[0].payload = { glucose_value: 'MISSING' };
    glucose[1].payload = { glucose_unit: 'mg/dL' };
    context.analytical_evidence.summaries.glucose_count = 6;
    const numeric = glucose.slice(2).map((event) => event.payload.glucose_value as number);
    context.analytical_evidence.summaries.glucose_min = Math.min(...numeric);
    context.analytical_evidence.summaries.glucose_max = Math.max(...numeric);
    context.analytical_evidence.summaries.glucose_avg = Number((numeric.reduce((sum, value) => sum + value, 0) / numeric.length).toFixed(2));
    context.historical_evidence = { cases: [] } as any;

    const view = buildTodayCompactEvidenceViewV1({ context, expected_patient_id: PATIENT_A });

    expect(view.daily_summary.glucose).toMatchObject({
      glucose_count: 6,
      usable_glucose_count: 4,
      missing_count: 1,
      unknown_count: 1,
      coverage_status: 'PARTIAL_DATA',
    });
    expect(view.summary_consistency.status).toBe('CONSISTENT');
    expect(view.glucose_evidence_status).toEqual({
      glucose_data: 'KNOWN',
      known_hypo_episodes: 'KNOWN',
      excluded_evidence: 'UNKNOWN',
    });
    expect(view.historical_evidence.status).toBe('NOT_SELECTED');
    expect(view.semantics).toEqual({
      omitted_refs_are_not_absence: true,
      empty_section_is_not_proof_of_absence: true,
      current_state_is_point_in_time_snapshot: true,
    });

    const full = buildTodayCompactEvidenceViewV1({ context: createSyntheticTodayContext(), expected_patient_id: PATIENT_A });
    const tempBasal = full.references.insulin_treatment_events.by_type.find((group) => group.event_type === 'TEMP_BASAL');
    expect(tempBasal).toMatchObject({ total_count: 101, listed_ref_count: 0, refs_status: 'OMITTED_DUE_TO_BUDGET' });
    expect(tempBasal?.ref_set_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(full.references.glucose_events).toMatchObject({ total_count: 190, refs_status: 'OMITTED_DUE_TO_BUDGET' });
    expect(full.references.activity_events).toMatchObject({ total_count: 0, refs_status: 'EMPTY', ref_set_digest: null });
    expect(full.significant_periods).toEqual({ status: 'UNAVAILABLE', reason: 'L2_CANDIDATE_ASSEMBLY_NOT_IN_TODAY_RUNTIME' });
  });

  it('keeps compact provenance traceable to the canonical context package', () => {
    const context = createSyntheticTodayContext();
    const view = buildTodayCompactEvidenceViewV1({ context, expected_patient_id: PATIENT_A });

    expect(view.source_context).toEqual({
      context_package_id: context.context_package_id,
      context_package_version: 'conversation-time-range-context.v1',
      content_hash: context.content_hash,
    });
    expect(view.daily_summary.provenance).toEqual({
      source_refs: [`context_package:${context.context_package_id}`],
      derivation_policy_version: TODAY_COMPACT_EVIDENCE_VIEW_POLICY_VERSION,
      selection_policy_version: context.provenance.selection_policy_version,
    });
    expect(view.provenance.source_ref_count).toBe(new Set(context.provenance.source_refs).size);
    expect(view.provenance.source_ref_set_digest).toMatch(/^sha256:/);

    const bolusIds = context.analytical_evidence.insulin_treatment_events
      .filter((event) => event.type === 'BOLUS' || event.type === 'SMB')
      .map((event) => String(event.event_id))
      .sort();
    expect([...view.daily_summary.insulin.insulin_event_refs].sort()).toEqual(bolusIds);
    expect(view.references.meal_events.refs).toEqual(context.analytical_evidence.meal_events.map((event) => String(event.event_id)).sort());
    expect(view.references.meal_events.refs.length).toBeLessThanOrEqual(MAX_LISTED_REFS_PER_GROUP);
    for (const ref of [...view.daily_summary.insulin.insulin_event_refs, ...view.references.meal_events.refs]) {
      expect(context.provenance.source_refs).toContain(ref);
    }
  });

  it('enforces patient isolation', () => {
    const contextA = createSyntheticTodayContext({ patientId: 'synthetic-patient-a', hypoEpisodeCount: 2 });
    const contextB = createSyntheticTodayContext({ patientId: 'synthetic-patient-b', hypoEpisodeCount: 2 });

    expect(() => buildTodayCompactEvidenceViewV1({ context: contextA, expected_patient_id: 'synthetic-patient-b' }))
      .toThrow('COMPACT_EVIDENCE_VIEW_PATIENT_MISMATCH');
    expect(measureTodayCompactEvidenceShadow({ context: contextA, expected_patient_id: 'synthetic-patient-b' }))
      .toMatchObject({ status: 'FAILED', failed_reason: 'COMPACT_EVIDENCE_VIEW_PATIENT_MISMATCH', compact_view_hash: null });

    const viewA = serializeTodayCompactEvidenceView(buildTodayCompactEvidenceViewV1({ context: contextA, expected_patient_id: 'synthetic-patient-a' }));
    const viewB = buildTodayCompactEvidenceViewV1({ context: contextB, expected_patient_id: 'synthetic-patient-b' });
    expect(viewA).not.toContain('synthetic-patient-b');
    for (const ref of [...viewB.daily_summary.hypo.episode_refs, ...viewB.references.meal_events.refs]) {
      expect(viewA).not.toContain(ref);
    }
  });

  it('separates current range evidence from historical evidence', () => {
    const withoutHistory = buildTodayCompactEvidenceViewV1({ context: createSyntheticTodayContext(), expected_patient_id: PATIENT_A });
    const withHistory = buildTodayCompactEvidenceViewV1({
      context: createSyntheticTodayContext({ historicalEvidence: { similar_cases: [{ case_id: 'historical-case-1', glucose_min: 40 }] } as any }),
      expected_patient_id: PATIENT_A,
    });

    expect(withHistory.scope.evidence_channel).toBe('CURRENT_RANGE');
    expect(withHistory.daily_summary).toEqual(withoutHistory.daily_summary);
    expect(withHistory.historical_evidence).toEqual({
      evidence_channel: 'HISTORICAL',
      status: 'NOT_SELECTED',
      reason: 'L1_CURRENT_RANGE_VIEW_EXCLUDES_HISTORICAL_CHANNEL',
    });
    expect(withoutHistory.historical_evidence.status).toBe('MISSING');
    expect(serializeTodayCompactEvidenceView(withHistory)).not.toContain('historical-case-1');
  });

  it('handles empty and partial evidence without treating absence as negative evidence', () => {
    const empty = buildTodayCompactEvidenceViewV1({
      context: createSyntheticTodayContext({
        glucoseCount: 0,
        insulinCounts: { BOLUS: 0, SMB: 0, TEMP_BASAL: 0, IOB_SNAPSHOT: 0, COB_SNAPSHOT: 0 },
        mealCount: 0,
        rangeFactCount: 0,
        withCurrentState: false,
      }),
      expected_patient_id: PATIENT_A,
    });

    expect(empty.daily_summary.glucose).toMatchObject({
      glucose_count: 0,
      usable_glucose_count: 0,
      glucose_min: null,
      glucose_max: null,
      glucose_avg: null,
      coverage_status: 'NO_USABLE_GLUCOSE_DATA',
    });
    expect(empty.glucose_evidence_status.glucose_data).toBe('MISSING');
    expect(empty.daily_summary.current_state).toBeNull();
    expect(empty.current_state_iob).toBeNull();
    expect(empty.daily_summary.data_quality.missing_sections).toEqual([
      'activity_events',
      'glucose_events',
      'hypo_episodes',
      'insulin_treatment_events',
      'meal_events',
    ]);
    expect(empty.semantics.empty_section_is_not_proof_of_absence).toBe(true);
    expect(empty.summary_consistency.status).toBe('CONSISTENT');
  });

  it('does not mutate the canonical context package', () => {
    const context = createSyntheticTodayContext({ hypoEpisodeCount: 1 });
    const before = canonicalJson(context);
    deepFreeze(context);

    expect(() => measureTodayCompactEvidenceShadow({ context, expected_patient_id: PATIENT_A })).not.toThrow();
    expect(measureTodayCompactEvidenceShadow({ context, expected_patient_id: PATIENT_A }).status).toBe('MEASURED');
    expect(canonicalJson(context)).toBe(before);
  });

  it('shows the full-vs-compact size comparison on a realistic TODAY fixture', () => {
    const context = createSyntheticTodayContext();
    const measurement = measureTodayCompactEvidenceShadow({
      context,
      expected_patient_id: PATIENT_A,
      production_user_payload: '{"selected_evidence":{}}',
    });

    expect(SYNTHETIC_TODAY_FIXTURE_PROVENANCE).toContain('SYNTHETIC');
    expect(measurement.status).toBe('MEASURED');
    expect(measurement.sent_to_provider).toBe(false);
    expect(measurement.bytes.full_ai_bound_context).toBe(Buffer.byteLength(canonicalJson(context), 'utf8'));
    expect(measurement.bytes.full_analytical_evidence).toBe(Buffer.byteLength(canonicalJson(context.analytical_evidence), 'utf8'));

    const fullContext = measurement.comparisons.find((entry) => entry.baseline === 'FULL_AI_BOUND_CONTEXT');
    expect(fullContext).toBeDefined();
    expect(fullContext!.delta_bytes).toBe(fullContext!.baseline_bytes - fullContext!.compact_bytes);
    expect(fullContext!.baseline_bytes).toBeGreaterThan(300_000);
    expect(fullContext!.compact_bytes).toBeLessThan(10_000);
    expect(fullContext!.reduction_pct).toBeGreaterThan(95);

    // The compact view is larger than a tiny production payload: deltas are signed, never clamped.
    const production = measurement.comparisons.find((entry) => entry.baseline === 'PRODUCTION_USER_PAYLOAD');
    expect(production!.delta_bytes).toBeLessThan(0);
    expect(production!.reduction_pct).toBeLessThan(0);

    expect(measurement.tokens).toEqual({
      provider_input_tokens_last_call: null,
      provider_input_tokens_kind: 'UNAVAILABLE',
      compact_view_tokens: null,
      compact_view_tokens_kind: 'UNAVAILABLE_NO_LOCAL_TOKENIZER',
    });
    expect(measurement.included_facts).toMatchObject({
      glucose_count: 190,
      insulin_treatment_count: 549,
      meal_count: 11,
      hypo_episode_count: 0,
      omitted_due_to_budget_ref_count: 190 + 101 + 216 + 216,
    });
    expect(measurement.policy_versions.view_policy_version).toBe(TODAY_COMPACT_EVIDENCE_VIEW_POLICY_VERSION);
  });

  it('runs only for TODAY time-range tasks and respects the budget mode kill switch', () => {
    const context = createSyntheticTodayContext();
    const base = {
      task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
      task_patient_id: PATIENT_A,
      context,
      production_user_payload: null,
      provider_serialized_input_bytes: 1000,
      provider_input_tokens: 400,
    };

    expect(evaluateTodayCompactEvidenceShadow({ ...base, env: {} })).toMatchObject({
      status: 'MEASURED',
      tokens: { provider_input_tokens_last_call: 400, provider_input_tokens_kind: 'AUTHORITATIVE_PROVIDER_USAGE' },
      bytes: { provider_serialized_input_last_call: 1000 },
    });
    expect(evaluateTodayCompactEvidenceShadow({ ...base, env: { GLUCO_MIND_CONTEXT_BUDGET_MODE: 'off' } })).toBeNull();
    expect(evaluateTodayCompactEvidenceShadow({ ...base, task_type: 'HYPO_ANALYSIS', env: {} })).toBeNull();

    const shortRange = createSyntheticTodayContext();
    shortRange.analysis_request_input.range_type = 'SHORT_RANGE';
    expect(evaluateTodayCompactEvidenceShadow({ ...base, context: shortRange, env: {} })).toBeNull();
  });
});
