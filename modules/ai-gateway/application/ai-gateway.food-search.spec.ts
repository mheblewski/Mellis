import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiGatewayService } from './ai-gateway.service';
import { createConversationDirectResponseTask, createConversationTimeRangeAnalysisTask } from './ai-task';
import type { AiProvider, AiProviderInput, AiProviderResponse } from '@modules/ai-gateway/domain/ai-gateway';
import { buildOpenAiResponsesRequestBody } from '@modules/ai-gateway/infrastructure/openai-provider';
import { DiabCalcUnavailableError, type DiabCalcFood, type FoodSearch } from '@modules/meal-chat/infrastructure/diabcalc-mcp-client';

const USAGE = { input_tokens: 100, output_tokens: 10, total_tokens: 110, cached_input_tokens: 0, reasoning_tokens: 0 };
const COST = { estimated_cost: 0.01, currency: 'USD', pricing_version: 'test', input_cost: 0.008, output_cost: 0.002, cached_input_cost: 0, reasoning_cost: 0 };
const JPEG = { media_type: 'image/jpeg' as const, data_base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64') };

function directContext(text: string): any {
  return {
    context_package_id: 'direct-food-1',
    context_package_version: 'conversation-context.v1',
    content_hash: 'sha256:direct-food-1',
    created_at: '2026-10-17T10:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    conversation_context: { thread_id: 'conv-food-1', thread_state_version: 'v1', awaiting_user_answer: false, messages: [] },
    direct_response_input: { user_message_id: 'msg-food-1', user_message_text: text },
    current_state_snapshot: null,
    patient_facts: [],
    provenance: { source_refs: ['msg-food-1'] },
  };
}

function directTask(context: any) {
  return createConversationDirectResponseTask({
    task_id: 'direct-food-task-1', context_package_id: context.context_package_id, context_package_version: context.context_package_version,
    context_package_hash: context.content_hash, correlation_id: 'conv-food-1', created_at: '2026-10-17T10:00:00.000Z', patient_id: 'patient-1',
  });
}

function timeRangeContext(text: string): any {
  return {
    context_package_id: 'tr-food-1',
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: 'sha256:tr-food-1',
    created_at: '2026-10-17T10:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    analysis_request_input: {
      user_message_id: 'msg-food-2',
      user_message_text: text,
      range_type: 'TODAY',
      timezone: 'Europe/Warsaw',
      range_start: '2026-10-16T22:00:00.000Z',
      range_end: '2026-10-17T10:00:00.000Z',
      requested_at: '2026-10-17T10:00:00.000Z',
    },
    conversation_context: { thread_id: 'conv-food-2', thread_state_version: 'v1', awaiting_user_answer: false, messages: [] },
    current_state_snapshot: { as_of: '2026-10-17T10:00:00.000Z', current_glucose: 142, trend: 'FLAT', iob: 0.4 },
    analytical_evidence: {
      glucose_events: [{ event_id: 'g-1', occurred_at: '2026-10-17T09:55:00.000Z', payload: { glucose_value: 142 }, provenance_ref: 'source-record/g-1' }],
      insulin_treatment_events: [],
      meal_events: [],
      activity_events: [],
      hypo_episodes: [],
      range_event_facts: [],
      summaries: {
        total_events: 1, glucose_count: 1, insulin_treatment_count: 0, meal_count: 0, activity_count: 0, hypo_episode_count: 0,
        glucose_min: 142, glucose_max: 142, glucose_avg: 142, missing_sections: ['meal_events', 'activity_events'],
      },
    },
    provenance: { source_refs: ['msg-food-2'], selection_policy_version: 'conversation-time-range-selector.v1' },
  };
}

function timeRangeTask(ctx: any) {
  return createConversationTimeRangeAnalysisTask({
    task_id: 'tr-food-task-1', context_package_id: ctx.context_package_id, context_package_version: ctx.context_package_version,
    context_package_hash: ctx.content_hash, correlation_id: 'conv-food-2', created_at: '2026-10-17T10:00:00.000Z', patient_id: 'patient-1',
  });
}

