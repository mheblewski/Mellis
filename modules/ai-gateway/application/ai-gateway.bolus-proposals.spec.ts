import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiGatewayService } from './ai-gateway.service';
import { createConversationDirectResponseTask } from './ai-task';
import type { AiProvider, AiProviderInput, AiProviderResponse } from '@modules/ai-gateway/domain/ai-gateway';
import { buildOpenAiResponsesRequestBody } from '@modules/ai-gateway/infrastructure/openai-provider';
import type { BolusProposalTools } from '@modules/remote-commands/application/bolus-proposal-tool';

const USAGE = { input_tokens: 100, output_tokens: 10, total_tokens: 110, cached_input_tokens: 0, reasoning_tokens: 0 };
const COST = { estimated_cost: 0.01, currency: 'USD', pricing_version: 'test', input_cost: 0.008, output_cost: 0.002, cached_input_cost: 0, reasoning_cost: 0 };

function directContext(text: string): any {
  return {
    context_package_id: 'direct-bolus-1',
    context_package_version: 'conversation-context.v1',
    content_hash: 'sha256:direct-bolus-1',
    created_at: '2026-10-19T12:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    conversation_context: { thread_id: 'conv-bolus-1', thread_state_version: 'v1', awaiting_user_answer: false, messages: [] },
    direct_response_input: { user_message_id: 'msg-bolus-1', user_message_text: text },
    current_state_snapshot: null,
    patient_facts: [],
    provenance: { source_refs: ['msg-bolus-1'] },
  };
}

