import { describe, expect, it } from 'vitest';
import {
  attachShadowToContextPackageUsage,
  evaluateEvidenceSelectionShadowSafe,
  finalizeShadowWithProviderMetrics,
  isSuccessfulShadowSelectionStatus,
} from './evidence-selection-shadow';
import {
  CONVERSATION_DIRECT_RESPONSE_TASK_TYPE,
  CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE,
  type AiTask,
  type DirectResponseContextRecord,
  type TimeRangeAnalysisContextRecord,
} from '@modules/ai-gateway/domain/ai-gateway';
import { buildAiInputHash } from '@modules/ai-gateway/application/ai-task';

function createDirectTask(context: DirectResponseContextRecord): AiTask {
  return {
    task_id: 'task-direct-1',
    task_type: CONVERSATION_DIRECT_RESPONSE_TASK_TYPE,
    task_version: 'conversation-direct-response-task.v1',
    context_package_id: context.context_package_id,
    context_package_version: context.context_package_version,
    context_package_hash: context.content_hash,
    prompt_version: 'conversation-direct-response.v1',
    output_schema_version: 'conversation-direct-response-output.v1',
    model_policy_version: 'fake-provider-policy.v1',
    correlation_id: 'conv-1',
    created_at: '2026-10-07T00:00:00.000Z',
    patient_id: 'patient-1',
  };
}

function createRangeTask(context: TimeRangeAnalysisContextRecord): AiTask {
  return {
    task_id: 'task-range-1',
    task_type: CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE,
    task_version: 'conversation-time-range-analysis-task.v1',
    context_package_id: context.context_package_id,
    context_package_version: context.context_package_version,
    context_package_hash: context.content_hash,
    prompt_version: 'conversation-time-range-analysis.v1',
    output_schema_version: 'conversation-time-range-analysis-output.v1',
    model_policy_version: 'fake-provider-policy.v1',
    correlation_id: 'conv-1',
    created_at: '2026-10-07T00:00:00.000Z',
    patient_id: 'patient-1',
  };
}

function createDirectContext(): DirectResponseContextRecord {
  const contextBase: DirectResponseContextRecord = {
    context_package_id: 'direct-ctx-1',
    context_package_version: 'conversation-context.v1',
    content_hash: '',
    created_at: '2026-10-07T00:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    conversation_context: {
      thread_id: 'conv-1',
      thread_state_version: 'conv-v1',
      awaiting_user_answer: false,
      messages: [
        {
          message_id: 'm-user-1',
          role: 'USER',
          created_at: '2026-10-07T00:00:00.000Z',
          content: 'Co oznacza ten trend?',
          provenance_ref: 'm-user-1',
        },
      ],
    },
    direct_response_input: {
      user_message_id: 'm-user-1',
      user_message_text: 'Co oznacza ten trend?',
    },
    current_state_snapshot: {
      as_of: '2026-10-07T00:00:00.000Z',
      current_glucose: 121,
      trend: 'FLAT',
      iob: 0.4,
    },
    provenance: {
      source_refs: ['m-user-1'],
    },
  };

  return {
    ...contextBase,
    content_hash: buildAiInputHash({ context_package: contextBase }),
  };
}

function createRangeContext(message = 'Przeanalizuj mi dzisiejszy dzień'): TimeRangeAnalysisContextRecord {
  const contextBase: TimeRangeAnalysisContextRecord = {
    context_package_id: 'range-ctx-1',
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: '',
    created_at: '2026-10-07T00:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    analysis_request_input: {
      user_message_id: 'm-user-1',
      user_message_text: message,
      range_type: 'TODAY',
      timezone: 'Europe/Warsaw',
      range_start: '2026-10-07T00:00:00.000Z',
      range_end: '2026-10-07T12:00:00.000Z',
      requested_at: '2026-10-07T12:00:00.000Z',
    },
    conversation_context: {
      thread_id: 'conv-1',
      thread_state_version: 'conv-v1',
      awaiting_user_answer: false,
      messages: [
        {
          message_id: 'm-user-1',
          role: 'USER',
          created_at: '2026-10-07T12:00:00.000Z',
          content: message,
          provenance_ref: 'm-user-1',
        },
      ],
    },
    current_state_snapshot: {
      as_of: '2026-10-07T12:00:00.000Z',
      current_glucose: 151,
      trend: 'DOWN',
      iob: 1.2,
    },
    analytical_evidence: {
      glucose_events: [{ event_id: 'g1' }, { event_id: 'g2' }],
      insulin_treatment_events: [{ event_id: 'i1', type: 'TEMP_BASAL' }, { event_id: 'i2', type: 'TEMP_BASAL' }],
      meal_events: [{ event_id: 'm1' }],
      activity_events: [],
      hypo_episodes: [{ episode_id: 'h1' }],
      range_event_facts: [{ fact_id: 'f1' }],
      summaries: {
        total_events: 5,
        glucose_count: 2,
        insulin_treatment_count: 2,
        meal_count: 1,
        activity_count: 0,
        hypo_episode_count: 1,
        glucose_min: 90,
        glucose_max: 180,
        glucose_avg: 132,
        missing_sections: ['activity_events'],
      },
    },
    provenance: {
      source_refs: ['m-user-1', 'g1', 'g2', 'i1', 'i2', 'm1'],
      selection_policy_version: 'conversation-time-range-context-selection.v1',
    },
  };

  return {
    ...contextBase,
    content_hash: buildAiInputHash({ context_package: contextBase }),
  };
}

