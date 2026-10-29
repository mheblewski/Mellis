import { readFileSync } from 'fs';
import { Logger } from '@nestjs/common';
import { deriveAiCapabilities } from './ai-capabilities';

interface DatabaseEnvironment {
  DATABASE_URL: string;
}

export interface ApiEnvironment extends DatabaseEnvironment {
  AUTH_MODE: 'cognito' | 'disabled' | 'local_token' | 'device';
  AUTH_DISABLED_USER_ID: string;
  /** local_token only: the fixed principal and the SHA-256 (hex) of the shared development token. */
  LOCAL_AUTH_USER_ID?: string;
  LOCAL_AUTH_TOKEN_SHA256?: string;
  COGNITO_USER_POOL_ID?: string;
  COGNITO_CLIENT_ID?: string;
  COGNITO_TOKEN_USE?: 'access' | 'id';
  /** AUTH_MODE=device: the installer's one-time setup code (valid until the first owner's phone pairs). */
  SETUP_CODE?: string;
  /** AUTH_MODE=device: the server address put into pairing QR codes (else the request's own address). */
  PUBLIC_BASE_URL?: string;
  /** Server switch of remote commands to Trio (REMOTE_COMMANDS_ENABLED, off by default). */
  REMOTE_COMMANDS_ENABLED: boolean;
  /** The main chat may read and prepare meal changes (AI_ENABLE_MEAL_ACTIONS, off by default). */
  AI_ENABLE_MEAL_ACTIONS: boolean;
  /** Voice input of the chat composers through OpenAI speech to text (VOICE_TRANSCRIPTION_ENABLED, off by default). */
  VOICE_TRANSCRIPTION_ENABLED: boolean;
  /** Where meal and chat photos are stored; unset: photo uploads are refused. */
  MEAL_PHOTO_DIR?: string;
  /** The seed's auth mode (the worker stores it with the env patient's source). */
  NIGHTSCOUT_AUTH_MODE: NightscoutAuthModeSetting;
  /** Decrypts the patients' stored Nightscout tokens for the dashboard's live reads; unset: no live reads. */
  NIGHTSCOUT_TOKEN_ENCRYPTION_KEY?: string;
  /** Closed beta: only allowlisted or invited e-mails get in (BETA_ALLOWLIST_ENABLED, on by default). */
  BETA_ALLOWLIST_ENABLED: boolean;
  /** Overrides the app's minimum supported build (GET /v1/app-config); 0 switches the update banner off. */
  IOS_MIN_SUPPORTED_BUILD?: number;
}

export type NightscoutAuthModeSetting = 'BEARER' | 'API_SECRET_SHA1' | 'ACCESS_TOKEN_JWT';

