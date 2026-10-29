import { deriveAiCapabilities, type AiCapabilities } from '@infra/config/ai-capabilities';

/**
 * The setup's AI step (community-self-hosted-plan.md, stage 7 wording): first the answering provider and its key; with
 * OpenAI that key also serves knowledge search and voice (no second question); with Claude an optional OpenAI key
 * ("lepsze wyszukiwanie w bazie wiedzy i rozpoznawanie mowy na serwerze, koszt to grosze miesięcznie"; skipped:
 * word-only search, voice on the phone). Each key is checked with a free call (the model list) and a failing key is
 * named. The result is the .env lines the setup page / installer writes; the server never stores keys itself.
 */

export type AnsweringProvider = 'anthropic' | 'openai';
export type AiKeyName = 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY';

export class AiKeyCheckError extends Error {
  constructor(
    readonly code: 'AI_PROVIDER_INVALID' | 'AI_KEY_MISSING' | 'AI_KEY_INVALID' | 'AI_KEY_UNREACHABLE',
    readonly key: AiKeyName | null,
  ) {
    super(key ? `${code}: ${key}` : code);
  }
}

export interface AiSetupInput {
  provider: AnsweringProvider;
  /** The answering provider's key. */
  apiKey: string;
  /** Claude only: the optional OpenAI key; null = skipped. Ignored with OpenAI (its key already covers it). */
  openaiApiKey: string | null;
}

export interface AiSetupResult {
  /** What to write into .env (the keys included); AI_PROVIDER plus one or two keys. */
  env: Record<string, string>;
  capabilities: AiCapabilities;
  checked: AiKeyName[];
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number }>;

/** Reads the body of POST /v1/setup/ai (or the CLI's env) into a checked shape. */
export function parseAiSetupInput(raw: Record<string, unknown>): AiSetupInput {
  const provider = typeof raw.provider === 'string' ? raw.provider.trim().toLowerCase() : '';
  const normalized = provider === 'claude' ? 'anthropic' : provider;
  if (normalized !== 'anthropic' && normalized !== 'openai') throw new AiKeyCheckError('AI_PROVIDER_INVALID', null);
  const apiKey = typeof raw.api_key === 'string' ? raw.api_key.trim() : '';
  if (!apiKey) throw new AiKeyCheckError('AI_KEY_MISSING', normalized === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
  const openai = typeof raw.openai_api_key === 'string' && raw.openai_api_key.trim() ? raw.openai_api_key.trim() : null;
  return { provider: normalized, apiKey, openaiApiKey: normalized === 'anthropic' ? openai : null };
}

/** Checks every key given (free model-list calls, in parallel) and returns the .env lines and what the server can do. */
export async function checkAiSetup(input: AiSetupInput, fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = 10_000): Promise<AiSetupResult> {
  const env: Record<string, string> = { AI_PROVIDER: input.provider };
  const checks: Array<Promise<void>> = [];
  const checked: AiKeyName[] = [];
  if (input.provider === 'anthropic') {
    env.ANTHROPIC_API_KEY = input.apiKey;
    checked.push('ANTHROPIC_API_KEY');
    checks.push(checkKey('ANTHROPIC_API_KEY', 'https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': input.apiKey, 'anthropic-version': '2023-06-01' }, fetchImpl, timeoutMs));
  }
  const openaiKey = input.provider === 'openai' ? input.apiKey : input.openaiApiKey;
  if (openaiKey) {
    env.OPENAI_API_KEY = openaiKey;
    checked.push('OPENAI_API_KEY');
    checks.push(checkKey('OPENAI_API_KEY', 'https://api.openai.com/v1/models', { Authorization: `Bearer ${openaiKey}` }, fetchImpl, timeoutMs));
  }
  // The first failing key (in question order) is the one named.
  const results = await Promise.allSettled(checks);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
  return { env, capabilities: deriveAiCapabilities(env), checked };
}

async function checkKey(key: AiKeyName, url: string, headers: Record<string, string>, fetchImpl: FetchLike, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status: number;
  try {
    status = (await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })).status;
  } catch {
    throw new AiKeyCheckError('AI_KEY_UNREACHABLE', key);
  } finally {
    clearTimeout(timer);
  }
  if (status === 401 || status === 403) throw new AiKeyCheckError('AI_KEY_INVALID', key);
  if (status < 200 || status >= 300) throw new AiKeyCheckError('AI_KEY_UNREACHABLE', key);
}
