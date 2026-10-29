import type { NightscoutDeviceStatusDto, NightscoutEntryDto } from '@modules/integrations/nightscout/application/nightscout-client';
import type { DashboardDeviceStatus, DashboardGlucoseReading } from './dashboard-snapshot';

/** Readings this far back are asked for; anything older is already in the database through the sync. */
const LOOKBACK_MS = 30 * 60_000;
const MAX_ENTRIES = 30;
/** Several phones refreshing together share one pair of requests. */
const CACHE_TTL_MS = 10_000;
/** The dashboard falls back to the synced data rather than wait for a slow Nightscout. */
const TIMEOUT_MS = 3_000;

export interface LiveNightscoutReader {
  fetchRecentEntries(sinceMs: number, count: number): Promise<NightscoutEntryDto[]>;
  fetchLatestDeviceStatus(): Promise<NightscoutDeviceStatusDto | null>;
}

export interface LiveNightscoutData {
  readings: DashboardGlucoseReading[];
  deviceStatus: DashboardDeviceStatus | null;
}

/**
 * The newest readings and devicestatus straight from Nightscout. The worker imports them only once a minute (and only
 * between other jobs), so without this the dashboard showed every reading about a minute late. Failures and slow
 * answers return null: the dashboard then shows the synced data.
 */
export class NightscoutLive {
  private cache: { value: LiveNightscoutData; expiresAtMs: number } | null = null;

  constructor(
    private readonly reader: LiveNightscoutReader,
    private readonly patientId: string,
    private readonly nowMs: () => number = Date.now,
    private readonly timeoutMs: number = TIMEOUT_MS,
  ) {}

  async latest(patientId: string): Promise<LiveNightscoutData | null> {
    if (patientId !== this.patientId) {
      return null;
    }
    const now = this.nowMs();
    if (this.cache && this.cache.expiresAtMs > now) {
      return this.cache.value;
    }

    try {
      const [entries, status] = await withTimeout(
        Promise.all([this.reader.fetchRecentEntries(now - LOOKBACK_MS, MAX_ENTRIES), this.reader.fetchLatestDeviceStatus()]),
        this.timeoutMs,
      );
      const value = { readings: entries.flatMap(toReading), deviceStatus: toDeviceStatus(status) };
      this.cache = { value, expiresAtMs: now + CACHE_TTL_MS };
      return value;
    } catch {
      return null;
    }
  }
}

function toReading(entry: NightscoutEntryDto): DashboardGlucoseReading[] {
  if (entry.type && entry.type !== 'sgv') return [];
  const value = Number(entry.sgv);
  const time = typeof entry.date === 'number' ? entry.date : Date.parse(String(entry.dateString ?? entry.date ?? ''));
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(time)) return [];
  const direction = typeof entry.direction === 'string' && entry.direction.trim() ? entry.direction.trim() : null;
  return [{ at: new Date(time).toISOString(), value, direction }];
}

function toDeviceStatus(status: NightscoutDeviceStatusDto | null): DashboardDeviceStatus | null {
  if (!status) return null;
  const observedAt = Date.parse(String(status.created_at ?? status.timestamp ?? ''));
  if (!Number.isFinite(observedAt)) return null;
  return { observed_at: new Date(observedAt).toISOString(), raw_payload: status as Record<string, unknown> };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Nightscout live read timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
