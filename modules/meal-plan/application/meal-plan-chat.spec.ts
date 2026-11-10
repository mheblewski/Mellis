import { describe, expect, it } from 'vitest';
import type { MealChatInput, MealChatReply, MealChatResponder } from '@modules/meal-chat/application/meal-chat-responder';
import { FakeMealChatResponder, plannedMealInstructions } from '@modules/meal-chat/application/meal-chat-responder';
import type { MealPlanEntry } from './meal-plan';
import { mealPlanCurrentMeal, mealPlanItemsFromProposal, parseMealPlanChatPost, parseMealPlanPlate, runMealPlanChatReplyJob, type MealPlanChatMessage } from './meal-plan-chat';

const PATIENT = '00000000-0000-0000-0000-000000000001';
const ENTRY = '00000000-0000-0000-0000-0000000000e1';

const entry: MealPlanEntry = {
  id: ENTRY,
  plan_id: '00000000-0000-0000-0000-0000000000p1',
  patient_id: PATIENT,
  kind: 'MEAL',
  title: 'Zupa i podwieczorek',
  planned_at: '2026-11-10T10:30:00.000Z',
  items: [
    { name: 'Krupnik z kaszą jęczmienną 250 ml', carbs_g: 15, protein_g: 3, fat_g: 2 },
    { name: 'Kisiel owocowy z kawałkami jabłka 150 g', carbs_g: 25, protein_g: 0, fat_g: 0 },
  ],
  status: 'PLANNED',
  lead_minutes: 20,
  reminder_sent_at: null,
  missed_sent_at: null,
  dose_answer: null,
  eaten_asked_at: null,
  eaten_asked_again_at: null,
  eaten_answer: null,
  eaten_answered_at: null,
  paused: false,
};

function message(partial: Partial<MealPlanChatMessage> & Pick<MealPlanChatMessage, 'id' | 'role' | 'content'>): MealPlanChatMessage {
  return { photo_ids: [], plate_summary: null, proposal: null, question: null, author_display_name: null, author_user_id: null, reply_to_message_id: null, accepted_at: null, created_at: '2026-11-10T09:00:00.000Z', ...partial };
}

