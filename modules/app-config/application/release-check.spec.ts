import { describe, expect, it, vi } from 'vitest';
import { PushNotificationProviderError } from '@modules/notifications/infrastructure/push-notification-provider.error';
import { buildAppConfig } from './app-config';
import {
  ReleaseCheckService,
  SAFETY_RELEASE_MARKER,
  isNewerVersion,
  isReleaseCheckEnabled,
  latestReleaseInfo,
  parseReleases,
  releaseRepo,
  safetyPushDue,
  type ReleaseCheckFinding,
  type StoredReleaseCheck,
} from './release-check';

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  html_url: `https://github.com/mheblewski/Mellis/releases/tag/${tag}`,
  body: 'Zmiany',
  ...extra,
});

const stored = (extra: Partial<StoredReleaseCheck> = {}): StoredReleaseCheck => ({
  latest_version: '1.0.31',
  notes_url: 'https://github.com/mheblewski/Mellis/releases/tag/v1.0.31',
  safety_version: null,
  safety_notified_version: null,
  checked_at: '2026-11-04T08:00:00.000Z',
  ...extra,
});

function service(state: StoredReleaseCheck | null, answer: unknown = [release('v1.0.31')], serverVersion: string | null = '1.0.30') {
  let row = state;
  const store = {
    get: vi.fn(async () => row),
    save: vi.fn(async (finding: ReleaseCheckFinding, checkedAt: Date) => {
      row = { safety_notified_version: row?.safety_notified_version ?? null, ...finding, checked_at: checkedAt.toISOString() };
    }),
    claimSafetyPush: vi.fn(async (version: string) => {
      if (!row || row.safety_notified_version === version) return false;
      row = { ...row, safety_notified_version: version };
      return true;
    }),
    listOwnerDevices: vi.fn(async () => [{ patient_id: 'p1', push_token: 'token-1' }, { patient_id: 'p2', push_token: 'token-2' }]),
    deactivatePushToken: vi.fn(async () => undefined),
  };
  const push = { sendAppUpdateAlert: vi.fn(async () => undefined) };
  const fetchReleases = vi.fn(async () => answer);
  const log = vi.fn();
  return { store, push, fetchReleases, log, check: new ReleaseCheckService({ store, push, fetchReleases, serverVersion, log }) };
}

const NOW = new Date('2026-11-04T12:00:00.000Z');
const DAY_LATER = new Date('2026-11-05T08:00:00.000Z');

describe('release check: what counts as newer', () => {
  it('compares release numbers part by part, not as text', () => {
    expect(isNewerVersion('1.0.31', '1.0.30')).toBe(true);
    expect(isNewerVersion('1.0.100', '1.0.99')).toBe(true);
    expect(isNewerVersion('1.1.0', '1.0.99')).toBe(true);
    expect(isNewerVersion('1.0.30', '1.0.30')).toBe(false);
    expect(isNewerVersion('1.0.29', '1.0.30')).toBe(false);
  });

  it('says no when either side is not a release number', () => {
    expect(isNewerVersion('1.0.31-beta', '1.0.30')).toBe(false);
    expect(isNewerVersion('1.0.31', null)).toBe(false);
    expect(isNewerVersion(null, '1.0.30')).toBe(false);
  });
});

describe('release check: reading GitHub', () => {
  it('takes the highest published release, whatever the order', () => {
    expect(parseReleases([release('v1.0.29'), release('v1.0.31'), release('v1.0.30')])?.latest_version).toBe('1.0.31');
  });

  it('skips drafts, prereleases and tags that are not release numbers', () => {
    const finding = parseReleases([release('v1.0.40', { draft: true }), release('v1.0.39', { prerelease: true }), release('nightly'), release('v1.0.30')]);
    expect(finding?.latest_version).toBe('1.0.30');
  });

  it('keeps the newest safety fix even when a later release has no marker', () => {
    const finding = parseReleases([release('v1.0.32'), release('v1.0.31', { body: `Poprawka\n${SAFETY_RELEASE_MARKER}` }), release('v1.0.30', { body: SAFETY_RELEASE_MARKER })]);
    expect(finding).toMatchObject({ latest_version: '1.0.32', safety_version: '1.0.31' });
  });

  it('passes only a github.com link on', () => {
    expect(parseReleases([release('v1.0.31', { html_url: 'https://example.com/x' })])?.notes_url).toBeNull();
  });

  it('finds nothing in an answer that is not a list of releases', () => {
    expect(parseReleases({ message: 'API rate limit exceeded' })).toBeNull();
    expect(parseReleases([null, 7, {}])).toBeNull();
    expect(parseReleases([])).toBeNull();
  });
});

describe('release check: settings', () => {
  it('is on unless switched off', () => {
    expect(isReleaseCheckEnabled({})).toBe(true);
    expect(isReleaseCheckEnabled({ RELEASE_CHECK_ENABLED: 'false' })).toBe(false);
    expect(isReleaseCheckEnabled({ RELEASE_CHECK_ENABLED: '0' })).toBe(false);
  });

  it('reads the project repository unless a fork names a valid one', () => {
    expect(releaseRepo({})).toBe('mheblewski/Mellis');
    expect(releaseRepo({ MELLIS_REPO: 'someone/Mellis-fork' })).toBe('someone/Mellis-fork');
    expect(releaseRepo({ MELLIS_REPO: '../../evil?x=' })).toBe('mheblewski/Mellis');
  });
});

