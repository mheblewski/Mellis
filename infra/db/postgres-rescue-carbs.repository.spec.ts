import { describe, expect, it } from 'vitest';
import { PostgresRescueCarbsRepository } from './postgres-rescue-carbs.repository';

/** A pool whose one client answers by statement and records every statement with its values. */
function fakePool() {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const rowsFor = (sql: string): Record<string, unknown>[] => {
    if (/SELECT \* FROM rescue_carb_proposals/.test(sql)) return [{ id: 'card-1', status: 'PROPOSED' }];
    if (/SELECT id FROM rescue_carb_alerts/.test(sql)) return [{ id: 'alert-1' }];
    if (/INSERT INTO (sources|source_records|events)/.test(sql)) return [{ id: 'row-1' }];
    if (/UPDATE rescue_carb_proposals/.test(sql)) {
      return [{ id: 'card-1', patient_id: 'p1', conversation_id: 'c1', user_message_id: 'm1', carbs_g: 10, status: 'ACCEPTED', created_at: '2026-10-21T12:00:00.000Z' }];
    }
    return [];
  };
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      return { rows: rowsFor(sql) };
    },
    release: () => {},
  };
  return { pool: { connect: async () => client } as never, statements };
}

describe('PostgresRescueCarbsRepository: where an alert\'s carbs came from', () => {
  const args = { patientId: 'p1', carbsG: 8, givenAt: '2026-10-21T12:00:00.000Z', userId: 'u1' };
  const alertUpdate = (statements: Array<{ sql: string; values: unknown[] }>) => statements.find((statement) => /UPDATE rescue_carb_alerts/.test(statement.sql))!;

  it('marks an open alert treated by a card of an ordinary conversation as CHAT_CARD, with the card', async () => {
    const { pool, statements } = fakePool();
    const result = await new PostgresRescueCarbsRepository(pool).acceptChatProposal({ ...args, conversationId: 'c1', proposalId: 'card-1' });
    expect(result).toMatchObject({ status: 'LOGGED', alert_id: 'alert-1' });
    expect(alertUpdate(statements).values.slice(5)).toEqual(['CHAT_CARD', 'card-1']);
  });
});
