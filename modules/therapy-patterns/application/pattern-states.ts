import type { PatternId, PatternResult } from './pattern-detectors';
import { dayPart, THERAPY_PATTERNS_POLICY } from './pattern-detectors';
import { localParts } from '@modules/settings-insights/application/settings-insights-common';

/**
 * "Wzorce" (therapy-patterns.v1): what the nightly run keeps per pattern, when an owner gets a push about it,
 * and the texts of its card. Pure functions; the service and the repository do the rest.
 */
export const THERAPY_PATTERNS_STATE_POLICY = {
  version: 'therapy-patterns-state.v1',
  /** The nightly run starts at this local hour. */
  runHour: 4,
  /** Weekly push: Sunday evening, local time. */
  weeklyWeekday: 0,
  weeklyFromHour: 18,
  weeklyToHour: 21,
  /** Last night under 54 (any night, after food too): checked from 7:00; while glucose is under 70 it waits, until 12:00. */
  urgentFromHour: 7,
  urgentToHour: 12,
  /** At most one push a week per patient (an urgent one may come in between). */
  minDaysBetweenPushes: 6,
  /** The same pattern again: only when it came back after this many days, or got half as bad again. */
  repeatAfterDays: 28,
  worseFactor: 1.5,
  /** "Nie dotyczy nas" hides a pattern (and its pushes) for this long. */
  dismissDays: 30,
  /** "Omówione z poradnią" (the settings card) hides it until one of its values changes; this is only the ceiling. */
  settingsDiscussedDays: 365,
  /** No push while glucose is under this (a low is being handled). */
  noPushBelowMgdl: 70,
} as const;

const S = THERAPY_PATTERNS_STATE_POLICY;
const DAY = 86_400_000;

/** Lows first, always (the retired patterns last: they are no longer run). */
export const PATTERN_ORDER: PatternId[] = ['NIGHT_LOWS', 'TIME_BELOW_GOAL', 'DAY_LOWS_WITHOUT_FOOD', 'RESCUE_REBOUND', 'MEAL_RISES_SAME_TIME', 'SETTING_CHECK', 'FOLLOW_UP_PORTIONS', 'LOOP_CANNOT_ADD'];

export interface PatternState {
  pattern_key: string;
  pattern_id: PatternId;
  shown: boolean;
  result: PatternResult;
  severity: number;
  first_shown_at: string | null;
  last_shown_at: string | null;
  computed_at: string;
  notified_at: string | null;
  notified_severity: number | null;
  dismissed_until: string | null;
  revision: number;
  /** Who chose "Nie dotyczy nas" / "Omówione z poradnią" (display name), when it is hidden. */
  dismissed_by?: string | null;
}

/**
 * Shown only in the clinic report, not on the list (plan to 9/10, D5): nothing for the family to do between visits.
 * They never push.
 */
export const REPORT_ONLY: PatternId[] = ['SETTING_CHECK', 'RESCUE_REBOUND'];

/** One key per pattern and, for patterns of one time of day, per hours ("MEAL_RISES_SAME_TIME.1800-2400"). */
export function patternKey(result: PatternResult): string {
  if (result.id === 'CHANGE_CHECK') return `CHANGE_CHECK.${String(result.stats.date ?? '')}`;
  // Its usual meal hours may move from night to night: the pattern stays one (review 2026-11-12, B7).
  if (result.id === 'LOWS_AFTER_MEAL_BOLUS' || result.id === 'TIME_BELOW_GOAL' || result.id === 'NIGHT_LOWS') return result.id;
  const block = result.stats.block;
  if (block === null || block === undefined || block === '') return result.id;
  const slug = typeof block === 'number' ? String(block) : String(block).replace(/:/g, '').replace(/[–—]/g, '-');
  return `${result.id}.${slug}`;
}

export function isPatternKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z_]{3,40}(\.[0-9-]{1,12})?$/.test(value);
}

