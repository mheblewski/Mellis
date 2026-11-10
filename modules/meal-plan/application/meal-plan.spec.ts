import { describe, expect, it } from 'vitest';
import { mealPlanMissedContent, mealPlanPushDecision, mealPlanReminderContent, parseMealPlanInput } from './meal-plan';
import { glucoseNotRisingSince, mealPlanEatenContent, mealPlanEatenDecision, mealPlanMovementContent, mealPlanMovementDecision } from './meal-plan';

const entry = { kind: 'MEAL' as const, status: 'PLANNED' as const, planned_at: '2026-11-10T11:30:00.000Z', lead_minutes: 20, reminder_sent_at: null as string | null, missed_sent_at: null as string | null };
const at = (time: string) => new Date(`2026-11-10T${time}:00.000Z`);

describe('mealPlanPushDecision', () => {
  it('waits until the lead, then reminds until the meal', () => {
    expect(mealPlanPushDecision(entry, at('11:09'), false).action).toBe('WAIT');
    expect(mealPlanPushDecision(entry, at('11:10'), false).action).toBe('REMIND');
    expect(mealPlanPushDecision(entry, at('11:29'), false).action).toBe('REMIND');
  });

  it('never says "soon" after the meal started', () => {
    expect(mealPlanPushDecision(entry, at('11:31'), false).action).toBe('CLOSE_REMINDER');
  });

  it('stays quiet when a dose was given', () => {
    expect(mealPlanPushDecision(entry, at('11:15'), true).action).toBe('CLOSE_REMINDER');
    expect(mealPlanPushDecision({ ...entry, reminder_sent_at: 'x' }, at('11:45'), true).action).toBe('CLOSE_MISSED');
  });

  it('sends the missed push once, from 10 minutes after until 2 hours after', () => {
    const reminded = { ...entry, reminder_sent_at: 'x' };
    expect(mealPlanPushDecision(reminded, at('11:39'), false).action).toBe('WAIT');
    expect(mealPlanPushDecision(reminded, at('11:40'), false).action).toBe('MISSED');
    expect(mealPlanPushDecision(reminded, at('13:31'), false).action).toBe('CLOSE_MISSED');
    expect(mealPlanPushDecision({ ...reminded, missed_sent_at: 'y' }, at('11:50'), false).action).toBe('DONE');
  });

  it('sends nothing for a skipped meal or movement', () => {
    expect(mealPlanPushDecision({ ...entry, status: 'SKIPPED' }, at('11:15'), false).action).toBe('DONE');
    expect(mealPlanPushDecision({ ...entry, status: 'REMOVED' }, at('11:15'), false).action).toBe('DONE');
    expect(mealPlanPushDecision({ ...entry, kind: 'MOVEMENT' }, at('11:15'), false).action).toBe('DONE');
  });
});

describe('push texts', () => {
  it('has no dose and says what glucose does', () => {
    const fall = mealPlanReminderContent({ title: 'Obiad' }, '12:30', { value: 84, arrow: '↘' });
    expect(fall).toEqual({ title: 'Obiad o 12:30', body: 'Glukoza wynosi 84 i spada.' });
    expect(mealPlanReminderContent({ title: 'Obiad' }, '12:30', { value: 128, arrow: '→' }).body).toBe('Glukoza wynosi 128 i nie zmienia się.');
    expect(mealPlanReminderContent({ title: 'Obiad' }, '12:30', null).body).toBe('Brak świeżego odczytu glukozy.');
    expect(mealPlanMissedContent({ title: 'Obiad' }, '12:30', { value: 128, arrow: null })).toEqual({ title: 'Obiad 12:30 bez bolusa', body: 'Glukoza wynosi 128. Jeśli obiad był zjedzony, otwórz i sprawdź dawkę.' });
    expect(mealPlanMissedContent({ title: 'Kolacja' }, '18:00', null).body).toBe('Brak świeżego odczytu glukozy. Jeśli kolacja była zjedzona, otwórz i sprawdź dawkę.');
    expect(mealPlanMissedContent({ title: 'Zupa i podwieczorek' }, '15:00', null).body).toBe('Brak świeżego odczytu glukozy. Jeśli posiłek był zjedzony, otwórz i sprawdź dawkę.');
  });
});

