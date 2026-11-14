import { describe, expect, it } from 'vitest';
import { readIcrWhatIfIntent } from '@modules/settings-whatif/application/icr-whatif-intent';
import { changeRequestReply, notInProfileReply, previousTherapySettingsCard, readSettingsHour, readTherapySettingsRequest } from './therapy-settings-request';

const read = (text: string, followUp: Parameters<typeof readTherapySettingsRequest>[1] = null) => readTherapySettingsRequest(text, followUp);

describe('readTherapySettingsRequest: layouts', () => {
  it('reads one setting without an hour as SINGLE', () => {
    expect(read('Jaką bazę ma Janek?')).toEqual({ kind: 'CARD', layout: 'SINGLE', settings: ['BASAL'], at: null });
    expect(read('Jakie jest ICR?')).toEqual({ kind: 'CARD', layout: 'SINGLE', settings: ['ICR'], at: null });
    expect(read('A ISF?')).toEqual({ kind: 'CARD', layout: 'SINGLE', settings: ['ISF'], at: null });
    expect(read('Jaki jest cel?')).toEqual({ kind: 'CARD', layout: 'SINGLE', settings: ['TARGET'], at: null });
    expect(read('Jaki jest przelicznik?')).toMatchObject({ layout: 'SINGLE', settings: ['ICR'] });
    expect(read('Jaka jest wrażliwość na insulinę?')).toMatchObject({ layout: 'SINGLE', settings: ['ISF'] });
    expect(read('Jaki ma bazal?')).toMatchObject({ layout: 'SINGLE', settings: ['BASAL'] });
    expect(read('ile wynosi target')).toMatchObject({ layout: 'SINGLE', settings: ['TARGET'] });
  });

  it('reads all settings without an hour as OVERVIEW', () => {
    expect(read('Jakie Janek ma ustawienia?')).toEqual({ kind: 'CARD', layout: 'OVERVIEW', settings: ['BASAL', 'ICR', 'ISF', 'TARGET'], at: null });
    expect(read('Pokaż profil')).toMatchObject({ layout: 'OVERVIEW' });
  });

  it('reads two or three settings as COMBO, in the card order', () => {
    expect(read('Pokaż ICR i ISF razem')).toEqual({ kind: 'CARD', layout: 'COMBO', settings: ['ICR', 'ISF'], at: null });
    expect(read('bazę i cel')).toEqual({ kind: 'CARD', layout: 'COMBO', settings: ['BASAL', 'TARGET'], at: null });
    expect(read('Pokaż cel, ISF i bazę')).toMatchObject({ layout: 'COMBO', settings: ['BASAL', 'ISF', 'TARGET'] });
  });

  it('reads one setting at an hour as AT_ONE', () => {
    expect(read('Jakie jest ICR o 13:00?')).toEqual({ kind: 'CARD', layout: 'AT_ONE', settings: ['ICR'], at: { hour: 13, minute: 0, ambiguous: false } });
    expect(read('Jaką bazę ma o 3 w nocy?')).toEqual({ kind: 'CARD', layout: 'AT_ONE', settings: ['BASAL'], at: { hour: 3, minute: 0, ambiguous: false } });
  });

  it('reads all or several settings at an hour as AT_MANY', () => {
    expect(read('Jakie ustawienia obowiązują o 18:30?')).toEqual({ kind: 'CARD', layout: 'AT_MANY', settings: ['BASAL', 'ICR', 'ISF', 'TARGET'], at: { hour: 18, minute: 30, ambiguous: false } });
    expect(read('ICR i ISF o 7:00')).toEqual({ kind: 'CARD', layout: 'AT_MANY', settings: ['ICR', 'ISF'], at: { hour: 7, minute: 0, ambiguous: false } });
  });
});

describe('readTherapySettingsRequest: no card', () => {
  it('answers a setting outside the profile with the fixed text', () => {
    expect(read('Jaki jest max IOB?')).toEqual({ kind: 'NOT_IN_PROFILE' });
    expect(read('Ile wynosi maksymalny bolus?')).toEqual({ kind: 'NOT_IN_PROFILE' });
    expect(read('Jaki jest autosens?')).toEqual({ kind: 'NOT_IN_PROFILE' });
  });

  it('writes the fixed texts with the loop name', () => {
    expect(notInProfileReply({ genitive: 'Trio', locative: 'Trio' })).toBe('Tego ustawienia Mellis nie dostaje z Trio. Sprawdź je w Trio. Mellis widzi bazę, ICR, ISF, cel i czas działania insuliny.');
    expect(changeRequestReply({ locative: 'Loopie' })).toBe('Ustawienia zmienia się w Loopie.');
  });

  it('answers a change request with the fixed text', () => {
    expect(read('Zmień ICR na 7')).toEqual({ kind: 'CHANGE_REQUEST' });
    expect(read('Zwiększ bazę w nocy')).toEqual({ kind: 'CHANGE_REQUEST' });
    expect(read('Jak zmienić ICR?')).toBeNull();
  });

  it('leaves doses, delivered insulin and history to other answers', () => {
    expect(read('ile na 30 g')).toBeNull();
    expect(read('Ile bazy poszło dziś?')).toBeNull();
    expect(read('Ile pętla dała w nocy?')).toBeNull();
    expect(read('Ile insuliny podać na 30 g przy ICR 8?')).toBeNull();
    expect(read('Jaka była baza wczoraj?')).toBeNull();
  });

  it('leaves judgements, definitions and what-ifs to the model', () => {
    expect(read('Czy baza w nocy jest za wysoka?')).toBeNull();
    expect(read('Dlaczego ICR rano jest niższy?')).toBeNull();
    expect(read('Co to jest ISF?')).toBeNull();
    expect(read('Co jeśli ICR będzie 7?')).toBeNull();
    expect(read('Jaką bazę tymczasową ustawiła pętla?')).toBeNull();
  });

  it('does not take other words for settings', () => {
    expect(read('W jakim celu jest ten alarm?')).toBeNull();
    expect(read('Jakie są ustawienia powiadomień?')).toBeNull();
    expect(read('Ile korekt było dziś?')).toBeNull();
    expect(read('Jaki był cukier o 13?')).toBeNull();
  });

  it('does not take a settings question for an ICR what-if', () => {
    const schedule: Array<[string, number]> = [['00:00', 10], ['06:00', 5], ['09:30', 8.3], ['18:00', 6.8]];
    for (const question of ['Jakie jest ICR?', 'Jakie jest ICR o 13:00?', 'ICR i ISF o 7:00', 'Pokaż ICR i ISF razem']) {
      expect(readIcrWhatIfIntent(question, schedule)).toBeNull();
    }
  });
});

