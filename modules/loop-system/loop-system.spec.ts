import { describe, expect, it } from 'vitest';
import { parseLoopPrediction } from './application/loop-prediction';
import { readEnactedTempBasal, readLoopValues } from './application/loop-status';
import { patientLoopSystem } from './application/patient-loop-system';
import { agree, capitalized, computesWithOref, remoteCommandDriver, detectLoopSystem, loopSystemLabel, loopSystemNames } from './domain/loop-system';

const AT = '2026-10-28T12:00:00.000Z';

/** Shapes as the systems upload them (Trio: test-env devicestatus; Loop: NightscoutKit LoopStatus; AAPS: its uploader). */
const trio = { device: 'Trio', openaps: { iob: { iob: 1.4 }, suggested: { timestamp: AT, bg: 120, IOB: 1.4, COB: 12, carbsReq: 0, predBGs: { IOB: [120, 118] } }, enacted: { timestamp: AT, rate: 0.5, duration: 30, COB: 14 } } };
const loop = {
  device: 'loop://iPhone',
  loop: {
    name: 'Loop', version: '3.14.11', timestamp: AT,
    iob: { timestamp: AT, iob: 2.1 }, cob: { timestamp: AT, cob: 30 },
    predicted: { startDate: AT, values: [140, 150, 160] },
    enacted: { rate: 1.2, duration: 30, timestamp: AT, received: true, bolusVolume: 0 },
  },
};
const aaps = { device: 'openaps://AndroidAPS', openaps: { suggested: { timestamp: AT, IOB: 0.8, COB: 0 } } };

describe('loop system detection', () => {
  it('tells Trio, AAPS, other oref uploaders and Loop apart from one devicestatus', () => {
    expect(detectLoopSystem(trio)).toEqual({ kind: 'TRIO', version: null });
    expect(detectLoopSystem(loop)).toEqual({ kind: 'LOOP', version: '3.14.11' });
    expect(detectLoopSystem(aaps)).toEqual({ kind: 'AAPS', version: null });
    expect(detectLoopSystem({ device: 'openaps://rig', openaps: {} }).kind).toBe('OPENAPS');
    // A pump-only record or nothing at all says nothing about the loop.
    expect(detectLoopSystem({ device: 'Trio', pump: { reservoir: 100 } }).kind).toBe('UNKNOWN');
    expect(detectLoopSystem(null).kind).toBe('UNKNOWN');
  });

  it('says which systems compute with oref and which take GlucoMind\'s commands', () => {
    expect(['TRIO', 'AAPS', 'OPENAPS', 'LOOP', 'UNKNOWN'].map((kind) => computesWithOref(kind as any))).toEqual([true, true, true, false, false]);
    // UNKNOWN keeps a configured Trio working while its devicestatus is missing; the phone checks the pinned Trio anyway.
    expect(['TRIO', 'AAPS', 'OPENAPS', 'LOOP', 'UNKNOWN'].map((kind) => remoteCommandDriver(kind as any))).toEqual(['TRIO', null, null, 'LOOP', 'TRIO']);
  });

  it('names the system in the Polish forms texts need, and in English for the model', () => {
    expect(loopSystemNames('TRIO')).toEqual({ nominative: 'Trio', locative: 'Trio', genitive: 'Trio', gender: 'n' });
    expect(loopSystemNames('LOOP')).toEqual({ nominative: 'Loop', locative: 'Loopie', genitive: 'Loopa', gender: 'm' });
    expect(loopSystemNames('UNKNOWN')).toEqual({ nominative: 'pętla', locative: 'pętli', genitive: 'pętli', gender: 'f' });
    const said = (kind: 'TRIO' | 'LOOP' | 'UNKNOWN') => `${capitalized(loopSystemNames(kind).nominative)} ${agree(loopSystemNames(kind), { m: 'odrzucił', f: 'odrzuciła', n: 'odrzuciło' })}`;
    expect([said('TRIO'), said('LOOP'), said('UNKNOWN')]).toEqual(['Trio odrzuciło', 'Loop odrzucił', 'Pętla odrzuciła']);
    expect([loopSystemLabel('LOOP'), loopSystemLabel('UNKNOWN')]).toEqual(['Loop', 'the loop']);
  });

  it('reads the patient\'s system from the newest loop calculation', async () => {
    expect((await patientLoopSystem({ getLatestLoopStatus: async () => ({ raw_payload: loop }) }, 'p1')).kind).toBe('LOOP');
    expect((await patientLoopSystem({ getLatestLoopStatus: async () => null }, 'p1')).kind).toBe('UNKNOWN');
  });
});

describe('loop status readers', () => {
  it('reads IOB and COB of oref and Loop; the oref suggestion wins over the last enacted calculation', () => {
    expect(readLoopValues(trio)).toEqual({ iob_u: 1.4, cob_g: 12 });
    expect(readLoopValues(loop)).toEqual({ iob_u: 2.1, cob_g: 30 });
    expect(readLoopValues({ pump: {} })).toEqual({ iob_u: null, cob_g: null });
  });

  it('reads the temp basal the loop set, Loop\'s included', () => {
    expect(readEnactedTempBasal(trio)).toEqual({ rate_u_per_h: 0.5, duration_minutes: 30, set_at: AT });
    expect(readEnactedTempBasal(loop)).toEqual({ rate_u_per_h: 1.2, duration_minutes: 30, set_at: AT });
    expect(readEnactedTempBasal(aaps)).toBeNull();
  });

  it('tags the forecast with the system that computed it', () => {
    expect(parseLoopPrediction({ observed_at: AT, raw_payload: trio })).toMatchObject({ source: 'OPENAPS', system: 'TRIO' });
    expect(parseLoopPrediction({ observed_at: AT, raw_payload: aaps })).toMatchObject({ source: 'OPENAPS', system: 'AAPS' });
    expect(parseLoopPrediction({ observed_at: AT, raw_payload: loop })).toMatchObject({
      source: 'LOOP', system: 'LOOP', iob_u: 2.1, cob_g: 30, carbs_req_g: null, eventual_bg: 160, curves: { IOB: [140, 150, 160] },
    });
  });
});
