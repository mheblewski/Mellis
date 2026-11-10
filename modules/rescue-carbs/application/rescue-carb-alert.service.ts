import { scheduleValueAt } from '@modules/meal-wbt/application/wbt-policy';
import { parseLoopPrediction, type LoopPrediction } from '@modules/loop-system/application/loop-prediction';
import { computeRescueOutcome, decideRescueAlert, RESCUE_ALERT_POLICY, rescuePushToResend, type RescueAlertRecord } from './rescue-alert-policy';
import type { RescueCarbsStore } from './rescue-carbs-store';
import { evaluateRescueNeed, evaluateRescueNeedV2, RESCUE_DETECTION_POLICY, type LowRiskVerdict, type RescueEvaluation } from './rescue-detection';
import { computeRescueDose, type RescueDoseProposal } from './rescue-dose';

/**
 * Runs rescue-carbs.v2 for every patient with a phone that opted in: one evaluation per minute, the alert's state
 * machine, and the time-sensitive push with the static dose (no AI). See the rescue-carbs plan.
 * rescue-carbs.v1 runs next to it as a shadow (owner decision 2026-10-21): never pushed, logged as
 * `rescue_carbs_v1_shadow` with when it would have pushed, so the two can be compared.
 */

/** Waits before the 2nd and 3rd attempt of a rescue push that failed for a passing reason. */
const PUSH_RETRY_DELAYS_MS = [1_000, 4_000];

export interface RescueCarbAlertDeps {
  store: RescueCarbsStore;
  data: {
    listGlucoseReadingsSince(patientId: string, sinceIso: string): Promise<Array<{ at: string; value: number }>>;
    getLatestLoopStatus(patientId: string): Promise<{ observed_at: string; raw_payload: Record<string, unknown> } | null>;
    getTherapyProfileAt(patientId: string, atIso: string): Promise<{
      units: string | null;
      timezone: string | null;
      carb_ratio_g_per_u: Array<[string, number]> | null;
      sensitivity_per_u: Array<[string, number]> | null;
      birth_year?: number | null;
    }>;
  };
  push: {
    sendRescueCarbAlert(input: { patientId: string; pushToken: string; conversationId: string; alertId: string; title: string; body: string; reminder: boolean }): Promise<void>;
  };
  /** A push refused for an invalid or unregistered token: the device is deactivated. */
  onPushError?(pushToken: string, error: unknown): Promise<void>;
  /** Waits between push attempts (tests pass an instant one). */
  sleep?(ms: number): Promise<void>;
  log?(event: Record<string, unknown>): void;
  timezone: string;
  /** The low-risk model's fresh verdict while it is the predicted-low source; absent or null: v2 decides. */
  lowRisk?(patientId: string, now: Date): Promise<LowRiskVerdict | null>;
  /**
   * low-comparison.v1: what the rules alone (rescue-carbs.v2, without the model) say for the newest reading, kept beside
   * the model's score for the same reading. Never decides anything.
   */
  recordRulesVerdict?(patientId: string, readingAt: string, warning: boolean): Promise<void>;
}

export interface RescueRunSummary {
  patients: number;
  notified: number;
  reminded: number;
  /** Pushes that reached no phone before and were sent again. */
  resent: number;
}

const READINGS_LOOKBACK_MINUTES = 3 * 60;
const DETECTION_READINGS_MINUTES = 45;

/** v1's alert in the shadow: only what decides whether it would have pushed (kept in memory, lost on restart). */
interface V1Shadow {
  state: 'PENDING' | 'NOTIFIED';
  first_flag_at: number;
  first_flag_reading_at: string | null;
  clear_since: number | null;
}

export class RescueCarbAlertService {
  private readonly v1Shadow = new Map<string, V1Shadow>();

  constructor(private readonly deps: RescueCarbAlertDeps) {}

