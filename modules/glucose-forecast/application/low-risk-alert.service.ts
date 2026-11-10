import type { GlucosePoint } from './cgm-trend';
import type { LowRiskVerdict } from '@modules/rescue-carbs/application/rescue-detection';
import { isPredictionExperimentEnabled, predictionFlagOn } from './prediction-engine';
import { buildLowRiskRows, fitLowRisk, lowRiskScore, LOW_RISK_MODEL_ID, LOW_RISK_POLICY, type LowRiskParams } from './low-risk';
import { compareLowWarnings, LOW_COMPARISON_POLICY, lowComparisonPushText, type LowComparison, type LowComparisonRow } from './low-risk-comparison';

export const LOW_RISK_ALERT_POLICY = {
  tick_ms: 60_000,
  refit_after_hours: 20,
  retention_days: 60,
  /** No alarm from a reading older than this. */
  max_reading_age_minutes: 10,
  /** Looked at each tick to notice a new reading cheaply. */
  newest_window_minutes: 20,
} as const;

/**
 * Owner decision 2026-11-08: RESCUE_PREDICTED_LOW_SOURCE=low-risk makes the model the rescue alert's predicted low (one
 * push, the usual rescue one), and its own experimental push stops. Off, or without a fresh score: rescue-carbs.v2.1.
 */
export function isLowRiskRescueSource(env: Record<string, string | undefined>): boolean {
  return isPredictionExperimentEnabled(env)
    && predictionFlagOn(env, 'PREDICTION_LOW_ALERT_ENABLED')
    && /^low-risk$/i.test(String(env.RESCUE_PREDICTED_LOW_SOURCE ?? '').trim());
}

/**
 * Owner decision 2026-11-09: the fit leaves out "no low" moments near pushed alerts, so the model does not unlearn the
 * lows its own alerts helped to stop. Off with PREDICTION_LOW_CENSOR_ALERTS=false (or 0): the next tick refits without.
 */
export function isLowRiskCensorEnabled(env: Record<string, string | undefined>): boolean {
  return predictionFlagOn(env, 'PREDICTION_LOW_CENSOR_ALERTS');
}

/** The newest score as the rescue alert reads it: null when none is fresh, so v2 decides. */
export function lowRiskVerdictOf(row: { reading_at: string; score: number; threshold: number; alarm: boolean } | null, now: Date): LowRiskVerdict | null {
  if (!row) return null;
  if (now.getTime() - Date.parse(row.reading_at) > LOW_RISK_ALERT_POLICY.max_reading_age_minutes * 60_000) return null;
  return { alarm: row.alarm, reading_at: row.reading_at, score: row.score, threshold: row.threshold };
}

export interface LowRiskScoreEntry {
  patient_id: string;
  reading_at: string;
  model_id: string;
  glucose_mgdl: number;
  score: number;
  threshold: number;
  alarm: boolean;
}

export interface LowRiskStore {
  /** Patients with the prediction experiment on: each is scored, whoever decides their alert. */
  listPatients(): Promise<string[]>;
  /** The model may decide this patient's predicted-low alert (someone is listed). Absent: as the server's switch says. */
  decidesAlert?(patientId: string): Promise<boolean>;
  listPushTokens(patientId: string): Promise<string[]>;
  getParams(patientId: string): Promise<{ params: LowRiskParams; stored_at: string } | null>;
  saveParams(patientId: string, params: LowRiskParams, now: Date): Promise<void>;
  lastScoredAt(patientId: string): Promise<string | null>;
  lastAlarmAt(patientId: string): Promise<string | null>;
  /** False when this reading was already scored. */
  logScore(entry: LowRiskScoreEntry): Promise<boolean>;
  markPushed(entry: LowRiskScoreEntry, pushedTo: number): Promise<void>;
  prune(before: Date): Promise<void>;
  /** The newest score of the current model, if any. */
  latestScore?(patientId: string): Promise<{ reading_at: string; score: number; threshold: number; alarm: boolean } | null>;
  /** The comparison of the two ways of warning (low-comparison.v1). Absent: none is made. */
  comparison?: {
    rows(patientId: string): Promise<LowComparisonRow[]>;
    /** Stores the result; true when the owners were not yet told it is ready. */
    save(patientId: string, result: LowComparison, now: Date): Promise<{ notified: boolean }>;
    listOwnerPushTokens(patientId: string): Promise<string[]>;
    markNotified(patientId: string, now: Date): Promise<void>;
  };
}

