import { createHash, randomBytes } from 'crypto';
import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';

/**
 * The Apple Watch app (watch-glance.v1): the caregiver's phone gets a long-lived read-only watch token (gmw_) from
 * POST /v1/me/watch-devices and hands it to its paired watch, which reads the compact glance with it.
 */

/** The complications show one or two patients, the app up to four. */
export const WATCH_MAX_PATIENTS = 4;
export const WATCH_DEVICE_LABEL_MAX = 40;
export const WATCH_TOKEN_PREFIX = 'gmw_';
const TOKEN_PATTERN = /^gmw_[A-Za-z0-9_-]{43}$/;

/** gmw_ + 32 random bytes as base64url (43 characters). */
export function generateWatchToken(): string {
  return `${WATCH_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function isWatchTokenShape(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The watch's own label: trimmed, control characters dropped, at most 40 characters; null when empty or not text. */
export function normalizeWatchDeviceLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const label = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, WATCH_DEVICE_LABEL_MAX).trim();
  return label.length > 0 ? label : null;
}

export interface WatchGlancePatient {
  /** Patient id (the complications pick a patient by it). */
  id: string;
  /** Name. */
  n: string;
  /** mg/dL. */
  v: number | null;
  /** Nightscout direction ("FortyFiveUp"). */
  dir: string | null;
  /** mg/dL per 5 minutes. */
  dl: number | null;
  /** Epoch seconds of the reading. */
  at: number | null;
  iob: number | null;
  cob: number | null;
  /** Only with ?hours=N (the chart): readings of the last N hours, [epoch seconds, mg/dL], oldest first. */
  r?: Array<[number, number]>;
}

/** The longest chart a watch may ask for (?hours=), and its default when asked without a number. */
export const WATCH_GLANCE_MAX_HISTORY_HOURS = 3;

/** ?hours= → whole hours 1–3, or null for no history. */
export function parseWatchGlanceHours(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return Math.min(WATCH_GLANCE_MAX_HISTORY_HOURS, Math.max(1, Math.round(hours)));
}

export interface WatchGlance {
  /** Server time, epoch seconds. */
  now: number;
  p: WatchGlancePatient[];
}

/** One patient's glance entry from the Dashboard tab's data; a missing dashboard leaves every value null. */
export function watchGlancePatient(
  id: string,
  name: string,
  dashboard: (Pick<DashboardResponse, 'glucose' | 'loop'> & Partial<Pick<DashboardResponse, 'readings'>>) | null,
  options: { historyHours?: number | null; now?: Date } = {},
): WatchGlancePatient {
  const glucose = dashboard?.glucose ?? null;
  const readingAt = glucose ? Date.parse(glucose.observed_at) : NaN;
  const loop = dashboard?.loop ?? null;
  return {
    id,
    n: name,
    v: glucose && Number.isFinite(glucose.value) ? Math.round(glucose.value) : null,
    dir: glucose?.direction ?? null,
    dl: glucose && typeof glucose.delta === 'number' && Number.isFinite(glucose.delta) ? Math.round(glucose.delta) : null,
    at: glucose && Number.isFinite(readingAt) ? Math.floor(readingAt / 1000) : null,
    iob: loop && typeof loop.iob_units === 'number' && Number.isFinite(loop.iob_units) ? Math.round(loop.iob_units * 100) / 100 : null,
    cob: loop && typeof loop.cob_grams === 'number' && Number.isFinite(loop.cob_grams) ? Math.round(loop.cob_grams) : null,
    ...(options.historyHours ? { r: glanceHistory(dashboard?.readings ?? [], options.historyHours, options.now ?? new Date()) } : {}),
  };
}

function glanceHistory(readings: Array<{ at: string; value: number }>, hours: number, now: Date): Array<[number, number]> {
  const from = now.getTime() - hours * 3_600_000;
  return readings
    .map((reading) => [Date.parse(reading.at), reading.value] as const)
    .filter(([at, value]) => Number.isFinite(at) && Number.isFinite(value) && at >= from && at <= now.getTime() + 60_000)
    .sort((a, b) => a[0] - b[0])
    .map(([at, value]) => [Math.floor(at / 1000), Math.round(value)]);
}
