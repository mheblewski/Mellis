import { createHash } from 'crypto';
import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import type { WidgetPushSender } from '@modules/notifications/infrastructure/apns-push-notification-provider';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';
import type { WidgetPushTarget } from '@infra/db/postgres-widget-push.repository';
import { decideWidgetPush } from '../domain/widget-push-throttle';

export interface WidgetPushStore {
  listTargets(): Promise<WidgetPushTarget[]>;
  markPushed(args: { token: string; patientId: string; readingAt: string; value: number; level: string; now: Date }): Promise<void>;
  markEvaluated(args: { token: string; patientId: string; readingAt: string; now: Date }): Promise<void>;
  markDeferred(args: { token: string; patientId: string; readingAt: string; now: Date }): Promise<void>;
  deleteToken(token: string): Promise<void>;
}

export interface WidgetPushPusherDeps {
  store: WidgetPushStore;
  sender: WidgetPushSender;
  dashboard: (patientId: string, now: Date) => Promise<DashboardResponse>;
  log: (event: Record<string, unknown>) => void;
}

/**
 * Tells registered widgets (the Apple Watch complications) to reload on a patient's new reading (widget-push.v1): one dashboard read per patient per tick, the throttle rule per token+patient, a JSON log line for
 * every push and every skip of a new reading (to measure Apple's push budget), gone tokens deleted. Never throws.
 */
export class WidgetPushPusher {
  constructor(private readonly deps: WidgetPushPusherDeps) {}

  async tick(now: Date = new Date()): Promise<void> {
    try {
      const targets = await this.deps.store.listTargets();
      const dashboards = new Map<string, Promise<DashboardResponse | null>>();
      // The token's last push across its patients, updated as this tick pushes.
      const tokenLastPushedAt = new Map<string, string | null>();
      const goneTokens = new Set<string>();
      for (const target of targets) {
        if (!tokenLastPushedAt.has(target.token)) tokenLastPushedAt.set(target.token, target.token_last_pushed_at);
      }
      for (const target of targets) {
        if (goneTokens.has(target.token)) continue;
        let dashboard = dashboards.get(target.patient_id);
        if (!dashboard) {
          dashboard = this.deps.dashboard(target.patient_id, now).catch(() => null);
          dashboards.set(target.patient_id, dashboard);
        }
        const data = await dashboard;
        if (!data?.glucose) continue;
        await this.handle(target, { at: data.glucose.observed_at, value: data.glucose.value }, now, tokenLastPushedAt, goneTokens);
      }
    } catch (error) {
      this.deps.log({ event: 'widget_push_tick_failed', error: errorCode(error) });
    }
  }

  private async handle(
    target: WidgetPushTarget,
    reading: { at: string; value: number },
    now: Date,
    tokenLastPushedAt: Map<string, string | null>,
    goneTokens: Set<string>,
  ): Promise<void> {
    const decision = decideWidgetPush({
      reading,
      state: target.has_state ? target : null,
      tokenLastPushedAt: tokenLastPushedAt.get(target.token) ?? null,
      now,
    });
    const ids = {
      token: shortTokenId(target.token),
      patient: target.patient_id.slice(0, 8),
      platform: target.platform,
      environment: target.environment,
      level: decision.level,
      reading_age_s: Math.round((now.getTime() - Date.parse(reading.at)) / 1000),
    };

    if (!decision.push) {
      // A reading already decided on is looked at every tick: no log, no write.
      if (decision.reason === 'same_reading' || decision.reason === 'older_reading') return;
      // The token cap: retried on later ticks, logged once per reading.
      if (sameInstant(reading.at, target.deferred_reading_at)) return;
      await this.deps.store.markDeferred({ token: target.token, patientId: target.patient_id, readingAt: reading.at, now });
      this.deps.log({ event: 'widget_push_skipped', ...ids, reason: decision.reason });
      return;
    }

    try {
      await this.deps.sender.sendWidgetUpdate(target.token, { topic: target.topic, environment: target.environment, priority: decision.priority });
    } catch (error) {
      if (isGoneToken(error)) {
        goneTokens.add(target.token);
        await this.deps.store.deleteToken(target.token);
        this.deps.log({ event: 'widget_push_token_deleted', ...ids, reason: decision.reason, error: errorCode(error) });
        return;
      }
      // Not retried for this reading: a failing APNs never turns into a push every 15 s.
      await this.deps.store.markEvaluated({ token: target.token, patientId: target.patient_id, readingAt: reading.at, now });
      this.deps.log({ event: 'widget_push_failed', ...ids, reason: decision.reason, error: errorCode(error) });
      return;
    }
    tokenLastPushedAt.set(target.token, now.toISOString());
    await this.deps.store.markPushed({ token: target.token, patientId: target.patient_id, readingAt: reading.at, value: reading.value, level: decision.level, now });
    this.deps.log({ event: 'widget_push_sent', ...ids, reason: decision.reason, priority: decision.priority });
  }
}

function sameInstant(a: string, b: string | null): boolean {
  return b !== null && Date.parse(a) === Date.parse(b);
}

function isGoneToken(error: unknown): boolean {
  return error instanceof PushNotificationProviderError && (error.code === 'DEVICE_TOKEN_INVALID' || error.code === 'DEVICE_TOKEN_UNREGISTERED');
}

function errorCode(error: unknown): string {
  return error instanceof PushNotificationProviderError ? error.code : error instanceof Error ? error.name : 'UNKNOWN';
}

/** Tells tokens apart in logs without carrying them. */
export function shortTokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 10);
}
