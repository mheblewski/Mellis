import type { Pool } from 'pg';
import type { ReleaseCheckFinding, ReleaseCheckStore, StoredReleaseCheck } from '@modules/app-config/application/release-check';

/** The server's newest known release (migration 101, release-check.v1) and the owners' phones for its one safety push. */
export class PostgresReleaseCheckRepository implements ReleaseCheckStore {
  constructor(private readonly pool: Pool) {}

  async get(): Promise<StoredReleaseCheck | null> {
    const result = await this.pool.query<Omit<StoredReleaseCheck, 'checked_at'> & { checked_at: Date }>(
      `SELECT latest_version, notes_url, safety_version, safety_notified_version, checked_at FROM server_release_check WHERE id`,
    );
    const row = result.rows[0];
    return row ? { ...row, checked_at: row.checked_at.toISOString() } : null;
  }

  async save(finding: ReleaseCheckFinding, checkedAt: Date): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO server_release_check (id, latest_version, notes_url, safety_version, checked_at)
        VALUES (true, $1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET
          latest_version = EXCLUDED.latest_version,
          notes_url = EXCLUDED.notes_url,
          safety_version = EXCLUDED.safety_version,
          checked_at = EXCLUDED.checked_at,
          updated_at = now()
      `,
      [finding.latest_version, finding.notes_url, finding.safety_version, checkedAt.toISOString()],
    );
  }

  async claimSafetyPush(version: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE server_release_check SET safety_notified_version = $1::text, updated_at = now()
        WHERE id AND safety_notified_version IS DISTINCT FROM $1::text
      `,
      [version],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listOwnerDevices(): Promise<Array<{ patient_id: string; push_token: string }>> {
    const result = await this.pool.query<{ patient_id: string; push_token: string }>(
      `
        SELECT DISTINCT ON (d.push_token) d.patient_id::text, d.push_token
        FROM patient_devices d
        JOIN caregiver_relationships r ON r.user_id = d.user_id AND r.patient_id = d.patient_id AND r.is_owner
        WHERE d.platform = 'ios' AND d.active = true
        ORDER BY d.push_token, d.updated_at DESC
      `,
    );
    return result.rows;
  }

  async deactivatePushToken(pushToken: string): Promise<void> {
    await this.pool.query(`UPDATE patient_devices SET active = false, updated_at = now() WHERE push_token = $1`, [pushToken]);
  }
}
