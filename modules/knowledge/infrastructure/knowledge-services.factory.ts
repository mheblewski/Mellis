/**
 * Builds the assistant's knowledge services from the worker environment:
 *   AI_ENABLE_KNOWLEDGE_SEARCH=1            offers the search_knowledge tool in conversations (default off);
 *   AI_ENABLE_KNOWLEDGE_PROTOCOL_CARD=1     adds the diabetologist-approved protocol card (default off) read from
 *     AI_KNOWLEDGE_PROTOCOL_CARD_PATH; a file still marked as a draft ("WERSJA ROBOCZA") is refused.
 * Two modes, picked by the keys present (ai-capabilities.ts) and logged once at startup (knowledge_search_enabled):
 *   - hybrid (an OPENAI_API_KEY, under either answer provider): OPENAI_LIGHT_MODEL with its OPENAI_LIGHT_PRICING_* prices
 *     (rewrite and rerank), OPENAI_EMBEDDING_PRICING_INPUT_PER_1K_TOKENS / _VERSION (query embeddings);
 *   - bm25 (AI_PROVIDER=anthropic, no OpenAI key): full text only, no embeddings call; rewrite and rerank on
 *     ANTHROPIC_LIGHT_MODEL with ANTHROPIC_LIGHT_PRICING_* (unset: ANTHROPIC_MODEL with ANTHROPIC_PRICING_*).
 * Both use the same cost guard and budget ledger as the worker's provider (AI_EXPERIMENT_*). Incomplete configuration
 * leaves the search off with a logged reason: the assistant keeps working without sources. Optional
 * AI_KNOWLEDGE_SEARCH_TIMEOUT_MS (default 25 s).
 */
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import {
  createGuardedOpenAiClientFromEnv,
  createGuardedOpenAiEmbeddingsClientFromEnv,
  resolveOpenAiPricingFromEnv,
} from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { createGuardedAnthropicClientFromEnv } from '@modules/ai-gateway/infrastructure/anthropic-responses-transport';
import { PostgresRagChunkStore } from '@infra/db/postgres-rag-chunks.repository';
import { deriveAiCapabilities } from '@infra/config/ai-capabilities';
import { KnowledgeSearchService, type KnowledgeSearch, type KnowledgeSearchPricing } from '../application/knowledge-search';

export const KNOWLEDGE_SERVICES = Symbol('KNOWLEDGE_SERVICES');

export const KNOWLEDGE_SEARCH_FLAG = 'AI_ENABLE_KNOWLEDGE_SEARCH';
export const KNOWLEDGE_PROTOCOL_CARD_FLAG = 'AI_ENABLE_KNOWLEDGE_PROTOCOL_CARD';
export const KNOWLEDGE_PROTOCOL_CARD_PATH = 'AI_KNOWLEDGE_PROTOCOL_CARD_PATH';
const DRAFT_MARKER = /WERSJA ROBOCZA/i;
/** The card goes into every conversation prompt: a bound keeps a wrong file from inflating every call. */
const MAX_PROTOCOL_CARD_CHARS = 24_000;

export interface KnowledgeServices {
  /** null: search_knowledge is not offered. */
  search: KnowledgeSearch | null;
  /** Approved protocol card text; null when the flag is off or the card was refused. */
  protocol_card: string | null;
}

type Env = Record<string, string | undefined>;
type Logger = { log: (message: string) => void; warn: (message: string) => void };

export function isTruthyFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && ['1', 'true', 'yes', 'on'].includes(normalized);
}

function price(env: Env, key: string): number | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** The light model's prices in place of the main ones; limits and ledger stay the same (as the probe's helper calls). */
export function lightPricingEnv(env: Env): Env {
  const light = { ...env };
  for (const key of ['INPUT_PER_1K_TOKENS', 'CACHED_INPUT_PER_1K_TOKENS', 'OUTPUT_PER_1K_TOKENS', 'REASONING_PER_1K_TOKENS', 'CURRENCY', 'VERSION']) {
    light[`OPENAI_PRICING_${key}`] = env[`OPENAI_LIGHT_PRICING_${key}`];
  }
  // Optional: unset means 1.25x the light input price; never the main model's cache write price.
  light.OPENAI_PRICING_CACHE_WRITE_PER_1K_TOKENS = env.OPENAI_LIGHT_PRICING_CACHE_WRITE_PER_1K_TOKENS;
  return light;
}

