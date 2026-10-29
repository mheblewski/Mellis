import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '@infra/db/database.module';
import { validateWorkerEnvironment, type OpenAiReasoningEffort } from '@infra/config/environment';
import { NIGHTSCOUT_CLIENT } from '@modules/integrations/nightscout/application/nightscout-client';
import { patientNightscoutClientsFromEnv, UNCONFIGURED_NIGHTSCOUT_CLIENT } from '@infra/db/patient-nightscout-clients.factory';
import { NightscoutSyncService } from '@modules/integrations/nightscout/application/nightscout-sync.service';
import { AI_PROVIDER } from '@modules/ai-gateway/infrastructure/ai-provider.token';
import { FakeAiProvider } from '@modules/ai-gateway/infrastructure/fake-ai-provider';
import { AiGatewayService } from '@modules/ai-gateway/application/ai-gateway.service';
import { OpenAiProvider } from '@modules/ai-gateway/infrastructure/openai-provider';
import { parseChainedInputBound, parseOpenAiServiceTier, resolveOpenAiPricingFromEnv } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { TieredAiProvider } from '@modules/ai-gateway/infrastructure/tiered-ai-provider';
import { createAnthropicResponsesTransport, parseAnthropicEffort, parseAnthropicRefusalFallback, parseAnthropicSwitch } from '@modules/ai-gateway/infrastructure/anthropic-responses-transport';
import { FileExperimentBudgetLedger } from '@modules/ai-gateway/infrastructure/experiment-budget-ledger';
import { PUSH_NOTIFICATION_PROVIDER } from '@modules/notifications/infrastructure/push-notification-provider.token';
import { FakePushNotificationProvider } from '@modules/notifications/infrastructure/fake-push-notification-provider';
import { ApnsPushNotificationProvider } from '@modules/notifications/infrastructure/apns-push-notification-provider';
import { PushNotificationService } from '@modules/notifications/application/push-notification.service';
import { WorkerService } from './worker.service';
import { LiveActivityWorker } from '@modules/live-activity/application/live-activity-worker';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PostgresNotificationHistoryRepository } from '@infra/db/postgres-notification-history.repository';
import { PostgresPatientPushLabeler } from '@infra/db/postgres-patient-push-label.repository';
import { KNOWLEDGE_SERVICES, buildKnowledgeServices } from '@modules/knowledge/infrastructure/knowledge-services.factory';

