import Anthropic from '@anthropic-ai/sdk';
import { parseAnthropicEffort, type AnthropicEffort } from '@infra/config/environment';
import { createGuardedOpenAiClient, resolveOpenAiCostGuardFromEnv, resolveOpenAiPricingFromEnv, type OpenAiResponsesTransport, type SettledAiCall } from './guarded-openai-client';

/**
 * Claude (Anthropic Messages API) behind the Responses-shaped transport every AI caller of the worker is written
 * against (OpenAiProvider, meal chat, WBT). AI_PROVIDER=anthropic swaps this transport in; the requests, the cost guard
 * (it wraps this transport like the OpenAI one), streaming and the tool loops stay as they are.
 *
 * What the translation does:
 *   - leading system items and `instructions` become `system` (cached: the prompt is the same for every answer);
 *     `text.format` becomes `output_config.format` (schemas reduced to what structured outputs accept), function tools
 *     become custom tools (not strict, see buildRequest), `tool_choice: 'none'` and `parallel_tool_calls: false` keep their meaning;
 *   - previous_response_id: Messages has no server-side chain, so this transport keeps it. A response that asks for
 *     tools is remembered by its id with the full conversation (thinking blocks included, which a tool loop must send
 *     back unchanged); a request chained on it continues that conversation with the outputs of the pending calls.
 *     System text sent again is dropped, and text added to it (the gateway's finalization instruction) goes in as a
 *     mid-conversation system message. Chains live in this process only: a worker restart loses the loops in flight,
 *     which then fail and are retried as new jobs;
 *   - the response comes back with `output` items, `output_text` and usage in the Responses shape, so the guard prices
 *     it: input includes cache reads and writes, reasoning = thinking tokens (already part of output);
 *   - with tools and an output schema the answer is the input of the deliver_answer tool, which streams (text after a
 *     tool result does not, see ANSWER_TOOL_NAME); the caller still gets it as output_text;
 *   - `stream: true` yields `response.output_text.delta` events and a final `response.completed`.
 * Refusals (stop_reason "refusal") throw a non-retryable error. With refusal fallback on (the default) supported models
 * send `fallbacks: "default"`, so a declined request is answered by the fallback model the API picks.
 */

