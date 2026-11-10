-- The prediction experiment (Settings → Funkcje eksperymentalne), first part: the low-warning model in the background
-- and its comparison with the rescue rules. An owner turns the experiment on per patient and off at any time; no row
-- means off. Everything is IF NOT EXISTS: a server that ran the same tables under other migration numbers keeps them.

CREATE TABLE IF NOT EXISTS prediction_experiment_optins (
  patient_id uuid PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
  enabled boolean NOT NULL,
  changed_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- Per-patient parameters of a model, refitted about daily.
CREATE TABLE IF NOT EXISTS prediction_params (
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  model_id text NOT NULL,
  params jsonb NOT NULL,
  fitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, model_id)
);

-- People for whom the low-warning model may decide the predicted-low alert (and who get its own test push while it does
-- not). Empty unless the server's owner adds a row by hand after reading the comparison: without one the rescue rules
-- keep deciding and the model only scores in the background.
CREATE TABLE IF NOT EXISTS prediction_low_alert_recipients (
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, user_id)
);

-- The model's score for each reading, kept 60 days, and beside it what the rescue rules say for the same reading.
CREATE TABLE IF NOT EXISTS prediction_low_scores (
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  reading_at timestamptz NOT NULL,
  model_id text NOT NULL,
  glucose_mgdl integer NOT NULL,
  score double precision NOT NULL,
  threshold double precision NOT NULL,
  alarm boolean NOT NULL,
  pushed_to integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, reading_at, model_id)
);
ALTER TABLE prediction_low_scores ADD COLUMN IF NOT EXISTS rules_warning boolean NULL;
CREATE INDEX IF NOT EXISTS prediction_low_scores_created_at_idx ON prediction_low_scores (created_at);

-- One stored comparison per patient (low-comparison.v1), shown under the experiment's switch once there is enough data.
CREATE TABLE IF NOT EXISTS prediction_low_comparisons (
  patient_id uuid PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
  result jsonb NOT NULL,
  computed_at timestamptz NOT NULL,
  -- When the owners were told the comparison is ready (once).
  notified_at timestamptz NULL
);

-- The rescue alert may name the model as its trigger (only for patients listed above, with RESCUE_PREDICTED_LOW_SOURCE=low-risk).
ALTER TABLE rescue_carb_alerts DROP CONSTRAINT IF EXISTS rescue_carb_alerts_source_check;
ALTER TABLE rescue_carb_alerts
  ADD CONSTRAINT rescue_carb_alerts_source_check CHECK (trigger_source IN ('TRIO_CARBS_REQ', 'TRIO_PREDICTION', 'CGM_TREND', 'CGM_LOW', 'LOW_RISK_MODEL'));
