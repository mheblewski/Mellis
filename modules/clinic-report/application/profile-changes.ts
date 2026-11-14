import type { WhatIfTherapy } from '@modules/settings-whatif/application/icr-whatif';

/** A setting changed between two Trio profiles, for one contiguous range of hours. */
export interface ProfileChange {
  /** When the new profile took effect (epoch ms). */
  at: number;
  setting: 'ICR' | 'ISF' | 'Baza' | 'Cel';
  unit: string;
  digits: number;
  fromMinute: number;
  toMinute: number;
  before: number;
  after: number;
}

const SETTINGS: Array<{ key: keyof WhatIfTherapy; setting: ProfileChange['setting']; unit: string; digits: number }> = [
  { key: 'carb_ratio_g_per_u', setting: 'ICR', unit: 'g/j', digits: 1 },
  { key: 'sensitivity_per_u', setting: 'ISF', unit: 'mg/dl/j', digits: 0 },
  { key: 'basal_u_per_h', setting: 'Baza', unit: 'j/h', digits: 2 },
  { key: 'target_low_mgdl', setting: 'Cel', unit: 'mg/dl', digits: 0 },
];
const toMinutes = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
function valueAt(schedule: Array<[string, number]>, minute: number): number | null {
  let v: number | null = null;
  for (const [t, x] of [...schedule].sort((a, b) => toMinutes(a[0]) - toMinutes(b[0]))) if (toMinutes(t) <= minute) v = x;
  return v;
}

/**
 * The changes between consecutive profiles that took effect in [start, end). A profile saved twice on one local day
 * counts once per setting and range, from the value before the first save to the value in force after the last.
 */
export function profileChanges(therapies: WhatIfTherapy[], start: number, end: number, dayOf: (ms: number) => string): ProfileChange[] {
  const sorted = [...therapies].sort((a, b) => (a.from_ms ?? 0) - (b.from_ms ?? 0));
  const rows: ProfileChange[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const at = sorted[i].from_ms ?? 0;
    if (at < start || at >= end) continue;
    for (const s of SETTINGS) {
      const before = sorted[i - 1][s.key] as Array<[string, number]> | null;
      const after = sorted[i][s.key] as Array<[string, number]> | null;
      if (!before || !after) continue;
      const cuts = [...new Set([...before, ...after].map(([t]) => toMinutes(t)).concat([0]))].sort((a, b) => a - b);
      let open: { from: number; b: number; a: number } | null = null;
      cuts.forEach((m, k) => {
        const b = valueAt(before, m); const a = valueAt(after, m);
        const differs = b !== null && a !== null && Math.abs(b - a) > 1e-9;
        if (open && (!differs || open.b !== b || open.a !== a)) { rows.push({ at, setting: s.setting, unit: s.unit, digits: s.digits, fromMinute: open.from, toMinute: m, before: open.b, after: open.a }); open = null; }
        if (differs && !open) open = { from: m, b: b as number, a: a as number };
        if (k === cuts.length - 1 && open) { rows.push({ at, setting: s.setting, unit: s.unit, digits: s.digits, fromMinute: open.from, toMinute: 1440, before: open.b, after: open.a }); open = null; }
      });
    }
  }
  const seen = new Map<string, ProfileChange>();
  for (const r of rows) {
    const key = `${dayOf(r.at)}|${r.setting}|${r.fromMinute}|${r.toMinute}`;
    const prev = seen.get(key);
    seen.set(key, prev ? { ...r, before: prev.before } : r);
  }
  return [...seen.values()].filter((r) => Math.abs(r.before - r.after) > 1e-9);
}
