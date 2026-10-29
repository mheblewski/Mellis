import type { Pool } from 'pg';

export type ReplyThreadKind = 'CONVERSATION' | 'MEAL_CHAT';

export interface ReplyDraft {
  thread_kind: ReplyThreadKind;
  thread_id: string;
  reply_to_message_id: string;
  content: string;
  updated_at: string;
}

/**
 * The answer text while the model writes it (042_live_updates.sql). One row per conversation or meal chat: a new answer
 * replaces the previous draft, the stored answer deletes it. Every write is announced to the app by a row trigger.
 */
export class PostgresReplyDraftRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async upsert(args: { kind: ReplyThreadKind; threadId: string; patientId: string; replyToMessageId: string; content: string }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO reply_drafts (thread_kind, thread_id, patient_id, reply_to_message_id, content, updated_at)
        VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, now())
        ON CONFLICT (thread_kind, thread_id) DO UPDATE
        SET reply_to_message_id = EXCLUDED.reply_to_message_id, content = EXCLUDED.content, updated_at = now()
        WHERE reply_drafts.content IS DISTINCT FROM EXCLUDED.content
          OR reply_drafts.reply_to_message_id IS DISTINCT FROM EXCLUDED.reply_to_message_id
      `,
      [args.kind, args.threadId, args.patientId, args.replyToMessageId, args.content],
    );
  }

  /** Deletes the draft of this answer only, so a newer answer's draft in the same thread survives. */
  async delete(args: { kind: ReplyThreadKind; threadId: string; replyToMessageId: string }): Promise<void> {
    await this.pool.query(
      `DELETE FROM reply_drafts WHERE thread_kind = $1 AND thread_id = $2::uuid AND reply_to_message_id = $3::uuid`,
      [args.kind, args.threadId, args.replyToMessageId],
    );
  }

  async get(kind: ReplyThreadKind, threadId: string, patientId: string): Promise<ReplyDraft | null> {
    const result = await this.pool.query(
      `
        SELECT thread_kind, thread_id::text, reply_to_message_id::text, content, updated_at
        FROM reply_drafts
        WHERE thread_kind = $1 AND thread_id = $2::uuid AND patient_id = $3::uuid
          -- A draft left behind by a crashed worker is not an answer in progress.
          AND updated_at > now() - interval '5 minutes'
      `,
      [kind, threadId, patientId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      thread_kind: row.thread_kind as ReplyThreadKind,
      thread_id: String(row.thread_id),
      reply_to_message_id: String(row.reply_to_message_id),
      content: String(row.content),
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }
}
