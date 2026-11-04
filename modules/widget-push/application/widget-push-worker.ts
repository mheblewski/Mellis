import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { PostgresWidgetPushRepository } from '@infra/db/postgres-widget-push.repository';
import { PUSH_NOTIFICATION_PROVIDER } from '@modules/notifications/infrastructure/push-notification-provider.token';
import type { WidgetPushSender } from '@modules/notifications/infrastructure/apns-push-notification-provider';
import { DashboardAssembler } from '@modules/dashboard/application/dashboard-assembler';
import { WidgetPushPusher } from './widget-push-pusher';

/** How often the worker looks for new readings (as the Live Activity timer). */
export const WIDGET_PUSH_TICK_MS = 15_000;

export function widgetPushEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(false|0)$/i.test(String(env.WIDGET_PUSH_ENABLED ?? 'true').trim());
}

/**
 * The worker's WidgetKit push timer (widget-push.v1). Off with WIDGET_PUSH_ENABLED=false, and with a push provider
 * that cannot send widget pushes (the fake one in tests and local runs).
 */
@Injectable()
export class WidgetPushWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('WidgetPush');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly pusher: WidgetPushPusher | null;

  constructor(
    @Inject(DATABASE_POOL) pool: Pool,
    @Inject(PostgresGlucoMindRepository) repository: PostgresGlucoMindRepository,
    @Inject(PUSH_NOTIFICATION_PROVIDER) provider: unknown,
  ) {
    const sender = provider as Partial<WidgetPushSender>;
    if (!widgetPushEnabled() || typeof sender.sendWidgetUpdate !== 'function') {
      this.pusher = null;
      return;
    }
    const dashboards = DashboardAssembler.fromEnv(pool, repository);
    this.pusher = new WidgetPushPusher({
      store: new PostgresWidgetPushRepository(pool),
      sender: sender as WidgetPushSender,
      dashboard: (patientId, now) => dashboards.dashboard(patientId, now),
      log: (event) => this.logger.log(JSON.stringify(event)),
    });
  }

  onModuleInit(): void {
    if (!this.pusher) return;
    this.timer = setInterval(() => void this.tick(), WIDGET_PUSH_TICK_MS);
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
