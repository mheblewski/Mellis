import type { Pool, PoolClient } from 'pg';
import { ConflictError, NotFoundError, ValidationError, StaleWriteError } from '@shared/errors/app-error';
import { NEW_MEAL_ASSIGNMENT_POLICY } from '@modules/meal-candidates/application/meal-history-boundary';
import { buildNewMealId } from '@modules/meal-candidates/application/new-meal-assignment';
import { followWbtRemindersToMealStart } from './postgres-meal-wbt.repository';
import {
  LOOP_ACTION_POLICY,
  carbKindForPurpose,
  groupLoopEvent,
  type LoopActionPurpose,
  type LoopEventType,
  type OpenLoopAction,
} from '@modules/loop-actions/application/loop-action-policy';

/**
 * PostgreSQL storage for loop actions (migration 041, modules/loop-actions). Grouping and assignment take the
 * per-patient meal lock (`meal-history:<patient>`, shared with meal entry detachment), because an assignment creates
 * meal records and memberships.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toIso = (value: unknown): string => new Date(value as string | Date).toISOString();
const num = (value: unknown): number | null => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));

export interface LoopActionRow {
  id: string;
  patient_id: string;
  started_at: string;
  purpose: LoopActionPurpose | null;
  meal_record_id: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  carb_event_id: string | null;
  carbs_g: number | null;
  bolus_event_id: string | null;
  bolus_units: number | null;
}

export interface LoopMealSummaryRow {
  meal_record_id: string;
  started_at: string;
  description: string | null;
  status: string;
}

const ACTION_SELECT = `
  SELECT a.id::text, a.patient_id::text, a.started_at, a.purpose, a.meal_record_id::text, a.assigned_at,
         CASE WHEN u.display_name ~* '^(cognito:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN NULL ELSE u.display_name END AS assigned_by,
         carb.event_id::text AS carb_event_id,
         CASE WHEN carb_ev.payload->>'carbs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (carb_ev.payload->>'carbs')::numeric END AS carbs_g,
         bolus.event_id::text AS bolus_event_id,
         CASE WHEN bolus_ev.payload->>'insulin_units' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (bolus_ev.payload->>'insulin_units')::numeric END AS bolus_units
  FROM loop_actions a
  LEFT JOIN users u ON u.id = a.assigned_by_user_id
  LEFT JOIN loop_action_events carb ON carb.loop_action_id = a.id AND carb.event_type = 'CARB_ENTRY'
  LEFT JOIN events carb_ev ON carb_ev.patient_id = carb.patient_id AND carb_ev.id = carb.event_id
  LEFT JOIN loop_action_events bolus ON bolus.loop_action_id = a.id AND bolus.event_type = 'BOLUS'
  LEFT JOIN events bolus_ev ON bolus_ev.patient_id = bolus.patient_id AND bolus_ev.id = bolus.event_id
`;

function toActionRow(row: Record<string, unknown>): LoopActionRow {
  return {
    id: String(row.id),
    patient_id: String(row.patient_id),
    started_at: toIso(row.started_at),
    purpose: (row.purpose as LoopActionPurpose | null) ?? null,
    meal_record_id: (row.meal_record_id as string | null) ?? null,
    assigned_by: (row.assigned_by as string | null) ?? null,
    assigned_at: row.assigned_at ? toIso(row.assigned_at) : null,
    carb_event_id: (row.carb_event_id as string | null) ?? null,
    carbs_g: num(row.carbs_g),
    bolus_event_id: (row.bolus_event_id as string | null) ?? null,
    bolus_units: num(row.bolus_units),
  };
}

/** Meal start = its earliest entry; cancelled meals and meals whose first entry is not food are left out. */
const MEAL_STARTS_SQL = `
  SELECT r.id AS meal_record_id, r.description, r.status, min(e.occurred_at) AS started_at
  FROM meal_records r
  JOIN meal_record_entries e ON e.meal_record_id = r.id AND e.patient_id = r.patient_id
  LEFT JOIN carb_entry_kinds k ON k.patient_id = r.patient_id AND k.event_id = r.anchor_event_id
  WHERE r.patient_id = $1::uuid AND r.status <> 'CANCELLED' AND COALESCE(k.kind, 'MEAL') = 'MEAL'
  GROUP BY r.id
`;

export class PostgresLoopActionRepository {
  private installed = false;

  constructor(private readonly pool: Pool) {}

