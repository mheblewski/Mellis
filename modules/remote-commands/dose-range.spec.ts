import { describe, expect, it } from 'vitest';
import { GLUCOSE_FORECAST_CALIBRATION } from '@modules/glucose-forecast/application/forecast-calibration';
import { RemoteCommandsService } from './application/remote-commands.service';
import type { NewRemoteCommand, RemoteCommandRecord, RemoteCommandStore } from './application/remote-command-record';
import type { RemoteCommandContext } from './application/remote-command-policy';
import {
  computeDoseCalculation,
  doseExceedsFormula,
  doseProposals,
  doseRangeWarning,
  doseSafetyWarnings,
  DOSE_RANGE_POLICY,
  type DoseCalculation,
  type RecentInsulin,
} from './application/dose-calculator';
import type { MealForecastData } from './application/meal-dose-forecast';

/**
 * dose-range.v1 (Mellis 1.0.10, owner 2026-10-31): on the Bolus tab's own form, the calculator's dose and carbs / ICR
 * (and the opt-in higher dose) are all normal choices. Inside or below their range: no dose-size warning. Above: one at
 * most — the backstop (≥ highest + max(1 j, 50 %)) always, else the dashed line below 100, else (no line) the plain
 * max(0,5 j, 25 %) rule.
 */
const now = new Date('2026-10-31T12:00:00.000Z');
const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const round2 = (value: number) => Math.round(value * 100) / 100;
const noCalibration = { ...GLUCOSE_FORECAST_CALIBRATION, version: 'test-none', shrink_by_minutes: { 5: 1 } };
const doseCodes = new Set(['DOSE_ABOVE_PROPOSALS', 'DOSE_LINE_LOW', 'DOSE_ABOVE_CALCULATOR', 'DOSE_DIFFERS_FROM_ICR']);

function mealData(options: { glucose: number; per5?: number; iob: number; isf?: number; target?: number; cob?: number }): MealForecastData {
  const per5 = options.per5 ?? 0;
  return {
    readings: [3, 2, 1, 0].map((back) => ({ at: at(1 + back * 5), value: options.glucose - per5 * back })),
    prediction: {
      source: 'OPENAPS', system: 'TRIO', computed_at: at(1), bg: options.glucose, carbs_req_g: null, iob_u: options.iob, cob_g: options.cob ?? 0,
      isf_mgdl_per_u: options.isf ?? 100, icr_g_per_u: null, eventual_bg: options.glucose, target_mgdl: options.target ?? 100,
      curves: {},
    },
    profile_isf: options.isf ?? 100,
    profile_target: options.target ?? 100,
    profile_units: 'mg/dl',
    calibration: noCalibration,
  };
}

