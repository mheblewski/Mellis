import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EvaluationOutputDirError,
  describeErrorSafely,
  ensureEvaluationOutputDir,
  parseOutputDirArgument,
  positionalArguments,
  requireInputFileArgument,
  resolveEvaluationOutputDir,
  resolveEvaluationOutputFile,
  writeEvaluationOutputDirFile,
} from './evaluation-output-dir';

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'eval-output-dir-')));
const fakeRepo = join(sandbox, 'repo');
const otherRepo = join(sandbox, 'other-repo');
const outside = join(sandbox, 'outside');
mkdirSync(join(fakeRepo, 'artifacts', 'evaluation'), { recursive: true });
writeFileSync(join(fakeRepo, 'package.json'), '{}\n');
mkdirSync(join(otherRepo, '.git'), { recursive: true });
mkdirSync(outside, { recursive: true });

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const refused = (argv: string[]) => expect(() => resolveEvaluationOutputDir(argv, fakeRepo)).toThrow(EvaluationOutputDirError);

describe('parseOutputDirArgument', () => {
  it('accepts --output-dir <dir> and --output-dir=<dir>', () => {
    expect(parseOutputDirArgument(['--output-dir', '/tmp/x'])).toBe('/tmp/x');
    expect(parseOutputDirArgument(['--other', '1', '--output-dir=/tmp/y'])).toBe('/tmp/y');
  });

  it('refuses a missing, empty, flag-like or repeated value', () => {
    for (const argv of [[], ['--output-dir'], ['--output-dir', '--other'], ['--output-dir='], ['--output-dir', '   '], ['--output-dir', '/a', '--output-dir', '/b']]) {
      expect(() => parseOutputDirArgument(argv)).toThrow(EvaluationOutputDirError);
    }
  });
});

describe('resolveEvaluationOutputDir', () => {
  it('accepts an existing or not-yet-existing directory outside every working tree, creating nothing', () => {
    expect(resolveEvaluationOutputDir(['--output-dir', outside], fakeRepo)).toBe(outside);
    expect(resolveEvaluationOutputDir(['--output-dir', join(outside, 'new', 'run')], fakeRepo)).toBe(join(outside, 'new', 'run'));
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses the repository, artifacts/, another Git working tree, an alias into them and a file', () => {
    refused(['--output-dir', fakeRepo]);
    refused(['--output-dir', join(fakeRepo, 'artifacts', 'evaluation')]);
    refused(['--output-dir', `${outside}/../repo/artifacts`]);
    refused(['--output-dir', join(otherRepo, 'runs')]);
    const alias = join(outside, 'alias');
    symlinkSync(join(fakeRepo, 'artifacts'), alias);
    refused(['--output-dir', join(alias, 'evaluation')]);
    rmSync(alias);
    const file = join(outside, 'a-file');
    writeFileSync(file, 'x');
    refused(['--output-dir', file]);
    rmSync(file);
    expect(readdirSync(join(fakeRepo, 'artifacts', 'evaluation'))).toEqual([]);
  });

  it('refuses when the repository root is unknown', () => {
    expect(() => resolveEvaluationOutputDir(['--output-dir', outside], null)).toThrow(EvaluationOutputDirError);
  });
});

describe('ensureEvaluationOutputDir', () => {
  it('creates a validated directory with mode 0700 and refuses protected ones without creating them', () => {
    const created = ensureEvaluationOutputDir(join(outside, 'run-1'), fakeRepo);
    expect(statSync(created).isDirectory()).toBe(true);
    expect(statSync(created).mode & 0o077).toBe(0);
    expect(() => ensureEvaluationOutputDir(join(fakeRepo, 'artifacts', 'new-run'), fakeRepo)).toThrow(EvaluationOutputDirError);
    expect(readdirSync(join(fakeRepo, 'artifacts'))).toEqual(['evaluation']);
  });
});

