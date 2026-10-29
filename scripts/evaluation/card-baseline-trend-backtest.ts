/**
 * Backtest of the card forecast's baseline (the line without the card) at every loop calculation, not only around meals
 * (owner 2026-10-23: glucose 116 and rising, every card forecast a fall to 39). Read-only (READ ONLY transaction), no
 * writes, no jobs, no AI, no network beyond the local database.
 *
 * Each Trio device status with curves is a case when the CGM has a reading at most 10 min older than the calculation and
 * no bolus or carb entry follows within 120 min (what comes next would be a new dose, not the baseline's error). The
 * baseline is drawn by computeBolusForecast itself (no carbs, no insulin) from a variant of the loop's curves:
 *   MAIN        the main curve as the card draws it today (COB while carbs absorb, else IOB);
 *   UAM         Trio's unannounced-meal curve when it has one, else MAIN;
 *   MEAN        the mean of MAIN and UAM where UAM exists;
 *   TREND T     MAIN pulled toward the CGM trend, fully at the start and fading to MAIN at T minutes;
 *   FLOOR f     MAIN's fall limited to f mg/dL per 5 min while the CGM is not falling.
 * Scored against the CGM at 30/60/90/120 min (MAE, bias = forecast − CGM) and for lows within 120 min: a forecast below
 * 70 when the CGM went below 70 (caught) or did not (false alarm). The subset "contradicts" is the cases where the CGM
 * rose (slope > 0) while MAIN fell by more than 20 mg/dL within 60 min.
 *
 * Usage: tsx scripts/evaluation/card-baseline-trend-backtest.ts --database-url postgresql:///<restore with "backtest">
 *          --output-dir ~/mellis-eval/<dir>
 * Outputs (results.json, REPORT.md) contain patient data and must stay outside the repository.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import type { GlucosePoint } from '@modules/glucose-forecast/application/cgm-trend';
import { computeBolusForecast } from '@modules/glucose-forecast/application/bolus-forecast';
import { buildGlucoseForecast, mainCurveName } from '@modules/glucose-forecast/application/glucose-forecast';
import { parseLoopPrediction, type LoopPrediction } from '@modules/loop-system/application/loop-prediction';

const MINUTE = 60_000;
const HORIZONS = [30, 60, 90, 120] as const;
const LOW = 70;

export type Variant = { name: string; curve: (prediction: LoopPrediction, slopePerMin: number | null) => number[] | null };

const main = (prediction: LoopPrediction) => {
  const name = mainCurveName(prediction);
  return name ? prediction.curves[name] ?? null : null;
};

/** MAIN pulled toward the CGM trend: weight 1 at the start, 0 from T minutes on (the trend held for at most 30 min). */
export function trendBlend(values: number[], slopePerMin: number | null, fadeMinutes: number): number[] {
  if (slopePerMin === null) return values;
  return values.map((value, index) => {
    const minutes = index * 5;
    const weight = Math.max(0, 1 - minutes / fadeMinutes);
    const trend = values[0] + slopePerMin * Math.min(minutes, 30);
    return Math.round(value + weight * (trend - value));
  });
}

/** MAIN's fall limited to `perStep` mg/dL per 5 min while the CGM is not falling. */
export function floorFall(values: number[], slopePerMin: number | null, perStep: number): number[] {
  if (slopePerMin === null || slopePerMin < 0) return values;
  const out: number[] = [values[0]];
  for (let index = 1; index < values.length; index += 1) out.push(out[index - 1] + Math.max(values[index] - values[index - 1], -perStep));
  return out;
}

