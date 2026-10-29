import { describe, expect, it } from 'vitest';
import { proposesDose } from '@modules/remote-commands/application/bolus-proposal-tool';
import { finalizeTherapyProposal, THERAPY_SUGGESTION_INSTRUCTIONS } from './therapy-suggestion-policy';

const dose = 'Wynik analizy.\n**Propozycja:** 2,5 j (do rozważenia)\n**Uzasadnienie:** 30 g / 12 = 2,5 j';
const fresh = { glucose_mgdl: 160, age_minutes: 4, trend: 'Flat' };

describe('free-text dose proposals (therapy-suggestion-policy)', () => {
  it('leaves a dose written from a fresh, steady reading and an answer without a dose as they are', () => {
    expect(finalizeTherapyProposal(dose, fresh, proposesDose)).toEqual({ text: dose, corrected: false });
    expect(finalizeTherapyProposal('**Propozycja:** brak, glikemia spada', { ...fresh, glucose_mgdl: 60 }, proposesDose).corrected).toBe(false);
    expect(finalizeTherapyProposal('Bez propozycji dawki.', null, proposesDose).corrected).toBe(false);
  });

  it('adds one sentence when the reading is missing, low, falling fast or stale (the text itself stays)', () => {
    const missing = finalizeTherapyProposal(dose, null, proposesDose);
    expect(missing.text.startsWith(dose)).toBe(true);
    expect(missing.text).toContain('brak aktualnego odczytu');
    expect(finalizeTherapyProposal(dose, { ...fresh, glucose_mgdl: 64 }, proposesDose).text).toContain('64 mg/dL jest poniżej 70');
    expect(finalizeTherapyProposal(dose, { ...fresh, trend: 'DoubleDown' }, proposesDose).text).toContain('szybko spada');
    expect(finalizeTherapyProposal(dose, { ...fresh, age_minutes: 22 }, proposesDose).text).toContain('sprzed 22 min');
    expect([null, { ...fresh, glucose_mgdl: 64 }, { ...fresh, trend: 'DoubleDown' }, { ...fresh, age_minutes: 22 }].map((glucose) => finalizeTherapyProposal(dose, glucose, proposesDose).kind))
      .toEqual(['THERAPY_NO_READING', 'THERAPY_LOW', 'THERAPY_FALLING', 'THERAPY_STALE_READING']);
  });

  it('states the split rule from the bolus cards\' constants', () => {
    const rule = THERAPY_SUGGESTION_INSTRUCTIONS.find((line) => line.startsWith('A split meal bolus'));
    expect(rule).toContain('70/30 with the second part after 60 min');
    expect(rule).toContain('60/40 after 90 min');
  });
});
