import type { Pool, PoolClient } from 'pg';
import type { MealPlanDoseAnswer, MealPlanEatenAnswer, MealPlanEntry, MealPlanEntryStatus, MealPlanItem, NewMealPlan } from '@modules/meal-plan/application/meal-plan';
import type { PatientNote, PatientNoteKind, PatientNotePortion } from '@modules/meal-plan/application/patient-notes';
import type { MealPlanProposalRecord, NewMealPlanProposal } from '@modules/meal-plan/application/meal-plan-proposal';

/** PostgreSQL storage of meal plans (migration 103, meal-plan.v1). */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toIso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string | Date).toISOString());

const SELECT_ENTRY = `SELECT e.*, p.lead_minutes FROM meal_plan_entries e JOIN meal_plans p ON p.id = e.plan_id`;

function toEntry(row: Record<string, unknown>): MealPlanEntry {
  return {
    id: String(row.id),
    plan_id: String(row.plan_id),
    patient_id: String(row.patient_id),
    kind: row.kind as MealPlanEntry['kind'],
    title: String(row.title),
    planned_at: toIso(row.planned_at)!,
    items: (row.items ?? []) as MealPlanEntry['items'],
    status: row.status as MealPlanEntryStatus,
    lead_minutes: Number(row.lead_minutes),
    reminder_sent_at: toIso(row.reminder_sent_at),
    missed_sent_at: toIso(row.missed_sent_at),
    dose_answer: (row.dose_answer ?? null) as MealPlanEntry['dose_answer'],
    eaten_asked_at: toIso(row.eaten_asked_at),
    eaten_asked_again_at: toIso(row.eaten_asked_again_at),
    eaten_answer: (row.eaten_answer ?? null) as MealPlanEntry['eaten_answer'],
    eaten_answered_at: toIso(row.eaten_answered_at),
    paused: row.paused === true,
    plate: (row.plate ?? null) as MealPlanEntry['plate'],
    menu_changed: row.menu_items !== null && row.menu_items !== undefined,
  };
}

function toNote(row: Record<string, unknown>): PatientNote {
  return {
    id: String(row.id),
    patient_id: String(row.patient_id),
    kind: row.kind as PatientNoteKind,
    text: String(row.text),
    food_name: (row.food_name ?? null) as string | null,
    portion: (row.portion ?? null) as PatientNotePortion | null,
    created_by_name: (row.created_by_name ?? null) as string | null,
    created_at: toIso(row.created_at)!,
    confirmed_at: toIso(row.confirmed_at),
    proposed_user_message_id: (row.proposed_user_message_id ?? null) as string | null,
  };
}

function toProposal(row: Record<string, unknown>): MealPlanProposalRecord {
  return {
    id: String(row.id),
    patient_id: String(row.patient_id),
    conversation_id: String(row.conversation_id),
    user_message_id: String(row.user_message_id),
    lead_minutes: Number(row.lead_minutes),
    macros_source: row.macros_source as MealPlanProposalRecord['macros_source'],
    entries: row.entries as MealPlanProposalRecord['entries'],
    times_to_check: row.times_to_check as MealPlanProposalRecord['times_to_check'],
    rules_to_remember: (row.rules_to_remember ?? []) as string[],
    applied_rules: (row.applied_rules ?? []) as string[],
    unread: (row.unread ?? []) as string[],
    rules_remembered: row.rules_remembered_at !== null && row.rules_remembered_at !== undefined,
    status: row.status as MealPlanProposalRecord['status'],
    plan_id: row.plan_id === null || row.plan_id === undefined ? null : String(row.plan_id),
    skipped_past: Number(row.skipped_past ?? 0),
    created_at: toIso(row.created_at)!,
  };
}

const REPLACED_ROWS = `FROM unnest($2::text[], $3::text[], $4::date[]) AS n(kind, title, day)
  WHERE e.patient_id = $1::uuid AND e.status = 'PLANNED' AND e.planned_at > $5::timestamptz AND e.kind = n.kind
    AND lower(btrim(e.title)) = n.title AND (e.planned_at AT TIME ZONE $6::text)::date = n.day`;

