import { describe, expect, it } from 'vitest';
import { AiGatewayService } from './ai-gateway.service';
import { createConversationDirectResponseTask } from './ai-task';
import type { AiProvider, AiProviderInput, AiProviderResponse } from '@modules/ai-gateway/domain/ai-gateway';
import type { RescueCarbProposalTools } from '@modules/rescue-carbs/application/rescue-carb-proposal-tool';

const USAGE = { input_tokens: 100, output_tokens: 10, total_tokens: 110, cached_input_tokens: 0, reasoning_tokens: 0 };
const COST = { estimated_cost: 0.01, currency: 'USD', pricing_version: 'test', input_cost: 0.008, output_cost: 0.002, cached_input_cost: 0, reasoning_cost: 0 };

function directContext(text: string): any {
  return {
    context_package_id: 'direct-rescue-1',
    context_package_version: 'conversation-context.v1',
    content_hash: 'sha256:direct-rescue-1',
    created_at: '2026-10-20T12:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    conversation_context: { thread_id: 'conv-rescue-1', thread_state_version: 'v1', awaiting_user_answer: false, messages: [] },
    direct_response_input: { user_message_id: 'msg-rescue-1', user_message_text: text },
    current_state_snapshot: null,
    patient_facts: [],
    provenance: { source_refs: ['msg-rescue-1'] },
  };
}

function directTask(context: any) {
  return createConversationDirectResponseTask({
    task_id: 'direct-rescue-task-1', context_package_id: context.context_package_id, context_package_version: context.context_package_version,
    context_package_hash: context.content_hash, correlation_id: 'conv-rescue-1', created_at: '2026-10-20T12:00:00.000Z', patient_id: 'patient-1',
  });
}

const toolCall = (id: string, name: string, args: Record<string, unknown>): AiProviderResponse => ({
  provider: 'fake', model: 'deep-x', response_id: `resp-${id}`, received_at: '2026-10-20T12:00:01.000Z', raw_output: {},
  tool_calls: [{ call_id: id, tool_name: name, arguments: args }], usage: USAGE, estimated_cost: COST,
});
const answer = (text: string): AiProviderResponse => ({
  provider: 'fake', model: 'deep-x', response_id: 'resp-final', received_at: '2026-10-20T12:00:02.000Z',
  raw_output: { assistant_message: text, follow_up_candidates: [] }, usage: USAGE, estimated_cost: COST,
});

class ScriptedProvider implements AiProvider {
  readonly inputs: AiProviderInput[] = [];
  constructor(private readonly script: AiProviderResponse[]) {}

  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    this.inputs.push(JSON.parse(JSON.stringify({ ...input, context_package: null })));
    return this.script[this.inputs.length - 1];
  }
}

class RecordingRescueTools implements RescueCarbProposalTools {
  readonly calls: Array<Record<string, unknown>> = [];
  constructor(private readonly fail = false, readonly for_alert = true) {}

  async propose(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push(args);
    if (this.fail) throw new Error('database down');
    return { tool: 'propose_rescue_carbs', status: 'PROPOSED', card: { carbs_g: args.carbs_g } };
  }
}

const toolNames = (input: AiProviderInput) => (input.tool_runtime?.available_tools ?? []).map((tool) => tool.name);