describe('parseMealPlanInput', () => {
  const now = new Date('2026-11-05T12:00:00.000Z');
  const meal = { kind: 'MEAL', title: ' Obiad ', planned_at: '2026-11-10T11:30:00.000Z', items: [{ name: 'Ziemniaki', carbs_g: 26 }] };

  it('reads a plan with the default lead', () => {
    const plan = parseMealPlanInput({ entries: [meal] }, now);
    expect(plan.lead_minutes).toBe(20);
    expect(plan.entries[0]).toEqual({ kind: 'MEAL', title: 'Obiad', planned_at: '2026-11-10T11:30:00.000Z', items: [{ name: 'Ziemniaki', carbs_g: 26, protein_g: null, fat_g: null }] });
  });

  it('refuses a meal in the past, too far ahead, or bad values', () => {
    expect(() => parseMealPlanInput({ entries: [{ ...meal, planned_at: '2026-11-01T11:30:00.000Z' }] }, now)).toThrow();
    expect(() => parseMealPlanInput({ entries: [{ ...meal, planned_at: '2027-02-01T11:30:00.000Z' }] }, now)).toThrow();
    expect(() => parseMealPlanInput({ entries: [{ ...meal, kind: 'X' }] }, now)).toThrow();
    expect(() => parseMealPlanInput({ entries: [{ ...meal, items: [{ name: 'A', carbs_g: -1 }] }] }, now)).toThrow();
    expect(() => parseMealPlanInput({ entries: [] }, now)).toThrow();
    expect(() => parseMealPlanInput({ lead_minutes: 2, entries: [meal] }, now)).toThrow();
  });

  describe('czy posiłek został zjedzony', () => {
    const base = { kind: 'MEAL' as const, status: 'PLANNED' as const, planned_at: '2026-11-10T11:30:00.000Z', dose_answer: null, eaten_asked_at: null, eaten_asked_again_at: null, eaten_answer: null, eaten_answered_at: null };
    const at = (minutes: number) => new Date(Date.parse(base.planned_at) + minutes * 60_000);
    const yes = { doseGiven: true, notRising: true };

    it('asks only after a bolus, when glucose has not risen, 25 to 90 minutes after the meal', () => {
      expect(mealPlanEatenDecision(base, at(24), yes).action).toBe('WAIT');
      expect(mealPlanEatenDecision(base, at(25), yes).action).toBe('ASK');
      expect(mealPlanEatenDecision(base, at(25), { doseGiven: false, notRising: true }).action).toBe('WAIT');
      expect(mealPlanEatenDecision(base, at(25), { doseGiven: true, notRising: false }).action).toBe('WAIT');
      expect(mealPlanEatenDecision(base, at(25), { doseGiven: true, notRising: null }).action).toBe('WAIT');
      expect(mealPlanEatenDecision(base, at(91), yes).action).toBe('DONE');
    });

    it('asks once, and once more 15 minutes after "Nie wiem"', () => {
      expect(mealPlanEatenDecision({ ...base, eaten_asked_at: at(25).toISOString() }, at(40), yes).action).toBe('DONE');
      const unknown = { ...base, eaten_asked_at: at(25).toISOString(), eaten_answer: 'UNKNOWN' as const, eaten_answered_at: at(30).toISOString() };
      expect(mealPlanEatenDecision(unknown, at(40), yes).action).toBe('WAIT');
      expect(mealPlanEatenDecision(unknown, at(45), yes).action).toBe('ASK_AGAIN');
      expect(mealPlanEatenDecision({ ...unknown, eaten_asked_again_at: at(45).toISOString() }, at(60), yes).action).toBe('DONE');
      expect(mealPlanEatenDecision({ ...base, eaten_answer: 'YES' as const, eaten_answered_at: at(30).toISOString() }, at(60), yes).action).toBe('DONE');
    });

    it('never asks about a bolus said to be for something else, or a skipped meal', () => {
      expect(mealPlanEatenDecision({ ...base, dose_answer: 'OTHER' }, at(30), yes).action).toBe('DONE');
      expect(mealPlanEatenDecision({ ...base, status: 'SKIPPED' }, at(30), yes).action).toBe('DONE');
    });

    it('compares the newest fresh reading with the one at the meal', () => {
      const reading = (minutes: number, value: number) => ({ at: at(minutes).toISOString(), value });
      expect(glucoseNotRisingSince([reading(0, 120), reading(25, 125)], base.planned_at, at(26))).toBe(true);
      expect(glucoseNotRisingSince([reading(0, 120), reading(25, 140)], base.planned_at, at(26))).toBe(false);
      expect(glucoseNotRisingSince([reading(0, 120)], base.planned_at, at(26)), 'no later reading').toBeNull();
      expect(glucoseNotRisingSince([reading(0, 120), reading(5, 121)], base.planned_at, at(26)), 'old reading').toBeNull();
      expect(glucoseNotRisingSince([reading(25, 120)], base.planned_at, at(26)), 'nothing near the meal').toBeNull();
    });

    it('asks in words that fit any meal, with no dose', () => {
      const content = mealPlanEatenContent({ title: 'Zupa i podwieczorek' }, { value: 128, arrow: '→' }, false);
      expect(content.title).toBe('Zupa i podwieczorek: czy posiłek został zjedzony?');
      expect(content.body).toBe('Bolus podany, a glukoza nie rośnie: 128 i nie zmienia się. Jeśli posiłek nie został zjedzony, mogą być potrzebne węglowodany.');
    });

    it('names a known meal with its own gender, with no dose', () => {
      expect(mealPlanEatenContent({ title: 'Obiad' }, { value: 110, arrow: '↘' }, false)).toEqual({ title: 'Czy obiad został zjedzony?', body: 'Bolus podany, a glukoza nie rośnie: 110 i spada. Jeśli obiad nie został zjedzony, mogą być potrzebne węglowodany.' });
      expect(mealPlanEatenContent({ title: 'Kolacja' }, { value: 110, arrow: null }, false).title).toBe('Czy kolacja została zjedzona?');
      expect(mealPlanEatenContent({ title: 'II śniadanie' }, { value: 110, arrow: null }, false).title).toBe('Czy II śniadanie zostało zjedzone?');
      expect(mealPlanEatenContent({ title: 'Obiad' }, { value: 110, arrow: '↘' }, true).body).toBe('Bolus podany, a glukoza nie rośnie: 110 i spada. Sprawdź, jak wygląda sytuacja.');
    });
  });

  describe('przed WF', () => {
    const movement = { kind: 'MOVEMENT' as const, status: 'PLANNED' as const, planned_at: '2026-11-10T13:45:00.000Z', reminder_sent_at: null };
    const before = (minutes: number) => new Date(Date.parse(movement.planned_at) - minutes * 60_000);

    it('pushes only in the last half hour, and only when glucose is low or falling', () => {
      expect(mealPlanMovementDecision(movement, before(31), { value: 80, arrow: '→' }).action).toBe('WAIT');
      expect(mealPlanMovementDecision(movement, before(30), { value: 119, arrow: '→' }).action).toBe('ALERT');
      expect(mealPlanMovementDecision(movement, before(30), { value: 120, arrow: '→' }).action).toBe('WAIT');
      expect(mealPlanMovementDecision(movement, before(10), { value: 149, arrow: '↘' }).action).toBe('ALERT');
      expect(mealPlanMovementDecision(movement, before(10), { value: 150, arrow: '↓' }).action).toBe('WAIT');
      expect(mealPlanMovementDecision(movement, before(10), { value: 140, arrow: '↑' }).action).toBe('WAIT');
    });

    it('stays silent with no reading, after its push, after the start, and when skipped', () => {
      expect(mealPlanMovementDecision(movement, before(10), null).action).toBe('WAIT');
      expect(mealPlanMovementDecision({ ...movement, reminder_sent_at: before(20).toISOString() }, before(10), { value: 80, arrow: '→' }).action).toBe('DONE');
      expect(mealPlanMovementDecision(movement, before(0), { value: 80, arrow: '→' }).action).toBe('DONE');
      expect(mealPlanMovementDecision({ ...movement, status: 'SKIPPED' }, before(10), { value: 80, arrow: '→' }).action).toBe('DONE');
      expect(mealPlanMovementDecision({ ...movement, kind: 'MEAL' }, before(10), { value: 80, arrow: '→' }).action).toBe('DONE');
    });

    it('names no dose and no grams', () => {
      const content = mealPlanMovementContent({ title: 'WF' }, '14:45', { value: 92, arrow: '↘' });
      expect(content).toEqual({ title: 'WF o 14:45', body: 'Glukoza wynosi 92 i spada. Przed zajęciami mogą być potrzebne węglowodany.' });
    });
  });
});