function directTask(context: any) {
  return createConversationDirectResponseTask({
    task_id: 'direct-bolus-task-1', context_package_id: context.context_package_id, context_package_version: context.context_package_version,
    context_package_hash: context.content_hash, correlation_id: 'conv-bolus-1', created_at: '2026-10-19T12:00:00.000Z', patient_id: 'patient-1',
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

class RecordingBolusTools implements BolusProposalTools {
  readonly calls: Array<Record<string, unknown>> = [];
  constructor(readonly dose_requested = true, private readonly fail = false) {}

  async propose(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push(args);
    if (this.fail) throw new Error('database down');
    return { tool: 'propose_bolus', status: 'PROPOSED', card: { carbs_g: 46, insulin_u: 3.8, dose_from_icr: 3.8, icr_g_per_u: 12, warnings: [] } };
  }
}

const BOLUS_ARGS = {
  purpose: 'MEAL', carbs_g: 46, insulin_u: null, meal_description: 'Naleśniki z serem ×2',
  items: [{ name: 'Naleśnik z serem', grams: 240, carbs_g: 46, protein_g: 22, fat_g: 14, source: 'DIABCALC' }], reason: 'Obiad.',
};

const toolNames = (input: AiProviderInput) => (input.tool_runtime?.available_tools ?? []).map((tool) => tool.name);

describe('bolus cards (propose_bolus) in conversation answers', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('prepares the cards of the options (at most 6) for a dose question on the main model', async () => {
    const tools = new RecordingBolusTools();
    const provider = new ScriptedProvider([
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => toolCall(`call-${n}`, 'propose_bolus', BOLUS_ARGS)),
      answer('Na dwa naleśniki z serem: W 46 g, 3,8 j. Podasz je przyciskiem na karcie po sprawdzeniu.'),
    ]);
    const ctx = directContext('Ile podać na 2 naleśniki z serem?');
    const execution = await new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, bolus_proposals: tools });

    expect(toolNames(provider.inputs[0])).toEqual(['propose_bolus']);
    expect(provider.inputs[0].prompt.system_instructions).toContain('BOLUS CARDS');
    expect(provider.inputs[0].model_tier).toBe('DEEP');
    expect(tools.calls).toHaveLength(6);
    expect(execution.metadata.evidence_tool_calls?.map((call) => call.result_status)).toEqual([...Array(6).fill('PROPOSED'), 'LIMIT_REACHED']);
    expect(() => buildOpenAiResponsesRequestBody({
      model: 'deep-x', task_type: 'CONVERSATION_DIRECT_RESPONSE', system_instructions: provider.inputs[1].prompt.system_instructions,
      user_payload: provider.inputs[1].prompt.user_payload, tool_runtime: provider.inputs[1].tool_runtime,
    })).not.toThrow();
  });

  it('prepares the cards of all options in one turn (parallel calls, AI_PARALLEL_CARD_TOOL_CALLS=0 turns it off)', async () => {
    const tools = new RecordingBolusTools();
    const both: AiProviderResponse = {
      ...toolCall('call-a', 'propose_bolus', { ...BOLUS_ARGS, option: 'A' }),
      tool_calls: [{ call_id: 'call-a', tool_name: 'propose_bolus', arguments: { ...BOLUS_ARGS, option: 'A' } }, { call_id: 'call-b', tool_name: 'propose_bolus', arguments: { ...BOLUS_ARGS, option: 'B' } }],
    };
    const provider = new ScriptedProvider([both, answer('Opcja A albo B poniżej.')]);
    const ctx = directContext('Co robić? Je kanapkę, a cukier spada.');
    await new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, bolus_proposals: tools });

    expect(tools.calls.map((call) => call.option)).toEqual(['A', 'B']);
    expect(provider.inputs).toHaveLength(2);
    expect(provider.inputs[0].tool_runtime?.parallel_tool_calls).toBe(true);
    expect(provider.inputs[1].tool_runtime?.tool_results.map((result) => result.call_id)).toEqual(['call-a', 'call-b']);
    const body = buildOpenAiResponsesRequestBody({
      model: 'deep-x', task_type: 'CONVERSATION_DIRECT_RESPONSE', system_instructions: provider.inputs[0].prompt.system_instructions,
      user_payload: provider.inputs[0].prompt.user_payload, tool_runtime: provider.inputs[0].tool_runtime,
    });
    expect(body.parallel_tool_calls).toBe(true);

    vi.stubEnv('AI_PARALLEL_CARD_TOOL_CALLS', '0');
    const sequential = new ScriptedProvider([toolCall('call-1', 'propose_bolus', BOLUS_ARGS), answer('Karta poniżej.')]);
    await new AiGatewayService(sequential).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, bolus_proposals: new RecordingBolusTools() });
    expect(sequential.inputs[0].tool_runtime?.parallel_tool_calls).toBeUndefined();
    expect(buildOpenAiResponsesRequestBody({
      model: 'deep-x', task_type: 'CONVERSATION_DIRECT_RESPONSE', system_instructions: sequential.inputs[0].prompt.system_instructions, user_payload: sequential.inputs[0].prompt.user_payload, tool_runtime: sequential.inputs[0].tool_runtime,
    }).parallel_tool_calls).toBe(false);
  });

  it('fails open and rejects unknown parameters', async () => {
    const provider = new ScriptedProvider([toolCall('call-1', 'propose_bolus', BOLUS_ARGS), answer('Karty nie da się teraz przygotować.')]);
    const ctx = directContext('ile podać na obiad');
    const execution = await new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, bolus_proposals: new RecordingBolusTools(true, true) });
    expect(execution.metadata.evidence_tool_calls?.map((call) => call.result_status)).toEqual(['UNAVAILABLE']);

    const bad = new ScriptedProvider([toolCall('call-x', 'propose_bolus', { ...BOLUS_ARGS, send_now: true })]);
    await expect(new AiGatewayService(bad).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, bolus_proposals: new RecordingBolusTools() }))
      .rejects.toMatchObject({ code: 'AI_CONTRACT_VIOLATION' });
  });

  it('uses the sources when they help, never as a gate before the card (owner 2026-10-22)', async () => {
    const tools = new RecordingBolusTools();
    const knowledge = {
      search: { search: async () => ({ status: 'NO_RESULTS', unavailable_reason: null, corpus_version: 'test', fragments: [], diagnostics: {} } as any) },
      protocol_card: null,
    };
    const provider = new ScriptedProvider([toolCall('call-1', 'propose_bolus', BOLUS_ARGS), answer('Na naleśniki: W 46 g, 3,8 j.')]);
    const ctx = directContext('Ile podać na 2 naleśniki z serem?');
    const execution = await new AiGatewayService(provider, knowledge as any).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, bolus_proposals: tools });

    expect(provider.inputs[0].prompt.system_instructions).toContain('a fatty meal with the advised split or the caregiver\'s own plan needs no search');
    expect(provider.inputs[0].prompt.system_instructions).toContain('never search to second-guess them');
    expect(provider.inputs[0].prompt.system_instructions).toContain('SPLIT BOLUS');
    expect(execution.metadata.evidence_tool_calls?.map((call) => [call.tool_name, call.result_status])).toEqual([['propose_bolus', 'PROPOSED']]);
  });

  it('sets reminders the caregiver asks for (set_reminder, care-reminders.v1)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const reminders = { set: async (args: Record<string, unknown>) => { calls.push(args); return { tool: 'set_reminder', status: 'SET', reminder: { described: 'czw., 14:00' } }; } };
    const args = { note: 'Sprawdź glukozę', trigger: 'AT_TIME', in_minutes: 120, at_local: null, threshold_mgdl: null, wait_minutes: null };
    const provider = new ScriptedProvider([toolCall('call-1', 'set_reminder', args), answer('Przypomnę o 14:00.')]);
    const ctx = directContext('Przypomnij mi za 2 godziny sprawdzić glukozę');
    const execution = await new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, care_reminders: reminders });
    expect(toolNames(provider.inputs[0])).toEqual(['set_reminder']);
    expect(provider.inputs[0].prompt.system_instructions).toContain('REMINDERS:');
    expect(calls).toEqual([args]);
    expect(execution.metadata.evidence_tool_calls?.map((call) => [call.tool_name, call.result_status])).toEqual([['set_reminder', 'SET']]);
  });

  it('needs no search without the knowledge base', async () => {
    const tools = new RecordingBolusTools();
    const provider = new ScriptedProvider([toolCall('call-1', 'propose_bolus', BOLUS_ARGS), answer('W 46 g, 3,8 j.')]);
    const ctx = directContext('ile podać na obiad');
    await new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, bolus_proposals: tools });
    expect(tools.calls).toHaveLength(1);
    expect(provider.inputs[0].prompt.system_instructions).not.toContain('needs no search');
  });

  it('offers no card without the session', async () => {
    const provider = new ScriptedProvider([answer('Około 4 j.')]);
    const ctx = directContext('ile podać na obiad');
    await new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000 });
    expect(toolNames(provider.inputs[0])).toEqual([]);
    expect(provider.inputs[0].prompt.system_instructions).not.toContain('BOLUS CARDS');
  });
});
