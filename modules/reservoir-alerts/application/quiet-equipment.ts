import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import type { ReservoirLevel } from '@modules/dashboard/application/reservoir-level';
import { localParts } from '@modules/local-time/local-time';
import { QUIET_HOURS_POLICY } from '@modules/notifications/application/quiet-hours';
import { RESERVOIR_ALERT_POLICY, reservoirPushText } from './reservoir-alerts';
import { BATTERY_ALERT_POLICY, batteryLevel, batteryPushText } from './battery-alerts';
import { SITE_ALERT_POLICY, sitePushText } from './site-alerts';

/**
 * Equipment around a phone's quiet hours (quiet-hours.v1 stage 2, docs/product/quiet-hours-plan.md):
 * - before them: what runs out before their end + 1 h, in one push half an hour before the start;
 * - after them: the equipment pushes that waited, checked again on fresh data (left out once the reservoir or site was
 *   changed or the battery charged) and sent as one push.
 */
export interface EquipmentNow {
  reservoir_units: number | null;
  reservoir_level: ReservoirLevel | null;
  reservoir_hours_left: number | null;
  /** Newest "Insulin Change" in Nightscout. */
  reservoir_changed_at: string | null;
  battery_percent: number | null;
  /** When the loop app last read the pump; older than 6 h is not acted on. */
  pump_read_at: string | null;
  site_changed_at: string | null;
}

export function equipmentNow(dashboard: DashboardResponse, reservoirChangedAt: string | null): EquipmentNow {
  const pump = dashboard.pump;
  return {
    reservoir_units: pump?.reservoir_units ?? null,
    reservoir_level: pump?.reservoir_level ?? null,
    reservoir_hours_left: pump?.reservoir_hours_left ?? null,
    reservoir_changed_at: reservoirChangedAt,
    battery_percent: pump?.battery_percent ?? null,
    pump_read_at: pump?.last_read_at ?? null,
    site_changed_at: dashboard.site_changed_at,
  };
}

export interface QuietPushText {
  title: string;
  body: string;
  /** One line of the push that gathers several. */
  line: string;
}

const HOUR_MS = 60 * 60_000;

function pumpFresh(now: EquipmentNow, at: Date): boolean {
  const read = now.pump_read_at ? Date.parse(now.pump_read_at) : Number.NaN;
  return Number.isFinite(read) && at.getTime() - read <= RESERVOIR_ALERT_POLICY.max_pump_status_age_ms;
}

function after(iso: string | null, thanIso: string): boolean {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) && ms > Date.parse(thanIso);
}

