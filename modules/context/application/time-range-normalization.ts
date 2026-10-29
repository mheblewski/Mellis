import { RangeSelectionProfileId } from './task-evidence-policy';

export const TIME_RANGE_NORMALIZATION_POLICY_VERSION = 'time-range-normalization.v1' as const;

export type ConversationTimeRangeType = 'TODAY' | 'SHORT_RANGE' | 'MEDIUM_RANGE' | 'LONG_RANGE' | 'EXTENDED_RANGE';

export interface NormalizedTimeRangeRequest {
  range_type: ConversationTimeRangeType;
  range_profile: RangeSelectionProfileId;
  range_start: string;
  range_end: string;
  timezone: string;
  normalization_policy_version: typeof TIME_RANGE_NORMALIZATION_POLICY_VERSION;
}

export type ParsedTimeRangeRequest =
  | { status: 'OK'; value: NormalizedTimeRangeRequest }
  | { status: 'AMBIGUOUS'; reason: string }
  | { status: 'INVALID'; reason: string };

const RANGE_TYPE_TO_DAYS: Record<ConversationTimeRangeType, number> = {
  TODAY: 1,
  SHORT_RANGE: 3,
  MEDIUM_RANGE: 7,
  LONG_RANGE: 14,
  EXTENDED_RANGE: 30,
};

const RANGE_TYPE_TO_PROFILE: Record<ConversationTimeRangeType, RangeSelectionProfileId> = {
  TODAY: 'SINGLE_DAY',
  SHORT_RANGE: 'SHORT_RANGE',
  MEDIUM_RANGE: 'MEDIUM_RANGE',
  LONG_RANGE: 'LONG_RANGE',
  EXTENDED_RANGE: 'EXTENDED_RANGE',
};

function isValidDateIso(value: string): boolean {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch);
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function getRangeDays(rangeType: ConversationTimeRangeType): number {
  return RANGE_TYPE_TO_DAYS[rangeType];
}

export function getRangeSelectionProfile(rangeType: ConversationTimeRangeType): RangeSelectionProfileId {
  return RANGE_TYPE_TO_PROFILE[rangeType];
}

export function isSupportedConversationTimeRangeType(value: string): value is ConversationTimeRangeType {
  return value === 'TODAY'
    || value === 'SHORT_RANGE'
    || value === 'MEDIUM_RANGE'
    || value === 'LONG_RANGE'
    || value === 'EXTENDED_RANGE';
}

function getLocalDateParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === 'year')?.value ?? '0');
  const month = Number(parts.find((part) => part.type === 'month')?.value ?? '0');
  const day = Number(parts.find((part) => part.type === 'day')?.value ?? '0');
  return { year, month, day };
}

function parseOffsetMinutes(offsetText: string): number {
  const normalized = offsetText.replace('UTC', 'GMT');
  if (normalized === 'GMT' || normalized === 'GMT+0' || normalized === 'GMT+00:00' || normalized === 'GMT-00:00') {
    return 0;
  }

  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(normalized);
  if (!match) {
    return 0;
  }

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? '0');
  return sign * ((hours * 60) + minutes);
}

function getTimeZoneOffsetMinutes(timezone: string, date: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
    minute: '2-digit',
  });
  const offsetText = formatter.formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  return parseOffsetMinutes(offsetText);
}

function zonedLocalMidnightUtcIso(args: { year: number; month: number; day: number; timezone: string; hour?: number; minute?: number }): string {
  const baseUtcMs = Date.UTC(args.year, args.month - 1, args.day, args.hour ?? 0, args.minute ?? 0, 0, 0);
  const firstPassOffset = getTimeZoneOffsetMinutes(args.timezone, new Date(baseUtcMs));
  const firstPassMs = baseUtcMs - (firstPassOffset * 60 * 1000);
  const secondPassOffset = getTimeZoneOffsetMinutes(args.timezone, new Date(firstPassMs));
  const correctedMs = baseUtcMs - (secondPassOffset * 60 * 1000);
  return new Date(correctedMs).toISOString();
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Before this local hour "dziś" / "teraz" also holds the previous evening (see computeRangeStartIso). */
const EARLY_MORNING_END_HOUR = 6;
/** Local hour of the previous day an early-morning TODAY window starts at. */
const EARLY_MORNING_WINDOW_START_HOUR = 18;

/** Local date parts shifted by a number of calendar days (no time zone involved). */
function shiftLocalDate(date: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** Calendar day number of a local date: differences between two of them count calendar days. */
function dayNumber(date: { year: number; month: number; day: number }): number {
  return Math.round(Date.UTC(date.year, date.month - 1, date.day) / DAY_MS);
}

function dateKey(date: { year: number; month: number; day: number }): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function getLocalClock(date: Date, timezone: string): { hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(date);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((part) => part.type === 'weekday')?.value ?? 'Sun');
  return {
    hour: Number(parts.find((part) => part.type === 'hour')?.value ?? '0') % 24,
    minute: Number(parts.find((part) => part.type === 'minute')?.value ?? '0'),
    weekday: Math.max(0, weekday),
  };
}

/** Local calendar date (YYYY-MM-DD) of an instant in the timezone, or null for an invalid instant or timezone. */
export function localDateKey(iso: string, timezone: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || !isValidTimeZone(timezone)) return null;
  return dateKey(getLocalDateParts(new Date(ms), timezone));
}

/** Calendar days from date `from` to date `to` (both YYYY-MM-DD): 1 from yesterday to today. */
export function localDateKeyDiffDays(from: string, to: string): number {
  const parse = (key: string) => {
    const [year, month, day] = key.split('-').map(Number);
    return dayNumber({ year, month, day });
  };
  return parse(to) - parse(from);
}