describe('writeEvaluationOutputDirFile', () => {
  it('writes nested files 0600 in 0700 directories below the validated directory', () => {
    const file = writeEvaluationOutputDirFile(join(outside, 'nested-run'), 'run-1/variants/a.json', '{"synthetic":true}\n', fakeRepo);
    expect(file).toBe(join(outside, 'nested-run', 'run-1', 'variants', 'a.json'));
    expect(readFileSync(file, 'utf8')).toBe('{"synthetic":true}\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const dir of ['nested-run', 'nested-run/run-1', 'nested-run/run-1/variants']) expect(statSync(join(outside, dir)).mode & 0o077).toBe(0);
  });

  it('refuses names that leave the directory and protected directories, creating nothing there', () => {
    for (const name of ['../escape.json', '/abs.json', 'a//b.json', 'a/../../b.json']) {
      expect(() => writeEvaluationOutputDirFile(join(outside, 'confined'), name, 'x', fakeRepo)).toThrow(EvaluationOutputDirError);
    }
    expect(() => writeEvaluationOutputDirFile(join(fakeRepo, 'artifacts', 'evaluation'), 'r.json', 'x', fakeRepo)).toThrow(EvaluationOutputDirError);
    expect(() => writeEvaluationOutputDirFile(join(otherRepo, 'out'), 'r.json', 'x', fakeRepo)).toThrow(EvaluationOutputDirError);
    expect(readdirSync(join(fakeRepo, 'artifacts', 'evaluation'))).toEqual([]);
    expect(readdirSync(otherRepo)).toEqual(['.git']);
  });
});

describe('resolveEvaluationOutputFile', () => {
  it('accepts a new file outside every working tree without creating it', () => {
    const target = join(outside, 'file-run', 'report.json');
    expect(resolveEvaluationOutputFile(target, fakeRepo)).toBe(target);
    expect(readdirSync(outside)).not.toContain('file-run');
  });

  it('refuses missing, flag-like, protected, symlinked and non-file outputs', () => {
    for (const value of [undefined, '', '  ', '--since', join(fakeRepo, 'report.json'), join(fakeRepo, 'artifacts', 'evaluation', 'r.json'), join(otherRepo, 'r.json')]) {
      expect(() => resolveEvaluationOutputFile(value, fakeRepo)).toThrow(EvaluationOutputDirError);
    }
    const dir = join(outside, 'file-links');
    mkdirSync(dir);
    writeFileSync(join(dir, 'real.json'), 'original');
    symlinkSync(join(dir, 'real.json'), join(dir, 'link.json'));
    symlinkSync(join(fakeRepo, 'artifacts'), join(dir, 'alias'));
    expect(() => resolveEvaluationOutputFile(join(dir, 'link.json'), fakeRepo)).toThrow(EvaluationOutputDirError);
    expect(() => resolveEvaluationOutputFile(join(dir, 'alias', 'r.json'), fakeRepo)).toThrow(EvaluationOutputDirError);
    expect(() => resolveEvaluationOutputFile(dir, fakeRepo)).toThrow(EvaluationOutputDirError);
    expect(readFileSync(join(dir, 'real.json'), 'utf8')).toBe('original');
  });
});

describe('positionalArguments and requireInputFileArgument', () => {
  it('drops --output-dir and its value, keeps positionals and refuses unknown options', () => {
    expect(positionalArguments(['in.ndjson', '--output-dir', '/x'])).toEqual(['in.ndjson']);
    expect(positionalArguments(['--output-dir=/x', 'in.ndjson', 'more'])).toEqual(['in.ndjson', 'more']);
    expect(() => positionalArguments(['in.ndjson', '--ouput-dir', '/x'])).toThrow(EvaluationOutputDirError);
    expect(() => positionalArguments(['--output-dir', '/x'], [])).toThrow(EvaluationOutputDirError);
  });

  it('requires an explicit input', () => {
    expect(requireInputFileArgument('in.ndjson', 'capture')).toBe('in.ndjson');
    for (const value of [undefined, '', ' ']) expect(() => requireInputFileArgument(value, 'capture')).toThrow(EvaluationOutputDirError);
  });
});

describe('describeErrorSafely', () => {
  it('keeps guard messages and reduces other errors to class and code', () => {
    expect(describeErrorSafely(new EvaluationOutputDirError('Missing required --output-dir.'))).toBe('Missing required --output-dir.');
    const parse = new SyntaxError('Unexpected token in JSON at position 3: "SYNTHETIC-PATIENT-TEXT"');
    expect(describeErrorSafely(parse)).toBe('SyntaxError');
    const io = Object.assign(new Error('ENOENT: no such file, open \'/private/synthetic-home/capture.ndjson\''), { code: 'ENOENT' });
    expect(describeErrorSafely(io)).toBe('Error (code ENOENT)');
    class Safe extends Error {}
    expect(describeErrorSafely(new Safe('allowed'), [Safe])).toBe('allowed');
  });
});
