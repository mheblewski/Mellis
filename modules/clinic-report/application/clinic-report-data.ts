import type { WhatIfData, WhatIfTherapy } from '@modules/settings-whatif/application/icr-whatif';
import { localClock } from '@modules/settings-whatif/application/settings-replay';
import { localInstant } from '@modules/settings-insights/application/settings-insights-common';
import { profileChanges } from './profile-changes';

/**
 * "Raport dla poradni" (clinic-report.v1): the numbers of the last 14 days for the diabetes clinic — CGM
 * metrics against the previous 14 days, the daily profile, times of day, insulin, the Trio settings with what the loop's
 * own decisions show, low episodes (ATTD 2023) and the days one by one. Facts only: no replay, no dosing advice.
 */
export const CLINIC_REPORT_VERSION = 'clinic-report.v1';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface ClinicReportCycle { ms: number; reason: string; iob: number | null }

export interface ClinicReportInput {
  /** At least 28 days before `todayIso` (the report and the comparison period). */
  data: WhatIfData;
  cycles: ClinicReportCycle[];
  patient: { name: string; birthYear: number | null };
  loopName: string;
  /** The local date of the report: the period ends at its midnight. */
  todayIso: string;
  generatedAtMs: number;
  /** Shown patterns (Wzorce), lows first; the settings card excluded. */
  patterns: Array<{ id: string; title: string; sentence: string }>;
}

export interface PeriodMetrics {
  days: number; wear: number; loop: number; mean: number; gmi: number; cv: number;
  vlow: number; low: number; tir: number; high: number; vhigh: number; tbr: number; tar: number; titr: number;
}

export interface ScheduleRow { from: string; to: string; value: number }

export interface ClinicReportData {
  version: string;
  patient: { name: string; birthYear: number | null };
  loopName: string;
  period: { from: string; to: string; prevFrom: string; prevTo: string };
  generatedOn: string;
  changes: Array<{ date: string; label: string; before: string; after: string; startMinute: number | null }>;
  current: PeriodMetrics;
  previous: PeriodMetrics | null;
  /** 96 slots of 15 min: [p10, p25, p50, p75, p90] or null. */
  profile: Array<[number, number, number, number, number] | null>;
  blocks: Array<{ hour: number; tir: number; tbr: number; tar: number; median: number; episodes: number; level2: number }>;
  episodes: { total: number; level2: number; zeroBasalBefore: number };
  lowRows: Array<{ hour: number; n: number; level2: number; under2h: number; from2to4h: number; over4h: number; iobMedian: number | null; carbsBefore: number }>;
  shareAfterMealBolus: number;
  rescues: { count: number; medianGrams: number | null };
  insulin: { tdd: number; mealUnits: number; mealBoluses: number; meals: number; correctionUnits: number; corrections: number; smb: number; basal: number; scheduledBasal: number; carbs: number };
  basal: Array<ScheduleRow & { smbZeroShare: number | null; maxTemp: number | null }>;
  icr: Array<ScheduleRow & { before: number | null }>;
  isf: Array<ScheduleRow & { used: number | null }>;
  target: ScheduleRow[];
  dia: number | null;
  dynamicIsf: { formula: string | null; factor: number | null; limit: number | null; clampedShare: number | null };
  patterns: Array<{ id: string; title: string; sentence: string }>;
  questions: Array<{ label: string; text: string }>;
  days: Array<{ date: string; weekday: number; points: Array<[number, number]> }>;
}

