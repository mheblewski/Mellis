import { describe, expect, it } from 'vitest';
import {
  buildDailyAnalyticalSummaryV1,
  buildGlucoseSemanticSummaryV1,
} from './evidence-summary-design-contract';

describe('evidence summary design contract', () => {
  it('produces deterministic, stable summaries from the same input', () => {
    const input = {
      time_range: { start_at: '2026-10-07T00:00:00.000Z', end_at: '2026-10-07T23:59:59.999Z' },
      glucose_events: [
        { event_id: 'g-1', glucose_value: 90 },
        { event_id: 'g-2', glucose_value: 100 },
        { event_id: 'g-3', glucose_value: 'UNKNOWN' },
        { event_id: 'g-4', glucose_value: 110 },
      ],
      hypo_episode_refs: ['hp-1'],
      source_boundary_refs: ['source-1'],
      protected_event_refs: ['g-1', 'hp-1'],
      source_refs: ['event:g-1', 'event:g-2', 'event:g-3'],
    };

    const a = buildGlucoseSemanticSummaryV1(input);
    const b = buildGlucoseSemanticSummaryV1(input);

    expect(a).toEqual(b);
    expect(a.glucose_summary.glucose_avg).toBe(100);
    expect(a.glucose_summary.coverage_status).toBe('PARTIAL_DATA');
  });

  it('does not leak raw event arrays into the summary payload', () => {
    const summary = buildGlucoseSemanticSummaryV1({
      time_range: { start_at: '2026-10-07T00:00:00.000Z', end_at: '2026-10-07T23:59:59.999Z' },
      glucose_events: [{ event_id: 'g-1', glucose_value: 98 }, { event_id: 'g-2', glucose_value: 'MISSING' }],
      source_refs: ['event:g-1'],
    });

    expect(summary).not.toHaveProperty('glucose_events');
    expect(summary).not.toHaveProperty('raw_event_stream');
    expect(summary.provenance.source_refs).toContain('event:g-1');
  });

  it('preserves UNKNOWN and MISSING semantics without inventing a value', () => {
    const summary = buildGlucoseSemanticSummaryV1({
      time_range: { start_at: '2026-10-07T00:00:00.000Z', end_at: '2026-10-07T23:59:59.999Z' },
      glucose_events: [
        { event_id: 'g-1', glucose_value: 'UNKNOWN' },
        { event_id: 'g-2', glucose_value: 'MISSING' },
      ],
      evidence_status: {
        glucose_data: 'UNKNOWN',
        known_hypo_episodes: 'MISSING',
        excluded_evidence: 'NONE',
      },
    });

    expect(summary.glucose_summary.glucose_min).toBeNull();
    expect(summary.glucose_summary.glucose_max).toBeNull();
    expect(summary.glucose_summary.glucose_avg).toBeNull();
    expect(summary.evidence_status.glucose_data).toBe('UNKNOWN');
    expect(summary.evidence_status.known_hypo_episodes).toBe('MISSING');
  });

  it('leaves readings of 0 or below out of min, max and average, as time in range does', () => {
    const summary = buildGlucoseSemanticSummaryV1({
      time_range: { start_at: '2026-10-07T00:00:00.000Z', end_at: '2026-10-07T23:59:59.999Z' },
      glucose_events: [
        { event_id: 'g-1', glucose_value: 0 },
        { event_id: 'g-2', glucose_value: -5 },
        { event_id: 'g-3', glucose_value: 80 },
        { event_id: 'g-4', glucose_value: '120' },
      ],
    });

    expect(summary.glucose_summary.glucose_count).toBe(4);
    expect(summary.glucose_summary.usable_glucose_count).toBe(2);
    expect(summary.glucose_summary.glucose_min).toBe(80);
    expect(summary.glucose_summary.glucose_max).toBe(120);
    expect(summary.glucose_summary.glucose_avg).toBe(100);
  });

  it('keeps excluded and not-selected semantics distinct', () => {
    const summary = buildGlucoseSemanticSummaryV1({
      time_range: { start_at: '2026-10-07T00:00:00.000Z', end_at: '2026-10-07T23:59:59.999Z' },
      glucose_events: [],
      evidence_status: {
        glucose_data: 'NOT_SELECTED',
        known_hypo_episodes: 'EXCLUDED',
        excluded_evidence: 'PRESENT',
      },
    });

    expect(summary.evidence_status.glucose_data).toBe('NOT_SELECTED');
    expect(summary.evidence_status.known_hypo_episodes).toBe('EXCLUDED');
    expect(summary.evidence_status.excluded_evidence).toBe('PRESENT');
  });

  it('builds a daily analytical summary that remains a semantic bundle instead of a raw stream', () => {
    const daily = buildDailyAnalyticalSummaryV1({
      time_range: { start_at: '2026-10-07T00:00:00.000Z', end_at: '2026-10-07T23:59:59.999Z' },
      glucose_summary: {
        glucose_count: 190,
        usable_glucose_count: 186,
        unknown_count: 2,
        missing_count: 2,
        glucose_min: 56,
        glucose_max: 230,
        glucose_avg: 120.5,
        coverage_status: 'PARTIAL_DATA',
      },
      insulin_treatment_count: 14,
      insulin_event_refs: ['insulin-1', 'insulin-2'],
      meal_count: 3,
      meal_case_refs: ['meal-1'],
      carbohydrate_total: 120,
      hypo_episode_count: 1,
      episode_refs: ['hypo-1'],
      current_state: { current_glucose: 92, trend: 'UNKNOWN', as_of: '2026-10-07T21:40:00.000Z' },
      missing_sections: ['activity_events'],
      excluded_sections: ['historical_similar_cases'],
      significant_period_refs: ['period-hypo-1'],
      source_refs: ['source:g1', 'source:meal-1'],
    });

    expect(daily.glucose.coverage_status).toBe('PARTIAL_DATA');
    expect(daily.significant_period_refs).toEqual(['period-hypo-1']);
    expect(daily.data_quality.missing_sections).toEqual(['activity_events']);
    expect(daily).not.toHaveProperty('glucose_events');
    expect(daily.provenance.source_refs).toContain('source:meal-1');
  });

  it('keeps provenance compact and does not silently recreate raw volume', () => {
    const summary = buildDailyAnalyticalSummaryV1({
      time_range: { start_at: '2026-10-07T00:00:00.000Z', end_at: '2026-10-07T23:59:59.999Z' },
      glucose_summary: {
        glucose_count: 190,
        usable_glucose_count: 186,
        unknown_count: 2,
        missing_count: 2,
        glucose_min: 56,
        glucose_max: 230,
        glucose_avg: 120.5,
        coverage_status: 'PARTIAL_DATA',
      },
      insulin_treatment_count: 549,
      insulin_event_refs: ['insulin-1', 'insulin-2'],
      meal_count: 11,
      meal_case_refs: ['meal-1'],
      carbohydrate_total: 1260,
      hypo_episode_count: 0,
      episode_refs: [],
      current_state: { current_glucose: 92, trend: 'FLAT', as_of: '2026-10-07T21:40:00.000Z' },
      missing_sections: ['activity_events'],
      excluded_sections: [],
      significant_period_refs: ['period-morning', 'period-evening'],
      source_refs: ['source:glucose-summary', 'source:meal-1'],
    });

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('glucose_events');
    expect(serialized).not.toContain('insulin_treatment_events');
    expect(serialized).not.toContain('raw_event_stream');
    expect(summary.provenance.source_refs).toEqual(['source:glucose-summary', 'source:meal-1']);
  });
});
