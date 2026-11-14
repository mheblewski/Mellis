import type { DashboardDeviceStatus, DashboardResponse } from './dashboard-snapshot';
import type { NowCheckPush } from './now-situation';

/**
 * The pushes "Mellis powiadomi" promises (now-situation.v1, HANDOFF stage 5), once a minute, only for a patient with rescue
 * carbs in the last hour. One push per carb entry and result, to every phone with glucose alerts on. A claim stops two
 * workers; a send that reached no phone gives it back, so the next minute tries again.
 */
export class NowSituationCheckWorker {
  constructor(private readonly deps: {
    listPatients(): Promise<string[]>;
    listDevices(patientId: string): Promise<Array<{ push_token: string; low_alert_on?: boolean }>>;
    hasRecentCarbs(patientId: string, sinceIso: string, untilIso: string): Promise<boolean>;
    dashboard(patientId: string, now: Date): Promise<{ dashboard: DashboardResponse; sources: { readings: Array<{ at: string; value: number }>; loopStatus: DashboardDeviceStatus | null } }>;
    checkPush(args: { patientId: string; viewerUserId: null; now: Date; dashboard: DashboardResponse; sources: { readings: Array<{ at: string; value: number }>; loopStatus: DashboardDeviceStatus | null } }): Promise<NowCheckPush | null>;
    claim(patientId: string, push: NowCheckPush, now: Date): Promise<boolean>;
    release(patientId: string, key: string): Promise<void>;
    send(input: { patientId: string; pushToken: string; key: string; title: string; body: string }): Promise<void>;
    onPushError?(pushToken: string, error: unknown): Promise<void>;
    log(event: Record<string, unknown>): void;
  }) {}

  async run(now = new Date()): Promise<number> {
    let sent = 0;
    for (const patientId of await this.deps.listPatients()) {
      try {
        if (await this.evaluate(patientId, now)) sent += 1;
      } catch (error) {
        this.deps.log({ event: 'now_situation_check_failed', patient_id: patientId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return sent;
  }

  private async evaluate(patientId: string, now: Date): Promise<boolean> {
    const since = new Date(now.getTime() - 60 * 60_000).toISOString();
    if (!(await this.deps.hasRecentCarbs(patientId, since, new Date(now.getTime() + 1).toISOString()))) return false;
    const { dashboard, sources } = await this.deps.dashboard(patientId, now);
    const push = await this.deps.checkPush({ patientId, viewerUserId: null, now, dashboard, sources });
    if (!push || !(await this.deps.claim(patientId, push, now))) return false;
    let delivered = 0;
    let skipped = 0;
    for (const device of await this.deps.listDevices(patientId)) {
      // That phone's own low alert says it already.
      if (push.skip_if_low_alert && device.low_alert_on) {
        skipped += 1;
        continue;
      }
      try {
        await this.deps.send({ patientId, pushToken: device.push_token, key: push.key, title: push.title, body: push.body });
        delivered += 1;
      } catch (error) {
        await this.deps.onPushError?.(device.push_token, error);
        this.deps.log({ event: 'now_situation_check_push_failed', patient_id: patientId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (delivered === 0 && skipped === 0) {
      await this.deps.release(patientId, push.key);
      return false;
    }
    this.deps.log({ event: 'now_situation_check_push_sent', patient_id: patientId, kind: push.kind, devices: delivered, skipped_low_alert: skipped });
    return true;
  }
}
