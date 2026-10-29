import { describe, expect, it } from 'vitest';
import { buildBeyondReachAnswer, routeUserMessage, type AnalysisWindow, type MessageRoute } from './message-routing';
import { namedFocusDates, readMessagePeriod, validateNormalizedTimeRangeWindow } from './time-range-normalization';

/**
 * Routing corpus (2026-10-19 audit): realistic caregiver questions run
 * through the same decision as ApiService.handleUserMessage, with a fixed request time. Each data question must get an
 * analysis whose window reaches the earliest local time the answer needs and ends at the request; general and social
 * messages get a direct reply without data. Before this routing, 37 of these 95 questions failed.
 */
const TZ = 'Europe/Warsaw';
/** Monday 2026-10-19 10:00 local. */
const MONDAY_10 = '2026-10-19T08:00:00.000Z';
const local = (iso: string) => new Date(iso).toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16);

type Expect = 'GENERAL' | 'SOCIAL' | 'BEYOND_REACH' | { from: string };
/** `from`: the earliest local time the answer needs ("2026-10-18 18:00"). */
const at = (from: string): Expect => ({ from });
const TODAY0 = '2026-10-19 00:00';

const CORPUS: Array<[string, Expect]> = [
  // Now / current state
  ['Jaki jest teraz cukier?', at('2026-10-19 09:30')],
  ['Ile ma teraz IOB?', at('2026-10-19 09:30')],
  ['Czy pętla teraz podaje bazę?', at('2026-10-19 09:00')],
  ['Czy potrzebna jest korekta?', at('2026-10-19 08:00')],
  ['Czemu teraz rośnie?', at('2026-10-19 07:00')],
  ['Dlaczego spada?', at('2026-10-19 08:00')],
  ['Skąd ten skok cukru?', at('2026-10-19 07:00')],
  ['Jak wygląda trend?', at('2026-10-19 09:00')],
  ['Kiedy był ostatni bolus?', at('2026-10-19 00:00')],
  ['Ile insuliny jest aktywnej?', at('2026-10-19 09:30')],
  ['Czy sensor dobrze działa?', at('2026-10-19 06:00')],
  ['Czy za chwilę będzie hipo?', at('2026-10-19 09:00')],
  // Today
  ['Jak minął poranek?', at('2026-10-19 06:00')],
  ['Co było po śniadaniu?', at('2026-10-19 07:00')],
  ['Dziś rano był spadek?', at('2026-10-19 05:00')],
  ['Od rana cukier jest wysoko, czemu?', at('2026-10-19 05:00')],
  ['Od północy ile było SMB?', at(TODAY0)],
  ['Ile węglowodanów dziś zjadł?', at(TODAY0)],
  ['Ile insuliny poszło dzisiaj?', at(TODAY0)],
  ['Co się działo o 7:30?', at('2026-10-19 07:00')],
  ['Dlaczego o 8:15 był taki wzrost?', at('2026-10-19 07:00')],
  ['Jaki był TIR dzisiaj?', at(TODAY0)],
  ['Pokaż ostatni posiłek', at('2026-10-18 18:00')],
  ['Ile zjadł na śniadanie?', at('2026-10-19 06:00')],
  ['Czy dobrze policzyłem bolus na śniadanie?', at('2026-10-19 06:00')],
  // Night
  ['Jak minęła noc?', at('2026-10-18 21:00')],
  ['Opowiedz mi o dzisiejszej nocy', at('2026-10-18 21:00')],
  ['Czy w nocy był spadek?', at('2026-10-18 21:00')],
  ['Ostatnia noc była spokojna?', at('2026-10-18 21:00')],
  ['Czemu w nocy pętla wstrzymywała bazę?', at('2026-10-18 21:00')],
  ['Co się działo nad ranem?', at('2026-10-19 03:00')],
  ['Poprzednia noc a ta, co lepsze?', at('2026-10-17 21:00')],
  ['Ile SMB poszło w nocy?', at('2026-10-18 21:00')],
  // Yesterday and named days
  ['Jak było wczoraj?', at('2026-10-18 00:00')],
  ['Wczoraj wieczorem był skok, dlaczego?', at('2026-10-18 17:00')],
  ['Co było przedwczoraj?', at('2026-10-17 00:00')],
  ['Przedwczoraj po obiedzie był wysoki cukier, czemu?', at('2026-10-17 12:00')],
  ['Jak było w niedzielę?', at('2026-10-18 00:00')],
  ['Co się stało w sobotę po południu?', at('2026-10-17 12:00')],
  ['W piątek była hipo?', at('2026-10-16 00:00')],
  ['Jak było w czwartek?', at('2026-10-15 00:00')],
  ['Co było w środę wieczorem?', at('2026-10-14 17:00')],
  ['Jak było w weekend?', at('2026-10-17 00:00')],
  ['Od piątku cukry są wyższe, dlaczego?', at('2026-10-16 00:00')],
  // Calendar dates
  ['Co wywołało wzrost do 318 po południu 15 października?', at('2026-10-15 12:00')],
  ['Co było 17 października?', at('2026-10-17 00:00')],
  ['Jak wyglądał 16.10?', at('2026-10-16 00:00')],
  ['Przeanalizuj 14 paź', at('2026-10-14 00:00')],
  ['Co się działo 12 października wieczorem?', at('2026-10-12 17:00')],
  ['Porównaj 15 i 16 października', at('2026-10-15 00:00')],
  // Periods
  ['Podsumuj mi ostatni tydzień', at('2026-10-12 00:00')],
  ['Jak wyglądał ostatni tydzień?', at('2026-10-12 00:00')],
  ['W tym tygodniu było dużo spadków?', at('2026-10-19 00:00')],
  ['Tydzień temu było lepiej?', at('2026-10-12 00:00')],
  ['Porównaj ten tydzień z poprzednim', at('2026-10-05 00:00')],
  ['Ostatnie 2 tygodnie, jaki TIR?', at('2026-10-05 00:00')],
  ['Podsumuj ostatni miesiąc', at('2026-09-19 00:00')],
  ['Od początku miesiąca jaki był TIR?', at('2026-10-01 00:00')],
  ['Ostatnie 3 dni', at('2026-10-16 00:00')],
  ['Ostatnie 5 dni, ile było hipo?', at('2026-10-14 00:00')],
  ['Ostatnie 10 dni', at('2026-10-09 00:00')],
  ['Ostatnie 24 godziny', at('2026-10-18 10:00')],
  ['Ostatnie 48 godzin, ile insuliny?', at('2026-10-17 10:00')],
  ['Ostatnie 3 godziny, czemu tak wysoko?', at('2026-10-19 07:00')],
  ['Od wczoraj cukier wysoki', at('2026-10-18 00:00')],
  ['Ile było hipo w ostatnim czasie?', at('2026-10-12 00:00')],
  ['Ile średnio insuliny na dobę?', at('2026-10-12 00:00')],
  ['Jakie jest średnie TDD?', at('2026-10-12 00:00')],
  ['Czy to się powtarza?', at('2026-10-12 00:00')],
  ['Czy przelicznik na śniadanie jest dobry?', at('2026-10-12 00:00')],
  ['Czy baza w nocy jest dobrze ustawiona?', at('2026-10-12 00:00')],
  ['Czy powinniśmy zmienić ISF?', at('2026-10-12 00:00')],
  // Intentional exception: the audit asked for two weeks; "kiedy ostatnio" is a week (owner's rule "ostatnio = tydzień").
  ['Kiedy ostatnio była hipo?', at('2026-10-12 00:00')],
  ['Jak często są spadki po WF?', at('2026-10-12 00:00')],
  ['Przeanalizuj mi ostatnie 7 dni pod kątem hipoglikemii', at('2026-10-12 00:00')],
  ['Przeanalizuj mi dzisiejszy dzień', at(TODAY0)],
  // Meals by name and doses
  ['Ile podać na pizzę?', at('2026-10-19 09:00')],
  // Intentional exception: the audit asked for a month; "ostatnio" is a week (owner's rule "ostatnio = tydzień").
  ['Jak ostatnio poszło po frytkach?', at('2026-10-12 00:00')],
  ['Ile dać na naleśniki z dżemem 150 g?', at('2026-10-19 09:00')],
  ['Ile WBT ma obiad, który zjadł wczoraj?', at('2026-10-18 00:00')],
  ['Czy dawka na kolację była za mała?', at('2026-10-18 17:00')],
  // General knowledge
  ['Co to jest WBT?', 'GENERAL'],
  ['Jak liczyć wymienniki węglowodanowe?', 'GENERAL'],
  ['Co robić przy ketonach 1,2?', 'GENERAL'],
  ['Jak działa SMB w Trio?', 'GENERAL'],
  ['Ile glukozy podać przy hipo dziecku 30 kg?', 'GENERAL'],
  ['Co oznacza IOB?', 'GENERAL'],
  ['Jak często zmieniać wkłucie?', 'GENERAL'],
  ['Ile razy w tygodniu zmieniać sensor?', 'GENERAL'],
  ['Co jeść na noc, żeby nie było spadków?', 'GENERAL'],
  ['Jak przygotować się do WF?', 'GENERAL'],
  // Social
  ['Cześć, jak się masz?', 'SOCIAL'],
  ['Dzięki!', 'SOCIAL'],
  ['Super, dzięki za pomoc', 'SOCIAL'],
  ['Ok', 'SOCIAL'],
];

