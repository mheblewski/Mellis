import { createHash } from 'crypto';
import { canonicalJson } from '@shared/utils/canonical-json';
import {
  AiTask,
  CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE,
  CONVERSATION_DIRECT_RESPONSE_TASK_TYPE,
} from '@modules/ai-gateway/domain/ai-gateway';
import { CONVERSATION_OUTPUT_SCHEMA_NAME } from './ai-contract.schema';
import { DIRECT_RESPONSE_PROMPT_VERSION } from './direct-response-prompt';
import { MODEL_ROUTING_POLICY_VERSION } from './model-routing';
import { TIME_RANGE_ANALYSIS_PROMPT_VERSION } from './time-range-analysis-prompt';

export function buildAiInputHash(args: {
  context_package: unknown;
}): string {
  const payload = canonicalJson(args.context_package);
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

/**
 * Content hash of a conversation context package for the AI task identity. It leaves out only per-attempt metadata:
 * the package's own created_at/content_hash and the historical retrieval run id and timestamp, which are new on every
 * attempt. Everything clinical stays in, so changed evidence still means a new identity, while a job retry over the
 * same evidence keeps its identity and reuses an already succeeded (and paid) AI execution instead of calling again.
 */
export function buildContextPackageIdentityHash(contextPackage: Record<string, unknown>): string {
  const { created_at: _createdAt, content_hash: _contentHash, historical_evidence: historicalEvidence, ...rest } = contextPackage;
  let stableHistory: unknown = historicalEvidence ?? null;
  if (historicalEvidence && typeof historicalEvidence === 'object' && !Array.isArray(historicalEvidence)) {
    const { retrieval_run_id: _runId, retrieval_timestamp: _timestamp, provenance, ...history } = historicalEvidence as Record<string, unknown>;
    const stableProvenance = provenance && typeof provenance === 'object' && !Array.isArray(provenance)
      ? (({ retrieval_run_id: _provenanceRunId, retrieval_timestamp: _provenanceTimestamp, ...kept }) => kept)(provenance as Record<string, unknown>)
      : provenance;
    stableHistory = { ...history, ...(provenance === undefined ? {} : { provenance: stableProvenance }) };
  }
  return buildAiInputHash({ context_package: { ...rest, historical_evidence: stableHistory } });
}

export function buildAiTaskIdentity(task: AiTask): string {
  const payload = canonicalJson({
    task_type: task.task_type,
    task_version: task.task_version,
    context_package_hash: task.context_package_hash,
    prompt_version: task.prompt_version,
    output_schema_version: task.output_schema_version,
    model_policy_version: task.model_policy_version,
  });

  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export function createConversationDirectResponseTask(args: {
  task_id: string;
  context_package_id: string;
  context_package_version: string;
  context_package_hash: string;
  correlation_id: string;
  created_at: string;
  patient_id?: string;
}): AiTask {
  return {
    task_id: args.task_id,
    task_type: CONVERSATION_DIRECT_RESPONSE_TASK_TYPE,
    task_version: 'conversation-direct-response-task.v1',
    context_package_id: args.context_package_id,
    context_package_version: args.context_package_version,
    context_package_hash: args.context_package_hash,
    prompt_version: DIRECT_RESPONSE_PROMPT_VERSION,
    output_schema_version: CONVERSATION_OUTPUT_SCHEMA_NAME,
    model_policy_version: MODEL_ROUTING_POLICY_VERSION,
    correlation_id: args.correlation_id,
    created_at: args.created_at,
    patient_id: args.patient_id,
  };
}

export function createConversationTimeRangeAnalysisTask(args: {
  task_id: string;
  context_package_id: string;
  context_package_version: string;
  context_package_hash: string;
  correlation_id: string;
  created_at: string;
  patient_id?: string;
}): AiTask {
  return {
    task_id: args.task_id,
    task_type: CONVERSATION_TIME_RANGE_ANALYSIS_TASK_TYPE,
    task_version: 'conversation-time-range-analysis-task.v1',
    context_package_id: args.context_package_id,
    context_package_version: args.context_package_version,
    context_package_hash: args.context_package_hash,
    prompt_version: TIME_RANGE_ANALYSIS_PROMPT_VERSION,
    output_schema_version: CONVERSATION_OUTPUT_SCHEMA_NAME,
    model_policy_version: MODEL_ROUTING_POLICY_VERSION,
    correlation_id: args.correlation_id,
    created_at: args.created_at,
    patient_id: args.patient_id,
  };
}
