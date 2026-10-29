import { describe, expect, it, vi } from 'vitest';
import { fatProteinUnitsOf, scheduleValueAt, shouldRemindAboutWbt, standardWbtDose, wbtReminderAt, wbtReminderBody } from './application/wbt-policy';
import { computeWbtCase, isUsableWbtCase, wbtIcrLookup, type WbtCase, type WbtHistoryEvent } from './application/wbt-history';
import { buildSuggestion, FakeWbtSuggestionResponder, OpenAiWbtSuggestionResponder, type WbtSuggestionContext } from './application/wbt-suggestion.job';

describe('WBT policy', () => {
  it('switches the reminder on at 1.5 WBT, 18 g fat or 20 g protein', () => {
    expect(shouldRemindAboutWbt({ protein_g: 22.4, fat_g: 26.7 })).toBe(true); // nuggets, 3.3 WBT
    expect(shouldRemindAboutWbt({ protein_g: 3, fat_g: 6 })).toBe(false); // small cinnamon roll, 0.7 WBT
    expect(shouldRemindAboutWbt({ protein_g: 20, fat_g: 0 })).toBe(true);
    expect(shouldRemindAboutWbt({ protein_g: 0, fat_g: 18 })).toBe(true);
    expect(shouldRemindAboutWbt({ protein_g: 10, fat_g: 12 })).toBe(true); // 1.48 -> 1.5 WBT
    expect(shouldRemindAboutWbt({ protein_g: null, fat_g: null })).toBe(false);
    expect(fatProteinUnitsOf(22.4, 26.7)).toBe(3.3);
  });

  it('reminds 2.5 h after the meal and proposes 30% of the insulin for 10 g carbs per WBT', () => {
    expect(wbtReminderAt('2026-10-15T17:05:00.000Z')).toBe('2026-10-15T19:35:00.000Z');
    expect(standardWbtDose(3.3, 7.1)).toEqual({ dose_units: 1.35, carbs_equivalent_g: 10 });
  });

  it('names the meal without gram amounts on one line and asks to open the dose screen', () => {
    const at = '2026-10-17T05:54:00.000Z'; // 07:54 in Warsaw
    expect(wbtReminderBody('Chleb pszenny (20 g), Jaja kurze całe (100 g), Szynka gotowana (20 g)', at, 'Europe/Warsaw'))
      .toBe('Chleb pszenny, Jaja kurze całe, Szynka…\nKliknij, aby ustalić dawkę insuliny');
    expect(wbtReminderBody('Nuggetsy (150g) i frytki (1,5 kg), sok (200 ml)', at, 'Europe/Warsaw'))
      .toBe('Nuggetsy i frytki, sok\nKliknij, aby ustalić dawkę insuliny');
    expect(wbtReminderBody('Jajecznica (3 jajka)', at, 'Europe/Warsaw')).toBe('Jajecznica (3 jajka)\nKliknij, aby ustalić dawkę insuliny');
    expect(wbtReminderBody(null, at, 'Europe/Warsaw')).toBe('Posiłek o 07:54\nKliknij, aby ustalić dawkę insuliny');
    expect(wbtReminderBody(' (20 g) ', at, 'Europe/Warsaw')).toBe('Posiłek o 07:54\nKliknij, aby ustalić dawkę insuliny');
  });

  it('reads a therapy schedule value at the local time of the meal', () => {
    const icr = [['00:00', 10], ['06:00', 7.7], ['18:00', 7.1]] as Array<[string, number]>;
    expect(scheduleValueAt(icr, '2026-10-15T17:05:00.000Z', 'Europe/Warsaw')).toBe(7.1); // 19:05
    expect(scheduleValueAt(icr, '2026-10-15T08:00:00.000Z', 'Europe/Warsaw')).toBe(7.7); // 10:00
    expect(scheduleValueAt(icr, '2026-10-15T02:00:00.000Z', 'Europe/Warsaw')).toBe(10); // 04:00
  });
});

