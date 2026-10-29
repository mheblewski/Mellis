import { describe, expect, it } from 'vitest';
import { GLUCOSE_FORECAST_CALIBRATION } from '@modules/glucose-forecast/application/forecast-calibration';
import { ConflictError, ValidationError } from '@shared/errors/app-error';
import { BOLUS_PROPOSAL_INSTRUCTIONS, BolusProposalSession, toBolusProposalView, type NewBolusProposal } from './application/bolus-proposal-tool';
import type { RemoteCommandContext } from './application/remote-command-policy';
import type { NewRemoteCommand, RemoteCommandRecord, RemoteCommandStore } from './application/remote-command-record';
import { RemoteCommandsService } from './application/remote-commands.service';
import { matchRemoteCommand } from './application/remote-command-matching';
import { RemoteCommandReconciler } from './application/remote-command-reconciler';
import { PlannedBolusService, type PlannedBolusStore } from './application/planned-bolus.service';
import {
  computeLaterPlan,
  computeLaterPlans,
  planParts,
  estimatePlannedBolus,
  estimateSecondPart,
  loopInsulinAboveBasal,
  parseLaterRequest,
  plannedBolusExpiresAtMs, plannedBolusReadiness,
  plannedDoseCarbs,
  planTrigger,
  readSplitPlan,
  plannedBolusPushContent,
  plannedBolusCalculatorLine,
  cardMealCarbs,
  manualInsulinForPart,
  mealCarbsChangeUpdates,
  mealChangeLine,
  mealExcessLine,
  plannedMealCarbs,
  secondPartDose,
  toPlannedBolusSummary,
  type LaterRequest,
  type LaterTrigger,
  type PlannedBolusRecord,
  type SplitPlan,
} from './application/split-bolus';
import { scheduleValueAt } from '@modules/meal-wbt/application/wbt-policy';

const now = new Date('2026-10-20T12:00:00.000Z');
const context = (overrides: Partial<RemoteCommandContext> = {}): Omit<RemoteCommandContext, 'in_flight_command_id' | 'recent_remote_bolus'> => ({
  now: now.toISOString(),
  glucose: { value: 150, observed_at: '2026-10-20T11:57:00.000Z', delta: 2 },
  lowest_recent_glucose: 140,
  loop: { iob_units: 0.4, cob_grams: 0, observed_at: '2026-10-20T11:56:00.000Z' },
  last_bolus: null,
  icr_g_per_u: 10,
  bolus_history_known: true,
  ...overrides,
});

const pizza = {
  purpose: 'MEAL',
  carbs_g: 60,
  insulin_u: null,
  reduce_for_drop: false,
  add_correction: false,
  eating_now: false,
  later: null,
  meal_description: 'Pizza margherita, 2 kawałki',
  items: [{ name: 'Pizza margherita', grams: 250, carbs_g: 60, protein_g: 28, fat_g: 32, source: 'DIABCALC' }],
  reason: 'Pizza: dużo tłuszczu, część dawki później.',
};

function session(ctx = context()) {
  const stored: NewBolusProposal[] = [];
  const instance = new BolusProposalSession({
    patientId: 'p1',
    conversationId: 'c1',
    userMessageId: 'm1',
    doseRequested: true,
    now: () => now,
    context: async () => ctx,
    store: { insert: async (proposal) => { stored.push(proposal); return { ...proposal, id: 'b1', status: 'PROPOSED', created_at: now.toISOString() }; } },
  });
  return { instance, stored };
}

describe('later parts of a card (later-plan.v1)', () => {
  const later = (overrides: Record<string, unknown> = {}) => ({ trigger: 'AFTER_MINUTES', after_minutes: 90, threshold_mgdl: null, carbs_g: 24, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null, ...overrides });

  it('reads the later part the caregiver planned and refuses only what cannot be planned', () => {
    expect(parseLaterRequest(null)).toBeNull();
    expect(parseLaterRequest(later())).toEqual({ trigger: 'AFTER_MINUTES', after_minutes: 90, threshold_mgdl: null, carbs_g: 24, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null });
    // Glucose triggers: checked from 15 min, waited for 3 h unless said otherwise.
    expect(parseLaterRequest(later({ trigger: 'GLUCOSE_RISING', after_minutes: null, carbs_g: 0 }))).toMatchObject({ after_minutes: 0, wait_minutes: 60 });
    expect(parseLaterRequest(later({ trigger: 'GLUCOSE_STOPPED_FALLING', after_minutes: null, carbs_g: 0 }))).toMatchObject({ after_minutes: 15, wait_minutes: 180 });
    // The old split bounds (>= 60% now, 30-120 min) are advice now: 50/50 after 3 h is the caregiver's call.
    expect(computeLaterPlan({ card_carbs_g: 30, card_insulin_u: 3, request: parseLaterRequest(later({ carbs_g: 30, after_minutes: 180 })) as LaterRequest, icr_g_per_u: 10, drop_cover_g: null, step: 0.05 }))
      .toMatchObject({ plan: { kind: 'SPLIT', now_percent: 50, later_after_minutes: 180, later_carbs_g: 30, later_insulin_u: 3 } });
    expect(parseLaterRequest(later({ trigger: 'GLUCOSE_ABOVE', threshold_mgdl: null }))).toMatchObject({ problem: expect.stringContaining('threshold_mgdl') });
    expect(parseLaterRequest(later({ trigger: 'AFTER_MINUTES', after_minutes: null }))).toMatchObject({ problem: expect.stringContaining('AFTER_MINUTES') });
    expect(parseLaterRequest(later({ trigger: 'TOMORROW' }))).toMatchObject({ problem: expect.stringContaining('trigger') });
  });

  it("prepares a split card: the card gives the caregiver's part now, the plan keeps the rest (36 g 3,6 j now, 24 g ~2,4 j after 90 min)", async () => {
    const { instance, stored } = session();
    const result = await instance.propose({ ...pizza, carbs_g: 36, later: later() });
    expect(result).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 36, insulin_u: 3.6, later: [{ kind: 'SPLIT', carbs_g: 24, insulin_u_estimate: 2.4, after_minutes: 90 }] } });
    expect(stored[0]).toMatchObject({ carbs_g: 36, insulin_u: 3.6, split: { now_percent: 60, total_carbs_g: 60, total_insulin_u: 6, later_carbs_g: 24, later_insulin_u: 2.4 } });
    // The meal keeps its whole macros (WBT and the meal page use them).
    expect(stored[0].meal_payload?.macros).toEqual({ carbs_g: 60, protein_g: 28, fat_g: 32 });
  });

  it('keeps one bolus without a later part and refuses a later part for a correction', async () => {
    const { instance, stored } = session();
    expect(await instance.propose({ ...pizza, later: null })).toMatchObject({ status: 'PROPOSED', card: { carbs_g: 60, insulin_u: 6 } });
    expect(stored[0].split).toBeNull();
    expect(await session().instance.propose({ ...pizza, purpose: 'CORRECTION', carbs_g: 0, insulin_u: 1, later: later() })).toMatchObject({ status: 'INVALID' });
  });

  it('recommends a split for fat and protein, and only the carb dose is split', () => {
    expect(BOLUS_PROPOSAL_INSTRUCTIONS).toContain('from the proportion, not from grams');
    expect(BOLUS_PROPOSAL_INSTRUCTIONS).toContain('Never less than 60% now');
    expect(BOLUS_PROPOSAL_INSTRUCTIONS).toContain('use_advised_split ADVISED');
    expect(BOLUS_PROPOSAL_INSTRUCTIONS).toContain('insulin for fat or protein is the separate WBT reminder later');
  });
});

