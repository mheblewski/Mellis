-- patient_devices.hypo_report_push_enabled: the switch "Podsumowanie po hipo" in the phone's settings. When it is off,
-- the device gets no push after a hypo has ended ("Hipo o 17:08 · najniżej 62 mg/dL", the hypo report form and the
-- hypo question cards). On by default: every phone got this push before the switch existed.

ALTER TABLE patient_devices ADD COLUMN IF NOT EXISTS hypo_report_push_enabled boolean NOT NULL DEFAULT true;
