import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { PostgresGlucoseAlertsRepository } from '@infra/db/postgres-glucose-alerts.repository';
import { DashboardAssembler } from '@modules/dashboard/application/dashboard-assembler';
import { PushNotificationService } from '@modules/notifications/application/push-notification.service';
import { GLUCOSE_ALERT_POLICY, GlucoseAlertService } from './glucose-alerts';

/** Off with GLUCOSE_ALERTS_ENABLED=false (or 0); on otherwise (every phone still starts with the section off). */
export function isGlucoseAlertsEnabled(env: NodeJS.ProcessEnv): boolean {
  return !/^(false|0)$/i.test(String(env.GLUCOSE_ALERTS_ENABLED ?? 'true').trim());
}

/**
 * The worker's glucose push timer (glucose-alerts.v1): every minute it reads the dashboard (the glucose, arrow, change
 * and IOB/COB the app shows, live Nightscout first) of each patient with a phone that has "Powiadomienia o glikemii" on.
 */
@Injectable()
export class GlucoseAlertWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('GlucoseAlerts');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly service: GlucoseAlertService | null;

  constructor(
    @Inject(DATABASE_POOL) pool: Pool,
    @Inject(PostgresGlucoMindRepository) repository: PostgresGlucoMindRepository,
    @Inject(PushNotificationService) push: PushNotificationService,
  ) {
    if (!isGlucoseAlertsEnabled(process.env)) {
      this.service = null;
      return;
    }
    const dashboards = DashboardAssembler.fromEnv(pool, repository);
    this.service = new GlucoseAlertService({
      store: new PostgresGlucoseAlertsRepository(pool),
      push,
      dashboard: (patientId, now) => dashboards.dashboard(patientId, now),
      log: (event) => this.logger.log(JSON.stringify(event)),
    });
  }

  onModuleInit(): void {
    if (!this.service) return;
    this.timer = setInterval(() => void this.tick(), GLUCOSE_ALERT_POLICY.tick_ms);
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
