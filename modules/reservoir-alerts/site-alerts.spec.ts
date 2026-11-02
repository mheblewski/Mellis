import { describe, expect, it, vi } from 'vitest';
import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import { decideSiteAlert, SiteAlertService, sitePushText, type SiteAlertState, type SiteAlertStore } from './application/site-alerts';

const NOW = new Date('2026-11-02T18:00:00.000Z');
const PATIENT = '11111111-1111-4111-8111-111111111111';

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

function saved(next: Omit<SiteAlertState, 'patient_id' | 'revision'> | null, previous: SiteAlertState | null = null): SiteAlertState {
  return { patient_id: PATIENT, revision: (previous?.revision ?? -1) + 1, ...next! };
}

describe('decideSiteAlert (site-alerts.v1)', () => {
  it('pushes again once after 72 hours: "Wymień wkłucie teraz" (owner 2026-11-02)', () => {
    const changed = hoursAgo(49);
    const first = decideSiteAlert(null, changed, NOW);
    expect(first.push).toEqual({ hours: 49, now: false });
    const afterFirst: SiteAlertState = { patient_id: 'p', revision: 0, ...first.next! };
    const later = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
    expect(decideSiteAlert(afterFirst, changed, later(22)).push).toBeNull();
    const second = decideSiteAlert(afterFirst, changed, later(23));
    expect(second.push).toEqual({ hours: 72, now: true });
    const afterSecond: SiteAlertState = { patient_id: 'p', revision: 1, ...second.next! };
    expect(decideSiteAlert(afterSecond, changed, later(30)).push).toBeNull();
    // First seen past 72 hours: only the second push.
    expect(decideSiteAlert(null, hoursAgo(80), NOW).push).toEqual({ hours: 80, now: true });
  });

  it('pushes once a site is older than 48 hours, once per site', () => {
    expect(decideSiteAlert(null, hoursAgo(47.9), NOW).push).toBeNull();
    const first = decideSiteAlert(null, hoursAgo(49), NOW);
    expect(first).toMatchObject({ push: { hours: 49 }, next: { notified_site_changed_at: hoursAgo(49) } });
    const state = saved(first.next);
    expect(decideSiteAlert(state, hoursAgo(49), new Date(NOW.getTime() + 22 * 3_600_000))).toEqual({ next: null, push: null });
    // A new site: quiet until it is 48 hours old too.
    expect(decideSiteAlert(state, hoursAgo(2), NOW).push).toBeNull();
    expect(decideSiteAlert(state, hoursAgo(50), new Date(NOW.getTime())).push).toEqual({ hours: 50, now: false });
  });

  it('says nothing without a site change or for one older than 7 days (most likely not logged)', () => {
    expect(decideSiteAlert(null, null, NOW)).toEqual({ next: null, push: null });
    expect(decideSiteAlert(null, hoursAgo(7 * 24 + 1), NOW)).toEqual({ next: null, push: null });
  });

  it('says how old the site is', () => {
    expect(sitePushText(48)).toEqual({ title: 'Czas zmienić wkłucie', body: 'Wkłucie ma już 2 dni. Zmień je dziś.' });
    expect(sitePushText(74, true)).toEqual({ title: 'Wymień wkłucie teraz', body: 'Wkłucie ma już 3 dni i 2 godz. Wymień je teraz.' });
    expect(sitePushText(51)).toEqual({ title: 'Czas zmienić wkłucie', body: 'Wkłucie ma już 2 dni i 3 godz. Zmień je dziś.' });
    expect(sitePushText(73).body).toBe('Wkłucie ma już 3 dni i 1 godz. Zmień je dziś.');
  });
});

describe('SiteAlertService', () => {
  it('pushes each phone once and not again on the next tick', async () => {
    let state: SiteAlertState | null = null;
    const store: SiteAlertStore = {
      listPatientsWithSiteDevices: vi.fn(async () => [PATIENT]),
      listSiteDevices: vi.fn(async () => [{ device_id: 'a', push_token: 'ta' }, { device_id: 'b', push_token: 'tb' }]),
      getSiteState: vi.fn(async () => state),
      saveSiteState: vi.fn(async (_patientId, _revision, next) => {
        state = saved(next, state);
        return true;
      }),
      deactivatePushToken: vi.fn(async () => undefined),
    };
    const push = { sendSiteAlert: vi.fn(async () => undefined) };
    const dashboard = { site_changed_at: hoursAgo(50) } as unknown as DashboardResponse;
    const service = new SiteAlertService({ store, push, dashboard: async () => dashboard, log: vi.fn() });
    await service.run(NOW);
    await service.run(NOW);
    expect(push.sendSiteAlert).toHaveBeenCalledTimes(2);
    expect(push.sendSiteAlert).toHaveBeenCalledWith(expect.objectContaining({ pushToken: 'ta', title: 'Czas zmienić wkłucie', body: 'Wkłucie ma już 2 dni i 2 godz. Zmień je dziś.' }));
  });
});
