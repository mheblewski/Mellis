import { describe, expect, it } from 'vitest';
import { ApiService } from './api.service';
import { ForbiddenError, NotFoundError } from '@shared/errors/app-error';

class InMemoryDeviceRepo {
  private access = new Map<string, { can_read_patient: boolean; can_write_patient: boolean }>();
  private devices = new Map<string, {
    id: string;
    patient_id: string;
    platform: 'ios';
    device_id: string;
    push_token: string;
    app_version: string | null;
    active: boolean;
    last_seen_at: string;
    created_at: string;
    updated_at: string;
  }>();

  setAccess(userId: string, patientId: string, write = true): void {
    this.access.set(`${userId}:${patientId}`, { can_read_patient: true, can_write_patient: write });
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

  async listActivePatientDevices(patientId: string): Promise<any[]> {
    return [...this.devices.values()].filter((item) => item.patient_id === patientId && item.active);
  }

  async upsertPatientDevice(args: {
    patientId: string;
    platform: 'ios';
    deviceId: string;
    pushToken: string;
    appVersion: string | null;
  }): Promise<any> {
    const key = `${args.patientId}:${args.platform}:${args.deviceId}`;
    const existing = this.devices.get(key);
    const now = new Date().toISOString();
    const row = {
      id: existing?.id ?? `dev-${this.devices.size + 1}`,
      patient_id: args.patientId,
      platform: args.platform,
      device_id: args.deviceId,
      push_token: args.pushToken,
      app_version: args.appVersion,
      active: true,
      last_seen_at: now,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };

    this.devices.set(key, row);
    return row;
  }

  async insertAuditEvent(): Promise<void> {
    return;
  }

  async patientHasAnyCaregiverRelationship(patientId: string): Promise<boolean> {
    for (const [key, value] of this.access.entries()) {
      const [userId, targetPatientId] = key.split(':');
      void userId;
      if (targetPatientId === patientId && value.can_read_patient) {
        return true;
      }
    }
    return false;
  }
}

describe('ApiService registerDevice', () => {
  it('registers a new device and returns created=true', async () => {
    const repo = new InMemoryDeviceRepo();
    repo.setAccess('caregiver-1', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', true);
    const api = new ApiService(repo as any);

    const result = await api.registerDevice({ user_id: 'caregiver-1' }, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', {
      platform: 'ios',
      device_id: 'ios-device-1',
      push_token: 'token-a',
      app_version: '0.1.0',
    });

    expect(result.created).toBe(true);
    expect(result.device.push_token).toBe('token-a');
  });

  it('updates existing device token and returns created=false', async () => {
    const repo = new InMemoryDeviceRepo();
    repo.setAccess('caregiver-1', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', true);
    const api = new ApiService(repo as any);

    await api.registerDevice({ user_id: 'caregiver-1' }, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', {
      platform: 'ios',
      device_id: 'ios-device-1',
      push_token: 'token-a',
      app_version: '0.1.0',
    });

    const result = await api.registerDevice({ user_id: 'caregiver-1' }, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', {
      platform: 'ios',
      device_id: 'ios-device-1',
      push_token: 'token-b',
      app_version: '0.1.1',
    });

    expect(result.created).toBe(false);
    expect(result.device.push_token).toBe('token-b');
  });

  it('enforces patient isolation for registration', async () => {
    const repo = new InMemoryDeviceRepo();
    repo.setAccess('caregiver-1', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', true);
    const api = new ApiService(repo as any);

    await expect(api.registerDevice({ user_id: 'caregiver-1' }, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002', {
      platform: 'ios',
      device_id: 'ios-device-1',
      push_token: 'token-a',
      app_version: '0.1.0',
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('returns a forbidden error when the user does not have a relationship to the patient', async () => {
    const repo = new InMemoryDeviceRepo();
    const api = new ApiService(repo as any);

    await expect(api.getPendingInvestigation({ user_id: 'caregiver-1' }, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('returns a forbidden error when the user has a relationship but lacks write permission', async () => {
    const repo = new InMemoryDeviceRepo();
    repo.setAccess('caregiver-1', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', false);
    const api = new ApiService(repo as any);

    await expect(api.registerDevice({ user_id: 'caregiver-1' }, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', {
      platform: 'ios',
      device_id: 'ios-device-1',
      push_token: 'token-a',
      app_version: '0.1.0',
    })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
