import { describe, expect, it } from 'vitest';
import { deriveAiCapabilities } from './ai-capabilities';

describe('deriveAiCapabilities', () => {
  it('fake (the default) makes no paid call, whatever keys are set', () => {
    expect(deriveAiCapabilities({})).toEqual({
      provider: 'fake',
      openai_key: false,
      anthropic_key: false,
      paid_ai: false,
      embeddings: false,
      knowledge_search_mode: 'off',
      server_voice_transcription: false,
    });
    expect(deriveAiCapabilities({ AI_PROVIDER: ' ', OPENAI_API_KEY: 'sk' })).toMatchObject({ provider: 'fake', paid_ai: false, embeddings: false, knowledge_search_mode: 'off' });
  });

  it('a Claude key alone: answers on Claude, BM25 search, voice on the phone', () => {
    expect(deriveAiCapabilities({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant' })).toEqual({
      provider: 'anthropic',
      openai_key: false,
      anthropic_key: true,
      paid_ai: true,
      embeddings: false,
      knowledge_search_mode: 'bm25',
      server_voice_transcription: false,
    });
  });

  it('an OpenAI key alone: everything on OpenAI', () => {
    expect(deriveAiCapabilities({ AI_PROVIDER: 'OpenAI', OPENAI_API_KEY: 'sk' })).toEqual({
      provider: 'openai',
      openai_key: true,
      anthropic_key: false,
      paid_ai: true,
      embeddings: true,
      knowledge_search_mode: 'hybrid',
      server_voice_transcription: true,
    });
  });

  it('both keys (production): Claude answers, embeddings and voice stay on OpenAI', () => {
    expect(deriveAiCapabilities({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk' })).toMatchObject({
      provider: 'anthropic',
      embeddings: true,
      knowledge_search_mode: 'hybrid',
      server_voice_transcription: true,
    });
  });

  it('refuses a provider without its own key, naming the key and the way out', () => {
    expect(() => deriveAiCapabilities({ AI_PROVIDER: 'anthropic', OPENAI_API_KEY: 'sk' }))
      .toThrow('Missing required environment variable: ANTHROPIC_API_KEY (AI_PROVIDER=anthropic; with only an OpenAI key set AI_PROVIDER=openai)');
    expect(() => deriveAiCapabilities({ AI_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'sk-ant' }))
      .toThrow('Missing required environment variable: OPENAI_API_KEY (AI_PROVIDER=openai; with only a Claude key set AI_PROVIDER=anthropic)');
    expect(() => deriveAiCapabilities({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '   ' })).toThrow('ANTHROPIC_API_KEY');
    expect(() => deriveAiCapabilities({ AI_PROVIDER: 'gemini' })).toThrow('AI_PROVIDER must be fake, openai or anthropic');
  });
});
