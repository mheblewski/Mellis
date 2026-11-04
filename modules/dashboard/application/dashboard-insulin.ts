import { deliveredBasalSegments, type InsulinDeliveryEvent } from '@modules/evidence-tools/daily-insulin-totals';
import type { TherapyContextEvent } from '@modules/integrations/nightscout/application/therapy-context-events';
import { buildBasalNow } from './dashboard-basal-now';
import type { DashboardInsulin } from './dashboard-snapshot';

/** Temp basals are read this much earlier, so one running at the window's start is known. */
export const DASHBOARD_INSULIN_LOOKBACK_MS = 6 * 3_600_000;

/** Boluses, SMBs and the delivered basal of the dashboard's window, from the synced Nightscout treatments. */
export function buildDashboardInsulin(args: {
  from: string;
  to: string;
  events: InsulinDeliveryEvent[];
  basalSchedule: Array<[string, number]> | null | undefined;
  profileTimezone: string;
  /** Override and suspend events for the basal capsule (BASAL_NOW_CONTEXT_KINDS); absent: not loaded. */
  contextEvents?: TherapyContextEvent[] | null;
  /** CARB_ENTRY events of the window (payload.carbs in g); absent: no carbs on the chart. */
  carbEntries?: Array<{ occurred_at: Date | string; payload: Record<string, unknown> }>;
}): DashboardInsulin {
  const fromMs = Date.parse(args.from);
  const toMs = Date.parse(args.to);
  const doses = (type: 'BOLUS' | 'SMB') => {
    const seen = new Set<string>();
    return args.events
      .filter((event) => String(event.type).toUpperCase() === type)
      .filter((event) => {
        const at = Date.parse(event.occurred_at);
        return Number.isFinite(at) && at >= fromMs && at <= toMs;
      })
      .flatMap((event) => {
        const units = Number(event.payload?.insulin_units ?? event.payload?.insulin);
        // The same dose uploaded twice (loop retry) is kept once.
        const key = `${event.occurred_at}|${units}`;
        if (!Number.isFinite(units) || units <= 0 || seen.has(key)) return [];
        seen.add(key);
        return [{ at: new Date(event.occurred_at).toISOString(), units: Math.round(units * 100) / 100 }];
      })
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  };

  const smbs = doses('SMB');
  const basal = deliveredBasalSegments({
    from: args.from,
    to: args.to,
    events: args.events,
    basalSchedule: args.basalSchedule,
    profileTimezone: args.profileTimezone,
  });
  return {
    boluses: doses('BOLUS'),
    smbs,
    carbs: dashboardCarbs(args.carbEntries ?? [], fromMs, toMs),
    basal: basal.map(({ start, end, rate }) => ({ start, end, rate })),
    basal_now: buildBasalNow({
      now: args.to,
      segments: basal,
      basalSchedule: args.basalSchedule,
      profileTimezone: args.profileTimezone,
      smbs,
      contextEvents: args.contextEvents,
    }),
  };
}

/** Carb entries of the window, oldest first; the same entry uploaded twice (same time and grams) is kept once. */
function dashboardCarbs(entries: Array<{ occurred_at: Date | string; payload: Record<string, unknown> }>, fromMs: number, toMs: number): Array<{ at: string; grams: number }> {
  const seen = new Set<string>();
  return entries
    .flatMap((entry) => {
      const at = new Date(entry.occurred_at).getTime();
      const grams = Number(entry.payload?.carbs);
      if (!Number.isFinite(at) || at < fromMs || at > toMs || !Number.isFinite(grams) || grams <= 0) return [];
      const rounded = Math.round(grams);
      const key = `${at}|${rounded}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ at: new Date(at).toISOString(), grams: rounded }];
    })
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}
