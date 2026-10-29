import { describe, expect, it } from 'vitest';
import {
  mergeRequirements,
  normalizeTimeRangeRequest,
  patternRequirement,
  readMessagePeriod,
  validateNormalizedTimeRangeWindow,
  windowForRequirement,
  localDayWindows,
  type ParsedTimeRangeRequest,
} from './time-range-normalization';

/**
 * The window a message names on its own (with the recurring-pattern week), as routeUserMessage builds it for a named
 * period; AMBIGUOUS when it names none.
 */
function parse(args: { message: string; requested_at: string; timezone: string }): ParsedTimeRangeRequest {
  const period = readMessagePeriod(args.message, args.requested_at, args.timezone);
  if (period.beyondReach) return { status: 'INVALID', reason: 'RANGE_BEYOND_REACH' };
  const requirement = mergeRequirements(period.named, patternRequirement(period));
  return requirement ? windowForRequirement(requirement, args.requested_at, args.timezone) : { status: 'AMBIGUOUS', reason: 'RANGE_NOT_FOUND' };
}

describe('time-range normalization', () => {
  const requestedAt = '2026-10-07T12:00:00.000Z';
  const timezone = 'UTC';

  it('normalizes TODAY from explicit today phrasing', () => {
    const result = parse({
      message: 'Przeanalizuj mój dzisiejszy dzień',
      requested_at: requestedAt,
      timezone,
    });

    expect(result.status).toBe('OK');
    if (result.status !== 'OK') return;
    expect(result.value.range_type).toBe('TODAY');
    expect(result.value.range_profile).toBe('SINGLE_DAY');
    expect(result.value.timezone).toBe('UTC');
    expect(result.value.range_start).toBe('2026-10-07T00:00:00.000Z');
    expect(result.value.range_end).toBe('2026-10-07T12:00:00.000Z');
  });

  it('normalizes 3-day request to SHORT_RANGE', () => {
    const result = parse({
      message: 'Przeanalizuj ostatnie 3 dni',
      requested_at: requestedAt,
      timezone,
    });

    expect(result.status).toBe('OK');
    if (result.status !== 'OK') return;
    expect(result.value.range_type).toBe('SHORT_RANGE');
    expect(result.value.range_profile).toBe('SHORT_RANGE');
    // Three complete days before today plus today so far.
    expect(result.value.range_start).toBe('2026-10-04T00:00:00.000Z');
    expect(result.value.range_end).toBe('2026-10-07T12:00:00.000Z');
  });

  it('gives "ostatnie 7 dni" seven complete local days plus today in Warsaw', () => {
    const result = parse({ message: 'Jakie średnie ddi z ostatnich 7 dni?', requested_at: '2026-10-17T07:54:00.000Z', timezone: 'Europe/Warsaw' });
    expect(result.status).toBe('OK');
    if (result.status !== 'OK') return;
    expect(result.value.range_start).toBe('2026-10-09T22:00:00.000Z');
    const days = localDayWindows(result.value.range_start, result.value.range_end, 'Europe/Warsaw');
    expect(days.map((day) => day.date)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);
    expect(days.filter((day) => day.complete)).toHaveLength(7);
    expect(validateNormalizedTimeRangeWindow({ ...result.value })).toEqual({ ok: true });
  });

  it('keeps ranges stored before the change (days - 1 complete days plus today) valid', () => {
    expect(validateNormalizedTimeRangeWindow({ range_type: 'SHORT_RANGE', range_start: '2026-10-05T00:00:00.000Z', range_end: requestedAt, timezone })).toEqual({ ok: true });
  });

  it('serves yesterday with the 3-day window that contains the whole previous day', () => {
    const result = parse({
      message: 'Jak wyglądała glikemia wczoraj między 18:00 a 23:00?',
      requested_at: requestedAt,
      timezone,
    });

    expect(result.status).toBe('OK');
    if (result.status !== 'OK') return;
    expect(result.value.range_type).toBe('SHORT_RANGE');
    expect(result.value.range_start).toBe('2026-10-04T00:00:00.000Z');
  });

  it('answers questions about the current value from today', () => {
    const result = parse({ message: 'Jaki jest teraz cukier i czy trend jest stabilny?', requested_at: requestedAt, timezone });
    expect(result.status === 'OK' && result.value.range_type).toBe('TODAY');
    const named = parse({ message: 'Jak wyglądał cukier przez ostatnie 7 dni aż do teraz?', requested_at: requestedAt, timezone });
    expect(named.status === 'OK' && named.value.range_type).toBe('MEDIUM_RANGE');
  });

  it('treats every form of "wczoraj" as the previous day', () => {
    for (const message of ['Przeanalizuj mi wczorajszy dzień pod kątem hipoglikemii', 'Dlaczego po wczorajszym obiedzie cukier rósł przez 4 godziny?', 'Co było wczoraj największym problemem?']) {
      const result = parse({ message, requested_at: requestedAt, timezone });
      expect(result.status === 'OK' && result.value.range_type).toBe('SHORT_RANGE');
    }
  });

  it('reads periods named in words: the night and a weekend as the 3-day window, a week, two weeks, a month', () => {
    // 2026-10-19: these were answered without the patient's data ("Nie mam wczytanych danych z ostatnich 7 dni").
    const cases: Array<[string, string]> = [
      ['Opowiedz mi o dzisiejszej nocy', 'SHORT_RANGE'],
      ['Jak minęła noc?', 'SHORT_RANGE'],
      ['Dziś w nocy był spadek?', 'SHORT_RANGE'],
      // Asked on a Wednesday: the last weekend began 4 days ago, beyond the 3-day window.
      ['Jak było w weekend?', 'MEDIUM_RANGE'],
      ['Podsumuj mi ostatni tydzień', 'MEDIUM_RANGE'],
      ['W tym tygodniu było dużo spadków?', 'MEDIUM_RANGE'],
      // The previous calendar week: on Wednesday its Monday is 9 days back.
      ['Jak wyglądał poprzedni tydzień?', 'LONG_RANGE'],
      ['Ostatnie dwa tygodnie?', 'LONG_RANGE'],
      ['Podsumuj ostatni miesiąc', 'EXTENDED_RANGE'],
    ];
    for (const [message, rangeType] of cases) {
      const result = parse({ message, requested_at: requestedAt, timezone });
      expect(result.status === 'OK' && result.value.range_type, message).toBe(rangeType);
    }
  });

  it('keeps general questions that only mention a week or the night without a range', () => {
    for (const message of ['Ile razy w tygodniu zmieniać wkłucie?', 'Co jeść na noc?', 'Potrzebuję pomocy z bazą', 'Cześć, jak się masz?']) {
      expect(parse({ message, requested_at: requestedAt, timezone }).status, message).not.toBe('OK');
    }
  });

  it('lets a named week or month win over the analysed period like a day count; the night does not', () => {
    const namesCount = (message: string) => readMessagePeriod(message, requestedAt, timezone).namesCount;
    expect(namesCount('Podsumuj mi ostatni tydzień')).toBe(true);
    expect(namesCount('A w ostatnim miesiącu?')).toBe(true);
    expect(namesCount('A jak minęła noc?')).toBe(false);
  });

  it('gives a question about a recurring pattern a week of data, unless a range is named', () => {
    const pattern = parse({ message: 'Czy to jest powtarzający się wzorzec?', requested_at: requestedAt, timezone });
    expect(pattern.status === 'OK' && pattern.value.range_type).toBe('MEDIUM_RANGE');
    const named = parse({ message: 'Czy w ostatnich 14 dni to się powtarza?', requested_at: requestedAt, timezone });
    expect(named.status === 'OK' && named.value.range_type).toBe('LONG_RANGE');
  });

  it('treats "dziś" as today', () => {
    const result = parse({ message: 'Jak było dziś rano?', requested_at: requestedAt, timezone });
    expect(result.status === 'OK' && result.value.range_type).toBe('TODAY');
  });

  it('normalizes 7-day request to MEDIUM_RANGE', () => {
    const result = parse({
      message: 'Przeanalizuj ostatnie 7 dni',
      requested_at: requestedAt,
      timezone,
    });

    expect(result.status).toBe('OK');
    if (result.status !== 'OK') return;
    expect(result.value.range_type).toBe('MEDIUM_RANGE');
    expect(result.value.range_profile).toBe('MEDIUM_RANGE');
  });

  it('normalizes 14-day request to LONG_RANGE', () => {
    const result = parse({
      message: 'Przeanalizuj ostatnie 14 dni',
      requested_at: requestedAt,
      timezone,
    });

    expect(result.status).toBe('OK');
    if (result.status !== 'OK') return;
    expect(result.value.range_type).toBe('LONG_RANGE');
    expect(result.value.range_profile).toBe('LONG_RANGE');
  });

  it('normalizes 30-day request to EXTENDED_RANGE', () => {
    const result = parse({
      message: 'Przeanalizuj ostatnie 30 dni',
      requested_at: requestedAt,
      timezone,
    });

    expect(result.status).toBe('OK');
    if (result.status !== 'OK') return;
    expect(result.value.range_type).toBe('EXTENDED_RANGE');
    expect(result.value.range_profile).toBe('EXTENDED_RANGE');
  });

  it('maps any day count up to 30 to the smallest range that holds it, and says when a period is beyond 30 days', () => {
    const five = parse({ message: 'Przeanalizuj ostatnie 5 dni', requested_at: requestedAt, timezone });
    expect(five.status === 'OK' && five.value.range_type).toBe('MEDIUM_RANGE');
    const ten = parse({ message: 'Ostatnie 10 dni', requested_at: requestedAt, timezone });
    expect(ten.status === 'OK' && ten.value.range_type).toBe('LONG_RANGE');
    expect(parse({ message: 'Przeanalizuj ostatnie 45 dni', requested_at: requestedAt, timezone }))
      .toEqual({ status: 'INVALID', reason: 'RANGE_BEYOND_REACH' });
  });

  it('returns AMBIGUOUS when range is not explicit', () => {
    const result = parse({
      message: 'Przeanalizuj moje wyniki',
      requested_at: requestedAt,
      timezone,
    });

    expect(result).toEqual({ status: 'AMBIGUOUS', reason: 'RANGE_NOT_FOUND' });
  });

  it('validates reversed ranges as invalid', () => {
    const validation = validateNormalizedTimeRangeWindow({
      range_type: 'MEDIUM_RANGE',
      range_start: '2026-10-07T12:00:00.000Z',
      range_end: '2026-10-07T11:00:00.000Z',
      timezone,
    });

    expect(validation).toEqual({ ok: false, reason: 'INVALID_RANGE_ORDER' });
  });

  it('validates timezone and duration compatibility', () => {
    const normalized = normalizeTimeRangeRequest({
      range_type: 'MEDIUM_RANGE',
      requested_at: requestedAt,
      timezone,
    });
    expect(normalized.status).toBe('OK');
    if (normalized.status !== 'OK') return;

    expect(
      validateNormalizedTimeRangeWindow({
        range_type: normalized.value.range_type,
        range_start: normalized.value.range_start,
        range_end: normalized.value.range_end,
        timezone: normalized.value.timezone,
      }),
    ).toEqual({ ok: true });

    expect(
      validateNormalizedTimeRangeWindow({
        range_type: 'TODAY',
        range_start: normalized.value.range_start,
        range_end: normalized.value.range_end,
        timezone: 'Invalid/Timezone',
      }),
    ).toEqual({ ok: false, reason: 'INVALID_TIMEZONE' });
  });
});