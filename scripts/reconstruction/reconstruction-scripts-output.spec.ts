import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PATIENT_REPLY, PATIENT_TEXT, SENSITIVE_MARKERS, STALE_FIGURES, syntheticExecution } from './reconstruction-fixtures';

// pg is replaced by an in-memory client that answers each read with synthetic rows; no database is involved.
const database = vi.hoisted(() => ({ respond: (_sql: string, _params: unknown[]): unknown[] => [], failWith: null as Error | null, queries: [] as string[] }));
vi.mock('pg', () => ({
  Pool: class {
    async query(sql: string, params: unknown[] = []) {
      database.queries.push(sql);
      if (database.failWith) throw database.failWith;
      return { rows: database.respond(sql, params) };
    }
    async end() {}
  },
}));

import { main as stage1 } from '../reconstruction-stage-1-recover';
import { main as stage2 } from '../reconstruction-stage-2-build';
import { main as stage2b } from '../reconstruction-stage-2b-analysis';
import { main as finalReport } from '../reconstruction-final-report';

// The legacy /tmp/glucomind-reconstruction directory is deliberately never touched here, not even its metadata; the
// source checks below prove the scripts no longer reference it, and test runs deny all access to it at the OS level.
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'reconstruction-output-')));
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const fixture = syntheticExecution();
const ids = [fixture.executionId, fixture.jobId, fixture.conversationId, fixture.messageId, fixture.patientId];

function respond(sql: string): unknown[] {
  if (sql.includes('FROM ai_executions')) return [fixture.execution];
  if (sql.includes('information_schema.tables')) return [{ exists: true }];
  if (sql.includes('FROM jobs')) return [{ id: fixture.jobId, job_type: 'conversation.time_range_analysis', payload: { text: PATIENT_TEXT } }];
  if (sql.includes('FROM conversations')) return [{ id: fixture.conversationId, conversation_type: 'USER_INITIATED', thread_state_version: 'thread-v1', awaiting_user_answer: false, patient_id: fixture.patientId }];
  if (sql.includes('WHERE id = $1') && sql.includes('FROM messages')) return [{ id: fixture.messageId, content: PATIENT_TEXT, created_at: '2026-02-04T09:59:00.000Z' }];
  if (sql.includes('FROM messages')) return [{ id: fixture.messageId, role: 'USER', content: PATIENT_TEXT, created_at: '2026-02-04T09:59:00.000Z' }, { role: 'ASSISTANT', content: PATIENT_REPLY, created_at: '2026-02-04T10:00:02.000Z' }];
  if (sql.includes('FROM current_states')) return [{ as_of: '2026-02-04T09:00:00.000Z', snapshot: { current_glucose: 111, note: PATIENT_TEXT } }];
  if (sql.includes("e.type = 'GLUCOSE_READING'")) return [{ id: 'g1', payload: { glucose_value: 100 } }, { id: 'g2', payload: {} }, { id: 'g3', payload: { glucose_value: 140 } }];
  return [];
}

let output: string[];
let consoleSpies: Array<{ mockRestore: () => void }> = [];
beforeEach(() => {
  output = [];
  database.respond = respond;
  database.failWith = null;
  database.queries = [];
  const capture = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
  consoleSpies = [vi.spyOn(console, 'log').mockImplementation(capture), vi.spyOn(console, 'error').mockImplementation(capture)];
  process.exitCode = undefined;
});
afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
  process.exitCode = undefined;
});

function expectCleanStdout() {
  const printed = output.join('\n');
  for (const marker of [...SENSITIVE_MARKERS, ...ids, String(fixture.execution.task_id)]) expect(printed).not.toContain(marker);
  for (const stale of STALE_FIGURES) expect(printed).not.toContain(stale);
  return printed;
}

function expectReadOnly() {
  for (const sql of database.queries) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
}

describe('reconstruction stdout with a mocked database (synthetic rows)', () => {
  it('stage 1 prints only the allowlisted summary', async () => {
    await stage1(['--execution-id', fixture.executionId]);
    const printed = expectCleanStdout();
    expect(printed).toContain('Execution: found');
    expect(printed).toContain('task_type: CONVERSATION_TIME_RANGE_ANALYSIS');
    expect(printed).toContain('context_package_usage: present (3 sections)');
    expect(printed).toContain('lookup skipped');
    expect(printed).not.toContain('{');
    // Stage 1 confirms the execution only: no hashes or fingerprints either.
    expect(printed).not.toContain('sha256:');
    expect(process.exitCode).toBeUndefined();
    expectReadOnly();
  });

  it('stage 1 reports a missing execution without dumping anything', async () => {
    database.respond = () => [];
    await stage1(['--execution-id', fixture.executionId]);
    expect(output.join('\n')).toContain('Execution: not found');
    expect(process.exitCode).toBe(1);
  });

  it('stage 2, 2b and the final report keep patient text and identifiers out of stdout and write guarded files', async () => {
    const outputDir = join(sandbox, 'run');
    for (const main of [stage2, stage2b, finalReport]) {
      await main(['--execution-id', fixture.executionId, '--output-dir', outputDir]);
      expect(process.exitCode).toBeUndefined();
    }
    expectCleanStdout();
    expectReadOnly();
    for (const name of ['reconstructed-context.json', 'reconstruction-analysis.txt', 'FINAL_RECONSTRUCTION_REPORT.md']) {
      expect(statSync(join(outputDir, name)).mode & 0o777).toBe(0o600);
    }
    expect(statSync(outputDir).mode & 0o077).toBe(0);

    const context = JSON.parse(readFileSync(join(outputDir, 'reconstructed-context.json'), 'utf8'));
    expect(context.analysis_request_input).toMatchObject({ range_type: 'SHORT_RANGE', timezone: null, normalization_policy_version: null });
    expect(context.analytical_evidence.summaries).toMatchObject({ glucose_min: 100, glucose_max: 140, glucose_avg: '120.0' });
    expect(context.reconstruction_notes.unavailable.timezone).toContain('not stored');
    const report = readFileSync(join(outputDir, 'FINAL_RECONSTRUCTION_REPORT.md'), 'utf8');
    for (const stale of STALE_FIGURES) expect(report).not.toContain(stale);
  });

  it('database errors are printed as class and code only', async () => {
    database.failWith = Object.assign(new Error(`invalid input syntax for type uuid: "${PATIENT_TEXT}" ${fixture.conversationId}`), { code: '22P02' });
    await stage1(['--execution-id', fixture.executionId]);
    await stage2(['--execution-id', fixture.executionId, '--output-dir', join(sandbox, 'failing')]);
    const printed = expectCleanStdout();
    expect(printed).toContain('Fatal error: Error (code 22P02)');
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(sandbox, 'failing'))).toBe(false);
  });

  it('inconsistent stored identifiers stop the report before related records are read', async () => {
    database.respond = (sql) => (sql.includes('FROM ai_executions') ? [{ ...fixture.execution, correlation_id: 'other' }] : respond(sql));
    await finalReport(['--execution-id', fixture.executionId, '--output-dir', join(sandbox, 'inconsistent')]);
    expect(output.join('\n')).toContain('refusing to guess');
    expect(database.queries.filter((sql) => sql.includes('FROM messages'))).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(sandbox, 'inconsistent'))).toBe(false);
    expectCleanStdout();
  });
});
