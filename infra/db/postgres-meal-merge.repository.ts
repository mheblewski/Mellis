import type { Pool, PoolClient } from 'pg';
import { ConflictError, NotFoundError, ValidationError } from '@shared/errors/app-error';
import type { MergeContent, MergeSplitChoice } from '@modules/meal-journal/application/meal-merge';
import { followWbtRemindersToMealStart } from './postgres-meal-wbt.repository';

/**
 * "Scal" in the Meals tab (meal-merge.v1, migration 097): the other meals' rows move to the merged meal in one
 * transaction under the patient's meal lock (`meal-history:<patient>`, as loop action assignment), then their records
 * are deleted. The plan (which meal stays, what content it keeps) is meal-merge.ts's.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MealMergeWrite {
  patientId: string;
  targetId: string;
  sourceIds: string[];
  content: MergeContent;
  /** KEPT: the meal whose description, values, items and photo the merged meal keeps (may be the target). */
  contentMealId: string | null;
  /** The other meals' carb entries, added to carbs stored on the kept meal (planMealMerge's added_carbs_g). */
  addedCarbsG: number;
  split: MergeSplitChoice | null;
  userId: string;
}

async function assertNoDoseBeingSent(client: Pick<Pool, 'query'> | PoolClient, patientId: string, mealId: string): Promise<void> {
  const sending = (await client.query(
    `SELECT 1 FROM remote_commands
     WHERE patient_id = $1::uuid AND (meal_record_id = $2::uuid OR target_meal_record_id = $2::uuid)
       AND status IN ('AUTHORIZED', 'SENT', 'TRIO_ACCEPTED') LIMIT 1`,
    [patientId, mealId],
  )).rowCount;
  if (sending) throw new ConflictError('MEAL_DELETE_SENDING: Dla tego posiłku właśnie wysyłana jest dawka. Spróbuj ponownie, gdy pętla odpowie.');
}

export class PostgresMealMergeRepository {
  constructor(private readonly pool: Pool) {}

