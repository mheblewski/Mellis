import { describe, expect, it } from 'vitest';
import { buildTherapyNow, polishAge } from './therapy-now';

const AT = '2026-10-26T17:40:00.000Z';
const TZ = 'Europe/Warsaw';

const orefStatus = (minutesAgo: number) => {
  const at = new Date(Date.parse(AT) - minutesAgo * 60_000).toISOString();
  return {
    observed_at: at,
    raw_payload: {
      device: 'Trio',
      openaps: {
        suggested: { timestamp: at, bg: 140, eventualBG: 95, carbsReq: 12, insulinReq: -0.4, IOB: 2.35, COB: 18, current_target: 100, reason: 'minGuardBG 68, minPredBG 82', predBGs: { IOB: [140, 130, 120, 110, 100, 90, 80] } },
        enacted: { timestamp: at, rate: 0, duration: 30 },
      },
    },
  };
};

const plan = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1', kind: 'SPLIT', patient_id: 'pt', meal_record_id: 'm', proposal_id: null, conversation_id: null, first_command_id: null,
  first_carbs_g: 30, first_insulin_u: 3, carbs_g: 20, planned_insulin_u: 1.5, icr_g_per_u: 10, now_percent: 60, delay_minutes: 60,
  due_at: '2026-10-26T18:10:00.000Z', status: 'SCHEDULED', notified_at: null, resolved_at: null, resolved_by_user_id: null, resolved_by_name: null,
  given_command_id: null, given_loop_action_id: null, given_insulin_u: null, created_at: AT, trigger: 'AFTER_MINUTES', threshold_mgdl: null,
  dose_carbs_g: null, fixed_insulin_u: null, drop_cover_g: null, subtract_first_insulin: false, wait_until: null, ...overrides,
}) as any;

