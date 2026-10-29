ALTER TABLE events
  ADD COLUMN IF NOT EXISTS event_ingestion_origin text;

UPDATE events
SET event_ingestion_origin = 'LIVE'
WHERE event_ingestion_origin IS NULL;

ALTER TABLE events
  ALTER COLUMN event_ingestion_origin SET DEFAULT 'LIVE';

ALTER TABLE events
  ALTER COLUMN event_ingestion_origin SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'events_ingestion_origin_check'
      AND conrelid = 'events'::regclass
  ) THEN
    ALTER TABLE events
      ADD CONSTRAINT events_ingestion_origin_check
      CHECK (event_ingestion_origin IN ('LIVE', 'HISTORICAL'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS events_patient_ingestion_origin_idx
  ON events (patient_id, event_ingestion_origin, occurred_at DESC);

WITH historical_pending AS (
  SELECT i.id, i.conversation_id
  FROM investigations i
  JOIN events e ON e.id = i.event_id AND e.patient_id = i.patient_id
  WHERE i.state = 'QUESTION_PENDING'
    AND e.event_ingestion_origin = 'HISTORICAL'
)
UPDATE investigations i
SET state = 'FINISHED_NO_QUESTION',
    active_question_id = NULL,
    last_decision = 'FINISH',
    last_decision_reason = 'Migration 017: historical/replay events are analytical-only and not eligible for user-facing pending investigation.',
    updated_at = now()
FROM historical_pending hp
WHERE i.id = hp.id;

WITH historical_conversations AS (
  SELECT DISTINCT i.conversation_id
  FROM investigations i
  JOIN events e ON e.id = i.event_id AND e.patient_id = i.patient_id
  WHERE e.event_ingestion_origin = 'HISTORICAL'
    AND i.state IN ('FINISHED_NO_QUESTION', 'FINISHED_ASK_LATER', 'RESOLVED', 'CLOSED')
)
UPDATE conversations c
SET awaiting_user_answer = false,
    updated_at = now()
FROM historical_conversations hc
WHERE c.id = hc.conversation_id
  AND c.awaiting_user_answer = true;
