-- Rescue carb alerts (docs/product/rescue-carbs-plan.md, rescue-carbs.v1): when glucose may drop below 70 mg/dL the
-- worker pushes a time-sensitive alert with a static rescue carb dose. The push opens a conversation about it; the
-- caregiver logs what was given ("Podano dosłodzenie"), stored as a carb entry of GlucoMind's own (never sent to
-- Nightscout or the loop) with the kind HYPO_TREATMENT, so it shows in the meals tab and reaches the AI.
--
-- patient_devices.rescue_carb_alerts_enabled: the switch in the phone's settings ("Ostrzeżenia o możliwym hipo"); a
-- device gets the alert only when it is on (off by default: the owner turns it on for his phone only).
-- rescue_carb_alerts: one row per alert, at most one active per patient (PENDING after the first flag, NOTIFIED once
-- pushed, TREATED once carbs were logged); evaluation/proposal keep what the push and the screen were based on, and
-- outcome what happened afterwards (lowest glucose within 45 min, treated or not) to measure false alarms.
-- rescue_carb_proposals: the chat's cards with a different dose ("Zatwierdź 8 g"), confirmed through the same endpoint.

ALTER TABLE patient_devices ADD COLUMN IF NOT EXISTS rescue_carb_alerts_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS rescue_carb_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDING',
  level text NOT NULL,
  trigger_source text NOT NULL,
  first_flag_at timestamptz NOT NULL,
  first_flag_reading_at timestamptz NULL,
  notified_at timestamptz NULL,
  notified_level text NULL,
  reminder_sent_at timestamptz NULL,
  last_evaluated_at timestamptz NOT NULL,
  clear_since timestamptz NULL,
  evaluation jsonb NOT NULL,
  proposal jsonb NULL,
  conversation_id uuid NULL REFERENCES conversations(id) ON DELETE SET NULL,
  treatment_event_id uuid NULL REFERENCES events(id) ON DELETE SET NULL,
  treatment_carbs_g numeric(5, 1) NULL,
  treated_at timestamptz NULL,
  treated_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  treatment_source text NULL,
  treatment_proposal_id uuid NULL,
  outcome jsonb NULL,
  resolved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rescue_carb_alerts_status_check CHECK (status IN ('PENDING', 'NOTIFIED', 'TREATED', 'RESOLVED', 'EXPIRED', 'CANCELLED')),
  CONSTRAINT rescue_carb_alerts_level_check CHECK (level IN ('PREDICTED_LOW', 'LOW_NOW', 'URGENT_LOW')),
  CONSTRAINT rescue_carb_alerts_notified_level_check CHECK (notified_level IS NULL OR notified_level IN ('PREDICTED_LOW', 'LOW_NOW', 'URGENT_LOW')),
  CONSTRAINT rescue_carb_alerts_source_check CHECK (trigger_source IN ('TRIO_CARBS_REQ', 'TRIO_PREDICTION', 'CGM_TREND', 'CGM_LOW')),
  CONSTRAINT rescue_carb_alerts_treatment_source_check CHECK (treatment_source IS NULL OR treatment_source IN ('ALERT', 'CHAT_CARD')),
  CONSTRAINT rescue_carb_alerts_treatment_check CHECK (treatment_carbs_g IS NULL OR (treatment_carbs_g > 0 AND treatment_carbs_g <= 50))
);

CREATE UNIQUE INDEX IF NOT EXISTS rescue_carb_alerts_one_active_idx ON rescue_carb_alerts (patient_id)
  WHERE status IN ('PENDING', 'NOTIFIED', 'TREATED');
CREATE UNIQUE INDEX IF NOT EXISTS rescue_carb_alerts_conversation_idx ON rescue_carb_alerts (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS rescue_carb_alerts_patient_created_idx ON rescue_carb_alerts (patient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rescue_carb_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  alert_id uuid NOT NULL REFERENCES rescue_carb_alerts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_message_id uuid NOT NULL,
  carbs_g numeric(5, 1) NOT NULL,
  reason text NULL,
  status text NOT NULL DEFAULT 'PROPOSED',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rescue_carb_proposals_status_check CHECK (status IN ('PROPOSED', 'ACCEPTED', 'DISCARDED')),
  CONSTRAINT rescue_carb_proposals_carbs_check CHECK (carbs_g > 0 AND carbs_g <= 50)
);

CREATE INDEX IF NOT EXISTS rescue_carb_proposals_conversation_idx ON rescue_carb_proposals (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS rescue_carb_proposals_user_message_idx ON rescue_carb_proposals (patient_id, user_message_id);

-- The alert's conversation is named by the system ("Dosłodzenie 14:32"), not by the AI's first answer.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_title_source_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_title_source_check CHECK (title_source IS NULL OR title_source IN ('AI', 'USER', 'SYSTEM'));

-- Both phones see an alert change (logged carbs, a card) at once in its conversation.
DROP TRIGGER IF EXISTS rescue_carb_alerts_live_event ON rescue_carb_alerts;
CREATE TRIGGER rescue_carb_alerts_live_event AFTER INSERT OR UPDATE OR DELETE ON rescue_carb_alerts
  FOR EACH ROW EXECUTE FUNCTION glucomind_notify_row_change('conversation', 'conversation_id');
DROP TRIGGER IF EXISTS rescue_carb_proposals_live_event ON rescue_carb_proposals;
CREATE TRIGGER rescue_carb_proposals_live_event AFTER INSERT OR UPDATE OR DELETE ON rescue_carb_proposals
  FOR EACH ROW EXECUTE FUNCTION glucomind_notify_row_change('conversation', 'conversation_id');