function route(content: string, options: { requestedAt?: string; messages?: Array<Record<string, unknown>>; hasPhotos?: boolean; hypoWindow?: AnalysisWindow | null } = {}): MessageRoute {
  return routeUserMessage({
    content,
    messages: options.messages ?? [],
    conversationId: 'corpus',
    requestedAtIso: options.requestedAt ?? MONDAY_10,
    timezone: TZ,
    hasPhotos: options.hasPhotos ?? false,
    hypoWindow: options.hypoWindow ?? null,
  });
}

/** Why a route does not serve what the message asks; null when it does. */
function problem(result: MessageRoute, expected: Expect, requestedAt = MONDAY_10): string | null {
  if (expected === 'GENERAL' || expected === 'SOCIAL' || expected === 'BEYOND_REACH') {
    const reason = { GENERAL: 'GENERAL_KNOWLEDGE', SOCIAL: 'SOCIAL', BEYOND_REACH: 'BEYOND_REACH' }[expected];
    return result.route === 'DIRECT' && result.reason === reason ? null : `expected a direct reply (${reason}), got ${JSON.stringify(result)}`;
  }
  if (result.route !== 'ANALYSIS') return `no data: ${JSON.stringify(result)}`;
  const { window } = result;
  const validation = validateNormalizedTimeRangeWindow({ range_type: window.rangeType, range_start: window.rangeStart, range_end: window.rangeEnd, timezone: window.timezone });
  if (!validation.ok) return `invalid ${window.rangeType} window: ${validation.reason}`;
  if (window.rangeEnd !== new Date(requestedAt).toISOString()) return `window ends ${local(window.rangeEnd)}, not at the request`;
  if (local(window.rangeStart) > expected.from) return `${window.rangeType} starts ${local(window.rangeStart)}, needs ${expected.from}`;
  return null;
}

