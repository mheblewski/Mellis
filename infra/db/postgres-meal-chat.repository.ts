import type { Pool } from 'pg';

/** One macro item of a proposal, as the model computed it (DiabCalc product values or its own estimate). */
export interface MealChatProposalItem {
  name: string;
  grams: number | null;
  carbs_g: number;
  protein_g: number;
  fat_g: number;
  source: 'DIABCALC' | 'ESTIMATE';
}

export interface MealChatProposal {
  items: MealChatProposalItem[];
  carbs_g: number;
  protein_g: number;
  fat_g: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  assumptions: string;
  /** Set when the proposal became the meal record's pending proposal (confirmable as such). */
  proposal_id?: string | null;
}

export interface MealChatMessage {
  id: string;
  role: 'USER' | 'ASSISTANT';
  content: string;
  photo_ids: string[];
  proposal: MealChatProposal | null;
  question: string | null;
  author_display_name: string | null;
  /** Who sent it (null for the assistant and notes); the reply job reads this user's AI preferences. */
  author_user_id?: string | null;
  reply_to_message_id: string | null;
  /** Set on the note that a change of this meal was confirmed in a conversation (043). */
  origin_conversation_id: string | null;
  created_at: string;
}

export interface MealPhotoRow {
  id: string;
  patient_id: string;
  meal_record_id: string;
  content_type: string;
  byte_size: number;
}

const DISPLAY_NAME_SQL = `
  CASE WHEN u.display_name ~* '^(cognito:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN NULL ELSE u.display_name END
`;

function toMessage(row: Record<string, unknown>): MealChatMessage {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  return {
    id: String(row.id),
    role: row.role === 'ASSISTANT' ? 'ASSISTANT' : 'USER',
    content: String(row.content ?? ''),
    photo_ids: Array.isArray(row.photo_ids) ? row.photo_ids.map(String) : [],
    proposal: (row.proposal as MealChatProposal | null) ?? null,
    question: typeof row.question === 'string' ? row.question : null,
    author_display_name: typeof row.author_display_name === 'string' ? row.author_display_name : null,
    author_user_id: row.author_user_id ? String(row.author_user_id) : null,
    reply_to_message_id: row.reply_to_message_id ? String(row.reply_to_message_id) : null,
    origin_conversation_id: row.origin_conversation_id ? String(row.origin_conversation_id) : null,
    created_at: createdAt,
  };
}

export class PostgresMealChatRepository {
  constructor(private readonly pool: Pool) {}

