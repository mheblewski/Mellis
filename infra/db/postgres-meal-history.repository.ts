import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError, NotFoundError, StaleWriteError, ValidationError } from '@shared/errors/app-error';
import { EvidenceAuthoritativeEligibilityService } from '@modules/evidence-exclusion/application/evidence-authoritative-eligibility.service';
import { PostgresEvidenceExclusionRepository } from './postgres-evidence-exclusion.repository';
import { followWbtRemindersToMealStart } from './postgres-meal-wbt.repository';
import { NEW_MEAL_ASSIGNMENT_POLICY } from '@modules/meal-candidates/application/meal-history-boundary';
import { buildNewMealId } from '@modules/meal-candidates/application/new-meal-assignment';
import { canTransitionMealRecord, type MacroValue, type MealRecord, type MealRecordStatus } from '@modules/meal-candidates/application/meal-record-trust';
import { itemsMatchTotals, readStoredMealItems, type MealItem } from '@modules/meal-candidates/application/meal-items';

/**
 * PostgreSQL storage for meal records (migration 027_meal_history.sql): their content and trust state, and the
 * entries taken out of a meal (meal_record_entry_detachments, migration 035). Meals start from loop actions
 * (postgres-loop-actions.repository.ts); nothing here joins carb entries into meals automatically.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toIso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

export type MealEntryDetachReason = 'CAREGIVER' | 'ANCHOR_NOT_A_MEAL';

export interface MealEntryDetachResult {
  /** Entries taken out of the meal (empty when there was nothing to detach). */
  detached_event_ids: string[];
  /** Record id of the meal the entries now form, or null when none of them could start a meal. */
  meal_record_id: string | null;
}

interface MealMemberRow {
  meal_record_id: string;
  meal_identity: string;
  epoch_id: string;
  assignment_policy_version: string;
  anchor_event_id: string;
  event_id: string;
  kind: string;
}

/**
 * Takes carb entries out of a meal they joined and makes them a meal of their own (meal_record_entry_detachments,
 * migration 035), under the per-patient meal lock (as loop actions). The detached entries keep their order; the earliest one
 * that may anchor a meal (LIVE, first stored inside the still active epoch) starts it and the rest join it. The new
 * meal waits for a description in the app; it gets no push (the caregiver is the one detaching).
 */
export class PostgresMealEntryDetachment {
  constructor(private readonly pool: Pool) {}

  /** Caregiver: this entry was a separate meal. Refused for the entry that started the meal. */
  async detachEntry(patientId: string, eventId: string, userId: string | null): Promise<MealEntryDetachResult> {
    return this.runExclusive(patientId, async (client) => {
      const members = await this.loadMembersOfMealContaining(client, patientId, eventId);
      const entry = members.find((member) => member.event_id === eventId);
      if (!entry) throw new NotFoundError('Carb entry is not part of a meal');
      if (entry.anchor_event_id === eventId) throw new ConflictError('The entry that started a meal cannot be detached from it');
      return this.moveToNewMeal(client, patientId, entry, [eventId], 'CAREGIVER', userId);
    });
  }

  /**
   * After the first entry of a meal was marked as not a meal (correction carbs, hypo treatment, WBT, deleted), its
   * other entries still marked as a meal become a meal of their own. No-op when the entry starts no meal.
   */
  async detachMealEntriesFromNonMealAnchor(patientId: string, anchorEventId: string, userId: string | null): Promise<MealEntryDetachResult> {
    return this.runExclusive(patientId, async (client) => {
      const members = await this.loadMembersOfMealContaining(client, patientId, anchorEventId);
      const anchor = members.find((member) => member.event_id === anchorEventId);
      if (!anchor || anchor.anchor_event_id !== anchorEventId || anchor.kind === 'MEAL') {
        return { detached_event_ids: [], meal_record_id: null };
      }
      const meals = members.filter((member) => member.event_id !== anchorEventId && member.kind === 'MEAL').map((member) => member.event_id);
      if (meals.length === 0) return { detached_event_ids: [], meal_record_id: null };
      return this.moveToNewMeal(client, patientId, anchor, meals, 'ANCHOR_NOT_A_MEAL', userId);
    });
  }

