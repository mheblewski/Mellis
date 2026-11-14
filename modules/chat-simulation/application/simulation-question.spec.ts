import { describe, expect, it } from 'vitest';
import { mayNeedSimulation, namesSettingValue } from './simulation-question';

describe('mayNeedSimulation (audit 2026-11-12)', () => {
  it('attaches the tools to settings, dosing-rule and what-if questions', () => {
    for (const text of ['Zasymuluj zwiększenie do 5,5', 'Co by było, gdyby ICR wieczorem 7,5?', 'Czy Mellis proponuje jakąś zmianę bazy?', 'Czy pomogłoby podać bolus 15 min wcześniej?', 'Porównaj ten tydzień z poprzednim']) {
      expect(mayNeedSimulation(text)).toBe(true);
    }
  });

  it('leaves them out of dose, now and cause questions', () => {
    for (const text of ['Ile insuliny na kanapkę z serem?', 'Jak dziś cukier?', 'Dlaczego w nocy był spadek?', 'Co to jest WBT?', 'Dałem 10 g soku']) {
      expect(mayNeedSimulation(text)).toBe(false);
    }
  });

  it('keeps them for a short follow-up after a simulation question or card', () => {
    expect(mayNeedSimulation('a 5,0?', [{ role: 'USER', content: 'Zasymuluj ICR 5,5 rano' }, { role: 'ASSISTANT', content: '…' }])).toBe(true);
    expect(mayNeedSimulation('a wieczorem?', [{ role: 'USER', content: 'Jak było?' }, { role: 'ASSISTANT', content: '…', metadata: { metric_card: { kind: 'SETTING_REPLAY' } } }])).toBe(true);
    expect(mayNeedSimulation('a wieczorem?', [{ role: 'USER', content: 'Jak dziś cukier?' }, { role: 'ASSISTANT', content: '…' }])).toBe(false);
  });
});

describe('namesSettingValue (Wzorce conversations, review 2026-11-12 B4: 0 unasked tables)', () => {
  const noValue = [
    'Co jeszcze zmieniło się w tych tygodniach?', 'Czy zmiana z 6.11 coś dała?', 'Co było o 18?', 'Co się zmieniło po 6.11?', 'a po 31.10?',
    'Czemu o 18 rośnie?', 'Co było między 18 a 21?', 'Jak było 18-21?', 'Co się działo 10.11 o 20:30?', 'Czy zmiana przelicznika pomogła?',
    'Dlaczego w nocy był spadek?', 'Ile razy było poniżej 54?', 'Czy baza jest dobra?', 'Co mówi przelicznik?', 'Czy 14 dni wystarczy?',
    'Co zrobić z wieczornymi wzrostami?', 'Czy zmieniać ISF?', 'od 6.11 do 12.11 jak było?', 'Co z bazą w nocy od 0 do 6?', 'Po 2 h był spadek, czemu?',
  ];
  const withValue = [
    'A gdyby ICR wieczorem 7,5?', 'Zasymuluj przelicznik 6,5 od 18', 'baza 0,1 w nocy?', 'Co jeśli 0,15 j/h od 0 do 2?', 'ISF 130 rano?',
    'cel 120 w nocy', 'przelicznik 8 w dzień', 'a gdyby 7 g/j wieczorem?', 'Co by było przy bazie 0,2?', 'DIA 6 godzin?',
  ];

  it('opens the tools only for a value next to its setting', () => {
    expect(noValue.filter((t) => namesSettingValue(t))).toEqual([]);
    expect(withValue.filter((t) => !namesSettingValue(t))).toEqual([]);
  });

  it('keeps them for a short follow-up with another value', () => {
    expect(namesSettingValue('a 7,0?', 'A gdyby ICR wieczorem 7,5?')).toBe(true);
    expect(namesSettingValue('a po 6.11?', 'A gdyby ICR wieczorem 7,5?')).toBe(false);
    expect(namesSettingValue('a 7,0?', 'Co było o 18?')).toBe(false);
  });
});
