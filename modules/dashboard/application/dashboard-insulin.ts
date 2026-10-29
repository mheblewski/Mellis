import { deliveredBasalSegments, type InsulinDeliveryEvent } from '@modules/evidence-tools/daily-insulin-totals';
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

  return {
    boluses: doses('BOLUS'),
    smbs: doses('SMB'),
    basal: deliveredBasalSegments({
      from: args.from,
      to: args.to,
      events: args.events,
      basalSchedule: args.basalSchedule,
      profileTimezone: args.profileTimezone,
    }).map(({ start, end, rate }) => ({ start, end, rate })),
  };
}
