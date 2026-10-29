import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANSWER_AS_JSON_INSTRUCTION,
  ANSWER_TOOL_INSTRUCTION,
  ANSWER_TOOL_NAME,
  PARALLEL_TOOLS_INSTRUCTION,
  createAnthropicResponsesTransport,
  createAnthropicResponsesTransportWith,
  parseAnthropicRefusalFallback,
  toClaudeSchema,
  toResponsesUsage,
  type AnthropicMessagesApi,
} from './anthropic-responses-transport';
import { OpenAiProvider, selectOpenAiStructuredSchema } from './openai-provider';
import { SEARCH_KNOWLEDGE_TOOL_DEFINITION } from '@modules/ai-gateway/application/knowledge-answer-rules';
import { SET_REMINDER_TOOL_DEFINITION } from '@modules/care-reminders/application/care-reminders';
import { GET_MEALS_TOOL_DEFINITION, PROPOSE_MEAL_CHANGE_TOOL_DEFINITION } from '@modules/meal-actions/application/meal-actions-tool';
import { SEARCH_FOOD_TOOL_DEFINITION } from '@modules/meal-chat/application/food-search-tool';
import { PROPOSE_BOLUS_TOOL_DEFINITION, ESTIMATE_WBT_TOOL_DEFINITION } from '@modules/remote-commands/application/bolus-proposal-tool';
import { PROPOSE_RESCUE_CARBS_TOOL_DEFINITION } from '@modules/rescue-carbs/application/rescue-carb-proposal-tool';
import { FileExperimentBudgetLedger, initializeExperimentBudgetLedger, summarizeExperimentBudget } from './experiment-budget-ledger';
import { AiGatewayService } from '@modules/ai-gateway/application/ai-gateway.service';
import { createConversationTimeRangeAnalysisTask } from '@modules/ai-gateway/application/ai-task';
import { parseAnthropicEffort } from '@infra/config/environment';

// The Claude transport with a fake Messages API: offline, synthetic data, nothing billed.

type Params = Record<string, unknown>;

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: '{"assistant_message":"OK"}' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, output_tokens_details: { thinking_tokens: 20 } },
    ...overrides,
  };
}

function fakeMessages(replies: Array<Record<string, unknown>>, options: { counted?: number; streamEvents?: unknown[] } = {}) {
  const create = vi.fn(async (_params: Params, _options?: Params) => {
    const next = replies[create.mock.calls.length - 1];
    if (!next) throw new Error('unexpected extra call');
    return next;
  });
  const stream = vi.fn((_params: Params, _options?: Params) => {
    const final = replies[stream.mock.calls.length - 1];
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of options.streamEvents ?? []) yield event;
      },
      finalMessage: async () => final,
    };
  });
  const countTokens = vi.fn(async (_params: Params, _options?: Params) => ({ input_tokens: options.counted ?? 1000 }));
  const api: AnthropicMessagesApi = { create, stream, countTokens };
  return { api, create, stream, countTokens };
}

const conversationBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'claude-opus-5-5',
  input: [
    { role: 'system', content: [{ type: 'input_text', text: 'SYSTEM PROMPT', prompt_cache_breakpoint: { mode: 'explicit' } }] },
    {
      role: 'user',
      content: [
        { type: 'input_text', text: '{"task":1}' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD', detail: 'auto' },
      ],
    },
  ],
  text: { format: { type: 'json_schema', name: 'conversation_output', strict: true, schema: { type: 'object', additionalProperties: false, properties: { title: { type: ['string', 'null'] } }, required: ['title'] } } },
  tools: [{ type: 'function', name: 'get_glucose', description: 'Glucose', parameters: { type: 'object', properties: { hours: { type: 'integer', minimum: 1, maximum: 24 } }, required: ['hours'] }, strict: true }],
  parallel_tool_calls: false,
  prompt_cache_key: 'glucomind:CONVERSATION_DIRECT_RESPONSE',
  max_output_tokens: 4000,
  ...overrides,
});