  private async runExclusive<T>(patientId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!UUID_PATTERN.test(patientId)) throw new ValidationError(`Invalid patient id for meal history: ${patientId}`);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`meal-history:${patientId}`]);
      const result = await work(client);
      await client.query('COMMIT');
      client.release();
      return result;
    } catch (error) {
      releaseAfterFailure(client, await rollbackQuietly(client));
      throw error;
    }
  }

  /** All entries of the meal the event belongs to (with their caregiver-set kind), oldest first; [] when none. */
  private async loadMembersOfMealContaining(client: PoolClient, patientId: string, eventId: string): Promise<MealMemberRow[]> {
    if (!UUID_PATTERN.test(eventId)) return [];
    return (await client.query<MealMemberRow>(
      `SELECT r.id::text AS meal_record_id, r.meal_identity, r.epoch_id::text, r.assignment_policy_version,
              r.anchor_event_id::text, e.event_id::text, COALESCE(k.kind, 'MEAL') AS kind
       FROM meal_record_entries own
       JOIN meal_records r ON r.id = own.meal_record_id AND r.patient_id = own.patient_id
       JOIN meal_record_entries e ON e.meal_record_id = r.id AND e.patient_id = r.patient_id
       LEFT JOIN carb_entry_kinds k ON k.patient_id = e.patient_id AND k.event_id = e.event_id
       WHERE own.patient_id = $1::uuid AND own.event_id = $2::uuid
       ORDER BY e.occurred_at, e.event_id`,
      [patientId, eventId],
    )).rows;
  }

  private async moveToNewMeal(
    client: PoolClient,
    patientId: string,
    from: Pick<MealMemberRow, 'meal_record_id' | 'meal_identity' | 'epoch_id' | 'assignment_policy_version'>,
    eventIds: string[],
    reason: MealEntryDetachReason,
    userId: string | null,
  ): Promise<MealEntryDetachResult> {
    await client.query(
      `DELETE FROM meal_record_entries WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid AND event_id = ANY($3::uuid[])`,
      [patientId, from.meal_record_id, eventIds],
    );
    // The meal may start later now: its WBT reminder follows (audit 2026-10-26).
    await followWbtRemindersToMealStart(client, patientId, [from.meal_record_id]);

    // Same eligibility as meal_records_guard_insert: a LIVE entry first stored inside the meal's still active epoch.
    const anchor = (await client.query<{ event_id: string }>(
      `SELECT ev.id::text AS event_id
       FROM events ev
       JOIN meal_history_epochs ep ON ep.id = $3::uuid AND ep.patient_id = ev.patient_id AND ep.retired_at IS NULL
       WHERE ev.patient_id = $1::uuid AND ev.id = ANY($2::uuid[])
         AND ev.type = 'CARB_ENTRY' AND ev.event_ingestion_origin = 'LIVE'
         AND COALESCE(ev.payload->>'entry_source', '') <> 'GLUCOMIND'
         AND ev.occurred_at >= ep.starts_at AND ev.created_at >= ep.starts_at
       ORDER BY ev.occurred_at, ev.id
       LIMIT 1`,
      [patientId, eventIds, from.epoch_id],
    )).rows[0];

    let mealRecordId: string | null = null;
    let mealIdentity: string | null = null;
    if (anchor) {
      mealIdentity = buildNewMealId(from.epoch_id, anchor.event_id, { ...NEW_MEAL_ASSIGNMENT_POLICY, version: from.assignment_policy_version });
      // The detachment row (below) records which meal the entries came from.
      mealRecordId = (await client.query<{ id: string }>(
        `INSERT INTO meal_records (patient_id, meal_identity, epoch_id, assignment_policy_version, anchor_event_id)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid)
         RETURNING id::text`,
        [patientId, mealIdentity, from.epoch_id, from.assignment_policy_version, anchor.event_id],
      )).rows[0].id;
      await client.query(
        `INSERT INTO meal_record_entries (patient_id, event_id, meal_record_id, occurred_at)
         SELECT ev.patient_id, ev.id, $3::uuid, ev.occurred_at
         FROM events ev
         WHERE ev.patient_id = $1::uuid AND ev.id = ANY($2::uuid[])`,
        [patientId, eventIds, mealRecordId],
      );
    }

    await client.query(
      `INSERT INTO meal_record_entry_detachments (patient_id, event_id, from_meal_identity, to_meal_identity, reason, detached_by_user_id)
       SELECT $1::uuid, event_id, $3, $4, $5, $6::uuid FROM unnest($2::uuid[]) AS event_id`,
      [patientId, eventIds, from.meal_identity, mealIdentity, reason, userId],
    );
    return { detached_event_ids: eventIds, meal_record_id: mealRecordId };
  }
}

