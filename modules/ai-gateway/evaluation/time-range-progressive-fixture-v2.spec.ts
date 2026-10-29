import { describe, expect, it } from 'vitest';
import { createEvidenceToolRegistry } from '@modules/evidence-tools';
import { createTimeRangeQualityCostFixtures } from './time-range-quality-cost-experiment';

function buildEvidenceToolContext(fixture: any): Record<string, unknown> {
  const context = fixture.context;
  const analyticalEvidence = (context.analytical_evidence ?? {}) as Record<string, unknown>;
  const glucoseEvents = Array.isArray(analyticalEvidence.glucose_events) ? analyticalEvidence.glucose_events : [];

  const glucoseEvidence = glucoseEvents.map((event, index) => {
    const record = event as Record<string, unknown>;
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const observedAt = String(record.occurred_at ?? record.observed_at ?? fixture.range_start);
    return {
      reading_id: String(record.event_id ?? `g-${index + 1}`),
      source_record_id: String(record.event_id ?? `g-${index + 1}`),
      observed_at: observedAt,
      recorded_at: observedAt,
      glucose_value: Number(payload.glucose_value ?? payload.sgv ?? 0),
      glucose_unit: 'mg/dL',
      classification: 'UNKNOWN',
      relation_to_episode: 'LATEST',
      validity: 'VALID',
      provenance_ref: String(record.provenance_ref ?? record.event_id ?? `source-record/g-${index + 1}`),
    };
  });

  return {
    patient_ref: context.patient_ref,
    glucose_evidence: glucoseEvidence,
    insulin_treatment_events: analyticalEvidence.insulin_treatment_events ?? [],
    treatment_events: analyticalEvidence.insulin_treatment_events ?? [],
    temp_basal_events: analyticalEvidence.insulin_treatment_events ?? [],
    current_state_snapshot: context.current_state_snapshot ?? null,
    active_therapy_snapshot: context.active_therapy_snapshot ?? null,
    event_context_facts: analyticalEvidence.range_event_facts ?? [],
  };
}

function buildInitialTreatmentPreviewText(fixture: any): string {
  const context = fixture.context as Record<string, any>;
  const analytical = (context.analytical_evidence ?? {}) as Record<string, any>;
  const knownTreatmentEvents = (Array.isArray(analytical.insulin_treatment_events) ? analytical.insulin_treatment_events : [])
    .slice(0, 2)
    .map((event) => ({
      kind: event.kind ?? 'UNKNOWN',
      occurred_at: event.occurred_at ?? null,
      amount: typeof event.amount === 'number' ? event.amount : null,
      rate: typeof event.rate === 'number' ? event.rate : null,
      unit: event.unit ?? null,
    }));

  const snapshotEvents = Array.isArray(context.current_state_snapshot?.recent_insulin)
    ? context.current_state_snapshot.recent_insulin
    : [];

  return JSON.stringify({ knownTreatmentEvents, snapshotEvents }).toLowerCase();
}

function executeAllTools(fixture: any) {
  const registry = createEvidenceToolRegistry();
  const context = buildEvidenceToolContext(fixture);

  const run = (tool: 'get_glucose_evidence' | 'get_insulin_evidence' | 'get_basal_evidence') => registry.execute({
    tool,
    patient_id: fixture.patient_id,
    time_range: { from: fixture.range_start, to: fixture.range_end },
    detail_level: 'DETAIL',
    task_context: { task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS' },
    constraints: { max_range_ms: 24 * 60 * 60 * 1000 },
  } as any, context as any, { executionId: `fixture-audit:${fixture.fixture_id}` });

  return {
    glucose: run('get_glucose_evidence'),
    insulin: run('get_insulin_evidence'),
    basal: run('get_basal_evidence'),
  };
}

describe('fixture-progressive-valuable-v2 informational structure', () => {
  it('supports natural progressive disclosure with non-redundant domain value', () => {
    const fixture = createTimeRangeQualityCostFixtures().find((entry) => entry.fixture_id === 'fixture-progressive-valuable-v2');
    expect(fixture).toBeTruthy();

    const initialPreview = buildInitialTreatmentPreviewText(fixture);
    const responses = executeAllTools(fixture);

    const glucoseText = JSON.stringify(responses.glucose.evidence).toLowerCase();
    const insulinText = JSON.stringify(responses.insulin.evidence).toLowerCase();
    const basalText = JSON.stringify(responses.basal.evidence).toLowerCase();

    // Stage 1: glucose alone can establish the first-pass trajectory problem.
    expect(glucoseText).toContain('minimum_glucose');
    expect(glucoseText).toContain('132');
    expect(glucoseText).toContain('67');

    // Decisive anchors are not already exposed in the initial treatment preview.
    expect(initialPreview.includes('1.6')).toBe(false);
    expect(initialPreview.includes('09:08')).toBe(false);
    expect(initialPreview.includes('0.95')).toBe(false);
    expect(initialPreview.includes('09:20')).toBe(false);

    // Stage 2: insulin tool adds new, decisive information unavailable in stage 1.
    expect(insulinText).toContain('1.6');
    expect(insulinText).toContain('09:08');

    // Stage 3: basal tool adds unique semantic value beyond glucose+insulin.
    expect(basalText).toContain('planned_basal');
    expect(basalText).toContain('temporal_relationship');
    expect(basalText).toContain('0.95');
    expect(basalText).toContain('0.65');
    expect(insulinText.includes('planned_basal')).toBe(false);
    expect(glucoseText.includes('planned_basal')).toBe(false);

    // All three domains remain relevant to final reasoning.
    expect(responses.glucose.status).toBe('KNOWN');
    expect(responses.insulin.status).toBe('KNOWN');
    expect(responses.basal.status).toBe('KNOWN');
  });

  it('flags the all-relevant fixture as non-progressive because key multi-domain clues are already present at input', () => {
    const fixture = createTimeRangeQualityCostFixtures().find((entry) => entry.fixture_id === 'fixture-all-relevant');
    expect(fixture).toBeTruthy();

    const initialPreview = buildInitialTreatmentPreviewText(fixture);

    // Immediate, strong insulin+basal anchors are visible before any progressive tool decisions.
    const hasImmediateInsulinAnchor = initialPreview.includes('3.7') && initialPreview.includes('11:20');
    const hasImmediateBasalAnchor = initialPreview.includes('1.1') && initialPreview.includes('temp_basal');

    const looksProgressive = !(hasImmediateInsulinAnchor && hasImmediateBasalAnchor);
    expect(looksProgressive).toBe(false);
  });
});
