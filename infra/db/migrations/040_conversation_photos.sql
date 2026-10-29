-- Photos in the main chat (a meal to dose for, a product label): stored on the server's disk next to the meal photos
-- (MEAL_PHOTO_DIR, by photo id); only metadata lives here. A caregiver message lists its photos in
-- messages.metadata.photo_ids.
CREATE TABLE IF NOT EXISTS conversation_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  byte_size integer NOT NULL,
  sha256 text NOT NULL,
  created_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_photos_content_type_check CHECK (content_type = 'image/jpeg'),
  CONSTRAINT conversation_photos_size_check CHECK (byte_size > 0 AND byte_size <= 4194304)
);

CREATE INDEX IF NOT EXISTS conversation_photos_conversation_idx ON conversation_photos (conversation_id, created_at);
