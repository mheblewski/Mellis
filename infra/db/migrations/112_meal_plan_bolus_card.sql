-- The planned meal's page shows the chat's bolus card (card A) without a conversation: the card is
-- computed by the same path as the chat's, without the model, and belongs to the meal plan entry instead.
ALTER TABLE bolus_proposals ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE bolus_proposals ALTER COLUMN user_message_id DROP NOT NULL;
ALTER TABLE bolus_proposals ADD COLUMN IF NOT EXISTS meal_plan_entry_id uuid NULL REFERENCES meal_plan_entries(id) ON DELETE CASCADE;
DO $$ BEGIN
  ALTER TABLE bolus_proposals ADD CONSTRAINT bolus_proposals_owner_check
    CHECK (conversation_id IS NOT NULL OR meal_plan_entry_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS bolus_proposals_meal_plan_entry_idx ON bolus_proposals (meal_plan_entry_id, created_at DESC)
  WHERE meal_plan_entry_id IS NOT NULL;