/** Keys the search needs besides the flag; returned when missing so the log names them. */
export function missingKnowledgeSearchConfiguration(env: Env): string[] {
  const required = [
    'OPENAI_API_KEY',
    'OPENAI_LIGHT_MODEL',
    'OPENAI_LIGHT_PRICING_INPUT_PER_1K_TOKENS',
    'OPENAI_LIGHT_PRICING_CACHED_INPUT_PER_1K_TOKENS',
    'OPENAI_LIGHT_PRICING_OUTPUT_PER_1K_TOKENS',
    'OPENAI_LIGHT_PRICING_REASONING_PER_1K_TOKENS',
    'OPENAI_LIGHT_PRICING_CURRENCY',
    'OPENAI_LIGHT_PRICING_VERSION',
    'OPENAI_EMBEDDING_PRICING_INPUT_PER_1K_TOKENS',
    'OPENAI_EMBEDDING_PRICING_VERSION',
    'OPENAI_PRICING_CURRENCY',
    'AI_EXPERIMENT_MAX_COST',
    'AI_EXPERIMENT_COST_CURRENCY',
    'AI_EXPERIMENT_MAX_OUTPUT_TOKENS',
    'AI_EXPERIMENT_BUDGET_LEDGER_PATH',
  ];
  return required.filter((key) => !env[key]?.trim());
}

/** The Claude model and pricing prefix of the BM25 mode's rewrite and rerank: the light model when set. */
export function anthropicKnowledgeModel(env: Env): { model: string; pricingPrefix: string } {
  const light = env.ANTHROPIC_LIGHT_MODEL?.trim();
  if (light) return { model: light, pricingPrefix: 'ANTHROPIC_LIGHT_PRICING' };
  return { model: env.ANTHROPIC_MODEL?.trim() || 'claude-opus-5-5', pricingPrefix: 'ANTHROPIC_PRICING' };
}

/** Keys the BM25 mode needs besides the flag (Claude's key, its prices, the cost guard and ledger). */
export function missingKeywordSearchConfiguration(env: Env): string[] {
  const { pricingPrefix } = anthropicKnowledgeModel(env);
  const required = [
    'ANTHROPIC_API_KEY',
    `${pricingPrefix}_INPUT_PER_1K_TOKENS`,
    `${pricingPrefix}_CACHED_INPUT_PER_1K_TOKENS`,
    `${pricingPrefix}_OUTPUT_PER_1K_TOKENS`,
    `${pricingPrefix}_REASONING_PER_1K_TOKENS`,
    `${pricingPrefix}_CURRENCY`,
    `${pricingPrefix}_VERSION`,
    'AI_EXPERIMENT_MAX_COST',
    'AI_EXPERIMENT_COST_CURRENCY',
    'AI_EXPERIMENT_MAX_OUTPUT_TOKENS',
    'AI_EXPERIMENT_BUDGET_LEDGER_PATH',
  ];
  return required.filter((key) => !env[key]?.trim());
}