describe('dose-range.v1: the form\'s range of proposals', () => {
  // A reported case (fictional profile): 10 g, ICR 7 → 1,4 j; the calculator 10 / 7 + (211 + 11 − 113) / 100 − IOB 1,5 → 1 j.
  const reported = computeDoseCalculation({ now, carbs_g: 10, icr_g_per_u: 7, step: 0.05, data: mealData({ glucose: 211, per5: 11 / 3, iob: 1.5, target: 113 }), forecast_nudge: false });
  const recent: RecentInsulin = { window_minutes: 120, total_u: 1.3, manual_u: 0, smb_u: 1.3, remote_u: 0, newest_at: at(20) };

  it('names the calculator and carbs / ICR as the range', () => {
    expect(reported).toMatchObject({ icr_dose_u: 1.4, default_u: 1, limited_by: 'CALCULATOR' });
    expect(doseProposals(reported)).toMatchObject({ low_u: 1, high_u: 1.4 });
  });

  it("the reported case: 1,9 j with the dashed line at ~140 → no warning; the line below 100 → one; the backstop → one", () => {
    expect(doseRangeWarning(1.9, reported, recent, 140)).toBeNull();
    expect(doseRangeWarning(1.4, reported, recent, 160)).toBeNull();
    expect(doseRangeWarning(1, reported, recent, 170)).toBeNull();
    expect(doseRangeWarning(1.2, reported, recent, 40)).toBeNull();
    const low = doseRangeWarning(1.9, reported, recent, 85)!;
    expect(low).toMatchObject({ code: 'DOSE_LINE_LOW', severity: 'WARNING', key: 'DOSE_LINE_LOW:1.9:1.4:BELOW_100' });
    expect(low.message).toBe('Po tej dawce ok. 85 mg/dL: z tą dawką prognoza schodzi do ok. 85 mg/dL (linia przerywana; zakłada, że pętla nic więcej nie zmieni). 1,9 j to 0,5 j więcej niż wyższa z propozycji (przelicznik 1,4 j; kalkulator 1 j). W ostatnich 120 min podano 1,3 j (SMB). Rozważ mniejszą dawkę.');
    expect(doseRangeWarning(1.9, reported, recent, 62)).toMatchObject({ code: 'DOSE_LINE_LOW', severity: 'DANGER', key: 'DOSE_LINE_LOW:1.9:1.4:BELOW_70' });
    // 1,4 + max(1, 0,7) = 2,4 j: the backstop, even with the line fine; its value is in the text.
    const backstop = doseRangeWarning(2.6, reported, recent, 130)!;
    expect(backstop).toMatchObject({ code: 'DOSE_ABOVE_PROPOSALS', severity: 'DANGER', key: 'DOSE_ABOVE_PROPOSALS:2.6:1.4' });
    expect(backstop.message).toBe('2,6 j to 1,2 j więcej niż wyższa z propozycji (przelicznik 1,4 j; kalkulator 1 j). Z tą dawką prognoza schodzi do ok. 130 mg/dL (linia przerywana; zakłada, że pętla nic więcej nie zmieni). W ostatnich 120 min podano 1,3 j (SMB). Większa dawka grozi niedocukrzeniem.');
    // Backstop and a low line: the backstop alone, the line in its text.
    expect(doseRangeWarning(2.6, reported, recent, 55)).toMatchObject({ code: 'DOSE_ABOVE_PROPOSALS', severity: 'DANGER' });
    // No dashed line: the plain rule, 1,4 + max(0,5, 0,35) = 1,9 j.
    expect(doseRangeWarning(1.85, reported, recent, null)).toBeNull();
    expect(doseRangeWarning(1.9, reported, recent, null)).toMatchObject({ code: 'DOSE_ABOVE_PROPOSALS', severity: 'DANGER', message: '1,9 j to 0,5 j więcej niż wyższa z propozycji (przelicznik 1,4 j; kalkulator 1 j). W ostatnich 120 min podano 1,3 j (SMB). Większa dawka grozi niedocukrzeniem.' });
  });

  it("the form's dose checks give no RECENT_INSULIN for a dose the calculator counted (said in the one warning instead)", () => {
    const form = (insulin: number, line: number | null) => doseSafetyWarnings({ insulin_u: insulin, calculation: reported, recent, dose_range: { line_min_mgdl: line } }).map((warning) => warning.code);
    expect(form(1.9, 140)).toEqual([]);
    expect(form(1.4, null)).toEqual([]);
    expect(form(2.6, 140)).toEqual(['DOSE_ABOVE_PROPOSALS']);
    // Not the form (a card): the calculator check as before.
    expect(doseSafetyWarnings({ insulin_u: 1.9, calculation: reported, recent }).map((warning) => warning.code)).toEqual(['DOSE_ABOVE_CALCULATOR']);
  });

  it('property: none inside or below the range; above it exactly one when the line is below 100 or the backstop holds, else none', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    let inside = 0;
    let aboveQuiet = 0;
    let aboveLine = 0;
    let backstops = 0;
    let plain = 0;
    for (let index = 0; index < 3000; index += 1) {
      const carbs = random() < 0.15 ? 0 : Math.round(5 + random() * 85);
      const icr = Math.round((5 + random() * 15) * 10) / 10;
      const data = mealData({ glucose: Math.round(75 + random() * 250), per5: Math.round(-4 + random() * 8), iob: Math.round(random() * 4 * 100) / 100, isf: Math.round(40 + random() * 160), cob: Math.round(random() * 40) });
      const base = computeDoseCalculation({ now, carbs_g: carbs, icr_g_per_u: icr, step: 0.05, data, forecast_nudge: false });
      // The opt-in higher dose, when offered, is a proposal too.
      const calculation: DoseCalculation = random() < 0.3 ? { ...base, higher_u: round2((base.icr_dose_u ?? base.default_u) + 0.05 * Math.ceil(random() * 20)) } : base;
      const range = doseProposals(calculation);
      if (!range) continue;
      const proposals = range.proposals.map((proposal) => proposal.units);
      expect(range.low_u).toBe(round2(Math.min(...proposals)));
      expect(range.high_u).toBe(round2(Math.max(...proposals)));
      const insulin = Math.round(random() * (range.high_u * 2.5 + 3) * 20) / 20;
      if (!(insulin > 0)) continue;
      const line = random() < 0.25 ? null : Math.round(40 + random() * 160);
      const warning = doseRangeWarning(insulin, calculation, null, line);
      const all = doseSafetyWarnings({ insulin_u: insulin, calculation, recent: null, dose_range: { line_min_mgdl: line } });
      expect(all.filter((entry) => doseCodes.has(entry.code)).length, `#${index}`).toBeLessThanOrEqual(1);
      if (insulin <= range.high_u + 1e-9) {
        // Inside (or below) the range: never, whatever the line.
        expect(warning, `#${index} ${insulin} in ${range.low_u}..${range.high_u}`).toBeNull();
        inside += 1;
        continue;
      }
      const extra = insulin - range.high_u;
      const backstop = extra >= Math.max(DOSE_RANGE_POLICY.backstop_min_u, DOSE_RANGE_POLICY.backstop_ratio * range.high_u) - 1e-6;
      if (backstop) {
        expect(warning, `#${index}`).toMatchObject({ code: 'DOSE_ABOVE_PROPOSALS', severity: 'DANGER' });
        if (line !== null) expect(warning!.message).toContain(`ok. ${line} mg/dL`);
        backstops += 1;
      } else if (line === null) {
        if (doseExceedsFormula(insulin, range.high_u)) {
          expect(warning, `#${index}`).toMatchObject({ code: 'DOSE_ABOVE_PROPOSALS' });
          expect(warning!.severity).toBe(calculation.calculated || calculation.drop ? 'DANGER' : 'WARNING');
        } else {
          expect(warning, `#${index}`).toBeNull();
        }
        plain += 1;
      } else if (line < DOSE_RANGE_POLICY.line_floor_mgdl) {
        expect(warning, `#${index}`).toMatchObject({ code: 'DOSE_LINE_LOW', severity: line < 70 ? 'DANGER' : 'WARNING' });
        expect(warning!.message.startsWith(`Po tej dawce ok. ${line} mg/dL`)).toBe(true);
        aboveLine += 1;
      } else {
        expect(warning, `#${index}`).toBeNull();
        aboveQuiet += 1;
      }
    }
    for (const count of [inside, aboveQuiet, aboveLine, backstops, plain]) expect(count).toBeGreaterThan(50);
  });

  it('carbs first or nothing to name: no range (INSULIN_WHILE_LOW says it)', () => {
    const low = computeDoseCalculation({ now, carbs_g: 20, icr_g_per_u: 10, step: 0.05, data: mealData({ glucose: 62, iob: 0 }) });
    expect(doseProposals(low)).toBeNull();
    expect(doseRangeWarning(3, low, null, 50)).toBeNull();
    expect(doseProposals(null)).toBeNull();
  });
});

