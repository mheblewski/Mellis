-- IGNORED: the caregiver deleted the entry in GlucoMind (a mistaken or duplicate carb entry). It stays in Nightscout
-- (the loop already dosed from it) but leaves the meal calendar, day totals, the attention badge and AI analyses.
-- Reversible: setting another kind restores it.
ALTER TABLE carb_entry_kinds DROP CONSTRAINT IF EXISTS carb_entry_kinds_kind_check;
ALTER TABLE carb_entry_kinds
  ADD CONSTRAINT carb_entry_kinds_kind_check CHECK (kind IN ('MEAL', 'CORRECTION_CARBS', 'HYPO_TREATMENT', 'IGNORED'));
