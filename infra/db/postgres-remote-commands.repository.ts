import type { Pool, PoolClient } from 'pg';
import { ConflictError } from '@shared/errors/app-error';
import { REMOTE_COMMAND_POLICY } from '@modules/remote-commands/application/remote-command-policy';
import type { NewRemoteCommand, RemoteCommandRecord, RemoteCommandStore } from '@modules/remote-commands/application/remote-command-record';
import { readSplitPlan } from '@modules/remote-commands/application/split-bolus';
import { readBolusReminders } from '@modules/remote-commands/application/bolus-reminders';
import { canTransitionRemoteCommand, type RemoteCommandStatus } from '@modules/remote-commands/application/remote-command-status';

/**
 * PostgreSQL storage of remote commands (migration 046). The partial unique index keeps one command of a patient in
 * flight; deadlines are applied before every in-flight read, so a command the phone never sent (EXPIRED) or Trio never
 * answered (NO_REPLY) does not block the next one forever.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toIso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string | Date).toISOString());
/**
 * Orders a card's commands so one that never left (a failed or expired send) comes after the others: only refused ones
 * can precede it (the unique indexes allow nothing else), and the card must keep offering their retry.
 */
export const UNSENT_LAST = `(status IN ('SEND_FAILED', 'EXPIRED'))`;
const num = (value: unknown): number | null => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));

/** The command's loop in the genitive ("do Loopa", "z Trio"), from the loop system stored in its context. */
const LOOP_GENITIVE_SQL = `CASE context->>'loop_system' WHEN 'LOOP' THEN 'Loopa' ELSE 'Trio' END`;

export class PostgresRemoteCommandRepository implements RemoteCommandStore {
  constructor(private readonly pool: Pool) {}

