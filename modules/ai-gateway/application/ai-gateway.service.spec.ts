import { Logger } from '@nestjs/common';
import { findDirectResponseBoundaryFlags } from './ai-gateway.service';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { AiGatewayService } from './ai-gateway.service';
import { AiExecutionError, AiProvider, AiProviderInput, AiProviderResponse } from '@modules/ai-gateway/domain/ai-gateway';
import { AiProviderError } from '@modules/ai-gateway/infrastructure/ai-provider.error';
import { createConversationDirectResponseTask, createConversationTimeRangeAnalysisTask, buildAiTaskIdentity, buildAiInputHash } from './ai-task';
import * as EvidenceSelectionShadow from '@modules/context/application/evidence-selection-shadow';

function createDirectResponseContext(): any {
  return {
    context_package_id: 'dr-1',
    context_package_version: 'conversation-context.v1',
    content_hash: 'sha256:dr-1',
    created_at: '2026-09-16T10:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    conversation_context: {
      thread_id: 'conv-1',
      thread_state_version: 'conv-v1',
      awaiting_user_answer: false,
      messages: [],
    },
    direct_response_input: {
      user_message_id: 'msg-1',
      user_message_text: 'Przeanalizuj mi dzisiejszy dzień',
    },
    current_state_snapshot: {
      as_of: '2026-09-16T10:00:00.000Z',
      current_glucose: 151,
      trend: 'DOWN',
      iob: 4.29,
    },
    provenance: {
      source_refs: ['msg-1'],
    },
  };
}

function createDirectResponseTask(contextPackage: any) {
  return createConversationDirectResponseTask({
    task_id: 'direct-response-task-1',
    context_package_id: contextPackage.context_package_id,
    context_package_version: contextPackage.context_package_version,
    context_package_hash: contextPackage.content_hash,
    correlation_id: 'conv-1',
    created_at: '2026-09-16T10:00:00.000Z',
    patient_id: 'patient-1',
  });
}

function createTimeRangeContext(overrides: Partial<any> = {}): any {
  const base = {
    context_package_id: 'tr-1',
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: 'sha256:tr-1',
    created_at: '2026-09-16T10:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    analysis_request_input: {
      user_message_id: 'msg-1',
      user_message_text: 'Przeanalizuj mi dzisiejszy dzień',
      range_type: 'TODAY',
      timezone: 'Europe/Warsaw',
      range_start: '2026-09-16T00:00:00.000Z',
      range_end: '2026-09-16T23:59:59.999Z',
      requested_at: '2026-09-16T10:00:00.000Z',
    },
    conversation_context: {
      thread_id: 'conv-1',
      thread_state_version: 'conv-v1',
      awaiting_user_answer: false,
      messages: [],
    },
    current_state_snapshot: {
      as_of: '2026-09-16T10:00:00.000Z',
      current_glucose: 151,
      trend: 'DOWN',
      iob: 4.29,
    },
    analytical_evidence: {
      glucose_events: [],
      insulin_treatment_events: [],
      meal_events: [],
      activity_events: [],
      hypo_episodes: [],
      range_event_facts: [],
      summaries: {
        total_events: 3,
        glucose_count: 1,
        insulin_treatment_count: 1,
        meal_count: 1,
        activity_count: 0,
        hypo_episode_count: 0,
        glucose_min: 151,
        glucose_max: 151,
        glucose_avg: 151,
        missing_sections: ['activity_events'],
      },
    },
    provenance: {
      source_refs: ['msg-1'],
      selection_policy_version: 'conversation-time-range-selector.v1',
    },
  };

  return {
    ...base,
    ...overrides,
    analysis_request_input: {
      ...base.analysis_request_input,
      ...(overrides.analysis_request_input ?? {}),
    },
  };
}

function createTimeRangeTask(contextPackage: any) {
  return createConversationTimeRangeAnalysisTask({
    task_id: 'time-range-task-1',
    context_package_id: contextPackage.context_package_id,
    context_package_version: contextPackage.context_package_version,
    context_package_hash: contextPackage.content_hash,
    correlation_id: 'conv-1',
    created_at: '2026-09-16T10:00:00.000Z',
    patient_id: 'patient-1',
  });
}

class StubProvider implements AiProvider {
  constructor(private readonly producer: (input: AiProviderInput) => Promise<AiProviderResponse>) {}

  generate(input: AiProviderInput): Promise<AiProviderResponse> {
    return this.producer(input);
  }
}

