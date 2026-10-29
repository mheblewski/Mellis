import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EvaluationCapturePathError,
  appendEvaluationCaptureLine,
  assertEvaluationCaptureOutsideRepository,
  describePath,
  findRepositoryRoot,
  writeEvaluationOutputFile,
} from './evaluation-capture-path';
import { OpenAiProvider } from './openai-provider';

// Everything happens in a throwaway temp directory: a fake repository (package.json, no .git), two other Git working
// trees (a .git directory and a worktree-style .git file) and a plain directory outside all of them.
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'capture-path-guard-')));
const fakeRepo = join(sandbox, 'repo');
const otherRepo = join(sandbox, 'other-repo');
const otherWorktree = join(sandbox, 'other-worktree');
const outside = join(sandbox, 'outside');
mkdirSync(join(fakeRepo, 'artifacts', 'evaluation'), { recursive: true });
writeFileSync(join(fakeRepo, 'package.json'), '{}\n');
mkdirSync(join(otherRepo, '.git'), { recursive: true });
mkdirSync(join(otherRepo, 'artifacts'), { recursive: true });
mkdirSync(otherWorktree, { recursive: true });
writeFileSync(join(otherWorktree, '.git'), 'gitdir: /nonexistent/worktrees/x\n');
mkdirSync(outside, { recursive: true });

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const refuses = (path: string, root: string | null = fakeRepo) =>
  expect(() => assertEvaluationCaptureOutsideRepository(path, root)).toThrow(EvaluationCapturePathError);

