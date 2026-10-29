import { describe, expect, it, vi } from 'vitest';
import { PostgresNightscoutRepository } from './postgres-nightscout.repository';
import { detectHypo } from '@modules/triggering/application/hypo-detector';

// Offline: the real repository against a recording fake pg client (no database). Pins which tables a new hypo
// episode writes for each ingestion origin.

function recordingPool() {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      statements.push(text);
      if (/^INSERT INTO (hypo_episodes|triggers|conversations|jobs|push_notifications)\b/.test(text)) {
        return { rows: [{ id: String(params[0] ?? 'generated-id') }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client), query: vi.fn() };
  const inserted = () => statements
    .map((text) => /^INSERT INTO ([a-z_]+)/.exec(text)?.[1])
    .filter((table): table is string => Boolean(table));
  return { pool, client, statements, inserted };
}

const reading = {
  reading_id: 'event-1',
  source_record_id: 'source-record-1',
  observed_at: '2026-09-16T10:00:00.000Z',
  recorded_at: '2026-09-16T10:00:00.000Z',
  glucose_value: 55,
  glucose_unit: 'mg/dL' as const,
  classification: 'UNKNOWN' as const,
  relation_to_episode: 'LATEST' as const,
  validity: 'VALID' as const,
  provenance_ref: 'source-record/source-record-1',
};

const detection = detectHypo({
  patient_id: 'patient-1',
  rule_version: 'hypo.cgm.ada2026.v1',
  existing_episode: null,
  reading: { ...reading, classification: 'UNKNOWN' },
});

describe('PostgresNightscoutRepository.persistHypoDetection by ingestion origin (offline)', () => {
  it('stores a new HISTORICAL episode and trigger only: no conversation, no job', async () => {
    const { pool, inserted, statements } = recordingPool();
    const repository = new PostgresNightscoutRepository(pool as never);

    const result = await repository.persistHypoDetection({ patientId: 'patient-1', reading, detection, existingEpisode: null, origin: 'HISTORICAL' });

    expect(detection.status).toBe('HYPO_DETECTED_NEW');
    expect(result).toEqual({ trigger_created: true, episode_created: true });
    expect(inserted()).toEqual(['hypo_episodes', 'triggers']);
    expect(statements.some((text) => /conversations|analysis\.follow_up/.test(text))).toBe(false);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('stores a new LIVE episode and trigger only', async () => {
    const { pool, inserted, statements } = recordingPool();
    const repository = new PostgresNightscoutRepository(pool as never);

    const result = await repository.persistHypoDetection({ patientId: 'patient-1', reading, detection, existingEpisode: null, origin: 'LIVE' });

    expect(result).toEqual({ trigger_created: true, episode_created: true });
    expect(inserted()).toEqual(['hypo_episodes', 'triggers']);
    expect(statements.some((text) => /conversations|analysis\.follow_up/.test(text))).toBe(false);
  });

  const openEpisode = {
    episode_id: 'episode-1',
    state: 'OPEN' as const,
    severity: 'L1' as const,
    started_at: '2026-09-16T10:00:00.000Z',
    ended_at: null,
    latest_reading_id: 'event-1',
    trigger_id: 'trigger-1',
    trigger_rule_version: 'hypo.cgm.ada2026.v1',
    source_event_id: 'event-1',
  };
  const recovery = { ...reading, reading_id: 'event-2', source_record_id: 'source-record-2', observed_at: '2026-09-16T10:25:00.000Z', glucose_value: 82 };
  const closing = detectHypo({ patient_id: 'patient-1', rule_version: 'hypo.cgm.ada2026.v1', existing_episode: openEpisode as never, reading: recovery });

  it('closes an episode without asking anything: no conversation, no push, no analysis', async () => {
    for (const origin of ['LIVE', 'HISTORICAL'] as const) {
      const { pool, inserted, statements } = recordingPool();
      const repository = new PostgresNightscoutRepository(pool as never);
      const result = await repository.persistHypoDetection({ patientId: 'patient-1', reading: recovery, detection: closing, existingEpisode: openEpisode as never, origin });
      expect(closing.status).toBe('NO_HYPO');
      expect(result).toEqual({ trigger_created: false, episode_created: false });
      expect(statements.some((text) => text.startsWith('UPDATE hypo_episodes') && text.includes("state = 'CLOSED'"))).toBe(true);
      expect(inserted()).toEqual([]);
    }
  });

  it('refuses a missing or unknown origin before opening a transaction', async () => {
    for (const origin of [undefined, null, '', 'REPLAY']) {
      const { pool } = recordingPool();
      const repository = new PostgresNightscoutRepository(pool as never);
      await expect(repository.persistHypoDetection({ patientId: 'patient-1', reading, detection, existingEpisode: null, origin: origin as never }))
        .rejects.toThrow('UNKNOWN_EVENT_INGESTION_ORIGIN');
      expect(pool.connect).not.toHaveBeenCalled();
    }
  });
});
