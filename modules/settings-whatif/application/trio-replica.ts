/**
 * Trio replica (trio-replica.v1): the subset of oref's determine-basal that decides one child's loop, rebuilt from the
 * values Trio logs every cycle (`openaps.suggested` in a Nightscout devicestatus). Used by the settings replay to
 * decide each cycle twice — from the logged state and from a changed one — and add only the difference to what was
 * really delivered (docs/product/settings-whatif-plan.md, "v2 — other settings").
 *
 * Checked on the family export 15 Oct – 11 Nov 2026 (7800 cycles): zero vs non-zero temp agrees in 98 % of cycles
 * (97–99 % per time block), SMB size in 98 % (94–99 %). Rules that were needed for that:
 * - the requested rate is read from the reason text: Trio logs rate 0 when it keeps the running temp;
 * - low guard threshold from the log (80 here, not oref's default 75);
 * - "eventual below target" low temp = basal + 2 × (2 × (eventual − target) / ISF), with oref's minDelta adjustments;
 * - SMB-path low temp is decided from the microbolus before the interval check;
 * - the 5-minute SMB interval counts manual boluses too;
 * - SMB cap (maxBolus) = scheduled basal × 45 min rounded to 0.1 U, without Trio's basal ratio (95 % of logged caps);
 *   max temp = min(4 × basal, max basal).
 */
export const TRIO_REPLICA_POLICY = {
  version: 'trio-replica.v1',
  smb_step_u: 0.1,
  smb_delivery_ratio: 0.5,
  smb_interval_seconds: 300,
  smb_cap_minutes: 45,
  max_basal_default_u_per_h: 1,
  max_temp_multiplier: 4,
  default_threshold_mgdl: 80,
  default_target_mgdl: 110,
  /** An SMB recorded this close before a status belongs to that very cycle. */
  own_cycle_bolus_seconds: 30,
} as const;

const R = TRIO_REPLICA_POLICY;

/** One logged Trio cycle: epoch ms and the `openaps.suggested` object as uploaded. */
export interface TrioCycleRecord {
  ms: number;
  suggested: Record<string, unknown>;
}

export interface OrefReason {
  minPredBG: number | null;
  minGuardBG: number | null;
  maxBolus: number | null;
  maxSafeBasal: number | null;
  maxIob: number | null;
  target: number | null;
  basalRatio: number | null;
  dynamicLimit: number | null;
  dynamicRaw: number | null;
  isfProfile: number | null;
  isfEffective: number | null;
  smbLowTemp: boolean;
  guardTrip: boolean;
}

const numberIn = (pattern: RegExp, text: string): number | null => {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : null;
};

export function parseOrefReason(reason: unknown): OrefReason {
  const text = typeof reason === 'string' ? reason : '';
  const limit = /Dynamic Limit: ([\d.]+) \(([\d.]+)\)/.exec(text);
  const isf = /ISF: ([\d.]+)→([\d.]+)/.exec(text);
  return {
    minPredBG: numberIn(/minPredBG:? (-?\d+(?:\.\d+)?)/, text),
    minGuardBG: numberIn(/minGuardBG:? (-?\d+(?:\.\d+)?)/, text),
    maxBolus: numberIn(/maxBolus:? (\d+(?:\.\d+)?)/, text),
    maxSafeBasal: numberIn(/maxSafeBasal:? (\d+(?:\.\d+)?)/, text),
    maxIob: numberIn(/max_iob:? (\d+(?:\.\d+)?)/, text),
    target: numberIn(/Target: (\d+(?:\.\d+)?)/, text),
    basalRatio: numberIn(/Basal ratio: ([\d.]+)/, text),
    dynamicLimit: limit ? Number(limit[1]) : null,
    dynamicRaw: limit ? Number(limit[2]) : null,
    isfProfile: isf ? Number(isf[1]) : null,
    isfEffective: isf ? Number(isf[2]) : null,
    smbLowTemp: /setting \d+m low temp of/.test(text),
    guardTrip: /minGuardBG -?\d+(?:\.\d+)?<\d+/.test(text),
  };
}

const num = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * The rate Trio asked for. When it keeps the running temp it logs rate 0 / duration 0 and states the request only in
 * the reason text ("temp 0.2 >~ req 0.2U/hr", "setting 120m zero temp", "Setting temp basal of 0.45U/hr").
 */
export function requestedRate(suggested: Record<string, unknown>): number {
  const text = typeof suggested.reason === 'string' ? suggested.reason : '';
  const tail = text.includes(';') ? text.slice(text.indexOf(';') + 1) : text;
  if (/zero temp|low temp of 0U\/h/.test(tail)) return 0;
  const low = /low temp of ([\d.]+)U\/h/.exec(tail);
  if (low) return Number(low[1]);
  const reqs = [...tail.matchAll(/req (-?[\d.]+)U\/hr/g)];
  if (reqs.length > 0) return Math.max(0, Number(reqs[reqs.length - 1][1]));
  const set = /temp basal of ([\d.]+)U\/hr/.exec(tail);
  if (set) return Number(set[1]);
  return num(suggested.rate) ?? 0;
}

