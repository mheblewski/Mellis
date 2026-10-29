import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresGlucoMindRepository } from './postgres-glucomind.repository';
import { configurePostgresIntegrationEnvironment, truncatePublicTablesForIntegrationTests } from './postgres-test-isolation';

const runPostgresIntegration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgresIntegration ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

describePostgres('conversation names and pins in the history list (PostgreSQL)', () => {
  let pool: Pool;
  let repository: PostgresGlucoMindRepository;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required for conversation list settings postgres tests');
    }
    pool = new Pool({ connectionString: databaseUrl });
    repository = new PostgresGlucoMindRepository(pool);
  });

  beforeEach(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
  });

  afterAll(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    await pool?.end();
  });

  /** Conversations c0..c(n-1), c0 the most recently updated. */
  async function scaffold(count: number) {
    const patientId = randomUUID();
    const userId = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'p')`, [patientId]);
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const created = await repository.createConversation({
        patientId, origin: 'USER', conversationType: 'USER_INITIATED', threadStateVersion: 'conv-v1', awaitingUserAnswer: false,
      });
      const id = String(created.conversation.id);
      await pool.query(`UPDATE conversations SET updated_at = $2::timestamptz WHERE id = $1`, [id, new Date(Date.UTC(2026, 9, 16, 12) - index * 60_000).toISOString()]);
      ids.push(id);
    }
    return { patientId, userId, ids };
  }

  const listIds = (result: { items: unknown[] }) => result.items.map((item) => (item as { id: string }).id);

  it('lists every pinned conversation first, on the first page only, and pages through the others without gaps', async () => {
    const { patientId, userId, ids } = await scaffold(5);
    await repository.updateConversationListSettings({ patientId, conversationId: ids[3], userId, pinned: true });
    await pool.query(`UPDATE conversations SET pinned_at = now() - interval '1 minute' WHERE id = $1`, [ids[3]]);
    await repository.updateConversationListSettings({ patientId, conversationId: ids[4], userId, pinned: true });

    const first = await repository.listConversations(patientId, 2, null);
    // Most recently pinned on top, then the two most recently updated unpinned ones.
    expect(listIds(first)).toEqual([ids[4], ids[3], ids[0], ids[1]]);
    expect((first.items[0] as Record<string, unknown>).pinned_at).not.toBeNull();
    expect((first.items[2] as Record<string, unknown>).pinned_at).toBeNull();
    expect(first.nextCursor).not.toBeNull();

    const second = await repository.listConversations(patientId, 2, first.nextCursor);
    expect(listIds(second)).toEqual([ids[2]]);
    expect(second.nextCursor).toBeNull();

    await repository.updateConversationListSettings({ patientId, conversationId: ids[4], userId, pinned: false });
    expect(listIds(await repository.listConversations(patientId, 10, null))).toEqual([ids[3], ids[0], ids[1], ids[2], ids[4]]);
  });

  it('keeps a caregiver\'s name over the AI\'s, and does not move the conversation in the list', async () => {
    const { patientId, userId, ids } = await scaffold(2);
    await repository.setAiConversationTitleIfMissing(ids[1], 'Pizza w sobotę');
    await repository.setAiConversationTitleIfMissing(ids[1], 'Inna nazwa');
    let list = await repository.listConversations(patientId, 10, null);
    expect(list.items[1]).toMatchObject({ id: ids[1], title: 'Pizza w sobotę', title_source: 'AI' });

    await expect(repository.updateConversationListSettings({ patientId, conversationId: ids[1], userId, title: 'Moja nazwa' })).resolves.toBe(true);
    await repository.setAiConversationTitleIfMissing(ids[1], 'Nazwa od AI');
    list = await repository.listConversations(patientId, 10, null);
    expect(listIds(list)).toEqual([ids[0], ids[1]]);
    expect(list.items[1]).toMatchObject({ title: 'Moja nazwa', title_source: 'USER' });
    expect(list.items[0]).toMatchObject({ title: null, title_source: null, pinned_at: null });
  });

  it('changes nothing for a deleted conversation or another patient\'s one', async () => {
    const { patientId, userId, ids } = await scaffold(1);
    await expect(repository.updateConversationListSettings({ patientId: randomUUID(), conversationId: ids[0], userId, pinned: true })).resolves.toBe(false);
    await repository.softDeleteConversation(patientId, ids[0], userId);
    await expect(repository.updateConversationListSettings({ patientId, conversationId: ids[0], userId, title: 'X' })).resolves.toBe(false);
  });
});
