DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'investigations'::regclass
      AND conname = 'investigations_patient_conversation_unique'
  ) THEN
    ALTER TABLE investigations
      DROP CONSTRAINT investigations_patient_conversation_unique;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS investigations_user_conversation_unique_idx
  ON investigations (patient_id, conversation_id)
  WHERE event_family = 'USER' AND event_id IS NULL;
