/**
 * Sharing a patient profile (the onboarding-sharing plan, stage 1): memberships with permissions, e-mail
 * invitations and the closed beta's allowlist. The rules the database does not enforce by itself live here.
 */

/** People with access to one patient, members and open invitations together. */
export const MAX_PEOPLE_PER_PATIENT = 10;
export const INVITATION_VALID_DAYS = 7;

/**
 * What a membership allows. manage_sharing is the owner flag (an owner manages sharing and can grant remote bolus);
 * remote_commands is the remote bolus switch, which counts only once granted by an owner and confirmed by the grantee.
 */
export interface SharingPermissions {
  glucose_alerts: boolean;
  ai_chat_meals: boolean;
  manage_sharing: boolean;
  remote_commands: boolean;
}

export type SharingErrorCode =
  | 'NOT_AN_OWNER'
  | 'NOT_A_MEMBER'
  | 'ALREADY_A_MEMBER'
  | 'PEOPLE_LIMIT_REACHED'
  | 'INVITATION_NOT_FOUND'
  | 'INVITATION_EXPIRED'
  | 'INVITATION_CLOSED'
  | 'INVITATION_EMAIL_MISMATCH'
  | 'REMOTE_BOLUS_NOT_GRANTED'
  | 'LAST_OWNER'
  | 'INVALID_EMAIL'
  | 'INVALID_PERMISSIONS';

export class SharingError extends Error {
  constructor(public readonly code: SharingErrorCode) {
    super(code);
  }
}

/** Trimmed, lower case and NFC: the form stored in sharing_invitations and beta_allowlist. */
export function normalizeEmail(raw: string): string {
  const email = raw.normalize('NFC').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 320) throw new SharingError('INVALID_EMAIL');
  return email;
}

/** Only a literal true turns a permission on; a missing key is off. */
export function parsePermissions(raw: unknown): SharingPermissions {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    glucose_alerts: value.glucose_alerts === true,
    ai_chat_meals: value.ai_chat_meals === true,
    manage_sharing: value.manage_sharing === true,
    remote_commands: value.remote_commands === true,
  };
}

/**
 * The closed beta: with the allowlist on, an e-mail gets in when it is allowlisted, invited (an open or accepted
 * invitation) or already linked to a patient. Off: everyone gets in.
 */
export function isBetaAccessAllowed(allowlistEnabled: boolean, known: { allowlisted: boolean; invited: boolean; member: boolean }): boolean {
  return !allowlistEnabled || known.allowlisted || known.invited || known.member;
}
