import { describe, expect, it } from 'vitest';
import { GLUCOSE_FORECAST_CALIBRATION } from '@modules/glucose-forecast/application/forecast-calibration';
import { isfToMgdl, isfUnitsUnknown } from '@modules/glucose-forecast/application/isf-units';
import { computeDoseCalculation } from '@modules/remote-commands/application/dose-calculator';
import type { MealForecastData } from '@modules/remote-commands/application/meal-dose-forecast';
import { evaluateRemoteCommand, type RemoteCommandContext } from '@modules/remote-commands/application/remote-command-policy';
import { computeRescueDose } from './application/rescue-dose';
import type { RescueEvaluation } from './application/rescue-detection';

/** Dose audit 2026-11-16: profiles that are not the family's (docs/product/dose-audit-profiles-2026-11-16.md). */
const now = new Date('2026-11-16T12:00:00.000Z');
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();

function evaluation(level: RescueEvaluation['level'], glucose: number, delta: number, predictedMin = glucose): RescueEvaluation {
  return {
    policy_version: 'test', evaluated_at: now.toISOString(), status: 'TRIGGER', level, trigger_source: 'TRIO_PREDICTION',
    suppressed_reason: null, no_data_reason: null, glucose: { at: now.toISOString(), value: glucose }, delta_per_5min: delta,
    slope_per_min: delta / 5, loop_used: true, carbs_req_g: null, predicted_min_mgdl: predictedMin, predicted_low_at: null,
    minutes_to_low: null, curve: { name: 'IOB', includes_cob: false, points: [{ at: at(15), value: predictedMin }] }, clear: false,
  };
}
const rescue = (ev: RescueEvaluation, profile: { isf: number; icr: number; units: string | null }, birthYear: number | null) => computeRescueDose({
  evaluation: ev,
  loop: { system: 'TRIO', isf_mgdl_per_u: profile.isf, icr_g_per_u: profile.icr, iob_u: 0.2, cob_g: 0 },
  profile: { isf: profile.isf, icr_g_per_u: profile.icr, units: profile.units },
  birth_year: birthYear,
});

describe('isfUnitsUnknown', () => {
  it('is true only below 25 with no units named', () => {
    expect(isfUnitsUnknown(20, null)).toBe(true);
    expect(isfUnitsUnknown(2.2, '')).toBe(true);
    expect(isfUnitsUnknown(20, 'mg/dl')).toBe(false);
    expect(isfUnitsUnknown(2.2, 'mmol')).toBe(false);
    expect(isfUnitsUnknown(40, null)).toBe(false);
    expect(isfUnitsUnknown(null, null)).toBe(false);
    // isfToMgdl is unchanged: it still reads it as mmol/L.
    expect(isfToMgdl(20, null)).toBe(360);
  });
});

describe('rescue dose: profile without units (UNITS_UNKNOWN)', () => {
  const noUnits = { isf: 20, icr: 5, units: null };

  it('an adult below 54 gets the dose for the age, not 4 g from an ISF read as mmol/L', () => {
    const dose = rescue(evaluation('URGENT_LOW', 48, -1, 46), noUnits, 1986);
    expect(dose.basis).toBe('UNITS_UNKNOWN');
    expect(dose.carbs_g).toBe(20);
    expect(dose.csf_mgdl_per_g).toBeNull();
    expect(dose.warnings[0]).toContain('nie ma jednostek');
  });

  it('54–69 flat gets the age table; a 3-year-old below 54 gets 0.3 g/kg for the age', () => {
    expect(rescue(evaluation('LOW_NOW', 64, -1), noUnits, 1986).carbs_g).toBe(10);
    expect(rescue(evaluation('URGENT_LOW', 48, -1), { isf: 15, icr: 30, units: null }, 2023).carbs_g).toBe(4);
  });

  it('without a year of birth, or with a predicted low, it gives no number', () => {
    const noAge = rescue(evaluation('URGENT_LOW', 48, -1), noUnits, null);
    expect(noAge.carbs_g).toBeNull();
    expect(noAge.warnings.some((line) => line.includes('roku urodzenia'))).toBe(true);
    expect(rescue(evaluation('PREDICTED_LOW', 85, -4, 62), noUnits, 1986).carbs_g).toBeNull();
  });

  it('rising glucose gives no number', () => {
    expect(rescue(evaluation('LOW_NOW', 64, 3), noUnits, 1986).carbs_g).toBeNull();
  });

  it('a profile with units is unchanged (mg/dL ISF 20 stays the formula)', () => {
    const dose = rescue(evaluation('LOW_NOW', 64, -1, 62), { isf: 20, icr: 5, units: 'mg/dl' }, 1986);
    expect(dose.basis).toBe('FORMULA');
    expect(dose.csf_mgdl_per_g).toBe(4);
  });
});

