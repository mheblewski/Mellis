import { afterEach, describe, expect, it } from 'vitest';
import { ApiService } from './api.service';
import { ForbiddenError } from '@shared/errors/app-error';

class CapabilitiesRepo {
  switches: Record<string, unknown> | null = { patient_remote_control: { enabled: true }, caregiver_permissions: { remote_commands: true } };
  async getAccessRow(userId: string, patientId: string): Promise<any> {
    return userId === 'u1' ? { user_id: userId, patient_id: patientId, can_read_patient: true, can_write_patient: true } : null;
  }
  async getRemoteControlSwitches(): Promise<any> {
    return this.switches;
  }
  async insertAuditEvent(): Promise<void> {}
  async getLatestRawNightscoutProfile(): Promise<any> {
    return {
      raw_profile: { bundleIdentifier: 'org.nightscout.ABCDE12345.trio', deviceToken: 'b'.repeat(64), isAPNSProduction: false, teamID: 'ABCDE12345', startDate: '2026-10-19T08:00:00Z' },
      stored_at: '2026-10-19T08:01:00.000Z',
    };
  }
}

const principal = (userId: string) => ({ user_id: userId, auth_subject: userId }) as any;

const TRIO_STATUS = { observed_at: '2026-10-28T12:00:00.000Z', raw_payload: { device: 'Trio', openaps: { suggested: { IOB: 1 } } } };
const LOOP_STATUS = { observed_at: '2026-10-28T12:00:00.000Z', raw_payload: { device: 'loop://iPhone', loop: { name: 'Loop', version: '3.14.11', iob: { iob: 1 } } } };

/** The service with the patient's newest loop calculation stubbed (patientLoopSystem reads it). */
function serviceWith(repo: CapabilitiesRepo, status: unknown = TRIO_STATUS): ApiService {
  const service = new ApiService(repo as any, {} as any);
  (service as any).dashboardRepository = { getLatestLoopStatus: async () => status };
  return service;
}

describe('ApiService.getCapabilities', () => {
  const previous = process.env.REMOTE_COMMANDS_ENABLED;
  afterEach(() => {
    if (previous === undefined) delete process.env.REMOTE_COMMANDS_ENABLED;
    else process.env.REMOTE_COMMANDS_ENABLED = previous;
  });

  it('turns remote commands on only with the server, patient and caregiver switches', async () => {
    const repo = new CapabilitiesRepo();
    const service = serviceWith(repo);

    process.env.REMOTE_COMMANDS_ENABLED = 'true';
    expect(await service.getCapabilities(principal('u1'), 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001')).toEqual({
      patient_id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
      loop_system: { kind: 'TRIO', version: null },
      remote_commands: { enabled: true, reason: 'ENABLED', driver: 'TRIO' },
      // No paid AI in tests: nothing to say about the AI limit.
      ai: null,
    });

    repo.switches = { patient_remote_control: { enabled: true }, caregiver_permissions: {} };
    expect((await service.getCapabilities(principal('u1'), 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001')).remote_commands).toEqual({ enabled: false, reason: 'CAREGIVER_NOT_PERMITTED', driver: 'TRIO' });

    process.env.REMOTE_COMMANDS_ENABLED = 'false';
    expect((await service.getCapabilities(principal('u1'), 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001')).remote_commands).toEqual({ enabled: false, reason: 'SERVER_DISABLED', driver: 'TRIO' });
  });

  it('names the patient\'s loop and its driver; an unknown loop keeps Trio\'s', async () => {
    process.env.REMOTE_COMMANDS_ENABLED = 'true';
    const loop = await serviceWith(new CapabilitiesRepo(), LOOP_STATUS).getCapabilities(principal('u1'), 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001');
    expect(loop.loop_system).toEqual({ kind: 'LOOP', version: '3.14.11' });
    expect(loop.remote_commands).toEqual({ enabled: true, reason: 'ENABLED', driver: 'LOOP' });
    const unknown = await serviceWith(new CapabilitiesRepo(), null).getCapabilities(principal('u1'), 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001');
    expect(unknown).toMatchObject({ loop_system: { kind: 'UNKNOWN' }, remote_commands: { enabled: true } });
  });

  it('refuses a caregiver without access to the patient', async () => {
    const service = serviceWith(new CapabilitiesRepo());
    await expect(service.getCapabilities(principal('u2'), 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001')).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('ApiService.getTrioRemoteTarget', () => {
  const previous = process.env.REMOTE_COMMANDS_ENABLED;
  afterEach(() => {
    if (previous === undefined) delete process.env.REMOTE_COMMANDS_ENABLED;
    else process.env.REMOTE_COMMANDS_ENABLED = previous;
  });

  it('gives the Trio address only to a caregiver allowed to send commands', async () => {
    const repo = new CapabilitiesRepo();
    const service = serviceWith(repo);
    process.env.REMOTE_COMMANDS_ENABLED = 'true';
    const result = await service.getTrioRemoteTarget(principal('u1'), 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001');
    expect(result.trio).toMatchObject({ status: 'READY', device_token: 'b'.repeat(64), apns_environment: 'sandbox', team_id: 'ABCDE12345' });

    repo.switches = { patient_remote_control: { enabled: false }, caregiver_permissions: { remote_commands: true } };
    await expect(service.getTrioRemoteTarget(principal('u1'), 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.getTrioRemoteTarget(principal('u2'), 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('gives Loop\'s address from loopSettings (team from the LoopWorkspace bundle id), only to a caregiver allowed to send', async () => {
    process.env.REMOTE_COMMANDS_ENABLED = 'true';
    const repo = new CapabilitiesRepo();
    repo.getLatestRawNightscoutProfile = async () => ({
      raw_profile: { enteredBy: 'Loop', startDate: '2026-10-28T08:00:00Z', isAPNSProduction: true, loopSettings: { deviceToken: 'c'.repeat(64), bundleIdentifier: 'com.ABCDE12345.loopkit.Loop', maximumBolus: 6 } },
      stored_at: '2026-10-28T08:01:00.000Z',
    });
    const result = await serviceWith(repo, LOOP_STATUS).getLoopRemoteTarget(principal('u1'), 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001');
    expect(result.loop).toEqual({ status: 'READY', device_token: 'c'.repeat(64), bundle_id: 'com.ABCDE12345.loopkit.Loop', team_id: 'ABCDE12345', apns_environment: 'production', profile_uploaded_at: '2026-10-28T08:00:00.000Z', max_bolus_u: 6 });
    await expect(serviceWith(repo, LOOP_STATUS).getLoopRemoteTarget(principal('u2'), 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001')).rejects.toBeInstanceOf(ForbiddenError);
    // The patient moved to Trio: the Loop profile still in Nightscout is no address.
    expect((await serviceWith(repo, TRIO_STATUS).getLoopRemoteTarget(principal('u1'), 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001')).loop).toMatchObject({ status: 'NOT_LOOP', device_token: null });
  });

});
