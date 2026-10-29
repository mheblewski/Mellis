import type { Pool, PoolClient } from 'pg';
import { nextWbtReminderSchedule, WBT_REMINDER_DELAY_MINUTES, type WbtReminderSchedule, type WbtReminderStatus } from '@modules/meal-wbt/application/wbt-policy';

export interface WbtReminderRow {
  patient_id: string;
  meal_record_id: string;
  enabled: boolean;
  source: 'AUTO' | 'MANUAL';
  remind_at: string;
  status: WbtReminderStatus;
  sent_at: string | null;
  /** A split bolus's second part postponed it to no earlier than this (migration 081). */
  not_before?: string | null;
  /** STALE: skipped because the worker found it too late to send (a server outage, migration 081). */
  skip_reason?: 'STALE' | null;
  /** A caregiver gave the WBT it asked for (migration 074). */
  dose_given_at?: string | null;
}

export interface WbtSuggestionRow {
  id: string;
  meal_record_id: string;
  status: 'PENDING' | 'DONE' | 'FAILED';
  result: Record<string, unknown> | null;
  created_at: string;
}

/** A WBT dose proposed in the meal's WBT conversation (migration 072): a suggestion that remembers its answer. */
export interface WbtChatSuggestionRow extends WbtSuggestionRow {
  conversation_id: string;
  user_message_id: string;
}

const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : value ? String(value) : null);

function toReminder(row: Record<string, unknown>): WbtReminderRow {
  return {
    patient_id: String(row.patient_id),
    meal_record_id: String(row.meal_record_id),
    enabled: Boolean(row.enabled),
    source: row.source === 'MANUAL' ? 'MANUAL' : 'AUTO',
    remind_at: iso(row.remind_at) as string,
    status: (row.status as WbtReminderRow['status']) ?? 'SCHEDULED',
    sent_at: iso(row.sent_at),
    dose_given_at: iso(row.dose_given_at),
    not_before: iso(row.not_before),
    skip_reason: row.skip_reason === 'STALE' ? 'STALE' : null,
  };
}

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Writes the meal's WBT reminder as nextWbtReminderSchedule says, in the caller's transaction: the time is always 2.5 h
 * after the meal's real start (min of its entries; the given remindAt only when it has none), so every write follows a
 * meal that moved.
 */
async function writeWbtReminder(
  client: Queryable,
  patientId: string,
  mealRecordId: string,
  write: { kind: 'AUTO' | 'MANUAL'; enabled: boolean },
  remindAtIso: string,
  userId: string | null,
  now: Date,
): Promise<void> {
  const startedAt = (await mealStartsAt(client, patientId, [mealRecordId])).get(mealRecordId)
    ?? new Date(Date.parse(remindAtIso) - WBT_REMINDER_DELAY_MINUTES * 60_000).toISOString();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const row = (await client.query(
      `SELECT * FROM meal_wbt_reminders WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid FOR UPDATE`,
      [patientId, mealRecordId],
    )).rows[0];
    const current = row ? toReminder(row) : null;
    const next = nextWbtReminderSchedule(current ? scheduleOf(current) : null, { ...write, meal_started_at: startedAt }, now);
    if (!next) return;
    if (!current) {
      const inserted = await client.query(
        `
          INSERT INTO meal_wbt_reminders (patient_id, meal_record_id, enabled, source, remind_at, status, set_by_user_id)
          VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6, $7::uuid)
          ON CONFLICT (patient_id, meal_record_id) DO NOTHING
        `,
        [patientId, mealRecordId, next.enabled, next.source, next.remind_at, next.status, write.kind === 'MANUAL' ? userId : null],
      );
      // Another write made it first: read it and apply this one over it.
      if ((inserted.rowCount ?? 0) > 0) return;
      continue;
    }
    await updateIfChanged(client, current, next, write.kind === 'MANUAL' ? userId : undefined);
    return;
  }
}

