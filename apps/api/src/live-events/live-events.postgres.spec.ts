import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { configurePostgresIntegrationEnvironment } from '@infra/db/postgres-test-isolation';
import { PostgresReplyDraftRepository } from '@infra/db/postgres-reply-drafts.repository';
import { LiveEventsService } from './live-events.service';

const describePostgres = process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

class FakeResponse extends EventEmitter {
  chunks: string[] = [];
  writableEnded = false;
  status() { return this; }
  setHeader() {}
  flushHeaders() {}
  write(chunk: string) { this.chunks.push(chunk); return true; }
  end() { this.writableEnded = true; this.emit('close'); }
}

const dataOf = (response: FakeResponse, event: string) => response.chunks
  .filter((chunk) => chunk.startsWith(`event: ${event}\n`))
  .map((chunk) => JSON.parse(chunk.split('\n')[1]!.slice(6)));

describePostgres('live events from database triggers (042_live_updates)', () => {
  let pool: Pool;
  let service: LiveEventsService;
  const patientId = randomUUID();
  const conversationId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'live-events')`, [patientId]);
    await pool.query(`INSERT INTO conversations (id, patient_id, thread_state_version) VALUES ($1::uuid, $2::uuid, 'v1')`, [conversationId, patientId]);
    service = new LiveEventsService(pool, { getOrThrow: () => process.env.DATABASE_URL } as any);
    await service.onModuleInit();
    await vi.waitFor(() => expect((service as any).listener.connected).toBe(true), { timeout: 5000 });
  });

  afterAll(async () => {
    await service?.onApplicationShutdown();
    await pool?.end();
  });

  it('streams a new message as one conversation change and a draft as deltas until it is cleared', async () => {
    const response = new FakeResponse();
    service.stream(patientId, { socket: { setNoDelay() {}, setKeepAlive() {} } } as any, response as any);

    const userMessageId = randomUUID();
    await pool.query(
      `INSERT INTO messages (id, conversation_id, patient_id, role, message_type, content, provenance_ref, idempotency_key)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'USER', 'USER_MESSAGE', 'Jak dziś?', 'test', $4)`,
      [userMessageId, conversationId, patientId, randomUUID()],
    );
    await vi.waitFor(() => expect(dataOf(response, 'change')).toEqual([{ kind: 'conversation', id: conversationId }]), { timeout: 3000 });

    const drafts = new PostgresReplyDraftRepository(pool);
    await drafts.upsert({ kind: 'CONVERSATION', threadId: conversationId, patientId, replyToMessageId: userMessageId, content: 'Gli' });
    await vi.waitFor(() => expect(dataOf(response, 'draft')).toHaveLength(1), { timeout: 3000 });
    await drafts.upsert({ kind: 'CONVERSATION', threadId: conversationId, patientId, replyToMessageId: userMessageId, content: 'Glikemia OK' });
    await vi.waitFor(() => expect(dataOf(response, 'draft')).toHaveLength(2), { timeout: 3000 });
    await drafts.delete({ kind: 'CONVERSATION', threadId: conversationId, replyToMessageId: userMessageId });
    await vi.waitFor(() => expect(dataOf(response, 'draft')).toHaveLength(3), { timeout: 3000 });

    expect(dataOf(response, 'draft')).toEqual([
      { thread: 'conversation', id: conversationId, reply_to: userMessageId, offset: 0, delta: 'Gli' },
      { thread: 'conversation', id: conversationId, reply_to: userMessageId, offset: 3, delta: 'kemia OK' },
      { thread: 'conversation', id: conversationId, cleared: true },
    ]);
    response.end();
  });
});