export interface LowRiskDeps {
  store: LowRiskStore;
  /** The model feeds the rescue alert instead (isLowRiskRescueSource): scores are kept, its own push is not sent. */
  scoreOnly?: boolean;
  readingsSince(patientId: string, sinceIso: string): Promise<GlucosePoint[]>;
  carbTimes(patientId: string, fromIso: string, toIso: string): Promise<string[]>;
  /** Times of pushed low alerts (rescue alerts and the model's own). Absent: the fit uses every moment, as before 2026-11-09. */
  alertTimes?(patientId: string, sinceIso: string): Promise<string[]>;
  push: {
    sendGlucoseAlert(input: { patientId: string; pushToken: string; kind: string; title: string; body: string }): Promise<void>;
    sendPredictionComparison?(input: { patientId: string; pushToken: string; title: string; body: string }): Promise<void>;
  };
  log?: (event: Record<string, unknown>) => void;
}

/** "92, −6 w 5 min." with the change only when two readings are close enough to tell it. */
export function lowRiskPushText(glucose: number, delta: number | null): { title: string; body: string } {
  const change = delta === null ? '' : `, ${delta > 0 ? '+' : delta < 0 ? '−' : ''}${Math.abs(delta)} w 5 min`;
  return {
    title: 'Test modelu: możliwy spadek',
    body: `${glucose}${change}. To prognoza testowa, porównaj ją z wykresem.`,
  };
}

export class LowRiskAlertService {
  constructor(private readonly deps: LowRiskDeps) {}

