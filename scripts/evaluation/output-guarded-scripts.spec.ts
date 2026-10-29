import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// These scripts read real captures or the database. The tests only prove that unsafe or missing output arguments
// stop them first: pg and dotenv are replaced, inputs point at files that do not exist (reading one first would fail
// with a different error), and no test passes a complete valid argument set.
vi.mock('dotenv/config', () => ({}));
vi.mock('pg', () => ({ Pool: vi.fn() }));

import { Pool } from 'pg';
import { EvaluationOutputDirError } from './evaluation-output-dir';
import { main as rubric } from './time-range-answer-rubric';
import { main as chainedReplay } from './chained-tool-results-offline-replay';
import { main as payloadInspection } from './generate-evidence-payload-inspection';
import { main as tokenBenchmark } from './offline-time-range-token-minimization-benchmark';
import { main as multiRangeValidation } from '../research/multi-range-local-evidence-validation';

const repoRoot = resolve(__dirname, '../..');
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'output-guarded-scripts-')));
const otherWorktree = join(sandbox, 'other-worktree');
mkdirSync(join(otherWorktree, '.git'), { recursive: true });
const aliasIntoRepo = join(sandbox, 'alias-into-repo');
symlinkSync(repoRoot, aliasIntoRepo);
const missingInput = join(sandbox, 'does-not-exist.ndjson');
const validOutputDir = join(sandbox, 'valid-but-unused');

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const artifactsExisted = existsSync(join(repoRoot, 'artifacts'));
beforeEach(() => {
  vi.clearAllMocks();
});

function expectNoSideEffects() {
  expect(Pool).not.toHaveBeenCalled();
  expect(existsSync(join(repoRoot, 'artifacts'))).toBe(artifactsExisted);
  expect(readdirSync(otherWorktree)).toEqual(['.git']);
  expect(existsSync(validOutputDir)).toBe(false);
  expect(readdirSync(sandbox).sort()).toEqual(['alias-into-repo', 'other-worktree']);
}

const unsafeDirs: Array<[string, string[]]> = [
  ['no --output-dir', []],
  ['--output-dir without a value', ['--output-dir']],
  ['the repository root', ['--output-dir', repoRoot]],
  ['the repository artifacts/ directory', ['--output-dir', join(repoRoot, 'artifacts', 'evaluation')]],
  ['another Git working tree', ['--output-dir', join(otherWorktree, 'out')]],
  ['a symlink alias into the repository', ['--output-dir', join(aliasIntoRepo, 'out')]],
];

const unsafeFiles: Array<[string, string | undefined]> = [
  ['no output file', undefined],
  ['a file in the repository', join(repoRoot, 'report.json')],
  ['a file in artifacts/', join(repoRoot, 'artifacts', 'evaluation', 'report.json')],
  ['a file in another Git working tree', join(otherWorktree, 'report.json')],
  ['a file through a symlink alias into the repository', join(aliasIntoRepo, 'report.json')],
];

describe.each([
  ['multi-range-local-evidence-validation', multiRangeValidation],
  ['generate-evidence-payload-inspection', payloadInspection],
  ['offline-time-range-token-minimization-benchmark', tokenBenchmark],
] as const)('%s: --output-dir and input are explicit and validated before the input is read', (_name, main) => {
  it.each(unsafeDirs)('refuses %s', async (_label, dirArgs) => {
    await expect(main([missingInput, ...dirArgs])).rejects.toBeInstanceOf(EvaluationOutputDirError);
    expectNoSideEffects();
  });

  it('refuses a missing input instead of falling back to a default capture', async () => {
    await expect(main(['--output-dir', validOutputDir])).rejects.toBeInstanceOf(EvaluationOutputDirError);
    expectNoSideEffects();
  });

  it('refuses unknown options', async () => {
    await expect(main([missingInput, '--output-dir', validOutputDir, '--ouput-dir', validOutputDir])).rejects.toBeInstanceOf(EvaluationOutputDirError);
    expectNoSideEffects();
  });
});

describe.each([
  ['time-range-answer-rubric', (out: string | undefined) => rubric(out === undefined ? [] : [out, '2026-01-01T00:00:00Z'])],
  ['chained-tool-results-offline-replay', (out: string | undefined) => chainedReplay(out === undefined ? [] : [out, missingInput])],
] as const)('%s: the output file is validated before the database or any capture is read', (_name, run) => {
  it.each(unsafeFiles)('refuses %s', async (_label, out) => {
    await expect(run(out)).rejects.toBeInstanceOf(EvaluationOutputDirError);
    expectNoSideEffects();
  });
});

describe('chained-tool-results-offline-replay', () => {
  it('requires at least one capture file', async () => {
    await expect(chainedReplay([join(sandbox, 'out.json')])).rejects.toBeInstanceOf(EvaluationOutputDirError);
    expectNoSideEffects();
  });
});

describe('hardened script sources', () => {
  const files = [
    'scripts/evaluation/time-range-answer-rubric.ts',
    'scripts/evaluation/chained-tool-results-offline-replay.ts',
    'scripts/evaluation/generate-evidence-payload-inspection.ts',
    'scripts/evaluation/offline-time-range-token-minimization-benchmark.ts',
    'scripts/research/multi-range-local-evidence-validation.ts',
    'scripts/evaluation/rag-knowledge-probe.ts',
    'scripts/evaluation/rag-corpus-ingest.ts',
    'scripts/evaluation/rag-assistant-live-check.ts',
  ];

  it.each(files)('%s has no default artifacts/ path, no unguarded write and no stack or raw error output', (file) => {
    const source = readFileSync(join(repoRoot, file), 'utf8');
    expect(source).not.toMatch(/['"`]artifacts\//);
    expect(source).not.toMatch(/'artifacts'/);
    expect(source).not.toContain('REPLAY_OUTPUT_DIR ??');
    expect(source).not.toMatch(/\b(writeFileSync|appendFileSync|createWriteStream|mkdirSync|rmSync)\s*\(/);
    expect(source).not.toMatch(/await (writeFile|appendFile|mkdir|rm)\(/);
    expect(source).not.toMatch(/\.stack\b/);
    expect(source).not.toMatch(/console\.error\(error\)/);
    expect(source).toContain('require.main === module');
  });
});
