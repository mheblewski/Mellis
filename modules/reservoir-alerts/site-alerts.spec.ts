import { describe, expect, it, vi } from 'vitest';
import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import { decideSiteAlert, planSitePushes, SiteAlertService, sitePushText, type SiteAlertState, type SiteAlertStore } from './application/site-alerts';

const TZ = 'Europe/Warsaw';
const PATIENT = '11111111-1111-4111-8111-111111111111';

/** Warsaw time in November 2026 (2 November is a Monday). */
function at(day: number, clock: string): Date {
  return new Date(`2026-11-${String(day).padStart(2, '0')}T${clock}:00.000+01:00`);
}

function iso(day: number, clock: string): string {
  return at(day, clock).toISOString();
}

function saved(next: Omit<SiteAlertState, 'patient_id' | 'revision'> | null, previous: SiteAlertState | null = null): SiteAlertState {
  return { patient_id: PATIENT, revision: (previous?.revision ?? -1) + 1, ...next! };
}

describe('planSitePushes (site-alerts.v2)', () => {
  it.each([
    ['due in the day: 7:00 that day and when due', iso(2, '19:40'), iso(5, '07:00'), iso(5, '19:40')],
    ['due at 9:00: still two pushes', iso(2, '09:00'), iso(5, '07:00'), iso(5, '09:00')],
    ['due from 7:00 to 9:00: only 7:00', iso(2, '08:15'), iso(5, '07:00'), null],
    ['due at 7:00 itself: only 7:00', iso(2, '07:00'), iso(5, '07:00'), null],
    ['due before 7:00: the evening before, then 7:00', iso(2, '02:00'), iso(4, '19:00'), iso(5, '07:00')],
    ['due after 22:00: that evening, then 7:00 the next day', iso(2, '23:30'), iso(5, '19:00'), iso(6, '07:00')],
  ])('%s', (_name, changed, first, second) => {
    const plan = planSitePushes(Date.parse(changed), TZ);
    expect(new Date(plan.first).toISOString()).toBe(first);
    expect(plan.second === null ? null : new Date(plan.second).toISOString()).toBe(second);
  });

  it('keeps the local hours over a clock change', () => {
    // Clocks went back on 25 October 2026; the site is due on 26 October at 10:30 winter time.
    const changed = Date.parse('2026-10-23T11:30:00.000+02:00');
    expect(new Date(planSitePushes(changed, TZ).first).toISOString()).toBe('2026-10-26T06:00:00.000Z');
  });
});

describe('decideSiteAlert (site-alerts.v2)', () => {
  it('sends the planned two pushes, each once', () => {
    const changed = iso(2, '19:40');
    expect(decideSiteAlert(null, changed, at(5, '06:59'), TZ).push).toBeNull();
    const first = decideSiteAlert(null, changed, at(5, '07:00'), TZ);
    expect(first.push).toEqual({ hours: 59, now: false });
    const afterFirst = saved(first.next);
    expect(decideSiteAlert(afterFirst, changed, at(5, '12:00'), TZ).push).toBeNull();
    const second = decideSiteAlert(afterFirst, changed, at(5, '19:40'), TZ);
    expect(second.push).toEqual({ hours: 72, now: true });
    expect(decideSiteAlert(saved(second.next, afterFirst), changed, at(5, '20:00'), TZ).push).toBeNull();
  });

  it('sends one push when the site is due from 7:00 to 9:00', () => {
    const changed = iso(2, '08:15');
    const only = decideSiteAlert(null, changed, at(5, '07:00'), TZ);
    expect(only.push).toEqual({ hours: 70, now: false });
    expect(decideSiteAlert(saved(only.next), changed, at(5, '08:15'), TZ).push).toBeNull();
    expect(decideSiteAlert(saved(only.next), changed, at(6, '12:00'), TZ).push).toBeNull();
  });

  it('moves the second push of a site due at night to 7:00', () => {
    const changed = iso(2, '02:00');
    const first = decideSiteAlert(null, changed, at(4, '19:00'), TZ);
    expect(first.push?.now).toBe(false);
    const state = saved(first.next);
    expect(decideSiteAlert(state, changed, at(5, '02:00'), TZ).push).toBeNull();
    expect(decideSiteAlert(state, changed, at(5, '07:00'), TZ).push).toEqual({ hours: 77, now: true });
  });

  it('sends nothing at night, a late push waits for the morning', () => {
    const changed = iso(2, '12:00');
    expect(decideSiteAlert(null, changed, at(5, '23:00'), TZ).push).toBeNull();
    expect(decideSiteAlert(null, changed, at(6, '06:59'), TZ).push).toBeNull();
    expect(decideSiteAlert(null, changed, at(6, '07:00'), TZ).push?.now).toBe(true);
  });

  it('a site first seen past due gets only the second push', () => {
    const changed = iso(1, '09:15');
    const seen = decideSiteAlert(null, changed, at(5, '10:00'), TZ);
    expect(seen.push).toEqual({ hours: 96, now: true });
    expect(decideSiteAlert(saved(seen.next), changed, at(5, '20:00'), TZ).push).toBeNull();
  });

  it('a site pushed by the earlier rule (48 hours) still gets the second push', () => {
    const changed = iso(2, '12:00');
    const state = saved({ notified_site_changed_at: changed, notified_at: iso(4, '12:00') });
    expect(decideSiteAlert(state, changed, at(5, '11:00'), TZ).push).toBeNull();
    expect(decideSiteAlert(state, changed, at(5, '12:00'), TZ).push?.now).toBe(true);
  });

  it('a newer site starts the count again', () => {
    const state = saved({ notified_site_changed_at: iso(2, '12:00'), notified_at: iso(5, '12:00') });
    expect(decideSiteAlert(state, iso(5, '13:00'), at(5, '14:00'), TZ).push).toBeNull();
    expect(decideSiteAlert(state, iso(5, '13:00'), at(8, '07:00'), TZ).push?.now).toBe(false);
  });

  it('says nothing without a site change or for one older than 7 days (most likely not logged)', () => {
    expect(decideSiteAlert(null, null, at(5, '12:00'), TZ)).toEqual({ next: null, push: null });
    expect(decideSiteAlert(null, iso(1, '09:00'), at(8, '10:00'), TZ)).toEqual({ next: null, push: null });
  });
});

