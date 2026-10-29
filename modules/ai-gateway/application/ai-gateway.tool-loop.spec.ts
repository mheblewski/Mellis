import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiGatewayService, resolveToolLoopTimeoutMs } from './ai-gateway.service';
import { createConversationTimeRangeAnalysisTask } from './ai-task';
import type { AiProvider, AiProviderInput, AiProviderResponse } from '@modules/ai-gateway/domain/ai-gateway';

const USAGE = { input_tokens: 100, output_tokens: 10, total_tokens: 110, cached_input_tokens: 0, reasoning_tokens: 0 };
const COST = { estimated_cost: 0.01, currency: 'USD', pricing_version: 'test', input_cost: 0.008, output_cost: 0.002, cached_input_cost: 0, reasoning_cost: 0 };

function context(): any {
  return {
    context_package_id: 'tr-loop-1',
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: 'sha256:tr-loop-1',
    created_at: '2026-10-16T10:36:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    analysis_request_input: {
      user_message_id: 'msg-loop-1',
      user_message_text: 'Pokaż glukozę w nocy.',
      range_type: 'TODAY',
      timezone: 'Europe/Warsaw',
      range_start: '2026-10-15T22:00:00.000Z',
      range_end: '2026-10-16T10:36:00.000Z',
      requested_at: '2026-10-16T10:36:00.000Z',
    },
    conversation_context: { thread_id: 'conv-loop-1', thread_state_version: 'v1', awaiting_user_answer: false, messages: [] },
    current_state_snapshot: { as_of: '2026-10-16T10:36:00.000Z', current_glucose: 142, trend: 'FLAT', iob: 1.9 },
    analytical_evidence: {
      glucose_events: [
        { event_id: 'g-1', occurred_at: '2026-10-15T22:03:00.000Z', payload: { glucose_value: 203 }, provenance_ref: 'source-record/g-1' },
        { event_id: 'g-2', occurred_at: '2026-10-15T23:43:00.000Z', payload: { glucose_value: 321 }, provenance_ref: 'source-record/g-2' },
      ],
      insulin_treatment_events: [],
      meal_events: [],
      activity_events: [],
      hypo_episodes: [],
      range_event_facts: [],
      summaries: {
        total_events: 2, glucose_count: 2, insulin_treatment_count: 0, meal_count: 0, activity_count: 0, hypo_episode_count: 0,
        glucose_min: 203, glucose_max: 321, glucose_avg: 262, missing_sections: ['meal_events', 'activity_events'],
      },
    },
    provenance: { source_refs: ['msg-loop-1'], selection_policy_version: 'conversation-time-range-selector.v1' },
  };
}

function task(ctx: any) {
  return createConversationTimeRangeAnalysisTask({
    task_id: 'loop-task-1', context_package_id: ctx.context_package_id, context_package_version: ctx.context_package_version,
    context_package_hash: ctx.content_hash, correlation_id: 'conv-loop-1', created_at: '2026-10-16T10:36:00.000Z', patient_id: 'patient-1',
  });
}

const NIGHT = { from: '2026-10-15T22:00:00.000Z', to: '2026-10-16T04:00:00.000Z' };
const toolCall = (id: string, name: string, args: Record<string, unknown>): AiProviderResponse => ({
  provider: 'fake', model: 'deep-x', response_id: `resp-${id}`, received_at: '2026-10-16T10:36:01.000Z', raw_output: {},
  tool_calls: [{ call_id: id, tool_name: name, arguments: args }], usage: USAGE, estimated_cost: COST,
});
const answer = (text: string): AiProviderResponse => ({
  provider: 'fake', model: 'deep-x', response_id: 'resp-final', received_at: '2026-10-16T10:36:02.000Z',
  raw_output: { assistant_message: text, follow_up_candidates: [] }, usage: USAGE, estimated_cost: COST,
});