/** One number per pattern, larger = worse; compared against the one a push was sent at. */
export function patternSeverity(result: PatternResult): number {
  const n = (key: string) => (typeof result.stats[key] === 'number' ? result.stats[key] as number : 0);
  switch (result.id) {
    case 'NIGHT_LOWS': return n('nights') + n('very_low_nights');
    case 'LOWS_AFTER_MEAL_BOLUS': return n('days') + n('very_low_days');
    case 'TIME_BELOW_GOAL': return n('share_below_70') + 4 * n('share_below_54');
    case 'DAY_LOWS_WITHOUT_FOOD': return n('days');
    case 'FOLLOW_UP_PORTIONS': return Math.max(0, n('rate') - n('base'));
    case 'MEAL_RISES_SAME_TIME': return n('meals') ? Math.max(0, (100 * n('rises')) / n('meals') - n('base')) : 0;
    case 'RESCUE_REBOUND': return n('treated') ? (100 * n('rebound')) / n('treated') : 0;
    case 'LOOP_CANNOT_ADD': return n('days');
    case 'SETTING_CHECK': return n('facts');
    default: return 0;
  }
}

/**
 * Tonight's results merged into the stored states. Shown results are upserted by key; stored patterns not shown tonight
 * stay (with their last shown result) as not shown. A pattern that comes back after `repeatAfterDays` since its push
 * starts again as new (it may push again).
 */
export function mergeStates(previous: PatternState[], results: PatternResult[], nowMs: number): PatternState[] {
  const now = new Date(nowMs).toISOString();
  const byKey = new Map(previous.map((s) => [s.pattern_key, s]));
  const shownKeys = new Set<string>();
  const out: PatternState[] = [];
  for (const raw of results) {
    // A fact card stays until clearly back within the goal (< 3.5 % / < 0.8 %): no flapping "new" every few nights.
    const before = byKey.get(patternKey(raw));
    const result = raw.id === 'TIME_BELOW_GOAL' && !raw.shown && before?.shown
      && ((Number(raw.stats.share_below_70) || 0) >= 3.5 || (Number(raw.stats.share_below_54) || 0) >= 0.8)
      ? { ...raw, shown: true, failed: [] } : raw;
    if (!result.shown) continue;
    const key = sameWindowKey(result, previous, shownKeys) ?? patternKey(result);
    shownKeys.add(key);
    const prev = byKey.get(key);
    const cameBack = prev && !prev.shown && (!prev.notified_at || nowMs - Date.parse(prev.notified_at) >= S.repeatAfterDays * DAY);
    out.push({
      pattern_key: key,
      pattern_id: result.id,
      shown: true,
      result,
      severity: patternSeverity(result),
      first_shown_at: !prev?.first_shown_at || cameBack ? now : prev.first_shown_at,
      last_shown_at: now,
      computed_at: now,
      notified_at: prev?.notified_at ?? null,
      notified_severity: prev?.notified_severity ?? null,
      // "Omówione z poradnią" lasts until one of the settings changes.
      dismissed_until: result.id === 'SETTING_CHECK' && prev && settingsChanged(prev.result, result) ? null : prev?.dismissed_until ?? null,
      revision: prev?.revision ?? -1,
    });
  }
  for (const prev of previous) if (!shownKeys.has(prev.pattern_key)) out.push({ ...prev, shown: false, computed_at: now });
  return out;
}

/**
 * The day lows' window slides by an hour (9–12 one night, 10–13 the next when a new low lands at 12:30): an overlapping
 * window of the previous run keeps its key, so the card is not "new" with a ghost under "Wcześniej wykryte".
 */