  async insert(command: NewRemoteCommand): Promise<RemoteCommandRecord> {
    try {
      const row = (await this.pool.query(
        `INSERT INTO remote_commands (
           patient_id, user_id, device_id, source, conversation_id, proposal_id, carbs_g, insulin_u, bolus_step,
           icr_g_per_u, icr_insulin_u, meal_payload, context, warnings, policy_version, send_deadline, follows_command_id,
           purpose, target_meal_record_id, planned_bolus_id, split_plan, rescue_alert_id, rescue_proposal_id, reminders, create_meal
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16::timestamptz, $17::uuid, $18, $19::uuid, $20::uuid, $21::jsonb, $22::uuid, $23::uuid, $24::jsonb, $25)
         RETURNING *`,
        [
          command.patient_id,
          command.user_id,
          command.device_id,
          command.source,
          command.conversation_id,
          command.proposal_id,
          command.carbs_g,
          command.insulin_u,
          command.bolus_step,
          command.icr_g_per_u,
          command.icr_insulin_u,
          command.meal_payload === null ? null : JSON.stringify(command.meal_payload),
          JSON.stringify(command.context),
          JSON.stringify(command.warnings),
          command.policy_version,
          command.send_deadline,
          command.follows_command_id,
          command.purpose,
          command.target_meal_record_id,
          command.planned_bolus_id,
          command.split_plan === null ? null : JSON.stringify(command.split_plan),
          command.rescue_alert_id ?? null,
          command.rescue_proposal_id ?? null,
          command.reminders && command.reminders.length > 0 ? JSON.stringify(command.reminders) : null,
          command.create_meal === true,
        ],
      )).rows[0];
      return toRecord(row);
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === '23505' && failure.constraint === 'remote_commands_one_per_proposal_idx') {
        throw new ConflictError('PROPOSAL_ALREADY_SENT: this proposal was already sent');
      }
      if (failure.code === '23505' && failure.constraint === 'remote_commands_one_per_planned_bolus_idx') {
        throw new ConflictError('PLANNED_BOLUS_ALREADY_SENT: Tę część bolusa już wysłano.');
      }
      if (failure.code === '23505') {
        throw new ConflictError('COMMAND_IN_FLIGHT: another command is waiting for Trio');
      }
      throw error;
    }
  }

  async get(patientId: string, commandId: string): Promise<RemoteCommandRecord | null> {
    if (!UUID_PATTERN.test(commandId)) return null;
    const row = (await this.pool.query(`SELECT * FROM remote_commands WHERE patient_id = $1::uuid AND id = $2::uuid`, [patientId, commandId])).rows[0];
    return row ? toRecord(row) : null;
  }

  async list(patientId: string, limit: number): Promise<RemoteCommandRecord[]> {
    const rows = (await this.pool.query(
      `SELECT * FROM remote_commands WHERE patient_id = $1::uuid ORDER BY authorized_at DESC LIMIT $2`,
      [patientId, Math.max(1, Math.min(100, Math.trunc(limit) || 20))],
    )).rows;
    return rows.map(toRecord);
  }

  async findInFlight(patientId: string, nowIso: string): Promise<RemoteCommandRecord | null> {
    await this.applyDeadlines(nowIso, patientId);
    const row = (await this.pool.query(
      `SELECT * FROM remote_commands WHERE patient_id = $1::uuid AND status IN ('AUTHORIZED', 'SENT', 'TRIO_ACCEPTED') LIMIT 1`,
      [patientId],
    )).rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * AUTHORIZED with no report a while after its send deadline → NO_REPLY: the push may have left even though the phone
   * never reported it (a lost "sent" report must never free the card for a second dose). SENT / TRIO_ACCEPTED without a
   * final answer within the reply timeout → NO_REPLY. Returns the commands that became NO_REPLY.
   */
  async applyDeadlines(nowIso: string, patientId?: string): Promise<RemoteCommandRecord[]> {
    const unreported = (await this.pool.query(
      `UPDATE remote_commands
       SET status = 'NO_REPLY',
           status_message = 'Nie wiadomo, czy polecenie dotarło do ' || ${LOOP_GENITIVE_SQL} || '. Nie wysyłaj ponownie: sprawdź telefon pacjenta lub Nightscout.',
           updated_at = now()
       WHERE status = 'AUTHORIZED'
         AND send_deadline < $1::timestamptz - make_interval(secs => $3)
         AND ($2::uuid IS NULL OR patient_id = $2::uuid)
       RETURNING *`,
      [nowIso, patientId ?? null, REMOTE_COMMAND_POLICY.unreported_grace_seconds],
    )).rows;
    const rows = (await this.pool.query(
      `UPDATE remote_commands
       SET status = 'NO_REPLY',
           status_message = 'Brak odpowiedzi z ' || ${LOOP_GENITIVE_SQL} || '. Nie wysyłaj ponownie: sprawdź telefon pacjenta lub Nightscout.',
           updated_at = now()
       WHERE status IN ('SENT', 'TRIO_ACCEPTED')
         AND sent_at < $1::timestamptz - make_interval(mins => $3)
         AND ($2::uuid IS NULL OR patient_id = $2::uuid)
       RETURNING *`,
      [nowIso, patientId ?? null, REMOTE_COMMAND_POLICY.reply_timeout_minutes],
    )).rows;
    return [...unreported, ...rows].map(toRecord);
  }

  /** A "sent" report that arrived after the command already went NO_REPLY: only the time is kept. */
  async recordSentAt(patientId: string, commandId: string, sentAtIso: string): Promise<void> {
    if (!UUID_PATTERN.test(commandId)) return;
    await this.pool.query(
      `UPDATE remote_commands SET sent_at = COALESCE(sent_at, $3::timestamptz), updated_at = now() WHERE patient_id = $1::uuid AND id = $2::uuid`,
      [patientId, commandId, sentAtIso],
    );
  }

  /**
   * One nightscout.sync job per Nightscout source of the patient and time; the dedupe key keeps a second answer of
   * the same command (accepted, then bolus started) from queueing them again. Jobs wake the worker (glucomind_jobs).
   */
  async requestNightscoutSync(patientId: string, commandId: string, atIsos: string[]): Promise<void> {
    if (!UUID_PATTERN.test(commandId) || atIsos.length === 0) return;
    await this.pool.query(
      `INSERT INTO jobs (job_type, status, payload_version, payload, dedupe_key, correlation_id, causation_id, patient_id, available_at, max_attempts)
       SELECT 'nightscout.sync', 'queued', 1,
              jsonb_build_object('source_id', s.id, 'remote_command_id', $2::text),
              'nightscout.sync:remote-command:' || $2::text || ':' || s.id || ':' || at.n,
              s.id, $2::uuid, s.patient_id, at.available_at, 2
       FROM sources s
       CROSS JOIN unnest($3::timestamptz[]) WITH ORDINALITY AS at(available_at, n)
       WHERE s.patient_id = $1::uuid AND s.source_system = 'NIGHTSCOUT'
       ON CONFLICT (job_type, dedupe_key) DO NOTHING`,
      [patientId, commandId, atIsos],
    );
  }

  /**
   * The commands that created a meal and their retries (also retries not linked to the meal yet); a planned second part
   * has its own card. A Bolus tab command belongs to the meal its loop action was assigned to by the caregiver.
   */
  async listForMeal(patientId: string, mealRef: string): Promise<RemoteCommandRecord[]> {
    const rows = (await this.pool.query(
      `WITH RECURSIVE chain AS (
         SELECT rc.* FROM remote_commands rc
         LEFT JOIN loop_actions la ON la.id = rc.loop_action_id AND la.patient_id = rc.patient_id
         JOIN meal_records m ON m.id = COALESCE(rc.meal_record_id, la.meal_record_id)
         WHERE rc.patient_id = $1::uuid AND (m.id::text = $2 OR m.meal_identity = $2) AND rc.purpose IS DISTINCT FROM 'MEAL_PART'
         UNION
         SELECT next.* FROM remote_commands next JOIN chain ON next.follows_command_id = chain.id WHERE next.purpose IS DISTINCT FROM 'MEAL_PART'
       )
       SELECT * FROM chain ORDER BY authorized_at`,
      [patientId, mealRef],
    )).rows;
    return rows.map(toRecord);
  }

  async listForProposal(patientId: string, proposalId: string): Promise<RemoteCommandRecord[]> {
    if (!UUID_PATTERN.test(proposalId)) return [];
    const rows = (await this.pool.query(
      `SELECT * FROM remote_commands WHERE patient_id = $1::uuid AND proposal_id = $2::uuid ORDER BY authorized_at`,
      [patientId, proposalId],
    )).rows;
    return rows.map(toRecord);
  }

  async listForPlannedBolus(patientId: string, plannedBolusId: string): Promise<RemoteCommandRecord[]> {
    if (!UUID_PATTERN.test(plannedBolusId)) return [];
    const rows = (await this.pool.query(
      `SELECT * FROM remote_commands WHERE patient_id = $1::uuid AND planned_bolus_id = $2::uuid ORDER BY authorized_at`,
      [patientId, plannedBolusId],
    )).rows;
    return rows.map(toRecord);
  }

  async listWbtForMeal(patientId: string, mealRecordId: string): Promise<RemoteCommandRecord[]> {
    if (!UUID_PATTERN.test(mealRecordId)) return [];
    const rows = (await this.pool.query(
      `SELECT * FROM remote_commands WHERE patient_id = $1::uuid AND purpose = 'WBT' AND target_meal_record_id = $2::uuid ORDER BY authorized_at`,
      [patientId, mealRecordId],
    )).rows;
    return rows.map(toRecord);
  }

  /** Boluses Trio confirmed for these loop actions (the newest per action): the bolus may not be in Nightscout yet. */
  async confirmedBolusesForActions(patientId: string, loopActionIds: string[]): Promise<Map<string, { units: number; confirmed_at: string }>> {
    const ids = loopActionIds.filter((id) => UUID_PATTERN.test(id));
    if (ids.length === 0) return new Map();
    const rows = (await this.pool.query(
      `SELECT DISTINCT ON (loop_action_id) loop_action_id, insulin_u, COALESCE(answered_at, sent_at, authorized_at) AS confirmed_at
       FROM remote_commands
       WHERE patient_id = $1::uuid AND loop_action_id = ANY($2::uuid[]) AND status = 'SUCCEEDED' AND insulin_u > 0
       ORDER BY loop_action_id, authorized_at DESC`,
      [patientId, ids],
    )).rows;
    return new Map(rows.map((row) => [String(row.loop_action_id), { units: Number(row.insulin_u), confirmed_at: toIso(row.confirmed_at) as string }]));
  }

  /**
   * The newest command for a planned second part of a split bolus (a failed or refused one too: the card decides). A
   * send that failed after a refusal leaves the refusal shown: the card offers its retry, not the whole part again.
   */
  async latestForPlannedBolus(patientId: string, plannedBolusId: string): Promise<RemoteCommandRecord | null> {
    if (!UUID_PATTERN.test(plannedBolusId)) return null;
    const row = (await this.pool.query(
      `SELECT * FROM remote_commands WHERE patient_id = $1::uuid AND planned_bolus_id = $2::uuid
       ORDER BY ${UNSENT_LAST}, authorized_at DESC LIMIT 1`,
      [patientId, plannedBolusId],
    )).rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * The newest WBT command sent from a meal's WBT window (a failed send or an expired one too: the window decides); a
   * send that failed after a refusal leaves the refusal shown.
   */
  async latestWbtForMeal(patientId: string, mealRecordId: string): Promise<RemoteCommandRecord | null> {
    if (!UUID_PATTERN.test(mealRecordId)) return null;
    const row = (await this.pool.query(
      `SELECT * FROM remote_commands WHERE patient_id = $1::uuid AND purpose = 'WBT' AND target_meal_record_id = $2::uuid
       ORDER BY ${UNSENT_LAST}, authorized_at DESC LIMIT 1`,
      [patientId, mealRecordId],
    )).rows[0];
    return row ? toRecord(row) : null;
  }

  /** The newest command with insulin that may have reached Trio (sent, accepted, given or unanswered) since a time. */
  async findRecentWithInsulin(patientId: string, sinceIso: string): Promise<RemoteCommandRecord | null> {
    const row = (await this.pool.query(
      `SELECT * FROM remote_commands
       WHERE patient_id = $1::uuid AND insulin_u > 0
         AND status IN ('SENT', 'TRIO_ACCEPTED', 'SUCCEEDED', 'NO_REPLY')
         AND COALESCE(sent_at, authorized_at) >= $2::timestamptz
       ORDER BY COALESCE(sent_at, authorized_at) DESC LIMIT 1`,
      [patientId, sinceIso],
    )).rows[0];
    return row ? toRecord(row) : null;
  }

  /** Commands with carbs and insulin authorized since a time (dose-calculator.v1: the same meal sent twice), newest first. */
  async listRecentMealBoluses(patientId: string, sinceIso: string): Promise<RemoteCommandRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM remote_commands
       WHERE patient_id = $1::uuid AND carbs_g > 0 AND insulin_u > 0
         AND authorized_at >= $2::timestamptz
       ORDER BY authorized_at DESC LIMIT 20`,
      [patientId, sinceIso],
    );
    return result.rows.map(toRecord);
  }

  /** Every command authorized since a time, newest first (dose-calculator.v1: recent remote boluses, own meal carbs). */
  async listRecent(patientId: string, sinceIso: string): Promise<RemoteCommandRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM remote_commands
       WHERE patient_id = $1::uuid AND authorized_at >= $2::timestamptz
       ORDER BY authorized_at DESC LIMIT 50`,
      [patientId, sinceIso],
    );
    return result.rows.map(toRecord);
  }

  async transition(
    patientId: string,
    commandId: string,
    to: RemoteCommandStatus,
    fields: { trio_message?: string | null; status_message?: string | null; sent_at?: string; answered_at?: string },
  ): Promise<RemoteCommandRecord | null> {
    if (!UUID_PATTERN.test(commandId)) return null;
    return this.inTransaction(async (client) => {
      const current = (await client.query(`SELECT * FROM remote_commands WHERE patient_id = $1::uuid AND id = $2::uuid FOR UPDATE`, [patientId, commandId])).rows[0];
      if (!current || !canTransitionRemoteCommand(current.status as RemoteCommandStatus, to)) return null;
      const row = (await client.query(
        `UPDATE remote_commands
         SET status = $3,
             trio_message = CASE WHEN $4::boolean THEN $5 ELSE trio_message END,
             status_message = CASE WHEN $6::boolean THEN $7 ELSE status_message END,
             -- Trio's answer before the phone's "sent" report: the command did leave.
             sent_at = COALESCE($8::timestamptz, sent_at, CASE WHEN $3 IN ('TRIO_ACCEPTED', 'SUCCEEDED', 'PARTIAL', 'REJECTED') THEN now() END),
             answered_at = COALESCE($9::timestamptz, answered_at),
             updated_at = now()
         WHERE patient_id = $1::uuid AND id = $2::uuid
         RETURNING *`,
        [
          patientId,
          commandId,
          to,
          fields.trio_message !== undefined,
          fields.trio_message ?? null,
          fields.status_message !== undefined,
          fields.status_message ?? null,
          fields.sent_at ?? null,
          fields.answered_at ?? null,
        ],
      )).rows[0];
      return toRecord(row);
    });
  }

  /** Commands that reached (or may have reached) Trio and are not linked to the loop's entries yet. */
  async listUnmatched(patientId: string, sinceIso: string): Promise<RemoteCommandRecord[]> {
    const rows = (await this.pool.query(
      `SELECT rc.*, bp.purpose AS card_purpose FROM remote_commands rc
       LEFT JOIN bolus_proposals bp ON bp.id = rc.proposal_id
       WHERE rc.patient_id = $1::uuid AND rc.loop_action_id IS NULL
         AND rc.status IN ('SENT', 'TRIO_ACCEPTED', 'SUCCEEDED', 'PARTIAL', 'NO_REPLY')
         AND rc.authorized_at >= $2::timestamptz
       ORDER BY rc.authorized_at`,
      [patientId, sinceIso],
    )).rows;
    return rows.map(toRecord);
  }

  async listMatchedWithInsulinSince(sinceIso: string): Promise<RemoteCommandRecord[]> {
    const rows = (await this.pool.query(
      `SELECT * FROM remote_commands
       WHERE loop_action_id IS NOT NULL AND insulin_u > 0 AND status IN ('SUCCEEDED', 'TRIO_ACCEPTED', 'NO_REPLY', 'SENT')
         AND authorized_at >= $1::timestamptz
       ORDER BY authorized_at`,
      [sinceIso],
    )).rows;
    return rows.map(toRecord);
  }

  async listPatientsWithUnmatched(sinceIso: string): Promise<string[]> {
    const rows = (await this.pool.query<{ patient_id: string }>(
      `SELECT DISTINCT patient_id::text FROM remote_commands
       WHERE loop_action_id IS NULL AND status IN ('SENT', 'TRIO_ACCEPTED', 'SUCCEEDED', 'PARTIAL', 'NO_REPLY') AND authorized_at >= $1::timestamptz`,
      [sinceIso],
    )).rows;
    return rows.map((row) => row.patient_id);
  }

  /**
   * Links the command to the loop's entries. A command still waiting for Trio's answer is settled by Nightscout: the
   * bolus it asked for is there (SUCCEEDED) or only its carbs are (PARTIAL).
   */
  async markMatched(patientId: string, commandId: string, match: { loop_action_id: string; meal_record_id: string | null; settled_status: RemoteCommandStatus | null; status_message: string | null }): Promise<void> {
    await this.inTransaction(async (client) => {
      const current = (await client.query(`SELECT status FROM remote_commands WHERE patient_id = $1::uuid AND id = $2::uuid FOR UPDATE`, [patientId, commandId])).rows[0];
      if (!current) return;
      const settle = match.settled_status !== null && canTransitionRemoteCommand(current.status as RemoteCommandStatus, match.settled_status);
      await client.query(
        `UPDATE remote_commands
         SET loop_action_id = $3::uuid, meal_record_id = $4::uuid, matched_at = now(),
             status = CASE WHEN $5::boolean THEN $6 ELSE status END,
             status_message = CASE WHEN $5::boolean THEN $7 ELSE status_message END,
             answered_at = CASE WHEN $5::boolean THEN COALESCE(answered_at, now()) ELSE answered_at END,
             updated_at = now()
         WHERE patient_id = $1::uuid AND id = $2::uuid`,
        [patientId, commandId, match.loop_action_id, match.meal_record_id, settle, match.settled_status, match.status_message],
      );
    });
  }

  /** The note in the meal's own chat that the meal was given from GlucoMind (once per command). */
  async addMealNote(command: Pick<RemoteCommandRecord, 'id' | 'patient_id' | 'user_id' | 'conversation_id'>, mealRecordId: string, content: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO meal_chat_messages (patient_id, meal_record_id, role, content, author_user_id, idempotency_key, origin_conversation_id)
       VALUES ($1::uuid, $2::uuid, 'ASSISTANT', $3, $4::uuid, $5, $6::uuid)
       ON CONFLICT (meal_record_id, idempotency_key) DO NOTHING`,
      [command.patient_id, mealRecordId, content.slice(0, 2000), command.user_id, `remote-command:${command.id}`, command.conversation_id],
    );
  }

  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function toRecord(row: Record<string, unknown>): RemoteCommandRecord {
  return {
    id: String(row.id),
    patient_id: String(row.patient_id),
    user_id: String(row.user_id),
    device_id: String(row.device_id),
    source: row.source as RemoteCommandRecord['source'],
    conversation_id: row.conversation_id ? String(row.conversation_id) : null,
    proposal_id: row.proposal_id ? String(row.proposal_id) : null,
    follows_command_id: row.follows_command_id ? String(row.follows_command_id) : null,
    purpose: row.purpose === 'WBT' || row.purpose === 'MEAL_PART' || row.purpose === 'HYPO_TREATMENT' ? row.purpose : null,
    rescue_alert_id: row.rescue_alert_id ? String(row.rescue_alert_id) : null,
    rescue_proposal_id: row.rescue_proposal_id ? String(row.rescue_proposal_id) : null,
    target_meal_record_id: row.target_meal_record_id ? String(row.target_meal_record_id) : null,
    planned_bolus_id: row.planned_bolus_id ? String(row.planned_bolus_id) : null,
    split_plan: readSplitPlan(row.split_plan ?? null),
    carbs_g: Number(row.carbs_g),
    insulin_u: Number(row.insulin_u),
    bolus_step: Number(row.bolus_step),
    icr_g_per_u: num(row.icr_g_per_u),
    icr_insulin_u: num(row.icr_insulin_u),
    meal_payload: (row.meal_payload ?? null) as RemoteCommandRecord['meal_payload'],
    reminders: readBolusReminders(row.reminders ?? null),
    create_meal: row.create_meal === true,
    context: row.context as RemoteCommandRecord['context'],
    warnings: (row.warnings ?? []) as RemoteCommandRecord['warnings'],
    policy_version: String(row.policy_version),
    status: row.status as RemoteCommandStatus,
    trio_message: (row.trio_message as string | null) ?? null,
    status_message: (row.status_message as string | null) ?? null,
    authorized_at: toIso(row.authorized_at) as string,
    send_deadline: toIso(row.send_deadline) as string,
    sent_at: toIso(row.sent_at),
    answered_at: toIso(row.answered_at),
    loop_action_id: row.loop_action_id ? String(row.loop_action_id) : null,
    meal_record_id: row.meal_record_id ? String(row.meal_record_id) : null,
    matched_at: toIso(row.matched_at),
    ...(row.card_purpose !== undefined ? { card_purpose: (row.card_purpose as string | null) ?? null } : {}),
  };
}
