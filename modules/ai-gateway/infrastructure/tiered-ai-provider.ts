import type { AiModelTier, AiProvider, AiProviderInput, AiProviderResponse } from '@modules/ai-gateway/domain/ai-gateway';

/**
 * Sends each provider call to the main (DEEP) or the light model according to input.model_tier. Both providers are
 * guarded on their own (pricing, per-call cost guard) and share the same budget ledger.
 */
export class TieredAiProvider implements AiProvider {
  constructor(private readonly deep: AiProvider, private readonly light: AiProvider) {}

  /** Identity of the main tier (the default), read when an attempt starts, before the tier is chosen. */
  get providerName(): string {
    return describeTierProvider(this.deep).provider;
  }

  get model(): string {
    return describeTierProvider(this.deep).model;
  }

  /** Identity of the provider a call of this tier goes to. */
  describeTier(tier: AiModelTier | undefined): { provider: string; model: string } {
    return describeTierProvider(tier === 'LIGHT' ? this.light : this.deep);
  }

  generate(input: AiProviderInput): Promise<AiProviderResponse> {
    return (input.model_tier === 'LIGHT' ? this.light : this.deep).generate(input);
  }
}

function describeTierProvider(provider: AiProvider): { provider: string; model: string } {
  // OpenAiProvider keeps its model in a TypeScript-private field: read at runtime like the gateway does.
  const maybe = provider as unknown as Partial<{ providerName: string; provider_name: string; model: string; model_name: string }>;
  return {
    provider: maybe.providerName ?? maybe.provider_name ?? 'unknown',
    model: maybe.model ?? maybe.model_name ?? 'unknown',
  };
}