  async insertPhoto(args: { patientId: string; mealRecordId: string; contentType: string; byteSize: number; sha256: string; userId: string | null }): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `
        INSERT INTO meal_photos (patient_id, meal_record_id, content_type, byte_size, sha256, created_by_user_id)
        VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)
        RETURNING id::text
      `,
      [args.patientId, args.mealRecordId, args.contentType, args.byteSize, args.sha256, args.userId],
    );
    return result.rows[0].id;
  }

  async getPhoto(patientId: string, mealRecordId: string, photoId: string): Promise<MealPhotoRow | null> {
    const result = await this.pool.query<MealPhotoRow>(
      `
        SELECT id::text, patient_id::text, meal_record_id::text, content_type, byte_size
        FROM meal_photos
        WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid AND id = $3::uuid
      `,
      [patientId, mealRecordId, photoId],
    );
    return result.rows[0] ?? null;
  }

  /** Photos of this meal among the given ids (a message may only reference its own meal's photos). */
  async countPhotosOfMeal(patientId: string, mealRecordId: string, photoIds: string[]): Promise<number> {
    if (photoIds.length === 0) return 0;
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM meal_photos WHERE patient_id = $1::uuid AND meal_record_id = $2::uuid AND id = ANY($3::uuid[])`,
      [patientId, mealRecordId, photoIds],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /** Idempotent per (meal, key): a retried send returns the stored message with created=false. */
  async insertUserMessage(args: {
    patientId: string;
    mealRecordId: string;
    content: string;
    photoIds: string[];
    authorUserId: string;
    idempotencyKey: string;
  }): Promise<{ message: MealChatMessage; created: boolean }> {
    const inserted = await this.pool.query<{ id: string }>(
      `
        INSERT INTO meal_chat_messages (patient_id, meal_record_id, role, content, photo_ids, author_user_id, idempotency_key)
        VALUES ($1::uuid, $2::uuid, 'USER', $3, $4::uuid[], $5::uuid, $6)
        ON CONFLICT (meal_record_id, idempotency_key) DO NOTHING
        RETURNING id::text
      `,
      [args.patientId, args.mealRecordId, args.content, args.photoIds, args.authorUserId, `user:${args.idempotencyKey}`],
    );
    const id = inserted.rows[0]?.id
      ?? (await this.pool.query<{ id: string }>(
        `SELECT id::text FROM meal_chat_messages WHERE meal_record_id = $1::uuid AND idempotency_key = $2`,
        [args.mealRecordId, `user:${args.idempotencyKey}`],
      )).rows[0].id;
    const message = await this.getMessage(args.patientId, args.mealRecordId, id);
    return { message: message as MealChatMessage, created: Boolean(inserted.rows[0]) };
  }

  /** One reply per user message (job retries do not duplicate it). */
  async insertAssistantMessage(args: {
    patientId: string;
    mealRecordId: string;
    replyToMessageId: string;
    content: string;
    question: string | null;
    proposal: MealChatProposal | null;
  }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO meal_chat_messages (patient_id, meal_record_id, role, content, question, proposal, reply_to_message_id, idempotency_key)
        VALUES ($1::uuid, $2::uuid, 'ASSISTANT', $3, $4, $5::jsonb, $6::uuid, $7)
        ON CONFLICT (meal_record_id, idempotency_key) DO NOTHING
      `,
      [
        args.patientId,
        args.mealRecordId,
        args.content,
        args.question,
        args.proposal ? JSON.stringify(args.proposal) : null,
        args.replyToMessageId,
        `assistant:${args.replyToMessageId}`,
      ],
    );
  }

  async hasReply(mealRecordId: string, userMessageId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM meal_chat_messages WHERE meal_record_id = $1::uuid AND idempotency_key = $2`,
      [mealRecordId, `assistant:${userMessageId}`],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listMessages(patientId: string, mealRecordId: string): Promise<MealChatMessage[]> {
    const result = await this.pool.query(
      `
        SELECT m.id, m.role, m.content, m.photo_ids::text[] AS photo_ids, m.proposal, m.question, m.reply_to_message_id,
               m.origin_conversation_id, m.created_at, m.author_user_id, ${DISPLAY_NAME_SQL} AS author_display_name
        FROM meal_chat_messages m
        LEFT JOIN users u ON u.id = m.author_user_id
        WHERE m.patient_id = $1::uuid AND m.meal_record_id = $2::uuid
        ORDER BY m.created_at ASC, m.id ASC
      `,
      [patientId, mealRecordId],
    );
    return result.rows.map(toMessage);
  }

  async getMessage(patientId: string, mealRecordId: string, messageId: string): Promise<MealChatMessage | null> {
    const result = await this.pool.query(
      `
        SELECT m.id, m.role, m.content, m.photo_ids::text[] AS photo_ids, m.proposal, m.question, m.reply_to_message_id,
               m.origin_conversation_id, m.created_at, m.author_user_id, ${DISPLAY_NAME_SQL} AS author_display_name
        FROM meal_chat_messages m
        LEFT JOIN users u ON u.id = m.author_user_id
        WHERE m.patient_id = $1::uuid AND m.meal_record_id = $2::uuid AND m.id = $3::uuid
      `,
      [patientId, mealRecordId, messageId],
    );
    return result.rows[0] ? toMessage(result.rows[0]) : null;
  }
}
