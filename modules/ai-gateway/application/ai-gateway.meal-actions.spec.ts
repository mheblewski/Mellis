import { describe, expect, it } from 'vitest';
import { AiGatewayService } from './ai-gateway.service';
import { createConversationDirectResponseTask } from './ai-task';
import type { AiProvider, AiProviderInput, AiProviderResponse } from '@modules/ai-gateway/domain/ai-gateway';
import { buildOpenAiResponsesRequestBody } from '@modules/ai-gateway/infrastructure/openai-provider';
import type { MealActionsTools } from '@modules/meal-actions/application/meal-actions-tool';

const USAGE = { input_tokens: 100, output_tokens: 10, total_tokens: 110, cached_input_tokens: 0, reasoning_tokens: 0 };
const COST = { estimated_cost: 0.01, currency: 'USD', pricing_version: 'test', input_cost: 0.008, output_cost: 0.002, cached_input_cost: 0, reasoning_cost: 0 };

function directContext(text: string): any {
  return {
    context_package_id: 'direct-meal-1',
    context_package_version: 'conversation-context.v1',
    content_hash: 'sha256:direct-meal-1',
    created_at: '2026-10-19T12:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    conversation_context: { thread_id: 'conv-meal-1', thread_state_version: 'v1', awaiting_user_answer: false, messages: [] },
    direct_response_input: { user_message_id: 'msg-meal-1', user_message_text: text },
    current_state_snapshot: null,
    patient_facts: [],
    provenance: { source_refs: ['msg-meal-1'] },
  };
}

function directTask(context: any) {
  return createConversationDirectResponseTask({
    task_id: 'direct-meal-task-1', context_package_id: context.context_package_id, context_package_version: context.context_package_version,
    context_package_hash: context.content_hash, correlation_id: 'conv-meal-1', created_at: '2026-10-19T12:00:00.000Z', patient_id: 'patient-1',
  });
}

