import type { Pool } from 'pg';
import { MEAL_JOURNAL_POLICY } from '@modules/meal-journal/application/meal-journal';

/**
 * Reads of the Meals tab's journal (meal-journal.v1, migration 073): which meals it lists (a description or a reminder),
 * where they came from, who sent their doses, and the description search. Meal values, loop actions and reminders are
 * read with their own repositories; this one only picks meals and adds what those do not have.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toIso = (value: unknown): string => new Date(value as string | Date).toISOString();

/** The patient's meals with their start (earliest entry); cancelled meals and ones whose first entry is not food are left out. */
const MEALS_CTE = `
  meal AS (
    SELECT r.id, r.description, min(e.occurred_at) AS started_at
    FROM meal_records r
    JOIN meal_record_entries e ON e.meal_record_id = r.id AND e.patient_id = r.patient_id
    LEFT JOIN carb_entry_kinds k ON k.patient_id = r.patient_id AND k.event_id = r.anchor_event_id
    WHERE r.patient_id = $1::uuid AND r.status <> 'CANCELLED' AND COALESCE(k.kind, 'MEAL') = 'MEAL'
    GROUP BY r.id
  )`;

/**
 * A meal of the journal: described, with a reminder (an AUTO WBT reminder the macros switched off is none), or saved as
 * a meal from the Bolus tab ("Zapisz jako posiłek", migration 089).
 */
const IN_JOURNAL = `(
  nullif(btrim(m.description), '') IS NOT NULL
  OR EXISTS (SELECT 1 FROM remote_commands rc WHERE rc.patient_id = $1::uuid AND rc.meal_record_id = m.id AND rc.create_meal)
  OR EXISTS (SELECT 1 FROM meal_wbt_reminders w WHERE w.patient_id = $1::uuid AND w.meal_record_id = m.id AND (w.enabled OR w.source = 'MANUAL'))
  OR EXISTS (SELECT 1 FROM care_reminders c WHERE c.patient_id = $1::uuid AND c.meal_record_id = m.id)
  OR EXISTS (SELECT 1 FROM planned_boluses p WHERE p.patient_id = $1::uuid AND p.meal_record_id = m.id)
)`;

export interface JournalMealRow {
  meal_record_id: string;
  started_at: string;
}

export interface JournalSearchRow extends JournalMealRow {
  glucose_peak_mgdl: number | null;
  glucose_min_mgdl: number | null;
}