/**
 * Local midnight that starts the range. TODAY starts today; a multi-day range ("ostatnie 3 dni") covers that many
 * complete days before today plus today so far, so daily totals and averages have every named day in full.
 * Early morning (before 06:00 local) TODAY starts at 18:00 of the previous day instead: at 00:15 today has a few
 * minutes of data, and a question about "dziś" or "teraz" then is about the evening and night that just passed.
 */
function computeRangeStartIso(requestedAtIso: string, timezone: string, rangeDays: number): string {
  const requestedAt = new Date(requestedAtIso);
  const localDate = getLocalDateParts(requestedAt, timezone);
  if (rangeDays <= 1 && getLocalClock(requestedAt, timezone).hour < EARLY_MORNING_END_HOUR) {
    return zonedLocalMidnightUtcIso({ ...shiftLocalDate(localDate, -1), hour: EARLY_MORNING_WINDOW_START_HOUR, timezone });
  }
  const completeDaysBeforeToday = rangeDays > 1 ? rangeDays : 0;
  return zonedLocalMidnightUtcIso({ ...shiftLocalDate(localDate, -completeDaysBeforeToday), timezone });
}

export interface LocalDayWindow {
  /** Local calendar date (YYYY-MM-DD) in the request timezone. */
  date: string;
  from: string;
  to: string;
  /** The whole local day lies inside the range (it has ended and was not clipped at the range start). */
  complete: boolean;
}

/**
 * Local calendar days of a range, cut at local midnights (23 h and 25 h days on DST changes). The first day is clipped
 * at the range start and the last at the range end; a clipped day is not complete.
 */
export function localDayWindows(rangeStartIso: string, rangeEndIso: string, timezone: string): LocalDayWindow[] {
  const startMs = Date.parse(rangeStartIso);
  const endMs = Date.parse(rangeEndIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !isValidTimeZone(timezone)) return [];
  const windows: LocalDayWindow[] = [];
  let local = getLocalDateParts(new Date(startMs), timezone);
  for (let guard = 0; guard < 62; guard += 1) {
    const dayStartMs = Date.parse(zonedLocalMidnightUtcIso({ ...local, timezone }));
    const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
    const nextLocal = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
    const dayEndMs = Date.parse(zonedLocalMidnightUtcIso({ ...nextLocal, timezone }));
    const fromMs = Math.max(dayStartMs, startMs);
    const toMs = Math.min(dayEndMs, endMs);
    if (toMs > fromMs) {
      windows.push({
        date: `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`,
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        complete: fromMs === dayStartMs && toMs === dayEndMs,
      });
    }
    if (dayEndMs >= endMs) break;
    local = nextLocal;
  }
  return windows;
}

export function normalizeTimeRangeRequest(args: {
  range_type: ConversationTimeRangeType;
  requested_at: string;
  timezone: string;
}): ParsedTimeRangeRequest {
  if (!isValidTimeZone(args.timezone)) {
    return { status: 'INVALID', reason: 'INVALID_TIMEZONE' };
  }

  if (!isValidDateIso(args.requested_at)) {
    return { status: 'INVALID', reason: 'INVALID_REQUESTED_AT' };
  }

  const requestedAt = new Date(args.requested_at);
  const rangeDays = getRangeDays(args.range_type);
  const rangeEnd = requestedAt;
  const rangeStartIso = computeRangeStartIso(args.requested_at, args.timezone, rangeDays);

  return {
    status: 'OK',
    value: {
      range_type: args.range_type,
      range_profile: getRangeSelectionProfile(args.range_type),
      range_start: rangeStartIso,
      range_end: rangeEnd.toISOString(),
      timezone: args.timezone,
      normalization_policy_version: TIME_RANGE_NORMALIZATION_POLICY_VERSION,
    },
  };
}

