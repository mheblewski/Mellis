import { APP_LINK_ORIGIN, type PushNotificationEnvelope } from '@modules/notifications/domain/push-notification';
import { localParts } from '@modules/local-time/local-time';
import { heldGroup, inQuietHours, QUIET_HOURS_POLICY, quietEndAfter, quietStartsAt, type QuietHoursSettings } from '@modules/notifications/application/quiet-hours';
import { AFTER_QUIET_TITLE, afterQuietItems, BEFORE_QUIET_TITLE, beforeQuietItems, EMPTY_RESERVOIR_TEXT, gathered, type EquipmentNow } from './quiet-equipment';

export interface QuietHeldPush {
  id: string;
  push_token: string;
  patient_id: string;
  notification_type: string;
  envelope: PushNotificationEnvelope;
  held_at: string;
  release_after: string;
}

export interface QuietPhone extends QuietHoursSettings {
  device_id: string;
  push_token: string;
  patient_id: string;
  reservoir_on: boolean;
  battery_on: boolean;
  site_on: boolean;
}

export interface QuietHoursDeps {
  store: {
    listWaiting(): Promise<QuietHeldPush[]>;
    markReleased(ids: string[], outcome: string): Promise<boolean>;
    listQuietPhones(): Promise<QuietPhone[]>;
    claimPreCheck(deviceId: string, localDate: string): Promise<boolean>;
  };
  settingsFor(pushToken: string): Promise<QuietHoursSettings | null>;
  equipment(patientId: string, now: Date): Promise<EquipmentNow>;
  deliver(envelope: PushNotificationEnvelope): Promise<void>;
  homeTimeZone: string;
  log(event: Record<string, unknown>): void;
}

/**
 * The quiet-hours worker step (quiet-hours.v1 stage 2), every minute:
 * - release: what waited goes out once the phone's quiet hours are over (or turned off / moved): information as it was
 *   (within 2 h of the end), equipment checked again and gathered into one push per patient ("Po godzinach ciszy"), an
 *   empty reservoir on its own, time-sensitive;
 * - before: half an hour before a phone's quiet hours, once per night, one push per patient with what runs out before
 *   their end + 1 h.
 */
export class QuietHoursService {
  constructor(private readonly deps: QuietHoursDeps) {}

  async run(now: Date): Promise<void> {
    await this.release(now).catch((error) => this.deps.log({ event: 'quiet_hours_release_failed', error_code: code(error) }));
    await this.beforeQuiet(now).catch((error) => this.deps.log({ event: 'quiet_hours_before_failed', error_code: code(error) }));
  }

  async release(now: Date): Promise<void> {
    const waiting = await this.deps.store.listWaiting();
    const groups = new Map<string, QuietHeldPush[]>();
    for (const row of waiting) {
      const key = `${row.push_token}|${row.patient_id}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const rows of groups.values()) {
      const { push_token: pushToken, patient_id: patientId } = rows[0]!;
      const settings = await this.deps.settingsFor(pushToken).catch(() => null);
      if (inQuietHours(settings, now)) continue;
      // The claim first: a second worker sees them released.
      if (!(await this.deps.store.markReleased(rows.map((row) => row.id), 'released'))) continue;
      const information = rows.filter((row) => heldGroup(row.notification_type) !== 'equipment');
      const equipment = rows.filter((row) => heldGroup(row.notification_type) === 'equipment');
      let sent = 0;
      let expired = 0;
      for (const row of information) {
        if (now.getTime() - Date.parse(row.release_after) > QUIET_HOURS_POLICY.information_expires_ms) { expired += 1; continue; }
        sent += await this.send(row.envelope);
      }
      if (equipment.length > 0) sent += await this.releaseEquipment(patientId, pushToken, equipment, settings?.time_zone ?? this.deps.homeTimeZone, now);
      this.deps.log({ event: 'quiet_hours_released', patient_id: patientId, held: rows.length, sent, expired });
    }
  }

  private async releaseEquipment(patientId: string, pushToken: string, rows: QuietHeldPush[], timeZone: string, now: Date): Promise<number> {
    let current: EquipmentNow;
    try {
      current = await this.deps.equipment(patientId, now);
    } catch (error) {
      // No fresh data: what waited goes as it was.
      this.deps.log({ event: 'quiet_hours_equipment_unavailable', patient_id: patientId, error_code: code(error) });
      let sent = 0;
      for (const row of rows) sent += await this.send(row.envelope);
      return sent;
    }
    const { items, emptyReservoir } = afterQuietItems(rows.map((row) => ({ type: row.notification_type, held_at: row.held_at, title: row.envelope.title, body: row.envelope.body })), current, now, timeZone);
    const base = equipmentEnvelope(patientId, pushToken);
    let sent = 0;
    if (emptyReservoir) sent += await this.send({ ...base, ...EMPTY_RESERVOIR_TEXT, interruptionLevel: 'time-sensitive' });
    const summary = gathered(items, AFTER_QUIET_TITLE);
    if (summary) sent += await this.send({ ...base, ...summary });
    return sent;
  }

  async beforeQuiet(now: Date): Promise<void> {
    const phones = await this.deps.store.listQuietPhones();
    const byPhone = new Map<string, QuietPhone[]>();
    for (const row of phones) byPhone.set(row.push_token, [...(byPhone.get(row.push_token) ?? []), row]);
    for (const rows of byPhone.values()) {
      const settings = rows[0]!;
      const start = quietStartsAt(settings, now);
      if (!start || start.getTime() - now.getTime() > QUIET_HOURS_POLICY.before_check_ms || start.getTime() <= now.getTime()) continue;
      if (!(await this.deps.store.claimPreCheck(settings.device_id, localParts(start.getTime(), settings.time_zone).date))) continue;
      const end = quietEndAfter(settings, start);
      for (const row of rows) {
        if (!row.reservoir_on && !row.battery_on && !row.site_on) continue;
        try {
          const items = beforeQuietItems(await this.deps.equipment(row.patient_id, now), { reservoir: row.reservoir_on, battery: row.battery_on, site: row.site_on }, now, end, settings.time_zone);
          const push = gathered(items, BEFORE_QUIET_TITLE);
          const sent = push ? await this.send({ ...equipmentEnvelope(row.patient_id, row.push_token), ...push }) : 0;
          this.deps.log({ event: 'quiet_hours_before_checked', patient_id: row.patient_id, items: items.length, sent });
        } catch (error) {
          this.deps.log({ event: 'quiet_hours_before_failed', patient_id: row.patient_id, error_code: code(error) });
        }
      }
    }
  }

  private async send(envelope: PushNotificationEnvelope): Promise<number> {
    try {
      await this.deps.deliver(envelope);
      return 1;
    } catch (error) {
      this.deps.log({ event: 'quiet_hours_send_failed', patient_id: envelope.payload.patientId, type: envelope.payload.type, error_code: code(error) });
      return 0;
    }
  }
}

/** A push about the patient's equipment: a tap opens the equipment list, stacked with the other equipment pushes. */
function equipmentEnvelope(patientId: string, pushToken: string): PushNotificationEnvelope {
  return {
    platform: 'ios',
    pushToken,
    title: '',
    body: '',
    threadId: `equipment-${patientId}`,
    payload: { type: 'site_change', patientId, routePath: `/patients/${patientId}`, universalLink: `${APP_LINK_ORIGIN}/patients/${patientId}/equipment` },
  };
}

function code(error: unknown): string {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'UNKNOWN';
}
