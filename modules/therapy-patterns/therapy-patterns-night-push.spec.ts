import { describe, expect, it } from 'vitest';
import type { WhatIfData } from '@modules/settings-whatif/application/icr-whatif';
import { TherapyPatternsService, type TherapyPatternsStore } from './application/therapy-patterns.service';
import { CAREGIVER_NIGHT_PUSH_DEVICES_SQL } from '@infra/db/postgres-therapy-patterns.repository';

const DAY = 86_400_000;
// Monday 16 Nov 2026, 7:30 in Warsaw (UTC+1); the night under 54 at 3:00–3:40 local
const NOW = new Date(Date.UTC(2026, 10, 16, 6, 30));
const LOW_FROM = Date.UTC(2026, 10, 16, 2, 0);

function data(): WhatIfData {
  const readings: Array<[number, number]> = [];
  for (let ms = NOW.getTime() - DAY; ms < NOW.getTime(); ms += 300_000) readings.push([ms, ms >= LOW_FROM && ms < LOW_FROM + 40 * 60_000 ? 48 : 120]);
  return { time_zone: 'Europe/Warsaw', readings, carbs: [], boluses: [], smbs: [], temps: [], therapies: [], dia_hours: 5, peak_minutes: 75 };
}

function store(): TherapyPatternsStore & { checks: Map<string, { checked_at: string; notified_at: string | null }> } {
  const checks = new Map<string, { checked_at: string; notified_at: string | null }>();
  return {
    checks,
    listPatientsToAnalyse: async () => ['p1'],
    getTimezone: async () => 'Europe/Warsaw',
    loadData: async () => data(),
    loadHistory: async () => data(),
    lastRunAt: async () => NOW.toISOString(),
    listStates: async () => [],
    saveRun: async () => undefined,
    claimPush: async () => true,
    latestGlucose: async () => 110,
    getNightCheck: async (_p, date) => checks.get(date) ?? null,
    saveNightCheck: async (_p, date, at) => { checks.set(date, { checked_at: at, notified_at: checks.get(date)?.notified_at ?? null }); },
    claimNightPush: async (_p, date, at) => { const c = checks.get(date)!; if (c.notified_at) return false; c.notified_at = at; return true; },
    listOwnerPushDevices: async () => [{ device_id: 'd1', push_token: 't1' }],
    listOwnerOpens: async () => [],
    listNightPushDevices: async () => [{ device_id: 'd1', push_token: 't1', is_owner: true }, { device_id: 'd2', push_token: 't2', is_owner: false }],
    deactivatePushToken: async () => undefined,
  };
}

describe('the morning push about last night under 54', () => {
  it('goes to every caregiver with full access once and opens the patient (Teraz)', async () => {
    const sent: Array<{ pushToken: string; openPatient?: boolean; title: string; body: string }> = [];
    const s = store();
    const service = new TherapyPatternsService({ store: s, push: { sendTherapyPattern: async (input) => { sent.push(input); } }, defaultTimezone: () => 'Europe/Warsaw', log: () => undefined });
    await service.sendDue(NOW);
    expect(sent.map((x) => [x.pushToken, x.openPatient])).toEqual([['t1', true], ['t2', true]]);
    expect(sent[0]).toMatchObject({ title: 'Ostatniej nocy glukoza spadła poniżej 54', body: 'Najniżej 48 o 3:00, poniżej 54 przez 40 min.' });
    await service.sendDue(new Date(NOW.getTime() + 2 * 3_600_000));
    expect(sent).toHaveLength(2);
  });
});

describe('who gets it', () => {
  it('only full access: owners, or members allowed both glucose alerts and the chat and meals', () => {
    expect(CAREGIVER_NIGHT_PUSH_DEVICES_SQL).toContain("permissions->'glucose_alerts' IS DISTINCT FROM 'false'");
    expect(CAREGIVER_NIGHT_PUSH_DEVICES_SQL).toContain("permissions->'ai_chat_meals' IS DISTINCT FROM 'false'");
  });
});

describe('the weekly pattern push', () => {
  // Sunday 15 Nov 2026, 18:00 in Warsaw; the card has been on the list since Friday 13 Nov
  const SUNDAY = new Date(Date.UTC(2026, 10, 15, 17, 0));
  const FIRST = new Date(Date.UTC(2026, 10, 13, 8, 10)).toISOString();
  const state = {
    pattern_key: 'DAY_LOWS_WITHOUT_FOOD.9', pattern_id: 'DAY_LOWS_WITHOUT_FOOD' as const, shown: true, severity: 5,
    result: { id: 'DAY_LOWS_WITHOUT_FOOD' as const, shown: true, failed: [], sentence: 'Spadki w 5 dniach. Dalej.', stats: { block: 9, days: 5 }, episodes: [] },
    first_shown_at: FIRST, last_shown_at: SUNDAY.toISOString(), computed_at: new Date(SUNDAY.getTime() - 13 * 3_600_000).toISOString(),
    notified_at: null, notified_severity: null, dismissed_until: null, revision: 2,
  };
  function weekly(opens: Array<{ user_id: string; pattern_key: string; opened_at: string }>) {
    const s = store();
    const claims: string[] = [];
    Object.assign(s, {
      listStates: async () => [state],
      lastRunAt: async () => state.computed_at,
      getNightCheck: async () => ({ checked_at: SUNDAY.toISOString(), notified_at: null }),
      claimPush: async (_p: string, key: string) => { claims.push(key); return true; },
      listOwnerPushDevices: async () => [{ device_id: 'd1', push_token: 't1', user_id: 'piotr' }, { device_id: 'd2', push_token: 't2', user_id: 'ewa' }],
      listOwnerOpens: async () => opens,
    });
    const sent: Array<{ pushToken: string; title: string }> = [];
    const service = new TherapyPatternsService({ store: s, push: { sendTherapyPattern: async (input) => { sent.push(input); } }, defaultTimezone: () => 'Europe/Warsaw', log: () => undefined });
    return { service, sent, claims };
  }
  const opened = (user: string, at = '2026-11-14T13:55:00.000Z') => ({ user_id: user, pattern_key: state.pattern_key, opened_at: at });

  it('is not sent when every owner has opened the card', async () => {
    const { service, sent, claims } = weekly([opened('piotr'), opened('ewa')]);
    await service.sendDue(SUNDAY);
    expect(sent).toEqual([]);
    expect(claims).toEqual([]);
  });

  it('goes only to the owner who has not opened it, with the day it was found', async () => {
    const { service, sent } = weekly([opened('piotr')]);
    await service.sendDue(SUNDAY);
    expect(sent.map((x) => [x.pushToken, x.title])).toEqual([['t2', 'Wzorzec od 13.11: spadki między 9 a 12 bez jedzenia']]);
  });

  it('counts an open from before the card was first shown as not seen', async () => {
    const { service, sent } = weekly([opened('piotr', '2026-11-01T10:00:00.000Z'), opened('ewa')]);
    await service.sendDue(SUNDAY);
    expect(sent.map((x) => x.pushToken)).toEqual(['t1']);
  });
});