describe('WBT history case', () => {
  const start = Date.parse('2026-10-15T17:00:00.000Z');
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const glucose = (minutes: number, value: number): WbtHistoryEvent => ({ type: 'GLUCOSE_READING_AVAILABLE', occurred_at: at(minutes), payload: { glucose_value: value } });

  it('counts WBT carbs logged in the loop and late boluses as WBT insulin, with the late glucose response', () => {
    const events: WbtHistoryEvent[] = [
      { type: 'BOLUS', occurred_at: at(0), payload: { insulin_units: 6 } }, // the meal bolus: not WBT
      { type: 'CARB_ENTRY', occurred_at: at(150), payload: { carbs: 14, carb_kind: 'FAT_PROTEIN_UNITS' } },
      { type: 'BOLUS', occurred_at: at(200), payload: { insulin_units: 0.5 } },
      { type: 'BOLUS', occurred_at: at(151), payload: { insulin_units: 2 } }, // the loop's bolus for the WBT carbs: not twice
      ...Array.from({ length: 43 }, (_, index) => glucose(145 + index * 5, index < 20 ? 150 + index * 4 : 230 - (index - 20) * 5)),
    ];
    const result = computeWbtCase({
      case_id: 'm1', started_at: at(0), local_time: '2026-10-15 19:00', description: 'Frytki, nuggetsy', carbs_g: 47, protein_g: 22, fat_g: 27,
      fat_protein_units: 3.3, icr_at: () => 7, events,
    });

    expect(result).toMatchObject({
      wbt_carbs_logged_g: 14,
      late_bolus_units: 0.5,
      wbt_insulin_units: 2.5,
      wbt_given_minutes_after: 150,
      glucose_at_reminder_mgdl: 154,
      late_peak_mgdl: 230,
      late_peak_minutes_after: 245,
      data_status: 'COMPLETE',
      hypo_after_reminder: false,
    });
    expect(isUsableWbtCase(result)).toBe(true);
  });

  it("does not count another meal's bolus, a correction or another meal's WBT as this meal's WBT", () => {
    // 2026-10-19: fries at 17:06; two snacks (20:01, 20:03) and more fries (21:12) had their own meal boluses.
    const meal = (identity: string) => ({ purpose: 'NEW_MEAL', meal_identity: identity, has_carbs: true });
    const events: WbtHistoryEvent[] = [
      { type: 'BOLUS', occurred_at: at(175), payload: { insulin: 1.8, loop_action: meal('snack-1') } },
      { type: 'BOLUS', occurred_at: at(177), payload: { insulin: 1.2, loop_action: meal('snack-2') } },
      // Trio uploaded that bolus twice; the copy formed its own unassigned action.
      { type: 'BOLUS', occurred_at: at(177), payload: { insulin: 1.2, loop_action: { purpose: null, meal_identity: null, has_carbs: false } } },
      { type: 'BOLUS', occurred_at: at(246), payload: { insulin: 3.8, loop_action: meal('fries-2') } },
      { type: 'BOLUS', occurred_at: at(120), payload: { insulin: 0.7, loop_action: { purpose: 'CORRECTION', meal_identity: null, has_carbs: false } } },
      // Unassigned, with carbs (a meal nobody answered for yet): not WBT either.
      { type: 'BOLUS', occurred_at: at(130), payload: { insulin: 2, loop_action: { purpose: null, meal_identity: null, has_carbs: true } } },
      { type: 'CARB_ENTRY', occurred_at: at(160), payload: { carbs: 9, carb_kind: 'FAT_PROTEIN_UNITS', loop_action: { purpose: 'WBT', meal_identity: 'other-meal', has_carbs: true } } },
    ];
    const none = computeWbtCase({ case_id: 'fries-1', started_at: at(0), local_time: null, description: 'Małe frytki', carbs_g: 30, protein_g: 3, fat_g: 12, fat_protein_units: 1.2, icr_at: () => 7.7, events });
    expect(none).toMatchObject({ late_bolus_units: 0, wbt_carbs_logged_g: 0, wbt_insulin_units: null });

    // This meal's WBT (from the WBT window) and a lone unassigned bolus still count.
    const own = computeWbtCase({ case_id: 'fries-1', started_at: at(0), local_time: null, description: 'Małe frytki', carbs_g: 30, protein_g: 3, fat_g: 12, fat_protein_units: 1.2, icr_at: () => 7.7, events: [
      ...events,
      { type: 'CARB_ENTRY', occurred_at: at(150), payload: { carbs: 7.7, carb_kind: 'FAT_PROTEIN_UNITS', loop_action: { purpose: 'WBT', meal_identity: 'fries-1', has_carbs: true } } },
      { type: 'BOLUS', occurred_at: at(200), payload: { insulin: 0.3, loop_action: { purpose: null, meal_identity: null, has_carbs: false } } },
      { type: 'BOLUS', occurred_at: at(210), payload: { insulin: 0.2 } },
      // The same bolus uploaded twice by Trio.
      { type: 'BOLUS', occurred_at: at(210), payload: { insulin: 0.2 } },
    ] });
    expect(own).toMatchObject({ wbt_carbs_logged_g: 7.7, late_bolus_units: 0.5, wbt_insulin_units: 1.5 });
  });

  it('is not usable evidence without a WBT dose or without glucose', () => {
    const noDose = computeWbtCase({ case_id: 'm2', started_at: at(0), local_time: null, description: null, carbs_g: 40, protein_g: 20, fat_g: 20, fat_protein_units: 2.6, icr_at: () => 7, events: [glucose(200, 180)] });
    expect(isUsableWbtCase(noDose)).toBe(false);
  });

  it('converts each WBT carb entry with the ICR active when it was logged, not the ICR of the meal', async () => {
    const icrSchedule = [['00:00', 10], ['06:00', 5], ['09:00', 8]] as Array<[string, number]>;
    const breakfast = Date.parse('2026-10-18T05:40:00.000Z'); // 07:40 in Warsaw: ICR 5
    const after = (minutes: number) => new Date(breakfast + minutes * 60_000).toISOString();
    const events: WbtHistoryEvent[] = [
      { type: 'CARB_ENTRY', occurred_at: after(60), payload: { carbs: 5, carb_kind: 'FAT_PROTEIN_UNITS' } }, // 08:40: ICR 5
      { type: 'CARB_ENTRY', occurred_at: after(160), payload: { carbs: 8, carb_kind: 'FAT_PROTEIN_UNITS' } }, // 10:20: ICR 8
      { type: 'CARB_ENTRY', occurred_at: after(170), payload: { carbs: 20 } }, // ordinary carbs: not WBT
      { type: 'GLUCOSE_READING_AVAILABLE', occurred_at: after(200), payload: { glucose_value: 160 } },
    ];
    const icrAt = vi.fn(async (iso: string) => scheduleValueAt(icrSchedule, iso, 'Europe/Warsaw'));

    const result = computeWbtCase({
      case_id: 'b', started_at: after(0), local_time: null, description: 'Parówki, jajecznica', carbs_g: 6, protein_g: 14, fat_g: 22,
      fat_protein_units: 2.5, icr_at: await wbtIcrLookup(after(0), events, icrAt), events,
    });

    expect(icrAt.mock.calls.map(([iso]) => iso)).toEqual([after(0), after(60), after(160)]);
    expect(result).toMatchObject({ icr_g_per_u: 5, wbt_carbs_logged_g: 13, wbt_insulin_units: 2, wbt_given_minutes_after: 60 });
  });
});

