-- Photos in the planned meal's chat (a product label, a changed dish): stored like the meal chat's photos
-- (the file on disk by photo id), each one belongs to one planned meal.
CREATE TABLE IF NOT EXISTS meal_plan_chat_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES meal_plan_entries(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  byte_size integer NOT NULL,
  sha256 text NOT NULL,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meal_plan_chat_photos_entry_idx ON meal_plan_chat_photos (entry_id, created_at);

ALTER TABLE meal_plan_chat_messages ADD COLUMN IF NOT EXISTS photo_ids uuid[] NOT NULL DEFAULT '{}';
