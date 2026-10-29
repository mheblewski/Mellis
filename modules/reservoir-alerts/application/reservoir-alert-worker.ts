import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { PostgresReservoirAlertsRepository } from '@infra/db/postgres-reservoir-alerts.repository';
import { DashboardAssembler } from '@modules/dashboard/application/dashboard-assembler';
import { PushNotificationService } from '@modules/notifications/application/push-notification.service';
import { RESERVOIR_ALERT_POLICY, ReservoirAlertService } from './reservoir-alerts';

/** Off with RESERVOIR_ALERTS_ENABLED=false (or 0); on otherwise. */
export function isReservoirAlertsEnabled(env: NodeJS.ProcessEnv): boolean {
  return !/^(false|0)$/i.test(String(env.RESERVOIR_ALERTS_ENABLED ?? 'true').trim());
}

/**
 * The worker's reservoir push timer (reservoir-alerts.v1): every 5 minutes it reads each patient's dashboard (the same
 * reservoir level the app shows) and pushes once per level and fill to the phones with "Zbiornik insuliny" on.
 */
@Injectable()
export class ReservoirAlertWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ReservoirAlerts');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly service: ReservoirAlertService | null;

  constructor(
    @Inject(DATABASE_POOL) pool: Pool,
    @Inject(PostgresGlucoMindRepository) repository: PostgresGlucoMindRepository,
    @Inject(PushNotificationService) push: PushNotificationService,
  ) {
    if (!isReservoirAlertsEnabled(process.env)) {
      this.service = null;
      return;
    }
    const dashboards = DashboardAssembler.fromEnv(pool, repository);
    this.service = new ReservoirAlertService({
      store: new PostgresReservoirAlertsRepository(pool),
      push,
      dashboard: async (patientId, now) => {
        const { dashboard, sources } = await dashboards.dashboardWithSources(patientId, now);
        return { dashboard, changedAt: sources.careEvents?.reservoir_changed_at ?? null };
      },
      log: (event) => this.logger.log(JSON.stringify(event)),
    });
  }

  onModuleInit(): void {
    if (!this.service) return;
    this.timer = setInterval(() => void this.tick(), RESERVOIR_ALERT_POLICY.tick_ms);
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
      await this.service.run(new Date());
    } finally {
      this.running = false;
    }
  }
}
