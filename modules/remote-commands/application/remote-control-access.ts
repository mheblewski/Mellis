/**
 * Who may send remote commands to the patient's loop (remote-bolus-trio-plan.md, W1). Three switches, all required:
 * the server's (REMOTE_COMMANDS_ENABLED), the patient's (patients.remote_control.enabled) and the caregiver's
 * (caregiver_relationships.permissions.remote_commands), and a loop GlucoMind can send to (Trio or Loop, each with its
 * own driver on the phone; not AAPS: loop-support-plan.md). The first one that fails is the reason shown in settings.
 *
 * This only decides whether GlucoMind offers and authorizes a command. The final say stays with Trio: its own Remote
 * Control switch and shared secret.
 */

import { readBooleanFlag } from '@infra/config/environment';
import { remoteCommandDriver, type LoopSystemKind, type RemoteCommandDriver } from '@modules/loop-system/domain/loop-system';

export type RemoteControlReason = 'ENABLED' | 'SERVER_DISABLED' | 'LOOP_SYSTEM_NOT_SUPPORTED' | 'PATIENT_DISABLED' | 'CAREGIVER_NOT_PERMITTED';

export interface RemoteControlAccess {
  enabled: boolean;
  reason: RemoteControlReason;
  /** How the phone sends to this patient's loop; null when it cannot. */
  driver: RemoteCommandDriver | null;
}

/** The stored switches for one caregiver and patient; null patient or caregiver fields mean the switch is off. */
export interface RemoteControlSwitches {
  patient_remote_control: unknown;
  caregiver_permissions: unknown;
}

/** REMOTE_COMMANDS_ENABLED with the shared boolean rules (true/1; a typo is refused at startup). */
export function isRemoteCommandsServerEnabled(env: Record<string, string | undefined>): boolean {
  return readBooleanFlag(env, 'REMOTE_COMMANDS_ENABLED');
}

export function resolveRemoteControlAccess(serverEnabled: boolean, switches: RemoteControlSwitches | null, loopSystem: LoopSystemKind): RemoteControlAccess {
  const driver = remoteCommandDriver(loopSystem);
  const off = (reason: RemoteControlReason): RemoteControlAccess => ({ enabled: false, reason, driver });
  if (!serverEnabled) return off('SERVER_DISABLED');
  if (!driver) return off('LOOP_SYSTEM_NOT_SUPPORTED');
  if (!switches || !isOn(switches.patient_remote_control, 'enabled')) return off('PATIENT_DISABLED');
  if (!isOn(switches.caregiver_permissions, 'remote_commands')) return off('CAREGIVER_NOT_PERMITTED');
  return { enabled: true, reason: 'ENABLED', driver };
}

/** Only a literal true turns a switch on: a string, a number or a missing key is off. */
function isOn(value: unknown, key: string): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>)[key] === true;
}
