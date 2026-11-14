import { describe, expect, it } from 'vitest';
import {
  decide,
  loggedDecisionInput,
  parseOrefReason,
  readTrioCycle,
  replicaAgreement,
  requestedRate,
  smbCapFor,
  type DecisionInput,
} from './application/trio-replica';

const GUARD_REASON = 'Autosens ratio: 1.2, ISF: 120→100, COB: 5, Dev: 8, BGI: -6, CR: 5, Target: 110, minPredBG -13, minGuardBG -14, IOBpredBG 39, COBpredBG 98, UAMpredBG 39, TDD: 16.35 U, Dynamic ISF: On, Logarithmic formula, Autosens/Dynamic Limit: 1.2 (1.21), AF: 0.9, Basal ratio: 1.03; minGuardBG -14<80 115m left and 0 ~ req 0U/hr: no temp required';
const SMB_REASON = 'Autosens ratio: 1.2, ISF: 120→100, COB: 23, Dev: 155, BGI: -12, CR: 7.7, Target: 110, minPredBG 139, minGuardBG 138, IOBpredBG 152, COBpredBG 179, UAMpredBG 120, TDD: 18.3 U, Dynamic ISF: On, Logarithmic formula, Autosens/Dynamic Limit: 1.2 (1.72), AF: 0.9, Basal ratio: 1.03; Eventual BG 179 >= 110,  insulinReq 0.29; maxBolus 0.1; setting 60m low temp of 0U/h. Microbolusing 0.1U. ';
const CAP_ZERO_REASON = 'Autosens ratio: 1.2, ISF: 120→100, Target: 110, minPredBG 111, minGuardBG 192, Basal ratio: 1.05; Eventual BG 401 >= 110,  insulinReq 0.01; maxBolus 0. 20m@0.20 > 2 * insulinReq. Setting temp basal of 0.05U/hr. . Setting neutral temp basal of 0.05U/hr';

const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  bg: 200, threshold: 80, target: 110, sens: 100, eventualBG: 200, minDelta: 0, expectedDelta: -2, carbsReq: false,
  insulinReq: 0.4, minGuardBG: 150, minIobPredBG: 150, naiveEventualBG: 150, basal: 0.1, maxBolus: 0.1, maxSafeBasal: 0.4,
  waiting: false, ...over,
});

describe('parseOrefReason', () => {
  it('reads the values Trio writes in the reason text', () => {
    const r = parseOrefReason(GUARD_REASON);
    expect(r).toMatchObject({ minPredBG: -13, minGuardBG: -14, target: 110, basalRatio: 1.03, dynamicLimit: 1.2, dynamicRaw: 1.21, isfProfile: 120, isfEffective: 100, guardTrip: true, smbLowTemp: false });
    expect(parseOrefReason(SMB_REASON)).toMatchObject({ maxBolus: 0.1, smbLowTemp: true, guardTrip: false });
    expect(parseOrefReason(CAP_ZERO_REASON).maxBolus).toBe(0);
  });
});

describe('requestedRate', () => {
  it('reads the request from the text, because Trio logs rate 0 when it keeps the running temp', () => {
    expect(requestedRate({ reason: GUARD_REASON, rate: 0.3 })).toBe(0);
    expect(requestedRate({ reason: SMB_REASON, rate: 0.5 })).toBe(0);
    expect(requestedRate({ reason: CAP_ZERO_REASON, rate: 0 })).toBe(0.05);
    expect(requestedRate({ reason: 'x; temp 0.2 >~ req 0.2U/hr: no temp required', rate: 0 })).toBe(0.2);
    expect(requestedRate({ reason: 'nothing here', rate: 0.35 })).toBe(0.35);
  });
});

describe('decide', () => {
  it('holds a zero temp when the forecast minimum is under the threshold', () => {
    expect(decide(input({ minGuardBG: 70 }))).toEqual({ rate: 0, smb: 0, path: 'GUARD' });
    expect(decide(input({ bg: 75 }))).toEqual({ rate: 0, smb: 0, path: 'GUARD' });
  });

  it('lowers the temp when the eventual glucose is below target', () => {
    const d = decide(input({ eventualBG: 90, insulinReq: 0 }));
    // basal + 2 × (2 × (90 − 110) / 100) = 0.1 − 0.8 → 0
    expect(d).toEqual({ rate: 0, smb: 0, path: 'EVENTUAL_BELOW' });
  });

  it('gives no microbolus when the cap is 0 (basal 0.05 × 45 min rounds to 0)', () => {
    const d = decide(input({ basal: 0.05, maxBolus: 0, maxSafeBasal: 0.2, insulinReq: 1 }));
    expect(d.smb).toBe(0);
    expect(d.rate).toBe(0.2);
    expect(d.path).toBe('HIGH');
  });

  it('gives half the insulin needed in 0.1 U steps, up to the cap, and waits 5 minutes after any bolus', () => {
    expect(decide(input({ insulinReq: 0.5, maxBolus: 1 })).smb).toBeCloseTo(0.2, 6);
    expect(decide(input({ insulinReq: 0.5, maxBolus: 0.1 })).smb).toBeCloseTo(0.1, 6);
    expect(decide(input({ insulinReq: 0.5, waiting: true })).smb).toBe(0);
  });

  it('caps the high temp at the max safe basal', () => {
    expect(decide(input({ insulinReq: 2, maxSafeBasal: 0.4 })).rate).toBe(0.4);
  });
});

describe('smbCapFor', () => {
  it('is the scheduled basal × 45 min in 0.1 U steps', () => {
    expect(smbCapFor(0.05)).toBe(0);
    expect(smbCapFor(0.1)).toBe(0.1);
    expect(smbCapFor(0.2)).toBe(0.2);
    expect(smbCapFor(0.3)).toBe(0.2);
    expect(smbCapFor(0.55)).toBe(0.4);
  });
});

describe('replicaAgreement', () => {
  it('reproduces logged choices from logged values', () => {
    const records = [
      { ms: 1_000_000, suggested: { bg: 151, rate: 0, threshold: 80, current_target: 110, ISF: 100, IOB: 1.594, eventualBG: 98, insulinReq: 0, minDelta: 0, expectedDelta: -1.1, reason: GUARD_REASON } },
      { ms: 2_000_000, suggested: { bg: 308, rate: 0, units: 0.1, threshold: 80, current_target: 110, ISF: 100, IOB: 4.467, eventualBG: 179, insulinReq: 0.29, minDelta: 0, expectedDelta: -8.3, reason: SMB_REASON, predBGs: { IOB: [308, 300, 290, 280, 270, 260, 250, 240, 230, 220, 210, 200, 190, 180, 170, 160, 152] } } },
    ];
    const cycles = records.map(readTrioCycle).filter((c) => c !== null);
    expect(cycles).toHaveLength(2);
    const agreement = replicaAgreement(cycles, () => 0.1, []);
    expect(agreement.zero_vs_nonzero).toBe(1);
    expect(agreement.smb_equal).toBe(1);
    const d = decide(loggedDecisionInput(cycles[1], 0.1, null, 1));
    expect(d.smb).toBeCloseTo(0.1, 6);
  });

  it('skips records without glucose or rate', () => {
    expect(readTrioCycle({ ms: 1, suggested: { reason: 'x' } })).toBeNull();
  });
});