/** Rolls back without masking the original error; returns the rollback failure, if any. */
async function rollbackQuietly(client: PoolClient): Promise<Error | undefined> {
  try {
    await client.query('ROLLBACK');
    return undefined;
  } catch (rollbackError) {
    return rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
  }
}

/** A client whose rollback failed may still be inside a transaction: destroy it instead of returning it to the pool. */
function releaseAfterFailure(client: PoolClient, rollbackError: Error | undefined): void {
  client.release(rollbackError ?? false);
}

export interface MacroProposalInput {
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  /** ai_executions id of the call that produced the proposal (this repository never calls a provider). */
  ai_execution_id: string | null;
}

interface StoredProposal extends MacroProposalInput {
  proposal_id: string;
  proposed_at: string;
  /** Caregiver input the proposal was computed from, so a later reader knows what the estimate was based on. */
  based_on: { description: string | null; photo_ref: string | null };
}

type StoredMacros = Record<'carbs' | 'protein' | 'fat', MacroValue>;

function assertGrams(value: number | null, name: string): void {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new ValidationError(`${name} must be a non-negative number or null`);
  }
}

/** Columns of one meal record (alias r) read by getMealRecord and listMealRecordsStartedBetween; see toMealRecord. */
const MEAL_RECORD_COLUMNS = `r.meal_identity, r.status, r.description, r.photo_ref, r.proposal, r.confirmed_macros, r.confirmed_items, r.content_revision,
              (SELECT array_agg(e.event_id::text) FROM meal_record_entries e WHERE e.meal_record_id = r.id) AS event_ids,
              (SELECT min(e.occurred_at) FROM meal_record_entries e WHERE e.meal_record_id = r.id) AS started_at,
              -- Only entries eaten as part of the meal: a joined WBT / correction-carbs / deleted entry is not food.
              (SELECT sum(CASE WHEN ev.payload->>'carbs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (ev.payload->>'carbs')::numeric END)
               FROM meal_record_entries e JOIN events ev ON ev.id = e.event_id AND ev.patient_id = e.patient_id
               LEFT JOIN carb_entry_kinds k ON k.patient_id = e.patient_id AND k.event_id = e.event_id
               WHERE e.meal_record_id = r.id AND COALESCE(k.kind, 'MEAL') = 'MEAL') AS source_carbs`;

