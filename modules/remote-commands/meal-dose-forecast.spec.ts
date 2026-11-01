import { describe, expect, it } from 'vitest';
import { FITTED_V1_FORECAST_CALIBRATION, type ForecastCalibration } from '@modules/glucose-forecast/application/forecast-calibration';
import type { LoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { computeFastCarbsFirst, computeMealDoseAdjustment, mealForecastDataFrom, type MealForecastData } from './application/meal-dose-forecast';

const now = new Date('2026-10-21T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
const readings = (...values: number[]) => values.map((value, index) => ({ at: at((values.length - 1 - index) * 5), value }));

function trio(overrides: Partial<LoopPrediction> = {}): LoopPrediction {
  return {
    source: 'OPENAPS',
    system: 'TRIO',
    computed_at: at(1),
    bg: 110,
    carbs_req_g: null,
    iob_u: 1.5,
    cob_g: 0,
    isf_mgdl_per_u: 50,
    icr_g_per_u: 10,
    eventual_bg: 80,
    // 110 falling 2 per step to 86 at 60 min, then faster to 50 at 90 min (5-min steps).
    curves: { IOB: [110, 108, 106, 104, 102, 100, 98, 96, 94, 92, 90, 88, 86, 80, 74, 68, 62, 56, 50] },
    ...overrides,
  };
}

/**
 * Most specs pin a calibration shaped like the opt-in fitted-v1 (Trio curves) with half of the curve's change at every
 * horizon, so they do not move with a refit; the default (FORECAST_CALIBRATION unset) is the loop's curve as it is.
 */
const HALF: ForecastCalibration = { ...FITTED_V1_FORECAST_CALIBRATION, version: 'test-half', shrink_by_minutes: { 5: 0.5 } };
const UNCALIBRATED: ForecastCalibration = { ...FITTED_V1_FORECAST_CALIBRATION, version: 'test-none', shrink_by_minutes: { 5: 1 } };

function data(overrides: Partial<MealForecastData> = {}): MealForecastData {
  return { readings: readings(122, 118, 114, 110), prediction: trio(), profile_isf: 50, profile_target: 100, profile_units: 'mg/dl', calibration: HALF, ...overrides };
}

const adjust = (carbs: number, input: Partial<MealForecastData> = {}, icr = 10) => computeMealDoseAdjustment({
  now,
  carbs_g: carbs,
  dose_u: Math.floor((carbs / icr) * 20) / 20,
  icr_g_per_u: icr,
  step: 0.05,
  data: data(input),
});

describe('meal dose for a falling glucose (meal-dose-forecast.v3)', () => {
  it('holds the calibrated forecast at +90 min against the target: 110 + ½ × (50 − 110) = 80, (100 − 80) / CSF 5 = 4 g of 30 g', () => {
    const result = adjust(30);
    expect(result).toMatchObject({
      basis: 'CALIBRATED_EVENTUAL',
      calibration_version: 'test-half',
      forecast_low_mgdl: 80,
      target_mgdl: 100,
      covered_carbs_g: 4,
      dose_before_u: 3,
      dose_u: 2.6,
      reduced_by_u: 0.4,
      give_at_meal_end: false,
    });
    expect(result?.summary).toBe('Za ok. 1,5 h prognoza ok. 80 mg/dL (cel 100), więc 4 g z posiłku pokryje spadek: insulina tylko na pozostałe 26 g (mniej o 0,4 j). Podaj na początku posiłku, nie wcześniej.');
  });

  it("holds the loop's own +90 min forecast by default (no calibration): 110 → 50, (100 − 50) / 5 = 10 g of 30 g", () => {
    const result = adjust(30, { calibration: undefined });
    expect(result).toMatchObject({ basis: 'CALIBRATED_EVENTUAL', calibration_version: null, forecast_low_mgdl: 50, covered_carbs_g: 10, dose_u: 2 });
  });

  it("does not read Trio's eventualBG any more: it runs far too low", () => {
    // eventualBG 40 would have covered (100 − 40) / 5 = 12 g in v2; the curve itself stays at 104 (calibrated 107).
    expect(adjust(30, { prediction: trio({ eventual_bg: 40, curves: { IOB: [110, 108, 106, 104] } }) })).toBeNull();
  });

  it('holds the lowest point within 60 min against the safety limit 80, as Loop does, not against the target', () => {
    const dip = trio({ curves: { IOB: [110, 95, 80, 70, 62, 60, 64, 70, 80, 90, 95] }, eventual_bg: 95 });
    const result = adjust(30, { prediction: dip });
    expect(result).toMatchObject({ basis: 'TRIO_EARLY_LOW', forecast_low_mgdl: 60, target_mgdl: 80, covered_carbs_g: 4, dose_u: 2.6 });
    expect(result?.summary).toMatch(/^Trio prognozuje spadek do 60 mg\/dL w ciągu godziny, więc 4 g/);
    // A shallow early dip (85) with the eventual glucose at target changes nothing.
    expect(adjust(30, { prediction: trio({ curves: { IOB: [110, 100, 90, 85, 88, 95, 100] }, eventual_bg: 100 }) })).toBeNull();
    // A dip after 60 min counts only through the calibrated +90 min forecast: 110 + ½ × (60 − 110) = 85 → 3 g.
    const late = Array.from({ length: 16 }, (_, index) => (index <= 12 ? 110 : 60));
    expect(adjust(30, { prediction: trio({ curves: { IOB: late }, eventual_bg: 110 }) })).toMatchObject({ basis: 'CALIBRATED_EVENTUAL', forecast_low_mgdl: 85, covered_carbs_g: 3 });
  });

  it('leaves the carbs alone (0 U) when the drop takes the whole meal, without a timing hint', () => {
    // Without calibration (w = 1) the curve's 45 at 90 min: (100 − 45) / 5 = 11 g, more than the 10 g snack.
    const result = adjust(10, { prediction: trio({ curves: { IOB: [110, 100, 90, 80, 70, 60, 55, 50, 47, 45] } }), calibration: UNCALIBRATED });
    expect(result).toMatchObject({ covered_carbs_g: 11, dose_u: 0, reduced_by_u: 1 });
    expect(result?.summary).toMatch(/cały posiłek pokryje spadek: bez insuliny teraz, bolus po sprawdzeniu glukozy\.$/);
  });

  it('reads the COB curve while carbs absorb', () => {
    // The IOB curve alone would dip to 60; with the carbs absorbing it stays at 90.
    expect(adjust(30, { prediction: trio({ cob_g: 15, eventual_bg: 95, curves: { IOB: [110, 90, 70, 60], COB: [110, 105, 100, 95, 90, 92] } }) })).toBeNull();
  });

  it("uses Trio's carbsReq when it asks for more", () => {
    expect(adjust(30, { prediction: trio({ carbs_req_g: 12 }) })).toMatchObject({ basis: 'TRIO_CARBS_REQ', covered_carbs_g: 12, dose_u: 1.8 });
  });

  it("takes Trio's current target (temp targets too), then the profile's, within 80–180", () => {
    expect(adjust(30, { prediction: trio({ target_mgdl: 110 }) })).toMatchObject({ target_mgdl: 110, covered_carbs_g: 6 });
    expect(adjust(30, { prediction: trio({ target_mgdl: 140 }) })).toMatchObject({ target_mgdl: 140, covered_carbs_g: 12 });
    expect(adjust(30, { profile_target: 110 })).toMatchObject({ target_mgdl: 110 });
    expect(adjust(30, { profile_target: 200 })).toMatchObject({ target_mgdl: 100 });
  });

  it('counts glucose below the safety limit now', () => {
    const result = adjust(30, { readings: readings(66, 67, 68, 70), prediction: trio({ bg: 70, curves: { IOB: [70, 72, 76, 82, 90, 100, 110, 120, 130] }, eventual_bg: 120 }) });
    expect(result).toMatchObject({ basis: 'TRIO_EARLY_LOW', forecast_low_mgdl: 70, covered_carbs_g: 2, dose_u: 2.8 });
    expect(result?.summary).toMatch(/^Glukoza 70 mg\/dL, więc 2 g/);
  });

  it("without a fresh forecast from Trio projects the CGM trend 30 min while it falls, against the target", () => {
    // 2 mg/dL per minute down: 110 − 60 = 50, (100 − 50) / CSF 5 = 10 g.
    const stale = trio({ computed_at: at(25) });
    expect(adjust(30, { readings: readings(140, 130, 120, 110), prediction: stale })).toMatchObject({ basis: 'CGM_TREND', forecast_low_mgdl: 50, covered_carbs_g: 10, dose_u: 2 });
    expect(adjust(30, { readings: readings(100, 104, 102, 110), prediction: null })).toBeNull();
  });

  it('asks for the bolus at the end of the meal when glucose falls fast (↓↓) at or below 150', () => {
    const result = adjust(30, { readings: readings(170, 155, 140, 125), prediction: null });
    expect(result).toMatchObject({ give_at_meal_end: true, forecast_low_mgdl: 39, covered_carbs_g: 12, dose_u: 1.8 });
    expect(result?.summary).toMatch(/Glukoza szybko spada: podaj bolus na koniec posiłku albo po kontroli za 15–20 min\.$/);
  });

  it('changes nothing without a recent reading, an ISF, or an ICR', () => {
    expect(adjust(30, { readings: readings(122, 118, 114, 110).map((reading) => ({ ...reading, at: new Date(Date.parse(reading.at) - 20 * 60_000).toISOString() })) })).toBeNull();
    expect(adjust(30, { prediction: null, readings: readings(140, 130, 120, 110), profile_isf: null })).toBeNull();
    expect(computeMealDoseAdjustment({ now, carbs_g: 30, dose_u: 3, icr_g_per_u: null, step: 0.05, data: data() })).toBeNull();
  });

  it('reads mmol/L profiles', () => {
    expect(adjust(30, { prediction: trio({ computed_at: at(25) }), readings: readings(140, 130, 120, 110), profile_isf: 2.8, profile_target: 5.5, profile_units: 'mmol' }))
      .toMatchObject({ target_mgdl: 99, isf_mgdl_per_u: 50, covered_carbs_g: 10 });
  });

  it("converts the loop's mmol/L ISF like the profile's (oref prints it in the user's units)", () => {
    const mgdl = adjust(30, { prediction: trio({ computed_at: at(25) }), readings: readings(140, 130, 120, 110) });
    const mmol = adjust(30, { prediction: trio({ computed_at: at(25), isf_mgdl_per_u: 2.8 }), readings: readings(140, 130, 120, 110), profile_isf: 2.8, profile_target: 5.5, profile_units: 'mmol' });
    expect(mmol).toMatchObject({ isf_mgdl_per_u: 50 });
    expect(mmol?.covered_carbs_g).toBe(mgdl?.covered_carbs_g);
  });

  it('builds its data from the synced readings, the loop status and the profile', () => {
    const built = mealForecastDataFrom({
      now,
      readings: [{ at: at(60), value: 150 }, ...readings(122, 118)],
      loopStatus: { observed_at: at(1), raw_payload: { openaps: { suggested: { bg: 118, ISF: 45, CR: 9, eventualBG: 85, current_target: 110, deliverAt: at(1), predBGs: { IOB: [118, 110, 100] } } } } },
      therapy: { units: 'mg/dl', timezone: 'Europe/Warsaw', sensitivity_per_u: [['00:00', 50]], target_low: [['00:00', 100], ['22:00', 120]] },
      lastCarbsAt: at(5),
    });
    expect(built.readings).toHaveLength(2);
    expect(built.prediction).toMatchObject({ isf_mgdl_per_u: 45, eventual_bg: 85, target_mgdl: 110, curves: { IOB: [118, 110, 100] } });
    expect(built).toMatchObject({ profile_isf: 50, profile_target: 100, profile_units: 'mg/dl', last_carbs_at: at(5) });
  });
});

describe('fast carbs before a meal when a low is near', () => {
  it("points out a confirmed predicted low (rescue-carbs.v2): Trio's carbsReq with the forecast crossing 70 within 30 min", () => {
    // Trio asks for 8 g; the dose is rescue-dose.v3's (90 − 60) / CSF 5 = 6 g.
    // Uncalibrated (w = 1) the curve crosses 70 at 25 min (24 min from now): confirmed, so the card says fast carbs first.
    const steep = trio({ carbs_req_g: 8, curves: { IOB: [110, 100, 90, 80, 72, 66, 60, 56] } });
    expect(computeFastCarbsFirst({ now, icr_g_per_u: 10, data: data({ prediction: steep, calibration: UNCALIBRATED }) })).toEqual({
      carbs_g: 6,
      level: 'PREDICTED_LOW',
      glucose_mgdl: 110,
      minutes_to_low: 24,
      message: 'Glukoza 110 mg/dL spadnie poniżej 70 za ok. 24 min: polecam najpierw 6 g szybkich węglowodanów (sok, glukoza), bo posiłek podnosi glukozę za wolno.',
    });
  });

  it("does not take Trio's carbsReq alone (an unconfirmed flag, ~5 false alarms a day in the backtest)", () => {
    expect(computeFastCarbsFirst({ now, icr_g_per_u: 10, data: data({ prediction: trio({ carbs_req_g: 8 }) }) })).toBeNull();
  });

  it('gives no grams when the profile has no ISF/ICR (no token dose)', () => {
    const result = computeFastCarbsFirst({ now, icr_g_per_u: null, data: data({ readings: readings(75, 70, 66, 64), prediction: null, profile_isf: null }) });
    expect(result).toMatchObject({ level: 'LOW_NOW', carbs_g: null });
    expect(result!.message).toMatch(/polecam najpierw szybkie węglowodany/);
  });

  it('points out a low now', () => {
    const result = computeFastCarbsFirst({ now, icr_g_per_u: 10, data: data({ readings: readings(75, 70, 66, 64), prediction: null }) });
    expect(result).toMatchObject({ level: 'LOW_NOW', glucose_mgdl: 64 });
    expect(result!.carbs_g).toBeGreaterThan(0);
    expect(result!.message).toMatch(/^Glukoza 64 mg\/dL: polecam najpierw \d+ g szybkich węglowodanów/);
  });

  it('says nothing without a low coming, or with carbs eaten in the last 15 min', () => {
    expect(computeFastCarbsFirst({ now, icr_g_per_u: 10, data: data() })).toBeNull();
    const steep = trio({ carbs_req_g: 8, curves: { IOB: [110, 100, 90, 80, 72, 66, 60, 56] } });
    expect(computeFastCarbsFirst({ now, icr_g_per_u: 10, data: data({ prediction: steep, calibration: UNCALIBRATED, last_carbs_at: at(5) }) })).toBeNull();
  });
});
