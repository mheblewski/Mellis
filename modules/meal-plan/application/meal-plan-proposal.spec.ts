import { describe, expect, it, vi } from 'vitest';
import {
  MealPlanProposalSession, daysWithoutMeals, earlierTimesFrom, isMealPlanMessage, mealPlanProposalView, namesMealPlanDocument,
  parseMealPlanProposal, planFromProposal, withMealPlanProposals, type MealPlanProposalRecord,
} from './meal-plan-proposal';

const TZ = 'Europe/Warsaw';
// Thursday 5 November 2026, 12:00 in Warsaw.
const NOW = new Date('2026-11-05T11:00:00Z');
const meal = (date: string, title = 'Obiad', time: string | null = '12:30') => ({ kind: 'MEAL', title, date, time, items: [{ name: 'Zupa', carbs_g: 20, protein_g: null, fat_g: null }] });
const parse = (entries: unknown[], extra: Record<string, unknown> = {}, earlier = new Map<string, string>()) =>
  parseMealPlanProposal({ lead_minutes: null, macros_source: 'FILE', entries, ...extra }, { now: NOW, timeZone: TZ, earlierTimes: earlier });

describe('parseMealPlanProposal', () => {
  it('takes a menu alone, activities alone and any mix', () => {
    expect(parse([meal('2026-11-09')]).entries).toHaveLength(1);
    expect(parse([{ kind: 'MOVEMENT', title: 'WF', date: '2026-11-10', time: '14:45', items: [] }]).entries[0].kind).toBe('MOVEMENT');
    const mixed = parse([meal('2026-11-09'), { kind: 'MOVEMENT', title: 'WF', date: '2026-11-09', time: '14:45', items: [{ name: 'x', carbs_g: 1, protein_g: 1, fat_g: 1 }] }]);
    expect(mixed.entries[1].items).toEqual([]);
    expect(mixed.lead_minutes).toBe(20);
  });

  it('asks on the card for a time the source lacks, borrowing an earlier plan when it can', () => {
    const noTime = parse([meal('2026-11-09', 'Obiad', null), meal('2026-11-10', 'Obiad', null), meal('2026-11-09', 'Kolacja', null)], {}, new Map([['MEAL|obiad', '12:30']]));
    expect(noTime.times_to_check).toEqual([
      { kind: 'MEAL', title: 'Obiad', time: '12:30' },
      { kind: 'MEAL', title: 'Kolacja', time: null },
    ]);
    expect(parse([meal('2026-11-09', 'Obiad', '8:50')]).entries[0].time).toBe('08:50');
  });

  it('leaves out days already past and refuses what it cannot place', () => {
    expect(parse([meal('2026-11-04'), meal('2026-11-09')]).entries.map((entry) => entry.date)).toEqual(['2026-11-09']);
    expect(() => parse([meal('2025-11-09')])).toThrow('every date has passed');
    expect(() => parse([meal('2026-12-25')])).toThrow('days ahead');
    expect(() => parse([meal('2026-02-31')])).toThrow('YYYY-MM-DD');
    expect(() => parse([meal('2026-11-09', 'Obiad', 'południe')])).toThrow('HH:MM');
    expect(() => parse([meal('2026-11-09')], { lead_minutes: 500 })).toThrow('lead_minutes');
    expect(() => parse([])).toThrow('empty');
  });

  it('drops the same entry read twice', () => {
    expect(parse([meal('2026-11-09'), meal('2026-11-09')]).entries).toHaveLength(1);
  });
});

