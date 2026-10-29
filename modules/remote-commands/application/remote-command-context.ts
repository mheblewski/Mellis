import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import { LOOP_ACTION_TIME_ZONE } from '@modules/loop-actions/application/loop-action-views';
import { detectLoopSystem } from '@modules/loop-system/domain/loop-system';
import { scheduleValueAt } from '@modules/meal-wbt/application/wbt-policy';
import { REMOTE_COMMAND_POLICY, type RemoteCommandContext } from './remote-command-policy';
import { recentInsulinFrom, recentInsulinWindowMinutes } from './dose-calculator';

/**
 * The data a remote command is checked against, from the dashboard's view of the patient (glucose, the loop's IOB/COB,
 * boluses) and the therapy profile's ICR at that moment. Shared by the API (live Nightscout first) and the worker
 * (synced data, for chat cards).
 */
export function remoteCommandContextFrom(input: {
  now: Date;
  dashboard: Pick<DashboardResponse, 'glucose' | 'readings' | 'loop' | 'insulin'>;
  therapy: { carb_ratio_g_per_u: Array<[string, number]> | null; timezone: string | null; dia_hours?: number | null };
  /** pump.bolusIncrement of Trio's latest device status. */
  pumpBolusStep?: number | null;
  /** The carbs dated later than now (a meal eaten later): the ICR of that time. */
  carbsAt?: Date | null;
  /** The loop's newest calculation: which system the command goes to. */
  loopStatus: { raw_payload: Record<string, unknown> } | null;
}): Omit<RemoteCommandContext, 'in_flight_command_id' | 'recent_remote_bolus'> {
  const { now, dashboard, therapy } = input;
  const lowSinceMs = now.getTime() - REMOTE_COMMAND_POLICY.low_lookback_minutes * 60_000;
  const recent = dashboard.readings.filter((reading) => Date.parse(reading.at) >= lowSinceMs).map((reading) => reading.value);
  const lastBolus = dashboard.insulin?.boluses.filter((bolus) => Date.parse(bolus.at) <= now.getTime()).at(-1) ?? null;
  return {
    now: now.toISOString(),
    glucose: dashboard.glucose
      ? { value: dashboard.glucose.value, observed_at: dashboard.glucose.observed_at, delta: dashboard.glucose.delta, direction: dashboard.glucose.direction }
      : null,
    lowest_recent_glucose: recent.length > 0 ? Math.min(...recent) : null,
    loop: dashboard.loop,
    last_bolus: lastBolus ? { at: lastBolus.at, units: lastBolus.units } : null,
    bolus_history_known: dashboard.insulin !== null && dashboard.insulin !== undefined,
    icr_g_per_u: scheduleValueAt(therapy.carb_ratio_g_per_u, (input.carbsAt ?? now).toISOString(), therapy.timezone ?? LOOP_ACTION_TIME_ZONE),
    pump_bolus_step: input.pumpBolusStep ?? null,
    loop_system: detectLoopSystem(input.loopStatus?.raw_payload).kind,
    // dose-calculator.v1: manual boluses and SMBs of the last DIA / 3 (90–120 min), for a second dose.
    recent_insulin: dashboard.insulin
      ? recentInsulinFrom({ now, window_minutes: recentInsulinWindowMinutes(therapy.dia_hours), boluses: dashboard.insulin.boluses, smbs: dashboard.insulin.smbs })
      : null,
    ...(input.carbsAt ? { carbs_at: input.carbsAt.toISOString() } : {}),
  };
}