describe('therapy now (therapy-now.v1)', () => {
  it('describes the loop\'s last calculation, its temp basal and how old it is', () => {
    const now = buildTherapyNow({ atIso: AT, timeZone: TZ, loopStatus: orefStatus(4), plannedBoluses: [], reminders: [], rescueAlert: null });
    expect(now.loop).toEqual({
      system: 'Trio', calculated_at_local: '2026-10-26 18:36', age_minutes: 4, stale: false,
      eventual_bg_mgdl: 95, min_predicted_bg_mgdl: 68, carbs_req_g: 12, insulin_req_u: -0.4, iob_u: 2.35, cob_g: 18, target_mgdl: 100,
      temp_basal: { rate_u_per_h: 0, duration_minutes: 30, set_at_local: '2026-10-26 18:36' },
    });
    expect(buildTherapyNow({ atIso: AT, timeZone: TZ, loopStatus: orefStatus(40), plannedBoluses: [], reminders: [], rescueAlert: null }).loop).toMatchObject({ age_minutes: 40, stale: true });
    expect(buildTherapyNow({ atIso: AT, timeZone: TZ, loopStatus: null, plannedBoluses: [], reminders: [], rescueAlert: null }).loop).toBeNull();
  });

  it('reads Loop\'s calculation: its forecast, IOB, COB, temp basal and bolus recommendation, and no oref fields', () => {
    const at = new Date(Date.parse(AT) - 3 * 60_000).toISOString();
    const loopStatus = {
      observed_at: at,
      raw_payload: {
        device: 'loop://iPhone',
        loop: {
          name: 'Loop', version: '3.14.11', timestamp: at,
          iob: { timestamp: at, iob: 1.2 }, cob: { timestamp: at, cob: 25 },
          predicted: { startDate: at, values: [150, 148, 140, 130, 118, 110] },
          recommendedBolus: 0.35,
          enacted: { rate: 0.35, duration: 30, timestamp: at, received: true },
        },
      },
    };
    expect(buildTherapyNow({ atIso: AT, timeZone: TZ, loopStatus, plannedBoluses: [], reminders: [], rescueAlert: null }).loop).toEqual({
      system: 'Loop', calculated_at_local: '2026-10-26 18:37', age_minutes: 3, stale: false,
      eventual_bg_mgdl: 110, min_predicted_bg_mgdl: 110, carbs_req_g: null, insulin_req_u: null, recommended_bolus_u: 0.35, iob_u: 1.2, cob_g: 25, target_mgdl: null,
      temp_basal: { rate_u_per_h: 0.35, duration_minutes: 30, set_at_local: '2026-10-26 18:37' },
    });
  });

  it('lists open later parts, deferred doses and active reminders in time order, and the open rescue alert', () => {
    const now = buildTherapyNow({
      atIso: AT, timeZone: TZ, loopStatus: null,
      plannedBoluses: [plan(), plan({ id: 'p2', kind: 'DEFERRED_INSULIN', trigger: 'GLUCOSE_STOPPED_FALLING', due_at: '2026-10-26T17:50:00.000Z', fixed_insulin_u: 2 }), plan({ id: 'p3', status: 'GIVEN' })],
      reminders: [{ id: 'r1', patient_id: 'pt', conversation_id: null, user_message_id: null, created_by_user_id: null, note: 'Sprawdź cukier', trigger: 'AT_TIME', due_at: '2026-10-26T19:00:00.000Z', threshold_mgdl: null, wait_until: null, status: 'ACTIVE', fired_at: null, fired_reason: null, fired_glucose_mgdl: null, cancelled_at: null, cancelled_by_user_id: null, created_at: AT }],
      rescueAlert: { status: 'NOTIFIED', level: 'PREDICTED_LOW', first_flag_at: AT, notified_at: AT, proposal: { carbs_g: 8 }, treated_at: null, treatment_carbs_g: null, declined_at: null } as any,
    });
    expect(now.open_plans).toEqual([
      { kind: 'DEFERRED_BOLUS', trigger: 'GLUCOSE_STOPPED_FALLING', due_local: '2026-10-26 18:50', carbs_g: 20, insulin_u_estimate: 2 },
      { kind: 'LATER_BOLUS_PART', trigger: 'AFTER_MINUTES', due_local: '2026-10-26 19:10', carbs_g: 20, insulin_u_estimate: 1.5 },
      { kind: 'REMINDER', trigger: 'AT_TIME', due_local: '2026-10-26 20:00', note: 'Sprawdź cukier' },
    ]);
    expect(now.active_rescue_alert).toEqual({ level: 'PREDICTED_LOW', status: 'NOTIFIED', detected_local: '2026-10-26 18:40', proposed_carbs_g: 8, treated: null, declined: false });
  });

  it('says what Trio set and logged: a running target, site and sensor age, a suspended pump, recent notes', () => {
    const event = (kind: string, minutesAgo: number, extra: Record<string, unknown> = {}) => ({ source_record_id: kind, kind, event_type: kind, occurred_at: new Date(Date.parse(AT) - minutesAgo * 60_000).toISOString(), duration_minutes: null, details: {}, ...extra }) as any;
    const now = buildTherapyNow({
      atIso: AT, timeZone: TZ, loopStatus: null, plannedBoluses: [], reminders: [], rescueAlert: null,
      contextEvents: {
        latest: [
          event('TEMP_TARGET', 30, { duration_minutes: 60, details: { target_top: 140, target_bottom: 140, reason: 'Activity' } }),
          event('OVERRIDE', 300, { duration_minutes: 60 }),
          event('SITE_CHANGE', 80 * 60),
          event('SENSOR_CHANGE', 5 * 60),
          event('PUMP_SUSPEND', 10),
          event('PUMP_RESUME', 60),
        ],
        notes: [event('NOTE', 20, { details: { notes: 'Command rejected: max IOB' } })],
      },
    });
    expect(now.context).toEqual({
      active: [{ kind: 'TEMP_TARGET', since_local: '2026-10-26 18:10', until_local: '2026-10-26 19:10', details: { target_top: 140, target_bottom: 140, reason: 'Activity' } }],
      profile_switch: null,
      site_age_hours: 80,
      sensor_age_hours: 5,
      reservoir_age_hours: null,
      site_age_text: '3 dni i 8 godzin',
      sensor_age_text: '5 godzin',
      reservoir_age_text: null,
      pump_suspended_since_local: '2026-10-26 18:30',
      recent_notes: [{ at_local: '2026-10-26 18:20', text: 'Command rejected: max IOB' }],
    });
  });
});

describe('polishAge', () => {
  it('says the age in days and hours with Polish plural forms', () => {
    expect(polishAge(null)).toBeNull();
    expect(polishAge(0)).toBe('0 godzin');
    expect(polishAge(1)).toBe('1 godzina');
    expect(polishAge(3)).toBe('3 godziny');
    expect(polishAge(5)).toBe('5 godzin');
    expect(polishAge(12)).toBe('12 godzin');
    expect(polishAge(22)).toBe('22 godziny');
    expect(polishAge(24)).toBe('1 dzień');
    expect(polishAge(25)).toBe('1 dzień i 1 godzina');
    expect(polishAge(46)).toBe('1 dzień i 22 godziny');
    expect(polishAge(51)).toBe('2 dni i 3 godziny');
    expect(polishAge(114)).toBe('4 dni i 18 godzin');
  });
});