class ScriptedProvider implements AiProvider {
  readonly inputs: AiProviderInput[] = [];
  constructor(private readonly script: AiProviderResponse[], private readonly delayMs = 0) {}

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    this.inputs.push(JSON.parse(JSON.stringify({ ...input, context_package: null })));
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.script[this.inputs.length - 1];
  }
}

describe('the tool loop', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('limits each provider call by timeout_ms and the whole loop by its own, larger budget', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    const script = () => [
      toolCall('call-1', 'get_glucose_evidence', { time_range: NIGHT, detail_level: 'SUMMARY' }),
      toolCall('call-2', 'get_insulin_evidence', { time_range: NIGHT, detail_level: 'SUMMARY' }),
      toolCall('call-3', 'get_meal_evidence', { time_range: NIGHT, detail_level: 'SUMMARY' }),
      answer('W nocy glukoza rosła do 321 mg/dL.'),
    ];
    const ctx = context();
    // Four calls of 40 ms each: every call is within its 100 ms limit, together they pass it.
    const provider = new ScriptedProvider(script(), 40);
    const execution = await new AiGatewayService(provider).execute({ task: task(ctx), context_package: ctx, timeout_ms: 100, loop_timeout_ms: 1000 });
    expect(provider.inputs).toHaveLength(4);
    expect(execution.result).toMatchObject({ assistant_message: 'W nocy glukoza rosła do 321 mg/dL.' });

    // The loop's own budget still ends a loop that runs too long.
    await expect(new AiGatewayService(new ScriptedProvider(script(), 40)).execute({ task: task(ctx), context_package: ctx, timeout_ms: 100, loop_timeout_ms: 60 }))
      .rejects.toMatchObject({ code: 'AI_TIMEOUT', retryable: true });
  });

  it('defaults the loop budget to three per-call limits, or AI_TOOL_LOOP_TIMEOUT_MS when set', () => {
    expect(resolveToolLoopTimeoutMs({}, 90_000)).toBe(270_000);
    expect(resolveToolLoopTimeoutMs({ AI_TOOL_LOOP_TIMEOUT_MS: '200000' }, 90_000)).toBe(200_000);
    expect(resolveToolLoopTimeoutMs({ AI_TOOL_LOOP_TIMEOUT_MS: 'x' }, 15_000)).toBe(45_000);
    // Never shorter than one call.
    expect(resolveToolLoopTimeoutMs({ AI_TOOL_LOOP_TIMEOUT_MS: '1000' }, 15_000)).toBe(15_000);
  });

  it('answers a repeated evidence request with DUPLICATE_QUERY instead of failing the answer, counting it against the budget', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    const failures: Array<Record<string, unknown>> = [];
    const provider = new ScriptedProvider([
      toolCall('call-1', 'get_glucose_evidence', { time_range: NIGHT, detail_level: 'SUMMARY' }),
      toolCall('call-2', 'get_glucose_evidence', { time_range: NIGHT, detail_level: 'SUMMARY' }),
      answer('W nocy glukoza rosła do 321 mg/dL.'),
    ]);
    const ctx = context();
    const execution = await new AiGatewayService(provider).execute({
      task: task(ctx),
      context_package: ctx,
      timeout_ms: 5000,
      evidence_session_observer: {
        onSessionStarted: async () => {},
        onToolCallRequested: async () => {},
        onToolCallSucceeded: async () => {},
        onToolCallFailed: async (args) => { failures.push(args.failure); },
      },
    });

    expect(execution.result).toMatchObject({ assistant_message: 'W nocy glukoza rosła do 321 mg/dL.' });
    const repeat = provider.inputs[2].tool_runtime?.tool_results.find((result) => result.call_id === 'call-2');
    expect(repeat?.result).toMatchObject({ tool: 'get_glucose_evidence', status: 'DUPLICATE_QUERY', requested_range: NIGHT });
    expect(provider.inputs[2].tool_runtime?.max_tool_calls_remaining).toBe(1);
    expect(failures).toEqual([{ reason: 'DUPLICATE_TOOL_REQUEST' }]);
  });
});