  /** True once migration 041 is applied (remembered once seen, migrations are never rolled back). */
  async isInstalled(): Promise<boolean> {
    if (this.installed) return true;
    try {
      const row = (await this.pool.query(`SELECT to_regclass('public.loop_actions') IS NOT NULL AS installed`)).rows[0];
      this.installed = Boolean(row?.installed);
    } catch {
      // No database behind the pool (offline specs): the feature is off.
      return false;
    }
    return this.installed;
  }

  async listPatientsWithEpoch(): Promise<string[]> {
    if (!(await this.isInstalled())) return [];
    return (await this.pool.query<{ patient_id: string }>(`SELECT patient_id::text FROM loop_action_epochs`)).rows.map((row) => row.patient_id);
  }

  /**
   * Turns new LIVE carb entries and boluses (after the epoch start, by event time and first-seen time) into actions:
   * each joins the nearest unassigned action within the group window that lacks its type, else starts one.
   * Returns the number of events processed.
   */
  async groupNewEvents(patientId: string, limit = 200): Promise<number> {
    return this.runExclusive(patientId, async (client) => {
      const events = (await client.query<{ id: string; type: LoopEventType; occurred_at: Date }>(
        `SELECT e.id::text, e.type, e.occurred_at
         FROM events e
         JOIN loop_action_epochs ep ON ep.patient_id = e.patient_id
         WHERE e.patient_id = $1::uuid
           AND e.type IN ('CARB_ENTRY', 'BOLUS')
           AND e.event_ingestion_origin = 'LIVE'
           -- Rescue carbs logged in GlucoMind (rescue-carbs.v1) were never a loop action.
           AND COALESCE(e.payload->>'entry_source', '') <> 'GLUCOMIND'
           AND e.occurred_at >= ep.starts_at
           AND e.created_at >= ep.starts_at
           AND NOT EXISTS (SELECT 1 FROM loop_action_events lae WHERE lae.patient_id = e.patient_id AND lae.event_id = e.id)
         ORDER BY e.occurred_at, e.id
         LIMIT $2`,
        [patientId, limit],
      )).rows;
      const windowMinutes = LOOP_ACTION_POLICY.group_window_minutes;
      for (const event of events) {
        const occurredAt = toIso(event.occurred_at);
        const nearby = (await client.query(
          `SELECT a.id::text, a.started_at, a.purpose IS NOT NULL AS assigned, array_agg(lae.event_type) AS event_types
           FROM loop_actions a
           JOIN loop_action_events lae ON lae.loop_action_id = a.id
           WHERE a.patient_id = $1::uuid
             AND a.started_at BETWEEN $2::timestamptz - make_interval(mins => $3) AND $2::timestamptz + make_interval(mins => $3)
           GROUP BY a.id`,
          [patientId, occurredAt, windowMinutes],
        )).rows.map((row): OpenLoopAction => ({
          id: String(row.id),
          started_at: toIso(row.started_at),
          assigned: Boolean(row.assigned),
          event_types: row.event_types as LoopEventType[],
        }));
        const decision = groupLoopEvent({ event_id: event.id, event_type: event.type, occurred_at: occurredAt }, nearby);
        let actionId: string;
        if (decision.action === 'JOIN') {
          actionId = decision.loop_action_id;
          await client.query(
            `UPDATE loop_actions SET started_at = LEAST(started_at, $2::timestamptz), updated_at = now() WHERE id = $1::uuid`,
            [actionId, occurredAt],
          );
        } else {
          actionId = (await client.query<{ id: string }>(
            `INSERT INTO loop_actions (patient_id, started_at) VALUES ($1::uuid, $2::timestamptz) RETURNING id::text`,
            [patientId, occurredAt],
          )).rows[0].id;
        }
        await client.query(
          `INSERT INTO loop_action_events (patient_id, event_id, loop_action_id, event_type, occurred_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz)`,
          [patientId, event.id, actionId, event.type, occurredAt],
        );
      }
      return events.length;
    });
  }

