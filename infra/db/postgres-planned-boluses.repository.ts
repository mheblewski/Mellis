import type { Pool } from 'pg';
import { OPEN_PLANNED_BOLUS_STATUSES, type LaterTrigger, type PlannedBolusRecord, type PlannedBolusStatus } from '@modules/remote-commands/application/split-bolus';
import { LIVE_COMMAND_STATUSES } from '@modules/remote-commands/application/planned-bolus.service';

/** PostgreSQL storage of planned later parts of meal boluses (migrations 050, 060, 063, 066, 076, 077). */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toIso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string | Date).toISOString());
const num = (value: unknown): number | null => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));

const SELECT_PLAN = `SELECT p.*, u.display_name AS resolved_by_name FROM planned_boluses p LEFT JOIN users u ON u.id = p.resolved_by_user_id`;
/** The part whose reminder came, else the next open one, else the newest settled one. */
const CURRENT_PART_ORDER = `ORDER BY (p.status = 'NOTIFIED') DESC, (p.status = 'SCHEDULED') DESC,
  CASE WHEN p.status IN ('NOTIFIED', 'SCHEDULED') THEN p.due_at END ASC, p.created_at DESC`;

export type NewPlannedBolus = Omit<PlannedBolusRecord, 'id' | 'status' | 'notified_at' | 'resolved_at' | 'resolved_by_user_id' | 'resolved_by_name' | 'given_command_id' | 'given_loop_action_id' | 'given_insulin_u' | 'created_at'>;

export class PostgresPlannedBolusRepository {
  constructor(private readonly pool: Pool) {}

