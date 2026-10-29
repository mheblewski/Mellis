import { describe, expect, it } from 'vitest';
import { deriveTimeRangeExecutionIdentifiers } from './reconstruction-cli';
import { PATIENT_REPLY, PATIENT_TEXT, SENSITIVE_MARKERS, STALE_FIGURES, syntheticExecution } from './reconstruction-fixtures';
import {
  HISTORICAL_LABEL,
  STDOUT_EXECUTION_FIELDS,
  buildFinalReconstructionReport,
  buildReconstructionAnalysis,
  computeExecutionFigures,
  describeErrorSafely,
  glucoseSummary,
  summarizeExecutionForStdout,
} from './reconstruction-report';

function finalReport(execution: Record<string, unknown>) {
  return buildFinalReconstructionReport({
    executionId: String(execution.id),
    outputDir: '/synthetic/out',
    execution,
    identifiers: deriveTimeRangeExecutionIdentifiers(execution),
    message: { content: PATIENT_TEXT, created_at: '2026-02-04T09:59:00.000Z' },
    conversation: { thread_state_version: 'thread-v1', awaiting_user_answer: false },
    conversationMessages: [
      { role: 'USER', content: PATIENT_TEXT, created_at: '2026-02-04T09:59:00.000Z' },
      { role: 'ASSISTANT', content: PATIENT_REPLY, created_at: '2026-02-04T10:00:02.000Z' },
    ],
    job: { job_type: 'conversation.time_range_analysis' },
  });
}

describe('computeExecutionFigures', () => {
  it('calculates figures from the selected execution', () => {
    const { execution } = syntheticExecution();
    const figures = computeExecutionFigures(execution);
    expect(figures.inputTokens).toEqual({ status: 'stored', value: 1234, source: 'ai_executions.input_tokens' });
    expect(figures.contextPackageBytes).toMatchObject({ status: 'stored', value: 5000 });
    expect(figures.analyticalEvidence.bytes).toMatchObject({ status: 'stored', value: 3000 });
    expect(figures.analyticalEvidence.share).toMatchObject({ status: 'calculated', value: '60.0%' });
    expect(figures.historicalEvidence.share).toMatchObject({ status: 'calculated', value: '10.0%' });
    expect(figures.duration).toMatchObject({ status: 'calculated', value: '1500 ms' });
    expect(figures.estimatedCost).toMatchObject({ status: 'stored', value: '0.012345 USD, pricing synthetic-pricing.v1' });
    expect(figures.bytesSavedByDelivery).toMatchObject({ status: 'calculated', value: 3000 });
  });

  it('sums sections when the total is not stored, and marks missing sources unavailable instead of guessing', () => {
    const { execution } = syntheticExecution({
      context_package_usage: { sections: [{ section_name: 'analytical_evidence', serialized_bytes: 100 }, { section_name: 'other', serialized_bytes: 300 }] },
    });
    const figures = computeExecutionFigures(execution);
    expect(figures.contextPackageBytes).toMatchObject({ status: 'calculated', value: 400 });
    expect(figures.analyticalEvidence.share).toMatchObject({ status: 'calculated', value: '25.0%' });
    expect(figures.historicalEvidence.bytes.status).toBe('unavailable');
    expect(figures.bytesSavedByDelivery.status).toBe('unavailable');

    const bare = computeExecutionFigures(syntheticExecution({
      context_package_usage: null, estimated_cost: null, cost_currency: null, started_at: null, input_tokens: null,
    }).execution);
    for (const value of [bare.contextPackageBytes, bare.analyticalEvidence.bytes, bare.analyticalEvidence.share, bare.estimatedCost, bare.duration, bare.inputTokens, bare.timezone, bare.costSplit]) {
      expect(value.status).toBe('unavailable');
    }
  });

  it('skips missing glucose values instead of counting them as 0 or 999', () => {
    expect(glucoseSummary([100, undefined, '140', null, 'n/a'])).toEqual({ glucose_min: 100, glucose_max: 140, glucose_avg: '120.0' });
    expect(glucoseSummary([undefined])).toEqual({ glucose_min: null, glucose_max: null, glucose_avg: null });
  });
});

describe('generated reports', () => {
  it('never present the 2026-10-09 figures as measurements of the selected execution', () => {
    const { execution } = syntheticExecution();
    for (const output of [finalReport(execution), buildReconstructionAnalysis(String(execution.id), execution)]) {
      for (const stale of STALE_FIGURES) expect(output).not.toContain(stale);
      expect(output).toContain(HISTORICAL_LABEL);
    }
  });

  it('use the selected execution: its range, cost, sizes and shares', () => {
    const { execution } = syntheticExecution();
    const report = finalReport(execution);
    expect(report).toContain('"range_type": "SHORT_RANGE"');
    expect(report).toContain('"range_start": "2026-02-01T00:00:00.000Z"');
    expect(report).toContain('"timezone": null');
    expect(report).toContain('0.012345 USD');
    expect(report).toContain('60.0%');
    expect(report).toContain('Duration | 1500 ms (calculated: completed_at - started_at)');
    const analysis = buildReconstructionAnalysis(String(execution.id), execution);
    expect(analysis).toContain('Analytical evidence: not rebuilt; size 3000 (stored: ai_executions.context_package_usage.sections)');
    expect(analysis).toContain('context_package_id is not UUID-shaped');
  });

  it('mark unavailable sources explicitly and never print undefined or NaN', () => {
    const { execution } = syntheticExecution({
      context_package_usage: null, estimated_cost: null, input_fingerprint: null, started_at: null, completed_at: null,
    });
    for (const output of [finalReport(execution), buildReconstructionAnalysis(String(execution.id), execution)]) {
      expect(output).toContain('unavailable (');
      expect(output).not.toMatch(/\bundefined\b|\bNaN\b/);
    }
    expect(finalReport(execution)).toContain('Estimated Cost | unavailable (ai_executions.estimated_cost is not set');
  });
});

describe('summarizeExecutionForStdout', () => {
  it('prints only allowlisted scalar fields and presence flags', () => {
    const { execution, executionId, jobId, conversationId, messageId, patientId } = syntheticExecution();
    const output = summarizeExecutionForStdout(execution).join('\n');
    for (const field of STDOUT_EXECUTION_FIELDS) expect(output).toContain(`${field}:`);
    for (const secret of [...SENSITIVE_MARKERS, executionId, jobId, conversationId, messageId, patientId, String(execution.task_id), String(execution.context_package_id), 'sha256:']) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('normalized_result: present');
    expect(output).toContain('context_package_usage: present (3 sections)');
  });

  it('withholds free text that ends up in an allowlisted column', () => {
    const { execution } = syntheticExecution({ model: `${PATIENT_TEXT}, with "quotes" and {json}`, status: { nested: PATIENT_TEXT } });
    const output = summarizeExecutionForStdout(execution).join('\n');
    expect(output).not.toContain('SYNTHETIC-PATIENT');
    expect(output).toContain('model: withheld');
    expect(output).toContain('status: withheld');
    expect(summarizeExecutionForStdout(undefined)).toEqual(['Execution: not found']);
  });
});

describe('describeErrorSafely', () => {
  it('reduces database errors to class and code, never their message', () => {
    const error = Object.assign(new Error(`invalid input syntax for type uuid: "${PATIENT_TEXT}"`), { code: '22P02', detail: PATIENT_TEXT });
    expect(describeErrorSafely(error)).toBe('Error (code 22P02)');
    expect(describeErrorSafely({ rows: [{ content: PATIENT_TEXT }] })).toBe('Error');
  });
});
