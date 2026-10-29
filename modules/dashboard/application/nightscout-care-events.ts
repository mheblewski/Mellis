import type { NightscoutDeviceStatusDto, NightscoutTreatmentDto } from '@modules/integrations/nightscout/application/nightscout-client';
import type { DashboardCareEvents } from './dashboard-snapshot';

/** Nightscout's CAGE plugin counts from "Site Change"; SAGE from "Sensor Start" or "Sensor Change", whichever is newer. */
export const SITE_CHANGE_EVENT_TYPES = ['Site Change'] as const;
export const SENSOR_EVENT_TYPES = ['Sensor Start', 'Sensor Change'] as const;
/** Trio and AAPS upload a reservoir (cartridge) change as "Insulin Change". */
export const RESERVOIR_CHANGE_EVENT_TYPES = ['Insulin Change'] as const;
/** The reservoir is read during this long after a change: before priming it shows the full amount. */
const RESERVOIR_FILL_WINDOW_MS = 60 * 60_000;

/** Sensors last up to ~15 days; anything older than this is not worth showing as an age. */
const LOOKBACK_DAYS = 30;
/** Site and sensor changes happen every few days, so a short cache spares Nightscout a request on every refresh. */
const CACHE_TTL_MS = 2 * 60_000;

export interface LatestTreatmentReader {
  fetchLatestTreatmentOfType(eventType: string, sinceIso: string): Promise<NightscoutTreatmentDto | null>;
  fetchDeviceStatusesBetween(fromIso: string, toIso: string, count: number): Promise<NightscoutDeviceStatusDto[]>;
}

/**
 * Infusion site, sensor and reservoir change times, read straight from Nightscout for the one patient the server
 * syncs, plus how much insulin the reservoir held after its change. A failed request leaves them unknown (the
 * dashboard shows the rest) and is retried on the next refresh.
 */
export class NightscoutCareEvents {
  private cache: { patientId: string; value: DashboardCareEvents; expiresAtMs: number } | null = null;
  /** The fill only changes with the next reservoir change, so it is kept for that change's time. */
  private reservoirFill: { changedAt: string; units: number | null } | null = null;

  constructor(
    private readonly reader: LatestTreatmentReader,
    private readonly patientId: string,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async latest(patientId: string): Promise<DashboardCareEvents | null> {
    if (patientId !== this.patientId) {
      return null;
    }
    const now = this.nowMs();
    if (this.cache && this.cache.patientId === patientId && this.cache.expiresAtMs > now) {
      return this.cache.value;
    }

    const sinceIso = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString();
    try {
      const [siteChangedAt, sensorStartedAt, reservoirChangedAt] = await Promise.all([
        this.newestOf(SITE_CHANGE_EVENT_TYPES, sinceIso),
        this.newestOf(SENSOR_EVENT_TYPES, sinceIso),
        this.newestOf(RESERVOIR_CHANGE_EVENT_TYPES, sinceIso),
      ]);
      const value = {
        site_changed_at: siteChangedAt,
        sensor_started_at: sensorStartedAt,
        reservoir_changed_at: reservoirChangedAt,
        reservoir_filled_units: reservoirChangedAt ? await this.filledUnits(reservoirChangedAt) : null,
      };
      this.cache = { patientId, value, expiresAtMs: now + CACHE_TTL_MS };
      return value;
    } catch {
      return null;
    }
  }

  /** The highest reservoir level in the hour after the change (the amount filled, before priming used some). */
  private async filledUnits(changedAt: string): Promise<number | null> {
    if (this.reservoirFill?.changedAt === changedAt) {
      return this.reservoirFill.units;
    }
    try {
      const from = Date.parse(changedAt);
      const statuses = await this.reader.fetchDeviceStatusesBetween(changedAt, new Date(from + RESERVOIR_FILL_WINDOW_MS).toISOString(), 30);
      const levels = statuses
        .map((status) => Number((status.pump as { reservoir?: unknown } | undefined)?.reservoir))
        .filter((units) => Number.isFinite(units) && units > 0 && units <= 1000);
      const units = levels.length > 0 ? Math.max(...levels) : null;
      this.reservoirFill = { changedAt, units };
      return units;
    } catch {
      return null;
    }
  }

  private async newestOf(eventTypes: readonly string[], sinceIso: string): Promise<string | null> {
    const treatments = await Promise.all(eventTypes.map((eventType) => this.reader.fetchLatestTreatmentOfType(eventType, sinceIso)));
    const times = treatments
      .map((treatment) => treatmentTime(treatment))
      .filter((time): time is number => time !== null);
    return times.length > 0 ? new Date(Math.max(...times)).toISOString() : null;
  }
}

function treatmentTime(treatment: NightscoutTreatmentDto | null): number | null {
  if (!treatment) return null;
  const raw = treatment.created_at ?? treatment.timestamp;
  const time = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}
