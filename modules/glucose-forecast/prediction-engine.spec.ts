import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { buildGlucoseForecast } from './application/glucose-forecast';
import { isPredictionExperimentEnabled, isPredictionLineEnabled, predict } from './application/prediction-engine';

/** A small seeded generator, so a failure repeats. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const NOW = Date.parse('2026-11-06T12:00:00.000Z');

function curve(next: () => number, start: number): number[] {
  const out = [start];
  for (let i = 0; i < 12 + Math.floor(next() * 36); i += 1) out.push(Math.round(out[i] + (next() - 0.5) * 20));
  return out;
}

function scenario(next: () => number) {
  const count = Math.floor(next() * 14);
  const gapMinutes = next() * 40;
  const readings = Array.from({ length: count }, (_, index) => ({
    at: new Date(NOW - (gapMinutes + index * 5) * 60_000).toISOString(),
    value: Math.round(40 + next() * 300),
  }));
  const shape = next();
  const prediction = shape < 0.2 ? null : ({
    source: shape < 0.6 ? 'OPENAPS' : 'LOOP',
    system: shape < 0.6 ? 'TRIO' : 'LOOP',
    computed_at: new Date(NOW - next() * 30 * 60_000).toISOString(),
    eventual_bg: next() < 0.5 ? Math.round(60 + next() * 200) : null,
    curves: shape < 0.6
      ? { IOB: curve(next, 120), COB: next() < 0.5 ? curve(next, 120) : undefined, ZT: curve(next, 120), UAM: next() < 0.5 ? curve(next, 120) : undefined }
      : { LOOP: curve(next, 120) },
    cob_g: next() < 0.5 ? next() * 40 : 0,
  } as unknown as LoopPrediction);
  return { now: new Date(NOW), readings, prediction };
}

describe('predict', () => {
  it('gives exactly the forecast the other modules read, in 200 000 random cases', () => {
    const next = random(20261106);
    for (let index = 0; index < 200_000; index += 1) {
      const input = scenario(next);
      const set = predict(input);
      expect(set.loop, `case ${index}`).toEqual(buildGlucoseForecast(input));
    }
  }, 300_000);

  it('works out no line unless asked, and fills no other output yet', () => {
    const set = predict(scenario(random(1)));
    expect(set).toMatchObject({ engine_version: 'prediction-engine.v2', line: null, risk: null, plan: [], late_rise: [] });
  });

  it('does not change what it is given', () => {
    const input = scenario(random(2));
    const before = JSON.stringify(input);
    predict(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('isPredictionExperimentEnabled', () => {
  it('is on unless the server turned it off', () => {
    expect(isPredictionExperimentEnabled({})).toBe(true);
    expect(isPredictionExperimentEnabled({ PREDICTION_EXPERIMENT_ENABLED: 'false' })).toBe(false);
    expect(isPredictionExperimentEnabled({ PREDICTION_EXPERIMENT_ENABLED: '0' })).toBe(false);
    expect(isPredictionExperimentEnabled({ PREDICTION_EXPERIMENT_ENABLED: 'FALSE' })).toBe(false);
    expect(isPredictionExperimentEnabled({ PREDICTION_EXPERIMENT_ENABLED: 'true' })).toBe(true);
  });

  it('reads the line and experiment switches as every other flag, and an unknown value as off', () => {
    expect(isPredictionLineEnabled({})).toBe(true);
    expect(isPredictionLineEnabled({ PREDICTION_LINE_ENABLED: ' false ' })).toBe(false);
    expect(isPredictionLineEnabled({ PREDICTION_LINE_ENABLED: 'off' })).toBe(false);
    expect(isPredictionExperimentEnabled({ PREDICTION_EXPERIMENT_ENABLED: 'false ' })).toBe(false);
    expect(isPredictionExperimentEnabled({ PREDICTION_EXPERIMENT_ENABLED: '' })).toBe(true);
  });
});

describe('the safety boundary', () => {
  /** No dose or alert code may read the engine: a line that looks accurate must not become a dose. */
  const GUARDED = ['modules/remote-commands', 'modules/rescue-carbs', 'modules/glucose-alerts', 'modules/care-reminders', 'modules/meal-wbt', 'modules/notifications', 'modules/recommendations'];

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return name.endsWith('.ts') ? [path] : [];
    });
  }

  it.each(GUARDED)('%s does not import the prediction engine', (directory) => {
    const offenders = sourceFiles(join(process.cwd(), directory)).filter((path) => /prediction-(engine|service|worker)|simple-line/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the guarded folders exist, so the check above cannot pass by finding nothing', () => {
    for (const directory of GUARDED) expect(sourceFiles(join(process.cwd(), directory)).length, directory).toBeGreaterThan(0);
  });
});
