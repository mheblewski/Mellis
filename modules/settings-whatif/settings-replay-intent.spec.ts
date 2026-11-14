import { describe, expect, it } from 'vitest';
import { readSettingsReplayIntent, type TherapySchedules } from './application/settings-replay-intent';

const therapy: TherapySchedules = {
  basal_u_per_h: [['00:00', 0.05], ['02:00', 0.1], ['05:00', 0.3], ['06:00', 0.15], ['10:00', 0.05], ['21:00', 0.45]],
  carb_ratio_g_per_u: [['00:00', 10], ['06:00', 5], ['09:30', 8.3], ['18:00', 6.8]],
  sensitivity_per_u: [['00:00', 190], ['03:30', 120]],
  target_low_mgdl: [['00:00', 110]],
  units: 'mg/dl',
};
const read = (text: string) => readSettingsReplayIntent(text, therapy);

describe('readSettingsReplayIntent', () => {
  it('reads a basal change at an hour or in a range', () => {
    expect(read('Co jeśli baza o północy będzie 0,10 zamiast 0,05?')).toEqual({ kind: 'REPLAY', change: { setting: 'BASAL', from: '00:00', to: '02:00', value: 0.1 } });
    expect(read('baza 0-1 na 0,1')).toEqual({ kind: 'REPLAY', change: { setting: 'BASAL', from: '00:00', to: '01:00', value: 0.1 } });
    expect(read('bazę od 2 do 5 z 0,1 na 0,05')).toEqual({ kind: 'REPLAY', change: { setting: 'BASAL', from: '02:00', to: '05:00', value: 0.05 } });
    expect(read('Baza 21:00–24:00 na 0,40')).toEqual({ kind: 'REPLAY', change: { setting: 'BASAL', from: '21:00', to: '00:00', value: 0.4 } });
  });

  it('finds the block by its old value, and asks when that is not enough', () => {
    expect(read('baza z 0,3 na 0,25')).toEqual({ kind: 'REPLAY', change: { setting: 'BASAL', from: '05:00', to: '06:00', value: 0.25 } });
    const ask = read('baza z 0,05 na 0,1');
    expect(ask?.kind).toBe('ASK');
    if (ask?.kind === 'ASK') {
      expect(ask.chips).toEqual(['Baza 0:00–2:00 na 0,10', 'Baza 10:00–21:00 na 0,10']);
      expect(read(ask.chips[0])).toEqual({ kind: 'REPLAY', change: { setting: 'BASAL', from: '00:00', to: '02:00', value: 0.1 } });
    }
  });

  it('narrows a single target or ISF block to the named time of day', () => {
    expect(read('cel w nocy 100')).toEqual({ kind: 'REPLAY', change: { setting: 'TARGET', from: '00:00', to: '06:00', value: 100 } });
    expect(read('cel na 120')).toEqual({ kind: 'REPLAY', change: { setting: 'TARGET', from: '00:00', to: '00:00', value: 120 } });
    expect(read('ISF w nocy z 190 na 170')).toEqual({ kind: 'REPLAY', change: { setting: 'ISF', from: '00:00', to: '03:30', value: 170 } });
    expect(read('ISF o 4 na 130')).toEqual({ kind: 'REPLAY', change: { setting: 'ISF', from: '03:30', to: '00:00', value: 130 } });
  });

  it('turns an ICR change into one block', () => {
    expect(read('ICR wieczorem na 7,5')).toEqual({ kind: 'REPLAY', change: { setting: 'ICR', from: '18:00', to: '00:00', value: 7.5 } });
  });

  it('leaves other messages alone', () => {
    expect(read('Jaka była baza w nocy?')).toBeNull();
    expect(read('baza na 5')).toBeNull();
    expect(read('w celu sprawdzenia glukozy')).toBeNull();
    expect(read('baza 0,05 na 0,05 o północy')).toBeNull();
  });
});
