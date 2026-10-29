import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiGatewayService, addKnowledgeSearchCost } from './ai-gateway.service';
import { createConversationDirectResponseTask, createConversationTimeRangeAnalysisTask } from './ai-task';
import type { AiProvider, AiProviderInput, AiProviderResponse } from '@modules/ai-gateway/domain/ai-gateway';
import { buildOpenAiResponsesRequestBody } from '@modules/ai-gateway/infrastructure/openai-provider';
import { KnowledgeSearchService, type KnowledgeSearch } from '@modules/knowledge/application/knowledge-search';
import {
  FakeEmbeddingsClient,
  FakeKnowledgeChunkStore,
  FakeLightModelClient,
  fakeKnowledgeChunk,
} from '@modules/knowledge/infrastructure/fake-knowledge-search';
import type { KnowledgeServices } from '@modules/knowledge/infrastructure/knowledge-services.factory';

const USAGE = { input_tokens: 100, output_tokens: 10, total_tokens: 110, cached_input_tokens: 0, reasoning_tokens: 0 };
const COST = { estimated_cost: 0.01, currency: 'USD', pricing_version: 'test', input_cost: 0.008, output_cost: 0.002, cached_input_cost: 0, reasoning_cost: 0 };

function timeRangeContext(text = 'Dlaczego wczoraj w nocy był nagły spadek, a potem od razu wzrost?'): any {
  return {
    context_package_id: 'tr-knowledge-1',
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: 'sha256:tr-knowledge-1',
    created_at: '2026-10-08T10:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    analysis_request_input: {
      user_message_id: 'msg-knowledge-1',
      user_message_text: text,
      range_type: 'TODAY',
      timezone: 'Europe/Warsaw',
      range_start: '2026-10-08T00:00:00.000Z',
      range_end: '2026-10-08T23:59:59.999Z',
      requested_at: '2026-10-08T10:00:00.000Z',
    },
    conversation_context: { thread_id: 'conv-knowledge-1', thread_state_version: 'v1', awaiting_user_answer: false, messages: [] },
    current_state_snapshot: { as_of: '2026-10-08T10:00:00.000Z', current_glucose: 142, trend: 'FLAT', iob: 1.9 },
    analytical_evidence: {
      glucose_events: [
        { event_id: 'g-1', occurred_at: '2026-10-08T02:00:00.000Z', payload: { glucose_value: 128 }, provenance_ref: 'source-record/g-1' },
        { event_id: 'g-2', occurred_at: '2026-10-08T02:20:00.000Z', payload: { glucose_value: 52 }, provenance_ref: 'source-record/g-2' },
        { event_id: 'g-3', occurred_at: '2026-10-08T02:40:00.000Z', payload: { glucose_value: 131 }, provenance_ref: 'source-record/g-3' },
      ],
      insulin_treatment_events: [],
      meal_events: [],
      activity_events: [],
      hypo_episodes: [],
      range_event_facts: [],
      summaries: {
        total_events: 3, glucose_count: 3, insulin_treatment_count: 0, meal_count: 0, activity_count: 0, hypo_episode_count: 0,
        glucose_min: 52, glucose_max: 131, glucose_avg: 103.7, missing_sections: ['meal_events', 'activity_events'],
      },
    },
    provenance: { source_refs: ['msg-knowledge-1'], selection_policy_version: 'conversation-time-range-selector.v1' },
  };
}

function timeRangeTask(context: any) {
  return createConversationTimeRangeAnalysisTask({
    task_id: 'knowledge-task-1', context_package_id: context.context_package_id, context_package_version: context.context_package_version,
    context_package_hash: context.content_hash, correlation_id: 'conv-knowledge-1', created_at: '2026-10-08T10:00:00.000Z', patient_id: 'patient-1',
  });
}

function directContext(text: string): any {
  return {
    context_package_id: 'direct-knowledge-1',
    context_package_version: 'conversation-context.v1',
    content_hash: 'sha256:direct-knowledge-1',
    created_at: '2026-10-08T10:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    conversation_context: { thread_id: 'conv-direct-1', thread_state_version: 'v1', awaiting_user_answer: false, messages: [] },
    direct_response_input: { user_message_id: 'msg-direct-1', user_message_text: text },
    current_state_snapshot: null,
    patient_facts: [],
    provenance: { source_refs: ['msg-direct-1'] },
  };
}