function parseNullablePrice(value: unknown, key: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  if (text.length === 0) {
    return null;
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid environment variable: ${key} must be a non-negative number`);
  }

  return parsed;
}

function parseNullableText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateWorkerEnvironment }), DatabaseModule],
  providers: [
    WorkerService,
    LiveActivityWorker,
    NightscoutSyncService,
    AiGatewayService,
    {
      provide: PUSH_NOTIFICATION_PROVIDER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const selectedProvider = String(configService.get<string>('PUSH_PROVIDER') ?? 'fake').toLowerCase();
        if (selectedProvider === 'apns') {
          return new ApnsPushNotificationProvider({
            teamId: configService.getOrThrow<string>('APNS_TEAM_ID'),
            keyId: configService.getOrThrow<string>('APNS_KEY_ID'),
            privateKey: configService.getOrThrow<string>('APNS_PRIVATE_KEY'),
            bundleId: configService.getOrThrow<string>('APNS_BUNDLE_ID'),
            useSandbox: Boolean(configService.get<boolean>('APNS_USE_SANDBOX') ?? true),
            timeoutMs: Number(configService.get<number>('APNS_TIMEOUT_MS') ?? 10_000),
          });
        }

        return new FakePushNotificationProvider();
      },
    },
    {
      provide: PushNotificationService,
      inject: [PUSH_NOTIFICATION_PROVIDER, DATABASE_POOL],
      useFactory: (provider: any, pool: Pool) => {
        return new PushNotificationService(provider, new PostgresNotificationHistoryRepository(pool), new PostgresPatientPushLabeler(pool));
      },
    },
    {
      provide: AI_PROVIDER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const selectedProvider = String(configService.get<string>('AI_PROVIDER') ?? 'fake').toLowerCase();
        if (selectedProvider === 'openai' || selectedProvider === 'anthropic') {
          // Same requests, guard and tiers for both: Claude goes through a transport that speaks the Responses shape.
          const prefix = selectedProvider === 'anthropic' ? 'ANTHROPIC' : 'OPENAI';
          const defaultModel = selectedProvider === 'anthropic' ? 'claude-opus-5-5' : 'gpt-5.6-terra';
          const deep = buildGuardedProvider(configService, selectedProvider, `${prefix}_PRICING`, parseNullableText(configService.get(`${prefix}_MODEL`)) ?? defaultModel);
          const lightModel = parseNullableText(configService.get(`${prefix}_LIGHT_MODEL`));
          if (!lightModel) {
            return deep;
          }
          // Light tier for direct replies and data lookups; analyses stay on the main model (see model-routing.ts).
          const light = buildGuardedProvider(configService, selectedProvider, `${prefix}_LIGHT_PRICING`, lightModel);
          return new TieredAiProvider(deep, light);
        }

        return new FakeAiProvider();
      },
    },
    {
      // Knowledge base for conversations: off unless AI_ENABLE_KNOWLEDGE_SEARCH=1 (see knowledge-services.factory.ts).
      provide: KNOWLEDGE_SERVICES,
      inject: [DATABASE_POOL],
      useFactory: (pool: Pool) => buildKnowledgeServices(process.env, pool, new Logger('KnowledgeSearch')),
    },
    {
      provide: 'AI_GATEWAY',
      useExisting: AiGatewayService,
    },
    {
      // Each patient's own Nightscout from sources (090_sharing_foundation.sql), tokens decrypted with
      // NIGHTSCOUT_TOKEN_ENCRYPTION_KEY (validateWorkerEnvironment requires it while the sync is on).
      provide: NIGHTSCOUT_CLIENT,
      inject: [DATABASE_POOL],
      useFactory: (pool: Pool) => patientNightscoutClientsFromEnv(pool, process.env) ?? UNCONFIGURED_NIGHTSCOUT_CLIENT,
    },
  ],
})
export class WorkerAppModule {}

/**
 * Guarded OpenAI provider for one model: its own pricing (`<prefix>_INPUT_PER_1K_TOKENS`, ...), the shared per-call cost
 * guard and the shared durable budget ledger, so every model's calls count against the same session budget.
 */
function buildGuardedProvider(configService: ConfigService, provider: 'openai' | 'anthropic', pricingPrefix: string, model: string): OpenAiProvider {
  const inputPrice = parseNullablePrice(configService.get(`${pricingPrefix}_INPUT_PER_1K_TOKENS`), `${pricingPrefix}_INPUT_PER_1K_TOKENS`);
  const outputPrice = parseNullablePrice(configService.get(`${pricingPrefix}_OUTPUT_PER_1K_TOKENS`), `${pricingPrefix}_OUTPUT_PER_1K_TOKENS`);
  const cachedInputPrice = parseNullablePrice(configService.get(`${pricingPrefix}_CACHED_INPUT_PER_1K_TOKENS`), `${pricingPrefix}_CACHED_INPUT_PER_1K_TOKENS`);
  const reasoningPrice = parseNullablePrice(configService.get(`${pricingPrefix}_REASONING_PER_1K_TOKENS`), `${pricingPrefix}_REASONING_PER_1K_TOKENS`);
  const pricingCurrency = parseNullableText(configService.get(`${pricingPrefix}_CURRENCY`));
  const pricingVersion = parseNullableText(configService.get(`${pricingPrefix}_VERSION`));

  const missingPricingKeys: string[] = [];
  if (inputPrice === null) missingPricingKeys.push(`${pricingPrefix}_INPUT_PER_1K_TOKENS`);
  if (outputPrice === null) missingPricingKeys.push(`${pricingPrefix}_OUTPUT_PER_1K_TOKENS`);
  if (cachedInputPrice === null) missingPricingKeys.push(`${pricingPrefix}_CACHED_INPUT_PER_1K_TOKENS`);
  if (reasoningPrice === null) missingPricingKeys.push(`${pricingPrefix}_REASONING_PER_1K_TOKENS`);
  if (!pricingCurrency) missingPricingKeys.push(`${pricingPrefix}_CURRENCY`);
  if (!pricingVersion) missingPricingKeys.push(`${pricingPrefix}_VERSION`);
  if (missingPricingKeys.length > 0) {
    throw new Error(
      `Missing required environment variables for priced ${provider} execution: ${missingPricingKeys.join(', ')}`,
    );
  }

  // validateWorkerEnvironment already refuses openai without these; re-checked here so the provider can never
  // be built without a cost guard.
  const maxCost = Number(configService.get('AI_EXPERIMENT_MAX_COST'));
  const costCurrency = parseNullableText(configService.get('AI_EXPERIMENT_COST_CURRENCY'));
  const maxOutputTokens = Number(configService.get('AI_EXPERIMENT_MAX_OUTPUT_TOKENS'));
  if (!(Number.isFinite(maxCost) && maxCost > 0) || !costCurrency || !(Number.isInteger(maxOutputTokens) && maxOutputTokens > 0)) {
    throw new Error('Missing or invalid AI cost guard: AI_EXPERIMENT_MAX_COST, AI_EXPERIMENT_COST_CURRENCY, AI_EXPERIMENT_MAX_OUTPUT_TOKENS');
  }
  if (costCurrency.toUpperCase() !== pricingCurrency?.toUpperCase()) {
    throw new Error(`AI_EXPERIMENT_COST_CURRENCY must match ${pricingPrefix}_CURRENCY`);
  }
  // Shared, durable experiment budget; read now so a missing or malformed ledger stops the worker at startup.
  const budgetLedger = new FileExperimentBudgetLedger(configService.getOrThrow<string>('AI_EXPERIMENT_BUDGET_LEDGER_PATH'));
  budgetLedger.read();

  const costGuard = { max_cost: maxCost, currency: costCurrency, max_output_tokens: maxOutputTokens };
  const timeoutMs = Number(configService.get<number>('OPENAI_TIMEOUT_MS') ?? 15_000);
  const evaluationCaptureFilePath = Boolean(configService.get<boolean>('OPENAI_EVAL_CAPTURE_ENABLED') ?? false)
    ? String(configService.get<string>('OPENAI_EVAL_CAPTURE_FILE_PATH') ?? '').trim() || null
    : null;
  if (provider === 'anthropic') {
    // The transport is wrapped by the same cost guard as the OpenAI client. ANTHROPIC_EFFORT replaces
    // OPENAI_REASONING_EFFORT; flex and prompt-cache markers are OpenAI-only. OPENAI_CHAINED_INPUT_BOUND applies to both:
    // a tool round chained on the previous response is bounded from its usage instead of a count_tokens request.
    return new OpenAiProvider({
      apiKey: '',
      providerName: 'anthropic',
      localChainedInputBound: parseChainedInputBound(configService.get('OPENAI_CHAINED_INPUT_BOUND')),
      // Optional: the refusal fallback's model prices (ANTHROPIC_FALLBACK_PRICING_*); unset = priced as the main model.
      fallbackPricing: process.env.ANTHROPIC_FALLBACK_PRICING_INPUT_PER_1K_TOKENS ? resolveOpenAiPricingFromEnv(process.env, 'ANTHROPIC_FALLBACK_PRICING') : null,
      costGuard,
      budgetLedger,
      model,
      timeoutMs,
      evaluationCaptureFilePath,
      pricing: {
        input_per_1k_tokens: inputPrice,
        output_per_1k_tokens: outputPrice,
        cached_input_per_1k_tokens: cachedInputPrice,
        reasoning_per_1k_tokens: reasoningPrice,
        currency: pricingCurrency,
        pricing_version: pricingVersion,
        // Optional: unset = 1.25x input, Claude's price for 5-minute cache writes.
        cache_write_per_1k_tokens: parseNullablePrice(configService.get(`${pricingPrefix}_CACHE_WRITE_PER_1K_TOKENS`), `${pricingPrefix}_CACHE_WRITE_PER_1K_TOKENS`),
      },
    }, createAnthropicResponsesTransport({
      apiKey: configService.getOrThrow<string>('ANTHROPIC_API_KEY'),
      effort: parseAnthropicEffort(configService.get('ANTHROPIC_EFFORT')),
      refusalFallback: parseAnthropicRefusalFallback(configService.get('ANTHROPIC_REFUSAL_FALLBACK')),
      answerTool: parseAnthropicSwitch(configService.get('ANTHROPIC_ANSWER_TOOL'), 'ANTHROPIC_ANSWER_TOOL'),
      // Unset = several tools per turn (owner 2026-10-26); 0 = one per turn, like OpenAI.
      parallelTools: parseAnthropicSwitch(configService.get('ANTHROPIC_PARALLEL_TOOLS'), 'ANTHROPIC_PARALLEL_TOOLS'),
    }));
  }

  return new OpenAiProvider({
    apiKey: configService.getOrThrow<string>('OPENAI_API_KEY'),
    costGuard,
    budgetLedger,
    // Validated by validateWorkerEnvironment (required in the single-call experiment, which openai requires).
    reasoningEffort: configService.get<OpenAiReasoningEffort>('OPENAI_REASONING_EFFORT') ?? null,
    promptCacheBreakpoints: Boolean(configService.get<boolean>('OPENAI_PROMPT_CACHE_BREAKPOINTS') ?? false),
    // One setting for every OpenAI call of the worker (main and light model, like the guarded clients built from env).
    serviceTier: parseOpenAiServiceTier(configService.get('OPENAI_SERVICE_TIER')),
    flexTimeoutMs: parseNullablePrice(configService.get('OPENAI_FLEX_TIMEOUT_MS'), 'OPENAI_FLEX_TIMEOUT_MS'),
    localChainedInputBound: parseChainedInputBound(configService.get('OPENAI_CHAINED_INPUT_BOUND')),
    model,
    timeoutMs,
    evaluationCaptureFilePath,
    pricing: {
      input_per_1k_tokens: inputPrice,
      output_per_1k_tokens: outputPrice,
      cached_input_per_1k_tokens: cachedInputPrice,
      reasoning_per_1k_tokens: reasoningPrice,
      currency: pricingCurrency,
      pricing_version: pricingVersion,
      // Optional: unset cache write price = 1.25x input; unset flex factor = priced as standard (never an undercount).
      cache_write_per_1k_tokens: parseNullablePrice(configService.get(`${pricingPrefix}_CACHE_WRITE_PER_1K_TOKENS`), `${pricingPrefix}_CACHE_WRITE_PER_1K_TOKENS`),
      flex_price_multiplier: parseNullablePrice(configService.get('OPENAI_FLEX_PRICE_MULTIPLIER'), 'OPENAI_FLEX_PRICE_MULTIPLIER'),
    },
  });
}
