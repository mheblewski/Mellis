import { describe, expect, it, vi } from 'vitest';
import { AiKeyCheckError, checkAiSetup, parseAiSetupInput } from './ai-key-check';

/** Answers the model lists: keys starting with "good" are valid. No network. */
function fakeFetch(down: string[] = []) {
  return vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
    if (down.some((host) => url.includes(host))) throw new Error('ECONNREFUSED');
    const key = init.headers['x-api-key'] ?? init.headers.Authorization?.replace('Bearer ', '') ?? '';
    return { status: key.startsWith('good') ? 200 : 401 };
  });
}

describe('setup AI step: provider, keys, free checks', () => {
  it('Claude alone: one check, word-only search and voice on the phone', async () => {
    const fetch = fakeFetch();
    const result = await checkAiSetup(parseAiSetupInput({ provider: 'anthropic', api_key: 'good-claude' }), fetch);
    expect(result.env).toEqual({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'good-claude' });
    expect(result.capabilities).toMatchObject({ knowledge_search_mode: 'bm25', server_voice_transcription: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models?limit=1');
  });

  it('Claude with the optional OpenAI key: both checked, hybrid search and server voice', async () => {
    const result = await checkAiSetup(parseAiSetupInput({ provider: 'claude', api_key: 'good-claude', openai_api_key: 'good-openai' }), fakeFetch());
    expect(result.env).toEqual({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'good-claude', OPENAI_API_KEY: 'good-openai' });
    expect(result.checked).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    expect(result.capabilities).toMatchObject({ knowledge_search_mode: 'hybrid', server_voice_transcription: true });
  });

  it('OpenAI: its one key covers search and voice, no second key asked or used', async () => {
    const fetch = fakeFetch();
    const result = await checkAiSetup(parseAiSetupInput({ provider: 'openai', api_key: 'good-openai', openai_api_key: 'other' }), fetch);
    expect(result.env).toEqual({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'good-openai' });
    expect(result.capabilities).toMatchObject({ knowledge_search_mode: 'hybrid', server_voice_transcription: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('names the failing key', async () => {
    await expect(checkAiSetup(parseAiSetupInput({ provider: 'anthropic', api_key: 'good-claude', openai_api_key: 'bad' }), fakeFetch()))
      .rejects.toMatchObject({ code: 'AI_KEY_INVALID', key: 'OPENAI_API_KEY' });
    await expect(checkAiSetup(parseAiSetupInput({ provider: 'anthropic', api_key: 'bad', openai_api_key: 'bad' }), fakeFetch()))
      .rejects.toMatchObject({ code: 'AI_KEY_INVALID', key: 'ANTHROPIC_API_KEY' });
    await expect(checkAiSetup(parseAiSetupInput({ provider: 'openai', api_key: 'good-openai' }), fakeFetch(['openai.com'])))
      .rejects.toMatchObject({ code: 'AI_KEY_UNREACHABLE', key: 'OPENAI_API_KEY' });
    expect(() => parseAiSetupInput({ provider: 'gemini', api_key: 'x' })).toThrow(AiKeyCheckError);
    expect(() => parseAiSetupInput({ provider: 'openai', api_key: ' ' })).toThrow('AI_KEY_MISSING: OPENAI_API_KEY');
  });
});
