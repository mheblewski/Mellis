import { resolveEvaluationOutputDir, writeEvaluationOutputDirFile } from '../evaluation/evaluation-output-dir';

/**
 * Shared arguments for the scripts/reconstruction-*.ts investigation tools. They read one AI execution and the
 * conversation behind it, so their output is patient-derived: the execution is always passed explicitly and files go
 * only to a validated --output-dir outside every Git working tree. Arguments are validated before any database access.
 */
export class ReconstructionArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconstructionArgumentError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = 'Pass --execution-id <ai_executions.id> (a UUID).';

/** The single `--execution-id <uuid>` or `--execution-id=<uuid>` value, lower-cased; anything else is refused. */
export function parseExecutionIdArgument(argv: readonly string[]): string {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--execution-id') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw new ReconstructionArgumentError(`Missing value for --execution-id. ${USAGE}`);
      values.push(value);
      index += 1;
    } else if (arg.startsWith('--execution-id=')) {
      values.push(arg.slice('--execution-id='.length));
    }
  }
  if (values.length === 0) throw new ReconstructionArgumentError(`Missing required --execution-id. ${USAGE}`);
  if (values.length > 1) throw new ReconstructionArgumentError(`--execution-id was given more than once. ${USAGE}`);
  // The value is never echoed: it identifies a real record.
  if (!UUID.test(values[0])) throw new ReconstructionArgumentError(`--execution-id is not a UUID. ${USAGE}`);
  return values[0].toLowerCase();
}

export interface ReconstructionArguments {
  executionId: string;
  outputDir: string;
}

/** --execution-id plus a validated (not yet created) --output-dir. */
export function parseReconstructionArguments(argv: readonly string[]): ReconstructionArguments {
  const executionId = parseExecutionIdArgument(argv);
  const outputDir = resolveEvaluationOutputDir(argv);
  return { executionId, outputDir };
}

/** Creates the validated output directory (0700) and writes one file in it (0600) through the capture guard. */
export function writeReconstructionOutput(outputDir: string, fileName: string, content: string): string {
  return writeEvaluationOutputDirFile(outputDir, fileName, content);
}

export interface TimeRangeExecutionIdentifiers {
  jobId: string;
  conversationId: string;
  messageId: string;
  patientId: string;
  rangeType: string;
  rangeStart: string;
  rangeEnd: string;
}

const ISO_INSTANT = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z';
const UUID_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// apps/worker/src/worker.service.ts builds CONVERSATION_TIME_RANGE_ANALYSIS tasks as
//   task_id            = `${jobId}:${conversationId}:${userMessageId}:${rangeType.toLowerCase()}:${rangeStartIso}:${rangeEndIso}`
//   context_package_id = `conversation-time-range:${conversationId}:user-message:${userMessageId}:${same range identity}`
//   correlation_id     = conversationId
const TASK_ID = new RegExp(`^(${UUID_PART}):(${UUID_PART}):(${UUID_PART}):([a-z_]+):(${ISO_INSTANT}):(${ISO_INSTANT})$`, 'i');

/**
 * Job, conversation, user message, patient and range of a CONVERSATION_TIME_RANGE_ANALYSIS execution, derived from the
 * identifiers the worker stores on the ai_executions row. All three stored forms must agree; otherwise this throws
 * instead of guessing. Error messages never include the identifiers themselves.
 */
export function deriveTimeRangeExecutionIdentifiers(execution: Record<string, unknown> | undefined): TimeRangeExecutionIdentifiers {
  if (!execution) throw new ReconstructionArgumentError('Execution not found.');
  if (execution.task_type !== 'CONVERSATION_TIME_RANGE_ANALYSIS') {
    throw new ReconstructionArgumentError('Execution is not a CONVERSATION_TIME_RANGE_ANALYSIS task; related records cannot be derived.');
  }
  const match = TASK_ID.exec(String(execution.task_id ?? ''));
  if (!match) throw new ReconstructionArgumentError('Execution task_id does not have the expected time-range format; related records cannot be derived.');
  const [, jobId, conversationId, messageId, rangeType, rangeStart, rangeEnd] = match;
  if (String(execution.correlation_id ?? '').toLowerCase() !== conversationId.toLowerCase()) {
    throw new ReconstructionArgumentError('Execution correlation_id does not match the conversation in task_id; refusing to guess.');
  }
  const expectedPackageId = `conversation-time-range:${conversationId}:user-message:${messageId}:${rangeType}:${rangeStart}:${rangeEnd}`;
  if (String(execution.context_package_id ?? '').toLowerCase() !== expectedPackageId.toLowerCase()) {
    throw new ReconstructionArgumentError('Execution context_package_id does not match task_id; refusing to guess.');
  }
  const patientId = String(execution.patient_id ?? '').trim();
  if (!UUID.test(patientId)) throw new ReconstructionArgumentError('Execution has no patient_id; related records cannot be derived.');
  return {
    jobId: jobId.toLowerCase(),
    conversationId: conversationId.toLowerCase(),
    messageId: messageId.toLowerCase(),
    patientId: patientId.toLowerCase(),
    rangeType: rangeType.toUpperCase(),
    rangeStart,
    rangeEnd,
  };
}
