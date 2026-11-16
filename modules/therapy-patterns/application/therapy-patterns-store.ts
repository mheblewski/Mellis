import type { Pool } from 'pg';
import { PostgresSettingsWhatIfRepository } from '@infra/db/postgres-settings-whatif.repository';
import { PostgresTherapyPatternsRepository } from '@infra/db/postgres-therapy-patterns.repository';
import type { TherapyPatternsStore } from './therapy-patterns.service';

/** The patterns' store: Trio patients with Nightscout, owners' phones, and the replay data loader. */
export function therapyPatternsStore(pool: Pool): TherapyPatternsStore & { patterns: PostgresTherapyPatternsRepository } {
  const whatIf = new PostgresSettingsWhatIfRepository(pool);
  const patterns = new PostgresTherapyPatternsRepository(pool);
  return {
    patterns,
    listPatientsToAnalyse: () => patterns.listPatientsToAnalyse(),
    getTimezone: (patientId) => patterns.getTimezone(patientId),
    // The insulin curve is not used by the detectors; the Trio log is (loop limits, dynamic ISF).
    loadData: (patientId, endIso, days, timeZone) => whatIf.loadIcrWhatIfData({ patientId, endIso, days, defaultTimeZone: timeZone, peakMinutes: 75, withTrioCycles: true }),
    loadHistory: (patientId, endIso, days, timeZone) => whatIf.loadIcrWhatIfData({ patientId, endIso, days, defaultTimeZone: timeZone, peakMinutes: 75, withTrioCycles: false }),
    lastRunAt: (patientId) => patterns.lastRunAt(patientId),
    listStates: (patientId) => patterns.listStates(patientId),
    saveRun: (patientId, states, computedAt, version) => patterns.saveRun(patientId, states, computedAt, version),
    claimPush: (patientId, key, revision, at, severity) => patterns.claimPush(patientId, key, revision, at, severity),
    latestGlucose: (patientId) => patterns.latestGlucose(patientId),
    getNightCheck: (patientId, date) => patterns.getNightCheck(patientId, date),
    saveNightCheck: (patientId, date, at, result) => patterns.saveNightCheck(patientId, date, at, result),
    claimNightPush: (patientId, date, at) => patterns.claimNightPush(patientId, date, at),
    listOwnerPushDevices: (patientId) => patterns.listOwnerPushDevices(patientId),
    listOwnerOpens: (patientId) => patterns.listOwnerOpens(patientId),
    listNightPushDevices: (patientId) => patterns.listCaregiverNightPushDevices(patientId),
    deactivatePushToken: (token) => patterns.deactivatePushToken(token),
  };
}