function sameWindowKey(result: PatternResult, previous: PatternState[], taken: Set<string>): string | null {
  if (result.id !== 'DAY_LOWS_WITHOUT_FOOD' || typeof result.stats.block !== 'number') return null;
  const exact = patternKey(result);
  if (previous.some((s) => s.pattern_key === exact)) return null;
  const hour = result.stats.block;
  const near = previous
    .filter((s) => s.pattern_id === result.id && !taken.has(s.pattern_key))
    .map((s) => ({ s, h: typeof s.result?.stats?.block === 'number' ? s.result.stats.block : Number(s.pattern_key.split('.')[1]) }))
    .filter(({ h }) => Number.isFinite(h) && Math.abs(h - hour) < 3)
    .sort((a, b) => Number(b.s.shown) - Number(a.s.shown) || Math.abs(a.h - hour) - Math.abs(b.h - hour));
  return near[0]?.s.pattern_key ?? null;
}

/** A setting changed: DIA exactly, the hours without microboluses by more than 2 (they wobble from night to night). */
function settingsChanged(before: PatternResult, after: PatternResult): boolean {
  const a = before.stats; const b = after.stats;
  if (typeof a.dia_hours === 'number' && typeof b.dia_hours === 'number' && a.dia_hours !== b.dia_hours) return true;
  if (typeof a.smb_blocked_hours === 'number' && typeof b.smb_blocked_hours === 'number' && Math.abs(a.smb_blocked_hours - b.smb_blocked_hours) > 2) return true;
  return false;
}

/** Lows are never hidden: a new night under 54 must still reach the phones. */
export const UNDISMISSABLE: PatternId[] = ['NIGHT_LOWS', 'TIME_BELOW_GOAL', 'DAY_LOWS_WITHOUT_FOOD', 'FOLLOW_UP_PORTIONS'];

export function canDismiss(id: PatternId): boolean {
  return !UNDISMISSABLE.includes(id);
}

export function isDismissed(state: PatternState, nowMs: number): boolean {
  return canDismiss(state.pattern_id) && state.dismissed_until !== null && Date.parse(state.dismissed_until) > nowMs;
}

/**
 * "Nowy" on a card: shown, and this caregiver has not opened it since it was first shown (owner 2026-11-14: "nowy dopóki
 * się go nie otworzy", not 7 days). A pattern that came back starts with a new first_shown_at, so it is new again.
 * Without a signed-in caregiver (auth off) nobody's opens are known: new for 7 days, as before.
 */
export function isPatternNew(state: PatternState, openedAt: string | null | undefined, nowMs: number, signedIn = true): boolean {
  if (!state.shown || !state.first_shown_at) return false;
  const first = Date.parse(state.first_shown_at);
  if (!signedIn) return nowMs - first < 7 * DAY;
  return !openedAt || Date.parse(openedAt) < first;
}

/** Why a pattern may push now: new (never sent, or came back), or worse by half since its push. */
function pushReason(state: PatternState, nowMs: number): 'NEW' | 'WORSE' | null {
  if (!state.shown || isDismissed(state, nowMs) || REPORT_ONLY.includes(state.pattern_id)) return null;
  // Nights under 54 have their own morning push (every night): not again on Sunday.
  if (state.pattern_id === 'NIGHT_LOWS') return null;
  if (!state.notified_at) return 'NEW';
  if (state.first_shown_at && Date.parse(state.first_shown_at) > Date.parse(state.notified_at)) return 'NEW';
  if (state.notified_severity !== null && state.notified_severity > 0 && state.severity >= state.notified_severity * S.worseFactor) return 'WORSE';
  return null;
}

export type PatternPushReason = 'NEW' | 'WORSE';

/**
 * The weekly push: Sunday 18–21, at most one in `minDaysBetweenPushes`, none while glucose is under 70 or unknown. The
 * morning push about last night is separate (`nightPushDue`) and never counts here (review 2026-11-12, B6).
 */
