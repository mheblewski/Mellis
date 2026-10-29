import type { Pool, PoolClient } from 'pg';
import { ConflictError, NotFoundError } from '@shared/errors/app-error';
import type {
  BuiltMealAction,
  CarbKind,
  MealActionAfter,
  MealActionBefore,
  MealActionCatalogEntry,
  MealActionEntryState,
  MealActionMealState,
  MealActionOperation,
  MealActionStatus,
  MealActionTargetMeal,
  MealActionWarning,
} from '@modules/meal-actions/application/meal-action-policy';
import type { LoopActionPurpose } from '@modules/loop-actions/application/loop-action-policy';
import { mealLabel } from '@modules/loop-actions/application/loop-action-views';
import { editMealContentLocked, PostgresMealRecordRepository, type MealContentEdit } from './postgres-meal-history.repository';

/**
 * PostgreSQL storage for meal changes prepared in conversations (migration 043, conversation-meal-actions.v1), and the
 * reads of the current meal / loop entry state the changes are built on. A content change is applied in one
 * transaction with the change row, so a change is never half applied and never applied twice.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toIso = (value: unknown): string => new Date(value as string | Date).toISOString();
const num = (value: unknown): number | null => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));

/** An APPLYING change older than this was left by a crashed request and may be applied again. */
const APPLYING_LEASE_SECONDS = 120;

export interface ConversationMealActionRow {
  id: string;
  patient_id: string;
  conversation_id: string;
  user_message_id: string;
  operation: MealActionOperation;
  meal_record_id: string | null;
  carb_event_id: string | null;
  loop_action_id: string | null;
  title: string;
  before: MealActionBefore;
  after: MealActionAfter;
  undoable: boolean;
  warnings: MealActionWarning[];
  base_content_revision: number | null;
  status: MealActionStatus;
  reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  applied_content_revision: number | null;
  undone_at: string | null;
  created_at: string;
}

const DISPLAY_NAME_SQL = `CASE WHEN u.display_name ~* '^(cognito:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN NULL ELSE u.display_name END`;

const ACTION_SELECT = `
  SELECT a.id::text, a.patient_id::text, a.conversation_id::text, a.user_message_id::text, a.operation,
         a.meal_record_id::text, a.carb_event_id::text, a.loop_action_id::text, a.payload, a.before, a.warnings,
         a.base_content_revision, a.status, a.reason, a.decided_at, a.applied_content_revision, a.undone_at, a.created_at,
         ${DISPLAY_NAME_SQL} AS decided_by
  FROM conversation_meal_actions a
  LEFT JOIN users u ON u.id = a.decided_by_user_id
`;

function toRow(row: Record<string, unknown>): ConversationMealActionRow {
  const payload = (row.payload ?? {}) as { title?: string; after?: MealActionAfter; undoable?: boolean };
  return {
    id: String(row.id),
    patient_id: String(row.patient_id),
    conversation_id: String(row.conversation_id),
    user_message_id: String(row.user_message_id),
    operation: row.operation as MealActionOperation,
    meal_record_id: (row.meal_record_id as string | null) ?? null,
    carb_event_id: (row.carb_event_id as string | null) ?? null,
    loop_action_id: (row.loop_action_id as string | null) ?? null,
    title: String(payload.title ?? ''),
    before: row.before as MealActionBefore,
    after: payload.after as MealActionAfter,
    undoable: payload.undoable === true,
    warnings: Array.isArray(row.warnings) ? (row.warnings as MealActionWarning[]) : [],
    base_content_revision: num(row.base_content_revision),
    status: row.status as MealActionStatus,
    reason: (row.reason as string | null) ?? null,
    decided_by: (row.decided_by as string | null) ?? null,
    decided_at: row.decided_at ? toIso(row.decided_at) : null,
    applied_content_revision: num(row.applied_content_revision),
    undone_at: row.undone_at ? toIso(row.undone_at) : null,
    created_at: toIso(row.created_at),
  };
}

export class PostgresConversationMealActionRepository {
  private readonly meals: PostgresMealRecordRepository;

  constructor(private readonly pool: Pool, meals?: PostgresMealRecordRepository) {
    this.meals = meals ?? new PostgresMealRecordRepository(pool);
  }

