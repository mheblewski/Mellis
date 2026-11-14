import { isfToMgdl } from '@modules/glucose-forecast/application/isf-units';
import { buildGlucoseForecast, mainLoopCurve } from '@modules/glucose-forecast/application/glucose-forecast';
import { bolusLineForApp } from '@modules/glucose-forecast/application/prediction-service';
import { parseLoopPrediction, type LoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { readEnactedTempBasal, readLoopValues } from '@modules/loop-system/application/loop-status';
import { detectLoopSystem } from '@modules/loop-system/domain/loop-system';
import { scheduleValueAt } from '@modules/meal-wbt/application/wbt-policy';
import { RESCUE_DETECTION_POLICY, evaluateRescueNeedV2, type LowRiskVerdict, type RescueEvaluation } from '@modules/rescue-carbs/application/rescue-detection';
import { readLowRisk } from '@modules/rescue-carbs/application/rescue-carb-alert.service';
import { computeRescueDose } from '@modules/rescue-carbs/application/rescue-dose';
import type { RescueAlertRecord } from '@modules/rescue-carbs/application/rescue-alert-policy';
import { isRescueCarbAlertsEnabled, RESCUE_CARB_ENTRY_SOURCE } from '@modules/rescue-carbs/application/rescue-carbs-store';
import { resolveHomeTimeZone } from '@shared/primitives/home-time-zone';
import type { DashboardDeviceStatus, DashboardResponse } from './dashboard-snapshot';
import { dayLines, NOW_DAY_LINES_POLICY } from './now-day-lines';
import { NOW_SITUATION_POLICY, dayLinesAllowed, decideCheckPush, decideNowSituation, fallbackNowSituation, isNowSituationEnabled, caregiverGender, lightFact, type NowCheckPush, type NowCarbEntry, type NowRemoteBolus, type NowLoopSnapshot, type NowPlannedMeal, type NowSituation, type NowSituationInput } from './now-situation';
import type { MealPlanEntry } from '@modules/meal-plan/application/meal-plan';

const MINUTE_MS = 60_000;
const DETECTION_READINGS_MINUTES = 45;
const LOOP_HISTORY_MINUTES = 150;
const CARBS_HISTORY_HOURS = 24;
const ALERTS_HISTORY_MINUTES = 60;
const BOLUS_PROBLEM_MINUTES = 180;
/** Remote boluses read for the caregiver's bolus sentence (20 min) and its matching. */
const REMOTE_BOLUS_MINUTES = 60;
/** A light fact never stands within this long of a bolus or carbs (v3 row 25, role review 2026-11-08). */
const LIGHT_FACT_QUIET_MINUTES = 120;

type TherapyProfile = {
  birth_year?: number | null;
  units?: string | null;
  timezone?: string | null;
  carb_ratio_g_per_u?: Array<[string, number]> | null;
  sensitivity_per_u?: Array<[string, number]> | null;
};

export interface NowSituationDeps {
  /** The low-risk model's fresh verdict while it is the predicted-low source (as the rescue alert reads it). */
  lowRisk?(patientId: string, now: Date): Promise<LowRiskVerdict | null>;
  dashboards: {
    listLoopSnapshotsBetween(patientId: string, fromIso: string, toIso: string): Promise<DashboardDeviceStatus[]>;
    listSituationCarbEntries(patientId: string, fromIso: string, toIso: string): Promise<Array<{ event_id?: string | null; occurred_at: Date | string; carbs: string | number | null; kind: string | null; entry_source: string | null; in_loop: string | boolean | null; by_user_id: string | null; by_name: string | null; by_gender?: string | null }>>;
    /** Remote boluses the loop confirmed since then, with their senders (v4). */
    listRemoteBolusesSince?(patientId: string, sinceIso: string): Promise<NowRemoteBolus[]>;
    getPatientLabel(patientId: string): Promise<string | null>;
    /** A remote bolus since then that did not finish cleanly. */
    hasBolusProblemSince?(patientId: string, sinceIso: string): Promise<boolean>;
    /** Linia dnia only. */
    listGlucoseReadingsBetween?(patientId: string, fromIso: string, toIso: string): Promise<Array<{ at: string; value: number }>>;
  };
  alerts: {
    getActiveAlert(patientId: string): Promise<RescueAlertRecord | null>;
    listAlertsNotifiedSince(patientId: string, sinceIso: string): Promise<string[]>;
    getRecentEatenCarbs(patientId: string, fromIso: string, toIso: string): Promise<{ last_carbs_at: string | null; last_hypo_treatment_at: string | null }>;
    /** Keys of the check pushes sent since then (now_situation_check_pushes). */
    listCheckPushKeys?(patientId: string, sinceIso: string): Promise<string[]>;
  };
  therapy: { getTherapyProfileAt(patientId: string, atIso: string): Promise<unknown> };
  /** Planned meals for Teraz's meal sentence (v5); absent (the worker's checks): none is read. */
  mealPlans?: { listBetween(patientId: string, fromIso: string, toIso: string): Promise<MealPlanEntry[]> };
  log?(event: Record<string, unknown>): void;
}

/** Planned meals around now as Teraz reads them (v5): PLANNED meals only, a paused one is not planned. */
export function plannedMealsFromEntries(entries: MealPlanEntry[]): NowPlannedMeal[] {
  return entries
    .filter((entry) => entry.kind === 'MEAL' && entry.status === 'PLANNED' && !entry.paused)
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      planned_at: entry.planned_at,
      items: entry.items.map((item) => item.name),
      answered: entry.dose_answer !== null || entry.eaten_answer !== null,
    }));
}

