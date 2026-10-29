-- users.ai_role / users.ai_instructions: the user's own instructions for the AI ("Moje instrukcje dla AI" in Settings).
-- Per user, not per patient: who is writing (a parent, a grandparent, a kindergarten or school caregiver, the patient
-- themself, a clinician, someone else) and free-text wishes (tone, level of detail), up to 500 characters. The AI reads
-- them as one low-priority line below every safety and dosing rule. NULL = not set. users.custom_instructions (001)
-- stays unused.

ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_role text NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_instructions text NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_ai_role_check;
ALTER TABLE users ADD CONSTRAINT users_ai_role_check
  CHECK (ai_role IS NULL OR ai_role IN ('PARENT', 'GRANDPARENT', 'INSTITUTION_CAREGIVER', 'PATIENT_SELF', 'CLINICIAN', 'OTHER'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_ai_instructions_length_check;
ALTER TABLE users ADD CONSTRAINT users_ai_instructions_length_check CHECK (ai_instructions IS NULL OR char_length(ai_instructions) <= 500);
