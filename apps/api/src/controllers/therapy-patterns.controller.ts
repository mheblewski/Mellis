import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import type { Pool } from 'pg';
import { ForbiddenError, NotFoundError, ValidationError } from '@shared/errors/app-error';
import { resolveHomeTimeZone } from '@shared/primitives/home-time-zone';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { localInstant, localParts } from '@modules/settings-insights/application/settings-insights-common';
import { RETIRED_PATTERNS, THERAPY_PATTERNS_POLICY, type ChangeGroup } from '@modules/therapy-patterns/application/pattern-detectors';
import { canDismiss, isDismissed, isPatternKey, isPatternNew, PATTERN_ORDER, patternSummary, patternText, REPORT_ONLY, THERAPY_PATTERNS_STATE_POLICY, type PatternState } from '@modules/therapy-patterns/application/pattern-states';
import { isTherapyPatternsEnabled } from '@modules/therapy-patterns/application/therapy-patterns-flag';
import { therapyPatternsStore } from '@modules/therapy-patterns/application/therapy-patterns-store';
import { TherapyPatternsService } from '@modules/therapy-patterns/application/therapy-patterns.service';
import { PostgresClinicReportRepository } from '@infra/db/postgres-clinic-report.repository';
import { PostgresSettingsWhatIfRepository } from '@infra/db/postgres-settings-whatif.repository';
import { buildClinicReportData } from '@modules/clinic-report/application/clinic-report-data';
import { renderClinicReportHtml } from '@modules/clinic-report/application/clinic-report-html';
import { PatientPermissionGuard } from '../auth/patient-permission.guard';
import { BearerPrincipalGuard, RequestPrincipal } from '../auth/bearer-principal.guard';
import { Principal } from '../auth/principal.decorator';
import { ProblemDetailsFilter } from '../common/problem.filter';