function toMealRecord(row: Record<string, any>, evidenceExcluded: boolean): MealRecord {
  const none: MacroValue = { grams: null, origin: null };
  const status = row.status as MealRecordStatus;
  const macros = (() => {
    if ((status === 'CONFIRMED' || status === 'CORRECTED') && row.confirmed_macros) {
      const confirmed = row.confirmed_macros as StoredMacros;
      return { carbs: confirmed.carbs, protein: confirmed.protein, fat: confirmed.fat };
    }
    if (status === 'AI_PROPOSED' && row.proposal) {
      const proposal = row.proposal as StoredProposal;
      const proposed = (grams: number | null): MacroValue => ({ grams, origin: grams === null ? null : 'AI_PROPOSAL' });
      return { carbs: proposed(proposal.carbs_g), protein: proposed(proposal.protein_g), fat: proposed(proposal.fat_g) };
    }
    return { carbs: none, protein: none, fat: none };
  })();

  return {
    meal_identity: row.meal_identity,
    status,
    evidence_excluded: evidenceExcluded,
    started_at: toIso(row.started_at),
    source_carbs_g: row.source_carbs === null ? null : Number(row.source_carbs),
    description: row.description,
    has_photo: row.photo_ref !== null,
    macros,
    pending_proposal_id: status === 'AI_PROPOSED' && row.proposal ? (row.proposal as StoredProposal).proposal_id : null,
    content_revision: Number(row.content_revision),
    items: readStoredMealItems(row.confirmed_items),
  };
}

/**
 * Caregiver-facing lifecycle of a new-history meal record (meal-record-trust.v1). Transitions are validated by
 * canTransitionMealRecord under a row lock; the table CHECKs reject trusted statuses without a caregiver action.
 */
export class PostgresMealRecordRepository {
  private readonly eligibility: EvidenceAuthoritativeEligibilityService;

  constructor(private readonly pool: Pool, eligibility?: EvidenceAuthoritativeEligibilityService) {
    this.eligibility = eligibility ?? new EvidenceAuthoritativeEligibilityService(new PostgresEvidenceExclusionRepository(pool));
  }

  async getMealRecord(patientId: string, mealIdentity: string): Promise<MealRecord> {
    const row = (await this.pool.query(
      `SELECT ${MEAL_RECORD_COLUMNS}
       FROM meal_records r
       WHERE r.patient_id = $1::uuid AND r.meal_identity = $2`,
      [patientId, mealIdentity],
    )).rows[0];
    if (!row) throw new NotFoundError(`Meal record not found: ${mealIdentity}`);

    // Evidence exclusions are revocable and resolved at read time: the
    // membership stays, but a meal with an excluded entry or source record is not analytical evidence.
    const resolution = await this.eligibility.resolve({ patient_id: patientId, event_ids: row.event_ids ?? [] });
    return toMealRecord(row, resolution.excluded_event_ids.length > 0 || resolution.excluded_source_record_ids.length > 0);
  }

  /** meal_identity of a meal addressed by its record id (the id used in push deep links), or null. */
  async findMealIdentityById(patientId: string, mealRecordId: string): Promise<string | null> {
    if (!UUID_PATTERN.test(mealRecordId)) return null;
    const row = (await this.pool.query(
      `SELECT meal_identity FROM meal_records WHERE patient_id = $1::uuid AND id = $2::uuid`,
      [patientId, mealRecordId],
    )).rows[0];
    return row ? String(row.meal_identity) : null;
  }

  async getAnchorEventId(patientId: string, mealRecordId: string): Promise<string | null> {
    const result = await this.pool.query<{ anchor_event_id: string }>(
      `SELECT anchor_event_id::text FROM meal_records WHERE patient_id = $1::uuid AND id = $2::uuid`,
      [patientId, mealRecordId],
    );
    return result.rows[0]?.anchor_event_id ?? null;
  }

