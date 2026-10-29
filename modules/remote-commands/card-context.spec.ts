import { describe, expect, it } from 'vitest';
import { describeAnswerCards } from './application/card-context';
import type { BolusProposalRecord } from './application/bolus-proposal-tool';

const base = {
  id: 'b1', patient_id: 'p1', conversation_id: 'c1', user_message_id: 'm1', icr_g_per_u: 8, icr_insulin_u: 6, reason: null, warnings: [],
  dose_adjustment: null, card_advice: null, status: 'PROPOSED', created_at: '2026-10-22T21:52:00.000Z', expires_at: '2026-10-22T22:07:00.000Z',
} as const;

describe('earlier cards for the model (card-context.v1)', () => {
  it('lists each option\'s amounts now and later, WBT and state as of the question', () => {
    const a = { ...base, purpose: 'MEAL', carbs_g: 46, insulin_u: 5.9, option_key: 'A',
      meal_payload: { description: '1/2 średniej pizzy Pepperoni', items: null, macros: { carbs_g: 65, protein_g: 24, fat_g: 28 } },
      split: { kind: 'SPLIT', now_percent: 70, later_after_minutes: 60, total_carbs_g: 65, total_insulin_u: 8.3, later_carbs_g: 19, later_insulin_u: 2.4, trigger: 'AFTER_MINUTES' } } as unknown as BolusProposalRecord;
    const b = { ...base, id: 'b2', purpose: 'MEAL', carbs_g: 65, insulin_u: 8.4, option_key: 'B', meal_payload: null, split: null } as unknown as BolusProposalRecord;
    const note = describeAnswerCards({
      cards: [{ proposal: a, command: null }, { proposal: b, command: { status: 'SUCCEEDED', carbs_g: 65, insulin_u: 8.4, authorized_at: '2026-10-22T21:55:00.000Z' } }],
      rescue: [],
      options: [{ key: 'A', title: 'Podział dawki na pizzę', detail: null, note: null, recommended: true }, { key: 'B', title: 'Cała dawka od razu', detail: null, note: null, recommended: false }],
      asOf: '2026-10-23T05:06:00.000Z',
    })!;
    expect(note).toContain('Opcja A (polecana) „Podział dawki na pizzę”, MEAL 1/2 średniej pizzy Pepperoni (cały posiłek: 65 g W, 24 g B, 28 g T): teraz 46 g + 5,9 j; za 60 min: 19 g + ok. 2,4 j');
    expect(note).toContain('WBT ok.');
    expect(note).toContain('stan: nieaktualna');
    expect(note).toContain('Opcja B „Cała dawka od razu”, MEAL: teraz 65 g + 8,4 j; stan: wysłana (65 g + 8,4 j, status SUCCEEDED)');
  });

  it('says nothing without cards and counts a send only from before the question', () => {
    expect(describeAnswerCards({ cards: [], rescue: [], options: [], asOf: '2026-10-23T05:06:00.000Z' })).toBeNull();
    const card = { ...base, purpose: 'MEAL', carbs_g: 20, insulin_u: 2, option_key: null, meal_payload: null, split: null, expires_at: '2026-10-23T06:00:00.000Z' } as unknown as BolusProposalRecord;
    expect(describeAnswerCards({ cards: [{ proposal: card, command: { status: 'SUCCEEDED', carbs_g: 20, insulin_u: 2, authorized_at: '2026-10-23T05:10:00.000Z' } }], rescue: [{ carbs_g: 7, option_key: null, status: 'ACCEPTED', treated: true }], options: [], asOf: '2026-10-23T05:06:00.000Z' }))
      .toBe('[Karty pod tą odpowiedzią]\n- Karta, MEAL: teraz 20 g + 2 j; stan: do podania\n- Karta, dosłodzenie 7 g; stan: zapisane');
    // A bolus-only retry after PARTIAL: the carbs are in Trio from the first command, not missing.
    expect(describeAnswerCards({ cards: [{ proposal: card, command: { status: 'SUCCEEDED', carbs_g: 0, insulin_u: 2, authorized_at: '2026-10-23T05:00:00.000Z', carbs_in_trio_g: 20 } }], rescue: [], options: [], asOf: '2026-10-23T05:06:00.000Z' }))
      .toContain('stan: wysłana (20 g w pętli z pierwszego polecenia, bolus 2 j ponowiony, status SUCCEEDED)');
  });

  it('tells a confirmed rescue card waiting for its loop entry and one replaced by a newer answer apart from an open one', () => {
    const note = describeAnswerCards({ cards: [], rescue: [
      { carbs_g: 8, option_key: null, status: 'ACCEPTED', treated: false },
      { carbs_g: 6, option_key: null, status: 'SUPERSEDED', treated: false },
      { carbs_g: 5, option_key: null, status: 'PROPOSED', treated: false },
    ], options: [], asOf: '2026-10-23T05:06:00.000Z' });
    expect(note).toContain('dosłodzenie 8 g; stan: potwierdzone (wysłane, czeka na wpis z pętli)');
    expect(note).toContain('dosłodzenie 6 g; stan: nieaktualne (zastąpione nowszą kartą)');
    expect(note).toContain('dosłodzenie 5 g; stan: do potwierdzenia');
  });
});
