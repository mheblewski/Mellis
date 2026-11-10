import { describe, expect, it, vi } from 'vitest';
import { CodedError } from '@shared/errors/app-error';
import { DiagnosticsController } from './diagnostics.controller';

describe('DiagnosticsController', () => {
  it('refuses anyone who owns no patient', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const controller = new DiagnosticsController({ query } as never);
    await expect(controller.getReport({ user_id: 'u-1' })).rejects.toMatchObject({ code: 'NOT_AN_OWNER', httpStatus: 403 });
    await expect(controller.getReport({ user_id: 'u-1' })).rejects.toBeInstanceOf(CodedError);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('is_owner'), ['u-1']);
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('diagnostic_events'), expect.anything());
  });

  it('gives an owner the report even when parts of it cannot be read', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('is_owner')) return { rowCount: 1, rows: [{}] };
      throw new Error('relation is missing');
    });
    const controller = new DiagnosticsController({ query } as never);
    const { text } = await controller.getReport({ user_id: 'u-1' });
    expect(text).toContain('RAPORT SERWERA');
    expect(text).toContain('nie udało się odczytać');
  });
});
