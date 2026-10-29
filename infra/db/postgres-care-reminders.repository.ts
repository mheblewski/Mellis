import type { Pool } from 'pg';
import type { CareReminderRecord, CareReminderStatus, CareReminderStore, CareReminderTrigger, NewCareReminder, NewSecondDoseReminder } from '@modules/care-reminders/application/care-reminders';

/** PostgreSQL storage of the reminders the chat sets (migrations 063, 065) and of Bolus tab second doses (073). */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toIso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string | Date).toISOString());
const num = (value: unknown): number | null => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));

const SELECT_REMINDER = `SELECT r.*, u.display_name AS cancelled_by_name FROM care_reminders r LEFT JOIN users u ON u.id = r.cancelled_by_user_id`;

export class PostgresCareReminderRepository implements CareReminderStore {
  constructor(private readonly pool: Pool) {}

  async insert(reminder: NewCareReminder): Promise<CareReminderRecord> {
    const row = (await this.pool.query(
      `INSERT INTO care_reminders (patient_id, conversation_id, user_message_id, created_by_user_id, note, trigger, due_at, threshold_mgdl, wait_until)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7::timestamptz, $8, $9::timestamptz)
       RETURNING id`,
      [reminder.patient_id, reminder.conversation_id, reminder.user_message_id, reminder.created_by_user_id, reminder.note, reminder.trigger, reminder.due_at, reminder.threshold_mgdl, reminder.wait_until],
    )).rows[0];
    return (await this.get(reminder.patient_id, String(row.id)))!;
  }

  /** A Bolus tab meal's second dose; a meal has one (the first one stays when it is created again). Null when it existed. */
  async insertSecondDose(reminder: NewSecondDoseReminder): Promise<CareReminderRecord | null> {
    const row = (await this.pool.query(
      `INSERT INTO care_reminders (patient_id, conversation_id, user_message_id, created_by_user_id, note, trigger, due_at, threshold_mgdl, wait_until, kind, meal_record_id)
       VALUES ($1::uuid, NULL, $2, $3::uuid, $4, $5, $6::timestamptz, NULL, $7::timestamptz, 'SECOND_DOSE', $8::uuid)
       ON CONFLICT (meal_record_id) WHERE kind = 'SECOND_DOSE' DO NOTHING
       RETURNING id`,
      [reminder.patient_id, reminder.source_ref, reminder.created_by_user_id, reminder.note, reminder.trigger, reminder.due_at, reminder.wait_until, reminder.meal_record_id],
    )).rows[0];
    return row ? this.get(reminder.patient_id, String(row.id)) : null;
  }

  /** The reminders of these meals (second doses), oldest first. */
  async listForMeals(patientId: string, mealRecordIds: string[]): Promise<CareReminderRecord[]> {
    const ids = mealRecordIds.filter((id) => UUID_PATTERN.test(id));
    if (ids.length === 0) return [];
    const rows = (await this.pool.query(`${SELECT_REMINDER} WHERE r.patient_id = $1::uuid AND r.meal_record_id = ANY($2::uuid[]) ORDER BY r.created_at`, [patientId, ids])).rows;
    return rows.map(toRecord);
  }

