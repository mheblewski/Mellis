/**
 * Tests run offline by default: `.env` is loaded by vitest.config.ts and may select paid or real providers
 * (AI_PROVIDER=openai, PUSH_PROVIDER=apns). Unless ALLOW_LIVE_AI=1 is set deliberately (only
 * scripts/run-e2e-first-slice-openai.ts does), every provider switch is forced to fake and the OpenAI key is
 * removed, so neither E2E_AI_PROVIDER nor a leftover .env value can start a paid call.
 */
export const LIVE_AI_OPT_IN_VARIABLE = 'ALLOW_LIVE_AI';

export function configureOfflineProviderEnvironment(env: NodeJS.ProcessEnv): { live_ai_allowed: boolean } {
  // Real pushes are never allowed from tests.
  env.PUSH_PROVIDER = 'fake';

  if (env[LIVE_AI_OPT_IN_VARIABLE] === '1') {
    return { live_ai_allowed: true };
  }

  env.AI_PROVIDER = 'fake';
  env.E2E_AI_PROVIDER = 'fake';
  env.AI_EVAL_PROVIDER = 'fake';
  delete env.OPENAI_API_KEY;
  return { live_ai_allowed: false };
}
