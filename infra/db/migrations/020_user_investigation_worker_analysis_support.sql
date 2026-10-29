ALTER TABLE patient_context
  ALTER COLUMN source_event_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'patient_context_event_unique'
  ) THEN
    ALTER TABLE patient_context
      ADD CONSTRAINT patient_context_event_unique
      UNIQUE (patient_id, fact_key, scope, source_event_id, source_question_id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS patient_context_conversation_unique_idx
  ON patient_context (patient_id, fact_key, scope, source_conversation_id, source_question_id)
  WHERE source_event_id IS NULL;

ALTER TABLE analyses
  ALTER COLUMN episode_id DROP NOT NULL,
  ALTER COLUMN trigger_id DROP NOT NULL;

ALTER TABLE recommendations
  ALTER COLUMN episode_id DROP NOT NULL;