/**
 * What the server's AI can do, derived from AI_PROVIDER and the keys present. A family self-hosting the server brings
 * one key, from either provider:
 *   - ANTHROPIC_API_KEY only (AI_PROVIDER=anthropic): answers, analyses, meal chat and WBT on Claude; knowledge search
 *     on full text (BM25) with Claude writing the English query and picking the fragments (no embeddings); voice input
 *     transcribed on the phone (Apple Speech);
 *   - OPENAI_API_KEY only (AI_PROVIDER=openai): everything on OpenAI, hybrid knowledge search, voice on the server;
 *   - both (production): AI_PROVIDER picks the answer provider; embeddings, the knowledge search helpers and voice stay
 *     on OpenAI, as before.
 * AI_PROVIDER=fake (the default) makes no paid call at all.
 */

export type AiProviderName = 'fake' | 'openai' | 'anthropic';
/** hybrid: embeddings + full text; bm25: full text only (no OpenAI key); off: no paid AI. */
export type KnowledgeSearchMode = 'hybrid' | 'bm25' | 'off';

export interface AiCapabilities {
  provider: AiProviderName;
  openai_key: boolean;
  anthropic_key: boolean;
  /** Paid answers (conversations, analyses, meal chat, WBT) on the provider's key. */
  paid_ai: boolean;
  /** Query embeddings for the knowledge search: OpenAI only. */
  embeddings: boolean;
  knowledge_search_mode: KnowledgeSearchMode;
  /** Speech to text on the server (OpenAI); otherwise the app transcribes on the phone. */
  server_voice_transcription: boolean;
}

type Env = Record<string, string | undefined>;

function hasValue(env: Env, key: string): boolean {
  return Boolean(env[key]?.trim());
}

/** AI_PROVIDER, lower-cased; unset or empty = fake. Anything else throws. */
export function parseAiProvider(env: Env): AiProviderName {
  const provider = (env.AI_PROVIDER?.trim() || 'fake').toLowerCase();
  if (provider !== 'fake' && provider !== 'openai' && provider !== 'anthropic') {
    throw new Error('Invalid environment variable: AI_PROVIDER must be fake, openai or anthropic');
  }
  return provider;
}

/**
 * The capabilities of this environment. Throws when AI_PROVIDER names a provider whose key is missing, so a server
 * never starts believing it has paid AI it cannot call.
 */
export function deriveAiCapabilities(env: Env): AiCapabilities {
  const provider = parseAiProvider(env);
  const openaiKey = hasValue(env, 'OPENAI_API_KEY');
  const anthropicKey = hasValue(env, 'ANTHROPIC_API_KEY');
  if (provider === 'openai' && !openaiKey) {
    throw new Error('Missing required environment variable: OPENAI_API_KEY (AI_PROVIDER=openai; with only a Claude key set AI_PROVIDER=anthropic)');
  }
  if (provider === 'anthropic' && !anthropicKey) {
    throw new Error('Missing required environment variable: ANTHROPIC_API_KEY (AI_PROVIDER=anthropic; with only an OpenAI key set AI_PROVIDER=openai)');
  }
  const paidAi = provider !== 'fake';
  const embeddings = paidAi && openaiKey;
  return {
    provider,
    openai_key: openaiKey,
    anthropic_key: anthropicKey,
    paid_ai: paidAi,
    embeddings,
    knowledge_search_mode: !paidAi ? 'off' : embeddings ? 'hybrid' : 'bm25',
    // Voice runs in the API, independent of the answer provider (as before): only the OpenAI key matters.
    server_voice_transcription: openaiKey,
  };
}
