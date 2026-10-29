import { describe, expect, it } from 'vitest';
import { allowsChatRescueCards, messageAllowsBolusCards } from './worker.service';

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