describe('Claude transport: request translation', () => {
  it('sends the system prompt cached, images, tools, the output schema and one call per turn', async () => {
    const { api, create } = fakeMessages([message()]);
    // Answer as text (the answer tool has its own tests below).
    const transport = createAnthropicResponsesTransportWith({ messages: api, effort: 'low', answerTool: false });
    await transport.responses.create(conversationBody(), { timeout: 30_000, maxRetries: 0 });

    const [params, options] = create.mock.calls[0];
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      system: [{ type: 'text', text: 'SYSTEM PROMPT' }, { type: 'text', text: PARALLEL_TOOLS_INSTRUCTION, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '{"task":1}' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
        ],
      }],
      cache_control: { type: 'ephemeral' },
      tools: [{ name: 'get_glucose', description: 'Glucose', input_schema: { type: 'object', additionalProperties: false, properties: { hours: { type: 'integer' } }, required: ['hours'] } }],
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false, properties: { title: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['title'] } },
      },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    // parallel_tool_calls: false is not passed on: independent calls come in one turn.
    expect(params).not.toHaveProperty('tool_choice');
    // Tools are not strict (too many nullable parameters for one grammar); only the output schema is.
    expect((params.tools as Array<Record<string, unknown>>)[0]).not.toHaveProperty('strict');
    // Only what the SDK understands: no prompt_cache_key, no OpenAI fields.
    expect(params).not.toHaveProperty('prompt_cache_key');
    expect(params).not.toHaveProperty('input');
    expect(options).toEqual({ timeout: 30_000, maxRetries: 0 });
  });

  it('keeps one call per turn when parallel tools are off, and adds no instruction without tools', async () => {
    const { api, create } = fakeMessages([message(), message()]);
    await createAnthropicResponsesTransportWith({ messages: api, parallelTools: false, answerTool: false }).responses.create(conversationBody());
    expect(create.mock.calls[0][0]).toMatchObject({ tool_choice: { type: 'auto', disable_parallel_tool_use: true }, system: [{ type: 'text', text: 'SYSTEM PROMPT', cache_control: { type: 'ephemeral' } }] });
    await createAnthropicResponsesTransportWith({ messages: api }).responses.create({ ...conversationBody(), tools: undefined });
    expect(create.mock.calls[1][0]).toMatchObject({ system: [{ type: 'text', text: 'SYSTEM PROMPT', cache_control: { type: 'ephemeral' } }] });
  });

  it('turns `instructions` into the system prompt, forbids tools with tool_choice none, and omits fallbacks where unsupported or off', async () => {
    const { api, create } = fakeMessages([message({ model: 'claude-haiku-5-5' }), message()]);
    const transport = createAnthropicResponsesTransportWith({ messages: api });
    await transport.responses.create({ model: 'claude-haiku-5-5', instructions: 'BE BRIEF', input: 'hello', tools: conversationBody().tools, tool_choice: 'none' });
    expect(create.mock.calls[0][0]).toMatchObject({ system: [{ type: 'text', text: 'BE BRIEF' }, { type: 'text', text: PARALLEL_TOOLS_INSTRUCTION }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tool_choice: { type: 'none' } });
    expect(create.mock.calls[0][0]).not.toHaveProperty('fallbacks');
    expect(create.mock.calls[0][0]).not.toHaveProperty('output_config');

    const off = createAnthropicResponsesTransportWith({ messages: api, refusalFallback: false });
    await off.responses.create(conversationBody());
    expect(create.mock.calls[1][0]).not.toHaveProperty('fallbacks');
    expect(create.mock.calls[1][0]).not.toHaveProperty('betas');
  });

  it('counts with count_tokens (raised by the margin), without max_tokens or the fallback fields', async () => {
    const { api, countTokens, create } = fakeMessages([], { counted: 1000 });
    const transport = createAnthropicResponsesTransportWith({ messages: api, answerTool: false });
    const counted = await transport.responses.inputTokens!.count(conversationBody());
    expect(counted).toEqual({ input_tokens: 1306 });
    const [params] = countTokens.mock.calls[0];
    expect(params).not.toHaveProperty('max_tokens');
    expect(params).not.toHaveProperty('fallbacks');
    expect(params).not.toHaveProperty('betas');
    expect(params).toHaveProperty('output_config.format');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('Claude transport: responses and tool loops', () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'sig-1' };
  const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'get_glucose', input: { hours: 3 } };

  it('returns output items, output_text and usage in the Responses shape', async () => {
    const { api } = fakeMessages([message({ content: [thinking, { type: 'text', text: 'Sprawdzę.' }, toolUse], stop_reason: 'tool_use' })]);
    const transport = createAnthropicResponsesTransportWith({ messages: api });
    const response = await transport.responses.create(conversationBody());
    expect(response).toMatchObject({
      id: 'msg_1',
      status: 'completed',
      output_text: 'Sprawdzę.',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Sprawdzę.' }] },
        { type: 'function_call', call_id: 'toolu_1', name: 'get_glucose', arguments: '{"hours":3}' },
      ],
      usage: {
        input_tokens: 2400,
        output_tokens: 50,
        total_tokens: 2450,
        input_tokens_details: { cached_tokens: 2000, cache_write_tokens: 300 },
        output_tokens_details: { reasoning_tokens: 20 },
      },
    });
  });

  it('continues a chained request with the stored conversation, the tool output and the added system text', async () => {
    const { api, create } = fakeMessages([
      message({ id: 'msg_1', content: [thinking, toolUse], stop_reason: 'tool_use' }),
      message({ id: 'msg_2' }),
    ]);
    const transport = createAnthropicResponsesTransportWith({ messages: api });
    const first = await transport.responses.create(conversationBody());
    // The gateway's chained finalization: only the new instruction and the new tool output.
    await transport.responses.create({
      model: 'claude-opus-5-5',
      previous_response_id: first.id,
      input: [
        { role: 'system', content: 'FINALIZE NOW' },
        { type: 'function_call_output', call_id: 'toolu_1', output: '{"glucose":[120,130]}' },
      ],
      tools: conversationBody().tools,
      tool_choice: 'none',
      text: conversationBody().text,
    });

    const params = create.mock.calls[1][0] as { system: unknown; messages: Array<{ role: string; content: unknown }> };
    expect(params.system).toEqual(create.mock.calls[0][0].system);
    expect(params.messages.map((entry) => entry.role)).toEqual(['user', 'assistant', 'user', 'system']);
    // The assistant turn goes back unchanged, thinking block included.
    expect(params.messages[1].content).toEqual([thinking, toolUse]);
    expect(params.messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"glucose":[120,130]}' }]);
    expect(params.messages[3].content).toBe('FINALIZE NOW');
  });

  it('drops a resent prompt and keeps only the new part of a longer system prompt', async () => {
    const { api, create } = fakeMessages([
      message({ id: 'msg_1', content: [toolUse], stop_reason: 'tool_use' }),
      message({ id: 'msg_2' }),
    ]);
    const transport = createAnthropicResponsesTransportWith({ messages: api });
    const first = await transport.responses.create(conversationBody());
    const body = conversationBody();
    const [system, user] = body.input as Array<Record<string, unknown>>;
    await transport.responses.create({
      ...body,
      previous_response_id: first.id,
      input: [
        { role: 'system', content: `${(system.content as Array<{ text: string }>)[0].text}\n\nFINALIZE NOW` },
        user,
        { type: 'function_call_output', call_id: 'toolu_1', output: '{}' },
      ],
    });
    const messages = (create.mock.calls[1][0] as { messages: Array<{ role: string; content: unknown }> }).messages;
    expect(messages.map((entry) => entry.role)).toEqual(['user', 'assistant', 'user', 'system']);
    expect(messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{}' }]);
    expect(messages[3].content).toBe('FINALIZE NOW');
  });

  it('refuses a missing chain (retryable), a missing tool output and tool outputs without a chain', async () => {
    const { api } = fakeMessages([message({ id: 'msg_1', content: [toolUse], stop_reason: 'tool_use' })]);
    const transport = createAnthropicResponsesTransportWith({ messages: api });
    await expect(transport.responses.create({ model: 'claude-opus-5-5', previous_response_id: 'msg_unknown', input: [] }))
      .rejects.toMatchObject({ code: 'ANTHROPIC_CHAIN_NOT_FOUND' });
    await expect(transport.responses.create({ model: 'claude-opus-5-5', input: [{ type: 'function_call_output', call_id: 'x', output: '{}' }] }))
      .rejects.toMatchObject({ status: 400, code: 'ANTHROPIC_TOOL_OUTPUT_WITHOUT_CHAIN' });
    const first = await transport.responses.create(conversationBody());
    await expect(transport.responses.create({ model: 'claude-opus-5-5', previous_response_id: first.id, input: [] }))
      .rejects.toMatchObject({ status: 400, code: 'ANTHROPIC_TOOL_OUTPUT_MISSING' });
  });

  it('forgets chains after 30 minutes', async () => {
    let now = 0;
    const { api } = fakeMessages([message({ id: 'msg_1', content: [toolUse], stop_reason: 'tool_use' })]);
    const transport = createAnthropicResponsesTransportWith({ messages: api, now: () => now });
    const first = await transport.responses.create(conversationBody());
    now = 31 * 60_000;
    await expect(transport.responses.create({ model: 'claude-opus-5-5', previous_response_id: first.id, input: [{ type: 'function_call_output', call_id: 'toolu_1', output: '{}' }] }))
      .rejects.toMatchObject({ code: 'ANTHROPIC_CHAIN_NOT_FOUND' });
  });

  it('throws a non-retryable error on a refusal and a retryable one on a cut-off answer', async () => {
    const { api } = fakeMessages([
      message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio' }, content: [] }),
      message({ stop_reason: 'max_tokens' }),
    ]);
    const transport = createAnthropicResponsesTransportWith({ messages: api });
    await expect(transport.responses.create(conversationBody())).rejects.toMatchObject({ status: 400, code: 'ANTHROPIC_REFUSAL' });
    const cutOff = await transport.responses.create(conversationBody()).catch((error: unknown) => error as Record<string, unknown>);
    expect(cutOff).toMatchObject({ code: 'ANTHROPIC_OUTPUT_TRUNCATED' });
    expect(cutOff).not.toHaveProperty('status');
  });

  it('leaves out the declined model\'s thinking and tool calls before a mid-output fallback', async () => {
    const { api, create } = fakeMessages([
      message({
        id: 'msg_1',
        stop_reason: 'tool_use',
        content: [thinking, { type: 'tool_use', id: 'toolu_declined', name: 'get_glucose', input: {} }, { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } }, toolUse],
      }),
      message({ id: 'msg_2' }),
    ]);
    const transport = createAnthropicResponsesTransportWith({ messages: api });
    const first = await transport.responses.create(conversationBody());
    expect((first.output as Array<{ call_id?: string }>).filter((item) => item.call_id).map((item) => item.call_id)).toEqual(['toolu_1']);
    await transport.responses.create({ model: 'claude-opus-5-5', previous_response_id: first.id, input: [{ type: 'function_call_output', call_id: 'toolu_1', output: '{}' }] });
    expect((create.mock.calls[1][0] as { messages: Array<{ content: unknown }> }).messages[1].content).toEqual([toolUse]);
  });

  it('streams text deltas and ends with the complete response', async () => {
    const { api, stream, create } = fakeMessages([message()], {
      streamEvents: [
        { type: 'message_start' },
        { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"assistant_' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'message":"OK"}' } },
        { type: 'message_stop' },
      ],
    });
    const transport = createAnthropicResponsesTransportWith({ messages: api, answerTool: false });
    const events: Array<Record<string, unknown>> = [];
    for await (const event of await transport.responses.create({ ...conversationBody(), stream: true }) as unknown as AsyncIterable<Record<string, unknown>>) {
      events.push(event);
    }
    expect(create).not.toHaveBeenCalled();
    expect(stream.mock.calls[0][0]).not.toHaveProperty('stream');
    expect(events.map((event) => event.type)).toEqual(['response.output_text.delta', 'response.output_text.delta', 'response.completed']);
    expect(events[2]).toMatchObject({ response: { output_text: '{"assistant_message":"OK"}' } });
  });
});