export function snapshotFromStatus(status: DashboardDeviceStatus): NowLoopSnapshot {
  const values = readLoopValues(status.raw_payload);
  return { at: status.observed_at, iob_u: values.iob_u, cob_g: values.cob_g, rate_u_per_h: readEnactedTempBasal(status.raw_payload)?.rate_u_per_h ?? null };
}

export function carbEntryFromRow(row: Awaited<ReturnType<NowSituationDeps['dashboards']['listSituationCarbEntries']>>[number]): NowCarbEntry | null {
  const grams = Number(row.carbs);
  if (!Number.isFinite(grams) || grams <= 0) return null;
  const known = row.kind === 'HYPO_TREATMENT' || row.kind === 'MEAL' || row.kind === 'CORRECTION_CARBS' ? row.kind : null;
  return {
    id: row.event_id ?? null,
    at: new Date(row.occurred_at).toISOString(),
    grams,
    kind: known,
    source: row.entry_source === RESCUE_CARB_ENTRY_SOURCE ? 'MELLIS' : 'LOOP',
    by_user_id: row.by_user_id,
    by_name: row.by_name,
    by_gender: caregiverGender(row.by_gender),
  };
}

/** A low with too few readings gets no level from the evaluation, yet its dose must be the dose for that low. */
function evaluationForDose(evaluation: RescueEvaluation): RescueEvaluation {
  const value = evaluation.glucose?.value;
  if (evaluation.status !== 'NO_DATA' || evaluation.no_data_reason !== 'TOO_FEW_READINGS' || value === undefined) return evaluation;
  if (value < RESCUE_DETECTION_POLICY.urgent_mgdl) return { ...evaluation, level: 'URGENT_LOW' };
  if (value < RESCUE_DETECTION_POLICY.low_mgdl) return { ...evaluation, level: 'LOW_NOW' };
  return evaluation;
}

/**
 * Reads what now-situation.v1 needs next to the dashboard. The evaluation and the dose run on the readings and the loop
 * status the dashboard itself shows, and on demand, so a low with alerts switched off has a dose too. Fails open: without
 * a situation the app draws today's hero.
 */
export class NowSituationService {
  constructor(private readonly deps: NowSituationDeps) {}

  async situation(args: {
    patientId: string;
    viewerUserId: string | null;
    now: Date;
    dashboard: DashboardResponse;
    sources: { readings: Array<{ at: string; value: number }>; loopStatus: DashboardDeviceStatus | null };
  }): Promise<NowSituation> {
    try {
      const input = await this.input(args);
      const situation = decideNowSituation(input);
      const lines = dayLinesAllowed(input, situation) ? await this.dayLinesFor(args.patientId, input) : null;
      const sent = lines ? { ...situation, day_lines: lines.lines, ...(lines.fact ? { light_fact: lines.fact } : {}) } : situation;
      // Builds up to 1632 read an empty sentence as no answer ("Mellis nie może pobrać danych", owner's screen 15:18):
      // nothing to say goes out as one space, which every build takes as an answer and draws as nothing.
      return sent.sentence === '' ? { ...sent, sentence: ' ' } : sent;
    } catch (error) {
      this.deps.log?.({ event: 'now_situation_failed', patient_id: args.patientId, error: error instanceof Error ? error.message : String(error) });
      const loopStatus = args.sources.loopStatus;
      const fallback = fallbackNowSituation(args.dashboard.glucose, args.now, loopStatus ? detectLoopSystem(loopStatus.raw_payload).kind : 'UNKNOWN');
      return fallback.sentence === '' ? { ...fallback, sentence: ' ' } : fallback;
    }
  }