  async merge(write: MealMergeWrite): Promise<void> {
    const { patientId, targetId, sourceIds } = write;
    if (!UUID_PATTERN.test(patientId)) throw new ValidationError(`Invalid patient id: ${patientId}`);
    if (sourceIds.length === 0 || sourceIds.includes(targetId) || ![targetId, ...sourceIds].every((id) => UUID_PATTERN.test(id))) {
      throw new ValidationError('A merge needs a meal and at least one other meal');
    }
    const all = [targetId, ...sourceIds];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`meal-history:${patientId}`]);
      const meals = (await client.query<{ id: string }>(
        `SELECT id::text FROM meal_records WHERE patient_id = $1::uuid AND id = ANY($2::uuid[]) AND status <> 'CANCELLED' FOR UPDATE`,
        [patientId, all],
      )).rows;
      if (meals.length !== all.length) throw new NotFoundError('Meal not found');
      // A legacy meal chained to one of them would go with its record (the chain cannot be moved).
      const chained = (await client.query(
        `SELECT 1 FROM meal_records WHERE patient_id = $1::uuid AND chained_to_meal_record_id = ANY($2::uuid[]) LIMIT 1`,
        [patientId, sourceIds],
      )).rowCount;
      if (chained) throw new ConflictError('MEAL_MERGE_CHAINED: Jednego z tych posiłków nie można scalić, bo zależy od niego inny wpis.');
      // A dose being sent for one of them: its answer must find the meal it was sent for.
      const sending = (await client.query(
        `SELECT 1 FROM remote_commands
         WHERE patient_id = $1::uuid AND (meal_record_id = ANY($2::uuid[]) OR target_meal_record_id = ANY($2::uuid[]))
           AND status IN ('AUTHORIZED', 'SENT', 'TRIO_ACCEPTED') LIMIT 1`,
        [patientId, all],
      )).rowCount;
      if (sending) throw new ConflictError('MEAL_MERGE_SENDING: Dla jednego z tych posiłków właśnie wysyłana jest dawka. Spróbuj ponownie, gdy pętla odpowie.');

      const carbsBefore = write.split === 'KEEP' ? await mealCarbs(client, patientId, targetId) : null;
      await this.moveRows(client, write);
      await this.mergeContent(client, write);

      // The others' carb entries join the merged meal (memberships are immutable: deleted and inserted again).
      const entries = (await client.query<{ event_id: string }>(
        `DELETE FROM meal_record_entries WHERE patient_id = $1::uuid AND meal_record_id = ANY($2::uuid[]) RETURNING event_id::text`,
        [patientId, sourceIds],
      )).rows.map((row) => row.event_id);
      if (entries.length > 0) {
        await client.query(
          `INSERT INTO meal_record_entries (patient_id, event_id, meal_record_id, occurred_at)
           SELECT e.patient_id, e.id, $3::uuid, e.occurred_at FROM events e WHERE e.patient_id = $1::uuid AND e.id = ANY($2::uuid[])`,
          [patientId, entries, targetId],
        );
      }
      await client.query(
        `INSERT INTO meal_merges (patient_id, meal_record_id, merged_meal_ids, content, split, merged_by_user_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid[], $4, $5, $6::uuid)`,
        [patientId, targetId, sourceIds, write.content, write.split, write.userId],
      );
      await client.query(`DELETE FROM meal_records WHERE patient_id = $1::uuid AND id = ANY($2::uuid[])`, [patientId, sourceIds]);
      if (carbsBefore !== null) {
        // "Zostaw podział": the later parts stay as they are. Their meal's carbs grew by the merge, not by a change of
        // what was eaten, so a later edit of the meal moves the parts only by that edit.
        const carbsAfter = await mealCarbs(client, patientId, targetId);
        if (carbsAfter !== null && carbsAfter !== carbsBefore) {
          await client.query(
            `UPDATE planned_boluses SET meal_carbs_g = meal_carbs_g + $3::numeric, updated_at = now()
             WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid AND meal_carbs_g IS NOT NULL`,
            [patientId, targetId, carbsAfter - carbsBefore],
          );
        }
      }
      // The merged meal starts with its earliest entry: its WBT reminder follows.
      await followWbtRemindersToMealStart(client, patientId, [targetId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** A dose being sent for this meal: its answer must find the meal it was sent for, so the meal cannot go yet. */
  async assertNoDoseBeingSent(patientId: string, mealId: string): Promise<void> {
    await assertNoDoseBeingSent(this.pool, patientId, mealId);
  }

  /**
   * "Usuń" in the Meals tab: the meal leaves the journal, the meal page and the AI's meal list (status CANCELLED), and
   * nothing about it reminds anyone any more. Its loop entries, sent commands and given doses stay as history, so the
   * entries are not asked about again and the loop's carbs and insulin are untouched. False: it was already deleted.
   */
  async deleteMeal(patientId: string, mealId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(patientId) || !UUID_PATTERN.test(mealId)) throw new ValidationError('Invalid meal id');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`meal-history:${patientId}`]);
      const meal = (await client.query<{ status: string }>(
        `SELECT status FROM meal_records WHERE patient_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
        [patientId, mealId],
      )).rows[0];
      if (!meal) throw new NotFoundError('Meal not found');
      if (meal.status === 'CANCELLED') {
        await client.query('COMMIT');
        return false;
      }
      await assertNoDoseBeingSent(client, patientId, mealId);
      await client.query(`UPDATE meal_records SET status = 'CANCELLED', updated_at = now() WHERE patient_id = $1::uuid AND id = $2::uuid`, [patientId, mealId]);
      await client.query(
        `UPDATE care_reminders SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
         WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid AND status = 'ACTIVE'`,
        [patientId, mealId],
      );
      await client.query(
        `UPDATE meal_wbt_reminders SET enabled = false, status = 'SKIPPED', updated_at = now()
         WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid AND status = 'SCHEDULED'`,
        [patientId, mealId],
      );
      await client.query(
        `UPDATE conversation_meal_actions SET status = 'STALE', updated_at = now()
         WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid AND status IN ('PROPOSED', 'APPLYING')`,
        [patientId, mealId],
      );
      await client.query(`DELETE FROM meal_dose_excess_notices WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid`, [patientId, mealId]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async moveRows(client: PoolClient, write: MealMergeWrite): Promise<void> {
    const { patientId, targetId, sourceIds } = write;
    const all = [targetId, ...sourceIds];
    const params = [patientId, sourceIds, targetId];
    // The other meals' first entries are now additions to the merged meal; every other bolus keeps its purpose.
    await client.query(
      `UPDATE loop_actions SET purpose = CASE WHEN purpose = 'NEW_MEAL' THEN 'MEAL_ADDITION' ELSE purpose END,
              meal_record_id = $3::uuid, updated_at = now()
       WHERE patient_id = $1::uuid AND meal_record_id = ANY($2::uuid[])`,
      params,
    );
    await client.query(
      `UPDATE remote_commands SET meal_record_id = CASE WHEN meal_record_id = ANY($2::uuid[]) THEN $3::uuid ELSE meal_record_id END,
              target_meal_record_id = CASE WHEN target_meal_record_id = ANY($2::uuid[]) THEN $3::uuid ELSE target_meal_record_id END
       WHERE patient_id = $1::uuid AND (meal_record_id = ANY($2::uuid[]) OR target_meal_record_id = ANY($2::uuid[]))`,
      params,
    );
    // At most one meal has parts still to come (planMealMerge), so the open-part index holds.
    await client.query(`UPDATE planned_boluses SET meal_record_id = $3::uuid, updated_at = now() WHERE patient_id = $1::uuid AND meal_record_id = ANY($2::uuid[])`, params);
    // One second dose per meal (073): the one still to come, else the newest, stays; the others' settled ones go.
    await client.query(
      `DELETE FROM care_reminders c
       WHERE c.patient_id = $1::uuid AND c.kind = 'SECOND_DOSE' AND c.meal_record_id = ANY($2::uuid[])
         AND c.id <> (SELECT k.id FROM care_reminders k
                      WHERE k.patient_id = $1::uuid AND k.kind = 'SECOND_DOSE' AND k.meal_record_id = ANY($2::uuid[])
                      ORDER BY (k.status IN ('ACTIVE', 'FIRED')) DESC, k.created_at DESC LIMIT 1)`,
      [patientId, all],
    );
    await client.query(`UPDATE care_reminders SET meal_record_id = $3::uuid WHERE patient_id = $1::uuid AND meal_record_id = ANY($2::uuid[])`, params);
    // Chat cards about the meals point at the merged one; a waiting one was worked out for one meal and cannot be applied.
    await client.query(
      `UPDATE conversation_meal_actions
       SET meal_record_id = CASE WHEN meal_record_id = ANY($2::uuid[]) THEN $3::uuid ELSE meal_record_id END,
           status = CASE WHEN status IN ('PROPOSED', 'APPLYING') THEN 'STALE' ELSE status END, updated_at = now()
       WHERE patient_id = $1::uuid AND meal_record_id = ANY($4::uuid[])`,
      [...params, all],
    );
    await client.query(`UPDATE meal_photos SET meal_record_id = $3::uuid WHERE patient_id = $1::uuid AND meal_record_id = ANY($2::uuid[])`, params);
    await client.query(`UPDATE meal_chat_messages SET meal_record_id = $3::uuid WHERE patient_id = $1::uuid AND meal_record_id = ANY($2::uuid[])`, params);
    // WBT: one reminder per meal. The merged meal's own stays, else the earliest of the others'.
    await client.query(
      `DELETE FROM meal_wbt_reminders w
       WHERE w.patient_id = $1::uuid AND w.meal_record_id = ANY($2::uuid[])
         AND (EXISTS (SELECT 1 FROM meal_wbt_reminders t WHERE t.patient_id = $1::uuid AND t.meal_record_id = $3::uuid)
              OR w.meal_record_id <> (SELECT o.meal_record_id FROM meal_wbt_reminders o
                                      WHERE o.patient_id = $1::uuid AND o.meal_record_id = ANY($2::uuid[])
                                      ORDER BY o.remind_at, o.meal_record_id LIMIT 1))`,
      params,
    );
    await client.query(`UPDATE meal_wbt_reminders SET meal_record_id = $3::uuid, updated_at = now() WHERE patient_id = $1::uuid AND meal_record_id = ANY($2::uuid[])`, params);
    // A WBT dose worked out for one part of the meal is not the whole meal's: the next one is asked for again.
    await client.query(`DELETE FROM meal_wbt_suggestions WHERE patient_id = $1::uuid AND meal_record_id = ANY($2::uuid[])`, [patientId, all]);
    // The WBT chat: the merged meal's own stays; another's joins it when it has none, the rest keep only their history.
    await client.query(
      `UPDATE conversations SET wbt_meal_record_id = CASE
         WHEN id = (SELECT c.id FROM conversations c WHERE c.patient_id = $1::uuid AND c.wbt_meal_record_id = ANY($2::uuid[]) AND c.deleted_at IS NULL
                    AND NOT EXISTS (SELECT 1 FROM conversations t WHERE t.patient_id = $1::uuid AND t.wbt_meal_record_id = $3::uuid AND t.deleted_at IS NULL)
                    ORDER BY c.created_at LIMIT 1)
         THEN $3::uuid ELSE NULL END
       WHERE patient_id = $1::uuid AND wbt_meal_record_id = ANY($2::uuid[])`,
      params,
    );
    // Excess notices are per meal and worked out again for the merged one.
    await client.query(`DELETE FROM meal_dose_excess_notices WHERE patient_id = $1::uuid AND meal_record_id = ANY($2::uuid[])`, [patientId, sourceIds]);
  }

  /** RESET: no description or values; KEPT: the one meal's, with the other meals' carbs added; NONE: nothing to do. */
  private async mergeContent(client: PoolClient, write: MealMergeWrite): Promise<void> {
    const { patientId, targetId } = write;
    if (write.content === 'RESET') {
      await client.query(
        `UPDATE meal_records SET status = 'AWAITING_DESCRIPTION', description = NULL, photo_ref = NULL, proposal = NULL,
                confirmed_macros = NULL, confirmed_by = NULL, confirmed_at = NULL, confirmed_items = NULL, updated_at = now()
         WHERE patient_id = $1::uuid AND id = $2::uuid`,
        [patientId, targetId],
      );
      return;
    }
    if (write.content === 'KEPT' && write.contentMealId && write.contentMealId !== targetId) {
      await client.query(
        `UPDATE meal_records t SET status = s.status, description = s.description, photo_ref = s.photo_ref, proposal = s.proposal,
                confirmed_macros = s.confirmed_macros, confirmed_by = s.confirmed_by, confirmed_at = s.confirmed_at,
                confirmed_items = s.confirmed_items, updated_at = now()
         FROM meal_records s
         WHERE t.patient_id = $1::uuid AND t.id = $2::uuid AND s.patient_id = $1::uuid AND s.id = $3::uuid`,
        [patientId, targetId, write.contentMealId],
      );
    }
    if (write.addedCarbsG <= 0) return;
    // Kept carbs were one meal's: the merged meal ate the others' too. Carbs read from the loop's entries need nothing.
    await client.query(
      `UPDATE meal_records SET
         confirmed_macros = CASE WHEN status IN ('CONFIRMED', 'CORRECTED') AND jsonb_typeof(confirmed_macros->'carbs'->'grams') = 'number'
           THEN jsonb_set(confirmed_macros, '{carbs,grams}', to_jsonb(round(((confirmed_macros->'carbs'->>'grams')::numeric + $3::numeric), 1)))
           ELSE confirmed_macros END,
         proposal = CASE WHEN status = 'AI_PROPOSED' AND jsonb_typeof(proposal->'carbs_g') = 'number'
           THEN jsonb_set(proposal, '{carbs_g}', to_jsonb(round(((proposal->>'carbs_g')::numeric + $3::numeric), 1)))
           ELSE proposal END,
         updated_at = now()
       WHERE patient_id = $1::uuid AND id = $2::uuid`,
      [patientId, targetId, write.addedCarbsG],
    );
  }
}

/** The meal's carbs as its record reads them: stored values (confirmed, or the AI's proposal), else its food entries. */
async function mealCarbs(client: PoolClient, patientId: string, mealId: string): Promise<number | null> {
  const row = (await client.query(
    `SELECT CASE
       WHEN r.status IN ('CONFIRMED', 'CORRECTED') AND jsonb_typeof(r.confirmed_macros->'carbs'->'grams') = 'number' THEN (r.confirmed_macros->'carbs'->>'grams')::numeric
       WHEN r.status = 'AI_PROPOSED' AND jsonb_typeof(r.proposal->'carbs_g') = 'number' THEN (r.proposal->>'carbs_g')::numeric
       ELSE (SELECT sum(CASE WHEN ev.payload->>'carbs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (ev.payload->>'carbs')::numeric END)
             FROM meal_record_entries e JOIN events ev ON ev.id = e.event_id AND ev.patient_id = e.patient_id
             LEFT JOIN carb_entry_kinds k ON k.patient_id = e.patient_id AND k.event_id = e.event_id
             WHERE e.meal_record_id = r.id AND COALESCE(k.kind, 'MEAL') = 'MEAL')
     END AS carbs
     FROM meal_records r WHERE r.patient_id = $1::uuid AND r.id = $2::uuid`,
    [patientId, mealId],
  )).rows[0];
  return row?.carbs === null || row?.carbs === undefined ? null : Number(row.carbs);
}