describe('Claude transport: the answer tool (tools + output schema)', () => {
  const answer = { type: 'tool_use', id: 'toolu_answer', name: ANSWER_TOOL_NAME, input: { assistant_message: 'Gotowe.' } };
  const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'get_glucose', input: { hours: 3 } };

  it('asks for the answer as a streamed strict tool instead of the text schema; the final turn answers as text', async () => {
    const { api, create } = fakeMessages([message(), message()]);
    const transport = createAnthropicResponsesTransportWith({ messages: api });
    await transport.responses.create(conversationBody());
    const params = create.mock.calls[0][0] as Record<string, any>;
    expect(params.tools.map((tool: { name: string }) => tool.name)).toEqual(['get_glucose', ANSWER_TOOL_NAME]);
    expect(params.tools[1]).toMatchObject({ strict: true, eager_input_streaming: true, input_schema: { type: 'object', properties: { title: { anyOf: [{ type: 'string' }, { type: 'null' }] } } } });
    expect(params.output_config?.format).toBeUndefined();
    expect(params.system.map((block: { text: string }) => block.text)).toEqual(['SYSTEM PROMPT', PARALLEL_TOOLS_INSTRUCTION, ANSWER_TOOL_INSTRUCTION]);

    await transport.responses.create({ ...conversationBody(), tool_choice: 'none' });
    const final = create.mock.calls[1][0] as Record<string, any>;
    expect(final.tool_choice).toEqual({ type: 'none' });
    expect(final.output_config).toHaveProperty('format');
    expect(final.tools.map((tool: { name: string }) => tool.name)).toEqual(['get_glucose', ANSWER_TOOL_NAME]);
  });

  it('returns the answer tool input as output_text, without a function call, and keeps no chain', async () => {
    const { api } = fakeMessages([message({ id: 'msg_answer', content: [{ type: 'thinking', thinking: '', signature: 's' }, answer], stop_reason: 'tool_use' })]);
    const transport = createAnthropicResponsesTransportWith({ messages: api });
    const response = await transport.responses.create(conversationBody());
    expect(response).toMatchObject({ status: 'completed', output_text: '{"assistant_message":"Gotowe."}', output: [{ type: 'message' }] });
    expect((response.output as unknown[]).length).toBe(1);
    await expect(transport.responses.create({ model: 'claude-opus-5-5', previous_response_id: 'msg_answer', input: [] })).rejects.toMatchObject({ code: 'ANTHROPIC_CHAIN_NOT_FOUND' });
  });

  it('drops an answer called next to other tools and tells Claude so on the next round', async () => {
    const { api, create } = fakeMessages([message({ id: 'msg_1', content: [toolUse, answer], stop_reason: 'tool_use' }), message({ id: 'msg_2' })]);
    const transport = createAnthropicResponsesTransportWith({ messages: api });
    const first = await transport.responses.create(conversationBody());
    expect(first.output_text).toBe('');
    expect((first.output as Array<{ name?: string }>).map((item) => item.name)).toEqual(['get_glucose']);
    await transport.responses.create({ model: 'claude-opus-5-5', previous_response_id: first.id, input: [{ type: 'function_call_output', call_id: 'toolu_1', output: '{}' }], tools: conversationBody().tools, text: conversationBody().text });
    const messages = (create.mock.calls[1][0] as { messages: Array<{ content: unknown }> }).messages;
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '{}' },
      { type: 'tool_result', tool_use_id: 'toolu_answer', content: expect.stringContaining('Not delivered') },
    ]);
  });

  it('streams the answer tool input as output text and leaves the notes before it out', async () => {
    const { api } = fakeMessages([message({ content: [{ type: 'text', text: 'Sprawdzam.' }, answer], stop_reason: 'tool_use' })], {
      streamEvents: [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sprawdzam.' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_answer', name: ANSWER_TOOL_NAME, input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"assistant_message": "Got' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'owe."}' } },
      ],
    });
    const transport = createAnthropicResponsesTransportWith({ messages: api });
    const events: Array<Record<string, unknown>> = [];
    for await (const event of await transport.responses.create({ ...conversationBody(), stream: true }) as unknown as AsyncIterable<Record<string, unknown>>) events.push(event);
    expect(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta)).toEqual(['{"assistant_message": "Got', 'owe."}']);
    expect(events.at(-1)).toMatchObject({ type: 'response.completed', response: { output_text: '{"assistant_message":"Gotowe."}' } });
  });
});