function directTask(context: any) {
  return createConversationDirectResponseTask({
    task_id: 'direct-task-1', context_package_id: context.context_package_id, context_package_version: context.context_package_version,
    context_package_hash: context.content_hash, correlation_id: 'conv-direct-1', created_at: '2026-10-08T10:00:00.000Z', patient_id: 'patient-1',
  });
}

const toolCall = (id: string, name: string, args: Record<string, unknown>): AiProviderResponse => ({
  provider: 'fake', model: 'deep-x', response_id: `resp-${id}`, received_at: '2026-10-08T10:00:01.000Z', raw_output: {},
  tool_calls: [{ call_id: id, tool_name: name, arguments: args }], usage: USAGE, estimated_cost: COST,
});
const answer = (text: string): AiProviderResponse => ({
  provider: 'fake', model: 'deep-x', response_id: 'resp-final', received_at: '2026-10-08T10:00:02.000Z',
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

const CHUNKS = Array.from({ length: 8 }, (_unused, index) => fakeKnowledgeChunk(`dexcom-g7#${index + 1}`, {
  title: 'Dexcom G7 User Guide',
  section: index === 0 ? 'Compression lows' : `Chapter ${index + 1}`,
  page: 100 + index,
  text: index === 0 ? 'Pressure on the sensor can cause falsely low readings (compression low).' : `Fragment ${index + 1}.`,
}));

function knowledge(options: { rerank?: string; search?: KnowledgeSearch; protocolCard?: string | null } = {}) {
  const store = new FakeKnowledgeChunkStore(CHUNKS);
  const light = new FakeLightModelClient({ rewrite: 'Dexcom G7 compression low at night', rerank: options.rerank ?? '1, 3' });
  const search = options.search ?? new KnowledgeSearchService({
    store, lightClient: light, embeddingsClient: new FakeEmbeddingsClient(), lightModel: 'light-x',
    pricing: { currency: 'USD', light: { input_per_1k_tokens: 0.0002, cached_input_per_1k_tokens: 0.00002, output_per_1k_tokens: 0.0012, reasoning_per_1k_tokens: 0, currency: 'USD', pricing_version: 'light-test' }, embedding_input_per_1k_tokens: 0.00002 },
  });
  const services: KnowledgeServices = { search, protocol_card: options.protocolCard ?? null };
  return { store, light, services };
}

const toolNames = (input: AiProviderInput) => (input.tool_runtime?.available_tools ?? []).map((tool) => tool.name);

describe('search_knowledge in conversations', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lets one answer look at the data and at the sources, and returns the cited sources with the message', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    const { services, light } = knowledge();
    const provider = new ScriptedProvider([
      toolCall('call-g', 'get_glucose_evidence', { time_range: { from: '2026-10-08T01:00:00.000Z', to: '2026-10-08T04:00:00.000Z' }, detail_level: 'DETAIL' }),
      toolCall('call-k', 'search_knowledge', { query: 'nagły spadek i powrót glukozy w nocy z sensorem Dexcom G7: ucisk sensora' }),
      answer('Spadek do 52 i powrót do 131 w 40 minut wygląda na ucisk sensora [S1] (fałszywie niski odczyt), nie na prawdziwą hipo [S2].'),
    ]);
    const attempts: any[] = [];
    const context = timeRangeContext();
    const execution = await new AiGatewayService(provider, services).execute({
      task: timeRangeTask(context),
      context_package: context,
      timeout_ms: 5000,
      attempt_observer: {
        onAttemptStarted: async () => ({ attempt_id: 'a-1', attempt_number: 1 }),
        onAttemptSucceeded: async (args) => { attempts.push(args); },
        onAttemptFailed: async () => undefined,
      },
    });

    // Data tools and the knowledge tool in one request, same definitions on every turn.
    expect(provider.inputs).toHaveLength(3);
    expect(toolNames(provider.inputs[0])).toContain('get_glucose_evidence');
    expect(toolNames(provider.inputs[0])).toContain('search_knowledge');
    expect(provider.inputs.map(toolNames)).toEqual([toolNames(provider.inputs[0]), toolNames(provider.inputs[0]), toolNames(provider.inputs[0])]);
    // Answer rules in the system instructions, next to the existing therapy rules.
    const system = provider.inputs[0].prompt.system_instructions;
    expect(system).toContain('never add their results together');
    expect(system).toContain('Apply a table only to the situation in its caption');
    expect(system).toContain('(wiedza ogólna, nie ze źródeł)');
    expect(system).toContain('look at the data first with the evidence tools');
    expect(system).toContain('Therapy suggestions are allowed');

    // The knowledge result reaches the model with numbered fragments and their source labels (rerank order: 1, 3).
    const knowledgeResult = provider.inputs[2].tool_runtime!.tool_results.find((result) => result.tool_name === 'search_knowledge')!.result as any;
    expect(knowledgeResult).toMatchObject({ tool: 'search_knowledge', status: 'FOUND', corpus_version: 'fake-corpus.v1' });
    expect(knowledgeResult.fragments.map((fragment: any) => fragment.ref)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
    expect(knowledgeResult.fragments[0]).toEqual({ ref: 'S1', source: 'Dexcom G7 User Guide, sekcja Compression lows, s. 100', text: 'Pressure on the sensor can cause falsely low readings (compression low).' });
    expect(knowledgeResult.fragments[1].source).toContain('Chapter 3');
    expect(light.requests).toHaveLength(2);
    // The OpenAI request body accepts the knowledge result as a function output.
    expect(() => buildOpenAiResponsesRequestBody({
      model: 'deep-x', task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS', system_instructions: system,
      user_payload: provider.inputs[2].prompt.user_payload, tool_runtime: provider.inputs[2].tool_runtime,
    })).not.toThrow();

    // Cited sources in citation order, no fragment text; the audit names query, status and chunks.
    expect(execution.metadata.knowledge_sources).toEqual([
      { ref: 'S1', title: 'Dexcom G7 User Guide', section: 'Compression lows', page: 100, page_end: null, chunk_id: 'dexcom-g7#1', corpus_version: 'fake-corpus.v1' },
      { ref: 'S2', title: 'Dexcom G7 User Guide', section: 'Chapter 3', page: 102, page_end: null, chunk_id: 'dexcom-g7#3', corpus_version: 'fake-corpus.v1' },
    ]);
    const audit = execution.metadata.knowledge_search as any;
    expect(audit.calls).toEqual([expect.objectContaining({ status: 'FOUND', refs: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'], chunk_ids: expect.arrayContaining(['dexcom-g7#1']) })]);
    expect(execution.metadata.evidence_tool_calls?.map((call) => call.tool_name)).toEqual(['get_glucose_evidence', 'search_knowledge']);
    // Attempt cost = 3 provider calls + the knowledge search's light/embedding calls.
    expect(audit.estimated_cost.amount).toBeGreaterThan(0);
    expect(attempts[0].estimated_cost.estimated_cost).toBeCloseTo(0.03 + audit.estimated_cost.amount, 8);
  });

  it('gives direct replies the knowledge tool alone and answers knowledge questions on the main model', async () => {
    const { services } = knowledge();
    const provider = new ScriptedProvider([
      toolCall('call-k', 'search_knowledge', { query: 'WBT metoda warszawska' }),
      answer('1 WBT to 100 kcal z białka i tłuszczu [S1].'),
    ]);
    const context = directContext('Jak działa WBT?');
    const execution = await new AiGatewayService(provider, services).execute({ task: directTask(context), context_package: context, timeout_ms: 5000 });

    expect(provider.inputs.map(toolNames)).toEqual([['search_knowledge'], ['search_knowledge']]);
    expect(provider.inputs[0].model_tier).toBe('DEEP');
    expect(provider.inputs[0].prompt.system_instructions).toContain('not loaded in this reply');
    expect(execution.metadata.knowledge_sources?.map((source) => source.ref)).toEqual(['S1']);

    const thanks = new ScriptedProvider([answer('Proszę!')]);
    const thanksContext = directContext('dzięki');
    await new AiGatewayService(thanks, services).execute({ task: directTask(thanksContext), context_package: thanksContext, timeout_ms: 5000 });
    expect(thanks.inputs[0].model_tier).toBe('LIGHT');
  });

  it('answers without sources when the search is unavailable, and tells the model to say so', async () => {
    const unavailable: KnowledgeSearch = {
      search: async () => ({ status: 'UNAVAILABLE', unavailable_reason: 'TIMEOUT', corpus_version: null, fragments: [], diagnostics: {} as any }),
    };
    const { services } = knowledge({ search: unavailable });
    const provider = new ScriptedProvider([
      toolCall('call-k', 'search_knowledge', { query: 'ketony w chorobie' }),
      answer('Nie udało się teraz przeszukać bazy wiedzy. Z wiedzy ogólnej: ... (wiedza ogólna, nie ze źródeł) [S1]'),
    ]);
    const context = directContext('Co robić przy ketonach w czasie choroby?');
    const execution = await new AiGatewayService(provider, services).execute({ task: directTask(context), context_package: context, timeout_ms: 5000 });

    const result = provider.inputs[1].tool_runtime!.tool_results[0].result as any;
    expect(result).toMatchObject({ status: 'UNAVAILABLE', fragments: [] });
    expect(result.note).toContain('Answer without sources and say so');
    // A cited number that no search returned is not shown as a source.
    expect(execution.metadata.knowledge_sources).toEqual([]);
    expect((execution.metadata.knowledge_search as any).calls[0]).toMatchObject({ status: 'UNAVAILABLE', unavailable_reason: 'TIMEOUT' });
  });

  it('limits searches per answer, answers a repeated query without searching, and rejects unknown parameters', async () => {
    const { services, store } = knowledge();
    const provider = new ScriptedProvider([
      toolCall('k1', 'search_knowledge', { query: 'ketony' }),
      toolCall('k2', 'search_knowledge', { query: ' ketony ' }),
      toolCall('k3', 'search_knowledge', { query: 'wysiłek' }),
      answer('Odpowiedź [S7].'),
    ]);
    const context = directContext('Ketony i wysiłek?');
    const execution = await new AiGatewayService(provider, services).execute({ task: directTask(context), context_package: context, timeout_ms: 5000 });
    expect((execution.metadata.knowledge_search as any).calls.map((call: any) => call.status)).toEqual(['FOUND', 'DUPLICATE_QUERY', 'FOUND']);
    expect(store.queries).toHaveLength(2);
    // Numbers continue across searches: the second search's first fragment is S7.
    expect(execution.metadata.knowledge_sources?.map((source) => [source.ref, source.chunk_id])).toEqual([['S7', 'dexcom-g7#1']]);
    // Three tool calls used up the budget: the last turn forbids further calls.
    expect(provider.inputs[3].tool_runtime?.tool_choice).toBe('none');

    const bad = new ScriptedProvider([toolCall('k1', 'search_knowledge', { query: 'x', patient_id: 'p' })]);
    await expect(new AiGatewayService(bad, services).execute({ task: directTask(context), context_package: context, timeout_ms: 5000 }))
      .rejects.toMatchObject({ code: 'AI_CONTRACT_VIOLATION' });
  });

  it('leaves conversations unchanged without the knowledge services, and never offers the tool to time-range analyses', async () => {
    vi.stubEnv('AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING', '1');
    const plain = new ScriptedProvider([answer('Odpowiedź.')]);
    const context = directContext('Jak działa WBT?');
    await new AiGatewayService(plain).execute({ task: directTask(context), context_package: context, timeout_ms: 5000 });
    expect(plain.inputs[0].tool_runtime).toBeUndefined();
    expect(plain.inputs[0].model_tier).toBe('LIGHT');
    expect(plain.inputs[0].prompt.system_instructions).not.toContain('search_knowledge');

    const timeRange = new ScriptedProvider([answer('Odpowiedź.')]);
    const trContext = timeRangeContext();
    await new AiGatewayService(timeRange).execute({ task: timeRangeTask(trContext), context_package: trContext, timeout_ms: 5000 });
    expect(toolNames(timeRange.inputs[0])).not.toContain('search_knowledge');
  });

  it('states the patient\'s age from the year of birth in the answer and in the knowledge search', async () => {
    const { services, light } = knowledge();
    const provider = new ScriptedProvider([
      toolCall('call-k', 'search_knowledge', { query: 'ile węglowodanów na niedocukrzenie' }),
      answer('Odpowiedź [S1].'),
    ]);
    const context = { ...directContext('Ile podać na niedocukrzenie?'), patient_ref: { patient_id: 'patient-1', birth_year: 1990 } };
    await new AiGatewayService(provider, services).execute({ task: directTask(context), context_package: context, timeout_ms: 5000 });

    const age = new Date().getUTCFullYear() - 1990;
    const system = provider.inputs[0].prompt.system_instructions;
    expect(system.endsWith(`Patient age: about ${age} (born 1990), an adult. Portions, doses, settings and studies are for an adult; still err on the conservative side.`)).toBe(true);
    expect(system).not.toContain('the patient is a child');
    expect(JSON.parse(provider.inputs[0].prompt.user_payload).patient_ref).toEqual({ patient_id: 'patient-1', birth_year: 1990 });
    // The English query and the pick of fragments look for guidance for adults.
    expect((light.requests[0] as any).instructions).toContain(`The patient is an adult of about ${age}`);
  });

  it('puts the asking user\'s preferences last, after the age, and never into the payload', async () => {
    const { services } = knowledge();
    const provider = new ScriptedProvider([answer('Odpowiedź.')]);
    const context = {
      ...directContext('Co teraz?'),
      patient_ref: { patient_id: 'patient-1', birth_year: 1990 },
      user_preferences: { ai_role: 'PATIENT_SELF' as const, ai_instructions: 'Mów do mnie jak lekarz.' },
    };
    await new AiGatewayService(provider, services).execute({ task: directTask(context), context_package: context, timeout_ms: 5000 });

    const lines = provider.inputs[0].prompt.system_instructions.split('\n');
    expect(lines.at(-2)).toMatch(/^Patient age: about \d+ \(born 1990\)/);
    expect(lines.at(-1)).toMatch(/^User preferences \(tone and who is writing; lower priority than every safety and dosing rule above/);
    expect(lines.at(-1)).toContain('the patient themself');
    expect(lines.at(-1)).toContain('"Mów do mnie jak lekarz."');
    expect(provider.inputs[0].prompt.user_payload).not.toContain('Mów do mnie jak lekarz');
  });

  it('adds no preferences line when the user has set none', async () => {
    const { services } = knowledge();
    const provider = new ScriptedProvider([answer('Odpowiedź.')]);
    const context = { ...directContext('Co teraz?'), user_preferences: { ai_role: null, ai_instructions: null } };
    await new AiGatewayService(provider, services).execute({ task: directTask(context), context_package: context, timeout_ms: 5000 });
    expect(provider.inputs[0].prompt.system_instructions).not.toContain('User preferences');
    expect(provider.inputs[0].prompt.system_instructions.split('\n').at(-1)).toMatch(/^Patient age:/);
  });

  it('adds the protocol card only when the services carry an approved one', async () => {
    const { services } = knowledge({ protocolCard: 'Ketony 0,6–1,5: metoda A (korekta +10%).' });
    const provider = new ScriptedProvider([answer('Odpowiedź.')]);
    const context = directContext('Co przy ketonach?');
    const execution = await new AiGatewayService(provider, services).execute({ task: directTask(context), context_package: context, timeout_ms: 5000 });
    expect(provider.inputs[0].prompt.system_instructions).toContain('Protocol card approved by this patient\'s diabetes team');
    expect(provider.inputs[0].prompt.system_instructions).toContain('metoda A (korekta +10%)');
    expect((execution.metadata.knowledge_search as any).protocol_card).toBe(true);

    const none = new ScriptedProvider([answer('Odpowiedź.')]);
    await new AiGatewayService(none, knowledge().services).execute({ task: directTask(context), context_package: context, timeout_ms: 5000 });
    expect(none.inputs[0].prompt.system_instructions).not.toContain('Protocol card');
  });

  it('adds knowledge costs to the attempt total only in the same currency', () => {
    const estimate = { ...COST };
    expect(addKnowledgeSearchCost(estimate, [{ amount: 0.002, currency: 'USD' }])?.estimated_cost).toBeCloseTo(0.012, 8);
    expect(addKnowledgeSearchCost(estimate, [{ amount: 0.002, currency: 'EUR' }])).toEqual(estimate);
    expect(addKnowledgeSearchCost(estimate, [])).toEqual(estimate);
    expect(addKnowledgeSearchCost(null, [{ amount: 0.002, currency: 'USD' }])).toBeNull();
  });
});