export { parseAnthropicEffort, type AnthropicEffort };

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`); others answer without it. */
const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1'];
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * count_tokens is documented as an estimate that may differ slightly from the billed input; the guard refuses a call
 * whose billed input exceeds its bound, so the count is raised by this margin (it only raises the reservation).
 */
const COUNT_MARGIN_FACTOR = 1.05;
const COUNT_MARGIN_TOKENS = 256;

/** Claude-only system text, after the caller's prompt (cached with it): fewer turns, each of which re-reads everything. */
export const PARALLEL_TOOLS_INSTRUCTION = 'Tool calls: when you need several tools whose inputs do not depend on each other\'s results (evidence of different kinds or time ranges, the cards of every option of an answer, a food search for each product), call them all in the same turn. Call a tool in a later turn only when its input needs an earlier tool\'s result.';

/**
 * Answers with tools go through this tool, not text: on Claude Opus 5.5 / Sonnet 5.5 text written after a tool result
 * is held back until the turn ends (it may turn out to be a progress note before another call), so an answer written
 * as text reaches the caregiver all at once. Tool input streams (eager_input_streaming), so the answer is shown while
 * it is written. Its input is the answer in the output schema; the transport returns it as output_text.
 */
export const ANSWER_TOOL_NAME = 'deliver_answer';
export const ANSWER_TOOL_INSTRUCTION = `Answer: deliver your final answer only by calling ${ANSWER_TOOL_NAME}, with the whole answer as its input; never write the answer as text. Call it alone, once every other tool you need has returned.`;
const ANSWER_NOT_DELIVERED = 'Not delivered: other tools of the same turn were still running. Read their results, then call deliver_answer again.';
/** The same on the final turn, where no tool can be called: the answer is written as the turn's output. */
const ANSWER_NOT_DELIVERED_FINAL = 'Not delivered: other tools of the same turn were still running. Read their results and write the final answer now.';

/**
 * After an answer written as prose (deliver_answer not called): one more turn with no tools and the output schema as
 * structured output, so the answer is still delivered (forced tool_choice is refused on Opus 5.5 / Sonnet 5.5).
 */
export const ANSWER_AS_JSON_INSTRUCTION = `That answer was not delivered: it was written as text instead of calling ${ANSWER_TOOL_NAME}. Write the whole final answer now as the JSON output, with the same content.`;

/** max_tokens when the caller sets none (the guarded client always sets its cap). */
const DEFAULT_MAX_TOKENS = 16_000;

/** Chains are needed only while a tool loop runs (seconds to a minute): a small, short-lived memory is enough. */
const CHAIN_CAPACITY = 64;
const CHAIN_TTL_MS = 30 * 60_000;

/** The part of the SDK this transport uses (client.beta.messages); offline tests inject a fake. */
export interface AnthropicMessagesApi {
  create(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  stream(params: Record<string, unknown>, options?: Record<string, unknown>): AnthropicMessageStream;
  countTokens(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

export interface AnthropicMessageStream extends AsyncIterable<unknown> {
  finalMessage(): Promise<unknown>;
}

export interface AnthropicResponsesTransportConfig {
  messages: AnthropicMessagesApi;
  effort?: AnthropicEffort | null;
  /** Server-side refusal fallback for the models that support it; default on. */
  refusalFallback?: boolean;
  /**
   * Default on: independent tool calls in one turn (parallel_tool_calls: false is not passed on) and the system
   * instruction asking for them. Off: one call per turn where the caller asks for it, as on OpenAI.
   */
  parallelTools?: boolean;
  /** Default on: with tools and an output schema, the answer comes as the deliver_answer tool (see ANSWER_TOOL_NAME). */
  answerTool?: boolean;
  now?: () => number;
}

type Block = Record<string, unknown>;
type Message = { role: 'user' | 'assistant' | 'system'; content: string | Block[] };

interface Chain {
  system: Block[];
  systemTexts: string[];
  /** The first user message as sent, to recognize it when a caller sends the whole prompt again. */
  firstUserKey: string;
  messages: Message[];
  storedAt: number;
}

/** The real client: one HTTP request per call (the guard and the job retry decide about retries). */
export function createAnthropicResponsesTransport(args: {
  apiKey: string;
  effort?: AnthropicEffort | null;
  refusalFallback?: boolean;
  /** ANTHROPIC_ANSWER_TOOL: the answer as the streamed deliver_answer tool (default on). */
  answerTool?: boolean;
  /** ANTHROPIC_PARALLEL_TOOLS: several tool calls in one turn (default on); off = one per turn when the caller asks. */
  parallelTools?: boolean;
  /** Offline tests only: the HTTP layer under the real SDK. */
  fetch?: typeof fetch;
}): OpenAiResponsesTransport {
  const client = new Anthropic({ apiKey: args.apiKey, maxRetries: 0, ...(args.fetch ? { fetch: args.fetch } : {}) });
  const beta = client.beta.messages;
  return createAnthropicResponsesTransportWith({
    messages: {
      create: (params, options) => beta.create(params as never, options as never),
      stream: (params, options) => beta.stream(params as never, options as never) as unknown as AnthropicMessageStream,
      countTokens: (params, options) => beta.countTokens(params as never, options as never),
    },
    effort: args.effort ?? null,
    refusalFallback: args.refusalFallback,
    answerTool: args.answerTool,
    parallelTools: args.parallelTools,
  });
}

/** A Claude switch that is on unless set false-like (ANTHROPIC_REFUSAL_FALLBACK, ANTHROPIC_ANSWER_TOOL); anything else throws. */
export function parseAnthropicSwitch(value: unknown, name: string): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value === undefined || value === null ? '' : String(value).toLowerCase();
  if (!normalized || /^(1|true|yes|on)$/.test(normalized)) return true;
  if (/^(0|false|no|off)$/.test(normalized)) return false;
  throw new Error(`${name} must be true or false, got ${normalized}`);
}

/** ANTHROPIC_REFUSAL_FALLBACK: unset or true-like = on, false-like = off; anything else is refused at startup. */
export function parseAnthropicRefusalFallback(value: unknown): boolean {
  return parseAnthropicSwitch(value, 'ANTHROPIC_REFUSAL_FALLBACK');
}

/**
 * Guarded Claude client for callers that build their own Responses requests (meal chat, WBT): ANTHROPIC_API_KEY,
 * ANTHROPIC_PRICING_*, ANTHROPIC_EFFORT, ANTHROPIC_REFUSAL_FALLBACK and the shared experiment limit and ledger
 * (AI_EXPERIMENT_*). Missing or invalid values throw; there are no defaults. `pricingPrefix` prices another model of the
 * same key (ANTHROPIC_LIGHT_PRICING for the knowledge search helpers).
 */
export function createGuardedAnthropicClientFromEnv(env: NodeJS.ProcessEnv, onCallSettled?: (call: SettledAiCall) => void, pricingPrefix = 'ANTHROPIC_PRICING'): OpenAiResponsesTransport {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for AI_PROVIDER=anthropic');
  const { pricing, costGuard, budgetLedger } = resolveOpenAiCostGuardFromEnv(env, pricingPrefix);
  return createGuardedOpenAiClient({
    transport: createAnthropicResponsesTransport({
      apiKey,
      effort: parseAnthropicEffort(env.ANTHROPIC_EFFORT),
      refusalFallback: parseAnthropicRefusalFallback(env.ANTHROPIC_REFUSAL_FALLBACK),
      answerTool: parseAnthropicSwitch(env.ANTHROPIC_ANSWER_TOOL, 'ANTHROPIC_ANSWER_TOOL'),
      parallelTools: parseAnthropicSwitch(env.ANTHROPIC_PARALLEL_TOOLS, 'ANTHROPIC_PARALLEL_TOOLS'),
    }),
    pricing,
    costGuard,
    ledger: budgetLedger,
    provider_label: 'anthropic',
    on_call_settled: onCallSettled,
    fallback_pricing: env.ANTHROPIC_FALLBACK_PRICING_INPUT_PER_1K_TOKENS ? resolveOpenAiPricingFromEnv(env, 'ANTHROPIC_FALLBACK_PRICING') : null,
  });
}

export function createAnthropicResponsesTransportWith(config: AnthropicResponsesTransportConfig): OpenAiResponsesTransport {
  const now = config.now ?? Date.now;
  const chains = new Map<string, Chain>();

  const findChain = (id: unknown): Chain | null => {
    if (typeof id !== 'string' || !id) return null;
    const chain = chains.get(id);
    if (!chain || now() - chain.storedAt > CHAIN_TTL_MS) {
      chains.delete(id);
      // Retryable (no status): the job is retried from the start, which needs no chain.
      throw Object.assign(new Error('Claude conversation chain not found (expired or the worker restarted)'), { code: 'ANTHROPIC_CHAIN_NOT_FOUND' });
    }
    return chain;
  };

  const remember = (id: string, chain: Omit<Chain, 'storedAt'>) => {
    for (const [key, value] of chains) {
      if (now() - value.storedAt > CHAIN_TTL_MS) chains.delete(key);
    }
    chains.set(id, { ...chain, storedAt: now() });
    while (chains.size > CHAIN_CAPACITY) chains.delete(chains.keys().next().value as string);
  };

  const assertComplete = (message: Record<string, unknown>) => {
    if (message.stop_reason === 'refusal') {
      const details = message.stop_details as { category?: unknown } | null | undefined;
      const category = typeof details?.category === 'string' ? details.category : 'unknown';
      // 400: the same request would be declined again, so neither the guard nor the job retries it.
      throw Object.assign(new Error(`Claude declined the request (${category})`), { status: 400, code: 'ANTHROPIC_REFUSAL', name: 'AnthropicRefusal' });
    }
    if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
      // A cut-off answer or tool input is parsed into valid but shortened JSON (items or cards silently missing), so it
      // is never used. Retryable (no status): the job runs again from the start.
      throw Object.assign(new Error(`Claude output was cut off (${String(message.stop_reason)})`), { code: 'ANTHROPIC_OUTPUT_TRUNCATED' });
    }
  };

  /** The answer-as-JSON turn for an answer-mode message that ended in prose; null: the message is fine as it is. */
  const answerAsJsonParams = (body: Record<string, unknown>, built: BuiltRequest, message: Record<string, unknown>): Record<string, unknown> | null => {
    assertComplete(message);
    const content = echoableContent(Array.isArray(message.content) ? message.content as Block[] : []);
    if (!built.answerMode || body.tool_choice === 'none' || content.some((block) => block.type === 'tool_use') || isJsonObjectText(content)) return null;
    // Prose instead of deliver_answer (seen on prod 2026-10-28 for whole time-range questions, every retry alike): the
    // answer is asked for again as structured output instead of failing the job.
    // Appended, never edited: the thinking blocks of the prose turn stay valid. No cache write: nothing reads it back.
    const { cache_control: _cache, ...params } = built.params;
    return {
      ...params,
      messages: [...built.messages, { role: 'assistant', content }, { role: 'user', content: [{ type: 'text', text: ANSWER_AS_JSON_INSTRUCTION }] }],
      tool_choice: { type: 'none' },
      output_config: { ...(built.params.output_config as Record<string, unknown> | undefined), format: { type: 'json_schema', schema: built.schema } },
    };
  };

  const finish = (body: Record<string, unknown>, built: BuiltRequest, message: Record<string, unknown>): Record<string, unknown> => {
    assertComplete(message);
    const content = echoableContent(Array.isArray(message.content) ? message.content as Block[] : []);
    const response = toResponsesShape(message, content);
    // A turn that only delivered the answer is not continued.
    if (content.some((block) => block.type === 'tool_use' && block.name !== ANSWER_TOOL_NAME) && typeof response.id === 'string') {
      // The continuation holds the whole conversation, so the chain it continued is not needed any more.
      if (typeof body.previous_response_id === 'string') chains.delete(body.previous_response_id);
      remember(response.id, {
        system: built.system,
        systemTexts: built.systemTexts,
        firstUserKey: built.firstUserKey,
        messages: [...built.messages, { role: 'assistant', content }],
      });
    }
    return response;
  };

  return {
    responses: {
      create: async (body, options = {}) => {
        const built = buildRequest(body, findChain(body.previous_response_id), config);
        const requestOptions = sdkOptions(options);
        if (body.stream === true) {
          const stream = config.messages.stream(built.params, requestOptions);
          return (async function* events() {
            let current = stream;
            let currentBuilt = built;
            // Answer mode: the answer tool's input is the output text (text blocks are notes then); otherwise text.
            let earlier: Record<string, unknown> | null = null;
            for (;;) {
              let answerBlock: number | null = null;
              for await (const event of current) {
                const record = event as { type?: unknown; index?: unknown; content_block?: { type?: unknown; name?: unknown }; delta?: { type?: unknown; text?: unknown; partial_json?: unknown } };
                if (record.type === 'content_block_start' && record.content_block?.type === 'tool_use' && record.content_block.name === ANSWER_TOOL_NAME && typeof record.index === 'number') {
                  answerBlock = record.index;
                }
                if (record.type !== 'content_block_delta') continue;
                if (currentBuilt.answerMode && record.index === answerBlock && record.delta?.type === 'input_json_delta' && typeof record.delta.partial_json === 'string' && record.delta.partial_json) {
                  yield { type: 'response.output_text.delta', delta: record.delta.partial_json };
                } else if (!currentBuilt.answerMode && record.delta?.type === 'text_delta' && typeof record.delta.text === 'string' && record.delta.text) {
                  yield { type: 'response.output_text.delta', delta: record.delta.text };
                }
              }
              const final = await current.finalMessage() as Record<string, unknown>;
              const retry = earlier ? null : answerAsJsonParams(body, currentBuilt, final);
              if (!retry) {
                yield { type: 'response.completed', response: withEarlierUsage(finish(body, currentBuilt, final), earlier) };
                return;
              }
              earlier = final;
              currentBuilt = { ...built, answerMode: false };
              current = config.messages.stream(retry, requestOptions);
            }
          })() as unknown as Record<string, unknown>;
        }
        const first = await config.messages.create(built.params, requestOptions) as Record<string, unknown>;
        const retry = answerAsJsonParams(body, built, first);
        if (!retry) return finish(body, built, first);
        const second = await config.messages.create(retry, requestOptions) as Record<string, unknown>;
        return withEarlierUsage(finish(body, { ...built, answerMode: false }, second), first);
      },
      inputTokens: {
        count: async (body, options = {}) => {
          const { params } = buildRequest(body, findChain(body.previous_response_id), config);
          const { max_tokens: _maxTokens, betas: _betas, fallbacks: _fallbacks, ...countParams } = params;
          const counted = await config.messages.countTokens(countParams, sdkOptions(options)) as { input_tokens?: unknown };
          return typeof counted.input_tokens === 'number'
            ? { input_tokens: Math.ceil(counted.input_tokens * COUNT_MARGIN_FACTOR) + COUNT_MARGIN_TOKENS }
            : {};
        },
      },
    },
  };
}

/** Only the request options the SDK knows (the guarded client already removed its own). */
function sdkOptions(options: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof options.timeout === 'number' ? { timeout: options.timeout } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    maxRetries: 0,
  };
}

interface BuiltRequest {
  params: Record<string, unknown>;
  /** The answer is the deliver_answer tool's input (tools and an output schema in the request). */
  answerMode: boolean;
  /** The output schema in Claude's subset; null without one. */
  schema: unknown;
  system: Block[];
  systemTexts: string[];
  firstUserKey: string;
  messages: Message[];
}

export function buildRequest(body: Record<string, unknown>, chain: Chain | null, config: Pick<AnthropicResponsesTransportConfig, 'effort' | 'refusalFallback' | 'parallelTools' | 'answerTool'>): BuiltRequest {
  const model = typeof body.model === 'string' ? body.model : '';
  const items = typeof body.input === 'string'
    ? [{ role: 'user', content: body.input }]
    : Array.isArray(body.input) ? body.input as Array<Record<string, unknown>> : [];

  const systemTexts: string[] = typeof body.instructions === 'string' && body.instructions.trim() ? [body.instructions] : [];
  const turns: Message[] = [];
  const toolOutputs = new Map<string, string>();
  for (const item of items) {
    if (item.type === 'function_call_output') {
      if (typeof item.call_id === 'string') toolOutputs.set(item.call_id, typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? null));
      continue;
    }
    if (item.role === 'system' || item.role === 'developer') {
      const text = textOf(item.content);
      if (text) systemTexts.push(text);
      continue;
    }
    if (item.role === 'user' || item.role === 'assistant') {
      const blocks = item.role === 'user' ? userBlocks(item.content) : textBlocks(item.content);
      if (blocks.length > 0) turns.push({ role: item.role, content: blocks });
    }
  }

  const format = (body.text as { format?: Record<string, unknown> } | undefined)?.format;
  const schema = format?.type === 'json_schema' && format.schema ? toClaudeSchema(format.schema) : null;
  const callerTools = (Array.isArray(body.tools) ? body.tools as Array<Record<string, unknown>> : [])
    .filter((tool) => tool.type === undefined || tool.type === 'function');
  const answerMode = schema !== null && callerTools.length > 0 && config.answerTool !== false;

  let system: Block[];
  let messages: Message[];
  let firstUserKey: string;
  if (chain) {
    system = chain.system;
    firstUserKey = chain.firstUserKey;
    messages = [...chain.messages];
    // Text that only repeats the chain's system prompt is dropped; text added after it is new.
    const added = systemTexts
      .map((text) => {
        const repeated = chain.systemTexts.find((stored) => text === stored || text.startsWith(stored));
        return repeated === undefined ? text : text.slice(repeated.length).trim();
      })
      .filter((text) => text.length > 0);
    const newTurns = turns.filter((turn) => !(turn.role === 'user' && JSON.stringify(turn.content) === chain.firstUserKey));
    const last = messages[messages.length - 1];
    const pending = last?.role === 'assistant' && Array.isArray(last.content)
      ? last.content.filter((block) => block.type === 'tool_use').map((block) => String(block.id))
      : [];
    const answerIds = new Set(Array.isArray(last?.content)
      ? last.content.filter((block) => block.type === 'tool_use' && block.name === ANSWER_TOOL_NAME).map((block) => String(block.id))
      : []);
    const results: Block[] = pending.map((id) => {
      // An answer called next to other tools was not delivered (the caller only ran the others).
      if (answerIds.has(id)) return { type: 'tool_result', tool_use_id: id, content: body.tool_choice === 'none' ? ANSWER_NOT_DELIVERED_FINAL : ANSWER_NOT_DELIVERED };
      const output = toolOutputs.get(id);
      if (output === undefined) {
        throw Object.assign(new Error(`Claude tool call ${id} has no output`), { status: 400, code: 'ANTHROPIC_TOOL_OUTPUT_MISSING' });
      }
      return { type: 'tool_result', tool_use_id: id, content: output };
    });
    // Tool results must open the user message that follows the calls; any new user text goes after them.
    const extraUser = newTurns.filter((turn) => turn.role === 'user').flatMap((turn) => turn.content as Block[]);
    if (results.length > 0 || extraUser.length > 0) messages.push({ role: 'user', content: [...results, ...extraUser] });
    for (const turn of newTurns.filter((entry) => entry.role === 'assistant')) messages.push(turn);
    for (const text of added) messages.push({ role: 'system', content: text });
  } else {
    if (toolOutputs.size > 0) {
      throw Object.assign(new Error('Claude tool outputs need the response that asked for them (previous_response_id)'), { status: 400, code: 'ANTHROPIC_TOOL_OUTPUT_WITHOUT_CHAIN' });
    }
    const hasTools = callerTools.length > 0;
    const texts = [
      ...systemTexts,
      ...(hasTools && config.parallelTools !== false ? [PARALLEL_TOOLS_INSTRUCTION] : []),
      ...(answerMode ? [ANSWER_TOOL_INSTRUCTION] : []),
    ];
    system = texts.map((text, index) => ({
      type: 'text',
      text,
      // One breakpoint at the end of the system prompt: it is the same for every request of a task.
      ...(index === texts.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
    }));
    messages = turns;
    const firstUser = turns.find((turn) => turn.role === 'user');
    firstUserKey = firstUser ? JSON.stringify(firstUser.content) : '';
  }

  const tools: Block[] = callerTools
    .map((tool) => ({
      name: tool.name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      input_schema: toClaudeSchema(tool.parameters ?? { type: 'object', properties: {} }),
      // Not strict: strict tools compile into one grammar that allows few nullable/union parameters (the conversation's
      // tools have 32, refused at generation). Every tool validates its own arguments and answers INVALID otherwise.
    }));
  if (answerMode) {
    // Strict (the only strict tool: few unions) and streamed as it is written.
    tools.push({ name: ANSWER_TOOL_NAME, description: 'Delivers the final answer to the caregiver. Its input is the whole answer.', input_schema: schema, strict: true, eager_input_streaming: true });
  }
  const toolChoice = tools.length === 0
    ? undefined
    : body.tool_choice === 'none'
      ? { type: 'none' }
      // One call per turn only when parallel tools are off: each turn re-reads the whole conversation, so independent
      // calls in one turn answer sooner (the gateway runs every call of a turn).
      : body.parallel_tool_calls === false && config.parallelTools === false ? { type: 'auto', disable_parallel_tool_use: true } : undefined;

  const toolRoundMayFollow = tools.some((tool) => tool.name !== ANSWER_TOOL_NAME) && body.tool_choice !== 'none';
  // With tool_choice none (the gateway's final turn) the answer tool cannot be called: that turn answers as text.
  const textAnswer = schema !== null && (!answerMode || body.tool_choice === 'none');
  const outputConfig = {
    ...(textAnswer ? { format: { type: 'json_schema', schema } } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
  };
  const fallback = config.refusalFallback !== false && FALLBACK_MODELS.includes(model);

  return {
    params: {
      model,
      max_tokens: typeof body.max_output_tokens === 'number' ? body.max_output_tokens : DEFAULT_MAX_TOKENS,
      ...(system.length > 0 ? { system } : {}),
      messages,
      // Automatic breakpoint at the end of the conversation: the next round of a tool loop reads it from the cache. Only
      // when a next round can follow (tools other than the answer, not the final turn): a write costs 1.25x the input
      // price and a one-shot call (WBT, a tool-less reply, the final round) never reads it back.
      ...(toolRoundMayFollow ? { cache_control: { type: 'ephemeral' } } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
      ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
    },
    answerMode,
    schema,
    system,
    systemTexts: chain ? chain.systemTexts : systemTexts,
    firstUserKey,
    messages,
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && typeof (part as Block).text === 'string' ? String((part as Block).text) : ''))
    .filter(Boolean)
    .join('\n');
}

function textBlocks(content: unknown): Block[] {
  const text = textOf(content);
  return text ? [{ type: 'text', text }] : [];
}

function userBlocks(content: unknown): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const part of content as Block[]) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string' && part.text && ['input_text', 'output_text', 'text'].includes(String(part.type))) {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'input_image' && typeof part.image_url === 'string') {
      const inline = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(part.image_url);
      blocks.push(inline
        ? { type: 'image', source: { type: 'base64', media_type: inline[1].toLowerCase(), data: inline[2] } }
        : { type: 'image', source: { type: 'url', url: part.image_url } });
    }
  }
  return blocks;
}

/** Keywords structured outputs and strict tools refuse; the gateway validates the values itself after the call. */
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
  'patternProperties',
]);
const SUPPORTED_STRING_FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);

/**
 * A JSON schema in the subset Claude's structured outputs accept: unsupported keywords removed, every object closed
 * (additionalProperties: false) and `type: [X, "null"]` written as anyOf.
 */
export function toClaudeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toClaudeSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const node: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) continue;
    if (key === 'format' && !(typeof value === 'string' && SUPPORTED_STRING_FORMATS.has(value))) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      node.properties = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, entry]) => [name, toClaudeSchema(entry)]));
    } else if (['items', 'anyOf', 'allOf', 'oneOf', '$defs', 'definitions'].includes(key)) {
      node[key === 'oneOf' ? 'anyOf' : key] = key === '$defs' || key === 'definitions'
        ? Object.fromEntries(Object.entries((value ?? {}) as Record<string, unknown>).map(([name, entry]) => [name, toClaudeSchema(entry)]))
        : toClaudeSchema(value);
    } else {
      node[key] = value;
    }
  }
  if (node.type === 'object' || node.properties) {
    node.additionalProperties = false;
  }
  if (Array.isArray(node.type)) {
    const { type, description, ...rest } = node;
    // An enum listing null (allowed with type [X, "null"]) keeps only the values of each branch's own type.
    const values = Array.isArray(rest.enum) ? rest.enum as unknown[] : null;
    return {
      ...(description !== undefined ? { description } : {}),
      anyOf: (type as unknown[]).map((entry) => {
        if (entry === 'null') return { type: 'null' };
        const branch = { ...rest, type: entry, ...(values ? { enum: values.filter((value) => value !== null) } : {}) };
        return toClaudeSchema(branch);
      }),
    };
  }
  return node;
}

/**
 * The assistant content as it is sent back on the next round. After a mid-output refusal fallback the declined model's
 * thinking and tool calls before the last `fallback` block are not part of the conversation and are left out.
 */
function echoableContent(content: Block[]): Block[] {
  const boundary = content.map((block) => block.type).lastIndexOf('fallback');
  if (boundary < 0) return content;
  return content.filter((block, index) => index > boundary || !['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use', 'fallback'].includes(String(block.type)));
}

/** The model a refusal fallback served the answer with (usage.iterations' fallback_message entry); null: none. */
export function fallbackModelOf(message: Record<string, unknown>): string | null {
  const iterations = (message.usage as { iterations?: unknown } | null | undefined)?.iterations;
  if (!Array.isArray(iterations)) return null;
  const served = iterations.find((entry) => (entry as { type?: unknown } | null)?.type === 'fallback_message') as { model?: unknown } | undefined;
  return served && typeof served.model === 'string' ? served.model : null;
}

/** The text blocks form one JSON object (an answer written as text but still in the schema's shape). */
function isJsonObjectText(content: Block[]): boolean {
  const text = content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => String(block.text)).join('').trim();
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function toResponsesShape(message: Record<string, unknown>, content: Block[]): Record<string, unknown> {
  const calls = content.filter((block) => block.type === 'tool_use' && block.name !== ANSWER_TOOL_NAME);
  const answer = content.filter((block) => block.type === 'tool_use' && block.name === ANSWER_TOOL_NAME).at(-1);
  // The answer tool's input is the answer, unless other tools were called in the same turn (it is asked again then).
  const text = answer && calls.length === 0
    ? JSON.stringify(answer.input ?? {})
    : content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => String(block.text)).join('');
  const output: Block[] = [];
  if (text) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  for (const block of calls) {
    output.push({ type: 'function_call', id: block.id, call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
  }
  return {
    id: message.id,
    object: 'response',
    model: message.model,
    status: 'completed',
    stop_reason: message.stop_reason ?? null,
    // A refusal fallback served this answer: the model that did (priced with ANTHROPIC_FALLBACK_PRICING_* when set).
    ...(fallbackModelOf(message) ? { fallback_model: fallbackModelOf(message) } : {}),
    output,
    output_text: text,
    usage: toResponsesUsage(message.usage),
  };
}

/** A response that took two calls (prose, then the answer as JSON) is priced with both. */
function withEarlierUsage(response: Record<string, unknown>, earlier: Record<string, unknown> | null): Record<string, unknown> {
  if (!earlier) return response;
  const a = toResponsesUsage(earlier.usage) as Record<string, any> | null;
  const b = response.usage as Record<string, any> | null;
  if (!a || !b) return response;
  const input = a.input_tokens + b.input_tokens;
  const output = a.output_tokens + b.output_tokens;
  return {
    ...response,
    usage: {
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
      input_tokens_details: {
        cached_tokens: a.input_tokens_details.cached_tokens + b.input_tokens_details.cached_tokens,
        cache_write_tokens: a.input_tokens_details.cache_write_tokens + b.input_tokens_details.cache_write_tokens,
      },
      output_tokens_details: { reasoning_tokens: a.output_tokens_details.reasoning_tokens + b.output_tokens_details.reasoning_tokens },
    },
  };
}

/** Messages usage in the Responses shape the guard prices: input = uncached + cache writes + cache reads. */
export function toResponsesUsage(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const usage = raw as Record<string, unknown>;
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
  if (typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null;
  // A refusal fallback (usage.iterations has a fallback_message entry) bills every attempt, also the declined one:
  // each count is at least the sum of the attempts, so the ledger and the cost guard never count less than was billed.
  const iterations = Array.isArray(usage.iterations) ? usage.iterations as Array<Record<string, unknown>> : [];
  const billed = iterations.some((entry) => entry?.type === 'fallback_message')
    ? iterations.filter((entry) => entry?.type === 'message' || entry?.type === 'fallback_message')
    : [];
  const atLeastAttempts = (key: string) => Math.max(count(usage[key]), billed.reduce((sum, entry) => sum + count(entry[key]), 0));
  const cacheRead = atLeastAttempts('cache_read_input_tokens');
  const cacheWrite = atLeastAttempts('cache_creation_input_tokens');
  const input = atLeastAttempts('input_tokens') + cacheRead + cacheWrite;
  const output = atLeastAttempts('output_tokens');
  const thinking = (usage.output_tokens_details as { thinking_tokens?: unknown } | null | undefined)?.thinking_tokens;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite },
    output_tokens_details: { reasoning_tokens: Math.min(count(thinking), output) },
  };
}