describe('planFromProposal', () => {
  it('uses the card\'s times, then the earlier plan, and converts in the patient\'s zone', () => {
    const proposal = parse([meal('2026-11-09', 'Obiad', null), meal('2026-11-09', 'Kolacja', null)], {}, new Map([['MEAL|obiad', '12:30']]));
    const { plan, replaced_keys } = planFromProposal(proposal, [{ kind: 'MEAL', title: 'Kolacja', time: '18:05' }], { now: NOW, timeZone: TZ });
    expect(plan.entries.map((entry) => entry.planned_at)).toEqual(['2026-11-09T11:30:00.000Z', '2026-11-09T17:05:00.000Z']);
    expect(replaced_keys[0]).toEqual({ kind: 'MEAL', title: 'obiad', date: '2026-11-09' });
  });

  it('refuses a meal with no time and counts what already passed', () => {
    const missing = parse([meal('2026-11-09', 'Kolacja', null)]);
    expect(() => planFromProposal(missing, [], { now: NOW, timeZone: TZ })).toThrow('Podaj godzinę: Kolacja');
    const today = parse([meal('2026-11-05', 'Śniadanie', '08:00'), meal('2026-11-09')]);
    expect(planFromProposal(today, [], { now: NOW, timeZone: TZ }).skipped_past).toBe(1);
    expect(() => planFromProposal(parse([meal('2026-11-05', 'Śniadanie', '08:00')]), [], { now: NOW, timeZone: TZ })).toThrow('minęły');
  });

  it('refuses a malformed time from the phone', () => {
    const proposal = parse([meal('2026-11-09', 'Kolacja', null)]);
    expect(() => planFromProposal(proposal, [{ kind: 'MEAL', title: 'Kolacja', time: '25:00' }], { now: NOW, timeZone: TZ })).toThrow('HH:MM');
    expect(() => planFromProposal(proposal, 'x', { now: NOW, timeZone: TZ })).toThrow('list');
  });
});

describe('the card', () => {
  const record = (over: Partial<MealPlanProposalRecord> = {}): MealPlanProposalRecord => ({
    rules_remembered: false,
    id: 'c1', patient_id: 'p', conversation_id: 'k', user_message_id: 'u', status: 'PROPOSED', plan_id: null, skipped_past: 0, created_at: NOW.toISOString(),
    ...parse([
      meal('2026-11-09'), meal('2026-11-10'), meal('2026-11-12'), meal('2026-11-13'),
      { kind: 'MOVEMENT', title: 'WF', date: '2026-11-10', time: '14:45', items: [] },
      { kind: 'MOVEMENT', title: 'WF', date: '2026-11-12', time: '14:45', items: [] },
    ], { macros_source: 'ESTIMATED' }),
    ...over,
  });
  const context = { patient_name: 'Zosia', recipients: ['Piotr', 'Ewa'], replaces: 0, now: NOW, time_zone: TZ };

  it('says what the plan holds in full sentences', () => {
    const view = mealPlanProposalView(record(), context);
    expect(view.summary).toBe('Plan ma 4 posiłki na 4 dni.');
    expect(view.button_title).toBe('Włącz 4 przypomnienia: Zosia');
    expect(view.notes).toEqual([
      'Dawkę policzę przed każdym posiłkiem.',
      'Makroskładniki są oszacowane dla typowych porcji. Sprawdzisz je przed posiłkiem.',
      '11 listopada nie ma w jadłospisie, więc wtedy nie przypomnę.',
      'WF: wtorki i czwartki, 14:45.',
      'Przypomnienia przyjdą do: Piotr, Ewa. Każdy może je wyłączyć na swoim telefonie.',
    ]);
    expect((view.days as Array<{ label: string }>)[0].label).toBe('Poniedziałek, 9 listopada');
  });

  it('says what a confirmed card did and what a replacement replaces', () => {
    const done = mealPlanProposalView(record({ status: 'ACCEPTED', skipped_past: 1 }), context);
    expect(done.accepted_line).toBe('Włączono 3 przypomnienia.');
    expect(done.skipped_line).toBe('1 posiłek już minął, więc nie ma go w planie.');
    expect(mealPlanProposalView(record({ status: 'ACCEPTED', skipped_past: 3 }), context).skipped_line).toBe('3 posiłki już minęły, więc nie ma ich w planie.');
    expect(mealPlanProposalView(record(), { ...context, replaces: 3 }).notes).toContain('Ten plan zastąpi wcześniejsze wpisy (3) na te same dni.');
  });

  it('counts only activities when there is no meal', () => {
    const view = mealPlanProposalView(record({ entries: [{ kind: 'MOVEMENT', title: 'WF', date: '2026-11-10', time: '14:45', items: [] }] }), context);
    expect(view.summary).toBe('Plan ma tylko zajęcia ruchowe.');
    expect(view.button_title).toBe('Zapisz plan: Zosia');
    expect(view.notes).toEqual(['WF: 10 listopada, 14:45.']);
  });

  it('skips weekends when it says which days have no meals', () => {
    expect(daysWithoutMeals(parse([meal('2026-11-06'), meal('2026-11-09')]).entries)).toEqual([]);
  });

  it('goes under the last answer to its question', () => {
    const conversation = { messages: [
      { id: 'u', role: 'USER' },
      { id: 'a1', role: 'ASSISTANT', metadata: { user_message_id: 'u' } },
      { id: 'a2', role: 'ASSISTANT', metadata: { user_message_id: 'u' } },
    ] };
    const out = withMealPlanProposals(conversation, [{ user_message_id: 'u', view: { id: 'c1' } }]).messages as Array<Record<string, unknown>>;
    expect(out[1].meal_plan_proposals).toBeUndefined();
    expect(out[2].meal_plan_proposals).toEqual([{ id: 'c1' }]);
  });
});

