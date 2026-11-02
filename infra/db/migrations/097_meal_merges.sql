-- "Scal" in the Meals tab (meal-merge.v1, owner 2026-11-01): several meals of the journal become one. The merged meal
-- is one of them (the one with the planned later part, else the one with a description or values, else the earliest);
-- the others' entries, boluses, reminders, parts, photos and chat move to it and their records are deleted.
--
-- meal_merges: one row per merge, for the audit and so a merged meal stays in the journal even when its description
-- and values were reset (several of the meals had their own, the caregiver enters them again). merged_meal_ids are the
-- deleted records' ids (no foreign key: they are gone).

CREATE TABLE IF NOT EXISTS meal_merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  meal_record_id uuid NOT NULL,
  merged_meal_ids uuid[] NOT NULL,
  -- RESET: several meals had a description or values, the merged meal has none; KEPT: one meal's were kept; NONE: none had any.
  content text NOT NULL,
  -- KEEP: the one split meal's later parts stay; RESPLIT: they were skipped for a new split in the chat; NULL: no split.
  split text NULL,
  merged_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  merged_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_merges_record_fk FOREIGN KEY (meal_record_id, patient_id) REFERENCES meal_records(id, patient_id) ON DELETE CASCADE,
  CONSTRAINT meal_merges_content_check CHECK (content IN ('RESET', 'KEPT', 'NONE')),
  CONSTRAINT meal_merges_split_check CHECK (split IS NULL OR split IN ('KEEP', 'RESPLIT')),
  CONSTRAINT meal_merges_merged_ids_check CHECK (cardinality(merged_meal_ids) >= 1)
);

CREATE INDEX IF NOT EXISTS meal_merges_record_idx ON meal_merges (meal_record_id);
