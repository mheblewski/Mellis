import { THERAPY_SETTING_ORDER, type TherapySettingKey, type TherapySettingsLayout, type TherapySettingsRequest } from './therapy-settings-request';

/**
 * The card above a chat answer about the therapy settings (therapy-settings-card.v1,
 * docs/product/therapy-settings-cards/HANDOFF.md). Built by code from the loop's profile in Nightscout, so every value,
 * hour and sentence on it is the profile's. The short text under it is code's too (therapySettingsReply): the card
 * answers the question, so no model is called. The app draws it; after
 * `live_until` it shows the history form (`history_title`, the hour instead of "teraz", no loop tile).
 */
export const THERAPY_SETTINGS_CARD_POLICY = {
  version: 'therapy-settings-card.v1',
  /** "teraz" holds this long after the answer; then the card is history. */
  live_minutes: 30,
  /** Loop data up to this old: the loop tile says "teraz". */
  loop_now_minutes: 15,
  /** Up to this old: the loop tile names the hour of the data; older: no tile. */
  loop_recent_minutes: 30,
  /**
   * No profile upload for this many days: the pill turns amber and a tile warns. Proposed in the HANDOFF; still to be
   * checked against how often Trio uploads an unchanged profile (docs/product/therapy-settings-cards/HANDOFF.md, open
   * question 2).
   */
  stale_days: 7,
} as const;

export interface TherapySettingsSegment {
  /** "00:00".."24:00", local in the profile's time zone. */
  start: string;
  end: string;
  value: number;
  /** Target only: the upper end when it differs from `value`. */
  high?: number;
  /** "0,35", "8,3", "100–120". */
  label: string;
}

export interface TherapySettingsLane {
  key: TherapySettingKey;
  /** "Baza", "ICR", "ISF", "Cel". */
  name: string;
  /** "j/h", "g na 1 j", "mg/dl na 1 j", "mg/dl". */
  unit: string;
  segments: TherapySettingsSegment[];
  /** Index in `segments` of the one at `at`. */
  current_index: number;
  /** "od 9:30 do 18:00" (across midnight when the day's last value goes on: "od 22:00 do 6:00"). */
  span_label: string;
  /** AT_ONE only: the segments before and after the current one. */
  previous: TherapySettingsSegment | null;
  next: TherapySettingsSegment | null;
  /** "ICR: od 0:00 do 6:00 10 g na 1 j; …; teraz 8,3" — one VoiceOver label per lane. */
  accessibility_label: string;
}

export interface TherapySettingsTableRow {
  start: string;
  end: string;
  /** One per lane, in the lanes' order; `changed`: the value is new in this row (bold), else repeated (grey). */
  values: Array<{ key: TherapySettingKey; label: string; changed: boolean }>;
  /** The row holding `at`. */
  current: boolean;
}

export interface TherapySettingsLoopNow {
  kind: 'TEMP' | 'PLAN' | 'SUSPENDED';
  rate_u_per_h: number | null;
  /** Local "12:58": when the loop data were sent. */
  at: string;
  /** Local time the pump was suspended. */
  since: string | null;
  text: string;
}

export interface TherapySettingsCard {
  version: typeof THERAPY_SETTINGS_CARD_POLICY.version;
  /** NO_PROFILE: the card holds only `missing`. */
  layout: TherapySettingsLayout | 'NO_PROFILE';
  /** "ICR teraz", "Baza z planu o 3:00", "Ustawienia terapii", "ICR i ISF", "Ustawienia o 18:30". */
  title: string;
  /** The title once the card is history: "ICR o 13:20". */
  history_title: string;
  patient_name: string | null;
  /** "Trio", "Loop". */
  source_label: string;
  /** "zmiana 3 lis": the day a value last changed; null when unknown. */
  changed_label: string | null;
  /** "12 dni temu": the profile has not been uploaded for a long time (amber pill + `stale_text`). */
  stale_label: string | null;
  stale_text: string | null;
  /** Local "13:20": where the marker stands. */
  at: string;
  is_now: boolean;
  /** ISO; null for a card about an hour. After it the app shows the history form. */
  live_until: string | null;
  settings: TherapySettingsLane[];
  /** The sentence under the value (SINGLE, AT_ONE). */
  sentence: string | null;
  /** "Pokazuję 7:00 rano.": an hour said without the part of the day whose values differ at 7:00 and 19:00. */
  hour_note: string | null;
  loop_now: TherapySettingsLoopNow | null;
  /** All hours: one column per lane, a new row at every change of any of them. */
  table: TherapySettingsTableRow[];
  footer: string | null;
  basal_plan_total_u: number | null;
  dia_hours: number | null;
  missing: { title: string; text: string } | null;
}