  /**
   * New-history meals started in [fromIso, toIso], as trust-model records for selectMealsForAiContext. A record whose
   * first entry the caregiver marked as not a meal (WBT, correction carbs, hypo treatment, deleted) is left out, as in
   * the meal calendar: it would reach the AI as an undescribed meal.
   */
  async listMealRecordsStartedBetween(patientId: string, fromIso: string, toIso: string): Promise<MealRecord[]> {
    // One query for the meals and one eligibility check for all their entries (not one per meal: a 90-day window
    // is hundreds of meals).
    const rows = (await this.pool.query(
      `WITH started AS (
         SELECT r.id, min(e.occurred_at) AS started_at
         FROM meal_records r
         JOIN meal_record_entries e ON e.meal_record_id = r.id
         LEFT JOIN carb_entry_kinds anchor_kind ON anchor_kind.patient_id = r.patient_id AND anchor_kind.event_id = r.anchor_event_id
         WHERE r.patient_id = $1::uuid
           AND COALESCE(anchor_kind.kind, 'MEAL') = 'MEAL'
         GROUP BY r.id
         HAVING min(e.occurred_at) >= $2::timestamptz AND min(e.occurred_at) <= $3::timestamptz
       )
       SELECT ${MEAL_RECORD_COLUMNS}
       FROM meal_records r
       JOIN started s ON s.id = r.id
       ORDER BY s.started_at, r.meal_identity`,
      [patientId, fromIso, toIso],
    )).rows;
    if (rows.length === 0) return [];

    // An excluded source record marks its linked events excluded too, so a meal is excluded exactly when one of
    // its own entries is in excluded_event_ids (the same answer as resolving each meal on its own).
    const resolution = await this.eligibility.resolve({ patient_id: patientId, event_ids: rows.flatMap((row) => (row.event_ids ?? []) as string[]) });
    const excludedEventIds = new Set(resolution.excluded_event_ids.map((id) => id.toLowerCase()));
    return rows.map((row) => toMealRecord(row, ((row.event_ids ?? []) as string[]).some((id) => excludedEventIds.has(id.trim().toLowerCase()))));
  }

  async recordDescription(patientId: string, mealIdentity: string, input: { description: string | null; photo_ref: string | null }): Promise<void> {
    if (!input.description?.trim() && !input.photo_ref) {
      throw new ValidationError('A meal description or photo is required');
    }
    await this.transition(patientId, mealIdentity, 'DESCRIBED', `description = $3, photo_ref = $4`, [input.description?.trim() || null, input.photo_ref]);
  }

  /**
   * Caregiver edits the meal description. A meal still awaiting one becomes DESCRIBED; any other keeps its status
   * and values (the update trigger records the previous description in revisions).
   */
  async updateDescription(patientId: string, mealIdentity: string, description: string, options: MealWriteOptions = {}): Promise<void> {
    const text = description.trim();
    if (!text) {
      throw new ValidationError('A meal description is required');
    }
    await this.withRecordLock(patientId, mealIdentity, async (client, current) => {
      assertContentRevision(mealIdentity, current.content_revision, options.expectedRevision);
      if (current.status === 'CANCELLED') {
        throw new ConflictError(`Meal record ${mealIdentity} cannot be edited in ${current.status}`);
      }
      if (current.status === 'AWAITING_DESCRIPTION' || current.status === 'INCOMPLETE') {
        await this.update(client, patientId, mealIdentity, 'DESCRIBED', `description = $3`, [text]);
        return;
      }
      await client.query(
        `UPDATE meal_records SET description = $3, updated_at = now() WHERE patient_id = $1::uuid AND meal_identity = $2`,
        [patientId, mealIdentity, text],
      );
    });
  }

