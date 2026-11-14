-- "Nowy" on a pattern until its caregiver opens it (owner 2026-11-14), instead of 7 days after it was first shown.
-- One row per patient, pattern key and caregiver: when that caregiver last opened the pattern's card. A pattern that
-- comes back after 28 days starts with a new first_shown_at, so an older open no longer counts and it is new again.

CREATE TABLE IF NOT EXISTS therapy_pattern_opens (
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  pattern_key text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opened_at timestamptz NOT NULL,
  PRIMARY KEY (patient_id, pattern_key, user_id)
);
