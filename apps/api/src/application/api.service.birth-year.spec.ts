import { describe, expect, it } from 'vitest';
import { ApiService } from './api.service';
import { ForbiddenError, NotFoundError, ValidationError } from '@shared/errors/app-error';

class BirthYearRepo {
  birthYears = new Map<string, number>([['aaaaaaaa-aaaa-4aaa-8aaa-000000000001', 2015]]);
  async getAccessRow(userId: string, patientId: string): Promise<any> {
    return userId === 'u1' ? { user_id: userId, patient_id: patientId, can_read_patient: true, can_write_patient: true } : null;
  }
  async insertAuditEvent(): Promise<void> {}
  async setPatientBirthYear(patientId: string, birthYear: number): Promise<boolean> {
    if (patientId === 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002') return false;
    this.birthYears.set(patientId, birthYear);
    return true;
  }
}

const principal = (userId: string) => ({ user_id: userId, auth_subject: userId }) as any;

describe('ApiService.setPatientBirthYear', () => {
  it('saves a whole year between 1900 and this year', async () => {
    const repo = new BirthYearRepo();
    const service = new ApiService(repo as any, {} as any);
    expect(await service.setPatientBirthYear(principal('u1'), 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', { birth_year: 2017 })).toEqual({ patient_id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', birth_year: 2017 });
    expect(repo.birthYears.get('aaaaaaaa-aaaa-4aaa-8aaa-000000000001')).toBe(2017);
  });

  it('refuses a missing, fractional, text or future year', async () => {
    const service = new ApiService(new BirthYearRepo() as any, {} as any);
    const nextYear = new Date().getUTCFullYear() + 1;
    for (const body of [{}, { birth_year: 2017.5 }, { birth_year: '2017' }, { birth_year: 1899 }, { birth_year: nextYear }]) {
      await expect(service.setPatientBirthYear(principal('u1'), 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', body)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('refuses a caregiver without access, and a patient that does not exist', async () => {
    const service = new ApiService(new BirthYearRepo() as any, {} as any);
    await expect(service.setPatientBirthYear(principal('u2'), 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', { birth_year: 2017 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.setPatientBirthYear(principal('u1'), 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002', { birth_year: 2017 })).rejects.toBeInstanceOf(NotFoundError);
  });
});
