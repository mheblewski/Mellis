import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiGatewayService, OMIT_CHAINED_TOOL_RESULTS_FLAG, isChainedToolResultOmissionEnabled } from './ai-gateway.service';
import { createConversationTimeRangeAnalysisTask } from './ai-task';
import type { AiProvider, AiProviderInput, AiProviderResponse } from '@modules/ai-gateway/domain/ai-gateway';
import { AiProviderError } from '@modules/ai-gateway/infrastructure/ai-provider.error';
import { buildOpenAiResponsesRequestBody } from '@modules/ai-gateway/infrastructure/openai-provider';
import { buildTimeRangeAnalysisPrompt } from './time-range-analysis-prompt';

function createContext(): any {
  return {
    context_package_id: 'tr-chain-1',
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: 'sha256:tr-chain-1',
    created_at: '2026-10-08T10:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    analysis_request_input: {
      user_message_id: 'msg-chain-1',
      user_message_text: 'Przeanalizuj mi dzisiejszy dzień',
      range_type: 'TODAY',
      timezone: 'Europe/Warsaw',
      range_start: '2026-10-08T00:00:00.000Z',
      range_end: '2026-10-08T23:59:59.999Z',
      requested_at: '2026-10-08T10:00:00.000Z',
    },
    conversation_context: { thread_id: 'conv-chain-1', thread_state_version: 'v1', awaiting_user_answer: false, messages: [] },
    current_state_snapshot: { as_of: '2026-10-08T10:00:00.000Z', current_glucose: 142, trend: 'FLAT', iob: 1.9 },
    analytical_evidence: {
      glucose_events: [
        { event_id: 'g-1', occurred_at: '2026-10-08T06:00:00.000Z', payload: { glucose_value: 91 }, provenance_ref: 'source-record/g-1' },
        { event_id: 'g-2', occurred_at: '2026-10-08T07:00:00.000Z', payload: { glucose_value: 122 }, provenance_ref: 'source-record/g-2' },
      ],
      insulin_treatment_events: [
        { event_id: 'ins-1', occurred_at: '2026-10-08T06:45:00.000Z', kind: 'BOLUS', amount: 2.2, unit: 'U', provenance_ref: 'source-record/ins-1' },
        { event_id: 'ins-2', occurred_at: '2026-10-08T08:15:00.000Z', kind: 'TEMP_BASAL', rate: 0.7, duration_minutes: 45, unit: 'U/h', provenance_ref: 'source-record/ins-2' },
      ],
      meal_events: [],
      activity_events: [],
      hypo_episodes: [],
      range_event_facts: [],
      summaries: {
        total_events: 4, glucose_count: 2, insulin_treatment_count: 2, meal_count: 0, activity_count: 0, hypo_episode_count: 0,
        glucose_min: 91, glucose_max: 122, glucose_avg: 106.5, missing_sections: ['meal_events', 'activity_events', 'hypo_episodes'],
      },
    },
    provenance: { source_refs: ['msg-chain-1'], selection_policy_version: 'conversation-time-range-selector.v1' },
  };
}

function createTask(context: any) {
  return createConversationTimeRangeAnalysisTask({
    task_id: 'chain-task-1',
    context_package_id: context.context_package_id,
    context_package_version: context.context_package_version,
    context_package_hash: context.content_hash,
    correlation_id: 'conv-chain-1',
    created_at: '2026-10-08T10:00:00.000Z',
    patient_id: 'patient-1',
  });
}

const ARGS = { time_range: { from: '2026-10-08T05:00:00.000Z', to: '2026-10-08T09:00:00.000Z' }, detail_level: 'DETAIL' };

function toolResponse(responseId: string | null, calls: Array<[string, string]>): AiProviderResponse {
  return {
    provider: 'fake',
    model: 'chain-model',
    response_id: responseId,
    received_at: '2026-10-08T10:00:01.000Z',
    raw_output: {},
    tool_calls: calls.map(([callId, toolName]) => ({ call_id: callId, tool_name: toolName, arguments: ARGS })),
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, cached_input_tokens: 0, reasoning_tokens: 0 },
  };
}

