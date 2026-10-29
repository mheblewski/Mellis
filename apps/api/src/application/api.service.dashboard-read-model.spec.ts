import { describe, expect, it } from 'vitest';
import { ApiService } from './api.service';
import { ForbiddenError } from '@shared/errors/app-error';

class InMemoryDashboardReadRepo {
  private access = new Map<string, { can_read_patient: boolean; can_write_patient: boolean }>();
  private pendingInvestigation = new Map<string, Record<string, unknown> | null>();

  setAccess(userId: string, patientId: string, read = true, write = true): void {
    this.access.set(`${userId}:${patientId}`, { can_read_patient: read, can_write_patient: write });
  }

  setPendingInvestigation(patientId: string, value: Record<string, unknown> | null): void {
    this.pendingInvestigation.set(patientId, value);
  }

  async getAccessRow(userId: string, patientId: string): Promise<any> {
    const row = this.access.get(`${userId}:${patientId}`);
    if (!row) {
      return null;
    }

    return {
      user_id: userId,
      patient_id: patientId,
      can_read_patient: row.can_read_patient,
      can_write_patient: row.can_write_patient,
    };
  }

  async getPendingInvestigation(patientId: string): Promise<Record<string, unknown> | null> {
    return this.pendingInvestigation.get(patientId) ?? null;
  }

  async insertAuditEvent(): Promise<void> {
    return;
  }
}

describe('ApiService dashboard read models', () => {
  it('returns the pending investigation', async () => {
    const repo = new InMemoryDashboardReadRepo();
    repo.setAccess('caregiver-1', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', true, true);
    repo.setPendingInvestigation('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', {
      investigation_id: 'inv-1',
      state: 'QUESTION_PENDING',
      question: 'Was there activity before the drop?',
      question_id: 'activity_before_drop',
      conversation_id: 'conv-1',
      event_id: 'evt-1',
    });
    const api = new ApiService(repo as any);

    const result = await api.getPendingInvestigation({ user_id: 'caregiver-1' } as any, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001');
    expect(result.pending_investigation).toEqual({
      investigation_id: 'inv-1',
      state: 'QUESTION_PENDING',
      question: 'Was there activity before the drop?',
      question_id: 'activity_before_drop',
      conversation_id: 'conv-1',
      event_id: 'evt-1',
    });
  });

  it('enforces patient isolation for dashboard read models', async () => {
    const repo = new InMemoryDashboardReadRepo();
    const api = new ApiService(repo as any);

    await expect(api.getPendingInvestigation({ user_id: 'caregiver-1' } as any, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001')).rejects.toBeInstanceOf(ForbiddenError);
  });
});
