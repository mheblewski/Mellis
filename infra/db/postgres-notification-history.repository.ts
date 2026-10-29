import type { Pool } from 'pg';
import type { NotificationHistoryEntry, NotificationHistoryRecorder } from '@modules/notifications/application/notification-history';

export interface NotificationHistoryRow {
  id: string;
  type: string;
  title: string;
  body: string;
  sent_at: string;
  payload: Record<string, unknown>;
}

const UNDEFINED_TABLE = '42P01';

export class PostgresNotificationHistoryRepository implements NotificationHistoryRecorder {
  constructor(private readonly pool: Pool) {}

  async record(entry: NotificationHistoryEntry): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO notification_history (patient_id, dedupe_key, notification_type, title, body, payload)
        VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb)
        ON CONFLICT (dedupe_key) DO NOTHING
      `,
      [entry.patientId, entry.dedupeKey, entry.type, entry.title, entry.body, JSON.stringify(entry.payload)],
    );
  }

  /**
   * Newest first. Notifications of a deleted conversation are left out: the conversation can no longer be opened.
   * So is a notification whose request no longer waits for the caregiver (either caregiver did it, skipped it, or it
   * lapsed): the meal's WBT given (or its reminder turned off), the bolus's later part given, the rescue carbs given or
   * declined, the question answered. Answers ready and the chat's reminders stay: they ask for nothing. Before
   * migration 039 the list is empty.
   */
  async listRecent(patientId: string, limit: number): Promise<NotificationHistoryRow[]> {
    try {
      const result = await this.pool.query(
        `
          SELECT n.id, n.notification_type, n.title, n.body, n.sent_at, n.payload
          FROM notification_history n
          LEFT JOIN conversations c ON c.id = (n.payload->>'conversationId')::uuid
          WHERE n.patient_id = $1::uuid
            AND (NOT (n.payload ? 'conversationId') OR (c.id IS NOT NULL AND c.deleted_at IS NULL))
            AND NOT CASE n.notification_type
              WHEN 'wbt_reminder' THEN EXISTS (
                SELECT 1 FROM loop_actions la
                WHERE la.meal_record_id = (n.payload->>'mealId')::uuid AND la.patient_id = n.patient_id AND la.purpose = 'WBT'
              ) OR EXISTS (
                SELECT 1 FROM meal_wbt_reminders r
                WHERE r.meal_record_id = (n.payload->>'mealId')::uuid AND r.patient_id = n.patient_id
                  AND (NOT r.enabled OR r.status = 'SKIPPED')
              )
              WHEN 'planned_bolus' THEN EXISTS (
                SELECT 1 FROM planned_boluses pb
                WHERE pb.id = (n.payload->>'plannedBolusId')::uuid AND pb.patient_id = n.patient_id
                  AND pb.status NOT IN ('SCHEDULED', 'NOTIFIED')
              )
              WHEN 'rescue_carbs' THEN EXISTS (
                SELECT 1 FROM rescue_carb_alerts a
                WHERE a.id = (n.payload->>'alertId')::uuid AND a.patient_id = n.patient_id
                  AND (a.status NOT IN ('PENDING', 'NOTIFIED') OR a.declined_at IS NOT NULL)
              )
              -- A question the chat no longer waits for (answered or replaced by another).
              WHEN 'conversation_question' THEN EXISTS (
                SELECT 1 FROM context_questions q
                WHERE q.conversation_id = c.id AND q.question_id = n.payload->>'questionId' AND q.status <> 'OPEN'
              )
              ELSE false
            END
          ORDER BY n.sent_at DESC
          LIMIT $2
        `,
        [patientId, limit],
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        type: String(row.notification_type),
        title: String(row.title),
        body: String(row.body),
        sent_at: row.sent_at instanceof Date ? row.sent_at.toISOString() : String(row.sent_at),
        payload: row.payload as Record<string, unknown>,
      }));
    } catch (error) {
      if ((error as { code?: string })?.code === UNDEFINED_TABLE) return [];
      throw error;
    }
  }
}
