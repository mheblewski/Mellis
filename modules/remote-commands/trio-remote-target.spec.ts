import { describe, expect, it } from 'vitest';
import { readTrioRemoteTarget } from './application/trio-remote-target';

const token = 'a'.repeat(64);
const trioProfile = {
  defaultProfile: 'default',
  startDate: '2026-10-19T08:00:00.000Z',
  mills: 1760860800000,
  units: 'mg/dl',
  enteredBy: 'Trio',
  store: { default: {} },
  bundleIdentifier: 'org.nightscout.ABCDE12345.trio',
  deviceToken: token.toUpperCase(),
  isAPNSProduction: true,
  teamID: 'ABCDE12345',
  expirationDate: '2027-01-10T00:00:00Z',
};

describe('Trio remote target from the Nightscout profile', () => {
  it('reads the device token, bundle, team and APNs environment Trio uploads', () => {
    expect(readTrioRemoteTarget(trioProfile, null)).toEqual({
      status: 'READY',
      device_token: token,
      bundle_id: 'org.nightscout.ABCDE12345.trio',
      team_id: 'ABCDE12345',
      apns_environment: 'production',
      profile_uploaded_at: '2026-10-19T08:00:00.000Z',
      remote_commands: null,
      build_expires_at: '2027-01-10T00:00:00.000Z',
    });
  });

  it('knows the sandbox environment and the command list of newer builds', () => {
    const target = readTrioRemoteTarget({ ...trioProfile, isAPNSProduction: false, remoteCommands: ['bolus', 'meal', 7] }, null);
    expect(target.apns_environment).toBe('sandbox');
    expect(target.remote_commands).toEqual(['bolus', 'meal']);
  });

  it('says what is missing instead of addressing a wrong phone', () => {
    expect(readTrioRemoteTarget({ ...trioProfile, deviceToken: '' }, null).status).toBe('MISSING_TOKEN');
    expect(readTrioRemoteTarget({ ...trioProfile, deviceToken: 'not-hex' }, null)).toMatchObject({ status: 'MISSING_TOKEN', device_token: null });
    expect(readTrioRemoteTarget({ ...trioProfile, teamID: 'bad' }, null).status).toBe('MISSING_TOKEN');
    // A Loop or hand-edited profile has none of Trio's remote fields.
    expect(readTrioRemoteTarget({ defaultProfile: 'Default', store: { Default: {} } }, '2026-10-19T07:00:00Z')).toMatchObject({ status: 'NOT_TRIO', profile_uploaded_at: '2026-10-19T07:00:00.000Z' });
    expect(readTrioRemoteTarget(null, null).status).toBe('NO_PROFILE');
  });
});