  /**
   * Stores a prepared change. An older change of the same meal or entry still waiting in this conversation is
   * superseded: only the newest card can be confirmed.
   */
  async insertProposal(args: { patientId: string; conversationId: string; userMessageId: string; action: BuiltMealAction; reason: string | null }): Promise<ConversationMealActionRow> {
    const { action } = args;
    return this.inTransaction(async (client) => {
      await client.query(
        `UPDATE conversation_meal_actions SET status = 'SUPERSEDED', updated_at = now()
         WHERE patient_id = $1::uuid AND conversation_id = $2::uuid AND status = 'PROPOSED'
           AND (($3::uuid IS NOT NULL AND meal_record_id = $3::uuid AND operation = ANY($6::text[]))
             OR ($4::uuid IS NOT NULL AND carb_event_id = $4::uuid)
             OR ($5::uuid IS NOT NULL AND loop_action_id = $5::uuid))`,
        [args.patientId, args.conversationId, action.meal_record_id, action.carb_event_id, action.loop_action_id, supersededOperations(action.operation)],
      );
      const id = (await client.query<{ id: string }>(
        `INSERT INTO conversation_meal_actions (patient_id, conversation_id, user_message_id, operation, meal_record_id, carb_event_id, loop_action_id,
                                                payload, before, warnings, base_content_revision, reason)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, $7::uuid, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12)
         RETURNING id::text`,
        [
          args.patientId,
          args.conversationId,
          args.userMessageId,
          action.operation,
          action.meal_record_id,
          action.carb_event_id,
          action.loop_action_id,
          JSON.stringify(action.payload),
          JSON.stringify(action.before),
          JSON.stringify(action.warnings),
          action.base_content_revision,
          args.reason?.slice(0, 600) ?? null,
        ],
      )).rows[0].id;
      return toRow((await client.query(`${ACTION_SELECT} WHERE a.id = $1::uuid`, [id])).rows[0]);
    });
  }

  async get(patientId: string, conversationId: string, actionId: string): Promise<ConversationMealActionRow | null> {
    if (!UUID_PATTERN.test(actionId) || !UUID_PATTERN.test(conversationId)) return null;
    const row = (await this.pool.query(`${ACTION_SELECT} WHERE a.patient_id = $1::uuid AND a.conversation_id = $2::uuid AND a.id = $3::uuid`, [patientId, conversationId, actionId])).rows[0];
    return row ? toRow(row) : null;
  }

  /** Changes of a conversation, oldest first (the app shows them under the answers they belong to). */
  async listForConversation(patientId: string, conversationId: string): Promise<ConversationMealActionRow[]> {
    if (!(await this.isInstalled())) return [];
    const rows = (await this.pool.query(
      `${ACTION_SELECT} WHERE a.patient_id = $1::uuid AND a.conversation_id = $2::uuid ORDER BY a.created_at, a.id`,
      [patientId, conversationId],
    )).rows;
    return rows.map(toRow);
  }

  /** Changes prepared for the answer to one caregiver message. */
  async listForUserMessage(patientId: string, userMessageId: string): Promise<ConversationMealActionRow[]> {
    if (!(await this.isInstalled()) || !UUID_PATTERN.test(userMessageId)) return [];
    const rows = (await this.pool.query(`${ACTION_SELECT} WHERE a.patient_id = $1::uuid AND a.user_message_id = $2::uuid ORDER BY a.created_at, a.id`, [patientId, userMessageId])).rows;
    return rows.map(toRow);
  }

