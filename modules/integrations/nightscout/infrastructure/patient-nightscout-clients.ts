import type { SecretBox } from '@infra/security/secret-box';
import type {
  SaveNightscoutCredentialsInput,
  StoredNightscoutCredentials,
} from '@infra/db/postgres-nightscout-credentials.repository';
import type {
  FetchDeviceStatusesInput,
  FetchDeviceStatusesResult,
  FetchEntriesInput,
  FetchEntriesResult,
  FetchProfilesInput,
  FetchProfilesResult,
  FetchTreatmentsInput,
  FetchTreatmentsResult,
  NightscoutClient,
} from '../application/nightscout-client';
import { HttpNightscoutClient, NightscoutClientError, type NightscoutAuthMode } from './http-nightscout-client';
import { guardsNightscoutHost } from '../application/nightscout-connection';

export interface NightscoutCredentialStore {
  getNightscoutCredentials(patientId: string): Promise<StoredNightscoutCredentials | null>;
  saveNightscoutCredentials(input: SaveNightscoutCredentialsInput): Promise<StoredNightscoutCredentials | null>;
}

/** A changed address or token is picked up within this time (the client and its exchanged JWT are kept otherwise). */
const CREDENTIALS_TTL_MS = 30_000;

type CachedClient = { fingerprint: string; client: HttpNightscoutClient | null; checkedAtMs: number };

/**
 * Every patient's own Nightscout (sources.base_url / auth_mode / api_token_ciphertext). As a NightscoutClient it routes
 * each sync request to the patient named in it, so the sync service is unchanged; forPatient() gives the API's live
 * reads the same client. The token is decrypted only in memory and never logged.
 */
export class PatientNightscoutClients implements NightscoutClient {
  private readonly cache = new Map<string, CachedClient>();

  constructor(
    private readonly store: NightscoutCredentialStore,
    private readonly box: SecretBox,
    private readonly options: {
      nowMs?: () => number;
      createClient?: (baseUrl: string, token: string, authMode: NightscoutAuthMode) => HttpNightscoutClient;
    } = {},
  ) {}

  /** null for a patient without an enabled, complete source. */
  async forPatient(patientId: string): Promise<HttpNightscoutClient | null> {
    const now = (this.options.nowMs ?? Date.now)();
    const cached = this.cache.get(patientId);
    if (cached && now - cached.checkedAtMs < CREDENTIALS_TTL_MS) return cached.client;

    const stored = await this.store.getNightscoutCredentials(patientId);
    const usable = stored && stored.enabled && stored.base_url && stored.api_token_ciphertext ? stored : null;
    const fingerprint = usable ? `${usable.base_url}|${usable.auth_mode ?? 'BEARER'}|${usable.api_token_ciphertext}` : '';
    if (cached && cached.fingerprint === fingerprint) {
      cached.checkedAtMs = now;
      return cached.client;
    }
    // Sync of an address a person typed is guarded like its connection test (audit #7), unless the server lists it.
    const client = usable
      ? (this.options.createClient ?? ((url, token, mode) => new HttpNightscoutClient(url, token, mode, { guardPrivateNetwork: guardsNightscoutHost(url, process.env) })))(
        usable.base_url as string,
        this.box.decrypt(usable.api_token_ciphertext as string),
        usable.auth_mode ?? 'BEARER',
      )
      : null;
    this.cache.set(patientId, { fingerprint, client, checkedAtMs: now });
    return client;
  }

  /** Stores (encrypted) and uses at once a patient's Nightscout. onlyIfMissing: false when a token was already stored. */
  async saveCredentials(
    patientId: string,
    credentials: { baseUrl: string; token: string; authMode: NightscoutAuthMode },
    options: { onlyIfMissing?: boolean } = {},
  ): Promise<boolean> {
    if (!credentials.token.trim()) throw new Error('Nightscout credential must be a non-empty string');
    const saved = await this.store.saveNightscoutCredentials({
      patientId,
      baseUrl: credentials.baseUrl,
      authMode: credentials.authMode,
      tokenCiphertext: this.box.encrypt(credentials.token.trim()),
      onlyIfMissing: options.onlyIfMissing,
    });
    this.cache.delete(patientId);
    return saved !== null;
  }

  /**
   * The one-time seed: NIGHTSCOUT_PATIENT_ID / NIGHTSCOUT_BASE_URL / NIGHTSCOUT_API_TOKEN (/ NIGHTSCOUT_AUTH_MODE) become
   * that patient's stored source unless it already has a token, so an environment keeps syncing after migration 090.
   * Later changes go through the stored source; env never overrides it.
   */
  async seedFromEnv(env: Record<string, string | undefined>): Promise<NightscoutSeedResult> {
    const patientId = env.NIGHTSCOUT_PATIENT_ID?.trim();
    const baseUrl = env.NIGHTSCOUT_BASE_URL?.trim();
    const token = env.NIGHTSCOUT_API_TOKEN?.trim();
    if (!patientId || !baseUrl || !token) return { status: 'NO_ENV_SOURCE' };
    const authMode = (env.NIGHTSCOUT_AUTH_MODE?.trim().toUpperCase() || 'BEARER') as NightscoutAuthMode;
    const seeded = await this.saveCredentials(patientId, { baseUrl, token, authMode }, { onlyIfMissing: true });
    if (seeded) return { status: 'SEEDED', patient_id: patientId };
    const stored = await this.store.getNightscoutCredentials(patientId);
    const sameAddress = stored?.base_url === new URL(baseUrl).origin;
    return { status: 'ALREADY_STORED', patient_id: patientId, env_address_differs: !sameAddress };
  }

  fetchEntries(input: FetchEntriesInput): Promise<FetchEntriesResult> {
    return this.required(input.patient_id).then((client) => client.fetchEntries(input));
  }

  fetchTreatments(input: FetchTreatmentsInput): Promise<FetchTreatmentsResult> {
    return this.required(input.patient_id).then((client) => client.fetchTreatments(input));
  }

  fetchDeviceStatuses(input: FetchDeviceStatusesInput): Promise<FetchDeviceStatusesResult> {
    return this.required(input.patient_id).then((client) => client.fetchDeviceStatuses(input));
  }

  fetchProfiles(input: FetchProfilesInput): Promise<FetchProfilesResult> {
    return this.required(input.patient_id).then((client) => client.fetchProfiles(input));
  }

  private async required(patientId: string): Promise<HttpNightscoutClient> {
    const client = await this.forPatient(patientId);
    if (!client) throw new NightscoutClientError('NIGHTSCOUT_SOURCE_NOT_CONFIGURED', false);
    return client;
  }
}

export type NightscoutSeedResult =
  | { status: 'NO_ENV_SOURCE' }
  | { status: 'SEEDED'; patient_id: string }
  | { status: 'ALREADY_STORED'; patient_id: string; env_address_differs: boolean };

export function isNightscoutSourceSeeder(client: unknown): client is Pick<PatientNightscoutClients, 'seedFromEnv'> {
  return !!client && typeof (client as { seedFromEnv?: unknown }).seedFromEnv === 'function';
}
