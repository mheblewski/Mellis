-- FAT_PROTEIN_UNITS: carbs logged in the loop to dose insulin for the protein and fat of a meal (WBT, Polish
-- "wymienniki białkowo-tłuszczowe"). Not carbohydrates eaten; excluded from carb totals and the attention badge, and
-- passed to AI analyses as their own group.
ALTER TABLE carb_entry_kinds DROP CONSTRAINT IF EXISTS carb_entry_kinds_kind_check;
ALTER TABLE carb_entry_kinds
  ADD CONSTRAINT carb_entry_kinds_kind_check CHECK (kind IN ('MEAL', 'CORRECTION_CARBS', 'HYPO_TREATMENT', 'IGNORED', 'FAT_PROTEIN_UNITS'));
