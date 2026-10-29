-- Meal chat: a caregiver describes a meal in text and/or photos, the AI proposes macros (it may ask back), and the
-- caregiver accepts or edits them. Photos are stored on the server's disk (MEAL_PHOTO_DIR); only metadata lives here.
CREATE TABLE IF NOT EXISTS meal_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  meal_record_id uuid NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL,
  sha256 text NOT NULL,
  created_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_photos_record_fk FOREIGN KEY (meal_record_id, patient_id) REFERENCES meal_records(id, patient_id) ON DELETE CASCADE,
  CONSTRAINT meal_photos_content_type_check CHECK (content_type = 'image/jpeg'),
  CONSTRAINT meal_photos_size_check CHECK (byte_size > 0 AND byte_size <= 4194304)
);

CREATE INDEX IF NOT EXISTS meal_photos_record_idx ON meal_photos (meal_record_id, created_at);

CREATE TABLE IF NOT EXISTS meal_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL,
  meal_record_id uuid NOT NULL,
  role text NOT NULL,
  content text NOT NULL DEFAULT '',
  photo_ids uuid[] NOT NULL DEFAULT '{}',
  -- ASSISTANT only: the macro proposal (items, totals, confidence) and, when it became the meal's pending proposal,
  -- its proposal_id.
  proposal jsonb NULL,
  question text NULL,
  author_user_id uuid NULL,
  reply_to_message_id uuid NULL REFERENCES meal_chat_messages(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_chat_messages_record_fk FOREIGN KEY (meal_record_id, patient_id) REFERENCES meal_records(id, patient_id) ON DELETE CASCADE,
  CONSTRAINT meal_chat_messages_role_check CHECK (role IN ('USER', 'ASSISTANT')),
  CONSTRAINT meal_chat_messages_idempotency_unique UNIQUE (meal_record_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS meal_chat_messages_record_idx ON meal_chat_messages (meal_record_id, created_at);
