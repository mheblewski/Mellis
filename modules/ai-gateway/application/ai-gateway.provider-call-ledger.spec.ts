import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiGatewayService } from './ai-gateway.service';
import { createConversationTimeRangeAnalysisTask } from './ai-task';
import type { AiProvider, AiProviderInput, AiProviderResponse, AIUsage } from '@modules/ai-gateway/domain/ai-gateway';
import { AiProviderError } from '@modules/ai-gateway/infrastructure/ai-provider.error';
import { WorkerService } from '../../../apps/worker/src/worker.service';

function createContext(): any {
  return {
    context_package_id: 'tr-ledger-1',
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: 'sha256:tr-ledger-1',
    created_at: '2026-10-08T10:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    analysis_request_input: {
      user_message_id: 'msg-ledger-1',
      user_message_text: 'Przeanalizuj mi dzisiejszy dzień',
      range_type: 'TODAY',
      timezone: 'Europe/Warsaw',
      range_start: '2026-10-08T00:00:00.000Z',
      range_end: '2026-10-08T23:59:59.999Z',
      requested_at: '2026-10-08T10:00:00.000Z',
    },
    conversation_context: { thread_id: 'conv-ledger-1', thread_state_version: 'v1', awaiting_user_answer: false, messages: [] },
    current_state_snapshot: { as_of: '2026-10-08T10:00:00.000Z', current_glucose: 142, trend: 'FLAT', iob: 1.9 },
    analytical_evidence: {
      glucose_events: [
        { event_id: 'g-1', occurred_at: '2026-10-08T06:00:00.000Z', payload: { glucose_value: 91 }, provenance_ref: 'source-record/g-1' },
        { event_id: 'g-2', occurred_at: '2026-10-08T07:00:00.000Z', payload: { glucose_value: 122 }, provenance_ref: 'source-record/g-2' },
      ],
      insulin_treatment_events: [
        { event_id: 'ins-1', occurred_at: '2026-10-08T06:45:00.000Z', kind: 'BOLUS', amount: 2.2, unit: 'U', provenance_ref: 'source-record/ins-1' },
      ],
      meal_events: [],
      activity_events: [],
      hypo_episodes: [],
      range_event_facts: [],
      summaries: {
        total_events: 3, glucose_count: 2, insulin_treatment_count: 1, meal_count: 0, activity_count: 0, hypo_episode_count: 0,
        glucose_min: 91, glucose_max: 122, glucose_avg: 106.5, missing_sections: ['meal_events', 'activity_events', 'hypo_episodes'],
      },
    },
    provenance: { source_refs: ['msg-ledger-1'], selection_policy_version: 'conversation-time-range-selector.v1' },
  };
}

function createTask(context: any) {
  return createConversationTimeRangeAnalysisTask({
    task_id: 'ledger-task-1',
    context_package_id: context.context_package_id,
    context_package_version: context.context_package_version,
    context_package_hash: context.content_hash,
    correlation_id: 'conv-ledger-1',
    created_at: '2026-10-08T10:00:00.000Z',
    patient_id: 'patient-1',
  });
}

function usage(input: number, output: number, cached = 0): AIUsage {
  return { input_tokens: input, output_tokens: output, total_tokens: input + output, cached_input_tokens: cached, reasoning_tokens: 0 };
}

function toolCallResponse(callId: string, toolName: string, callUsage: AIUsage | null): AiProviderResponse {
  return {
    provider: 'fake',
    model: 'ledger-model',
    response_id: `resp-${callId}`,
    received_at: '2026-10-08T10:00:01.000Z',
    raw_output: {},
    tool_calls: [{
      call_id: callId,
      tool_name: toolName,
      arguments: { time_range: { from: '2026-10-08T05:00:00.000Z', to: '2026-10-08T09:00:00.000Z' }, detail_level: 'DETAIL' },
    }],
    usage: callUsage,
    estimated_cost: callUsage ? { estimated_cost: callUsage.input_tokens! / 1_000_000, currency: 'USD', pricing_version: 'test-pricing', input_cost: null, output_cost: null, cached_input_cost: null, reasoning_cost: null } : null,
    serialized_input_bytes: 1000,
  };
}