  /** Never costs the screen its sentence. Reads two weeks only here, when a line may stand at all. */
  private async dayLinesFor(patientId: string, input: NowSituationInput): Promise<{ lines: string[]; fact: string | null }> {
    try {
      if (!this.deps.dashboards.listGlucoseReadingsBetween) return { lines: [], fact: null };
      const dayMs = 24 * 60 * MINUTE_MS;
      const fromMs = input.now.getTime() - NOW_DAY_LINES_POLICY.history_days * dayMs;
      const [readings, carbRows] = await Promise.all([
        this.deps.dashboards.listGlucoseReadingsBetween(patientId, new Date(fromMs).toISOString(), new Date(input.now.getTime() + 1).toISOString()),
        this.deps.dashboards.listSituationCarbEntries(patientId, new Date(fromMs).toISOString(), new Date(input.now.getTime() + 1).toISOString()),
      ]);
      const entries = carbRows.map(carbEntryFromRow).filter((entry): entry is NowCarbEntry => entry !== null);
      const rescueMs = entries.filter((entry) => entry.kind === 'HYPO_TREATMENT' || entry.source === 'MELLIS').map((entry) => Date.parse(entry.at));
      const meals = entries.filter((entry) => entry.kind === 'MEAL').map((entry) => ({
        at: entry.at,
        rescue_near: rescueMs.some((ms) => ms >= Date.parse(entry.at) && ms <= Date.parse(entry.at) + NOW_DAY_LINES_POLICY.meal_peak_minutes * MINUTE_MS),
      }));
      const lines = dayLines({ now: input.now, time_zone: input.time_zone, readings, meals });
      const quietFromMs = input.now.getTime() - LIGHT_FACT_QUIET_MINUTES * MINUTE_MS;
      const doseNear = [...input.boluses, ...input.carbs].some((dose) => Date.parse(dose.at) >= quietFromMs);
      const fact = doseNear ? null : lightFact(input.now, input.time_zone);
      // Owner, 2026-11-08: the facts only here, in full calm, and only in two hours of the day.
      return { lines: [...(input.loop.snapshots.at(-1)?.cob_g ? [...lines.during_meal, ...lines.any] : lines.any), ...(fact ? [fact] : [])], fact };
    } catch (error) {
      this.deps.log?.({ event: 'now_day_lines_failed', patient_id: patientId, error: error instanceof Error ? error.message : String(error) });
      return { lines: [], fact: null };
    }
  }

  /** The push after a check, for the worker; null when none is due. */
  async checkPush(args: Parameters<NowSituationService['situation']>[0]): Promise<NowCheckPush | null> {
    const input = await this.input(args);
    const since = new Date(args.now.getTime() - 3 * 60 * MINUTE_MS).toISOString();
    const sent = (await this.deps.alerts.listCheckPushKeys?.(args.patientId, since)) ?? [];
    return decideCheckPush({ ...input, sent_check_push_keys: sent });
  }

  private async input(args: Parameters<NowSituationService['situation']>[0]): Promise<NowSituationInput> {
    const { patientId, now, dashboard, sources } = args;
    const nowIso = now.toISOString();
    const untilIso = new Date(now.getTime() + 1).toISOString();
    const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * MINUTE_MS).toISOString();
    const [statuses, carbRows, label, alert, notifiedAt, recentCarbs, therapyRaw, bolusProblem, remoteBoluses] = await Promise.all([
      this.deps.dashboards.listLoopSnapshotsBetween(patientId, minutesAgo(LOOP_HISTORY_MINUTES), untilIso),
      this.deps.dashboards.listSituationCarbEntries(patientId, minutesAgo(CARBS_HISTORY_HOURS * 60), untilIso),
      this.deps.dashboards.getPatientLabel(patientId),
      this.deps.alerts.getActiveAlert(patientId),
      this.deps.alerts.listAlertsNotifiedSince(patientId, minutesAgo(CARBS_HISTORY_HOURS * 60 + ALERTS_HISTORY_MINUTES)),
      this.deps.alerts.getRecentEatenCarbs(patientId, minutesAgo(RESCUE_DETECTION_POLICY.recent_carbs_minutes), nowIso),
      this.deps.therapy.getTherapyProfileAt(patientId, nowIso),
      this.deps.dashboards.hasBolusProblemSince?.(patientId, minutesAgo(BOLUS_PROBLEM_MINUTES)) ?? Promise.resolve(false),
      this.deps.dashboards.listRemoteBolusesSince?.(patientId, minutesAgo(REMOTE_BOLUS_MINUTES)) ?? Promise.resolve([] as NowRemoteBolus[]),
    ]);
    // Never costs the screen its sentence: without the plan, nothing is said about one.
    const plannedMeals = this.deps.mealPlans
      ? await this.deps.mealPlans.listBetween(patientId, minutesAgo(NOW_SITUATION_POLICY.meal_late_until_minutes + 1), new Date(now.getTime() + (NOW_SITUATION_POLICY.meal_soon_minutes + 1) * MINUTE_MS).toISOString())
        .then(plannedMealsFromEntries)
        .catch(() => undefined)
      : undefined;
    const therapy = therapyRaw as TherapyProfile | null;
    const timeZone = therapy?.timezone ?? resolveHomeTimeZone();

