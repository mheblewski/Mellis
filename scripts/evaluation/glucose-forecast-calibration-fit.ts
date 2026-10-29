/**
 * Refits glucose-forecast-calibration (SHRINK: glucose + w × the main curve's change, one w per 5-min horizon) from a
 * local restore of a backup. Read-only (READ ONLY transaction), no AI, no network beyond the local database.
 *
 * Usage: tsx scripts/evaluation/glucose-forecast-calibration-fit.ts --database-url postgresql:///glucomind_forecast_backtest_YYYYMMDD \
 *          --output-dir ~/mellis-eval/forecast-backtest-2026-10/<date> [--since 2026-10-15T00:00:00+02:00] [--source <dump file name>]
 * Same guards as trio-forecast-backtest.ts (a local *backtest* database only; output outside every Git tree). Writes
 * calibration.json and calibration.ts (the object to paste into
 * modules/glucose-forecast/application/forecast-calibration.ts as the next version), then re-run the backtest.
 */
import { Pool } from 'pg';
import { GLUCOSE_FORECAST_CALIBRATION, type ForecastCalibration } from '@modules/glucose-forecast/application/forecast-calibration';
import { describeErrorSafely, ensureEvaluationOutputDir, resolveEvaluationOutputDir, writeEvaluationOutputDirFile } from './evaluation-output-dir';
import { accuracy, actualAt, BacktestArgumentError, buildPatients, calibrate, loadBacktestRows, parseBacktestArgs, predict, type Calculation } from './trio-forecast-backtest';
import type { GlucosePoint } from '@modules/glucose-forecast/application/cgm-trend';

const MINUTE = 60_000;
const MAX_MINUTES = 120;

/** Least squares w per horizon on every calculation: Σ(predicted change × actual change) / Σ(predicted change²). */
export function fitShrink(calcs: Calculation[], readings: GlucosePoint[]): Record<number, number> {
  const times = readings.map((reading) => Date.parse(reading.at));
  const shrink: Record<number, number> = {};
  for (let minutes = 5; minutes <= MAX_MINUTES; minutes += 5) {
    let xy = 0;
    let xx = 0;
    for (const calc of calcs) {
      const main = predict(calc, 'MAIN', minutes);
      const actual = actualAt(readings, times, calc.anchor_ms + minutes * MINUTE);
      if (main === null || actual === null) continue;
      xy += (main - calc.bg) * (actual - calc.bg);
      xx += (main - calc.bg) ** 2;
    }
    shrink[minutes] = xx > 0 ? Math.round((xy / xx) * 1000) / 1000 : 1;
  }
  return shrink;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const requestedDir = resolveEvaluationOutputDir(argv);
  const { databaseUrl, since } = parseBacktestArgs(argv);
  const sourceIndex = argv.indexOf('--source');
  const source = sourceIndex >= 0 ? argv[sourceIndex + 1] ?? 'unknown' : 'unknown';
  const outputDir = ensureEvaluationOutputDir(requestedDir);
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const rows = await loadBacktestRows(client, since);
    const patients = buildPatients(rows.statuses, rows.readingRows, rows.carbRows);
    if (patients.length !== 1) throw new BacktestArgumentError(`Expected one patient, found ${patients.length}: fit per patient before using one calibration for all.`);
    const { calcs, readings } = patients[0];
    calibrate(calcs, readings);
    const heldOut = accuracy(calcs, readings);
    const firstMs = calcs[0].anchor_ms;
    const lastMs = calcs.at(-1)!.anchor_ms;
    const calibration: ForecastCalibration = {
      version: GLUCOSE_FORECAST_CALIBRATION.version,
      method: 'SHRINK',
      curve: 'MAIN',
      fitted_at: new Date().toISOString().slice(0, 10),
      data_window: {
        source,
        from: new Date(firstMs).toISOString(),
        to: new Date(lastMs).toISOString(),
        days: Math.round(((lastMs - firstMs) / (24 * 60 * MINUTE)) * 100) / 100,
        calculations: calcs.length,
      },
      validation: { mae_main_30: heldOut.MAIN['+30'].mae ?? 0, mae_calibrated_30: heldOut.SHRINK['+30'].mae ?? 0 },
      shrink_by_minutes: fitShrink(calcs, readings),
    };
    writeEvaluationOutputDirFile(outputDir, 'calibration.json', JSON.stringify(calibration, null, 2));
    writeEvaluationOutputDirFile(outputDir, 'calibration.ts', `export const GLUCOSE_FORECAST_CALIBRATION: ForecastCalibration = ${JSON.stringify(calibration, null, 2)};\n`);
    console.log(`Wrote calibration.json and calibration.ts to ${outputDir} (held-out MAE +30: MAIN ${calibration.validation.mae_main_30}, calibrated ${calibration.validation.mae_calibrated_30}).`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(describeErrorSafely(error, [BacktestArgumentError]));
    process.exitCode = 1;
  });
}
