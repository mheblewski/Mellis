import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { ApiService } from '../apps/api/src/application/api.service';
import { WorkerService } from '../apps/worker/src/worker.service';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { AiGatewayService } from '@modules/ai-gateway/application/ai-gateway.service';
import { FakeAiProvider } from '@modules/ai-gateway/infrastructure/fake-ai-provider';
import { PushNotificationService } from '@modules/notifications/application/push-notification.service';

const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/gluco_mind';
const BENCHMARK_VERSION = 'local-performance-baseline.v3';

const BENCHMARK_CONFIG = {
  totalRuns: 8,
  calibrationRuns: 2,
  apiWarmupIterations: 20,
  apiMeasuredIterations: 120,
  workerWarmupJobs: 10,
  workerMeasuredJobs: 60,
};

interface ComponentSamples {
  api_latency_ms: number[];
  worker_execution_ms: number[];
  queue_wait_ms: number[];
}

interface SummaryStats {
  count: number;
  mean: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

interface ComponentRunSummary {
  run_index: number;
  sample_count: number;
  stats: SummaryStats;
}

interface BenchmarkRunResult {
  run_index: number;
  included_in_repeatability: boolean;
  timestamp_utc: string;
  workload: {
    api_warmup_iterations: number;
    api_measured_iterations: number;
    worker_warmup_jobs: number;
    worker_measured_jobs: number;
    replay_dataset_files: number;
    replay_dataset_version: string;
  };
  samples: ComponentSamples;
  summaries: {
    api_latency_ms: ComponentRunSummary;
    worker_execution_ms: ComponentRunSummary;
    queue_wait_ms: ComponentRunSummary;
  };
}

interface RepeatabilityMetric {
  metric: keyof ComponentSamples;
  run_means: number[];
  run_medians: number[];
  mean_of_run_means: number;
  median_of_run_medians: number;
  run_mean_p10: number;
  run_mean_p90: number;
  run_mean_band_width_percent: number;
  run_mean_cv_percent: number;
  run_mean_relative_spread_percent: number;
}

interface BaselineDocument {
  benchmark_version: string;
  generated_at_utc: string;
  repo_version: string;
  node_version: string;
  platform: string;
  environment: {
    database_url_present: boolean;
    database_host: string | null;
    database_name: string | null;
    benchmark_mode: 'local-synthetic-steady-state';
  };
  methodology: {
    benchmark_runs_total: number;
    benchmark_runs_measured: number;
    benchmark_runs_calibration: number;
    warmup_policy: string;
    statistical_representation: string;
    queue_wait_boundary: string;
    worker_execution_boundary: string;
  };
  replay_dataset: {
    files: number;
    version: string;
    role_in_benchmark: string;
  };
  repeatability: {
    representation: string;
    metrics: RepeatabilityMetric[];
  };
  limitations: string[];
  runs: BenchmarkRunResult[];
}

function parseDatabaseInfo(connectionString: string | undefined): { host: string | null; name: string | null } {
  if (!connectionString) {
    return { host: null, name: null };
  }

  try {
    const url = new URL(connectionString);
    return {
      host: url.hostname,
      name: url.pathname.replace(/^\//, ''),
    };
  } catch {
    return { host: null, name: null };
  }
}

function toFixedNumber(value: number, precision = 3): number {
  return Number(value.toFixed(precision));
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const center = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[center - 1] + sorted[center]) / 2;
  }

