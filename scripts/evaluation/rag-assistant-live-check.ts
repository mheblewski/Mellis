/**
 * RAG stage 3 live check: knowledge-base and anomaly questions through the real conversation path, before the deploy.
 * Each question is routed like the API does (a direct reply for general questions, otherwise a time-range analysis)
 * and answered by the real worker job, the real AI gateway (tool loop with the evidence tools and search_knowledge)
 * and the real OpenAI provider (main and light model). Two things are local stand-ins:
 *   - patient data: the synthetic 3-day scenario (a correction followed by a hypo, a CGM gap), so no real patient data
 *     is sent; the time-range questions are answered over it;
 *   - the knowledge store: the index file (--index) searched in memory with the prototype's hybrid retrieval (exact
 *     cosine per query vector + BM25, fused by RRF); production searches the same chunks in Postgres (BM25 in SQL over
 *     the English full-text index: stemming differs slightly). Rewrite, embeddings and rerank are the real guarded light-model and embeddings calls.
 * Every paid call goes through the guarded clients with the budget ledger named by AI_EXPERIMENT_BUDGET_LEDGER_PATH
 * (use a separate experiment ledger). Without --live it only prints the plan.
 *
 *   tsx scripts/evaluation/rag-assistant-live-check.ts --output-dir <dir> --index <rag-index.json> [--only Q05,A1] [--live]
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { WorkerService } from '../../apps/worker/src/worker.service';
import { AiGatewayService } from '@modules/ai-gateway/application/ai-gateway.service';
import { AiProviderError } from '@modules/ai-gateway/infrastructure/ai-provider.error';
import {
  createGuardedOpenAiClientFromEnv,
  createGuardedOpenAiEmbeddingsClientFromEnv,
  resolveOpenAiCostGuardFromEnv,
  resolveOpenAiPricingFromEnv,
} from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { OpenAiProvider } from '@modules/ai-gateway/infrastructure/openai-provider';
import { TieredAiProvider } from '@modules/ai-gateway/infrastructure/tiered-ai-provider';
import type { AiProvider } from '@modules/ai-gateway/domain/ai-gateway';
import { parseOpenAiReasoningEffort } from '@infra/config/environment';
import { determineUserMessageCapability, isPatientDataQuestion } from '@modules/context/application/investigation-policy';
import { buildTimeRangeSyntheticScenario, type TimeRangeSyntheticScenario } from '@modules/context/application/time-range-synthetic-scenario.fixture';
import { KnowledgeSearchService, type KnowledgeChunkStore } from '@modules/knowledge/application/knowledge-search';
import { lightPricingEnv } from '@modules/knowledge/infrastructure/knowledge-services.factory';
import type { RagSearchHit, RagSearchQuery } from '@infra/db/postgres-rag-chunks.repository';
import { indexFileSha256 } from '@infra/db/postgres-rag-chunks.repository';
import { describeErrorSafely, resolveEvaluationOutputDir, writeEvaluationOutputDirFile } from './evaluation-output-dir';
import { RagIndexError, parseIndex, retrieveHybrid, type LoadedIndex } from './rag-retrieval';
import questionSet from './rag-knowledge-probe.questions.json';

export class LiveCheckArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveCheckArgumentError';
  }
}

/** ~10 probe questions over the topics the owner named (illness, exercise, WBT, devices) plus the probe's anomalies. */
export const DEFAULT_PROBE_IDS = ['Q05', 'Q06', 'Q07', 'Q09', 'Q10', 'Q14', 'Q16', 'Q20', 'Q26', 'Q27'] as const;

/** Anomaly questions about the synthetic scenario's own data: they need the data and the knowledge together. */
export const ANOMALY_QUESTIONS = [
  { id: 'A1', question: 'Nie rozumiem, co się stało wczoraj przed południem: po korekcie cukier szybko spadł poniżej 70, a potem wrócił. To była prawdziwa hipoglikemia czy błąd sensora? Co mówią wytyczne o leczeniu takiego spadku przy pętli?' },
  { id: 'A2', question: 'Wczoraj po południu przez ponad godzinę nie było odczytów z Dexcoma. Dlaczego tak się dzieje i co to zmienia w działaniu pętli Trio?' },
] as const;

export interface LiveCheckQuestion {
  id: string;
  question: string;
}

