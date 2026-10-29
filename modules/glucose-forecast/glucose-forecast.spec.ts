import { describe, expect, it } from 'vitest';
import { cleanReadings, deltaPerFiveMinutes, lastTwoFalling, shortAverageSlope } from './application/cgm-trend';
import {
  bestCurve,
  buildGlucoseForecast,
  cgmProjection,
  cgmTrendCurve,
  firstCrossing,
  loopCurve,
  lowestWithin,
  mainLoopCurve,
  minutesUntil,
} from './application/glucose-forecast';
import { parseLoopPrediction, type LoopPrediction } from '@modules/loop-system/application/loop-prediction';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const minutes = (value: number) => new Date(NOW.getTime() + value * 60_000).toISOString();

/** CGM every 5 min ending at `endAt` minutes from NOW, values oldest first. */
function cgm(values: number[], endAt = -1) {
  return values.map((value, index) => ({ at: minutes(endAt - (values.length - 1 - index) * 5), value }));
}

function trio(suggested: Record<string, unknown> = {}, at = minutes(-1)): LoopPrediction {
  return parseLoopPrediction({
    observed_at: at,
    raw_payload: {
      openaps: {
        suggested: {
          bg: 120,
          deliverAt: at,
          IOB: 1.5,
          COB: 0,
          ISF: 100,
          CR: 10,
          eventualBG: 95,
          current_target: 110,
          insulinReq: 0.2,
          predBGs: { IOB: [120, 116, 112, 108, 104, 100, 97], ZT: [120, 118, 116, 114, 112, 110, 109] },
          ...suggested,
        },
      },
    },
  })!;
}

describe('loop prediction parsing (glucose-forecast.v1)', () => {
  it("reads oref's eventual glucose, target, carbsReq and insulinReq", () => {
    const prediction = trio({ carbsReq: 6 });
    expect(prediction).toMatchObject({ source: 'OPENAPS', eventual_bg: 95, target_mgdl: 110, carbs_req_g: 6, insulin_req_u: 0.2, computed_at: minutes(-1) });
  });

  it('uses the enacted calculation only when the suggestion has no curves', () => {
    const status = { observed_at: minutes(-1), raw_payload: { openaps: { suggested: { bg: 100 }, enacted: { bg: 101, deliverAt: minutes(-2), predBGs: { IOB: [101, 99] } } } } };
    expect(parseLoopPrediction(status)).toMatchObject({ bg: 101, computed_at: minutes(-2), curves: { IOB: [101, 99] } });
  });
});

describe('CGM trend helpers', () => {
  it('drops sensor errors and future readings; keeps the first reading per timestamp unless asked to keep duplicates', () => {
    const readings = [{ at: minutes(-5), value: 100 }, { at: minutes(-5), value: 104 }, { at: minutes(-10), value: 38 }, { at: minutes(2), value: 99 }, { at: minutes(0), value: 98 }];
    expect(cleanReadings(readings, NOW).map((reading) => reading.value)).toEqual([100, 98]);
    expect(cleanReadings(readings, NOW, { keep_duplicates: true }).map((reading) => reading.value)).toEqual([100, 104, 98]);
  });

  it("measures oref's delta and short average slope, and whether the last two changes fall", () => {
    const readings = cgm([130, 124, 118, 112]);
    expect(deltaPerFiveMinutes(readings)).toBe(-6);
    expect(shortAverageSlope(readings)).toBeCloseTo(-1.2);
    expect(lastTwoFalling(readings)).toBe(true);
    expect(lastTwoFalling(cgm([130, 124, 126]))).toBe(false);
    expect(lastTwoFalling(cgm([130, 124]))).toBe(false);
  });
});

describe('buildGlucoseForecast', () => {
  it("uses Trio's forecast when it is fresh and belongs to the newest reading", () => {
    const forecast = buildGlucoseForecast({ now: NOW, readings: cgm([132, 128, 124, 120]), prediction: trio() });
    expect(forecast).toMatchObject({
      reading_fresh: true,
      reading_age_minutes: 1,
      loop_state: 'FRESH',
      loop_age_minutes: 1,
      source: 'OPENAPS',
      main_curve: 'IOB',
      eventual_mgdl: 95,
      target_mgdl: 110,
      insulin_req_u: 0.2,
    });
  });

  it('reads the COB curve while carbs absorb', () => {
    const forecast = buildGlucoseForecast({ now: NOW, readings: cgm([110, 115, 120]), prediction: trio({ COB: 20, predBGs: { IOB: [120, 118], COB: [120, 126, 133] } }) });
    expect(forecast.main_curve).toBe('COB');
    expect(mainLoopCurve(forecast).map((point) => point.value)).toEqual([120, 126, 133]);
  });

  it('falls back to the CGM trend for a stale forecast or one computed for another reading', () => {
    const stale = buildGlucoseForecast({ now: NOW, readings: cgm([132, 128, 124, 120]), prediction: trio({}, minutes(-16)) });
    expect(stale).toMatchObject({ loop: null, loop_state: 'STALE', source: 'CGM_TREND', eventual_mgdl: null });
    const otherReading = buildGlucoseForecast({ now: NOW, readings: cgm([132, 128, 124, 120], -1), prediction: trio({}, minutes(-9)) });
    expect(otherReading.loop_state).toBe('NOT_FOR_READING');
    const none = buildGlucoseForecast({ now: NOW, readings: cgm([120]), prediction: null });
    expect(none).toMatchObject({ loop_state: 'NONE', source: 'NONE', slope_per_min: null });
  });

  it('marks a reading older than 15 minutes as not fresh', () => {
    const forecast = buildGlucoseForecast({ now: NOW, readings: cgm([120, 118, 116], -16), prediction: null });
    expect(forecast.reading_fresh).toBe(false);
  });

  it("uses the main curve's last value as the eventual glucose when oref sends none", () => {
    const forecast = buildGlucoseForecast({ now: NOW, readings: cgm([124, 122, 120]), prediction: trio({ eventualBG: undefined }) });
    expect(forecast.eventual_mgdl).toBe(97);
  });
});

describe('curve helpers', () => {
  const forecast = buildGlucoseForecast({ now: NOW, readings: cgm([132, 128, 124, 120]), prediction: trio() });

  it('times loop curves from the calculation and cuts them at the horizon', () => {
    const zt = loopCurve(forecast, 'ZT', 10);
    expect(zt).toEqual([{ at: minutes(-1), value: 120 }, { at: minutes(4), value: 118 }, { at: minutes(9), value: 116 }]);
    expect(loopCurve(forecast, 'UAM')).toEqual([]);
  });

  it('finds the lowest point within a horizon, and the first crossing after now', () => {
    const iob = mainLoopCurve(forecast);
    expect(lowestWithin(iob, 15)).toEqual({ at: minutes(14), value: 108 });
    const crossing = firstCrossing(iob, 105, 'BELOW');
    expect(crossing).toEqual({ at: minutes(19), value: 104 });
    expect(minutesUntil(crossing, NOW)).toBe(19);
    expect(firstCrossing(iob, 120, 'ABOVE')).toBeNull();
  });

  it('projects the CGM trend with a floor of 39 mg/dL', () => {
    const falling = buildGlucoseForecast({ now: NOW, readings: cgm([100, 85, 70, 55]), prediction: null });
    expect(cgmProjection(falling, 20)).toBe(39);
    expect(cgmTrendCurve(falling, 10).map((point) => point.value)).toEqual([55, 40, 39]);
    expect(bestCurve(falling, 10).name).toBe('CGM');
    expect(bestCurve(forecast, 10).name).toBe('IOB');
  });
});