describe('release check: GET /v1/app-config', () => {
  const env = { MELLIS_VERSION: '1.0.30' };

  it('tells the app the newest release and whether this server is behind a safety fix', () => {
    expect(buildAppConfig(env, { voice_transcription: false, release_check: stored({ safety_version: '1.0.31' }) }, () => null).latest_release).toEqual({
      version: '1.0.31',
      notes_url: 'https://github.com/mheblewski/Mellis/releases/tag/v1.0.31',
      safety: true,
    });
  });

  it('does not repeat a safety fix the server already has', () => {
    expect(latestReleaseInfo(stored({ latest_version: '1.0.32', safety_version: '1.0.31' }), '1.0.31')?.safety).toBe(false);
  });

  it('says nothing when switched off, unchecked or on a server without a release number', () => {
    const release_check = stored();
    expect(buildAppConfig({ ...env, RELEASE_CHECK_ENABLED: 'false' }, { voice_transcription: false, release_check }, () => null).latest_release).toBeNull();
    expect(buildAppConfig(env, { voice_transcription: false, release_check: null }, () => null).latest_release).toBeNull();
    expect(buildAppConfig({}, { voice_transcription: false, release_check }, () => null).latest_release).toBeNull();
  });
});

describe('release check: the safety push', () => {
  it('is due once per release, and only while the server is behind it', () => {
    expect(safetyPushDue(stored(), '1.0.30')).toBeNull();
    expect(safetyPushDue(stored({ safety_version: '1.0.31' }), '1.0.30')).toBe('1.0.31');
    expect(safetyPushDue(stored({ safety_version: '1.0.31' }), '1.0.31')).toBeNull();
    expect(safetyPushDue(stored({ safety_version: '1.0.31', safety_notified_version: '1.0.31' }), '1.0.30')).toBeNull();
    expect(safetyPushDue(stored({ safety_version: '1.0.32', safety_notified_version: '1.0.31' }), '1.0.30')).toBe('1.0.32');
  });

  it('goes to every owner phone once, even across two runs', async () => {
    const { check, push, store } = service(null, [release('v1.0.31', { body: SAFETY_RELEASE_MARKER })]);
    await check.run(NOW);
    await check.run(new Date(NOW.getTime() + 3_600_000));
    expect(store.listOwnerDevices).toHaveBeenCalledTimes(1);
    expect(push.sendAppUpdateAlert).toHaveBeenCalledTimes(2);
    expect(push.sendAppUpdateAlert).toHaveBeenCalledWith(expect.objectContaining({ pushToken: 'token-1', patientId: 'p1', version: '1.0.31', title: 'Ważna aktualizacja: Mellis 1.0.31', body: 'Ta wersja zawiera poprawkę bezpieczeństwa. Zaktualizuj serwer i aplikację jak najszybciej.' }));
  });

  it('sends nothing for an ordinary release', async () => {
    const { check, push, store } = service(null);
    await check.run(NOW);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(push.sendAppUpdateAlert).not.toHaveBeenCalled();
  });

  it('forgets a dead phone and still reaches the next one', async () => {
    const { check, push, store } = service(null, [release('v1.0.31', { body: SAFETY_RELEASE_MARKER })]);
    push.sendAppUpdateAlert.mockRejectedValueOnce(new PushNotificationProviderError('DEVICE_TOKEN_UNREGISTERED', 'gone', false));
    await check.run(NOW);
    expect(store.deactivatePushToken).toHaveBeenCalledWith('token-1');
    expect(push.sendAppUpdateAlert).toHaveBeenCalledTimes(2);
  });
});

describe('release check: when GitHub is asked', () => {
  it('asks once a day', async () => {
    const { check, fetchReleases } = service(stored());
    await check.run(NOW);
    expect(fetchReleases).not.toHaveBeenCalled();
    await check.run(DAY_LATER);
    expect(fetchReleases).toHaveBeenCalledTimes(1);
  });

  it('never asks on a server without a release number', async () => {
    const { check, fetchReleases, store } = service(null, [], null);
    await check.run(NOW);
    expect(fetchReleases).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
  });

  it('keeps the last finding and does not throw when GitHub fails, then tries again', async () => {
    const { check, fetchReleases, store, log } = service(stored());
    fetchReleases.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'GITHUB_403' }));
    await expect(check.run(DAY_LATER)).resolves.toBeUndefined();
    expect(store.save).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith({ event: 'release_check_failed', error_code: 'GITHUB_403' });
    await check.run(new Date(DAY_LATER.getTime() + 3_600_000));
    expect(fetchReleases).toHaveBeenCalledTimes(2);
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite the finding with an empty answer', async () => {
    const { check, store } = service(stored(), { message: 'rate limit' });
    await check.run(DAY_LATER);
    expect(store.save).not.toHaveBeenCalled();
  });
});
