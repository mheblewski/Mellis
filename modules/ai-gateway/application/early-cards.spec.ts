import { describe, expect, it, vi } from 'vitest';
import { EarlyCards, type EarlyCardsDeps } from './early-cards';

function setup(overrides: Partial<EarlyCardsDeps> = {}) {
  const log: string[] = [];
  const deps: EarlyCardsDeps = {
    propose: vi.fn(async (tool, args) => {
      log.push(`card:${tool}:${String(args.option ?? '')}`);
      return { status: 'PROPOSED', tool };
    }),
    onAnswerReady: vi.fn(async () => {
      log.push('answer');
    }),
    allowedKeys: { propose_bolus: ['option', 'carbs_g'], propose_rescue_carbs: ['option', 'carbs_g'] },
    bolusCallsLeft: 3,
    rescueCallsLeft: 2,
    rescueOptionsCarded: new Set(),
    totalCallsLeft: 10,
    isAborted: () => false,
    ...overrides,
  };
  return { cards: new EarlyCards(deps), deps, log };
}

const bolus = (id: string, option = 'A') => ({ call_id: id, name: 'propose_bolus', arguments: { option } });

describe('EarlyCards (cards-after-text.v1)', () => {
  it('prepares a card only after the answer is finished, and the mark comes first', async () => {
    const { cards, deps, log } = setup();
    cards.onToolReady(bolus('c1'));
    await Promise.resolve();
    expect(deps.propose).not.toHaveBeenCalled();
    cards.onAnswerReady({ assistant_message: 'x' });
    cards.onToolReady(bolus('c2', 'B'));
    await expect(cards.take('c1')).resolves.toMatchObject({ status: 'PROPOSED' });
    await cards.take('c2');
    expect(log).toEqual(['answer', 'card:propose_bolus:A', 'card:propose_bolus:B']);
  });

  it('leaves everything to the loop when the answer never finished in the turn', async () => {
    const { cards, deps } = setup();
    cards.onToolReady(bolus('c1'));
    cards.close();
    cards.onAnswerReady({});
    await cards.settled();
    expect(cards.take('c1')).toBeUndefined();
    expect(deps.propose).not.toHaveBeenCalled();
    expect(deps.onAnswerReady).not.toHaveBeenCalled();
  });

  it('stops at another tool: its result may matter to the calls after it', async () => {
    const { cards, deps } = setup();
    cards.onAnswerReady({});
    cards.onToolReady(bolus('c1'));
    cards.onToolReady({ call_id: 'w', name: 'estimate_wbt', arguments: {} });
    cards.onToolReady(bolus('c2', 'B'));
    await cards.settled();
    expect(cards.take('c1')).toBeDefined();
    expect(cards.take('w')).toBeUndefined();
    expect(cards.take('c2')).toBeUndefined();
    expect(deps.propose).toHaveBeenCalledTimes(1);
  });

  it('never prepares a card the loop would refuse: limits and arguments', async () => {
    const limited = setup({ bolusCallsLeft: 1 });
    limited.cards.onAnswerReady({});
    limited.cards.onToolReady(bolus('c1'));
    limited.cards.onToolReady(bolus('c2', 'B'));
    await limited.cards.settled();
    expect(limited.deps.propose).toHaveBeenCalledTimes(1);

    const budget = setup({ totalCallsLeft: 0 });
    budget.cards.onAnswerReady({});
    budget.cards.onToolReady(bolus('c1'));
    await budget.cards.settled();
    expect(budget.deps.propose).not.toHaveBeenCalled();

    const forbidden = setup();
    forbidden.cards.onAnswerReady({});
    forbidden.cards.onToolReady({ call_id: 'c1', name: 'propose_bolus', arguments: { patient_id: 'x' } });
    await forbidden.cards.settled();
    expect(forbidden.deps.propose).not.toHaveBeenCalled();
  });

  it('a corrected rescue card for its option does not use up the limit, as in the loop', async () => {
    const { cards, deps } = setup({ rescueCallsLeft: 0, rescueOptionsCarded: new Set(['A']) });
    cards.onAnswerReady({});
    cards.onToolReady({ call_id: 'r1', name: 'propose_rescue_carbs', arguments: { option: 'A' } });
    cards.onToolReady({ call_id: 'r2', name: 'propose_rescue_carbs', arguments: { option: 'B' } });
    await cards.settled();
    expect(deps.propose).toHaveBeenCalledTimes(1);
  });

  it('a failed card reaches the loop and the next one still runs', async () => {
    const propose = vi.fn().mockRejectedValueOnce(new Error('db')).mockResolvedValue({ status: 'PROPOSED' });
    const { cards } = setup({ propose });
    cards.onAnswerReady({});
    cards.onToolReady(bolus('c1'));
    cards.onToolReady(bolus('c2', 'B'));
    await expect(cards.take('c1')).rejects.toThrow('db');
    await expect(cards.take('c2')).resolves.toEqual({ status: 'PROPOSED' });
  });

  it('prepares nothing after a cancellation', async () => {
    const { cards, deps } = setup({ isAborted: () => true });
    cards.onAnswerReady({});
    cards.onToolReady(bolus('c1'));
    await expect(cards.take('c1')).rejects.toThrow('EARLY_CARD_ABORTED');
    expect(deps.propose).not.toHaveBeenCalled();
  });
});
