import { describe, expect, it, vi } from 'vitest';
import { mealWbtForAi, WbtDoseProposalSession } from './wbt-dose-proposal-tool';
import type { WbtSuggestionContext } from './wbt-suggestion.job';

function context(overrides: Partial<WbtSuggestionContext> = {}): WbtSuggestionContext {
  return {
    meal: { meal_record_id: 'meal-1', description: 'Pizza', started_at: '2026-10-25T10:00:00.000Z', local_time: '2026-10-25 12:00', carbs_g: 60, protein_g: 25, fat_g: 20, fat_protein_units: 2.8, meal_bolus_units: 4 },
    icr_g_per_u: 10,
    current: { as_of: '2026-10-25T12:30:00.000Z', glucose_mgdl: 160, trend: 'Flat', iob_u: 0.8, cob_g: 5, minutes_after_meal: 150 },
    already_given: { wbt_carbs_logged_g: 0, late_bolus_units: 0, wbt_insulin_units: null },
    ...overrides,
  };
}

function session(ctx: WbtSuggestionContext = context()) {
  const store = {
    insertChatSuggestion: vi.fn(async () => ({ id: 's-1' })),
    discardChatSuggestionsForUserMessage: vi.fn(async () => undefined),
  };
  const tool = new WbtDoseProposalSession({
    patientId: 'p', mealRecordId: 'meal-1', conversationId: 'c', userMessageId: 'u', store, context: ctx,
    current: { dose_units: 0.85, rationale: 'Standard', basis: 'STANDARD', history_cases: [], history_cases_used: 0 },
    nowIso: '2026-10-25T12:31:00.000Z',
  });
  return { tool, store };
}

describe('propose_wbt_dose', () => {
  it('stores the caregiver\'s dose as the meal\'s newest WBT suggestion, with its carbs for the loop', async () => {
    const { tool, store } = session();
    const result = await tool.propose({ insulin_u: 0.52, reason: 'Opiekun chce mniej.' });

    expect(result).toMatchObject({ status: 'PROPOSED', card: { insulin_u: 0.5, carbs_equivalent_g: 5 }, warnings: [] });
    expect(store.insertChatSuggestion).toHaveBeenCalledWith(expect.objectContaining({
      patientId: 'p', mealRecordId: 'meal-1', conversationId: 'c', userMessageId: 'u',
      result: expect.objectContaining({ basis: 'CHAT', dose_units: 0.5, carbs_equivalent_g: 5, rationale: 'Opiekun chce mniej.' }),
    }));
  });

  it('warns but never blocks: low glucose, WBT already given, far above the usual dose', async () => {
    const { tool } = session(context({
      current: { as_of: null, glucose_mgdl: 82, trend: null, iob_u: null, cob_g: null, minutes_after_meal: 150 },
      already_given: { wbt_carbs_logged_g: 8, late_bolus_units: 0, wbt_insulin_units: 0.8 },
    }));
    const result = await tool.propose({ insulin_u: 3, reason: 'x' });

    expect(result.status).toBe('PROPOSED');
    expect(result.warnings).toEqual([
      expect.stringContaining('Glikemia 82 mg/dL'),
      expect.stringContaining('Brak aktualnej glikemii'),
      expect.stringContaining('podano już 0.8 j'),
      expect.stringContaining('ponad dwa razy'),
    ]);
  });

  it('spells out the standard dose when the dose is dangerously above it, and says nothing for a small difference (dose-calculator.v1)', async () => {
    // 2,8 WBT × 10 / ICR 10 × 30% = 0,8 j (rounded down); 1,3 j is 0,5 j above it.
    expect((await session().tool.propose({ insulin_u: 1.3, reason: 'x' })).warnings).toEqual(['⚠️ 1,3 j to o 0,5 j więcej niż standard: 2,8 WBT × 10 / ICR 10 × 30% = 0,8 j.']);
    expect((await session().tool.propose({ insulin_u: 1.25, reason: 'x' })).warnings).toEqual([]);
  });

  it('warns about a reading older than 15 min', async () => {
    const { tool } = session(context({ current: { as_of: '2026-10-25T12:00:00.000Z', glucose_mgdl: 160, trend: 'Flat', iob_u: 0, cob_g: 0, minutes_after_meal: 150 } }));
    expect((await tool.propose({ insulin_u: 0.5, reason: 'x' })).warnings).toEqual([expect.stringContaining('sprzed 31 min')]);
  });

  it('refuses an impossible dose and replaces the answer\'s earlier card', async () => {
    const { tool, store } = session();
    expect((await tool.propose({ insulin_u: -1, reason: 'x' })).status).toBe('INVALID_REQUEST');
    expect((await tool.propose({ insulin_u: 40, reason: 'x' })).status).toBe('INVALID_REQUEST');

    await tool.propose({ insulin_u: 0.5, reason: 'x' });
    await tool.propose({ insulin_u: 0.7, reason: 'y' });
    expect(store.discardChatSuggestionsForUserMessage).toHaveBeenCalledTimes(1);
    expect(store.insertChatSuggestion).toHaveBeenCalledTimes(2);
  });

  it('shows the model the standard dose and the proposal it starts from', () => {
    const view = mealWbtForAi(context(), { dose_units: 0.85, rationale: 'Standard' });
    expect(view).toMatchObject({ standard_dose: { dose_units: 0.8, factor: 0.3 }, current_proposal: { dose_units: 0.85 } });
    // No earlier meals: nothing about history reaches the model.
    expect(view).not.toHaveProperty('history');
    expect(JSON.stringify(view)).not.toMatch(/basis|history/);
  });
});

describe('propose_wbt_dose on a phone without remote control', () => {
  it('says the dose is given in Trio itself, and the session counts as a card', async () => {
    const { WbtDoseProposalSession: Session } = await import('./wbt-dose-proposal-tool');
    const { tool } = session();
    const deps = (tool as any).deps;
    const phoneOnly = new Session({ ...deps, canSendToTrio: false });
    expect(phoneOnly.used).toBe(false);
    const result = await phoneOnly.propose({ insulin_u: 0.5, reason: 'x' });
    expect(result).toMatchObject({ status: 'PROPOSED', note_phone: expect.stringContaining('gives it in Trio themself') });
    expect(phoneOnly.used).toBe(true);
    expect(await tool.propose({ insulin_u: 0.5, reason: 'x' })).not.toHaveProperty('note_phone');
  });
});