describe('Claude transport on the real SDK (HTTP faked)', () => {
  it('posts to the beta Messages endpoint with the fallback beta header and the translated body', async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) });
      const reply = String(url).includes('count_tokens') ? { input_tokens: 1000 } : message();
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const transport = createAnthropicResponsesTransport({ apiKey: 'synthetic-test-key', effort: 'medium', fetch: fakeFetch });

    await transport.responses.inputTokens!.count(conversationBody());
    const response = await transport.responses.create(conversationBody(), { timeout: 30_000, maxRetries: 0 });

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(['/v1/messages/count_tokens', '/v1/messages']);
    expect(requests[0].headers.get('anthropic-beta') ?? '').not.toContain('server-side-fallback');
    expect(requests[1].headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(requests[1].headers.get('x-api-key')).toBe('synthetic-test-key');
    expect(requests[1].body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 4000, fallbacks: 'default', output_config: { effort: 'medium' } });
    expect(requests[1].body).not.toHaveProperty('betas');
    expect(response).toMatchObject({ id: 'msg_1', output_text: '{"assistant_message":"OK"}' });
  });

  it('streams server-sent events into text deltas and the final response', async () => {
    const sse = [
      ['message_start', { type: 'message_start', message: { ...message(), content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"assistant_message":' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '"OK"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }],
      ['message_stop', { type: 'message_stop' }],
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    const fakeFetch = (async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const transport = createAnthropicResponsesTransport({ apiKey: 'synthetic-test-key', fetch: fakeFetch });

    const events: Array<Record<string, unknown>> = [];
    for await (const event of await transport.responses.create({ ...conversationBody(), tools: undefined, stream: true }) as unknown as AsyncIterable<Record<string, unknown>>) {
      events.push(event);
    }
    expect(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta)).toEqual(['{"assistant_message":', '"OK"}']);
    expect(events[events.length - 1]).toMatchObject({ type: 'response.completed', response: { output_text: '{"assistant_message":"OK"}', usage: { input_tokens: 100, output_tokens: 7 } } });
  });
});