export type PredictionCurves = Partial<Record<'IOB' | 'ZT' | 'COB' | 'UAM', number[]>>;

/** A logged cycle in the shape the replay works with. */
export interface TrioCycle {
  ms: number;
  bg: number;
  threshold: number;
  target: number;
  /** Trio's effective ISF this cycle (dynamic ISF already applied), mg/dL per U. */
  sens: number;
  iob: number;
  eventualBG: number | null;
  insulinReq: number;
  minDelta: number;
  expectedDelta: number;
  carbsReq: boolean;
  minGuardBG: number;
  minPredBG: number;
  minIobPredBG: number;
  predictions: PredictionCurves;
  reason: OrefReason;
  /** What Trio really asked for: requested rate (U/h) and the SMB it gave (U). */
  realRate: number;
  realSmb: number;
}

export function readTrioCycle(record: TrioCycleRecord): TrioCycle | null {
  const s = record.suggested;
  const bg = num(s.bg);
  if (bg === null || num(s.rate) === null) return null;
  const reason = parseOrefReason(s.reason);
  const preds: PredictionCurves = {};
  const raw = (s.predBGs ?? {}) as Record<string, unknown>;
  for (const key of ['IOB', 'ZT', 'COB', 'UAM'] as const) {
    const curve = raw[key];
    if (Array.isArray(curve)) {
      const values = curve.map(num).filter((v): v is number => v !== null);
      if (values.length > 0) preds[key] = values;
    }
  }
  const eventual = num(s.eventualBG);
  const iobCurve = preds.IOB ?? [];
  return {
    ms: record.ms,
    bg,
    threshold: num(s.threshold) ?? R.default_threshold_mgdl,
    target: num(s.current_target) ?? reason.target ?? R.default_target_mgdl,
    sens: num(s.ISF) ?? reason.isfEffective ?? 100,
    iob: num(s.IOB) ?? 0,
    eventualBG: eventual,
    insulinReq: num(s.insulinReq) ?? 0,
    minDelta: num(s.minDelta) ?? 0,
    expectedDelta: num(s.expectedDelta) ?? 0,
    carbsReq: Boolean(s.carbsReq),
    minGuardBG: reason.minGuardBG ?? bg,
    minPredBG: reason.minPredBG ?? eventual ?? bg,
    minIobPredBG: iobCurve.length > 1 ? Math.min(...iobCurve.slice(1)) : bg,
    predictions: preds,
    reason,
    realRate: requestedRate(s),
    realSmb: num(s.units) ?? 0,
  };
}

/** Inputs of one decision. */
export interface DecisionInput {
  bg: number;
  threshold: number;
  target: number;
  sens: number;
  eventualBG: number | null;
  minDelta: number;
  expectedDelta: number;
  carbsReq: boolean;
  insulinReq: number;
  minGuardBG: number;
  minIobPredBG: number;
  /** bg − IOB × ISF, rounded. */
  naiveEventualBG: number;
  /** Basal Trio works with this cycle (scheduled × autosens basal ratio), U/h. */
  basal: number;
  maxBolus: number;
  maxSafeBasal: number;
  /** An SMB was given less than the interval ago. */
  waiting: boolean;
}

export type DecisionPath = 'GUARD' | 'EVENTUAL_BELOW' | 'SMB_LOW_TEMP' | 'HIGH';

export interface Decision { rate: number; smb: number; path: DecisionPath }

const round2 = (v: number) => Math.round(v * 100) / 100;

/** oref determine-basal, the subset that decides this loop. Returns the temp rate (U/h) and the SMB (U). */
export function decide(v: DecisionInput): Decision {
  if (v.bg < v.threshold || v.minGuardBG < v.threshold) return { rate: 0, smb: 0, path: 'GUARD' };
  if (v.eventualBG !== null && v.eventualBG < v.target) {
    if (v.minDelta > v.expectedDelta && v.minDelta > 0 && !v.carbsReq) {
      return { rate: v.naiveEventualBG < 40 ? 0 : v.basal, smb: 0, path: 'EVENTUAL_BELOW' };
    }
    let req = v.sens ? 2 * Math.min(0, (v.eventualBG - v.target) / v.sens) : 0;
    if (v.minDelta < 0 && v.minDelta > v.expectedDelta && v.expectedDelta) req *= v.minDelta / v.expectedDelta;
    return { rate: Math.max(0, round2(v.basal + 2 * req)), smb: 0, path: 'EVENTUAL_BELOW' };
  }
  const ireq = v.insulinReq;
  const micro = ireq > 0 ? Math.floor(Math.min(ireq * R.smb_delivery_ratio, v.maxBolus) / R.smb_step_u + 1e-6) * R.smb_step_u : 0;
  const smb = v.waiting ? 0 : micro;
  const worstCase = v.sens ? (v.target - (v.naiveEventualBG + v.minIobPredBG) / 2) / v.sens : 0;
  let duration = v.basal > 0 ? Math.round((60 * worstCase) / v.basal) : 0;
  if (ireq > 0 && micro < R.smb_step_u) duration = 0;
  if (duration > 0) return { rate: duration >= 30 ? 0 : round2((v.basal * duration) / 30), smb, path: 'SMB_LOW_TEMP' };
  return { rate: Math.min(round2(v.basal + 2 * ireq), v.maxSafeBasal), smb, path: 'HIGH' };
}