export interface WorkerEnvironment extends DatabaseEnvironment {
  /**
   * The one-time seed of a patient's stored Nightscout (090_sharing_foundation.sql): all three or none. Each patient's
   * stored source is what the worker syncs; these never override it.
   */
  NIGHTSCOUT_BASE_URL?: string;
  NIGHTSCOUT_API_TOKEN?: string;
  NIGHTSCOUT_AUTH_MODE: NightscoutAuthModeSetting;
  NIGHTSCOUT_PATIENT_ID?: string;
  /** Decrypts the stored Nightscout tokens (32 bytes, hex or base64); required while the sync is on. */
  NIGHTSCOUT_TOKEN_ENCRYPTION_KEY?: string;
  /** Closed beta: only allowlisted or invited e-mails get in (BETA_ALLOWLIST_ENABLED, on by default). */
  BETA_ALLOWLIST_ENABLED: boolean;
  NIGHTSCOUT_SYNC_MAX_ENTRY_PAGES: number;
  /** How far behind its cursors each sync re-reads entries and treatments for late uploads. 0 = off. Default 360. */
  NIGHTSCOUT_SYNC_LOOKBACK_MINUTES: number;
  /** false: the worker registers no Nightscout source, schedules no nightscout.sync and claims none. Default true. */
  NIGHTSCOUT_SYNC_ENABLED: boolean;
  AI_PROVIDER: 'fake' | 'openai' | 'anthropic';
  OPENAI_API_KEY?: string;
  /**
   * Claude (AI_PROVIDER=anthropic). With an OpenAI key too, embeddings (knowledge search) and voice transcription stay
   * on OPENAI_API_KEY; without one, knowledge search is full text only and the app transcribes voice on the phone.
   */
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL: string;
  /** Messages API `output_config.effort`; unset = the model's default. */
  ANTHROPIC_EFFORT?: AnthropicEffort;
  /** Server-side refusal fallback (`fallbacks: "default"`) on the models that support it. Default true. */
  ANTHROPIC_REFUSAL_FALLBACK: boolean;
  OPENAI_MODEL: string;
  OPENAI_TIMEOUT_MS: number;
  OPENAI_EVAL_CAPTURE_ENABLED: boolean;
  /** Explicit prompt-cache breakpoint after the system message (gpt-5.6+); off by default. */
  OPENAI_PROMPT_CACHE_BREAKPOINTS: boolean;
  OPENAI_EVAL_CAPTURE_FILE_PATH?: string;
  /**
   * Budgeted usage session: paid AI for every job type, bounded by the per-call cost guard and a durable ledger (total
   * budget and call count) created for that session. Required true for openai.
   */
  AI_BUDGETED_USAGE_SESSION: boolean;
  /**
   * Responses API `reasoning.effort`. Unset keeps requests unchanged (no `reasoning` field). Validated here; model
   * support is not checked.
   */
  OPENAI_REASONING_EFFORT?: OpenAiReasoningEffort;
  /** Hard cost limit of one call. Required for openai and anthropic, no default. */
  AI_EXPERIMENT_MAX_COST?: number;
  AI_EXPERIMENT_COST_CURRENCY?: string;
  AI_EXPERIMENT_MAX_OUTPUT_TOKENS?: number;
  /** Durable experiment budget ledger (absolute path outside every Git working tree). Required for openai. */
  AI_EXPERIMENT_BUDGET_LEDGER_PATH?: string;
  PUSH_PROVIDER: 'fake' | 'apns';
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_PRIVATE_KEY_PATH?: string;
  APNS_BUNDLE_ID?: string;
  APNS_USE_SANDBOX: boolean;
  APNS_TIMEOUT_MS: number;
  /** Restricted mode: only these job types are claimed; undefined claims every type (default behaviour). */
  WORKER_JOB_TYPES?: string[];
}

export const OPENAI_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type OpenAiReasoningEffort = (typeof OPENAI_REASONING_EFFORTS)[number];

export const ANTHROPIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

/** ANTHROPIC_EFFORT: null when unset or empty, otherwise one of ANTHROPIC_EFFORTS; anything else throws. */
export function parseAnthropicEffort(value: unknown): AnthropicEffort | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) return null;
  if ((ANTHROPIC_EFFORTS as readonly string[]).includes(normalized)) return normalized as AnthropicEffort;
  throw new Error(`Invalid environment variable: ANTHROPIC_EFFORT must be one of ${ANTHROPIC_EFFORTS.join(', ')}`);
}

/** Optional OPENAI_REASONING_EFFORT: undefined when unset or empty, otherwise one of OPENAI_REASONING_EFFORTS. */
export function parseOpenAiReasoningEffort(raw: string | undefined): OpenAiReasoningEffort | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  if (!(OPENAI_REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new Error(`Invalid environment variable: OPENAI_REASONING_EFFORT must be one of ${OPENAI_REASONING_EFFORTS.join(', ')}`);
  }
  return value as OpenAiReasoningEffort;
}

const JOB_TYPE_PATTERN = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/;

/**
 * WORKER_JOB_TYPES: comma-separated job types for a restricted worker. Unset means no restriction. When set, it must
 * name at least one well-formed type; anything else throws so a typo can never fall back to processing every job.
 */
export function parseWorkerJobTypes(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const items = raw.split(',').map((item) => item.trim());
  if (items.length === 0 || items.every((item) => item === '')) {
    throw new Error('Invalid environment variable: WORKER_JOB_TYPES is set but empty');
  }
  const invalid = items.filter((item) => !JOB_TYPE_PATTERN.test(item));
  if (invalid.length > 0) {
    throw new Error(`Invalid environment variable: WORKER_JOB_TYPES contains invalid job types: ${invalid.map((item) => JSON.stringify(item)).join(', ')}`);
  }
  return [...new Set(items)];
}

function requireString(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

function optionalString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (!value || !value.trim()) {
    return undefined;
  }

  return value;
}