describe('split meal bolus: the second part when due', () => {
  const basal: Array<[string, number]> = [['00:00', 0.6]];
  const tz = 'Europe/Warsaw';

  it("counts the loop's SMBs and temp basal above the profile since the meal (a zero temp counts against it)", () => {
    const extra = loopInsulinAboveBasal({
      from: '2026-10-20T10:00:00.000Z',
      to: '2026-10-20T11:30:00.000Z',
      basalSchedule: basal,
      profileTimezone: tz,
      events: [
        { type: 'SMB', occurred_at: '2026-10-20T10:20:00.000Z', payload: { insulin_units: 0.3 } },
        { type: 'SMB', occurred_at: '2026-10-20T10:40:00.000Z', payload: { insulin_units: 0.2 } },
        // Before the meal: not counted.
        { type: 'SMB', occurred_at: '2026-10-20T09:50:00.000Z', payload: { insulin_units: 0.5 } },
        // 1.2 U/h for 30 min = +0.3 U above 0.6 U/h; 0 U/h for 30 min = -0.3 U.
        { type: 'TEMP_BASAL', occurred_at: '2026-10-20T10:00:00.000Z', payload: { rate: 1.2, duration_minutes: 30 } },
        { type: 'TEMP_BASAL', occurred_at: '2026-10-20T11:00:00.000Z', payload: { rate: 0, duration_minutes: 30 } },
      ],
    });
    expect(extra).toEqual({ smb_u: 0.5, temp_basal_extra_u: 0, total_u: 0.5 });
  });

  it('still counts the SMBs without a basal profile and marks the temp basal part unknown', () => {
    const events = [
      { type: 'SMB', occurred_at: '2026-10-20T10:20:00.000Z', payload: { insulin_units: 0.3 } },
      { type: 'TEMP_BASAL', occurred_at: '2026-10-20T10:00:00.000Z', payload: { rate: 1.2, duration_minutes: 30 } },
    ];
    for (const basalSchedule of [null, []]) {
      expect(loopInsulinAboveBasal({ from: '2026-10-20T10:00:00.000Z', to: '2026-10-20T11:30:00.000Z', basalSchedule, profileTimezone: tz, events }))
        .toEqual({ smb_u: 0.3, temp_basal_extra_u: null, total_u: 0.3 });
    }
    const estimate = estimateSecondPart({
      carbs_g: 24,
      meal_started_at: '2026-10-20T09:30:00.000Z',
      now_iso: '2026-10-20T11:00:00.000Z',
      therapy: { timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', 8]], basal_u_per_h: null },
      events: [{ type: 'SMB', occurred_at: '2026-10-20T10:00:00.000Z', payload: { insulin_units: 0.4 } }],
      step: 0.05,
      fallback_time_zone: 'Europe/Warsaw',
      icr_at: scheduleValueAt,
    });
    // 3 U for the carbs minus the 0.4 U of SMB (was the full 3 U: no basal profile dropped the SMBs too).
    expect(estimate).toMatchObject({ insulin_for_carbs_u: 3, loop_extra_u: 0.4, loop_extra_partial: true, smb_u: 0.4, temp_basal_extra_u: null, insulin_u: 2.6 });
  });

  it('takes off only the loop extra since an earlier part was given (the same SMBs never twice)', () => {
    const args = {
      carbs_g: 24, meal_started_at: '2026-10-20T09:30:00.000Z', now_iso: '2026-10-20T11:00:00.000Z',
      therapy: { timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', 8]] as Array<[string, number]>, basal_u_per_h: null },
      events: [
        { type: 'SMB', occurred_at: '2026-10-20T10:00:00.000Z', payload: { insulin_units: 0.4 } },
        { type: 'SMB', occurred_at: '2026-10-20T10:40:00.000Z', payload: { insulin_units: 0.2 } },
      ],
      step: 0.05, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt,
    };
    expect(estimateSecondPart(args)).toMatchObject({ loop_extra_u: 0.6, insulin_u: 2.4 });
    // Part 1 was given at 10:15: only the 10:40 SMB counts for part 2.
    expect(estimateSecondPart({ ...args, loop_extra_from: '2026-10-20T10:15:00.000Z' })).toMatchObject({ loop_extra_u: 0.2, insulin_u: 2.8 });
  });

  it('recomputes the dose with the ICR valid now, minus the loop extra, never below 0', () => {
    expect(secondPartDose({ carbs_g: 24, icr_g_per_u: 8, loop_extra_u: 0.5, step: 0.05 })).toEqual({ insulin_for_carbs_u: 3, loop_extra_u: 0.5, insulin_u: 2.5 });
    expect(secondPartDose({ carbs_g: 10, icr_g_per_u: 10, loop_extra_u: 1.4, step: 0.05 })).toMatchObject({ insulin_u: 0 });
    expect(secondPartDose({ carbs_g: 10, icr_g_per_u: null, loop_extra_u: 0, step: 0.05 })).toMatchObject({ insulin_u: null });
  });

  it('estimates the second part from the profile valid now (ICR changes at 12:00 local)', () => {
    const estimate = estimateSecondPart({
      carbs_g: 24,
      meal_started_at: '2026-10-20T09:30:00.000Z',
      now_iso: '2026-10-20T11:00:00.000Z',
      therapy: { timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', 10], ['12:00', 8]], basal_u_per_h: basal },
      events: [{ type: 'SMB', occurred_at: '2026-10-20T10:00:00.000Z', payload: { insulin_units: 0.4 } }],
      step: 0.05,
      fallback_time_zone: 'Europe/Warsaw',
      icr_at: scheduleValueAt,
    });
    // 11:00 UTC = 13:00 in Warsaw: ICR 8 -> 3 U, minus 0.4 U of SMB.
    expect(estimate).toMatchObject({ icr_g_per_u: 8, insulin_for_carbs_u: 3, loop_extra_u: 0.4, loop_extra_partial: false, insulin_u: 2.6 });
  });

  it('writes the push with the meal, the deferred carbs and the estimate, and warns about a low', () => {
    expect(plannedBolusPushContent({ description: 'Pizza margherita (250 g)', carbs_g: 24, estimate_u: 2.6, low_glucose: null })).toEqual({ title: 'Druga część bolusa', body: 'Pizza margherita: 24 g, ok. 2,6 j\nKliknij, aby sprawdzić dawkę' });
    expect(plannedBolusPushContent({ description: null, carbs_g: 24, estimate_u: 0, low_glucose: 85 }).body).toBe('Druga część posiłku: 24 g\nGlukoza 85 mg/dL: sprawdź, zanim podasz');
  });
});

class CommandStore implements RemoteCommandStore {
  rows: RemoteCommandRecord[] = [];
  async insert(command: NewRemoteCommand): Promise<RemoteCommandRecord> {
    if (command.planned_bolus_id && this.rows.some((row) => row.planned_bolus_id === command.planned_bolus_id && !['EXPIRED', 'SEND_FAILED', 'REJECTED', 'PARTIAL'].includes(row.status))) {
      throw new ConflictError('PLANNED_BOLUS_ALREADY_SENT');
    }
    const record: RemoteCommandRecord = { ...command, id: `00000000-0000-4000-8000-00000000000${this.rows.length + 1}`, status: 'AUTHORIZED', trio_message: null, status_message: null, authorized_at: now.toISOString(), sent_at: null, answered_at: null, loop_action_id: null, meal_record_id: null, matched_at: null };
    this.rows.push(record);
    return record;
  }
  async get(patientId: string, id: string) { return this.rows.find((row) => row.patient_id === patientId && row.id === id) ?? null; }
  async list() { return this.rows; }
  async findInFlight() { return null; }
  async recordSentAt() {}
  async listForProposal(patientId: string, proposalId: string) { return this.rows.filter((row) => row.proposal_id === proposalId); }
  async listForPlannedBolus(patientId: string, planId: string) { return this.rows.filter((row) => row.planned_bolus_id === planId); }
  async listWbtForMeal(patientId: string, mealId: string) { return this.rows.filter((row) => row.purpose === 'WBT' && row.target_meal_record_id === mealId); }
  async latestForPlannedBolus(patientId: string, planId: string) { return this.rows.filter((row) => row.planned_bolus_id === planId).at(-1) ?? null; }
  async findRecentWithInsulin() { return null; }
  async transition() { return null; }
}

const split: SplitPlan = { policy_version: 'split-bolus.v1', now_percent: 60, later_after_minutes: 90, total_carbs_g: 60, total_insulin_u: 6, later_carbs_g: 24, later_insulin_u: 2.4 };

function plan(overrides: Partial<PlannedBolusRecord> = {}): PlannedBolusRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111', patient_id: 'p1', meal_record_id: '22222222-2222-4222-8222-222222222222', proposal_id: 'b1', conversation_id: 'c1',
    first_command_id: 'cmd-1', first_carbs_g: 36, first_insulin_u: 3.6, carbs_g: 24, planned_insulin_u: 2.4, icr_g_per_u: 10, now_percent: 60, delay_minutes: 90,
    due_at: '2026-10-20T13:30:00.000Z', status: 'NOTIFIED', notified_at: null, resolved_at: null, resolved_by_user_id: null, resolved_by_name: null,
    given_command_id: null, given_loop_action_id: null, given_insulin_u: null, created_at: now.toISOString(),
    trigger: null, threshold_mgdl: null, dose_carbs_g: null, fixed_insulin_u: null, drop_cover_g: null, subtract_first_insulin: false, wait_until: null, ...overrides,
  };
}

class PlanStore implements PlannedBolusStore {
  rows: PlannedBolusRecord[] = [];
  async create(input: Parameters<PlannedBolusStore['create']>[0]) {
    if (this.rows.some((row) => row.meal_record_id === input.meal_record_id && (row.part_index ?? 0) === (input.part_index ?? 0) && ['SCHEDULED', 'NOTIFIED'].includes(row.status))) return null;
    const record = plan({ ...input, id: `plan-${this.rows.length + 1}`, status: 'SCHEDULED' });
    this.rows.push(record);
    return record;
  }
  async get(_patientId: string, id: string) { return this.rows.find((row) => row.id === id) ?? null; }
  async latestForMeal(_patientId: string, mealId: string) { return this.rows.filter((row) => row.meal_record_id === mealId).at(-1) ?? null; }
  async listForProposals() { return new Map(); }
  async listOpen() { return this.rows.filter((row) => ['SCHEDULED', 'NOTIFIED'].includes(row.status)); }
  async markNotified() { return true; }
  async resolve(_patientId: string, id: string, to: 'GIVEN' | 'SKIPPED' | 'EXPIRED' | 'CANCELLED', fields: { user_id?: string | null; command_id?: string | null; loop_action_id?: string | null; insulin_u?: number | null } = {}) {
    const row = this.rows.find((candidate) => candidate.id === id && ['SCHEDULED', 'NOTIFIED'].includes(candidate.status));
    if (!row) return null;
    Object.assign(row, { status: to, resolved_at: now.toISOString(), resolved_by_user_id: fields.user_id ?? null, given_command_id: fields.command_id ?? null, given_loop_action_id: fields.loop_action_id ?? null, given_insulin_u: fields.insulin_u ?? null });
    return row;
  }
}

describe('split meal bolus: giving the second part', () => {
  const ctx = async () => ({ ...context(), icr_g_per_u: 10 });
  const secondPart = {
    source: 'PLANNED_BOLUS' as const, carbs_g: 24, insulin_u: 2.4, bolus_step: 0.05, device_id: 'd1', acknowledged_warnings: [],
  };

  it('copies the card\'s split to its first command, so its meal gets the planned part', async () => {
    const commands = new CommandStore();
    const service = new RemoteCommandsService(commands, ctx, { get: async () => ({ conversation_id: 'c1', status: 'PROPOSED', expires_at: '2026-10-20T12:15:00.000Z', split }) });
    await service.authorize('p1', 'u1', { source: 'CHAT_CARD', carbs_g: 36, insulin_u: 3.6, bolus_step: 0.05, device_id: 'd1', conversation_id: 'c1', proposal_id: 'b1', acknowledged_warnings: [] }, now);
    expect(commands.rows[0]).toMatchObject({ split_plan: split, purpose: null, planned_bolus_id: null });
  });

  it('sends the planned part for its meal (no new meal), once; a settled plan is refused with who gave it', async () => {
    const commands = new CommandStore();
    const plans = new PlanStore();
    plans.rows.push(plan());
    const service = new RemoteCommandsService(commands, ctx, null, plans);
    const view = await service.authorize('p1', 'u1', { ...secondPart, planned_bolus_id: plan().id, meal: { description: 'x' } }, now);
    expect(view).toMatchObject({ purpose: 'MEAL_PART', target_meal_record_id: plan().meal_record_id, planned_bolus_id: plan().id });
    expect(commands.rows[0].meal_payload).toBeNull();
    // The other caregiver taps "Podaj" a moment later.
    await expect(service.authorize('p1', 'u2', { ...secondPart, planned_bolus_id: plan().id }, now)).rejects.toBeInstanceOf(ConflictError);
    plans.rows[0].status = 'GIVEN';
    plans.rows[0].resolved_by_name = 'Ewa';
    await expect(service.authorize('p1', 'u2', { ...secondPart, planned_bolus_id: plan().id }, now)).rejects.toThrow('Tę część bolusa już podano (Ewa).');
  });

  it('needs the planned part named for PLANNED_BOLUS and only for it', async () => {
    const service = new RemoteCommandsService(new CommandStore(), ctx, null, new PlanStore());
    await expect(service.authorize('p1', 'u1', { ...secondPart }, now)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.authorize('p1', 'u1', { ...secondPart, source: 'BOLUS_SCREEN', planned_bolus_id: plan().id }, now)).rejects.toBeInstanceOf(ValidationError);
  });

  it("matches the planned part's loop entry as an addition to its meal", () => {
    const command = { ...({} as RemoteCommandRecord), id: 'cmd-2', carbs_g: 24, insulin_u: 2.4, status: 'SENT', purpose: 'MEAL_PART', target_meal_record_id: 'meal-1', planned_bolus_id: 'plan-1', authorized_at: now.toISOString() } as RemoteCommandRecord;
    const match = matchRemoteCommand(command, [{ id: 'a2', started_at: '2026-10-20T12:00:30.000Z', purpose: null, carbs_g: 24, bolus_units: 2.4 }], '2026-10-20T12:02:00.000Z');
    expect(match).toMatchObject({ loop_action_id: 'a2', purpose: 'MEAL_ADDITION', settled_status: 'SUCCEEDED' });
  });

  it('plans the second part when the first part\'s meal is saved and settles it when the second part reaches the loop', async () => {
    const plans = new PlanStore();
    const postponed: string[] = [];
    const planned = new PlannedBolusService({ store: plans, commands: new CommandStore(), postponeWbtReminder: async (_p, _m, at) => { postponed.push(at); } });
    const assigned: Array<{ actionId: string; purpose: string; mealRecordId: string | null }> = [];
    const first = { id: 'cmd-1', patient_id: 'p1', user_id: 'u1', proposal_id: 'b1', conversation_id: 'c1', carbs_g: 36, insulin_u: 3.6, icr_g_per_u: 10, status: 'SUCCEEDED', purpose: null, target_meal_record_id: null, planned_bolus_id: null, split_plan: split, follows_command_id: null, meal_payload: { description: 'Pizza', items: null, macros: { carbs_g: 60, protein_g: 12, fat_g: 20 } }, authorized_at: '2026-10-20T12:00:00.000Z', sent_at: '2026-10-20T12:00:05.000Z' } as unknown as RemoteCommandRecord;
    const commands = [first];
    const edits: Array<{ macros?: { carbs_g: number | null } }> = [];
    const reconciler = new RemoteCommandReconciler({
      commands: {
        applyDeadlines: async () => [],
        listPatientsWithUnmatched: async () => (commands.some((command) => !command.loop_action_id) ? ['p1'] : []),
        listUnmatched: async () => commands.filter((command) => !command.loop_action_id),
        listMatchedWithInsulinSince: async () => [],
        markMatched: async (_p, id, match) => { Object.assign(commands.find((command) => command.id === id)!, { loop_action_id: match.loop_action_id, meal_record_id: match.meal_record_id }); },
        addMealNote: async () => {},
        get: async (_p, id) => commands.find((command) => command.id === id) ?? null,
      },
      loopActions: {
        listActionsBetween: async () => [
          { id: 'a1', started_at: '2026-10-20T12:00:10.000Z', purpose: null, carbs_g: 36, bolus_units: 3.6, meal_record_id: null },
          { id: 'a2', started_at: '2026-10-20T13:31:00.000Z', purpose: null, carbs_g: 24, bolus_units: 2.4, meal_record_id: null },
        ],
        assign: async (args) => { assigned.push({ actionId: args.actionId, purpose: args.purpose, mealRecordId: args.mealRecordId }); },
        getAction: async () => ({ meal_record_id: 'meal-1' }),
        joinBolusToAction: async () => false,
      },
      meals: { findMealIdentityById: async () => 'identity-1', editContent: async (_p, _i, _u, edit) => { edits.push(edit); return 1; } },
      plannedBoluses: {
        createForMeal: async (command, mealId, startedAt) => { await planned.createForMeal(command, mealId, startedAt); },
        markGivenByCommand: (command, actionId) => planned.markGivenByCommand(command, actionId),
      },
      log: () => {},
    });
    await reconciler.run('2026-10-20T12:01:00.000Z');
    expect(plans.rows[0]).toMatchObject({ meal_record_id: 'meal-1', carbs_g: 24, planned_insulin_u: 2.4, due_at: '2026-10-20T13:30:10.000Z', status: 'SCHEDULED', first_command_id: 'cmd-1', meal_carbs_g: 60 });
    // The meal holds the whole meal (36 g now + 24 g later), the start the part follows changes from.
    expect(edits[0].macros).toMatchObject({ carbs_g: 60 });

    commands.push({ ...first, id: 'cmd-2', proposal_id: null, carbs_g: 24, insulin_u: 2.4, split_plan: null, purpose: 'MEAL_PART', target_meal_record_id: 'meal-1', planned_bolus_id: plans.rows[0].id, user_id: 'u2', meal_payload: null, loop_action_id: null, meal_record_id: null, authorized_at: '2026-10-20T13:30:30.000Z' } as unknown as RemoteCommandRecord);
    await reconciler.run('2026-10-20T13:32:00.000Z');
    expect(assigned).toContainEqual({ actionId: 'a2', purpose: 'MEAL_ADDITION', mealRecordId: 'meal-1' });
    expect(plans.rows[0]).toMatchObject({ status: 'GIVEN', given_command_id: 'cmd-2', resolved_by_user_id: 'u2', given_insulin_u: 2.4 });
    // The WBT reminder is moved to an hour after the second part at the earliest.
    expect(postponed).toEqual(['2026-10-20T13:00:00.000Z']);
  });

  it('retries a planned part Trio refused only as the bolus alone after PARTIAL, also after a retry that failed to send', async () => {
    const commands = new CommandStore();
    const plans = new PlanStore();
    plans.rows.push(plan());
    const service = new RemoteCommandsService(commands, ctx, null, plans);
    await service.authorize('p1', 'u1', { ...secondPart, planned_bolus_id: plan().id }, now);
    commands.rows[0].status = 'PARTIAL';
    const retry = { ...secondPart, carbs_g: 0, planned_bolus_id: plan().id, follows_command_id: commands.rows[0].id, acknowledged_warnings: ['INSULIN_WITHOUT_CARBS:2.4'] };
    await expect(service.authorize('p1', 'u1', { ...secondPart, planned_bolus_id: plan().id }, now)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.authorize('p1', 'u1', { ...secondPart, planned_bolus_id: plan().id, follows_command_id: commands.rows[0].id }, now)).rejects.toThrow(/Węglowodany są już w Trio/);
    await service.authorize('p1', 'u1', retry, now);
    commands.rows[1].status = 'SEND_FAILED';
    // The newest command is the failed send: the part with its carbs still does not go again.
    await expect(service.authorize('p1', 'u1', { ...secondPart, planned_bolus_id: plan().id }, now)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.authorize('p1', 'u1', retry, now)).resolves.toMatchObject({ follows_command_id: commands.rows[0].id, carbs_g: 0, planned_bolus_id: plan().id });
  });

  it('keeps a planned part open when Trio kept its carbs but refused its bolus, and settles it with the retry', async () => {
    const plans = new PlanStore();
    plans.rows.push(plan({ id: 'plan-1', meal_record_id: 'meal-1' }));
    const planned = new PlannedBolusService({ store: plans, commands: new CommandStore() });
    const notes: string[] = [];
    const logged: Array<Record<string, unknown>> = [];
    const part = { id: 'cmd-2', patient_id: 'p1', user_id: 'u2', proposal_id: null, conversation_id: null, source: 'PLANNED_BOLUS', carbs_g: 24, insulin_u: 2.4, icr_g_per_u: 10, status: 'PARTIAL', purpose: 'MEAL_PART', target_meal_record_id: 'meal-1', planned_bolus_id: 'plan-1', split_plan: null, follows_command_id: null, meal_payload: null, loop_action_id: null, meal_record_id: null, authorized_at: '2026-10-20T13:30:30.000Z', sent_at: '2026-10-20T13:30:35.000Z' } as unknown as RemoteCommandRecord;
    const commands = [part];
    const actions = [{ id: 'a2', started_at: '2026-10-20T13:31:00.000Z', purpose: null as null | string, carbs_g: 24 as number | null, bolus_units: null as number | null, meal_record_id: null as string | null }];
    const reconciler = new RemoteCommandReconciler({
      commands: {
        applyDeadlines: async () => [],
        listPatientsWithUnmatched: async () => (commands.some((command) => !command.loop_action_id) ? ['p1'] : []),
        listUnmatched: async () => commands.filter((command) => !command.loop_action_id),
        listMatchedWithInsulinSince: async () => [],
        markMatched: async (_p, id, match) => { Object.assign(commands.find((command) => command.id === id)!, { loop_action_id: match.loop_action_id, meal_record_id: match.meal_record_id, ...(match.settled_status ? { status: match.settled_status } : {}) }); },
        addMealNote: async (_command, _meal, content) => { notes.push(content); },
        get: async (_p, id) => commands.find((command) => command.id === id) ?? null,
      },
      loopActions: {
        listActionsBetween: async () => actions.filter((action) => action.purpose === null) as never,
        assign: async (args) => { Object.assign(actions.find((action) => action.id === args.actionId)!, { purpose: args.purpose, meal_record_id: args.mealRecordId }); },
        getAction: async () => ({ meal_record_id: 'meal-1' }),
        joinBolusToAction: async () => true,
      },
      meals: { findMealIdentityById: async () => 'identity-1', editContent: async () => 1 },
      plannedBoluses: {
        createForMeal: async () => {},
        markGivenByCommand: (command, actionId) => planned.markGivenByCommand(command, actionId),
      },
      log: (event) => { logged.push(event); },
    });
    // Carbs only in Nightscout, past the time the bolus would have joined them.
    await reconciler.run('2026-10-20T13:40:00.000Z');
    expect(part.loop_action_id).toBe('a2');
    expect(plans.rows[0]).toMatchObject({ status: 'NOTIFIED', given_insulin_u: null, given_command_id: null });
    expect(notes).toEqual(['Druga część bolusa: 24 g węglowodanów zapisane w Trio, bolus 2,4 j odrzucony przez Trio (insuliny nie podano).']);
    expect(logged).toContainEqual(expect.objectContaining({ event: 'planned_bolus_left_open', remote_command_id: 'cmd-2' }));
    // Even called directly, PARTIAL never settles the part as given.
    await planned.markGivenByCommand(part, 'a2');
    expect(plans.rows[0].status).toBe('NOTIFIED');

    // The bolus-only retry reaches the loop: it joins the part's action and gives the part with its own dose.
    commands.push({ ...part, id: 'cmd-3', carbs_g: 0, insulin_u: 2, status: 'SUCCEEDED', follows_command_id: 'cmd-2', loop_action_id: null, meal_record_id: null, authorized_at: '2026-10-20T13:41:00.000Z' } as unknown as RemoteCommandRecord);
    actions.push({ id: 'a3', started_at: '2026-10-20T13:41:20.000Z', purpose: null, carbs_g: null, bolus_units: 2, meal_record_id: null });
    await reconciler.run('2026-10-20T13:42:00.000Z');
    expect(plans.rows[0]).toMatchObject({ status: 'GIVEN', given_command_id: 'cmd-3', given_insulin_u: 2, given_loop_action_id: 'a2' });
  });

  it('skips an open part (not while its command is on the way) and shows the plan on the chat card', async () => {
    const plans = new PlanStore();
    plans.rows.push(plan());
    const commands = new CommandStore();
    const service = new PlannedBolusService({ store: plans, commands });
    commands.rows.push({ id: 'x', status: 'SENT', planned_bolus_id: plan().id } as RemoteCommandRecord);
    await expect(service.skip('p1', 'u1', plan().id)).rejects.toThrow('wysłana do Trio');
    commands.rows[0].status = 'SEND_FAILED';
    expect(await service.skip('p1', 'u1', plan().id)).toMatchObject({ status: 'SKIPPED', resolved_by_user_id: 'u1' });
    await expect(service.skip('p1', 'u2', plan().id)).rejects.toBeInstanceOf(ConflictError);

    const summary = toPlannedBolusSummary(plan(), { status: 'SENT' });
    expect(summary).toMatchObject({ status: 'NOTIFIED', carbs_g: 24, sending: true });
    const card = toBolusProposalView({ id: 'b1', patient_id: 'p1', conversation_id: 'c1', user_message_id: 'm1', purpose: 'MEAL', carbs_g: 36, insulin_u: 3.6, icr_g_per_u: 10, icr_insulin_u: 3.6, meal_payload: null, reason: null, warnings: [], split, dose_adjustment: null, card_advice: null, status: 'PROPOSED', expires_at: '2026-10-20T12:15:00.000Z', created_at: now.toISOString() }, null, 'u1', now, summary);
    expect(card).toMatchObject({ split: { later_carbs_g: 24 }, planned_bolus: { sending: true } });
  });
});

describe('split meal bolus: expiring an overdue part', () => {
  const authorizedAt = '2026-10-20T13:31:00.000Z';
  const service = (status: string | null) => {
    const plans = new PlanStore();
    plans.rows.push(plan());
    const commands = new CommandStore();
    if (status) commands.rows.push({ id: 'x', status, planned_bolus_id: plan().id, authorized_at: authorizedAt } as RemoteCommandRecord);
    return new PlannedBolusService({ store: plans, commands });
  };
  const minutesAfter = (minutes: number) => new Date(Date.parse(authorizedAt) + minutes * 60_000);

  it('waits for a command on its way while the reconciler can still match it', async () => {
    // A command matched later in Nightscout settles the plan as GIVEN: the plan must still be open then.
    for (const status of ['AUTHORIZED', 'SENT', 'TRIO_ACCEPTED', 'SUCCEEDED', 'NO_REPLY']) {
      expect(await service(status).commandMaySettle(plan(), minutesAfter(59))).toBe(true);
      expect(await service(status).commandMaySettle(plan(), minutesAfter(60))).toBe(false);
    }
  });

  it('a part Trio confirmed but no loop entry matched within the look-back is given by its command', async () => {
    expect(await service('SUCCEEDED').settleConfirmedUnmatched(plan(), minutesAfter(59))).toBe(false);
    const confirmed = service('SUCCEEDED');
    expect(await confirmed.settleConfirmedUnmatched(plan(), minutesAfter(61))).toBe(true);
    expect(await service('NO_REPLY').settleConfirmedUnmatched(plan(), minutesAfter(61))).toBe(false);
  });

  it('expires without a command or after a failed one', async () => {
    expect(await service(null).commandMaySettle(plan(), minutesAfter(1))).toBe(false);
    for (const status of ['SEND_FAILED', 'REJECTED', 'PARTIAL', 'EXPIRED']) expect(await service(status).commandMaySettle(plan(), minutesAfter(1))).toBe(false);
  });
});

describe('waiting for glucose (deferred-bolus.v1, later-plan.v1)', () => {
  const meal = '2026-10-21T11:05:00.000Z';
  const at = (minutes: number) => new Date(Date.parse(meal) + minutes * 60_000);
  const due = at(15).toISOString();
  const check = (trigger: LaterTrigger, minutes: number, glucose: number | null, slope: number | null, forecast: number | null = null, forceAt: string | null = at(60).toISOString(), threshold: number | null = null) => plannedBolusReadiness({
    now: at(minutes), trigger, due_at: due, force_at: forceAt, glucose: glucose === null ? null : { value: glucose, at: at(minutes - 1).toISOString() }, slope_per_min: slope, forecast_min_mgdl: forecast, threshold_mgdl: threshold,
  });
  /** GLUCOSE_RISING takes the Bolus tab's rule (glucoseRisingForSecondDose), not the slope. */
  const checkRising = (minutes: number, glucose: number | null, rising: boolean, forceAt: string | null = at(60).toISOString()) => plannedBolusReadiness({
    now: at(minutes), trigger: 'GLUCOSE_RISING', due_at: due, force_at: forceAt, glucose: glucose === null ? null : { value: glucose, at: at(minutes - 1).toISOString() }, slope_per_min: rising ? 0.1 : 0.9, forecast_min_mgdl: null, rising,
  });

  it('is stored and read back with its trigger; older plans keep their rule', () => {
    const plan = computeLaterPlan({ card_carbs_g: 45, card_insulin_u: 0, request: parseLaterRequest({ trigger: 'GLUCOSE_STOPPED_FALLING', after_minutes: null, threshold_mgdl: null, carbs_g: 0, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null }) as LaterRequest, icr_g_per_u: 8, drop_cover_g: null, step: 0.05 });
    expect(plan).toMatchObject({ plan: { kind: 'DEFERRED_INSULIN', now_percent: 100, later_after_minutes: 15, total_carbs_g: 45, later_carbs_g: 0, later_insulin_u: 5.6, trigger: 'GLUCOSE_STOPPED_FALLING', wait_minutes: 180 } });
    const stored = (plan as { plan: SplitPlan }).plan;
    expect(readSplitPlan(JSON.parse(JSON.stringify(stored)))).toEqual({ ...stored, threshold_mgdl: undefined, dose_carbs_g: undefined, fixed_insulin_u: undefined, drop_cover_g: undefined });
    expect(planTrigger({ kind: 'DEFERRED_INSULIN' })).toBe('GLUCOSE_STOPPED_FALLING');
    expect(planTrigger({ kind: 'SPLIT' })).toBe('AFTER_MINUTES');
    // A plain split with nothing deferred is still not a plan; older cards read as SPLIT.
    expect(readSplitPlan({ ...stored, kind: 'SPLIT' })).toBeNull();
    expect(readSplitPlan({ ...stored, kind: undefined, later_carbs_g: 10 })).toMatchObject({ kind: 'SPLIT' });
    expect(plannedDoseCarbs({ kind: 'DEFERRED_INSULIN', carbs_g: 0, first_carbs_g: 45 })).toBe(45);
    expect(plannedDoseCarbs({ kind: 'SPLIT', carbs_g: 24, first_carbs_g: 36 })).toBe(24);
    expect(plannedDoseCarbs({ kind: 'DEFERRED_INSULIN', carbs_g: 0, first_carbs_g: 23, dose_carbs_g: 46 })).toBe(46);
  });

  it('glucose stopped falling: from due, at least 80, not falling faster than 1 mg/dL/min, not forecast below 80', () => {
    expect(check('GLUCOSE_STOPPED_FALLING', 10, 120, 0)).toEqual({ state: 'WAIT', reason: 'TOO_EARLY' });
    expect(check('GLUCOSE_STOPPED_FALLING', 20, 76, 0.5)).toEqual({ state: 'WAIT', reason: 'LOW' });
    expect(check('GLUCOSE_STOPPED_FALLING', 20, 110, -2)).toEqual({ state: 'WAIT', reason: 'FALLING' });
    expect(check('GLUCOSE_STOPPED_FALLING', 20, 110, -0.5, 74)).toEqual({ state: 'WAIT', reason: 'LOW_FORECAST' });
    expect(check('GLUCOSE_STOPPED_FALLING', 20, null, null)).toEqual({ state: 'WAIT', reason: 'NO_READING' });
    expect(check('GLUCOSE_STOPPED_FALLING', 20, 104, -0.6, 95)).toEqual({ state: 'READY', trigger: 'GLUCOSE_STOPPED_FALLING', glucose_mgdl: 104 });
  });

  it('glucose rising or above a threshold, and the reminder comes anyway once the waiting time is over', () => {
    expect(checkRising(20, 90, false)).toEqual({ state: 'WAIT', reason: 'NOT_RISING' });
    expect(checkRising(20, 92, true)).toEqual({ state: 'READY', trigger: 'GLUCOSE_RISING', glucose_mgdl: 92 });
    expect(checkRising(20, null, false)).toEqual({ state: 'WAIT', reason: 'NO_READING' });
    expect(check('GLUCOSE_ABOVE', 20, 170, 2, null, null, 180)).toEqual({ state: 'WAIT', reason: 'NOT_ABOVE' });
    expect(check('GLUCOSE_ABOVE', 20, 184, 2, null, null, 180)).toEqual({ state: 'READY', trigger: 'GLUCOSE_ABOVE', glucose_mgdl: 184 });
    // Never rising: no reminder anyway (the Bolus tab's rule); the plan lapses at its watching time instead.
    expect(checkRising(195, 88, false, at(195).toISOString())).toEqual({ state: 'WAIT', reason: 'NOT_RISING' });
    const rising = { kind: 'DEFERRED_INSULIN' as const, trigger: 'GLUCOSE_RISING' as const, wait_until: at(60).toISOString(), due_at: due };
    expect(plannedBolusExpiresAtMs({ ...rising, status: 'SCHEDULED' }, due)).toBe(at(60).getTime());
    expect(plannedBolusExpiresAtMs({ ...rising, status: 'NOTIFIED' }, due)).toBe(at(180).getTime());
    // Older deferred plans: 60 min after the meal.
    expect(check('GLUCOSE_STOPPED_FALLING', 60, 85, -2)).toEqual({ state: 'FORCED', trigger: 'GLUCOSE_STOPPED_FALLING', glucose_mgdl: 85, reason: 'FALLING' });
    expect(check('AFTER_MINUTES', 20, null, null)).toEqual({ state: 'READY', trigger: 'AFTER_MINUTES', glucose_mgdl: null });
  });

  it('says why in the push', () => {
    expect(plannedBolusPushContent({ description: 'Makaron z sosem pomidorowym', carbs_g: 45, estimate_u: 5.6, low_glucose: null, kind: 'DEFERRED_INSULIN', readiness: { state: 'READY', trigger: 'GLUCOSE_STOPPED_FALLING', glucose_mgdl: 112 } }))
      .toEqual({ title: 'Bolus na posiłek', body: 'Makaron z sosem pomidorowym: ok. 5,6 j na 45 g\nGlukoza 112 mg/dL przestała spadać: sprawdź dawkę i podaj' });
    expect(plannedBolusPushContent({ description: null, carbs_g: 45, estimate_u: 0, low_glucose: 72, kind: 'DEFERRED_INSULIN', readiness: { state: 'FORCED', trigger: 'GLUCOSE_STOPPED_FALLING', glucose_mgdl: 72, reason: 'LOW' } }).body)
      .toBe('Bolus na 45 g\nGlukoza 72 mg/dL nadal niska: sprawdź glukozę, zanim podasz');
    expect(plannedBolusPushContent({ description: 'Bułka', carbs_g: 23, estimate_u: 1.4, low_glucose: null, kind: 'DEFERRED_INSULIN', readiness: { state: 'READY', trigger: 'GLUCOSE_RISING', glucose_mgdl: 96 } }).body)
      .toBe('Bułka: ok. 1,4 j na 23 g\nGlukoza 96 mg/dL rośnie: sprawdź dawkę i podaj');
    expect(plannedBolusPushContent({ description: 'Bułka', carbs_g: 23, estimate_u: 1.4, low_glucose: null, kind: 'DEFERRED_INSULIN', readiness: { state: 'FORCED', trigger: 'GLUCOSE_RISING', glucose_mgdl: 88, reason: 'NOT_RISING' } }).body)
      .toBe('Bułka: ok. 1,4 j na 23 g\nGlukoza 88 mg/dL nie zaczęła rosnąć: sprawdź, czy bolus jest jeszcze potrzebny');
  });

  it('is planned from the carbs the caregiver actually sent, waits its time, and takes off what the card gave', async () => {
    const plans = new PlanStore();
    const service = new PlannedBolusService({ store: plans, commands: new CommandStore() });
    const split = (computeLaterPlan({ card_carbs_g: 45, card_insulin_u: 0, request: parseLaterRequest({ trigger: 'GLUCOSE_RISING', after_minutes: null, threshold_mgdl: null, carbs_g: 0, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: 120 }) as LaterRequest, icr_g_per_u: 8, drop_cover_g: null, step: 0.05 }) as { plan: SplitPlan }).plan;
    // The caregiver changed the card to 20 g and 0,5 j before sending.
    const command = { id: 'cmd-9', patient_id: 'p1', proposal_id: 'b9', conversation_id: 'c1', carbs_g: 20, insulin_u: 0.5, icr_g_per_u: 8, split_plan: split } as unknown as RemoteCommandRecord;
    const created = await service.createForMeal(command, 'meal-9', meal);
    expect(created).toMatchObject({ kind: 'DEFERRED_INSULIN', meal_record_id: 'meal-9', first_carbs_g: 20, first_insulin_u: 0.5, carbs_g: 0, now_percent: 100, delay_minutes: 0, due_at: '2026-10-21T11:05:00.000Z', trigger: 'GLUCOSE_RISING', subtract_first_insulin: true, wait_until: '2026-10-21T13:05:00.000Z' });
    const estimate = estimatePlannedBolus({
      plan: created!,
      meal_started_at: meal,
      now_iso: at(40).toISOString(),
      therapy: { timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', 8]], basal_u_per_h: [['00:00', 0.6]] },
      events: [],
      step: 0.05,
      fallback_time_zone: 'Europe/Warsaw',
      icr_at: scheduleValueAt,
    });
    // 20 g / 8 = 2,5 j minus the 0,5 j the card gave = 2 j.
    expect(estimate).toMatchObject({ dose_carbs_g: 20, insulin_for_carbs_u: 2.5, first_insulin_subtracted_u: 0.5, insulin_u: 2 });
  });
});

describe('several later parts of one card (migration 066)', () => {
  it('plans each part for the meal, the fixed half without taking the card\'s insulin off again', async () => {
    const plans = new PlanStore();
    const service = new PlannedBolusService({ store: plans, commands: new CommandStore() });
    const parts = (computeLaterPlans({
      card_carbs_g: 28, card_insulin_u: 1.8, icr_g_per_u: 8, drop_cover_g: null, step: 0.05,
      requests: [
        parseLaterRequest({ trigger: 'AFTER_MINUTES', after_minutes: 10, threshold_mgdl: null, carbs_g: 0, dose_carbs_g: null, insulin_u: 1.8, subtract_drop_cover: false, wait_minutes: null }) as LaterRequest,
        parseLaterRequest({ trigger: 'AFTER_MINUTES', after_minutes: 60, threshold_mgdl: null, carbs_g: 12, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null }) as LaterRequest,
      ],
    }) as { plan: SplitPlan }).plan;
    expect(planParts(parts).map((part) => [part.kind, part.later_after_minutes, part.later_carbs_g, part.later_insulin_u])).toEqual([['DEFERRED_INSULIN', 10, 0, 1.8], ['SPLIT', 60, 12, 1.5]]);
    const command = { id: 'cmd-p', patient_id: 'p1', proposal_id: 'b1', conversation_id: 'c1', carbs_g: 28, insulin_u: 1.8, icr_g_per_u: 8, split_plan: readSplitPlan(JSON.parse(JSON.stringify(parts))) } as unknown as RemoteCommandRecord;
    await service.createForMeal(command, 'meal-p', '2026-10-22T10:50:00.000Z');
    expect(plans.rows.map((row) => [row.part_index, row.kind, row.due_at, row.fixed_insulin_u, row.carbs_g, row.subtract_first_insulin])).toEqual([
      [0, 'DEFERRED_INSULIN', '2026-10-22T11:00:00.000Z', 1.8, 0, false],
      [1, 'SPLIT', '2026-10-22T11:50:00.000Z', null, 12, false],
    ]);
  });

  const deferred = (overrides: Partial<Record<string, unknown>> = {}) => parseLaterRequest({ trigger: 'GLUCOSE_STOPPED_FALLING', after_minutes: 10, threshold_mgdl: null, carbs_g: 0, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null, ...overrides }) as LaterRequest;

  it('takes the card\'s insulin off the same dose on the card and when due, also with the card\'s grams named (review 2026-10-22)', async () => {
    const parts = (computeLaterPlans({ card_carbs_g: 40, card_insulin_u: 1, icr_g_per_u: 20, drop_cover_g: null, step: 0.05, requests: [deferred({ dose_carbs_g: 40 })] }) as { plan: SplitPlan }).plan;
    expect(parts).toMatchObject({ later_insulin_u: 1, subtract_card_insulin: true });
    const plans = new PlanStore();
    const service = new PlannedBolusService({ store: plans, commands: new CommandStore() });
    const command = { id: 'cmd-s', patient_id: 'p1', proposal_id: 'b1', conversation_id: 'c1', carbs_g: 40, insulin_u: 1, icr_g_per_u: 20, split_plan: readSplitPlan(JSON.parse(JSON.stringify(parts))) } as unknown as RemoteCommandRecord;
    await service.createForMeal(command, 'meal-s', '2026-10-22T10:50:00.000Z');
    expect(plans.rows[0]).toMatchObject({ subtract_first_insulin: true });
  });

  it('refuses later doses that would dose the card\'s carbs twice', () => {
    expect(computeLaterPlans({ card_carbs_g: 40, card_insulin_u: 0, icr_g_per_u: 20, drop_cover_g: null, step: 0.05, requests: [deferred(), deferred({ trigger: 'GLUCOSE_RISING' })] }))
      .toMatchObject({ problem: expect.stringContaining('later doses are for 80 g') });
    // Split by grams: fine.
    expect(computeLaterPlans({ card_carbs_g: 40, card_insulin_u: 0, icr_g_per_u: 20, drop_cover_g: null, step: 0.05, requests: [deferred({ dose_carbs_g: 20 }), deferred({ dose_carbs_g: 20, trigger: 'GLUCOSE_RISING' })] }))
      .toMatchObject({ plan: { later_insulin_u: 1, more_parts: [{ later_insulin_u: 1 }] } });
  });

  const split = (overrides: Partial<Record<string, unknown>> = {}) => parseLaterRequest({ trigger: 'AFTER_MINUTES', after_minutes: 60, threshold_mgdl: null, carbs_g: 20, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null, ...overrides }) as LaterRequest;

  it('a later part dosing the card\'s carbs too takes the card\'s insulin off (never 10 U for 60 g at ICR 10)', () => {
    // Card 40 g + 4 U now; later 20 g dosed for 60 g: 6 U - 4 U = 2 U.
    expect(computeLaterPlans({ card_carbs_g: 40, card_insulin_u: 4, icr_g_per_u: 10, drop_cover_g: null, step: 0.05, requests: [split({ dose_carbs_g: 60 })] }))
      .toMatchObject({ plan: { later_insulin_u: 2, subtract_card_insulin: true, total_insulin_u: 6 } });
    // Carbs now with no insulin now: the later dose covers both.
    expect(computeLaterPlans({ card_carbs_g: 40, card_insulin_u: 0, icr_g_per_u: 10, drop_cover_g: null, step: 0.05, requests: [split({ dose_carbs_g: 60 })] }))
      .toMatchObject({ plan: { later_insulin_u: 6 } });
    // More of the card's carbs than it has: refused.
    expect(computeLaterPlans({ card_carbs_g: 40, card_insulin_u: 0, icr_g_per_u: 10, drop_cover_g: null, step: 0.05, requests: [split({ dose_carbs_g: 80 })] }))
      .toMatchObject({ problem: expect.stringContaining('later doses are for 60 g but this card has 40 g') });
  });

  it('refuses a whole plan over 30 U or 300 g, though each part alone fits', () => {
    const fixed = (units: number) => split({ carbs_g: 0, insulin_u: units, trigger: 'AFTER_MINUTES' });
    expect(computeLaterPlans({ card_carbs_g: 40, card_insulin_u: 4, icr_g_per_u: 10, drop_cover_g: null, step: 0.05, requests: [fixed(10), fixed(10), fixed(10)] }))
      .toMatchObject({ problem: expect.stringContaining('whole plan would be 34 U') });
    expect(computeLaterPlans({ card_carbs_g: 100, card_insulin_u: 0, icr_g_per_u: 50, drop_cover_g: null, step: 0.05, requests: [split({ carbs_g: 150 }), split({ carbs_g: 100 })] }))
      .toMatchObject({ problem: expect.stringContaining('whole plan would be 350 g') });
  });
});

describe('PlannedBolusService.cardInsulinGiven', () => {
  const command = (fields: Partial<RemoteCommandRecord>) => ({ id: 'c', patient_id: 'p1', proposal_id: 'card-1', planned_bolus_id: null, insulin_u: 0, status: 'SUCCEEDED', ...fields }) as RemoteCommandRecord;
  const service = (rows: RemoteCommandRecord[]) => new PlannedBolusService({
    store: new PlanStore(),
    commands: { latestForPlannedBolus: async () => null, listForProposal: async () => rows },
  });
  const plan = { patient_id: 'p1', proposal_id: 'card-1', subtract_first_insulin: true, first_insulin_u: 2 };

  it('takes off what the card delivered: nothing for a refused bolus, the retry\'s bolus once it went', async () => {
    expect(await service([command({ id: 'c1', insulin_u: 2, status: 'PARTIAL' })]).cardInsulinGiven(plan)).toBe(0);
    expect(await service([command({ id: 'c1', insulin_u: 2, status: 'PARTIAL' }), command({ id: 'c2', insulin_u: 1.5, status: 'SUCCEEDED' })]).cardInsulinGiven(plan)).toBe(1.5);
    // Unanswered may have been given: counted, so a later dose is never too big.
    expect(await service([command({ id: 'c1', insulin_u: 2, status: 'NO_REPLY' })]).cardInsulinGiven(plan)).toBe(2);
    // A later part's own command is not the card's insulin.
    expect(await service([command({ id: 'c1', insulin_u: 2 }), command({ id: 'c3', insulin_u: 1, planned_bolus_id: 'plan-1' })]).cardInsulinGiven(plan)).toBe(2);
    expect(await service([]).cardInsulinGiven({ ...plan, subtract_first_insulin: false })).toBeNull();
  });
});

describe('later dose limit', () => {
  it('refuses a later dose over 30 U instead of a plan the database would refuse', () => {
    const request = parseLaterRequest({ trigger: 'AFTER_MINUTES', after_minutes: 60, threshold_mgdl: null, carbs_g: 200, dose_carbs_g: null, insulin_u: null, subtract_drop_cover: false, wait_minutes: null }) as LaterRequest;
    expect(computeLaterPlan({ card_carbs_g: 40, card_insulin_u: 6, request, icr_g_per_u: 6, drop_cover_g: null, step: 0.05 })).toMatchObject({ problem: expect.stringContaining('30 U') });
  });
});

describe('a meal changed before its later parts (migration 076)', () => {
  // A split meal: 36 g now, 24 g in 90 min; the meal holds the whole 60 g.
  const split = (overrides: Partial<PlannedBolusRecord> = {}) => plan({ status: 'SCHEDULED', meal_carbs_g: 60, meal_change_g: 0, cancelled_by_meal_change: false, ...overrides });

  it('the meal holds the whole meal: the carbs now and the later parts\' carbs', () => {
    const card = { now_percent: 60, later_after_minutes: 90, total_carbs_g: 60, total_insulin_u: 6, later_carbs_g: 24, later_insulin_u: 2.4, kind: 'SPLIT' } as SplitPlan;
    expect(plannedMealCarbs(36, card)).toBe(60);
    expect(plannedMealCarbs(23, { ...card, kind: 'DEFERRED_INSULIN', later_carbs_g: 0 })).toBe(23);
    expect(plannedMealCarbs(30, { ...card, later_carbs_g: 10, more_parts: [{ ...card, later_carbs_g: 20 }] })).toBe(60);
    expect(plannedMealCarbs(40, null)).toBe(40);
  });

  it('10 g removed: the later part sends 10 g less and its dose is for 10 g less', () => {
    expect(mealCarbsChangeUpdates([split()], 50, 0.05)).toEqual([
      { plan_id: split().id, carbs_g: 14, dose_carbs_g: null, planned_insulin_u: 1.4, meal_carbs_g: 50, meal_change_g: -10, cancel: false, reopen: false, meal_excess_g: 0 },
    ]);
    // Added: the later part gets them.
    expect(mealCarbsChangeUpdates([split()], 66, 0.05)[0]).toMatchObject({ carbs_g: 30, planned_insulin_u: 3, meal_change_g: 6 });
    // No change, a settled part, a part already at the meal's carbs: nothing to do.
    expect(mealCarbsChangeUpdates([split()], 60, 0.05)).toEqual([]);
    expect(mealCarbsChangeUpdates([split({ status: 'GIVEN' })], 50, 0.05)).toEqual([]);
  });

  it('a deferred dose is for fewer carbs; the carbs already sent stay', () => {
    const deferred = split({ kind: 'DEFERRED_INSULIN', first_carbs_g: 23, first_insulin_u: 0, carbs_g: 0, planned_insulin_u: 2.3, meal_carbs_g: 23 });
    expect(mealCarbsChangeUpdates([deferred], 13, 0.05)[0]).toMatchObject({ carbs_g: 0, dose_carbs_g: 13, planned_insulin_u: 1.3, meal_change_g: -10, cancel: false, reopen: false });
    expect(plannedDoseCarbs({ ...deferred, dose_carbs_g: 13 })).toBe(13);
  });

  it('what does not fit in the next part comes off the one after it; a part with nothing left is cancelled', () => {
    const first = split({ id: 'a', part_index: 0, carbs_g: 10, planned_insulin_u: 1 });
    const second = split({ id: 'b', part_index: 1, carbs_g: 20, planned_insulin_u: 2 });
    expect(mealCarbsChangeUpdates([second, first], 45, 0.05)).toEqual([
      { plan_id: 'a', carbs_g: 0, dose_carbs_g: null, planned_insulin_u: 0, meal_carbs_g: 45, meal_change_g: -10, cancel: true, reopen: false, meal_excess_g: 0 },
      { plan_id: 'b', carbs_g: 15, dose_carbs_g: null, planned_insulin_u: 1.5, meal_carbs_g: 45, meal_change_g: -5, cancel: false, reopen: false, meal_excess_g: 0 },
    ]);
  });

  it('carbs added back give the parts what earlier changes took, in order, then the rest to the next open part', () => {
    const emptied = split({ id: 'a', part_index: 0, carbs_g: 0, planned_insulin_u: 0, meal_carbs_g: 45, meal_change_g: -10, status: 'CANCELLED', cancelled_by_meal_change: true });
    const reduced = split({ id: 'b', part_index: 1, carbs_g: 15, planned_insulin_u: 1.5, meal_carbs_g: 45, meal_change_g: -5 });
    expect(mealCarbsChangeUpdates([emptied, reduced], 52, 0.05)).toEqual([
      { plan_id: 'a', carbs_g: 7, dose_carbs_g: null, planned_insulin_u: 0.7, meal_carbs_g: 52, meal_change_g: -3, cancel: false, reopen: true, meal_excess_g: 0 },
      // Untouched, but on the same start as the others.
      { plan_id: 'b', carbs_g: 15, dose_carbs_g: null, planned_insulin_u: 1.5, meal_carbs_g: 52, meal_change_g: -5, cancel: false, reopen: false, meal_excess_g: 0 },
    ]);
    expect(mealCarbsChangeUpdates([emptied, reduced], 65, 0.05)).toEqual([
      { plan_id: 'a', carbs_g: 10, dose_carbs_g: null, planned_insulin_u: 1, meal_carbs_g: 65, meal_change_g: 0, cancel: false, reopen: true, meal_excess_g: 0 },
      { plan_id: 'b', carbs_g: 25, dose_carbs_g: null, planned_insulin_u: 2.5, meal_carbs_g: 65, meal_change_g: 5, cancel: false, reopen: false, meal_excess_g: 0 },
    ]);
    // A part cancelled otherwise (skipped, the meal deleted) never comes back.
    expect(mealCarbsChangeUpdates([{ ...emptied, cancelled_by_meal_change: false }], 60, 0.05)).toEqual([]);
  });

  it('a dose named in the plan stays (its push asks to check it); an unknown start takes the meal\'s carbs now', () => {
    expect(mealCarbsChangeUpdates([split({ fixed_insulin_u: 2 })], 50, 0.05)[0]).toMatchObject({ carbs_g: 14, planned_insulin_u: 2.4, meal_change_g: -10, cancel: false, reopen: false });
    expect(mealCarbsChangeUpdates([split({ meal_carbs_g: null })], 50, 0.05)).toEqual([
      { plan_id: split().id, carbs_g: 24, dose_carbs_g: null, planned_insulin_u: 2.4, meal_carbs_g: 50, meal_change_g: 0, cancel: false, reopen: false, meal_excess_g: 0 },
    ]);
  });

  it('the push says the meal changed', () => {
    expect(mealChangeLine(-10, null)).toBe('⚠️ Posiłek zmieniono po zaplanowaniu (−10 g): dawka przeliczona.');
    expect(mealChangeLine(5, 2)).toBe('⚠️ Posiłek zmieniono po zaplanowaniu (+5 g), a dawka tej części była ustalona z góry: przelicz ją.');
    expect(mealChangeLine(0, null)).toBeNull();
    expect(plannedBolusPushContent({ description: 'Pizza', carbs_g: 14, estimate_u: 1.4, low_glucose: null, meal_change_g: -10, fixed_insulin_u: null }).body)
      .toBe('Pizza: 14 g, ok. 1,4 j\nKliknij, aby sprawdzić dawkę\n⚠️ Posiłek zmieniono po zaplanowaniu (−10 g): dawka przeliczona.');
    expect(toPlannedBolusSummary(split({ meal_change_g: -10 }), null)).toMatchObject({ meal_change_g: -10 });
  });

  it('the service follows the meal: the part updated, an emptied one cancelled, the start stored with the plan', async () => {
    const plans = new PlanStore() as PlanStore & Required<Pick<PlannedBolusStore, 'listForMeal' | 'followMealChange'>>;
    plans.listForMeal = async (_patientId, mealId) => plans.rows.filter((row) => row.meal_record_id === mealId);
    plans.followMealChange = async (_patientId, id, { cancel, reopen, ...fields }) => {
      const row = plans.rows.find((candidate) => candidate.id === id)!;
      Object.assign(row, fields, cancel ? { status: 'CANCELLED', cancelled_by_meal_change: true } : reopen ? { status: 'SCHEDULED', cancelled_by_meal_change: false } : {});
      return true;
    };
    plans.rows.push(split({ id: 'a', part_index: 0, carbs_g: 10 }), split({ id: 'b', part_index: 1, carbs_g: 20 }));
    const service = new PlannedBolusService({ store: plans, commands: { latestForPlannedBolus: async () => null } });
    await service.followMealCarbs('p1', plan().meal_record_id, 45);
    expect(plans.rows.map((row) => [row.id, row.status, row.carbs_g, row.meal_carbs_g, row.cancelled_by_meal_change])).toEqual([['a', 'CANCELLED', 0, 45, true], ['b', 'SCHEDULED', 15, 45, false]]);
    // Undone ("Cofnij"): both parts get their grams back, the cancelled one is scheduled again.
    await service.followMealCarbs('p1', plan().meal_record_id, 60);
    expect(plans.rows.map((row) => [row.id, row.status, row.carbs_g, row.meal_change_g, row.cancelled_by_meal_change])).toEqual([['a', 'SCHEDULED', 10, 0, false], ['b', 'SCHEDULED', 20, 0, false]]);
  });
});

describe('meal changes and doses given by hand (audit 2026-10-26)', () => {
  const split = (overrides: Partial<PlannedBolusRecord> = {}) => plan({ status: 'SCHEDULED', meal_carbs_g: 60, meal_change_g: 0, cancelled_by_meal_change: false, meal_excess_g: 0, ...overrides });

  it('grams removed beyond the later parts are kept as an excess, and come back first when the change is undone', () => {
    // 60 g meal, 24 g later: 34 g removed takes the part's 24 g and leaves 10 g of insulin already given too much.
    const [update] = mealCarbsChangeUpdates([split()], 26, 0.05);
    expect(update).toMatchObject({ carbs_g: 0, cancel: true, meal_change_g: -24, meal_excess_g: 10 });
    const cancelled = split({ ...update, status: 'CANCELLED', cancelled_by_meal_change: true });
    // "Cofnij": the excess goes first, then the part gets its 24 g back, never more.
    expect(mealCarbsChangeUpdates([cancelled], 60, 0.05)[0]).toMatchObject({ carbs_g: 24, meal_change_g: 0, reopen: true, meal_excess_g: 0 });
    // Half undone: only the excess shrinks.
    expect(mealCarbsChangeUpdates([cancelled], 31, 0.05)[0]).toMatchObject({ carbs_g: 0, reopen: false, meal_excess_g: 5 });
  });

  it('a card without item macros compares the first carbs the caregiver sets with its own whole meal', () => {
    const unknown = split({ meal_carbs_g: null, first_carbs_g: 36, carbs_g: 24 });
    expect(cardMealCarbs([unknown])).toBe(60);
    expect(mealCarbsChangeUpdates([unknown], 50, 0.05, { baseline_when_unknown: 60 })[0]).toMatchObject({ carbs_g: 14, meal_change_g: -10, meal_carbs_g: 50 });
    // A deferred card: the carbs were all sent at once.
    expect(cardMealCarbs([split({ kind: 'DEFERRED_INSULIN', first_carbs_g: 60, carbs_g: 0 })])).toBe(60);
  });

  it('a part whose command is on its way keeps what was sent', () => {
    expect(mealCarbsChangeUpdates([split({ id: 'sending' })], 40, 0.05, { locked: new Set(['sending']) })).toEqual([]);
  });

  it('the service reports a new excess and skips parts with a live command', async () => {
    const plans = new PlanStore() as PlanStore & Required<Pick<PlannedBolusStore, 'listForMeal' | 'followMealChange'>>;
    plans.listForMeal = async (_patientId, mealId) => plans.rows.filter((row) => row.meal_record_id === mealId);
    plans.followMealChange = async (_patientId, id, { cancel, reopen, ...fields }) => {
      Object.assign(plans.rows.find((candidate) => candidate.id === id)!, fields, cancel ? { status: 'CANCELLED', cancelled_by_meal_change: true } : reopen ? { status: 'SCHEDULED' } : {});
      return true;
    };
    plans.rows.push(split({ id: 'a', icr_g_per_u: 10 }));
    const live = { latestForPlannedBolus: async () => null as RemoteCommandRecord | null };
    const service = new PlannedBolusService({ store: plans, commands: live });
    expect(await service.followMealCarbs('p1', plan().meal_record_id, 26)).toEqual({ before_g: 0, after_g: 10, excess_u: 1 });
    expect(await service.followMealCarbs('p1', plan().meal_record_id, 60)).toEqual({ before_g: 10, after_g: 0, excess_u: 0 });

    plans.rows.push(split({ id: 'b', meal_record_id: '33333333-3333-4333-8333-333333333333' }));
    live.latestForPlannedBolus = async () => ({ status: 'SENT' }) as RemoteCommandRecord;
    expect(await service.followMealCarbs('p1', '33333333-3333-4333-8333-333333333333', 30)).toBeNull();
    expect(plans.rows.find((row) => row.id === 'b')).toMatchObject({ status: 'SCHEDULED', carbs_g: 24 });
  });

  it('the meal page and the push say the given insulin was too much', () => {
    expect(mealExcessLine(10, 1)).toBe('Posiłek zmniejszono o 10 g więcej, niż zostało w kolejnych częściach bolusa: podana insulina była o ok. 1 j za duża. Sprawdź glukozę.');
    expect(mealExcessLine(0, null)).toBeNull();
  });

  it('insulin given by hand for the meal is taken off the part and named in its push', () => {
    const meal = plan().meal_record_id;
    const action = (id: string, minutes: number, extra: Partial<{ bolus_units: number; carbs_g: number | null; meal_record_id: string | null }> = {}) => ({
      id, started_at: new Date(Date.parse('2026-10-20T12:00:00.000Z') + minutes * 60_000).toISOString(), bolus_units: 1, carbs_g: null, meal_record_id: null, ...extra,
    });
    const manual = manualInsulinForPart({
      actions: [
        action('own', 0, { bolus_units: 3.6, carbs_g: 36, meal_record_id: meal }), // the card's own bolus
        action('trio', 40, { bolus_units: 1.2 }), // given in Trio
        action('dessert', 50, { bolus_units: 2, carbs_g: 20 }), // came with carbs: not this meal's dose
        action('other-meal', 55, { bolus_units: 1, meal_record_id: 'other' }),
        action('part-1', 60, { bolus_units: 1, meal_record_id: meal }), // an earlier part, already used
      ],
      used: new Set(['own', 'part-1']),
      meal_record_id: meal,
      meal_started_at: '2026-10-20T12:00:00.000Z',
      now: new Date('2026-10-20T13:30:00.000Z'),
    });
    expect(manual.map((entry) => entry.id)).toEqual(['trio']);

    const base = {
      meal_started_at: '2026-10-20T12:00:00.000Z', now_iso: '2026-10-20T13:30:00.000Z', events: [], step: 0.05, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt,
      therapy: { timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', 10]], basal_schedule_u_per_h: null } as never,
    };
    expect(estimatePlannedBolus({ ...base, plan: plan(), manual_insulin_u: 1.2 })).toMatchObject({ insulin_u: 1.2, manual_insulin_subtracted_u: 1.2 });
    // A dose the caregiver named stays.
    expect(estimatePlannedBolus({ ...base, plan: plan({ fixed_insulin_u: 2 }), manual_insulin_u: 1.2 })).toMatchObject({ insulin_u: 2, manual_insulin_subtracted_u: null });

    expect(plannedBolusPushContent({ description: 'Pizza', carbs_g: 24, estimate_u: 1.2, low_glucose: null, given_line: '⚠️ Od 14:00 podano już 1,2 j (14:40, Trio).' }).body)
      .toBe('Pizza: 24 g, ok. 1,2 j\nKliknij, aby sprawdzić dawkę\n⚠️ Od 14:00 podano już 1,2 j (14:40, Trio). Odjęte od dawki, sprawdź, zanim podasz.');
  });
});

describe('meal reminders share one rule (audit 2026-10-26)', () => {
  it('a second dose given before its reminder came settles it; an earlier or other meal\'s bolus does not', async () => {
    const { secondDoseGivenBefore } = await import('./application/bolus-reminders');
    const reminder = { created_at: '2026-10-26T12:00:00.000Z', meal_record_id: 'm1' };
    const action = (id: string, at: string, extra: Partial<{ purpose: string | null; meal_record_id: string | null; bolus_units: number | null }> = {}) => ({ id, started_at: at, purpose: 'MEAL_ADDITION', meal_record_id: 'm1', bolus_units: 1, ...extra });
    expect(secondDoseGivenBefore({ reminder, actions: [action('early', '2026-10-26T11:59:00.000Z'), action('other', '2026-10-26T12:30:00.000Z', { meal_record_id: 'm2' }), action('given', '2026-10-26T12:40:00.000Z')] })?.id).toBe('given');
    expect(secondDoseGivenBefore({ reminder, actions: [action('given', '2026-10-26T12:40:00.000Z')], used: new Set(['given']) })).toBeNull();
    expect(secondDoseGivenBefore({ reminder, actions: [action('wbt', '2026-10-26T12:40:00.000Z', { purpose: 'WBT' })] })).toBeNull();
  });

  it('the second dose\'s title says what was delivered and the meal\'s carbs now', async () => {
    const { secondDoseTitleAtSend } = await import('./application/bolus-reminders');
    const entry = { started_at: '2026-10-26T16:05:00.000Z', carbs_g: 45, bolus_units: 4.5 };
    expect(secondDoseTitleAtSend({ entry, meal_carbs_g: 45, time_zone: 'Europe/Warsaw' })).toEqual({ title: 'Druga dawka · 45 g · 4,5 j o 17:05', lines: [] });
    expect(secondDoseTitleAtSend({ entry, meal_carbs_g: 35, time_zone: 'Europe/Warsaw' })).toEqual({ title: 'Druga dawka · 35 g · 4,5 j o 17:05', lines: ['Posiłek zmieniony: 45→35 g.'] });
    expect(secondDoseTitleAtSend({ entry: { ...entry, bolus_units: null }, meal_carbs_g: 45, time_zone: 'Europe/Warsaw' })).toEqual({ title: 'Druga dawka · 45 g o 17:05', lines: ['Bolus do posiłku nie został podany.'] });
    expect(secondDoseTitleAtSend({ entry: null, meal_carbs_g: 45, time_zone: 'Europe/Warsaw' })).toBeNull();
  });

  it('a WBT reminder waits for the meal\'s second dose', async () => {
    const { wbtWaitForSecondDose } = await import('./application/bolus-reminders');
    const gaps = { given_gap_minutes: 60, unanswered_gap_minutes: 30 };
    expect(wbtWaitForSecondDose([{ kind: 'SECOND_DOSE', status: 'ACTIVE', fired_at: null }], gaps)).toEqual({ state: 'OPEN' });
    expect(wbtWaitForSecondDose([{ kind: 'SECOND_DOSE', status: 'FIRED', fired_at: '2026-10-26T14:00:00.000Z', dose_given_at: '2026-10-26T14:10:00.000Z' }], gaps)).toEqual({ state: 'NOT_BEFORE', at: '2026-10-26T15:10:00.000Z' });
    expect(wbtWaitForSecondDose([{ kind: 'SECOND_DOSE', status: 'FIRED', fired_at: '2026-10-26T14:00:00.000Z' }], gaps)).toEqual({ state: 'NOT_BEFORE', at: '2026-10-26T14:30:00.000Z' });
    expect(wbtWaitForSecondDose([{ kind: 'SECOND_DOSE', status: 'CANCELLED', fired_at: null }, { kind: null, status: 'ACTIVE', fired_at: null }], gaps)).toBeNull();
  });

  it('one dose answers one reminder, a dose assigned to the meal first', async () => {
    const { doseAnsweringReminder } = await import('./application/bolus-reminders');
    const base = { kind: 'WBT' as const, mealRecordId: 'm1', firedAt: '2026-10-26T14:00:00.000Z', until: null, now: new Date('2026-10-26T15:00:00.000Z') };
    const unassigned = { action_id: 'a1', at: '2026-10-26T14:05:00.000Z', insulin_u: 1, user_id: 'u', name: 'Ewa', purpose: null, meal_record_id: null, carbs_g: null };
    const assigned = { ...unassigned, action_id: 'a2', at: '2026-10-26T14:20:00.000Z', purpose: 'WBT', meal_record_id: 'm1' };
    expect(doseAnsweringReminder({ ...base, doses: [unassigned, assigned] })?.action_id).toBe('a2');
    expect(doseAnsweringReminder({ ...base, doses: [unassigned, assigned], used: new Set(['a2']) })?.action_id).toBe('a1');
    expect(doseAnsweringReminder({ ...base, doses: [unassigned], used: new Set(['a1']) })).toBeNull();
  });
});

describe('the insulin excess of any meal with a bolus', () => {
  it('compares the carbs the insulin was given for with the meal\'s carbs now', async () => {
    const { mealDoseExcess, mealExcessLine } = await import('./application/split-bolus');
    const own = { purpose: 'NEW_MEAL', carbs_g: 45, bolus_units: 4.5 };
    expect(mealDoseExcess({ actions: [own], meal_carbs_g: 35 })).toEqual({ grams: 10, insulin_u: 1 });
    // A dose reduced on purpose stays reduced: the excess is in proportion.
    expect(mealDoseExcess({ actions: [{ ...own, bolus_units: 3 }], meal_carbs_g: 30 })).toEqual({ grams: 15, insulin_u: 1 });
    // An add-on with its own bolus counts; insulin alone, a refused bolus or more carbs now do not.
    expect(mealDoseExcess({ actions: [own, { purpose: 'MEAL_ADDITION', carbs_g: 15, bolus_units: 1.5 }], meal_carbs_g: 50 })).toEqual({ grams: 10, insulin_u: 1 });
    expect(mealDoseExcess({ actions: [{ ...own, bolus_units: null }], meal_carbs_g: 20 })).toBeNull();
    expect(mealDoseExcess({ actions: [own, { purpose: 'MEAL_ADDITION', carbs_g: null, bolus_units: 2 }], meal_carbs_g: 45 })).toBeNull();
    expect(mealDoseExcess({ actions: [own], meal_carbs_g: 60 })).toBeNull();
    expect(mealDoseExcess({ actions: [own], meal_carbs_g: null })).toBeNull();
    expect(mealExcessLine(10, 1, 'MEAL')).toBe('Posiłek ma teraz o 10 g węglowodanów mniej, niż było, gdy podano insulinę: podana insulina była o ok. 1 j za duża. Sprawdź glukozę.');
  });
});

describe('a later part lowered by the loop-style calculator (dose-calculator.v1)', () => {
  const nowIso = '2026-10-20T13:30:00.000Z';
  const minutesBefore = (minutes: number) => new Date(Date.parse(nowIso) - minutes * 60_000).toISOString();
  const forecast = (glucose: number, per5: number, iob = 2) => ({
    readings: [16, 11, 6, 1].map((minutes, index) => ({ at: minutesBefore(minutes), value: glucose - per5 * (3 - index) })),
    prediction: {
      source: 'OPENAPS' as const, system: 'TRIO' as const, computed_at: minutesBefore(1), bg: glucose, carbs_req_g: null, iob_u: iob, cob_g: 30,
      isf_mgdl_per_u: 100, icr_g_per_u: 10, eventual_bg: glucose, target_mgdl: 100, curves: { IOB: [glucose, glucose, glucose, glucose, glucose, glucose, glucose] },
    },
    profile_isf: 100, profile_target: 100, profile_units: 'mg/dl',
    calibration: { ...GLUCOSE_FORECAST_CALIBRATION, version: 'test-none', shrink_by_minutes: { 5: 1 } },
  });
  const part = { kind: 'SPLIT' as const, carbs_g: 20, first_carbs_g: 40, first_insulin_u: 4, dose_carbs_g: null, drop_cover_g: null, fixed_insulin_u: null, subtract_first_insulin: false };
  const base = {
    meal_started_at: '2026-10-20T12:30:00.000Z', now_iso: nowIso, events: [], step: 0.05, fallback_time_zone: 'Europe/Warsaw', icr_at: scheduleValueAt,
    therapy: { timezone: 'Europe/Warsaw', carb_ratio_g_per_u: [['00:00', 10]], basal_u_per_h: null } as never,
  };

  it('keeps the planned dose at or above target (IOB and COB of the meal are not counted again), lowers it when glucose falls', () => {
    // 20 g / 10 = 2 j; glucose 160 steady: no change, IOB 2 j of the first part is not taken off again.
    expect(estimatePlannedBolus({ ...base, plan: part, forecast: forecast(160, 0) })).toMatchObject({ insulin_u: 2, dose_before_calculator_u: 2, dose_calculation: { limited_by: 'ICR' } });
    // 100 falling 8 per 5 min: 2 + (100 − 24 − 100) / 100 = 1,76 → 1,75 j.
    const falling = estimatePlannedBolus({ ...base, plan: part, forecast: forecast(100, -8) });
    expect(falling.insulin_u).toBeLessThanOrEqual(1.75);
    expect(falling.dose_before_calculator_u).toBe(2);
    expect(plannedBolusCalculatorLine(falling)).toMatch(/^(↓ 0,\d+\u00a0j mniej niż z planu \(2\u00a0j\)|0\u00a0j zamiast 2\u00a0j z planu): /);
    // Below 70: 0 j, carbs first.
    const low = estimatePlannedBolus({ ...base, plan: part, forecast: forecast(66, 0) });
    expect(low).toMatchObject({ insulin_u: 0, dose_calculation: { limited_by: 'CARBS_FIRST' } });
    expect(plannedBolusPushContent({ description: 'Pizza', carbs_g: 20, estimate_u: low.insulin_u, low_glucose: 66, calculator_line: plannedBolusCalculatorLine(low) }).body).toContain('0\u00a0j zamiast 2\u00a0j z planu: niska glukoza — najpierw węglowodany');
    // A dose the caregiver named stays theirs.
    expect(estimatePlannedBolus({ ...base, plan: { ...part, fixed_insulin_u: 1.5 }, forecast: forecast(66, 0) })).toMatchObject({ insulin_u: 1.5 });
    // Without forecast data: as before.
    expect(estimatePlannedBolus({ ...base, plan: part })).not.toHaveProperty('dose_calculation');
  });

  it('a calculator that throws is logged and the push says to check the dose by hand (review M4)', () => {
    const logged: string[] = [];
    const original = console.warn;
    console.warn = (line: string) => { logged.push(line); };
    let broken;
    try {
      broken = estimatePlannedBolus({ ...base, plan: part, forecast: { ...forecast(160, 0), readings: null } as never });
    } finally {
      console.warn = original;
    }
    expect(broken).toMatchObject({ insulin_u: 2, dose_calculation: null, calculator_failed: true });
    expect(plannedBolusCalculatorLine(broken)).toBe('Kalkulator dawki niedostępny — sprawdź dawkę ręcznie.');
    expect(JSON.parse(logged[0])).toMatchObject({ event: 'dose_safety_check_failed', where: 'split-bolus.estimate', error_class: 'TypeError' });
  });
});
