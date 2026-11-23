import { describe, expect, it } from 'vitest';
import { loopSystemNames } from '@modules/loop-system/domain/loop-system';
import { warningsChangedReason, worsenedWarnings, type WarningLike } from './warning-change';

const w = (key: string, message = `text of ${key}`, severity?: string): WarningLike => ({ code: key.split(':')[0], key, message, ...(severity ? { severity } : {}) });
const trio = loopSystemNames('TRIO');
const reason = (live: WarningLike[], acknowledged: string[], extra: { line_min_mgdl?: number | null; dose_at?: (at: string) => { units: number; remote: boolean } | null } = {}) =>
  warningsChangedReason(worsenedWarnings(live, acknowledged, { dose_at: extra.dose_at }), live, { loop: trio, line_min_mgdl: extra.line_min_mgdl ?? null });

describe('warning-change.v1: refused only when it got worse since the slide', () => {
  it('an exact key passes; a code not acknowledged at all is a new warning', () => {
    expect(worsenedWarnings([w('NO_GLUCOSE')], ['NO_GLUCOSE'])).toEqual([]);
    expect(worsenedWarnings([w('NO_GLUCOSE')], [])).toMatchObject([{ kind: 'NEW_WARNING' }]);
    expect(reason([w('NO_GLUCOSE', 'Brak odczytu glukozy.')], [])).toBe('Pojawiło się nowe ostrzeżenie: Brak odczytu glukozy.');
  });

  it('the 2026-11-18 case: a reading 97 → 90 is a drop of 7 → refused with both numbers; 97 → 93 passes', () => {
    const ack = ['INSULIN_WHILE_LOW:PREDICTED_LOW:97'];
    expect(worsenedWarnings([w('INSULIN_WHILE_LOW:PREDICTED_LOW:93')], ack)).toEqual([]);
    expect(worsenedWarnings([w('INSULIN_WHILE_LOW:PREDICTED_LOW:102')], ack)).toEqual([]);
    expect(reason([w('INSULIN_WHILE_LOW:PREDICTED_LOW:90', 'x', 'DANGER')], ack, { line_min_mgdl: 68.4 }))
      .toBe('W trakcie wysyłania glukoza wyraźnie spadła z 97 do 90 mg/dL.\nZ tą dawką prognoza schodzi do ok. 68 mg/dL.');
    // Exactly 5 lower is worse.
    expect(worsenedWarnings([w('INSULIN_WHILE_LOW:PREDICTED_LOW:92')], ack)).toHaveLength(1);
  });

  it('INSULIN_WHILE_LOW: a more severe level is worse whatever the glucose; a milder one is not', () => {
    expect(worsenedWarnings([w('INSULIN_WHILE_LOW:BELOW_70:69')], ['INSULIN_WHILE_LOW:PREDICTED_LOW:72'])).toMatchObject([{ kind: 'GLUCOSE_DROP', before: 72, after: 69 }]);
    // A drop under 5 mg/dL: said with the warning's own text (no "wyraźnie spadła").
    expect(reason([w('INSULIN_WHILE_LOW:BELOW_70:69', 'Glukoza 69 mg/dL: najpierw węglowodany.')], ['INSULIN_WHILE_LOW:PREDICTED_LOW:72'])).toBe('Pojawiło się nowe ostrzeżenie: Glukoza 69 mg/dL: najpierw węglowodany.');
    expect(worsenedWarnings([w('INSULIN_WHILE_LOW:STALE_LOW:64')], ['INSULIN_WHILE_LOW:BELOW_70:64'])).toEqual([]);
    expect(worsenedWarnings([w('INSULIN_WHILE_LOW:URGENT_LOW:58')], ['INSULIN_WHILE_LOW:LOW_NOW:60'])).toHaveLength(1);
  });

  it('GLUCOSE_FALLING_OR_LOW and LOW_GLUCOSE compare the reading at the end of the key; an older key without one is refused', () => {
    expect(worsenedWarnings([w('GLUCOSE_FALLING_OR_LOW:2026-11-18T11:51:00.000Z:76')], ['GLUCOSE_FALLING_OR_LOW:2026-11-18T11:46:00.000Z:78'])).toEqual([]);
    expect(reason([w('GLUCOSE_FALLING_OR_LOW:2026-11-18T11:51:00.000Z:72')], ['GLUCOSE_FALLING_OR_LOW:2026-11-18T11:46:00.000Z:78'])).toBe('W trakcie wysyłania glukoza wyraźnie spadła z 78 do 72 mg/dL.');
    expect(worsenedWarnings([w('LOW_GLUCOSE:2026-11-18T11:51:00.000Z:66')], ['LOW_GLUCOSE:2026-11-18T11:46:00.000Z:64'])).toEqual([]);
    // The "fell to 65 in the last 30 min" form ends with the current reading too (75): now 66 is 9 lower.
    expect(worsenedWarnings([w('LOW_GLUCOSE:2026-11-18T11:51:00.000Z:66')], ['LOW_GLUCOSE:2026-11-18T11:46:00.000Z:65:75'])).toMatchObject([{ before: 75, after: 66 }]);
    expect(worsenedWarnings([w('LOW_GLUCOSE:2026-11-18T11:51:00.000Z:65:73')], ['LOW_GLUCOSE:2026-11-18T11:46:00.000Z:65:75'])).toEqual([]);
    expect(worsenedWarnings([w('GLUCOSE_FALLING_OR_LOW:2026-11-18T11:51:00.000Z:76')], ['GLUCOSE_FALLING_OR_LOW:2026-11-18T11:46:00.000Z'])).toHaveLength(1);
  });

  it('another glucose code than the acknowledged one is refused, said as the drop when it is one', () => {
    const live = [w('LOW_GLUCOSE:2026-11-18T11:51:00.000Z:68')];
    expect(reason(live, ['GLUCOSE_FALLING_OR_LOW:2026-11-18T11:46:00.000Z:75'])).toBe('W trakcie wysyłania glukoza wyraźnie spadła z 75 do 68 mg/dL.');
    expect(reason([w('LOW_GLUCOSE:2026-11-18T11:51:00.000Z:68', 'Glukoza 68 mg/dL: insulina może pogłębić niedocukrzenie.')], ['GLUCOSE_FALLING_OR_LOW:2026-11-18T11:46:00.000Z:70']))
      .toBe('Pojawiło się nowe ostrzeżenie: Glukoza 68 mg/dL: insulina może pogłębić niedocukrzenie.');
  });

  it('DOSE_LINE_LOW: a lower band or a minimum at least 5 mg/dL lower is worse; the same band a little lower passes', () => {
    const ack = ['DOSE_LINE_LOW:1.9:1.4:BELOW_100:82'];
    expect(worsenedWarnings([w('DOSE_LINE_LOW:1.9:1.4:BELOW_100:79')], ack)).toEqual([]);
    expect(worsenedWarnings([w('DOSE_LINE_LOW:1.9:1.4:BELOW_100:90')], ack)).toEqual([]);
    expect(reason([w('DOSE_LINE_LOW:1.9:1.4:BELOW_100:76')], ack, { line_min_mgdl: 76 })).toBe('W trakcie wysyłania prognoza z tą dawką zeszła z 82 do ok. 76 mg/dL.');
    expect(reason([w('DOSE_LINE_LOW:1.9:1.4:BELOW_70:68')], ['DOSE_LINE_LOW:1.9:1.4:BELOW_100:71'])).toBe('W trakcie wysyłania prognoza z tą dawką zeszła z 71 do ok. 68 mg/dL.');
    expect(worsenedWarnings([w('DOSE_LINE_LOW:1.9:1.4:BELOW_100:85')], ['DOSE_LINE_LOW:1.9:1.4:BELOW_70:68'])).toEqual([]);
    // A key from before the minimum was in it, or another dose: refused.
    expect(worsenedWarnings([w('DOSE_LINE_LOW:1.9:1.4:BELOW_100:85')], ['DOSE_LINE_LOW:1.9:1.4:BELOW_100'])).toHaveLength(1);
    expect(worsenedWarnings([w('DOSE_LINE_LOW:2:1.4:BELOW_100:85')], ['DOSE_LINE_LOW:1.9:1.4:BELOW_100:85'])).toHaveLength(1);
  });

  it('DOSE_ABOVE_PROPOSALS / DOSE_ABOVE_CALCULATOR: worse only when the reference went down', () => {
    expect(worsenedWarnings([w('DOSE_ABOVE_CALCULATOR:4.6:2.8')], ['DOSE_ABOVE_CALCULATOR:4.6:2.3'])).toEqual([]);
    expect(reason([w('DOSE_ABOVE_CALCULATOR:4.6:1.9', '4,6 j to o 2,7 j więcej.')], ['DOSE_ABOVE_CALCULATOR:4.6:2.3'])).toBe('Pojawiło się nowe ostrzeżenie: 4,6 j to o 2,7 j więcej.');
    expect(worsenedWarnings([w('DOSE_ABOVE_PROPOSALS:2.6:1.5')], ['DOSE_ABOVE_PROPOSALS:2.6:1.4'])).toEqual([]);
    expect(worsenedWarnings([w('DOSE_ABOVE_PROPOSALS:2.6:1.3')], ['DOSE_ABOVE_PROPOSALS:2.6:1.4'])).toMatchObject([{ kind: 'FORECAST_DROP' }]);
  });

  it('new insulin: another bolus or SMB since the slide, with the loop name, units and Warsaw time', () => {
    expect(reason([w('RECENT_BOLUS:2026-11-18T11:46:00.000Z:0.3')], ['RECENT_BOLUS:2026-11-18T11:20:00.000Z:1.5'])).toBe('W trakcie wysyłania Trio podało 0,3 j o 12:46.');
    // A bolus the slide did not see at all (no RECENT_BOLUS acknowledged) is new insulin too.
    expect(reason([w('RECENT_BOLUS:2026-11-18T11:46:00.000Z:0.3')], [])).toBe('W trakcie wysyłania Trio podało 0,3 j o 12:46.');
    expect(warningsChangedReason(worsenedWarnings([w('RECENT_BOLUS:2026-11-18T11:46:00.000Z:0.3')], []), [], { loop: loopSystemNames('LOOP') })).toBe('W trakcie wysyłania Loop podał 0,3 j o 12:46.');
    expect(warningsChangedReason(worsenedWarnings([w('RECENT_BOLUS:2026-11-18T11:46:00.000Z:0.3')], []), [], { loop: loopSystemNames('UNKNOWN') })).toBe('W trakcie wysyłania pętla podała 0,3 j o 12:46.');
    // RECENT_INSULIN: the newest dose from the context, else what the total grew by.
    const smb = (at: string) => (at === '2026-11-18T11:46:00.000Z' ? { units: 0.2, remote: false } : null);
    expect(reason([w('RECENT_INSULIN:2026-11-18T11:46:00.000Z:1.7')], ['RECENT_INSULIN:2026-11-18T11:30:00.000Z:1.5'], { dose_at: smb })).toBe('W trakcie wysyłania Trio podało 0,2 j o 12:46.');
    expect(reason([w('RECENT_INSULIN:2026-11-18T11:46:00.000Z:1.7')], ['RECENT_INSULIN:2026-11-18T11:30:00.000Z:1.5'])).toBe('W trakcie wysyłania Trio podało 0,2 j o 12:46.');
    // The same newest dose, a higher total: worse; a lower total (insulin left the window): not.
    expect(worsenedWarnings([w('RECENT_INSULIN:2026-11-18T11:30:00.000Z:1.8')], ['RECENT_INSULIN:2026-11-18T11:30:00.000Z:1.5'])).toHaveLength(1);
    expect(worsenedWarnings([w('RECENT_INSULIN:2026-11-18T11:30:00.000Z:1.2')], ['RECENT_INSULIN:2026-11-18T11:30:00.000Z:1.5'])).toEqual([]);
  });

  it('another remote command: "O HH:MM wysłano inny zdalny bolus", units when known', () => {
    const sent = (at: string) => (at === '2026-11-18T11:47:00.000Z' ? { units: 1.5, remote: true } : null);
    expect(reason([w('RECENT_REMOTE_BOLUS:2026-11-18T11:47:00.000Z')], ['RECENT_REMOTE_BOLUS:2026-11-18T11:20:00.000Z'], { dose_at: sent })).toBe('O 12:47 wysłano inny zdalny bolus 1,5 j.');
    expect(reason([w('UNCONFIRMED_REMOTE_BOLUS:2026-11-18T11:47:00.000Z')], [])).toBe('O 12:47 wysłano inny zdalny bolus.');
    expect(reason([w('ALREADY_SENT_FOR_MEAL:command:abc:2026-11-18T11:47:00.000Z')], ['ALREADY_SENT_FOR_MEAL:command:def:2026-11-18T11:20:00.000Z'], { dose_at: sent })).toBe('O 12:47 wysłano inny zdalny bolus 1,5 j.');
    // RECENT_INSULIN whose newest dose is a remote command not in Nightscout yet.
    expect(reason([w('RECENT_INSULIN:2026-11-18T11:47:00.000Z:1.5')], [], { dose_at: sent })).toBe('O 12:47 wysłano inny zdalny bolus 1,5 j.');
    // A card's own (no time): its own text.
    expect(reason([w('ALREADY_SENT_FOR_MEAL:card-2', 'Ten posiłek już wysłano.')], ['ALREADY_SENT_FOR_MEAL:card-1'])).toBe('Pojawiło się nowe ostrzeżenie: Ten posiłek już wysłano.');
  });

  it('age warnings and DOSE_DIFFERS_FROM_ICR pass with the same code; other codes need the exact key', () => {
    expect(worsenedWarnings([w('GLUCOSE_OLD:2026-11-18T11:30:00.000Z'), w('GLUCOSE_STALE:b'), w('LOOP_STALE:2026-11-18T11:00:00.000Z'), w('DOSE_DIFFERS_FROM_ICR:46:3:10')],
      ['GLUCOSE_OLD:2026-11-18T11:25:00.000Z', 'GLUCOSE_STALE:a', 'LOOP_STALE:none', 'DOSE_DIFFERS_FROM_ICR:46:3:9'])).toEqual([]);
    expect(worsenedWarnings([w('FORECAST_LOW:2:1')], ['FORECAST_LOW:2:2'])).toMatchObject([{ kind: 'NEW_WARNING' }]);
    expect(worsenedWarnings([w('HIGH_DESPITE_INSULIN:A:2026-11-18T11:4')], ['HIGH_DESPITE_INSULIN:A:2026-11-18T11:3'])).toHaveLength(1);
  });

  it('one sentence for the most important: new insulin, then glucose, then the forecast, then a new warning (red first)', () => {
    const live = [
      w('NO_THERAPY_PROFILE', 'Brak ICR.'),
      w('DOSE_LINE_LOW:1.9:1.4:BELOW_70:60', 'line', 'DANGER'),
      w('INSULIN_WHILE_LOW:PREDICTED_LOW:90', 'low', 'DANGER'),
      w('RECENT_BOLUS:2026-11-18T11:46:00.000Z:0.3'),
    ];
    const ack = ['DOSE_LINE_LOW:1.9:1.4:BELOW_100:75', 'INSULIN_WHILE_LOW:PREDICTED_LOW:97'];
    expect(reason(live, ack, { line_min_mgdl: 60 })).toBe('W trakcie wysyłania Trio podało 0,3 j o 12:46.\nZ tą dawką prognoza schodzi do ok. 60 mg/dL.');
    expect(reason(live.slice(0, 3), ack, { line_min_mgdl: 60 })).toBe('W trakcie wysyłania glukoza wyraźnie spadła z 97 do 90 mg/dL.\nZ tą dawką prognoza schodzi do ok. 60 mg/dL.');
    expect(reason(live.slice(0, 2), ack, { line_min_mgdl: 60 })).toBe('W trakcie wysyłania prognoza z tą dawką zeszła z 75 do ok. 60 mg/dL.');
    expect(reason([w('NO_THERAPY_PROFILE', 'Brak ICR.'), w('CALCULATOR_UNAVAILABLE', 'Kalkulator niedostępny.', 'DANGER')], [])).toBe('Pojawiło się nowe ostrzeżenie: Kalkulator niedostępny.');
    // No risk line without DOSE_LINE_LOW / INSULIN_WHILE_LOW among the live warnings, or without the line's minimum.
    expect(reason([w('NO_THERAPY_PROFILE', 'Brak ICR.')], [], { line_min_mgdl: 60 })).toBe('Pojawiło się nowe ostrzeżenie: Brak ICR.');
    expect(reason([live[2]], ack)).toBe('W trakcie wysyłania glukoza wyraźnie spadła z 97 do 90 mg/dL.');
    // The live DOSE_LINE_LOW key's minimum when the chart's is not passed.
    expect(reason(live.slice(0, 3), ack)).toBe('W trakcie wysyłania glukoza wyraźnie spadła z 97 do 90 mg/dL.\nZ tą dawką prognoza schodzi do ok. 60 mg/dL.');
  });
});
