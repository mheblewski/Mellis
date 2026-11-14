/**
 * Settings insights (docs/product/settings-insights-v5.md): the deterministic engine's input and output shapes. The
 * input is plain data already read from the database (no I/O in the analysis), times in epoch milliseconds, glucose in
 * mg/dL, insulin in units. Every analysis function takes the whole input and a thresholds config.
 */

export const SETTINGS_INSIGHTS_ENGINE_VERSION = 'settings-insights.v1';

export interface GlucoseReading { ms: number; value: number }
export interface InsulinDose { ms: number; units: number }
/** A Trio temporary basal: `rate` U/h for `durationMinutes` from `ms` (a later temp cancels it). */
export interface TempBasal { ms: number; rate: number; durationMinutes: number }

export type CarbKind = 'MEAL' | 'HYPO_TREATMENT' | 'CORRECTION_CARBS' | 'UNKNOWN';
export interface CarbEntry {
  ms: number;
  grams: number;
  kind: CarbKind;
  /** True when the meal is marked fatty / protein-heavy (meal record macros or Trio fat/protein fields). */
  fatty: boolean;
}

/** One Trio loop cycle (devicestatus openaps.suggested), deduplicated to one per cycle. */
export interface LoopCycle {
  ms: number;
  bg: number | null;
  iob: number | null;
  cob: number | null;
  eventualBg: number | null;
  insulinReq: number | null;
  /** SMB the loop decided to give in this cycle (U), null when none. */
  smbUnits: number | null;
  /** Temp basal rate set in this cycle (U/h), null when unchanged. */
  rate: number | null;
  /** Parsed from the reason string. */
  minGuardBg: number | null;
  /** The loop's own threshold (from the reason, e.g. "minGuardBG 76<80"), when stated. */
  threshold: number | null;
  /** "maxBolus X" from the reason: the SMB cap of this cycle. */
  maxBolus: number | null;
  /** maxIOB stated in the reason, when present. */
  maxIob: number | null;
  /** "Autosens ratio: X" from the reason (oref scales the basal behind maxBolus by it); null = 1 / unknown. */
  autosensRatio?: number | null;
  smbCapped: boolean;
  smbDisabled: boolean;
  /** Which predicted curve was lowest when minGuardBG blocked insulin (from predBGs). */
  guardCurve: 'IOB' | 'ZT' | 'COB' | 'UAM' | null;
  reason: string;
}

/** A schedule entry: from `minute` of the local day (0–1439) the value applies until the next entry. */
export interface ScheduleEntry { minute: number; value: number }

export interface TherapySchedules {
  basal: ScheduleEntry[];
  /** g/U */
  carbRatio: ScheduleEntry[];
  /** mg/dL per U */
  sensitivity: ScheduleEntry[];
  targetLow: ScheduleEntry[];
  targetHigh: ScheduleEntry[];
  diaHours: number | null;
}

/** A therapy profile valid over [fromMs, toMs) (toMs null = still current). */
export interface TherapyPeriod { fromMs: number; toMs: number | null; schedules: TherapySchedules }

export interface OverridePeriod { ms: number; durationMinutes: number; percentage: number | null; name: string | null }

export type NoteKind = 'ILLNESS' | 'EXERCISE' | 'TRIP' | 'OTHER';
/** A confirmed note (from chat): illness excludes the nights it covers, the rest only flag them. */
export interface CareNote { kind: NoteKind; fromMs: number; toMs: number; createdMs: number }

export interface SettingsInsightsInput {
  patientId: string;
  timezone: string;
  /** Analysis window [fromMs, toMs); normally the last 14 local days up to the last local midnight. */
  fromMs: number;
  toMs: number;
  readings: GlucoseReading[];
  boluses: InsulinDose[];
  smbs: InsulinDose[];
  tempBasals: TempBasal[];
  carbs: CarbEntry[];
  cycles: LoopCycle[];
  therapies: TherapyPeriod[];
  overrides: OverridePeriod[];
  /** Sensor insert times (Nightscout "Sensor Change"/"Sensor Start"). */
  sensorStarts: number[];
  /** Infusion site changes (Nightscout "Site Change"), when loaded; only the AI analyst's data pack reads them (site age). */
  siteChanges?: number[];
  notes: CareNote[];
  /** Pump bolus/SMB step (U); 0.05 when unknown. */
  pumpStep: number;
  /** Trio settings not in the Nightscout profile, when known (read indirectly from loop records). */
  advanced: { maxSmbBasalMinutes: number | null; maxUamSmbBasalMinutes: number | null; maxIob: number | null; dynamicIsf: boolean | null };
}

