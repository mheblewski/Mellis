import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The reconstruction scripts read real records. These tests only prove that bad arguments stop them before the
// database: pg is replaced, and no test passes a complete valid argument set to main().
vi.mock('pg', () => ({ Pool: vi.fn() }));

import { Pool } from 'pg';
import { EvaluationOutputDirError } from '../evaluation/evaluation-output-dir';
import { ReconstructionArgumentError } from './reconstruction-cli';
import { STALE_FIGURES } from './reconstruction-fixtures';
import { main as stage1 } from '../reconstruction-stage-1-recover';
import { main as stage2 } from '../reconstruction-stage-2-build';
import { main as stage2b } from '../reconstruction-stage-2b-analysis';
import { main as finalReport } from '../reconstruction-final-report';

const repoRoot = resolve(__dirname, '../..');
const scriptsDir = resolve(__dirname, '..');
// The legacy /tmp/glucomind-reconstruction directory is deliberately never touched here, not even its metadata; the
// source checks below prove the scripts no longer reference it, and test runs deny all access to it at the OS level.
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'reconstruction-scripts-')));
const otherWorktree = join(sandbox, 'other-worktree');
mkdirSync(join(otherWorktree, '.git'), { recursive: true });
const validOutputDir = join(sandbox, 'valid-but-unused');

// A checkout may already hold artifacts/ from earlier work; the scripts must leave it exactly as found.
const artifactsDir = join(repoRoot, 'artifacts');
function snapshotArtifacts(): string[] {
  if (!existsSync(artifactsDir)) return [];
  return readdirSync(artifactsDir, { recursive: true, encoding: 'utf8' })
    .map((path) => {
      const stats = statSync(join(artifactsDir, path));
      return `${path} ${stats.isDirectory() ? 'dir' : `${stats.size} ${stats.mtimeMs}`}`;
    })
    .sort();
}
const artifactsBefore = snapshotArtifacts();

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const executionId = randomUUID();
const badExecutionIds: Array<[string, string[]]> = [
  ['a missing --execution-id', []],
  ['--execution-id without a value', ['--execution-id']],
  ['a malformed --execution-id', ['--execution-id', 'not-a-uuid']],
];
const badOutputDirs: Array<[string, string[]]> = [
  ['a missing --output-dir', []],
  ['--output-dir without a value', ['--output-dir']],
  ['the repository artifacts/ directory', ['--output-dir', join(repoRoot, 'artifacts', 'reconstruction')]],
  ['the repository root', ['--output-dir', repoRoot]],
  ['another Git working tree', ['--output-dir', join(otherWorktree, 'reconstruction')]],
];

const writingScripts = [
  ['reconstruction-stage-2-build', stage2],
  ['reconstruction-stage-2b-analysis', stage2b],
  ['reconstruction-final-report', finalReport],
] as const;

describe('reconstruction scripts validate arguments before database access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function expectNoSideEffects() {
    expect(Pool).not.toHaveBeenCalled();
    expect(existsSync(validOutputDir)).toBe(false);
    expect(snapshotArtifacts()).toEqual(artifactsBefore);
    expect(readdirSync(otherWorktree)).toEqual(['.git']);
  }

  it.each(badExecutionIds)('reconstruction-stage-1-recover stops on %s', async (_label, argv) => {
    await expect(stage1(argv)).rejects.toBeInstanceOf(ReconstructionArgumentError);
    expectNoSideEffects();
  });

  describe.each(writingScripts)('%s', (_name, main) => {
    it.each(badExecutionIds)('stops on %s', async (_label, argv) => {
      await expect(main([...argv, '--output-dir', validOutputDir])).rejects.toBeInstanceOf(ReconstructionArgumentError);
      expectNoSideEffects();
    });

    it.each(badOutputDirs)('stops on %s', async (_label, argv) => {
      await expect(main(['--execution-id', executionId, ...argv])).rejects.toBeInstanceOf(EvaluationOutputDirError);
      expectNoSideEffects();
    });
  });
});

describe('reconstruction report builder source', () => {
  it('embeds none of the 2026-10-09 figures', () => {
    const source = readFileSync(join(__dirname, 'reconstruction-report.ts'), 'utf8');
    for (const stale of STALE_FIGURES) expect(source).not.toContain(stale);
  });
});

describe('reconstruction script sources', () => {
  const sources = readdirSync(scriptsDir)
    .filter((name) => /^reconstruction-.*\.ts$/.test(name) && !name.endsWith('.spec.ts'))
    .map((name) => [name, readFileSync(join(scriptsDir, name), 'utf8')] as const);

  it('covers all four scripts', () => {
    expect(sources.map(([name]) => name).sort()).toEqual([
      'reconstruction-final-report.ts',
      'reconstruction-stage-1-recover.ts',
      'reconstruction-stage-2-build.ts',
      'reconstruction-stage-2b-analysis.ts',
    ]);
  });

  it.each(sources)('%s embeds no record identifiers and has no default or unguarded output', (_name, source) => {
    expect(source).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(source).not.toContain('glucomind-reconstruction');
    expect(source).not.toMatch(/['"`]\/tmp\b/);
    expect(source).not.toMatch(/\b(writeFileSync|appendFileSync|createWriteStream|mkdirSync|writeFile|appendFile|mkdir)\s*\(/);
    // Figures from the 2026-10-09 investigation are not embedded as values (the report builder computes them).
    for (const stale of STALE_FIGURES) expect(source).not.toContain(stale);
    // Stdout never dumps whole rows or their content.
    expect(source).not.toMatch(/JSON\.stringify\((exec|pkg|job|message|conversation)\b/);
    expect(source).not.toMatch(/\$\{(message|m|msg)\.content/);
    // Arguments are parsed before the pool exists.
    const parse = source.search(/parse(ExecutionIdArgument|ReconstructionArguments)\(argv\)/);
    expect(parse).toBeGreaterThan(-1);
    expect(parse).toBeLessThan(source.indexOf('new Pool('));
  });
});