/** SMB cap from a scheduled basal: basal × 45 min in pump steps (0.05 U/h → 0, 0.10 → 0.1). */
export function smbCapFor(scheduledBasal: number): number {
  return Math.round((scheduledBasal * R.smb_cap_minutes) / 60 * 10 + 1e-9) / 10;
}

/** Floor to pump steps. */
export function pumpSteps(units: number): number {
  return Math.floor(units / R.smb_step_u + 1e-6) * R.smb_step_u;
}

/**
 * The decision input from a logged cycle (decision 0). `scheduledBasal` is the profile basal at that time;
 * `lastBolusMs` the last bolus or SMB before this cycle (for the interval); `maxBasal` the max basal setting.
 */
export function loggedDecisionInput(cycle: TrioCycle, scheduledBasal: number, lastBolusMs: number | null, maxBasal: number): DecisionInput {
  const ratio = cycle.reason.basalRatio ?? 1;
  return {
    bg: cycle.bg,
    threshold: cycle.threshold,
    target: cycle.target,
    sens: cycle.sens,
    eventualBG: cycle.eventualBG,
    minDelta: cycle.minDelta,
    expectedDelta: cycle.expectedDelta,
    carbsReq: cycle.carbsReq,
    insulinReq: cycle.insulinReq,
    minGuardBG: cycle.minGuardBG,
    minIobPredBG: cycle.minIobPredBG,
    naiveEventualBG: Math.round(cycle.bg - cycle.iob * cycle.sens),
    basal: scheduledBasal * ratio,
    maxBolus: cycle.reason.maxBolus ?? smbCapFor(scheduledBasal),
    maxSafeBasal: cycle.reason.maxSafeBasal ?? Math.min(R.max_temp_multiplier * scheduledBasal, maxBasal),
    waiting: lastBolusMs !== null && cycle.ms - lastBolusMs < R.smb_interval_seconds * 1000,
  };
}

/** Max basal seen in the logged caps (maxSafeBasal = min(4 × basal, max basal)), capped at the default. */
export function maxBasalFromCycles(cycles: TrioCycle[]): number {
  let seen = 0;
  for (const c of cycles) if (c.reason.maxSafeBasal !== null) seen = Math.max(seen, c.reason.maxSafeBasal);
  if (seen <= 0) return R.max_basal_default_u_per_h;
  return Math.min(seen, R.max_basal_default_u_per_h);
}

export interface ReplicaAgreement {
  cycles: number;
  zero_vs_nonzero: number;
  smb_equal: number;
  smb_equal_when_any: number;
}

/**
 * V1a gate: how often the rules give Trio's own choice from its logged values. A setting whose mechanism this does not
 * reproduce (gate: zero vs non-zero ≥ 0.90, SMB size ≥ 0.85) gets no replay.
 */
export function replicaAgreement(cycles: TrioCycle[], scheduledBasalAt: (ms: number) => number, bolusMs: number[]): ReplicaAgreement {
  const sorted = [...bolusMs].sort((a, b) => a - b);
  const maxBasal = maxBasalFromCycles(cycles);
  let zn = 0;
  let se = 0;
  let any = 0;
  let anyEq = 0;
  for (const c of cycles) {
    const last = lastBefore(sorted, c.ms - R.own_cycle_bolus_seconds * 1000);
    const d = decide(loggedDecisionInput(c, scheduledBasalAt(c.ms), last, maxBasal));
    if ((d.rate === 0) === (c.realRate === 0)) zn += 1;
    const eq = Math.abs(d.smb - c.realSmb) < 0.05;
    if (eq) se += 1;
    if (d.smb > 0 || c.realSmb > 0) { any += 1; if (eq) anyEq += 1; }
  }
  const n = cycles.length || 1;
  return { cycles: cycles.length, zero_vs_nonzero: zn / n, smb_equal: se / n, smb_equal_when_any: any ? anyEq / any : 1 };
}

/** The last value below `limit` in an ascending list, or null. */
export function lastBefore(sorted: number[], limit: number): number | null {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < limit) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? sorted[lo - 1] : null;
}
