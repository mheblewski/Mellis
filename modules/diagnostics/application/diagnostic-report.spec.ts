import { describe, expect, it } from 'vitest';
import { buildDiagnosticReport, type DiagnosticReportStore } from './diagnostic-report';

const NOW = new Date('2026-11-07T12:00:00Z');

const store: DiagnosticReportStore = {
  newestMigration: async () => '109_diagnostic_events.sql',
  patients: async () => [{
    loop_kind: 'TRIO',
    loop_version: null,
    profile_timezone: 'Europe/Warsaw',
    source: { enabled: true, has_token: true, auth_mode: 'ACCESS_TOKEN_JWT', version: '15.0.2', last_observed_at: '2026-11-07T11:55:00Z', credentials_updated_at: '2026-10-01T00:00:00Z' },
    newest_by_type: [{ type: 'GLUCOSE_READING_AVAILABLE', at: '2026-11-07T11:55:00Z' }],
  }],
  devices: async () => ({
    phones: [{ platform: 'ios', app_version: '1.0.33 (1200 · d37e1ab)', patients: 1, active: true, last_seen_at: '2026-11-07T11:00:00Z' }],
    paired_devices: { active: 1, revoked: 0, newest_seen_at: '2026-11-07T11:59:00Z' },
    watches: { active: 0, newest_used_at: null },
  }),
  pushFacts: async () => ({ outbox_open: 2, outbox_errors: [{ name: 'BadDeviceToken', count: 3 }], notifications: [{ name: 'ANSWER_READY:SENT', count: 5 }] }),
  commands: async () => ({
    by_status: [{ name: 'SUCCEEDED', count: 4 }],
    recent: [{ source: 'BOLUS_SCREEN', status: 'NO_REPLY', authorized_at: '2026-11-07T10:00:00.000Z', sent_at: '2026-11-07T10:00:02.000Z', answered_at: null, matched_at: null }],
  }),
  ai: async () => [{ provider: 'anthropic', model: 'claude-opus-4-20250514', task_type: 'answer', status: 'FAILED', error_code: 'TIMEOUT', attempts: 2, p50_ms: 900, p95_ms: 1500, tokens: 1000 }],
  jobs: async () => [{ job_type: 'NIGHTSCOUT_SYNC', status: 'queued', count: 1, oldest_at: '2026-11-07T11:00:00Z', max_attempts: 2 }],
  eventTotals: async () => [{ level: 'warn', event: 'record_rejected', count: 7, last_at: '2026-11-07T11:00:00.000Z' }],
  timeline: async () => [{ source: 'worker', level: 'warn', event: 'record_rejected', fields: { reason: 'BAD_DATE' }, count: 3, first_at: '2026-11-07T10:51:00.000Z', last_at: '2026-11-07T10:59:00.000Z', duration_ms_max: null }],
};

describe('buildDiagnosticReport', () => {
  it('reads as a report of the whole server', async () => {
    const text = await buildDiagnosticReport(store, { MELLIS_VERSION: '1.0.34', AI_PROVIDER: 'anthropic', OPENAI_API_KEY: 'sk-secret', AUTH_MODE: 'device' }, NOW, 600);
    expect(text).toContain('Wersja: 1.0.34 · ostatnia migracja: 109_diagnostic_events');
    expect(text).toContain('działa od 10 min');
    expect(text).toContain('klucz OpenAI: tak');
    expect(text).toContain('Podopieczny 1: pętla TRIO · strefa profilu Europe/Warsaw');
    expect(text).toContain('ostatnie dane 5 min temu');
    expect(text).toContain('Telefon 1: ios, wersja 1.0.33_1200_d37e1ab');
    expect(text).toContain('Błędy kolejki: BadDeviceToken 3');
    expect(text).toContain('BOLUS_SCREEN → NO_REPLY');
    expect(text).toContain('claude-opus-4-20250514 answer FAILED TIMEOUT');
    expect(text).toContain('2026-11-07T10:59:00.000Z worker warn record_rejected reason=BAD_DATE ×3');
  });

  it('prints no value that does not look like a code, and no key', async () => {
    const leaky: DiagnosticReportStore = {
      ...store,
      patients: async () => [{ ...(await store.patients())[0], profile_timezone: 'Kuba i jego dom', loop_version: 'https://secret-host/' }],
      pushFacts: async () => ({ outbox_open: 0, outbox_errors: [{ name: 'dostawa do Kuby: 5,5 j', count: 1 }], notifications: [] }),
      eventTotals: async () => [{ level: 'warn', event: 'Kuba ma hipo', count: 1, last_at: '2026-11-07T11:00:00.000Z' }],
    };
    const text = await buildDiagnosticReport(leaky, { OPENAI_API_KEY: 'sk-secret', AI_PROVIDER: 'https://proxy.secret-host', AUTH_MODE: 'device' }, NOW, null);
    for (const leak of ['Kuba', 'secret-host', 'sk-secret', '5,5 j']) expect(text).not.toContain(leak);
    expect(text).not.toContain('działa od');
  });

  it('keeps the other parts when one part cannot be read', async () => {
    const broken: DiagnosticReportStore = { ...store, ai: async () => { throw Object.assign(new Error('relation missing for Kuba'), { code: '42P01' }); } };
    const text = await buildDiagnosticReport(broken, {}, NOW, null);
    expect(text).toContain('nie udało się odczytać: 42P01');
    expect(text).not.toContain('Kuba');
    expect(text).toContain('ZDARZENIA');
  });
});