/** The profile as the context holds it (getTherapyProfileAt). */
export interface TherapySettingsProfile {
  status: string;
  units: string | null;
  timezone: string | null;
  dia_hours: number | null;
  carb_ratio_g_per_u: Array<[string, number]> | null;
  sensitivity_per_u: Array<[string, number]> | null;
  basal_u_per_h: Array<[string, number]> | null;
  target_low: Array<[string, number]> | null;
  target_high: Array<[string, number]> | null;
}

/** The basal the loop runs now (dashboard-basal-now.v1) and when its data were sent. */
export interface TherapySettingsLoopInput {
  source: 'TEMP' | 'PROFILE' | 'SUSPENDED' | 'UNKNOWN';
  rate: number | null;
  /** The plan now, to tell a temp basal at the plan's rate from a real one. */
  plan_rate: number | null;
  since: string | null;
  /** ISO of the loop's newest status. */
  status_at: string | null;
}

const NAMES: Record<TherapySettingKey, { name: string; inSentence: string; unit: string }> = {
  BASAL: { name: 'Baza', inSentence: 'baza', unit: 'j/h' },
  ICR: { name: 'ICR', inSentence: 'ICR', unit: 'g na 1 j' },
  ISF: { name: 'ISF', inSentence: 'ISF', unit: 'mg/dl na 1 j' },
  TARGET: { name: 'Cel', inSentence: 'cel', unit: 'mg/dl' },
};
const MONTHS_SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
const NBSP = ' ';
const DAY_MINUTES = 24 * 60;

/** "0,35" (basal: at least two decimals), "8,3", "250". */
export function formatSettingValue(key: TherapySettingKey, value: number): string {
  const text = key === 'BASAL'
    ? (Math.round(value * 1000) / 1000).toFixed(3).replace(/0$/, '')
    : String(Math.round(value * 100) / 100);
  return text.replace('.', ',');
}

/** "9:30", "24:00". */
function clock(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}
const toMinutes = (time: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes < DAY_MINUTES ? minutes : null;
};
const stamp = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

interface Run { start: number; end: number; value: number; high?: number }

/**
 * A profile schedule as runs over the whole day: sorted, from midnight (a schedule starting later wraps its last value
 * over midnight), equal neighbours merged. Null without a usable entry.
 */
export function scheduleRuns(entries: Array<[string, number]> | null | undefined): Run[] | null {
  const points = (entries ?? [])
    .map(([time, value]) => ({ start: toMinutes(String(time)), value: Number(value) }))
    .filter((point): point is { start: number; value: number } => point.start !== null && Number.isFinite(point.value))
    .sort((left, right) => left.start - right.start);
  if (points.length === 0) return null;
  if (points[0].start > 0) points.unshift({ start: 0, value: points[points.length - 1].value });
  const runs: Run[] = [];
  points.forEach((point, index) => {
    const end = points[index + 1]?.start ?? DAY_MINUTES;
    if (end <= point.start) return;
    const last = runs[runs.length - 1];
    if (last && last.value === point.value) last.end = end;
    else runs.push({ start: point.start, end, value: point.value });
  });
  return runs;
}