export function duePatternPush(
  states: PatternState[], nowMs: number, timeZone: string, glucose: number | null,
  /** Every owner's phone already opened this card since it was first shown: a "new" push would tell them nothing (2026-11-15). */
  seenByAll: (state: PatternState) => boolean = () => false,
): { state: PatternState; reason: PatternPushReason } | null {
  if (glucose === null || glucose < S.noPushBelowMgdl) return null;
  const { minute, weekday } = localParts(nowMs, timeZone);
  const hour = Math.floor(minute / 60);
  if (!(weekday === S.weeklyWeekday && hour >= S.weeklyFromHour && hour < S.weeklyToHour)) return null;
  const lastPush = Math.max(0, ...states.map((s) => (s.notified_at ? Date.parse(s.notified_at) : 0)));
  if (nowMs - lastPush < S.minDaysBetweenPushes * DAY) return null;
  const candidates = states
    // The change card is not a pattern: it never pushes.
    .filter((state) => state.pattern_id !== 'CHANGE_CHECK')
    .map((state) => ({ state, reason: pushReason(state, nowMs) }))
    .filter((c): c is { state: PatternState; reason: PatternPushReason } => c.reason !== null)
    // A worse pattern is new information even when its card was opened; a new one the owners have seen is not.
    .filter((c) => c.reason === 'WORSE' || !seenByAll(c.state))
    .sort((a, b) => PATTERN_ORDER.indexOf(a.state.pattern_id) - PATTERN_ORDER.indexOf(b.state.pattern_id));
  return candidates[0] ?? null;
}

/** One night's low under 54 (≥ 15 min, starting 0:00–6:00 local), found in the morning. */
export interface NightVeryLow { date: string; startMs: number; nadir: number; nadirMs: number; minutes: number; maybeCompression?: boolean }

/** Whether the morning push about last night is due now: 7:00–12:00 local, glucose known and at least 70. */
export function nightPushWindow(nowMs: number, timeZone: string, glucose: number | null): boolean {
  if (glucose === null || glucose < S.noPushBelowMgdl) return false;
  const hour = Math.floor(localParts(nowMs, timeZone).minute / 60);
  return hour >= S.urgentFromHour && hour < S.urgentToHour;
}

