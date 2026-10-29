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
import {
  ConversationTimeRangeType,
  validateNormalizedTimeRangeWindow,
} from '@modules/context/application/time-range-normalization';
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
  context_package_usage: Record<string, unknown> | null;
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
  prompt: {
    system_instructions: string;
    user_payload: string;
  };
  context_package: TimeRangeAnalysisContextRecord;
  request_representation: Record<string, unknown>;
  serialized_input_bytes: number;
  input_fingerprint: string;
}

interface RangeRequestCase {
  requested_label: 'TODAY' | '3D' | '7D' | '14D' | '30D';
  message: string;
  expected_range_type: ConversationTimeRangeType;
}

interface CaseValidation {
  requested_label: RangeRequestCase['requested_label'];
  requested_message: string;
  expected_range_type: ConversationTimeRangeType;
  actual_range_type: string | null;
  range_start: string | null;
  range_end: string | null;
  timezone: string | null;
  normalization_policy_version: string | null;
  duration_hours: number | null;
  valid_range_window: boolean;
  fallback_to_today_detected: boolean;
  conversation_id: string | null;
  user_message_id: string | null;
  job_id: string | null;
  task_identity: string | null;
  context_package_version: string | null;
  context_package_hash: string | null;
  context_package_id: string | null;
  input_fingerprint: string | null;
  serialized_input_bytes: number | null;
  provider_bound_request_captured: boolean;
  provider: string | null;
  model: string | null;
  capture_file_task_identity: string | null;
  analytical_evidence_summary: Record<string, unknown> | null;
  evidence_selection: {
    selection_profile: string | null;
    selected_level: string | null;
    default_level: string | null;
    selected_evidence_families: string[];
    omitted_evidence_families: string[];
    omission_reasons: string[];
    significant_periods: unknown[];
    targeted_windows: unknown[];
    unknown_states: string[];
    missing_states: string[];
    excluded_states: string[];
    not_selected_states: string[];
    unresolved_reasons: string[];
  };
  range_profile: string | null;
  compact_artifact_hash: string | null;
  compact_source_task_identity: string | null;
  status: 'PASS' | 'FAIL';
  failure_stage:
    | null
    | 'parser/normalization'
    | 'API/task'
    | 'worker'
    | 'ContextPackage'
    | 'evidence selection'
    | 'capture infrastructure'
    | 'provider invocation';
  failure_reason: string | null;
}

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseIntOrNull(value: string | null): number | null {
  if (!value) return null;
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
    if (value) return value;
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
      if (match) return match;
    } catch {
      // Continue polling.
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
  if (!row) return null;

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

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function computeDurationHours(rangeStart: string | null, rangeEnd: string | null): number | null {
  if (!rangeStart || !rangeEnd) return null;
  const start = new Date(rangeStart).getTime();
  const end = new Date(rangeEnd).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Number(((end - start) / (1000 * 60 * 60)).toFixed(2));
}

function toRangeIdentity(rangeType: string | null, rangeStart: string | null, rangeEnd: string | null): string {
  return `${rangeType ?? 'UNKNOWN'}|${rangeStart ?? 'UNKNOWN'}|${rangeEnd ?? 'UNKNOWN'}`;
}

function markdownTableEscape(value: unknown): string {
  return String(value ?? '').replace(/\|/g, '\\|');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // Captures and the reports contain patient data: the destination is validated before any other side effect.
  const outputDir = resolveEvaluationOutputDir(argv);
  const databaseUrl = process.env.DATABASE_URL?.trim() || 'postgresql://postgres:postgres@localhost:5432/gluco_mind';
  const pool = new Pool({ connectionString: databaseUrl });

  const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', 'T').slice(0, 15) + 'Z';
  const runId = randomUUID().slice(0, 8);
  const captureFilePath = join(outputDir, `fresh-multi-range-capture-validation-${timestamp}-${runId}.ndjson`);
  const reportJsonPath = join(outputDir, `fresh-multi-range-capture-validation-${timestamp}-${runId}.json`);
  const reportMdPath = join(outputDir, `fresh-multi-range-capture-validation-${timestamp}-${runId}.md`);

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
  process.env.NIGHTSCOUT_PATIENT_ID = relationship.patient_id;

  requiredEnv('NIGHTSCOUT_BASE_URL');
  requiredEnv('NIGHTSCOUT_API_TOKEN');
  requiredEnv('NIGHTSCOUT_PATIENT_ID');

  ensureEvaluationOutputDir(outputDir);
  await rm(captureFilePath, { force: true });

  const ranges: RangeRequestCase[] = [
    { requested_label: 'TODAY', message: 'Przeanalizuj mi dzisiaj', expected_range_type: 'TODAY' },
    { requested_label: '3D', message: 'Przeanalizuj ostatnie 3 dni', expected_range_type: 'SHORT_RANGE' },
    { requested_label: '7D', message: 'Przeanalizuj ostatnie 7 dni', expected_range_type: 'MEDIUM_RANGE' },
    { requested_label: '14D', message: 'Przeanalizuj ostatnie 14 dni', expected_range_type: 'LONG_RANGE' },
    { requested_label: '30D', message: 'Przeanalizuj ostatnie 30 dni', expected_range_type: 'EXTENDED_RANGE' },
  ];

  console.log('Expected cases: 5');
  console.log('Expected captures: TODAY, 3D, 7D, 14D, 30D');
  console.log('Expected provider invocations: 5 (current capture infrastructure writes pre-call inside OpenAI provider and still executes provider path).');

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

  const validations: CaseValidation[] = [];
  let providerCallsActual = 0;

  try {
    for (const rangeCase of ranges) {
      const row: CaseValidation = {
        requested_label: rangeCase.requested_label,
        requested_message: rangeCase.message,
        expected_range_type: rangeCase.expected_range_type,
        actual_range_type: null,
        range_start: null,
        range_end: null,
        timezone: null,
        normalization_policy_version: null,
        duration_hours: null,
        valid_range_window: false,
        fallback_to_today_detected: false,
        conversation_id: null,
        user_message_id: null,
        job_id: null,
        task_identity: null,
        context_package_version: null,
        context_package_hash: null,
        context_package_id: null,
        input_fingerprint: null,
        serialized_input_bytes: null,
        provider_bound_request_captured: false,
        provider: null,
        model: null,
        capture_file_task_identity: null,
        analytical_evidence_summary: null,
        evidence_selection: {
          selection_profile: null,
          selected_level: null,
          default_level: null,
          selected_evidence_families: [],
          omitted_evidence_families: [],
          omission_reasons: [],
          significant_periods: [],
          targeted_windows: [],
          unknown_states: [],
          missing_states: [],
          excluded_states: [],
          not_selected_states: [],
          unresolved_reasons: [],
        },
        range_profile: null,
        compact_artifact_hash: null,
        compact_source_task_identity: null,
        status: 'FAIL',
        failure_stage: null,
        failure_reason: null,
      };

      try {
        const createConversationResponse = await request(apiApp.getHttpServer())
          .post(`/v1/patients/${relationship.patient_id}/conversations`)
          .set('Idempotency-Key', `fresh-multi-range-create-${runId}-${rangeCase.requested_label}`)
          .expect(201);
        row.conversation_id = String(createConversationResponse.body.conversation.id);

        const submitMessageResponse = await request(apiApp.getHttpServer())
          .post(`/v1/patients/${relationship.patient_id}/conversations/${row.conversation_id}/messages`)
          .set('Idempotency-Key', `fresh-multi-range-message-${runId}-${rangeCase.requested_label}`)
          .send({
            message_type: 'USER_MESSAGE',
            content: rangeCase.message,
          })
          .expect(200);

        const decision = String(submitMessageResponse.body.decision ?? '');
        row.user_message_id = String(submitMessageResponse.body.message?.id ?? '');
        if (decision !== 'ANALYSIS_REQUEST') {
          row.failure_stage = 'parser/normalization';
          row.failure_reason = `Expected ANALYSIS_REQUEST, got ${decision}`;
          validations.push(row);
          continue;
        }

        const queuedJob = await pollUntil<{ id: string; payload: Record<string, unknown> }>({
          description: `queued time_range job for conversation ${row.conversation_id}`,
          timeoutMs: 10_000,
          intervalMs: 200,
          run: async () => {
            const result = await pool.query<{ id: string; payload: Record<string, unknown> }>(
              `
                SELECT id::text, payload
                FROM jobs
                WHERE status = 'queued'
                  AND job_type = 'conversation.time_range_analysis'
                  AND correlation_id = $1::uuid
                ORDER BY created_at DESC
                LIMIT 1
              `,
              [row.conversation_id],
            );
            return result.rows[0] ?? null;
          },
        });

        row.job_id = queuedJob.id;
        const jobPayload = safeRecord(queuedJob.payload);
        row.actual_range_type = typeof jobPayload.range_type === 'string' ? String(jobPayload.range_type) : null;
        row.range_start = typeof jobPayload.range_start === 'string' ? String(jobPayload.range_start) : null;
        row.range_end = typeof jobPayload.range_end === 'string' ? String(jobPayload.range_end) : null;
        row.timezone = typeof jobPayload.timezone === 'string' ? String(jobPayload.timezone) : null;
        row.normalization_policy_version = typeof jobPayload.normalization_policy_version === 'string'
          ? String(jobPayload.normalization_policy_version)
          : null;

        if (!row.actual_range_type || !row.range_start || !row.range_end || !row.timezone) {
          row.failure_stage = 'API/task';
          row.failure_reason = 'Missing range fields in conversation.time_range_analysis payload';
          validations.push(row);
          continue;
        }

        const validationResult = validateNormalizedTimeRangeWindow({
          range_type: row.actual_range_type as ConversationTimeRangeType,
          range_start: row.range_start,
          range_end: row.range_end,
          timezone: row.timezone,
        });
        row.valid_range_window = validationResult.ok;
        row.duration_hours = computeDurationHours(row.range_start, row.range_end);
        row.fallback_to_today_detected = row.actual_range_type === 'TODAY' && rangeCase.expected_range_type !== 'TODAY';

        if (!validationResult.ok) {
          row.failure_stage = 'API/task';
          row.failure_reason = validationResult.reason;
          validations.push(row);
          continue;
        }

        const claimedJob = await claimQueuedTimeRangeJob({
          pool,
          conversationId: row.conversation_id,
          workerId: `fresh-multi-range-${runId}`,
        });

        if (!claimedJob) {
          row.failure_stage = 'worker';
          row.failure_reason = 'Unable to claim queued time_range job';
          validations.push(row);
          continue;
        }

        try {
          await workerService.handleConversationTimeRangeAnalysis(claimedJob.id, claimedJob.lease_token, claimedJob.payload);
        } catch (error) {
          row.failure_stage = 'worker';
          row.failure_reason = error instanceof Error ? error.message : String(error);
          validations.push(row);
          continue;
        }

        const execution = await pollUntil<ExecutionRow>({
          description: `succeeded ai_execution for conversation ${row.conversation_id}`,
          timeoutMs: 30_000,
          intervalMs: 300,
          run: async () => {
            const result = await pool.query<ExecutionRow>(
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
                  context_package_usage,
                  created_at::text,
                  status
                FROM ai_executions
                WHERE correlation_id = $1::text
                  AND task_type = 'CONVERSATION_TIME_RANGE_ANALYSIS'
                ORDER BY created_at DESC
                LIMIT 1
              `,
              [row.conversation_id],
            );
            const item = result.rows[0];
            if (!item || item.status !== 'succeeded') return null;
            return item;
          },
        });

        providerCallsActual += 1;
        row.provider = execution.provider;
        row.model = execution.model;
        row.task_identity = execution.task_identity;
        row.context_package_version = execution.context_package_version;
        row.context_package_hash = execution.context_package_hash;
        row.context_package_id = execution.context_package_id;
        row.input_fingerprint = execution.input_fingerprint;
        row.serialized_input_bytes = parseIntOrNull(execution.serialized_input_bytes);

        const contextResult = await pool.query<{ payload: Record<string, unknown> }>(
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

        const contextPayload = safeRecord(contextResult.rows[0]?.payload);
        const persistedRange = safeRecord(contextPayload.range);
        if (!persistedRange.range_type || !persistedRange.range_start || !persistedRange.range_end || !persistedRange.timezone) {
          row.failure_stage = 'ContextPackage';
          row.failure_reason = 'ContextPackage payload missing persisted range fields';
          validations.push(row);
          continue;
        }

        row.analytical_evidence_summary = safeRecord(contextPayload.evidence_sections);

        const capture = await pollCaptureRecord({
          captureFilePath,
          taskIdentity: execution.task_identity,
          timeoutMs: 20_000,
          intervalMs: 500,
        });

        if (!capture) {
          row.failure_stage = 'capture infrastructure';
          row.failure_reason = 'Capture record not found for task identity';
          validations.push(row);
          continue;
        }

        row.provider_bound_request_captured = true;
        row.capture_file_task_identity = capture.task_identity;

        const captureRange = capture.context_package.analysis_request_input;
        const consistentRange =
          String(persistedRange.range_type) === String(captureRange.range_type)
          && String(persistedRange.range_start) === String(captureRange.range_start)
          && String(persistedRange.range_end) === String(captureRange.range_end)
          && String(persistedRange.timezone) === String(captureRange.timezone);

        if (!consistentRange) {
          row.failure_stage = 'ContextPackage';
          row.failure_reason = 'Range mismatch between persisted ContextPackage and capture context package';
          validations.push(row);
          continue;
        }

        const shadow = safeRecord(execution.context_package_usage?.shadow_selection);
        row.evidence_selection = {
          selection_profile: typeof shadow.selection_profile === 'string' ? String(shadow.selection_profile) : null,
          selected_level: typeof shadow.selected_level === 'string' ? String(shadow.selected_level) : null,
          default_level: typeof shadow.default_level === 'string' ? String(shadow.default_level) : null,
          selected_evidence_families: toStringArray(shadow.selected_evidence_families),
          omitted_evidence_families: toStringArray(shadow.omitted_evidence_families),
          omission_reasons: toStringArray(shadow.omission_reasons),
          significant_periods: Array.isArray(shadow.significant_periods) ? shadow.significant_periods : [],
          targeted_windows: Array.isArray(shadow.targeted_windows) ? shadow.targeted_windows : [],
          unknown_states: toStringArray(shadow.unknowns),
          missing_states: toStringArray(shadow.missing),
          excluded_states: toStringArray(shadow.excluded),
          not_selected_states: toStringArray(shadow.not_selected),
          unresolved_reasons: toStringArray(shadow.unresolved_reasons),
        };

        row.range_profile = row.actual_range_type === 'TODAY'
          ? 'SINGLE_DAY'
          : row.actual_range_type;

        const contextRecord = capture.context_package;
        const compactArtifact = buildCompactDeliveryArtifact({
          contextPackage: contextRecord,
          task: asAiTask(execution),
        });
        row.compact_artifact_hash = compactArtifact.artifact_content_hash;
        row.compact_source_task_identity = compactArtifact.deterministic_replay_metadata.source_task_identity;

        if (row.actual_range_type !== rangeCase.expected_range_type) {
          row.failure_stage = 'parser/normalization';
          row.failure_reason = `Expected range_type ${rangeCase.expected_range_type}, got ${row.actual_range_type}`;
          validations.push(row);
          continue;
        }

        if (row.fallback_to_today_detected) {
          row.failure_stage = 'parser/normalization';
          row.failure_reason = 'Detected silent fallback to TODAY for non-TODAY request';
          validations.push(row);
          continue;
        }

        row.status = 'PASS';
        validations.push(row);
      } catch (error) {
        row.failure_stage = 'provider invocation';
        row.failure_reason = error instanceof Error ? error.message : String(error);
        validations.push(row);
      }
    }
  } finally {
    await workerApp.close();
    await apiApp.close();
    await pool.end();
  }

  const byLabel = new Map(validations.map((item) => [item.requested_label, item]));
  const sevenDay = byLabel.get('7D') ?? null;
  const fourteenDay = byLabel.get('14D') ?? null;

  const identityComparison = {
    seven_day_task_identity: sevenDay?.task_identity ?? null,
    fourteen_day_task_identity: fourteenDay?.task_identity ?? null,
    seven_day_context_hash: sevenDay?.context_package_hash ?? null,
    fourteen_day_context_hash: fourteenDay?.context_package_hash ?? null,
    seven_day_range_identity: sevenDay ? toRangeIdentity(sevenDay.actual_range_type, sevenDay.range_start, sevenDay.range_end) : null,
    fourteen_day_range_identity: fourteenDay ? toRangeIdentity(fourteenDay.actual_range_type, fourteenDay.range_start, fourteenDay.range_end) : null,
    different_task_identity: Boolean(sevenDay?.task_identity && fourteenDay?.task_identity && sevenDay.task_identity !== fourteenDay.task_identity),
    different_context_hash: Boolean(sevenDay?.context_package_hash && fourteenDay?.context_package_hash && sevenDay.context_package_hash !== fourteenDay.context_package_hash),
    different_range_identity: Boolean(
      sevenDay
      && fourteenDay
      && toRangeIdentity(sevenDay.actual_range_type, sevenDay.range_start, sevenDay.range_end)
        !== toRangeIdentity(fourteenDay.actual_range_type, fourteenDay.range_start, fourteenDay.range_end),
    ),
  };

  const expectedLabels = ranges.map((item) => item.requested_label);
  const passedLabels = validations.filter((item) => item.status === 'PASS').map((item) => item.requested_label);
  const missingLabels = expectedLabels.filter((label) => !passedLabels.includes(label));

  const allFivePassed = validations.length === 5 && missingLabels.length === 0;
  const identityOk = identityComparison.different_task_identity
    && identityComparison.different_context_hash
    && identityComparison.different_range_identity;

  const verdict = allFivePassed && identityOk
    ? 'MULTI_RANGE_CAPTURE_READY'
    : 'MULTI_RANGE_CAPTURE_BLOCKED';

  const report = {
    status: verdict,
    run_id: runId,
    generated_at: new Date().toISOString(),
    expected_cases: 5,
    expected_captures: ['TODAY', '3D', '7D', '14D', '30D'],
    expected_provider_invocations: 5,
    actual_provider_invocations: providerCallsActual,
    capture_file_path: captureFilePath,
    ranges: validations,
    identity_validation: identityComparison,
    missing_labels: missingLabels,
  };

  await writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  const tableRows = validations.map((item) => {
    return `| ${markdownTableEscape(item.requested_label)} | ${markdownTableEscape(item.actual_range_type)} | ${markdownTableEscape(item.range_start)} | ${markdownTableEscape(item.range_end)} | ${markdownTableEscape(item.timezone)} | ${markdownTableEscape(item.context_package_version)} | ${markdownTableEscape(item.evidence_selection.selection_profile)} | ${markdownTableEscape(item.evidence_selection.selected_level)} | ${item.provider_bound_request_captured ? 'YES' : 'NO'} |`;
  });

  const perRangeEvidence = validations.map((item) => {
    return [
      `### ${item.requested_label}`,
      `- status: ${item.status}`,
      `- selected families: ${item.evidence_selection.selected_evidence_families.join(', ') || '(none)'}`,
      `- omitted families: ${item.evidence_selection.omitted_evidence_families.join(', ') || '(none)'}`,
      `- L1/L2/L3 level: ${item.evidence_selection.selected_level ?? '(unknown)'}`,
      `- significant periods: ${JSON.stringify(item.evidence_selection.significant_periods)}`,
      `- targeted windows: ${JSON.stringify(item.evidence_selection.targeted_windows)}`,
      `- UNKNOWN: ${item.evidence_selection.unknown_states.join(', ') || '(none)'}`,
      `- MISSING: ${item.evidence_selection.missing_states.join(', ') || '(none)'}`,
      `- EXCLUDED: ${item.evidence_selection.excluded_states.join(', ') || '(none)'}`,
      `- NOT_SELECTED: ${item.evidence_selection.not_selected_states.join(', ') || '(none)'}`,
      `- omission reasons: ${item.evidence_selection.omission_reasons.join(', ') || '(none)'}`,
      `- unresolved reasons: ${item.evidence_selection.unresolved_reasons.join(', ') || '(none)'}`,
      item.failure_stage ? `- failure: ${item.failure_stage} :: ${item.failure_reason}` : '',
    ].filter((line) => line.length > 0).join('\n');
  }).join('\n\n');

  const markdown = [
    '# Fresh Multi-Range TIME_RANGE Capture Validation',
    '',
    `- run id: ${runId}`,
    `- generated at: ${new Date().toISOString()}`,
    `- expected cases: 5`,
    `- expected captures: TODAY, 3D, 7D, 14D, 30D`,
    `- expected provider invocations: 5`,
    `- actual provider invocations: ${providerCallsActual}`,
    '',
    '## Range matrix',
    '',
    '| Requested | range_type | Start | End | Timezone | Package | Profile | Level | Capture |',
    '|---|---|---|---|---|---|---|---|---|',
    ...tableRows,
    '',
    '## Identity validation',
    '',
    `- 7D task identity: ${identityComparison.seven_day_task_identity ?? '(missing)'}`,
    `- 14D task identity: ${identityComparison.fourteen_day_task_identity ?? '(missing)'}`,
    `- 7D context hash: ${identityComparison.seven_day_context_hash ?? '(missing)'}`,
    `- 14D context hash: ${identityComparison.fourteen_day_context_hash ?? '(missing)'}`,
    `- 7D range identity: ${identityComparison.seven_day_range_identity ?? '(missing)'}`,
    `- 14D range identity: ${identityComparison.fourteen_day_range_identity ?? '(missing)'}`,
    `- 7D vs 14D identity comparison: task_identity_diff=${identityComparison.different_task_identity}, context_hash_diff=${identityComparison.different_context_hash}, range_identity_diff=${identityComparison.different_range_identity}`,
    '',
    '## Evidence selection',
    '',
    perRangeEvidence,
    '',
    '## Provider calls',
    '',
    `- provider calls executed: ${providerCallsActual}`,
    '',
    '## Verdict',
    '',
    `- ${verdict}`,
    '',
    '## Capture file',
    '',
    `- ${captureFilePath}`,
  ].join('\n');

  await writeFile(reportMdPath, `${markdown}\n`, { encoding: 'utf8', mode: 0o600 });

  console.log(JSON.stringify({
    status: verdict,
    run_id: runId,
    expected_cases: 5,
    actual_cases: validations.length,
    expected_provider_invocations: 5,
    actual_provider_invocations: providerCallsActual,
    report_json_path: reportJsonPath,
    report_md_path: reportMdPath,
    capture_file_path: captureFilePath,
  }, null, 2));
}

if (require.main === module) {
  void main().catch((error) => {
    console.error('[fresh-multi-range-capture-validation] failed');
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
