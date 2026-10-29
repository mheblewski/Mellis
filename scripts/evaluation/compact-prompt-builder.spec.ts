import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

import * as fsPromises from 'node:fs/promises';
import * as productionPrompts from '@modules/ai-gateway/application/time-range-analysis-prompt';
import { CompactPromptBuilderUnavailableError, assertCompactPromptBuilderAvailable, buildCompactTimeRangeAnalysisPrompt } from './compact-prompt-builder';
import { main as payloadInspection } from './generate-evidence-payload-inspection';
import { main as tokenBenchmark } from './offline-time-range-token-minimization-benchmark';

const repoRoot = resolve(__dirname, '../..');
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'compact-prompt-builder-')));
const syntheticCapture = join(sandbox, 'synthetic-capture.ndjson');
writeFileSync(syntheticCapture, '{"synthetic":true}\n');

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
});

const tools = [
  ['generate-evidence-payload-inspection', payloadInspection, 'scripts/evaluation/generate-evidence-payload-inspection.ts'],
  ['offline-time-range-token-minimization-benchmark', tokenBenchmark, 'scripts/evaluation/offline-time-range-token-minimization-benchmark.ts'],
] as const;

describe('compact time-range prompt builder', () => {
  it('is not provided by the production prompt module (the tools must not silently use another builder)', () => {
    expect('buildCompactTimeRangeAnalysisPrompt' in productionPrompts).toBe(false);
    expect(typeof productionPrompts.buildTimeRangeAnalysisPrompt).toBe('function');
  });

  it('the fail-closed marker never builds a prompt', () => {
    expect(() => assertCompactPromptBuilderAvailable()).toThrow(CompactPromptBuilderUnavailableError);
    expect(() => buildCompactTimeRangeAnalysisPrompt({} as never, {} as never, {})).toThrow(CompactPromptBuilderUnavailableError);
  });

  it.each(tools)('%s resolves the compact builder from the fail-closed module only', (_name, _main, file) => {
    const source = readFileSync(join(repoRoot, file), 'utf8');
    expect(source).toMatch(/import \{[^}]*buildCompactTimeRangeAnalysisPrompt[^}]*\} from '\.\/compact-prompt-builder';/);
    expect(source).not.toMatch(/buildCompactTimeRangeAnalysisPrompt[^;]*from '@modules/);
    // The guard runs right after argument validation and before the capture is read.
    const body = source.slice(source.indexOf('export async function main('));
    expect(body.indexOf('assertCompactPromptBuilderAvailable()')).toBeGreaterThan(body.indexOf('requireInputFileArgument('));
    expect(body.indexOf('assertCompactPromptBuilderAvailable()')).toBeLessThan(body.indexOf('readFile('));
  });

  it('the token benchmark keeps the production full-prompt builder for variant A', () => {
    const source = readFileSync(join(repoRoot, 'scripts/evaluation/offline-time-range-token-minimization-benchmark.ts'), 'utf8');
    expect(source).toContain("import { buildTimeRangeAnalysisPrompt } from '@modules/ai-gateway/application/time-range-analysis-prompt';");
    expect(source).toContain('buildTimeRangeAnalysisPrompt(task, selected.context_package)');
  });

  it.each(tools)('%s fails closed before reading the capture and creates no output', async (_name, main) => {
    const outputDir = join(sandbox, `out-${_name}`);
    await expect(main([syntheticCapture, '--output-dir', outputDir])).rejects.toBeInstanceOf(CompactPromptBuilderUnavailableError);
    expect(fsPromises.readFile).not.toHaveBeenCalled();
    expect(existsSync(outputDir)).toBe(false);
    expect(readFileSync(syntheticCapture, 'utf8')).toBe('{"synthetic":true}\n');
  });
});
