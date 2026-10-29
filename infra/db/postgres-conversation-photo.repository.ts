import type { Pool } from 'pg';

export interface ConversationPhotoRow {
  id: string;
  patient_id: string;
  conversation_id: string;
  content_type: string;
  byte_size: number;
}

/** Metadata of the main chat's photos; the JPEGs themselves are on disk (MealPhotoStorage, by photo id). */
export class PostgresConversationPhotoRepository {
  constructor(private readonly pool: Pool) {}

  async insertPhoto(args: { patientId: string; conversationId: string; contentType: string; byteSize: number; sha256: string; userId: string | null }): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `
        INSERT INTO conversation_photos (patient_id, conversation_id, content_type, byte_size, sha256, created_by_user_id)
        VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)
        RETURNING id::text
      `,
      [args.patientId, args.conversationId, args.contentType, args.byteSize, args.sha256, args.userId],
    );
    return result.rows[0].id;
  }

  async getPhoto(patientId: string, conversationId: string, photoId: string): Promise<ConversationPhotoRow | null> {
    const result = await this.pool.query<ConversationPhotoRow>(
      `
        SELECT id::text, patient_id::text, conversation_id::text, content_type, byte_size
        FROM conversation_photos
        WHERE patient_id = $1::uuid AND conversation_id = $2::uuid AND id = $3::uuid
      `,
      [patientId, conversationId, photoId],
    );
    return result.rows[0] ?? null;
  }

  /** Photos of this conversation among the given ids (a message may only reference its own conversation's photos). */
  async countPhotosOfConversation(patientId: string, conversationId: string, photoIds: string[]): Promise<number> {
    if (photoIds.length === 0) return 0;
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM conversation_photos WHERE patient_id = $1::uuid AND conversation_id = $2::uuid AND id = ANY($3::uuid[])`,
      [patientId, conversationId, photoIds],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}
