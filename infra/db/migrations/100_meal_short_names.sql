-- "Do posiłku: …" on the Bolus tab's given card (owner 2026-11-03): a dose given within 3 hours of a bigger meal can be
-- added to it. The button names that meal by a short name the meal chat's AI gives with each proposal ("Pizza
-- margherita", one to three words). It is shown nowhere else, so it lives apart from the meal record: no revision, no
-- STALE_WRITE check and no description history are touched by it. A meal without one is named by its time.

CREATE TABLE IF NOT EXISTS meal_short_names (
  patient_id uuid NOT NULL,
  meal_record_id uuid NOT NULL,
  short_name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meal_record_id),
  CONSTRAINT meal_short_names_record_fk FOREIGN KEY (meal_record_id, patient_id) REFERENCES meal_records(id, patient_id) ON DELETE CASCADE,
  CONSTRAINT meal_short_names_length_check CHECK (char_length(short_name) BETWEEN 1 AND 32)
);
