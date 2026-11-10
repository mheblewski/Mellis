-- The planned meal's chat: on a planned meal's page a caregiver writes what changed ("zamiast kisielu
-- batonik"), Mellis answers with the whole meal after the change, and an accepted change replaces the entry's dishes.
-- Portions set on a phone are kept with the entry, so both phones see the same plate.
ALTER TABLE meal_plan_entries ADD COLUMN IF NOT EXISTS plate jsonb NULL;
-- The menu's dishes as the plan gave them, kept on the first change from the chat (null: never changed).
ALTER TABLE meal_plan_entries ADD COLUMN IF NOT EXISTS menu_items jsonb NULL;

CREATE TABLE IF NOT EXISTS meal_plan_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES meal_plan_entries(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('USER', 'ASSISTANT')),
  content text NOT NULL DEFAULT '',
  -- USER only: the plate as the phone showed it when the message was sent ("Krupnik (połowa) 8 g, Kisiel 25 g").
  plate_summary text NULL,
  -- ASSISTANT only: the whole meal after the change (items and totals, as in the meal chat).
  proposal jsonb NULL,
  question text NULL,
  author_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  reply_to_message_id uuid NULL REFERENCES meal_plan_chat_messages(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  accepted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_plan_chat_messages_idempotency_unique UNIQUE (entry_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS meal_plan_chat_messages_entry_idx ON meal_plan_chat_messages (entry_id, created_at);
