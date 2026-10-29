import type { Pool } from 'pg';
import type { BolusProposalRecord, BolusProposalStore, NewBolusProposal } from '@modules/remote-commands/application/bolus-proposal-tool';
import type { RemoteCommandRecord } from '@modules/remote-commands/application/remote-command-record';
import { readCardAdvice } from '@modules/remote-commands/application/bolus-proposal-tool';
import { readOptionKey } from '@modules/ai-gateway/application/answer-options';
import { readMealDoseAdjustment } from '@modules/remote-commands/application/meal-dose-forecast';
import { readSplitPlan } from '@modules/remote-commands/application/split-bolus';
import { UNSENT_LAST } from './postgres-remote-commands.repository';

/** PostgreSQL storage of bolus cards in conversations (migrations 047, 050, 058, 063, 067). */

const num = (value: unknown): number | null => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));

export interface BolusProposalWithCommand {
  proposal: BolusProposalRecord;
  /** The newest command sent from this card, if any (the refusal before a retry that failed to send). */
  command: (Pick<RemoteCommandRecord, 'id' | 'status' | 'status_message' | 'carbs_g' | 'insulin_u' | 'meal_record_id' | 'user_id' | 'authorized_at' | 'follows_command_id'> & {
    /** Carbs an earlier command of the card left in Trio (a bolus-only retry after PARTIAL sends none itself). */
    carbs_in_trio_g?: number;
  }) | null;
}

export class PostgresBolusProposalRepository implements BolusProposalStore {
  constructor(private readonly pool: Pool) {}

  async insert(proposal: NewBolusProposal): Promise<BolusProposalRecord> {
    const row = (await this.pool.query(
      `INSERT INTO bolus_proposals (patient_id, conversation_id, user_message_id, purpose, carbs_g, insulin_u, icr_g_per_u, icr_insulin_u, meal_payload, reason, warnings, expires_at, split, dose_adjustment, card_advice, option_key)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12::timestamptz, $13::jsonb, $14::jsonb, $15::jsonb, $16)
       RETURNING *`,
      [
        proposal.patient_id,
        proposal.conversation_id,
        proposal.user_message_id,
        proposal.purpose,
        proposal.carbs_g,
        proposal.insulin_u,
        proposal.icr_g_per_u,
        proposal.icr_insulin_u,
        proposal.meal_payload === null ? null : JSON.stringify(proposal.meal_payload),
        proposal.reason,
        JSON.stringify(proposal.warnings),
        proposal.expires_at,
        proposal.split === null ? null : JSON.stringify(proposal.split),
        proposal.dose_adjustment === null ? null : JSON.stringify(proposal.dose_adjustment),
        proposal.card_advice === null ? null : JSON.stringify(proposal.card_advice),
        proposal.option_key,
      ],
    )).rows[0];
    return toRecord(row);
  }

  async get(patientId: string, proposalId: string): Promise<BolusProposalRecord | null> {
    if (!/^[0-9a-f-]{36}$/i.test(proposalId)) return null;
    const row = (await this.pool.query(`SELECT * FROM bolus_proposals WHERE patient_id = $1::uuid AND id = $2::uuid`, [patientId, proposalId])).rows[0];
    return row ? toRecord(row) : null;
  }

  /** A card of an answer in progress that a newer card for the same option replaces (never shown; never one sent). */
  async discard(patientId: string, proposalId: string): Promise<void> {
    await this.pool.query(
      `UPDATE bolus_proposals SET status = 'DISCARDED', updated_at = now()
       WHERE patient_id = $1::uuid AND id = $2::uuid AND status = 'PROPOSED'
         AND NOT EXISTS (SELECT 1 FROM remote_commands c WHERE c.proposal_id = bolus_proposals.id)`,
      [patientId, proposalId],
    );
  }