describe('rescue carb cards (propose_rescue_carbs) in an alert\'s chat', () => {
  it('prepares the cards (one per option, at most 3) with the rescue rules on the main model', async () => {
    const tools = new RecordingRescueTools();
    const provider = new ScriptedProvider([
      toolCall('call-1', 'propose_rescue_carbs', { carbs_g: 8, reason: 'Po WF spada szybciej.' }),
      toolCall('call-2', 'propose_rescue_carbs', { carbs_g: 9, reason: 'x' }),
      toolCall('call-3', 'propose_rescue_carbs', { carbs_g: 10, reason: 'x' }),
      toolCall('call-4', 'propose_rescue_carbs', { carbs_g: 11, reason: 'x' }),
      answer('Proponuję 8 g; zatwierdź je kartą po podaniu.'),
    ]);
    const ctx = directContext('Czy 4 g wystarczy? Był WF.');
    const execution = await new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, rescue_carbs: tools });

    expect(toolNames(provider.inputs[0])).toEqual(['propose_rescue_carbs']);
    expect(provider.inputs[0].prompt.system_instructions).toContain('RESCUE CARBS');
    expect(provider.inputs[0].model_tier).toBe('DEEP');
    expect(tools.calls.map((call) => call.carbs_g)).toEqual([8, 9, 10]);
    expect(execution.metadata.evidence_tool_calls?.map((call) => call.result_status)).toEqual(['PROPOSED', 'PROPOSED', 'PROPOSED', 'LIMIT_REACHED']);
  });

  it('lets a corrected card replace its option\'s card after the three options are carded', async () => {
    const tools = new RecordingRescueTools();
    const provider = new ScriptedProvider([
      toolCall('call-1', 'propose_rescue_carbs', { carbs_g: 8, reason: 'x', option: 'A' }),
      toolCall('call-2', 'propose_rescue_carbs', { carbs_g: 9, reason: 'x', option: 'B' }),
      toolCall('call-3', 'propose_rescue_carbs', { carbs_g: 10, reason: 'x', option: 'C' }),
      toolCall('call-4', 'propose_rescue_carbs', { carbs_g: 7, reason: 'x', option: 'A' }),
      answer('Wybierz opcję poniżej albo napisz własny plan.'),
    ]);
    const ctx = directContext('Ile dosłodzić?');
    await new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, rescue_carbs: tools });
    expect(tools.calls.map((call) => call.carbs_g)).toEqual([8, 9, 10, 7]);
  });

  it('fails open, rejects unknown parameters and is absent outside an alert\'s chat', async () => {
    const ctx = directContext('ile dosłodzić');
    const failing = new ScriptedProvider([toolCall('call-1', 'propose_rescue_carbs', { carbs_g: 6, reason: 'x' }), answer('Podaj 6 g.')]);
    const execution = await new AiGatewayService(failing).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, rescue_carbs: new RecordingRescueTools(true) });
    expect(execution.metadata.evidence_tool_calls?.map((call) => call.result_status)).toEqual(['UNAVAILABLE']);

    const bad = new ScriptedProvider([toolCall('call-x', 'propose_rescue_carbs', { carbs_g: 6, reason: 'x', log_now: true })]);
    await expect(new AiGatewayService(bad).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, rescue_carbs: new RecordingRescueTools() }))
      .rejects.toMatchObject({ code: 'AI_CONTRACT_VIOLATION' });

    const plain = new ScriptedProvider([answer('Cześć.')]);
    await new AiGatewayService(plain).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000 });
    expect(plain.inputs[0].prompt.system_instructions).not.toContain('RESCUE CARBS');
    expect(plain.inputs[0].prompt.system_instructions).not.toContain('card tools');
  });

  it('keeps an ordinary chat on the light model when only the chat cards are offered', async () => {
    const ctx = directContext('Dzięki, a co oznacza COB?');
    const provider = new ScriptedProvider([answer('COB to węglowodany jeszcze nie wchłonięte.')]);
    await new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, rescue_carbs: new RecordingRescueTools(false, false) });

    expect(toolNames(provider.inputs[0])).toEqual(['propose_rescue_carbs']);
    expect(provider.inputs[0].model_tier).toBe('LIGHT');
    // The direct reply's no-numbers rule leaves the card's dose to the card tool.
    expect(provider.inputs[0].prompt.system_instructions).toContain('A dose to give now goes only through them');
    expect(JSON.parse(provider.inputs[0].prompt.user_payload).evidence_contract.therapy_suggestions).toBe('ONLY_ON_DOSE_CARDS_NOT_IN_TEXT');
  });
});
