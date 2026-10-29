-- Any meal whose carbs dropped below what its insulin was given for (owner 2026-10-26: the "za duża dawka" warning for
-- every meal with a bolus, not only a split one): the grams the caregivers were last told about, so a push comes when
-- the excess grows, not on every save.
CREATE TABLE IF NOT EXISTS meal_dose_excess_notices (
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  meal_record_id uuid NOT NULL REFERENCES meal_records(id) ON DELETE CASCADE,
  notified_excess_g integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, meal_record_id)
);