/** A stored answer that analysed a period (the metadata the worker writes on an analysis answer). */
function analysedConversation(question: string, window: { range_type: string; range_start: string; range_end: string }): Array<Record<string, unknown>> {
  return [
    { id: 'u1', role: 'USER', message_type: 'USER_MESSAGE', content: question, metadata: { decision: 'ANALYSIS_REQUEST' } },
    {
      id: 'a1',
      role: 'ASSISTANT',
      message_type: 'ASSISTANT_MESSAGE',
      content: 'Odpowiedź z danymi.',
      metadata: { decision: 'ANALYSIS_REQUEST', ...window, timezone: TZ, normalization_policy_version: 'time-range-normalization.v1' },
    },
  ];
}

describe('message routing corpus (Monday 2026-10-19 10:00, Europe/Warsaw)', () => {
  it('has the 95 audited questions', () => {
    expect(CORPUS).toHaveLength(95);
  });

  it.each(CORPUS)('%s', (content, expected) => {
    expect(problem(route(content), expected)).toBeNull();
  });
});

describe('follow-ups continue the analysed period up to now and include any day they name', () => {
  // "Jak minął dzień?" analysed at 10:00 today: TODAY from midnight to 10:00.
  const morningToday = analysedConversation('Jak minął dzień?', { range_type: 'TODAY', range_start: '2026-10-18T22:00:00.000Z', range_end: '2026-10-19T08:00:00.000Z' });
  const at18 = '2026-10-19T16:00:00.000Z';
  const nextMorning = '2026-10-20T06:00:00.000Z';
  const cases: Array<[string, Array<Record<string, unknown>>, string, Expect]> = [
    // A hypo at 15:10, asked about at 18:00: the 10:00 window ended before it.
    ['Co spowodowało tę hipoglikemię?', morningToday, at18, at('2026-10-19 00:00')],
    // A cause with an infinitive and "je": about the analysed day, not a general how-to (CI, 2026-10-19).
    ['A co mogło je powodować?', morningToday, at18, at('2026-10-19 00:00')],
    ['Jakie mogą być przyczyny?', morningToday, at18, at('2026-10-19 00:00')],
    ['Pokaż przebieg glukozy od 15:00 do 17:30', morningToday, at18, at('2026-10-19 00:00')],
    // The next morning: the evening and night after the analysis are in the window.
    // "teraz" names today: the current state, not the analysed day.
    ['A jak teraz?', morningToday, nextMorning, at('2026-10-20 07:00')],
    ['Co było po kolacji?', morningToday, nextMorning, at('2026-10-19 17:00')],
    ['A jak minęła noc?', morningToday, nextMorning, at('2026-10-19 21:00')],
    // A day named in the follow-up.
    ['Co spowodowało wczorajszą hipo?', morningToday, at18, at('2026-10-18 00:00')],
    ['A w piątek?', morningToday, at18, at('2026-10-16 00:00')],
    ['A w ostatnich 14 dniach?', morningToday, at18, at('2026-10-05 00:00')],
    ['Czy to się powtarza?', morningToday, at18, at('2026-10-12 00:00')],
    // After a week: a bare follow-up keeps the week.
    ['A co z bazą?', analysedConversation('Podsumuj tydzień', { range_type: 'MEDIUM_RANGE', range_start: '2026-10-11T22:00:00.000Z', range_end: '2026-10-19T08:00:00.000Z' }), at18, at('2026-10-12 00:00')],
    ['Dzięki!', morningToday, at18, 'SOCIAL'],
    ['Co oznacza SMB?', morningToday, at18, 'GENERAL'],
  ];

  it.each(cases)('%s', (content, messages, requestedAt, expected) => {
    expect(problem(route(content, { messages, requestedAt }), expected, requestedAt)).toBeNull();
  });

  it('keeps the analysed start when a range type fits the longer window', () => {
    const result = route('Co spowodowało tę hipoglikemię?', { messages: morningToday, requestedAt: at18 });
    expect(result).toMatchObject({ route: 'ANALYSIS', basis: 'FOLLOW_UP', window: { rangeType: 'TODAY', rangeStart: '2026-10-18T22:00:00.000Z', rangeEnd: at18 } });
    // 32 h fits no range type exactly: the 3-day window that holds the analysed day.
    const nextDay = route('A teraz jak?', { messages: morningToday, requestedAt: nextMorning });
    expect(nextDay).toMatchObject({ route: 'ANALYSIS', window: { rangeType: 'TODAY' } });
    const bare = route('A po obiedzie?', { messages: morningToday, requestedAt: nextMorning });
    expect(bare).toMatchObject({ route: 'ANALYSIS', basis: 'FOLLOW_UP', window: { rangeType: 'SHORT_RANGE', rangeEnd: nextMorning } });
  });
});

