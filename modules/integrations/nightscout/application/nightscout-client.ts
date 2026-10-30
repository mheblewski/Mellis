export interface NightscoutEntryDto {
  _id?: string;
  id?: string;
  eventId?: string;
  date?: number | string;
  dateString?: string;
  sysTime?: string;
  patient?: string;
  patientId?: string;
  source?: string;
  device?: string;
  type?: string;
  sgv?: number | string;
  glucose?: number | string;
  value?: number | string;
  units?: string;
  unit?: string;
  displayUnits?: string;
  direction?: string;
  delta?: number | string;
  noise?: number | string;
  utcOffset?: number | string;
  created_at?: string;
  enteredBy?: string;
  [key: string]: unknown;
}

export interface FetchEntriesInput {
  patient_id: string;
  cursor: string | null;
  limit: number;
  /** Exclusive upper bound (ISO): the look-back fetch for late uploads reads [cursor, before). */
  before?: string | null;
}

export interface FetchEntriesResult {
  entries: NightscoutEntryDto[];
  next_cursor: string | null;
}

export interface NightscoutTreatmentDto {
  _id?: string;
  id?: string;
  eventId?: string;
  eventType?: string;
  eventtype?: string;
  type?: string;
  created_at?: string;
  timestamp?: string;
  patient?: string;
  patientId?: string;
  enteredBy?: string;
  carbs?: number | string;
  insulin?: number | string;
  enteredInsulin?: number | string;
  rate?: number | string;
  absolute?: number | string;
  duration?: number | string;
  utcOffset?: number | string;
  notes?: string;
  [key: string]: unknown;
}

export interface NightscoutDeviceStatusDto {
  _id?: string;
  id?: string;
  eventId?: string;
  created_at?: string;
  timestamp?: string;
  date?: number | string;
  dateString?: string;
  sysTime?: string;
  patient?: string;
  patientId?: string;
  device?: string;
  openaps?: {
    iob?: {
      iob?: number | string;
      bolusiob?: number | string;
      cob?: number | string;
      [key: string]: unknown;
    };
    suggested?: {
      IOB?: number | string;
      iob?: number | string;
      COB?: number | string;
      cob?: number | string;
      [key: string]: unknown;
    };
    enacted?: {
      IOB?: number | string;
      iob?: number | string;
      COB?: number | string;
      cob?: number | string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface FetchTreatmentsInput {
  patient_id: string;
  cursor: string | null;
  limit: number;
  /** Exclusive upper bound (ISO): the look-back fetch for late uploads reads [cursor, before). */
  before?: string | null;
}

export interface FetchTreatmentsResult {
  treatments: NightscoutTreatmentDto[];
  next_cursor: string | null;
}

export interface FetchDeviceStatusesInput {
  patient_id: string;
  cursor: string | null;
  limit: number;
  /** Exclusive upper bound (ISO): the history import reads [cursor, before). */
  before?: string | null;
}

export interface FetchDeviceStatusesResult {
  device_statuses: NightscoutDeviceStatusDto[];
  next_cursor: string | null;
}

export interface NightscoutProfileDto {
  _id?: string;
  id?: string;
  patient?: string;
  patientId?: string;
  defaultProfile?: string;
  profile?: Record<string, unknown>;
  store?: Record<string, unknown>;
  timezone?: string;
  units?: string;
  startDate?: number | string;
  endDate?: number | string;
  [key: string]: unknown;
}

export interface FetchProfilesInput {
  patient_id: string;
  cursor: string | null;
  limit: number;
}

export interface FetchProfilesResult {
  profiles: NightscoutProfileDto[];
  next_cursor: string | null;
}

export interface NightscoutClient {
  fetchEntries(input: FetchEntriesInput): Promise<FetchEntriesResult>;
  fetchTreatments(input: FetchTreatmentsInput): Promise<FetchTreatmentsResult>;
  fetchDeviceStatuses(input: FetchDeviceStatusesInput): Promise<FetchDeviceStatusesResult>;
  fetchProfiles(input: FetchProfilesInput): Promise<FetchProfilesResult>;
}

export const NIGHTSCOUT_CLIENT = Symbol('NIGHTSCOUT_CLIENT');