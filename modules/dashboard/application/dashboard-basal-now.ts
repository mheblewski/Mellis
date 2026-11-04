import { deliveredBasalSegments, type BasalSegment } from '@modules/evidence-tools/daily-insulin-totals';
import type { TherapyContextEvent } from '@modules/integrations/nightscout/application/therapy-context-events';

/** The context events the basal capsule reads: an override that scales the plan and a suspended pump. */
export const BASAL_NOW_CONTEXT_KINDS = ['OVERRIDE', 'EXERCISE', 'PUMP_SUSPEND', 'PUMP_RESUME'] as const;

/** A short change of one pump step (0.05 U/h) does not restart "since": the loop nudging the rate is the same state. */
const NUDGE_MAX_MS = 10 * 60_000;
const NUDGE_MAX_RATE = 0.05 + 1e-9;
/** A suspend or an override older than this is not taken as still running (as therapy-now). */
const CONTEXT_MAX_AGE_MS = 24 * 3_600_000;

/**
 * The basal right now for the dashboard's basal capsule (dashboard-basal-now.v1): what the loop set, what the plan is
 * (the profile, scaled by an override in force), since when the current rate runs and the SMBs of the last hour.
 */
export interface DashboardBasalNow {
  /** U/h set now (the temp basal, else the profile); 0 while suspended; null when unknown. */
  rate: number | null;
  /** TEMP: a temp basal; PROFILE: no temp basal running (the profile); SUSPENDED: the pump is suspended. */
  source: 'TEMP' | 'PROFILE' | 'SUSPENDED' | 'UNKNOWN';
  /** Since when the current rate runs (runs of the same rate merged; short one-step nudges ignored). */
  since: string | null;
  /** The plan now: the profile basal times an override's insulin factor; null without a profile. */
  plan_rate: number | null;
  /** The profile basal now, without the override. */
  profile_rate: number | null;
  /** The override in force that scales the plan; null when none (or it does not change insulin). */
  override: { name: string | null; percentage: number } | null;
  /** SMBs of the last 60 minutes, U. */
  smb_last_hour_units: number;
}

export function buildBasalNow(args: {
  now: string;
  /** Delivered basal runs ending at `now` (deliveredBasalSegments). */
  segments: BasalSegment[];
  basalSchedule: Array<[string, number]> | null | undefined;
  profileTimezone: string;
  smbs: Array<{ at: string; units: number }>;
  /** The newest event of each BASAL_NOW_CONTEXT_KINDS kind; absent or null: not loaded. */
  contextEvents?: TherapyContextEvent[] | null;
}): DashboardBasalNow {
  const nowMs = Date.parse(args.now);
  const profileRate = deliveredBasalSegments({
    from: new Date(nowMs - 60_000).toISOString(),
    to: args.now,
    events: [],
    basalSchedule: args.basalSchedule,
    profileTimezone: args.profileTimezone,
  })[0]?.rate ?? null;
  const override = activeOverride(args.contextEvents ?? [], nowMs);
  const planRate = profileRate === null ? null : round2(profileRate * (override ? override.percentage / 100 : 1));
  const smbLastHour = round2(args.smbs
    .filter((dose) => Date.parse(dose.at) > nowMs - 3_600_000 && Date.parse(dose.at) <= nowMs)
    .reduce((sum, dose) => sum + dose.units, 0));

  const suspendedAt = suspendedSince(args.contextEvents ?? [], nowMs);
  if (suspendedAt) {
    return { rate: 0, source: 'SUSPENDED', since: suspendedAt, plan_rate: planRate, profile_rate: profileRate, override, smb_last_hour_units: smbLastHour };
  }

  const runs = args.segments.filter((segment) => Date.parse(segment.start) < nowMs);
  const current = runs[runs.length - 1];
  if (!current || current.rate === null) {
    return { rate: null, source: 'UNKNOWN', since: null, plan_rate: planRate, profile_rate: profileRate, override, smb_last_hour_units: smbLastHour };
  }
  return {
    rate: current.rate,
    source: current.source === 'TEMP_BASAL' ? 'TEMP' : 'PROFILE',
    since: rateSince(runs, current.rate),
    plan_rate: planRate,
    profile_rate: profileRate,
    override,
    smb_last_hour_units: smbLastHour,
  };
}

/** The start of the newest stretch at `rate`: back over runs of the same rate and nudges shorter than 10 minutes. */
function rateSince(runs: BasalSegment[], rate: number): string {
  let since = runs[runs.length - 1].start;
  for (let index = runs.length - 2; index >= 0; index -= 1) {
    const run = runs[index];
    if (run.rate === rate) {
      since = run.start;
      continue;
    }
    const nudge = run.rate !== null
      && Math.abs(run.rate - rate) <= NUDGE_MAX_RATE
      && Date.parse(run.end) - Date.parse(run.start) < NUDGE_MAX_MS
      && runs[index - 1]?.rate === rate;
    if (!nudge) break;
  }
  return since;
}

/** The override or exercise in force whose insulin factor is not 100 %, as a percentage. */
function activeOverride(events: TherapyContextEvent[], nowMs: number): DashboardBasalNow['override'] {
  const running = events
    .filter((event) => event.kind === 'OVERRIDE' || event.kind === 'EXERCISE')
    .filter((event) => {
      const start = Date.parse(event.occurred_at);
      if (event.duration_minutes === 0 || !Number.isFinite(start) || start > nowMs) return false;
      const end = event.duration_minutes !== null ? start + event.duration_minutes * 60_000 : start + CONTEXT_MAX_AGE_MS;
      return end > nowMs;
    })
    .sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at))[0];
  if (!running) return null;
  const scale = numberOrNull(running.details.insulin_needs_scale);
  const percentage = scale !== null ? scale * 100 : numberOrNull(running.details.percentage);
  if (percentage === null || percentage <= 0 || Math.round(percentage) === 100) return null;
  const name = [running.details.reason, running.details.notes].find((value): value is string => typeof value === 'string' && value.length > 0) ?? null;
  return { name: name?.slice(0, 40) ?? null, percentage: Math.round(percentage) };
}

/** When the pump was suspended, if no resume came after it (and it is under a day old). */
function suspendedSince(events: TherapyContextEvent[], nowMs: number): string | null {
  const latest = (kind: TherapyContextEvent['kind']) => events
    .filter((event) => event.kind === kind && Date.parse(event.occurred_at) <= nowMs)
    .sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at))[0];
  const suspend = latest('PUMP_SUSPEND');
  if (!suspend || nowMs - Date.parse(suspend.occurred_at) >= CONTEXT_MAX_AGE_MS) return null;
  const resume = latest('PUMP_RESUME');
  return resume && Date.parse(resume.occurred_at) >= Date.parse(suspend.occurred_at) ? null : suspend.occurred_at;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