export const VARIANTS: Variant[] = [
  { name: 'MAIN', curve: (p) => main(p) },
  { name: 'UAM', curve: (p) => p.curves.UAM ?? main(p) },
  { name: 'MEAN', curve: (p) => {
    const m = main(p);
    const u = p.curves.UAM;
    if (!m || !u) return m;
    return m.map((value, index) => Math.round((value + (u[index] ?? u[u.length - 1])) / 2));
  } },
  ...[30, 60, 90].map((t) => ({ name: `TREND ${t}`, curve: (p: LoopPrediction, s: number | null) => { const m = main(p); return m ? trendBlend(m, s, t) : null; } })),
  ...[2, 4, 6].map((f) => ({ name: `FLOOR ${f}`, curve: (p: LoopPrediction, s: number | null) => { const m = main(p); return m ? floorFall(m, s, f) : null; } })),
];

function argValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function actualAt(readings: GlucosePoint[], atMs: number): number | null {
  let best: GlucosePoint | null = null;
  for (const reading of readings) {
    const distance = Math.abs(Date.parse(reading.at) - atMs);
    if (distance <= 5 * MINUTE && (!best || distance < Math.abs(Date.parse(best.at) - atMs))) best = reading;
  }
  return best ? best.value : null;
}

async function main_(): Promise<void> {
  const args = process.argv.slice(2);
  const url = argValue(args, '--database-url');
  const out = argValue(args, '--output-dir');
  if (!url || !/backtest/.test(url) || !out) throw new Error('--database-url (a local restore with "backtest" in its name) and --output-dir are required');
  const outDir = resolve(out.replace(/^~/, process.env.HOME ?? '~'));
  if (outDir.includes('/gluco-mind')) throw new Error('the output directory must be outside the repository');
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const readings = (await client.query(`SELECT patient_id::text, occurred_at, (payload->>'glucose_value')::numeric AS value FROM events WHERE type = 'GLUCOSE_READING_AVAILABLE' ORDER BY occurred_at`)).rows
      .map((row) => ({ patient: String(row.patient_id), point: { at: new Date(row.occurred_at).toISOString(), value: Number(row.value) } }));
    const doses = (await client.query(`SELECT patient_id::text, occurred_at FROM events WHERE type IN ('BOLUS', 'CARB_ENTRY') ORDER BY occurred_at`)).rows
      .map((row) => ({ patient: String(row.patient_id), ms: new Date(row.occurred_at).getTime() }));
    const statuses = (await client.query(`SELECT patient_id::text, occurred_at, raw_payload FROM source_records WHERE record_type = 'DEVICE_STATUS' ORDER BY occurred_at`)).rows;
    await client.query('COMMIT');

    type Score = { errors: Record<number, number[]>; caught: number; missed: number; falseAlarms: number; lowsAvoided: number };
    const empty = (): Score => ({ errors: { 30: [], 60: [], 90: [], 120: [] }, caught: 0, missed: 0, falseAlarms: 0, lowsAvoided: 0 });
    const scores: Record<string, { all: Score; contradicts: Score }> = Object.fromEntries(VARIANTS.map((v) => [v.name, { all: empty(), contradicts: empty() }]));
    let cases = 0;
    let contradicting = 0;
    let lastCaseMs = 0;
    for (const status of statuses) {
      const patient = String(status.patient_id);
      const prediction = parseLoopPrediction({ observed_at: new Date(status.occurred_at).toISOString(), raw_payload: status.raw_payload });
      if (!prediction || !main(prediction)) continue;
      const nowMs = Date.parse(prediction.computed_at);
      if (nowMs - lastCaseMs < 10 * MINUTE) continue;
      const own = readings.filter((r) => r.patient === patient).map((r) => r.point);
      const before = own.filter((r) => Date.parse(r.at) <= nowMs && Date.parse(r.at) >= nowMs - 45 * MINUTE);
      const after = own.filter((r) => Date.parse(r.at) > nowMs && Date.parse(r.at) <= nowMs + 125 * MINUTE);
      if (before.length < 3 || after.length < 20) continue;
      if (doses.some((d) => d.patient === patient && d.ms > nowMs && d.ms <= nowMs + 120 * MINUTE)) continue;
      const forecast = buildGlucoseForecast({ now: new Date(nowMs), readings: before, prediction });
      if (!forecast.glucose || !forecast.reading_fresh) continue;
      lastCaseMs = nowMs;
      cases += 1;
      const startMs = Date.parse(forecast.glucose.at);
      const actualMin = Math.min(...after.map((r) => r.value));
      const mainValues = main(prediction)!;
      const contradicts = (forecast.slope_per_min ?? 0) > 0 && mainValues[0] - Math.min(...mainValues.slice(0, 13)) > 20;
      if (contradicts) contradicting += 1;
      for (const variant of VARIANTS) {
        const curve = variant.curve(prediction, forecast.slope_per_min);
        const chart = computeBolusForecast({
          now: new Date(nowMs), readings: before,
          prediction: curve ? { ...prediction, curves: { IOB: curve }, cob_g: 0 } : prediction,
          profile_isf: null, profile_units: null, dia_hours: null, carbs_g: 0, insulin_u: 0, icr_g_per_u: null,
        });
        if (!chart) continue;
        for (const bucket of contradicts ? [scores[variant.name].all, scores[variant.name].contradicts] : [scores[variant.name].all]) {
          for (const horizon of HORIZONS) {
            const actual = actualAt(after, startMs + horizon * MINUTE);
            const predicted = chart.baseline[horizon / 5];
            if (actual !== null && predicted !== undefined) bucket.errors[horizon].push(predicted - actual);
          }
          const predictedMin = Math.min(...chart.baseline.slice(0, 25));
          if (actualMin < LOW) predictedMin < LOW ? bucket.caught++ : bucket.missed++;
          else predictedMin < LOW ? bucket.falseAlarms++ : bucket.lowsAvoided++;
        }
      }
    }

    const mae = (values: number[]) => (values.length ? Math.round((values.reduce((s, v) => s + Math.abs(v), 0) / values.length) * 10) / 10 : null);
    const bias = (values: number[]) => (values.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10 : null);
    const summary = (score: Score) => ({
      mae: Object.fromEntries(HORIZONS.map((h) => [h, mae(score.errors[h])])),
      bias: Object.fromEntries(HORIZONS.map((h) => [h, bias(score.errors[h])])),
      lows_caught: score.caught, lows_missed: score.missed, false_alarms: score.falseAlarms, no_low_ok: score.lowsAvoided,
    });
    const result = { cases, contradicting, variants: Object.fromEntries(VARIANTS.map((v) => [v.name, { all: summary(scores[v.name].all), contradicts: summary(scores[v.name].contradicts) }])) };
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, 'results.json'), JSON.stringify(result, null, 2));
    const row = (name: string, s: ReturnType<typeof summary>) => `| ${name} | ${HORIZONS.map((h) => `${s.mae[h]} (${s.bias[h]})`).join(' | ')} | ${s.lows_caught}/${s.lows_caught + s.lows_missed} | ${s.false_alarms} |`;
    const table = (key: 'all' | 'contradicts') => [
      '| wariant | MAE (bias) 30 | 60 | 90 | 120 | niskie złapane | fałszywe alarmy |',
      '|---|---|---|---|---|---|---|',
      ...VARIANTS.map((v) => row(v.name, result.variants[v.name][key])),
    ].join('\n');
    writeFileSync(resolve(outDir, 'REPORT.md'), `# Baza prognozy karty: test historyczny\n\nPrzypadki: ${cases}, z czego sprzeczne (CGM rośnie, krzywa Trio spada > 20 mg/dL w 60 min): ${contradicting}.\n\n## Wszystkie\n\n${table('all')}\n\n## Sprzeczne\n\n${table('contradicts')}\n`);
    console.log(JSON.stringify({ cases, contradicting }));
    console.log(table('all'));
    console.log('\nsprzeczne:');
    console.log(table('contradicts'));
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main_().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
