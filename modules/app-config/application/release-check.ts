import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';

/**
 * "Jest nowa wersja" (release-check.v1): once a day the worker reads the project's public GitHub Releases, the same list
 * `mellis update` offers, and the app shows the owners what is new. A release whose notes hold SAFETY_RELEASE_MARKER
 * (an HTML comment, invisible on GitHub) is a safety fix: its owners also get one push. Only the server's IP address
 * reaches GitHub. Off with RELEASE_CHECK_ENABLED=false (or 0); a server without a release number (built by hand) never
 * checks, it has nothing to compare.
 */
export const RELEASE_CHECK_POLICY = {
  version: 'release-check.v1',
  tick_ms: 60 * 60_000,
  check_every_ms: 24 * 60 * 60_000,
  fetch_timeout_ms: 10_000,
  default_repo: 'mheblewski/Mellis',
} as const;

export const SAFETY_RELEASE_MARKER = '<!-- mellis:safety -->';

const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

export function isReleaseCheckEnabled(env: NodeJS.ProcessEnv): boolean {
  return !/^(false|0)$/i.test(String(env.RELEASE_CHECK_ENABLED ?? 'true').trim());
}

/** The installer's MELLIS_REPO when a fork sets it, else the project's own. */
export function releaseRepo(env: NodeJS.ProcessEnv): string {
  const repo = String(env.MELLIS_REPO ?? '').trim();
  return REPO_NAME.test(repo) ? repo : RELEASE_CHECK_POLICY.default_repo;
}

/** True when both are release numbers (X.Y.Z) and `candidate` is the later one. */
export function isNewerVersion(candidate: string | null | undefined, current: string | null | undefined): boolean {
  const a = RELEASE_VERSION.exec(candidate ?? '');
  const b = RELEASE_VERSION.exec(current ?? '');
  if (!a || !b) return false;
  for (const part of [1, 2, 3]) {
    const difference = Number(a[part]) - Number(b[part]);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

export interface ReleaseCheckFinding {
  latest_version: string;
  notes_url: string | null;
  /** The newest release marked as a safety fix: a later unmarked release must not hide it from a server behind both. */
  safety_version: string | null;
}

/**
 * The newest published release in GitHub's answer; null when the answer holds none. It is outside data, so only a
 * release number and a github.com link get through, and the notes themselves are read for the marker alone.
 */
export function parseReleases(answer: unknown): ReleaseCheckFinding | null {
  if (!Array.isArray(answer)) return null;
  let finding: ReleaseCheckFinding | null = null;
  let safety: string | null = null;
  for (const release of answer as Array<Record<string, unknown> | null>) {
    if (!release || release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string') continue;
    const version = release.tag_name.replace(/^v/, '');
    if (!RELEASE_VERSION.test(version)) continue;
    if (typeof release.body === 'string' && release.body.includes(SAFETY_RELEASE_MARKER) && (!safety || isNewerVersion(version, safety))) {
      safety = version;
    }
    if (!finding || isNewerVersion(version, finding.latest_version)) {
      const url = typeof release.html_url === 'string' && release.html_url.startsWith('https://github.com/') ? release.html_url : null;
      finding = { latest_version: version, notes_url: url, safety_version: null };
    }
  }
  return finding && { ...finding, safety_version: safety };
}

export interface StoredReleaseCheck extends ReleaseCheckFinding {
  safety_notified_version: string | null;
  checked_at: string;
}

export interface LatestReleaseInfo {
  version: string;
  notes_url: string | null;
  /** This server is behind a safety fix. */
  safety: boolean;
}

/** What GET /v1/app-config says about the newest release; the app compares it with its own version and the server's. */
export function latestReleaseInfo(stored: StoredReleaseCheck | null, serverVersion: string | null): LatestReleaseInfo | null {
  if (!stored || !serverVersion) return null;
  return {
    version: stored.latest_version,
    notes_url: stored.notes_url,
    safety: isNewerVersion(stored.safety_version, serverVersion),
  };
}

/** One push per safety release, and only while this server is behind it. */
export function safetyPushDue(stored: StoredReleaseCheck | null, serverVersion: string): string | null {
  const safety = stored?.safety_version ?? null;
  if (!safety || !isNewerVersion(safety, serverVersion)) return null;
  const notified = stored?.safety_notified_version ?? null;
  return notified && !isNewerVersion(safety, notified) ? null : safety;
}

export function safetyPushText(version: string): { title: string; body: string } {
  return {
    title: `Ważna aktualizacja: Mellis ${version}`,
    body: 'Ta wersja zawiera poprawkę bezpieczeństwa. Zaktualizuj serwer i aplikację jak najszybciej.',
  };
}

export interface ReleaseCheckStore {
  get(): Promise<StoredReleaseCheck | null>;
  save(finding: ReleaseCheckFinding, checkedAt: Date): Promise<void>;
  /** Takes the push for this release for this worker; false when it was sent already. */
  claimSafetyPush(version: string): Promise<boolean>;
  /** The phones of the patients' owners, each once: only they can update the server. */
  listOwnerDevices(): Promise<Array<{ patient_id: string; push_token: string }>>;
  deactivatePushToken(pushToken: string): Promise<void>;
}

export interface ReleaseCheckPush {
  sendAppUpdateAlert(input: { patientId: string; pushToken: string; version: string; title: string; body: string }): Promise<void>;
}

export class ReleaseCheckService {
  constructor(private readonly deps: {
    store: ReleaseCheckStore;
    push: ReleaseCheckPush;
    /** GitHub's list of releases; throws when it cannot be read. */
    fetchReleases: () => Promise<unknown>;
    serverVersion: string | null;
    log: (event: Record<string, unknown>) => void;
  }) {}

  /** Never throws: without GitHub or the table the app just shows nothing new, and the next hour tries again. */
  async run(now: Date): Promise<void> {
    const serverVersion = this.deps.serverVersion;
    if (!serverVersion) return;
    try {
      let stored = await this.deps.store.get();
      if (!stored || now.getTime() - Date.parse(stored.checked_at) >= RELEASE_CHECK_POLICY.check_every_ms) {
        const finding = parseReleases(await this.deps.fetchReleases());
        if (finding) {
          await this.deps.store.save(finding, now);
          stored = await this.deps.store.get();
          this.deps.log({ event: 'release_check_done', latest_version: finding.latest_version, server_version: serverVersion });
        }
      }
      const version = safetyPushDue(stored, serverVersion);
      if (version && (await this.deps.store.claimSafetyPush(version))) await this.pushSafetyRelease(version);
    } catch (error) {
      this.deps.log({ event: 'release_check_failed', error_code: errorCode(error) });
    }
  }

  private async pushSafetyRelease(version: string): Promise<void> {
    const devices = await this.deps.store.listOwnerDevices();
    let delivered = 0;
    for (const device of devices) {
      try {
        await this.deps.push.sendAppUpdateAlert({ patientId: device.patient_id, pushToken: device.push_token, version, ...safetyPushText(version) });
        delivered += 1;
      } catch (error) {
        if (error instanceof PushNotificationProviderError && (error.code === 'DEVICE_TOKEN_INVALID' || error.code === 'DEVICE_TOKEN_UNREGISTERED')) {
          await this.deps.store.deactivatePushToken(device.push_token).catch(() => undefined);
        }
        this.deps.log({ event: 'release_safety_push_failed', error_code: errorCode(error) });
      }
    }
    this.deps.log({ event: 'release_safety_push_sent', version, devices: devices.length, delivered });
  }
}

function errorCode(error: unknown): string {
  if (error instanceof PushNotificationProviderError) return error.code;
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return 'UNKNOWN';
}
