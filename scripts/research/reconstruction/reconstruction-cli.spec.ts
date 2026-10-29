import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EvaluationOutputDirError } from '../../evaluation/evaluation-output-dir';
import {
  ReconstructionArgumentError,
  deriveTimeRangeExecutionIdentifiers,
  parseExecutionIdArgument,
  parseReconstructionArguments,
  writeReconstructionOutput,
} from './reconstruction-cli';

const repoRoot = resolve(__dirname, '../../..');
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'reconstruction-cli-')));
const otherWorktree = join(sandbox, 'other-worktree');
mkdirSync(join(otherWorktree, '.git'), { recursive: true });

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// Synthetic identifiers only, generated per run.
const executionId = randomUUID();

describe('parseExecutionIdArgument', () => {
  it('accepts exactly one UUID, in either form, lower-cased', () => {
    expect(parseExecutionIdArgument(['--execution-id', executionId])).toBe(executionId);
    expect(parseExecutionIdArgument([`--execution-id=${executionId.toUpperCase()}`])).toBe(executionId);
  });

  it('refuses a missing, empty, flag-like, repeated or malformed value without echoing it', () => {
    const cases = [
      [],
      ['--execution-id'],
      ['--execution-id', '--output-dir'],
      ['--execution-id='],
      ['--execution-id', executionId, '--execution-id', randomUUID()],
      ['--execution-id', 'not-a-uuid'],
      ['--execution-id', `${executionId}x`],
      ['--execution-id', `'; DROP TABLE ai_executions; --`],
    ];
    for (const argv of cases) {
      expect(() => parseExecutionIdArgument(argv)).toThrow(ReconstructionArgumentError);
    }
    try {
      parseExecutionIdArgument(['--execution-id', 'secret-looking-value']);
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-looking-value');
    }
  });
});

describe('parseReconstructionArguments', () => {
  it('accepts a temporary output directory outside every working tree without creating it', () => {
    const outputDir = join(sandbox, 'valid', 'run-1');
    expect(parseReconstructionArguments(['--execution-id', executionId, '--output-dir', outputDir])).toEqual({ executionId, outputDir });
    expect(readdirSync(sandbox)).toEqual(['other-worktree']);
  });

  it('refuses a missing or unsafe output directory', () => {
    const unsafe = [
      [],
      ['--output-dir'],
      ['--output-dir', repoRoot],
      ['--output-dir', join(repoRoot, 'artifacts', 'reconstruction')],
      ['--output-dir', join(otherWorktree, 'reconstruction')],
    ];
    for (const extra of unsafe) {
      expect(() => parseReconstructionArguments(['--execution-id', executionId, ...extra])).toThrow(EvaluationOutputDirError);
    }
    expect(readdirSync(otherWorktree)).toEqual(['.git']);
  });
});

describe('writeReconstructionOutput', () => {
  it('creates the directory 0700 and the file 0600 through the guard', () => {
    const outputDir = join(sandbox, 'write', 'run');
    const file = writeReconstructionOutput(outputDir, 'report.md', 'synthetic\n');
    expect(file).toBe(join(outputDir, 'report.md'));
    expect(readFileSync(file, 'utf8')).toBe('synthetic\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(outputDir).mode & 0o077).toBe(0);
  });

  it('refuses the repository and other working trees', () => {
    expect(() => writeReconstructionOutput(join(repoRoot, 'artifacts', 'reconstruction'), 'report.md', 'x')).toThrow(EvaluationOutputDirError);
    expect(() => writeReconstructionOutput(join(otherWorktree, 'out'), 'report.md', 'x')).toThrow(EvaluationOutputDirError);
    expect(readdirSync(otherWorktree)).toEqual(['.git']);
  });
});

describe('deriveTimeRangeExecutionIdentifiers', () => {
  const jobId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const patientId = randomUUID();
  const rangeStart = '2026-01-01T00:00:00.000Z';
  const rangeEnd = '2026-01-01T12:34:56.000Z';
  const rangeIdentity = `today:${rangeStart}:${rangeEnd}`;
  // Same shapes as apps/worker/src/worker.service.ts.
  const execution = {
    task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
    task_id: `${jobId}:${conversationId}:${messageId}:${rangeIdentity}`,
    context_package_id: `conversation-time-range:${conversationId}:user-message:${messageId}:${rangeIdentity}`,
    correlation_id: conversationId,
    patient_id: patientId,
  };

  it('derives job, conversation, message, patient and range from the stored execution', () => {
    expect(deriveTimeRangeExecutionIdentifiers(execution)).toEqual({
      jobId,
      conversationId,
      messageId,
      patientId,
      rangeType: 'TODAY',
      rangeStart,
      rangeEnd,
    });
  });

  it('refuses instead of guessing when the stored identifiers are missing or disagree', () => {
    const broken: Array<Record<string, unknown> | undefined> = [
      undefined,
      { ...execution, task_type: 'CONVERSATION_DIRECT_RESPONSE' },
      { ...execution, task_id: `${jobId}:${conversationId}` },
      { ...execution, task_id: `${jobId}:${conversationId}:${messageId}:today:not-a-date:${rangeEnd}` },
      { ...execution, correlation_id: randomUUID() },
      { ...execution, context_package_id: `conversation-time-range:${conversationId}:user-message:${randomUUID()}:${rangeIdentity}` },
      { ...execution, patient_id: null },
    ];
    for (const row of broken) {
      expect(() => deriveTimeRangeExecutionIdentifiers(row)).toThrow(ReconstructionArgumentError);
    }
    try {
      deriveTimeRangeExecutionIdentifiers({ ...execution, correlation_id: randomUUID() });
    } catch (error) {
      for (const id of [jobId, conversationId, messageId, patientId]) expect((error as Error).message).not.toContain(id);
    }
  });
});