describe('planned meal chat', () => {
  it('names an accepted dish with its grams, and keeps a name that has its own portion', () => {
    expect(mealPlanItemsFromProposal({
      items: [
        { name: 'Krupnik z kaszą jęczmienną 250 ml', grams: 250, carbs_g: 15, protein_g: 3, fat_g: 2, source: 'ESTIMATE' },
        { name: 'Batonik zbożowy', grams: 25, carbs_g: 17.46, protein_g: 1.2, fat_g: 4, source: 'DIABCALC' },
        { name: 'Jabłko', grams: null, carbs_g: 900, protein_g: 0, fat_g: 0, source: 'ESTIMATE' },
      ],
    })).toEqual([
      { name: 'Krupnik z kaszą jęczmienną 250 ml', carbs_g: 15, protein_g: 3, fat_g: 2 },
      { name: 'Batonik zbożowy 25 g', carbs_g: 17.5, protein_g: 1.2, fat_g: 4 },
      { name: 'Jabłko', carbs_g: 500, protein_g: 0, fat_g: 0 },
    ]);
  });

  it('gives the model the menu dishes, and the plate the caregiver saw when the phone sent it', () => {
    const current = mealPlanCurrentMeal(entry, 'Krupnik z kaszą jęczmienną 250 ml (połowa) 8 g, Kisiel owocowy z kawałkami jabłka 150 g 25 g');
    expect(current.carbs_g).toBe(40);
    expect(current.items).toHaveLength(2);
    expect(current.description).toContain('Na talerzu teraz: Krupnik');
    expect(mealPlanCurrentMeal(entry, null).description).toBe('Zupa i podwieczorek');
  });

  it('refuses an empty message, takes a plate summary, and bounds the plate', () => {
    expect(() => parseMealPlanChatPost({ content: '  ' })).toThrow();
    const label = '00000000-0000-4000-8000-00000000abcd';
    expect(parseMealPlanChatPost({ content: '', photo_ids: [label.toUpperCase(), label] })).toEqual({ content: '', photo_ids: [label], plate_summary: null });
    expect(() => parseMealPlanChatPost({ content: 'x', photo_ids: ['nie-id'] })).toThrow();
    expect(parseMealPlanChatPost({ content: ' zamiast kisielu batonik ', plate_summary: '' })).toEqual({ content: 'zamiast kisielu batonik', photo_ids: [], plate_summary: null });
    expect(parseMealPlanPlate({ plate: null })).toBeNull();
    expect(parseMealPlanPlate({ plate: { foods: {} } })).toEqual({ foods: {} });
    expect(() => parseMealPlanPlate({ plate: [] })).toThrow();
    expect(() => parseMealPlanPlate({ plate: { big: 'x'.repeat(20_000) } })).toThrow();
  });

  it('answers with the planned dishes and the remembered rules, without a dose', async () => {
    const seen: MealChatInput[] = [];
    const responder: MealChatResponder = {
      providerName: 'test',
      async respond(input): Promise<MealChatReply> {
        seen.push(input);
        return { reply: 'Zamieniam kisiel na batonik. Podaj 2 j insuliny.', question: null, proposal: { items: [{ name: 'Batonik', grams: 25, carbs_g: 17, protein_g: 1, fat_g: 4, source: 'ESTIMATE' }], carbs_g: 17, protein_g: 1, fat_g: 4, confidence: 'MEDIUM', assumptions: '' } };
      },
    };
    const stored: Array<Record<string, unknown>> = [];
    const messages = [message({ id: 'u1', role: 'USER', content: 'zamiast kisielu batonik', plate_summary: 'Krupnik 15 g, Kisiel 25 g', author_user_id: 'user-1' })];
    const outcome = await runMealPlanChatReplyJob({
      getEntry: async () => entry,
      listMessages: async () => messages,
      hasReply: async () => false,
      insertAssistantMessage: async (args) => { stored.push(args); },
      planRules: async () => ['Podwieczorek jest zaraz po zupie.'],
      responder,
    }, { patient_id: PATIENT, entry_id: ENTRY, user_message_id: 'u1' });
    expect(outcome).toBe('REPLIED');
    expect(seen[0].planned).toEqual({ title: 'Zupa i podwieczorek', rules: ['Podwieczorek jest zaraz po zupie.'] });
    expect(seen[0].meal.logged_carbs_g).toBeNull();
    expect(seen[0].meal.current?.description).toContain('Krupnik 15 g, Kisiel 25 g');
    expect(String(stored[0].content)).toContain('Dawki tutaj nie liczę');
    expect((stored[0].proposal as { proposal_id: unknown }).proposal_id).toBeNull();
  });

  it('sends the photo of a product label with its message', async () => {
    const seen: MealChatInput[] = [];
    const responder: MealChatResponder = { providerName: 'test', async respond(input) { seen.push(input); return { reply: 'Odczytałem etykietę.', question: null, proposal: null }; } };
    const read: string[] = [];
    await runMealPlanChatReplyJob({
      getEntry: async () => entry,
      listMessages: async () => [message({ id: 'u1', role: 'USER', content: '', photo_ids: ['p1'] })],
      hasReply: async () => false,
      insertAssistantMessage: async () => undefined,
      planRules: async () => [],
      readPhoto: async (_patient, photoId) => { read.push(photoId); return Buffer.from('jpeg'); },
      responder,
    }, { patient_id: PATIENT, entry_id: ENTRY, user_message_id: 'u1' });
    expect(read).toEqual(['p1']);
    expect(seen[0].turns[0].photos).toHaveLength(1);
    expect(plannedMealInstructions({ title: 'Obiad', rules: [] }).join('\n')).toContain('etykietę produktu');
  });

  it('does nothing when the message already has its reply', async () => {
    const outcome = await runMealPlanChatReplyJob({
      getEntry: async () => entry,
      listMessages: async () => [],
      hasReply: async () => true,
      insertAssistantMessage: async () => { throw new Error('no second reply'); },
      planRules: async () => [],
      responder: new FakeMealChatResponder(),
    }, { patient_id: PATIENT, entry_id: ENTRY, user_message_id: 'u1' });
    expect(outcome).toBe('ALREADY_REPLIED');
  });

  it('tells the model this is a planned meal, with the rules, and nothing for an eaten meal', () => {
    expect(plannedMealInstructions(null)).toEqual([]);
    const lines = plannedMealInstructions({ title: 'Obiad', rules: ['Owoce tylko arbuz i melon.'] });
    expect(lines.join('\n')).toContain('dopiero będzie zjedzony');
    expect(lines.at(-1)).toContain('Owoce tylko arbuz i melon.');
  });

  it('the offline responder keeps the planned dishes and adds the change', async () => {
    const reply = await new FakeMealChatResponder().respond({
      meal: { started_at: entry.planned_at, local_time: null, logged_carbs_g: null, current: mealPlanCurrentMeal(entry, null) },
      planned: { title: entry.title, rules: [] },
      turns: [{ role: 'USER', content: 'dodatkowo bułka', photos: [] }],
    });
    expect(reply.proposal?.items.map((item) => item.name)).toEqual(['Krupnik z kaszą jęczmienną 250 ml', 'Kisiel owocowy z kawałkami jabłka 150 g', 'dodatkowo bułka']);
    expect(reply.proposal?.carbs_g).toBe(50);
  });
});