export interface LiveCheckArgs {
  index: string;
  only: Set<string> | null;
  live: boolean;
}

const VALUE_FLAGS = new Set(['--output-dir', '--index', '--only']);

export function parseLiveCheckArgs(argv: readonly string[]): LiveCheckArgs {
  const args: LiveCheckArgs = { index: '', only: null, live: false };
  for (let position = 0; position < argv.length; position += 1) {
    const flag = argv[position];
    if (flag === '--live') {
      args.live = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new LiveCheckArgumentError(`Unknown argument ${flag}.`);
    const value = argv[position + 1];
    if (value === undefined) throw new LiveCheckArgumentError(`${flag} needs a value.`);
    position += 1;
    if (flag === '--index') args.index = value;
    if (flag === '--only') args.only = new Set(value.split(',').map((id) => id.trim()).filter(Boolean));
  }
  if (!args.index) throw new LiveCheckArgumentError('--index <rag-index.json> is required.');
  return args;
}

export function selectedQuestions(only: Set<string> | null): LiveCheckQuestion[] {
  const probe = questionSet.questions.filter((question) => (DEFAULT_PROBE_IDS as readonly string[]).includes(question.id) || only?.has(question.id));
  const all: LiveCheckQuestion[] = [...probe.map(({ id, question }) => ({ id, question })), ...ANOMALY_QUESTIONS];
  return only ? all.filter((question) => only.has(question.id)) : all;
}

/** The API's routing of a first message in a conversation: a direct reply only for general, non-data questions. */
export function routeOf(text: string): 'DIRECT_RESPONSE' | 'TIME_RANGE_ANALYSIS' {
  return determineUserMessageCapability(text) === 'DIRECT_RESPONSE' && !isPatientDataQuestion(text) ? 'DIRECT_RESPONSE' : 'TIME_RANGE_ANALYSIS';
}

/** The index file searched in memory like rag_chunks (cosine per vector + BM25 instead of Postgres full-text, RRF). */
export class InMemoryIndexStore implements KnowledgeChunkStore {
  constructor(private readonly index: LoadedIndex, private readonly version: string) {}

  async activeVersion() {
    return { version: this.version, embeddingModel: this.index.file.embedding_model, chunkCount: this.index.file.chunks.length };
  }

  async search(query: RagSearchQuery): Promise<RagSearchHit[]> {
    return retrieveHybrid(this.index, {
      vectors: query.vectors.map(({ name, embedding }) => ({ name, vector: embedding })),
      lexical: query.keywords ?? null,
      candidates: query.candidates,
      k: query.k,
    }).map((hit) => {
      const { tokens_estimate: _tokens, ...chunk } = hit.chunk;
      return { rank: hit.rank, score: hit.score, ranks: hit.ranks ?? {}, cosine: null, chunk: { ...chunk, corpus_version: this.version } };
    });
  }
}

const CONVERSATION_ID = 'live-check-conversation';
const USER_MESSAGE_ID = 'live-check-user-message';

/** The synthetic scenario served with the SQL's filtering and limits (as in the worker's offline scenario tests). */
function scenarioRepository(scenario: TimeRangeSyntheticScenario, captured: Record<string, unknown>) {
  const inRange = (iso: string, start: string, end: string) => Date.parse(iso) >= Date.parse(start) && Date.parse(iso) <= Date.parse(end);
  const userMessage = { id: USER_MESSAGE_ID, role: 'USER', message_type: 'USER_MESSAGE', content: scenario.user_message, created_at: scenario.requested_at, provenance_ref: `conv/${CONVERSATION_ID}/messages/live-check` };
  return {
    getConversation: async () => ({ id: CONVERSATION_ID, patient_id: scenario.patient_id, thread_state_version: 'conv-v1', awaiting_user_answer: false, messages: [userMessage] }),
    getMessageByIdempotencyKey: async () => null,
    getMessageById: async () => userMessage,
    getCurrentStateAtOrBefore: async () => null,
    getCurrentState: async () => null,
    listRecentConversationEventFacts: async () => [],
    listPatientEventsByRange: async (args: { patientId: string; startAtIso: string; endAtIso: string; limit: number }) => scenario.events
      .filter((event) => event.patient_id === args.patientId && inRange(event.occurred_at, args.startAtIso, args.endAtIso))
      .slice(0, Math.max(1, Math.min(5000, Math.floor(args.limit)))),
    listHypoEpisodesIntersectingRange: async (args: { patientId: string; startAtIso: string; endAtIso: string; limit: number }) => scenario.hypo_episodes
      .filter((episode) => episode.patient_id === args.patientId && Date.parse(episode.started_at) <= Date.parse(args.endAtIso) && Date.parse(episode.ended_at) >= Date.parse(args.startAtIso))
      .slice(0, Math.max(1, Math.min(200, Math.floor(args.limit)))),
    listPatientContextFactsByRecordedRange: async () => [],
    insertContextPackage: async () => ({ id: 'live-check-package' }),
    getAiExecutionByTaskIdentity: async () => null,
    markAiExecutionRunning: async () => undefined,
    markAiExecutionSucceeded: async (args: { result: Record<string, unknown> }) => { captured.execution = args.result; },
    markAiExecutionFailed: async () => undefined,
    createAiExecutionAttempt: async () => ({ id: 'live-check-attempt', attempt_number: 1 }),
    updateAiExecutionAttempt: async (args: Record<string, unknown>) => { captured.attempt = args; },
    insertAnalysis: async () => ({ id: 'live-check-analysis', status: 'INSUFFICIENT_DATA', facts: [], unknowns: [], calculations: [], hypotheses: [], uncertainty: {}, question: null, proposal: null, rationale: '' }),
    linkAiExecutionToAnalysis: async () => undefined,
    getAnalysis: async () => ({ id: 'live-check-analysis', status: 'INSUFFICIENT_DATA', facts: [], unknowns: [], calculations: [], hypotheses: [], uncertainty: {}, question: null, proposal: null, rationale: '' }),
    insertRecommendation: async (args: Record<string, unknown>) => ({ id: 'live-check-recommendation', analysis_id: String(args.analysisId ?? ''), status: 'INSUFFICIENT_DATA', proposal: {}, evidence: [], provenance: {} }),
    linkConversation: async () => undefined,
    insertMessage: async (args: Record<string, unknown>) => { captured.message = args; return { id: 'live-check-assistant-message' }; },
    finalizeJobSuccess: async () => undefined,
  };
}

interface QuestionResult {
  id: string;
  question: string;
  route: string;
  answer: string | null;
  sources: unknown;
  knowledge_calls: unknown;
  tool_sequence: string[];
  model: string | null;
  attempt_cost: number | null;
  knowledge_cost: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number;
  error: string | null;
  retried_after?: string;
}

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new LiveCheckArgumentError(`${key} is required for --live.`);
  return value;
}