  /**
   * What each of these events was assigned to: its loop action's purpose, the meal (by identity) and whether the action
   * has carbs. Events outside loop actions (before the epoch) are absent.
   */
  async listEventAssignments(patientId: string, eventIds: string[]): Promise<Map<string, { purpose: LoopActionPurpose | null; meal_identity: string | null; meal_record_id?: string | null; has_carbs: boolean }>> {
    const ids = eventIds.filter((id) => UUID_PATTERN.test(id));
    if (ids.length === 0) return new Map();
    const rows = (await this.pool.query(
      `SELECT lae.event_id::text AS event_id, la.purpose, mr.meal_identity, la.meal_record_id::text AS meal_record_id,
              EXISTS (SELECT 1 FROM loop_action_events c WHERE c.loop_action_id = la.id AND c.event_type = 'CARB_ENTRY') AS has_carbs
       FROM loop_action_events lae
       JOIN loop_actions la ON la.id = lae.loop_action_id
       LEFT JOIN meal_records mr ON mr.id = la.meal_record_id
       WHERE lae.patient_id = $1::uuid AND lae.event_id = ANY($2::uuid[])`,
      [patientId, ids],
    )).rows;
    return new Map(rows.map((row) => [String(row.event_id), { purpose: (row.purpose ?? null) as LoopActionPurpose | null, meal_identity: row.meal_identity ? String(row.meal_identity) : null, meal_record_id: row.meal_record_id ? String(row.meal_record_id) : null, has_carbs: row.has_carbs === true }]));
  }

  async getAction(patientId: string, actionId: string): Promise<LoopActionRow | null> {
    if (!UUID_PATTERN.test(actionId)) return null;
    const row = (await this.pool.query(`${ACTION_SELECT} WHERE a.patient_id = $1::uuid AND a.id = $2::uuid`, [patientId, actionId])).rows[0];
    return row ? toActionRow(row) : null;
  }

  /** Actions that started in [from, to), oldest first. */
  /** With `linked_to_command`: a remote command is matched to the action already (a Bolus tab dose leaves it unassigned). */
  async listActionsBetween(patientId: string, fromIso: string, toIso_: string): Promise<Array<LoopActionRow & { linked_to_command: boolean }>> {
    const rows = (await this.pool.query(
      `SELECT x.*, EXISTS (SELECT 1 FROM remote_commands rc WHERE rc.patient_id = $1::uuid AND rc.loop_action_id = x.id::uuid) AS linked_to_command
       FROM (${ACTION_SELECT} WHERE a.patient_id = $1::uuid AND a.started_at >= $2::timestamptz AND a.started_at < $3::timestamptz) x
       ORDER BY x.started_at, x.id`,
      [patientId, fromIso, toIso_],
    )).rows;
    return rows.map((row) => ({ ...toActionRow(row), linked_to_command: row.linked_to_command === true }));
  }

  /** Actions linked to the given meals. */
  async listActionsForMeals(patientId: string, mealRecordIds: string[]): Promise<LoopActionRow[]> {
    if (mealRecordIds.length === 0 || !(await this.isInstalled())) return [];
    const rows = (await this.pool.query(
      `${ACTION_SELECT} WHERE a.patient_id = $1::uuid AND a.meal_record_id = ANY($2::uuid[]) ORDER BY a.started_at, a.id`,
      [patientId, mealRecordIds],
    )).rows;
    return rows.map(toActionRow);
  }

  /** Start of the first meal after `afterIso` (exclusive), or null. */
  async nextMealStart(patientId: string, afterIso: string): Promise<string | null> {
    const row = (await this.pool.query(
      `SELECT min(started_at) AS started_at FROM (${MEAL_STARTS_SQL}) m WHERE m.started_at > $2::timestamptz`,
      [patientId, afterIso],
    )).rows[0];
    return row?.started_at ? toIso(row.started_at) : null;
  }

  async listSmbsBetween(patientId: string, fromIso: string, toIso_: string): Promise<Array<{ at: string; units: number }>> {
    const rows = (await this.pool.query(
      `SELECT occurred_at, payload->>'insulin_units' AS units
       FROM events
       WHERE patient_id = $1::uuid AND type = 'SMB' AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz
       ORDER BY occurred_at`,
      [patientId, fromIso, toIso_],
    )).rows;
    return rows
      .map((row) => ({ at: toIso(row.occurred_at), units: Number(row.units) }))
      .filter((smb) => Number.isFinite(smb.units) && smb.units > 0);
  }

