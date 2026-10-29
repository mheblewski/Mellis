import { describe, expect, it } from 'vitest';
import {
  assertUnknownMissingSemantics,
  classifyEvidenceSectionRole,
  selectTaskEvidenceProfile,
} from './task-evidence-policy';

describe('task evidence policy', () => {
  it('keeps direct responses summary-first and does not select full-day raw evidence', () => {
    const decision = selectTaskEvidenceProfile({
      task_type: 'CONVERSATION_DIRECT_RESPONSE',
      request_type: 'DIRECT_RESPONSE',
      user_message_text: 'Co oznacza ten trend?',
    });

    expect(decision.evidence_profile).toBe('DIRECT_RESPONSE');
    expect(decision.default_level).toBe('L1');
    expect(decision.required_sections).toContain('current_state');
    expect(decision.forbidden_sections).toContain('full_day_glucose_events');
  });

  it('defaults today analysis to L1 and escalates only when explanation is required', () => {
    const today = selectTaskEvidenceProfile({
      task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
      request_type: 'ANALYSIS_REQUEST',
      range_profile: 'SINGLE_DAY',
      user_message_text: 'Jak wyglądał mój dzisiejszy dzień?',
    });

    expect(today.evidence_profile).toBe('GENERAL_TIME_RANGE_ANALYSIS');
    expect(today.default_level).toBe('L1');
    expect(today.required_sections).toContain('glucose_summary');
    expect(today.l2_eligibility).toContain('significant_periods');
  });

  it('escalates to L2 for event-specific why questions and to L3 for exact trajectory reconstruction', () => {
    const why = selectTaskEvidenceProfile({
      task_type: 'triggering.hypo_detection',
      request_type: 'INVESTIGATION_REQUIRED',
      asks_why: true,
      event_reference: true,
      user_message_text: 'Dlaczego spadek był po obiedzie?',
    });

    const exact = selectTaskEvidenceProfile({
      task_type: 'MEAL_ANALYSIS',
      meal_reference: true,
      requires_exact_trajectory: true,
      user_message_text: 'Jaki był dokładny przebieg glukozy po posiłku?',
    });

    expect(why.evidence_profile).toBe('EVENT_INVESTIGATION');
    expect(why.default_level).toBe('L2');
    expect(why.l3_eligibility).toContain('exact_glucose_trajectory');
    expect(exact.default_level).toBe('L2');
    expect(exact.l3_eligibility).toContain('exact_glucose_trajectory');
  });

  it('keeps historical evidence distinct from current evidence and preserves semantic clarity', () => {
    const comparison = selectTaskEvidenceProfile({
      task_type: 'conversation.time_range_analysis',
      historical_reference: true,
      user_message_text: 'Porównaj z ostatnim tygodniem',
    });

    expect(comparison.evidence_profile).toBe('HISTORICAL_COMPARISON');
    expect(classifyEvidenceSectionRole('historical_summary', 'HISTORICAL_COMPARISON')).toBe('REQUIRED');
    expect(classifyEvidenceSectionRole('treating_historical_events_as_current_events', 'HISTORICAL_COMPARISON')).toBe('PROHIBITED');
    expect(assertUnknownMissingSemantics('UNKNOWN')).toContain('genuinely unknown');
    expect(assertUnknownMissingSemantics('MISSING')).toContain('absent');
  });
});
