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
    // The profile alone, as if no temp basal had run: the chart's dashed line of the planned basal.
    basal_plan: deliveredBasalSegments({
      from: args.from,
      to: args.to,
      events: [],
      basalSchedule: args.basalSchedule,
      profileTimezone: args.profileTimezone,
    }).flatMap(({ start, end, rate }) => (rate === null ? [] : [{ start, end, rate }])),
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

/**
 * Carb entries of the window, oldest first; the same entry uploaded twice (same time and grams) is kept once.
 * `mellis_only`: carbs logged only in Mellis (a rescue logged from Teraz or a card, entry_source GLUCOMIND, not sent to
 * the loop); the chart draws them as an empty ring. A copy that is in the loop wins over a Mellis-only one.
 */
function dashboardCarbs(entries: Array<{ occurred_at: Date | string; payload: Record<string, unknown> }>, fromMs: number, toMs: number): Array<{ at: string; grams: number; mellis_only?: true }> {
  const byKey = new Map<string, { at: string; grams: number; mellis_only?: true }>();
  for (const entry of entries) {
    const at = new Date(entry.occurred_at).getTime();
    const grams = Number(entry.payload?.carbs);
    if (!Number.isFinite(at) || at < fromMs || at > toMs || !Number.isFinite(grams) || grams <= 0) continue;
    const rounded = Math.round(grams);
    const key = `${at}|${rounded}`;
    const mellisOnly = entry.payload?.entry_source === 'GLUCOMIND' && entry.payload?.in_loop !== true;
    const seen = byKey.get(key);
    if (seen && (seen.mellis_only !== true || mellisOnly)) continue;
    byKey.set(key, mellisOnly ? { at: new Date(at).toISOString(), grams: rounded, mellis_only: true } : { at: new Date(at).toISOString(), grams: rounded });
  }
  return [...byKey.values()].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}