const toolCall = (id: string, name: string, args: Record<string, unknown>): AiProviderResponse => ({
  provider: 'fake', model: 'deep-x', response_id: `resp-${id}`, received_at: '2026-10-17T10:00:01.000Z', raw_output: {},
  tool_calls: [{ call_id: id, tool_name: name, arguments: args }], usage: USAGE, estimated_cost: COST,
});
const answer = (text: string): AiProviderResponse => ({
  provider: 'fake', model: 'deep-x', response_id: 'resp-final', received_at: '2026-10-17T10:00:02.000Z',
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

const food = (name: string, carbs: number): DiabCalcFood => ({
  name, brand: null, serving_grams: 50, serving_note: null, per_100g: { carbs_g: carbs, protein_g: 8, fat_g: 3, kcal: 280 }, glycemic_index: null,
});

class RecordingFoods implements FoodSearch {
  readonly queries: string[] = [];
  constructor(private readonly respond: (query: string) => Promise<DiabCalcFood[]>) {}

  async searchFood(query: string): Promise<DiabCalcFood[]> {
    this.queries.push(query);
    return this.respond(query);
  }
}

const toolNames = (input: AiProviderInput) => (input.tool_runtime?.available_tools ?? []).map((tool) => tool.name);
const foodResults = (provider: ScriptedProvider) => provider.inputs
  .flatMap((input) => input.tool_runtime?.tool_results ?? [])
  .filter((result) => result.tool_name === 'search_food')
  .map((result) => result.result as any);

describe('search_food (DiabCalc) in conversation answers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('looks up several products in one call for a direct question about a meal', async () => {
    const foods = new RecordingFoods(async (query) => (query.includes('kajzerka') ? [food('Bułka kajzerka', 58)] : []));
    const provider = new ScriptedProvider([
      toolCall('call-1', 'search_food', { queries: ['bułka kajzerka', 'Bułka kajzerka', 'szynka konserwowa'] }),
      answer('2 kajzerki (100 g): W 58 g (DiabCalc).'),
    ]);
    const ctx = directContext('Ile węglowodanów mają 2 kajzerki z szynką?');
    const execution = await new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, food_search: foods });

    expect(toolNames(provider.inputs[0])).toEqual(['search_food']);
    expect(provider.inputs[0].prompt.system_instructions).toContain('search_food looks products up in the DiabCalc database');
    // Duplicates (case-insensitive) are searched once.
    expect(foods.queries).toEqual(['bułka kajzerka', 'szynka konserwowa']);
    const [result] = foodResults(provider);
    expect(result).toMatchObject({ tool: 'search_food', status: 'FOUND' });
    expect(result.products[0]).toMatchObject({ query: 'bułka kajzerka', matches: [{ name: 'Bułka kajzerka', per_100g: { carbs_g: 58 } }] });
    expect(result.products[1]).toMatchObject({ query: 'szynka konserwowa', matches: [] });
    expect(result.products[1].note).toContain('estimate');
    expect(execution.metadata.evidence_tool_calls?.map((call) => [call.tool_name, call.result_status])).toEqual([['search_food', 'FOUND']]);
    // Strict function calling accepts the definition and its output.
    expect(() => buildOpenAiResponsesRequestBody({
      model: 'deep-x', task_type: 'CONVERSATION_DIRECT_RESPONSE', system_instructions: provider.inputs[1].prompt.system_instructions,
      user_payload: provider.inputs[1].prompt.user_payload, tool_runtime: provider.inputs[1].tool_runtime,
    })).not.toThrow();
  });

  it('fails open when DiabCalc is down, limits the lookups and rejects unknown parameters', async () => {
    const down = new RecordingFoods(async () => { throw new DiabCalcUnavailableError('timeout'); });
    const provider = new ScriptedProvider([
      toolCall('call-1', 'search_food', { queries: ['naleśniki'] }),
      toolCall('call-2', 'search_food', { queries: ['dżem truskawkowy'] }),
      toolCall('call-3', 'search_food', { queries: ['twaróg'] }),
      answer('Szacunek: naleśniki ok. 40 g W.'),
    ]);
    const ctx = directContext('Ile insuliny na 2 naleśniki z dżemem?');
    const execution = await new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, food_search: down });
    expect(down.queries).toEqual(['naleśniki', 'dżem truskawkowy']);
    expect(execution.metadata.evidence_tool_calls?.map((call) => call.result_status)).toEqual(['UNAVAILABLE', 'UNAVAILABLE', 'LIMIT_REACHED']);
    expect(foodResults(provider)[0].note).toContain('unavailable');

    const bad = new ScriptedProvider([toolCall('call-x', 'search_food', { queries: ['ryż'], patient_id: 'other' })]);
    await expect(new AiGatewayService(bad).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, food_search: down }))
      .rejects.toMatchObject({ code: 'AI_CONTRACT_VIOLATION' });
  });

  it('offers search_food next to the evidence tools in a time-range analysis, and only with the food search wired in', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    const foods = new RecordingFoods(async () => [food('Ryż biały gotowany', 28)]);
    const provider = new ScriptedProvider([answer('Odpowiedź.')]);
    const ctx = timeRangeContext('Ile insuliny podać na 150 g ryżu z kurczakiem?');
    await new AiGatewayService(provider).execute({ task: timeRangeTask(ctx), context_package: ctx, timeout_ms: 5000, food_search: foods });
    expect(toolNames(provider.inputs[0])).toEqual(expect.arrayContaining(['search_food', 'get_glucose_evidence']));

    const withoutFoods = new ScriptedProvider([answer('Odpowiedź.')]);
    await new AiGatewayService(withoutFoods).execute({ task: timeRangeTask(ctx), context_package: ctx, timeout_ms: 5000 });
    expect(toolNames(withoutFoods.inputs[0])).not.toContain('search_food');
    expect(withoutFoods.inputs[0].prompt.system_instructions).not.toContain('search_food');
  });

  it('tells the model when an attached photo could not be loaded, instead of answering as if none was sent', async () => {
    const provider = new ScriptedProvider([answer('Nie udało się wczytać zdjęcia.')]);
    const ctx = directContext('[zdjęcie bez opisu]');
    await new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, user_images: [JPEG], user_images_unavailable: 1 });

    expect(provider.inputs[0].user_images).toEqual([JPEG]);
    expect(provider.inputs[0].prompt.system_instructions).toContain('the caregiver attached 1 photo');
    expect(provider.inputs[0].prompt.system_instructions).toContain('1 photo the caregiver attached could not be loaded');
  });

  it('sends attached photos as images on the main model and tells the model about them', async () => {
    const provider = new ScriptedProvider([answer('Na zdjęciu: kanapka, ok. 30 g W.')]);
    const ctx = directContext('[zdjęcie bez opisu]');
    await new AiGatewayService(provider).execute({ task: directTask(ctx), context_package: ctx, timeout_ms: 5000, user_images: [JPEG, JPEG] });

    expect(provider.inputs[0].user_images).toEqual([JPEG, JPEG]);
    expect(provider.inputs[0].model_tier).toBe('DEEP');
    expect(provider.inputs[0].prompt.system_instructions).toContain('the caregiver attached 2 photos');

    const body = buildOpenAiResponsesRequestBody({
      model: 'deep-x', task_type: 'CONVERSATION_DIRECT_RESPONSE', system_instructions: 'x',
      user_payload: provider.inputs[0].prompt.user_payload, user_images: provider.inputs[0].user_images,
    }) as { input: Array<{ role?: string; content: unknown }> };
    const user = body.input.find((item) => item.role === 'user') as { content: Array<Record<string, unknown>> };
    expect(user.content[0]).toMatchObject({ type: 'input_text' });
    expect(JSON.parse(String(user.content[0].text))).toBeTypeOf('object');
    expect(user.content.slice(1)).toEqual([
      { type: 'input_image', image_url: `data:image/jpeg;base64,${JPEG.data_base64}`, detail: 'auto' },
      { type: 'input_image', image_url: `data:image/jpeg;base64,${JPEG.data_base64}`, detail: 'auto' },
    ]);

    // Without photos the user message stays the plain envelope string.
    const plain = buildOpenAiResponsesRequestBody({
      model: 'deep-x', task_type: 'CONVERSATION_DIRECT_RESPONSE', system_instructions: 'x', user_payload: provider.inputs[0].prompt.user_payload,
    }) as { input: Array<{ role?: string; content: unknown }> };
    expect(typeof plain.input.find((item) => item.role === 'user')?.content).toBe('string');
  });
});
