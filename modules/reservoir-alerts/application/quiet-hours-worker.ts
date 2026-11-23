import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { PostgresQuietHeldRepository } from '@infra/db/postgres-quiet-held.repository';
import { PostgresQuietHoursRepository } from '@infra/db/postgres-quiet-hours.repository';
import { DashboardAssembler } from '@modules/dashboard/application/dashboard-assembler';
import { PushNotificationService } from '@modules/notifications/application/push-notification.service';
import { resolveHomeTimeZone } from '@shared/primitives/home-time-zone';
import { equipmentNow } from './quiet-equipment';
import { QuietHoursService } from './quiet-hours-service';

const TICK_MS = 60_000;

/**
 * Quiet hours around the night (quiet-hours.v1 stage 2): every minute it sends what waited for the end of a phone's
 * quiet hours and, half an hour before them, what runs out at night. No switch: held pushes would never leave without it.
 */
@Injectable()
export class QuietHoursWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('QuietHours');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly service: QuietHoursService;

  constructor(
    @Inject(DATABASE_POOL) pool: Pool,
    @Inject(PostgresGlucoMindRepository) repository: PostgresGlucoMindRepository,
    @Inject(PushNotificationService) push: PushNotificationService,
  ) {
    const dashboards = DashboardAssembler.fromEnv(pool, repository);
    const settings = new PostgresQuietHoursRepository(pool);
    this.service = new QuietHoursService({
      store: new PostgresQuietHeldRepository(pool),
      settingsFor: (pushToken) => settings.forPushToken(pushToken),
      equipment: async (patientId, now) => {
        const { dashboard, sources } = await dashboards.dashboardWithSources(patientId, now);
        return equipmentNow(dashboard, sources.careEvents?.reservoir_changed_at ?? null);
      },
      deliver: (envelope) => push.deliverQuietHoursPush(envelope),
      homeTimeZone: resolveHomeTimeZone(),
      log: (event) => this.logger.log(JSON.stringify(event)),
    });
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
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
      await this.service.run(new Date());
    } finally {
      this.running = false;
    }
  }
}
