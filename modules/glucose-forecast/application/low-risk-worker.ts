import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PostgresDashboardRepository } from '@infra/db/postgres-dashboard.repository';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { PostgresLowRiskAlertRepository } from '@infra/db/postgres-low-risk-alert.repository';
import { PushNotificationService } from '@modules/notifications/application/push-notification.service';
import { isLowRiskCensorEnabled, isLowRiskRescueSource, LOW_RISK_ALERT_POLICY, LowRiskAlertService } from './low-risk-alert.service';
import { isPredictionExperimentEnabled, predictionFlagOn } from './prediction-engine';

/** Off with PREDICTION_LOW_ALERT_ENABLED=false (or 0), or with the whole prediction experiment off. */
export function isLowRiskAlertEnabled(env: Record<string, string | undefined>): boolean {
  return isPredictionExperimentEnabled(env) && predictionFlagOn(env, 'PREDICTION_LOW_ALERT_ENABLED');
}

/** Every minute: for listed people's patients with the experiment on, score each new reading and push an alarm. */
@Injectable()
export class LowRiskAlertWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('LowRisk');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly service: LowRiskAlertService | null;

  constructor(
    @Inject(DATABASE_POOL) pool: Pool,
    @Inject(PostgresGlucoMindRepository) repository: PostgresGlucoMindRepository,
    @Inject(PushNotificationService) push: PushNotificationService,
  ) {
    if (!isLowRiskAlertEnabled(process.env)) {
      this.service = null;
      return;
    }
    const readings = new PostgresDashboardRepository(pool);
    const store = new PostgresLowRiskAlertRepository(pool);
    this.service = new LowRiskAlertService({
      store,
      alertTimes: isLowRiskCensorEnabled(process.env) ? (patientId, sinceIso) => store.listPushedAlertTimes(patientId, sinceIso) : undefined,
      scoreOnly: isLowRiskRescueSource(process.env),
      push,
      readingsSince: async (patientId, sinceIso) => (await readings.listGlucoseReadingsSince(patientId, sinceIso)).map((reading) => ({ at: reading.at, value: reading.value })),
      carbTimes: async (patientId, fromIso, toIso) => {
        const rows = await repository.listCarbEntriesBetween(patientId, fromIso, toIso);
        return rows.filter((row) => row.kind !== 'IGNORED' && Number(row.payload?.carbs) > 0).map((row) => new Date(row.occurred_at).toISOString()).sort();
      },
      log: (event) => this.logger.log(JSON.stringify(event)),
    });
  }

  onModuleInit(): void {
    if (!this.service) return;
    this.timer = setInterval(() => void this.tick(), LOW_RISK_ALERT_POLICY.tick_ms);
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
      await this.service.tick(new Date());
    } catch (error) {
      this.logger.warn(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
