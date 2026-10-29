-- Skipped loop actions (loop-actions.v1): the caregiver will not say what an action was for ("Pomiń"), or nobody did
-- within 24 h. A skipped action stays unassigned (purpose NULL) and its Nightscout entries are unchanged, but it no
-- longer waits in "Czekające na uzupełnienie", counts toward the meals tab badge or gets a push. Assigning a purpose
-- later clears the skip.
ALTER TABLE loop_actions ADD COLUMN IF NOT EXISTS skipped_at timestamptz NULL;
ALTER TABLE loop_actions ADD COLUMN IF NOT EXISTS skipped_by_user_id uuid NULL REFERENCES users(id);
