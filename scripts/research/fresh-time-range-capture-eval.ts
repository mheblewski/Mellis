import 'reflect-metadata';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { Pool } from 'pg';
import { buildCompactDeliveryArtifact } from '@modules/context/application/compact-delivery-artifact';
import type { AiTask, TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import { ensureEvaluationOutputDir, resolveEvaluationOutputDir } from '../evaluation/evaluation-output-dir';

interface CaregiverRelationshipRow {
  user_id: string;
  patient_id: string;
}

interface ExecutionRow {
  id: string;
  task_identity: string;
  task_id: string;
  task_type: string;
  task_version: string;
  patient_id: string;
  trigger_id: string | null;
  analysis_id: string | null;
  context_package_id: string;
  context_package_version: string;
  context_package_hash: string;
  correlation_id: string;
  prompt_version: string;
  output_schema_version: string;
  model_policy_version: string;
  model: string | null;
  provider: string | null;
  model_fingerprint: string | null;
  input_fingerprint: string | null;
  serialized_input_bytes: string | null;
  created_at: string;
  status: string;
}

interface CaptureRecord {
  captured_at: string;
  capture_version: string;
  task_identity: string;
  task: {
    task_id: string;
    task_type: string;
    task_version: string;
    prompt_version: string;
    output_schema_version: string;
    model_policy_version: string;
    context_package_id: string;
    context_package_version: string;
    context_package_hash: string;
    correlation_id: string;
    created_at: string;
  };
  provider: string;
  model: string;
  model_fingerprint: string;
  request_representation: unknown;
  serialized_input_bytes: number;
  input_fingerprint: string;
}

interface CaseResult {
  case_index: number;
  conversation_id: string;
  user_message_id: string;
  execution_id: string;
  task_identity: string;
  provider: string | null;
  model: string | null;
  capture_file_task_identity: string;
  persisted_input_fingerprint: string | null;
  captured_input_fingerprint: string;
  fingerprint_equal: boolean;
  persisted_serialized_input_bytes: number | null;
  captured_serialized_input_bytes: number;
  serialized_bytes_equal: boolean;
  context_package_version_equal: boolean;
  context_package_hash_equal: boolean;
  compact_artifact_hash: string;
  compact_artifact_bytes: number;
  compact_hash_stable_repeat: boolean;
  compact_source_hash_match: boolean;
  compact_source_task_identity_stable_repeat: boolean;
  blocked_reasons: string[];
}

interface MissedCaptureExecution {
  attempt_index: number;
  conversation_id: string;
  user_message_id: string;
  execution_id: string;
  task_identity: string;
  provider: string | null;
  model: string | null;
  reason: 'CAPTURE_RECORD_NOT_FOUND_WITHIN_TIMEOUT';
}

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

function parseIntOrNull(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function pollUntil<T>(args: {
  description: string;
  timeoutMs: number;
  intervalMs: number;
  run: () => Promise<T | null>;
}): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < args.timeoutMs) {
    const value = await args.run();
    if (value) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, args.intervalMs));
  }

  throw new Error(`Timed out waiting for ${args.description}`);
}

async function pollCaptureRecord(args: {
  captureFilePath: string;
  taskIdentity: string;
  timeoutMs: number;
  intervalMs: number;
}): Promise<CaptureRecord | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < args.timeoutMs) {
    try {
      const raw = await readFile(args.captureFilePath, 'utf8');
      const records = raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as CaptureRecord);

      const match = records.find((record) => record.task_identity === args.taskIdentity) ?? null;
      if (match) {
        return match;
      }
    } catch {
      // Keep polling until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, args.intervalMs));
  }

  return null;
}