export class PostgresMealJournalRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * A page of the journal, newest first, started before `beforeIso` (null: from the newest) and not before `afterIso`
   * (null: no limit; the calendar's day).
   */
  async listJournalMeals(patientId: string, beforeIso: string | null, limit: number, afterIso: string | null = null, beforeId: string | null = null): Promise<JournalMealRow[]> {
    // The page's cursor is the last meal's start and id: a meal starting at the same moment is on the next page, not lost.
    const rows = (await this.pool.query(
      `WITH ${MEALS_CTE}
       SELECT m.id::text AS meal_record_id, m.started_at FROM meal m
       WHERE ($2::timestamptz IS NULL OR m.started_at < $2::timestamptz OR ($5::uuid IS NOT NULL AND m.started_at = $2::timestamptz AND m.id < $5::uuid))
         AND ($4::timestamptz IS NULL OR m.started_at >= $4::timestamptz) AND ${IN_JOURNAL}
       ORDER BY m.started_at DESC, m.id DESC
       LIMIT $3`,
      [patientId, beforeIso, limit, afterIso, beforeId],
    )).rows;
    return rows.map((row) => ({ meal_record_id: String(row.meal_record_id), started_at: toIso(row.started_at) }));
  }

  /** When the journal's meals between these instants started (the calendar's dots; the app groups them by its day). */
  async listJournalMealStarts(patientId: string, fromIso: string, untilIso: string): Promise<string[]> {
    const rows = (await this.pool.query(
      `WITH ${MEALS_CTE}
       SELECT m.started_at FROM meal m
       WHERE m.started_at >= $2::timestamptz AND m.started_at < $3::timestamptz AND ${IN_JOURNAL}
       ORDER BY m.started_at`,
      [patientId, fromIso, untilIso],
    )).rows;
    return rows.map((row) => toIso(row.started_at));
  }

  /**
   * Meals whose description contains the text, case and Polish diacritics folded (glucomind_fold_text), newest first,
   * with the highest and lowest glucose within 4 h of the start.
   */
  async searchMeals(patientId: string, pattern: string, limit: number): Promise<JournalSearchRow[]> {
    const rows = (await this.pool.query(
      `WITH ${MEALS_CTE}
       SELECT m.id::text AS meal_record_id, m.started_at, g.peak, g.low
       FROM meal m
       LEFT JOIN LATERAL (
         SELECT max(v.value) AS peak, min(v.value) AS low
         FROM (
           SELECT CASE WHEN ev.payload->>'glucose_value' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (ev.payload->>'glucose_value')::numeric END AS value
           FROM events ev
           WHERE ev.patient_id = $1::uuid AND ev.type = 'GLUCOSE_READING_AVAILABLE'
             AND ev.occurred_at >= m.started_at AND ev.occurred_at < m.started_at + make_interval(hours => $4)
         ) v
       ) g ON true
       WHERE m.description IS NOT NULL AND glucomind_fold_text(m.description) LIKE glucomind_fold_text($2) ESCAPE '\\'
       ORDER BY m.started_at DESC, m.id DESC
       LIMIT $3`,
      [patientId, pattern, limit, MEAL_JOURNAL_POLICY.search_glucose_hours],
    )).rows;
    return rows.map((row) => ({
      meal_record_id: String(row.meal_record_id),
      started_at: toIso(row.started_at),
      glucose_peak_mgdl: row.peak === null ? null : Math.round(Number(row.peak)),
      glucose_min_mgdl: row.low === null ? null : Math.round(Number(row.low)),
    }));
  }

  /**
   * Where each meal came from: the source of the command its chain of retries started with (a chat card, the Bolus
   * tab, a new meal...) and the conversation of that command or of the chat's meal change applied to it.
   */
  async mealOrigins(patientId: string, mealRecordIds: string[]): Promise<Map<string, { first_command_source: string | null; conversation_id: string | null }>> {
    const ids = mealRecordIds.filter((id) => UUID_PATTERN.test(id));
    const out = new Map<string, { first_command_source: string | null; conversation_id: string | null }>();
    if (ids.length === 0) return out;
    const [commands, actions] = await Promise.all([
      this.pool.query(
        `WITH RECURSIVE chain AS (
           SELECT rc.meal_record_id AS meal_id, rc.source, rc.conversation_id, rc.follows_command_id, rc.authorized_at, 0 AS depth
           FROM remote_commands rc
           WHERE rc.patient_id = $1::uuid AND rc.meal_record_id = ANY($2::uuid[]) AND rc.purpose IS NULL
           UNION ALL
           SELECT chain.meal_id, prev.source, prev.conversation_id, prev.follows_command_id, prev.authorized_at, chain.depth + 1
           FROM chain JOIN remote_commands prev ON prev.id = chain.follows_command_id AND prev.patient_id = $1::uuid
           WHERE chain.depth < 5
         )
         SELECT DISTINCT ON (meal_id) meal_id::text, source, conversation_id::text FROM chain ORDER BY meal_id, authorized_at`,
        [patientId, ids],
      ),
      this.pool.query(
        `SELECT DISTINCT ON (meal_record_id) meal_record_id::text, conversation_id::text
         FROM conversation_meal_actions
         WHERE patient_id = $1::uuid AND meal_record_id = ANY($2::uuid[]) AND status = 'APPLIED'
         ORDER BY meal_record_id, created_at`,
        [patientId, ids],
      ),
    ]);
    for (const row of commands.rows) out.set(String(row.meal_id), { first_command_source: row.source ?? null, conversation_id: row.conversation_id ?? null });
    for (const row of actions.rows) {
      const current = out.get(String(row.meal_record_id)) ?? { first_command_source: null, conversation_id: null };
      out.set(String(row.meal_record_id), { ...current, conversation_id: current.conversation_id ?? row.conversation_id ?? null });
    }
    return out;
  }

  /** Who sent the app's command each of these loop actions came from (null: a name not shown); others are the loop's. */
  async sendersForActions(patientId: string, loopActionIds: string[]): Promise<Map<string, string | null>> {
    const ids = loopActionIds.filter((id) => UUID_PATTERN.test(id));
    if (ids.length === 0) return new Map();
    const rows = (await this.pool.query(
      `SELECT DISTINCT ON (rc.loop_action_id) rc.loop_action_id::text AS loop_action_id,
              CASE WHEN u.display_name ~* '^(cognito:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN NULL ELSE u.display_name END AS name
       FROM remote_commands rc
       LEFT JOIN users u ON u.id = rc.user_id
       WHERE rc.patient_id = $1::uuid AND rc.loop_action_id = ANY($2::uuid[])
       ORDER BY rc.loop_action_id, rc.authorized_at DESC`,
      [patientId, ids],
    )).rows;
    return new Map(rows.map((row) => [String(row.loop_action_id), (row.name as string | null) ?? null]));
  }

  /** Who sent each action from the app, with their user (the dose-given push skips the sender's own phones). */
  async commandSendersForActions(patientId: string, loopActionIds: string[]): Promise<Map<string, { user_id: string; name: string | null }>> {
    const ids = loopActionIds.filter((id) => UUID_PATTERN.test(id));
    if (ids.length === 0) return new Map();
    const rows = (await this.pool.query(
      `SELECT DISTINCT ON (rc.loop_action_id) rc.loop_action_id::text AS loop_action_id, rc.user_id::text AS user_id,
              CASE WHEN u.display_name ~* '^(cognito:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN NULL ELSE u.display_name END AS name
       FROM remote_commands rc
       LEFT JOIN users u ON u.id = rc.user_id
       WHERE rc.patient_id = $1::uuid AND rc.loop_action_id = ANY($2::uuid[]) AND rc.user_id IS NOT NULL
       ORDER BY rc.loop_action_id, rc.authorized_at DESC`,
      [patientId, ids],
    )).rows;
    return new Map(rows.map((row) => [String(row.loop_action_id), { user_id: String(row.user_id), name: (row.name as string | null) ?? null }]));
  }

  /** The patient's caregivers ("Żaden z opiekunów…" only with more than one). */
  async caregiverCount(patientId: string): Promise<number> {
    const rows = (await this.pool.query(`SELECT count(DISTINCT user_id)::int AS count FROM caregiver_relationships WHERE patient_id = $1::uuid`, [patientId])).rows;
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Meal reminders that came since `sinceIso` and whose dose nobody was told about yet (migration 074, dose_given_at): second doses
   * (their window ends when the meal's WBT reminder came, `until`) and WBT reminders.
   */
  async remindersAwaitingDoseNews(sinceIso: string): Promise<Array<{ kind: 'SECOND_DOSE' | 'WBT'; reminder_id: string; patient_id: string; meal_record_id: string; fired_at: string; until: string | null }>> {
    const rows = (await this.pool.query(
      `SELECT 'SECOND_DOSE' AS kind, c.id::text AS reminder_id, c.patient_id::text AS patient_id, c.meal_record_id::text AS meal_record_id,
              c.fired_at, w.sent_at AS until
       FROM care_reminders c
       LEFT JOIN meal_wbt_reminders w ON w.patient_id = c.patient_id AND w.meal_record_id = c.meal_record_id AND w.status = 'SENT' AND w.sent_at > c.fired_at
       WHERE c.kind = 'SECOND_DOSE' AND c.status = 'FIRED' AND c.meal_record_id IS NOT NULL AND c.fired_at >= $1::timestamptz
         AND c.dose_given_at IS NULL
       UNION ALL
       SELECT 'WBT', 'wbt', w.patient_id::text, w.meal_record_id::text, w.sent_at, NULL
       FROM meal_wbt_reminders w
       WHERE w.status = 'SENT' AND w.sent_at >= $1::timestamptz AND w.dose_given_at IS NULL`,
      [sinceIso],
    )).rows;
    return rows.map((row) => ({
      kind: row.kind as 'SECOND_DOSE' | 'WBT',
      reminder_id: String(row.reminder_id),
      patient_id: String(row.patient_id),
      meal_record_id: String(row.meal_record_id),
      fired_at: toIso(row.fired_at),
      until: row.until ? toIso(row.until) : null,
    }));
  }

  /** The dose a reminder asked for was given at `givenAt`; false when another worker recorded it already (no second push). */
  async markDoseGiven(reminder: { kind: 'SECOND_DOSE' | 'WBT'; reminder_id: string; patient_id: string; meal_record_id: string }, givenAt: string, loopActionId: string | null = null): Promise<boolean> {
    const result = reminder.kind === 'WBT'
      ? await this.pool.query(
        `UPDATE meal_wbt_reminders SET dose_given_at = $3::timestamptz, dose_given_action_id = $4::uuid
         WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid AND dose_given_at IS NULL`,
        [reminder.patient_id, reminder.meal_record_id, givenAt, loopActionId],
      )
      : await this.pool.query(
        `UPDATE care_reminders SET dose_given_at = $3::timestamptz, dose_given_action_id = $4::uuid
         WHERE patient_id = $1::uuid AND id = $2::uuid AND dose_given_at IS NULL`,
        [reminder.patient_id, reminder.reminder_id, givenAt, loopActionId],
      );
    return (result.rowCount ?? 0) > 0;
  }

  /** The excess grams the caregivers were last told about for this meal (migration 084); 0 before any. */
  async notifiedDoseExcess(patientId: string, mealRecordId: string): Promise<number> {
    const rows = (await this.pool.query(
      `SELECT notified_excess_g FROM meal_dose_excess_notices WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid`,
      [patientId, mealRecordId],
    )).rows;
    return Number(rows[0]?.notified_excess_g ?? 0);
  }

  async setNotifiedDoseExcess(patientId: string, mealRecordId: string, grams: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO meal_dose_excess_notices (patient_id, meal_record_id, notified_excess_g) VALUES ($1::uuid, $2::uuid, $3)
       ON CONFLICT (patient_id, meal_record_id) DO UPDATE SET notified_excess_g = EXCLUDED.notified_excess_g, updated_at = now()`,
      [patientId, mealRecordId, grams],
    );
  }

  /** Loop actions that already answered one of the patient's meal reminders (migration 082): never a second one. */
  async answeredDoseActionIds(patientId: string): Promise<Set<string>> {
    const rows = (await this.pool.query(
      `SELECT dose_given_action_id::text AS id FROM care_reminders WHERE patient_id = $1::uuid AND dose_given_action_id IS NOT NULL
       UNION
       SELECT dose_given_action_id::text FROM meal_wbt_reminders WHERE patient_id = $1::uuid AND dose_given_action_id IS NOT NULL`,
      [patientId],
    )).rows;
    return new Set(rows.map((row) => String(row.id)));
  }
}
