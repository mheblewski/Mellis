import { localInstant, localParts } from '@modules/local-time/local-time';

/**
 * "Godziny ciszy" (quiet-hours.v1, owner 2026-11-22, docs/product/quiet-hours-plan.md): hours set on a phone, for every
 * patient on it, in which Mellis keeps glucose pushes off that phone. Stage 1 decides per push: send, send it
 * time-sensitive (so the iOS "Sen" Focus lets a low warning through), drop it, or hold it until the end (stage 2):
 * - glucose pushes: dropped, except glucose below 54 for 20 minutes without a rise (owner: it breaks quiet hours) and,
 *   with "Ostrzeżenia o niedocukrzeniu" on, the low-risk warning and no readings for an hour;
 * - the carbs proposal ("Możliwe niedocukrzenie", every level) and the check after carbs: with the switch on;
 * - "Opiekun Ewa podał …": dropped (the bolus history and the bell show it);
 * - equipment (reservoir, pump battery, site): held, then checked again and sent fresh after the end;
 * - information (patterns, update, meal plan, handed-over settings, the comparison): held, sent as they were within
 *   2 h of the end;
 * - everything else (boluses, WBT, reminders, answers): as before.
 */
export const QUIET_HOURS_POLICY = {
  version: 'quiet-hours.v1',
  /** Glucose below this for `urgent_sustained_ms` without a rise breaks quiet hours. */
  urgent_below: 54,
  urgent_sustained_ms: 20 * 60_000,
  /** No readings for this long comes with the low warnings. */
  no_data_minutes: 60,
  default_start_minute: 22 * 60,
  default_end_minute: 7 * 60,
  /** A held information push is not sent later than this after the end. */
  information_expires_ms: 2 * 60 * 60_000,
  /** The check before quiet hours: this long before the start, for what runs out before the end + `before_margin_ms`. */
  before_check_ms: 30 * 60_000,
  before_margin_ms: 60 * 60_000,
} as const;

const EQUIPMENT_TYPES = ['reservoir_low', 'battery_low', 'site_change'] as const;
const INFORMATION_TYPES = ['therapy_pattern', 'app_update', 'meal_plan', 'remote_settings_handoff', 'prediction_comparison'] as const;

/** Which pushes wait for the end of quiet hours. */
export function heldGroup(type: string): 'equipment' | 'information' | null {
  if ((EQUIPMENT_TYPES as readonly string[]).includes(type)) return 'equipment';
  if ((INFORMATION_TYPES as readonly string[]).includes(type)) return 'information';
  return null;
}

export interface QuietHoursSettings {
  enabled: boolean;
  /** Minutes after local midnight (0–1439); an end before the start means the next day. */
  start_minute: number;
  end_minute: number;
  time_zone: string;
  /** "Ostrzeżenia o niedocukrzeniu" in quiet hours. */
  low_warnings: boolean;
}

/** What the push says about itself, for the pushes whose fate depends on more than their type. */
export interface QuietPushContext {
  /** glucose_alert: the readings were below 54 for 20 minutes and the last one did not rise. */
  urgentLowSustained?: boolean;
  /** glucose_alert no_data: minutes without a reading. */
  noDataMinutes?: number;
}

export type QuietDecision = 'send' | 'time_sensitive' | 'drop' | 'hold';

export function inQuietHours(settings: QuietHoursSettings | null, at: Date): boolean {
  if (!settings?.enabled || settings.start_minute === settings.end_minute) return false;
  const minute = localParts(at.getTime(), settings.time_zone).minute;
  return settings.start_minute < settings.end_minute
    ? minute >= settings.start_minute && minute < settings.end_minute
    : minute >= settings.start_minute || minute < settings.end_minute;
}

/** The next start of quiet hours at or after `at` (null when they are off). */
export function quietStartsAt(settings: QuietHoursSettings | null, at: Date): Date | null {
  if (!settings?.enabled || settings.start_minute === settings.end_minute) return null;
  const { date, minute } = localParts(at.getTime(), settings.time_zone);
  if (minute <= settings.start_minute) return new Date(localInstant(date, settings.start_minute, settings.time_zone));
  return new Date(localInstant(nextDate(date), settings.start_minute, settings.time_zone));
}

function nextDate(date: string): string {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** The end of quiet hours that start at `start` (the first end after it). */
export function quietEndAfter(settings: QuietHoursSettings, start: Date): Date {
  const { date } = localParts(start.getTime(), settings.time_zone);
  const sameDay = localInstant(date, settings.end_minute, settings.time_zone);
  return new Date(sameDay > start.getTime() ? sameDay : localInstant(nextDate(date), settings.end_minute, settings.time_zone));
}

/** The end of the quiet hours `at` is in (null when it is not in them). */
export function quietEndsAt(settings: QuietHoursSettings | null, at: Date): Date | null {
  if (!settings || !inQuietHours(settings, at)) return null;
  const { date, minute } = localParts(at.getTime(), settings.time_zone);
  const endToday = localInstant(date, settings.end_minute, settings.time_zone);
  if (minute < settings.end_minute) return new Date(endToday);
  // Past midnight is still ahead: the end is tomorrow.
  return new Date(localInstant(nextDate(date), settings.end_minute, settings.time_zone));
}

/** The fate of one push to one phone. Outside quiet hours (or with them off) everything is sent as before. */
export function quietDecision(type: string, kind: string | null, settings: QuietHoursSettings | null, context: QuietPushContext, at: Date): QuietDecision {
  if (!settings || !inQuietHours(settings, at)) return 'send';
  const lowWarning = settings.low_warnings ? 'time_sensitive' : 'drop';
  switch (type) {
    case 'glucose_alert':
      if (kind === 'very_low' && context.urgentLowSustained) return 'time_sensitive';
      if (kind === 'prediction_low') return lowWarning;
      if (kind === 'no_data' && (context.noDataMinutes ?? 0) >= QUIET_HOURS_POLICY.no_data_minutes) return lowWarning;
      return 'drop';
    case 'rescue_carbs':
    case 'situation_check':
      return lowWarning;
    case 'dose_given':
      return 'drop';
    default:
      return heldGroup(type) ? 'hold' : 'send';
  }
}

/**
 * Below 54 for 20 minutes without a rise: the newest reading and every reading of the last 20 minutes under 54, the
 * readings reach back at least 20 minutes (no gap hides a higher one) and the last change is not up.
 */
export function urgentLowSustained(history: Array<{ at: string; value: number }>, delta: number | null | undefined): boolean {
  const p = QUIET_HOURS_POLICY;
  const points = history.map((r) => ({ at: Date.parse(r.at), value: r.value })).filter((r) => Number.isFinite(r.at)).sort((a, b) => a.at - b.at);
  const last = points.at(-1);
  if (!last || last.value >= p.urgent_below || (delta ?? 0) > 0) return false;
  const from = last.at - p.urgent_sustained_ms;
  const window = points.filter((r) => r.at >= from - 2.5 * 60_000);
  if (window.length === 0 || window[0]!.at > from + 2.5 * 60_000) return false;
  for (let i = 1; i < window.length; i += 1) if (window[i]!.at - window[i - 1]!.at > 8 * 60_000) return false;
  return window.every((r) => r.value < p.urgent_below);
}

/** Validates "HH:MM" or a minute number from the API into a minute of the day. */
export function parseQuietMinute(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1440) return value;
  if (typeof value === 'string') {
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
    if (match) return Number(match[1]) * 60 + Number(match[2]);
  }
  return null;
}
