import type { WhatIfData } from '@modules/settings-whatif/application/icr-whatif';
import { localInstant, localParts } from '@modules/settings-insights/application/settings-insights-common';
import { detectPatterns, lastNightVeryLows, THERAPY_PATTERNS_POLICY } from './pattern-detectors';
import { CHANGE_CHECK_POLICY, changeComparison } from './change-check';
import { duePatternPush, mergeStates, nightPushText, nightPushWindow, patternPushText, THERAPY_PATTERNS_STATE_POLICY, type PatternState } from './pattern-states';

const DAY = 86_400_000;
/** Last night is looked at again at most this often in the morning (Trio may upload readings late). */
const NIGHT_RECHECK_MS = 60 * 60_000;
/** The detectors look at 14 days; a meal or a low at the start needs a few hours before it. */
const LOAD_DAYS = THERAPY_PATTERNS_POLICY.window_days + 2;

export interface TherapyPatternsStore {
  listPatientsToAnalyse(): Promise<string[]>;
  getTimezone(patientId: string): Promise<string | null>;
  loadData(patientId: string, endIso: string, days: number, timeZone: string): Promise<WhatIfData>;
  /** Readings and profiles only (no Trio log), for the change card's weeks before and after. */
  loadHistory(patientId: string, endIso: string, days: number, timeZone: string): Promise<WhatIfData>;
  lastRunAt(patientId: string): Promise<string | null>;
  listStates(patientId: string): Promise<PatternState[]>;
  saveRun(patientId: string, states: PatternState[], computedAt: string, engineVersion: string): Promise<void>;
  claimPush(patientId: string, key: string, revision: number, notifiedAt: string, severity: number): Promise<boolean>;
  latestGlucose(patientId: string): Promise<number | null>;
  getNightCheck(patientId: string, date: string): Promise<{ checked_at: string; notified_at: string | null } | null>;
  saveNightCheck(patientId: string, date: string, checkedAt: string, result: unknown): Promise<void>;
  claimNightPush(patientId: string, date: string, notifiedAt: string): Promise<boolean>;
  listOwnerPushDevices(patientId: string): Promise<Array<{ device_id: string; push_token: string }>>;
  /** Every caregiver's phone allowed glucose alerts (the night under 54 push), with whether the person is an owner. */
  listNightPushDevices(patientId: string): Promise<Array<{ device_id: string; push_token: string; is_owner: boolean }>>;
  deactivatePushToken(pushToken: string): Promise<void>;
}

export interface TherapyPatternsPushSender {
  /** `openPatient`: the tap opens the patient, not Wzorce (a caregiver who is not an owner has no Wzorce). */
  sendTherapyPattern(input: { patientId: string; pushToken: string; patternKey: string; title: string; body: string; notifiedAt: string; openPatient?: boolean }): Promise<void>;
}

/**
 * "Wzorce" (therapy-patterns.v1): once a night after 04:00 local the detectors run on the last 14 days of every
 * opted-in patient and the states are saved; every tick the due push (one a week) goes to the owners' phones.
 */
export class TherapyPatternsService {
  constructor(private readonly deps: {
    store: TherapyPatternsStore;
    push: TherapyPatternsPushSender;
    defaultTimezone: () => string;
    log: (event: Record<string, unknown>) => void;
    isDeadToken?: (error: unknown) => boolean;
  }) {}

  private async timezone(patientId: string): Promise<string> {
    return (await this.deps.store.getTimezone(patientId).catch(() => null)) ?? this.deps.defaultTimezone();
  }