/** A local night (00:00–06:00 of `date`) and why it is or is not counted. */
export interface NightStatus {
  /** Local date of the night, YYYY-MM-DD. */
  date: string;
  startMs: number;
  sensorCoverage: number;
  loopCoverage: number;
  excluded: boolean;
  reasons: Array<'SENSOR_GAP' | 'SENSOR_DAY_1' | 'ILLNESS' | 'OVERRIDE' | 'LOOP_GAP'>;
  flags: Array<'EXERCISE' | 'TRIP' | 'OTHER_NOTE' | 'OVERRIDE'>;
}

export interface TimeInRange {
  readings: number;
  /** Shares 0–1: < 54, 54–69, 70–180, 181–250, > 250. */
  veryLow: number;
  low: number;
  inRange: number;
  high: number;
  veryHigh: number;
  meanMgdl: number | null;
  gmiPercent: number | null;
  cvPercent: number | null;
  sensorCoverage: number;
}

/** AGP: 96 slots of 15 minutes, percentiles of every day's readings in that slot. */
export interface AgpSlot { minute: number; n: number; p5: number | null; p25: number | null; p50: number | null; p75: number | null; p95: number | null }

export type Confidence = 'GOOD' | 'MODERATE' | 'LOW';
export type SettingKind = 'BASAL' | 'CARB_RATIO' | 'SENSITIVITY' | 'TARGET' | 'MAX_UAM_SMB_MINUTES' | 'MAX_SMB_MINUTES' | 'MAX_IOB';
/** Direction in insulin terms: does the change give more or less insulin? */
export type InsulinDirection = 'MORE' | 'LESS';

/** A time window of the local day, [startMinute, endMinute) with endMinute up to 1440; global = whole day. */
export interface DayWindow { startMinute: number; endMinute: number }

export interface ProposalEvidence {
  /** Plain numbers shown in "Na czym to opieramy" (stable keys, the app formats them). */
  [key: string]: number | string | boolean | null | Array<Record<string, number | string | boolean | null>>;
}

export interface SettingsProposal {
  kind: SettingKind;
  /** The schedule block (local minutes) or null for a global setting. */
  window: DayWindow | null;
  from: number;
  to: number;
  /** Signed relative change, e.g. -0.17. */
  relativeChange: number;
  direction: InsulinDirection;
  confidence: Confidence;
  /** n qualifying situations behind it. */
  n: number;
  /** Half-block segment proposal (30 min) when the full step would exceed what the confidence allows. */
  segment: DayWindow | null;
  /** Priority rank: lower first (hypo issues first). */
  rank: number;
  /** Stable code of the reason, e.g. BASAL_TOO_HIGH_NIGHT_LOWS. */
  reasonCode: string;
  evidence: ProposalEvidence;
}

/** Why a lever produced no proposal (shown as "obserwujemy" / refusals). */
export interface LeverRefusal {
  kind: SettingKind;
  window: DayWindow | null;
  code: string;
  evidence: ProposalEvidence;
}

/** An issue sent to "Na wizytę" instead of a proposal. */
export interface ClinicItem { code: string; evidence: ProposalEvidence }

/** What one lever (basal, ICR, ISF, target, advanced) produced for the whole window. */
export interface LeverResult { proposals: SettingsProposal[]; refusals: LeverRefusal[]; clinic: ClinicItem[] }

/** Data quality of the window (v5 §7.2), computed once and passed to every lever. */
export interface DataQuality {
  sensorCoverage: number;
  loopCoverage: number;
  nights: NightStatus[];
  /** Local dates excluded from analysis (illness, sensor day 1, isolated override days). */
  excludedDates: string[];
  excludedShare: number;
  /** Overrides on more than the threshold share of nights: effective settings analysed, said so. */
  habitualOverrides: boolean;
  /** Set when no proposal may be made from this window at all. */
  paused: null | 'LOOP_COVERAGE' | 'SENSOR_COVERAGE' | 'TOO_MANY_EXCLUDED';
}