  return sorted[center];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);

  if (lower === upper) {
    return sorted[lower];
  }

  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function stdDev(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }

  const avg = mean(values);
  const variance = values.reduce((total, value) => total + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function buildSummary(values: number[]): SummaryStats {
  return {
    count: values.length,
    mean: toFixedNumber(mean(values)),
    median: toFixedNumber(median(values)),
    p95: toFixedNumber(percentile(values, 0.95)),
    min: toFixedNumber(Math.min(...values)),
    max: toFixedNumber(Math.max(...values)),
  };
}

function cvPercent(values: number[]): number {
  const avg = mean(values);
  if (avg === 0) {
    return 0;
  }

  return toFixedNumber((stdDev(values) / Math.abs(avg)) * 100);
}

function relativeSpreadPercent(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const med = Math.max(Math.abs(median(values)), 1e-9);
  const spread = percentile(values, 0.9) - percentile(values, 0.1);
  return toFixedNumber((spread / med) * 100);
}

async function createSyntheticPatientData(pool: Pool): Promise<{ patientId: string; userId: string }> {
  const patientId = randomUUID();
  const userId = randomUUID();

  await pool.query(
    `
      INSERT INTO users (id, display_name)
      VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
    `,
    [userId, 'local-benchmark-user'],
  );

  await pool.query(
    `
      INSERT INTO patients (id, display_name)
      VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
    `,
    [patientId, 'local-benchmark-patient'],
  );

  await pool.query(
    `
      INSERT INTO caregiver_relationships (user_id, patient_id, relationship_type, permissions)
      VALUES ($1, $2, 'primary_caregiver', '{}'::jsonb)
      ON CONFLICT (user_id, patient_id, relationship_type) DO UPDATE SET updated_at = now()
    `,
    [userId, patientId],
  );

  return { patientId, userId };
}

async function cleanupSyntheticPatientData(pool: Pool, patientId: string, userId: string): Promise<void> {
  await pool.query(`DELETE FROM jobs WHERE patient_id = $1::uuid AND job_type = 'benchmark.synthetic_worker'`, [patientId]);
  await pool.query(`DELETE FROM caregiver_relationships WHERE user_id = $1::uuid AND patient_id = $2::uuid`, [userId, patientId]);
  await pool.query(`DELETE FROM patients WHERE id = $1::uuid`, [patientId]);
  await pool.query(`DELETE FROM users WHERE id = $1::uuid`, [userId]);
}

async function measureApiLatency(args: {
  pool: Pool;
  repository: PostgresGlucoMindRepository;
  userId: string;
  warmupIterations: number;
  measuredIterations: number;
}): Promise<number[]> {
  const apiService = new ApiService(args.repository, args.pool);
  const principal = {
    user_id: args.userId,
    auth_provider: 'COGNITO',
    auth_subject: `local-benchmark/${args.userId}`,
  } as const;

  const samples: number[] = [];
  const totalIterations = args.warmupIterations + args.measuredIterations;

  for (let i = 0; i < totalIterations; i += 1) {
    const started = performance.now();
    await apiService.listAccessiblePatients(principal);
    const elapsed = performance.now() - started;

    if (i >= args.warmupIterations) {
      samples.push(elapsed);
    }
  }

  return samples;
}

async function measureWorkerTiming(args: {
  repository: PostgresGlucoMindRepository;
  patientId: string;
  warmupJobs: number;
  measuredJobs: number;
}): Promise<{ queueWaitMs: number[]; workerExecutionMs: number[] }> {
  const configService = new ConfigService({});
  const aiGateway = new AiGatewayService(new FakeAiProvider());
  const pushService = new PushNotificationService(
    {
      send: async () => undefined,
    } as any,
  );

  const nightscoutStub = {
    ensureNightscoutSource: async () => ({
      id: 'benchmark-nightscout-source',
      patient_id: args.patientId,
      source_system: 'NIGHTSCOUT',
      source_key: args.patientId,
      sync_cursor: null,
      last_successful_observed_at: null,
      source_version: 'nightscout.v1',
      metadata: {},
    }),
    enqueueRecurringSyncJobs: async () => ({ sources: 0, jobs_enqueued: 0 }),
    runNightscoutSyncJob: async () => ({
      entries: { fetched: 0, imported: 0, deduplicated: 0, rejected: 0, events_created: 0, jobs_enqueued: 0 },
      treatments: { fetched: 0, imported: 0, deduplicated: 0, rejected: 0, events_created: 0, jobs_enqueued: 0 },
      records_fetched: 0,
      records_imported: 0,
      records_deduplicated: 0,
      records_rejected: 0,
      events_created: 0,
      jobs_enqueued: 0,
    }),
  } as any;

  const worker = new WorkerService(args.repository, nightscoutStub, configService, aiGateway, pushService);

  const queueWaitMs: number[] = [];
  const workerExecutionMs: number[] = [];
  const totalJobs = args.warmupJobs + args.measuredJobs;
  const enqueueCompletionTimes: number[] = [];

  for (let i = 0; i < totalJobs; i += 1) {
    const dedupeKey = `benchmark.synthetic_worker:${randomUUID()}`;

    await args.repository.insertJob({
      jobType: 'benchmark.synthetic_worker',
      payloadVersion: 1,
      payload: { benchmark: true, iteration: i, patient_id: args.patientId },
      dedupeKey,
      correlationId: randomUUID(),
      causationId: null,
      patientId: args.patientId,
      availableAt: new Date().toISOString(),
      maxAttempts: 3,
    });

    enqueueCompletionTimes.push(performance.now());
  }

  for (let i = 0; i < totalJobs; i += 1) {
    const processStart = performance.now();
    await worker.processOnce();
    const processEnd = performance.now();

    if (i >= args.warmupJobs) {
      queueWaitMs.push(processStart - enqueueCompletionTimes[i]);
      workerExecutionMs.push(processEnd - processStart);
    }
  }

  return { queueWaitMs, workerExecutionMs };
}

function buildRunSummary(runIndex: number, values: number[]): ComponentRunSummary {
  return {
    run_index: runIndex,
    sample_count: values.length,
    stats: buildSummary(values),
  };
}

async function runBenchmarkIteration(args: {
  runIndex: number;
  includeInRepeatability: boolean;
  pool: Pool;
  repository: PostgresGlucoMindRepository;
  replayDatasetFiles: number;
  replayDatasetVersion: string;
}): Promise<BenchmarkRunResult> {
  const { patientId, userId } = await createSyntheticPatientData(args.pool);

  try {
    const apiLatency = await measureApiLatency({
      pool: args.pool,
      repository: args.repository,
      userId,
      warmupIterations: BENCHMARK_CONFIG.apiWarmupIterations,
      measuredIterations: BENCHMARK_CONFIG.apiMeasuredIterations,
    });

    const worker = await measureWorkerTiming({
      repository: args.repository,
      patientId,
      warmupJobs: BENCHMARK_CONFIG.workerWarmupJobs,
      measuredJobs: BENCHMARK_CONFIG.workerMeasuredJobs,
    });

    return {
      run_index: args.runIndex,
      included_in_repeatability: args.includeInRepeatability,
      timestamp_utc: new Date().toISOString(),
      workload: {
        api_warmup_iterations: BENCHMARK_CONFIG.apiWarmupIterations,
        api_measured_iterations: BENCHMARK_CONFIG.apiMeasuredIterations,
        worker_warmup_jobs: BENCHMARK_CONFIG.workerWarmupJobs,
        worker_measured_jobs: BENCHMARK_CONFIG.workerMeasuredJobs,
        replay_dataset_files: args.replayDatasetFiles,
        replay_dataset_version: args.replayDatasetVersion,
      },
      samples: {
        api_latency_ms: apiLatency,
        worker_execution_ms: worker.workerExecutionMs,
        queue_wait_ms: worker.queueWaitMs,
      },
      summaries: {
        api_latency_ms: buildRunSummary(args.runIndex, apiLatency),
        worker_execution_ms: buildRunSummary(args.runIndex, worker.workerExecutionMs),
        queue_wait_ms: buildRunSummary(args.runIndex, worker.queueWaitMs),
      },
    };
  } finally {
    await cleanupSyntheticPatientData(args.pool, patientId, userId);
  }
}

function buildRepeatabilityMetrics(runs: BenchmarkRunResult[]): RepeatabilityMetric[] {
  const measuredRuns = runs.filter((run) => run.included_in_repeatability);
  const metrics: Array<keyof ComponentSamples> = [
    'api_latency_ms',
    'worker_execution_ms',
    'queue_wait_ms',
  ];

  return metrics.map((metric) => {
    const runMeans = measuredRuns.map((run) => run.summaries[metric].stats.mean);
    const runMedians = measuredRuns.map((run) => run.summaries[metric].stats.median);

    return {
      metric,
      run_means: runMeans,
      run_medians: runMedians,
      mean_of_run_means: toFixedNumber(mean(runMeans)),
      median_of_run_medians: toFixedNumber(median(runMedians)),
      run_mean_p10: toFixedNumber(percentile(runMeans, 0.1)),
      run_mean_p90: toFixedNumber(percentile(runMeans, 0.9)),
      run_mean_band_width_percent: relativeSpreadPercent(runMeans),
      run_mean_cv_percent: cvPercent(runMeans),
      run_mean_relative_spread_percent: relativeSpreadPercent(runMeans),
    };
  });
}

function readReplayDatasetFileCount(): number {
  const replayDatasetDir = join(process.cwd(), 'artifacts', 'replay-dataset');

  try {
    return readdirSync(replayDatasetDir).filter((entry) => entry.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const repoVersion = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version as string;
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const replayDatasetFiles = readReplayDatasetFileCount();
  const replayDatasetVersion = 'context-package-replay-dataset.v1';

  const pool = new Pool({ connectionString: databaseUrl });
  const repository = new PostgresGlucoMindRepository(pool as any);

  try {
    const runs: BenchmarkRunResult[] = [];

    for (let i = 0; i < BENCHMARK_CONFIG.totalRuns; i += 1) {
      const run = await runBenchmarkIteration({
        runIndex: i + 1,
        includeInRepeatability: i >= BENCHMARK_CONFIG.calibrationRuns,
        pool,
        repository,
        replayDatasetFiles,
        replayDatasetVersion,
      });
      runs.push(run);
    }

    const repeatabilityMetrics = buildRepeatabilityMetrics(runs);

    const document: BaselineDocument = {
      benchmark_version: BENCHMARK_VERSION,
      generated_at_utc: new Date().toISOString(),
      repo_version: repoVersion,
      node_version: process.version,
      platform: `${process.platform}/${process.arch}`,
      environment: {
        database_url_present: Boolean(databaseUrl),
        database_host: parseDatabaseInfo(databaseUrl).host,
        database_name: parseDatabaseInfo(databaseUrl).name,
        benchmark_mode: 'local-synthetic-steady-state',
      },
      methodology: {
        benchmark_runs_total: BENCHMARK_CONFIG.totalRuns,
        benchmark_runs_measured: BENCHMARK_CONFIG.totalRuns - BENCHMARK_CONFIG.calibrationRuns,
        benchmark_runs_calibration: BENCHMARK_CONFIG.calibrationRuns,
        warmup_policy: 'Each component has explicit warm-up samples that are executed but excluded from reported metrics.',
        statistical_representation: 'Repeatability is represented by per-run sample distributions plus cross-run CV and relative spread of run means.',
        queue_wait_boundary: 'Queue wait is measured in benchmark harness as monotonic elapsed time between enqueue completion and worker polling start under a controlled local backlog batch.',
        worker_execution_boundary: 'Worker execution is measured in benchmark harness as monotonic elapsed time of worker.processOnce().',
      },
      replay_dataset: {
        files: replayDatasetFiles,
        version: replayDatasetVersion,
        role_in_benchmark: 'Dataset presence/version is recorded for provenance; benchmark workload remains synthetic and deterministic.',
      },
      repeatability: {
        representation: 'Use median_of_run_medians as baseline center and run_mean_p10..run_mean_p90 as expected local-noise band.',
        metrics: repeatabilityMetrics,
      },
      limitations: [
        'This benchmark is local-only and does not represent production capacity or production SLO behavior.',
        'The workload is synthetic and uses FakeAiProvider; it does not exercise networked model providers.',
        'The worker benchmark uses a benchmark.synthetic_worker no-op job path to isolate queue and finalize overhead.',
        'Run-to-run variability still depends on local machine background activity, Node runtime state, and local PostgreSQL process scheduling.',
      ],
      runs,
    };

    const outputDir = join(process.cwd(), 'artifacts');
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, 'local-performance-baseline.json');
    writeFileSync(outputPath, JSON.stringify(document, null, 2));

    console.log(
      JSON.stringify(
        {
          output_path: outputPath,
          benchmark_version: BENCHMARK_VERSION,
          repeatability: document.repeatability,
          methodology: document.methodology,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Local performance baseline failed: ${message}`);
  process.exit(1);
});
