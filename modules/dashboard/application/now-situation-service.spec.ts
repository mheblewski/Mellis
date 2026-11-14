import { describe, expect, it, vi } from 'vitest';
import type { DashboardResponse } from './dashboard-snapshot';
import { fallbackNowSituation, isNowSituationEnabled } from './now-situation';
import { carbEntryFromRow, NowSituationService, snapshotFromStatus, type NowSituationDeps } from './now-situation-service';

const NOW = new Date('2026-11-07T11:40:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const flat = (value: number, tail: number[] = [], newestAgo = 1) => [...Array(48).fill(value), ...tail].map((reading, index, all) => ({ at: ago(newestAgo + (all.length - 1 - index) * 5), value: reading }));

const loopStatus = (minutes = 2, overrides: Record<string, unknown> = {}) => ({
  observed_at: ago(minutes),
  raw_payload: { device: 'Trio', openaps: { iob: { iob: 0 }, suggested: { COB: 0, IOB: 0, ISF: 100, CR: 10, deliverAt: ago(minutes), timestamp: ago(minutes), bg: 100, predBGs: { IOB: [100, 100, 100, 100, 100, 100, 100] }, ...overrides }, enacted: { rate: 1, duration: 30, timestamp: ago(minutes) } } },
});

const dashboard = { insulin: { boluses: [], smbs: [], carbs: [], basal: [], basal_now: { plan_rate: 1 } }, sensor_started_at: null } as unknown as DashboardResponse;

function deps(overrides: Partial<{ carbs: unknown[]; alert: unknown; therapy: unknown; alertsFail: boolean }> = {}): NowSituationDeps {
  return {
    dashboards: {
      listLoopSnapshotsBetween: vi.fn(async () => [loopStatus(32), loopStatus(22), loopStatus(12), loopStatus(2)]),
      listSituationCarbEntries: vi.fn(async () => (overrides.carbs ?? []) as never),
      getPatientLabel: vi.fn(async () => 'Ewa'),
    },
    alerts: {
      getActiveAlert: vi.fn(async () => {
        if (overrides.alertsFail) throw new Error('connection lost');
        return (overrides.alert ?? null) as never;
      }),
      listAlertsNotifiedSince: vi.fn(async () => []),
      getRecentEatenCarbs: vi.fn(async () => ({ last_carbs_at: null, last_hypo_treatment_at: null })),
    },
    therapy: { getTherapyProfileAt: vi.fn(async () => overrides.therapy ?? { units: 'mg/dl', timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', 10]], sensitivity_per_u: [['00:00', 100]] }) },
    log: vi.fn(),
  };
}

const run = (service: NowSituationService, readings: Array<{ at: string; value: number }>, status: ReturnType<typeof loopStatus> | null = loopStatus()) =>
  service.situation({ patientId: 'p', viewerUserId: 'me', now: NOW, dashboard, sources: { readings, loopStatus: status } });

describe('NowSituationService', () => {
  it('computes a dose on demand for a low with no alert at all', async () => {
    const result = await run(new NowSituationService(deps()), flat(90, [78, 72, 66]));
    expect(result?.state).toMatch(/^6/);
    expect(result?.second).toMatchObject({ kind: 'DOSE', label: 'Podaj' });
    expect(result?.action).toMatchObject({ kind: 'GIVEN', style: 'FILLED' });
    expect(result?.dose_policy_version).toBe('rescue-dose.v4');
  });

  it('sends nothing to say as one space, which older builds take as an answer', async () => {
    const result = await run(new NowSituationService(deps()), flat(150, [150, 150, 150]).slice(-6));
    expect(result.sentence.trim()).toBe('');
    expect(result.sentence).not.toBe('');
  });

  it('with no ISF or ICR proposes no amount', async () => {
    const service = new NowSituationService(deps({ therapy: { units: 'mg/dl', timezone: 'Europe/Warsaw', carb_ratio_g_per_u: null, sensitivity_per_u: null } }));
    const result = await run(service, flat(90, [78, 72, 66]), null);
    expect(result?.state).toBe('6g');
    expect(result?.second).toBeNull();
  });

  it('keeps the ISPAD dose below 54 even when there are too few readings for an evaluation', async () => {
    const result = await run(new NowSituationService(deps()), [{ at: ago(1), value: 50 }], null);
    expect(result?.state).toBe('7');
    // 70 mg/dL at CSF 10 g.
    expect(result?.second).toMatchObject({ value: '8 g', label: 'Podaj od razu' });
  });

  it('shows no dose from a stale reading', async () => {
    const result = await run(new NowSituationService(deps()), flat(90, [66], 16));
    expect(result?.state).toBe('9b');
    expect(result?.second).toMatchObject({ kind: 'NO_READING' });
    expect(result?.action).toBeNull();
  });

  it('reads an open alert only once it was pushed', async () => {
    const pending = { status: 'PENDING', notified_at: null };
    const pushed = { status: 'NOTIFIED', notified_at: ago(5), situation_last_triggered_at: ago(3), situation_grams_since: ago(5) };
    expect((await run(new NowSituationService(deps({ alert: pending })), flat(105, [105, 105, 105])))?.state).not.toMatch(/^5/);
    expect((await run(new NowSituationService(deps({ alert: pushed })), flat(105, [105, 105, 105])))?.state).toBe('5');
  });

  it('promises a push only while the worker that keeps it runs', async () => {
    const carbs = [{ occurred_at: ago(4), carbs: '5', kind: 'HYPO_TREATMENT', entry_source: 'GLUCOMIND', in_loop: 'false', by_user_id: 'me', by_name: null }];
    process.env.NOW_SITUATION_ENABLED = 'true';
    process.env.RESCUE_CARB_ALERTS_ENABLED = 'true';
    try {
      // From 70 up: below 70 the countdown alone says it (texts review, 2026-11-09).
      const result = await run(new NowSituationService(deps({ carbs })), flat(90, [76, 74, 72]));
      expect(result?.sentence).toContain('Mellis da znać');
    } finally {
      delete process.env.NOW_SITUATION_ENABLED;
      delete process.env.RESCUE_CARB_ALERTS_ENABLED;
    }
  });

  it('does not promise a push before the push exists', async () => {
    const result = await run(new NowSituationService(deps({ carbs: [{ occurred_at: ago(4), carbs: '5', kind: 'HYPO_TREATMENT', entry_source: 'GLUCOMIND', in_loop: 'false', by_user_id: 'me', by_name: null }] })), flat(90, [76, 74, 72]));
    expect(result?.state).toBe('8');
    expect(result?.sentence).not.toContain('Mellis da znać');
  });

  it('tells another caregiver from this one', async () => {
    const result = await run(new NowSituationService(deps({ carbs: [{ occurred_at: ago(4), carbs: '5', kind: 'HYPO_TREATMENT', entry_source: 'GLUCOMIND', in_loop: 'false', by_user_id: 'ewa', by_name: 'Ewa' }] })), flat(90, [72, 68, 66]));
    expect(result?.state).toBe('8b');
    expect(result?.sentence).toContain('Opiekun Ewa podał 5 g węgli');
  });

  it('fails open: only what the dashboard knows, no dose or button, and the failure is logged', async () => {
    const injected = deps({ alertsFail: true });
    const service = new NowSituationService(injected);
    const glucose = { value: 66, observed_at: ago(2) };
    const result = await service.situation({ patientId: 'p', viewerUserId: 'me', now: NOW, dashboard: { ...dashboard, glucose } as DashboardResponse, sources: { readings: [], loopStatus: null } });
    expect(result).toMatchObject({ state: '1d', sentence: ' ', glucose: { value: 66, tone: 'RED' }, second: null, action: null });
    expect(injected.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'now_situation_failed' }));
  });

  it('falls back to the stale wording for an old reading or none', () => {
    expect(fallbackNowSituation({ value: 120, observed_at: ago(40) }, NOW)).toMatchObject({ state: '9', glucose: { tone: 'STALE' }, second: { kind: 'NO_READING', unit: 'bez odczytu' }, sentence: 'Warto sprawdzić sensor i telefon z pętlą.', detail: null });
    expect(fallbackNowSituation({ value: 120, observed_at: ago(40) }, NOW, 'TRIO').sentence).toBe('Warto sprawdzić sensor i telefon z Trio.');
    expect(fallbackNowSituation({ value: 120, observed_at: ago(2) }, NOW)).toMatchObject({ state: '1d', sentence: '' });
    expect(fallbackNowSituation(null, NOW)).toMatchObject({ state: '9', glucose: null, second: null });
  });
});

describe('now-situation reads', () => {
  it('reads the flag', () => {
    expect(isNowSituationEnabled({})).toBe(true);
    expect(isNowSituationEnabled({ NOW_SITUATION_ENABLED: '' })).toBe(true);
    expect(isNowSituationEnabled({ NOW_SITUATION_ENABLED: 'true' })).toBe(true);
    expect(isNowSituationEnabled({ NOW_SITUATION_ENABLED: '0' })).toBe(false);
    expect(isNowSituationEnabled({ NOW_SITUATION_ENABLED: 'false' })).toBe(false);
    expect(isNowSituationEnabled({ NOW_SITUATION_ENABLED: ' Off ' })).toBe(false);
  });

  it('maps a snapshot from Trio and from Loop', () => {
    expect(snapshotFromStatus({ observed_at: ago(1), raw_payload: { openaps: { iob: { iob: 1.5 }, suggested: { COB: 7 }, enacted: { rate: 0.4 } } } })).toEqual({ at: ago(1), iob_u: 1.5, cob_g: 7, rate_u_per_h: 0.4 });
    expect(snapshotFromStatus({ observed_at: ago(1), raw_payload: { loop: { iob: { iob: 0.5 }, cob: { cob: 2 }, enacted: { rate: 1.1 } } } })).toEqual({ at: ago(1), iob_u: 0.5, cob_g: 2, rate_u_per_h: 1.1 });
  });

  it('maps carb entries: the source and a kind without a default', () => {
    const row = { occurred_at: ago(4), carbs: '12', kind: null, entry_source: null, in_loop: null, by_user_id: null, by_name: null };
    expect(carbEntryFromRow(row)).toMatchObject({ grams: 12, kind: null, source: 'LOOP' });
    expect(carbEntryFromRow({ ...row, kind: 'HYPO_TREATMENT', entry_source: 'GLUCOMIND' })).toMatchObject({ kind: 'HYPO_TREATMENT', source: 'MELLIS' });
    expect(carbEntryFromRow({ ...row, carbs: '0' })).toBeNull();
    expect(carbEntryFromRow({ ...row, carbs: 'x' })).toBeNull();
  });
});
