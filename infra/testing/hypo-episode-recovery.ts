import { detectHypo } from '@modules/triggering/application/hypo-detector';
import type { Pool } from 'pg';
import type { PostgresNightscoutRepository } from '@infra/db/postgres-nightscout.repository';

type LiveReading = Parameters<PostgresNightscoutRepository['persistHypoDetection']>[0]['reading'];

/**
 * Test seed: a LIVE caregiver conversation starts only when the hypo episode closes. Persists the low reading, then
 * closes the open episode with a recovery (>= 70 mg/dL) on the same event, so tests that need the hypo conversation
 * get it the way production does.
 */
export async function persistLiveHypoUntilRecovered(
  repository: PostgresNightscoutRepository,
  args: { patientId: string; reading: LiveReading; detection: ReturnType<typeof detectHypo>; existingEpisode: Parameters<PostgresNightscoutRepository['persistHypoDetection']>[0]['existingEpisode'] },
): Promise<void> {
  await repository.persistHypoDetection({ ...args, origin: 'LIVE' });
  // Legacy-replay tests persist a HISTORICAL event with origin LIVE: its episode is found under the event's origin.
  const openEpisode = (await repository.getLatestOpenHypoEpisode(args.patientId, 'LIVE'))
    ?? (await repository.getLatestOpenHypoEpisode(args.patientId, 'HISTORICAL'));
  if (!openEpisode) {
    return;
  }
  // Five minutes later, as the next CGM reading would be (the episode window then includes the low reading).
  const recovery = { ...args.reading, glucose_value: 95, observed_at: new Date(Date.parse(args.reading.observed_at) + 5 * 60_000).toISOString() };
  const closing = detectHypo({ patient_id: args.patientId, rule_version: 'hypo.cgm.ada2026.v1', existing_episode: openEpisode, reading: recovery });
  await repository.persistHypoDetection({ patientId: args.patientId, reading: recovery, detection: closing, existingEpisode: openEpisode, origin: 'LIVE' });
}

/**
 * Test seed: the caregiver conversation a closed LIVE hypo got before 2026-10-25 (e3acc11), inserted as that code did.
 * Hypo detection no longer starts one, but older conversations still run the investigation questions and their pushes,
 * which the tests using this keep covering until the cleanup stage removes them.
 */
export async function seedLegacyHypoConversation(pool: Pick<Pool, 'query'>, args: { patientId: string; sourceEventId: string }): Promise<{ conversationId: string; triggerId: string; episodeId: string }> {
  const trigger = await pool.query<{ trigger_id: string; episode_id: string; trigger_type: string }>(
    `SELECT t.id::text AS trigger_id, t.episode_id::text AS episode_id, t.type AS trigger_type
     FROM triggers t WHERE t.patient_id = $1::uuid AND t.source_event_id = $2::uuid AND t.episode_id IS NOT NULL
     ORDER BY t.created_at DESC LIMIT 1`,
    [args.patientId, args.sourceEventId],
  );
  const row = trigger.rows[0];
  if (!row) throw new Error('TRIGGER_NOT_FOUND_FOR_EVENT');
  const conversation = await pool.query<{ id: string }>(
    `INSERT INTO conversations (patient_id, episode_id, trigger_id, origin, trigger_type, thread_state_version, awaiting_user_answer, conversation_type)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'SYSTEM', $4, 'conv-v1', false, 'TRIGGER_INITIATED')
     ON CONFLICT (patient_id, episode_id) DO UPDATE SET trigger_id = EXCLUDED.trigger_id, updated_at = now()
     RETURNING id::text AS id`,
    [args.patientId, row.episode_id, row.trigger_id, row.trigger_type],
  );
  return { conversationId: conversation.rows[0].id, triggerId: row.trigger_id, episodeId: row.episode_id };
}
