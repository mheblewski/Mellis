import { randomUUID } from 'node:crypto';

/**
 * Synthetic rows for the reconstruction tool tests. Values are invented per run and deliberately differ from the
 * figures observed in the 2026-10-09 investigation, so a stale hard-coded figure cannot pass for a calculated one.
 */
export const PATIENT_TEXT = 'SYNTHETIC-PATIENT-QUESTION about lunch';
export const PATIENT_REPLY = 'SYNTHETIC-ASSISTANT-ANSWER mentions glucose';
export const SENSITIVE_MARKERS = ['SYNTHETIC-PATIENT', 'SYNTHETIC-ASSISTANT', 'SYNTHETIC-RESULT', 'SYNTHETIC-ERROR', 'SYNTHETIC-PAYLOAD'];

/** Figures from the 2026-10-09 investigation that used to be hard-coded; none may appear as a current value. */
export const STALE_FIGURES = ['0.2739', '0.0060', '0.2799', '357,559', '357559', '293,876', '293876', '82.2%', '738 bytes', '393KB', '293KB', '357KB', 'Europe/Warsaw', '2026-10-08', '2026-10-09T13:05:51', 'CET', '100% match', '100% confidence'];

export function syntheticExecution(overrides: Record<string, unknown> = {}) {
  const jobId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const patientId = randomUUID();
  const executionId = randomUUID();
  const rangeIdentity = 'short_range:2026-02-01T00:00:00.000Z:2026-02-03T23:59:59.999Z';
  const execution: Record<string, unknown> = {
    id: executionId,
    task_type: 'CONVERSATION_TIME_RANGE_ANALYSIS',
    task_version: 'v1',
    task_id: `${jobId}:${conversationId}:${messageId}:${rangeIdentity}`,
    task_identity: 'sha256:synthetic-task-identity',
    context_package_id: `conversation-time-range:${conversationId}:user-message:${messageId}:${rangeIdentity}`,
    context_package_hash: 'sha256:synthetic-package-hash',
    correlation_id: conversationId,
    patient_id: patientId,
    input_hash: 'sha256:synthetic-input-hash',
    input_fingerprint: 'sha256:synthetic-fingerprint',
    prompt_version: 'synthetic-prompt.v9',
    output_schema_version: 'synthetic-output.v9',
    model_policy_version: 'synthetic-policy.v9',
    provider: 'fake',
    model: 'synthetic-model',
    model_fingerprint: 'fake:synthetic',
    status: 'SUCCEEDED',
    input_tokens: '1234',
    output_tokens: 56,
    total_tokens: 1290,
    serialized_input_bytes: 4000,
    estimated_cost: '0.012345000000',
    cost_currency: 'USD',
    pricing_version: 'synthetic-pricing.v1',
    started_at: new Date('2026-02-04T10:00:00.000Z'),
    completed_at: new Date('2026-02-04T10:00:01.500Z'),
    created_at: new Date('2026-02-04T09:59:59.000Z'),
    context_package_usage: {
      total_serialized_bytes: 5000,
      sections: [
        { section_name: 'analytical_evidence', serialized_bytes: 3000 },
        { section_name: 'historical_evidence', serialized_bytes: 500 },
        { section_name: 'conversation_context', serialized_bytes: 1500 },
      ],
      delivery: { delivery_mode_used: 'COMPACT', full_serialized_input_bytes: 5000, compact_serialized_input_bytes: 2000, note: 'SYNTHETIC-PAYLOAD-in-usage' },
    },
    normalized_result: { assistant_message: 'SYNTHETIC-RESULT text' },
    error: { message: 'SYNTHETIC-ERROR text' },
    ...overrides,
  };
  return { execution, executionId, jobId, conversationId, messageId, patientId };
}