function finalResponse(): AiProviderResponse {
  return {
    provider: 'fake',
    model: 'chain-model',
    response_id: 'resp-final',
    received_at: '2026-10-08T10:00:02.000Z',
    raw_output: { assistant_message: 'Glikemia była dziś stabilna. Brak danych o aktywności, więc jej wpływ pozostaje UNKNOWN.' },
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, cached_input_tokens: 0, reasoning_tokens: 0 },
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

function deliveredCallIds(provider: ScriptedProvider): string[][] {
  return provider.inputs.map((input) => (input.tool_runtime?.tool_results ?? []).map((result) => result.call_id));
}

async function run(script: Array<AiProviderResponse | Error>) {
  const provider = new ScriptedProvider(script);
  const context = createContext();
  const execution = await new AiGatewayService(provider).execute({ task: createTask(context), context_package: context, timeout_ms: 5000 });
  return { provider, execution, ledger: execution.metadata.context_package_usage?.provider_call_ledger as Record<string, any> };
}

const SEQUENTIAL_SCRIPT = () => [
  toolResponse('resp-1', [['call-g', 'get_glucose_evidence']]),
  toolResponse('resp-2', [['call-i', 'get_insulin_evidence']]),
  finalResponse(),
];

describe('chained tool result omission experiment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is on by default in every environment and can be switched off explicitly', () => {
    expect(isChainedToolResultOmissionEnabled({})).toBe(true);
    expect(isChainedToolResultOmissionEnabled({ NODE_ENV: 'production' })).toBe(true);
    expect(isChainedToolResultOmissionEnabled({ NODE_ENV: 'development', [OMIT_CHAINED_TOOL_RESULTS_FLAG]: '1' })).toBe(true);
    for (const off of ['0', 'false', 'no', 'off', ' OFF ']) {
      expect(isChainedToolResultOmissionEnabled({ NODE_ENV: 'production', [OMIT_CHAINED_TOOL_RESULTS_FLAG]: off })).toBe(false);
    }
  });

  it('keeps the full-resend behavior when the flag is switched off, and chains by default', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    vi.stubEnv(OMIT_CHAINED_TOOL_RESULTS_FLAG, '0');
    const off = await run(SEQUENTIAL_SCRIPT());
    expect(deliveredCallIds(off.provider)).toEqual([[], ['call-g'], ['call-g', 'call-i']]);
    expect(off.ledger.calls.map((call: any) => call.tool_result_delivery)).toEqual(['FULL_RESEND', 'FULL_RESEND', 'FULL_RESEND']);

    vi.unstubAllEnvs();
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    vi.stubEnv('NODE_ENV', 'production');
    const byDefault = await run(SEQUENTIAL_SCRIPT());
    expect(deliveredCallIds(byDefault.provider)).toEqual([[], ['call-g'], ['call-i']]);
    expect(byDefault.ledger.calls.map((call: any) => call.tool_result_delivery)).toEqual(['NEW_ONLY_CHAINED', 'NEW_ONLY_CHAINED', 'NEW_ONLY_CHAINED']);
  });

  it('sends only the outputs answering the previous response when the chain is intact', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    vi.stubEnv(OMIT_CHAINED_TOOL_RESULTS_FLAG, '1');
    const baseline = await (async () => {
      vi.stubEnv(OMIT_CHAINED_TOOL_RESULTS_FLAG, '0');
      const result = await run(SEQUENTIAL_SCRIPT());
      vi.stubEnv(OMIT_CHAINED_TOOL_RESULTS_FLAG, '1');
      return result;
    })();
    const experiment = await run(SEQUENTIAL_SCRIPT());

    expect(deliveredCallIds(experiment.provider)).toEqual([[], ['call-g'], ['call-i']]);
    expect(experiment.provider.inputs.map((input) => input.previous_response_id ?? null)).toEqual([null, 'resp-1', 'resp-2']);
    // Prompt, tool definitions and new tool output payloads are identical to the default path.
    experiment.provider.inputs.forEach((input, index) => {
      expect(input.prompt).toEqual(baseline.provider.inputs[index].prompt);
      expect(input.tool_runtime?.available_tools).toEqual(baseline.provider.inputs[index].tool_runtime?.available_tools);
    });
    expect(experiment.provider.inputs[2].tool_runtime?.tool_results).toEqual(baseline.provider.inputs[2].tool_runtime?.tool_results.slice(1));
    expect(experiment.execution.result).toEqual(baseline.execution.result);

    expect(experiment.ledger.calls.map((call: any) => call.tool_result_delivery)).toEqual(['NEW_ONLY_CHAINED', 'NEW_ONLY_CHAINED', 'NEW_ONLY_CHAINED']);
    expect(experiment.ledger.calls[2]).toMatchObject({ tool_results_omitted_chained_count: 1, tool_results_resent_count: 0 });
    expect(experiment.ledger.calls[2].tool_results_omitted_chained_bytes).toBe(baseline.ledger.calls[2].measured_bytes.tool_results_resent);
    expect(experiment.ledger.bytes.tool_results_resent_total).toBe(0);
  });

  it('pairs each output with a tool call of the chained response, preserving order for batched calls', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    vi.stubEnv(OMIT_CHAINED_TOOL_RESULTS_FLAG, '1');
    const script = [
      toolResponse('resp-1', [['call-g', 'get_glucose_evidence'], ['call-i', 'get_insulin_evidence']]),
      toolResponse('resp-2', [['call-b', 'get_basal_evidence']]),
      finalResponse(),
    ];
    const { provider } = await run(script);

    expect(deliveredCallIds(provider)).toEqual([[], ['call-g', 'call-i'], ['call-b']]);
    provider.inputs.slice(1).forEach((input, index) => {
      const chained = script[index] as AiProviderResponse;
      expect(input.previous_response_id).toBe(chained.response_id);
      const requested = (chained.tool_calls ?? []).map((call) => call.call_id);
      expect(input.tool_runtime?.tool_results.map((result) => result.call_id)).toEqual(requested);
    });
  });

  it('sends only the last outputs on the finalization turn', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    vi.stubEnv(OMIT_CHAINED_TOOL_RESULTS_FLAG, '1');
    const { provider, ledger } = await run([
      toolResponse('resp-1', [['call-g', 'get_glucose_evidence']]),
      toolResponse('resp-2', [['call-i', 'get_insulin_evidence']]),
      toolResponse('resp-3', [['call-b', 'get_basal_evidence']]),
      finalResponse(),
    ]);

    expect(deliveredCallIds(provider)).toEqual([[], ['call-g'], ['call-i'], ['call-b']]);
    // Same tool definitions as the earlier turns (cached prefix stays valid); calls are forbidden by tool_choice.
    expect(provider.inputs[3].tool_runtime?.available_tools).toEqual(provider.inputs[0].tool_runtime?.available_tools);
    expect(provider.inputs[3].tool_runtime?.tool_choice).toBe('none');
    expect(provider.inputs[0].tool_runtime?.tool_choice).toBeUndefined();
    expect(ledger.calls[3]).toMatchObject({ turn_kind: 'FINALIZATION', tool_results_omitted_chained_count: 2 });
  });

  it('falls back to a full resend when the previous turn returned no response id', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    vi.stubEnv(OMIT_CHAINED_TOOL_RESULTS_FLAG, '1');
    const { provider, ledger } = await run([
      toolResponse('resp-1', [['call-g', 'get_glucose_evidence']]),
      toolResponse(null, [['call-i', 'get_insulin_evidence']]),
      finalResponse(),
    ]);

    // The chain still ends at resp-1, which does not contain call-g's output: nothing may be dropped.
    expect(provider.inputs[2].previous_response_id).toBe('resp-1');
    expect(deliveredCallIds(provider)).toEqual([[], ['call-g'], ['call-g', 'call-i']]);
    expect(ledger.calls[2]).toMatchObject({ tool_result_delivery: 'FULL_RESEND_CHAIN_FALLBACK', tool_results_omitted_chained_count: 0 });
  });

  it('fails the attempt on a provider error and starts the retry without carried chain state', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    vi.stubEnv(OMIT_CHAINED_TOOL_RESULTS_FLAG, '1');
    const failing = new ScriptedProvider([
      toolResponse('resp-1', [['call-g', 'get_glucose_evidence']]),
      new AiProviderError('Previous response not found', false, 'previous_response_not_found'),
    ]);
    const context = createContext();
    await expect(new AiGatewayService(failing).execute({ task: createTask(context), context_package: context, timeout_ms: 5000 }))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_NON_RETRYABLE' });
    expect(deliveredCallIds(failing)).toEqual([[], ['call-g']]);

    const retry = await run(SEQUENTIAL_SCRIPT());
    expect(retry.provider.inputs[0].previous_response_id ?? null).toBeNull();
    expect(deliveredCallIds(retry.provider)).toEqual([[], ['call-g'], ['call-i']]);
  });

  it('isolates concurrent executions on one gateway instance', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    vi.stubEnv(OMIT_CHAINED_TOOL_RESULTS_FLAG, '1');
    const providerA = new ScriptedProvider([
      toolResponse('A-1', [['A-call-g', 'get_glucose_evidence']]),
      toolResponse('A-2', [['A-call-i', 'get_insulin_evidence']]),
      finalResponse(),
    ]);
    const providerB = new ScriptedProvider([
      toolResponse('B-1', [['B-call-g', 'get_glucose_evidence']]),
      toolResponse('B-2', [['B-call-b', 'get_basal_evidence']]),
      finalResponse(),
    ]);
    const gatewayA = new AiGatewayService(providerA);
    const gatewayB = new AiGatewayService(providerB);

    const contextA = createContext();
    const contextB = { ...createContext(), patient_ref: { patient_id: 'patient-1' }, context_package_id: 'tr-chain-2', content_hash: 'sha256:tr-chain-2' };
    await Promise.all([
      gatewayA.execute({ task: createTask(contextA), context_package: contextA, timeout_ms: 5000 }),
      gatewayB.execute({ task: { ...createTask(contextB), task_id: 'chain-task-2', context_package_id: 'tr-chain-2', context_package_hash: 'sha256:tr-chain-2' }, context_package: contextB, timeout_ms: 5000 }),
    ]);

    expect(deliveredCallIds(providerA)).toEqual([[], ['A-call-g'], ['A-call-i']]);
    expect(deliveredCallIds(providerB)).toEqual([[], ['B-call-g'], ['B-call-b']]);
    expect(providerA.inputs.map((input) => input.previous_response_id ?? null)).toEqual([null, 'A-1', 'A-2']);
    expect(providerB.inputs.map((input) => input.previous_response_id ?? null)).toEqual([null, 'B-1', 'B-2']);
  });

  it('handles a tool request beyond the call budget identically in both modes', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    const script = () => [
      toolResponse('resp-1', [['call-g', 'get_glucose_evidence'], ['call-i', 'get_insulin_evidence']]),
      toolResponse('resp-2', [['call-b', 'get_basal_evidence'], ['call-m', 'get_meal_evidence']]),
      finalResponse(),
    ];
    vi.stubEnv(OMIT_CHAINED_TOOL_RESULTS_FLAG, '0');
    const baseline = await run(script());
    vi.stubEnv(OMIT_CHAINED_TOOL_RESULTS_FLAG, '1');
    const experiment = await run(script());

    // Budget of 3 tool calls: call-m is not executed in either mode, but answered LIMIT_REACHED (the provider needs an
    // output for every call of a turn).
    expect(deliveredCallIds(baseline.provider)).toEqual([[], ['call-g', 'call-i'], ['call-g', 'call-i', 'call-b', 'call-m']]);
    expect(deliveredCallIds(experiment.provider)).toEqual([[], ['call-g', 'call-i'], ['call-b', 'call-m']]);
    expect(experiment.ledger.calls[2]).toMatchObject({ turn_kind: 'FINALIZATION', tool_results_omitted_chained_count: 2 });
    expect(experiment.execution.result).toEqual(baseline.execution.result);
  });

  it('does not resend the prompt carried by an intact chain, and adds only the finalization instruction', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    vi.stubEnv(OMIT_CHAINED_TOOL_RESULTS_FLAG, '0');
    const baseline = await run(SEQUENTIAL_SCRIPT());
    expect(baseline.provider.inputs.map((input) => input.chained_prompt ?? null)).toEqual([null, null, null]);
    expect(baseline.ledger.calls.map((call: any) => call.prompt_delivery)).toEqual(['FULL', 'FULL', 'FULL']);

    vi.stubEnv(OMIT_CHAINED_TOOL_RESULTS_FLAG, '1');
    const experiment = await run(SEQUENTIAL_SCRIPT());
    expect(experiment.provider.inputs.map((input) => input.chained_prompt ?? null)).toEqual([
      null,
      { additional_system_instructions: null },
      { additional_system_instructions: null },
    ]);
    // The full prompt stays on the provider input for validation and audit; the result is unchanged.
    experiment.provider.inputs.forEach((input, index) => expect(input.prompt).toEqual(baseline.provider.inputs[index].prompt));
    expect(experiment.execution.result).toEqual(baseline.execution.result);
    expect(experiment.ledger.calls.map((call: any) => call.prompt_delivery)).toEqual(['FULL', 'CHAINED', 'CHAINED']);
    expect(experiment.ledger.calls[1].measured_bytes.user_payload).toBe(0);
    expect(experiment.ledger.calls[0].measured_bytes.user_payload).toBe(baseline.ledger.calls[0].measured_bytes.user_payload);

    const finalization = await run([
      toolResponse('resp-1', [['call-g', 'get_glucose_evidence']]),
      toolResponse('resp-2', [['call-i', 'get_insulin_evidence']]),
      toolResponse('resp-3', [['call-b', 'get_basal_evidence']]),
      finalResponse(),
    ]);
    const finalInput = finalization.provider.inputs[3];
    expect(finalInput.chained_prompt?.additional_system_instructions).toContain('FINALIZATION MODE');
    expect(finalInput.prompt.system_instructions).toContain(finalInput.chained_prompt?.additional_system_instructions);
  });

  it('resends the full prompt whenever the chain is not intact', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    vi.stubEnv(OMIT_CHAINED_TOOL_RESULTS_FLAG, '1');
    const { provider, ledger } = await run([
      toolResponse('resp-1', [['call-g', 'get_glucose_evidence']]),
      toolResponse(null, [['call-i', 'get_insulin_evidence']]),
      finalResponse(),
    ]);
    expect(provider.inputs[2].chained_prompt ?? null).toBeNull();
    expect(ledger.calls[2].prompt_delivery).toBe('FULL');

    vi.stubEnv(OMIT_CHAINED_TOOL_RESULTS_FLAG, '0');
    const switchedOff = await run(SEQUENTIAL_SCRIPT());
    expect(switchedOff.provider.inputs.every((input) => (input.chained_prompt ?? null) === null)).toBe(true);
  });

  it('builds a chained Responses request without the repeated system and user messages', () => {
    const userPayload = buildTimeRangeAnalysisPrompt(createTask(createContext()), createContext()).user_payload;
    const toolRuntime = {
      available_tools: [],
      tool_results: [{ call_id: 'call-i', tool_name: 'get_insulin_evidence', result: { tool: 'get_insulin_evidence' } }],
      max_tool_calls_remaining: 1,
    };
    const base = { model: 'gpt-5.6-terra', task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS', system_instructions: 'system', user_payload: userPayload, tool_runtime: toolRuntime };
    const roles = (body: Record<string, unknown>) => (body.input as Array<Record<string, unknown>>).map((item) => item.role ?? item.type);

    const chained = buildOpenAiResponsesRequestBody({ ...base, previous_response_id: 'resp-2', chained_prompt: { additional_system_instructions: null } });
    expect(roles(chained)).toEqual(['function_call_output']);

    const finalization = buildOpenAiResponsesRequestBody({ ...base, previous_response_id: 'resp-2', chained_prompt: { additional_system_instructions: 'FINALIZATION MODE' } });
    expect(finalization.input).toEqual([{ role: 'system', content: 'FINALIZATION MODE' }, expect.objectContaining({ type: 'function_call_output' })]);

    // Without a chain to carry it, the prompt is always sent in full.
    const unchained = buildOpenAiResponsesRequestBody({ ...base, previous_response_id: null, chained_prompt: { additional_system_instructions: null } });
    expect(roles(unchained)).toEqual(['system', 'user', 'function_call_output']);
    expect(roles(buildOpenAiResponsesRequestBody({ ...base, previous_response_id: 'resp-2' }))).toEqual(['system', 'user', 'function_call_output']);
  });

  it('builds a Responses request containing only the new function_call_output items', () => {
    const body = buildOpenAiResponsesRequestBody({
      model: 'gpt-5.6-terra',
      task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
      system_instructions: 'system',
      user_payload: buildTimeRangeAnalysisPrompt(createTask(createContext()), createContext()).user_payload,
      previous_response_id: 'resp-2',
      tool_runtime: {
        available_tools: [],
        tool_results: [{ call_id: 'call-i', tool_name: 'get_insulin_evidence', result: { tool: 'get_insulin_evidence' } }],
        max_tool_calls_remaining: 1,
      },
    });

    const outputs = (body.input as Array<Record<string, unknown>>).filter((item) => item.type === 'function_call_output');
    expect(body.previous_response_id).toBe('resp-2');
    expect(outputs.map((item) => item.call_id)).toEqual(['call-i']);
  });
});
