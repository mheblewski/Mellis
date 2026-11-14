-- Therapy patterns ("Wzorce", therapy-patterns.v1, docs/product/patterns-and-chat-replay-review.md).
-- The same tables as the family's 920_family_therapy_patterns.sql (idempotent, so a server that already ran 920
-- changes nothing here).
--
-- therapy_pattern_states: one row per patient and pattern key (pattern id, plus the hours for patterns of one time of
-- day). Written by the nightly run: the last result (sentence, numbers, episodes), when it was first and last shown,
-- the push claim (notified_at + the severity it was sent at: the same pattern is sent again only after 28 days or when
-- it is half as bad again), and "Nie dotyczy nas" (dismissed_until).
-- therapy_pattern_threads: "Omów z Mellis" — one conversation per pattern key, shared by the owners.

CREATE TABLE IF NOT EXISTS therapy_pattern_states (
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  pattern_key text NOT NULL,
  pattern_id text NOT NULL,
  shown boolean NOT NULL,
  result jsonb NOT NULL,
  severity double precision NOT NULL DEFAULT 0,
  first_shown_at timestamptz,
  last_shown_at timestamptz,
  computed_at timestamptz NOT NULL,
  notified_at timestamptz,
  notified_severity double precision,
  dismissed_until timestamptz,
  dismissed_by_user_id uuid,
  engine_version text NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  PRIMARY KEY (patient_id, pattern_key)
);

CREATE TABLE IF NOT EXISTS therapy_pattern_threads (
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  pattern_key text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, pattern_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS therapy_pattern_threads_conversation_idx ON therapy_pattern_threads (conversation_id);
