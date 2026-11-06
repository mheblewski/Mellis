import type { Pool } from 'pg';
import { sanitizeMetricCard, type MetricCard } from '@modules/context/application/metric-card';

export type ReplyThreadKind = 'CONVERSATION' | 'MEAL_CHAT';

export interface ReplyDraft {
  thread_kind: ReplyThreadKind;
  thread_id: string;
  reply_to_message_id: string;
  content: string;
  /** The value card above the answer, known before the model writes (chat-metric-card.v1). */
  metric_card: MetricCard | null;
  updated_at: string;
  /** cards-after-text.v1: the answer is finished and its cards are coming; null while the text is written. */
  answer_ready: Record<string, unknown> | null;
}

/**
 * The answer text while the model writes it (042_live_updates.sql). One row per conversation or meal chat: a new answer
 * replaces the previous draft, the stored answer deletes it. Every write is announced to the app by a row trigger.
 */
export class PostgresReplyDraftRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async upsert(args: { kind: ReplyThreadKind; threadId: string; patientId: string; replyToMessageId: string; content: string; metricCard?: MetricCard | null }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO reply_drafts (thread_kind, thread_id, patient_id, reply_to_message_id, content, metric_card, updated_at)
        VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6::jsonb, now())
        ON CONFLICT (thread_kind, thread_id) DO UPDATE
        SET reply_to_message_id = EXCLUDED.reply_to_message_id, content = EXCLUDED.content, metric_card = EXCLUDED.metric_card, updated_at = now(),
          answer_ready = CASE WHEN reply_drafts.reply_to_message_id IS DISTINCT FROM EXCLUDED.reply_to_message_id THEN NULL ELSE reply_drafts.answer_ready END
        WHERE reply_drafts.content IS DISTINCT FROM EXCLUDED.content
          OR reply_drafts.reply_to_message_id IS DISTINCT FROM EXCLUDED.reply_to_message_id
          OR reply_drafts.metric_card IS DISTINCT FROM EXCLUDED.metric_card
      `,
      [args.kind, args.threadId, args.patientId, args.replyToMessageId, args.content, args.metricCard ? JSON.stringify(args.metricCard) : null],
    );
  }

  /** The answer of this draft is finished (cards-after-text.v1), or null when it is being written again. */
  async setAnswerReady(args: { kind: ReplyThreadKind; threadId: string; replyToMessageId: string; answerReady: Record<string, unknown> | null }): Promise<void> {
    await this.pool.query(
      // The draft's own event carries text only: the conversation event makes the app read this mark at once.
      `WITH marked AS (
         UPDATE reply_drafts SET answer_ready = $4::jsonb, updated_at = now()
         WHERE thread_kind = $1 AND thread_id = $2::uuid AND reply_to_message_id = $3::uuid
         RETURNING patient_id, thread_id, thread_kind
       )
       SELECT glucomind_notify_event(patient_id, 'conversation', thread_id::text) FROM marked WHERE thread_kind = 'CONVERSATION'`,
      [args.kind, args.threadId, args.replyToMessageId, args.answerReady === null ? null : JSON.stringify(args.answerReady)],
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
        SELECT thread_kind, thread_id::text, reply_to_message_id::text, content, metric_card, updated_at, answer_ready
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
      metric_card: sanitizeMetricCard(row.metric_card),
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      answer_ready: (row.answer_ready as Record<string, unknown> | null | undefined) ?? null,
    };
  }
}