const DAY = 86_400_000;
const shiftDate = (iso: string, days: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
/** A pattern no longer seen stays on the screen under "Wcześniej" this long. */
const GONE_DAYS = 14;
/** This caregiver's opened cards (pattern key → when). */
type Opens = { signedIn: boolean; byKey: Map<string, string> };

/**
 * "Wzorce" (therapy-patterns.v1): the patterns of the last 14 days for the app, "Nie dotyczy nas", and the
 * conversation of a pattern ("Omów z Mellis"). Owners of the patient only.
 */
@Injectable()
export class TherapyPatternsApi {
  private readonly store: ReturnType<typeof therapyPatternsStore>;
  private readonly service: TherapyPatternsService;
  private readonly clinic: PostgresClinicReportRepository;
  private readonly whatIf: PostgresSettingsWhatIfRepository;
  /** One report per patient and local day, kept for an hour (it reads 28 days of data). */
  private readonly reports = new Map<string, { at: number; html: string }>();

  constructor(
    @Inject(PostgresGlucoMindRepository) private readonly repository: PostgresGlucoMindRepository,
    @Inject(DATABASE_POOL) pool: Pool,
  ) {
    this.store = therapyPatternsStore(pool);
    this.clinic = new PostgresClinicReportRepository(pool);
    this.whatIf = new PostgresSettingsWhatIfRepository(pool);
    // The API never pushes: pushes are the worker's.
    this.service = new TherapyPatternsService({
      store: this.store,
      push: { sendTherapyPattern: async () => undefined },
      defaultTimezone: resolveHomeTimeZone,
      log: (event) => console.log(JSON.stringify(event)),
    });
  }

  private async assertAccess(principal: RequestPrincipal, patientId: string): Promise<string> {
    if (!isTherapyPatternsEnabled(process.env)) throw new ForbiddenError('Patterns are off on this server');
    const scopes = await this.repository.getMemberScopes(principal.user_id, patientId);
    if (!scopes?.is_owner) throw new ForbiddenError('Only an owner of the patient sees patterns');
    return (await this.store.patterns.getTimezone(patientId).catch(() => null)) ?? resolveHomeTimeZone();
  }

  private card(state: PatternState, tz: string, nowMs: number, opens: Opens): Record<string, unknown> {
    const text = patternText(state.result);
    return {
      key: state.pattern_key,
      id: state.pattern_id,
      title: text.title,
      summary: patternSummary(state.result),
      sentence: state.result.sentence,
      lines: state.result.lines ?? [],
      details: state.result.details ?? [],
      // A pattern no longer seen has nothing to check now: its title, when it was seen and how often.
      question: state.shown ? text.question : null,
      visit: text.visit,
      can_dismiss: canDismiss(state.pattern_id),
      episode_count: state.result.episodes.length,
      episodes: state.result.episodes.slice(-5).reverse().map((e) => {
        const hm = (ms: number) => { const m = localParts(ms, tz).minute; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
        const chart = state.result.chart && e.trace ? {
          trace: e.trace,
          meal_minute: e.meal_minute ?? null,
          meal_time: typeof e.meal_minute === 'number' ? (() => { const m = (state.result.chart!.from_minute + e.meal_minute!); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; })() : null,
          nadir: e.nadir ?? null,
          nadir_time: typeof e.nadir_at === 'number' ? hm(e.nadir_at).replace(/^0/, '') : null,
          low_minutes: e.low_minutes ?? null,
          boluses: e.boluses ?? [],
          carbs: e.carbs ?? [],
        } : null;
        return { date: e.date, time: hm(e.at), note: e.note, chart };
      }),
      // The "Kiedy" mini charts (only patterns of one time of day that carry them).
      chart: state.shown && state.result.chart ? state.result.chart : null,
      first_seen: state.first_shown_at?.slice(0, 10) ?? null,
      // "Pierwszy raz: 4.11": the first episode in the window, not the night Mellis first counted it.
      first_episode: state.result.episodes[0]?.date ?? null,
      last_seen: state.last_shown_at?.slice(0, 10) ?? null,
      // "Nowy" until this caregiver opens the card (owner 2026-11-14), each caregiver on their own.
      is_new: isPatternNew(state, opens.byKey.get(state.pattern_key), nowMs, opens.signedIn),
      dismissed_until: isDismissed(state, nowMs) ? state.dismissed_until : null,
      // The other caregiver sees who hid it and when (role review 2026-11-12).
      dismissed_label: isDismissed(state, nowMs) ? this.dismissedLabel(state, tz) : null,
    };
  }

  private dismissedLabel(state: PatternState, tz: string): string | null {
    if (!state.dismissed_until) return null;
    const days = state.pattern_id === 'SETTING_CHECK' ? THERAPY_PATTERNS_STATE_POLICY.settingsDiscussedDays : THERAPY_PATTERNS_STATE_POLICY.dismissDays;
    const on = localParts(Date.parse(state.dismissed_until) - days * DAY, tz).date;
    const date = `${Number(on.slice(8))}.${on.slice(5, 7)}`;
    return state.dismissed_by ? `Ukryte przez: ${state.dismissed_by}, ${date}` : `Ukryte ${date}`;
  }

  /**
   * "Przed i po zmianie" (plan to 9/10, D1 + S5 B): until day 14 one line without numbers ("dzień 5 z 14 · porównanie od
   * 20.11"); then one section per direction, titled by the setting ("Przelicznik 18–24: 7,1 → 6,8"), two rows of numbers
   * each (days under 54, time under 70), dated columns, and what else changed in one sentence under it.
   */
  private changeCard(state: PatternState): Record<string, unknown> {
    const st = state.result.stats;
    const num = (k: string) => (typeof st[k] === 'number' ? st[k] as number : null);
    const pl = (x: number | null, k = 1) => (x === null ? '–' : x.toFixed(k).replace('.', ','));
    const dm = (iso: string) => `${Number(iso.slice(8))}.${iso.slice(5, 7)}`;
    const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
    const date = String(st.date ?? '');
    const day = num('day') ?? 0;
    const of = num('of') ?? 14;
    const ready = day >= of;
    const title = patternText(state.result).title;
    const changeLines = (state.result.lines ?? []).map((line) => { const [label, before, after] = line.split('|'); return { label, before, after }; });
    const label = (raw: string) => raw.replace(/^ICR/, 'Przelicznik');
    if (!ready) {
      // One line until day 14, but it still says what changed (owner 2026-11-12: "nie jest napisane jaka to zmiana").
      // "Przelicznik 18–24: 7,1 → 6,8 (więcej insuliny)": full hours without ":00", so a change fits one line.
      const what = changeLines.map((c) => `${label(c.label).replace(/(\d{1,2}):00/g, '$1')}: ${c.before} → ${c.after} (${this.isMore(c) ? 'więcej' : 'mniej'} insuliny)`);
      return {
        key: state.pattern_key, title, ready: false, day, of,
        line: [...what, `dzień ${day} z ${of} · porównanie od ${dm(addDays(date, of + 1))}`].join('\n'),
        changes: [], hours: null, before_days: null, after_days: null, rows: [], sections: [], context: [], before_note: null, note: null, question: null,
      };
    }
    const groups: ChangeGroup[] = state.result.groups ?? [];
    const beforeLabel = `Przed ${dm(addDays(date, -14))}–${dm(addDays(date, -1))}`;
    const afterLabel = `Po ${dm(addDays(date, 1))}–${dm(addDays(date, of))}`;
    const sections = groups.map((g) => {
      const own = changeLines.filter((c) => (g.direction === 'MORE') === this.isMore(c));
      const icr = own.some((c) => c.label.startsWith('ICR'));
      return {
        title: `${own.map((c) => `${label(c.label)}: ${c.before} → ${c.after}`).join(' · ') || 'Zmiana'} (${g.direction === 'MORE' ? 'więcej insuliny' : 'mniej insuliny'})`,
        subtitle: `liczone w godzinach ${g.hours}${icr ? ', bo insulina z posiłku działa też po tych godzinach' : ''}`,
        before_days: g.before.days,
        after_days: g.after.days,
        before_label: beforeLabel,
        after_label: afterLabel,
        rows: [
          { label: 'Dni poniżej 54', before: `${g.before.very_low_days} z ${g.before.days}`, after: `${g.after.very_low_days} z ${g.after.days}` },
          { label: 'Czas poniżej 70', before: `${pl(g.before.tbr)}%`, after: `${pl(g.after.tbr)}%` },
        ],
      };
    });
    const bpmB = num('boluses_per_meal_before');
    const bpmA = num('boluses_per_meal_after');
    const dosingChanged = bpmB !== null && bpmA !== null && bpmB > 0 && Math.abs(bpmA - bpmB) / bpmB >= 0.2;
    const beforeDays = Math.min(...groups.map((g) => g.before.days), 14);
    // Safety, not a verdict (review round 3): more time under 70, or more days under 54, after the change in its hours.
    // Its own line above the note, saying exactly what grew (round 4): longer below 70, or more days below 54.
    const longer70 = groups.some((g) => g.after.tbr > 4 && g.after.tbr > g.before.tbr);
    const more54 = groups.some((g) => g.after.days > 0 && g.before.days > 0 && g.after.very_low_days / g.after.days > g.before.very_low_days / g.before.days);
    const safety = longer70 && more54 ? 'Po zmianie w tych godzinach glukoza była dłużej poniżej 70 i częściej poniżej 54 niż przed. Pokaż to poradni.'
      : longer70 ? 'Po zmianie w tych godzinach glukoza była dłużej poniżej 70 niż przed. Pokaż to poradni.'
        : more54 ? 'Po zmianie w tych godzinach glukoza częściej spadała poniżej 54 niż przed. Pokaż to poradni.' : null;
    const note = (dosingChanged
      ? `Bez oceny: w tych samych tygodniach zmienił się też sposób podawania bolusa (${pl(bpmB)} → ${pl(bpmA)} na posiłek), a tych zmian nie da się rozdzielić.`
      : 'Bez oceny: w tych tygodniach mogły się zmienić też posiłki i sposób podawania bolusa.');
    return {
      key: state.pattern_key, title, ready: true, day, of, line: null,
      changes: [], hours: st.hours ?? null,
      before_days: beforeDays, after_days: num('after_days'),
      // The first section's rows, for builds before the sections.
      rows: sections[0]?.rows ?? [],
      sections,
      context: [],
      before_note: beforeDays < 10 ? `Przed: tylko ${beforeDays} dni z danymi.` : null,
      note,
      safety,
      question: patternText(state.result).question,
    };
  }

  /** A change line "ICR 18:00–24:00|7,1|6,8": more insulin when a ratio, sensitivity or target goes down, or basal up. */
  private isMore(c: { label: string; before: string; after: string }): boolean {
    const b = Number(c.before.replace(',', '.')); const a = Number(c.after.replace(',', '.'));
    return c.label.startsWith('Baza') ? a > b : a < b;
  }

  async view(principal: RequestPrincipal, patientId: string): Promise<Record<string, unknown>> {
    const tz = await this.assertAccess(principal, patientId);
    const now = new Date();
    const today = localParts(now.getTime(), tz).date;
    let states = await this.store.listStates(patientId);
    let computedAt = await this.store.lastRunAt(patientId);
    // Before the first night: counted now (a few seconds), then kept like a nightly run.
    if (!computedAt) {
      states = await this.service.analyse(patientId, now, tz, today);
      computedAt = now.toISOString();
    }
    const order = (s: PatternState) => PATTERN_ORDER.indexOf(s.pattern_id);
    const nowMs = now.getTime();
    const change = states.filter((s) => s.pattern_id === 'CHANGE_CHECK' && s.shown).sort((a, b) => String(b.result.stats.date).localeCompare(String(a.result.stats.date)))[0] ?? null;
    // The change card is drawn apart; retired patterns (no longer run) are not listed at all.
    // Report-only patterns (settings, rebound after a treated low) are in "Raport dla poradni", not on the list.
    states = states.filter((s) => s.pattern_id !== 'CHANGE_CHECK' && !RETIRED_PATTERNS.includes(s.pattern_id) && !REPORT_ONLY.includes(s.pattern_id));
    const active = states.filter((s) => s.shown && !isDismissed(s, nowMs)).sort((a, b) => order(a) - order(b));
    // One night under 54 is not a pattern that stopped: it never goes to "Już się nie powtarza".
    const gone = states.filter((s) => !s.shown && !isDismissed(s, nowMs) && s.result.stats.single !== 1 && s.last_shown_at && nowMs - Date.parse(s.last_shown_at) < GONE_DAYS * DAY).sort((a, b) => order(a) - order(b));
    const dismissed = states.filter((s) => isDismissed(s, nowMs)).sort((a, b) => order(a) - order(b));
    const runDate = localParts(Date.parse(computedAt), tz).date;
    const opens: Opens = principal.user_id
      ? { signedIn: true, byKey: await this.store.patterns.listOpens(patientId, principal.user_id) }
      : { signedIn: false, byKey: new Map() };
    return {
      patient_id: patientId,
      version: THERAPY_PATTERNS_POLICY.version,
      computed_at: computedAt,
      // Local dates by calendar arithmetic: the ISO slice of local midnight gave the day before (29.10–11.11 for 30.10–12.11).
      window: { from: shiftDate(runDate, -THERAPY_PATTERNS_POLICY.window_days), to: shiftDate(runDate, -1) },
      change_check: change ? this.changeCard(change) : null,
      patterns: active.map((s) => this.card(s, tz, nowMs, opens)),
      gone: gone.map((s) => this.card(s, tz, nowMs, opens)),
      dismissed: dismissed.map((s) => this.card(s, tz, nowMs, opens)),
    };
  }

  /** "Raport dla poradni" (clinic-report.v1): the last 14 days as A4 pages of HTML; the app prints them to PDF. */
  async clinicReport(principal: RequestPrincipal, patientId: string): Promise<Record<string, unknown>> {
    const tz = await this.assertAccess(principal, patientId);
    const now = Date.now();
    const today = localParts(now, tz).date;
    const key = `${patientId}:${today}`;
    const hit = this.reports.get(key);
    if (hit && now - hit.at < 3_600_000) return { patient_id: patientId, version: 'clinic-report.v1', html: hit.html };
    const started = Date.now();
    const end = localInstant(today, 0, tz);
    const from = new Date(end - 28 * DAY).toISOString();
    const [data, cycles, patient, states] = await Promise.all([
      this.whatIf.loadIcrWhatIfData({ patientId, endIso: new Date(end).toISOString(), days: 28, defaultTimeZone: tz, peakMinutes: 75, withTrioCycles: false }),
      this.clinic.loadCycles(patientId, from, new Date(end).toISOString()),
      this.clinic.patient(patientId),
      this.store.listStates(patientId),
    ]);
    const order = (s: PatternState) => PATTERN_ORDER.indexOf(s.pattern_id);
    const patterns = states.filter((s) => s.shown && !isDismissed(s, now) && s.pattern_id !== 'SETTING_CHECK' && s.pattern_id !== 'CHANGE_CHECK' && !RETIRED_PATTERNS.includes(s.pattern_id)).sort((a, b) => order(a) - order(b))
      .map((s) => ({ id: s.pattern_id, title: patternText(s.result).title, sentence: s.result.sentence }));
    const report = buildClinicReportData({ data, cycles, patient, loopName: cycles.length ? 'Trio' : 'pętla', todayIso: today, generatedAtMs: now, patterns });
    const html = renderClinicReportHtml(report);
    console.log(JSON.stringify({ event: 'clinic_report', patient_id: patientId, ms: Date.now() - started, cycles: cycles.length }));
    for (const [k, v] of this.reports) if (now - v.at >= 3_600_000) this.reports.delete(k);
    this.reports.set(key, { at: now, html });
    return { patient_id: patientId, version: 'clinic-report.v1', html };
  }

  async dismiss(principal: RequestPrincipal, patientId: string, key: string, body: unknown): Promise<Record<string, unknown>> {
    if (!isPatternKey(key)) throw new ValidationError('Unknown pattern');
    await this.assertAccess(principal, patientId);
    const state = await this.store.patterns.getState(patientId, key);
    if (!state) throw new NotFoundError('Pattern not found');
    // Lows are never hidden: a new night under 54 must still reach the phones.
    if (!canDismiss(state.pattern_id)) throw new ValidationError('Lows cannot be hidden');
    const dismissed = (body as Record<string, unknown> | null)?.dismissed !== false;
    const days = state.pattern_id === 'SETTING_CHECK' ? THERAPY_PATTERNS_STATE_POLICY.settingsDiscussedDays : THERAPY_PATTERNS_STATE_POLICY.dismissDays;
    const until = dismissed ? new Date(Date.now() + days * DAY).toISOString() : null;
    if (!(await this.store.patterns.setDismissed(patientId, key, until, principal.user_id ?? null))) throw new NotFoundError('Pattern not found');
    return { patient_id: patientId, key, dismissed_until: until };
  }

  /** The caregiver opened the pattern's card: it is no longer "Nowy" for them. */
  async markOpened(principal: RequestPrincipal, patientId: string, key: string): Promise<Record<string, unknown>> {
    if (!isPatternKey(key)) throw new ValidationError('Unknown pattern');
    await this.assertAccess(principal, patientId);
    if (!(await this.store.patterns.getState(patientId, key))) throw new NotFoundError('Pattern not found');
    const at = new Date().toISOString();
    if (principal.user_id) await this.store.patterns.markOpened(patientId, key, principal.user_id, at);
    return { patient_id: patientId, key, opened_at: at };
  }

  async openThread(principal: RequestPrincipal, patientId: string, key: string): Promise<Record<string, unknown>> {
    if (!isPatternKey(key)) throw new ValidationError('Unknown pattern');
    await this.assertAccess(principal, patientId);
    const state = await this.store.patterns.getState(patientId, key);
    if (!state) throw new NotFoundError('Pattern not found');
    const conversationId = await this.store.patterns.getOrCreateThread(patientId, key, state.pattern_id === 'CHANGE_CHECK' ? patternText(state.result).title : `Wzorzec: ${patternText(state.result).title.replace(/^./, (c) => c.toLowerCase())}`);
    return { patient_id: patientId, key, conversation_id: conversationId };
  }
}

@Controller('/v1/patients/:patientId/patterns')
@UseGuards(BearerPrincipalGuard, PatientPermissionGuard)
@UseFilters(ProblemDetailsFilter)
export class TherapyPatternsController {
  constructor(@Inject(TherapyPatternsApi) private readonly api: TherapyPatternsApi) {}

  @Get()
  async view(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string): Promise<Record<string, unknown>> {
    return this.api.view(principal, patientId);
  }

  @Get('report')
  async clinicReport(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string): Promise<Record<string, unknown>> {
    return this.api.clinicReport(principal, patientId);
  }

  @Post(':key/dismiss')
  @HttpCode(200)
  async dismiss(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Param('key') key: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.api.dismiss(principal, patientId, key, body);
  }

  @Post(':key/opened')
  @HttpCode(200)
  async markOpened(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Param('key') key: string): Promise<Record<string, unknown>> {
    return this.api.markOpened(principal, patientId, key);
  }

  @Post(':key/conversation')
  @HttpCode(200)
  async openThread(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Param('key') key: string): Promise<Record<string, unknown>> {
    return this.api.openThread(principal, patientId, key);
  }
}