async function updateIfChanged(client: Queryable, current: WbtReminderRow, next: NonNullable<ReturnType<typeof nextWbtReminderSchedule>>, userId?: string | null): Promise<void> {
  const same = current.enabled === next.enabled && current.source === next.source && current.status === next.status
    && Date.parse(current.remind_at) === Date.parse(next.remind_at) && userId === undefined;
  // No write when nothing changed: every update is a live event for the phones.
  if (same) return;
  await client.query(
    `
      UPDATE meal_wbt_reminders
      SET enabled = $3, source = $4, remind_at = $5::timestamptz, status = $6,
          set_by_user_id = CASE WHEN $7::boolean THEN $8::uuid ELSE set_by_user_id END, updated_at = now()
      WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid
    `,
    [current.patient_id, current.meal_record_id, next.enabled, next.source, next.remind_at, next.status, userId !== undefined, userId ?? null],
  );
}

function scheduleOf(row: WbtReminderRow): WbtReminderSchedule {
  return { enabled: row.enabled, source: row.source, remind_at: row.remind_at, status: row.status, not_before: row.not_before ?? null };
}

async function mealStartsAt(client: Queryable, patientId: string, mealRecordIds: string[]): Promise<Map<string, string>> {
  const result = await client.query(
    `SELECT meal_record_id::text AS meal_record_id, min(occurred_at) AS started_at FROM meal_record_entries
     WHERE patient_id = $1::uuid AND meal_record_id = ANY($2::uuid[]) GROUP BY meal_record_id`,
    [patientId, mealRecordIds],
  );
  return new Map(result.rows.map((row) => [String(row.meal_record_id), iso(row.started_at) as string]));
}

/**
 * Entries joined or left these meals (an earlier entry added, one detached): their open WBT reminders follow the new
 * start, in the caller's transaction (audit 2026-10-26). A meal that is gone or has no reminder is left alone.
 */
