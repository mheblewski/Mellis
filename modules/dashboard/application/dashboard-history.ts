/**
 * The dashboard chart's history: readings, insulin and the loop's IOB/COB for any window, so the chart can be scrolled
 * back and show what was on board at a past reading. The app asks for windows ahead of the finger, a few days at most.
 */
import { loopValues, type DashboardDeviceStatus, type DashboardGlucoseReading, type DashboardInsulin } from './dashboard-snapshot';

/** One request covers at most this much; the app asks for 1–4 days at a time. */
export const DASHBOARD_HISTORY_MAX_SPAN_MS = 7 * 24 * 3_600_000;
/** A window may end a little after the server's clock (the phone's clock runs ahead). */
const FUTURE_SLACK_MS = 10 * 60_000;

export interface DashboardHistoryResponse {
  patient_id: string;
  from: string;
  to: string;
  /** Oldest first, one per timestamp. */
  readings: Array<{ at: string; value: number }>;
  /** The loop's calculations, oldest first: what was on board when each was made. */
  loop: Array<{ at: string; iob_units: number | null; cob_grams: number | null }>;
  /** Null when it could not be read (the chart then shows glucose only). */
  insulin: DashboardInsulin | null;
}

export type DashboardHistoryWindow = { from: Date; to: Date };

/** `from` and `to` as ISO dates, `from` before `to`, at most 7 days apart; `to` defaults to now. */
export function parseDashboardHistoryWindow(fromRaw: unknown, toRaw: unknown, now: Date): DashboardHistoryWindow | string {
  if (typeof fromRaw !== 'string' || !fromRaw) return 'from is required (ISO date)';
  const fromMs = Date.parse(fromRaw);
  if (!Number.isFinite(fromMs)) return 'from must be an ISO date';
  const toMs = typeof toRaw === 'string' && toRaw ? Date.parse(toRaw) : now.getTime();
  if (!Number.isFinite(toMs)) return 'to must be an ISO date';
  if (fromMs >= toMs) return 'from must be before to';
  if (toMs - fromMs > DASHBOARD_HISTORY_MAX_SPAN_MS) return 'the window may span at most 7 days';
  const cappedTo = Math.min(toMs, now.getTime() + FUTURE_SLACK_MS);
  if (fromMs >= cappedTo) return 'from must be in the past';
  return { from: new Date(fromMs), to: new Date(cappedTo) };
}

export function buildDashboardHistory(input: {
  patientId: string;
  window: DashboardHistoryWindow;
  readings: DashboardGlucoseReading[];
  loopStatuses: DashboardDeviceStatus[];
  insulin: DashboardInsulin | null;
}): DashboardHistoryResponse {
  const fromMs = input.window.from.getTime();
  const toMs = input.window.to.getTime();
  const inWindow = (at: string) => {
    const time = Date.parse(at);
    return Number.isFinite(time) && time >= fromMs && time < toMs;
  };

  const readings = new Map<number, { at: string; value: number }>();
  for (const reading of input.readings) {
    if (!inWindow(reading.at) || !Number.isFinite(reading.value) || reading.value <= 0) continue;
    const time = Date.parse(reading.at);
    if (!readings.has(time)) readings.set(time, { at: new Date(time).toISOString(), value: Math.round(reading.value) });
  }

  const loop = new Map<number, DashboardHistoryResponse['loop'][number]>();
  for (const status of input.loopStatuses) {
    if (!inWindow(status.observed_at)) continue;
    const values = loopValues(status.raw_payload);
    const time = Date.parse(status.observed_at);
    if (values && !loop.has(time)) loop.set(time, { at: new Date(time).toISOString(), ...values });
  }

  const byTime = <T>(map: Map<number, T>) => [...map.entries()].sort(([left], [right]) => left - right).map(([, value]) => value);
  return {
    patient_id: input.patientId,
    from: input.window.from.toISOString(),
    to: input.window.to.toISOString(),
    readings: byTime(readings),
    loop: byTime(loop),
    insulin: input.insulin,
  };
}