function finalResponse(callUsage: AIUsage | null): AiProviderResponse {
  return {
    provider: 'fake',
    model: 'ledger-model',
    response_id: 'resp-final',
    received_at: '2026-10-08T10:00:02.000Z',
    raw_output: { assistant_message: 'Glikemia była dziś stabilna. Brak danych o aktywności, więc jej wpływ pozostaje UNKNOWN.' },
    usage: callUsage,
    estimated_cost: callUsage ? { estimated_cost: callUsage.input_tokens! / 1_000_000, currency: 'USD', pricing_version: 'test-pricing', input_cost: null, output_cost: null, cached_input_cost: null, reasoning_cost: null } : null,
    serialized_input_bytes: 3000,
  };
}

class ScriptedProvider implements AiProvider {
  readonly inputs: AiProviderInput[] = [];
  constructor(private readonly script: Array<AiProviderResponse | Error>) {}

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    this.inputs.push(JSON.parse(JSON.stringify({ ...input, context_package: null })));
    const next = this.script[this.inputs.length - 1];
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

function createAttemptObserver() {
  let attemptNumber = 0;
  return {
    onAttemptStarted: vi.fn(async () => ({ attempt_id: `attempt-${++attemptNumber}`, attempt_number: attemptNumber })),
    onAttemptSucceeded: vi.fn(async () => undefined),
    onAttemptFailed: vi.fn(async () => undefined),
  };
}

describe('AiGatewayService provider call ledger', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('aggregates usage across a multi-turn tool loop and persists per-call measurements', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    // Measures the full-resend construction (resent counts); the chained default is covered separately.
    vi.stubEnv('AI_EXPERIMENT_OMIT_CHAINED_TOOL_RESULTS', '0');
    const context = createContext();
    const provider = new ScriptedProvider([
      toolCallResponse('call-g', 'get_glucose_evidence', usage(2000, 40, 0)),
      toolCallResponse('call-i', 'get_insulin_evidence', usage(5000, 50, 1900)),
      finalResponse(usage(9000, 300, 4800)),
    ]);
    const observer = createAttemptObserver();

    const execution = await new AiGatewayService(provider).execute({
      task: createTask(context),
      context_package: context,
      timeout_ms: 5000,
      attempt_observer: observer,
    });

    // Production request flow is unchanged: same prompt each turn, tool results accumulate.
    expect(provider.inputs).toHaveLength(3);
    expect(new Set(provider.inputs.map((input) => input.prompt.user_payload)).size).toBe(1);
    expect(provider.inputs.map((input) => input.tool_runtime?.tool_results.length)).toEqual([0, 1, 2]);

    // Legacy metadata keeps last-call semantics.
    expect(execution.metadata.usage).toEqual(usage(9000, 300, 4800));

    const ledger = execution.metadata.context_package_usage?.provider_call_ledger as Record<string, any>;
    expect(ledger).toMatchObject({
      scope: 'GATEWAY_ATTEMPT',
      provider_call_count: 3,
      tokens: {
        complete: true,
        totals: { input_tokens: 16000, output_tokens: 390, total_tokens: 16390, cached_input_tokens: 6700, reasoning_tokens: 0 },
      },
      calls_by_input_tokens_desc: [3, 2, 1],
    });
    expect(ledger.calls.map((call: any) => call.turn_kind)).toEqual(['INITIAL', 'TOOL_CONTINUATION', 'TOOL_CONTINUATION']);
    expect(ledger.calls.map((call: any) => call.previous_response_id_sent)).toEqual([false, true, true]);
    expect(ledger.calls[2].tool_results_resent_count).toBe(1);
    expect(ledger.bytes.tool_results_resent_total).toBe(ledger.calls[2].measured_bytes.tool_results_resent);
    expect(ledger.bytes.tool_results_resent_total).toBeGreaterThan(0);
    expect(ledger.bytes.provider_request_body_total).toBe(5000);

    expect(observer.onAttemptSucceeded).toHaveBeenCalledTimes(1);
    const attemptArgs = (observer.onAttemptSucceeded.mock.calls[0] as unknown[])[0] as Record<string, any>;
    expect(attemptArgs.usage).toEqual(ledger.tokens.totals);
    expect(attemptArgs.estimated_cost.estimated_cost).toBeCloseTo(0.016, 12);
    expect(attemptArgs.estimated_cost.pricing_version).toBe('test-pricing');
  });