describe('what a card still lacks', () => {
  it('says what could not be read', () => {
    const proposal = parse([meal('2026-11-09')], { unread: ['obiad we wtorek'] });
    const view = mealPlanProposalView({ id: 'c', patient_id: 'p', conversation_id: 'k', user_message_id: 'u', status: 'PROPOSED', plan_id: null, skipped_past: 0, created_at: NOW.toISOString(), rules_remembered: false, ...proposal }, { patient_name: 'Zosia', recipients: [], replaces: 2, now: NOW, time_zone: TZ });
    expect(view.notes).toContain('Nie udało się odczytać: obiad we wtorek.');
    expect(view.unread).toEqual(['obiad we wtorek']);
    expect(view.replaces).toBe(2);
    expect(view.patient_name).toBe('Zosia');
  });

  it('"Dodaj tylko nowe" keeps what an earlier plan has on that day', () => {
    const proposal = parse([meal('2026-11-09'), meal('2026-11-10')]);
    const { plan, replaced_keys } = planFromProposal(proposal, [], { now: NOW, timeZone: TZ, keepExisting: new Set(['MEAL|obiad|2026-11-09']) });
    expect(plan.entries.map((entry) => entry.planned_at.slice(0, 10))).toEqual(['2026-11-10']);
    expect(replaced_keys.map((key) => key.date)).toEqual(['2026-11-10']);
    expect(() => planFromProposal(parse([meal('2026-11-09')]), [], { now: NOW, timeZone: TZ, keepExisting: new Set(['MEAL|obiad|2026-11-09']) })).toThrow('już w planie');
  });
});

describe('a food note from the chat', () => {
  const session = (offerFoodNote?: (args: never) => Promise<{ status: 'OFFERED' | 'ALREADY_REMEMBERED' }>) => new MealPlanProposalSession({ patientId: 'p', conversationId: 'k', userMessageId: 'u', timeZone: TZ, now: () => NOW, store: { offerFoodNote } as never });

  it('waits for the card, in words made here', async () => {
    const offer = vi.fn(async () => ({ status: 'OFFERED' as const }));
    expect(await session(offer).proposeFoodNote({ food_name: 'Buraczki', portion: 'NONE' })).toMatchObject({ status: 'OFFERED', note: 'Zwykle zostaje na talerzu: Buraczki' });
    expect(await session(offer).proposeFoodNote({ food_name: 'Buraczki', portion: 'ALL' })).toMatchObject({ status: 'INVALID_REQUEST' });
    expect(offer).toHaveBeenCalledTimes(1);
  });
});