/** "3:00" in the phone's zone. */
export function quietClock(ms: number, timeZone: string): string {
  const minute = localParts(ms, timeZone).minute;
  return `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function units(value: number): string {
  return `${Math.round(value * 10) / 10}`.replace('.', ',');
}

/** Several items in one push, or the one item as it is. */
export function gathered(items: QuietPushText[], title: string): { title: string; body: string } | null {
  if (items.length === 0) return null;
  if (items.length === 1) return { title: items[0]!.title, body: items[0]!.body };
  return { title, body: items.map((item) => item.line).join('\n') };
}

/**
 * Half an hour before quiet hours: the reservoir that runs out before their end + 1 h, a pump battery under 25%, and a
 * site that turns 3 days old by then. Only what the phone has on in "Powiadomienia o sprzęcie".
 */
export function beforeQuietItems(now: EquipmentNow, switches: { reservoir: boolean; battery: boolean; site: boolean }, at: Date, quietEnd: Date, timeZone: string): QuietPushText[] {
  const items: QuietPushText[] = [];
  const limit = quietEnd.getTime() + QUIET_HOURS_POLICY.before_margin_ms;
  const end = quietClock(quietEnd.getTime(), timeZone);
  const fresh = pumpFresh(now, at);
  if (switches.reservoir && fresh && now.reservoir_units !== null && now.reservoir_hours_left !== null) {
    const runsOut = at.getTime() + now.reservoir_hours_left * HOUR_MS;
    if (runsOut < limit) {
      const clock = quietClock(runsOut, timeZone);
      items.push({
        title: `Zbiornik może się skończyć ok. ${clock}`,
        body: `Zostało ${units(now.reservoir_units)} j. Godziny ciszy trwają do ${end}.`,
        line: `Zbiornik: zostało ${units(now.reservoir_units)} j, może się skończyć ok. ${clock}.`,
      });
    }
  }
  if (switches.battery && fresh && now.battery_percent !== null && now.battery_percent < BATTERY_ALERT_POLICY.warning_below) {
    const percent = `${Math.round(now.battery_percent)}%`;
    items.push({
      title: `Bateria pompy: ${percent}`,
      body: `Może się wyczerpać w godzinach ciszy (do ${end}). Naładuj lub wymień baterię wcześniej.`,
      line: `Bateria pompy: ${percent}.`,
    });
  }
  const changed = now.site_changed_at ? Date.parse(now.site_changed_at) : Number.NaN;
  if (switches.site && Number.isFinite(changed) && at.getTime() - changed <= SITE_ALERT_POLICY.max_age_ms) {
    const due = changed + SITE_ALERT_POLICY.change_now_after_ms;
    if (due < limit) {
      const text = due <= at.getTime()
        ? { title: `Wkłucie ma już ${Math.floor((at.getTime() - changed) / (24 * HOUR_MS))} dni`, body: 'Najlepiej zmień je przed godzinami ciszy.' }
        : { title: `Wkłucie skończy 3 dni o ${quietClock(due, timeZone)}`, body: `To w godzinach ciszy (do ${end}). Najlepiej zmień je wcześniej.` };
      items.push({ ...text, line: `${text.title}.` });
    }
  }
  return items;
}

/** What waited, as it stands now: left out when it was dealt with in the meantime. */
export function afterQuietItems(held: Array<{ type: string; held_at: string; title: string; body: string }>, now: EquipmentNow, at: Date, timeZone: string): { items: QuietPushText[]; emptyReservoir: boolean } {
  const items: QuietPushText[] = [];
  let emptyReservoir = false;
  const fresh = pumpFresh(now, at);
  for (const item of held) {
    if (item.type === 'reservoir_low') {
      if (after(now.reservoir_changed_at, item.held_at)) continue;
      if (!fresh || now.reservoir_units === null || now.reservoir_level === null) {
        items.push({ title: item.title, body: item.body, line: `Zbiornik: ${lowerFirst(item.body)}` });
        continue;
      }
      if (now.reservoir_units <= 0) { emptyReservoir = true; continue; }
      if (now.reservoir_level === 'normal') continue;
      const text = reservoirPushText(now.reservoir_level, now.reservoir_units, now.reservoir_hours_left);
      items.push({ ...text, line: `Zbiornik: ${lowerFirst(text.body)}` });
    } else if (item.type === 'battery_low') {
      if (!fresh || now.battery_percent === null) {
        items.push({ title: item.title, body: item.body, line: `Bateria pompy: ${lowerFirst(item.body)}` });
        continue;
      }
      const level = batteryLevel(now.battery_percent);
      if (level === 'normal') continue;
      items.push({ ...batteryPushText(level, now.battery_percent), line: `Bateria pompy: ${Math.round(now.battery_percent)}%.` });
    } else if (item.type === 'site_change') {
      if (after(now.site_changed_at, item.held_at) || !now.site_changed_at) continue;
      const text = sitePushText(now.site_changed_at, at, timeZone);
      items.push({ ...text, line: `${text.title}.` });
    }
  }
  return { items, emptyReservoir };
}

/** The reservoir ran dry in quiet hours: its own push, time-sensitive. */
export const EMPTY_RESERVOIR_TEXT = { title: 'Zbiornik jest pusty', body: 'Pompa nie podaje insuliny. Wymień zbiornik.' } as const;

export const AFTER_QUIET_TITLE = 'Po godzinach ciszy';
export const BEFORE_QUIET_TITLE = 'Przed godzinami ciszy';
