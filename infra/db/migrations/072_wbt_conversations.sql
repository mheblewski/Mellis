-- A meal's WBT conversation (wbt-chat.v1): opened from the WBT insulin screen, it talks the WBT dose over and may propose
-- another one. One per meal; its doses are WBT suggestions of the meal (the screen shows the newest) that remember the
-- answer they came from.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS wbt_meal_record_id uuid NULL;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_wbt_meal_idx
  ON conversations (patient_id, wbt_meal_record_id)
  WHERE wbt_meal_record_id IS NOT NULL;

ALTER TABLE meal_wbt_suggestions
  ADD COLUMN IF NOT EXISTS conversation_id uuid NULL,
  ADD COLUMN IF NOT EXISTS user_message_id uuid NULL;

CREATE INDEX IF NOT EXISTS meal_wbt_suggestions_conversation_idx
  ON meal_wbt_suggestions (conversation_id, created_at)
  WHERE conversation_id IS NOT NULL;