async function claimQueuedTimeRangeJob(args: {
  pool: Pool;
  conversationId: string;
  workerId: string;
}): Promise<{ id: string; lease_token: string; payload: Record<string, unknown> } | null> {
  const pick = await args.pool.query<{ id: string; payload: Record<string, unknown> }>(
    `
      SELECT id::text, payload
      FROM jobs
      WHERE job_type = 'conversation.time_range_analysis'
        AND correlation_id = $1::uuid
        AND status = 'queued'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [args.conversationId],
  );

  const row = pick.rows[0];
  if (!row) {
    return null;
  }

  const leaseToken = randomUUID();
  const now = new Date();
  const lockExpiresAt = new Date(now.getTime() + 300_000).toISOString();

  const claimed = await args.pool.query<{ id: string; lease_token: string; payload: Record<string, unknown> }>(
    `
      UPDATE jobs
      SET status = 'running',
          attempts = attempts + 1,
          locked_at = $2::timestamptz,
          lock_expires_at = $3::timestamptz,
          locked_by = $4::text,
          lease_token = $5::uuid,
          updated_at = now()
      WHERE id = $1::uuid
        AND status = 'queued'
      RETURNING id::text, lease_token::text, payload
    `,
    [row.id, now.toISOString(), lockExpiresAt, args.workerId, leaseToken],
  );

  return claimed.rows[0] ?? null;
}

function asAiTask(row: ExecutionRow): AiTask {
  return {
    task_id: row.task_id,
    task_type: row.task_type as AiTask['task_type'],
    task_version: row.task_version,
    patient_id: row.patient_id,
    trigger_id: row.trigger_id ?? undefined,
    analysis_id: row.analysis_id ?? undefined,
    context_package_id: row.context_package_id,
    context_package_version: row.context_package_version,
    context_package_hash: row.context_package_hash,
    correlation_id: row.correlation_id,
    prompt_version: row.prompt_version,
    output_schema_version: row.output_schema_version,
    model_policy_version: row.model_policy_version,
    created_at: row.created_at,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // Captures and the report contain patient data: the destination is validated before any other side effect.
  const outputDir = resolveEvaluationOutputDir(argv);
  const databaseUrl = process.env.DATABASE_URL?.trim() || 'postgresql://postgres:postgres@localhost:5432/gluco_mind';

  const pool = new Pool({ connectionString: databaseUrl });

  const captureRunId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const captureFilePath = join(outputDir, `fresh-time-range-capture-${captureRunId}.ndjson`);
  const reportFilePath = join(outputDir, `fresh-time-range-capture-report-${captureRunId}.json`);

  const relationshipResult = await pool.query<CaregiverRelationshipRow>(
    `
      SELECT user_id::text, patient_id::text
      FROM caregiver_relationships
      ORDER BY created_at DESC
      LIMIT 1
    `,
  );
  const relationship = relationshipResult.rows[0];
  if (!relationship) {
    throw new Error('No caregiver_relationships row found. Seed at least one user-patient relationship first.');
  }

  process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
  process.env.AUTH_MODE = 'disabled';
  process.env.ALLOW_AUTH_DISABLED_IN_LOCAL = 'true';
  process.env.AUTH_DISABLED_USER_ID = relationship.user_id;
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = requiredEnv('OPENAI_API_KEY');
  process.env.OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-terra';
  process.env.OPENAI_EVAL_CAPTURE_ENABLED = 'true';
  process.env.OPENAI_EVAL_CAPTURE_FILE_PATH = captureFilePath;

  requiredEnv('NIGHTSCOUT_BASE_URL');
  requiredEnv('NIGHTSCOUT_API_TOKEN');
  requiredEnv('NIGHTSCOUT_PATIENT_ID');

  ensureEvaluationOutputDir(outputDir);
  await rm(captureFilePath, { force: true });

  const [{ ApiAppModule }, { WorkerAppModule }] = await Promise.all([
    import('../../apps/api/src/app.module'),
    import('../../apps/worker/src/app.module'),
  ]);

  const apiApp = await NestFactory.create(ApiAppModule, { logger: ['error', 'warn'] });
  await apiApp.init();

  const workerApp = await NestFactory.createApplicationContext(WorkerAppModule, {
    logger: ['error', 'warn'],
  });
  const { WorkerService } = await import('../../apps/worker/src/worker.service');
  const workerService = workerApp.get(WorkerService) as any;
  if (workerService.jobTimer) {
    clearInterval(workerService.jobTimer);
    workerService.jobTimer = null;
  }
  if (workerService.syncTimer) {
    clearInterval(workerService.syncTimer);
    workerService.syncTimer = null;
  }

  const caseResults: CaseResult[] = [];
  const missedCaptures: MissedCaptureExecution[] = [];
  const maxAttempts = 8;

  try {
    let attempt = 0;
    while (caseResults.length < 2 && attempt < maxAttempts) {
      attempt += 1;
      const createConversationResponse = await request(apiApp.getHttpServer())
        .post(`/v1/patients/${relationship.patient_id}/conversations`)
        .set('Idempotency-Key', `fresh-capture-create-${captureRunId}-${attempt}`)
        .expect(201);

      const conversationId = String(createConversationResponse.body.conversation.id);

      const submitMessageResponse = await request(apiApp.getHttpServer())
        .post(`/v1/patients/${relationship.patient_id}/conversations/${conversationId}/messages`)
        .set('Idempotency-Key', `fresh-capture-message-${captureRunId}-${attempt}`)
        .send({
          message_type: 'USER_MESSAGE',
          content: 'analiza dzisiejszego dnia',
        })
        .expect(200);

      const decision = String(submitMessageResponse.body.decision ?? '');
      if (decision !== 'ANALYSIS_REQUEST') {
        throw new Error(`Expected ANALYSIS_REQUEST, got ${decision} for attempt ${attempt}`);
      }

      const userMessageId = String(submitMessageResponse.body.message.id);

      const claimedJob = await pollUntil<{ id: string; lease_token: string; payload: Record<string, unknown> }>({
        description: `queued time_range job for conversation ${conversationId}`,
        timeoutMs: 10_000,
        intervalMs: 200,
        run: async () => {
          return claimQueuedTimeRangeJob({
            pool,
            conversationId,
            workerId: `fresh-capture-eval-${captureRunId}`,
          });
        },
      });

      await workerService.handleConversationTimeRangeAnalysis(claimedJob.id, claimedJob.lease_token, claimedJob.payload);

      const execution = await pollUntil<ExecutionRow>({
        description: `succeeded ai_execution for conversation ${conversationId}`,
        timeoutMs: 30_000,
        intervalMs: 250,
        run: async () => {
          const executionResult = await pool.query<ExecutionRow>(
            `
              SELECT
                id::text,
                task_identity,
                task_id,
                task_type,
                task_version,
                patient_id::text,
                trigger_id::text,
                analysis_id::text,
                context_package_id,
                context_package_version,
                context_package_hash,
                correlation_id,
                prompt_version,
                output_schema_version,
                model_policy_version,
                model,
                provider,
                model_fingerprint,
                input_fingerprint,
                serialized_input_bytes::text,
                created_at::text,
                status
              FROM ai_executions
              WHERE correlation_id = $1::text
                AND task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS'
              ORDER BY created_at DESC
              LIMIT 1
            `,
            [conversationId],
          );

          const row = executionResult.rows[0];
          if (!row || row.status !== 'succeeded') {
            return null;
          }

          return row;
        },
      });

      const contextResult = await pool.query<{ payload: TimeRangeAnalysisContextRecord }>(
        `
          SELECT payload
          FROM context_packages
          WHERE package_version = $1::text
            AND content_hash = $2::text
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [execution.context_package_version, execution.context_package_hash],
      );

      const contextRecord = contextResult.rows[0]?.payload;
      if (!contextRecord) {
        throw new Error(`Missing context package payload for execution ${execution.id}`);
      }

      const artifactTask = asAiTask(execution);
      const compactA = buildCompactDeliveryArtifact({ contextPackage: contextRecord, task: artifactTask });
      const compactB = buildCompactDeliveryArtifact({ contextPackage: contextRecord, task: artifactTask });

      const capture = await pollCaptureRecord({
        captureFilePath,
        taskIdentity: execution.task_identity,
        timeoutMs: 20_000,
        intervalMs: 500,
      });

      if (!capture) {
        missedCaptures.push({
          attempt_index: attempt,
          conversation_id: conversationId,
          user_message_id: userMessageId,
          execution_id: execution.id,
          task_identity: execution.task_identity,
          provider: execution.provider,
          model: execution.model,
          reason: 'CAPTURE_RECORD_NOT_FOUND_WITHIN_TIMEOUT',
        });
        continue;
      }

      const persistedBytes = parseIntOrNull(execution.serialized_input_bytes);
      const blockedReasons: string[] = [];

      const fingerprintEqual = execution.input_fingerprint === capture.input_fingerprint;
      const serializedBytesEqual = persistedBytes === capture.serialized_input_bytes;
      const contextVersionEqual = execution.context_package_version === capture.task.context_package_version;
      const contextHashEqual = execution.context_package_hash === capture.task.context_package_hash;
      const compactHashStableRepeat = compactA.artifact_content_hash === compactB.artifact_content_hash;
      const compactSourceHashMatch =
        compactA.deterministic_replay_metadata.source_context_package_hash === execution.context_package_hash;
      const compactSourceTaskIdentityStableRepeat =
        compactA.deterministic_replay_metadata.source_task_identity === compactB.deterministic_replay_metadata.source_task_identity;

      if (!fingerprintEqual) blockedReasons.push('INPUT_FINGERPRINT_MISMATCH');
      if (!serializedBytesEqual) blockedReasons.push('SERIALIZED_INPUT_BYTES_MISMATCH');
      if (!contextVersionEqual) blockedReasons.push('CONTEXT_PACKAGE_VERSION_MISMATCH');
      if (!contextHashEqual) blockedReasons.push('CONTEXT_PACKAGE_HASH_MISMATCH');
      if (!compactHashStableRepeat) blockedReasons.push('COMPACT_ARTIFACT_NON_DETERMINISTIC');
      if (!compactSourceHashMatch) blockedReasons.push('COMPACT_ARTIFACT_SOURCE_HASH_MISMATCH');
      if (!compactSourceTaskIdentityStableRepeat) blockedReasons.push('COMPACT_ARTIFACT_SOURCE_TASK_IDENTITY_NON_DETERMINISTIC');

      caseResults.push({
        case_index: caseResults.length + 1,
        conversation_id: conversationId,
        user_message_id: userMessageId,
        execution_id: execution.id,
        task_identity: execution.task_identity,
        provider: execution.provider,
        model: execution.model,
        capture_file_task_identity: capture.task_identity,
        persisted_input_fingerprint: execution.input_fingerprint,
        captured_input_fingerprint: capture.input_fingerprint,
        fingerprint_equal: fingerprintEqual,
        persisted_serialized_input_bytes: persistedBytes,
        captured_serialized_input_bytes: capture.serialized_input_bytes,
        serialized_bytes_equal: serializedBytesEqual,
        context_package_version_equal: contextVersionEqual,
        context_package_hash_equal: contextHashEqual,
        compact_artifact_hash: compactA.artifact_content_hash,
        compact_artifact_bytes: compactA.artifact_bytes,
        compact_hash_stable_repeat: compactHashStableRepeat,
        compact_source_hash_match: compactSourceHashMatch,
        compact_source_task_identity_stable_repeat: compactSourceTaskIdentityStableRepeat,
        blocked_reasons: blockedReasons,
      });
    }

    if (caseResults.length < 2) {
      throw new Error(`Collected ${caseResults.length} captured case(s); required 2. Missed captures: ${missedCaptures.length}.`);
    }
  } finally {
    await workerApp.close();
    await apiApp.close();
    await pool.end();
  }

  const allPassed = caseResults.every((row) => row.blocked_reasons.length === 0);

  const report = {
    status: allPassed ? 'FRESH_TIME_RANGE_CAPTURE_READY' : 'FRESH_TIME_RANGE_CAPTURE_BLOCKED',
    run_id: captureRunId,
    capture_file_path: captureFilePath,
    report_generated_at: new Date().toISOString(),
    provider: 'openai',
    model: process.env.OPENAI_MODEL,
    checks: {
      exact_input_fingerprint: true,
      exact_serialized_input_bytes: true,
      context_package_version_alignment: true,
      context_package_hash_alignment: true,
      compact_artifact_deterministic_linkage: true,
      no_full_vs_compact_ai_output_comparison: true,
    },
    cases: caseResults,
    missed_captures: missedCaptures,
  };

  await writeFile(reportFilePath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  console.log(JSON.stringify({
    status: report.status,
    capture_file_path: captureFilePath,
    report_file_path: reportFilePath,
    case_count: caseResults.length,
    attempt_count: caseResults.length + missedCaptures.length,
    missed_capture_count: missedCaptures.length,
    blocked_cases: caseResults.filter((row) => row.blocked_reasons.length > 0).length,
  }, null, 2));
}

if (require.main === module) {
  void main().catch((error) => {
    console.error('[fresh-time-range-capture-eval] failed');
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
