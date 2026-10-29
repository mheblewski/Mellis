import { describe, expect, it } from 'vitest';
import { configureOfflineProviderEnvironment } from './offline-providers';

describe('offline provider environment for tests', () => {
  it('forces fake AI and fake push even when .env or the shell select real providers', () => {
    const env: NodeJS.ProcessEnv = {
      AI_PROVIDER: 'openai',
      E2E_AI_PROVIDER: 'openai',
      AI_EVAL_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-live',
      PUSH_PROVIDER: 'apns',
    };

    expect(configureOfflineProviderEnvironment(env)).toEqual({ live_ai_allowed: false });
    expect(env).toEqual({ AI_PROVIDER: 'fake', E2E_AI_PROVIDER: 'fake', AI_EVAL_PROVIDER: 'fake', PUSH_PROVIDER: 'fake' });
  });

  it('keeps live AI only with the explicit ALLOW_LIVE_AI=1 opt-in, and never allows real pushes', () => {
    const env: NodeJS.ProcessEnv = { ALLOW_LIVE_AI: '1', E2E_AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-live', PUSH_PROVIDER: 'apns' };

    expect(configureOfflineProviderEnvironment(env)).toEqual({ live_ai_allowed: true });
    expect(env.E2E_AI_PROVIDER).toBe('openai');
    expect(env.OPENAI_API_KEY).toBe('sk-live');
    expect(env.PUSH_PROVIDER).toBe('fake');
  });

  it('is applied by the vitest setup to this very process', () => {
    if (process.env.ALLOW_LIVE_AI === '1') return;
    expect(process.env.AI_PROVIDER).toBe('fake');
    expect(process.env.E2E_AI_PROVIDER).toBe('fake');
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.PUSH_PROVIDER).toBe('fake');
  });
});