  /** Changes prepared for the answer to this caregiver message that the answer was not stored for (cancelled, failed). */
  async discardForUserMessage(patientId: string, userMessageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE conversation_meal_actions SET status = 'DISCARDED', updated_at = now()
       WHERE patient_id = $1::uuid AND user_message_id = $2::uuid AND status = 'PROPOSED'`,
      [patientId, userMessageId],
    );
  }

  /**
   * Takes a proposed change for applying (status APPLYING) so a second tap or the other phone cannot apply it again.
   * Returns null when it is not waiting any more.
   */
  async claim(actionId: string): Promise<ConversationMealActionRow | null> {
    const row = (await this.pool.query(
      `UPDATE conversation_meal_actions SET status = 'APPLYING', updated_at = now()
       WHERE id = $1::uuid AND (status = 'PROPOSED' OR (status = 'APPLYING' AND updated_at < now() - make_interval(secs => $2)))
       RETURNING id::text`,
      [actionId, APPLYING_LEASE_SECONDS],
    )).rows[0];
    if (!row) return null;
    return toRow((await this.pool.query(`${ACTION_SELECT} WHERE a.id = $1::uuid`, [actionId])).rows[0]);
  }

  /** Back to PROPOSED after an apply failed for a reason the caregiver can retry. */
  async release(actionId: string): Promise<void> {
    await this.pool.query(`UPDATE conversation_meal_actions SET status = 'PROPOSED', updated_at = now() WHERE id = $1::uuid AND status = 'APPLYING'`, [actionId]);
  }

  async finishApplying(actionId: string, status: 'APPLIED' | 'STALE', userId: string, appliedContentRevision: number | null = null): Promise<void> {
    await this.pool.query(
      `UPDATE conversation_meal_actions
       SET status = $2, decided_by_user_id = $3::uuid, decided_at = now(), applied_content_revision = $4, updated_at = now()
       WHERE id = $1::uuid AND status = 'APPLYING'`,
      [actionId, status, userId, appliedContentRevision],
    );
  }

  /** The caregiver declined the change; false when it was not waiting any more. */
  async reject(actionId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE conversation_meal_actions SET status = 'REJECTED', decided_by_user_id = $2::uuid, decided_at = now(), updated_at = now()
       WHERE id = $1::uuid AND status = 'PROPOSED'`,
      [actionId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Marks a stale change (the meal or entry changed after it was prepared); false when it was not waiting. */
  async markStale(actionId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE conversation_meal_actions SET status = 'STALE', updated_at = now() WHERE id = $1::uuid AND status IN ('PROPOSED', 'APPLYING')`,
      [actionId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Applies a content change: the meal save (checked against the revision the change was prepared on), the change row
   * and the note in the meal's own chat commit together. The claimed (APPLYING) change must be this one.
   */
  async applyContent(args: { action: ConversationMealActionRow; identity: string; userId: string; edit: MealContentEdit; note: string; after?: MealActionAfter }): Promise<number> {
    const { action } = args;
    if (!action.meal_record_id) throw new NotFoundError('Meal not found');
    return this.inTransaction(async (client) => {
      await this.lockAction(client, action.id, 'APPLYING');
      const revision = await editMealContentLocked(client, action.patient_id, args.identity, args.userId, args.edit, action.base_content_revision);
      await client.query(
        `UPDATE conversation_meal_actions
         SET status = 'APPLIED', decided_by_user_id = $2::uuid, decided_at = now(), applied_content_revision = $3, updated_at = now(),
             -- A loop entry made a meal with its content: the change now names the meal it made.
             meal_record_id = COALESCE(meal_record_id, $5::uuid),
             -- "Popraw": the card shows what was saved, not what the AI proposed.
             payload = CASE WHEN $4::jsonb IS NULL THEN payload ELSE jsonb_set(payload, '{after}', $4::jsonb) END
         WHERE id = $1::uuid`,
        [action.id, args.userId, revision, args.after ? JSON.stringify(args.after) : null, action.meal_record_id],
      );
      await insertMealChatNote(client, action, args.userId, args.note, `meal-action:${action.id}`);
      return revision;
    });
  }

  /** "Cofnij" of a content change: restores the previous content unless the meal changed again after the change. */
  async undoContent(args: { action: ConversationMealActionRow; identity: string; userId: string; edit: MealContentEdit; note: string }): Promise<void> {
    const { action } = args;
    if (!action.meal_record_id) throw new NotFoundError('Meal not found');
    await this.inTransaction(async (client) => {
      await this.lockAction(client, action.id, 'APPLIED');
      await editMealContentLocked(client, action.patient_id, args.identity, args.userId, args.edit, action.applied_content_revision);
      // The values written back are the meal's earlier ones: it is again as it was (accepted AI values stay CONFIRMED,
      // not CORRECTED by the undo).
      if (action.before.kind === 'CONTENT' && action.before.status === 'CONFIRMED') {
        await client.query(
          `UPDATE meal_records SET status = 'CONFIRMED', updated_at = now() WHERE patient_id = $1::uuid AND meal_identity = $2 AND status = 'CORRECTED'`,
          [action.patient_id, args.identity],
        );
      }
      await this.markUndoneLocked(client, action.id, args.userId);
      await insertMealChatNote(client, action, args.userId, args.note, `meal-action-undo:${action.id}`);
    });
  }

  /** Marks an applied change undone after its undo was written elsewhere (loop entry purpose, WBT reminder). */
  async markUndone(action: ConversationMealActionRow, userId: string, note: string | null): Promise<boolean> {
    return this.inTransaction(async (client) => {
      const locked = (await client.query(`SELECT status FROM conversation_meal_actions WHERE id = $1::uuid FOR UPDATE`, [action.id])).rows[0];
      if (locked?.status !== 'APPLIED') return false;
      await this.markUndoneLocked(client, action.id, userId);
      if (note && action.meal_record_id) await insertMealChatNote(client, action, userId, note, `meal-action-undo:${action.id}`);
      return true;
    });
  }

  /** Adds the note about an applied non-content change to the meal's chat (idempotent per change). */
  async addMealChatNote(action: ConversationMealActionRow, mealRecordId: string, userId: string, note: string): Promise<void> {
    await this.inTransaction(async (client) => {
      const exists = (await client.query(`SELECT 1 FROM meal_records WHERE patient_id = $1::uuid AND id = $2::uuid`, [action.patient_id, mealRecordId])).rows[0];
      if (exists) await insertMealChatNote(client, { ...action, meal_record_id: mealRecordId }, userId, note, `meal-action:${action.id}`);
    });
  }

  // ---- State the changes are built on -------------------------------------------------------------------------------

  /** The meal as the change sees it, or null when there is no such meal. */
  async loadMealState(patientId: string, mealRecordId: string): Promise<{ identity: string; state: MealActionMealState } | null> {
    const identity = await this.meals.findMealIdentityById(patientId, mealRecordId);
    if (!identity) return null;
    const record = await this.meals.getMealRecord(patientId, identity);
    const reminder = (await this.pool.query(
      `SELECT enabled FROM meal_wbt_reminders WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid`,
      [patientId, mealRecordId],
    )).rows[0];
    return {
      identity,
      state: {
        meal_id: mealRecordId,
        started_at: record.started_at,
        status: record.status,
        description: record.description,
        items: record.items ?? null,
        carbs_g: record.macros.carbs.grams,
        protein_g: record.macros.protein.grams,
        fat_g: record.macros.fat.grams,
        content_revision: record.content_revision ?? 1,
        loop_carbs_g: record.source_carbs_g,
        wbt_reminder_enabled: reminder ? Boolean(reminder.enabled) : null,
      },
    };
  }

  /** Meals (not cancelled, first entry food) that started in [from, to], newest first, as the changes see them. */
  async listMealStatesBetween(patientId: string, fromIso: string, toIso_: string, limit = 40): Promise<MealActionMealState[]> {
    const ids = (await this.pool.query<{ id: string }>(
      `SELECT r.id::text AS id
       FROM meal_records r
       JOIN meal_record_entries e ON e.meal_record_id = r.id AND e.patient_id = r.patient_id
       LEFT JOIN carb_entry_kinds k ON k.patient_id = r.patient_id AND k.event_id = r.anchor_event_id
       WHERE r.patient_id = $1::uuid AND r.status <> 'CANCELLED' AND COALESCE(k.kind, 'MEAL') = 'MEAL'
       GROUP BY r.id
       HAVING min(e.occurred_at) >= $2::timestamptz AND min(e.occurred_at) <= $3::timestamptz
       ORDER BY min(e.occurred_at) DESC
       LIMIT $4`,
      [patientId, fromIso, toIso_, limit],
    )).rows.map((row) => row.id);
    const states: MealActionMealState[] = [];
    for (const id of ids) {
      const loaded = await this.loadMealState(patientId, id);
      if (loaded) states.push(loaded.state);
    }
    return states;
  }

  /**
   * Loop entries in [from, to], newest first: every carb entry (with its kind, the meal it belongs to and its loop
   * action) and every loop action with a bolus only.
   */
  async listEntriesBetween(patientId: string, fromIso: string, toIso_: string, limit = 80): Promise<MealActionCatalogEntry[]> {
    const rows = (await this.pool.query(
      `SELECT * FROM (
         SELECT ev.id::text AS carb_event_id, a.id::text AS loop_action_id, ev.occurred_at,
                CASE WHEN ev.payload->>'carbs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (ev.payload->>'carbs')::numeric END AS carbs_g,
                CASE WHEN bolus_ev.payload->>'insulin_units' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (bolus_ev.payload->>'insulin_units')::numeric END AS bolus_units,
                COALESCE(k.kind, 'MEAL') AS kind, a.purpose, a.meal_record_id::text AS purpose_meal_id,
                member.meal_record_id::text AS meal_id
         FROM events ev
         LEFT JOIN carb_entry_kinds k ON k.patient_id = ev.patient_id AND k.event_id = ev.id
         LEFT JOIN meal_record_entries member ON member.patient_id = ev.patient_id AND member.event_id = ev.id
         LEFT JOIN loop_action_events own ON own.patient_id = ev.patient_id AND own.event_id = ev.id
         LEFT JOIN loop_actions a ON a.id = own.loop_action_id
         LEFT JOIN loop_action_events bolus ON bolus.loop_action_id = a.id AND bolus.event_type = 'BOLUS'
         LEFT JOIN events bolus_ev ON bolus_ev.patient_id = bolus.patient_id AND bolus_ev.id = bolus.event_id
         WHERE ev.patient_id = $1::uuid AND ev.type = 'CARB_ENTRY' AND ev.occurred_at >= $2::timestamptz AND ev.occurred_at <= $3::timestamptz
         UNION ALL
         SELECT NULL, a.id::text, a.started_at,
                NULL,
                CASE WHEN bolus_ev.payload->>'insulin_units' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (bolus_ev.payload->>'insulin_units')::numeric END,
                'MEAL', a.purpose, a.meal_record_id::text, NULL
         FROM loop_actions a
         JOIN loop_action_events bolus ON bolus.loop_action_id = a.id AND bolus.event_type = 'BOLUS'
         JOIN events bolus_ev ON bolus_ev.patient_id = bolus.patient_id AND bolus_ev.id = bolus.event_id
         WHERE a.patient_id = $1::uuid AND a.started_at >= $2::timestamptz AND a.started_at <= $3::timestamptz
           AND NOT EXISTS (SELECT 1 FROM loop_action_events c WHERE c.loop_action_id = a.id AND c.event_type = 'CARB_ENTRY')
       ) entries
       ORDER BY occurred_at DESC
       LIMIT $4`,
      [patientId, fromIso, toIso_, limit],
    )).rows;
    return rows.map((row) => ({
      carb_event_id: row.carb_event_id ?? null,
      loop_action_id: row.loop_action_id ?? null,
      occurred_at: toIso(row.occurred_at),
      carbs_g: num(row.carbs_g),
      bolus_units: num(row.bolus_units),
      kind: row.kind as CarbKind,
      purpose: (row.purpose as LoopActionPurpose | null) ?? null,
      purpose_meal_id: row.purpose_meal_id ?? null,
      meal_id: row.meal_id ?? null,
    }));
  }

  async loadTargetMeal(patientId: string, mealRecordId: string): Promise<MealActionTargetMeal | null> {
    if (!UUID_PATTERN.test(mealRecordId)) return null;
    const row = (await this.pool.query(
      `SELECT r.id::text, r.status, r.description, min(e.occurred_at) AS started_at
       FROM meal_records r JOIN meal_record_entries e ON e.meal_record_id = r.id AND e.patient_id = r.patient_id
       WHERE r.patient_id = $1::uuid AND r.id = $2::uuid
       GROUP BY r.id`,
      [patientId, mealRecordId],
    )).rows[0];
    return row ? { meal_id: String(row.id), status: row.status, label: mealLabel(row.description, toIso(row.started_at)) } : null;
  }

  /**
   * A loop entry by its loop action or carb entry: the action's answer, the carb entry's kind and the meal the carb
   * entry belongs to. Null when neither exists for this patient.
   */
  async loadEntryState(patientId: string, ref: { loopActionId?: string | null; carbEventId?: string | null }): Promise<MealActionEntryState | null> {
    let actionId = ref.loopActionId && UUID_PATTERN.test(ref.loopActionId) ? ref.loopActionId : null;
    const carbRef = ref.carbEventId && UUID_PATTERN.test(ref.carbEventId) ? ref.carbEventId : null;
    if (!actionId && !carbRef) return null;
    if (!actionId && carbRef && (await this.loopActionsInstalled())) {
      actionId = (await this.pool.query<{ id: string }>(
        `SELECT loop_action_id::text AS id FROM loop_action_events WHERE patient_id = $1::uuid AND event_id = $2::uuid`,
        [patientId, carbRef],
      )).rows[0]?.id ?? null;
    }

    let base: Omit<MealActionEntryState, 'kind' | 'meal' | 'purpose_meal_label'>;
    if (actionId) {
      const row = (await this.pool.query(
        `SELECT a.id::text, a.started_at, a.purpose, a.meal_record_id::text,
                carb.event_id::text AS carb_event_id,
                CASE WHEN carb_ev.payload->>'carbs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (carb_ev.payload->>'carbs')::numeric END AS carbs_g,
                CASE WHEN bolus_ev.payload->>'insulin_units' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (bolus_ev.payload->>'insulin_units')::numeric END AS bolus_units,
                COALESCE(carb_ev.occurred_at, a.started_at) AS occurred_at
         FROM loop_actions a
         LEFT JOIN loop_action_events carb ON carb.loop_action_id = a.id AND carb.event_type = 'CARB_ENTRY'
         LEFT JOIN events carb_ev ON carb_ev.patient_id = carb.patient_id AND carb_ev.id = carb.event_id
         LEFT JOIN loop_action_events bolus ON bolus.loop_action_id = a.id AND bolus.event_type = 'BOLUS'
         LEFT JOIN events bolus_ev ON bolus_ev.patient_id = bolus.patient_id AND bolus_ev.id = bolus.event_id
         WHERE a.patient_id = $1::uuid AND a.id = $2::uuid`,
        [patientId, actionId],
      )).rows[0];
      if (!row) return null;
      if (carbRef && row.carb_event_id !== carbRef) return null;
      base = {
        carb_event_id: row.carb_event_id ?? null,
        loop_action_id: String(row.id),
        occurred_at: toIso(row.occurred_at),
        carbs_g: num(row.carbs_g),
        bolus_units: num(row.bolus_units),
        purpose: (row.purpose as LoopActionPurpose | null) ?? null,
        purpose_meal_id: row.meal_record_id ?? null,
      };
    } else {
      const row = (await this.pool.query(
        `SELECT id::text, occurred_at,
                CASE WHEN payload->>'carbs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (payload->>'carbs')::numeric END AS carbs_g
         FROM events WHERE patient_id = $1::uuid AND id = $2::uuid AND type = 'CARB_ENTRY'`,
        [patientId, carbRef],
      )).rows[0];
      if (!row) return null;
      base = { carb_event_id: String(row.id), loop_action_id: null, occurred_at: toIso(row.occurred_at), carbs_g: num(row.carbs_g), bolus_units: null, purpose: null, purpose_meal_id: null };
    }

    const kind = base.carb_event_id
      ? ((await this.pool.query<{ kind: CarbKind }>(`SELECT kind FROM carb_entry_kinds WHERE patient_id = $1::uuid AND event_id = $2::uuid`, [patientId, base.carb_event_id])).rows[0]?.kind ?? 'MEAL')
      : 'MEAL';
    const meal = base.carb_event_id ? await this.loadEntryMeal(patientId, base.carb_event_id, base.loop_action_id) : null;
    const purposeMeal = base.purpose_meal_id ? await this.loadTargetMeal(patientId, base.purpose_meal_id) : null;
    return { ...base, kind, meal, purpose_meal_label: purposeMeal?.label ?? null };
  }

  private async loadEntryMeal(patientId: string, carbEventId: string, loopActionId: string | null): Promise<MealActionEntryState['meal']> {
    const row = (await this.pool.query(
      `SELECT r.id::text, r.anchor_event_id::text, r.description, r.confirmed_macros, r.confirmed_items, r.status,
              (SELECT count(*) FROM meal_record_entries m WHERE m.meal_record_id = r.id) AS entry_count,
              (SELECT min(m.occurred_at) FROM meal_record_entries m WHERE m.meal_record_id = r.id) AS started_at
       FROM meal_record_entries e JOIN meal_records r ON r.id = e.meal_record_id AND r.patient_id = e.patient_id
       WHERE e.patient_id = $1::uuid AND e.event_id = $2::uuid`,
      [patientId, carbEventId],
    )).rows[0];
    if (!row) return null;
    const dependants = (await this.loopActionsInstalled())
      ? Number((await this.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM loop_actions
         WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid AND purpose IN ('MEAL_ADDITION', 'WBT') AND ($3::uuid IS NULL OR id <> $3::uuid)`,
        [patientId, row.id, loopActionId],
      )).rows[0]?.count ?? 0)
      : 0;
    // A later dose still planned, or a card's command that made the meal: the meal cannot be taken back.
    const plannedDoses = Number((await this.pool.query<{ count: string }>(
      `SELECT ((SELECT count(*) FROM planned_boluses WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid AND status IN ('SCHEDULED', 'NOTIFIED'))
             + (SELECT count(*) FROM remote_commands WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid))::text AS count`,
      [patientId, row.id],
    ).catch(() => ({ rows: [{ count: '0' }] }))).rows[0]?.count ?? 0);
    return {
      meal_id: String(row.id),
      label: mealLabel(row.description, toIso(row.started_at)),
      is_anchor: row.anchor_event_id === carbEventId,
      entry_count: Number(row.entry_count),
      has_content: Boolean(row.description?.trim()) || row.confirmed_macros !== null || row.confirmed_items !== null,
      dependants,
      planned_doses: plannedDoses,
    };
  }

  private loopInstalled: boolean | null = null;
  private tableInstalled = false;

  private async loopActionsInstalled(): Promise<boolean> {
    if (this.loopInstalled === null) {
      this.loopInstalled = Boolean((await this.pool.query(`SELECT to_regclass('public.loop_actions') IS NOT NULL AS installed`)).rows[0]?.installed);
    }
    return this.loopInstalled;
  }

  /** True once migration 043 is applied (a conversation read keeps working before it). */
  private async isInstalled(): Promise<boolean> {
    if (this.tableInstalled) return true;
    try {
      this.tableInstalled = Boolean((await this.pool.query(`SELECT to_regclass('public.conversation_meal_actions') IS NOT NULL AS installed`)).rows[0]?.installed);
    } catch {
      return false;
    }
    return this.tableInstalled;
  }

  private async lockAction(client: PoolClient, actionId: string, expected: MealActionStatus): Promise<void> {
    const row = (await client.query(`SELECT status FROM conversation_meal_actions WHERE id = $1::uuid FOR UPDATE`, [actionId])).rows[0];
    if (!row) throw new NotFoundError('Meal change not found');
    if (row.status !== expected) throw new ConflictError(`MEAL_ACTION_NOT_${expected}: the change is ${row.status}`);
  }

  private async markUndoneLocked(client: PoolClient, actionId: string, userId: string): Promise<void> {
    await client.query(
      `UPDATE conversation_meal_actions SET status = 'UNDONE', undone_by_user_id = $2::uuid, undone_at = now(), updated_at = now() WHERE id = $1::uuid`,
      [actionId, userId],
    );
  }

  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      client.release();
      return result;
    } catch (error) {
      let rollbackError: Error | undefined;
      try {
        await client.query('ROLLBACK');
      } catch (failure) {
        rollbackError = failure instanceof Error ? failure : new Error(String(failure));
      }
      // A client whose rollback failed may still be inside a transaction: destroy it instead of reusing it.
      client.release(rollbackError ?? false);
      throw error;
    }
  }
}