  async run(now = new Date()): Promise<RescueRunSummary> {
    const summary: RescueRunSummary = { patients: 0, notified: 0, reminded: 0, resent: 0 };
    for (const patientId of await this.deps.store.listPatientsWithAlertDevices()) {
      summary.patients += 1;
      try {
        const action = await this.evaluatePatient(patientId, now);
        if (action === 'NOTIFY') summary.notified += 1;
        if (action === 'REMIND') summary.reminded += 1;
        if (action === 'RESEND') summary.resent += 1;
      } catch (error) {
        this.deps.log?.({ event: 'rescue_carbs_evaluation_failed', patient_id: patientId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return summary;
  }

  async evaluatePatient(patientId: string, now: Date): Promise<string> {
    const nowIso = now.toISOString();
    const [readings, loopStatus, recentCarbs] = await Promise.all([
      this.deps.data.listGlucoseReadingsSince(patientId, new Date(now.getTime() - READINGS_LOOKBACK_MINUTES * 60_000).toISOString()),
      this.deps.data.getLatestLoopStatus(patientId),
      this.deps.store.getRecentEatenCarbs(patientId, new Date(now.getTime() - RESCUE_DETECTION_POLICY.recent_carbs_minutes * 60_000).toISOString(), nowIso),
    ]);
    const prediction = parseLoopPrediction(loopStatus);
    const recent = readings.filter((reading) => Date.parse(reading.at) >= now.getTime() - DETECTION_READINGS_MINUTES * 60_000);
    // The kind matters (owner decision 2026-10-26): a meal holds back only a predicted low, rescue carbs also a low now.
    const detectionInput = { now, readings: recent, prediction, last_carbs_at: recentCarbs.last_carbs_at, last_hypo_treatment_at: recentCarbs.last_hypo_treatment_at };
    const lowRisk = await readLowRisk(this.deps, patientId, now);
    const evaluation = evaluateRescueNeedV2({ ...detectionInput, low_risk: lowRisk });
    const active = await this.deps.store.getActiveAlert(patientId);
    const decision = decideRescueAlert(active, evaluation, now);
    this.logV1Shadow(patientId, evaluateRescueNeed(detectionInput), evaluation, decision.action, now);
    if (this.deps.recordRulesVerdict && evaluation.glucose) {
      try {
        const rules = lowRisk ? evaluateRescueNeedV2(detectionInput) : evaluation;
        await this.deps.recordRulesVerdict(patientId, evaluation.glucose.at, rules.status === 'TRIGGER' && rules.level === 'PREDICTED_LOW' && rules.confirmed === true);
      } catch (error) {
        this.deps.log?.({ event: 'rescue_rules_verdict_failed', patient_id: patientId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (decision.action !== 'NONE') {
      this.deps.log?.({
        event: 'rescue_carbs_decision',
        patient_id: patientId,
        alert_id: active?.id ?? null,
        action: decision.action,
        status: evaluation.status,
        level: evaluation.level,
        trigger_source: evaluation.trigger_source,
        signals: evaluation.signals ?? null,
        confirmation: evaluation.confirmation ?? null,
        suppressed_reason: evaluation.suppressed_reason,
        glucose: evaluation.glucose?.value ?? null,
        predicted_min_mgdl: evaluation.predicted_min_mgdl,
        carbs_req_g: evaluation.carbs_req_g,
        ...(decision.action === 'CLOSE' ? { close_status: decision.status, reason: decision.reason } : {}),
      });
    }

    switch (decision.action) {
      case 'NONE': {
        if (!active) return 'NONE';
        await this.deps.store.touchAlert(active.id, { evaluation, now: nowIso, clearSince: decision.clear_since === undefined ? active.clear_since : decision.clear_since });
        const resend = rescuePushToResend(active, now);
        if (resend && await this.resend(patientId, active, resend === 'REMINDER', now)) return 'RESEND';
        return 'NONE';
      }
      case 'START_PENDING':
        await this.deps.store.insertAlert({ patientId, status: 'PENDING', evaluation, now: nowIso });
        return 'START_PENDING';
      case 'CANCEL':
        await this.deps.store.closeAlert(active!.id, { status: 'CANCELLED', outcome: null, now: nowIso });
        return 'CANCEL';
      case 'NOTIFY': {
        const alert = active ?? await this.deps.store.insertAlert({ patientId, status: 'PENDING', evaluation, now: nowIso });
        if (!alert) return 'NONE';
        await this.notify(patientId, alert, evaluation, prediction, now, false);
        return 'NOTIFY';
      }
      case 'REMIND':
        await this.notify(patientId, active!, evaluation, prediction, now, true);
        return 'REMIND';
      case 'CLOSE': {
        const outcome = computeRescueOutcome(active!, readings, decision.reason, now);
        await this.deps.store.closeAlert(active!.id, { status: decision.status, outcome, now: nowIso });
        this.deps.log?.({ event: 'rescue_carbs_outcome', patient_id: patientId, alert_id: active!.id, level: active!.level, trigger_source: active!.trigger_source, ...outcome });
        if (decision.restart === 'PENDING') await this.deps.store.insertAlert({ patientId, status: 'PENDING', evaluation, now: nowIso });
        if (decision.restart === 'NOTIFY') {
          const next = await this.deps.store.insertAlert({ patientId, status: 'PENDING', evaluation, now: nowIso });
          if (next) await this.notify(patientId, next, evaluation, prediction, now, false);
        }
        return 'CLOSE';
      }
    }
  }

  /**
   * v1 in the shadow: its own two-flags rule (PENDING → NOTIFY after ≥ 4 min on a newer reading, urgent at once), cleared
   * after 15 min clear or 2 h. Logged whenever either version flags, v1 would push, or v2 acts.
   */
  private logV1Shadow(patientId: string, v1: RescueEvaluation, v2: RescueEvaluation, v2Action: string, now: Date): void {
    const policy = RESCUE_ALERT_POLICY;
    const nowMs = now.getTime();
    const triggered = v1.status === 'TRIGGER';
    let shadow = this.v1Shadow.get(patientId) ?? null;
    let wouldNotify = false;
    if (shadow?.state === 'PENDING' && v1.status !== 'NO_DATA') {
      const newerReading = v1.glucose && shadow.first_flag_reading_at ? Date.parse(v1.glucose.at) > Date.parse(shadow.first_flag_reading_at) : true;
      if (nowMs - shadow.first_flag_at > policy.pending_max_minutes * 60_000 || !triggered) shadow = null;
      else if (v1.level === 'URGENT_LOW' || (nowMs - shadow.first_flag_at >= policy.confirm_after_minutes * 60_000 && newerReading)) {
        shadow = { ...shadow, state: 'NOTIFIED' };
        wouldNotify = true;
      }
    } else if (shadow?.state === 'NOTIFIED') {
      const clearSince = v1.status === 'NO_DATA' ? shadow.clear_since : v1.clear ? shadow.clear_since ?? nowMs : null;
      const closed = (clearSince !== null && nowMs - clearSince >= policy.clear_for_minutes * 60_000) || nowMs - shadow.first_flag_at >= policy.max_open_minutes * 60_000;
      shadow = closed ? null : { ...shadow, clear_since: clearSince };
    }
    if (!shadow && triggered) {
      wouldNotify = v1.level === 'URGENT_LOW';
      shadow = { state: wouldNotify ? 'NOTIFIED' : 'PENDING', first_flag_at: nowMs, first_flag_reading_at: v1.glucose?.at ?? null, clear_since: null };
    }
    if (shadow) this.v1Shadow.set(patientId, shadow);
    else this.v1Shadow.delete(patientId);

    const flagged = (evaluation: RescueEvaluation) => evaluation.status === 'TRIGGER' || evaluation.status === 'SUPPRESSED';
    if (!flagged(v1) && !flagged(v2) && !wouldNotify && v2Action === 'NONE') return;
    this.deps.log?.({
      event: 'rescue_carbs_v1_shadow',
      patient_id: patientId,
      glucose: v1.glucose?.value ?? null,
      would_trigger: triggered,
      would_notify: wouldNotify,
      shadow_state: shadow?.state ?? null,
      v1_status: v1.status,
      level: v1.level,
      trigger_source: v1.trigger_source,
      v2_status: v2.status,
      v2_level: v2.level,
      v2_signals: v2.signals ?? null,
      v2_confirmed: v2.confirmed ?? null,
      v2_confirmation: v2.confirmation ?? null,
      v2_action: v2Action,
      differs: v1.status !== v2.status || v1.level !== v2.level || (wouldNotify !== (v2Action === 'NOTIFY')),
    });
  }

  private async notify(patientId: string, alert: RescueAlertRecord, evaluation: RescueEvaluation, prediction: LoopPrediction | null, now: Date, reminder: boolean): Promise<void> {
    const nowIso = now.toISOString();
    const therapy = await this.deps.data.getTherapyProfileAt(patientId, nowIso).catch(() => null);
    const timezone = therapy?.timezone ?? this.deps.timezone;
    const proposal = computeRescueDose({
      evaluation,
      loop: prediction,
      profile: {
        isf: therapy ? scheduleValueAt(therapy.sensitivity_per_u, nowIso, timezone) : null,
        icr_g_per_u: therapy ? scheduleValueAt(therapy.carb_ratio_g_per_u, nowIso, timezone) : null,
        units: therapy?.units ?? null,
      },
      birth_year: therapy?.birth_year ?? null,
    });
    const updated = await this.deps.store.markNotified(alert.id, {
      patientId,
      evaluation,
      proposal,
      now: nowIso,
      reminder,
      conversationTitle: `Dosłodzenie ${clock(alert.notified_at ?? nowIso, this.deps.timezone)}`,
    });
    if (!updated?.conversation_id) return;
    const { title, body } = buildRescuePushText({ evaluation, proposal, reminder, timezone: this.deps.timezone, notified_at: updated.notified_at });
    const sent = await this.deliver(patientId, updated, { title, body, reminder }, now);
    this.deps.log?.({ event: reminder ? 'rescue_carbs_reminder_sent' : 'rescue_carbs_push_sent', patient_id: patientId, alert_id: updated.id, devices: sent, level: evaluation.level, carbs_g: proposal.carbs_g, basis: proposal.basis });
  }

  /**
   * A push that reached no phone goes again with what it announced (the stored evaluation and dose) and the same alert
   * id, so the phone shows one notification and the bell one entry. False when another worker claimed it, or the alert
   * was declined, treated or closed meanwhile.
   */
  private async resend(patientId: string, active: RescueAlertRecord, reminder: boolean, now: Date): Promise<boolean> {
    if (!active.proposal || !active.conversation_id) return false;
    const claimed = await this.deps.store.claimPushResend(active.id, { reminder, now: now.toISOString() });
    if (!claimed?.conversation_id || !claimed.proposal) return false;
    const { title, body } = buildRescuePushText({ evaluation: claimed.evaluation, proposal: claimed.proposal, reminder, timezone: this.deps.timezone, notified_at: claimed.notified_at });
    const sent = await this.deliver(patientId, claimed, { title, body, reminder }, now);
    this.deps.log?.({
      event: 'rescue_carbs_push_resent',
      patient_id: patientId,
      alert_id: claimed.id,
      reminder,
      attempt: (reminder ? claimed.reminder_push_attempts : claimed.alert_push_attempts) ?? null,
      devices: sent,
      level: claimed.evaluation.level,
    });
    return true;
  }

  /**
   * Sends one push to every opted-in phone; the number that took it. The alert is marked NOTIFIED already: a network
   * blip or an APNs 5xx/429 is retried here, and a push that reached no phone (also no phone, or the device list
   * failing) stays undelivered, so the next evaluations send it again (rescuePushToResend).
   */
  private async deliver(patientId: string, alert: RescueAlertRecord, push: { title: string; body: string; reminder: boolean }, now: Date): Promise<number> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let devices: Array<{ device_id: string; push_token: string }> = [];
    try {
      devices = await this.deps.store.listAlertDevices(patientId);
    } catch (error) {
      this.deps.log?.({ event: 'rescue_carbs_push_failed', patient_id: patientId, alert_id: alert.id, reminder: push.reminder, stage: 'LIST_DEVICES', error: error instanceof Error ? error.message : String(error) });
    }
    let sent = 0;
    for (const device of devices) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await this.deps.push.sendRescueCarbAlert({ patientId, pushToken: device.push_token, conversationId: alert.conversation_id!, alertId: alert.id, title: push.title, body: push.body, reminder: push.reminder });
          sent += 1;
          break;
        } catch (error) {
          const retryable = (error as { retryable?: unknown } | null)?.retryable === true;
          if (retryable && attempt < PUSH_RETRY_DELAYS_MS.length) {
            await sleep(PUSH_RETRY_DELAYS_MS[attempt]);
            continue;
          }
          await this.deps.onPushError?.(device.push_token, error);
          this.deps.log?.({ event: 'rescue_carbs_push_failed', patient_id: patientId, alert_id: alert.id, reminder: push.reminder, attempts: attempt + 1, error: error instanceof Error ? error.message : String(error) });
          break;
        }
      }
    }
    if (sent > 0) {
      await this.deps.store.markPushDelivered(alert.id, { reminder: push.reminder, now: now.toISOString() });
    } else {
      this.deps.log?.({ event: 'rescue_carbs_push_undelivered', patient_id: patientId, alert_id: alert.id, reminder: push.reminder, devices: devices.length });
    }
    return sent;
  }
}

/**
 * The alert's push (role review 2026-11-09, table B1–B5): the glucose and its 5-minute change in the title ("66 −4 ·
 * niedocukrzenie", no unit, just the number when the change is unknown), one sentence with the dose in the body. The
 * reminder goes only while the alert is NOTIFIED with nothing logged or declined, so it can say nobody confirmed it;
 * `notified_at` is the first push's time ("alertu z 14:20").
 */
export function buildRescuePushText(input: { evaluation: RescueEvaluation; proposal: RescueDoseProposal; reminder: boolean; timezone: string; notified_at?: string | null }): { title: string; body: string } {
  const { evaluation, proposal } = input;
  const glucose = evaluation.glucose?.value ?? null;
  const urgent = evaluation.level === 'URGENT_LOW';
  const lowNow = urgent || evaluation.level === 'LOW_NOW';
  const label = input.reminder
    ? (urgent ? 'nadal pilne niedocukrzenie' : lowNow ? 'nadal niedocukrzenie' : 'nadal możliwe niedocukrzenie')
    : (urgent ? 'pilne niedocukrzenie' : lowNow ? 'niedocukrzenie' : 'możliwe niedocukrzenie');
  const delta = evaluation.delta_per_5min === null ? null : Math.round(evaluation.delta_per_5min);
  const reading = glucose === null ? null : [String(Math.round(glucose)), delta === null ? null : delta > 0 ? `+${delta}` : delta < 0 ? `−${Math.abs(delta)}` : '+0'].filter(Boolean).join(' ');
  const title = reading ? `${reading} · ${label}` : label.charAt(0).toUpperCase() + label.slice(1);
  const grams = proposal.carbs_g !== null ? formatGrams(proposal.carbs_g) : null;
  const sentences: string[] = [];
  if (input.reminder) {
    sentences.push(input.notified_at ? `Nikt nie potwierdził alertu z ${clock(input.notified_at, input.timezone)}.` : 'Nikt nie potwierdził alertu.');
    sentences.push('Jeśli węgle już podano, odczekaj 15 min.');
    sentences.push(grams !== null ? `Inaczej Mellis proponuje ${grams} g.` : 'Inaczej podaj szybkie węglowodany według swojego planu.');
    return { title, body: sentences.join(' ') };
  }
  if (evaluation.level === 'PREDICTED_LOW' && evaluation.predicted_low_at) {
    sentences.push(`Ok. ${clock(evaluation.predicted_low_at, input.timezone)} glukoza może spaść poniżej 70.`);
  }
  if (grams === null) {
    sentences.push('Mellis nie ma propozycji dawki. Podaj szybkie węglowodany według swojego planu.');
  } else if (urgent) {
    sentences.push(`Mellis proponuje ${grams} g szybkich węglowodanów teraz.`);
  } else {
    sentences.push(`Mellis proponuje ${grams} g szybkich węglowodanów.`);
    if (lowNow) sentences.push('Sprawdź glukozę po 15 min.');
  }
  return { title, body: sentences.join(' ') };
}

export function clock(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(new Date(iso));
}

function formatGrams(value: number): string {
  return String(Math.round(value * 10) / 10).replace('.', ',');
}


/** A failed read leaves v2 to decide, never no alert at all. */
export async function readLowRisk(deps: { lowRisk?(patientId: string, now: Date): Promise<LowRiskVerdict | null>; log?(event: Record<string, unknown>): void }, patientId: string, now: Date): Promise<LowRiskVerdict | null> {
  if (!deps.lowRisk) return null;
  try {
    return await deps.lowRisk(patientId, now);
  } catch (error) {
    deps.log?.({ event: 'rescue_low_risk_read_failed', patient_id: patientId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
