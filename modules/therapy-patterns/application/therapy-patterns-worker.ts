import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PushNotificationService } from '@modules/notifications/application/push-notification.service';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';
import { resolveHomeTimeZone } from '@shared/primitives/home-time-zone';
import { isTherapyPatternsEnabled } from './therapy-patterns-flag';
import { therapyPatternsStore } from './therapy-patterns-store';
import { TherapyPatternsService } from './therapy-patterns.service';

/** Every 15 minutes: whose nightly run is due (once per local night, after 04:00), then the due pushes. */
const TICK_MS = 15 * 60_000;

/** The worker's "Wzorce" timer (therapy-patterns.v1); nothing runs with THERAPY_PATTERNS_ENABLED=false. */
@Injectable()
export class TherapyPatternsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('TherapyPatterns');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly patterns: TherapyPatternsService | null;

  constructor(@Inject(DATABASE_POOL) pool: Pool, @Inject(PushNotificationService) push: PushNotificationService) {
    this.patterns = isTherapyPatternsEnabled(process.env)
      ? new TherapyPatternsService({
        store: therapyPatternsStore(pool),
        push,
        defaultTimezone: resolveHomeTimeZone,
        log: (event) => this.logger.log(JSON.stringify(event)),
        isDeadToken: (error) => error instanceof PushNotificationProviderError && (error.code === 'DEVICE_TOKEN_INVALID' || error.code === 'DEVICE_TOKEN_UNREGISTERED'),
      })
      : null;
  }

  onModuleInit(): void {
    if (!this.patterns) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running || !this.patterns) return;
    this.running = true;
    try {
      await this.patterns.runDue(new Date()).catch((error) => this.logger.warn(`therapy patterns run failed: ${(error as Error).message}`));
      await this.patterns.sendDue(new Date()).catch((error) => this.logger.warn(`therapy patterns pushes failed: ${(error as Error).message}`));
    } finally {
      this.running = false;
    }
  }
}