/** The target as runs of low and high, a new run wherever either changes. */
function targetRuns(low: Array<[string, number]> | null, high: Array<[string, number]> | null): Run[] | null {
  const lows = scheduleRuns(low) ?? scheduleRuns(high);
  const highs = scheduleRuns(high) ?? lows;
  if (!lows || !highs) return null;
  const at = (runs: Run[], minute: number) => runs.find((run) => run.start <= minute && minute < run.end)!.value;
  const starts = [...new Set([...lows, ...highs].map((run) => run.start))].sort((left, right) => left - right);
  const runs: Run[] = [];
  starts.forEach((start, index) => {
    const end = starts[index + 1] ?? DAY_MINUTES;
    const value = Math.min(at(lows, start), at(highs, start));
    const top = Math.max(at(lows, start), at(highs, start));
    const last = runs[runs.length - 1];
    if (last && last.value === value && (last.high ?? last.value) === top) last.end = end;
    else runs.push({ start, end, value, ...(top !== value ? { high: top } : {}) });
  });
  return runs;
}

function runsOf(key: TherapySettingKey, profile: TherapySettingsProfile): Run[] | null {
  if (key === 'BASAL') return scheduleRuns(profile.basal_u_per_h);
  if (key === 'ICR') return scheduleRuns(profile.carb_ratio_g_per_u);
  if (key === 'ISF') return scheduleRuns(profile.sensitivity_per_u);
  return targetRuns(profile.target_low, profile.target_high);
}

const labelOf = (key: TherapySettingKey, run: { value: number; high?: number }) =>
  run.high !== undefined ? `${formatSettingValue(key, run.value)}–${formatSettingValue(key, run.high)}` : formatSettingValue(key, run.value);
const segmentOf = (key: TherapySettingKey, run: Run): TherapySettingsSegment => ({
  start: stamp(run.start),
  end: run.end === DAY_MINUTES ? '24:00' : stamp(run.end),
  value: run.value,
  ...(run.high !== undefined ? { high: run.high } : {}),
  label: labelOf(key, run),
});
const indexAt = (runs: Run[], minute: number) => runs.findIndex((run) => run.start <= minute && minute < run.end);

/** The current run's hours, across midnight when the first and last runs hold the same value. */
function spanOf(runs: Run[], index: number): { start: number; end: number } {
  const wraps = runs.length > 1 && runs[0].value === runs[runs.length - 1].value && runs[0].high === runs[runs.length - 1].high;
  const run = runs[index];
  return {
    start: wraps && index === 0 ? runs[runs.length - 1].start : run.start,
    end: wraps && index === runs.length - 1 ? runs[0].end : run.end,
  };
}

const sentenceHour = (minutes: number) => (minutes === DAY_MINUTES || minutes === 0 ? 'północy' : clock(minutes));

/** The local "HH:MM" and the minute of the day of an instant in a time zone. */
function localClock(at: Date, timeZone: string): { minute: number; text: string } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  return { minute: hour * 60 + minute, text: clock(hour * 60 + minute) };
}

function localDayNumber(iso: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(pick('year'), pick('month') - 1, pick('day')) / 86_400_000;
}

/** "zmiana 3 lis". */
export function changedLabel(changedAt: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, month: 'numeric', day: 'numeric' }).formatToParts(new Date(changedAt));
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return `zmiana ${pick('day')} ${MONTHS_SHORT[pick('month') - 1]}`;
}

/** "6 godzin", "3 godziny", "1 godzina", "6,5 godziny". */
function hoursText(hours: number): string {
  if (!Number.isInteger(hours)) return `${String(Math.round(hours * 10) / 10).replace('.', ',')} godziny`;
  if (hours === 1) return '1 godzina';
  const lastDigit = hours % 10;
  const lastTwo = hours % 100;
  return `${hours} ${lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'godziny' : 'godzin'}`;
}

/** The plan's basal over 24 h, U. */
export function basalPlanTotal(runs: Run[] | null): number | null {
  if (!runs) return null;
  return Math.round(runs.reduce((sum, run) => sum + run.value * (run.end - run.start) / 60, 0) * 100) / 100;
}

const isNightMinute = (minute: number) => minute >= 22 * 60 || minute < 6 * 60;