function buildGateway(index: LoadedIndex, version: string): AiGatewayService {
  const env = process.env;
  const apiKey = requireEnv('OPENAI_API_KEY');
  const timeoutMs = Number(env.OPENAI_TIMEOUT_MS ?? 90_000);
  const reasoningEffort = env.OPENAI_REASONING_EFFORT ? parseOpenAiReasoningEffort(env.OPENAI_REASONING_EFFORT) ?? null : null;
  const provider = (pricingEnv: NodeJS.ProcessEnv, model: string) => {
    const guard = resolveOpenAiCostGuardFromEnv(pricingEnv);
    return new OpenAiProvider({ apiKey, model, timeoutMs, reasoningEffort, pricing: guard.pricing, costGuard: guard.costGuard, budgetLedger: guard.budgetLedger });
  };
  const lightModel = requireEnv('OPENAI_LIGHT_MODEL');
  const light = lightPricingEnv(env) as NodeJS.ProcessEnv;
  const search = new KnowledgeSearchService({
    store: new InMemoryIndexStore(index, version),
    lightClient: createGuardedOpenAiClientFromEnv(light, apiKey),
    embeddingsClient: createGuardedOpenAiEmbeddingsClientFromEnv(env, apiKey),
    lightModel,
    pricing: {
      currency: requireEnv('OPENAI_PRICING_CURRENCY'),
      light: resolveOpenAiPricingFromEnv(light),
      embedding_input_per_1k_tokens: Number(env.OPENAI_EMBEDDING_PRICING_INPUT_PER_1K_TOKENS),
    },
    logger: { warn: (message) => console.warn(message) },
  });
  const tiered = new TieredAiProvider(provider(env, requireEnv('OPENAI_MODEL')), provider(light, lightModel));
  // Failed provider calls are logged with their metadata only (status, stage, error class; never the message).
  const logged: AiProvider = {
    generate: async (input) => {
      try {
        return await tiered.generate(input);
      } catch (error) {
        const details = error as AiProviderError;
        console.warn(JSON.stringify({ event: 'provider_call_failed', tier: input.model_tier ?? 'DEEP', name: details?.name ?? null, http_status: details?.httpStatus ?? null, stage: details?.stage ?? null, error_name: details?.errorName ?? null, error_type: details?.errorType ?? null, code: (details as { code?: unknown })?.code ?? null, debug_message: process.env.LIVE_CHECK_DEBUG ? String(details?.message).slice(0, 300) : undefined }));
        throw error;
      }
    },
  };
  return new AiGatewayService(logged, { search, protocol_card: null });
}