/** "Ostatniej nocy glukoza spadła poniżej 54" + facts only: nadir, its time, minutes (no cause: "after a meal bolus" failed the offline proof). */
export function nightPushText(low: NightVeryLow, timeZone: string): { title: string; body: string } {
  const t = (ms: number) => { const m = localParts(ms, timeZone).minute; return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
  const h = (min: number) => { const r = Math.round(min / 5) * 5; return r >= 60 ? `${Math.floor(r / 60)} h${r % 60 ? ` ${r % 60} min` : ''}` : `${r} min`; };
  const compression = low.maybeCompression ? ' Spadek był bardzo szybki i krótki: mógł to być ucisk na sensor.' : '';
  return { title: 'Ostatniej nocy glukoza spadła poniżej 54', body: `Najniżej ${Math.round(low.nadir)} o ${t(low.nadirMs)}, poniżej 54 przez ${h(low.minutes)}.${compression}` };
}

const hourText = (minute: number) => `${Math.floor(minute / 60)}${minute % 60 ? `:${String(minute % 60).padStart(2, '0')}` : ''}`;

/**
 * The card: a short title with the hours when the pattern has them, at most one question the data cannot answer (the
 * chat checks the rest), and the topic for the clinic. Never a cause, a dose or a setting value.
 */
export function patternText(result: PatternResult): { title: string; question: string | null; visit: string } {
  const n = (key: string) => (typeof result.stats[key] === 'number' ? result.stats[key] as number : null);
  switch (result.id) {
    case 'NIGHT_LOWS':
      return {
        title: result.stats.single === 1 ? 'Noc poniżej 54' : 'Noce poniżej 54',
        question: 'Co było wieczorem: wysiłek, korekta albo jedzenie przed snem?',
        visit: result.stats.single === 1 ? 'ta noc poniżej 54.' : 'noce poniżej 54.',
      };
    case 'TIME_BELOW_GOAL': {
      // The title names the goal actually missed; while the card is held by its hysteresis, "blisko celu" (round 4).
      const s70 = n('share_below_70') ?? 0; const s54 = n('share_below_54') ?? 0;
      const over70 = s70 > 4; const over54 = s54 > 1;
      const pc = (x: number) => String(x).replace('.', ',');
      const title = over70 && over54 ? 'Czas poniżej 70 i 54 ponad cel' : over70 ? 'Czas poniżej 70 ponad cel' : over54 ? 'Czas poniżej 54 ponad cel' : 'Czas poniżej 70 blisko celu';
      const facts = [over70 || !over54 ? `czas poniżej 70: ${pc(s70)}% (cel: poniżej 4%)` : '', over54 ? `czas poniżej 54: ${pc(s54)}% (cel: poniżej 1%)` : ''].filter(Boolean).join(', ');
      return {
        title,
        question: 'Czy przed spadkami był ruch albo zjedzone było mniej, niż zapisano?',
        // A fact, no setting named (review round 3): the clinic decides what to change.
        visit: `${facts}. Zmiany dawek omów z poradnią.`,
      };
    }
    // Retired (offline proof 2026-11-12): only old stored states, never listed.
    case 'LOWS_AFTER_MEAL_BOLUS':
      return { title: n('about_bolus') === 0 ? 'Spadki w ciągu dnia' : 'Spadki po bolusie do posiłku', question: null, visit: 'spadki. Zmiany dawek omów z poradnią.' };
    case 'DAY_LOWS_WITHOUT_FOOD': {
      const from = n('block');
      return { title: from === null ? 'Spadki bez jedzenia' : `Spadki między ${from} a ${from + 3} bez jedzenia`, question: 'Czy przed spadkiem był ruch: WF, spacer, zabawa?', visit: 'baza i ISF tych godzin.' };
    }
    case 'FOLLOW_UP_PORTIONS':
      return { title: 'Spadki po dokładanych bolusach', question: 'Po co był dokładany bolus: dokładka jedzenia czy wysoka glukoza?', visit: 'dzielenie bolusa przy jedzeniu.' };
    case 'MEAL_RISES_SAME_TIME': {
      const from = n('from_minute');
      const to = n('to_minute');
      const when = from !== null && to !== null ? ` ${dayPart(from, to)} (${hourText(from)}–${hourText(to)})` : '';
      const lows = (n('low_days') ?? 0) >= THERAPY_PATTERNS_POLICY.min_days;
      const part = from !== null && to !== null ? ` ${dayPart(from, to)}` : '';
      return {
        title: `Wzrosty po posiłkach${when}`,
        question: 'Co zwykle jest na talerzu o tej porze: szybkie węgle, dużo tłuszczu?',
        // With lows in the same hours no direction is named: both together (review 2026-11-12).
        visit: lows ? `wzrosty i spadki${part} razem: przelicznik i wrażliwość na insulinę.` : `przelicznik${part}.`,
      };
    }
    case 'RESCUE_REBOUND':
      return { title: 'Wysoka glukoza po leczeniu spadku', question: 'Czy zapisana porcja to wszystko, co było zjedzone (sok, dokładka)?', visit: 'postępowanie przy spadku z pętlą.' };
    case 'LOOP_CANNOT_ADD': {
      const from = n('block');
      return { title: from === null ? 'Wzrosty bez mikrobolusów' : `Wzrosty bez mikrobolusów między ${from} a ${from + 3}`, question: null, visit: 'baza i limit mikrobolusa w tych godzinach.' };
    }
    case 'SETTING_CHECK':
      return { title: 'Ustawienia do omówienia z poradnią', question: null, visit: 'czy te ustawienia pasują do obecnej insuliny.' };
    case 'CHANGE_CHECK': {
      const date = String(result.stats.date ?? '');
      return { title: `Zmiana z ${Number(date.slice(8))}.${date.slice(5, 7)}`, question: 'Co jeszcze zmieniło się w tych tygodniach: posiłki, sposób podawania bolusa, ruch, choroba?', visit: 'czy ta zmiana działa tak, jak zakładano.' };
    }
  }
}

/** The list's one line: the sentence, or for the settings card how many settings there are. */
export function patternSummary(result: PatternResult): string {
  if (result.id !== 'SETTING_CHECK') return result.sentence;
  const count = result.lines?.length ?? 0;
  return `${count} ${count === 1 ? 'ustawienie' : count < 5 ? 'ustawienia' : 'ustawień'} do omówienia`;
}

/**
 * The push: "Nowy wzorzec: …" when it was found today, "Wzorzec od 13.11: …" when it has been on the list since an
 * earlier day (the weekly push comes on Sunday), or "powtarza się częściej"; the body is the card's first sentence.
 */
export function patternPushText(state: PatternState, reason: PatternPushReason, nowMs?: number, timeZone?: string): { title: string; body: string } {
  const title = patternText(state.result).title;
  const lower = title.charAt(0).toLowerCase() + title.slice(1);
  if (state.pattern_id === 'SETTING_CHECK') {
    const count = state.result.lines?.length ?? 0;
    return { title: 'Nowy wzorzec: ustawienia do omówienia', body: `${count === 1 ? 'Jedno ustawienie' : `${count} ${count < 5 ? 'ustawienia' : 'ustawień'}`} Trio warto omówić w poradni.` };
  }
  if (state.pattern_id === 'TIME_BELOW_GOAL') return { title: `${title} (14 dni)`, body: state.result.sentence };
  const first = state.result.sentence.split(/(?<=\.)\s/)[0];
  if (reason === 'WORSE') return { title: `Wzorzec powtarza się częściej: ${lower}`, body: first };
  const since = nowMs !== undefined && timeZone && state.first_shown_at ? localParts(Date.parse(state.first_shown_at), timeZone).date : null;
  if (since && since !== localParts(nowMs!, timeZone!).date) {
    return { title: `Wzorzec od ${Number(since.slice(8))}.${since.slice(5, 7)}: ${lower}`, body: first };
  }
  return { title: `Nowy wzorzec: ${lower}`, body: first };
}

/** Rules for every pattern and change conversation (role review 2026-11-12). */
const SHARED_RULES = [
  'LOWS FIRST: if the same hours have lows (time below 70 over 4 % or any reading below 54 in the tool results), say that before any explanation of highs, and never suggest more insulin for highs without naming those lows.',
  'AFTER A LOW: never suggest a correction bolus within 3 hours after a treated low, and never suggest smaller rescue portions.',
  'MICROBOLUS: a microbolus limit (SMB cap) of 0 does not mean the loop gave no insulin — it could still raise the basal; say "pętla nie mogła dać mikrobolusa", never "pętla nie mogła dodać insuliny".',
  'SIMULATIONS: here a replay is only for a setting value the caregiver names in their message. Under every replay table write one line: "Odtworzenie na danych z <od>–<do> (<N> dni), nie zalecenie. Zmianę ustawień ustala poradnia." Give its results as % of time, like the card.',
].join('\n');

/**
 * The chat rules for a conversation about one pattern ("Omów z Mellis"): the pattern itself, then a fixed order of
 * checks, each explanation backed by a number from a tool result. Never a cause stated as fact, a dose or a setting value.
 */
export function patternChatInstructions(state: PatternState): string {
  const text = patternText(state.result);
  const pattern = {
    title: text.title,
    sentence: state.result.sentence,
    numbers: state.result.stats,
    episodes: state.result.episodes.slice(0, 20).map((e) => ({ date: e.date, at: new Date(e.at).toISOString(), note: e.note })),
    first_shown: state.first_shown_at?.slice(0, 10) ?? null,
    window: `${THERAPY_PATTERNS_POLICY.window_days} days ending last midnight`,
  };
  if (state.pattern_id === 'CHANGE_CHECK') {
    return [
      `ZMIANA USTAWIEŃ (change-check.v1): this conversation is about one Trio profile change and the same hours before and after it: ${JSON.stringify({ title: text.title, sentence: state.result.sentence, numbers: { ...state.result.stats, groups: state.result.groups ?? [] } })}. Questions here are about it unless the caregiver says otherwise; settings_insights is not needed for it.`,
      'ORDER (briefly): 1) the numbers before and after, with how many days each — say plainly when the days after are few (under 10: "za mało dni, by ocenić"); 2) what else differed between the two periods: meal sizes and times, how boluses were given (one dose or split, timing before the meal), number of boluses, exercise, illness signs, a new sensor or site — from daily_insulin_totals and the evidence in the context first, then at most four evidence tool calls (one day each) on the days that matter most, and give each difference with its number; 3) the loop: how often it held or raised the basal in these hours (get_basal_evidence: the loop\'s temp basals; get_loop_evidence holds only the loop\'s state now, not its past).',
      'GROUPS: the card compares each direction of the change separately (numbers.groups: hours with more insulin and hours with less); never merge them into one before/after.',
      'NEVER say the change helped, worked, hurt or failed, and never "przyczyną jest": the numbers changed while other things changed too (for example how boluses were given: one dose or split) — say plainly that these changes cannot be separated. Never give a dose, grams or a setting value; whether to keep the change is the clinic\'s decision.',
      SHARED_RULES,
      'END: one concrete question to bring to the clinic about this change, or what to watch until the comparison has 14 days.',
    ].join('\n');
  }
  return [
    `WZORZEC (therapy-patterns.v1): this conversation is about one pattern Mellis found in the last ${THERAPY_PATTERNS_POLICY.window_days} days: ${JSON.stringify(pattern)}. Questions here are about it unless the caregiver says otherwise; settings_insights is not needed for it.`,
    'ORDER (keep it, briefly): 1) is it real — the numbers, how many days; say so when the sample is small; 2) what else could explain it: illness, the sensor (first day, compression at night), unusual days, exercise, carbs not entered — look at the episode dates with the evidence tools; 3) bolus timing and portions around the episodes; 4) the settings of those hours (get_therapy_profile, get_basal_evidence); 5) loop limits: the microbolus limit and max IOB are not in the data (get_loop_evidence holds only the state now): name them as something to check in Trio, temporary targets are in therapy_context_events; 6) technique (site, insulin age). At most four evidence tool calls (one day each): use them on the episode days that matter most.',
    'EXPLANATIONS: give at least two possible explanations; for each, one number from a tool result (or from the pattern) that fits it or does not. Say which fits the data better and what cannot be checked from the data. Write "pasuje do danych" / "nie pasuje"; never "przyczyną jest".',
    'NEVER: a dose, a number of grams to give, or a recommended setting value; a change of settings is a topic for the diabetes clinic (poradnia) and the caregiver enters it in Trio. A value the caregiver asks about may be replayed with the simulation tools and named as tested. Never suggest skipping or restricting food. Numbers only from tool results or the pattern above.',
    ...(state.pattern_id === 'FOLLOW_UP_PORTIONS' && typeof state.result.stats.base === 'number' && state.result.stats.base >= 30
      ? [`FIRST FACT: lows also follow a single bolus at these times in ${state.result.stats.base}% of cases — say that first. Before any explanation compare the meal sizes and the total dose of the series with the single boluses (get_meal_evidence, get_insulin_evidence); a bigger meal split into parts is not the same as an extra dose.`]
      : []),
    ...(state.result.episodes.length < 6 ? ['FEW CASES: fewer than 6 episodes — say "mało przypadków" before drawing anything from them.'] : []),
    ...(state.result.episodes.length < 10 ? ['NOT "WYRAŹNY": under 10 episodes never call the pattern clear or strong ("wyraźny", "silny"); say instead "to niedużo przypadków; za tydzień będzie widać, czy się utrzymuje".'] : []),
    SHARED_RULES,
    'END: one concrete question to bring to the clinic, or one thing to watch in the coming week.',
  ].join('\n');
}