  /** A new answer to the same message replaces the cards of an earlier, failed attempt (never shown). */
  async discardForUserMessage(patientId: string, userMessageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE bolus_proposals SET status = 'DISCARDED', updated_at = now()
       WHERE patient_id = $1::uuid AND user_message_id = $2::uuid AND status = 'PROPOSED'
         AND NOT EXISTS (SELECT 1 FROM remote_commands c WHERE c.proposal_id = bolus_proposals.id)`,
      [patientId, userMessageId],
    );
  }

  async listForUserMessage(patientId: string, userMessageId: string): Promise<BolusProposalRecord[]> {
    const rows = (await this.pool.query(
      `SELECT * FROM bolus_proposals WHERE patient_id = $1::uuid AND user_message_id = $2::uuid ORDER BY created_at`,
      [patientId, userMessageId],
    )).rows;
    return rows.map(toRecord);
  }

  /**
   * The conversation's cards with the newest command sent from each; a retry whose send failed leaves the refusal before
   * it on the card, so the card offers that retry again and never the whole dose with the carbs Trio kept.
   */
  async listForConversation(patientId: string, conversationId: string): Promise<BolusProposalWithCommand[]> {
    const rows = (await this.pool.query(
      `SELECT p.*, c.id AS command_id, c.status AS command_status, c.status_message AS command_status_message,
              c.carbs_g AS command_carbs_g, c.insulin_u AS command_insulin_u, c.meal_record_id AS command_meal_record_id,
              c.user_id AS command_user_id, c.authorized_at AS command_authorized_at, c.follows_command_id AS command_follows_command_id,
              (SELECT max(s.carbs_g) FROM remote_commands s
               WHERE s.proposal_id = p.id AND s.status IN ('SUCCEEDED', 'PARTIAL', 'NO_REPLY', 'TRIO_ACCEPTED')) AS carbs_in_trio_g
       FROM bolus_proposals p
       LEFT JOIN LATERAL (
         SELECT * FROM remote_commands rc WHERE rc.proposal_id = p.id ORDER BY ${UNSENT_LAST}, rc.authorized_at DESC LIMIT 1
       ) c ON true
       WHERE p.patient_id = $1::uuid AND p.conversation_id = $2::uuid AND p.status = 'PROPOSED'
       ORDER BY p.created_at`,
      [patientId, conversationId],
    )).rows;
    return rows.map((row) => ({
      proposal: toRecord(row),
      command: row.command_id
        ? {
          id: String(row.command_id),
          status: row.command_status,
          status_message: row.command_status_message ?? null,
          carbs_g: Number(row.command_carbs_g),
          insulin_u: Number(row.command_insulin_u),
          meal_record_id: row.command_meal_record_id ? String(row.command_meal_record_id) : null,
          user_id: String(row.command_user_id),
          authorized_at: new Date(row.command_authorized_at).toISOString(),
          follows_command_id: row.command_follows_command_id ? String(row.command_follows_command_id) : null,
          carbs_in_trio_g: row.carbs_in_trio_g === null || row.carbs_in_trio_g === undefined ? 0 : Number(row.carbs_in_trio_g),
        }
        : null,
    }));
  }
}

function toRecord(row: Record<string, unknown>): BolusProposalRecord {
  return {
    id: String(row.id),
    patient_id: String(row.patient_id),
    conversation_id: String(row.conversation_id),
    user_message_id: String(row.user_message_id),
    purpose: row.purpose as BolusProposalRecord['purpose'],
    carbs_g: Number(row.carbs_g),
    insulin_u: Number(row.insulin_u),
    icr_g_per_u: num(row.icr_g_per_u),
    icr_insulin_u: num(row.icr_insulin_u),
    meal_payload: (row.meal_payload ?? null) as BolusProposalRecord['meal_payload'],
    reason: (row.reason as string | null) ?? null,
    warnings: (row.warnings ?? []) as BolusProposalRecord['warnings'],
    split: readSplitPlan(row.split ?? null),
    dose_adjustment: readMealDoseAdjustment(row.dose_adjustment ?? null),
    card_advice: readCardAdvice(row.card_advice ?? null),
    option_key: readOptionKey(row.option_key),
    status: row.status as BolusProposalRecord['status'],
    expires_at: new Date(row.expires_at as string).toISOString(),
    created_at: new Date(row.created_at as string).toISOString(),
  };
}
