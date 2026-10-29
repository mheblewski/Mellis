-- A caregiver can delete a conversation from the app (shared by all caregivers of the patient). The row and its
-- messages stay: answers recorded in it remain patient facts for analyses. Deleted conversations are hidden by the API.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS deleted_by_user_id uuid NULL;