  /**
   * Stores an AI proposal as unconfirmed, with the caregiver input it was based on. It never becomes trusted history
   * without confirmProposal/correctMacros. Returns the proposal id the caregiver must confirm.
   */
  async recordAiProposal(patientId: string, mealIdentity: string, proposal: MacroProposalInput): Promise<string> {
    assertGrams(proposal.carbs_g, 'carbs_g');
    assertGrams(proposal.protein_g, 'protein_g');
    assertGrams(proposal.fat_g, 'fat_g');
    const proposalId = randomUUID();
    await this.withRecordLock(patientId, mealIdentity, async (client, current) => {
      if (!canTransitionMealRecord(current.status, 'AI_PROPOSED')) {
        throw new ConflictError(`Meal record ${mealIdentity} cannot move from ${current.status} to AI_PROPOSED`);
      }
      const stored: StoredProposal = {
        ...proposal,
        proposal_id: proposalId,
        proposed_at: new Date().toISOString(),
        based_on: { description: current.description, photo_ref: current.photo_ref },
      };
      await this.update(client, patientId, mealIdentity, 'AI_PROPOSED', `proposal = $3::jsonb`, [JSON.stringify(stored)]);
    });
    return proposalId;
  }

  /**
   * Caregiver accepts the AI proposal they were shown, unchanged; values keep AI_PROPOSAL as their origin. Refused
   * when a newer proposal replaced it in the meantime.
   */
  async confirmProposal(patientId: string, mealIdentity: string, caregiverUserId: string, expectedProposalId: string, options: MealWriteOptions = {}): Promise<void> {
    await this.withRecordLock(patientId, mealIdentity, async (client, current) => {
      assertContentRevision(mealIdentity, current.content_revision, options.expectedRevision);
      if (!canTransitionMealRecord(current.status, 'CONFIRMED') || !current.proposal) {
        throw new ConflictError(`Meal record ${mealIdentity} cannot be confirmed from ${current.status}`);
      }
      const proposal = current.proposal as StoredProposal;
      if (proposal.proposal_id !== expectedProposalId) {
        throw new ConflictError(`MEAL_PROPOSAL_CHANGED: ${mealIdentity} now has proposal ${proposal.proposal_id}`);
      }
      const value = (grams: number | null): MacroValue => ({ grams, origin: grams === null ? null : 'AI_PROPOSAL' });
      const confirmed: StoredMacros = { carbs: value(proposal.carbs_g), protein: value(proposal.protein_g), fat: value(proposal.fat_g) };
      const items = itemsAfterValues(current.items, options.items, proposal);
      await this.update(client, patientId, mealIdentity, 'CONFIRMED', `confirmed_macros = $3::jsonb, confirmed_by = $4::uuid, confirmed_at = now(), confirmed_items = $5::jsonb`, [JSON.stringify(confirmed), caregiverUserId, items === null ? null : JSON.stringify(items)]);
    });
  }

  /**
   * Caregiver enters or edits values; every given value is attributed to the caregiver. The meal's items stay only
   * while they still add up to the new values (or are given with them in options.items).
   */
  async correctMacros(patientId: string, mealIdentity: string, caregiverUserId: string, macros: { carbs_g: number | null; protein_g: number | null; fat_g: number | null }, options: MealWriteOptions = {}): Promise<void> {
    assertGrams(macros.carbs_g, 'carbs_g');
    assertGrams(macros.protein_g, 'protein_g');
    assertGrams(macros.fat_g, 'fat_g');
    const value = (grams: number | null): MacroValue => ({ grams, origin: grams === null ? null : 'CAREGIVER' });
    const corrected: StoredMacros = { carbs: value(macros.carbs_g), protein: value(macros.protein_g), fat: value(macros.fat_g) };
    await this.withRecordLock(patientId, mealIdentity, async (client, current) => {
      assertContentRevision(mealIdentity, current.content_revision, options.expectedRevision);
      if (!canTransitionMealRecord(current.status, 'CORRECTED')) {
        throw new ConflictError(`Meal record ${mealIdentity} cannot move from ${current.status} to CORRECTED`);
      }
      const items = itemsAfterValues(current.items, options.items, macros);
      await this.update(client, patientId, mealIdentity, 'CORRECTED', `confirmed_macros = $3::jsonb, confirmed_by = $4::uuid, confirmed_at = now(), confirmed_items = $5::jsonb`, [JSON.stringify(corrected), caregiverUserId, items === null ? null : JSON.stringify(items)]);
    });
  }

