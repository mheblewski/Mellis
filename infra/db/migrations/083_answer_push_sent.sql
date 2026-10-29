-- One "Odpowiedź gotowa" / "Nie udało się odpowiedzieć" push per question (answer-ready-push.v1, audit 2026-10-26).
-- A job that ran past its 300 s lease was claimed again, run again and pushed "ready" a second time; the worker now
-- claims the push here (one row per question message and outcome) before sending it, so a rerun pushes nothing.
CREATE TABLE IF NOT EXISTS answer_push_sent (
  question_message_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('ready', 'failed')),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (question_message_id, outcome)
);

CREATE INDEX IF NOT EXISTS answer_push_sent_patient_idx ON answer_push_sent (patient_id);
