import { describe, expect, it } from 'vitest';
import {
  assignmentProblem,
  carbKindForPurpose,
  groupLoopEvent,
  summarizeMealInsulin,
} from './application/loop-action-policy';
import { mealLabel } from './application/loop-action-views';

const at = (hhmm: string) => `2026-10-18T${hhmm}:00.000Z`;

describe('loop action grouping', () => {
  it('joins the bolus of the same calculator use to its carbs', () => {
    const decision = groupLoopEvent(
      { event_id: 'b', event_type: 'BOLUS', occurred_at: '2026-10-18T15:40:42.000Z' },
      [{ id: 'a1', started_at: '2026-10-18T15:39:24.000Z', event_types: ['CARB_ENTRY'], assigned: false }],
    );
    expect(decision).toEqual({ action: 'JOIN', loop_action_id: 'a1' });
  });

  it('starts a new action for a second carb entry, an assigned action or one outside the window', () => {
    const carbs = { id: 'a1', started_at: at('12:00'), event_types: ['CARB_ENTRY' as const], assigned: false };
    expect(groupLoopEvent({ event_id: 'c', event_type: 'CARB_ENTRY', occurred_at: at('12:01') }, [carbs])).toEqual({ action: 'NEW' });
    expect(groupLoopEvent({ event_id: 'b', event_type: 'BOLUS', occurred_at: at('12:01') }, [{ ...carbs, assigned: true }])).toEqual({ action: 'NEW' });
    expect(groupLoopEvent({ event_id: 'b', event_type: 'BOLUS', occurred_at: at('12:04') }, [carbs])).toEqual({ action: 'NEW' });
  });

  it('picks the nearest open action', () => {
    const decision = groupLoopEvent({ event_id: 'b', event_type: 'BOLUS', occurred_at: at('12:02') }, [
      { id: 'far', started_at: at('12:00'), event_types: ['CARB_ENTRY'], assigned: false },
      { id: 'near', started_at: at('12:03'), event_types: ['CARB_ENTRY'], assigned: false },
    ]);
    expect(decision).toEqual({ action: 'JOIN', loop_action_id: 'near' });
  });
});

describe('loop action assignment rules', () => {
  it('rejects answers that do not fit the logged events', () => {
    expect(assignmentProblem('MEAL_ADDITION', null, true, true)).toMatch(/meal_id/);
    expect(assignmentProblem('NEW_MEAL', 'm1', true, true)).toMatch(/no meal_id/);
    expect(assignmentProblem('NEW_MEAL', null, false, true)).toMatch(/PRE_BOLUS/);
    expect(assignmentProblem('PRE_BOLUS', null, true, false)).toMatch(/bolus/);
    expect(assignmentProblem('CORRECTION', null, false, true)).toBeNull();
    expect(assignmentProblem('CORRECTION', 'm1', true, true)).toBeNull();
  });

  it('maps purposes to carb entry kinds', () => {
    expect(carbKindForPurpose('MEAL_ADDITION')).toBe('MEAL');
    expect(carbKindForPurpose('CORRECTION')).toBe('CORRECTION_CARBS');
    expect(carbKindForPurpose('WBT')).toBe('FAT_PROTEIN_UNITS');
  });
});

describe('meal insulin', () => {
  it('splits meal, correction and WBT insulin and counts SMBs until the next meal', () => {
    const summary = summarizeMealInsulin({
      meal_started_at: at('12:30'),
      next_meal_started_at: at('15:30'),
      actions: [
        { id: 'a1', purpose: 'NEW_MEAL', started_at: at('12:30'), carbs_g: 50, bolus_units: 4.5 },
        { id: 'a2', purpose: 'MEAL_ADDITION', started_at: at('13:25'), carbs_g: 10, bolus_units: 1 },
        { id: 'a3', purpose: 'CORRECTION', started_at: at('14:30'), carbs_g: 15, bolus_units: 1.5 },
        { id: 'a4', purpose: 'WBT', started_at: at('15:05'), carbs_g: null, bolus_units: 1.2 },
      ],
      smbs: [
        { at: at('12:50'), units: 0.3 },
        { at: at('13:10'), units: 0.2 },
        { at: at('15:45'), units: 0.4 },
        { at: at('12:00'), units: 0.5 },
      ],
    });
    expect(summary).toMatchObject({ meal_units: 5.5, correction_units: 1.5, wbt_units: 1.2, smb_units: 0.5, smb_count: 2, loop_carbs_g: 60 });
    expect(summary.doses.map((dose) => dose.kind)).toEqual(['MEAL', 'ADDITION', 'CORRECTION', 'WBT']);
  });
});

describe('meal labels', () => {
  it('labels meals by description or time', () => {
    expect(mealLabel(null, at('10:30'), 'Europe/Warsaw')).toBe('Posiłek o 12:30');
    expect(mealLabel('Pizza margherita, 3 kawałki', at('10:30'), 'Europe/Warsaw')).toBe('Pizza margherita, 3 kawałki');
    expect(mealLabel('Chleb pszenny (20 g), Jaja kurze całe (100 g), Szynka gotowana (20 g)', at('10:30'), 'Europe/Warsaw'))
      .toBe('Chleb pszenny (20 g), Jaja kurze całe…');
  });
});