  /**
   * One caregiver save of a meal's content (description, items and/or values) in one transaction, as used by changes
   * confirmed from a conversation. Returns the meal's new content revision.
   */
  async editContent(patientId: string, mealIdentity: string, caregiverUserId: string, edit: MealContentEdit, options: MealWriteOptions = {}): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const revision = await editMealContentLocked(client, patientId, mealIdentity, caregiverUserId, edit, options.expectedRevision);
      await client.query('COMMIT');
      client.release();
      return revision;
    } catch (error) {
      releaseAfterFailure(client, await rollbackQuietly(client));
      throw error;
    }
  }

  private async transition(patientId: string, mealIdentity: string, to: MealRecordStatus, setSql: string, params: unknown[], options: MealWriteOptions = {}): Promise<void> {
    await this.withRecordLock(patientId, mealIdentity, async (client, current) => {
      assertContentRevision(mealIdentity, current.content_revision, options.expectedRevision);
      if (!canTransitionMealRecord(current.status, to)) {
        throw new ConflictError(`Meal record ${mealIdentity} cannot move from ${current.status} to ${to}`);
      }
      await this.update(client, patientId, mealIdentity, to, setSql, params);
    });
  }

  private async update(client: PoolClient, patientId: string, mealIdentity: string, to: MealRecordStatus, setSql: string, params: unknown[]): Promise<void> {
    await client.query(
      `UPDATE meal_records SET status = $${params.length + 3}, ${setSql ? `${setSql}, ` : ''}updated_at = now()
       WHERE patient_id = $1::uuid AND meal_identity = $2`,
      [patientId, mealIdentity, ...params, to],
    );
  }

  private async withRecordLock(
    patientId: string,
    mealIdentity: string,
    work: (client: PoolClient, current: LockedMealRecord) => Promise<void>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await work(client, await lockMealRecord(client, patientId, mealIdentity));
      await client.query('COMMIT');
      client.release();
    } catch (error) {
      releaseAfterFailure(client, await rollbackQuietly(client));
      throw error;
    }
  }
}

/** A caregiver save names the meal content revision it was based on; absent (older apps): the save is not checked. */
export interface MealWriteOptions {
  expectedRevision?: number | null;
  /** Items the saved values come from (043). Absent: the stored items stay only while they add up to the new values. */
  items?: MealItem[] | null;
}

/**
 * A content save. `macros` makes the meal CORRECTED (the caregiver's values); `description` alone moves a meal still
 * awaiting one to DESCRIBED and otherwise keeps its status; `items` (null clears them) are stored as given, and when
 * left out they stay only while they add up to the new values.
 */
export interface MealContentEdit {
  description?: string | null;
  items?: MealItem[] | null;
  macros?: { carbs_g: number | null; protein_g: number | null; fat_g: number | null };
}

interface LockedMealRecord {
  status: MealRecordStatus;
  proposal: unknown;
  description: string | null;
  photo_ref: string | null;
  content_revision: number;
  items: MealItem[] | null;
  macros: { carbs_g: number | null; protein_g: number | null; fat_g: number | null };
}

async function lockMealRecord(client: PoolClient, patientId: string, mealIdentity: string): Promise<LockedMealRecord> {
  const row = (await client.query(
    `SELECT status, proposal, description, photo_ref, content_revision, confirmed_macros, confirmed_items
     FROM meal_records WHERE patient_id = $1::uuid AND meal_identity = $2 FOR NO KEY UPDATE`,
    [patientId, mealIdentity],
  )).rows[0];
  if (!row) throw new NotFoundError(`Meal record not found: ${mealIdentity}`);
  const confirmed = (row.confirmed_macros ?? null) as StoredMacros | null;
  const grams = (key: keyof StoredMacros) => confirmed?.[key]?.grams ?? null;
  return {
    status: row.status as MealRecordStatus,
    proposal: row.proposal,
    description: row.description,
    photo_ref: row.photo_ref,
    content_revision: Number(row.content_revision),
    items: readStoredMealItems(row.confirmed_items),
    macros: { carbs_g: grams('carbs'), protein_g: grams('protein'), fat_g: grams('fat') },
  };
}