  /**
   * Records what the action was for and applies it to the meal history: NEW_MEAL creates a meal anchored on the carb
   * entry (and links pre-boluses logged shortly before), MEAL_ADDITION adds the carb entry to the meal, and the carb
   * entry's kind follows the purpose. A changed answer first undoes the previous one; a meal created by this action can
   * only be removed while nothing else was added to it.
   *
   * `purpose` null takes the answer back (the "Cofnij" after a quick answer): the action waits again.
   *
   * `expected` is the answer the caregiver saw (live-updates.v1): when the other caregiver answered differently in the
   * meantime nothing is written (StaleWriteError). The same answer from both is not a conflict.
   */
  async assign(args: { patientId: string; actionId: string; purpose: LoopActionPurpose | null; mealRecordId: string | null; userId: string; expected?: { purpose: LoopActionPurpose | null; mealRecordId: string | null } }): Promise<void> {
    const { patientId, actionId, purpose, userId } = args;
    await this.runExclusive(patientId, async (client) => {
      const current = (await client.query(`${ACTION_SELECT} WHERE a.patient_id = $1::uuid AND a.id = $2::uuid FOR UPDATE OF a`, [patientId, actionId])).rows[0];
      if (!current) throw new NotFoundError('Loop action not found');
      const action = toActionRow(current);

      let targetMealId = args.mealRecordId;
      if (targetMealId) {
        const meal = (await client.query(
          `SELECT id FROM meal_records WHERE patient_id = $1::uuid AND id = $2::uuid AND status <> 'CANCELLED'`,
          [patientId, targetMealId],
        )).rows[0];
        if (!meal) throw new NotFoundError('Meal not found');
        if (action.purpose === 'NEW_MEAL' && action.meal_record_id === targetMealId) {
          throw new ValidationError('An action cannot be added to the meal it started');
        }
      }

      if (action.purpose === purpose && action.meal_record_id === targetMealId) return;
      if (action.purpose === 'NEW_MEAL' && purpose === 'NEW_MEAL') return;
      // A pre-bolus linked to its meal (by the meal's answer) answered PRE_BOLUS again: the same answer, the link stays.
      if (action.purpose === 'PRE_BOLUS' && purpose === 'PRE_BOLUS' && targetMealId === null) return;
      if (args.expected && (action.purpose !== args.expected.purpose || action.meal_record_id !== args.expected.mealRecordId)) {
        throw new StaleWriteError(`LOOP_ACTION_CHANGED: ${actionId} is now ${action.purpose ?? 'unassigned'}`);
      }

      // Undo the previous answer.
      if (action.purpose === 'NEW_MEAL' && action.meal_record_id) {
        const dependants = (await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM loop_actions
           WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid AND id <> $3::uuid AND purpose IN ('MEAL_ADDITION', 'WBT')`,
          [patientId, action.meal_record_id, actionId],
        )).rows[0];
        if (Number(dependants?.count ?? 0) > 0) {
          throw new ConflictError('Other entries were added to this meal; move them first');
        }
        // An insulin command for this meal (a WBT dose or a split bolus's second part) must keep its meal: the meal
        // stays, and so does the record of what was sent for it.
        const commands = (await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM remote_commands
           WHERE patient_id = $1::uuid AND target_meal_record_id = $2::uuid AND purpose IS NOT NULL`,
          [patientId, action.meal_record_id],
        )).rows[0];
        if (Number(commands?.count ?? 0) > 0) {
          throw new ConflictError('MEAL_HAS_REMOTE_COMMANDS: a dose was sent from GlucoMind for this meal');
        }
        // The meal a card's command made, or one with a later dose still planned: removing it would delete the plan
        // (its reminder never comes) and the record of what was sent.
        const planned = (await client.query<{ count: string }>(
          `SELECT (SELECT count(*) FROM planned_boluses WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid AND status IN ('SCHEDULED', 'NOTIFIED'))
                + (SELECT count(*) FROM remote_commands WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid) AS count`,
          [patientId, action.meal_record_id],
        )).rows[0];
        if (Number(planned?.count ?? 0) > 0) {
          throw new ConflictError('MEAL_HAS_PLANNED_DOSES: Ten posiłek ma zaplanowaną kolejną dawkę albo został wysłany z karty do Trio; najpierw pomiń zaplanowaną dawkę.');
        }
        // Chat cards about this meal stay in their conversation: a waiting one can no longer be applied (STALE), and one
        // that named only the meal keeps the meal's carb entry (or this action) as its subject, since the target CHECK
        // needs one once the meal is gone.
        await client.query(
          `UPDATE conversation_meal_actions
           SET status = CASE WHEN status IN ('PROPOSED', 'APPLYING') THEN 'STALE' ELSE status END,
               carb_event_id = CASE WHEN carb_event_id IS NULL AND loop_action_id IS NULL THEN $3::uuid ELSE carb_event_id END,
               loop_action_id = CASE WHEN carb_event_id IS NULL AND loop_action_id IS NULL AND $3::uuid IS NULL THEN $4::uuid ELSE loop_action_id END,
               updated_at = now()
           WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid`,
          [patientId, action.meal_record_id, action.carb_event_id, actionId],
        );
        await client.query(`UPDATE loop_actions SET purpose = NULL, assigned_at = NULL, meal_record_id = NULL WHERE id = $1::uuid`, [actionId]);
        await client.query(`DELETE FROM meal_records WHERE patient_id = $1::uuid AND id = $2::uuid`, [patientId, action.meal_record_id]);
      }
      if (action.purpose === 'MEAL_ADDITION' && action.carb_event_id) {
        await client.query(`DELETE FROM meal_record_entries WHERE patient_id = $1::uuid AND event_id = $2::uuid`, [patientId, action.carb_event_id]);
      }

      if (purpose === null) {
        if (action.carb_event_id) {
          await client.query(`DELETE FROM carb_entry_kinds WHERE patient_id = $1::uuid AND event_id = $2::uuid`, [patientId, action.carb_event_id]);
        }
        await client.query(
          `UPDATE loop_actions SET purpose = NULL, meal_record_id = NULL, assigned_by_user_id = NULL, assigned_at = NULL, updated_at = now()
           WHERE id = $1::uuid`,
          [actionId],
        );
        if (action.purpose === 'MEAL_ADDITION') await followWbtRemindersToMealStart(client, patientId, [action.meal_record_id]);
        return;
      }

      // Apply the new one.
      if (purpose === 'NEW_MEAL') {
        if (!action.carb_event_id) throw new ValidationError('NEW_MEAL needs a carb entry');
        targetMealId = await this.createMeal(client, patientId, action.carb_event_id);
        await client.query(
          `UPDATE loop_actions SET meal_record_id = $2::uuid, updated_at = now()
           WHERE patient_id = $1::uuid AND purpose = 'PRE_BOLUS' AND meal_record_id IS NULL
             AND started_at <= $3::timestamptz AND started_at >= $3::timestamptz - make_interval(mins => $4)`,
          [patientId, targetMealId, action.started_at, LOOP_ACTION_POLICY.pre_bolus_link_minutes],
        );
      }
      if (purpose === 'PRE_BOLUS' && !targetMealId) {
        // Answered after its meal: it joins the first meal of its own started within the link window after it (the
        // same pairing as when the meal is answered after it), so its units count for that meal.
        const meal = (await client.query<{ meal_record_id: string }>(
          `SELECT meal_record_id::text FROM loop_actions
           WHERE patient_id = $1::uuid AND purpose = 'NEW_MEAL' AND meal_record_id IS NOT NULL
             AND started_at >= $2::timestamptz AND started_at <= $2::timestamptz + make_interval(mins => $3)
           ORDER BY started_at LIMIT 1`,
          [patientId, action.started_at, LOOP_ACTION_POLICY.pre_bolus_link_minutes],
        )).rows[0];
        if (meal) targetMealId = meal.meal_record_id;
      }
      if (purpose === 'MEAL_ADDITION' && action.carb_event_id && targetMealId) {
        await client.query(
          `INSERT INTO meal_record_entries (patient_id, event_id, meal_record_id, occurred_at)
           SELECT e.patient_id, e.id, $3::uuid, e.occurred_at FROM events e WHERE e.patient_id = $1::uuid AND e.id = $2::uuid`,
          [patientId, action.carb_event_id, targetMealId],
        );
      }
      if (action.carb_event_id) {
        await client.query(
          `INSERT INTO carb_entry_kinds (patient_id, event_id, kind, set_by_user_id, set_at)
           VALUES ($1::uuid, $2::uuid, $3, $4::uuid, now())
           ON CONFLICT (patient_id, event_id) DO UPDATE SET kind = EXCLUDED.kind, set_by_user_id = EXCLUDED.set_by_user_id, set_at = now()`,
          [patientId, action.carb_event_id, carbKindForPurpose(purpose), userId],
        );
      }
      await client.query(
        `UPDATE loop_actions
         SET purpose = $2, meal_record_id = $3::uuid, assigned_by_user_id = $4::uuid, assigned_at = now(), updated_at = now()
         WHERE id = $1::uuid`,
        [actionId, purpose, targetMealId, userId],
      );
      // An entry joined or left a meal: its WBT reminder follows the meal's new start (audit 2026-10-26).
      if (action.purpose === 'MEAL_ADDITION' || purpose === 'MEAL_ADDITION') {
        await followWbtRemindersToMealStart(client, patientId, [action.meal_record_id, targetMealId]);
      }
    });
  }

  /**
   * A remote bolus retried after Trio kept only the meal's carbs: its bolus joins the meal's action (one use of the
   * calculator, given in two steps) and the bolus-only action it formed goes away. False (nothing changes) unless the
   * source is an unassigned action with only a bolus and the target has no bolus yet.
   */
  async joinBolusToAction(patientId: string, sourceActionId: string, targetActionId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(sourceActionId) || !UUID_PATTERN.test(targetActionId) || sourceActionId === targetActionId) return false;
    return this.runExclusive(patientId, async (client) => {
      const locked = (await client.query(
        `SELECT id::text, purpose FROM loop_actions WHERE patient_id = $1::uuid AND id IN ($2::uuid, $3::uuid) FOR UPDATE`,
        [patientId, sourceActionId, targetActionId],
      )).rows;
      const source = locked.find((row) => row.id === sourceActionId);
      const target = locked.find((row) => row.id === targetActionId);
      const events = (await client.query<{ loop_action_id: string; event_type: string }>(
        `SELECT loop_action_id::text, event_type FROM loop_action_events WHERE patient_id = $1::uuid AND loop_action_id IN ($2::uuid, $3::uuid)`,
        [patientId, sourceActionId, targetActionId],
      )).rows;
      const sourceTypes = events.filter((event) => event.loop_action_id === sourceActionId).map((event) => event.event_type);
      const targetHasBolus = events.some((event) => event.loop_action_id === targetActionId && event.event_type === 'BOLUS');
      if (!source || source.purpose !== null || sourceTypes.length !== 1 || sourceTypes[0] !== 'BOLUS' || !target || targetHasBolus) return false;
      await client.query(
        `UPDATE loop_action_events SET loop_action_id = $3::uuid WHERE patient_id = $1::uuid AND loop_action_id = $2::uuid AND event_type = 'BOLUS'`,
        [patientId, sourceActionId, targetActionId],
      );
      await client.query(`DELETE FROM loop_actions WHERE patient_id = $1::uuid AND id = $2::uuid`, [patientId, sourceActionId]);
      await client.query(`UPDATE loop_actions SET updated_at = now() WHERE id = $1::uuid`, [targetActionId]);
      return true;
    });
  }

  /** A meal record anchored on the carb entry, in the active meal history epoch; no description push (the caregiver is here). */
  private async createMeal(client: PoolClient, patientId: string, carbEventId: string): Promise<string> {
    const epoch = (await client.query(
      `SELECT id::text, assignment_policy_version FROM meal_history_epochs WHERE patient_id = $1::uuid AND retired_at IS NULL FOR SHARE`,
      [patientId],
    )).rows[0];
    if (!epoch) throw new ConflictError('Meal history is not active for this patient');
    const identity = buildNewMealId(epoch.id, carbEventId, { ...NEW_MEAL_ASSIGNMENT_POLICY, version: epoch.assignment_policy_version });
    // An earlier membership of this entry (an old automatic meal) would block the new meal.
    await client.query(`DELETE FROM meal_record_entries WHERE patient_id = $1::uuid AND event_id = $2::uuid`, [patientId, carbEventId]);
    const mealId = (await client.query<{ id: string }>(
      `INSERT INTO meal_records (patient_id, meal_identity, epoch_id, assignment_policy_version, anchor_event_id)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid)
       RETURNING id::text`,
      [patientId, identity, epoch.id, epoch.assignment_policy_version, carbEventId],
    )).rows[0].id;
    await client.query(
      `INSERT INTO meal_record_entries (patient_id, event_id, meal_record_id, occurred_at)
       SELECT e.patient_id, e.id, $3::uuid, e.occurred_at FROM events e WHERE e.patient_id = $1::uuid AND e.id = $2::uuid`,
      [patientId, carbEventId, mealId],
    );
    return mealId;
  }

  private async runExclusive<T>(patientId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!UUID_PATTERN.test(patientId)) throw new ValidationError(`Invalid patient id: ${patientId}`);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`meal-history:${patientId}`]);
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
      client.release(rollbackError ?? false);
      throw error;
    }
  }
}
