-- Options under an answer (answer-options.v1, owner 2026-10-22): when the caregiver asks what to do, the answer offers
-- options A-C, each with its own cards; the app shows the option picker and the cards of the chosen option. A card
-- without an option (the caregiver's own plan, or no options) is shown as before.

ALTER TABLE bolus_proposals ADD COLUMN IF NOT EXISTS option_key text;
ALTER TABLE bolus_proposals DROP CONSTRAINT IF EXISTS bolus_proposals_option_key_check;
ALTER TABLE bolus_proposals ADD CONSTRAINT bolus_proposals_option_key_check CHECK (option_key IS NULL OR option_key IN ('A', 'B', 'C'));

ALTER TABLE rescue_carb_proposals ADD COLUMN IF NOT EXISTS option_key text;
ALTER TABLE rescue_carb_proposals DROP CONSTRAINT IF EXISTS rescue_carb_proposals_option_key_check;
ALTER TABLE rescue_carb_proposals ADD CONSTRAINT rescue_carb_proposals_option_key_check CHECK (option_key IS NULL OR option_key IN ('A', 'B', 'C'));
