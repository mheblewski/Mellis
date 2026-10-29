-- patients.birth_year: the patient's year of birth, set by a caregiver in the app ("Rok urodzenia"). The AI states the
-- patient's age from it instead of assuming a child (portions, therapy suggestions, knowledge answers). Required in the
-- app: until it is set, the app asks for it before anything else. Nullable here only because existing patients have none
-- yet; date_of_birth (001) stays unused.

ALTER TABLE patients ADD COLUMN IF NOT EXISTS birth_year smallint NULL;
ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_birth_year_check;
ALTER TABLE patients ADD CONSTRAINT patients_birth_year_check CHECK (birth_year IS NULL OR (birth_year >= 1900 AND birth_year <= 2100));
