import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findRepositoryRoot } from './evaluation-capture-path';

// No entry point may reach OpenAI around the cost guard: guarded-openai-client.ts is the only source that imports or
// constructs the SDK, and nothing calls the HTTP API directly. Spec files (which mock the SDK) are excluded.

const repoRoot = String(findRepositoryRoot(__dirname));
const GUARDED_MODULE = 'modules/ai-gateway/infrastructure/guarded-openai-client.ts';
const SOURCE_DIRS = ['apps', 'modules', 'infra', 'scripts', 'shared'];

function sourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|js|mjs|cjs)$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name) ? [path] : [];
  });
}

describe('OpenAI entry points', () => {
  const files = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(repoRoot, dir))).map((path) => relative(repoRoot, path));

  it('scans the production and script sources', () => {
    expect(files).toContain(GUARDED_MODULE);
    expect(files).toContain('modules/ai-gateway/infrastructure/openai-provider.ts');
    expect(files).toContain('scripts/dual-time-range-expanded-replay.ts');
  });

  it('only the guarded client imports or constructs the OpenAI SDK', () => {
    const offenders = files.filter((file) => file !== GUARDED_MODULE).filter((file) => {
      const source = readFileSync(join(repoRoot, file), 'utf8');
      return /from\s+['"]openai(\/[^'"]*)?['"]|require\(\s*['"]openai(\/[^'"]*)?['"]\s*\)|import\(\s*['"]openai|new\s+OpenAI\s*\(/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it('nothing calls the OpenAI HTTP API directly', () => {
    // The setup's key check lists models (GET /v1/models, free, no tokens): the one direct call allowed, and only that URL.
    const keyCheck = 'modules/ai-setup/ai-key-check.ts';
    const offenders = files.filter((file) => {
      const source = readFileSync(join(repoRoot, file), 'utf8');
      return file === keyCheck ? source.replaceAll("'https://api.openai.com/v1/models'", '').includes('api.openai.com') : source.includes('api.openai.com');
    });
    expect(offenders).toEqual([]);
    expect(readFileSync(join(repoRoot, keyCheck), 'utf8')).toContain("'https://api.openai.com/v1/models'");
  });

  it('exports no raw (unguarded) SDK client factory', async () => {
    const exported = Object.keys(await import('./guarded-openai-client')).sort();
    expect(exported).toEqual(['ON_OUTPUT_TEXT_OPTION', 'chainedInputTokenBound', 'createGuardedOpenAiClient', 'createGuardedOpenAiClientFromEnv', 'createGuardedOpenAiEmbeddingsClient', 'createGuardedOpenAiEmbeddingsClientFromEnv', 'createGuardedOpenAiSdkClient', 'createGuardedOpenAiTranscriber', 'createGuardedOpenAiTranscriberFromEnv', 'parseChainedInputBound', 'parseOpenAiServiceTier', 'resolveOpenAiCostGuardFromEnv', 'resolveOpenAiPricingFromEnv']);
    const source = readFileSync(join(repoRoot, GUARDED_MODULE), 'utf8');
    expect(source).toMatch(/^function createSdkTransport\(/m);
  });

  it('the guarded client builds the SDK only with retries disabled', () => {
    const source = readFileSync(join(repoRoot, GUARDED_MODULE), 'utf8');
    expect(source.match(/new OpenAI\(/g)).toHaveLength(1);
    expect(source).toContain('new OpenAI({ apiKey, maxRetries: 0 })');
  });
});
