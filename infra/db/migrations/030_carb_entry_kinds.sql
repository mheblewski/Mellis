-- What a Nightscout carb entry really was, set by a caregiver. No row means an ordinary meal (MEAL).
--   MEAL              eaten food
--   CORRECTION_CARBS  "virtual" carbs entered only so the loop keeps delivering insulin after a correction; not eaten
--   HYPO_TREATMENT    fast carbs given to treat a hypo; eaten, but not a meal
-- The Nightscout entry itself (amount, time) is never changed here.
CREATE TABLE IF NOT EXISTS carb_entry_kinds (
  patient_id uuid NOT NULL,
  event_id uuid NOT NULL,
  kind text NOT NULL,
  set_by_user_id uuid NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carb_entry_kinds_pkey PRIMARY KEY (patient_id, event_id),
  CONSTRAINT carb_entry_kinds_event_fk FOREIGN KEY (patient_id, event_id) REFERENCES events(patient_id, id) ON DELETE CASCADE,
  CONSTRAINT carb_entry_kinds_kind_check CHECK (kind IN ('MEAL', 'CORRECTION_CARBS', 'HYPO_TREATMENT'))
);
