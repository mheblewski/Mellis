import { describe, expect, it } from 'vitest';
import { getGlucoseEvidenceTool } from '@modules/evidence-tools';
import { boundToolResultForProvider, compactSourceRefListsForProvider, PROVIDER_TOOL_RESULT_MAX_BYTES } from './ai-gateway.service';

// Synthetic CGM day (5-min readings, long ids like real Nightscout refs); no patient data.
const PATIENT = '00000000-0000-4000-8000-000000000001';
function glucoseDay(readings: number, spacingMs = 300_000) {
  const start = Date.parse('2026-10-14T00:00:00Z');
  const rows = Array.from({ length: readings }, (_, i) => ({
    observed_at: new Date(start + i * spacingMs).toISOString(),
    glucose_value: 110 + (i % 50),
    validity: 'VALID',
    reading_id: `nightscout:entry:${'a'.repeat(24)}${i}`,
    source_record_id: `nightscout:entries:${'b'.repeat(40)}${i}`,
    provenance_ref: `event/${'c'.repeat(36)}${i}`,
  }));
  const response: any = getGlucoseEvidenceTool.execute(
    { tool: 'get_glucose_evidence', patient_id: PATIENT, time_range: { from: '2026-10-14T00:00:00.000Z', to: '2026-10-14T23:59:59.000Z' }, detail_level: 'TRAJECTORY' } as any,
    { patient_ref: { patient_id: PATIENT }, glucose_evidence: rows },
  );
  return {
    tool: response.tool, status: response.status, evidence: response.evidence, coverage: response.coverage, limitations: response.limitations,
    provenance: { source_refs: response.provenance.source_refs }, content_hash: response.content_hash,
  };
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('provider copy of tool results', () => {
  it('sends each glucose reading of a TRAJECTORY day once, with its reference, within the size bound', () => {
    const raw = glucoseDay(288);
    expect(raw.evidence.detail_window.observations).toHaveLength(288);
    expect(raw.evidence.trajectory.ordered_points).toHaveLength(288);

    const sent: any = boundToolResultForProvider(compactSourceRefListsForProvider(raw));
    expect(sent.status).toBe('KNOWN');
    const first = raw.evidence.detail_window.observations[0];
    expect(sent.evidence.detail_window.readings).toHaveLength(288);
    expect(sent.evidence.detail_window.readings[0]).toEqual([`${first.observed_at.slice(0, 16)}Z`, first.glucose_value]);
    expect(sent.evidence.detail_window.reading_columns).toEqual(['observed_at', 'glucose_mg_dl', 'validity_if_not_valid']);
    expect(sent.evidence.detail_window.reading_refs).toMatchObject({ count: 288, first: first.provenance_ref });
    expect(sent.evidence.detail_window.unit).toBe('mg/dL');
    expect(sent.evidence.trajectory).not.toHaveProperty('ordered_points');
    expect(sent.evidence.trajectory).toMatchObject({
      ordered_points_omitted: 'SAME_READINGS_AS_DETAIL_WINDOW_OBSERVATIONS',
      minimum_point: raw.evidence.trajectory.minimum_point,
      last_glucose_value: raw.evidence.trajectory.last_glucose_value,
    });
    expect(sent.evidence.significant_periods).toEqual(raw.evidence.significant_periods);
    expect(sent.coverage).toEqual(raw.coverage);
    expect(bytes(sent)).toBeLessThanOrEqual(PROVIDER_TOOL_RESULT_MAX_BYTES);
    expect(bytes(sent)).toBeLessThan(bytes(raw) / 4);
  });

  it('replaces a result that is still too large with an explicit stand-in keeping summary, periods and coverage', () => {
    // Much denser than any real CGM day, to exceed the bound inside one 24 h window even in compact rows.
    const raw = glucoseDay(4000, 21_000);
    const sent: any = boundToolResultForProvider(compactSourceRefListsForProvider(raw));
    expect(sent.status).toBe('RESULT_TOO_LARGE');
    expect(sent.original_status).toBe('KNOWN');
    expect(sent.evidence.summary.observation_count).toBe(raw.evidence.summary.observation_count);
    expect(sent.evidence.significant_periods).toEqual(raw.evidence.significant_periods);
    expect(sent.evidence).not.toHaveProperty('detail_window');
    expect(sent.coverage).toEqual(raw.coverage);
    expect(sent.limitations.join(' ')).toContain('Request a narrower time range');
    expect(sent.content_hash).toBe(raw.content_hash);
    expect(bytes(sent)).toBeLessThanOrEqual(PROVIDER_TOOL_RESULT_MAX_BYTES);
  });

  it('keeps the boluses (significant_events) when a too large insulin result becomes the stand-in', () => {
    const event = (i: number, kind: string) => ({ event_id: `e${i}`, event_type: kind, kind, amount: kind === 'SMB' ? 0.1 : 2, unit: 'U', occurred_at: new Date(Date.parse('2026-10-14T00:00:00Z') + i * 60_000).toISOString(), validity: 'VALID', provenance_ref: `event/${'x'.repeat(60)}${i}`, note: 'y'.repeat(40) });
    const boluses = [event(1, 'BOLUS'), event(2, 'BOLUS')];
    const events = [...boluses, ...Array.from({ length: 1200 }, (_, i) => event(i + 10, 'SMB'))];
    const sent: any = boundToolResultForProvider({ tool: 'get_insulin_evidence', status: 'KNOWN', coverage: {}, limitations: [], evidence: { summary: { event_count: events.length }, events, significant_events: boluses } });
    expect(sent.status).toBe('RESULT_TOO_LARGE');
    expect(sent.evidence.significant_events).toHaveLength(2);
    expect(sent.evidence.significant_events[0]).toMatchObject({ amount: 2, occurred_at: '2026-10-14T00:01Z' });
  });

  it('drops ids and default values from event records but keeps every clinical field, with a digest of the ids', () => {
    const insulin = {
      tool: 'get_insulin_evidence', status: 'KNOWN', coverage: {}, limitations: [],
      evidence: {
        summary: { event_count: 2 },
        events: [
          { event_id: 'e1', event_type: 'BOLUS', kind: 'BOLUS', amount: 2, unit: 'U', occurred_at: '2026-10-14T05:54:12.000Z', validity: 'VALID', provenance_ref: 'event/1', relationship_to_meal: 'UNKNOWN' },
          { event_id: 'e2', event_type: 'SMB', kind: 'SMB', amount: 0.1, unit: 'U', occurred_at: '2026-10-14T06:14:00.000Z', validity: 'INVALID', provenance_ref: 'event/2', relationship_to_meal: 'UNKNOWN' },
        ],
      },
    };
    const sent: any = boundToolResultForProvider(insulin);
    expect(sent.evidence.events).toEqual([
      { event_type: 'BOLUS', amount: 2, occurred_at: '2026-10-14T05:54Z' },
      { event_type: 'SMB', amount: 0.1, occurred_at: '2026-10-14T06:14Z', validity: 'INVALID' },
    ]);
    expect(sent.evidence.events_unit).toBe('U');
    expect(sent.evidence.events_refs).toMatchObject({ count: 2, first: 'event/1', last: 'event/2' });
    expect(sent.evidence.summary).toEqual({ event_count: 2 });
  });
});

describe('evidence tool times', () => {
  it('reads a time without an offset in the patient zone, keeps one with an offset or Z', async () => {
    const { toUtcIsoIfParseable } = await import('./ai-gateway.service');
    expect(toUtcIsoIfParseable('2026-10-26T08:00', 'Europe/Warsaw')).toBe('2026-10-26T07:00:00.000Z');
    expect(toUtcIsoIfParseable('2026-10-24T08:00:00', 'Europe/Warsaw')).toBe('2026-10-24T06:00:00.000Z');
    expect(toUtcIsoIfParseable('2026-10-26T08:00+02:00', 'Europe/Warsaw')).toBe('2026-10-26T06:00:00.000Z');
    expect(toUtcIsoIfParseable('2026-10-26T08:00:00Z', 'Europe/Warsaw')).toBe('2026-10-26T08:00:00.000Z');
  });
});
