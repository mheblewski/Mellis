import { describe, expect, it } from 'vitest';
import type { WhatIfData } from '@modules/settings-whatif/application/icr-whatif';
import { defaultWindow, runSimulationTool, lastDays } from './application/simulation-tools';
import { ChatSimulationSession } from './application/simulation-session';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 11, 12);
function data(): WhatIfData {
  const readings: Array<[number, number]> = [];
  for (let ms = NOW - 40 * DAY; ms < NOW; ms += 300_000) readings.push([ms, ms < NOW - 10 * DAY ? 160 : 130]);
  const carbs: WhatIfData['carbs'] = []; const boluses: Array<[number, number]> = [];
  for (let d = 40; d >= 1; d -= 1) {
    const meal = NOW - d * DAY + 7 * 3_600_000;
    carbs.push({ ms: meal, g: 20, kind: null });
    boluses.push([meal, 2], [meal + 20 * 60_000, 1]); // a follow-up 20 min later
  }
  return {
    time_zone: 'UTC', readings, carbs, boluses, smbs: [], temps: [], dia_hours: 6, peak_minutes: 75, trio_cycles: [],
    therapies: [
      { from_ms: null, carb_ratio_g_per_u: [['00:00', 10]], sensitivity_per_u: [['00:00', 120]], basal_u_per_h: [['00:00', 0.3]], target_low_mgdl: [['00:00', 110]], units: 'mg/dl' },
      { from_ms: NOW - 10 * DAY, carb_ratio_g_per_u: [['00:00', 9]], sensitivity_per_u: [['00:00', 120]], basal_u_per_h: [['00:00', 0.3]], target_low_mgdl: [['00:00', 110]], units: 'mg/dl' },
    ],
  };
}

describe('simulation tools', () => {
  it('puts the window after the hours no change reaches, across midnight', () => {
    expect(defaultWindow([{ from: '18:00', to: '00:00' }, { from: '00:00', to: '02:00' }])).toEqual({ from: '18:00', to: '06:00' });
    expect(defaultWindow([{ from: '09:30', to: '18:00' }])).toEqual({ from: '09:30', to: '22:00' });
  });

  it('rejects values outside the range and says when there is no Trio log', () => {
    const d = data();
    expect(runSimulationTool('simulate_settings', { changes: [{ setting: 'ICR', from: '18:00', to: '00:00', value: 99 }], window_from: null, window_to: null, days: null }, d, NOW, null).result.status).toBe('INVALID_VALUE');
    expect(runSimulationTool('simulate_settings', { changes: [{ setting: 'ICR', from: '18:00', to: '00:00', value: 7.5 }], window_from: null, window_to: null, days: null }, d, NOW, null).result.status).toBe('NO_TRIO_CYCLES');
  });

  it('compares two periods with habits and the profile change between them', () => {
    const r = runSimulationTool('compare_periods', { a_from: '2026-10-15', a_to: '2026-10-28', b_from: '2026-11-02', b_to: '2026-11-10', hours_from: null, hours_to: null }, data(), NOW, null).result as any;
    expect(r.a.mean_mgdl).toBe(160);
    expect(r.b.mean_mgdl).toBe(130);
    expect(r.b.boluses_per_meal).toBe(2);
    expect(r.b.meals_with_split_dose_pct).toBe(100);
    expect(r.profile_changes).toEqual([{ date: '2026-11-01', setting: 'ICR', hours: '00:00–24:00', before: 10, after: 9 }]);
  });

  it('keeps the last days only', () => {
    expect(lastDays(data(), 14, NOW).readings[0][0]).toBeGreaterThanOrEqual(NOW - 14 * DAY - 12 * 3_600_000);
  });
});

describe('ChatSimulationSession', () => {
  it('loads data once per answer, runs the tool and keeps no card without a replay', async () => {
    let loads = 0;
    const session = new ChatSimulationSession({ patientId: 'p-cache', timeZone: 'UTC', checkDate: null, now: () => NOW, store: { loadReplayData: async () => { loads += 1; return data(); }, loadHistory: async () => { loads += 1; return data(); } } });
    const r = await session.call('compare_periods', { a_from: '2026-10-15', a_to: '2026-10-28', b_from: '2026-11-02', b_to: '2026-11-10', hours_from: null, hours_to: null });
    expect(r).toMatchObject({ tool: 'compare_periods', status: 'OK' });
    await session.call('compare_periods', { a_from: '2026-10-15', a_to: '2026-10-28', b_from: '2026-11-02', b_to: '2026-11-10', hours_from: null, hours_to: null });
    expect(loads).toBe(1);
    expect(session.takeCard()).toBeNull();
    expect((await session.call('nope', {})).status).toBe('INVALID_REQUEST');
  });

  it('answers UNAVAILABLE when loading fails', async () => {
    const session = new ChatSimulationSession({ patientId: 'p-fail', timeZone: 'UTC', checkDate: null, now: () => NOW, store: { loadReplayData: async () => { throw new Error('db'); }, loadHistory: async () => { throw new Error('db'); } } });
    expect((await session.call('simulate_settings', { changes: [], window_from: null, window_to: null, days: null })).status).toBe('UNAVAILABLE');
  });
});
