import type { Pool } from 'pg';
import type { PushOutboxItem, PushOutboxRequest, PushOutboxStore } from '@modules/notifications/application/push-outbox';

interface PushOutboxRow {
  id: string;
  dedupe_key: string;
  patient_id: string;
  request: PushOutboxRequest;
  exclude_user_id: string | null;
  attempts: number;
  expires_at: Date | string;
}

/** push-outbox.v1 (migration 079): reminder pushes kept until every phone has them or they expire. */
export class PostgresPushOutboxRepository implements PushOutboxStore {
  constructor(private readonly pool: Pool) {}

  async enqueue(args: { dedupeKey: string; patientId: string; request: PushOutboxRequest; excludeUserId: string | null; expiresAt: string; nextAttemptAt?: string | null }): Promise<PushOutboxItem | null> {
    const result = await this.pool.query<PushOutboxRow>(
      `INSERT INTO push_outbox (dedupe_key, patient_id, notification_type, request, exclude_user_id, expires_at, next_attempt_at)
       VALUES ($1, $2::uuid, $3, $4::jsonb, $5::uuid, $6::timestamptz, $7::timestamptz)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id, dedupe_key, patient_id, request, exclude_user_id, attempts, expires_at`,
      [args.dedupeKey, args.patientId, args.request.kind, JSON.stringify(args.request), args.excludeUserId, args.expiresAt, args.nextAttemptAt ?? null],
    );
    return result.rows[0] ? toItem(result.rows[0]) : null;
  }

  async listDue(nowIso: string, limit: number): Promise<PushOutboxItem[]> {
    const result = await this.pool.query<PushOutboxRow>(
      `SELECT id, dedupe_key, patient_id, request, exclude_user_id, attempts, expires_at
       FROM push_outbox
       WHERE completed_at IS NULL AND next_attempt_at IS NOT NULL AND next_attempt_at <= $1::timestamptz
       ORDER BY next_attempt_at
       LIMIT $2`,
      [nowIso, limit],
    );
    return result.rows.map(toItem);
  }

  async deliveredTokens(id: string): Promise<Set<string>> {
    const result = await this.pool.query<{ push_token: string }>(`SELECT push_token FROM push_outbox_deliveries WHERE outbox_id = $1::uuid`, [id]);
    return new Set(result.rows.map((row) => row.push_token));
  }

  async markDelivered(id: string, pushToken: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO push_outbox_deliveries (outbox_id, push_token) VALUES ($1::uuid, $2) ON CONFLICT DO NOTHING`,
      [id, pushToken],
    );
  }

  async finishAttempt(id: string, args: { complete: boolean; nextAttemptAt: string | null; errorCode: string | null }): Promise<void> {
    await this.pool.query(
      `UPDATE push_outbox
       SET attempts = attempts + 1,
           next_attempt_at = $2::timestamptz,
           completed_at = CASE WHEN $3 THEN now() ELSE NULL END,
           last_error_code = $4,
           updated_at = now()
       WHERE id = $1::uuid`,
      [id, args.nextAttemptAt, args.complete, args.errorCode],
    );
  }
}

function toItem(row: PushOutboxRow): PushOutboxItem {
  return {
    id: row.id,
    dedupe_key: row.dedupe_key,
    patient_id: row.patient_id,
    request: row.request,
    exclude_user_id: row.exclude_user_id,
    attempts: row.attempts,
    expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
  };
}
