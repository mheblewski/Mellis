import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PostgresDashboardRepository } from '@infra/db/postgres-dashboard.repository';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { PostgresPredictionRepository } from '@infra/db/postgres-prediction.repository';
import { PostgresRescueCarbsRepository } from '@infra/db/postgres-rescue-carbs.repository';
import { DashboardAssembler } from '@modules/dashboard/application/dashboard-assembler';
import { isPredictionExperimentEnabled } from './prediction-engine';
import { PREDICTION_SERVICE_POLICY, PredictionService, type PredictionSources } from './prediction-service';

/** Reads, for the service, from the same places the app's dashboard and carb entries come from. */
export function predictionSourcesFrom(args: { pool: Pool; repository: PostgresGlucoMindRepository; live: PredictionSources['live'] }): PredictionSources {
  const readings = new PostgresDashboardRepository(args.pool);
  const rescue = new PostgresRescueCarbsRepository(args.pool);
  return {
    store: new PostgresPredictionRepository(args.pool),
    live: args.live,
    readingsSince: async (patientId, sinceIso) => (await readings.listGlucoseReadingsSince(patientId, sinceIso)).map((reading) => ({ at: reading.at, value: reading.value })),
    carbTimes: async (patientId, fromIso, toIso) => {
      const rows = await args.repository.listCarbEntriesBetween(patientId, fromIso, toIso);
      return rows
        .filter((row) => row.kind !== 'IGNORED' && Number(row.payload?.carbs) > 0)
        .map((row) => new Date(row.occurred_at).toISOString())
        .sort();
    },
    activeAlert: async (patientId) => Boolean(await rescue.getActiveAlert(patientId).catch(() => null)),
  };
}

/** Every two minutes, for patients with the experiment on only: a refit about daily, and the line logged at each new reading. */
@Injectable()
export class PredictionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Prediction');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly service: PredictionService | null;

  constructor(@Inject(DATABASE_POOL) pool: Pool, @Inject(PostgresGlucoMindRepository) repository: PostgresGlucoMindRepository) {
    if (!isPredictionExperimentEnabled(process.env)) {
      this.service = null;
      return;
    }
    const dashboards = DashboardAssembler.fromEnv(pool, repository);
    this.service = new PredictionService(predictionSourcesFrom({
      pool,
      repository,
      live: async (patientId, now) => {
        const { sources } = await dashboards.dashboardWithSources(patientId, now);
        return { readings: sources.readings, loopStatus: sources.loopStatus };
      },
    }));
  }

  onModuleInit(): void {
    if (!this.service) return;
    this.timer = setInterval(() => void this.tick(), PREDICTION_SERVICE_POLICY.tick_ms);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running || !this.service) return;
    this.running = true;
    try {
      await this.service.tick(new Date(), (event) => this.logger.log(JSON.stringify(event)));
    } catch (error) {
      this.logger.warn(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