describe('AiGatewayService', () => {
  it('exposes no Memory mutation surface beyond ContextPackage validation', () => {
    const gateway = new AiGatewayService(new StubProvider(async () => ({
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      received_at: new Date().toISOString(),
      raw_output: { assistant_message: 'Odpowiedź.' },
    })));

    expect('createMemory' in gateway).toBe(false);
    expect('mutateMemory' in gateway).toBe(false);
    expect('promoteMemory' in gateway).toBe(false);
    expect('invalidateMemory' in gateway).toBe(false);
    expect('resolveContradiction' in gateway).toBe(false);
    expect('createMemoryEvidence' in gateway).toBe(false);
  });

  it.each([
    'Po posiłku glukoza wzrosła, a wcześniej podano insulinę.',
    'W ciągu dnia wystąpiły wahania glukozy związane z posiłkami.',
    'Podano insulinę przed posiłkiem.',
    'Dzisiejszy dzień: glukoza 151 mg/dL, posiłek o 14:00, bolus 1.2 U, basal 0.4 U; dane są z tego dnia i nie wskazują na zmianę terapii.',
  ])('allows neutral analytical statements mentioning insulin/carbs/glucose: %s', async (assistantMessage) => {
    const contextPackage = createDirectResponseContext();
    const task = createDirectResponseTask(contextPackage);

    const gateway = new AiGatewayService(new StubProvider(async () => ({
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      received_at: new Date().toISOString(),
      raw_output: { assistant_message: assistantMessage },
    })));

    await expect(gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 })).resolves.toMatchObject({
      result: { assistant_message: assistantMessage },
    });
  });

  it.each([
    'Zwiększ dawkę insuliny o 1 jednostkę.',
    'Podaj teraz 2 jednostki insuliny.',
    'Zmniejsz dawkę korekty.',
    'Ustaw wyższy basal.',
    'Zmień ICR na 1:8.',
  ])('accepts a dose or settings suggestion in a conversation answer (therapy-suggestion-policy): %s', async (assistantMessage) => {
    const contextPackage = createDirectResponseContext();
    const task = createDirectResponseTask(contextPackage);

    const gateway = new AiGatewayService(new StubProvider(async () => ({
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      received_at: new Date().toISOString(),
      raw_output: { assistant_message: assistantMessage },
    })));

    // Suggestions are decision support for the caregiver, so they are no longer rejected.
    await expect(gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 })).resolves.toMatchObject({
      result: { assistant_message: assistantMessage },
    });
  });

  it.each([
    'W opisach kontekstowych odnotowano aktywność przed wcześniejszym spadkiem.',
    'Wcześniej odpowiedziałeś, że zwykle jesz późno.',
    'W poprzednim pytaniu podałeś, że aktywność była przed spadkiem.',
    'Zebrany kontekst wskazuje na podobny przebieg glikemii.',
    'Aktywność przed spadkiem była zgłoszona.',
    'Activity was reported in contextual descriptions from previous answers.',
  ])('delivers and logs TODAY analysis exposing internal context-collection wording: %s', async (assistantMessage) => {
    const contextPackage = createTimeRangeContext();
    const task = createTimeRangeTask(contextPackage);

    const gateway = new AiGatewayService(new StubProvider(async () => ({
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      received_at: new Date().toISOString(),
      raw_output: { assistant_message: assistantMessage },
    })));

    // Live 2026-10-16: a flagged phrase discarded a whole answer. The answer is kept and the phrase is logged.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());
    await expect(gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 })).resolves.toMatchObject({
      result: { assistant_message: assistantMessage },
    });
    expect(warn.mock.calls.map((call) => JSON.parse(String(call[0])))).toContainEqual(expect.objectContaining({ event: 'direct_response_boundary_flag', rule: 'INTERNAL_CONTEXT_EXPOSURE' }));
  });

  it('allows TODAY analysis to use historically-relevant factor in natural wording', async () => {
    const assistantMessage = 'Podobny spadek wcześniej wystąpił w związku z aktywnością. Aktywność może być istotnym czynnikiem przy podobnych spadkach.';
    const contextPackage = createTimeRangeContext();
    const task = createTimeRangeTask(contextPackage);

    const gateway = new AiGatewayService(new StubProvider(async () => ({
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      received_at: new Date().toISOString(),
      raw_output: { assistant_message: assistantMessage },
    })));

    await expect(gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 })).resolves.toMatchObject({
      result: { assistant_message: assistantMessage },
    });
  });

  it('allows neutral TODAY analysis summary with UNKNOWN/MISSING semantics', async () => {
    const assistantMessage = 'Dzisiaj widoczny jest wzrost glikemii po posiłku, następnie częściowy powrót. W tej chwili glukoza wynosi 151 mg/dL. Brak danych o aktywności dla tego zakresu czasu, więc wpływ wysiłku pozostaje UNKNOWN.';
    const contextPackage = createTimeRangeContext();
    const task = createTimeRangeTask(contextPackage);

    const gateway = new AiGatewayService(new StubProvider(async () => ({
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      received_at: new Date().toISOString(),
      raw_output: { assistant_message: assistantMessage },
    })));

    await expect(gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 })).resolves.toMatchObject({
      result: { assistant_message: assistantMessage },
    });
  });

  it('allows TODAY analysis wording with neutral reported/provided terms when internal machinery is not exposed', async () => {
    const assistantMessage = 'During this time range, reported carbohydrates were 45 g and glucose later increased. Activity data is missing for this interval, so activity impact remains UNKNOWN.';
    const contextPackage = createTimeRangeContext();
    const task = createTimeRangeTask(contextPackage);

    const gateway = new AiGatewayService(new StubProvider(async () => ({
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      received_at: new Date().toISOString(),
      raw_output: { assistant_message: assistantMessage },
    })));

    await expect(gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 })).resolves.toMatchObject({
      result: { assistant_message: assistantMessage },
    });
  });

  it.each([
    'Zwiększ dawkę insuliny o 1 jednostkę.',
    'Podaj teraz 2 jednostki insuliny.',
    'Ustaw wyższy basal.',
  ])('accepts a dose or settings suggestion in a TODAY analysis (therapy-suggestion-policy): %s', async (assistantMessage) => {
    const contextPackage = createTimeRangeContext();
    const task = createTimeRangeTask(contextPackage);

    const gateway = new AiGatewayService(new StubProvider(async () => ({
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      received_at: new Date().toISOString(),
      raw_output: { assistant_message: assistantMessage },
    })));

    // Suggestions are decision support for the caregiver, so they are no longer rejected.
    await expect(gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 })).resolves.toMatchObject({
      result: { assistant_message: assistantMessage },
    });
  });

  it('delivers and logs TODAY analysis that turns historical context into direct today observation', async () => {
    const assistantMessage = 'Dzisiaj aktywność przed spadkiem wystąpiła, ponieważ wcześniej widzieliśmy podobny wzorzec.';
    const contextPackage = createTimeRangeContext();
    const task = createTimeRangeTask(contextPackage);

    const gateway = new AiGatewayService(new StubProvider(async () => ({
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      received_at: new Date().toISOString(),
      raw_output: { assistant_message: assistantMessage },
    })));

    // Live 2026-10-16: a flagged phrase discarded a whole answer. The answer is kept and the phrase is logged.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());
    await expect(gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 })).resolves.toMatchObject({
      result: { assistant_message: assistantMessage },
    });
    expect(warn.mock.calls.map((call) => JSON.parse(String(call[0])))).toContainEqual(expect.objectContaining({ event: 'direct_response_boundary_flag', rule: 'HISTORICAL_AS_TODAY' }));
  });

  it.each([
    'Brak aktywności.',
    'Brak aktywności w danych.',
    'No activity was recorded in this range.',
  ])('delivers and logs explicit activity-occurrence denial statements: %s', async (assistantMessage) => {
    const contextPackage = createTimeRangeContext();
    const task = createTimeRangeTask(contextPackage);

    const gateway = new AiGatewayService(new StubProvider(async () => ({
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      received_at: new Date().toISOString(),
      raw_output: { assistant_message: assistantMessage },
    })));

    // Live 2026-10-16: a flagged phrase discarded a whole answer. The answer is kept and the phrase is logged.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());
    await expect(gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 })).resolves.toMatchObject({
      result: { assistant_message: assistantMessage },
    });
    expect(warn.mock.calls.map((call) => JSON.parse(String(call[0])))).toContainEqual(expect.objectContaining({ event: 'direct_response_boundary_flag', rule: 'NO_ACTIVITY_INSTEAD_OF_MISSING' }));
  });

  it('allows response when activity evidence is missing and analysis does not claim activity presence or absence', async () => {
    const assistantMessage = 'Po posiłku widoczny jest wzrost glikemii, a następnie spadek. Z dostępnych danych nie wynika jednoznaczna przyczyna tego przebiegu.';
    const contextPackage = createTimeRangeContext();
    const task = createTimeRangeTask(contextPackage);

    const gateway = new AiGatewayService(new StubProvider(async () => ({
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      received_at: new Date().toISOString(),
      raw_output: { assistant_message: assistantMessage },
    })));

    await expect(gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 })).resolves.toMatchObject({
      result: { assistant_message: assistantMessage },
    });
  });

  it('allows response that acknowledges missing activity intensity/duration while activity evidence exists', async () => {
    const assistantMessage = 'Zarejestrowano aktywność typu WALKING około 10:10, ale brak danych o intensywności i czasie trwania tego zdarzenia.';
    const contextPackage = createTimeRangeContext({
      analytical_evidence: {
        ...createTimeRangeContext().analytical_evidence,
        activity_events: [
          {
            event_id: 'act-1',
            occurred_at: '2026-09-16T10:10:00.000Z',
            payload: { activity_type: 'WALKING' },
            provenance_ref: 'act/1',
          },
        ],
        summaries: {
          ...createTimeRangeContext().analytical_evidence.summaries,
          activity_count: 1,
          missing_sections: [],
        },
      },
    });
    const task = createTimeRangeTask(contextPackage);

    const gateway = new AiGatewayService(new StubProvider(async () => ({
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      received_at: new Date().toISOString(),
      raw_output: { assistant_message: assistantMessage },
    })));

    await expect(gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 })).resolves.toMatchObject({
      result: { assistant_message: assistantMessage },
    });
  });

  it('allows missing-activity-data wording when there is no evidence of presence or absence', async () => {
    const assistantMessage = 'Brak danych o aktywności w tym zakresie czasu, więc wpływ aktywności pozostaje UNKNOWN.';
    const contextPackage = createTimeRangeContext();
    const task = createTimeRangeTask(contextPackage);

    const gateway = new AiGatewayService(new StubProvider(async () => ({
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      received_at: new Date().toISOString(),
      raw_output: { assistant_message: assistantMessage },
    })));

    await expect(gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 })).resolves.toMatchObject({
      result: { assistant_message: assistantMessage },
    });
  });

  it('classifies retryable provider failure', async () => {
    const contextPackage = createDirectResponseContext();
    const task = createDirectResponseTask(contextPackage);
    const gateway = new AiGatewayService(new StubProvider(async () => {
      throw new AiProviderError('rate limited', true, '429');
    }));

    await expect(gateway.execute({ task, context_package: contextPackage })).rejects.toMatchObject({
      code: 'AI_PROVIDER_RETRYABLE',
      retryable: true,
    });
  });

  it('classifies timeout as retryable', async () => {
    const contextPackage = createDirectResponseContext();
    const task = createDirectResponseTask(contextPackage);
    const gateway = new AiGatewayService(new StubProvider(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        provider: 'fake',
        model: 'deterministic-hypo-v1',
        received_at: new Date().toISOString(),
        raw_output: { assistant_message: 'Odpowiedź.' },
      };
    }));

    await expect(gateway.execute({ task, context_package: contextPackage, timeout_ms: 1 })).rejects.toMatchObject({
      code: 'AI_TIMEOUT',
      retryable: true,
    });
  });

  it('produces deterministic task identity and input hash', () => {
    const contextPackage = createDirectResponseContext();
    const task = createDirectResponseTask(contextPackage);

    const firstIdentity = buildAiTaskIdentity(task);
    const secondIdentity = buildAiTaskIdentity({ ...task });
    expect(firstIdentity).toBe(secondIdentity);

    const firstInputHash = buildAiInputHash({ context_package: contextPackage });
    const secondInputHash = buildAiInputHash({ context_package: { ...contextPackage } });

    expect(firstInputHash).toBe(secondInputHash);
  });

  it('changes input hash when time-range window changes', () => {
    const first = createTimeRangeContext({
      analysis_request_input: {
        range_type: 'TODAY',
        range_start: '2026-09-16T00:00:00.000Z',
        range_end: '2026-09-16T23:59:59.999Z',
      },
    });
    const second = createTimeRangeContext({
      analysis_request_input: {
        range_type: 'MEDIUM_RANGE',
        range_start: '2026-09-10T00:00:00.000Z',
        range_end: '2026-09-16T23:59:59.999Z',
      },
    });

    const firstHash = buildAiInputHash({ context_package: first });
    const secondHash = buildAiInputHash({ context_package: second });
    expect(firstHash).not.toBe(secondHash);
  });

  it('accepts supported non-TODAY time range types', async () => {
    const contextPackage = createTimeRangeContext({
      analysis_request_input: {
        range_type: 'MEDIUM_RANGE',
        range_start: '2026-09-10T00:00:00.000Z',
        range_end: '2026-09-16T10:00:00.000Z',
      },
    });
    const task = createTimeRangeTask(contextPackage);

    const gateway = new AiGatewayService(new StubProvider(async () => ({
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      received_at: new Date().toISOString(),
      raw_output: { assistant_message: 'Analiza zakresu MEDIUM_RANGE gotowa.' },
    })));

    const result = await gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 });
    expect(result.result).toEqual({ assistant_message: 'Analiza zakresu MEDIUM_RANGE gotowa.' });
  });

  it('runs shadow telemetry without altering provider input payload', async () => {
    const contextPackage = createTimeRangeContext();
    const task = createTimeRangeTask(contextPackage);
    const expectedHash = buildAiInputHash({ context_package: contextPackage });
    let providerInputHash = '';
    let providerCallCount = 0;

    const gateway = new AiGatewayService(new StubProvider(async (input) => {
      providerCallCount += 1;
      providerInputHash = buildAiInputHash({ context_package: input.context_package });
      return {
        provider: 'fake',
        model: 'deterministic-hypo-v1',
        received_at: new Date().toISOString(),
        raw_output: { assistant_message: 'Analiza dzisiejszego dnia: brak dodatkowych danych o aktywności.' },
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          cached_input_tokens: 0,
          reasoning_tokens: 0,
        },
        serialized_input_bytes: 1000,
      };
    }));

    const result = await gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 });

    expect(providerInputHash).toBe(expectedHash);
    expect(providerCallCount).toBe(1);
    expect(result.metadata.context_package_usage?.shadow_selection).toBeTruthy();
  });

  it('uses a single validated time-range envelope path and never sends analytical_evidence to provider', async () => {
    const contextPackage = createTimeRangeContext();
    const task = createTimeRangeTask(contextPackage);
    let providerUserPayload: Record<string, unknown> | null = null;

    const gateway = new AiGatewayService(new StubProvider(async (input) => {
      providerUserPayload = JSON.parse(input.prompt.user_payload) as Record<string, unknown>;
      return {
        provider: 'fake',
        model: 'deterministic-hypo-v1',
        received_at: new Date().toISOString(),
        raw_output: { assistant_message: 'Analiza zakresu gotowa.' },
        usage: {
          input_tokens: 210,
          output_tokens: 20,
          total_tokens: 230,
          cached_input_tokens: 0,
          reasoning_tokens: 0,
        },
        serialized_input_bytes: 1150,
      };
    }));

    const result = await gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 });

    expect(providerUserPayload).not.toBeNull();
    expect((providerUserPayload as Record<string, unknown>).selected_evidence).toBeTruthy();
    expect((providerUserPayload as Record<string, unknown>).analytical_evidence).toBeUndefined();
    expect((providerUserPayload as Record<string, unknown>).compact_delivery_artifact).toBeUndefined();
    expect(result.metadata.context_package_usage?.delivery).toMatchObject({
      delivery_path: 'SINGLE_VALIDATED_ENVELOPE_V1',
      evidence_loop_enabled: false,
    });
  });

  it('always emits the single validated envelope for time-range requests', async () => {
    const contextPackage = createTimeRangeContext();
    const task = createTimeRangeTask(contextPackage);
    let providerUserPayload: Record<string, unknown> | null = null;

    const gateway = new AiGatewayService(new StubProvider(async (input) => {
      providerUserPayload = JSON.parse(input.prompt.user_payload) as Record<string, unknown>;
      return {
        provider: 'fake',
        model: 'deterministic-hypo-v1',
        received_at: new Date().toISOString(),
        raw_output: { assistant_message: 'Analiza zakresu gotowa.' },
      };
    }));

    await gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 });

    expect(providerUserPayload).not.toBeNull();
    expect((providerUserPayload as Record<string, unknown>).selected_evidence).toBeTruthy();
    expect((providerUserPayload as Record<string, unknown>).compact_delivery_artifact).toBeUndefined();
  });

  it('keeps shadow metadata persisted on a successful execution', async () => {
    const contextPackage = createDirectResponseContext();
    const task = createDirectResponseTask(contextPackage);

    const gateway = new AiGatewayService(new StubProvider(async () => ({
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      received_at: new Date().toISOString(),
      raw_output: { assistant_message: 'Odpowiedź.' },
      usage: {
        input_tokens: 120,
        output_tokens: 24,
        total_tokens: 144,
        cached_input_tokens: 0,
        reasoning_tokens: 0,
      },
      serialized_input_bytes: 1600,
    })));

    const result = await gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 });

    expect(result.task.task_type).toBe('CONVERSATION_DIRECT_RESPONSE');
    expect(result.metadata.context_package_usage?.shadow_selection).toBeTruthy();
    expect(result.metadata.context_package_usage?.sections.some((section) => section.section_name === 'shadow_selection')).toBe(true);
  });

  it('shadow failure does not block provider execution', async () => {
    const contextPackage = createDirectResponseContext();
    const task = createDirectResponseTask(contextPackage);
    const shadowSpy = vi.spyOn(EvidenceSelectionShadow, 'evaluateEvidenceSelectionShadowSafe').mockReturnValue({
      shadow_version: 'evidence-selection-shadow.v1',
      task_type: task.task_type,
      task_identity: 'sha256:shadow-failed',
      patient_id: task.patient_id ?? null,
      context_package_id: contextPackage.context_package_id,
      context_package_version: contextPackage.context_package_version,
      context_package_hash: contextPackage.content_hash,
      evidence_representation_version: contextPackage.context_package_version,
      task_evidence_policy_version: 'task-evidence-policy.v1',
      evidence_selection_policy_version: 'evidence-selection-policy.v1',
      evidence_relationship_semantics_version: 'evidence-relationship-semantics.v1',
      selection_profile: 'UNKNOWN',
      default_level: 'UNKNOWN',
      selected_level: 'UNKNOWN',
      status: 'SHADOW_SELECTION_FAILED',
      selected_evidence_families: [],
      selected_evidence_ref_count: 0,
      selected_evidence_refs_sample: [],
      omitted_evidence_ref_count: 0,
      omitted_evidence_refs_sample: [],
      relationship_decisions: [],
      unresolved_reasons: ['SHADOW_SELECTION_FAILED'],
      unknowns: ['forced failure'],
      missing: [],
      excluded: [],
      not_selected: [],
      provenance_refs_sample: [],
      input_material_hash: 'sha256:in',
      selection_material_hash: 'sha256:sel',
      current_payload_bytes: 0,
      current_payload_tokens: null,
      current_payload_tokens_kind: 'UNAVAILABLE',
      shadow_payload_bytes: 0,
      shadow_payload_tokens_estimate: null,
      shadow_payload_tokens_kind: 'UNAVAILABLE',
      bytes_saved: 0,
      bytes_reduction_pct: 0,
      token_reduction_estimate: null,
      token_reduction_pct_estimate: null,
      family_counts: {},
      telemetry_bounded: true,
      failed_reason: 'forced',
    });

    let providerCallCount = 0;
    const gateway = new AiGatewayService(new StubProvider(async () => {
      providerCallCount += 1;
      return {
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      received_at: new Date().toISOString(),
      raw_output: { assistant_message: 'To jest odpowiedz bez blokady.' },
      };
    }));

    const result = await gateway.execute({ task, context_package: contextPackage, timeout_ms: 1000 });
    expect(result.result).toEqual({ assistant_message: 'To jest odpowiedz bez blokady.' });
    expect(providerCallCount).toBe(1);
    expect(result.metadata.context_package_usage?.shadow_selection?.['status']).toBe('SHADOW_SELECTION_FAILED');

    shadowSpy.mockRestore();
  });

  it('enables evidence tool loop when the feature flag is set to a truthy string like true', async () => {
    const previousFlag = process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
    process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = 'true';

    try {
      const contextPackage = createTimeRangeContext({
        analytical_evidence: {
          glucose_events: [
            { event_id: 'g-1', occurred_at: '2026-09-16T06:10:00.000Z', payload: { glucose_value: 92 } },
            { event_id: 'g-2', occurred_at: '2026-09-16T06:20:00.000Z', payload: { glucose_value: 74 } },
            { event_id: 'g-3', occurred_at: '2026-09-16T06:30:00.000Z', payload: { glucose_value: 68 } },
          ],
          insulin_treatment_events: [],
          meal_events: [],
          activity_events: [],
          hypo_episodes: [],
          range_event_facts: [],
          summaries: {
            total_events: 3,
            glucose_count: 3,
            insulin_treatment_count: 0,
            meal_count: 0,
            activity_count: 0,
            hypo_episode_count: 0,
            glucose_min: 68,
            glucose_max: 92,
            glucose_avg: 78,
            missing_sections: [],
          },
        },
      });
      const task = createTimeRangeTask(contextPackage);

      let providerCall = 0;
      const gateway = new AiGatewayService(new StubProvider(async (input) => {
        providerCall += 1;
        if (providerCall === 1) {
          expect(String(input.prompt.user_payload)).not.toContain('"analytical_evidence"');
          return {
            provider: 'fake',
            model: 'deterministic-hypo-v1',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_call: {
              call_id: 'call-1',
              tool_name: 'get_glucose_evidence',
              arguments: {
                time_range: {
                  from: '2026-09-16T06:00:00.000Z',
                  to: '2026-09-16T07:00:00.000Z',
                },
                detail_level: 'DETAIL',
              },
            },
          };
        }

        expect(String(input.prompt.user_payload)).not.toContain('"analytical_evidence"');
        expect(input.tool_runtime?.available_tools?.some((tool: { name: string }) => tool.name === 'get_glucose_evidence')).toBe(true);
        return {
          provider: 'fake',
          model: 'deterministic-hypo-v1',
          received_at: new Date().toISOString(),
          raw_output: { assistant_message: 'Analiza zakresu gotowa z true.' },
        };
      }));

      const result = await gateway.execute({ task, context_package: contextPackage, timeout_ms: 1500 });
      expect(result.result).toEqual({ assistant_message: 'Analiza zakresu gotowa z true.' });
      expect(providerCall).toBe(2);
    } finally {
      if (previousFlag === undefined) {
        delete process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
      } else {
        process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = previousFlag;
      }
    }
  });

  it('executes first real time-range tool flow: provider tool call -> glucose evidence -> final response', async () => {
    const previousFlag = process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
    process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = '1';

    try {
      const contextPackage = createTimeRangeContext({
        analytical_evidence: {
          glucose_events: [
            { event_id: 'g-1', occurred_at: '2026-09-16T06:10:00.000Z', payload: { glucose_value: 92 } },
            { event_id: 'g-2', occurred_at: '2026-09-16T06:20:00.000Z', payload: { glucose_value: 74 } },
            { event_id: 'g-3', occurred_at: '2026-09-16T06:30:00.000Z', payload: { glucose_value: 68 } },
          ],
          insulin_treatment_events: [],
          meal_events: [],
          activity_events: [],
          hypo_episodes: [],
          range_event_facts: [],
          summaries: {
            total_events: 3,
            glucose_count: 3,
            insulin_treatment_count: 0,
            meal_count: 0,
            activity_count: 0,
            hypo_episode_count: 0,
            glucose_min: 68,
            glucose_max: 92,
            glucose_avg: 78,
            missing_sections: [],
          },
        },
      });
      const task = createTimeRangeTask(contextPackage);

      const providerInputs: AiProviderInput[] = [];
      let providerCall = 0;
      const steps: Array<{ type: string; tool?: string | null }> = [];
      const gateway = new AiGatewayService(new StubProvider(async (input) => {
        providerInputs.push(input);
        providerCall += 1;
        if (providerCall === 1) {
          expect(String(input.prompt.user_payload)).not.toContain('"analytical_evidence"');
          const availableTools = (input.tool_runtime?.available_tools ?? []).map((tool) => tool.name);
          expect(availableTools).toEqual([
            'get_glucose_evidence',
            'get_insulin_evidence',
            'get_basal_evidence',
            'get_meal_evidence',
            'get_activity_evidence',
            'get_loop_evidence',
            'get_therapy_profile',
          ]);
          return {
            provider: 'fake',
            model: 'deterministic-hypo-v1',
            response_id: 'resp-1',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_call: {
              call_id: 'call-1',
              tool_name: 'get_glucose_evidence',
              arguments: {
                time_range: {
                  from: '2026-09-16T06:00:00.000Z',
                  to: '2026-09-16T07:00:00.000Z',
                },
                detail_level: 'DETAIL',
              },
            },
          };
        }

        return {
          provider: 'fake',
          model: 'deterministic-hypo-v1',
          received_at: new Date().toISOString(),
          raw_output: { assistant_message: 'Analiza zakresu gotowa.' },
        };
      }));

      const result = await gateway.execute({
        task,
        context_package: contextPackage,
        timeout_ms: 1500,
        processing_observer: {
          onStep: (step) => {
            steps.push({ type: step.type, tool: step.tool ?? null });
          },
        },
      });

      expect(result.result).toEqual({ assistant_message: 'Analiza zakresu gotowa.' });
      expect(providerCall).toBe(2);
      expect(providerInputs.every((entry) => !String(entry.prompt.user_payload).includes('"analytical_evidence"'))).toBe(true);
      expect(providerInputs[0]?.previous_response_id).toBeUndefined();
      expect(providerInputs[1]?.previous_response_id).toBe('resp-1');
      expect(steps.map((step) => [step.type, step.tool ?? null])).toEqual([
        ['ANALYZING_REQUEST', null],
        ['REQUESTING_EVIDENCE', 'get_glucose_evidence'],
        ['ANALYZING_EVIDENCE', 'get_glucose_evidence'],
        ['GENERATING_RESPONSE', null],
        ['COMPLETED', null],
      ]);

      const secondCallToolResults = providerInputs[1]?.tool_runtime?.tool_results ?? [];
      expect(secondCallToolResults.length).toBe(1);
      expect(secondCallToolResults[0]?.call_id).toBe('call-1');
      const toolResultPayload = secondCallToolResults[0]?.result ?? {};
      expect(toolResultPayload['evidence']).toBeTruthy();
      expect(toolResultPayload['coverage']).toBeTruthy();
      const payloadText = JSON.stringify(toolResultPayload);
      expect(payloadText.includes('raw_payload')).toBe(false);
      expect(payloadText.includes('context_package_id')).toBe(false);
    } finally {
      if (previousFlag === undefined) {
        delete process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
      } else {
        process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = previousFlag;
      }
    }
  });

  it('supports sequential progressive tool calls across responses with max budget 3 and preserved call ids', async () => {
    const previousFlag = process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
    process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = '1';
    // Asserts the full-resend request construction (the chained default is covered in ai-gateway.chained-tool-results.spec).
    vi.stubEnv('AI_EXPERIMENT_OMIT_CHAINED_TOOL_RESULTS', '0');
    onTestFinished(() => vi.unstubAllEnvs());

    try {
      const contextPackage = createTimeRangeContext({
        analytical_evidence: {
          glucose_events: [
            { event_id: 'g-1', occurred_at: '2026-09-16T06:10:00.000Z', payload: { glucose_value: 92 } },
            { event_id: 'g-2', occurred_at: '2026-09-16T06:20:00.000Z', payload: { glucose_value: 74 } },
            { event_id: 'g-3', occurred_at: '2026-09-16T06:30:00.000Z', payload: { glucose_value: 68 } },
          ],
          insulin_treatment_events: [
            { event_id: 'i-1', occurred_at: '2026-09-16T06:05:00.000Z', kind: 'BOLUS', amount: 1.2, unit: 'U' },
          ],
          meal_events: [
            { event_id: 'm-1', occurred_at: '2026-09-16T06:00:00.000Z', carbs: 18 },
          ],
          activity_events: [],
          hypo_episodes: [],
          range_event_facts: [],
          summaries: {
            total_events: 5,
            glucose_count: 3,
            insulin_treatment_count: 1,
            meal_count: 1,
            activity_count: 0,
            hypo_episode_count: 0,
            glucose_min: 68,
            glucose_max: 92,
            glucose_avg: 78,
            missing_sections: [],
          },
        },
      });
      const task = createTimeRangeTask(contextPackage);

      const providerInputs: AiProviderInput[] = [];
      let providerCall = 0;
      const gateway = new AiGatewayService(new StubProvider(async (input) => {
        providerInputs.push(input);
        providerCall += 1;

        if (providerCall === 1) {
          expect(input.previous_response_id).toBeUndefined();
          return {
            provider: 'fake',
            model: 'deterministic-hypo-v1',
            response_id: 'resp-1',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_call: {
              call_id: 'call-1',
              tool_name: 'get_glucose_evidence',
              arguments: {
                time_range: {
                  from: '2026-09-16T06:00:00.000Z',
                  to: '2026-09-16T07:00:00.000Z',
                },
                detail_level: 'SUMMARY',
              },
            },
          };
        }

        if (providerCall === 2) {
          expect(input.previous_response_id).toBe('resp-1');
          const toolResults = input.tool_runtime?.tool_results ?? [];
          expect(toolResults.length).toBe(1);
          expect(toolResults[0]?.call_id).toBe('call-1');
          expect(toolResults[0]?.tool_name).toBe('get_glucose_evidence');

          return {
            provider: 'fake',
            model: 'deterministic-hypo-v1',
            response_id: 'resp-2',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_call: {
              call_id: 'call-2',
              tool_name: 'get_insulin_evidence',
              arguments: {
                time_range: {
                  from: '2026-09-16T06:00:00.000Z',
                  to: '2026-09-16T07:00:00.000Z',
                },
                detail_level: 'SUMMARY',
              },
            },
          };
        }

        if (providerCall === 3) {
          expect(input.previous_response_id).toBe('resp-2');
          const toolResults = input.tool_runtime?.tool_results ?? [];
          expect(toolResults.length).toBe(2);
          expect(toolResults[0]?.call_id).toBe('call-1');
          expect(toolResults[1]?.call_id).toBe('call-2');

          return {
            provider: 'fake',
            model: 'deterministic-hypo-v1',
            response_id: 'resp-3',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_call: {
              call_id: 'call-3',
              tool_name: 'get_meal_evidence',
              arguments: {
                time_range: {
                  from: '2026-09-16T06:00:00.000Z',
                  to: '2026-09-16T07:00:00.000Z',
                },
                detail_level: 'SUMMARY',
              },
            },
          };
        }

        expect(input.previous_response_id).toBe('resp-3');
        const toolResults = input.tool_runtime?.tool_results ?? [];
        expect(toolResults.length).toBe(3);
        expect(toolResults[0]?.call_id).toBe('call-1');
        expect(toolResults[1]?.call_id).toBe('call-2');
        expect(toolResults[2]?.call_id).toBe('call-3');
        expect(input.tool_runtime?.max_tool_calls_remaining).toBe(0);

        return {
          provider: 'fake',
          model: 'deterministic-hypo-v1',
          response_id: 'resp-4',
          received_at: new Date().toISOString(),
          raw_output: { assistant_message: 'Największym problemem była duża zmienność glikemii rano.' },
        };
      }));

      const result = await gateway.execute({
        task,
        context_package: contextPackage,
        timeout_ms: 1500,
      });

      expect(result.result).toEqual({ assistant_message: 'Największym problemem była duża zmienność glikemii rano.' });
      expect(providerCall).toBe(4);
      expect(providerInputs.every((entry) => !String(entry.prompt.user_payload).includes('"analytical_evidence"'))).toBe(true);
      expect(providerInputs[0]?.tool_runtime?.max_tool_calls_remaining).toBe(3);
      expect(providerInputs[1]?.tool_runtime?.max_tool_calls_remaining).toBe(2);
      expect(providerInputs[2]?.tool_runtime?.max_tool_calls_remaining).toBe(1);
      expect(providerInputs[3]?.tool_runtime?.max_tool_calls_remaining).toBe(0);
    } finally {
      if (previousFlag === undefined) {
        delete process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
      } else {
        process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = previousFlag;
      }
    }
  });

  it('finalizes after budget exhaustion with one tool_choice none request and final assistant response', async () => {
    const previousFlag = process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
    process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = '1';
    // Asserts the full-resend request construction (the chained default is covered in ai-gateway.chained-tool-results.spec).
    vi.stubEnv('AI_EXPERIMENT_OMIT_CHAINED_TOOL_RESULTS', '0');
    onTestFinished(() => vi.unstubAllEnvs());

    try {
      const contextPackage = createTimeRangeContext({
        analytical_evidence: {
          glucose_events: [
            { event_id: 'g-1', occurred_at: '2026-09-16T06:10:00.000Z', payload: { glucose_value: 92 } },
            { event_id: 'g-2', occurred_at: '2026-09-16T06:20:00.000Z', payload: { glucose_value: 74 } },
            { event_id: 'g-3', occurred_at: '2026-09-16T06:30:00.000Z', payload: { glucose_value: 68 } },
          ],
          insulin_treatment_events: [
            { event_id: 'i-1', occurred_at: '2026-09-16T06:05:00.000Z', kind: 'BOLUS', amount: 1.2, unit: 'U' },
          ],
          meal_events: [
            { event_id: 'm-1', occurred_at: '2026-09-16T06:00:00.000Z', carbs: 18 },
          ],
          activity_events: [],
          hypo_episodes: [],
          range_event_facts: [],
          summaries: {
            total_events: 5,
            glucose_count: 3,
            insulin_treatment_count: 1,
            meal_count: 1,
            activity_count: 0,
            hypo_episode_count: 0,
            glucose_min: 68,
            glucose_max: 92,
            glucose_avg: 78,
            missing_sections: [],
          },
        },
      });
      const task = createTimeRangeTask(contextPackage);

      const providerInputs: AiProviderInput[] = [];
      let providerCall = 0;
      const gateway = new AiGatewayService(new StubProvider(async (input) => {
        providerInputs.push(input);
        providerCall += 1;

        if (providerCall === 1) {
          expect(input.previous_response_id).toBeUndefined();
          expect(input.tool_runtime?.available_tools?.length).toBe(7);
          expect(input.tool_runtime?.max_tool_calls_remaining).toBe(3);
          return {
            provider: 'fake',
            model: 'deterministic-hypo-v1',
            response_id: 'resp-1',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_call: {
              call_id: 'call-1',
              tool_name: 'get_glucose_evidence',
              arguments: {
                time_range: {
                  from: '2026-09-16T06:00:00.000Z',
                  to: '2026-09-16T07:00:00.000Z',
                },
                detail_level: 'SUMMARY',
              },
            },
          };
        }

        if (providerCall === 2) {
          expect(input.previous_response_id).toBe('resp-1');
          expect(input.tool_runtime?.available_tools?.length).toBe(7);
          expect(input.tool_runtime?.max_tool_calls_remaining).toBe(2);
          const toolResults = input.tool_runtime?.tool_results ?? [];
          expect(toolResults.length).toBe(1);
          expect(toolResults[0]?.call_id).toBe('call-1');

          return {
            provider: 'fake',
            model: 'deterministic-hypo-v1',
            response_id: 'resp-2',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_call: {
              call_id: 'call-2',
              tool_name: 'get_insulin_evidence',
              arguments: {
                time_range: {
                  from: '2026-09-16T06:00:00.000Z',
                  to: '2026-09-16T07:00:00.000Z',
                },
                detail_level: 'SUMMARY',
              },
            },
          };
        }

        if (providerCall === 3) {
          expect(input.previous_response_id).toBe('resp-2');
          expect(input.tool_runtime?.available_tools?.length).toBe(7);
          expect(input.tool_runtime?.max_tool_calls_remaining).toBe(1);
          const toolResults = input.tool_runtime?.tool_results ?? [];
          expect(toolResults.length).toBe(2);
          expect(toolResults[0]?.call_id).toBe('call-1');
          expect(toolResults[1]?.call_id).toBe('call-2');

          return {
            provider: 'fake',
            model: 'deterministic-hypo-v1',
            response_id: 'resp-3',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_call: {
              call_id: 'call-3',
              tool_name: 'get_meal_evidence',
              arguments: {
                time_range: {
                  from: '2026-09-16T06:00:00.000Z',
                  to: '2026-09-16T07:00:00.000Z',
                },
                detail_level: 'SUMMARY',
              },
            },
          };
        }

        if (providerCall === 4) {
          expect(input.previous_response_id).toBe('resp-3');
          expect(input.tool_runtime?.max_tool_calls_remaining).toBe(0);
          expect(input.tool_runtime?.tool_choice).toBe('none');
          expect(input.tool_runtime?.tool_results.map((entry) => entry.call_id)).toEqual(['call-1', 'call-2', 'call-3']);
          expect(String(input.prompt.system_instructions)).toContain('FINALIZATION MODE: EVIDENCE_BUDGET_EXHAUSTED.');
          expect(String(input.prompt.system_instructions)).toContain('Do not request additional evidence or tools.');
          expect(String(input.prompt.system_instructions)).toContain('Answer now using only the evidence already retrieved.');
          expect(String(input.prompt.system_instructions)).toContain('represent it as UNKNOWN rather than assuming NO.');

          return {
            provider: 'fake',
            model: 'deterministic-hypo-v1',
            response_id: 'resp-4',
            received_at: new Date().toISOString(),
            raw_output: { assistant_message: 'Największym problemem była zmienność glikemii z ograniczonym kontekstem aktywności (UNKNOWN).' },
          };
        }

        throw new Error(`Unexpected provider call: ${providerCall}`);
      }));

      const result = await gateway.execute({
        task,
        context_package: contextPackage,
        timeout_ms: 1500,
      });

      expect(result.result).toEqual({ assistant_message: 'Największym problemem była zmienność glikemii z ograniczonym kontekstem aktywności (UNKNOWN).' });
      expect(providerCall).toBe(4);
      expect(providerInputs.every((entry) => !String(entry.prompt.user_payload).includes('"analytical_evidence"'))).toBe(true);

      const maxCallsRemainingByTurn = providerInputs.map((entry) => entry.tool_runtime?.max_tool_calls_remaining ?? null);
      expect(maxCallsRemainingByTurn).toEqual([3, 2, 1, 0]);
      const toolsCountByTurn = providerInputs.map((entry) => (entry.tool_runtime?.available_tools ?? []).length);
      // The final turn keeps the definitions (cache prefix) and forbids tool calls with tool_choice 'none'.
      expect(toolsCountByTurn).toEqual([7, 7, 7, 7]);
      expect(providerInputs.map((entry) => entry.tool_runtime?.tool_choice ?? null)).toEqual([null, null, null, 'none']);
    } finally {
      if (previousFlag === undefined) {
        delete process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
      } else {
        process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = previousFlag;
      }
    }
  });

  it('records evidence session observer events for batched multi-tool retrieval with call_id association', async () => {
    const previousFlag = process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
    process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = '1';

    try {
      const contextPackage = createTimeRangeContext({
        analytical_evidence: {
          glucose_events: [
            { event_id: 'g-1', occurred_at: '2026-09-16T06:10:00.000Z', payload: { glucose_value: 92 } },
            { event_id: 'g-2', occurred_at: '2026-09-16T06:20:00.000Z', payload: { glucose_value: 74 } },
          ],
          insulin_treatment_events: [
            { event_id: 'i-1', occurred_at: '2026-09-16T05:45:00.000Z', kind: 'BOLUS', amount: 1.2, unit: 'U' },
          ],
          meal_events: [],
          activity_events: [],
          hypo_episodes: [],
          range_event_facts: [],
          summaries: {
            total_events: 3,
            glucose_count: 2,
            insulin_treatment_count: 1,
            meal_count: 0,
            activity_count: 0,
            hypo_episode_count: 0,
            glucose_min: 74,
            glucose_max: 92,
            glucose_avg: 83,
            missing_sections: [],
          },
        },
      });
      const task = createTimeRangeTask(contextPackage);

      let providerCall = 0;
      const sessionStarts: Array<Record<string, unknown>> = [];
      const requestedCalls: Array<Record<string, unknown>> = [];
      const successfulCalls: Array<Record<string, unknown>> = [];
      const gateway = new AiGatewayService(new StubProvider(async () => {
        providerCall += 1;
        if (providerCall === 1) {
          return {
            provider: 'fake',
            model: 'deterministic-hypo-v1',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_calls: [
              {
                call_id: 'call-g',
                tool_name: 'get_glucose_evidence',
                arguments: {
                  time_range: { from: '2026-09-16T06:00:00.000Z', to: '2026-09-16T07:00:00.000Z' },
                  detail_level: 'DETAIL',
                },
              },
              {
                call_id: 'call-i',
                tool_name: 'get_insulin_evidence',
                arguments: {
                  time_range: { from: '2026-09-16T05:00:00.000Z', to: '2026-09-16T07:00:00.000Z' },
                  detail_level: 'SUMMARY',
                },
              },
              {
                call_id: 'call-m',
                tool_name: 'get_meal_evidence',
                arguments: {
                  time_range: { from: '2026-09-16T05:00:00.000Z', to: '2026-09-16T07:00:00.000Z' },
                  detail_level: 'SUMMARY',
                },
              },
            ],
          };
        }

        return {
          provider: 'fake',
          model: 'deterministic-hypo-v1',
          received_at: new Date().toISOString(),
          raw_output: { assistant_message: 'Batch retrieval complete.' },
        };
      }));

      const result = await gateway.execute({
        task,
        context_package: contextPackage,
        timeout_ms: 2000,
        evidence_session_observer: {
          onSessionStarted: async (args) => {
            sessionStarts.push(args as unknown as Record<string, unknown>);
          },
          onToolCallRequested: async (args) => {
            requestedCalls.push(args as unknown as Record<string, unknown>);
          },
          onToolCallSucceeded: async (args) => {
            successfulCalls.push(args as unknown as Record<string, unknown>);
          },
          onToolCallFailed: async () => {
            throw new Error('Unexpected failure callback in batch success test');
          },
        },
      });

      expect(result.result).toEqual({ assistant_message: 'Batch retrieval complete.' });
      expect(providerCall).toBe(2);

      expect(sessionStarts.length).toBe(1);
      expect(String(sessionStarts[0].task_type)).toBe('CONVERSATION_TIME_RANGE_ANALYSIS');
      expect(Number(sessionStarts[0].initial_evidence_bytes ?? 0)).toBeGreaterThan(0);
      expect(String(sessionStarts[0].initial_evidence_hash ?? '')).toContain('sha256:');

      expect(requestedCalls.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
      expect(requestedCalls.map((entry) => entry.call_id)).toEqual(['call-g', 'call-i', 'call-m']);
      expect(requestedCalls.map((entry) => entry.tool_name)).toEqual([
        'get_glucose_evidence',
        'get_insulin_evidence',
        'get_meal_evidence',
      ]);

      expect(successfulCalls.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
      expect(successfulCalls.every((entry) => Number(entry.result_bytes ?? 0) > 0)).toBe(true);
      expect(successfulCalls.every((entry) => String(entry.result_hash ?? '').length > 0)).toBe(true);
    } finally {
      if (previousFlag === undefined) {
        delete process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
      } else {
        process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = previousFlag;
      }
    }
  });

  it('records evidence session observer events for sequential tool retrieval across turns', async () => {
    const previousFlag = process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
    process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = '1';

    try {
      const contextPackage = createTimeRangeContext({
        analytical_evidence: {
          glucose_events: [
            { event_id: 'g-1', occurred_at: '2026-09-16T06:10:00.000Z', payload: { glucose_value: 92 } },
          ],
          insulin_treatment_events: [],
          meal_events: [],
          activity_events: [],
          hypo_episodes: [],
          range_event_facts: [],
          summaries: {
            total_events: 1,
            glucose_count: 1,
            insulin_treatment_count: 0,
            meal_count: 0,
            activity_count: 0,
            hypo_episode_count: 0,
            glucose_min: 92,
            glucose_max: 92,
            glucose_avg: 92,
            missing_sections: [],
          },
        },
      });
      const task = createTimeRangeTask(contextPackage);

      let providerCall = 0;
      const requestedCalls: Array<Record<string, unknown>> = [];
      const successfulCalls: Array<Record<string, unknown>> = [];
      const gateway = new AiGatewayService(new StubProvider(async () => {
        providerCall += 1;
        if (providerCall === 1) {
          return {
            provider: 'fake',
            model: 'deterministic-hypo-v1',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_call: {
              call_id: 'seq-g',
              tool_name: 'get_glucose_evidence',
              arguments: {
                time_range: { from: '2026-09-16T06:00:00.000Z', to: '2026-09-16T07:00:00.000Z' },
                detail_level: 'SUMMARY',
              },
            },
          };
        }
        if (providerCall === 2) {
          return {
            provider: 'fake',
            model: 'deterministic-hypo-v1',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_call: {
              call_id: 'seq-i',
              tool_name: 'get_insulin_evidence',
              arguments: {
                time_range: { from: '2026-09-16T06:00:00.000Z', to: '2026-09-16T07:00:00.000Z' },
                detail_level: 'SUMMARY',
              },
            },
          };
        }
        if (providerCall === 3) {
          return {
            provider: 'fake',
            model: 'deterministic-hypo-v1',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_call: {
              call_id: 'seq-a',
              tool_name: 'get_activity_evidence',
              arguments: {
                time_range: { from: '2026-09-16T06:00:00.000Z', to: '2026-09-16T07:00:00.000Z' },
                detail_level: 'SUMMARY',
              },
            },
          };
        }

        return {
          provider: 'fake',
          model: 'deterministic-hypo-v1',
          received_at: new Date().toISOString(),
          raw_output: { assistant_message: 'Sequential retrieval complete.' },
        };
      }));

      const result = await gateway.execute({
        task,
        context_package: contextPackage,
        timeout_ms: 2500,
        evidence_session_observer: {
          onSessionStarted: async () => {},
          onToolCallRequested: async (args) => {
            requestedCalls.push(args as unknown as Record<string, unknown>);
          },
          onToolCallSucceeded: async (args) => {
            successfulCalls.push(args as unknown as Record<string, unknown>);
          },
          onToolCallFailed: async () => {
            throw new Error('Unexpected failure callback in sequential success test');
          },
        },
      });

      expect(result.result).toEqual({ assistant_message: 'Sequential retrieval complete.' });
      expect(providerCall).toBe(4);
      expect(requestedCalls.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
      expect(requestedCalls.map((entry) => entry.call_id)).toEqual(['seq-g', 'seq-i', 'seq-a']);
      expect(requestedCalls.map((entry) => entry.tool_name)).toEqual([
        'get_glucose_evidence',
        'get_insulin_evidence',
        'get_activity_evidence',
      ]);
      expect(successfulCalls.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    } finally {
      if (previousFlag === undefined) {
        delete process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
      } else {
        process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = previousFlag;
      }
    }
  });

  it('rejects forbidden parameters in glucose tool call arguments', async () => {
    const previousFlag = process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
    process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = '1';

    try {
      const contextPackage = createTimeRangeContext();
      const task = createTimeRangeTask(contextPackage);
      const gateway = new AiGatewayService(new StubProvider(async () => ({
        provider: 'fake',
        model: 'deterministic-hypo-v1',
        received_at: new Date().toISOString(),
        raw_output: {},
        tool_call: {
          call_id: 'call-forbidden',
          tool_name: 'get_glucose_evidence',
          arguments: {
            patient_id: 'other-patient',
          },
        },
      })));

      await expect(gateway.execute({ task, context_package: contextPackage, timeout_ms: 1500 })).rejects.toMatchObject({
        code: 'AI_CONTRACT_VIOLATION',
      });
    } finally {
      if (previousFlag === undefined) {
        delete process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
      } else {
        process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = previousFlag;
      }
    }
  });

  it('fails duplicate glucose tool request in the same execution', async () => {
    const previousFlag = process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
    process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = '1';

    try {
      const contextPackage = createTimeRangeContext({
        analytical_evidence: {
          glucose_events: [{ event_id: 'g-1', occurred_at: '2026-09-16T06:10:00.000Z', payload: { glucose_value: 92 } }],
          insulin_treatment_events: [],
          meal_events: [],
          activity_events: [],
          hypo_episodes: [],
          range_event_facts: [],
          summaries: {
            total_events: 1,
            glucose_count: 1,
            insulin_treatment_count: 0,
            meal_count: 0,
            activity_count: 0,
            hypo_episode_count: 0,
            glucose_min: 92,
            glucose_max: 92,
            glucose_avg: 92,
            missing_sections: [],
          },
        },
      });
      const task = createTimeRangeTask(contextPackage);

      let providerCall = 0;
      const gateway = new AiGatewayService(new StubProvider(async () => {
        providerCall += 1;
        return {
          provider: 'fake',
          model: 'deterministic-hypo-v1',
          received_at: new Date().toISOString(),
          raw_output: {},
          tool_call: {
            call_id: `call-${providerCall}`,
            tool_name: 'get_glucose_evidence',
            arguments: {
              time_range: {
                from: '2026-09-16T06:00:00.000Z',
                to: '2026-09-16T07:00:00.000Z',
              },
              detail_level: 'SUMMARY',
            },
          },
        };
      }));

      await expect(gateway.execute({ task, context_package: contextPackage, timeout_ms: 1500 })).rejects.toMatchObject({
        code: 'AI_CONTRACT_VIOLATION',
      });
    } finally {
      if (previousFlag === undefined) {
        delete process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
      } else {
        process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = previousFlag;
      }
    }
  });

  it('emits FAILED step when provider fails after glucose tool result', async () => {
    const previousFlag = process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
    process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = '1';

    try {
      const contextPackage = createTimeRangeContext({
        analytical_evidence: {
          glucose_events: [{ event_id: 'g-1', occurred_at: '2026-09-16T06:10:00.000Z', payload: { glucose_value: 92 } }],
          insulin_treatment_events: [],
          meal_events: [],
          activity_events: [],
          hypo_episodes: [],
          range_event_facts: [],
          summaries: {
            total_events: 1,
            glucose_count: 1,
            insulin_treatment_count: 0,
            meal_count: 0,
            activity_count: 0,
            hypo_episode_count: 0,
            glucose_min: 92,
            glucose_max: 92,
            glucose_avg: 92,
            missing_sections: [],
          },
        },
      });
      const task = createTimeRangeTask(contextPackage);

      let providerCall = 0;
      const steps: string[] = [];
      const gateway = new AiGatewayService(new StubProvider(async () => {
        providerCall += 1;
        if (providerCall === 1) {
          return {
            provider: 'fake',
            model: 'deterministic-hypo-v1',
            received_at: new Date().toISOString(),
            raw_output: {},
            tool_call: {
              call_id: 'call-before-failure',
              tool_name: 'get_glucose_evidence',
              arguments: {
                time_range: {
                  from: '2026-09-16T06:00:00.000Z',
                  to: '2026-09-16T07:00:00.000Z',
                },
                detail_level: 'SUMMARY',
              },
            },
          };
        }

        throw new AiProviderError('provider failed after tool call', 'UPSTREAM_FAILURE', true);
      }));

      await expect(gateway.execute({
        task,
        context_package: contextPackage,
        timeout_ms: 1500,
        processing_observer: {
          onStep: (step) => {
            steps.push(step.type);
          },
        },
      })).rejects.toMatchObject({
        code: 'AI_PROVIDER_RETRYABLE',
      });

      expect(steps).toContain('FAILED');
    } finally {
      if (previousFlag === undefined) {
        delete process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING;
      } else {
        process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = previousFlag;
      }
    }
  });

  it('exposes provider boundary without therapy/db mutation methods', () => {
    const provider = {
      async generate(): Promise<AiProviderResponse> {
        return {
          provider: 'fake',
          model: 'deterministic-hypo-v1',
          raw_output: { assistant_message: 'Odpowiedź.' },
          received_at: new Date().toISOString(),
        };
      },
    } satisfies AiProvider;

    expect('deliverInsulin' in provider).toBe(false);
    expect('mutateTherapy' in provider).toBe(false);
    expect('mutateNightscout' in provider).toBe(false);
    expect('queryDatabase' in provider).toBe(false);
  });
});

describe('wording flags of time-range answers', () => {
  const flags = (text: string, taskType: any = 'CONVERSATION_TIME_RANGE_ANALYSIS') => findDirectResponseBoundaryFlags({ assistant_message: text } as any, taskType);

  it('reports the rule and the matched fragment instead of failing the answer', () => {
    expect(flags('Wcześniej odpowiedziałeś, że był sok.')).toEqual([{ rule: 'INTERNAL_CONTEXT_EXPOSURE', fragment: 'wcześniej odpowiedziałeś' }]);
    expect(flags('Dzisiaj spadek był głęboki, bo wcześniej podano korektę.')).toEqual([
      { rule: 'HISTORICAL_AS_TODAY', fragment: 'dzisiaj spadek był głęboki, bo wcześniej' },
    ]);
    expect(flags('Brak aktywności.')).toEqual([{ rule: 'NO_ACTIVITY_INSTEAD_OF_MISSING', fragment: 'brak aktywności.' }]);
  });

  it('has nothing to report for plain answers and for direct responses', () => {
    expect(flags('O 11:40 był spadek do 62 mg/dL po korekcie z 10:55.')).toEqual([]);
    expect(flags('Wcześniej odpowiedziałeś, że był sok.', 'CONVERSATION_DIRECT_RESPONSE')).toEqual([]);
  });
});