describe('WBT dose suggestion', () => {
  const context = (overrides: Partial<WbtSuggestionContext> = {}): WbtSuggestionContext => ({
    meal: { meal_record_id: 'm', description: 'Frytki, nuggetsy', started_at: '2026-10-15T17:00:00.000Z', local_time: '2026-10-15 19:00', carbs_g: 47, protein_g: 22.4, fat_g: 26.7, fat_protein_units: 3.3, meal_bolus_units: 6.5 },
    icr_g_per_u: 7.1,
    current: { as_of: '2026-10-15T19:27:00.000Z', glucose_mgdl: 160, trend: 'FLAT', iob_u: 0.5, cob_g: 0, minutes_after_meal: 150 },
    already_given: { wbt_carbs_logged_g: 0, late_bolus_units: 0, wbt_insulin_units: null },
    ...overrides,
  });
  it('uses the standard 30% dose', async () => {
    const result = await buildSuggestion(new FakeWbtSuggestionResponder(), context(), '2026-10-15T19:30:00.000Z');
    expect(result).toMatchObject({ basis: 'STANDARD', dose_units: 1.35, carbs_equivalent_g: 10, history_cases_used: 0, history_cases: [] });
  });

  it('asks the model from the standard dose only: no earlier meals and no word about them', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const client = { responses: { create: vi.fn(async (body: Record<string, unknown>) => {
      requests.push(body);
      return { id: 'r', output_text: JSON.stringify({ dose_units: 1.4, rationale: 'Standard.' }), output: [] };
    }) } };
    const result = await buildSuggestion(new OpenAiWbtSuggestionResponder(client as never, 'm'), context(), '2026-10-15T19:30:00.000Z');
    expect(result).toMatchObject({ basis: 'STANDARD', history_cases_used: 0, history_cases: [] });
    expect(String(requests[0].instructions)).not.toMatch(/wcześniejsze posiłki|HISTORY|histori/i);
    expect(JSON.stringify(requests[0].input)).not.toMatch(/history|min_history_cases|basis/);
  });

  it('states the patient\'s age in the prompt instead of assuming a child', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const client = { responses: { create: vi.fn(async (body: Record<string, unknown>) => {
      requests.push(body);
      return { id: 'r', output_text: JSON.stringify({ dose_units: 1.4, rationale: 'Standard.', case_ids_used: [] }), output: [] };
    }) } };
    await buildSuggestion(new OpenAiWbtSuggestionResponder(client as never, 'm'), context({ patient_birth_year: 1990 }), '2026-10-15T19:30:00.000Z');
    const age = new Date().getUTCFullYear() - 1990;
    expect(String(requests[0].instructions)).toContain(`Wiek pacjenta: ok. ${age}`);
    expect(String(requests[0].instructions)).toContain('osoba dorosła');
    expect(String(requests[0].instructions)).not.toContain('dziecka');

    await buildSuggestion(new OpenAiWbtSuggestionResponder(client as never, 'm'), context(), '2026-10-15T19:30:00.000Z');
    expect(String(requests[1].instructions)).toContain('Wiek pacjenta: nieznany');
  });

  it('proposes no insulin when glucose is low', async () => {
    const result = await buildSuggestion(new FakeWbtSuggestionResponder(), context({ current: { as_of: '2026-10-15T19:27:00.000Z', glucose_mgdl: 82, trend: 'DOWN', iob_u: 1, cob_g: 0, minutes_after_meal: 150 } }), '2026-10-15T19:30:00.000Z');
    expect(result.dose_units).toBe(0);
    expect(String(result.rationale)).toContain('82 mg/dL');
    expect(result.server_adjustment).toEqual({ reason: 'LOW_GLUCOSE', model_dose_units: 1.35 });
  });

  it('keeps how the bounds changed the model\'s dose, and nothing when they did not', async () => {
    const answering = (dose: number) => ({ providerName: 'test', suggest: async () => ({ dose_units: dose, rationale: 'x' }) });
    const capped = await buildSuggestion(answering(9), context(), '2026-10-15T19:30:00.000Z');
    expect(capped).toMatchObject({ dose_units: 2.7, server_adjustment: { reason: 'ABOVE_MAX', model_dose_units: 9 } });
    expect((await buildSuggestion(answering(1), context(), '2026-10-15T19:30:00.000Z')).server_adjustment).toBeNull();
    // The shown dose and the text agree: the server's sentence comes first.
    expect(String(capped.rationale)).toMatch(/^Dawkę ograniczono do 2,7 j \(maks\. 2× dawka standardowa\)\. x$/);
  });

  it('proposes no insulin on a reading older than 15 min or without one, and tells the model its age', async () => {
    const stale = await buildSuggestion(new FakeWbtSuggestionResponder(), context({ current: { as_of: '2026-10-15T18:50:00.000Z', glucose_mgdl: 140, trend: 'FLAT', iob_u: 0, cob_g: 0, minutes_after_meal: 150 } }), '2026-10-15T19:30:00.000Z');
    expect(stale).toMatchObject({ dose_units: 0, server_adjustment: { reason: 'STALE_GLUCOSE' }, current: { glucose_age_minutes: 40 } });
    expect(String(stale.rationale)).toMatch(/^Ostatni odczyt glikemii jest sprzed 40 min/);
    const none = await buildSuggestion(new FakeWbtSuggestionResponder(), context({ current: { as_of: null, glucose_mgdl: null, trend: null, iob_u: null, cob_g: null, minutes_after_meal: 150 } }), '2026-10-15T19:30:00.000Z');
    expect(none).toMatchObject({ dose_units: 0, server_adjustment: { reason: 'STALE_GLUCOSE' } });
  });

  it('takes the WBT insulin already given off the ceiling', async () => {
    const answering = { providerName: 'test', suggest: async () => ({ dose_units: 2.7, rationale: 'x' }) };
    const result = await buildSuggestion(answering, context({ already_given: { wbt_carbs_logged_g: 14, late_bolus_units: 0, wbt_insulin_units: 2 } }), '2026-10-15T19:30:00.000Z');
    // 2 × 1.35 - 2 = 0.7.
    expect(result).toMatchObject({ dose_units: 0.7, server_adjustment: { reason: 'ABOVE_MAX', model_dose_units: 2.7 } });
    expect(String(result.rationale)).toContain('minus 2 j już podane na WBT');
  });

  it('bounds the call in time and records the provider that answered', async () => {
    const create = vi.fn(async () => ({ id: 'r', output_text: JSON.stringify({ dose_units: 1.4, rationale: 'Standard.' }), output: [] }));
    const responder = new OpenAiWbtSuggestionResponder({ responses: { create } } as never, 'm', 'anthropic');
    const result = await buildSuggestion(responder, context(), '2026-10-15T19:30:00.000Z');
    expect((create.mock.calls[0] as unknown[])[1]).toEqual({ timeout: 60_000 });
    expect(result.provider).toBe('anthropic');
  });
});