describe('just after midnight "dziś" and "teraz" include the previous evening', () => {
  /** Monday 2026-10-19 00:15 local. */
  const AFTER_MIDNIGHT = '2026-10-18T22:15:00.000Z';
  const cases: Array<[string, Expect]> = [
    ['Jaki jest teraz cukier?', at('2026-10-18 21:00')],
    ['Czemu teraz rośnie?', at('2026-10-18 19:00')],
    ['Ile dziś zjadł?', at('2026-10-18 18:00')],
    ['Czy potrzebna jest korekta?', at('2026-10-18 20:00')],
    ['Jak minął wieczór?', at('2026-10-18 17:00')],
    ['Co było o 22:00?', at('2026-10-18 21:00')],
    ['Jak było wczoraj?', at('2026-10-18 00:00')],
    ['Ostatnie 3 godziny', at('2026-10-18 21:15')],
  ];

  it.each(cases)('%s', (content, expected) => {
    expect(problem(route(content, { requestedAt: AFTER_MIDNIGHT }), expected, AFTER_MIDNIGHT)).toBeNull();
  });

  it('starts TODAY at 18:00 the day before until 06:00, then at midnight', () => {
    const early = route('Jaki jest teraz cukier?', { requestedAt: '2026-10-19T03:59:00.000Z' });
    expect(early.route === 'ANALYSIS' && local(early.window.rangeStart)).toBe('2026-10-18 18:00');
    const morning = route('Jaki jest teraz cukier?', { requestedAt: '2026-10-19T04:00:00.000Z' });
    expect(morning.route === 'ANALYSIS' && local(morning.window.rangeStart)).toBe('2026-10-19 00:00');
  });

  it('puts the previous evening in focus too', () => {
    expect(namedFocusDates('Jaki jest teraz cukier?', AFTER_MIDNIGHT, TZ)).toEqual(['2026-10-18', '2026-10-19']);
    expect(namedFocusDates('Jaki jest teraz cukier?', MONDAY_10, TZ)).toEqual(['2026-10-19']);
  });
});