class Store implements RemoteCommandStore {
  rows: RemoteCommandRecord[] = [];
  async insert(command: NewRemoteCommand): Promise<RemoteCommandRecord> {
    const record = { ...command, id: `00000000-0000-4000-8000-${String(this.rows.length + 1).padStart(12, '0')}`, status: 'AUTHORIZED', trio_message: null, status_message: null, authorized_at: now.toISOString(), sent_at: null, answered_at: null, loop_action_id: null, meal_record_id: null, matched_at: null } as RemoteCommandRecord;
    this.rows.push(record);
    return record;
  }
  async get() { return null; }
  async list() { return []; }
  async findInFlight() { return null; }
  async recordSentAt() {}
  async listForProposal() { return []; }
  async listForPlannedBolus() { return []; }
  async listWbtForMeal() { return []; }
  async findRecentWithInsulin() { return null; }
  async transition() { return null; }
}

describe('dose-range.v1 in the remote-command service (preview and authorization)', () => {
  /** The reported case's numbers, the chart's line flat at `chart` mg/dL (the CGM trend without a loop curve). */
  const service = (chart: number) => {
    const context: Omit<RemoteCommandContext, 'in_flight_command_id' | 'recent_remote_bolus'> = {
      now: now.toISOString(),
      glucose: { value: 211, observed_at: at(1), delta: 4 },
      lowest_recent_glucose: 200,
      loop: { iob_units: 1.5, cob_grams: 0, observed_at: at(1) },
      last_bolus: null,
      icr_g_per_u: 7,
      bolus_history_known: true,
      recent_insulin: { window_minutes: 120, total_u: 1.3, manual_u: 0, smb_u: 1.3, remote_u: 0, newest_at: at(20), boluses: [], smbs: [{ at: at(20), units: 1.3 }] },
      recent_remote_boluses: [],
    };
    const forecastInputs = { readings: [{ at: at(6), value: chart }, { at: at(1), value: chart }], prediction: null, profile_isf: 100, profile_units: 'mg/dL', dia_hours: 6 };
    return new RemoteCommandsService(new Store(), async () => ({ ...context, meal_forecast: mealData({ glucose: 211, per5: 11 / 3, iob: 1.5, target: 113 }), forecast_inputs: forecastInputs }));
  };
  const request = (insulin: number, acknowledged: string[] = []) => ({ source: 'BOLUS_SCREEN' as const, carbs_g: 10, insulin_u: insulin, bolus_step: 0.05, device_id: 'd', acknowledged_warnings: acknowledged });

  it("the reported case: 1,9 j typed, dashed line ~150 → no dose warning at all (no DOSE_DIFFERS_FROM_ICR either)", async () => {
    const preview = await service(200).preview('p1', { carbs_g: 10, insulin_u: 1.9, bolus_step: 0.05 }, now);
    expect(preview.icr_insulin_u).toBe(1.4);
    expect(preview.forecast?.with_excess_min).toBeGreaterThanOrEqual(100);
    expect(preview.warnings).toEqual([]);
    await expect(service(200).authorize('p1', 'u1', request(1.9), now)).resolves.toMatchObject({ insulin_u: 1.9 });
    // Either proposal by the switch or typed: nothing.
    for (const insulin of [1, 1.2, 1.4]) expect((await service(200).preview('p1', { carbs_g: 10, insulin_u: insulin, bolus_step: 0.05 }, now)).warnings).toEqual([]);
  });

  it('the line below 100 → one warning with the chart\'s value; the backstop → one DANGER, acknowledged at authorization', async () => {
    const low = await service(130).preview('p1', { carbs_g: 10, insulin_u: 1.9, bolus_step: 0.05 }, now);
    expect(low.warnings.map((warning) => [warning.code, warning.severity])).toEqual([['DOSE_LINE_LOW', 'WARNING']]);
    expect(low.warnings[0].message).toContain(`Po tej dawce ok. ${low.forecast!.with_excess_min} mg/dL`);
    await expect(service(130).authorize('p1', 'u1', request(1.9), now)).rejects.toThrow(/REMOTE_COMMAND_WARNINGS_CHANGED: Po tej dawce/);
    await expect(service(130).authorize('p1', 'u1', request(1.9, [low.warnings[0].key]), now)).resolves.toMatchObject({ insulin_u: 1.9 });
    const backstop = await service(250).preview('p1', { carbs_g: 10, insulin_u: 2.6, bolus_step: 0.05 }, now);
    expect(backstop.warnings.map((warning) => [warning.code, warning.severity, warning.key])).toEqual([['DOSE_ABOVE_PROPOSALS', 'DANGER', 'DOSE_ABOVE_PROPOSALS:2.6:1.4']]);
    expect(backstop.warnings[0].message).toContain('2,6 j to 1,2 j więcej niż wyższa z propozycji (przelicznik 1,4 j; kalkulator 1 j).');
    await expect(service(250).authorize('p1', 'u1', request(2.6, ['DOSE_ABOVE_PROPOSALS:2.6:1.4']), now)).resolves.toMatchObject({ insulin_u: 2.6 });
  });
});