export class PostgresMealPlanRepository {
  constructor(private readonly pool: Pool) {}

  async createPlan(patientId: string, userId: string | null, plan: NewMealPlan): Promise<{ plan_id: string; entries: MealPlanEntry[] }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const planId = await this.insertPlan(client, patientId, userId, plan);
      await client.query('COMMIT');
      const rows = (await this.pool.query(`${SELECT_ENTRY} WHERE e.plan_id = $1::uuid ORDER BY e.planned_at`, [planId])).rows;
      return { plan_id: planId, entries: rows.map(toEntry) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertPlan(client: PoolClient, patientId: string, userId: string | null, plan: NewMealPlan): Promise<string> {
    const planId = String((await client.query(
      `INSERT INTO meal_plans (patient_id, created_by_user_id, lead_minutes) VALUES ($1::uuid, $2::uuid, $3) RETURNING id`,
      [patientId, userId, plan.lead_minutes],
    )).rows[0].id);
    for (const entry of plan.entries) {
      await client.query(
        `INSERT INTO meal_plan_entries (plan_id, patient_id, kind, title, planned_at, items) VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6::jsonb)`,
        [planId, patientId, entry.kind, entry.title, entry.planned_at, JSON.stringify(entry.items)],
      );
    }
    return planId;
  }

  /** A card read in chat (slice 3c); the conversation's earlier open cards are replaced by it. */
  async insertProposal(args: { patientId: string; conversationId: string; userMessageId: string; proposal: NewMealPlanProposal }): Promise<MealPlanProposalRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE meal_plan_proposals SET status = 'SUPERSEDED', updated_at = now() WHERE patient_id = $1::uuid AND conversation_id = $2::uuid AND status = 'PROPOSED'`, [args.patientId, args.conversationId]);
      const row = (await client.query(
        `INSERT INTO meal_plan_proposals (patient_id, conversation_id, user_message_id, lead_minutes, macros_source, entries, times_to_check, rules_to_remember, applied_rules, unread)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb) RETURNING *`,
        [args.patientId, args.conversationId, args.userMessageId, args.proposal.lead_minutes, args.proposal.macros_source, JSON.stringify(args.proposal.entries), JSON.stringify(args.proposal.times_to_check), JSON.stringify(args.proposal.rules_to_remember), JSON.stringify(args.proposal.applied_rules), JSON.stringify(args.proposal.unread)],
      )).rows[0];
      await client.query('COMMIT');
      return toProposal(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Cards of a failed attempt or of a corrected call: they never show. */
  async discardForUserMessage(patientId: string, userMessageId: string): Promise<void> {
    await this.pool.query(`UPDATE meal_plan_proposals SET status = 'DISCARDED', updated_at = now() WHERE patient_id = $1::uuid AND user_message_id = $2::uuid AND status = 'PROPOSED'`, [patientId, userMessageId]);
  }

  async listProposalsForConversation(patientId: string, conversationId: string): Promise<MealPlanProposalRecord[]> {
    const rows = (await this.pool.query(`SELECT * FROM meal_plan_proposals WHERE patient_id = $1::uuid AND conversation_id = $2::uuid AND status <> 'DISCARDED' ORDER BY created_at`, [patientId, conversationId])).rows;
    return rows.map(toProposal);
  }

  async getProposal(patientId: string, conversationId: string, proposalId: string): Promise<MealPlanProposalRecord | null> {
    if (!UUID_PATTERN.test(proposalId)) return null;
    const row = (await this.pool.query(`SELECT * FROM meal_plan_proposals WHERE patient_id = $1::uuid AND conversation_id = $2::uuid AND id = $3::uuid AND status <> 'DISCARDED'`, [patientId, conversationId, proposalId])).rows[0];
    return row ? toProposal(row) : null;
  }

  /** The newest time of each planned meal or activity, newest first: a source with no times borrows them. */
  async listEarlierTimes(patientId: string): Promise<Array<{ kind: string; title: string; planned_at: string }>> {
    const rows = (await this.pool.query(
      `SELECT DISTINCT ON (kind, lower(btrim(title))) kind, title, planned_at FROM meal_plan_entries
       WHERE patient_id = $1::uuid AND status <> 'REMOVED' ORDER BY kind, lower(btrim(title)), planned_at DESC LIMIT 40`,
      [patientId],
    )).rows;
    return rows.map((row) => ({ kind: String(row.kind), title: String(row.title), planned_at: toIso(row.planned_at)! }));
  }

  /** Who gets the reminders: caregivers whose phone has the switch on. */
  async listReminderRecipients(patientId: string): Promise<string[]> {
    const rows = (await this.pool.query(
      `SELECT DISTINCT u.display_name AS name FROM patient_devices d JOIN users u ON u.id = d.user_id
       WHERE d.patient_id = $1::uuid AND d.meal_plan_push_enabled AND u.display_name IS NOT NULL AND btrim(u.display_name) <> '' ORDER BY 1`,
      [patientId],
    )).rows;
    return rows.map((row) => String(row.name));
  }

  async patientName(patientId: string): Promise<string | null> {
    const row = (await this.pool.query(`SELECT display_name FROM patients WHERE id = $1::uuid`, [patientId])).rows[0];
    return row?.display_name ?? null;
  }

  /** "kind|title|day" of what is still to come, for "Dodaj tylko nowe". */
  async listExistingKeys(patientId: string, keys: Array<{ kind: string; title: string; date: string }>, now: Date, timeZone: string): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = (await this.pool.query(
      `SELECT DISTINCT n.kind, n.title, n.day::text AS day FROM meal_plan_entries e, unnest($2::text[], $3::text[], $4::date[]) AS n(kind, title, day)
       WHERE e.patient_id = $1::uuid AND e.status = 'PLANNED' AND e.planned_at > $5::timestamptz AND e.kind = n.kind
         AND lower(btrim(e.title)) = n.title AND (e.planned_at AT TIME ZONE $6::text)::date = n.day`,
      [patientId, keys.map((key) => key.kind), keys.map((key) => key.title), keys.map((key) => key.date), now.toISOString(), timeZone],
    )).rows;
    return new Set(rows.map((row) => `${row.kind}|${row.title}|${row.day}`));
  }

  /** Entries of earlier plans a card would replace: the same title and kind on the same day, still to come. */
  async countReplaced(patientId: string, keys: Array<{ kind: string; title: string; date: string }>, now: Date, timeZone: string): Promise<number> {
    if (keys.length === 0) return 0;
    const row = (await this.pool.query(
      `SELECT count(*)::int AS count FROM meal_plan_entries e WHERE EXISTS (SELECT 1 ${REPLACED_ROWS})`,
      [patientId, keys.map((key) => key.kind), keys.map((key) => key.title), keys.map((key) => key.date), now.toISOString(), timeZone],
    )).rows[0];
    return Number(row?.count ?? 0);
  }

  /**
   * "Włącz przypomnienia": the card becomes a plan once, whoever is first. A meal of an earlier plan with the same title
   * on the same day is replaced, so a corrected menu does not remind twice and activities added later keep the meals.
   */
  async acceptProposal(args: { patientId: string; conversationId: string; proposalId: string; userId: string | null; plan: NewMealPlan; skippedPast: number; replacedKeys: Array<{ kind: string; title: string; date: string }>; now: Date; timeZone: string }): Promise<{ status: 'ACCEPTED' | 'ALREADY_ACCEPTED' | 'NOT_OPEN'; proposal: MealPlanProposalRecord | null }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = (await client.query(`SELECT * FROM meal_plan_proposals WHERE patient_id = $1::uuid AND conversation_id = $2::uuid AND id = $3::uuid AND status <> 'DISCARDED' FOR UPDATE`, [args.patientId, args.conversationId, args.proposalId])).rows[0];
      if (!current || current.status !== 'PROPOSED') {
        await client.query('ROLLBACK');
        return { status: current?.status === 'ACCEPTED' ? 'ALREADY_ACCEPTED' : 'NOT_OPEN', proposal: current ? toProposal(current) : null };
      }
      await client.query(
        `UPDATE meal_plan_entries e SET status = 'REMOVED', changed_by_user_id = $7::uuid, updated_at = now() ${REPLACED_ROWS}`,
        [args.patientId, args.replacedKeys.map((key) => key.kind), args.replacedKeys.map((key) => key.title), args.replacedKeys.map((key) => key.date), args.now.toISOString(), args.timeZone, args.userId],
      );
      const planId = await this.insertPlan(client, args.patientId, args.userId, args.plan);
      const row = (await client.query(
        `UPDATE meal_plan_proposals SET status = 'ACCEPTED', plan_id = $2::uuid, accepted_by_user_id = $3::uuid, accepted_at = $4::timestamptz, skipped_past = $5, updated_at = now() WHERE id = $1::uuid RETURNING *`,
        [args.proposalId, planId, args.userId, args.now.toISOString(), args.skippedPast],
      )).rows[0];
      await client.query('COMMIT');
      return { status: 'ACCEPTED', proposal: toProposal(row) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** The entries still in the plan between two moments, oldest first (removed ones are gone for the caregiver). */
  async listBetween(patientId: string, fromIso: string, toIso_: string): Promise<MealPlanEntry[]> {
    const rows = (await this.pool.query(
      `${SELECT_ENTRY} WHERE e.patient_id = $1::uuid AND e.status <> 'REMOVED' AND p.removed_at IS NULL
         AND e.planned_at >= $2::timestamptz AND e.planned_at < $3::timestamptz ORDER BY e.planned_at`,
      [patientId, fromIso, toIso_],
    )).rows;
    return rows.map(toEntry);
  }

  async getEntry(patientId: string, entryId: string): Promise<MealPlanEntry | null> {
    if (!UUID_PATTERN.test(entryId)) return null;
    const row = (await this.pool.query(`${SELECT_ENTRY} WHERE e.patient_id = $1::uuid AND e.id = $2::uuid`, [patientId, entryId])).rows[0];
    return row ? toEntry(row) : null;
  }

  /** The portions a phone set, for all phones (null clears them). Null when the entry is not there. */
  async setPlate(patientId: string, entryId: string, plate: Record<string, unknown> | null, userId: string | null): Promise<MealPlanEntry | null> {
    if (!UUID_PATTERN.test(entryId)) return null;
    const row = (await this.pool.query(
      `UPDATE meal_plan_entries SET plate = $3::jsonb, changed_by_user_id = $4::uuid, updated_at = now() WHERE patient_id = $1::uuid AND id = $2::uuid RETURNING id`,
      [patientId, entryId, plate === null ? null : JSON.stringify(plate), userId],
    )).rows[0];
    return row ? this.getEntry(patientId, entryId) : null;
  }

  /**
   * A change accepted in the planned meal's chat: its dishes replace the entry's, the menu's own are kept on the first
   * change, and the portions start over (the change already says what is eaten). Only a meal still planned.
   */
  async replaceItems(patientId: string, entryId: string, items: MealPlanItem[], userId: string | null): Promise<MealPlanEntry | null> {
    if (!UUID_PATTERN.test(entryId)) return null;
    const row = (await this.pool.query(
      `UPDATE meal_plan_entries SET menu_items = COALESCE(menu_items, items), items = $3::jsonb, plate = '{}'::jsonb,
              changed_by_user_id = $4::uuid, updated_at = now()
       WHERE patient_id = $1::uuid AND id = $2::uuid AND kind = 'MEAL' AND status = 'PLANNED' RETURNING id`,
      [patientId, entryId, JSON.stringify(items), userId],
    )).rows[0];
    return row ? this.getEntry(patientId, entryId) : null;
  }

  /** "Pomiń", "Usuń" and "Cofnij" (status back to PLANNED). Null when the entry is not there. */
  async setStatus(patientId: string, entryId: string, status: MealPlanEntryStatus, userId: string | null): Promise<MealPlanEntry | null> {
    if (!UUID_PATTERN.test(entryId)) return null;
    const row = (await this.pool.query(
      `UPDATE meal_plan_entries SET status = $3, changed_by_user_id = $4::uuid, updated_at = now() WHERE patient_id = $1::uuid AND id = $2::uuid RETURNING id`,
      [patientId, entryId, status, userId],
    )).rows[0];
    return row ? this.getEntry(patientId, entryId) : null;
  }

  /** Removes what is still to come, on all phones; meals already past stay as they were. Returns how many. */
  async removePlan(patientId: string, planId: string, userId: string | null, now: Date): Promise<number> {
    if (!UUID_PATTERN.test(planId)) return 0;
    return (await this.pool.query(
      `UPDATE meal_plan_entries SET status = 'REMOVED', changed_by_user_id = $3::uuid, updated_at = now()
       WHERE patient_id = $1::uuid AND plan_id = $2::uuid AND status = 'PLANNED' AND planned_at > $4::timestamptz`,
      [patientId, planId, userId, now.toISOString()],
    )).rowCount ?? 0;
  }

  /** "Tak" or "Nie" to "Czy to było do tego posiłku?"; null takes the answer back. */
  async setDoseAnswer(patientId: string, entryId: string, answer: MealPlanDoseAnswer | null, userId: string | null): Promise<MealPlanEntry | null> {
    if (!UUID_PATTERN.test(entryId)) return null;
    const row = (await this.pool.query(
      `UPDATE meal_plan_entries SET dose_answer = $3, dose_answered_by_user_id = $4::uuid, updated_at = now() WHERE patient_id = $1::uuid AND id = $2::uuid RETURNING id`,
      [patientId, entryId, answer, userId],
    )).rows[0];
    return row ? this.getEntry(patientId, entryId) : null;
  }

  /** The answer to "Czy obiad został zjedzony?". */
  async setEatenAnswer(patientId: string, entryId: string, answer: MealPlanEatenAnswer, userId: string | null, now: Date): Promise<MealPlanEntry | null> {
    if (!UUID_PATTERN.test(entryId)) return null;
    const row = (await this.pool.query(
      `UPDATE meal_plan_entries SET eaten_answer = $3, eaten_answered_at = $5::timestamptz, eaten_answered_by_user_id = $4::uuid, updated_at = now() WHERE patient_id = $1::uuid AND id = $2::uuid RETURNING id`,
      [patientId, entryId, answer, userId, now.toISOString()],
    )).rows[0];
    return row ? this.getEntry(patientId, entryId) : null;
  }

  /** Activities in their last half hour, with no push yet. */
  async listMovementCandidates(now: Date, leadMinutes: number): Promise<MealPlanEntry[]> {
    const rows = (await this.pool.query(
      `${SELECT_ENTRY} WHERE e.kind = 'MOVEMENT' AND e.status = 'PLANNED' AND p.removed_at IS NULL AND e.reminder_sent_at IS NULL
         AND e.planned_at > $1::timestamptz AND e.planned_at <= $1::timestamptz + make_interval(mins => $2)
       ORDER BY e.planned_at LIMIT 50`,
      [now.toISOString(), leadMinutes],
    )).rows;
    return rows.map(toEntry);
  }

  /** Meals that may still need "Czy został zjedzony?". */
  async listEatenCandidates(now: Date, untilMinutesAfter: number): Promise<MealPlanEntry[]> {
    const rows = (await this.pool.query(
      `${SELECT_ENTRY} WHERE e.kind = 'MEAL' AND e.status = 'PLANNED' AND p.removed_at IS NULL AND e.planned_at <= $1::timestamptz
         AND e.planned_at > $1::timestamptz - make_interval(mins => $2)
       ORDER BY e.planned_at LIMIT 100`,
      [now.toISOString(), untilMinutesAfter],
    )).rows;
    return rows.map(toEntry);
  }

  async claimEatenAsk(entryId: string, now: Date, again: boolean): Promise<boolean> {
    const column = again ? 'eaten_asked_again_at' : 'eaten_asked_at';
    return ((await this.pool.query(`UPDATE meal_plan_entries SET ${column} = $2::timestamptz, updated_at = now() WHERE id = $1::uuid AND ${column} IS NULL`, [entryId, now.toISOString()])).rowCount ?? 0) > 0;
  }

  async listNotes(patientId: string, kind?: PatientNoteKind): Promise<PatientNote[]> {
    const rows = (await this.pool.query(
      `SELECT n.*, u.display_name AS created_by_name FROM patient_notes n LEFT JOIN users u ON u.id = n.created_by_user_id
       WHERE n.patient_id = $1::uuid AND n.removed_at IS NULL AND n.confirmed_at IS NOT NULL AND ($2::text IS NULL OR n.kind = $2) ORDER BY n.created_at DESC`,
      [patientId, kind ?? null],
    )).rows;
    return rows.map(toNote);
  }

  /** What the chat offers waits for its card; a note already remembered is not offered again. */
  async offerFoodNote(args: { patientId: string; userMessageId: string; note: { text: string; food_name: string; portion: PatientNotePortion } }): Promise<{ status: 'OFFERED' | 'ALREADY_REMEMBERED' }> {
    const row = (await this.pool.query(
      `INSERT INTO patient_notes (patient_id, kind, text, food_name, portion, proposed_user_message_id) VALUES ($1::uuid, 'FOOD', $2, $3, $4, $5::uuid)
       ON CONFLICT (patient_id, kind, lower(text)) WHERE removed_at IS NULL DO UPDATE SET proposed_user_message_id = CASE WHEN patient_notes.confirmed_at IS NULL THEN EXCLUDED.proposed_user_message_id ELSE patient_notes.proposed_user_message_id END, updated_at = now()
       RETURNING confirmed_at`,
      [args.patientId, args.note.text, args.note.food_name, args.note.portion, args.userMessageId],
    )).rows[0];
    return { status: row?.confirmed_at ? 'ALREADY_REMEMBERED' : 'OFFERED' };
  }

  /** The chat's offers in one conversation, confirmed or not. */
  async listOfferedNotes(patientId: string, userMessageIds: string[]): Promise<PatientNote[]> {
    if (userMessageIds.length === 0) return [];
    const rows = (await this.pool.query(
      `SELECT n.*, NULL AS created_by_name FROM patient_notes n WHERE n.patient_id = $1::uuid AND n.removed_at IS NULL AND n.proposed_user_message_id = ANY($2::uuid[]) ORDER BY n.created_at`,
      [patientId, userMessageIds],
    )).rows;
    return rows.map(toNote);
  }

  async confirmNote(patientId: string, noteId: string, userId: string | null): Promise<boolean> {
    if (!UUID_PATTERN.test(noteId)) return false;
    return ((await this.pool.query(`UPDATE patient_notes SET confirmed_at = COALESCE(confirmed_at, now()), created_by_user_id = COALESCE(created_by_user_id, $3::uuid), updated_at = now() WHERE patient_id = $1::uuid AND id = $2::uuid AND removed_at IS NULL`, [patientId, noteId, userId])).rowCount ?? 0) > 0;
  }

  /** "Zmień godzinę", for all caregivers: the meal's pushes and questions start over. */
  async setPlannedAt(patientId: string, entryId: string, plannedAt: string, userId: string | null): Promise<MealPlanEntry | null> {
    if (!UUID_PATTERN.test(entryId)) return null;
    const row = (await this.pool.query(
      `UPDATE meal_plan_entries SET planned_at = $3::timestamptz, reminder_sent_at = NULL, missed_sent_at = NULL, eaten_asked_at = NULL, eaten_asked_again_at = NULL, eaten_answer = NULL, eaten_answered_at = NULL, changed_by_user_id = $4::uuid, updated_at = now()
       WHERE patient_id = $1::uuid AND id = $2::uuid RETURNING id`,
      [patientId, entryId, plannedAt, userId],
    )).rows[0];
    return row ? this.getEntry(patientId, entryId) : null;
  }

  /** "Bez przypomnień do…": what is still to come until then. Returns how many. */
  async pausePlan(patientId: string, until: string, userId: string | null, now: Date): Promise<number> {
    return (await this.pool.query(
      `UPDATE meal_plan_entries SET status = 'SKIPPED', paused = true, changed_by_user_id = $4::uuid, updated_at = now()
       WHERE patient_id = $1::uuid AND status = 'PLANNED' AND planned_at > $2::timestamptz AND planned_at <= $3::timestamptz`,
      [patientId, now.toISOString(), until, userId],
    )).rowCount ?? 0;
  }

  /** Takes the pause back: meals skipped one by one stay skipped. */
  async resumePlan(patientId: string, userId: string | null, now: Date): Promise<number> {
    return (await this.pool.query(
      `UPDATE meal_plan_entries SET status = 'PLANNED', paused = false, changed_by_user_id = $3::uuid, updated_at = now()
       WHERE patient_id = $1::uuid AND paused AND status = 'SKIPPED' AND planned_at > $2::timestamptz`,
      [patientId, now.toISOString(), userId],
    )).rowCount ?? 0;
  }

  /** The same words again keep the note that is there. */
  async addNote(patientId: string, note: { kind: PatientNoteKind; text: string; food_name?: string | null; portion?: PatientNotePortion | null }, userId: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO patient_notes (patient_id, kind, text, food_name, portion, created_by_user_id, confirmed_at) VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, now())
       ON CONFLICT (patient_id, kind, lower(text)) WHERE removed_at IS NULL DO UPDATE SET confirmed_at = COALESCE(patient_notes.confirmed_at, now()), updated_at = now()`,
      [patientId, note.kind, note.text, note.food_name ?? null, note.portion ?? null, userId],
    );
  }

  async updateNoteText(patientId: string, noteId: string, text: string): Promise<boolean> {
    if (!UUID_PATTERN.test(noteId)) return false;
    return ((await this.pool.query(`UPDATE patient_notes SET text = $3, updated_at = now() WHERE patient_id = $1::uuid AND id = $2::uuid AND removed_at IS NULL`, [patientId, noteId, text])).rowCount ?? 0) > 0;
  }

  async removeNote(patientId: string, noteId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(noteId)) return false;
    return ((await this.pool.query(`UPDATE patient_notes SET removed_at = now(), updated_at = now() WHERE patient_id = $1::uuid AND id = $2::uuid AND removed_at IS NULL`, [patientId, noteId])).rowCount ?? 0) > 0;
  }

  /** "Zapamiętaj" on a card: its rules become notes, once. */
  async rememberProposalRules(patientId: string, conversationId: string, proposalId: string, userId: string | null): Promise<MealPlanProposalRecord | null> {
    const proposal = await this.getProposal(patientId, conversationId, proposalId);
    if (!proposal) return null;
    for (const text of proposal.rules_to_remember) await this.addNote(patientId, { kind: 'PLAN_RULE', text }, userId);
    const row = (await this.pool.query(`UPDATE meal_plan_proposals SET rules_remembered_at = COALESCE(rules_remembered_at, now()), updated_at = now() WHERE id = $1::uuid RETURNING *`, [proposalId])).rows[0];
    return toProposal(row);
  }

  /** Meals the worker may still have to send something for. */
  async listPushCandidates(now: Date, untilMinutesAfter: number, leadMaxMinutes: number): Promise<MealPlanEntry[]> {
    const rows = (await this.pool.query(
      `${SELECT_ENTRY} WHERE e.kind = 'MEAL' AND e.status = 'PLANNED' AND p.removed_at IS NULL AND e.missed_sent_at IS NULL
         AND e.planned_at > $1::timestamptz - make_interval(mins => $2) AND e.planned_at <= $1::timestamptz + make_interval(mins => $3)
       ORDER BY e.planned_at LIMIT 200`,
      [now.toISOString(), untilMinutesAfter + 5, leadMaxMinutes],
    )).rows;
    return rows.map(toEntry);
  }

  /** One worker's claim: false when another one was first. */
  async claimReminder(entryId: string, now: Date): Promise<boolean> {
    return ((await this.pool.query(`UPDATE meal_plan_entries SET reminder_sent_at = $2::timestamptz, updated_at = now() WHERE id = $1::uuid AND reminder_sent_at IS NULL AND status = 'PLANNED'`, [entryId, now.toISOString()])).rowCount ?? 0) > 0;
  }

  async claimMissed(entryId: string, now: Date): Promise<boolean> {
    return ((await this.pool.query(`UPDATE meal_plan_entries SET missed_sent_at = $2::timestamptz, updated_at = now() WHERE id = $1::uuid AND missed_sent_at IS NULL AND status = 'PLANNED'`, [entryId, now.toISOString()])).rowCount ?? 0) > 0;
  }
}
