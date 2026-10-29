import type { Pool } from 'pg';
import { SecretBox } from '@infra/security/secret-box';
import type { NightscoutClient } from '@modules/integrations/nightscout/application/nightscout-client';
import { NightscoutClientError } from '@modules/integrations/nightscout/infrastructure/http-nightscout-client';
import { PatientNightscoutClients } from '@modules/integrations/nightscout/infrastructure/patient-nightscout-clients';
import { PostgresNightscoutCredentialsRepository } from './postgres-nightscout-credentials.repository';

/** The patients' stored Nightscout connections; null without NIGHTSCOUT_TOKEN_ENCRYPTION_KEY (no token can be read). */
export function patientNightscoutClientsFromEnv(pool: Pool, env: Record<string, string | undefined>): PatientNightscoutClients | null {
  const box = SecretBox.fromEnv(env);
  return box ? new PatientNightscoutClients(new PostgresNightscoutCredentialsRepository(pool), box) : null;
}

/** Used when the sync is off and no key is set: any request fails without reaching a network. */
export const UNCONFIGURED_NIGHTSCOUT_CLIENT: NightscoutClient = {
  fetchEntries: () => Promise.reject(new NightscoutClientError('NIGHTSCOUT_TOKEN_ENCRYPTION_KEY_MISSING', false)),
  fetchTreatments: () => Promise.reject(new NightscoutClientError('NIGHTSCOUT_TOKEN_ENCRYPTION_KEY_MISSING', false)),
  fetchDeviceStatuses: () => Promise.reject(new NightscoutClientError('NIGHTSCOUT_TOKEN_ENCRYPTION_KEY_MISSING', false)),
  fetchProfiles: () => Promise.reject(new NightscoutClientError('NIGHTSCOUT_TOKEN_ENCRYPTION_KEY_MISSING', false)),
};
