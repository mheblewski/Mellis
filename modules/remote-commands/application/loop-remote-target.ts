/**
 * Where a remote command for the patient's Loop goes (loop-support-plan.md, stage 3). Loop uploads its APNs device
 * token and bundle id in the Nightscout profile's `loopSettings`, and the APNs environment as `isAPNSProduction`
 * (NightscoutKit ProfileSet / LoopSettings; LoopFollow reads the same fields). Loop does not upload its Apple team: a
 * LoopWorkspace build names it in the bundle id (`com.<TEAM>.loopkit.Loop`), otherwise the caregiver types it on the
 * phone. Like Trio's target, it never reaches the model.
 */

export type LoopRemoteTargetStatus =
  /** Loop's profile with a device token: commands can be addressed. */
  | 'READY'
  /** A Loop profile without a device token (remote notifications not on in Loop's Nightscout service yet). */
  | 'MISSING_TOKEN'
  /** The newest profile is not Loop's. */
  | 'NOT_LOOP'
  /** No profile imported for the patient. */
  | 'NO_PROFILE';

export interface LoopRemoteTarget {
  status: LoopRemoteTargetStatus;
  device_token: string | null;
  bundle_id: string | null;
  /** From a LoopWorkspace bundle id; null when it cannot be read from it. */
  team_id: string | null;
  apns_environment: 'production' | 'sandbox' | null;
  profile_uploaded_at: string | null;
  /** Loop's own bolus limit (loopSettings.maximumBolus), U; the phone keeps its limit at or below it. */
  max_bolus_u: number | null;
}

const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/i;
const WORKSPACE_BUNDLE = /^com\.([A-Z0-9]{10})\.loopkit\.Loop$/;

export function readLoopRemoteTarget(rawProfile: unknown, storedAt: string | null): LoopRemoteTarget {
  const empty: LoopRemoteTarget = {
    status: 'NO_PROFILE',
    device_token: null,
    bundle_id: null,
    team_id: null,
    apns_environment: null,
    profile_uploaded_at: null,
    max_bolus_u: null,
  };
  const profile = record(rawProfile);
  if (!profile) return empty;
  const settings = record(profile.loopSettings);
  if (!settings) return { ...empty, status: 'NOT_LOOP' };

  const bundleId = text(settings.bundleIdentifier);
  const token = text(settings.deviceToken);
  const maxBolus = typeof settings.maximumBolus === 'number' && Number.isFinite(settings.maximumBolus) && settings.maximumBolus > 0 ? settings.maximumBolus : null;
  const base: LoopRemoteTarget = {
    ...empty,
    bundle_id: bundleId,
    team_id: bundleId ? WORKSPACE_BUNDLE.exec(bundleId)?.[1] ?? null : null,
    apns_environment: typeof profile.isAPNSProduction === 'boolean' ? (profile.isAPNSProduction ? 'production' : 'sandbox') : null,
    profile_uploaded_at: date(profile.startDate) ?? date(profile.mills) ?? date(storedAt),
    max_bolus_u: maxBolus,
  };
  if (!bundleId || !token || !DEVICE_TOKEN.test(token)) return { ...base, status: 'MISSING_TOKEN' };
  return { ...base, status: 'READY', device_token: token.toLowerCase() };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
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