describe('sitePushText', () => {
  it('announces the hour before the site is due', () => {
    expect(sitePushText(iso(2, '19:40'), at(5, '07:00'), TZ)).toEqual({ title: 'Dziś wymiana wkłucia', body: 'Wkłucie skończy 3 dni o 19:40.' });
    expect(sitePushText(iso(2, '08:15'), at(5, '07:00'), TZ)).toEqual({ title: 'Dziś wymiana wkłucia', body: 'Wkłucie skończy 3 dni o 8:15.' });
    expect(sitePushText(iso(2, '23:30'), at(5, '19:00'), TZ)).toEqual({ title: 'Dziś wieczorem wymiana wkłucia', body: 'Wkłucie skończy 3 dni o 23:30. Najlepiej zmień je dziś wieczorem i sprawdź glukozę po 1–2 godz.' });
    expect(sitePushText(iso(2, '02:00'), at(4, '19:00'), TZ)).toEqual({ title: 'Dziś wieczorem wymiana wkłucia', body: 'Wkłucie skończy 3 dni o 2:00 w nocy. Najlepiej zmień je dziś wieczorem i sprawdź glukozę po 1–2 godz.' });
  });

  it('says when the site was placed once it is due', () => {
    expect(sitePushText(iso(2, '19:40'), at(5, '19:40'), TZ)).toEqual({ title: 'Wkłucie ma już 3 dni', body: 'Założone w poniedziałek o 19:40. Zmień je teraz.' });
    expect(sitePushText(iso(2, '23:30'), at(6, '07:00'), TZ)).toEqual({ title: 'Wkłucie ma już 3 dni', body: 'Założone w poniedziałek o 23:30. Zmień je dziś rano.' });
    expect(sitePushText(iso(1, '09:15'), at(5, '12:00'), TZ)).toEqual({ title: 'Wkłucie ma już 4 dni', body: 'Założone w niedzielę o 9:15. Zmień je dziś.' });
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
    const dashboard = { site_changed_at: iso(2, '19:40') } as unknown as DashboardResponse;
    const service = new SiteAlertService({ store, push, dashboard: async () => dashboard, timeZone: async () => TZ, log: vi.fn() });
    await service.run(at(5, '07:00'));
    await service.run(at(5, '07:01'));
    expect(push.sendSiteAlert).toHaveBeenCalledTimes(2);
    expect(push.sendSiteAlert).toHaveBeenCalledWith(expect.objectContaining({ pushToken: 'ta', now: false, title: 'Dziś wymiana wkłucia', body: 'Wkłucie skończy 3 dni o 19:40.' }));
  });
});