const round = (x: number, k = 1) => Math.round(x * 10 ** k) / 10 ** k;
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (sorted: number[], p: number) => {
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
const toMinutes = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
const clock = (m: number) => (m >= 1440 ? '24:00' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
export const plDecimal = (x: number | null | undefined, k = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '–' : x.toFixed(k).replace('.', ','));

function scheduleRows(schedule: Array<[string, number]> | null | undefined): ScheduleRow[] {
  const list = [...(schedule ?? [])].sort((a, b) => toMinutes(a[0]) - toMinutes(b[0]));
  return list.map(([t, v], i) => ({ from: clock(toMinutes(t)), to: i + 1 < list.length ? clock(toMinutes(list[i + 1][0])) : '24:00', value: v }));
}
function valueAt(schedule: Array<[string, number]> | null | undefined, minute: number): number | null {
  let v: number | null = null;
  for (const [t, x] of [...(schedule ?? [])].sort((a, b) => toMinutes(a[0]) - toMinutes(b[0]))) if (toMinutes(t) <= minute) v = x;
  return v;
}

/** Changes between consecutive profiles inside the period, one row per setting and contiguous range of hours. */
function settingChanges(therapies: WhatIfTherapy[], start: number, end: number, dateOf: (ms: number) => string) {
  const hhmm = (m: number) => clock(m).replace(/^0(\d)/, '$1');
  return profileChanges(therapies, start, end, dateOf).slice(0, 8).map((r) => ({
    date: dateOf(r.at), label: `${r.setting} ${hhmm(r.fromMinute)}–${hhmm(r.toMinute)} (${r.unit})`,
    before: plDecimal(r.before, r.digits), after: plDecimal(r.after, r.digits), startMinute: r.fromMinute,
  }));
}

export function buildClinicReportData(input: ClinicReportInput): ClinicReportData {
  const { data } = input;
  const tz = data.time_zone;
  const loc = localClock(tz);
  const end = localInstant(input.todayIso, 0, tz);
  const start = end - 14 * DAY;
  const prevStart = start - 14 * DAY;
  const dateOf = (ms: number) => { const d = loc(ms).date; return `${Number(d.slice(8))}.${d.slice(5, 7)}`; };
  const minuteOf = (ms: number) => { const c = loc(ms); return c.hour * 60 + c.minute; };
  const readings = data.readings.filter(([, v]) => v > 0).sort((a, b) => a[0] - b[0]);
  const between = (a: number, b: number) => readings.filter(([t]) => t >= a && t < b);
  const cycles = [...input.cycles].sort((a, b) => a.ms - b.ms);

  const metrics = (a: number, b: number, days: number): PeriodMetrics | null => {
    const v = between(a, b).map(([, x]) => x);
    if (v.length < 288) return null;
    const n = v.length;
    const mean = v.reduce((s, x) => s + x, 0) / n;
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / n);
    const p = (f: (x: number) => boolean) => round((100 * v.filter(f).length) / n);
    const bands = { vlow: p((x) => x < 54), low: p((x) => x >= 54 && x < 70), tir: p((x) => x >= 70 && x <= 180), high: p((x) => x > 180 && x <= 250), vhigh: p((x) => x > 250) };
    bands.tir = round(bands.tir + round(100 - (bands.vlow + bands.low + bands.tir + bands.high + bands.vhigh)));
    const slots = new Set(cycles.filter((c) => c.ms >= a && c.ms < b).map((c) => Math.floor(c.ms / (5 * MIN))));
    return {
      days, wear: Math.round((100 * n) / (days * 288)), loop: Math.round((100 * slots.size) / (days * 288)), mean: Math.round(mean),
      gmi: round(3.31 + 0.02392 * mean), cv: round((100 * sd) / mean), ...bands,
      tbr: round(bands.vlow + bands.low), tar: round(bands.high + bands.vhigh), titr: p((x) => x >= 70 && x <= 140),
    };
  };
  const current = metrics(start, end, 14) as PeriodMetrics;
  const previous = metrics(prevStart, start, 14);

  // Daily profile, 15-minute slots.
  const slots: number[][] = Array.from({ length: 96 }, () => []);
  for (const [t, v] of between(start, end)) slots[Math.floor(minuteOf(t) / 15)].push(v);
  const profile = slots.map((s) => {
    if (!s.length) return null;
    const sorted = [...s].sort((a, b) => a - b);
    return [0.1, 0.25, 0.5, 0.75, 0.9].map((q) => quantile(sorted, q)) as [number, number, number, number, number];
  });

  // Low episodes, ATTD 2023: >= 15 min < 70 starts one; >= 15 min >= 70 ends it; level 2 = >= 15 min < 54 inside.
  type Episode = { start: number; level2: boolean };
  const episodes: Episode[] = [];
  {
    let run: Array<[number, number]> = []; let cur: Episode | null = null; let aboveSince: number | null = null; let run54: number[] = [];
    for (const [t, v] of between(start, end)) {
      if (!cur) {
        if (v < 70) {
          run.push([t, v]);
          // The readings under 54 from the episode's first 15 min count for level 2 too.
          if (run[run.length - 1][0] - run[0][0] >= 10 * MIN) { cur = { start: run[0][0], level2: false }; run54 = run.filter(([, x]) => x < 54).map(([x]) => x); }
        } else run = [];
        continue;
      }
      if (v < 70) aboveSince = null;
      else { aboveSince = aboveSince ?? t; if (t - aboveSince >= 10 * MIN) { episodes.push(cur); cur = null; run = []; aboveSince = null; continue; } }
      if (v < 54) { run54.push(t); if (run54[run54.length - 1] - run54[0] >= 10 * MIN) cur.level2 = true; } else run54 = [];
    }
    if (cur) episodes.push(cur);
  }

  const carbs = [...data.carbs].sort((a, b) => a.ms - b.ms);
  const boluses = [...data.boluses].sort((a, b) => a[0] - b[0]);
  const isMealBolus = (t: number) => carbs.some((c) => Math.abs(c.ms - t) <= 30 * MIN && c.kind !== 'HYPO_TREATMENT');
  const mealBolusTimes = boluses.filter(([t]) => isMealBolus(t)).map(([t]) => t);
  const temps = [...data.temps].sort((a, b) => a[0] - b[0]);
  const iobAt = (t: number) => {
    let best: ClinicReportCycle | null = null;
    for (const c of cycles) { if (Math.abs(c.ms - t) <= 10 * MIN && (!best || Math.abs(c.ms - t) < Math.abs(best.ms - t))) best = c; if (c.ms > t + 10 * MIN) break; }
    return best?.iob ?? null;
  };
  const zeroBefore = (t: number) => temps.some(([s, r, m]) => r === 0 && s <= t && s + m * MIN >= t - 30 * MIN && s >= t - 6 * HOUR);

  const blocks: ClinicReportData['blocks'] = [];
  const lowRows: ClinicReportData['lowRows'] = [];
  for (let h = 0; h < 24; h += 3) {
    const vs = between(start, end).filter(([t]) => { const x = loc(t).hour; return x >= h && x < h + 3; }).map(([, v]) => v);
    const eps = episodes.filter((e) => { const x = loc(e.start).hour; return x >= h && x < h + 3; });
    const share = (f: (v: number) => boolean) => (vs.length ? round((100 * vs.filter(f).length) / vs.length) : 0);
    blocks.push({ hour: h, tir: share((v) => v >= 70 && v <= 180), tbr: share((v) => v < 70), tar: share((v) => v > 180), median: Math.round(median(vs) ?? 0), episodes: eps.length, level2: eps.filter((e) => e.level2).length });
    const row = { hour: h, n: eps.length, level2: eps.filter((e) => e.level2).length, under2h: 0, from2to4h: 0, over4h: 0, iobMedian: null as number | null, carbsBefore: 0 };
    const iobs: number[] = [];
    for (const e of eps) {
      const last = boluses.filter(([b]) => b <= e.start).pop();
      const gap = last ? (e.start - last[0]) / HOUR : 99;
      if (gap < 2) row.under2h += 1; else if (gap < 4) row.from2to4h += 1; else row.over4h += 1;
      const iob = iobAt(e.start); if (iob !== null) iobs.push(iob);
      if (carbs.some((c) => c.ms >= e.start - 3 * HOUR && c.ms < e.start && c.kind !== 'HYPO_TREATMENT')) row.carbsBefore += 1;
    }
    const m = median(iobs); row.iobMedian = m === null ? null : round(m);
    lowRows.push(row);
  }
  let afterMeal = 0; let all = 0;
  for (let t = start; t < end; t += 5 * MIN) { all += 1; if (mealBolusTimes.some((b) => b <= t - 30 * MIN && b >= t - 5 * HOUR)) afterMeal += 1; }
  const rescueGrams = carbs.filter((c) => c.ms >= start && c.ms < end && c.kind === 'HYPO_TREATMENT').map((c) => c.g);

  // Insulin and carbs per day.
  const therapies = [...data.therapies].sort((a, b) => (a.from_ms ?? 0) - (b.from_ms ?? 0));
  const currentTherapy = therapies[therapies.length - 1];
  const inPeriod = (t: number) => t >= start && t < end;
  const mealBoluses = boluses.filter(([t]) => inPeriod(t) && isMealBolus(t));
  const corrections = boluses.filter(([t]) => inPeriod(t) && !isMealBolus(t));
  let basal = 0; let ti = 0;
  for (let t = start; t < end; t += 5 * MIN) {
    while (ti + 1 < temps.length && temps[ti + 1][0] <= t) ti += 1;
    const temp = temps[ti];
    const rate = temp && temp[0] <= t && t < temp[0] + temp[2] * MIN ? temp[1] : valueAt(currentTherapy.basal_u_per_h, minuteOf(t)) ?? 0;
    basal += rate / 12;
  }
  let scheduledBasal = 0;
  for (let m = 0; m < 1440; m += 5) scheduledBasal += (valueAt(currentTherapy.basal_u_per_h, m) ?? 0) / 12;
  const meals: Array<{ at: number; g: number; last: number }> = [];
  for (const c of carbs) {
    if (!inPeriod(c.ms) || c.kind === 'HYPO_TREATMENT') continue;
    const last = meals[meals.length - 1];
    if (last && c.ms - last.last <= 45 * MIN) { last.g += c.g; last.last = c.ms; } else meals.push({ at: c.ms, g: c.g, last: c.ms });
  }
  const sum = (xs: Array<[number, number]>) => xs.reduce((s, [, u]) => s + u, 0);
  const smb = sum(data.smbs.filter(([t]) => inPeriod(t)));
  const insulin = {
    tdd: round((sum(mealBoluses) + sum(corrections) + smb + basal) / 14), mealUnits: round(sum(mealBoluses) / 14), mealBoluses: round(mealBoluses.length / 14),
    meals: round(meals.length / 14), correctionUnits: round(sum(corrections) / 14), corrections: round(corrections.length / 14),
    smb: round(smb / 14), basal: round(basal / 14), scheduledBasal: round(scheduledBasal, 2), carbs: Math.round(meals.reduce((s, m) => s + m.g, 0) / 14),
  };

  // Settings with what Trio's decisions show.
  const decisions = cycles.filter((c) => inPeriod(c.ms));
  const inRow = (m: number, r: ScheduleRow) => m >= toMinutes(r.from) && m < (r.to === '24:00' ? 1440 : toMinutes(r.to));
  const basalRows = scheduleRows(currentTherapy.basal_u_per_h).map((r) => {
    const maxBolus: number[] = []; const maxTemp: number[] = [];
    for (const c of decisions) {
      if (!inRow(minuteOf(c.ms), r)) continue;
      const mb = /maxBolus (\d+(?:\.\d+)?)/.exec(c.reason); if (mb) maxBolus.push(Number(mb[1]));
      const ms = /maxSafeBasal: (\d+(?:\.\d+)?)/.exec(c.reason); if (ms) maxTemp.push(Number(ms[1]));
    }
    const counts = new Map<number, number>(); for (const x of maxTemp) counts.set(x, (counts.get(x) ?? 0) + 1);
    const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return { ...r, smbZeroShare: maxBolus.length ? Math.round((100 * maxBolus.filter((x) => x === 0).length) / maxBolus.length) : null, maxTemp: mode };
  });
  const firstChange = therapies.find((t) => (t.from_ms ?? 0) >= start && (t.from_ms ?? 0) < end);
  const beforeTherapy = firstChange ? therapies[therapies.indexOf(firstChange) - 1] ?? null : null;
  const icr = scheduleRows(currentTherapy.carb_ratio_g_per_u).map((r) => {
    const b = beforeTherapy ? valueAt(beforeTherapy.carb_ratio_g_per_u, toMinutes(r.from)) : null;
    return { ...r, before: b !== null && Math.abs(b - r.value) > 1e-9 ? b : null };
  });
  const isf = scheduleRows(currentTherapy.sensitivity_per_u).map((r) => {
    const used = decisions.filter((c) => inRow(minuteOf(c.ms), r)).map((c) => /ISF: \d+(?:\.\d+)?→(\d+(?:\.\d+)?)/.exec(c.reason)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1]));
    const med = median(used);
    return { ...r, used: med === null ? null : Math.round(med) };
  });
  const dyn = decisions.map((c) => c.reason).filter((r) => /Dynamic Limit/.test(r));
  const limit = dyn.map((r) => /Limit: (\d+(?:\.\d+)?) \((\d+(?:\.\d+)?)\)/.exec(r)).filter((m): m is RegExpExecArray => m !== null);
  const dynamicIsf = {
    formula: dyn.length ? (/Logarithmic/.test(dyn[0]) ? 'logarytmiczny' : /Sigmoid/.test(dyn[0]) ? 'sigmoidalny' : null) : null,
    factor: dyn.length ? Number(/AF: (\d+(?:\.\d+)?)/.exec(dyn[0])?.[1] ?? NaN) || null : null,
    limit: limit.length ? Number(limit[0][1]) : null,
    clampedShare: limit.length ? Math.round((100 * limit.filter((m) => Number(m[2]) >= Number(m[1])).length) / limit.length) : null,
  };

  // Questions to bring: plain facts, "Do omówienia" / "Czy to zamierzone?".
  const questions: ClinicReportData['questions'] = [];
  const hours = (h: number) => `${h}:00–${h + 3}:00`;
  const worstLow = [...blocks].sort((a, b) => b.tbr - a.tbr)[0];
  const worstHigh = [...blocks].sort((a, b) => b.tar - a.tar)[0];
  const timeParts: string[] = [];
  if (worstLow && worstLow.tbr > 4) timeParts.push(`${hours(worstLow.hour)}: ${plDecimal(worstLow.tbr)}% czasu poniżej 70 (${worstLow.episodes} ${worstLow.episodes === 1 ? 'epizod' : worstLow.episodes < 5 && worstLow.episodes > 1 ? 'epizody' : 'epizodów'}, ${worstLow.level2} poniżej 54).`);
  if (worstHigh && worstHigh.tar > 25) timeParts.push(`${hours(worstHigh.hour)}: ${plDecimal(worstHigh.tar, 0)}% czasu powyżej 180.`);
  if (timeParts.length) questions.push({ label: 'Pory dnia', text: `${timeParts.join(' ')} Do omówienia.` });
  for (const p of input.patterns) questions.push({ label: p.title, text: `${p.sentence} Do omówienia.` });
  const blocked = basalRows.filter((r) => (r.smbZeroShare ?? 0) >= 50);
  const facts: string[] = [];
  if (blocked.length) {
    const temp = blocked.map((r) => r.maxTemp).filter((x): x is number => x !== null);
    facts.push(`Baza ${plDecimal(blocked[0].value, 2)} j/h (${blocked.map((r) => `${r.from.replace(/^0(\d)/, '$1')}–${r.to.replace(/^0(\d)/, '$1')}`).join(', ')}): limit mikrobolusa w decyzjach ${input.loopName} = 0 j${temp.length ? `, baza tymczasowa najwyżej ${plDecimal(Math.max(...temp), 1)} j/h` : ''}.`);
  }
  if (data.dia_hours !== null && data.dia_hours >= 8) facts.push(`DIA ${plDecimal(data.dia_hours, 0)} h.`);
  // Dynamic ISF at its limit: not a question until the lower limit is read from autosens min (role review 2026-11-12).
  if (facts.length) questions.push({ label: 'Ustawienia pętli', text: `${facts.join(' ')} Czy to zamierzone?` });

  const days: ClinicReportData['days'] = [];
  for (let k = 0; k < 14; k += 1) {
    const a = start + k * DAY; const b = a + DAY;
    const date = loc(a + HOUR).date;
    const pts = between(a, b).filter((_, i) => i % 2 === 0).map(([t, v]) => [Math.round((t - a) / MIN), v] as [number, number]);
    days.push({ date, weekday: (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7, points: pts });
  }

  return {
    version: CLINIC_REPORT_VERSION,
    patient: input.patient,
    loopName: input.loopName,
    period: { from: dateOf(start), to: dateOf(end - HOUR), prevFrom: dateOf(prevStart), prevTo: dateOf(start - HOUR) },
    generatedOn: (() => { const d = loc(input.generatedAtMs).date; return `${Number(d.slice(8))}.${d.slice(5, 7)}.${d.slice(0, 4)}`; })(),
    changes: settingChanges(data.therapies, start, end, dateOf),
    current, previous, profile, blocks,
    episodes: { total: episodes.length, level2: episodes.filter((e) => e.level2).length, zeroBasalBefore: episodes.filter((e) => zeroBefore(e.start)).length },
    lowRows, shareAfterMealBolus: Math.round((100 * afterMeal) / Math.max(all, 1)),
    rescues: { count: rescueGrams.length, medianGrams: median(rescueGrams) },
    insulin, basal: basalRows, icr, isf, target: scheduleRows(currentTherapy.target_low_mgdl), dia: data.dia_hours, dynamicIsf,
    patterns: input.patterns, questions, days,
  };
}