function optionalFileContents(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const filePath = optionalString(env, key);
  if (!filePath) {
    return undefined;
  }

  return readFileSync(filePath, 'utf8').trim();
}

function parsePositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw || !raw.trim()) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid environment variable: ${key} must be a positive integer`);
  }

  return parsed;
}

function parseNonNegativeInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw || !raw.trim()) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid environment variable: ${key} must be a non-negative integer`);
  }

  return parsed;
}

function parseOptionalPositiveNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (!raw || !raw.trim()) {
    return undefined;
  }

  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid environment variable: ${key} must be a positive number`);
  }

  return parsed;
}

/**
 * A boolean environment variable: true/1 or false/0 (any case, surrounding spaces ignored); unset or empty is the
 * fallback. Anything else ("yes", "on", a typo) throws, so validate*Environment stops the start on it.
 */
export function parseBoolean(env: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (!raw || !raw.trim()) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }

  if (normalized === 'false' || normalized === '0') {
    return false;
  }

  throw new Error(`Invalid environment variable: ${key} must be true/false or 1/0`);
}

const flagLogger = new Logger('Environment');
const warnedFlags = new Set<string>();

/**
 * A boolean flag read while the app runs (per request or per job), with parseBoolean's values. An invalid value is
 * refused at startup by validateApiEnvironment / validateWorkerEnvironment; should one get here anyway, the flag reads
 * as off and a warning is logged once per variable. Unset or empty is off.
 */
export function readBooleanFlag(env: Record<string, string | undefined>, key: string): boolean {
  try {
    return parseBoolean(env, key, false);
  } catch (error) {
    if (!warnedFlags.has(key)) {
      warnedFlags.add(key);
      flagLogger.warn(`${(error as Error).message}; treated as false`);
    }
    return false;
  }
}

/** NIGHTSCOUT_AUTH_MODE: BEARER (default), API_SECRET_SHA1 or ACCESS_TOKEN_JWT, any case. */
export function parseNightscoutAuthMode(raw: string | undefined): NightscoutAuthModeSetting {
  const mode = (raw ?? 'BEARER').trim().toUpperCase() || 'BEARER';
  if (mode !== 'BEARER' && mode !== 'API_SECRET_SHA1' && mode !== 'ACCESS_TOKEN_JWT') {
    throw new Error('Invalid environment variable: NIGHTSCOUT_AUTH_MODE must be BEARER, API_SECRET_SHA1 or ACCESS_TOKEN_JWT');
  }
  return mode;
}

/** Optional whole number >= 0; unset or empty is undefined. */
function parseOptionalNonNegativeInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid environment variable: ${key} must be a whole number >= 0`);
  }
  return Number(raw);
}

/** Settings the API reads at run time besides authentication, validated once at startup. */
function validateApiRuntimeSettings(env: NodeJS.ProcessEnv): Pick<ApiEnvironment, 'REMOTE_COMMANDS_ENABLED' | 'AI_ENABLE_MEAL_ACTIONS' | 'VOICE_TRANSCRIPTION_ENABLED' | 'MEAL_PHOTO_DIR' | 'NIGHTSCOUT_AUTH_MODE' | 'NIGHTSCOUT_TOKEN_ENCRYPTION_KEY' | 'BETA_ALLOWLIST_ENABLED' | 'IOS_MIN_SUPPORTED_BUILD'> {
  return {
    NIGHTSCOUT_TOKEN_ENCRYPTION_KEY: parseOptionalEncryptionKey(env, 'NIGHTSCOUT_TOKEN_ENCRYPTION_KEY'),
    BETA_ALLOWLIST_ENABLED: parseBoolean(env, 'BETA_ALLOWLIST_ENABLED', true),
    REMOTE_COMMANDS_ENABLED: parseBoolean(env, 'REMOTE_COMMANDS_ENABLED', false),
    AI_ENABLE_MEAL_ACTIONS: parseBoolean(env, 'AI_ENABLE_MEAL_ACTIONS', false),
    VOICE_TRANSCRIPTION_ENABLED: parseBoolean(env, 'VOICE_TRANSCRIPTION_ENABLED', false),
    MEAL_PHOTO_DIR: optionalString(env, 'MEAL_PHOTO_DIR')?.trim(),
    NIGHTSCOUT_AUTH_MODE: parseNightscoutAuthMode(env.NIGHTSCOUT_AUTH_MODE),
    IOS_MIN_SUPPORTED_BUILD: parseOptionalNonNegativeInt(env, 'IOS_MIN_SUPPORTED_BUILD'),
  };
}

