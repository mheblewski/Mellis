import type { Pool } from 'pg';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { diagnosticRecorder } from '../application/diagnostic-recorder';
import { PostgresDiagnosticStore } from './postgres-diagnostic-store';

/** The report's reads, with each patient's time zone from the therapy profile (the cause of a clock an hour off). */
export function serverDiagnosticStore(pool: Pool): PostgresDiagnosticStore {
  const repository = new PostgresGlucoMindRepository(pool);
  return new PostgresDiagnosticStore(pool, async (patientId, atIso) => (await repository.getTherapyProfileAt(patientId, atIso))?.timezone ?? null);
}

/** Called once by main.ts, after the schema check. The worker deletes rows older than the retention period. */
export function startDiagnosticEvents(pool: Pool, source: 'api' | 'worker'): void {
  diagnosticRecorder.record({ level: 'info', event: 'process_started', fields: { kind: source }, duration_ms: null });
  diagnosticRecorder.attach(new PostgresDiagnosticStore(pool), { source, prunes: source === 'worker' });
}