describe('evidence selection shadow', () => {
  it('accepts AVAILABLE and AVAILABLE_WITH_RELATION as successful shadow statuses', () => {
    expect(isSuccessfulShadowSelectionStatus('AVAILABLE')).toBe(true);
    expect(isSuccessfulShadowSelectionStatus('AVAILABLE_WITH_RELATION')).toBe(true);
  });

  it('rejects non-success shadow statuses', () => {
    expect(isSuccessfulShadowSelectionStatus('PARTIAL')).toBe(false);
    expect(isSuccessfulShadowSelectionStatus('UNRESOLVED')).toBe(false);
    expect(isSuccessfulShadowSelectionStatus('SHADOW_SELECTION_FAILED')).toBe(false);
    expect(isSuccessfulShadowSelectionStatus(null)).toBe(false);
    expect(isSuccessfulShadowSelectionStatus(undefined)).toBe(false);
  });

  it('shadow execution does not alter current AI payload', () => {
    const context = createRangeContext();
    const before = buildAiInputHash({ context_package: context });

    evaluateEvidenceSelectionShadowSafe({
      task: createRangeTask(context),
      context_package: context,
    });

    const after = buildAiInputHash({ context_package: context });
    expect(after).toBe(before);
  });

  it('DIRECT_RESPONSE shadow excludes patient analytical detail by default', () => {
    const context = createDirectContext();
    const result = evaluateEvidenceSelectionShadowSafe({
      task: createDirectTask(context),
      context_package: context,
    });

    expect(result.selected_evidence_families).toContain('CURRENT_STATE');
    expect(result.selected_evidence_families).toContain('CONVERSATION_CONTEXT');
    expect(result.selected_evidence_families).not.toContain('GLUCOSE_DETAIL');
    expect(result.selected_evidence_families).not.toContain('INSULIN_DETAIL');
  });

  it('TODAY shadow operates on exact existing context representation identity', () => {
    const context = createRangeContext();
    const result = evaluateEvidenceSelectionShadowSafe({
      task: createRangeTask(context),
      context_package: context,
    });

    expect(result.context_package_id).toBe(context.context_package_id);
    expect(result.context_package_hash).toBe(context.content_hash);
    expect(result.current_payload_bytes).toBeGreaterThan(0);
  });

  it('TODAY shadow is deterministic', () => {
    const context = createRangeContext();
    const task = createRangeTask(context);

    const a = evaluateEvidenceSelectionShadowSafe({ task, context_package: context });
    const b = evaluateEvidenceSelectionShadowSafe({ task, context_package: context });

    expect(a.selection_material_hash).toBe(b.selection_material_hash);
    expect(a).toEqual(b);
  });

  it('TODAY shadow keeps task-type profile routing authoritative', () => {
    const context = createRangeContext();
    const result = evaluateEvidenceSelectionShadowSafe({
      task: createRangeTask(context),
      context_package: context,
    });

    expect(result.selection_profile).toBe('CONVERSATION_TIME_RANGE_ANALYSIS');
  });

  it('maps significant periods and targeted windows for time-range analysis', () => {
    const context = createRangeContext('Co bylo dzisiaj najwiekszym problemem i dlaczego?');
    const result = evaluateEvidenceSelectionShadowSafe({
      task: createRangeTask(context),
      context_package: context,
    });

    expect(result.selected_evidence_families).toContain('SIGNIFICANT_PERIODS');
    expect(result.unknowns.some((item) => item.startsWith('SIGNIFICANT_PERIODS:UNMAPPED'))).toBe(false);
    expect(result.unknowns.some((item) => item.startsWith('TARGETED_WINDOWS:UNMAPPED'))).toBe(false);
  });

  it('reads a reading from raw_payload.sgv like the worker, and does not take a 0 for a low', () => {
    const significantCount = (rawSgv: number) => {
      const base = createRangeContext('Co bylo dzisiaj najwiekszym problemem i dlaczego?');
      const context: TimeRangeAnalysisContextRecord = {
        ...base,
        analytical_evidence: {
          ...base.analytical_evidence,
          glucose_events: [{ event_id: 'g1', payload: { raw_payload: { sgv: rawSgv } } }, { event_id: 'g2', payload: { glucose_value: 120 } }],
        },
      };
      const result = evaluateEvidenceSelectionShadowSafe({ task: createRangeTask(context), context_package: context });
      expect(result.selected_evidence_families).toContain('SIGNIFICANT_PERIODS');
      return result.selected_evidence_ref_count;
    };

    expect(significantCount(55) - significantCount(120)).toBe(1);
    expect(significantCount(0)).toBe(significantCount(120));
  });

  it('can select targeted windows for exact sequence requests', () => {
    const context = createRangeContext('Podaj dokladna sekwencje zmian glikemii krok po kroku');
    const result = evaluateEvidenceSelectionShadowSafe({
      task: createRangeTask(context),
      context_package: context,
    });

    expect(result.selected_level).toBe('L3');
    expect(result.selected_evidence_families).toContain('TARGETED_WINDOWS');
  });

  it('MEAL shadow selection does not invent a universal targeted glucose window', () => {
    const context = createRangeContext('Please give exact meal reconstruction sequence.');
    const task = {
      ...createRangeTask(context),
      task_type: 'meal.wbt_suggestion',
    } as unknown as AiTask;

    const result = evaluateEvidenceSelectionShadowSafe({ task, context_package: context });

    expect(result.status).toBe('UNRESOLVED');
    expect(result.unresolved_reasons.join(' ')).toContain('MEAL_GLUCOSE relationship remains PARTIAL');
  });

  it('shadow failure is non-blocking and returns bounded failure metadata', () => {
    const circular: any = {};
    circular.context_package_id = 'circular';
    circular.context_package_version = 'conversation-context.v1';
    circular.content_hash = 'sha256:circular';
    circular.self = circular;

    const result = evaluateEvidenceSelectionShadowSafe({
      task: {
        task_id: 't1',
        task_type: CONVERSATION_DIRECT_RESPONSE_TASK_TYPE,
        task_version: 'v1',
        context_package_id: 'circular',
        context_package_version: 'conversation-context.v1',
        context_package_hash: 'sha256:circular',
        prompt_version: 'v1',
        output_schema_version: 'v1',
        model_policy_version: 'v1',
        correlation_id: 'c1',
        created_at: '2026-10-07T00:00:00.000Z',
      },
      context_package: circular,
    });

    expect(result.status).toBe('SHADOW_SELECTION_FAILED');
    expect(result.telemetry_bounded).toBe(true);
    expect(result.unknowns.length).toBeLessThanOrEqual(32);
  });

  it('telemetry is bounded', () => {
    const context = createRangeContext();
    const result = evaluateEvidenceSelectionShadowSafe({
      task: createRangeTask(context),
      context_package: context,
    });

    expect(result.selected_evidence_refs_sample.length).toBeLessThanOrEqual(32);
    expect(result.omitted_evidence_refs_sample.length).toBeLessThanOrEqual(32);
    expect(result.provenance_refs_sample.length).toBeLessThanOrEqual(32);
    expect(result.telemetry_bounded).toBe(true);
  });

  it('same input and versions produce identical shadow material hash', () => {
    const context = createRangeContext();
    const task = createRangeTask(context);

    const base = evaluateEvidenceSelectionShadowSafe({ task, context_package: context });
    const finalizedA = finalizeShadowWithProviderMetrics({
      shadow: base,
      current_payload_bytes: 1000,
      current_payload_tokens: 250,
    });
    const finalizedB = finalizeShadowWithProviderMetrics({
      shadow: base,
      current_payload_bytes: 1000,
      current_payload_tokens: 250,
    });

    const usage = attachShadowToContextPackageUsage({
      usage: {
        total_serialized_bytes: 1000,
        sections: [{ section_name: 'analytical_evidence', serialized_bytes: 700 }],
      },
      shadow: finalizedA,
    });

    expect(finalizedA.selection_material_hash).toBe(finalizedB.selection_material_hash);
    expect(usage.shadow_selection?.['telemetry_bounded']).toBe(true);
  });
});