function freshDir(name: string): string {
  const dir = join(outside, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('evaluation capture path guard: classification', () => {
  it('accepts a destination outside every Git working tree, without creating it', () => {
    const target = join(outside, 'not-yet', 'capture.ndjson');
    expect(assertEvaluationCaptureOutsideRepository(target, fakeRepo)).toBe(target);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses the repository root and anything below it, artifacts/ included', () => {
    refuses(fakeRepo);
    refuses(join(fakeRepo, 'capture.ndjson'));
    refuses(join(fakeRepo, 'artifacts', 'evaluation', 'capture.ndjson'));
    refuses(join(fakeRepo, 'artifacts', 'new-dir', 'deeper', 'capture.ndjson'));
  });

  it('refuses destinations inside other Git working trees (.git directory and worktree .git file)', () => {
    refuses(join(otherRepo, 'capture.ndjson'));
    refuses(join(otherRepo, 'artifacts', 'not-yet', 'capture.ndjson'));
    refuses(otherWorktree);
    refuses(join(otherWorktree, 'artifacts', 'capture.ndjson'));
  });

  it('refuses a relative path that resolves inside the repository', () => {
    refuses(relative(process.cwd(), join(fakeRepo, 'artifacts', 'capture.ndjson')));
  });

  it('refuses paths that leave and re-enter a protected tree through ..', () => {
    refuses(`${outside}/../${basename(fakeRepo)}/artifacts/capture.ndjson`);
    refuses(`${fakeRepo}/artifacts/../../${basename(fakeRepo)}/capture.ndjson`);
    refuses(`${outside}/missing/../../${basename(otherRepo)}/capture.ndjson`);
  });

  it('refuses symlinked aliases that resolve into a protected tree', () => {
    const intoRepo = join(outside, 'alias-repo');
    const intoOther = join(outside, 'alias-other');
    symlinkSync(fakeRepo, intoRepo);
    symlinkSync(join(otherRepo, 'artifacts'), intoOther);
    refuses(join(intoRepo, 'capture.ndjson'));
    refuses(join(intoRepo, 'artifacts', 'not-yet', 'capture.ndjson'));
    refuses(join(intoOther, 'capture.ndjson'));
    rmSync(intoRepo);
    rmSync(intoOther);
  });

  it('fails closed on a dangling symlink, an unknown root and a file used as a directory', () => {
    const dangling = join(outside, 'dangling.ndjson');
    symlinkSync(join(fakeRepo, 'artifacts', 'missing-target.ndjson'), dangling);
    refuses(dangling);
    rmSync(dangling);
    refuses(join(outside, 'capture.ndjson'), null);
    const file = join(outside, 'plain-file');
    writeFileSync(file, 'x');
    refuses(join(file, 'capture.ndjson'));
    rmSync(file);
  });

  it('finds the repository root as the nearest ancestor with package.json', () => {
    expect(findRepositoryRoot(join(fakeRepo, 'artifacts', 'evaluation'))).toBe(fakeRepo);
    expect(findRepositoryRoot(outside)).toBe(null);
  });

  it('keeps the local home directory out of messages', () => {
    expect(describePath(join(homedir(), 'x', 'y'))).toBe(join('~', 'x', 'y'));
    for (const path of [join(fakeRepo, 'artifacts', 'capture.ndjson'), join(otherRepo, 'capture.ndjson')]) {
      try {
        assertEvaluationCaptureOutsideRepository(path, fakeRepo);
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(EvaluationCapturePathError);
        expect((error as Error).message).not.toContain(homedir());
      }
    }
  });
});

describe('evaluation capture path guard: write-time validation', () => {
  it('appends lines unchanged to a new 0600 file in a new 0700 directory', () => {
    const target = join(outside, 'write-ok', 'nested', 'capture.ndjson');
    appendEvaluationCaptureLine(target, '{"a":1}\n', fakeRepo);
    appendEvaluationCaptureLine(target, '{"b":2}\n', fakeRepo);
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}\n{"b":2}\n');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(statSync(join(outside, 'write-ok', 'nested')).mode & 0o077).toBe(0);
  });

  it('refuses an existing symlink as the final component, leaving its target untouched', () => {
    const dir = freshDir('write-symlink');
    const protectedFile = join(fakeRepo, 'artifacts', 'protected.ndjson');
    writeFileSync(protectedFile, 'original\n');
    symlinkSync(protectedFile, join(dir, 'capture.ndjson'));
    expect(() => appendEvaluationCaptureLine(join(dir, 'capture.ndjson'), 'leak\n', fakeRepo)).toThrow(EvaluationCapturePathError);
    expect(readFileSync(protectedFile, 'utf8')).toBe('original\n');
  });

  it('refuses any symlink as the final component via O_NOFOLLOW, even one pointing outside', () => {
    const dir = freshDir('write-nofollow');
    const elsewhere = join(dir, 'elsewhere.ndjson');
    writeFileSync(elsewhere, 'original\n');
    symlinkSync(elsewhere, join(dir, 'capture.ndjson'));
    expect(() => appendEvaluationCaptureLine(join(dir, 'capture.ndjson'), 'redirected\n', fakeRepo)).toThrow(/symlink/);
    expect(readFileSync(elsewhere, 'utf8')).toBe('original\n');
  });

  it('refuses a hard link to a protected file, leaving it untouched', () => {
    const dir = freshDir('write-hardlink');
    const protectedFile = join(otherRepo, 'artifacts', 'protected.ndjson');
    writeFileSync(protectedFile, 'original\n');
    linkSync(protectedFile, join(dir, 'capture.ndjson'));
    expect(() => appendEvaluationCaptureLine(join(dir, 'capture.ndjson'), 'leak\n', fakeRepo)).toThrow(EvaluationCapturePathError);
    expect(readFileSync(protectedFile, 'utf8')).toBe('original\n');
  });

  it('re-validates at write time when a directory was swapped for a symlink after construction', () => {
    const fakeClient = { responses: { create: async () => { throw new Error('not used'); } } } as never;
    const dir = freshDir('write-swap');
    const target = join(dir, 'capture.ndjson');
    // Constructor-time check passes (outside), then the directory is replaced by a symlink into a Git working tree.
    expect(() => new OpenAiProvider({ apiKey: 'test-key', evaluationCaptureFilePath: target }, fakeClient)).not.toThrow();
    renameSync(dir, `${dir}-moved`);
    symlinkSync(join(otherRepo, 'artifacts'), dir);
    expect(() => appendEvaluationCaptureLine(target, 'leak\n', fakeRepo)).toThrow(EvaluationCapturePathError);
    expect(readdirSync(join(otherRepo, 'artifacts')).filter((name) => name === 'capture.ndjson')).toEqual([]);
  });
});

describe('evaluation output file guard: replace writes', () => {
  it('creates a 0600 file, replaces its content on rewrite and resets a looser mode', () => {
    const target = join(outside, 'replace-ok', 'nested', 'report.md');
    writeEvaluationOutputFile(target, 'first, longer content\n', fakeRepo);
    writeEvaluationOutputFile(target, 'second\n', fakeRepo);
    expect(readFileSync(target, 'utf8')).toBe('second\n');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    chmodSync(target, 0o644);
    writeEvaluationOutputFile(target, 'third\n', fakeRepo);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(statSync(join(outside, 'replace-ok', 'nested')).mode & 0o077).toBe(0);
  });

  it('refuses the repository, other working trees, a symlinked leaf and a hard link without touching the targets', () => {
    expect(() => writeEvaluationOutputFile(join(fakeRepo, 'artifacts', 'report.md'), 'x', fakeRepo)).toThrow(EvaluationCapturePathError);
    expect(() => writeEvaluationOutputFile(join(otherWorktree, 'report.md'), 'x', fakeRepo)).toThrow(EvaluationCapturePathError);
    expect(readdirSync(join(fakeRepo, 'artifacts'))).not.toContain('report.md');
    const dir = freshDir('replace-links');
    const symTarget = join(dir, 'elsewhere.md');
    writeFileSync(symTarget, 'original\n');
    symlinkSync(symTarget, join(dir, 'via-symlink.md'));
    expect(() => writeEvaluationOutputFile(join(dir, 'via-symlink.md'), 'replaced\n', fakeRepo)).toThrow(/symlink/);
    expect(readFileSync(symTarget, 'utf8')).toBe('original\n');
    const protectedFile = join(otherRepo, 'artifacts', 'protected-report.md');
    writeFileSync(protectedFile, 'original\n');
    linkSync(protectedFile, join(dir, 'via-hardlink.md'));
    // Not truncated: the single-link check runs before any truncation.
    expect(() => writeEvaluationOutputFile(join(dir, 'via-hardlink.md'), 'replaced\n', fakeRepo)).toThrow(EvaluationCapturePathError);
    expect(readFileSync(protectedFile, 'utf8')).toBe('original\n');
  });
});

describe('OpenAiProvider evaluation capture destination', () => {
  const fakeClient = { responses: { create: async () => { throw new Error('not used'); } } } as never;
  const repoRoot = resolve(__dirname, '../../..');

  it('refuses a capture path inside this repository at construction', () => {
    expect(() => new OpenAiProvider({ apiKey: 'test-key', evaluationCaptureFilePath: join(repoRoot, 'artifacts', 'evaluation', 'capture.ndjson') }, fakeClient))
      .toThrow(EvaluationCapturePathError);
  });

  it('accepts a capture path outside every working tree and keeps capture off when unset, creating nothing', () => {
    const target = join(outside, 'provider-ok', 'capture.ndjson');
    expect(() => new OpenAiProvider({ apiKey: 'test-key', evaluationCaptureFilePath: target }, fakeClient)).not.toThrow();
    expect(() => new OpenAiProvider({ apiKey: 'test-key' }, fakeClient)).not.toThrow();
    expect(readdirSync(outside)).not.toContain('provider-ok');
  });
});
