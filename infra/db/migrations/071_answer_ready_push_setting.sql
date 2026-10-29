-- patient_devices.answer_ready_push_enabled: the switch "Gotowa odpowiedź" in the phone's settings. When it is on, the
-- phone of the caregiver who asked gets a push once GlucoMind's answer (main chat, hypo chat or meal chat) is stored,
-- so the caregiver can ask and put the phone away. The app shows no banner while it is open. On by default.

ALTER TABLE patient_devices ADD COLUMN IF NOT EXISTS answer_ready_push_enabled boolean NOT NULL DEFAULT true;