const toolCall = (id: string, name: string, args: Record<string, unknown>): AiProviderResponse => ({
  provider: 'fake', model: 'deep-x', response_id: `resp-${id}`, received_at: '2026-10-19T12:00:01.000Z', raw_output: {},
  tool_calls: [{ call_id: id, tool_name: name, arguments: args }], usage: USAGE, estimated_cost: COST,
});
const answer = (text: string): AiProviderResponse => ({
  provider: 'fake', model: 'deep-x', response_id: 'resp-final', received_at: '2026-10-19T12:00:02.000Z',
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

class RecordingMealTools implements MealActionsTools {
  readonly calls: Array<[string, Record<string, unknown>]> = [];
  constructor(readonly meal_change_requested = true, private readonly fail = false) {}

  async getMeals(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push(['get_meals', args]);
    if (this.fail) throw new Error('database down');
    return { tool: 'get_meals', status: 'OK', meals: [{ meal: 'M1a2b3c', time: '13:10', description: 'Zupa pomidorowa' }], entries: [] };
  }

  async proposeChange(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push(['propose_meal_change', args]);
    return { tool: 'propose_meal_change', status: 'PROPOSED', card: { title: 'Zmiana posiłku · Zupa pomidorowa (13:10)' } };
  }
}

const PROPOSAL_ARGS = {
  operation: 'REPLACE_CONTENT', meal: 'M1a2b3c', entry: null,
  items: [{ name: 'Naleśnik', grams: 120, carbs_g: 34.2, protein_g: 7.8, fat_g: 8.4, source: 'DIABCALC' }],
  description: null, carbs_g: null, protein_g: null, fat_g: null, purpose: null, target_meal: null, enabled: null, reason: 'Zjadł naleśniki.',
};

const toolNames = (input: AiProviderInput) => (input.tool_runtime?.available_tools ?? []).map((tool) => tool.name);

describe('meal tools (get_meals, propose_meal_change) in conversation answers', () => {
  it('reads the meals, prepares a change and answers on the main model', async () => {
    const tools = new RecordingMealTools();
    const provider = new ScriptedProvider([
      toolCall('call-1', 'get_meals', { days_back: null }),
      toolCall('call-2', 'propose_meal_change', PROPOSAL_ARGS),
      answer('Przygotowałem zmianę obiadu z 13:10: W 34 g zamiast 30 g. Zapisze się po „Zatwierdź”.'),
    ]);
    const ctx = directContext('Zamiast ostatniego posiłku zjadł naleśnik');
    const execution = await new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, meal_actions: tools });

    expect(toolNames(provider.inputs[0])).toEqual(['get_meals', 'propose_meal_change']);
    expect(provider.inputs[0].prompt.system_instructions).toContain('MEALS MODULE');
    expect(provider.inputs[0].model_tier).toBe('DEEP');
    expect(tools.calls.map(([name]) => name)).toEqual(['get_meals', 'propose_meal_change']);
    expect(tools.calls[1][1]).toEqual(PROPOSAL_ARGS);
    expect(provider.inputs[2].tool_runtime?.tool_results?.map((result) => [result.tool_name, (result.result as any).status])).toEqual([['propose_meal_change', 'PROPOSED']]);
    expect(execution.metadata.evidence_tool_calls?.map((call) => [call.tool_name, call.result_status])).toEqual([['get_meals', 'OK'], ['propose_meal_change', 'PROPOSED']]);
    // Strict function calling accepts both definitions.
    expect(() => buildOpenAiResponsesRequestBody({
      model: 'deep-x', task_type: 'CONVERSATION_DIRECT_RESPONSE', system_instructions: provider.inputs[1].prompt.system_instructions,
      user_payload: provider.inputs[1].prompt.user_payload, tool_runtime: provider.inputs[1].tool_runtime,
    })).not.toThrow();
  });

  it('stays on the light model for an ordinary direct reply that may read meals', async () => {
    const provider = new ScriptedProvider([answer('Dzień dobry!')]);
    const ctx = directContext('Dzień dobry');
    await new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, meal_actions: new RecordingMealTools(false) });
    expect(provider.inputs[0].model_tier).toBe('LIGHT');
  });

  it('fails open when the meals cannot be read, limits the changes per answer and rejects unknown parameters', async () => {
    const down = new RecordingMealTools(true, true);
    const provider = new ScriptedProvider([toolCall('call-1', 'get_meals', { days_back: 2 }), answer('Nie mogę teraz odczytać posiłków.')]);
    const ctx = directContext('popraw obiad');
    const execution = await new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, meal_actions: down });
    expect(execution.metadata.evidence_tool_calls?.map((call) => call.result_status)).toEqual(['UNAVAILABLE']);
    expect((provider.inputs[1].tool_runtime?.tool_results?.[0].result as any).note).toContain('Posiłki');

    const tools = new RecordingMealTools();
    const many = new ScriptedProvider([
      toolCall('call-1', 'propose_meal_change', PROPOSAL_ARGS),
      toolCall('call-2', 'propose_meal_change', PROPOSAL_ARGS),
      toolCall('call-3', 'propose_meal_change', PROPOSAL_ARGS),
      toolCall('call-4', 'propose_meal_change', PROPOSAL_ARGS),
      answer('Przygotowałem zmiany.'),
    ]);
    const limited = await new AiGatewayService(many).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, meal_actions: tools });
    expect(tools.calls).toHaveLength(3);
    expect(limited.metadata.evidence_tool_calls?.map((call) => call.result_status)).toEqual(['PROPOSED', 'PROPOSED', 'PROPOSED', 'LIMIT_REACHED']);

    const bad = new ScriptedProvider([toolCall('call-x', 'propose_meal_change', { ...PROPOSAL_ARGS, meal_id: 'some-uuid' })]);
    await expect(new AiGatewayService(bad).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, meal_actions: tools }))
      .rejects.toMatchObject({ code: 'AI_CONTRACT_VIOLATION' });
  });

  it('offers no meal tools without the session', async () => {
    const provider = new ScriptedProvider([answer('Obiad wyglądał dobrze.')]);
    const ctx = directContext('jak tam obiad?');
    await new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000 });
    expect(toolNames(provider.inputs[0])).toEqual([]);
    expect(provider.inputs[0].prompt.system_instructions).not.toContain('MEALS MODULE');
  });
});
