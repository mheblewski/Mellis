-- The reacting Teraz screen (now-situation.v1). What it reads from an open rescue alert: the newest evaluation that
-- flagged it (the forecast state ends two readings later) and when grams were first shown for it (they then stay).
-- Written only while NOW_SITUATION_ENABLED is on. Idempotent: the family server already has these from 909 and 910.
ALTER TABLE rescue_carb_alerts
  ADD COLUMN IF NOT EXISTS situation_last_triggered_at timestamptz,
  ADD COLUMN IF NOT EXISTS situation_grams_since timestamptz;

-- The pushes after a check on the Teraz screen ("Mellis powiadomi"): one per carb entry and result, on all phones.
-- A row is a claim: a send that reached no phone removes it, so the next minute tries again.
CREATE TABLE IF NOT EXISTS now_situation_check_pushes (
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  push_key text NOT NULL,
  kind text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, push_key)
);
