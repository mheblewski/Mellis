import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
// The compact builder this tool needs does not exist; see compact-prompt-builder.ts (the tool fails closed).
import { assertCompactPromptBuilderAvailable, buildCompactTimeRangeAnalysisPrompt, CompactPromptBuilderUnavailableError } from './compact-prompt-builder';
import { buildOpenAiResponsesRequestBody } from '@modules/ai-gateway/infrastructure/openai-provider';
import { buildCompactDeliveryArtifactFromRuntime } from '@modules/context/application/compact-delivery-artifact';
import type { AiTask, TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';
import { describeErrorSafely, positionalArguments, requireInputFileArgument, resolveEvaluationOutputDir, writeEvaluationOutputDirFile } from './evaluation-output-dir';

interface CaptureTaskEnvelope {
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
}

interface CaptureRecord {
  captured_at: string;
  capture_version: string;
  task_identity: string;
  task: CaptureTaskEnvelope;
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

// Usage: tsx scripts/evaluation/generate-evidence-payload-inspection.ts <capture.ndjson> --output-dir <dir outside every Git working tree>
// The capture and every output (including the full model request) contain patient data: there is no default input
// or output, and the output directory is validated before the capture is read.

function byteSize(value: unknown): number {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function asTask(record: CaptureRecord): AiTask {
  return {
    task_id: record.task.task_id,
    task_type: record.task.task_type as AiTask['task_type'],
    task_version: record.task.task_version,
    context_package_id: record.task.context_package_id,
    context_package_version: record.task.context_package_version,
    context_package_hash: record.task.context_package_hash,
    prompt_version: record.task.prompt_version,
    output_schema_version: record.task.output_schema_version,
    model_policy_version: record.task.model_policy_version,
    correlation_id: record.task.correlation_id,
    created_at: record.task.created_at,
    patient_id: String(record.context_package.patient_ref?.patient_id ?? ''),
  };
}

function isTodayTimeRange(record: CaptureRecord): boolean {
  return record.task.task_type === 'CONVERSATION_TIME_RANGE_ANALYSIS'
    && record.context_package.analysis_request_input?.range_type === 'TODAY';
}

function selectCapture(records: CaptureRecord[]): CaptureRecord {
  const candidates = records.filter(isTodayTimeRange);
  if (candidates.length === 0) {
    throw new Error('No CONVERSATION_TIME_RANGE_ANALYSIS TODAY record found in fixture.');
  }

  candidates.sort((left, right) => String(right.task.created_at).localeCompare(String(left.task.created_at)));
  return candidates[0];
}

function buildSectionSizes(userPayloadObject: Record<string, unknown>): Array<{
  section: string;
  bytes: number;
  percent_of_user_payload: number;
}> {
  const userPayloadBytes = byteSize(JSON.stringify(userPayloadObject));

  return Object.entries(userPayloadObject)
    .map(([section, value]) => {
      const size = byteSize(value);
      return {
        section,
        bytes: size,
        percent_of_user_payload: userPayloadBytes > 0 ? Number(((size / userPayloadBytes) * 100).toFixed(4)) : 0,
      };
    })
    .sort((a, b) => b.bytes - a.bytes);
}

function asPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const outputBaseDir = resolveEvaluationOutputDir(argv);
  const fixturePath = requireInputFileArgument(positionalArguments(argv)[0], '<capture.ndjson> argument');
  // Before the capture is read: without the compact builder the tool could only fail after reading patient data.
  assertCompactPromptBuilderAvailable();
  const raw = await readFile(fixturePath, 'utf8');
  const rows = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CaptureRecord);

  const selected = selectCapture(rows);
  const task = asTask(selected);

  const compactArtifact = buildCompactDeliveryArtifactFromRuntime({
    contextPackage: selected.context_package,
    task,
  });

  const compactPrompt = buildCompactTimeRangeAnalysisPrompt(task, selected.context_package, compactArtifact as unknown as Record<string, unknown>);
  const finalRequest = buildOpenAiResponsesRequestBody({
    model: selected.model,
    task_type: task.task_type,
    system_instructions: compactPrompt.system_instructions,
    user_payload: compactPrompt.user_payload,
  });

  const requestObject = finalRequest as Record<string, unknown>;
  const inputArray = Array.isArray(requestObject.input) ? requestObject.input as Array<Record<string, unknown>> : [];
  const systemEntry = inputArray.find((entry) => entry.role === 'system');
  const userEntry = inputArray.find((entry) => entry.role === 'user');

  const systemInstructions = safeString(systemEntry?.content);
  const userPayload = safeString(userEntry?.content);
  const userPayloadObject = JSON.parse(userPayload) as Record<string, unknown>;

  const requestBytes = byteSize(finalRequest);
  const systemBytes = byteSize(systemInstructions);
  const userPayloadBytes = byteSize(userPayload);
  const schemaBytes = byteSize((requestObject.text ?? null));
  const modelBytes = byteSize((requestObject.model ?? ''));
  const envelopeBytes = requestBytes - modelBytes - systemBytes - userPayloadBytes - schemaBytes;

  const sectionSizes = buildSectionSizes(userPayloadObject);

  const runTag = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z-${randomUUID().slice(0, 8)}`;
  const runDirName = `inspection-${runTag}`;
  const outputDir = join(outputBaseDir, runDirName);

  const finalRequestPath = writeEvaluationOutputDirFile(outputBaseDir, `${runDirName}/final-model-request.json`, `${asPrettyJson(finalRequest)}\n`);

  const readableLines: string[] = [];
  readableLines.push('# Model Input Readable');
  readableLines.push('');
  readableLines.push('This file presents the actual offline-generated model input built by current production builders from the selected fixture.');
  readableLines.push('');
  readableLines.push('## Selected Fixture and Task');
  readableLines.push('');
  readableLines.push(`- fixture_file: ${fixturePath}`);
  readableLines.push(`- task_identity: ${selected.task_identity}`);
  readableLines.push(`- task_type: ${selected.task.task_type}`);
  readableLines.push(`- range_type: ${selected.context_package.analysis_request_input.range_type}`);
  readableLines.push(`- range_start: ${selected.context_package.analysis_request_input.range_start}`);
  readableLines.push(`- range_end: ${selected.context_package.analysis_request_input.range_end}`);
  readableLines.push(`- timezone: ${selected.context_package.analysis_request_input.timezone}`);
  readableLines.push('');

  readableLines.push('## System Instructions (Exact)');
  readableLines.push('');
  readableLines.push('```text');
  readableLines.push(systemInstructions);
  readableLines.push('```');
  readableLines.push('');

  readableLines.push('## User Payload (Exact JSON)');
  readableLines.push('');
  readableLines.push('```json');
  readableLines.push(asPrettyJson(userPayloadObject));
  readableLines.push('```');
  readableLines.push('');

  readableLines.push('## Task, Time Range, Timezone');
  readableLines.push('');
  readableLines.push('```json');
  readableLines.push(asPrettyJson(userPayloadObject.task ?? null));
  readableLines.push('```');
  readableLines.push('');
  readableLines.push('```json');
  readableLines.push(asPrettyJson(userPayloadObject.analysis_request_input ?? null));
  readableLines.push('```');
  readableLines.push('');

  readableLines.push('## Current Glucose and Therapy State');
  readableLines.push('');
  readableLines.push('```json');
  readableLines.push(asPrettyJson(userPayloadObject.current_state_snapshot ?? null));
  readableLines.push('```');
  readableLines.push('');

  readableLines.push('## Compact Delivery Artifact (Exact JSON)');
  readableLines.push('');
  readableLines.push('```json');
  readableLines.push(asPrettyJson(userPayloadObject.compact_delivery_artifact ?? null));
  readableLines.push('```');
  readableLines.push('');

  readableLines.push('## Missing or Unknown or Excluded or Not Selected Data States');
  readableLines.push('');
  readableLines.push('```json');
  readableLines.push(asPrettyJson((userPayloadObject.compact_delivery_artifact as Record<string, unknown> | undefined)?.status_summary ?? null));
  readableLines.push('```');
  readableLines.push('');

  readableLines.push('## Conversation Context and User Message');
  readableLines.push('');
  readableLines.push('```json');
  readableLines.push(asPrettyJson(userPayloadObject.conversation_context ?? null));
  readableLines.push('```');
  readableLines.push('');

  readableLines.push('## Evidence and Semantics Contracts Sent to Model');
  readableLines.push('');
  readableLines.push('```json');
  readableLines.push(asPrettyJson(userPayloadObject.evidence_contract ?? null));
  readableLines.push('```');
  readableLines.push('');
  readableLines.push('```json');
  readableLines.push(asPrettyJson(userPayloadObject.compact_semantic_contract ?? null));
  readableLines.push('```');
  readableLines.push('');
  readableLines.push('```json');
  readableLines.push(asPrettyJson(userPayloadObject.historical_therapy_semantics_contract ?? null));
  readableLines.push('```');
  readableLines.push('');

  readableLines.push('## Output Schema and Request Parameters');
  readableLines.push('');
  readableLines.push('```json');
  readableLines.push(asPrettyJson(requestObject.text ?? null));
  readableLines.push('```');
  readableLines.push('');

  const readablePath = writeEvaluationOutputDirFile(outputBaseDir, `${runDirName}/model-input-readable.md`, `${readableLines.join('\n')}\n`);

  const sizeLines: string[] = [];
  sizeLines.push('# Payload Section Sizes');
  sizeLines.push('');
  sizeLines.push('## Request-level Sizes');
  sizeLines.push('');
  sizeLines.push(`- total_request_bytes: ${requestBytes}`);
  sizeLines.push(`- model_bytes: ${modelBytes}`);
  sizeLines.push(`- system_instructions_bytes: ${systemBytes}`);
  sizeLines.push(`- user_payload_bytes: ${userPayloadBytes}`);
  sizeLines.push(`- output_schema_bytes: ${schemaBytes}`);
  sizeLines.push(`- request_envelope_overhead_bytes: ${envelopeBytes}`);
  sizeLines.push('');
  sizeLines.push('## User Payload Sections');
  sizeLines.push('');
  sizeLines.push('| section | bytes | percent_of_user_payload |');
  sizeLines.push('|---|---:|---:|');
  for (const row of sectionSizes) {
    sizeLines.push(`| ${row.section} | ${row.bytes} | ${row.percent_of_user_payload}% |`);
  }
  sizeLines.push('');

  sizeLines.push('## Duplicate Information Signals');
  sizeLines.push('');
  sizeLines.push('- user question appears in analysis_request_input.user_message_text and conversation_context.recent_messages.');
  sizeLines.push('- current_state_snapshot may overlap semantically with compact artifact current-state family summary.');
  sizeLines.push('- provenance_summary in payload coexists with provenance-related decisions inside compact_delivery_artifact.');
  sizeLines.push('');
  sizeLines.push('## Token Estimation');
  sizeLines.push('');
  sizeLines.push('- no token approximation added in this file to avoid implying model-token equivalence without tokenizer-based computation.');
  sizeLines.push('');

  const sizesPath = writeEvaluationOutputDirFile(outputBaseDir, `${runDirName}/payload-section-sizes.md`, `${sizeLines.join('\n')}\n`);

  const readmeLines: string[] = [];
  readmeLines.push('# Evidence Payload Inspection Output');
  readmeLines.push('');
  readmeLines.push('## Fixture');
  readmeLines.push('');
  readmeLines.push(`- fixture_file: ${fixturePath}`);
  readmeLines.push(`- selected_task_identity: ${selected.task_identity}`);
  readmeLines.push(`- selected_task_type: ${selected.task.task_type}`);
  readmeLines.push(`- selected_range_type: ${selected.context_package.analysis_request_input.range_type}`);
  readmeLines.push(`- selected_range_start: ${selected.context_package.analysis_request_input.range_start}`);
  readmeLines.push(`- selected_range_end: ${selected.context_package.analysis_request_input.range_end}`);
  readmeLines.push('');
  readmeLines.push('## What Is Exactly Reproduced');
  readmeLines.push('');
  readmeLines.push('- compact delivery artifact built by current production builder functions.');
  readmeLines.push('- compact prompt built by current production prompt builder.');
  readmeLines.push('- final provider-bound request body built by current production OpenAI request serializer.');
  readmeLines.push('');
  readmeLines.push('## What Is Reconstruction, Not Historical Runtime Replay');
  readmeLines.push('');
  readmeLines.push('- the produced final-model-request.json is generated now from current code and stored fixture context.');
  readmeLines.push('- it is not a byte-identical claim of the historical request sent in the past.');
  readmeLines.push('- the fixture historical request exists in request_representation and can differ from current-code reconstruction.');
  readmeLines.push('');
  readmeLines.push('## Historical vs Current Snapshot (Bytes)');
  readmeLines.push('');
  readmeLines.push(`- historical_captured_request_bytes: ${byteSize(selected.request_representation)}`);
  readmeLines.push(`- current_reconstructed_request_bytes: ${requestBytes}`);
  readmeLines.push(`- delta_bytes_current_minus_historical: ${requestBytes - byteSize(selected.request_representation)}`);
  readmeLines.push('');
  readmeLines.push('## How To Re-run');
  readmeLines.push('');
  readmeLines.push('From repository root:');
  readmeLines.push('');
  readmeLines.push('```bash');
  readmeLines.push('npx tsx scripts/evaluation/generate-evidence-payload-inspection.ts <capture.ndjson> --output-dir "$(mktemp -d)"');
  readmeLines.push('```');
  readmeLines.push('');
  readmeLines.push('## Generated Files');
  readmeLines.push('');
  readmeLines.push('- final-model-request.json');
  readmeLines.push('- model-input-readable.md');
  readmeLines.push('- payload-section-sizes.md');
  readmeLines.push('- README.md');
  readmeLines.push('');

  const readmePath = writeEvaluationOutputDirFile(outputBaseDir, `${runDirName}/README.md`, `${readmeLines.join('\n')}\n`);

  const stdout = {
    status: 'EVIDENCE_PAYLOAD_INSPECTION_GENERATED',
    fixture_file: fixturePath,
    selected_task_identity: selected.task_identity,
    output_dir: outputDir,
    files: {
      final_model_request: finalRequestPath,
      model_input_readable: readablePath,
      payload_section_sizes: sizesPath,
      readme: readmePath,
    },
    request_bytes: {
      reconstructed_current: requestBytes,
      captured_historical: byteSize(selected.request_representation),
      delta_current_minus_historical: requestBytes - byteSize(selected.request_representation),
    },
  };

  process.stdout.write(`${JSON.stringify(stdout, null, 2)}\n`);
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`[generate-evidence-payload-inspection] failed: ${describeErrorSafely(error, [CompactPromptBuilderUnavailableError])}\n`);
    process.exitCode = 1;
  });
}