describe('readSettingsHour', () => {
  const hour = (text: string) => readSettingsHour(text.toLowerCase());

  it('reads hours with and without minutes', () => {
    expect(hour('o 13')).toEqual({ hour: 13, minute: 0, ambiguous: false });
    expect(hour('o 18.30')).toEqual({ hour: 18, minute: 30, ambiguous: false });
    expect(hour('o godzinie 9:30')).toEqual({ hour: 9, minute: 30, ambiguous: false });
  });

  it('reads the night as 22–6', () => {
    expect(hour('o 3 w nocy')).toEqual({ hour: 3, minute: 0, ambiguous: false });
    expect(hour('o 11 w nocy')).toEqual({ hour: 23, minute: 0, ambiguous: false });
    expect(hour('o 12 w nocy')).toEqual({ hour: 0, minute: 0, ambiguous: false });
  });

  it('reads midnight and noon', () => {
    expect(hour('o polnocy')).toEqual({ hour: 0, minute: 0, ambiguous: false });
    expect(hour('o 24')).toEqual({ hour: 0, minute: 0, ambiguous: false });
    expect(hour('o 0:00')).toEqual({ hour: 0, minute: 0, ambiguous: false });
    expect(hour('w poludnie')).toEqual({ hour: 12, minute: 0, ambiguous: false });
  });

  it('reads "o 7" as 7:00 and marks it ambiguous; a part of the day settles it', () => {
    expect(hour('o 7')).toEqual({ hour: 7, minute: 0, ambiguous: true });
    expect(hour('o 7 rano')).toEqual({ hour: 7, minute: 0, ambiguous: false });
    expect(hour('o 7 wieczorem')).toEqual({ hour: 19, minute: 0, ambiguous: false });
    expect(hour('o 3 po poludniu')).toEqual({ hour: 15, minute: 0, ambiguous: false });
  });

  it('does not read grams, units or invalid hours', () => {
    expect(hour('o 30 g')).toBeNull();
    expect(hour('o 2 j')).toBeNull();
    expect(hour('o 25')).toBeNull();
    expect(hour('o 13:75')).toBeNull();
  });
});

describe('follow-ups', () => {
  const cardAnswer = (therapy: Record<string, unknown>) => [
    { id: 'u1', role: 'USER', content: 'Jakie jest ICR o 13:00?' },
    { id: 'a1', role: 'ASSISTANT', content: '', metadata: { metric_card: { kind: 'THERAPY_SETTINGS', period_label: 'o 13:00', therapy } } },
    { id: 'u2', role: 'USER', content: 'a ISF?' },
  ];

  it('reads the previous card', () => {
    const messages = cardAnswer({ layout: 'AT_ONE', at: '13:00', is_now: false, settings: [{ key: 'ICR' }] });
    expect(previousTherapySettingsCard(messages, 'u2')).toEqual({ settings: ['ICR'], all: false, at: { hour: 13, minute: 0 } });
    expect(previousTherapySettingsCard(messages, 'u1')).toBeNull();
    expect(previousTherapySettingsCard(cardAnswer({ layout: 'SINGLE', at: '13:20', is_now: true, settings: [{ key: 'ICR' }] }), 'u2')).toEqual({ settings: ['ICR'], all: false, at: null });
  });

  it('keeps the previous hour for another setting', () => {
    expect(read('a ISF?', { settings: ['ICR'], all: false, at: { hour: 13, minute: 0 } }))
      .toEqual({ kind: 'CARD', layout: 'AT_ONE', settings: ['ISF'], at: { hour: 13, minute: 0, ambiguous: false } });
    expect(read('a ISF?', { settings: ['ICR'], all: false, at: null })).toEqual({ kind: 'CARD', layout: 'SINGLE', settings: ['ISF'], at: null });
  });

  it('keeps the previous settings for another hour', () => {
    expect(read('a o 18?', { settings: ['ICR'], all: false, at: { hour: 13, minute: 0 } }))
      .toEqual({ kind: 'CARD', layout: 'AT_ONE', settings: ['ICR'], at: { hour: 18, minute: 0, ambiguous: false } });
    expect(read('A o 3 w nocy?', { settings: ['BASAL', 'ICR', 'ISF', 'TARGET'], all: true, at: null }))
      .toMatchObject({ layout: 'AT_MANY', at: { hour: 3, minute: 0 } });
  });

  it('needs a previous card for a reply without a setting', () => {
    expect(read('a o 18?')).toBeNull();
    expect(read('a teraz?', { settings: ['ICR'], all: false, at: { hour: 13, minute: 0 } })).toBeNull();
  });
});