export async function followWbtRemindersToMealStart(client: Queryable, patientId: string, mealRecordIds: Array<string | null | undefined>, now = new Date()): Promise<void> {
  const ids = [...new Set(mealRecordIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return;
  const starts = await mealStartsAt(client, patientId, ids);
  if (starts.size === 0) return;
  const rows = (await client.query(
    `SELECT * FROM meal_wbt_reminders WHERE patient_id = $1::uuid AND meal_record_id = ANY($2::uuid[]) AND status IN ('SCHEDULED', 'MISSED') FOR UPDATE`,
    [patientId, [...starts.keys()]],
  )).rows.map(toReminder);
  for (const current of rows) {
    const next = nextWbtReminderSchedule(scheduleOf(current), { kind: 'MEAL_MOVED', meal_started_at: starts.get(current.meal_record_id)! }, now);
    if (next) await updateIfChanged(client, current, next);
  }
}

export class PostgresMealWbtRepository {
  constructor(private readonly pool: Pool) {}

  private async inTransaction(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await work(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getReminder(patientId: string, mealRecordId: string): Promise<WbtReminderRow | null> {
    const result = await this.pool.query(
      `SELECT * FROM meal_wbt_reminders WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid`,
      [patientId, mealRecordId],
    );
    return result.rows[0] ? toReminder(result.rows[0]) : null;
  }

  /** The WBT reminders of these meals (the Meals tab's journal reads a page at once). */
  async listRemindersForMeals(patientId: string, mealRecordIds: string[]): Promise<WbtReminderRow[]> {
    if (mealRecordIds.length === 0) return [];
    const result = await this.pool.query(
      `SELECT * FROM meal_wbt_reminders WHERE patient_id = $1::uuid AND meal_record_id = ANY($2::uuid[])`,
      [patientId, mealRecordIds],
    );
    return result.rows.map(toReminder);
  }

  /** AUTO decision from the macros; never overrides a caregiver's MANUAL choice (the time still follows the meal). */
  async setAutoReminder(args: { patientId: string; mealRecordId: string; enabled: boolean; remindAt: string; now?: Date }): Promise<void> {
    await this.inTransaction((client) => writeWbtReminder(client, args.patientId, args.mealRecordId, { kind: 'AUTO', enabled: args.enabled }, args.remindAt, null, args.now ?? new Date()));
  }

  async setManualReminder(args: { patientId: string; mealRecordId: string; enabled: boolean; remindAt: string; userId: string; now?: Date }): Promise<void> {
    await this.inTransaction((client) => writeWbtReminder(client, args.patientId, args.mealRecordId, { kind: 'MANUAL', enabled: args.enabled }, args.remindAt, args.userId, args.now ?? new Date()));
  }

  /**
   * Moves a scheduled reminder to no earlier than notBefore (a split bolus's second part was just given, or is still
   * open). The floor is kept (not_before, migration 081), so a later write that follows the meal never undoes it.
   */
  async postponeReminder(patientId: string, mealRecordId: string, notBeforeIso: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE meal_wbt_reminders
        SET not_before = GREATEST(COALESCE(not_before, $3::timestamptz), $3::timestamptz),
            remind_at = GREATEST(remind_at, $3::timestamptz), updated_at = now()
        WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid AND status = 'SCHEDULED'
          AND (remind_at < $3::timestamptz OR not_before IS NULL OR not_before < $3::timestamptz)
      `,
      [patientId, mealRecordId, notBeforeIso],
    );
  }

  /** Enabled reminders due now and not older than maxAgeMinutes (an older one is no longer useful). */
  async listDueReminders(nowIso: string, maxAgeMinutes: number): Promise<WbtReminderRow[]> {
    const result = await this.pool.query(
      `
        SELECT * FROM meal_wbt_reminders
        WHERE enabled AND status = 'SCHEDULED'
          AND remind_at <= $1::timestamptz
          AND remind_at > $1::timestamptz - make_interval(mins => $2)
        ORDER BY remind_at
        LIMIT 20
      `,
      [nowIso, maxAgeMinutes],
    );
    return result.rows.map(toReminder);
  }

  /** Expires due reminders that were never sent in time (the worker was down), so they never fire late. */
  async skipStaleReminders(nowIso: string, maxAgeMinutes: number): Promise<number> {
    const result = await this.pool.query(
      `
        UPDATE meal_wbt_reminders SET status = 'SKIPPED', skip_reason = 'STALE', updated_at = now()
        WHERE enabled AND status = 'SCHEDULED' AND remind_at <= $1::timestamptz - make_interval(mins => $2)
      `,
      [nowIso, maxAgeMinutes],
    );
    return result.rowCount ?? 0;
  }

  /** Claims a due reminder for sending; false when another worker took it or it changed. */
  async markReminder(patientId: string, mealRecordId: string, status: 'SENT' | 'SKIPPED'): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE meal_wbt_reminders
        SET status = $3, sent_at = CASE WHEN $3 = 'SENT' THEN now() ELSE sent_at END, updated_at = now()
        WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid AND status = 'SCHEDULED'
      `,
      [patientId, mealRecordId, status],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * A new suggestion unless one is already pending for the meal (two caregivers tapping at once get one AI call): the
   * meal's lock serialises the check and the insert. created false: the pending one's id.
   */
  async createSuggestionIfNonePending(patientId: string, mealRecordId: string, userId: string): Promise<{ id: string; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('meal_wbt_suggestion:' || $1::text))`, [mealRecordId]);
      const pending = (await client.query<{ id: string }>(
        `SELECT id::text FROM meal_wbt_suggestions WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
        [patientId, mealRecordId],
      )).rows[0];
      const id = pending?.id ?? (await client.query<{ id: string }>(
        `INSERT INTO meal_wbt_suggestions (patient_id, meal_record_id, requested_by_user_id) VALUES ($1::uuid, $2::uuid, $3::uuid) RETURNING id::text`,
        [patientId, mealRecordId, userId],
      )).rows[0].id;
      await client.query('COMMIT');
      return { id, created: !pending };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async createSuggestion(patientId: string, mealRecordId: string, userId: string): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO meal_wbt_suggestions (patient_id, meal_record_id, requested_by_user_id) VALUES ($1::uuid, $2::uuid, $3::uuid) RETURNING id::text`,
      [patientId, mealRecordId, userId],
    );
    return result.rows[0].id;
  }

  async getLatestSuggestion(patientId: string, mealRecordId: string): Promise<WbtSuggestionRow | null> {
    const result = await this.pool.query(
      `SELECT id::text, meal_record_id::text, status, result, created_at FROM meal_wbt_suggestions
       WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid ORDER BY created_at DESC LIMIT 1`,
      [patientId, mealRecordId],
    );
    const row = result.rows[0];
    return row ? { id: row.id, meal_record_id: row.meal_record_id, status: row.status, result: row.result, created_at: iso(row.created_at) as string } : null;
  }

  async getSuggestion(suggestionId: string): Promise<(WbtSuggestionRow & { patient_id: string }) | null> {
    const result = await this.pool.query(
      `SELECT id::text, patient_id::text, meal_record_id::text, status, result, created_at FROM meal_wbt_suggestions WHERE id = $1::uuid`,
      [suggestionId],
    );
    const row = result.rows[0];
    return row ? { id: row.id, patient_id: row.patient_id, meal_record_id: row.meal_record_id, status: row.status, result: row.result, created_at: iso(row.created_at) as string } : null;
  }

  /**
   * The meal's WBT conversation (wbt-chat.v1), created on first use; a deleted one gives way to a new one. Null before
   * migration 072.
   */
  async getOrCreateWbtConversation(patientId: string, mealRecordId: string, title: string): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // One conversation per meal even when both caregivers open it at once.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('wbt-conversation:' || $1::text))`, [mealRecordId]);
      const existing = (await client.query(
        `SELECT id::text, deleted_at FROM conversations WHERE patient_id = $1::uuid AND wbt_meal_record_id = $2::uuid`,
        [patientId, mealRecordId],
      )).rows[0];
      if (existing && !existing.deleted_at) {
        await client.query('COMMIT');
        return String(existing.id);
      }
      if (existing) {
        await client.query(`UPDATE conversations SET wbt_meal_record_id = NULL WHERE id = $1::uuid`, [existing.id]);
      }
      const created = (await client.query(
        `
          INSERT INTO conversations (patient_id, episode_id, origin, trigger_type, thread_state_version, awaiting_user_answer, conversation_type, title, title_source, title_updated_at, wbt_meal_record_id)
          VALUES ($1::uuid, NULL, 'USER', 'MEAL_WBT', 'conv-v1', false, 'USER_INITIATED', $3, 'SYSTEM', now(), $2::uuid)
          RETURNING id::text
        `,
        [patientId, mealRecordId, title],
      )).rows[0];
      await client.query('COMMIT');
      return String(created.id);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** A dose the chat proposed: DONE at once, so the WBT screen shows it as the newest suggestion. */
  async insertChatSuggestion(args: { patientId: string; mealRecordId: string; conversationId: string; userMessageId: string; result: Record<string, unknown> }): Promise<WbtChatSuggestionRow> {
    const row = (await this.pool.query(
      `
        INSERT INTO meal_wbt_suggestions (patient_id, meal_record_id, status, result, conversation_id, user_message_id)
        VALUES ($1::uuid, $2::uuid, 'DONE', $3::jsonb, $4::uuid, $5::uuid)
        RETURNING id::text, meal_record_id::text, status, result, created_at, conversation_id::text, user_message_id::text
      `,
      [args.patientId, args.mealRecordId, JSON.stringify(args.result), args.conversationId, args.userMessageId],
    )).rows[0];
    return toChatSuggestion(row);
  }

  async listChatSuggestions(patientId: string, conversationId: string): Promise<WbtChatSuggestionRow[]> {
    const result = await this.pool.query(
      `
        SELECT id::text, meal_record_id::text, status, result, created_at, conversation_id::text, user_message_id::text
        FROM meal_wbt_suggestions
        WHERE patient_id = $1::uuid AND conversation_id = $2::uuid
        ORDER BY created_at
      `,
      [patientId, conversationId],
    );
    return result.rows.map(toChatSuggestion);
  }

  /** A new AI call answers the message anew: doses an earlier failed run proposed for it are taken back. */
  async discardChatSuggestionsForUserMessage(patientId: string, userMessageId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM meal_wbt_suggestions WHERE patient_id = $1::uuid AND user_message_id = $2::uuid`,
      [patientId, userMessageId],
    );
  }

  async completeSuggestion(suggestionId: string, status: 'DONE' | 'FAILED', result: Record<string, unknown> | null): Promise<void> {
    await this.pool.query(
      `UPDATE meal_wbt_suggestions SET status = $2, result = $3::jsonb, updated_at = now() WHERE id = $1::uuid AND status = 'PENDING'`,
      [suggestionId, status, result ? JSON.stringify(result) : null],
    );
  }
}

function toChatSuggestion(row: Record<string, unknown>): WbtChatSuggestionRow {
  return {
    id: String(row.id),
    meal_record_id: String(row.meal_record_id),
    status: row.status as WbtSuggestionRow['status'],
    result: (row.result as Record<string, unknown> | null) ?? null,
    created_at: iso(row.created_at) as string,
    conversation_id: String(row.conversation_id),
    user_message_id: String(row.user_message_id),
  };
}