const CONTENT_OPERATIONS: MealActionOperation[] = ['REPLACE_CONTENT', 'UPDATE_MACROS', 'UPDATE_DESCRIPTION'];

/** Waiting changes of the same meal a new change replaces: content replaces content, a WBT reminder a WBT reminder. */
function supersededOperations(operation: MealActionOperation): MealActionOperation[] {
  if (CONTENT_OPERATIONS.includes(operation)) return CONTENT_OPERATIONS;
  if (operation === 'SET_WBT_REMINDER') return ['SET_WBT_REMINDER'];
  return [];
}

/** The note in the meal's own chat that a change came from a conversation (decision 3 of the plan). */
async function insertMealChatNote(client: PoolClient, action: Pick<ConversationMealActionRow, 'patient_id' | 'meal_record_id' | 'conversation_id'>, userId: string, content: string, key: string): Promise<void> {
  if (!action.meal_record_id) return;
  await client.query(
    `INSERT INTO meal_chat_messages (patient_id, meal_record_id, role, content, author_user_id, idempotency_key, origin_conversation_id)
     VALUES ($1::uuid, $2::uuid, 'ASSISTANT', $3, $4::uuid, $5, $6::uuid)
     ON CONFLICT (meal_record_id, idempotency_key) DO NOTHING`,
    [action.patient_id, action.meal_record_id, content.slice(0, 2000), userId, key, action.conversation_id],
  );
}
