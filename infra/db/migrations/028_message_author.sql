-- Which caregiver wrote a USER message (USER_MESSAGE or CONTEXT_ANSWER) in a conversation shared by several
-- caregivers of the same patient. NULL for system/assistant messages and for messages written before this column.
-- No foreign key: development principals (AUTH_MODE=disabled/local_token) may have no users row.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS author_user_id uuid NULL;