async function runQuestion(gateway: AiGatewayService, question: LiveCheckQuestion): Promise<QuestionResult> {
  const route = routeOf(question.question);
  const scenario = { ...buildTimeRangeSyntheticScenario(), user_message: question.question };
  const captured: Record<string, any> = {};
  const repository = scenarioRepository(scenario, captured);
  const config = { get: (key: string) => process.env[key], getOrThrow: (key: string) => process.env[key] };
  const worker = new WorkerService(repository as any, {} as any, config as any, gateway, {} as any);
  const startedAt = Date.now();
  let error: string | null = null;
  try {
    if (route === 'DIRECT_RESPONSE') {
      await (worker as any).handleConversationDirectResponse(`live-check-${question.id}`, 'lease', { patient_id: scenario.patient_id, conversation_id: CONVERSATION_ID, user_message_id: USER_MESSAGE_ID });
    } else {
      await (worker as any).handleConversationTimeRangeAnalysis(`live-check-${question.id}`, 'lease', {
        patient_id: scenario.patient_id,
        conversation_id: CONVERSATION_ID,
        user_message_id: USER_MESSAGE_ID,
        range_type: scenario.range_type,
        range_start: scenario.range_start,
        range_end: scenario.range_end,
        timezone: scenario.timezone,
        normalization_policy_version: scenario.normalization_policy_version,
      });
    }
  } catch (caught) {
    // Codes only (never the message, which may echo request content).
    const details = caught as { code?: unknown; details?: { provider_code?: unknown } } | null;
    const codes = [details?.code, details?.details?.provider_code].filter((value): value is string => typeof value === 'string');
    error = `${describeErrorSafely(caught, [AiProviderError, LiveCheckArgumentError])}${codes.length ? ` [${codes.join(', ')}]` : ''}`;
  }
  const metadata = captured.execution?.metadata ?? {};
  return {
    id: question.id,
    question: question.question,
    route,
    answer: typeof captured.message?.content === 'string' ? captured.message.content : null,
    sources: captured.message?.metadata?.knowledge_sources ?? [],
    knowledge_calls: (metadata.knowledge_search?.calls ?? []).map((call: Record<string, any>) => ({
      query: call.query,
      status: call.status,
      english_query: call.diagnostics?.english_query ?? null,
      rerank: call.diagnostics?.rerank_status ?? null,
      latency_ms: call.diagnostics?.latency_ms ?? null,
      cost: call.diagnostics?.estimated_cost?.amount ?? null,
      chunk_ids: call.chunk_ids,
    })),
    tool_sequence: (metadata.evidence_tool_calls ?? []).map((call: { tool_name: string }) => call.tool_name),
    model: metadata.model ?? null,
    attempt_cost: captured.attempt?.estimatedCost?.estimated_cost ?? null,
    knowledge_cost: metadata.knowledge_search?.estimated_cost?.amount ?? null,
    input_tokens: captured.attempt?.usage?.input_tokens ?? null,
    output_tokens: captured.attempt?.usage?.output_tokens ?? null,
    latency_ms: Date.now() - startedAt,
    error,
  };
}

