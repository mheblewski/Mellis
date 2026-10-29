import type { Pool } from 'pg';
import { PostgresDashboardRepository } from '@infra/db/postgres-dashboard.repository';
import { buildDashboard, DASHBOARD_HISTORY_HOURS, newestStatusWith, type DashboardInsulin, type DashboardResponse } from './dashboard-snapshot';
import { buildDashboardInsulin, DASHBOARD_INSULIN_LOOKBACK_MS } from './dashboard-insulin';
import type { DashboardCareEvents } from './dashboard-snapshot';
import type { LiveNightscoutData } from './nightscout-live';
import { PatientNightscoutReaders } from './patient-nightscout-readers';
import { patientNightscoutClientsFromEnv } from '@infra/db/patient-nightscout-clients.factory';

/** Straight-from-Nightscout reads for a patient; null when the patient has no usable Nightscout. */
export interface PatientLatest<T> {
  latest(patientId: string): Promise<T | null>;
}
import { ReservoirUsageEstimator } from './reservoir-usage';

/** The insulin and therapy reads the chart needs (PostgresGlucoMindRepository). */
export interface DashboardInsulinSource {
  listInsulinDeliveryEventsByRange(args: { patientId: string; startAtIso: string; endAtIso: string }): Promise<Parameters<typeof buildDashboardInsulin>[0]['events']>;
  getTherapyProfileAt(patientId: string, atIso: string): Promise<{ status: string; basal_u_per_h?: unknown; timezone?: string | null }>;
}

/**
 * The Dashboard tab's data, put together once for every reader: the API's dashboard and the worker's Live Activity
 * pushes show the same reading, IOB/COB and equipment.
 */
export class DashboardAssembler {
  private readonly reservoirUsage: ReservoirUsageEstimator;

  constructor(
    private readonly dashboardRepository: PostgresDashboardRepository,
    private readonly insulinSource: DashboardInsulinSource,
    private readonly careEvents: PatientLatest<DashboardCareEvents> | null,
    private readonly nightscoutLive: PatientLatest<LiveNightscoutData> | null,
  ) {
    this.reservoirUsage = new ReservoirUsageEstimator(insulinSource);
  }

  static fromEnv(pool: Pool, insulinSource: DashboardInsulinSource, env: NodeJS.ProcessEnv = process.env): DashboardAssembler {
    const readers = patientNightscoutReadersFromEnv(pool, env);
    return new DashboardAssembler(new PostgresDashboardRepository(pool), insulinSource, readers?.careEvents ?? null, readers?.live ?? null);
  }

  async dashboard(patientId: string, now: Date): Promise<DashboardResponse> {
    return (await this.dashboardWithSources(patientId, now)).dashboard;
  }

  /** The dashboard and the readings and loop status it was built from (live Nightscout first). */
  async dashboardWithSources(patientId: string, now: Date) {
    const sinceIso = new Date(now.getTime() - DASHBOARD_HISTORY_HOURS * 3_600_000).toISOString();
    const [readings, pumpStatus, loopStatus, careEvents, live, insulin, usage] = await Promise.all([
      this.dashboardRepository.listGlucoseReadingsSince(patientId, sinceIso),
      this.dashboardRepository.getLatestPumpStatus(patientId),
      this.dashboardRepository.getLatestLoopStatus(patientId),
      this.careEvents?.latest(patientId) ?? Promise.resolve(null),
      // Ahead of the minute sync: readings and pump status as soon as they are in Nightscout.
      this.nightscoutLive?.latest(patientId) ?? Promise.resolve(null),
      this.insulin(patientId, sinceIso, now.toISOString()),
      // How long the reservoir lasts; cached for an hour, null when it cannot be estimated.
      this.reservoirUsage.usage(patientId, now),
    ]);
    const allReadings = [...readings, ...(live?.readings ?? [])];
    const newestLoopStatus = newestStatusWith(['openaps', 'loop'], loopStatus, live?.deviceStatus);
    const dashboard = buildDashboard({
      patientId,
      now,
      readings: allReadings,
      deviceStatus: newestStatusWith(['pump'], pumpStatus, live?.deviceStatus),
      loopStatus: newestLoopStatus,
      careEvents,
      insulin,
      averageDailyInsulinUnits: usage?.average_daily_units ?? null,
    });
    return { dashboard, sources: { readings: allReadings, loopStatus: newestLoopStatus, careEvents } };
  }

  /** The chart's insulin; fails open (the chart then shows glucose only). */
  async insulin(patientId: string, fromIso: string, toIso: string): Promise<DashboardInsulin | null> {
    try {
      const [events, profile] = await Promise.all([
        this.insulinSource.listInsulinDeliveryEventsByRange({
          patientId,
          startAtIso: new Date(Date.parse(fromIso) - DASHBOARD_INSULIN_LOOKBACK_MS).toISOString(),
          endAtIso: toIso,
        }),
        this.insulinSource.getTherapyProfileAt(patientId, toIso),
      ]);
      return buildDashboardInsulin({
        from: fromIso,
        to: toIso,
        events,
        basalSchedule: profile.status === 'KNOWN' ? (profile.basal_u_per_h as Parameters<typeof buildDashboardInsulin>[0]['basalSchedule']) : null,
        profileTimezone: profile.timezone ?? 'Europe/Warsaw',
      });
    } catch {
      return null;
    }
  }
}

/** Each patient's stored Nightscout (090_sharing_foundation.sql); null without NIGHTSCOUT_TOKEN_ENCRYPTION_KEY. */
export function patientNightscoutReadersFromEnv(pool: Pool, env: NodeJS.ProcessEnv): PatientNightscoutReaders | null {
  const clients = patientNightscoutClientsFromEnv(pool, env);
  return clients ? new PatientNightscoutReaders(clients) : null;
}