  async runDue(now: Date): Promise<void> {
    for (const patientId of await this.deps.store.listPatientsToAnalyse()) {
      try {
        const tz = await this.timezone(patientId);
        const local = localParts(now.getTime(), tz);
        const runFrom = localInstant(local.date, THERAPY_PATTERNS_STATE_POLICY.runHour * 60, tz);
        if (now.getTime() < runFrom) continue;
        const last = await this.deps.store.lastRunAt(patientId);
        if (last && Date.parse(last) >= runFrom) continue;
        await this.analyse(patientId, now, tz, local.date);
      } catch (error) {
        this.deps.log({ event: 'therapy_patterns.run_failed', patient_id: patientId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /** One patient now (also the API's first open, before any night has run). */
  async analyse(patientId: string, now: Date, tz: string, today: string): Promise<PatternState[]> {
    const started = Date.now();
    const endIso = new Date(localInstant(today, 0, tz)).toISOString();
    const data = await this.deps.store.loadData(patientId, endIso, LOAD_DAYS, tz);
    const history = await this.deps.store.loadHistory(patientId, endIso, CHANGE_CHECK_POLICY.showDays + CHANGE_CHECK_POLICY.beforeDays + 1, tz);
    const results = [...detectPatterns(data, today), changeComparison(history, today)];
    const states = mergeStates(await this.deps.store.listStates(patientId), results, now.getTime());
    await this.deps.store.saveRun(patientId, states, now.toISOString(), THERAPY_PATTERNS_POLICY.version);
    this.deps.log({ event: 'therapy_patterns.run', patient_id: patientId, shown: results.filter((r) => r.shown).map((r) => r.id), ms: Date.now() - started });
    return states;
  }

  async sendDue(now: Date): Promise<void> {
    for (const patientId of await this.deps.store.listPatientsToAnalyse()) {
      try {
        await this.sendNightForPatient(patientId, now);
      } catch (error) {
        this.deps.log({ event: 'therapy_patterns.night_push_failed', patient_id: patientId, error: error instanceof Error ? error.message : String(error) });
      }
      try {
        await this.sendDueForPatient(patientId, now);
      } catch (error) {
        this.deps.log({ event: 'therapy_patterns.push_failed', patient_id: patientId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /**
   * Last night under 54 (review 2026-11-12, B1/B2, S1 A, S2 A): the nightly run ends at midnight, so last night is
   * looked at in the morning, from 0:00 to now — any low of ≥ 15 min under 54 starting 0–6, after food too. Checked at
   * most once an hour from 7:00 (Trio may upload late), pushed once per night, held while glucose is under 70 (until 12:00).
   */
  private async sendNightForPatient(patientId: string, now: Date): Promise<void> {
    const tz = await this.timezone(patientId);
    const glucose = await this.deps.store.latestGlucose(patientId);
    if (!nightPushWindow(now.getTime(), tz, glucose)) return;
    const today = localParts(now.getTime(), tz).date;
    const check = await this.deps.store.getNightCheck(patientId, today);
    if (check?.notified_at) return;
    if (check && now.getTime() - Date.parse(check.checked_at) < NIGHT_RECHECK_MS) return;
    const data = await this.deps.store.loadData(patientId, now.toISOString(), 1, tz);
    const lows = lastNightVeryLows(data, today);
    await this.deps.store.saveNightCheck(patientId, today, now.toISOString(), { lows });
    if (!lows.length) return;
    const notifiedAt = now.toISOString();
    if (!(await this.deps.store.claimNightPush(patientId, today, notifiedAt))) return;
    const worst = [...lows].sort((a, b) => a.nadir - b.nadir)[0];
    const text = nightPushText(worst, tz);
    // Every caregiver (owner's decision 2026-11-12): the second parent who does half of the nights must know.
    const devices = await this.deps.store.listNightPushDevices(patientId);
    let delivered = 0;
    for (const device of devices) {
      try {
        // Opens the patient (Teraz): the night is on its chart; Wzorce has no night card since 2026-11-13.
        await this.deps.push.sendTherapyPattern({ patientId, pushToken: device.push_token, patternKey: 'NIGHT_LOWS', title: text.title, body: text.body, notifiedAt, openPatient: true });
        delivered += 1;
      } catch (error) {
        if (this.deps.isDeadToken?.(error)) await this.deps.store.deactivatePushToken(device.push_token).catch(() => undefined);
        this.deps.log({ event: 'therapy_patterns.push_device_failed', patient_id: patientId, device_id: device.device_id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    // The claim is written before sending: a night whose push reached no phone is logged loudly (no retry).
    this.deps.log({ event: delivered ? 'therapy_patterns.night_push' : 'therapy_patterns.night_push_undelivered', patient_id: patientId, date: today, nadir: Math.round(worst.nadir), devices: devices.length, delivered });
  }

  private async sendDueForPatient(patientId: string, now: Date): Promise<void> {
    const tz = await this.timezone(patientId);
    const states = await this.deps.store.listStates(patientId);
    // Only tonight's results: a run that failed for days must not push an old pattern.
    const fresh = states.filter((s) => now.getTime() - Date.parse(s.computed_at) < 1.5 * DAY);
    if (!fresh.some((s) => s.shown)) return;
    const due = duePatternPush(fresh, now.getTime(), tz, await this.deps.store.latestGlucose(patientId));
    if (!due) return;
    const notifiedAt = now.toISOString();
    if (!(await this.deps.store.claimPush(patientId, due.state.pattern_key, due.state.revision, notifiedAt, due.state.severity))) {
      this.deps.log({ event: 'therapy_patterns.push_claim_lost', patient_id: patientId, pattern_key: due.state.pattern_key });
      return;
    }
    const text = patternPushText(due.state, due.reason);
    const devices = await this.deps.store.listOwnerPushDevices(patientId);
    for (const device of devices) {
      try {
        await this.deps.push.sendTherapyPattern({ patientId, pushToken: device.push_token, patternKey: due.state.pattern_key, title: text.title, body: text.body, notifiedAt });
      } catch (error) {
        if (this.deps.isDeadToken?.(error)) await this.deps.store.deactivatePushToken(device.push_token).catch(() => undefined);
        this.deps.log({ event: 'therapy_patterns.push_device_failed', patient_id: patientId, device_id: device.device_id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    this.deps.log({ event: 'therapy_patterns.push', patient_id: patientId, pattern_key: due.state.pattern_key, reason: due.reason, devices: devices.length });
  }
}