  it('keeps usage of responded calls on a failed attempt and aggregates the retry separately', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    const observer = createAttemptObserver();

    const failing = new ScriptedProvider([
      toolCallResponse('call-g', 'get_glucose_evidence', usage(2000, 40)),
      new AiProviderError('OpenAI server error', true, 'server_error'),
    ]);
    await expect(new AiGatewayService(failing).execute({
      task: createTask(createContext()),
      context_package: createContext(),
      timeout_ms: 5000,
      attempt_observer: observer,
    })).rejects.toMatchObject({ code: 'AI_PROVIDER_RETRYABLE', retryable: true });

    const failedArgs = (observer.onAttemptFailed.mock.calls[0] as unknown[])[0] as Record<string, any>;
    expect(failedArgs.attempt_id).toBe('attempt-1');
    expect(failedArgs.usage).toEqual(usage(2000, 40));
    expect(failedArgs.estimated_cost.estimated_cost).toBeCloseTo(0.002, 12);

    const retry = new ScriptedProvider([finalResponse(usage(2100, 200))]);
    const execution = await new AiGatewayService(retry).execute({
      task: createTask(createContext()),
      context_package: createContext(),
      timeout_ms: 5000,
      attempt_observer: observer,
    });

    const succeededArgs = (observer.onAttemptSucceeded.mock.calls[0] as unknown[])[0] as Record<string, any>;
    expect(succeededArgs.attempt_id).toBe('attempt-2');
    expect(succeededArgs.usage).toEqual(usage(2100, 200));
    expect((execution.metadata.context_package_usage?.provider_call_ledger as any).provider_call_count).toBe(1);
  });

  it('marks the attempt aggregate incomplete when a provider call reports no usage', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    const observer = createAttemptObserver();
    const provider = new ScriptedProvider([
      toolCallResponse('call-g', 'get_glucose_evidence', usage(2000, 40)),
      finalResponse(null),
    ]);

    const execution = await new AiGatewayService(provider).execute({
      task: createTask(createContext()),
      context_package: createContext(),
      timeout_ms: 5000,
      attempt_observer: observer,
    });

    const ledger = execution.metadata.context_package_usage?.provider_call_ledger as Record<string, any>;
    expect(ledger.tokens.complete).toBe(false);
    expect(ledger.tokens.totals.input_tokens).toBeNull();
    expect(ledger.tokens.reported_sums.input_tokens).toBe(2000);

    const attemptArgs = (observer.onAttemptSucceeded.mock.calls[0] as unknown[])[0] as Record<string, any>;
    expect(attemptArgs.usage.input_tokens).toBeNull();
    expect(attemptArgs.estimated_cost).toBeNull();
  });

  it('single-call executions persist the same usage and cost as before', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '0');
    const observer = createAttemptObserver();
    const response = finalResponse(usage(4500, 120, 100));
    const execution = await new AiGatewayService(new ScriptedProvider([response])).execute({
      task: createTask(createContext()),
      context_package: createContext(),
      timeout_ms: 5000,
      attempt_observer: observer,
    });

    const attemptArgs = (observer.onAttemptSucceeded.mock.calls[0] as unknown[])[0] as Record<string, any>;
    expect(attemptArgs.usage).toEqual(response.usage);
    expect(attemptArgs.estimated_cost).toEqual(response.estimated_cost);
    expect(execution.metadata.usage).toEqual(response.usage);
  });
});

describe('WorkerService attempt observer persistence', () => {
  it('forwards failed-attempt usage and cost to the attempt repository', async () => {
    const updateAiExecutionAttempt = vi.fn(async () => undefined);
    const worker = new WorkerService({} as any, {} as any, { getOrThrow: vi.fn().mockReturnValue('test') } as any, {} as any, {} as any);
    const observer = (worker as any).createAiAttemptObserver({ updateAiExecutionAttempt });

    await observer.onAttemptFailed({
      attempt_id: 'attempt-1',
      task_identity: 'task-1',
      provider: 'fake',
      model: 'ledger-model',
      started_at: '2026-10-08T10:00:00.000Z',
      completed_at: '2026-10-08T10:00:03.000Z',
      provider_latency_ms: 3000,
      error_type: 'AI_PROVIDER_RETRYABLE',
      error_code: 'server_error',
      usage: usage(2000, 40),
      estimated_cost: { estimated_cost: 0.002, currency: 'USD', pricing_version: 'test-pricing', input_cost: null, output_cost: null, cached_input_cost: null, reasoning_cost: null },
    });

    expect(updateAiExecutionAttempt).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt-1',
      status: 'FAILED',
      usage: usage(2000, 40),
      estimatedCost: expect.objectContaining({ estimated_cost: 0.002, pricing_version: 'test-pricing' }),
    }));
  });
});
