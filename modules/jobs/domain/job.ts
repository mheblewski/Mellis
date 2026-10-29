/** 'failed' covers a job out of attempts, also one whose lease expired on its last attempt; 'cancelled' is set by the user. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobRecord {
  id: string;
  job_type: string;
  status: JobStatus;
  payload_version: number;
  payload: Record<string, unknown>;
  dedupe_key: string;
  correlation_id: string;
  causation_id: string | null;
  patient_id: string | null;
  available_at: string;
  locked_at: string | null;
  lock_expires_at: string | null;
  locked_by: string | null;
  lease_token: string | null;
  attempts: number;
  max_attempts: number;
  last_error: Record<string, unknown> | null;
  completed_at: string | null;
  failed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobClaim {
  id: string;
  lease_token: string;
  job_type: string;
  payload_version: number;
  payload: Record<string, unknown>;
  correlation_id: string;
  causation_id: string | null;
  patient_id: string | null;
  attempts: number;
  max_attempts: number;
}