/** A 32-byte key as 64 hex characters or base64; the value never appears in the error. */
function parseOptionalEncryptionKey(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = optionalString(env, key)?.trim();
  if (!raw) return undefined;
  const bytes = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (bytes.length !== 32) {
    throw new Error(`Invalid environment variable: ${key} must be 32 bytes (64 hex characters or base64)`);
  }
  return raw;
}

/** NIGHTSCOUT_PATIENT_ID / NIGHTSCOUT_BASE_URL / NIGHTSCOUT_API_TOKEN: the one-time seed, all three or none. */
function parseNightscoutSeed(env: NodeJS.ProcessEnv): Pick<WorkerEnvironment, 'NIGHTSCOUT_BASE_URL' | 'NIGHTSCOUT_API_TOKEN' | 'NIGHTSCOUT_PATIENT_ID'> {
  const seed = {
    NIGHTSCOUT_BASE_URL: optionalString(env, 'NIGHTSCOUT_BASE_URL'),
    NIGHTSCOUT_API_TOKEN: optionalString(env, 'NIGHTSCOUT_API_TOKEN'),
    NIGHTSCOUT_PATIENT_ID: optionalString(env, 'NIGHTSCOUT_PATIENT_ID'),
  };
  const missing = Object.entries(seed).filter(([, value]) => value === undefined).map(([name]) => name);
  if (missing.length > 0 && missing.length < 3) {
    throw new Error(`Missing required environment variables for the Nightscout seed: ${missing.join(', ')} (set all three or none)`);
  }
  return seed;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * AUTH_MODE=local_token: development-only shared bearer token. The backend keeps only the token's SHA-256 (hex); the
 * principal is LOCAL_AUTH_USER_ID from configuration. Fails closed: any missing or malformed value, a non-development
 * NODE_ENV, or a still-enabled ALLOW_AUTH_DISABLED_IN_LOCAL refuses to start. Error messages never include values.
 */
export function validateLocalTokenAuth(env: NodeJS.ProcessEnv): { userId: string; tokenSha256: string } {
  const nodeEnv = (env.NODE_ENV ?? '').trim().toLowerCase();
  if (nodeEnv !== 'development') {
    throw new Error('Invalid environment variables: AUTH_MODE=local_token requires NODE_ENV=development');
  }
  // Switching from disabled must not leave the unauthenticated mode armed.
  if (parseBoolean(env, 'ALLOW_AUTH_DISABLED_IN_LOCAL', false)) {
    throw new Error('Invalid environment variables: AUTH_MODE=local_token requires ALLOW_AUTH_DISABLED_IN_LOCAL to be unset or false');
  }
  const userId = (env.LOCAL_AUTH_USER_ID ?? '').trim();
  if (!UUID_PATTERN.test(userId)) {
    throw new Error('Invalid environment variable: LOCAL_AUTH_USER_ID must be a UUID when AUTH_MODE=local_token');
  }
  const tokenSha256 = (env.LOCAL_AUTH_TOKEN_SHA256 ?? '').trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(tokenSha256)) {
    throw new Error('Invalid environment variable: LOCAL_AUTH_TOKEN_SHA256 must be the 64-character hex SHA-256 of the token when AUTH_MODE=local_token');
  }
  return { userId, tokenSha256 };
}