describe('Claude transport: helpers', () => {
  it('reduces schemas to what structured outputs accept', () => {
    expect(toClaudeSchema({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 20, pattern: '^a', format: 'not-a-format' },
        when: { type: 'string', format: 'date-time' },
        items: { type: 'array', minItems: 1, items: { type: 'object', properties: { n: { type: 'number', minimum: 0 } } } },
        kind: { oneOf: [{ type: 'string', enum: ['A'] }, { type: 'null' }] },
      },
      required: ['name'],
    })).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        when: { type: 'string', format: 'date-time' },
        items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { n: { type: 'number' } } } },
        kind: { anyOf: [{ type: 'string', enum: ['A'] }, { type: 'null' }] },
      },
      required: ['name'],
    });
  });

  it('keeps null out of the string branch of a nullable enum (propose_bolus option)', () => {
    expect(toClaudeSchema({ type: ['string', 'null'], enum: ['A', 'B', null], description: 'Option' })).toEqual({
      description: 'Option',
      anyOf: [{ type: 'string', enum: ['A', 'B'] }, { type: 'null' }],
    });
  });

  it('accepts every conversation tool schema of the gateway (no null in a typed enum, objects closed)', () => {
    const typedEnumsWithNull: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) return node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (typeof record.type === 'string' && record.type !== 'null' && Array.isArray(record.enum) && record.enum.includes(null)) typedEnumsWithNull.push(path);
      if (Array.isArray(record.type)) typedEnumsWithNull.push(`${path} (type array left)`);
      for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`);
    };
    for (const tool of [PROPOSE_BOLUS_TOOL_DEFINITION, ESTIMATE_WBT_TOOL_DEFINITION, PROPOSE_RESCUE_CARBS_TOOL_DEFINITION, PROPOSE_MEAL_CHANGE_TOOL_DEFINITION, GET_MEALS_TOOL_DEFINITION, SEARCH_FOOD_TOOL_DEFINITION, SEARCH_KNOWLEDGE_TOOL_DEFINITION, SET_REMINDER_TOOL_DEFINITION]) {
      walk(toClaudeSchema(tool.input_schema), tool.name);
    }
    walk(toClaudeSchema(selectOpenAiStructuredSchema('CONVERSATION_DIRECT_RESPONSE').schema), 'CONVERSATION_DIRECT_RESPONSE');
    expect(typedEnumsWithNull).toEqual([]);
  });

  it('maps usage and returns null without counts', () => {
    expect(toResponsesUsage({ input_tokens: 10, output_tokens: 5 })).toEqual({
      input_tokens: 10, output_tokens: 5, total_tokens: 15,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
    expect(toResponsesUsage(null)).toBeNull();
    expect(toResponsesUsage({ output_tokens: 5 })).toBeNull();
  });

  it('counts every attempt of a refusal fallback (never less than was billed)', () => {
    const usage = toResponsesUsage({
      input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      iterations: [
        { type: 'message', model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ],
    });
    expect(usage).toMatchObject({ input_tokens: 200, output_tokens: 320 });
    // No fallback: the top-level counts as they are.
    expect(toResponsesUsage({ input_tokens: 100, output_tokens: 20, iterations: [{ type: 'message', input_tokens: 100, output_tokens: 20 }] })).toMatchObject({ input_tokens: 100, output_tokens: 20 });
  });

  it('asks again for an answer written as prose, as structured output with no tools, priced with both calls', async () => {
    const prose = message({ content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Glukoza wygląda dobrze.' }] });
    const { api, create } = fakeMessages([prose, message({ content: [{ type: 'text', text: '{"assistant_message":"Glukoza wygląda dobrze."}' }] }), message()]);
    const transport = createAnthropicResponsesTransportWith({ messages: api, effort: 'low' });
    const response = await transport.responses.create(conversationBody());
    expect(response.output_text).toBe('{"assistant_message":"Glukoza wygląda dobrze."}');
    const retry = create.mock.calls[1][0] as Record<string, any>;
    expect(retry.tool_choice).toEqual({ type: 'none' });
    expect(retry.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: expect.objectContaining({ type: 'object' }) } });
    expect(retry).not.toHaveProperty('cache_control');
    expect(retry.messages.slice(-2)).toEqual([
      { role: 'assistant', content: prose.content },
      { role: 'user', content: [{ type: 'text', text: ANSWER_AS_JSON_INSTRUCTION }] },
    ]);
    expect(response.usage).toMatchObject({ input_tokens: 2 * 2400, output_tokens: 100, output_tokens_details: { reasoning_tokens: 40 } });
    // An answer written as JSON text is kept as it is.
    await expect(transport.responses.create(conversationBody())).resolves.toMatchObject({ output_text: '{"assistant_message":"OK"}' });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('streams the answer asked again after prose', async () => {
    const { api, stream } = fakeMessages([message({ content: [{ type: 'text', text: 'Proza.' }] }), message({ content: [{ type: 'text', text: '{"assistant_message":"OK"}' }] })], {
      streamEvents: [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"assistant_message":"OK"}' } }],
    });
    const transport = createAnthropicResponsesTransportWith({ messages: api });
    const events: Array<Record<string, unknown>> = [];
    for await (const event of await transport.responses.create({ ...conversationBody(), stream: true }) as unknown as AsyncIterable<Record<string, unknown>>) events.push(event);
    expect(stream).toHaveBeenCalledTimes(2);
    // The first stream's text is a note in answer mode (not shown); the second one's text is the answer.
    expect(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta)).toEqual(['{"assistant_message":"OK"}']);
    expect(events.at(-1)).toMatchObject({ type: 'response.completed', response: { output_text: '{"assistant_message":"OK"}' } });
  });

  it('writes the conversation cache only when a tool round can follow', async () => {
    const { api, create } = fakeMessages([message(), message(), message()]);
    const transport = createAnthropicResponsesTransportWith({ messages: api });
    await transport.responses.create(conversationBody());
    await transport.responses.create(conversationBody({ tool_choice: 'none' }));
    await transport.responses.create(conversationBody({ tools: [] }));
    expect(create.mock.calls.map((call) => 'cache_control' in (call[0] as Record<string, unknown>))).toEqual([true, false, false]);
  });

  it('parses ANTHROPIC_EFFORT and ANTHROPIC_REFUSAL_FALLBACK strictly', () => {
    expect(parseAnthropicEffort(undefined)).toBeNull();
    expect(parseAnthropicEffort(' Medium ')).toBe('medium');
    expect(() => parseAnthropicEffort('minimal')).toThrow(/ANTHROPIC_EFFORT/);
    expect(parseAnthropicRefusalFallback(undefined)).toBe(true);
    expect(parseAnthropicRefusalFallback('off')).toBe(false);
    expect(parseAnthropicRefusalFallback(false)).toBe(false);
    expect(() => parseAnthropicRefusalFallback('maybe')).toThrow(/ANTHROPIC_REFUSAL_FALLBACK/);
  });
});

describe('Claude through the provider, the cost guard and the gateway', () => {
  let ledgerDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    ledgerDir = mkdtempSync(join(tmpdir(), 'glucomind-anthropic-test-'));
    ledgerPath = join(ledgerDir, 'ledger.json');
    initializeExperimentBudgetLedger(ledgerPath, { experiment_id: 'synthetic-anthropic', currency: 'USD', total_budget: 1, max_calls: 5 });
  });

  afterEach(() => {
    rmSync(ledgerDir, { recursive: true, force: true });
  });

  it('answers a time-range analysis, records provider anthropic and settles the cost in the shared ledger', async () => {
    const answer = JSON.stringify({ assistant_message: 'Glikemia była dziś stabilna.', follow_up_candidates: [], conversation_title: null, answer_options: [] });
    const { api, create, countTokens } = fakeMessages([message({ content: [{ type: 'text', text: answer }], usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })], { counted: 900 });
    const provider = new OpenAiProvider({
      apiKey: '',
      providerName: 'anthropic',
      model: 'claude-opus-5-5',
      timeoutMs: 5000,
      pricing: { input_per_1k_tokens: 0.004, output_per_1k_tokens: 0.02, cached_input_per_1k_tokens: 0.0004, reasoning_per_1k_tokens: 0, currency: 'USD', pricing_version: 'synthetic-claude.v1' },
      costGuard: { max_cost: 0.5, currency: 'USD', max_output_tokens: 8000 },
      budgetLedger: new FileExperimentBudgetLedger(ledgerPath),
    }, createAnthropicResponsesTransportWith({ messages: api }));

    const context = timeRangeContext();
    const task = createConversationTimeRangeAnalysisTask({
      task_id: 'anthropic-task-1',
      context_package_id: context.context_package_id,
      context_package_version: context.context_package_version,
      context_package_hash: context.content_hash,
      correlation_id: 'conv-anthropic-1',
      created_at: '2026-10-08T10:00:00.000Z',
      patient_id: 'patient-1',
    });
    const result = await new AiGatewayService(provider).execute({ task, context_package: context, timeout_ms: 5000 });

    expect(countTokens).toHaveBeenCalled();
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 8000 });
    expect(result.metadata).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' });
    // 1000 input × 0.004/1k + 200 output × 0.02/1k.
    expect(result.metadata.estimated_cost?.estimated_cost).toBeCloseTo(0.008, 6);
    const budget = summarizeExperimentBudget(new FileExperimentBudgetLedger(ledgerPath).read());
    expect(budget.calls).toBe(1);
    expect(budget.charged).toBeCloseTo(0.008, 6);
    expect(new FileExperimentBudgetLedger(ledgerPath).read().reservations[0].label).toBe('anthropic:claude-opus-5-5');
  });
});

function timeRangeContext(): any {
  return {
    context_package_id: 'tr-anthropic-1',
    context_package_version: 'conversation-time-range-context.v1',
    content_hash: 'sha256:tr-anthropic-1',
    created_at: '2026-10-08T10:00:00.000Z',
    patient_ref: { patient_id: 'patient-1' },
    analysis_request_input: {
      user_message_id: 'msg-anthropic-1',
      user_message_text: 'Przeanalizuj mi dzisiejszy dzień',
      range_type: 'TODAY',
      timezone: 'Europe/Warsaw',
      range_start: '2026-10-08T00:00:00.000Z',
      range_end: '2026-10-08T23:59:59.999Z',
      requested_at: '2026-10-08T10:00:00.000Z',
    },
    conversation_context: { thread_id: 'conv-anthropic-1', thread_state_version: 'v1', awaiting_user_answer: false, messages: [] },
    current_state_snapshot: { as_of: '2026-10-08T10:00:00.000Z', current_glucose: 142, trend: 'FLAT', iob: 1.9 },
    analytical_evidence: {
      glucose_events: [
        { event_id: 'g-1', occurred_at: '2026-10-08T06:00:00.000Z', payload: { glucose_value: 91 }, provenance_ref: 'source-record/g-1' },
        { event_id: 'g-2', occurred_at: '2026-10-08T07:00:00.000Z', payload: { glucose_value: 122 }, provenance_ref: 'source-record/g-2' },
      ],
      insulin_treatment_events: [],
      meal_events: [],
      activity_events: [],
      hypo_episodes: [],
      range_event_facts: [],
      summaries: {
        total_events: 2, glucose_count: 2, insulin_treatment_count: 0, meal_count: 0, activity_count: 0, hypo_episode_count: 0,
        glucose_min: 91, glucose_max: 122, glucose_avg: 106.5, missing_sections: ['insulin_treatment_events', 'meal_events', 'activity_events', 'hypo_episodes'],
      },
    },
    provenance: { source_refs: ['msg-anthropic-1'], selection_policy_version: 'conversation-time-range-selector.v1' },
  };
}

describe('ANTHROPIC_PARALLEL_TOOLS', () => {
  it('lets the switch turn off parallel tool calls when the caller asks for one per turn', async () => {
    const { buildRequest } = await import('./anthropic-responses-transport');
    const body = { model: 'claude-opus-5-5', input: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', name: 'get_glucose', parameters: { type: 'object', properties: {} } }], parallel_tool_calls: false };
    expect(buildRequest(body, null, { parallelTools: false }).params.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(buildRequest(body, null, { parallelTools: true }).params.tool_choice).toBeUndefined();
  });
});

describe('refusal fallback pricing', () => {
  it('names the model a fallback served the answer with', async () => {
    const { fallbackModelOf } = await import('./anthropic-responses-transport');
    expect(fallbackModelOf({ usage: { iterations: [{ type: 'message', model: 'claude-opus-5-5' }, { type: 'fallback_message', model: 'claude-opus-5' }] } })).toBe('claude-opus-5');
    expect(fallbackModelOf({ usage: { iterations: [{ type: 'message', model: 'claude-opus-5-5' }] } })).toBeNull();
    expect(fallbackModelOf({ usage: {} })).toBeNull();
  });
});
