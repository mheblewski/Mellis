import { describe, expect, it, vi } from 'vitest';
import { PostgresGlucoMindRepository } from '../../../infra/db/postgres-glucomind.repository';

describe('Analysis v1.1', () => {
  it('persists the AI execution linkage to the Analysis row', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new PostgresGlucoMindRepository({ query } as any);

    await repository.linkAiExecutionToAnalysis({
      taskIdentity: 'sha256:task-1',
      analysisId: 'analysis-123',
      nowIso: '2026-09-30T12:00:00.000Z',
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE ai_executions'),
      ['sha256:task-1', 'analysis-123', '2026-09-30T12:00:00.000Z'],
    );
  });
});
