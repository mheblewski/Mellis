/**
 * Where a remote command for the patient's Trio goes (remote-bolus-trio-plan.md §1). Trio uploads its APNs device
 * token, bundle id, team id and APNs environment with every Nightscout profile; the phone that sends a command reads
 * them from here. They never reach the model (the evidence tools strip raw_profile).
 */

export type TrioRemoteTargetStatus =
  /** Trio's profile with a device token: commands can be addressed. */
  | 'READY'
  /** A Trio profile without a device token (remote notifications not registered in Trio yet). */
  | 'MISSING_TOKEN'
  /** The newest profile is not Trio's (another uploader, e.g. Loop or a Nightscout editor). */
  | 'NOT_TRIO'
  /** No profile imported for the patient. */
  | 'NO_PROFILE';

export interface TrioRemoteTarget {
  status: TrioRemoteTargetStatus;
  device_token: string | null;
  bundle_id: string | null;
  team_id: string | null;
  /** APNs environment of the Trio build: production for TestFlight/browser builds, sandbox for Xcode builds. */
  apns_environment: 'production' | 'sandbox' | null;
  /** When Trio uploaded the profile (a stale one may carry an old token after a rebuild or a phone change). */
  profile_uploaded_at: string | null;
  /** Command types the Trio build accepts; null for builds that do not say (Trio 1.0.x). */
  remote_commands: string[] | null;
  /** When the Trio build expires (TestFlight/developer profile), if Trio says. */
  build_expires_at: string | null;
}

const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/i;
const TEAM_ID = /^[A-Z0-9]{10}$/;

export function readTrioRemoteTarget(rawProfile: unknown, storedAt: string | null): TrioRemoteTarget {
  const empty: TrioRemoteTarget = {
    status: 'NO_PROFILE',
    device_token: null,
    bundle_id: null,
    team_id: null,
    apns_environment: null,
    profile_uploaded_at: null,
    remote_commands: null,
    build_expires_at: null,
  };
  if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) return empty;
  const profile = rawProfile as Record<string, unknown>;

  const bundleId = text(profile.bundleIdentifier);
  const teamId = text(profile.teamID);
  const token = text(profile.deviceToken);
  const uploadedAt = date(profile.startDate) ?? date(profile.mills) ?? date(storedAt);
  const remoteCommands = Array.isArray(profile.remoteCommands)
    ? profile.remoteCommands.filter((value): value is string => typeof value === 'string')
    : null;
  const base: TrioRemoteTarget = {
    ...empty,
    bundle_id: bundleId,
    team_id: teamId && TEAM_ID.test(teamId) ? teamId : null,
    apns_environment: typeof profile.isAPNSProduction === 'boolean' ? (profile.isAPNSProduction ? 'production' : 'sandbox') : null,
    profile_uploaded_at: uploadedAt,
    remote_commands: remoteCommands,
    build_expires_at: date(profile.expirationDate),
  };

  // Trio is recognised by what only Trio uploads: its bundle id and the APNs environment flag.
  const isTrio = !!bundleId && typeof profile.isAPNSProduction === 'boolean' && 'deviceToken' in profile;
  if (!isTrio) return { ...base, status: 'NOT_TRIO' };
  if (!token || !DEVICE_TOKEN.test(token) || !base.team_id) return { ...base, status: 'MISSING_TOKEN' };
  return { ...base, status: 'READY', device_token: token.toLowerCase() };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function date(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}