  /**
   * Switches a cancelled reminder back on while it can still come: never fired or lapsed, its time (AT_TIME) or its
   * watching time (glucose) not past. Null when it cannot.
   */
  async reactivate(patientId: string, id: string): Promise<CareReminderRecord | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const row = (await this.pool.query(
      `UPDATE care_reminders SET status = 'ACTIVE', cancelled_at = NULL, cancelled_by_user_id = NULL, updated_at = now()
       WHERE patient_id = $1::uuid AND id = $2::uuid AND status = 'CANCELLED' AND fired_at IS NULL
         AND CASE WHEN trigger = 'AT_TIME' THEN due_at > now() ELSE wait_until > now() END
       RETURNING id`,
      [patientId, id],
    )).rows[0];
    return row ? this.get(patientId, String(row.id)) : null;
  }

  async get(patientId: string, id: string): Promise<CareReminderRecord | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const row = (await this.pool.query(`${SELECT_REMINDER} WHERE r.patient_id = $1::uuid AND r.id = $2::uuid`, [patientId, id])).rows[0];
    return row ? toRecord(row) : null;
  }

  /** A new answer to the same message replaces the reminders an earlier, failed attempt set (never shown). */
  async discardForUserMessage(patientId: string, userMessageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE care_reminders SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
       WHERE patient_id = $1::uuid AND user_message_id = $2 AND status = 'ACTIVE'`,
      [patientId, userMessageId],
    );
  }

  async listForConversation(patientId: string, conversationId: string): Promise<CareReminderRecord[]> {
    if (!UUID_PATTERN.test(conversationId)) return [];
    const rows = (await this.pool.query(`${SELECT_REMINDER} WHERE r.patient_id = $1::uuid AND r.conversation_id = $2::uuid ORDER BY r.created_at`, [patientId, conversationId])).rows;
    return rows.map(toRecord);
  }

  /** One patient's active reminders (therapy-now.v1: what the conversation prompts see). */
  async listActiveForPatient(patientId: string): Promise<CareReminderRecord[]> {
    const rows = (await this.pool.query(`${SELECT_REMINDER} WHERE r.patient_id = $1::uuid AND r.status = 'ACTIVE' ORDER BY r.due_at`, [patientId])).rows;
    return rows.map(toRecord);
  }

  async listActive(): Promise<CareReminderRecord[]> {
    const rows = (await this.pool.query(
      `SELECT r.*, u.display_name AS cancelled_by_name, (c.deleted_at IS NOT NULL) AS conversation_deleted
       FROM care_reminders r
       LEFT JOIN users u ON u.id = r.cancelled_by_user_id
       LEFT JOIN conversations c ON c.id = r.conversation_id
       WHERE r.status = 'ACTIVE' ORDER BY r.due_at`,
    )).rows;
    return rows.map(toRecord);
  }

  async markFired(patientId: string, id: string, reason: 'READY' | 'FORCED', glucose: number | null): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE care_reminders SET status = 'FIRED', fired_at = now(), fired_reason = $3, fired_glucose_mgdl = $4, updated_at = now()
       WHERE patient_id = $1::uuid AND id = $2::uuid AND status = 'ACTIVE'`,
      [patientId, id, reason, glucose],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markExpired(patientId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE care_reminders SET status = 'EXPIRED', updated_at = now() WHERE patient_id = $1::uuid AND id = $2::uuid AND status = 'ACTIVE'`,
      [patientId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** ACTIVE -> MISSED: a reminder at a time the worker could not send within 2 h (no late push). */
  async markMissed(patientId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE care_reminders SET status = 'MISSED', updated_at = now() WHERE patient_id = $1::uuid AND id = $2::uuid AND status = 'ACTIVE'`,
      [patientId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** ACTIVE -> GIVEN: the dose a second dose's reminder asks for was given before it came (no push). */
  async markGivenBeforeDue(patientId: string, id: string, givenAt: string, loopActionId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE care_reminders SET status = 'GIVEN', dose_given_at = $3::timestamptz, dose_given_action_id = $4::uuid, updated_at = now()
       WHERE patient_id = $1::uuid AND id = $2::uuid AND status = 'ACTIVE'`,
      [patientId, id, givenAt, loopActionId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async cancel(patientId: string, id: string, userId: string): Promise<CareReminderRecord | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const row = (await this.pool.query(
      `UPDATE care_reminders SET status = 'CANCELLED', cancelled_at = now(), cancelled_by_user_id = $3::uuid, updated_at = now()
       WHERE patient_id = $1::uuid AND id = $2::uuid AND status = 'ACTIVE'
       RETURNING id`,
      [patientId, id, userId],
    )).rows[0];
    return row ? this.get(patientId, String(row.id)) : null;
  }
}

function toRecord(row: Record<string, unknown>): CareReminderRecord {
  return {
    id: String(row.id),
    patient_id: String(row.patient_id),
    conversation_id: row.conversation_id ? String(row.conversation_id) : null,
    user_message_id: row.user_message_id ? String(row.user_message_id) : null,
    created_by_user_id: row.created_by_user_id ? String(row.created_by_user_id) : null,
    note: String(row.note),
    trigger: row.trigger as CareReminderTrigger,
    due_at: toIso(row.due_at) as string,
    threshold_mgdl: num(row.threshold_mgdl),
    wait_until: toIso(row.wait_until),
    status: row.status as CareReminderStatus,
    fired_at: toIso(row.fired_at),
    fired_reason: row.fired_reason === 'READY' || row.fired_reason === 'FORCED' ? row.fired_reason : null,
    fired_glucose_mgdl: num(row.fired_glucose_mgdl),
    cancelled_at: toIso(row.cancelled_at),
    cancelled_by_user_id: row.cancelled_by_user_id ? String(row.cancelled_by_user_id) : null,
    cancelled_by_name: (row.cancelled_by_name as string | null) ?? null,
    created_at: toIso(row.created_at) as string,
    kind: row.kind === 'SECOND_DOSE' ? 'SECOND_DOSE' : null,
    meal_record_id: row.meal_record_id ? String(row.meal_record_id) : null,
    dose_given_at: toIso(row.dose_given_at) ?? null,
    dose_given_action_id: row.dose_given_action_id ? String(row.dose_given_action_id) : null,
    ...(row.conversation_deleted === true ? { conversation_deleted: true } : {}),
  };
}
