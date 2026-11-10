import type { Pool } from 'pg';
import type { MealChatProposal } from '@infra/db/postgres-meal-chat.repository';
import type { MealPlanChatMessage } from '@modules/meal-plan/application/meal-plan-chat';

/** PostgreSQL storage of the planned meal's chat (migration 110). */

const DISPLAY_NAME_SQL = `
  CASE WHEN u.display_name ~* '^(cognito:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN NULL ELSE u.display_name END
`;

const SELECT_MESSAGE = `
  SELECT m.id, m.role, m.content, m.photo_ids::text[] AS photo_ids, m.plate_summary, m.proposal, m.question, m.reply_to_message_id, m.accepted_at,
         m.created_at, m.author_user_id, ${DISPLAY_NAME_SQL} AS author_display_name
  FROM meal_plan_chat_messages m
  LEFT JOIN users u ON u.id = m.author_user_id
`;

const toIso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string | Date).toISOString());

function toMessage(row: Record<string, unknown>): MealPlanChatMessage {
  return {
    id: String(row.id),
    role: row.role === 'ASSISTANT' ? 'ASSISTANT' : 'USER',
    content: String(row.content ?? ''),
    photo_ids: Array.isArray(row.photo_ids) ? row.photo_ids.map(String) : [],
    plate_summary: typeof row.plate_summary === 'string' ? row.plate_summary : null,
    proposal: (row.proposal as MealChatProposal | null) ?? null,
    question: typeof row.question === 'string' ? row.question : null,
    author_display_name: typeof row.author_display_name === 'string' ? row.author_display_name : null,
    author_user_id: row.author_user_id ? String(row.author_user_id) : null,
    reply_to_message_id: row.reply_to_message_id ? String(row.reply_to_message_id) : null,
    accepted_at: toIso(row.accepted_at),
    created_at: toIso(row.created_at)!,
  };
}

export class PostgresMealPlanChatRepository {
  constructor(private readonly pool: Pool) {}

  /** Idempotent per (entry, key): a retried send returns the stored message. */
  async insertUserMessage(args: { patientId: string; entryId: string; content: string; photoIds?: string[]; plateSummary: string | null; authorUserId: string | null; idempotencyKey: string }): Promise<MealPlanChatMessage> {
    const key = `user:${args.idempotencyKey}`;
    await this.pool.query(
      `INSERT INTO meal_plan_chat_messages (patient_id, entry_id, role, content, photo_ids, plate_summary, author_user_id, idempotency_key)
       VALUES ($1::uuid, $2::uuid, 'USER', $3, $4::uuid[], $5, $6::uuid, $7)
       ON CONFLICT (entry_id, idempotency_key) DO NOTHING`,
      [args.patientId, args.entryId, args.content, args.photoIds ?? [], args.plateSummary, args.authorUserId, key],
    );
    const row = (await this.pool.query(`${SELECT_MESSAGE} WHERE m.entry_id = $1::uuid AND m.idempotency_key = $2`, [args.entryId, key])).rows[0];
    return toMessage(row);
  }

  /** One reply per user message (job retries do not duplicate it). */
  async insertAssistantMessage(args: { patientId: string; entryId: string; replyToMessageId: string; content: string; question: string | null; proposal: MealChatProposal | null }): Promise<void> {
    await this.pool.query(
      `INSERT INTO meal_plan_chat_messages (patient_id, entry_id, role, content, question, proposal, reply_to_message_id, idempotency_key)
       VALUES ($1::uuid, $2::uuid, 'ASSISTANT', $3, $4, $5::jsonb, $6::uuid, $7)
       ON CONFLICT (entry_id, idempotency_key) DO NOTHING`,
      [args.patientId, args.entryId, args.content, args.question, args.proposal ? JSON.stringify(args.proposal) : null, args.replyToMessageId, `assistant:${args.replyToMessageId}`],
    );
  }

  async hasReply(entryId: string, userMessageId: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM meal_plan_chat_messages WHERE entry_id = $1::uuid AND idempotency_key = $2`, [entryId, `assistant:${userMessageId}`]);
    return (result.rowCount ?? 0) > 0;
  }

  async listMessages(patientId: string, entryId: string): Promise<MealPlanChatMessage[]> {
    const rows = (await this.pool.query(`${SELECT_MESSAGE} WHERE m.patient_id = $1::uuid AND m.entry_id = $2::uuid ORDER BY m.created_at ASC, m.id ASC`, [patientId, entryId])).rows;
    return rows.map(toMessage);
  }

  async getMessage(patientId: string, entryId: string, messageId: string): Promise<MealPlanChatMessage | null> {
    const row = (await this.pool.query(`${SELECT_MESSAGE} WHERE m.patient_id = $1::uuid AND m.entry_id = $2::uuid AND m.id = $3::uuid`, [patientId, entryId, messageId])).rows[0];
    return row ? toMessage(row) : null;
  }

  async insertPhoto(args: { patientId: string; entryId: string; contentType: string; byteSize: number; sha256: string; userId: string | null }): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO meal_plan_chat_photos (patient_id, entry_id, content_type, byte_size, sha256, created_by_user_id)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid) RETURNING id::text`,
      [args.patientId, args.entryId, args.contentType, args.byteSize, args.sha256, args.userId],
    );
    return result.rows[0].id;
  }

  async getPhoto(patientId: string, entryId: string, photoId: string): Promise<{ id: string; content_type: string } | null> {
    const result = await this.pool.query<{ id: string; content_type: string }>(
      `SELECT id::text, content_type FROM meal_plan_chat_photos WHERE patient_id = $1::uuid AND entry_id = $2::uuid AND id = $3::uuid`,
      [patientId, entryId, photoId],
    );
    return result.rows[0] ?? null;
  }

  /** Photos of this planned meal among the given ids (a message may only reference its own meal's photos). */
  async countPhotosOfEntry(patientId: string, entryId: string, photoIds: string[]): Promise<number> {
    if (photoIds.length === 0) return 0;
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM meal_plan_chat_photos WHERE patient_id = $1::uuid AND entry_id = $2::uuid AND id = ANY($3::uuid[])`,
      [patientId, entryId, photoIds],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async markAccepted(entryId: string, messageId: string): Promise<void> {
    await this.pool.query(`UPDATE meal_plan_chat_messages SET accepted_at = COALESCE(accepted_at, now()) WHERE entry_id = $1::uuid AND id = $2::uuid`, [entryId, messageId]);
  }
}
