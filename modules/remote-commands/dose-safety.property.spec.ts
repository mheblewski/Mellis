import { describe, expect, it } from 'vitest';
import { GLUCOSE_FORECAST_CALIBRATION } from '@modules/glucose-forecast/application/forecast-calibration';
import { RemoteCommandsService } from './application/remote-commands.service';
import type { NewRemoteCommand, RemoteCommandRecord, RemoteCommandStore } from './application/remote-command-record';
import { evaluateRemoteCommand, type RemoteCommandContext } from './application/remote-command-policy';
import { computeDoseCalculation, doseExceedsFormula } from './application/dose-calculator';
import type { MealForecastData } from './application/meal-dose-forecast';

/**
 * dose-calculator.v1 review (2026-10-29): authorization only ever adds requirements. Over random patients and doses:
 * - what the preview shows is exactly what authorization requires (acked, plus the separate low confirmation);
 * - every warning the server required before this branch (evaluateRemoteCommand without the calculator) is still
 *   required, except "differs from ICR" for a dose the calculator itself lowered (less insulin);
 * - a dose dangerously above the reference, or any insulin below 70, never goes through without its own warning;
 * - builds without card_warnings_shown are held to the same live warnings.
 */
class Store implements RemoteCommandStore {
  rows: RemoteCommandRecord[] = [];
  async insert(command: NewRemoteCommand): Promise<RemoteCommandRecord> {
    const record = { ...command, id: `00000000-0000-4000-8000-${String(this.rows.length + 1).padStart(12, '0')}`, status: 'AUTHORIZED', trio_message: null, status_message: null, authorized_at: new Date(Date.parse(command.send_deadline) - 120_000).toISOString(), sent_at: null, answered_at: null, loop_action_id: null, meal_record_id: null, matched_at: null } as RemoteCommandRecord;
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

const now = new Date('2026-10-29T12:00:00.000Z');
const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

describe('dose safety property: authorization only adds requirements (review 2026-10-29)', () => {
  it('holds over 400 random patients and doses', async () => {
    let seed = 11;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const proposalId = '22222222-2222-4222-8222-222222222222';
    let checked = 0;
    for (let index = 0; index < 400; index += 1) {
      const glucose = Math.round(50 + random() * 250);
      const per5 = Math.round(-12 + random() * 24);
      const iob = Math.round(random() * 5 * 100) / 100;
      const cob = Math.round(random() * 120);
      const readingAge = random() < 0.15 ? 25 : 1;
      const forecast: MealForecastData = {
        readings: [3, 2, 1, 0].map((back) => ({ at: at(readingAge + back * 5), value: glucose - per5 * back })),
        prediction: {
          source: 'OPENAPS', system: 'TRIO', computed_at: at(random() < 0.1 ? 40 : 1), bg: glucose, carbs_req_g: null, iob_u: iob, cob_g: cob,
          isf_mgdl_per_u: Math.round(40 + random() * 160), icr_g_per_u: 10, eventual_bg: glucose, target_mgdl: random() < 0.2 ? 200 : 100,
          curves: { IOB: Array.from({ length: 7 }, () => Math.max(45, glucose)) },
        },
        profile_isf: 100,
        profile_target: 100,
        profile_target_high: 120,
        profile_units: 'mg/dl',
        calibration: { ...GLUCOSE_FORECAST_CALIBRATION, version: 'test-none', shrink_by_minutes: { 5: 1 } },
      };
      const icr = Math.round((5 + random() * 15) * 10) / 10;
      const context: Omit<RemoteCommandContext, 'in_flight_command_id' | 'recent_remote_bolus'> = {
        now: now.toISOString(),
        glucose: { value: glucose, observed_at: at(readingAge), delta: per5 },
        lowest_recent_glucose: glucose,
        loop: { iob_units: iob, cob_grams: cob, observed_at: at(1) },
        last_bolus: null,
        icr_g_per_u: icr,
        bolus_history_known: true,
      };
      const carbs = random() < 0.2 ? 0 : Math.round(random() * 90);
      const icrDose = carbs > 0 ? Math.floor(carbs / icr / 0.05 + 1e-9) * 0.05 : 0;
      const insulin = Math.round((random() < 0.3 ? icrDose * (1 + random()) : random() * 8) * 20) / 20;
      if (!(insulin > 0) && !(carbs > 0)) continue;
      const fromCard = random() < 0.3;
      const cardShown = fromCard && random() < 0.5;
      const proposals = { get: async () => ({ conversation_id: conversationId, status: 'PROPOSED', expires_at: at(-10), carbs_g: carbs, insulin_u: insulin, warnings: [{ code: 'DOSE_ABOVE_FORMULA' as const, key: `DOSE_ABOVE_FORMULA:MEAL:${insulin}:frozen`, severity: 'DANGER' as const, message: 'karta' }], purpose: 'MEAL' }) };
      const service = () => new RemoteCommandsService(new Store(), async () => ({ ...context, meal_forecast: forecast }), proposals as never);
      const preview = await service().preview('p1', { carbs_g: carbs, insulin_u: insulin, bolus_step: 0.05, proposal_id: fromCard ? proposalId : null, source: fromCard ? 'CHAT_CARD' : 'BOLUS_SCREEN' }, now);
      if (preview.blocks.length > 0) continue;
      checked += 1;
      const keys = preview.warnings.map((warning) => warning.key);
      const codes = preview.warnings.map((warning) => warning.code);
      const low = codes.includes('INSULIN_WHILE_LOW');
      const request = (acknowledged: string[], lowConfirmed: boolean) => ({
        source: fromCard ? 'CHAT_CARD' as const : 'BOLUS_SCREEN' as const,
        carbs_g: carbs, insulin_u: insulin, bolus_step: 0.05, device_id: 'd',
        conversation_id: fromCard ? conversationId : null, proposal_id: fromCard ? proposalId : null,
        card_warnings_shown: cardShown, acknowledged_warnings: acknowledged, low_glucose_confirmed: lowConfirmed,
      });
      // Exactly what the preview showed is what is required.
      const live = keys.filter((key) => cardShown || !key.startsWith('DOSE_ABOVE_FORMULA:'));
      await expect(service().authorize('p1', 'u1', request(live, true), now)).resolves.toMatchObject({ insulin_u: insulin });
      for (const key of live) {
        await expect(service().authorize('p1', 'u1', request(live.filter((other) => other !== key), true), now)).rejects.toThrow(/REMOTE_COMMAND_WARNINGS_CHANGED/);
      }
      if (low) await expect(service().authorize('p1', 'u1', request(live, false), now)).rejects.toThrow(/LOW_GLUCOSE_CONFIRMATION_REQUIRED/);

      // Every warning required before this branch is still required (except "differs from ICR" for a dose lowered by the calculator).
      const before = evaluateRemoteCommand({ carbs_g: carbs, insulin_u: insulin, bolus_step: 0.05, context: { ...context, in_flight_command_id: null, recent_remote_bolus: null } });
      for (const warning of before.warnings) {
        if (warning.code === 'DOSE_DIFFERS_FROM_ICR' && insulin < icrDose) continue;
        expect(keys, `#${index} lost ${warning.key}`).toContain(warning.key);
      }
      // A dose dangerously above the reference, or insulin below 70, never goes without its own warning.
      const calculation = computeDoseCalculation({ now, carbs_g: carbs, icr_g_per_u: icr, step: 0.05, data: forecast });
      if (insulin > 0 && glucose < 70) expect(codes, `#${index}`).toContain('INSULIN_WHILE_LOW');
      if (insulin > 0 && !low && doseExceedsFormula(insulin, calculation.reference_u)) expect(codes, `#${index}`).toContain('DOSE_ABOVE_CALCULATOR');
    }
    expect(checked).toBeGreaterThan(200);
  }, 60_000);
});