export function validateApiEnvironment(env: NodeJS.ProcessEnv): ApiEnvironment {
  const authMode = (env.AUTH_MODE ?? 'cognito').trim().toLowerCase();
  if (authMode !== 'cognito' && authMode !== 'disabled' && authMode !== 'local_token' && authMode !== 'device') {
    throw new Error('Invalid environment variable: AUTH_MODE must be cognito, disabled, local_token or device');
  }

  const authDisabledUserId = (env.AUTH_DISABLED_USER_ID ?? '00000000-0000-4000-8000-000000000001').trim();
  const tokenUse = (env.COGNITO_TOKEN_USE ?? 'access').trim().toLowerCase();
  if (tokenUse !== 'access' && tokenUse !== 'id') {
    throw new Error('Invalid environment variable: COGNITO_TOKEN_USE must be access or id');
  }

  const runtime = validateApiRuntimeSettings(env);

  if (authMode === 'local_token') {
    const local = validateLocalTokenAuth(env);
    return {
      ...runtime,
      DATABASE_URL: requireString(env, 'DATABASE_URL'),
      AUTH_MODE: 'local_token',
      AUTH_DISABLED_USER_ID: authDisabledUserId,
      LOCAL_AUTH_USER_ID: local.userId,
      LOCAL_AUTH_TOKEN_SHA256: local.tokenSha256,
    };
  }

  if (authMode === 'device') {
    // Self-hosted (docs/device-auth-api.md): paired devices, no Cognito. Patients' Nightscout tokens are stored
    // encrypted, so the key is required; SETUP_CODE (the installer's, at least 16 characters) opens the setup.
    if (!runtime.NIGHTSCOUT_TOKEN_ENCRYPTION_KEY) {
      throw new Error('Missing required environment variable: NIGHTSCOUT_TOKEN_ENCRYPTION_KEY (AUTH_MODE=device)');
    }
    const setupCode = optionalString(env, 'SETUP_CODE')?.trim();
    if (setupCode !== undefined && setupCode.length < 16) {
      throw new Error('Invalid environment variable: SETUP_CODE must be at least 16 characters');
    }
    const publicBaseUrl = optionalString(env, 'PUBLIC_BASE_URL')?.trim();
    if (publicBaseUrl && !/^https?:\/\/[^\s/]+(\/.*)?$/i.test(publicBaseUrl)) {
      throw new Error('Invalid environment variable: PUBLIC_BASE_URL must be an http(s) URL');
    }
    return {
      ...runtime,
      DATABASE_URL: requireString(env, 'DATABASE_URL'),
      AUTH_MODE: 'device',
      AUTH_DISABLED_USER_ID: authDisabledUserId,
      SETUP_CODE: setupCode,
      PUBLIC_BASE_URL: publicBaseUrl,
    };
  }

  if (authMode === 'disabled') {
    const nodeEnv = (env.NODE_ENV ?? '').trim().toLowerCase();
    const isLocalEnvironment = nodeEnv === 'development' || nodeEnv === 'local' || nodeEnv === 'test';
    const allowAuthDisabledInLocal = parseBoolean(env, 'ALLOW_AUTH_DISABLED_IN_LOCAL', false);
    if (!isLocalEnvironment || !allowAuthDisabledInLocal) {
      throw new Error(
        'Invalid environment variables: AUTH_MODE=disabled requires NODE_ENV to be development/local/test and ALLOW_AUTH_DISABLED_IN_LOCAL=true',
      );
    }

    return {
      ...runtime,
      DATABASE_URL: requireString(env, 'DATABASE_URL'),
      AUTH_MODE: 'disabled',
      AUTH_DISABLED_USER_ID: authDisabledUserId,
    };
  }

  return {
    ...runtime,
    DATABASE_URL: requireString(env, 'DATABASE_URL'),
    AUTH_MODE: 'cognito',
    AUTH_DISABLED_USER_ID: authDisabledUserId,
    COGNITO_USER_POOL_ID: requireString(env, 'COGNITO_USER_POOL_ID'),
    COGNITO_CLIENT_ID: requireString(env, 'COGNITO_CLIENT_ID'),
    COGNITO_TOKEN_USE: tokenUse,
  };
}