describe('isMealWbtDose', () => {
  const at = '2026-10-20T19:30:00.000Z';
  it('counts only a WBT answered for this meal, also a bolus alone; an older WBT carb entry by its kind', async () => {
    const { isMealWbtDose } = await import('./application/wbt-history');
    const wbtFor = (meal: string | null, type = 'CARB_ENTRY') => ({ type, occurred_at: at, payload: { loop_action: { purpose: 'WBT', meal_identity: meal, has_carbs: type === 'CARB_ENTRY' } } });
    expect(isMealWbtDose(wbtFor('dinner'), 'dinner')).toBe(true);
    expect(isMealWbtDose(wbtFor('dinner', 'BOLUS'), 'dinner')).toBe(true);
    // The dinner's WBT does not silence the dessert's reminder.
    expect(isMealWbtDose(wbtFor('dinner'), 'dessert')).toBe(false);
    expect(isMealWbtDose({ type: 'CARB_ENTRY', occurred_at: at, payload: { carb_kind: 'FAT_PROTEIN_UNITS', loop_action: { purpose: 'MEAL_ADDITION', meal_identity: 'dessert', has_carbs: true } } }, 'dessert')).toBe(false);
    expect(isMealWbtDose({ type: 'CARB_ENTRY', occurred_at: at, payload: { carb_kind: 'FAT_PROTEIN_UNITS' } }, 'dessert')).toBe(true);
    expect(isMealWbtDose({ type: 'BOLUS', occurred_at: at, payload: {} }, 'dessert')).toBe(false);
  });
});
