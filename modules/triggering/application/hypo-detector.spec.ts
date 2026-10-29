import { classifyGlucoseReading, detectHypo, HYPO_NEW_FLOW_MAX_READING_AGE_MINUTES, isReadingTooStaleToStartHypoFlow } from './hypo-detector';

function reading(glucose: number, observedAt: string, sourceRecordId: string): Parameters<typeof detectHypo>[0]['reading'] {
  return {
    reading_id: sourceRecordId,
    source_record_id: sourceRecordId,
    observed_at: observedAt,
    recorded_at: observedAt,
    glucose_value: glucose,
    glucose_unit: 'mg/dL',
    classification: 'UNKNOWN',
    relation_to_episode: 'LATEST',
    validity: 'VALID',
    provenance_ref: `src/${sourceRecordId}`,
  };
}

function readingWithDistinctIds(glucose: number, observedAt: string, readingId: string, sourceRecordId: string): Parameters<typeof detectHypo>[0]['reading'] {
  return {
    reading_id: readingId,
    source_record_id: sourceRecordId,
    observed_at: observedAt,
    recorded_at: observedAt,
    glucose_value: glucose,
    glucose_unit: 'mg/dL',
    classification: 'UNKNOWN',
    relation_to_episode: 'LATEST',
    validity: 'VALID',
    provenance_ref: `src/${sourceRecordId}`,
  };
}

describe('hypo detector', () => {
  it('classifies 69 and 54 as L1, 53 as L2, 70 as normal', () => {
    expect(detectHypo({ patient_id: 'pat_1', rule_version: 'hypo.cgm.ada2026.v1', existing_episode: null, reading: reading(69, '2026-09-16T20:00:00.000Z', 'r1') }).status).toBe('HYPO_DETECTED_NEW');
    expect(detectHypo({ patient_id: 'pat_1', rule_version: 'hypo.cgm.ada2026.v1', existing_episode: null, reading: reading(54, '2026-09-16T20:00:00.000Z', 'r2') }).severity).toBe('L1');
    expect(detectHypo({ patient_id: 'pat_1', rule_version: 'hypo.cgm.ada2026.v1', existing_episode: null, reading: reading(53, '2026-09-16T20:00:00.000Z', 'r3') }).severity).toBe('L2');
    expect(detectHypo({ patient_id: 'pat_1', rule_version: 'hypo.cgm.ada2026.v1', existing_episode: null, reading: reading(70, '2026-09-16T20:00:00.000Z', 'r4') }).status).toBe('NO_HYPO');
  });

  it('starts on a single hypo reading and continues across subsequent low readings', () => {
    const started = detectHypo({ patient_id: 'pat_1', rule_version: 'hypo.cgm.ada2026.v1', existing_episode: null, reading: reading(68, '2026-09-16T20:00:00.000Z', 'r1') });
    expect(started.status).toBe('HYPO_DETECTED_NEW');
    expect(started.trigger).not.toBeNull();

    const ongoing = detectHypo({ patient_id: 'pat_1', rule_version: 'hypo.cgm.ada2026.v1', existing_episode: started.episode, reading: reading(61, '2026-09-16T20:05:00.000Z', 'r2') });
    expect(ongoing.status).toBe('HYPO_ONGOING');
    expect(ongoing.trigger).toBeNull();
  });

  it('escalates L1 to L2', () => {
    const started = detectHypo({ patient_id: 'pat_1', rule_version: 'hypo.cgm.ada2026.v1', existing_episode: null, reading: reading(66, '2026-09-16T20:00:00.000Z', 'r1') });
    const ongoing = detectHypo({ patient_id: 'pat_1', rule_version: 'hypo.cgm.ada2026.v1', existing_episode: started.episode, reading: reading(52, '2026-09-16T20:05:00.000Z', 'r2') });
    expect(ongoing.severity).toBe('L2');
    expect(ongoing.status).toBe('HYPO_ONGOING');
  });

  it('closes an open episode on a normal reading', () => {
    const started = detectHypo({ patient_id: 'pat_1', rule_version: 'hypo.cgm.ada2026.v1', existing_episode: null, reading: reading(66, '2026-09-16T20:00:00.000Z', 'r1') });
    const closed = detectHypo({ patient_id: 'pat_1', rule_version: 'hypo.cgm.ada2026.v1', existing_episode: started.episode, reading: reading(90, '2026-09-16T20:05:00.000Z', 'r2') });
    expect(closed.status).toBe('NO_HYPO');
    expect(closed.episode?.state).toBe('CLOSED');
  });

  it('preserves the open episode across a CGM gap until a new reading arrives', () => {
    const started = detectHypo({ patient_id: 'pat_1', rule_version: 'hypo.cgm.ada2026.v1', existing_episode: null, reading: reading(66, '2026-09-16T20:00:00.000Z', 'r1') });
    const afterGap = detectHypo({ patient_id: 'pat_1', rule_version: 'hypo.cgm.ada2026.v1', existing_episode: started.episode, reading: reading(62, '2026-09-16T20:20:00.000Z', 'r2') });
    expect(afterGap.status).toBe('HYPO_ONGOING');
    expect(afterGap.episode?.state).toBe('OPEN');
  });

  it('returns insufficient data for invalid readings', () => {
    const result = detectHypo({
      patient_id: 'pat_1',
      rule_version: 'hypo.cgm.ada2026.v1',
      existing_episode: null,
      reading: {
        ...reading(66, '2026-09-16T20:00:00.000Z', 'r1'),
        validity: 'INVALID',
      },
    });
    expect(result.status).toBe('INSUFFICIENT_DATA');
  });

  it('uses reading_id as canonical source_event_id', () => {
    const result = detectHypo({
      patient_id: 'pat_1',
      rule_version: 'hypo.cgm.ada2026.v1',
      existing_episode: null,
      reading: readingWithDistinctIds(66, '2026-09-16T20:00:00.000Z', 'evt-1', 'src-1'),
    });

    expect(result.trigger?.source_event_id).toBe('evt-1');
    expect(result.episode?.source_event_id).toBe('evt-1');
  });

  it('marks a reading as too stale to start a hypo flow only beyond 30 minutes, without changing classification', () => {
    expect(HYPO_NEW_FLOW_MAX_READING_AGE_MINUTES).toBe(30);
    expect(isReadingTooStaleToStartHypoFlow({ observed_at: '2026-09-16T20:00:00.000Z' }, '2026-09-16T20:30:00.000Z')).toBe(false);
    expect(isReadingTooStaleToStartHypoFlow({ observed_at: '2026-09-16T20:00:00.000Z' }, '2026-09-16T20:30:00.001Z')).toBe(true);
    expect(isReadingTooStaleToStartHypoFlow({ observed_at: 'not-a-date' }, '2026-09-16T20:30:00.000Z')).toBe(true);
    expect(classifyGlucoseReading(69)).toBe('L1');
    expect(classifyGlucoseReading(53)).toBe('L2');
    expect(classifyGlucoseReading(70)).toBe('NORMAL');
  });
});
