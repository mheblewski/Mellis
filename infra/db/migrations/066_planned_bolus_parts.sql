-- A card may plan several later parts (later-plan.v1, owner 2026-10-22: "half the first dose now, the other half in 10
-- min, the rest of the carbs in 60 min"): each part is its own planned_boluses row with part_index. The uniqueness of
-- one open plan per meal and one plan per command becomes one per (meal, part) and (command, part).

ALTER TABLE planned_boluses ADD COLUMN IF NOT EXISTS part_index integer NOT NULL DEFAULT 0;
ALTER TABLE planned_boluses DROP CONSTRAINT IF EXISTS planned_boluses_part_index_check;
ALTER TABLE planned_boluses ADD CONSTRAINT planned_boluses_part_index_check CHECK (part_index BETWEEN 0 AND 2);

DROP INDEX IF EXISTS planned_boluses_one_open_per_meal_idx;
CREATE UNIQUE INDEX IF NOT EXISTS planned_boluses_one_open_per_meal_part_idx ON planned_boluses (meal_record_id, part_index)
  WHERE status IN ('SCHEDULED', 'NOTIFIED');

DROP INDEX IF EXISTS planned_boluses_first_command_idx;
CREATE UNIQUE INDEX IF NOT EXISTS planned_boluses_first_command_part_idx ON planned_boluses (first_command_id, part_index)
  WHERE first_command_id IS NOT NULL;