  async tick(now: Date): Promise<void> {
    for (const patientId of await this.deps.store.listPatients()) {
      try {
        const params = await this.refitIfDue(patientId, now);
        if (params) await this.scoreNewest(patientId, params, now);
        await this.compareIfDue(patientId, now);
      } catch (error) {
        this.deps.log?.({ event: 'low_risk_tick_failed', patient_id: patientId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async refitIfDue(patientId: string, now: Date): Promise<LowRiskParams | null> {
    const stored = await this.deps.store.getParams(patientId);
    const age = stored ? now.getTime() - Date.parse(stored.stored_at) : Infinity;
    // A fit made the other way (with or without the alerts left out) is replaced at once, so the switch acts on the next tick.
    const sameKind = stored ? (stored.params.censored_rows !== undefined) === Boolean(this.deps.alertTimes) : false;
    if (stored && sameKind && age < LOW_RISK_ALERT_POLICY.refit_after_hours * 3_600_000) return stored.params;
    // One try per refit period, also when the fit could not be made: the last one that could is kept.
    if (this.lastTry.has(patientId) && now.getTime() - this.lastTry.get(patientId)! < LOW_RISK_ALERT_POLICY.refit_after_hours * 3_600_000) return stored?.params ?? null;
    this.lastTry.set(patientId, now.getTime());
    const since = new Date(now.getTime() - LOW_RISK_POLICY.window_days * 86_400_000).toISOString();
    const [readings, carbs] = await Promise.all([this.deps.readingsSince(patientId, since), this.deps.carbTimes(patientId, since, now.toISOString())]);
    const alerts = this.deps.alertTimes ? (await this.deps.alertTimes(patientId, since)).map((at) => Date.parse(at)) : null;
    const params = fitLowRisk(buildLowRiskRows(readings, carbs.map((at) => Date.parse(at))), now, alerts ? { alert_times_ms: alerts } : {});
    await this.deps.store.prune(new Date(now.getTime() - LOW_RISK_ALERT_POLICY.retention_days * 86_400_000));
    if (!params) {
      this.deps.log?.({ event: 'low_risk_fit_skipped', patient_id: patientId });
      return stored?.params ?? null;
    }
    await this.deps.store.saveParams(patientId, params, now);
    this.deps.log?.({ event: 'low_risk_refit', patient_id: patientId, days: params.days, rows: params.rows, positives: params.positives, censored_rows: params.censored_rows ?? null, threshold: params.threshold });
    return params;
  }

  private readonly lastTry = new Map<string, number>();
  private readonly lastComparison = new Map<string, number>();

  /** About daily, and once after a restart: the comparison is worked out again, and the owners are told once when it is ready. */
  private async compareIfDue(patientId: string, now: Date): Promise<void> {
    const store = this.deps.store.comparison;
    if (!store) return;
    const last = this.lastComparison.get(patientId);
    if (last !== undefined && now.getTime() - last < LOW_COMPARISON_POLICY.recompute_after_hours * 3_600_000) return;
    this.lastComparison.set(patientId, now.getTime());
    const modelDecides = Boolean(this.deps.scoreOnly) && ((await this.deps.store.decidesAlert?.(patientId)) ?? true);
    const result = compareLowWarnings({ rows: await store.rows(patientId), live_source: modelDecides ? 'MODEL' : 'RULES' });
    const { notified } = await store.save(patientId, result, now);
    this.deps.log?.({ event: 'low_comparison', patient_id: patientId, days: result.days, lows: result.lows, ready: result.ready });
    if (!result.ready || notified || !this.deps.push.sendPredictionComparison) return;
    let pushed = 0;
    for (const pushToken of await store.listOwnerPushTokens(patientId)) {
      try {
        await this.deps.push.sendPredictionComparison({ patientId, pushToken, ...lowComparisonPushText() });
        pushed += 1;
      } catch (error) {
        this.deps.log?.({ event: 'low_comparison_push_failed', patient_id: patientId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    // With no phone reached it is tried again at the next comparison.
    if (pushed > 0) await store.markNotified(patientId, now);
    this.deps.log?.({ event: 'low_comparison_ready', patient_id: patientId, pushed_to: pushed });
  }

  private async scoreNewest(patientId: string, params: LowRiskParams, now: Date): Promise<void> {
    const recent = await this.deps.readingsSince(patientId, new Date(now.getTime() - LOW_RISK_ALERT_POLICY.newest_window_minutes * 60_000).toISOString());
    const newest = recent.at(-1);
    if (!newest) return;
    const newestMs = Date.parse(newest.at);
    const scored = await this.deps.store.lastScoredAt(patientId);
    if (scored && Date.parse(scored) >= newestMs) return;
    const since = new Date(now.getTime() - LOW_RISK_POLICY.history_days * 86_400_000).toISOString();
    const [history, carbs] = await Promise.all([
      this.deps.readingsSince(patientId, since),
      this.deps.carbTimes(patientId, new Date(now.getTime() - 300 * 60_000).toISOString(), now.toISOString()),
    ]);
    const rows = buildLowRiskRows(history, carbs.map((at) => Date.parse(at)));
    if (rows.count === 0) return;
    const last = rows.count - 1;
    const glucose = rows.values[last];
    const fresh = now.getTime() - rows.times[last] <= LOW_RISK_ALERT_POLICY.max_reading_age_minutes * 60_000;
    const score = lowRiskScore(params, rows.features[last]);
    const entry: LowRiskScoreEntry = {
      patient_id: patientId,
      reading_at: new Date(rows.times[last]).toISOString(),
      model_id: LOW_RISK_MODEL_ID,
      glucose_mgdl: Math.round(glucose),
      score,
      threshold: params.threshold,
      alarm: fresh && glucose >= LOW_RISK_POLICY.low_mgdl && score >= params.threshold,
    };
    // Read before this row goes in, or it would find itself.
    const lastAlarm = entry.alarm ? await this.deps.store.lastAlarmAt(patientId) : null;
    if (!(await this.deps.store.logScore(entry)) || !entry.alarm) return;
    if (lastAlarm && rows.times[last] - Date.parse(lastAlarm) <= LOW_RISK_POLICY.quiet_minutes * 60_000) return;
    if (this.deps.scoreOnly) return;
    const delta = rows.features[last][3];
    const close = last > 0 && rows.times[last] - rows.times[last - 1] <= 7 * 60_000;
    const text = lowRiskPushText(Math.round(glucose), close ? Math.round(delta) : null);
    let pushed = 0;
    for (const pushToken of await this.deps.store.listPushTokens(patientId)) {
      try {
        await this.deps.push.sendGlucoseAlert({ patientId, pushToken, kind: 'prediction_low', ...text });
        pushed += 1;
      } catch (error) {
        this.deps.log?.({ event: 'low_risk_push_failed', patient_id: patientId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    await this.deps.store.markPushed(entry, pushed);
    this.deps.log?.({ event: 'low_risk_alarm', patient_id: patientId, pushed_to: pushed });
  }
}
