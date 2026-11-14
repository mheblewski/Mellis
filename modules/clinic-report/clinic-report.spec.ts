import { describe, expect, it } from 'vitest';
import type { WhatIfData } from '@modules/settings-whatif/application/icr-whatif';
import { buildClinicReportData } from './application/clinic-report-data';
import { renderClinicReportHtml } from './application/clinic-report-html';

const DAY = 86_400_000;
const END = Date.UTC(2026, 10, 11); // 11.11 00:00 UTC
const START = END - 28 * DAY;

function data(glucose: (ms: number) => number, extra: Partial<WhatIfData> = {}): WhatIfData {
  const readings: Array<[number, number]> = [];
  for (let ms = START; ms < END; ms += 300_000) readings.push([ms, glucose(ms)]);
  return {
    time_zone: 'UTC', readings, carbs: [], boluses: [], smbs: [], temps: [], dia_hours: 10, peak_minutes: 75,
    therapies: [{ from_ms: null, carb_ratio_g_per_u: [['00:00', 10], ['18:00', 7.1]], sensitivity_per_u: [['00:00', 120]], basal_u_per_h: [['00:00', 0.05], ['06:00', 0.3]], target_low_mgdl: [['00:00', 110]], units: 'mg/dl' }],
    ...extra,
  };
}
const input = (d: WhatIfData) => ({ data: d, cycles: [], patient: { name: 'Ewa <b>', birthYear: 2017 }, loopName: 'Trio', todayIso: '2026-11-11', generatedAtMs: END + 3_600_000, patterns: [] });

describe('buildClinicReportData', () => {
  it('counts a 20-minute low as one ATTD episode and ignores a 10-minute one', () => {
    const d = data((ms) => {
      const m = ((ms - START) % DAY) / 60_000;
      const day = Math.floor((ms - START) / DAY);
      if (day === 20 && m >= 120 && m < 140) return 60;
      if (day === 21 && m >= 120 && m < 130) return 60;
      return 120;
    });
    const r = buildClinicReportData(input(d));
    expect(r.episodes.total).toBe(1);
    expect(r.blocks[0].episodes).toBe(1);
    expect(r.current.tir + r.current.low + r.current.vlow + r.current.high + r.current.vhigh).toBeCloseTo(100, 5);
  });

  it('compares with the previous 14 days and lists a profile change with its hours', () => {
    const d = data((ms) => (ms < END - 14 * DAY ? 200 : 120));
    d.therapies.push({ ...d.therapies[0], from_ms: END - 5 * DAY + 3_600_000, carb_ratio_g_per_u: [['00:00', 10], ['18:00', 6.8]] });
    const r = buildClinicReportData(input(d));
    expect(r.previous!.tir).toBe(0);
    expect(r.current.tir).toBe(100);
    expect(r.changes).toEqual([{ date: '6.11', label: 'ICR 18:00–24:00 (g/j)', before: '7,1', after: '6,8', startMinute: 1080 }]);
    expect(r.icr.find((x) => x.from === '18:00')!.before).toBe(7.1);
  });

  it('reads the loop limits from the decisions', () => {
    const cycles = Array.from({ length: 40 }, (_, i) => ({ ms: END - 3 * DAY + i * 300_000, reason: 'ISF: 120→100, Dynamic ISF: On, Logarithmic formula, Autosens/Dynamic Limit: 1.2 (1.4), AF: 0.9; maxBolus 0. maxSafeBasal: 0.2', iob: 0.5 }));
    const r = buildClinicReportData({ ...input(data(() => 120)), cycles });
    expect(r.basal[0].smbZeroShare).toBe(100);
    expect(r.basal[0].maxTemp).toBe(0.2);
    expect(r.isf[0].used).toBe(100);
    expect(r.dynamicIsf).toEqual({ formula: 'logarytmiczny', factor: 0.9, limit: 1.2, clampedShare: 100 });
    expect(r.questions.at(-1)!.label).toBe('Ustawienia pętli');
  });
});

describe('renderClinicReportHtml', () => {
  it('renders four A4 pages and escapes the name', () => {
    const html = renderClinicReportHtml(buildClinicReportData(input(data(() => 120))));
    expect(html.match(/<section class="page">/g)).toHaveLength(4);
    expect(html).toContain('Ewa &lt;b&gt;, rocznik 2017');
    expect(html).not.toContain('Ewa <b>');
  });
});
