-- The hypo report form stores structured answers (activity timing, grams of rescue carbs) as one JSON value per fact.
ALTER TABLE patient_context
  DROP CONSTRAINT IF EXISTS patient_context_value_type_check;

ALTER TABLE patient_context
  ADD CONSTRAINT patient_context_value_type_check
  CHECK (value_type IN ('BOOLEAN', 'TEXT', 'NULL', 'JSON'));

-- The form reads and analyses join a hypo's facts by its episode.
CREATE INDEX IF NOT EXISTS patient_context_related_episode_idx
  ON patient_context (patient_id, related_episode_id, fact_key)
  WHERE related_episode_id IS NOT NULL;
