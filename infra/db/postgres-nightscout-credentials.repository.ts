import type { Pool } from 'pg';

export type StoredNightscoutAuthMode = 'BEARER' | 'API_SECRET_SHA1' | 'ACCESS_TOKEN_JWT';

/** A patient's Nightscout as stored (090_sharing_foundation.sql); the token stays encrypted here. */
export interface StoredNightscoutCredentials {
  source_id: string;
  patient_id: string;
  enabled: boolean;
  base_url: string | null;
  auth_mode: StoredNightscoutAuthMode | null;
  api_token_ciphertext: string | null;
  credentials_updated_at: string | null;
}

export interface SaveNightscoutCredentialsInput {
  patientId: string;
  baseUrl: string;
  authMode: StoredNightscoutAuthMode;
  tokenCiphertext: string;
  /** true: only a patient without a stored token gets these (the one-time seed from env). */
  onlyIfMissing?: boolean;
}

const RETURNED_COLUMNS = 'id, patient_id, enabled, base_url, auth_mode, api_token_ciphertext, credentials_updated_at';
/** The patient's connection source first: credentials, then the source keyed by the patient id, then the oldest. */
const CONNECTION_SOURCE_ORDER = '(api_token_ciphertext IS NOT NULL) DESC, (source_key = patient_id::text) DESC, created_at ASC';

/** One Nightscout connection per patient (sources_one_nightscout_connection_per_patient_idx), its token encrypted. */
export class PostgresNightscoutCredentialsRepository {
  constructor(private readonly pool: Pool) {}

  async getNightscoutCredentials(patientId: string): Promise<StoredNightscoutCredentials | null> {
    const row = (await this.pool.query(
      `SELECT id, patient_id, enabled, base_url, auth_mode, api_token_ciphertext, credentials_updated_at
       FROM sources WHERE patient_id = $1::uuid AND source_system = 'NIGHTSCOUT'
       ORDER BY ${CONNECTION_SOURCE_ORDER}
       LIMIT 1`,
      [patientId],
    )).rows[0];
    return row ? toCredentials(row) : null;
  }

  /**
   * Stores the patient's address and token on its connection source (the one with credentials, else the one keyed by
   * the patient id, else the oldest), creating it when the patient has none. Returns null when onlyIfMissing found a
   * token already stored. The sync cursors (metadata.stream_cursors) are kept: the same patient's history continues.
   */
  async saveNightscoutCredentials(input: SaveNightscoutCredentialsInput): Promise<StoredNightscoutCredentials | null> {
    const baseUrl = new URL(input.baseUrl).origin;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM patients WHERE id = $1::uuid FOR UPDATE`, [input.patientId]);
      const existing = (await client.query(
        `SELECT id, api_token_ciphertext FROM sources WHERE patient_id = $1::uuid AND source_system = 'NIGHTSCOUT'
         ORDER BY ${CONNECTION_SOURCE_ORDER} LIMIT 1`,
        [input.patientId],
      )).rows[0];
      if (existing?.api_token_ciphertext && input.onlyIfMissing) {
        await client.query('ROLLBACK');
        return null;
      }
      const row = existing
        ? (await client.query(
          `UPDATE sources SET base_url = $2, auth_mode = $3, api_token_ciphertext = $4, credentials_updated_at = now(),
                  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('base_url', $2::text), updated_at = now()
           WHERE id = $1::uuid
           RETURNING ${RETURNED_COLUMNS}`,
          [existing.id, baseUrl, input.authMode, input.tokenCiphertext],
        )).rows[0]
        : (await client.query(
          `INSERT INTO sources (patient_id, source_system, source_key, source_version, metadata, enabled, base_url, auth_mode,
                                api_token_ciphertext, credentials_updated_at)
           VALUES ($1::uuid, 'NIGHTSCOUT', $1::text, 'nightscout.v1',
                   jsonb_build_object('base_url', $2::text, 'source_patient_id', $1::text), true, $2, $3, $4, now())
           RETURNING ${RETURNED_COLUMNS}`,
          [input.patientId, baseUrl, input.authMode, input.tokenCiphertext],
        )).rows[0];
      await client.query('COMMIT');
      return toCredentials(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Off: the worker stops syncing the patient (every source of it) and the API its live reads; the data stays. */
  async setNightscoutSourceEnabled(patientId: string, enabled: boolean): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE sources SET enabled = $2, updated_at = now() WHERE patient_id = $1::uuid AND source_system = 'NIGHTSCOUT'`,
      [patientId, enabled],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

function toCredentials(row: Record<string, any>): StoredNightscoutCredentials {
  return {
    source_id: row.id,
    patient_id: row.patient_id,
    enabled: row.enabled,
    base_url: row.base_url,
    auth_mode: row.auth_mode,
    api_token_ciphertext: row.api_token_ciphertext,
    credentials_updated_at: row.credentials_updated_at ? new Date(row.credentials_updated_at).toISOString() : null,
  };
}