describe('days in focus and periods beyond reach', () => {
  it('names the days a message is about, counted from the question time', () => {
    expect(namedFocusDates('W piątek była hipo?', MONDAY_10, TZ)).toEqual(['2026-10-16']);
    expect(namedFocusDates('Porównaj 15 i 16 października', MONDAY_10, TZ)).toEqual(['2026-10-15', '2026-10-16']);
    expect(namedFocusDates('Jak było w weekend?', MONDAY_10, TZ)).toEqual(['2026-10-17', '2026-10-18']);
    expect(namedFocusDates('Co było przedwczoraj?', MONDAY_10, TZ)).toEqual(['2026-10-17']);
    // Monday asking about Monday: a week ago.
    expect(namedFocusDates('Jak było w poniedziałek?', MONDAY_10, TZ)).toEqual(['2026-10-12']);
    expect(namedFocusDates('Podsumuj ostatni tydzień', MONDAY_10, TZ)).toEqual([]);
  });

  it.each([
    ['Co było 12 września?', 'BEYOND_REACH'],
    ['Podsumuj ostatnie 3 miesiące', 'BEYOND_REACH'],
    ['Ostatnie 45 dni', 'BEYOND_REACH'],
    ['Jak było w zeszłym roku?', 'BEYOND_REACH'],
  ] as Array<[string, Expect]>)('%s', (content, expected) => {
    expect(problem(route(content), expected)).toBeNull();
  });

  it('says plainly how far back an analysis reaches', () => {
    expect(buildBeyondReachAnswer('Co było 12 września?', MONDAY_10, TZ)).toBe(
      'Mogę przeanalizować najwyżej ostatnie 30 dni, czyli dane od 19 września. Pytanie sięga 12 września 2026, więc tego okresu nie przeanalizuję. Zapytaj o dzień albo okres z ostatnich 30 dni, np. „podsumuj ostatni miesiąc”.',
    );
    expect(buildBeyondReachAnswer('Co było wczoraj?', MONDAY_10, TZ)).toBeNull();
  });

  it('does not read times, decimals, "co 3 dni" or dates ahead as periods beyond reach', () => {
    for (const content of ['Czy przelicznik 1.5 jest dobry?', 'Co było o 8.05?', 'Ile podać na 2.5 WBT?', 'Jak będzie 25 października?', 'Czy zmieniamy wkłucie co 3 dni?']) {
      expect(route(content), content).toMatchObject({ route: 'ANALYSIS' });
    }
    expect(route('Co 3 dni zmieniać wkłucie?')).toEqual({ route: 'DIRECT', reason: 'GENERAL_KNOWLEDGE' });
  });
});

