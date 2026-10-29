import { describe, expect, it } from 'vitest';
import {
  assertSelectionStateSemantics,
  relationshipStatusFor,
  selectEvidenceBundle,
} from './evidence-selection-policy';

describe('evidence selection policy', () => {
  it('CONVERSATION_TIME_RANGE_ANALYSIS stays authoritative even when meal evidence is present', () => {
    const bundle = selectEvidenceBundle({
      task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
      request_kind: 'ANALYSIS_REQUEST',
      references_meal: true,
      references_insulin: true,
      user_message_text: 'Przeanalizuj mi dzisiejszy dzień',
    });

    expect(bundle.selection_profile).toBe('CONVERSATION_TIME_RANGE_ANALYSIS');
    expect(bundle.effective_level).toBe('L1');
    expect(bundle.required).toContain('CURRENT_STATE');
    expect(bundle.required).toContain('GLUCOSE_SUMMARY');
    expect(bundle.required).toContain('RANGE_FACTS');
  });

  it('CONVERSATION_DIRECT_RESPONSE stays authoritative even when meal evidence is present', () => {
    const bundle = selectEvidenceBundle({
      task_type: 'CONVERSATION_DIRECT_RESPONSE',
      request_kind: 'DIRECT_RESPONSE',
      references_meal: true,
      references_insulin: true,
      user_message_text: 'Czy jesteś dziś w normie?',
    });

    expect(bundle.selection_profile).toBe('CONVERSATION_DIRECT_RESPONSE');
    expect(bundle.effective_level).toBe('L1');
    expect(bundle.excluded_by_default).toContain('GLUCOSE_DETAIL');
  });

  it('MEAL_ANALYSIS + PARTIAL meal-glucose: summary allowed and universal targeted window not allowed', () => {
    const bundle = selectEvidenceBundle({
      task_type: 'meal.wbt_suggestion',
      references_meal: true,
    });

    expect(relationshipStatusFor('MEAL_GLUCOSE')).toBe('PARTIAL');
    expect(bundle.selection_mode).toBe('SUMMARY_PLUS_REFERENCES');
    expect(bundle.required).toContain('MEAL_SUMMARY');
    expect(bundle.required).toContain('GLUCOSE_SUMMARY');
    expect(bundle.excluded_by_default).toContain('TARGETED_WINDOWS');
  });

  it('MEAL_ANALYSIS + exact reconstruction request: unresolved when no CLOSED targeted meal-glucose window exists', () => {
    const bundle = selectEvidenceBundle({
      task_type: 'meal.wbt_suggestion',
      references_meal: true,
      asks_for_exact_sequence: true,
      requires_exact_local_evidence: true,
    });

    expect(bundle.decision_state).toBe('UNRESOLVED');
    expect(bundle.effective_level).toBe('L2');
    expect(bundle.unresolved_reasons.join(' ')).toContain('MEAL_GLUCOSE relationship remains PARTIAL');
  });

  it('DIRECT_RESPONSE: no patient analytical evidence by default', () => {
    const bundle = selectEvidenceBundle({
      task_type: 'CONVERSATION_DIRECT_RESPONSE',
      request_kind: 'DIRECT_RESPONSE',
      user_message_text: 'Co oznacza trend glikemii?',
    });

    expect(bundle.selection_mode).toBe('SUMMARY_ONLY');
    expect(bundle.effective_level).toBe('L1');
    expect(bundle.excluded_by_default).toContain('GLUCOSE_DETAIL');
    expect(bundle.excluded_by_default).toContain('INSULIN_DETAIL');
  });

  it('provenance is required and never reduced by selection contract', () => {
    const bundle = selectEvidenceBundle({
      task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
      request_kind: 'ANALYSIS_REQUEST',
    });

    expect(bundle.required).toContain('PROVENANCE');
  });

  it('UNKNOWN/MISSING/EXCLUDED/NOT_SELECTED remain distinguishable semantics', () => {
    expect(assertSelectionStateSemantics('UNKNOWN')).toContain('cannot be established');
    expect(assertSelectionStateSemantics('MISSING')).toContain('unavailable');
    expect(assertSelectionStateSemantics('EXCLUDED')).toContain('excluded');
    expect(assertSelectionStateSemantics('NOT_SELECTED')).toContain('intentionally excludes');
  });

  it('deterministic replay: same inputs produce same selection and material hash', () => {
    const input = {
      task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
      request_kind: 'ANALYSIS_REQUEST' as const,
      asks_why: true,
      asks_for_exact_sequence: true,
      references_event: true,
      references_insulin: true,
      user_message_text: 'Why did this hypo happen?',
    };

    const a = selectEvidenceBundle(input);
    const b = selectEvidenceBundle(input);

    expect(a).toEqual(b);
    expect(a.material_input_hash).toBe(b.material_input_hash);
  });
});
