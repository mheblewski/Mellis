import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { PostgresLiveActivityRepository } from '@infra/db/postgres-live-activity.repository';
import { PUSH_NOTIFICATION_PROVIDER } from '@modules/notifications/infrastructure/push-notification-provider.token';
import type { LiveActivityPushSender } from '@modules/notifications/infrastructure/apns-push-notification-provider';
import { DashboardAssembler } from '@modules/dashboard/application/dashboard-assembler';
import { LiveActivityPusher } from './live-activity-pusher';

/** How often the worker looks for new readings to push (Nightscout readings come every 5 min, 1 for some sensors). */
export const LIVE_ACTIVITY_TICK_MS = 15_000;

/**
 * The worker's Live Activity timer (live-activity.v1). Off with LIVE_ACTIVITY_PUSH_ENABLED=false, and with a push
 * provider that cannot send Live Activity pushes (the fake one in tests and local runs).
 */
@Injectable()
export class LiveActivityWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('LiveActivity');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly pusher: LiveActivityPusher | null;

  constructor(
    @Inject(DATABASE_POOL) pool: Pool,
    @Inject(PostgresGlucoMindRepository) repository: PostgresGlucoMindRepository,
    @Inject(PUSH_NOTIFICATION_PROVIDER) provider: unknown,
  ) {
    const sender = provider as Partial<LiveActivityPushSender>;
    const enabled = !/^(false|0)$/i.test(String(process.env.LIVE_ACTIVITY_PUSH_ENABLED ?? 'true').trim());
    if (!enabled || typeof sender.sendLiveActivity !== 'function') {
      this.pusher = null;
      return;
    }
    const dashboards = DashboardAssembler.fromEnv(pool, repository);
    this.pusher = new LiveActivityPusher({
      store: new PostgresLiveActivityRepository(pool),
      sender: sender as LiveActivityPushSender,
      dashboard: (patientId, now) => dashboards.dashboard(patientId, now),
      patientName: async (patientId) => {
        const row = (await pool.query<{ display_name: string | null }>('SELECT display_name FROM patients WHERE id = $1::uuid', [patientId])).rows[0];
        return row?.display_name?.trim() || 'Mellis';
      },
      log: (event) => this.logger.log(JSON.stringify(event)),
    });
  }

  onModuleInit(): void {
    if (!this.pusher) return;
    this.timer = setInterval(() => void this.tick(), LIVE_ACTIVITY_TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running || !this.pusher) return;
    this.running = true;
    try {
      await this.pusher.tick(new Date());
    } finally {
      this.running = false;
    }
  }
}
