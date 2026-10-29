import { describe, expect, it } from 'vitest';
import { isRemoteCommandsServerEnabled, resolveRemoteControlAccess } from './application/remote-control-access';

const on = { patient_remote_control: { enabled: true }, caregiver_permissions: { remote_commands: true } };

describe('remote control access', () => {
  it('needs the server, the patient and the caregiver switch', () => {
    expect(resolveRemoteControlAccess(true, on, 'TRIO')).toEqual({ enabled: true, reason: 'ENABLED', driver: 'TRIO' });
    expect(resolveRemoteControlAccess(false, on, 'TRIO')).toEqual({ enabled: false, reason: 'SERVER_DISABLED', driver: 'TRIO' });
    expect(resolveRemoteControlAccess(true, { ...on, patient_remote_control: { enabled: false } }, 'TRIO')).toEqual({ enabled: false, reason: 'PATIENT_DISABLED', driver: 'TRIO' });
    expect(resolveRemoteControlAccess(true, { ...on, caregiver_permissions: {} }, 'TRIO')).toEqual({ enabled: false, reason: 'CAREGIVER_NOT_PERMITTED', driver: 'TRIO' });
    expect(resolveRemoteControlAccess(true, null, 'TRIO')).toEqual({ enabled: false, reason: 'PATIENT_DISABLED', driver: 'TRIO' });
  });

  it('names the driver of the patient\'s loop: Trio\'s (also for a loop not identified yet), Loop\'s, none for AAPS', () => {
    expect(resolveRemoteControlAccess(true, on, 'UNKNOWN')).toEqual({ enabled: true, reason: 'ENABLED', driver: 'TRIO' });
    expect(resolveRemoteControlAccess(true, on, 'LOOP')).toEqual({ enabled: true, reason: 'ENABLED', driver: 'LOOP' });
    expect(resolveRemoteControlAccess(true, on, 'AAPS')).toEqual({ enabled: false, reason: 'LOOP_SYSTEM_NOT_SUPPORTED', driver: null });
    expect(resolveRemoteControlAccess(true, on, 'OPENAPS')).toEqual({ enabled: false, reason: 'LOOP_SYSTEM_NOT_SUPPORTED', driver: null });
    // The server switch is named first: it is off for everyone.
    expect(resolveRemoteControlAccess(false, on, 'AAPS')).toEqual({ enabled: false, reason: 'SERVER_DISABLED', driver: null });
  });

  it('treats anything but a literal true as off', () => {
    expect(resolveRemoteControlAccess(true, { ...on, patient_remote_control: { enabled: 'true' } }, 'TRIO').enabled).toBe(false);
    expect(resolveRemoteControlAccess(true, { ...on, caregiver_permissions: { remote_commands: 1 } }, 'TRIO').enabled).toBe(false);
    expect(resolveRemoteControlAccess(true, { ...on, caregiver_permissions: null }, 'TRIO').enabled).toBe(false);
    expect(resolveRemoteControlAccess(true, { ...on, patient_remote_control: [true] }, 'TRIO').enabled).toBe(false);
  });

  it('reads the server switch from env', () => {
    expect(isRemoteCommandsServerEnabled({ REMOTE_COMMANDS_ENABLED: 'true' })).toBe(true);
    expect(isRemoteCommandsServerEnabled({ REMOTE_COMMANDS_ENABLED: ' 1 ' })).toBe(true);
    expect(isRemoteCommandsServerEnabled({ REMOTE_COMMANDS_ENABLED: 'false' })).toBe(false);
    expect(isRemoteCommandsServerEnabled({})).toBe(false);
    // Shared boolean rules: only true/1 turn it on (a typo is refused at startup, here it reads as off).
    expect(isRemoteCommandsServerEnabled({ REMOTE_COMMANDS_ENABLED: 'yes' })).toBe(false);
    expect(isRemoteCommandsServerEnabled({ REMOTE_COMMANDS_ENABLED: 'treu' })).toBe(false);
  });
});
