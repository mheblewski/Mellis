-- The prediction experiment, second part: what the experimental line said at each new reading beside the loop's main
-- curve, kept 60 days, so it can be scored against what really happened. Written only while an owner has the experiment
-- on for the patient. IF NOT EXISTS: a server that already has the table under another migration number keeps it.
CREATE TABLE IF NOT EXISTS prediction_log (
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  reading_at timestamptz NOT NULL,
  model_id text NOT NULL,
  glucose_mgdl integer NOT NULL,
  points jsonb NOT NULL,
  loop_main jsonb NULL,
  after_carbs boolean NOT NULL,
  hidden_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, reading_at, model_id)
);

CREATE INDEX IF NOT EXISTS prediction_log_created_at_idx ON prediction_log (created_at);
