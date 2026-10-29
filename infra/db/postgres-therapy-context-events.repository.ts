import type { Pool } from 'pg';
import type { TherapyContextEvent, TherapyContextKind } from '@modules/integrations/nightscout/application/therapy-context-events';

export interface StoredTherapyContextEvent extends TherapyContextEvent {
  id: string;
}

/** therapy_context_events (migration 086): written by the Nightscout import, read for the AI. */
export class PostgresTherapyContextEventRepository {
  constructor(private readonly pool: Pool) {}

  /** Stores one event; a treatment already stored is kept as it is (true when this call stored it). */
  async insert(patientId: string, event: TherapyContextEvent): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO therapy_context_events (patient_id, source_record_id, kind, event_type, occurred_at, duration_minutes, details)
       VALUES ($1::uuid, $2, $3, $4, $5::timestamptz, $6, $7::jsonb)
       ON CONFLICT (patient_id, source_record_id) DO NOTHING`,
      [patientId, event.source_record_id, event.kind, event.event_type, event.occurred_at, event.duration_minutes, JSON.stringify(event.details)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Notes of refused remote commands whose `remote-address` starts with `prefix` (Loop's refusals of GlucoMind's pushes). */
  async listRemoteCommandNotesSince(sinceIso: string, prefix: string, limit = 50): Promise<Array<{ patient_id: string; occurred_at: string; remote_address: string; notes: string | null }>> {
    const rows = (await this.pool.query(
      `SELECT patient_id::text, occurred_at, details->>'remote_address' AS remote_address, details->>'notes' AS notes
       FROM therapy_context_events
       WHERE kind = 'NOTE' AND occurred_at >= $1::timestamptz AND starts_with(details->>'remote_address', $2)
       ORDER BY occurred_at LIMIT $3`,
      [sinceIso, prefix, limit],
    )).rows;
    return rows.map((row) => ({ patient_id: String(row.patient_id), occurred_at: new Date(row.occurred_at).toISOString(), remote_address: String(row.remote_address), notes: row.notes ?? null }));
  }

  /** Events that started in [from, to], oldest first, at most `limit`. */
  async listBetween(patientId: string, fromIso: string, toIso: string, limit = 200): Promise<StoredTherapyContextEvent[]> {
    const rows = (await this.pool.query(
      `SELECT * FROM (
         SELECT * FROM therapy_context_events WHERE patient_id = $1::uuid AND occurred_at >= $2::timestamptz AND occurred_at <= $3::timestamptz
         ORDER BY occurred_at DESC LIMIT $4
       ) newest ORDER BY occurred_at`,
      [patientId, fromIso, toIso, limit],
    )).rows;
    return rows.map(toEvent);
  }

  /** The newest event of each kind at or before `atIso` (for what is active now and how old the site / sensor are). */
  async latestPerKind(patientId: string, atIso: string, kinds: TherapyContextKind[]): Promise<StoredTherapyContextEvent[]> {
    const rows = (await this.pool.query(
      `SELECT DISTINCT ON (kind) * FROM therapy_context_events
       WHERE patient_id = $1::uuid AND occurred_at <= $2::timestamptz AND kind = ANY($3::text[])
       ORDER BY kind, occurred_at DESC`,
      [patientId, atIso, kinds],
    )).rows;
    return rows.map(toEvent);
  }
}

function toEvent(row: Record<string, unknown>): StoredTherapyContextEvent {
  return {
    id: String(row.id),
    source_record_id: String(row.source_record_id),
    kind: row.kind as TherapyContextKind,
    event_type: String(row.event_type),
    occurred_at: new Date(row.occurred_at as string).toISOString(),
    duration_minutes: row.duration_minutes === null || row.duration_minutes === undefined ? null : Number(row.duration_minutes),
    details: (row.details ?? {}) as Record<string, unknown>,
  };
}