export function validateWorkerEnvironment(env: NodeJS.ProcessEnv): WorkerEnvironment {
  // Either key alone is enough (see ai-capabilities.ts); AI_PROVIDER without its own key stops the start.
  const provider = deriveAiCapabilities(env).provider;
  const openAiApiKey = optionalString(env, 'OPENAI_API_KEY');
  const anthropicApiKey = optionalString(env, 'ANTHROPIC_API_KEY');
  const anthropicEffort = parseAnthropicEffort(env.ANTHROPIC_EFFORT) ?? undefined;
  const anthropicRefusalFallback = parseBoolean(env, 'ANTHROPIC_REFUSAL_FALLBACK', true);
  // Validated here so a typo stops the start (read by app.module).
  parseBoolean(env, 'ANTHROPIC_ANSWER_TOOL', true);

  const openAiEvalCaptureEnabled = parseBoolean(env, 'OPENAI_EVAL_CAPTURE_ENABLED', false);
  const openAiEvalCaptureFilePath = optionalString(env, 'OPENAI_EVAL_CAPTURE_FILE_PATH');
  if (openAiEvalCaptureEnabled && !openAiEvalCaptureFilePath) {
    throw new Error('Missing required environment variable: OPENAI_EVAL_CAPTURE_FILE_PATH when OPENAI_EVAL_CAPTURE_ENABLED=true');
  }

  // The single-call experiment is gone: a leftover AI_SINGLE_CALL_EXPERIMENT=true stops the start instead of silently
  // running with tools and retries.
  if (parseBoolean(env, 'AI_SINGLE_CALL_EXPERIMENT', false)) {
    throw new Error('Invalid environment: AI_SINGLE_CALL_EXPERIMENT was removed; use AI_BUDGETED_USAGE_SESSION=true');
  }
  const reasoningEffort = parseOpenAiReasoningEffort(env.OPENAI_REASONING_EFFORT);
  const workerJobTypes = parseWorkerJobTypes(env.WORKER_JOB_TYPES);
  const experimentMaxCost = parseOptionalPositiveNumber(env, 'AI_EXPERIMENT_MAX_COST');
  const experimentCostCurrency = optionalString(env, 'AI_EXPERIMENT_COST_CURRENCY')?.trim();
  const experimentMaxOutputTokens = optionalString(env, 'AI_EXPERIMENT_MAX_OUTPUT_TOKENS')
    ? parsePositiveInt(env, 'AI_EXPERIMENT_MAX_OUTPUT_TOKENS', 0)
    : undefined;
  const experimentBudgetLedgerPath = optionalString(env, 'AI_EXPERIMENT_BUDGET_LEDGER_PATH')?.trim();
  const budgetedUsageSession = parseBoolean(env, 'AI_BUDGETED_USAGE_SESSION', false);
  if (provider === 'openai' || provider === 'anthropic') {
    // Paid calls only with an explicit cost limit and a ledger-bounded mode; missing config never means unlimited.
    if (!budgetedUsageSession) {
      throw new Error(`Invalid environment: AI_PROVIDER=${provider} requires AI_BUDGETED_USAGE_SESSION=true`);
    }
    const missing = [
      experimentMaxCost === undefined ? 'AI_EXPERIMENT_MAX_COST' : null,
      !experimentCostCurrency ? 'AI_EXPERIMENT_COST_CURRENCY' : null,
      experimentMaxOutputTokens === undefined ? 'AI_EXPERIMENT_MAX_OUTPUT_TOKENS' : null,
      !experimentBudgetLedgerPath ? 'AI_EXPERIMENT_BUDGET_LEDGER_PATH' : null,
    ].filter((key): key is string => key !== null);
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables for AI_PROVIDER=${provider}: ${missing.join(', ')}`);
    }
  }

  // In production a missing PUSH_PROVIDER would drop every push silently (alerts, reminders marked sent).
  if (env.NODE_ENV === 'production' && !env.PUSH_PROVIDER?.trim()) {
    throw new Error('Missing required environment variable: PUSH_PROVIDER (apns, or fake on purpose) in production');
  }
  const pushProvider = (env.PUSH_PROVIDER ?? 'fake').toLowerCase();
  if (pushProvider !== 'fake' && pushProvider !== 'apns') {
    throw new Error('Invalid environment variable: PUSH_PROVIDER must be fake or apns');
  }

  const nightscoutAuthMode = parseNightscoutAuthMode(env.NIGHTSCOUT_AUTH_MODE);
  const nightscoutSyncEnabled = parseBoolean(env, 'NIGHTSCOUT_SYNC_ENABLED', true);
  const nightscoutSeed = parseNightscoutSeed(env);
  const nightscoutTokenKey = parseOptionalEncryptionKey(env, 'NIGHTSCOUT_TOKEN_ENCRYPTION_KEY');
  if (nightscoutSyncEnabled && !nightscoutTokenKey) {
    throw new Error('Missing required environment variable: NIGHTSCOUT_TOKEN_ENCRYPTION_KEY (the stored Nightscout tokens cannot be read without it; or NIGHTSCOUT_SYNC_ENABLED=false)');
  }
  // Flags the worker reads per job (readBooleanFlag): a typo stops the start instead of silently meaning off.
  parseBoolean(env, 'REMOTE_COMMANDS_ENABLED', false);
  parseBoolean(env, 'AI_ENABLE_MEAL_ACTIONS', false);
  parseBoolean(env, 'AI_ENABLE_BOLUS_PROPOSALS', false);

  const apnsTeamId = optionalString(env, 'APNS_TEAM_ID');
  const apnsKeyId = optionalString(env, 'APNS_KEY_ID');
  const apnsPrivateKey = optionalString(env, 'APNS_PRIVATE_KEY') ?? optionalFileContents(env, 'APNS_PRIVATE_KEY_PATH');
  const apnsBundleId = optionalString(env, 'APNS_BUNDLE_ID');

  if (pushProvider === 'apns') {
    if (!apnsTeamId || !apnsKeyId || !apnsPrivateKey || !apnsBundleId) {
      throw new Error('APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY or APNS_PRIVATE_KEY_PATH, and APNS_BUNDLE_ID are required when PUSH_PROVIDER=apns');
    }
  }

  return {
    DATABASE_URL: requireString(env, 'DATABASE_URL'),
    ...nightscoutSeed,
    NIGHTSCOUT_AUTH_MODE: nightscoutAuthMode,
    NIGHTSCOUT_TOKEN_ENCRYPTION_KEY: nightscoutTokenKey,
    BETA_ALLOWLIST_ENABLED: parseBoolean(env, 'BETA_ALLOWLIST_ENABLED', true),
    NIGHTSCOUT_SYNC_MAX_ENTRY_PAGES: parsePositiveInt(env, 'NIGHTSCOUT_SYNC_MAX_ENTRY_PAGES', 24),
    NIGHTSCOUT_SYNC_LOOKBACK_MINUTES: parseNonNegativeInt(env, 'NIGHTSCOUT_SYNC_LOOKBACK_MINUTES', 360),
    NIGHTSCOUT_SYNC_ENABLED: nightscoutSyncEnabled,
    AI_PROVIDER: provider,
    OPENAI_API_KEY: openAiApiKey,
    ANTHROPIC_API_KEY: anthropicApiKey,
    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL?.trim() || 'claude-opus-5-5',
    ANTHROPIC_EFFORT: anthropicEffort,
    ANTHROPIC_REFUSAL_FALLBACK: anthropicRefusalFallback,
    OPENAI_MODEL: env.OPENAI_MODEL?.trim() || 'gpt-5.6-terra',
    OPENAI_TIMEOUT_MS: parsePositiveInt(env, 'OPENAI_TIMEOUT_MS', 15_000),
    OPENAI_EVAL_CAPTURE_ENABLED: openAiEvalCaptureEnabled,
    OPENAI_PROMPT_CACHE_BREAKPOINTS: parseBoolean(env, 'OPENAI_PROMPT_CACHE_BREAKPOINTS', false),
    OPENAI_EVAL_CAPTURE_FILE_PATH: openAiEvalCaptureFilePath,
    AI_BUDGETED_USAGE_SESSION: budgetedUsageSession,
    OPENAI_REASONING_EFFORT: reasoningEffort,
    AI_EXPERIMENT_MAX_COST: experimentMaxCost,
    AI_EXPERIMENT_COST_CURRENCY: experimentCostCurrency,
    AI_EXPERIMENT_MAX_OUTPUT_TOKENS: experimentMaxOutputTokens,
    AI_EXPERIMENT_BUDGET_LEDGER_PATH: experimentBudgetLedgerPath,
    PUSH_PROVIDER: pushProvider,
    APNS_TEAM_ID: apnsTeamId,
    APNS_KEY_ID: apnsKeyId,
    APNS_PRIVATE_KEY: apnsPrivateKey,
    APNS_PRIVATE_KEY_PATH: optionalString(env, 'APNS_PRIVATE_KEY_PATH'),
    APNS_BUNDLE_ID: apnsBundleId,
    APNS_USE_SANDBOX: parseBoolean(env, 'APNS_USE_SANDBOX', true),
    APNS_TIMEOUT_MS: parsePositiveInt(env, 'APNS_TIMEOUT_MS', 10_000),
    WORKER_JOB_TYPES: workerJobTypes,
  };
}