export function renderLiveCheckMarkdown(meta: Record<string, unknown>, results: readonly QuestionResult[]): string {
  const lines = ['# RAG stage 3: live check through the conversation path', '', '```json', JSON.stringify(meta, null, 2), '```', ''];
  for (const result of results) {
    lines.push(`## ${result.id} · ${result.route} · ${result.model ?? '?'}`, '', `**Pytanie:** ${result.question}`, '');
    lines.push(`**Narzędzia:** ${result.tool_sequence.join(' → ') || '_brak_'} · koszt ${result.attempt_cost ?? '?'} USD (wiedza ${result.knowledge_cost ?? 0}) · ${result.input_tokens ?? '?'}/${result.output_tokens ?? '?'} tok. · ${Math.round(result.latency_ms / 100) / 10} s`, '');
    for (const call of result.knowledge_calls as Array<Record<string, unknown>>) {
      lines.push(`- search_knowledge: „${String(call.query)}” → ${String(call.status)} (EN: ${String(call.english_query)}; rerank ${String(call.rerank)}; ${String(call.latency_ms)} ms)`);
    }
    if (result.error) lines.push('', `**Błąd:** ${result.error}`);
    lines.push('', result.answer ?? '_brak odpowiedzi_', '');
    for (const source of result.sources as Array<Record<string, unknown>>) {
      lines.push(`- [${String(source.ref)}] ${String(source.title)}${source.section ? ` · ${String(source.section)}` : ''}${source.page ? ` · s. ${String(source.page)}` : ''}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const outputDir = resolveEvaluationOutputDir(argv);
  const args = parseLiveCheckArgs(argv);
  if (!existsSync(args.index)) throw new LiveCheckArgumentError('--index: file not found.');
  const raw = readFileSync(args.index, 'utf8');
  const index = parseIndex(raw);
  const version = `local-${indexFileSha256(raw).slice(0, 12)}`;
  const questions = selectedQuestions(args.only);
  console.log(`Index: ${index.file.chunks.length} chunks (${index.file.embedding_model}), ${version}. Questions: ${questions.length}.`);
  for (const question of questions) console.log(`  ${question.id}: ${routeOf(question.question)}`);
  if (!args.live) {
    console.log('Dry run: nothing sent. Add --live to answer the questions (paid, guarded, budget ledger from AI_EXPERIMENT_BUDGET_LEDGER_PATH).');
    return;
  }
  // The gateway's tool loop reads this flag; the knowledge tool comes with the gateway built here.
  process.env.AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING = '1';
  const gateway = buildGateway(index, version);
  const results: QuestionResult[] = [];
  for (const question of questions) {
    let result = await runQuestion(gateway, question);
    // The worker retries a retryable failure as a new job attempt; the check does the same once.
    if (result.error?.includes('AI_PROVIDER_RETRYABLE')) {
      console.log(`${question.id}: retryable failure (${result.error}), retrying once`);
      result = { ...(await runQuestion(gateway, question)), retried_after: result.error } as QuestionResult;
    }
    results.push(result);
    console.log(`${question.id}: ${result.error ? `failed (${result.error})` : `${result.tool_sequence.join(' → ') || 'no tools'}, ${result.attempt_cost ?? '?'} USD, ${Math.round(result.latency_ms / 1000)} s`}`);
    // A refused or failed paid call (budget, cost guard) stops the run; the report keeps what was answered.
    if (result.error) break;
  }
  const meta = {
    generated_at: new Date().toISOString(),
    corpus: version,
    index_chunks: index.file.chunks.length,
    questions: results.length,
    failed: results.filter((result) => result.error).length,
    total_attempt_cost: Math.round(results.reduce((sum, result) => sum + (result.attempt_cost ?? 0), 0) * 1e6) / 1e6,
    total_knowledge_cost: Math.round(results.reduce((sum, result) => sum + (result.knowledge_cost ?? 0), 0) * 1e6) / 1e6,
  };
  const stamp = meta.generated_at.replace(/[:.]/g, '-');
  writeEvaluationOutputDirFile(outputDir, `rag-assistant-live-check-${stamp}.json`, `${JSON.stringify({ ...meta, results }, null, 2)}\n`);
  writeEvaluationOutputDirFile(outputDir, `rag-assistant-live-check-${stamp}.md`, renderLiveCheckMarkdown(meta, results));
  console.log(`Report: rag-assistant-live-check-${stamp}.md (${meta.questions} questions, ${meta.total_attempt_cost} USD).`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(describeErrorSafely(error, [LiveCheckArgumentError, RagIndexError, AiProviderError]));
    process.exitCode = 1;
  });
}
