import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PostgresReleaseCheckRepository } from '@infra/db/postgres-release-check.repository';
import { PushNotificationService } from '@modules/notifications/application/push-notification.service';
import { RELEASE_CHECK_POLICY, ReleaseCheckService, isReleaseCheckEnabled, releaseRepo } from './release-check';

/** The worker's release timer (release-check.v1): looks every hour whether the daily check is due, and once at start. */
@Injectable()
export class ReleaseCheckWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ReleaseCheck');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly service: ReleaseCheckService | null;

  constructor(
    @Inject(DATABASE_POOL) pool: Pool,
    @Inject(PushNotificationService) push: PushNotificationService,
  ) {
    const serverVersion = process.env.MELLIS_VERSION?.trim() || null;
    this.service = isReleaseCheckEnabled(process.env) && serverVersion
      ? new ReleaseCheckService({
          store: new PostgresReleaseCheckRepository(pool),
          push,
          serverVersion,
          fetchReleases: () => fetchReleases(releaseRepo(process.env)),
          log: (event) => this.logger.log(JSON.stringify(event)),
        })
      : null;
  }

  onModuleInit(): void {
    if (!this.service) return;
    this.timer = setInterval(() => void this.tick(), RELEASE_CHECK_POLICY.tick_ms);
    this.timer.unref?.();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.service?.run(new Date());
    } finally {
      this.running = false;
    }
  }
}

async function fetchReleases(repo: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Mellis-server' },
    signal: AbortSignal.timeout(RELEASE_CHECK_POLICY.fetch_timeout_ms),
  });
  if (!response.ok) throw Object.assign(new Error('GitHub answered with an error'), { code: `GITHUB_${response.status}` });
  return response.json();
}