export function buildKnowledgeSearch(env: Env, pool: Pick<Pool, 'connect' | 'query'>, logger: Logger): KnowledgeSearch | null {
  if (!isTruthyFlag(env[KNOWLEDGE_SEARCH_FLAG])) return null;
  let mode: ReturnType<typeof deriveAiCapabilities>['knowledge_search_mode'];
  try {
    mode = deriveAiCapabilities(env).knowledge_search_mode;
  } catch (error) {
    logger.warn(JSON.stringify({ event: 'knowledge_search_disabled', reason: 'CONFIGURATION_REFUSED', error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
  // Only the fake provider (no paid AI at all) keeps the search off.
  if (mode === 'off') {
    logger.warn(JSON.stringify({ event: 'knowledge_search_disabled', reason: 'AI_PROVIDER_FAKE' }));
    return null;
  }
  if (mode === 'bm25') return buildKeywordKnowledgeSearch(env, pool, logger);
  const missing = missingKnowledgeSearchConfiguration(env);
  if (missing.length) {
    logger.warn(JSON.stringify({ event: 'knowledge_search_disabled', reason: 'MISSING_CONFIGURATION', missing }));
    return null;
  }
  try {
    const apiKey = String(env.OPENAI_API_KEY).trim();
    const lightModel = String(env.OPENAI_LIGHT_MODEL).trim();
    // Same per-call cost guard and the same durable budget ledger file as the worker's provider.
    const lightEnv = lightPricingEnv(env) as NodeJS.ProcessEnv;
    const lightClient = createGuardedOpenAiClientFromEnv(lightEnv, apiKey);
    const embeddingsClient = createGuardedOpenAiEmbeddingsClientFromEnv(env as NodeJS.ProcessEnv, apiKey);
    const timeoutMs = Number(env.AI_KNOWLEDGE_SEARCH_TIMEOUT_MS);
    const pricing: KnowledgeSearchPricing = {
      currency: String(env.OPENAI_PRICING_CURRENCY).trim(),
      light: resolveOpenAiPricingFromEnv(lightEnv),
      embedding_input_per_1k_tokens: price(env, 'OPENAI_EMBEDDING_PRICING_INPUT_PER_1K_TOKENS') ?? 0,
    };
    const search = new KnowledgeSearchService({
      store: new PostgresRagChunkStore(pool),
      lightClient,
      embeddingsClient,
      lightModel,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
      pricing,
      logger,
    });
    logger.log(JSON.stringify({ event: 'knowledge_search_enabled', mode: 'hybrid', light_model: lightModel }));
    return search;
  } catch (error) {
    logger.warn(JSON.stringify({ event: 'knowledge_search_disabled', reason: 'CONFIGURATION_REFUSED', error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

/** BM25 mode (no OpenAI key): Claude rewrites and reranks, the candidates are full text only. */
function buildKeywordKnowledgeSearch(env: Env, pool: Pick<Pool, 'connect' | 'query'>, logger: Logger): KnowledgeSearch | null {
  const missing = missingKeywordSearchConfiguration(env);
  if (missing.length) {
    logger.warn(JSON.stringify({ event: 'knowledge_search_disabled', mode: 'bm25', reason: 'MISSING_CONFIGURATION', missing }));
    return null;
  }
  try {
    const { model, pricingPrefix } = anthropicKnowledgeModel(env);
    const lightClient = createGuardedAnthropicClientFromEnv(env as NodeJS.ProcessEnv, undefined, pricingPrefix);
    const timeoutMs = Number(env.AI_KNOWLEDGE_SEARCH_TIMEOUT_MS);
    const pricing: KnowledgeSearchPricing = {
      currency: String(env[`${pricingPrefix}_CURRENCY`]).trim(),
      light: resolveOpenAiPricingFromEnv(env as NodeJS.ProcessEnv, pricingPrefix),
      embedding_input_per_1k_tokens: 0,
    };
    const search = new KnowledgeSearchService({
      store: new PostgresRagChunkStore(pool),
      lightClient,
      embeddingsClient: null,
      lightModel: model,
      lightProvider: 'anthropic',
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
      pricing,
      logger,
    });
    logger.log(JSON.stringify({ event: 'knowledge_search_enabled', mode: 'bm25', light_model: model }));
    return search;
  } catch (error) {
    logger.warn(JSON.stringify({ event: 'knowledge_search_disabled', mode: 'bm25', reason: 'CONFIGURATION_REFUSED', error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

/** The approved protocol card, or null (flag off, path missing, unreadable, empty, too long or still a draft). */
export function loadProtocolCard(env: Env, logger: Logger, read: (path: string) => string = (path) => readFileSync(path, 'utf8')): string | null {
  if (!isTruthyFlag(env[KNOWLEDGE_PROTOCOL_CARD_FLAG])) return null;
  const path = env[KNOWLEDGE_PROTOCOL_CARD_PATH]?.trim();
  const refuse = (reason: string) => {
    logger.warn(JSON.stringify({ event: 'knowledge_protocol_card_refused', reason }));
    return null;
  };
  if (!path) return refuse('PATH_NOT_SET');
  let text: string;
  try {
    text = read(path).trim();
  } catch {
    return refuse('UNREADABLE');
  }
  if (!text) return refuse('EMPTY');
  if (DRAFT_MARKER.test(text)) return refuse('DRAFT_NOT_APPROVED');
  if (text.length > MAX_PROTOCOL_CARD_CHARS) return refuse('TOO_LONG');
  logger.log(JSON.stringify({ event: 'knowledge_protocol_card_loaded', chars: text.length }));
  return text;
}

export function buildKnowledgeServices(env: Env, pool: Pick<Pool, 'connect' | 'query'>, logger: Logger): KnowledgeServices {
  return { search: buildKnowledgeSearch(env, pool, logger), protocol_card: loadProtocolCard(env, logger) };
}