describe('2026-10-21 audit: background durations, patient-tied definitions, more period wordings', () => {
  /** Wednesday 2026-10-21 10:00 local. */
  const WEDNESDAY_10 = '2026-10-21T08:00:00.000Z';

  it.each([
    // A duration that sets the scene is no period: the day word or the default wins, never "beyond reach".
    ['Od 3 miesięcy mamy Trio, dlaczego dziś tak skacze?', at(TODAY0)],
    ['Syn ma 12 lat i od 2 miesięcy ma pompę, czy dobrze idzie?', at(TODAY0)],
    ['Pół roku temu zmieniliśmy ICR, czy teraz jest dobry?', at('2026-10-12 00:00')],
    ['Od zeszłego roku ma cukrzycę, jak wygląda cukier?', at(TODAY0)],
    ['Od 2 tygodni mamy nowy sensor, dlaczego wczoraj skakał?', at('2026-10-18 00:00')],
    // Within 30 days and alone, it is the period.
    ['Od 3 dni jest wysoko, czemu?', at('2026-10-16 00:00')],
    // Genuine requests for an old period still say how far back an analysis reaches.
    ['Pokaż ostatnie 3 miesiące', 'BEYOND_REACH'],
    ['Jak było przez ostatni rok?', 'BEYOND_REACH'],
    ['Podsumuj ostatnie pół roku', 'BEYOND_REACH'],
    ['Co było 2 miesiące temu?', 'BEYOND_REACH'],
    ['Rok temu było lepiej?', 'BEYOND_REACH'],
    // A definition wording about the patient's own event or reading is about the patient.
    ['Co oznacza ten spadek o 14:30?', at('2026-10-18 13:30')],
    ['Jak działa jego bazal, że tak rośnie?', at('2026-10-12 00:00')],
    ['Co oznacza wynik 250 po obiedzie?', at('2026-10-18 12:00')],
    ['Jak w tej rozmowie pisałem, po kolacji spadł do 50 — dlaczego?', at('2026-10-18 17:00')],
    ['Jak działa SMB?', 'GENERAL'],
    ['Co to jest bolus przedłużony?', 'GENERAL'],
    ['Co oznacza strzałka w dół?', 'GENERAL'],
    ['Czy to zostanie tylko w tej rozmowie?', 'GENERAL'],
    // Days counted as "doby", a week that passed, a calendar month, the previous calendar week.
    ['Ostatnie 2 doby, ile było hipo?', at('2026-10-17 00:00')],
    ['Jak minęły trzy doby?', at('2026-10-16 00:00')],
    ['Jak minął tydzień?', at('2026-10-12 00:00')],
    ['Jaki był TIR w październiku?', at('2026-10-01 00:00')],
    ['Podsumuj październik', at('2026-10-01 00:00')],
    ['Jak było we wrześniu?', 'BEYOND_REACH'],
    ['Jak było w zeszłym tygodniu?', at('2026-10-12 00:00')],
  ] as Array<[string, Expect]>)('%s', (content, expected) => {
    expect(problem(route(content), expected)).toBeNull();
  });

  it('reads the previous calendar week Monday to Sunday, and "ostatni tydzień" as the rolling 7 days', () => {
    // Its Monday is 9 days back: the 14-day window that holds it.
    const previous = route('Jak było w zeszłym tygodniu?', { requestedAt: WEDNESDAY_10 });
    expect(problem(previous, at('2026-10-12 00:00'), WEDNESDAY_10)).toBeNull();
    expect(previous).toMatchObject({ route: 'ANALYSIS', window: { rangeType: 'LONG_RANGE' } });
    expect(namedFocusDates('Jak było w zeszłym tygodniu?', WEDNESDAY_10, TZ)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
    expect(namedFocusDates('Co było w poprzednim tygodniu?', MONDAY_10, TZ)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
    const rolling = route('Jak wyglądał ostatni tydzień?', { requestedAt: WEDNESDAY_10 });
    expect(rolling.route === 'ANALYSIS' && [rolling.window.rangeType, local(rolling.window.rangeStart)]).toEqual(['MEDIUM_RANGE', '2026-10-14 00:00']);
    expect(namedFocusDates('Jak wyglądał ostatni tydzień?', WEDNESDAY_10, TZ)).toEqual([]);
  });

  it('keeps today\'s window when a background duration or an amount is not a period or a clock time', () => {
    for (const content of [
      'Od 3 miesięcy mamy Trio, dlaczego dziś tak skacze?',
      'Syn ma 12 lat i od 2 miesięcy ma pompę, czy dobrze idzie?',
      'Za 2 tygodnie mamy wizytę, jak dziś?',
      'Po 2 tygodniach przerwy wrócił na basen, czemu spada?',
      'Zjadł ok 15 g węgli, czemu rośnie?',
      'Dałem około 20 g, czy dobrze?',
    ]) {
      const result = route(content);
      expect(result.route === 'ANALYSIS' && [result.window.rangeType, local(result.window.rangeStart)], content).toEqual(['TODAY', TODAY0]);
    }
    for (const content of ['ok 15 g', 'około 20 g', 'ok 2 j', 'o 2 godziny później']) {
      expect(readMessagePeriod(content, MONDAY_10, TZ).soft, content).toBeNull();
    }
    expect(readMessagePeriod('Co było ok 15?', MONDAY_10, TZ).soft).not.toBeNull();
  });
});

describe('the hypo screen chat and photos stay as they were', () => {
  const hypoWindow: AnalysisWindow = { rangeType: 'TODAY', rangeStart: '2026-10-19T03:00:00.000Z', rangeEnd: '2026-10-19T08:00:00.000Z', timezone: TZ, normalizationPolicyVersion: 'time-range-normalization.v1' };

  it('analyses the hypo window unless a period is named or the question is about a pattern', () => {
    expect(route('Dlaczego był ten spadek?', { hypoWindow })).toMatchObject({ route: 'ANALYSIS', basis: 'HYPO_EPISODE', window: hypoWindow });
    expect(route('Ile zjadł na śniadanie?', { hypoWindow })).toMatchObject({ basis: 'HYPO_EPISODE' });
    expect(route('Czy w ostatnich 7 dniach też były takie spadki?', { hypoWindow })).toMatchObject({ window: { rangeType: 'MEDIUM_RANGE' } });
    expect(route('Czy to się powtarza?', { hypoWindow })).toMatchObject({ window: { rangeType: 'MEDIUM_RANGE' } });
    expect(route('dzięki', { hypoWindow })).toEqual({ route: 'DIRECT', reason: 'SOCIAL' });
    // A general question in the event's chat is about the event: its data, not a data-free answer.
    expect(route('Czy można podać sok?', { hypoWindow })).toMatchObject({ route: 'ANALYSIS', basis: 'HYPO_EPISODE' });
    expect(route('Czy można podać sok?')).toMatchObject({ route: 'DIRECT', reason: 'GENERAL_KNOWLEDGE' });
  });

  it('answers a photo with the patient data, whatever the wording', () => {
    for (const content of ['Ile to ma węglowodanów?', '', 'Ok', 'Co to jest?']) {
      expect(route(content, { hasPhotos: true })).toMatchObject({ route: 'ANALYSIS', window: { rangeType: 'TODAY' } });
    }
  });
});
