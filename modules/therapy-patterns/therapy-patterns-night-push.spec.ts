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