function titleList(keys: TherapySettingKey[]): string {
  const names = keys.map((key, index) => (index === 0 ? NAMES[key].name : NAMES[key].inSentence));
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} i ${names[names.length - 1]}`;
}

function titlesOf(layout: TherapySettingsLayout, keys: TherapySettingKey[], at: string, nowText: string): { title: string; history: string } {
  const single = (when: string) => (keys[0] === 'BASAL' ? `Baza z planu ${when}` : `${NAMES[keys[0]].name} ${when}`);
  if (layout === 'SINGLE') return { title: single('teraz'), history: single(`o ${nowText}`) };
  if (layout === 'AT_ONE') return { title: single(`o ${at}`), history: single(`o ${at}`) };
  if (layout === 'OVERVIEW') return { title: 'Ustawienia terapii', history: 'Ustawienia terapii' };
  if (layout === 'COMBO') return { title: titleList(keys), history: titleList(keys) };
  const many = keys.length === 4 ? `Ustawienia o ${at}` : `${titleList(keys)} o ${at}`;
  return { title: many, history: many };
}

/** "Pętla ustawiła teraz bazę tymczasową 0,20 j/h." and the other loop tile sentences; null: no tile. */
export function loopTile(loop: TherapySettingsLoopInput | null, now: Date, timeZone: string): TherapySettingsLoopNow | null {
  if (!loop?.status_at || loop.source === 'UNKNOWN') return null;
  const ageMinutes = (now.getTime() - Date.parse(loop.status_at)) / 60_000;
  if (!Number.isFinite(ageMinutes) || ageMinutes < -2 || ageMinutes > THERAPY_SETTINGS_CARD_POLICY.loop_recent_minutes) return null;
  const at = localClock(new Date(loop.status_at), timeZone).text;
  const fresh = ageMinutes <= THERAPY_SETTINGS_CARD_POLICY.loop_now_minutes;
  const rateText = (rate: number) => `${formatSettingValue('BASAL', rate)}${NBSP}j/h`;
  if (loop.source === 'SUSPENDED') {
    const since = loop.since ? localClock(new Date(loop.since), timeZone).text : null;
    return since ? { kind: 'SUSPENDED', rate_u_per_h: 0, at, since, text: `Pompa wstrzymana od ${since}.` } : null;
  }
  if (loop.rate === null) return null;
  const temp = loop.source === 'TEMP' && (loop.plan_rate === null || Math.abs(loop.rate - loop.plan_rate) > 1e-6);
  if (!fresh) return { kind: temp ? 'TEMP' : 'PLAN', rate_u_per_h: loop.rate, at, since: null, text: `Pętla podawała ${rateText(loop.rate)} o ${at}.` };
  return temp
    ? { kind: 'TEMP', rate_u_per_h: loop.rate, at, since: null, text: `Pętla ustawiła teraz bazę tymczasową ${rateText(loop.rate)}.` }
    : { kind: 'PLAN', rate_u_per_h: loop.rate, at, since: null, text: 'Pętla podaje teraz bazę z planu.' };
}

/**
 * The card for a settings question, or null when the profile is in units the card does not draw (mmol/l). A profile
 * missing in Mellis gives the NO_PROFILE card.
 */
export function buildTherapySettingsCard(args: {
  request: Extract<TherapySettingsRequest, { kind: 'CARD' }>;
  profile: TherapySettingsProfile | null;
  now: Date;
  /** The patient's zone, used when the profile names none. */
  timeZone: string;
  patientName: string | null;
  /** The loop's name: "Trio", "Loop"; `genitive` for "z Trio", "z Loopa". */
  loop: { nominative: string; genitive: string };
  /** When a profile value last changed (lastTherapyChange); null: unknown. */
  changedAt: string | null;
  /** When the loop last uploaded its profile. */
  uploadedAt: string | null;
  loopNow: TherapySettingsLoopInput | null;
}): TherapySettingsCard | null {
  const { request, profile, now } = args;
  const timeZone = profile?.timezone && isValidZone(profile.timezone) ? profile.timezone : args.timeZone;
  const nowClock = localClock(now, timeZone);
  const atMinute = request.at ? request.at.hour * 60 + request.at.minute : nowClock.minute;
  const at = clock(atMinute);
  const isNow = request.at === null;
  const base = {
    version: THERAPY_SETTINGS_CARD_POLICY.version,
    patient_name: args.patientName,
    source_label: args.loop.nominative,
    at,
    is_now: isNow,
    live_until: isNow ? new Date(now.getTime() + THERAPY_SETTINGS_CARD_POLICY.live_minutes * 60_000).toISOString() : null,
  };
  if (profile && profile.units && /mmol/i.test(profile.units)) return null;

  const lanesRuns = (profile && profile.status === 'KNOWN' ? request.settings : [])
    .map((key) => ({ key, runs: runsOf(key, profile!) }))
    .filter((lane): lane is { key: TherapySettingKey; runs: Run[] } => lane.runs !== null);
  if (!profile || lanesRuns.length === 0) {
    return {
      ...base,
      layout: 'NO_PROFILE',
      title: '',
      history_title: '',
      changed_label: null,
      stale_label: null,
      stale_text: null,
      settings: [],
      sentence: null,
      hour_note: null,
      loop_now: null,
      table: [],
      footer: null,
      basal_plan_total_u: null,
      dia_hours: null,
      missing: { title: `Mellis nie ma jeszcze ustawień z ${args.loop.genitive}.`, text: `Pojawią się, gdy ${args.loop.nominative} wyśle profil do Nightscout.` },
    };
  }

  const keys = lanesRuns.map((lane) => lane.key);
  // A setting asked for but missing from the profile drops out; the layout follows what is left.
  const layout: TherapySettingsLayout = request.layout === 'OVERVIEW'
    ? 'OVERVIEW'
    : request.at
      ? (keys.length === 1 && request.layout === 'AT_ONE' ? 'AT_ONE' : 'AT_MANY')
      : keys.length === 1 ? 'SINGLE' : 'COMBO';
  const single = layout === 'SINGLE' || layout === 'AT_ONE';

  const settings: TherapySettingsLane[] = lanesRuns.map(({ key, runs }) => {
    const index = indexAt(runs, atMinute);
    const span = spanOf(runs, index);
    const segments = runs.map((run) => segmentOf(key, run));
    const wraps = runs.length > 2 && runs[0].value === runs[runs.length - 1].value && runs[0].high === runs[runs.length - 1].high;
    const previousIndex = index > 0 ? index - 1 : wraps ? runs.length - 2 : -1;
    const nextIndex = index < runs.length - 1 ? index + 1 : wraps ? 1 : -1;
    const unit = NAMES[key].unit;
    return {
      key,
      name: NAMES[key].name,
      unit,
      segments,
      current_index: index,
      span_label: `od ${clock(span.start)} do ${clock(span.end)}`,
      previous: layout === 'AT_ONE' && previousIndex >= 0 && previousIndex !== index ? segments[previousIndex] : null,
      next: layout === 'AT_ONE' && nextIndex >= 0 && nextIndex !== index ? segments[nextIndex] : null,
      accessibility_label: `${NAMES[key].name}: ${runs.map((run) => `od ${clock(run.start)} do ${clock(run.end)} ${labelOf(key, run)} ${unit}`).join('; ')}; ${isNow ? 'teraz' : `o ${at}`} ${segments[index].label}`,
    };
  });

  // The sentence under the value of a one-setting card.
  let sentence: string | null = null;
  if (single) {
    const { key, runs } = lanesRuns[0];
    const index = indexAt(runs, atMinute);
    const span = spanOf(runs, index);
    const previous = runs[index - 1] ?? (runs.length > 1 ? runs[runs.length - 1] : undefined);
    if (runs.length === 1) sentence = 'Ta wartość jest ustawiona na całą dobę.';
    else if (layout === 'AT_ONE' && atMinute === runs[index].start && previous && labelOf(key, previous) !== labelOf(key, runs[index])) {
      const unit = NAMES[key].unit;
      sentence = `O ${at} ${NAMES[key].inSentence} zmienia się z ${labelOf(key, previous)} na ${labelOf(key, runs[index])} ${unit} i zostaje tak do ${sentenceHour(span.end)}.`;
    } else {
      sentence = `Ta wartość jest ustawiona od ${clock(span.start)} do ${sentenceHour(span.end)}.`;
    }
  }

  // "o 7" and 19:00 holds another value: say which one the card shows.
  let hourNote: string | null = null;
  if (request.at?.ambiguous) {
    const evening = atMinute + 12 * 60;
    const differs = lanesRuns.some(({ key, runs }) => labelOf(key, runs[indexAt(runs, atMinute)]) !== labelOf(key, runs[indexAt(runs, evening)]));
    if (differs) hourNote = `Pokazuję ${at} ${request.at.hour < 6 ? 'w nocy' : 'rano'}.`;
  }

  // One shared table: a row at every change of any lane.
  const starts = [...new Set(lanesRuns.flatMap(({ runs }) => runs.map((run) => run.start)))].sort((left, right) => left - right);
  const table: TherapySettingsTableRow[] = starts.map((start, rowIndex) => {
    const end = starts[rowIndex + 1] ?? DAY_MINUTES;
    return {
      start: stamp(start),
      end: end === DAY_MINUTES ? '24:00' : stamp(end),
      values: lanesRuns.map(({ key, runs }) => {
        const run = runs[indexAt(runs, start)];
        return { key, label: labelOf(key, run), changed: rowIndex === 0 || run.start === start };
      }),
      current: start <= atMinute && atMinute < end,
    };
  });

  const basalRuns = scheduleRuns(profile.basal_u_per_h);
  const basalTotal = basalPlanTotal(basalRuns);
  const basalTotalText = basalTotal !== null ? `W planie jest ${formatSettingValue('BASAL', basalTotal)} j bazy na dobę.` : null;
  let footer: string | null = null;
  if (layout === 'OVERVIEW') {
    footer = [basalTotalText, profile.dia_hours ? `Czas działania insuliny w ustawieniach: ${hoursText(profile.dia_hours)}.` : null].filter(Boolean).join(' ') || null;
  } else if (single) {
    const lane = settings[0];
    const current = lane.segments[lane.current_index];
    if (lane.key === 'BASAL') footer = layout === 'AT_ONE' ? (isNightMinute(atMinute) ? `To plan z ${args.loop.genitive}. Pętla może w nocy podawać więcej albo mniej.` : null) : basalTotalText;
    else if (lane.key === 'ICR') footer = layout === 'SINGLE' ? 'Im mniej gramów na 1 j, tym więcej insuliny na ten sam posiłek.' : null;
    else if (lane.key === 'ISF') footer = layout === 'SINGLE' ? `Według ustawień 1 j insuliny obniża glukozę o ${current.label} mg/dl.` : null;
    else if (current.high !== undefined) footer = `Pętla celuje w środek: ${formatSettingValue('TARGET', (current.value + current.high) / 2)} mg/dl.`;
  }

  // Stale profile: no upload for a long time.
  let staleLabel: string | null = null;
  let staleText: string | null = null;
  if (args.uploadedAt && Number.isFinite(Date.parse(args.uploadedAt))) {
    const days = localDayNumber(now.toISOString(), timeZone) - localDayNumber(args.uploadedAt, timeZone);
    if (days >= THERAPY_SETTINGS_CARD_POLICY.stale_days) {
      staleLabel = `${days} dni temu`;
      staleText = `Ustawienia z ${args.loop.genitive} są sprzed ${days} dni. Jeśli od tego czasu coś się zmieniło, karta tego nie pokaże.`;
    }
  }

  const titles = titlesOf(layout, keys, at, nowClock.text);
  return {
    ...base,
    layout,
    title: titles.title,
    history_title: titles.history,
    changed_label: args.changedAt && Number.isFinite(Date.parse(args.changedAt)) ? changedLabel(args.changedAt, timeZone) : null,
    stale_label: staleLabel,
    stale_text: staleText,
    settings,
    sentence,
    hour_note: hourNote,
    loop_now: layout === 'SINGLE' && keys[0] === 'BASAL' && staleText === null ? loopTile(args.loopNow, now, timeZone) : null,
    table,
    footer,
    basal_plan_total_u: basalTotal,
    dia_hours: profile.dia_hours,
    missing: null,
  };
}

/**
 * The answer under a settings card, written by code (therapy-settings-reply.v1): the card already answers the question
 * (the request reader leaves judgements, what-ifs, doses and history to the usual answer), so a model would only add
 * a line without numbers. The chip asks for the other settings when the card shows only some of them.
 */
export const THERAPY_SETTINGS_REPLY_POLICY = {
  version: 'therapy-settings-reply.v1',
  all_settings_chip: 'Pokaż wszystkie ustawienia',
} as const;

export function therapySettingsReply(card: TherapySettingsCard, loop: { locative: string }): { text: string; chips: string[] } {
  if (card.layout === 'NO_PROFILE') return { text: `Do tego czasu ustawienia są widoczne w ${loop.locative}.`, chips: [] };
  const text = card.hour_note ?? `To ustawienia z profilu w ${loop.locative}.`;
  const showsAll = card.layout === 'OVERVIEW' || card.settings.length === THERAPY_SETTING_ORDER.length;
  return { text, chips: showsAll ? [] : [THERAPY_SETTINGS_REPLY_POLICY.all_settings_chip] };
}

function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** One stored profile upload: when the loop sent it and its values. */
export interface TherapyProfileUpload {
  uploaded_at: string;
  profile: Record<string, unknown> | null;
}

const SETTINGS_FIELDS = ['basal', 'carbratio', 'sens', 'target_low', 'target_high', 'dia'] as const;

function settingsFingerprint(profile: Record<string, unknown> | null): string {
  const normalize = (value: unknown): unknown => (Array.isArray(value)
    ? value.map((entry) => {
      const record = entry as Record<string, unknown>;
      return [toMinutes(String(record?.time ?? '')), Number(record?.value)];
    })
    : value === undefined || value === null ? null : Number(value));
  return JSON.stringify(SETTINGS_FIELDS.map((field) => normalize(profile?.[field])));
}

/**
 * When a setting last changed, from the stored uploads, newest first. Trio uploads its profile again with a new start
 * date without any value changing, so the newest upload's date is not the change: the change is the oldest upload of
 * the run of uploads holding the same values as the newest. Null without uploads; `complete` false when every listed
 * upload holds the same values (the change may be older than the list).
 */
export function lastTherapyChange(uploads: TherapyProfileUpload[]): { changed_at: string; uploaded_at: string; complete: boolean } | null {
  const sorted = uploads
    .filter((upload) => Number.isFinite(Date.parse(upload.uploaded_at)))
    .sort((left, right) => Date.parse(right.uploaded_at) - Date.parse(left.uploaded_at));
  if (sorted.length === 0) return null;
  const newest = settingsFingerprint(sorted[0].profile);
  let changedAt = sorted[0].uploaded_at;
  for (const upload of sorted.slice(1)) {
    if (settingsFingerprint(upload.profile) !== newest) return { changed_at: changedAt, uploaded_at: sorted[0].uploaded_at, complete: true };
    changedAt = upload.uploaded_at;
  }
  return { changed_at: changedAt, uploaded_at: sorted[0].uploaded_at, complete: false };
}

/** A stored card as the app may read it; null for anything else. */
export function sanitizeTherapySettingsCard(value: unknown): TherapySettingsCard | null {
  if (typeof value !== 'object' || value === null) return null;
  const card = value as Record<string, unknown>;
  if (card.version !== THERAPY_SETTINGS_CARD_POLICY.version) return null;
  if (!['OVERVIEW', 'SINGLE', 'COMBO', 'AT_ONE', 'AT_MANY', 'NO_PROFILE'].includes(String(card.layout))) return null;
  if (typeof card.at !== 'string' || typeof card.is_now !== 'boolean' || typeof card.source_label !== 'string') return null;
  if (!Array.isArray(card.settings) || !Array.isArray(card.table)) return null;
  const lanesOk = (card.settings as unknown[]).every((lane) => {
    const record = lane as Record<string, unknown>;
    return THERAPY_SETTING_ORDER.includes(record?.key as TherapySettingKey)
      && Array.isArray(record.segments) && record.segments.length > 0
      && (record.segments as Array<Record<string, unknown>>).every((segment) => typeof segment?.start === 'string' && typeof segment?.end === 'string' && typeof segment?.value === 'number' && Number.isFinite(segment.value) && typeof segment?.label === 'string')
      && typeof record.current_index === 'number' && record.current_index >= 0 && record.current_index < record.segments.length;
  });
  if (!lanesOk) return null;
  if (card.layout === 'NO_PROFILE' ? !card.missing : (card.settings as unknown[]).length === 0) return null;
  return card as unknown as TherapySettingsCard;
}