/** Lower case without Polish diacritics ("tydzień" -> "tydzien", "miesiąc" -> "miesiac"). */
export function plainText(message: string): string {
  return String(message ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
}

/**
 * A period named in words instead of a day count (2026-10-19: "Podsumuj mi ostatni tydzień" and "Opowiedz mi o dzisiejszej
 * nocy" were answered without the patient's data). Weeks and months need a determiner ("ostatni tydzień", "w tym
 * tygodniu"), so "ile razy w tygodniu…" stays a general question.
 */
const NAMED_WEEK_PATTERN = /\b(?:ostatni|poprzedni|miniony|zeszly|ubiegly|ten|caly)\s+tydzien|\b(?:ostatnim|poprzednim|minionym|zeszlym|ubieglym|tym|calym)\s+tygodniu|\b(?:ostatniego|poprzedniego|minionego|zeszlego|ubieglego|tego|calego)\s+tygodnia|\bpodsumuj\w*\s+(?:mi\s+)?tydzien\b|\b(?:minal|uplynal|wygladal|poszedl)\s+(?:\w+\s+)?tydzien\b|\btydzien\s+(?:minal|uplynal)\b|\blast week\b|\bthis week\b/;
/**
 * The previous calendar week, Monday to Sunday ("zeszły tydzień", "w poprzednim tygodniu"); "ostatni tydzień" and
 * "ostatnie 7 dni" stay the rolling 7 days.
 */
const PREVIOUS_CALENDAR_WEEK_PATTERN = /\b(?:poprzedni|miniony|zeszly|ubiegly)\s+tydzien|\b(?:poprzednim|minionym|zeszlym|ubieglym)\s+tygodniu|\b(?:poprzedniego|minionego|zeszlego|ubieglego)\s+tygodnia/;
const NAMED_MONTH_PATTERN = /\b(?:ostatni|poprzedni|miniony|zeszly|ubiegly|ten|caly)\s+miesiac|\b(?:ostatnim|poprzednim|minionym|zeszlym|ubieglym|tym|calym)\s+miesiacu|\b(?:ostatniego|poprzedniego|minionego|zeszlego|ubieglego|tego|calego)\s+miesiaca|\bpodsumuj\w*\s+(?:mi\s+)?miesiac\b|\blast month\b|\bthis month\b/;
/** This week compared with the previous one ("porównaj ten tydzień z poprzednim"): two weeks. */
const THIS_AND_PREVIOUS_WEEK_PATTERN = /(?=.*\b(?:tydzien|tygodni\w*)\b)(?=.*\b(?:poprzedni\w*|zeszl\w*|ubiegl\w*)\b)(?=.*\b(?:ten|tym|tego|obecn\w*|biezac\w*)\b)/;
const MONTH_START_PATTERN = /\bod poczatku (?:tego )?miesiaca\b/;
/** A past year, half-year or quarter: always beyond the 30 days an analysis holds. */
const YEAR_PATTERNS: Array<[RegExp, number]> = [
  [/\b(?:ostatni|zeszly|poprzedni|ubiegly|caly)\s+rok\b|\b(?:ostatniego|zeszlego|poprzedniego|ubieglego|calego)\s+roku\b|\b(?:ostatnim|zeszlym|poprzednim|ubieglym|calym)\s+roku\b|\blast year\b/, 365],
  [/\b(?:ostatnie|ostatnich|przez)\s+pol\s+roku\b|\bpolrocz\w*/, 182],
  [/\b(?:ostatni|zeszly|poprzedni|ubiegly)\s+kwartal\b|\b(?:ostatnim|zeszlym|poprzednim|ubieglym)\s+kwartale\b/, 91],
];
/**
 * The last night (it began yesterday evening): served by the 3-day window that holds it, like "wczoraj".
 * "na noc" plans the night ahead ("co jeść na noc?"): not a period to analyse.
 */
const NIGHT_PATTERN = /(?:^|[^a-z])(?<!\bna )noc(?:y|ka|ke|ki|a|e|na|ne|ny|nej|nych|nym)?\b|\bovernight\b|\bthe night\b|\blast night\b/;
const WEEKEND_PATTERN = /\bweekend/;
const TODAY_PATTERN = /\bdzis\b|\bdzisiaj\b|\bdzisiejsz\w*|\btoday\b|\bod rana\b|\bod rano\b|\bod polnocy\b/;
const NOW_PATTERN = /\bteraz\b|\baktualn\w*|\bobecn\w*|\bw tej chwili\b|\bright now\b|\bcurrently\b|\bnow\b/;
const YESTERDAY_PATTERN = /(?:^|[^a-z])wczoraj|\byesterday\b/;
const DAY_BEFORE_YESTERDAY_PATTERN = /przedwczoraj|\bday before yesterday\b/;
const WEEK_AGO_PATTERN = /\btydzien temu\b|\ba week ago\b/;

const NUMBER_WORDS: Record<string, number> = {
  jeden: 1, jednego: 1, jedna: 1, dwa: 2, dwie: 2, dwoch: 2, dwu: 2, trzy: 3, trzech: 3, cztery: 4, czterech: 4, piec: 5,
  pieciu: 5, szesc: 6, szesciu: 6, siedem: 7, siedmiu: 7, osiem: 8, osmiu: 8, dziewiec: 9, dziewieciu: 9, dziesiec: 10,
  dziesieciu: 10, pare: 3, paru: 3, kilka: 5, kilku: 5,
};
const NUMBER = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`;
function numberValue(token: string): number {
  return /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS[token] ?? Number.NaN;
}
/** "co 3 dni" (every), "za 3 dni" (ahead) and "po 3 dniach" (after) name no past period. */
const NOT_A_PERIOD = '(?<!\\bco )(?<!\\bza )(?<!\\bpo )';
/** Days, or 24-hour "doby" ("ostatnie 2 doby", "trzy doby"). */
const DAY_COUNT_PATTERN = new RegExp(`${NOT_A_PERIOD}\\b${NUMBER}\\s*(?:dni|dnia|dniach|dniami|doby|dob|dobach|dobami|days?)\\b`, 'g');
const NAMED_TWO_WEEKS_PATTERN = new RegExp(`${NOT_A_PERIOD}\\b(?:dwa|2|ostatnie\\s+dwa|ostatnie\\s+2)\\s+tygodnie\\b|${NOT_A_PERIOD}\\b(?:ostatnich\\s+)?(?:dwoch|2)\\s+tygodni(?:ach)?\\b|\\blast (?:two|2) weeks\\b`);
const WEEK_COUNT_PATTERN = new RegExp(`${NOT_A_PERIOD}\\b${NUMBER}\\s*(?:tygodnie|tygodni|tygodniach|tygodniami|weeks?)\\b`, 'g');
const MONTH_COUNT_PATTERN = new RegExp(`${NOT_A_PERIOD}\\b${NUMBER}\\s*(?:miesiace|miesiecy|miesiacach|miesiacami|months?)\\b`, 'g');
const HOUR_COUNT_PATTERN = new RegExp(`\\b(?:ostatni\\w*|w ciagu(?: ostatni\\w*)?|last)\\s+${NUMBER}\\s*(?:h|godz\\w*|hours?)(?![a-z])|\\b${NUMBER}\\s*(?:h|godz\\w*|hours?)\\s+temu\\b`, 'g');
/** The last day / hour without a number: "ostatnia doba", "ostatni dzień", "ostatnia godzina". */
const LAST_DAY_PATTERN = /\bostatni(?:a|ej|e|ch)?\s+dob\w*|\bostatni(?:ego)?\s+(?:dzien|dnia)\b|\b(?:1|jeden)\s+dzien\b/;
const LAST_HOUR_PATTERN = /\bostatni(?:a|ej|e)?\s+godzin(?:a|e|y)\b/;

/** A duration unit of a background duration; "pol roku" is half a year. */
const DURATION_UNIT = '(pol\\s+roku|dni|dnia|doby|dob|tygodni\\w*|tydzien|miesiac\\w*|miesiec\\w*|lat\\w*|lata|roku|rok|kwartal\\w*)';
/**
 * Durations that set the scene rather than name a period to analyse (2026-10-21 audit: "Od 3 miesięcy mamy Trio,
 * dlaczego dziś tak skacze?" was refused as older than 30 days): since when something holds ("od 3 miesięcy", "od
 * zeszłego roku"), when it happened ("pół roku temu zmieniliśmy ICR") and ages ("ma 12 lat", "10-miesięczny").
 */
const SINCE_DURATION_PATTERN = new RegExp(`\\bod\\s+(?:(?:okolo|ok|prawie|ponad|niemal|juz)\\s+)?(?:${NUMBER}\\s*)?${DURATION_UNIT}\\b|\\bod\\s+(?:zeszlego|poprzedniego|ubieglego|ostatniego)\\s+(roku|kwartalu)\\b`, 'g');
const AGO_DURATION_PATTERN = new RegExp(`(?:\\b${NUMBER}\\s*)?\\b${DURATION_UNIT}\\s+temu\\b`, 'g');
const AGE_PATTERN = new RegExp(`\\bma\\s+(?:juz\\s+)?(?:${NUMBER}\\s*)?(?:lat\\w*|lata|rok|roczek|miesiac\\w*|miesiec\\w*)\\b|\\b${NUMBER}\\s*-?\\s*(?:letni\\w*|latk\\w*|miesieczn\\w*)`, 'g');

/** Days of a background duration ("3 miesiące" 90, "pół roku" 182, "rok" 365). */
function durationDays(numberToken: string | undefined, unit: string): number {
  if (/^pol/.test(unit)) return 182;
  const count = numberToken ? numberValue(numberToken) : 1;
  if (/^(?:dni|dnia|dob)/.test(unit)) return count;
  if (/^(?:tydz|tygod)/.test(unit)) return count * 7;
  if (/^miesi/.test(unit)) return count * 30;
  if (/^kwartal/.test(unit)) return count * 91;
  return count * 365;
}

/** Locative and nominative / genitive month names ("w październiku", "podsumuj październik", "z października"). */
const MONTH_LOCATIVE: Record<string, number> = {
  styczniu: 1, lutym: 2, marcu: 3, kwietniu: 4, maju: 5, czerwcu: 6, lipcu: 7, sierpniu: 8, wrzesniu: 9, pazdzierniku: 10, listopadzie: 11, grudniu: 12,
};
const MONTH_NOMINATIVE: Record<string, number> = {
  styczen: 1, luty: 2, marzec: 3, kwiecien: 4, maj: 5, czerwiec: 6, lipiec: 7, sierpien: 8, wrzesien: 9, pazdziernik: 10, listopad: 11, grudzien: 12,
};
const MONTH_GENITIVE: Record<string, number> = {
  stycznia: 1, lutego: 2, marca: 3, kwietnia: 4, maja: 5, czerwca: 6, lipca: 7, sierpnia: 8, wrzesnia: 9, pazdziernika: 10, listopada: 11, grudnia: 12,
};
/** A calendar month named as a period (a day number before it makes it a date, read by WORD_DATE_PATTERN). */
const NAMED_CALENDAR_MONTH_PATTERN = new RegExp([
  `\\b(?:w|we)\\s+(?:(?:calym|tym|zeszlym|ubieglym|poprzednim)\\s+)?(${Object.keys(MONTH_LOCATIVE).join('|')})\\b`,
  `\\b(?:podsumuj\\w*(?:\\s+mi)?|caly|przez(?:\\s+caly)?|za)\\s+(${Object.keys(MONTH_NOMINATIVE).join('|')})\\b`,
  `(?<!\\d\\s?)\\b(?:z|ze)\\s+(?:(?:calego|tego|zeszlego|ubieglego|poprzedniego)\\s+)?(${Object.keys(MONTH_GENITIVE).join('|')})\\b`,
].join('|'), 'g');

/** Polish weekday forms (without diacritics), Sunday = 0. */
const WEEKDAY_PATTERNS: Array<[number, RegExp]> = [
  [1, /\bponiedzial(?:ek|ku|kow(?:y|a|e|ego|ej))\b|\bmonday\b/],
  [2, /\bwtor(?:ek|ku|kow(?:y|a|e|ego|ej))\b|\btuesday\b/],
  [3, /\bsrod(?:a|e|y|zie|ow(?:y|a|e|ego|ej))\b|\bwednesday\b/],
  [4, /\bczwart(?:ek|ku|kow(?:y|a|e|ego|ej))\b|\bthursday\b/],
  [5, /\bpiat(?:ek|ku|kow(?:y|a|e|ego|ej))\b|\bfriday\b/],
  [6, /\bsobot(?:a|e|y|ni|nia|nie|niego|niej)\b|\bsaturday\b/],
  [0, /\bniedziel(?:a|e|i|ny|na|ne|nego|nej)\b|\bsunday\b/],
];
/** Month names and abbreviations; "sie" (sierpień) is left out, it is "się" without diacritics. */
const MONTHS: Array<[number, string]> = [
  [1, 'stycznia|styczen|styczniu|sty'], [2, 'lutego|luty|lutym|lut'], [3, 'marca|marzec|marcu|mar'], [4, 'kwietnia|kwiecien|kwietniu|kwi'],
  [5, 'maja|maj|maju'], [6, 'czerwca|czerwiec|czerwcu|cze'], [7, 'lipca|lipiec|lipcu|lip'], [8, 'sierpnia|sierpien|sierpniu|sierp'],
  [9, 'wrzesnia|wrzesien|wrzesniu|wrz'], [10, 'pazdziernika|pazdziernik|pazdzierniku|paz'], [11, 'listopada|listopad|listopadzie|lis'],
  [12, 'grudnia|grudzien|grudniu|gru'],
];
const MONTH_BY_NAME = new Map(MONTHS.flatMap(([month, names]) => names.split('|').map((name) => [name, month] as const)));
/** "15 października", "15 i 16 października", "15-16 paź", "15 października 2026". */
const WORD_DATE_PATTERN = new RegExp(`((?:\\b\\d{1,2}\\b\\s*(?:-|–|,|i|oraz|a|do)?\\s*)+)\\.?\\s*(${[...MONTH_BY_NAME.keys()].join('|')})\\b\\.?(?:\\s*(\\d{4})\\b)?`, 'g');
/** "16.10", "16.10.2026"; read as a date only when it falls in the last 30 days (otherwise it is a time or a number). */
const NUMERIC_DATE_PATTERN = /(?<![\d:.,])(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?(?![\d:]|\.\d|\s*(?:wbt|ww|j\b|jedn|g\b|mg|mmol|u\b|%))/g;
/** Words that make "16.10" a clock time ("o 16.10", "od 7.30"). */
const CLOCK_PREFIX_BEFORE = /\b(?:o|okolo|ok|godz\w*|od|do|miedzy|po|przed|wokol|okolic\w*|a)\.?\s*$/;
/** Clock times: "o 7", "o 7.30", "około 22", "7:30", "od 15.00". */
const CLOCK_PATTERNS = [
  // Not an amount: "ok 15 g", "około 20 g", "ok 2 j", "o 2 godziny".
  /\b(?:o|okolo|ok|godz|godzinie|godzina)\.?\s+(\d{1,2})(?:[:.](\d{2}))?(?![\d:.]?\d)(?![.,]?\d|\s*(?:g\b|gr\w*|j\b|j\.|jedn\w*|u\b|ww\b|wbt|mg|mmol|%|kg|ml|min\w*|godzin(?:y|e|ami|ach)?\b|dni|dob|tydz|tyg\w*|mies\w*|lat\w*|razy|x\b))/g,
  /(?<![\d:.])(\d{1,2}):(\d{2})(?![\d:])/g,
  /\b(?:od|do|miedzy|po|przed|wokol|okolic\w*)\s+(\d{1,2})\.(\d{2})(?![\d.:])/g,
];
/** Parts of a day and the local hour each starts at: named without a day, the most recent one is meant. */
const DAY_PART_PATTERNS: Array<[RegExp, number]> = [
  [/\bnad ran(?:em|kiem)\b/, 3],
  [/\b(?:rano|rana|ranek|ranka|poranek|poranku|porann\w*|sniadani\w*)\b/, 5],
  [/\bprzedpoludni\w*/, 9],
  // "po obiedzie": the locative changes the stem.
  [/\b(?:obiad\w*|obied\w*|poludni\w*|popoludni\w*|lunch\w*)/, 12],
  [/\bpodwieczor\w*/, 15],
  [/\b(?:wieczor\w*|kolacj\w*)/, 17],
];
/** "ostatni posiłek / bolus / pomiar": in the last 24 hours. */
const LAST_FREQUENT_EVENT_PATTERN = /\bostatni(?:a|e|ego|ej|m)?\s+(?:posil\w*|bolus\w*|korekt\w*|jedzeni\w*|pomiar\w*|odczyt\w*|smb\w*|dawk\w*|cukier|cukr\w*|wynik\w*|insulin\w*|wegl\w*|wbt|ww|przekask\w*|bazal\w*|posilek)/;
/** "ostatnia hipo / zmiana wkłucia": rarer events, a week. */
const LAST_RARE_EVENT_PATTERN = /\bostatni(?:a|e|ego|ej|m)?\s+(?:hipo\w*|niedocukrz\w*|hiper\w*|spad\w*|skok\w*|zmian\w*|wymian\w*|wkluc\w*|sensor\w*|kaniul\w*|zbiornik\w*)/;
/** "ostatnio", "w ostatnim czasie", "kiedy ostatnio": a week. */
const RECENTLY_PATTERN = /\bostatnio\b|\bw ostatnim czasie\b|\bostatnimi czasy\b|\bw ostatnich dniach\b|\bostatnie dni\b|\blately\b|\brecently\b/;
/** Averages and daily totals ("średnio na dobę", "średnie TDD"): a week. */
const AVERAGE_PATTERN = /\bsredni\w*|\bsrednio\b|\btdd\b|\bna dobe\b|\bdziennie\b|\bdobow\w*|\bper day\b|\baverage\b/;
/**
 * A question about a recurring pattern needs several days to compare: a week, unless a period is counted.
 * Settings questions (ICR, ISF, basal, targets) need a repeated pattern too.
 */
const PATTERN_OR_SETTINGS_PATTERN = /wzorz|wzorc|powtarza|regularn|czesto|zazwyczaj|codzienn|pattern|recurr|przelicznik|wspolczynnik|\bicr\b|\bisf\b|bazal|ustawien|ustawion|dawk[aie] baz|\bbaz(?:a|y|e|ie|owa|owe|owej)\b.*\b(?:dobr\w*|ustaw\w*|zmien\w*|zwieksz\w*|zmniejsz\w*|za (?:wysok|nisk|mal|duz|slab|mocn)\w*)|\b(?:zmien|zwieksz|zmniejsz|ustaw)\w*\b.*\bbaz(?:a|y|e|ie|owa|owe|owej)\b/;

/** The most an analysis can hold: EXTENDED_RANGE, 30 complete days before today plus today. */
export const MAX_ANALYSIS_DAYS_BACK = 30;
const WEEK_DAYS_BACK = 7;

/** What a window must hold: complete local days before today (0: today only) and an earliest instant. */
export interface PeriodRequirement {
  daysBack: number;
  sinceMs: number | null;
}

export interface MessagePeriod {
  /**
   * The period or day the message names: a day count, hours, a week or month, today/now, yesterday, the night, a
   * weekend, a weekday, a calendar date. It wins over a general wording and over the period a conversation analysed.
   */
  named: PeriodRequirement | null;
  /** The message counts a period (days, hours, weeks, months): it also wins over the recurring-pattern week. */
  namesCount: boolean;
  /** Hints without a named period (a clock time, a part of the day, "ostatni posiłek", "ostatnio", an average). */
  soft: PeriodRequirement | null;
  /** A recurring-pattern or settings question: at least a week, unless a period is counted. */
  pattern: boolean;
  /** Local dates (YYYY-MM-DD) of the days the message names: the days in focus of the answer. */
  focusDates: string[];
  /** Earliest local date (YYYY-MM-DD) of a named period older than the 30 days an analysis can hold. */
  beyondReach: string | null;
}

/** One requirement holding all of them: the most days back and the earliest instant. */
export function mergeRequirements(...requirements: Array<PeriodRequirement | null>): PeriodRequirement | null {
  const present = requirements.filter((requirement): requirement is PeriodRequirement => requirement !== null);
  if (present.length === 0) return null;
  const since = present.map((requirement) => requirement.sinceMs).filter((value): value is number => value !== null);
  return { daysBack: Math.max(...present.map((requirement) => requirement.daysBack)), sinceMs: since.length > 0 ? Math.min(...since) : null };
}

/**
 * Reads the period a caregiver's message is about, relative to when it was sent (local calendar of the timezone).
 * Weekdays are the most recent past one (the same weekday as today: a week ago); a calendar date without a year is
 * its most recent past occurrence (a date up to a month ahead is not a period); "16.10" is a date only when it falls
 * within the last 30 days, otherwise it is read as a time or a number.
 */
export function readMessagePeriod(message: string, requestedAtIso: string, timezone: string): MessagePeriod {
  const text = plainText(message);
  const nowMs = Date.parse(requestedAtIso);
  const result: MessagePeriod = { named: null, namesCount: false, soft: null, pattern: false, focusDates: [], beyondReach: null };
  if (!text || !Number.isFinite(nowMs) || !isValidTimeZone(timezone)) return result;
  const now = new Date(nowMs);
  const today = getLocalDateParts(now, timezone);
  const clock = getLocalClock(now, timezone);
  const todayNumber = dayNumber(today);
  const localTimeMs = (daysBack: number, hour: number, minute = 0) => Date.parse(zonedLocalMidnightUtcIso({ ...shiftLocalDate(today, -daysBack), hour, minute, timezone }));

  const namedDaysBack: number[] = [];
  const namedSince: number[] = [];
  const focus = new Set<string>();
  const nameDay = (daysBack: number) => {
    namedDaysBack.push(daysBack);
    if (daysBack <= MAX_ANALYSIS_DAYS_BACK) focus.add(dateKey(shiftLocalDate(today, -daysBack)));
  };
  const count = (daysBack: number) => {
    namedDaysBack.push(daysBack);
    result.namesCount = true;
  };
  const focusDays = (fromDaysBack: number, toDaysBack: number) => {
    for (let back = fromDaysBack; back >= toDaysBack; back -= 1) {
      if (back <= MAX_ANALYSIS_DAYS_BACK) focus.add(dateKey(shiftLocalDate(today, -back)));
    }
  };

  // Background durations ("od 3 miesięcy", "pół roku temu", "ma 12 lat") are set aside: the period patterns below
  // read the text without them. They count only when the message names nothing else (see the end).
  const background: Array<{ daysBack: number; ago: boolean }> = [];
  const blank = (match: string) => ' '.repeat(match.length);
  const periodText = text
    .replace(AGE_PATTERN, blank)
    .replace(SINCE_DURATION_PATTERN, (match, numberToken: string | undefined, unit: string | undefined, determinerUnit: string | undefined) => {
      background.push({ daysBack: durationDays(determinerUnit ? undefined : numberToken, unit ?? determinerUnit ?? 'rok'), ago: false });
      return blank(match);
    })
    .replace(AGO_DURATION_PATTERN, (match, numberToken: string | undefined, unit: string) => {
      background.push({ daysBack: durationDays(numberToken, unit), ago: true });
      return blank(match);
    });

  for (const match of periodText.matchAll(DAY_COUNT_PATTERN)) count(numberValue(match[1]));
  for (const match of periodText.matchAll(WEEK_COUNT_PATTERN)) count(numberValue(match[1]) * 7);
  for (const match of periodText.matchAll(MONTH_COUNT_PATTERN)) count(numberValue(match[1]) * 30);
  for (const match of text.matchAll(HOUR_COUNT_PATTERN)) {
    namedSince.push(nowMs - numberValue(match[1] ?? match[2]) * 60 * 60 * 1000);
    result.namesCount = true;
  }
  if (LAST_DAY_PATTERN.test(text)) {
    namedSince.push(nowMs - DAY_MS);
    result.namesCount = true;
  }
  if (LAST_HOUR_PATTERN.test(text)) {
    namedSince.push(nowMs - 60 * 60 * 1000);
    result.namesCount = true;
  }
  if (NAMED_TWO_WEEKS_PATTERN.test(periodText) || (NAMED_WEEK_PATTERN.test(periodText) && THIS_AND_PREVIOUS_WEEK_PATTERN.test(periodText))) {
    count(14);
  } else if (PREVIOUS_CALENDAR_WEEK_PATTERN.test(periodText)) {
    // Monday to Sunday of the previous calendar week, its days in focus.
    const previousMondayBack = ((clock.weekday + 6) % 7) + WEEK_DAYS_BACK;
    count(previousMondayBack);
    focusDays(previousMondayBack, previousMondayBack - 6);
  } else if (NAMED_WEEK_PATTERN.test(periodText)) {
    count(WEEK_DAYS_BACK);
  }
  if (NAMED_MONTH_PATTERN.test(periodText)) count(30);
  if (MONTH_START_PATTERN.test(periodText)) count(today.day - 1);
  for (const match of periodText.matchAll(NAMED_CALENDAR_MONTH_PATTERN)) {
    // The month's most recent occurrence, from its first day; a past month's days are in focus.
    const name = match[1] ?? match[2] ?? match[3];
    const month = MONTH_LOCATIVE[name] ?? MONTH_NOMINATIVE[name] ?? MONTH_GENITIVE[name];
    const year = month <= today.month ? today.year : today.year - 1;
    const firstBack = todayNumber - dayNumber({ year, month, day: 1 });
    count(firstBack);
    if ((month !== today.month || year !== today.year) && firstBack <= MAX_ANALYSIS_DAYS_BACK) {
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      focusDays(firstBack, todayNumber - dayNumber({ year, month, day: lastDay }));
    }
  }
  for (const [pattern, days] of YEAR_PATTERNS) if (pattern.test(periodText)) count(days);

  // Today and now. Early in the morning (see computeRangeStartIso) the evening before is in focus too.
  if (TODAY_PATTERN.test(text) || NOW_PATTERN.test(text)) {
    nameDay(0);
    if (clock.hour < EARLY_MORNING_END_HOUR) focus.add(dateKey(shiftLocalDate(today, -1)));
  }
  if (DAY_BEFORE_YESTERDAY_PATTERN.test(text)) nameDay(2);
  if (YESTERDAY_PATTERN.test(text.replace(/przedwczoraj/g, ''))) nameDay(1);
  if (WEEK_AGO_PATTERN.test(text)) nameDay(WEEK_DAYS_BACK);
  // The last night began yesterday evening: the 3-day window, as for "wczoraj" (no day in focus, it spans two).
  const namesNight = NIGHT_PATTERN.test(text);
  if (namesNight) namedDaysBack.push(3);
  const namesWeekend = WEEKEND_PATTERN.test(text);
  if (namesWeekend) {
    // This weekend on Saturday and Sunday, otherwise the last one; at least the 3-day window.
    const saturdayBack = clock.weekday === 6 ? 0 : clock.weekday === 0 ? 1 : clock.weekday + 1;
    namedDaysBack.push(Math.max(3, saturdayBack));
    focus.add(dateKey(shiftLocalDate(today, -saturdayBack)));
    if (saturdayBack >= 1) focus.add(dateKey(shiftLocalDate(today, -saturdayBack + 1)));
  }
  for (const [weekday, pattern] of WEEKDAY_PATTERNS) {
    if (pattern.test(text)) nameDay(((clock.weekday - weekday + 7) % 7) || 7);
  }

  const dateDaysBack = (day: number, month: number, year: number | null): number | null => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const probe = new Date(Date.UTC(year ?? today.year, month - 1, day));
    if (probe.getUTCMonth() !== month - 1) return null;
    let back = todayNumber - dayNumber({ year: year ?? today.year, month, day });
    if (back < 0 && year === null) {
      // A date a little ahead is no period to analyse; further ahead it is the previous year's.
      if (back >= -31) return null;
      back = todayNumber - dayNumber({ year: today.year - 1, month, day });
    }
    return back < 0 ? null : back;
  };
  for (const match of text.matchAll(WORD_DATE_PATTERN)) {
    const month = MONTH_BY_NAME.get(match[2]) ?? 0;
    const year = match[3] ? Number(match[3]) : null;
    for (const dayToken of match[1].match(/\d{1,2}/g) ?? []) {
      const back = dateDaysBack(Number(dayToken), month, year);
      if (back !== null) nameDay(back);
    }
  }
  for (const match of text.matchAll(NUMERIC_DATE_PATTERN)) {
    if (CLOCK_PREFIX_BEFORE.test(text.slice(0, match.index))) continue;
    const yearToken = match[3];
    const year = yearToken ? (yearToken.length === 2 ? 2000 + Number(yearToken) : Number(yearToken)) : null;
    const back = dateDaysBack(Number(match[1]), Number(match[2]), year);
    if (back !== null && back <= MAX_ANALYSIS_DAYS_BACK) nameDay(back);
  }

  // Hints, used when no period is named.
  const softDaysBack: number[] = [];
  const softSince: number[] = [];
  for (const pattern of CLOCK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const hour = Number(match[1]);
      const minute = Number(match[2] ?? '0');
      if (hour > 23 || minute > 59) continue;
      // A clock time later than now is yesterday's; an hour before it gives the context of what happened.
      const todayAt = localTimeMs(0, hour, minute);
      softSince.push((todayAt > nowMs + 10 * 60 * 1000 ? localTimeMs(1, hour, minute) : todayAt) - 60 * 60 * 1000);
    }
  }
  for (const [pattern, startHour] of DAY_PART_PATTERNS) {
    // The most recent one: "kolacja" asked at 10:00 is yesterday's dinner.
    if (pattern.test(text)) softSince.push(localTimeMs(clock.hour >= startHour ? 0 : 1, startHour));
  }
  if (LAST_FREQUENT_EVENT_PATTERN.test(text)) softSince.push(nowMs - DAY_MS);
  if (LAST_RARE_EVENT_PATTERN.test(text) || RECENTLY_PATTERN.test(text) || AVERAGE_PATTERN.test(text)) softDaysBack.push(WEEK_DAYS_BACK);
  result.pattern = PATTERN_OR_SETTINGS_PATTERN.test(text);
  result.soft = mergeRequirements(
    softDaysBack.length > 0 ? { daysBack: Math.max(...softDaysBack), sinceMs: null } : null,
    softSince.length > 0 ? { daysBack: 0, sinceMs: Math.min(...softSince) } : null,
  );

  // A background duration counts only when nothing else is named: up to 30 days it is the period ("od 3 dni jest
  // wysoko"); longer, only a bare "N temu" names a period ("co było 2 miesiące temu?" is beyond reach), while "od…"
  // and anything next to a day, a period, a clock time or a settings question just sets the scene.
  const namesOther = namedDaysBack.length > 0 || namedSince.length > 0 || namesNight || namesWeekend;
  if (!namesOther) {
    const nothingElse = result.soft === null && !result.pattern;
    for (const duration of background) {
      if (duration.daysBack <= MAX_ANALYSIS_DAYS_BACK || (duration.ago && nothingElse)) count(duration.daysBack);
    }
  }

  const validDaysBack = namedDaysBack.filter((value) => Number.isFinite(value) && value >= 0);
  if (validDaysBack.length > 0 || namedSince.length > 0) {
    result.named = mergeRequirements(
      validDaysBack.length > 0 ? { daysBack: Math.max(...validDaysBack), sinceMs: null } : null,
      namedSince.length > 0 ? { daysBack: 0, sinceMs: Math.min(...namedSince) } : null,
    );
    if (result.named && result.named.daysBack > MAX_ANALYSIS_DAYS_BACK) {
      result.beyondReach = dateKey(shiftLocalDate(today, -result.named.daysBack));
    }
  }
  result.focusDates = [...focus].sort();
  return result;
}

/** The recurring-pattern week of a message, unless it counts a period of its own. */
export function patternRequirement(period: MessagePeriod): PeriodRequirement | null {
  return period.pattern && !period.namesCount ? { daysBack: WEEK_DAYS_BACK, sinceMs: null } : null;
}

/** The smallest supported range type holding `daysBack` complete days before today plus today; null beyond 30. */
export function rangeTypeCoveringDaysBack(daysBack: number): ConversationTimeRangeType | null {
  if (daysBack <= 0) return 'TODAY';
  if (daysBack <= 3) return 'SHORT_RANGE';
  if (daysBack <= 7) return 'MEDIUM_RANGE';
  if (daysBack <= 14) return 'LONG_RANGE';
  if (daysBack <= MAX_ANALYSIS_DAYS_BACK) return 'EXTENDED_RANGE';
  return null;
}

/**
 * The window that holds a requirement, ending at the request: TODAY (from its start, or from the earliest instant
 * when that is up to 24 h back), otherwise the smallest multi-day range that holds the earliest day needed.
 * INVALID RANGE_BEYOND_REACH past 30 days.
 */
export function windowForRequirement(requirement: PeriodRequirement, requestedAtIso: string, timezone: string): ParsedTimeRangeRequest {
  const todayWindow = normalizeTimeRangeRequest({ range_type: 'TODAY', requested_at: requestedAtIso, timezone });
  if (todayWindow.status !== 'OK') return todayWindow;
  const nowMs = Date.parse(requestedAtIso);
  const todayStartMs = Date.parse(todayWindow.value.range_start);
  let daysBack = Math.max(0, requirement.daysBack);
  let startMs = todayStartMs;
  if (requirement.sinceMs !== null && requirement.sinceMs < todayStartMs) {
    if (daysBack === 0 && nowMs - requirement.sinceMs <= DAY_MS + 60 * 1000) {
      startMs = requirement.sinceMs;
    } else {
      daysBack = Math.max(daysBack, dayNumber(getLocalDateParts(new Date(nowMs), timezone)) - dayNumber(getLocalDateParts(new Date(requirement.sinceMs), timezone)));
    }
  }
  if (daysBack === 0) {
    return { status: 'OK', value: { ...todayWindow.value, range_start: new Date(startMs).toISOString() } };
  }
  const rangeType = rangeTypeCoveringDaysBack(daysBack);
  if (!rangeType) return { status: 'INVALID', reason: 'RANGE_BEYOND_REACH' };
  return normalizeTimeRangeRequest({ range_type: rangeType, requested_at: requestedAtIso, timezone });
}

/** Local dates (YYYY-MM-DD) of the days a message names, relative to when it was sent; empty when it names none. */
export function namedFocusDates(message: string, requestedAtIso: string, timezone: string): string[] {
  return readMessagePeriod(message, requestedAtIso, timezone).focusDates;
}

export function validateNormalizedTimeRangeWindow(args: {
  range_type: ConversationTimeRangeType;
  range_start: string;
  range_end: string;
  timezone: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!isValidTimeZone(args.timezone)) {
    return { ok: false, reason: 'INVALID_TIMEZONE' };
  }

  if (!isValidDateIso(args.range_start) || !isValidDateIso(args.range_end)) {
    return { ok: false, reason: 'INVALID_RANGE_TIMESTAMP' };
  }

  const startMs = new Date(args.range_start).getTime();
  const endMs = new Date(args.range_end).getTime();
  if (!(startMs < endMs)) {
    return { ok: false, reason: 'INVALID_RANGE_ORDER' };
  }

  const durationMs = endMs - startMs;
  const dayMs = 24 * 60 * 60 * 1000;
  const epsilonMs = 60 * 1000;
  const days = getRangeDays(args.range_type);
  // Multi-day ranges hold `days` complete days plus today so far; ranges stored before that held days - 1 complete
  // days plus today and stay valid. 25 h days (DST) are covered by the extra hour.
  const minDurationMs = Math.max(0, (days - 1) * dayMs - epsilonMs);
  const maxDurationMs = ((days > 1 ? days + 1 : days) * dayMs) + 60 * 60 * 1000 + epsilonMs;

  if (durationMs < minDurationMs || durationMs > maxDurationMs) {
    return { ok: false, reason: 'RANGE_DURATION_INCOMPATIBLE_WITH_TYPE' };
  }

  return { ok: true };
}