describe('remembered rules', () => {
  const context = { patient_name: 'Zosia', recipients: [], replaces: 0, now: NOW, time_zone: TZ };
  const base = { id: 'c1', patient_id: 'p', conversation_id: 'k', user_message_id: 'u', status: 'PROPOSED' as const, plan_id: null, skipped_past: 0, created_at: NOW.toISOString(), rules_remembered: false };

  it('keeps what the model passes, and only short sentences', () => {
    const proposal = parse([meal('2026-11-09')], { rules_to_remember: [' Owoc dają  na wynos. ', 'Owoc dają na wynos.', 'x'.repeat(201), 7], applied_rules: ['Zupa z podwieczorkiem to jeden posiłek.'] });
    expect(proposal.rules_to_remember).toEqual(['Owoc dają na wynos.']);
    expect(proposal.applied_rules).toEqual(['Zupa z podwieczorkiem to jeden posiłek.']);
    expect(parse([meal('2026-11-09')]).rules_to_remember).toEqual([]);
  });

  it('tells the model only what is remembered, as data about meals', () => {
    const session = new MealPlanProposalSession({ patientId: 'p', conversationId: 'k', userMessageId: 'u', timeZone: TZ, now: () => NOW, store: {} as never, rememberedRules: ['Owoc dają na wynos.'] });
    expect(session.instructions).toContain('["Owoc dają na wynos."]');
    expect(session.instructions).toContain('about meals only');
    expect(new MealPlanProposalSession({ patientId: 'p', conversationId: 'k', userMessageId: 'u', timeZone: TZ, now: () => NOW, store: {} as never }).instructions).not.toContain('asked to remember');
  });

  it('names the rules on the card and offers to remember new ones', () => {
    const view = mealPlanProposalView({ ...base, ...parse([meal('2026-11-09')], { rules_to_remember: ['Owoc dają na wynos.'], applied_rules: ['Zupa z podwieczorkiem to jeden posiłek.'] }) }, context);
    expect(view.rules_to_remember).toEqual(['Owoc dają na wynos.']);
    expect(view.rules_remembered).toBe(false);
    expect(view.notes).toContain('Zastosowano zapamiętane zasady: Zupa z podwieczorkiem to jeden posiłek.');
  });
});

describe('words', () => {
  it('opens the tool for plans, keeps analyses of the past out of the document rule', () => {
    expect(isMealPlanMessage('Dodaj jadłospis')).toBe(true);
    expect(isMealPlanMessage('WF jest we wtorki o 14:45')).toBe(true);
    expect(isMealPlanMessage('plan lekcji na przyszły tydzień')).toBe(true);
    expect(isMealPlanMessage('ile było hipo?')).toBe(false);
    expect(namesMealPlanDocument('jadłospis na ten tydzień')).toBe(true);
    expect(namesMealPlanDocument('jak po WF-ie w zeszłym tygodniu?')).toBe(false);
  });

  it('earlier times keep the newest of each title', () => {
    expect(earlierTimesFrom([{ kind: 'MEAL', title: 'Obiad ', planned_at: '2026-11-03T11:30:00Z' }, { kind: 'MEAL', title: 'obiad', planned_at: '2026-10-01T10:00:00Z' }], TZ).get('MEAL|obiad')).toBe('12:30');
  });
});

describe('MealPlanProposalSession', () => {
  const store = () => ({ insertProposal: vi.fn(async (args) => ({ id: 'c1', ...args.proposal })), discardForUserMessage: vi.fn(async () => undefined), listEarlierTimes: vi.fn(async () => []) });

  it('stores a card and tells the model what the card asks for; nothing else happens', async () => {
    const deps = store();
    const session = new MealPlanProposalSession({ patientId: 'p', conversationId: 'k', userMessageId: 'u', timeZone: TZ, now: () => NOW, store: deps as never });
    expect(session.instructions).toContain('today is 2026-11-05 (czwartek)');
    const result = await session.propose({ lead_minutes: null, macros_source: 'FILE', entries: [meal('2026-11-09', 'Obiad', null)] });
    expect(result).toMatchObject({ status: 'PROPOSED', meals: 1, times_the_card_asks_for: ['Obiad'], days_already_past: 0 });
    const withPast = await session.propose({ lead_minutes: null, macros_source: 'FILE', entries: [meal('2026-11-02'), meal('2026-11-03'), meal('2026-11-06')] });
    expect(withPast).toMatchObject({ meals: 1, days_already_past: 2 });
    expect(deps.discardForUserMessage).toHaveBeenCalledWith('p', 'u');
  });

  it('returns the problem for a call it cannot use, with no card', async () => {
    const deps = store();
    const session = new MealPlanProposalSession({ patientId: 'p', conversationId: 'k', userMessageId: 'u', timeZone: TZ, now: () => NOW, store: deps as never });
    expect(await session.propose({ macros_source: 'FILE', entries: [] })).toMatchObject({ status: 'INVALID_REQUEST' });
    expect(deps.insertProposal).not.toHaveBeenCalled();
  });
});
