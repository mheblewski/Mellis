import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { PostgresReservoirAlertsRepository } from '@infra/db/postgres-reservoir-alerts.repository';
import { DashboardAssembler } from '@modules/dashboard/application/dashboard-assembler';
import { PushNotificationService } from '@modules/notifications/application/push-notification.service';
import { RESERVOIR_ALERT_POLICY, ReservoirAlertService } from './reservoir-alerts';
import { BatteryAlertService } from './battery-alerts';

/** Off with RESERVOIR_ALERTS_ENABLED=false (or 0); on otherwise. */
export function isReservoirAlertsEnabled(env: NodeJS.ProcessEnv): boolean {
  return !/^(false|0)$/i.test(String(env.RESERVOIR_ALERTS_ENABLED ?? 'true').trim());
}

/** Off with BATTERY_ALERTS_ENABLED=false (or 0); on otherwise. */
export function isBatteryAlertsEnabled(env: NodeJS.ProcessEnv): boolean {
  return !/^(false|0)$/i.test(String(env.BATTERY_ALERTS_ENABLED ?? 'true').trim());
}

/**
 * The worker's equipment push timer: every 5 minutes it reads each patient's dashboard (what the app shows) and pushes
 * once per level and fill to the phones with "Zbiornik insuliny" on (reservoir-alerts.v1), and once per level and
 * charge to the phones with "Bateria pompy" on (battery-alerts.v1).
 */
@Injectable()
export class ReservoirAlertWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ReservoirAlerts');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly service: ReservoirAlertService | null;
  private readonly battery: BatteryAlertService | null;

  constructor(
    @Inject(DATABASE_POOL) pool: Pool,
    @Inject(PostgresGlucoMindRepository) repository: PostgresGlucoMindRepository,
    @Inject(PushNotificationService) push: PushNotificationService,
  ) {
    const dashboards = DashboardAssembler.fromEnv(pool, repository);
    const store = new PostgresReservoirAlertsRepository(pool);
    this.battery = isBatteryAlertsEnabled(process.env)
      ? new BatteryAlertService({
          store,
          push,
          dashboard: (patientId, now) => dashboards.dashboard(patientId, now),
          log: (event) => this.logger.log(JSON.stringify(event)),
        })
      : null;
    if (!isReservoirAlertsEnabled(process.env)) {
      this.service = null;
      return;
    }
    this.service = new ReservoirAlertService({
      store,
      push,
      dashboard: async (patientId, now) => {
        const { dashboard, sources } = await dashboards.dashboardWithSources(patientId, now);
        return { dashboard, changedAt: sources.careEvents?.reservoir_changed_at ?? null };
      },
      log: (event) => this.logger.log(JSON.stringify(event)),
    });
  }

  onModuleInit(): void {
    if (!this.service && !this.battery) return;
    this.timer = setInterval(() => void this.tick(), RESERVOIR_ALERT_POLICY.tick_ms);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      await this.service?.run(now);
      await this.battery?.run(now);
    } finally {
      this.running = false;
    }
  }
}
