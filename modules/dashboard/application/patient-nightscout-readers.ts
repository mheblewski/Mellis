import type { DashboardCareEvents } from './dashboard-snapshot';
import { NightscoutCareEvents, type LatestTreatmentReader } from './nightscout-care-events';
import { NightscoutLive, type LiveNightscoutData, type LiveNightscoutReader } from './nightscout-live';

/** Each patient's own Nightscout client (PatientNightscoutClients.forPatient); null without an enabled source. */
export interface PatientNightscoutDirectory {
  forPatient(patientId: string): Promise<(LiveNightscoutReader & LatestTreatmentReader) | null>;
}

/**
 * The dashboard's live reads for every patient: one NightscoutLive and NightscoutCareEvents per patient (each keeps its
 * own cache), rebuilt when the patient's stored Nightscout changes (the directory then hands out a new client).
 */
export class PatientNightscoutReaders {
  private readonly readers = new Map<string, { client: unknown; live: NightscoutLive; careEvents: NightscoutCareEvents }>();

  constructor(private readonly directory: PatientNightscoutDirectory) {}

  readonly live = { latest: (patientId: string): Promise<LiveNightscoutData | null> => this.read(patientId, (r) => r.live.latest(patientId)) };

  readonly careEvents = { latest: (patientId: string): Promise<DashboardCareEvents | null> => this.read(patientId, (r) => r.careEvents.latest(patientId)) };

  private async read<T>(patientId: string, use: (readers: { live: NightscoutLive; careEvents: NightscoutCareEvents }) => Promise<T | null>): Promise<T | null> {
    let client: (LiveNightscoutReader & LatestTreatmentReader) | null;
    try {
      client = await this.directory.forPatient(patientId);
    } catch {
      // A missing key or an unreadable token: the dashboard shows the synced data.
      return null;
    }
    if (!client) {
      this.readers.delete(patientId);
      return null;
    }
    let readers = this.readers.get(patientId);
    if (!readers || readers.client !== client) {
      readers = { client, live: new NightscoutLive(client, patientId), careEvents: new NightscoutCareEvents(client, patientId) };
      this.readers.set(patientId, readers);
    }
    return use(readers);
  }
}