describe('rescue dose: missing year of birth', () => {
  it('is said on an ongoing low, not on a predicted one', () => {
    const profile = { isf: 40, icr: 10, units: 'mg/dl' };
    expect(rescue(evaluation('LOW_NOW', 64, -1, 62), profile, null).warnings.some((line) => line.includes('roku urodzenia'))).toBe(true);
    expect(rescue(evaluation('LOW_NOW', 64, -1, 62), profile, 1986).warnings.some((line) => line.includes('roku urodzenia'))).toBe(false);
    expect(rescue(evaluation('PREDICTED_LOW', 85, -4, 62), profile, null).warnings.some((line) => line.includes('roku urodzenia'))).toBe(false);
  });
});

describe('dose calculator: profile without units', () => {
  it('keeps using the calculator: IOB still lowers the dose, the misread ISF only shrinks the correction', () => {
    const readings = [12, 9, 6, 3, 0].map((m) => ({ at: at(-1 - m), value: 120 }));
    const data: MealForecastData = {
      readings,
      prediction: {
        source: 'OPENAPS', system: 'TRIO', computed_at: at(-1), bg: 120, carbs_req_g: null, iob_u: 5, cob_g: 0,
        isf_mgdl_per_u: 20, icr_g_per_u: 5, eventual_bg: 120, target_mgdl: 100, curves: { IOB: Array(37).fill(120) },
      },
      profile_isf: 20, profile_target: 100, profile_units: null,
      calibration: { ...GLUCOSE_FORECAST_CALIBRATION, version: 'test-none', shrink_by_minutes: { 5: 1 } },
    };
    const calc = computeDoseCalculation({ now, carbs_g: 50, icr_g_per_u: 5, step: 0.1, data, forecast_nudge: false });
    expect(calc.calculated).toBe(true);
    expect(calc.default_u).toBeLessThan(10);
  });
});

describe('remote command: amounts above the ceiling', () => {
  const context: RemoteCommandContext = {
    now: now.toISOString(), glucose: { value: 140, observed_at: at(-3), delta: 0 }, lowest_recent_glucose: 120,
    loop: { iob_units: 0, cob_grams: 0, observed_at: at(-3) }, last_bolus: null, icr_g_per_u: 4, in_flight_command_id: null,
    bolus_history_known: true, recent_remote_bolus: null, loop_system: 'LOOP',
  } as RemoteCommandContext;

  it('says the limit instead of "pump steps"', () => {
    const above = evaluateRemoteCommand({ carbs_g: 150, insulin_u: 37.5, bolus_step: 0.05, context });
    expect(above.blocks[0].code).toBe('INVALID_AMOUNTS');
    expect(above.blocks[0].message).toContain('powyżej limitu Mellis (30 j');
    expect(above.blocks[0].message).toContain('w Loopie');
    const step = evaluateRemoteCommand({ carbs_g: 40, insulin_u: 4.33, bolus_step: 0.05, context });
    expect(step.blocks[0].message).toContain('w krokach pompy');
  });

  it('names Loop, not Trio, for an unconfirmed remote bolus', () => {
    const result = evaluateRemoteCommand({ carbs_g: 0, insulin_u: 1, bolus_step: 0.05, context: { ...context, recent_remote_bolus: { at: at(-10), units: 1, status: 'NO_REPLY' } } as RemoteCommandContext });
    const line = result.warnings.find((warning) => warning.code === 'UNCONFIRMED_REMOTE_BOLUS');
    expect(line?.message).toContain('z Loopa');
  });
});

describe('rescue detection: the previous 5-minute change (rescue-dose.v6)', () => {
  it('is the change ending at the reading before the newest', async () => {
    const { evaluateRescueNeed } = await import('./application/rescue-detection');
    const readings = [80, 72, 66, 60].map((value, index) => ({ at: at(-15 + index * 5), value }));
    const ev = evaluateRescueNeed({ now, readings, prediction: null, last_carbs_at: null });
    expect(ev.delta_per_5min).toBe(-6);
    expect(ev.previous_delta_per_5min).toBe(-6);
    const gap = evaluateRescueNeed({ now, readings: [readings[0], readings[2], readings[3]], prediction: null, last_carbs_at: null });
    expect(gap.previous_delta_per_5min).toBeNull();
  });
});