    const prediction: LoopPrediction | null = parseLoopPrediction(sources.loopStatus);
    const recent = sources.readings.filter((reading) => Date.parse(reading.at) >= now.getTime() - DETECTION_READINGS_MINUTES * MINUTE_MS);
    // The same verdict as the rescue alert, so Teraz and the push say the same thing.
    const lowRisk = await readLowRisk(this.deps, patientId, now);
    const evaluation = evaluateRescueNeedV2({ now, readings: recent, prediction, last_carbs_at: recentCarbs.last_carbs_at, last_hypo_treatment_at: recentCarbs.last_hypo_treatment_at, low_risk: lowRisk });
    const profileIsf = therapy ? scheduleValueAt(therapy.sensitivity_per_u ?? null, nowIso, timeZone) : null;
    const dose = computeRescueDose({
      evaluation: evaluationForDose(evaluation),
      loop: prediction,
      profile: { isf: profileIsf, icr_g_per_u: therapy ? scheduleValueAt(therapy.carb_ratio_g_per_u ?? null, nowIso, timeZone) : null, units: therapy?.units ?? null },
      birth_year: therapy?.birth_year ?? null,
    });

    // The live status may be newer than the last synced one.
    const snapshots = statuses.map(snapshotFromStatus);
    if (sources.loopStatus && !snapshots.some((snapshot) => snapshot.at === sources.loopStatus!.observed_at)) {
      snapshots.push(snapshotFromStatus(sources.loopStatus));
      snapshots.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    }

    const forecast = buildGlucoseForecast({ now, readings: recent, prediction });
    const curve = mainLoopCurve(forecast);
    return {
      now,
      time_zone: timeZone,
      viewer_user_id: args.viewerUserId,
      patient_label: label,
      readings: sources.readings,
      loop: {
        system: sources.loopStatus ? detectLoopSystem(sources.loopStatus.raw_payload).kind : 'UNKNOWN',
        snapshots,
        plan_rate_u_per_h: dashboard.insulin?.basal_now?.plan_rate ?? null,
        rate_now: dashboard.insulin?.basal_now
          ? { rate_u_per_h: dashboard.insulin.basal_now.rate, since: dashboard.insulin.basal_now.since }
          : null,
      },
      loop_curve: curve,
      chart_line: (bolusLineForApp(now, { readings: sources.readings, loopStatus: sources.loopStatus })?.points ?? []).map((point) => ({ at: point.at, value: point.value, low: point.low, high: point.high })),
      // Trio does not send its insulin curve (insulin-curve.ts): owner, 2026-11-08, no guessed peak, so no peak sentence.
      insulin_peak_minutes: null,
      isf_mgdl_per_u: isfToMgdl(prediction?.isf_mgdl_per_u ?? profileIsf, therapy?.units ?? null),
      boluses: dashboard.insulin?.boluses ?? [],
      remote_boluses: remoteBoluses,
      smbs: dashboard.insulin?.smbs ?? [],
      carbs: carbRows.map(carbEntryFromRow).filter((entry): entry is NowCarbEntry => entry !== null),
      sensor_changed_at: dashboard.sensor_started_at,
      site_changed_at: dashboard.site_changed_at ?? null,
      pump_suspended_since: dashboard.insulin?.basal_now?.source === 'SUSPENDED' ? dashboard.insulin.basal_now.since ?? nowIso : null,
      bolus_problem: bolusProblem,
      trend_direction: dashboard.glucose?.direction ?? null,
      override: dashboard.insulin?.basal_now?.override ?? null,
      reservoir_hours_left: dashboard.pump?.reservoir_hours_left ?? null,
      evaluation,
      dose,
      alert: alert?.status === 'NOTIFIED' && alert.notified_at
        ? { notified_at: alert.notified_at, last_triggered_at: alert.situation_last_triggered_at ?? null, grams_since: alert.situation_grams_since ?? null, grams: alert.proposal?.carbs_g ?? null }
        : null,
      recent_alerts_notified_at: notifiedAt,
      forecast_peak_mgdl: curve.length > 0 ? Math.max(...curve.map((point) => point.value)) : null,
      // The promise only while the worker that keeps it runs.
      check_push_live: isNowSituationEnabled() && isRescueCarbAlertsEnabled(),
      planned_meals: plannedMeals,
    };
  }
}