  /** Stores the plan of a meal's second part; null when the meal already has an open plan or the command made one. */
  async create(plan: NewPlannedBolus): Promise<PlannedBolusRecord | null> {
    const row = (await this.pool.query(
      `INSERT INTO planned_boluses (
         patient_id, meal_record_id, proposal_id, conversation_id, first_command_id, first_carbs_g, first_insulin_u,
         carbs_g, planned_insulin_u, icr_g_per_u, now_percent, delay_minutes, due_at, kind,
         trigger, threshold_mgdl, dose_carbs_g, fixed_insulin_u, drop_cover_g, subtract_first_insulin, wait_until, part_index, meal_carbs_g
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, $14,
         $15, $16, $17, $18, $19, $20, $21::timestamptz, $22, $23)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        plan.patient_id, plan.meal_record_id, plan.proposal_id, plan.conversation_id, plan.first_command_id, plan.first_carbs_g,
        plan.first_insulin_u, plan.carbs_g, plan.planned_insulin_u, plan.icr_g_per_u, plan.now_percent, plan.delay_minutes, plan.due_at,
        plan.kind, plan.trigger, plan.threshold_mgdl, plan.dose_carbs_g, plan.fixed_insulin_u, plan.drop_cover_g,
        plan.subtract_first_insulin, plan.wait_until, plan.part_index ?? 0, plan.meal_carbs_g ?? null,
      ],
    )).rows[0];
    return row ? this.get(plan.patient_id, String(row.id)) : null;
  }

  async get(patientId: string, planId: string): Promise<PlannedBolusRecord | null> {
    if (!UUID_PATTERN.test(planId)) return null;
    const row = (await this.pool.query(`${SELECT_PLAN} WHERE p.patient_id = $1::uuid AND p.id = $2::uuid`, [patientId, planId])).rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * The meal's current plan, as its page shows it: the open part whose reminder came, else the next open one, else the
   * newest settled one (a card may plan several parts, migration 066).
   */
  async latestForMeal(patientId: string, mealRecordId: string): Promise<PlannedBolusRecord | null> {
    if (!UUID_PATTERN.test(mealRecordId)) return null;
    const row = (await this.pool.query(
      `${SELECT_PLAN} WHERE p.patient_id = $1::uuid AND p.meal_record_id = $2::uuid ${CURRENT_PART_ORDER} LIMIT 1`,
      [patientId, mealRecordId],
    )).rows[0];
    return row ? toRecord(row) : null;
  }

  /** The plans made from these chat cards (one per card at most). */
  async listForProposals(patientId: string, proposalIds: string[]): Promise<Map<string, PlannedBolusRecord>> {
    const ids = proposalIds.filter((id) => UUID_PATTERN.test(id));
    if (ids.length === 0) return new Map();
    const rows = (await this.pool.query(
      `SELECT DISTINCT ON (q.proposal_id) q.* FROM (${SELECT_PLAN} WHERE p.patient_id = $1::uuid AND p.proposal_id = ANY($2::uuid[])) q
       ORDER BY q.proposal_id, (q.status = 'NOTIFIED') DESC, (q.status = 'SCHEDULED') DESC,
                CASE WHEN q.status IN ('NOTIFIED', 'SCHEDULED') THEN q.due_at END ASC, q.created_at DESC`,
      [patientId, ids],
    )).rows;
    return new Map(rows.map((row) => [String(row.proposal_id), toRecord(row)]));
  }

  /** Every plan of a meal, oldest card first and in part order (its time line). */
  async listForMeal(patientId: string, mealRecordId: string): Promise<PlannedBolusRecord[]> {
    if (!UUID_PATTERN.test(mealRecordId)) return [];
    const rows = (await this.pool.query(
      `${SELECT_PLAN} WHERE p.patient_id = $1::uuid AND p.meal_record_id = $2::uuid ORDER BY p.created_at, p.part_index`,
      [patientId, mealRecordId],
    )).rows;
    return rows.map(toRecord);
  }

  /** Every plan of these meals, in each meal's time line order (the Meals tab's journal reads a page at once). */
  async listForMeals(patientId: string, mealRecordIds: string[]): Promise<PlannedBolusRecord[]> {
    const ids = mealRecordIds.filter((id) => UUID_PATTERN.test(id));
    if (ids.length === 0) return [];
    const rows = (await this.pool.query(
      `${SELECT_PLAN} WHERE p.patient_id = $1::uuid AND p.meal_record_id = ANY($2::uuid[]) ORDER BY p.meal_record_id, p.created_at, p.part_index`,
      [patientId, ids],
    )).rows;
    return rows.map(toRecord);
  }

  /** Every part planned from these chat cards, in order (a card may plan several, migration 066). */
  async listAllForProposals(patientId: string, proposalIds: string[]): Promise<Map<string, PlannedBolusRecord[]>> {
    const ids = proposalIds.filter((id) => UUID_PATTERN.test(id));
    if (ids.length === 0) return new Map();
    const rows = (await this.pool.query(
      `${SELECT_PLAN} WHERE p.patient_id = $1::uuid AND p.proposal_id = ANY($2::uuid[]) ORDER BY p.proposal_id, p.part_index, p.created_at`,
      [patientId, ids],
    )).rows;
    const byProposal = new Map<string, PlannedBolusRecord[]>();
    for (const row of rows) {
      const key = String(row.proposal_id);
      byProposal.set(key, [...(byProposal.get(key) ?? []), toRecord(row)]);
    }
    return byProposal;
  }

  /** Open plans of every patient (the worker settles, expires and sends them). */
  /**
   * Loop actions of a meal that are already some dose's: a part given by them, or the loop action of a remote command
   * for the meal (the card's own bolus, a part sent from the app). A manual addition never comes from them.
   */
  async usedLoopActionIds(patientId: string, mealRecordId: string): Promise<Set<string>> {
    if (!UUID_PATTERN.test(mealRecordId)) return new Set();
    const rows = (await this.pool.query(
      `SELECT given_loop_action_id AS id FROM planned_boluses WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid AND given_loop_action_id IS NOT NULL
       UNION
       SELECT loop_action_id AS id FROM remote_commands WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid AND loop_action_id IS NOT NULL`,
      [patientId, mealRecordId],
    )).rows;
    return new Set(rows.map((row) => String(row.id)));
  }

  /** One patient's open plans (therapy-now.v1: what the conversation prompts see). */
  async listOpenForPatient(patientId: string): Promise<PlannedBolusRecord[]> {
    const rows = (await this.pool.query(`${SELECT_PLAN} WHERE p.patient_id = $1::uuid AND p.status = ANY($2::text[]) ORDER BY p.due_at`, [patientId, OPEN_PLANNED_BOLUS_STATUSES])).rows;
    return rows.map(toRecord);
  }

  async listOpen(): Promise<PlannedBolusRecord[]> {
    const rows = (await this.pool.query(`${SELECT_PLAN} WHERE p.status = ANY($1::text[]) ORDER BY p.due_at`, [OPEN_PLANNED_BOLUS_STATUSES])).rows;
    return rows.map(toRecord);
  }

  /** SCHEDULED -> NOTIFIED once (two workers never send the reminder twice). */
  async markNotified(patientId: string, planId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE planned_boluses SET status = 'NOTIFIED', notified_at = now(), updated_at = now()
       WHERE patient_id = $1::uuid AND id = $2::uuid AND status = 'SCHEDULED'`,
      [patientId, planId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * A part follows a change of its meal's carbs (migrations 076, 077): its numbers, the meal's carbs they are for now and
   * what it took of changes; emptied, it is cancelled by the change, and given carbs again, scheduled again. Only open
   * parts and parts a meal change cancelled; false when the part was settled otherwise in the meantime.
   */
  async followMealChange(patientId: string, planId: string, fields: { carbs_g: number; dose_carbs_g: number | null; planned_insulin_u: number; meal_carbs_g: number; meal_change_g: number; cancel: boolean; reopen: boolean; meal_excess_g?: number }): Promise<boolean> {
    // A part that was already pushed comes back as NOTIFIED (audit 2026-10-26): its reminder is not sent a second time.
    const result = await this.pool.query(
      `UPDATE planned_boluses
       SET carbs_g = $3, dose_carbs_g = $4, planned_insulin_u = $5, meal_carbs_g = $6, meal_change_g = $7,
           meal_excess_g = $11,
           status = CASE WHEN $9 THEN 'CANCELLED' WHEN $10 THEN (CASE WHEN notified_at IS NOT NULL THEN 'NOTIFIED' ELSE 'SCHEDULED' END) ELSE status END,
           resolved_at = CASE WHEN $9 THEN now() WHEN $10 THEN NULL ELSE resolved_at END,
           cancelled_by_meal_change = CASE WHEN $9 THEN true WHEN $10 THEN false ELSE cancelled_by_meal_change END,
           updated_at = now()
       WHERE patient_id = $1::uuid AND id = $2::uuid
         AND (status = ANY($8::text[]) OR (status = 'CANCELLED' AND cancelled_by_meal_change))`,
      [patientId, planId, fields.carbs_g, fields.dose_carbs_g, fields.planned_insulin_u, fields.meal_carbs_g, fields.meal_change_g, OPEN_PLANNED_BOLUS_STATUSES, fields.cancel, fields.reopen, fields.meal_excess_g ?? 0],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Settles an open plan (given, skipped, expired, cancelled); null when it was settled already. */
  async resolve(patientId: string, planId: string, to: Exclude<PlannedBolusStatus, 'SCHEDULED' | 'NOTIFIED'>, fields: {
    user_id?: string | null;
    command_id?: string | null;
    loop_action_id?: string | null;
    insulin_u?: number | null;
  } = {}): Promise<PlannedBolusRecord | null> {
    const row = (await this.pool.query(
      `UPDATE planned_boluses
       SET status = $3, resolved_at = now(), resolved_by_user_id = $4::uuid, given_command_id = $5::uuid,
           given_loop_action_id = $6::uuid, given_insulin_u = $7, updated_at = now()
       WHERE patient_id = $1::uuid AND id = $2::uuid AND status = ANY($8::text[])
         -- "Pomiń" while the other caregiver's command for the part is on its way or delivered: not skipped.
         AND ($3 <> 'SKIPPED' OR NOT EXISTS (
           SELECT 1 FROM remote_commands rc
           WHERE rc.patient_id = $1::uuid AND rc.planned_bolus_id = $2::uuid AND rc.status = ANY($9::text[])
         ))
       RETURNING id`,
      [
        patientId, planId, to, fields.user_id ?? null, fields.command_id ?? null, fields.loop_action_id ?? null, fields.insulin_u ?? null,
        // A part skipped in the moment its command was sent is still given by that command (it reached the loop).
        to === 'GIVEN' && fields.command_id ? [...OPEN_PLANNED_BOLUS_STATUSES, 'SKIPPED'] : OPEN_PLANNED_BOLUS_STATUSES,
        LIVE_COMMAND_STATUSES,
      ],
    )).rows[0];
    return row ? this.get(patientId, String(row.id)) : null;
  }
}

function toRecord(row: Record<string, unknown>): PlannedBolusRecord {
  return {
    id: String(row.id),
    kind: row.kind === 'DEFERRED_INSULIN' ? 'DEFERRED_INSULIN' : 'SPLIT',
    patient_id: String(row.patient_id),
    meal_record_id: String(row.meal_record_id),
    proposal_id: row.proposal_id ? String(row.proposal_id) : null,
    conversation_id: row.conversation_id ? String(row.conversation_id) : null,
    first_command_id: row.first_command_id ? String(row.first_command_id) : null,
    first_carbs_g: Number(row.first_carbs_g),
    first_insulin_u: Number(row.first_insulin_u),
    carbs_g: Number(row.carbs_g),
    planned_insulin_u: Number(row.planned_insulin_u),
    icr_g_per_u: num(row.icr_g_per_u),
    now_percent: Number(row.now_percent),
    delay_minutes: Number(row.delay_minutes),
    due_at: toIso(row.due_at) as string,
    status: row.status as PlannedBolusStatus,
    notified_at: toIso(row.notified_at),
    resolved_at: toIso(row.resolved_at),
    resolved_by_user_id: row.resolved_by_user_id ? String(row.resolved_by_user_id) : null,
    resolved_by_name: (row.resolved_by_name as string | null) ?? null,
    given_command_id: row.given_command_id ? String(row.given_command_id) : null,
    given_loop_action_id: row.given_loop_action_id ? String(row.given_loop_action_id) : null,
    given_insulin_u: num(row.given_insulin_u),
    created_at: toIso(row.created_at) as string,
    trigger: typeof row.trigger === 'string' ? row.trigger as LaterTrigger : null,
    threshold_mgdl: num(row.threshold_mgdl),
    dose_carbs_g: num(row.dose_carbs_g),
    fixed_insulin_u: num(row.fixed_insulin_u),
    drop_cover_g: num(row.drop_cover_g),
    subtract_first_insulin: row.subtract_first_insulin === true,
    wait_until: toIso(row.wait_until),
    part_index: num(row.part_index) ?? 0,
    meal_carbs_g: num(row.meal_carbs_g),
    meal_change_g: num(row.meal_change_g) ?? 0,
    cancelled_by_meal_change: row.cancelled_by_meal_change === true,
    meal_excess_g: num(row.meal_excess_g) ?? 0,
  };
}