/** Items stored with new values: the given ones, else the current ones while they still add up to the values. */
function itemsAfterValues(current: MealItem[] | null, given: MealItem[] | null | undefined, values: { carbs_g: number | null; protein_g: number | null; fat_g: number | null }): MealItem[] | null {
  if (given !== undefined) return given;
  return current && itemsMatchTotals(current, values) ? current : null;
}

/**
 * The content save of editContent on a caller's transaction (the conversation meal action is marked applied in the
 * same one). Takes the meal's row lock, checks the expected revision and the status, and returns the new revision.
 */
export async function editMealContentLocked(
  client: PoolClient,
  patientId: string,
  mealIdentity: string,
  caregiverUserId: string,
  edit: MealContentEdit,
  expectedRevision: number | null | undefined,
): Promise<number> {
  const current = await lockMealRecord(client, patientId, mealIdentity);
  assertContentRevision(mealIdentity, current.content_revision, expectedRevision);
  if (current.status === 'CANCELLED') {
    throw new ConflictError(`Meal record ${mealIdentity} cannot be edited in ${current.status}`);
  }
  const description = edit.description === undefined ? current.description : (edit.description?.trim() || null);
  if (description !== null && description.length > 2000) throw new ValidationError('description must be at most 2000 characters');
  let status = current.status;
  let confirmed: StoredMacros | null = null;
  let items = edit.items === undefined ? current.items : edit.items;
  if (edit.macros) {
    assertGrams(edit.macros.carbs_g, 'carbs_g');
    assertGrams(edit.macros.protein_g, 'protein_g');
    assertGrams(edit.macros.fat_g, 'fat_g');
    if (!canTransitionMealRecord(current.status, 'CORRECTED')) {
      throw new ConflictError(`Meal record ${mealIdentity} cannot move from ${current.status} to CORRECTED`);
    }
    status = 'CORRECTED';
    const value = (grams: number | null): MacroValue => ({ grams, origin: grams === null ? null : 'CAREGIVER' });
    confirmed = { carbs: value(edit.macros.carbs_g), protein: value(edit.macros.protein_g), fat: value(edit.macros.fat_g) };
    items = itemsAfterValues(current.items, edit.items, edit.macros);
  } else if (description !== null && (current.status === 'AWAITING_DESCRIPTION' || current.status === 'INCOMPLETE')) {
    status = 'DESCRIBED';
  }
  const result = await client.query<{ content_revision: string }>(
    `UPDATE meal_records
     SET status = $3, description = $4, confirmed_items = $5::jsonb,
         confirmed_macros = COALESCE($6::jsonb, confirmed_macros),
         confirmed_by = CASE WHEN $6::jsonb IS NULL THEN confirmed_by ELSE $7::uuid END,
         confirmed_at = CASE WHEN $6::jsonb IS NULL THEN confirmed_at ELSE now() END,
         updated_at = now()
     WHERE patient_id = $1::uuid AND meal_identity = $2
     RETURNING content_revision::text`,
    [patientId, mealIdentity, status, description, items === null ? null : JSON.stringify(items), confirmed === null ? null : JSON.stringify(confirmed), caregiverUserId],
  );
  return Number(result.rows[0].content_revision);
}

/** Refuses a save based on an outdated meal, checked under the row lock so two saves can never both pass. */
function assertContentRevision(mealIdentity: string, current: number, expected: number | null | undefined): void {
  if (expected !== undefined && expected !== null && expected !== current) {
    throw new StaleWriteError(`MEAL_CHANGED: ${mealIdentity} is at revision ${current}, the save was based on ${expected}`);
  }
}
