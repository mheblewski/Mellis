import { describe, expect, it } from 'vitest';
import { allowsChatRescueCards, allowsMealPlanCards, messageAllowsBolusCards } from './worker.service';

describe('bolus cards only for a phone that can give the dose', () => {
  it('needs the message to say its phone has remote control set up', () => {
    expect(messageAllowsBolusCards({ metadata: { message_type: 'USER_MESSAGE', bolus_cards: true } })).toBe(true);
    // Older apps and phones without Trio set up say nothing.
    expect(messageAllowsBolusCards({ metadata: { message_type: 'USER_MESSAGE' } })).toBe(false);
    expect(messageAllowsBolusCards({ metadata: { bolus_cards: 'true' } })).toBe(false);
    expect(messageAllowsBolusCards({})).toBe(false);
    expect(messageAllowsBolusCards(undefined)).toBe(false);
  });
});

describe('rescue carb cards outside an alert only for a phone that can confirm them', () => {
  const conversation = (metadata: Record<string, unknown> | undefined, triggerType: string | null = null) => ({
    trigger_type: triggerType,
    messages: [{ id: 'm1', role: 'USER', metadata }],
  });

  it('needs rescue_cards on the message and is never offered in a hypo conversation', () => {
    expect(allowsChatRescueCards(conversation({ message_type: 'USER_MESSAGE', rescue_cards: true }), 'm1')).toBe(true);
    // Older apps say nothing; another message's flag does not count.
    expect(allowsChatRescueCards(conversation({ message_type: 'USER_MESSAGE' }), 'm1')).toBe(false);
    expect(allowsChatRescueCards(conversation({ rescue_cards: true }), 'm2')).toBe(false);
    expect(allowsChatRescueCards(conversation(undefined), 'm1')).toBe(false);
    // The hypo report form records the treatment there.
    expect(allowsChatRescueCards(conversation({ rescue_cards: true }, 'HYPO_DETECTED'), 'm1')).toBe(false);
  });
});

describe('the meal plan tool only where it can be used', () => {
  const ask = (content: string, metadata: Record<string, unknown> = { meal_plan_cards: true }) => ({ id: 'm', role: 'USER', content, metadata });

  it('needs a phone that shows the card, and a plan or a photo in the question or the one before', () => {
    expect(allowsMealPlanCards({ messages: [ask('Dodaj jadłospis')] }, 'm')).toBe(true);
    expect(allowsMealPlanCards({ messages: [ask('co u niej?')] }, 'm')).toBe(false);
    expect(allowsMealPlanCards({ messages: [ask('Dodaj jadłospis', {})] }, 'm')).toBe(false);
    expect(allowsMealPlanCards({ messages: [ask('', { meal_plan_cards: true, photo_ids: ['11111111-1111-4111-8111-111111111111'] })] }, 'm')).toBe(true);
    const earlier = { id: 'e', role: 'USER', content: 'Dodaj jadłospis', metadata: {} };
    expect(allowsMealPlanCards({ messages: [earlier, { id: 'a', role: 'ASSISTANT', content: 'WF?' }, ask('we wtorki 14:45')] }, 'm')).toBe(true);
    const older = { id: 'o', role: 'USER', content: 'ile było hipo?', metadata: {} };
    expect(allowsMealPlanCards({ messages: [earlier, older, ask('dzięki')] }, 'm')).toBe(false);
  });

  it('never in a hypo, rescue or WBT conversation', () => {
    for (const special of [{ trigger_type: 'HYPO_DETECTED' }, { trigger_type: 'RESCUE_CARBS' }, { wbt_meal_record_id: 'w' }]) {
      expect(allowsMealPlanCards({ ...special, messages: [ask('Dodaj jadłospis')] }, 'm')).toBe(false);
    }
  });
});
