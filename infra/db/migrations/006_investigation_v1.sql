DROP TABLE IF EXISTS investigations;

CREATE UNIQUE INDEX hypo_episodes_id_patient_start_event_unique_idx
  ON hypo_episodes (id, patient_id, start_event_id);

CREATE UNIQUE INDEX triggers_id_patient_episode_event_unique_idx
  ON triggers (id, patient_id, episode_id, source_event_id);

CREATE UNIQUE INDEX conversations_id_patient_episode_unique_idx
  ON conversations (id, patient_id, episode_id);

CREATE TABLE investigations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  event_family text NOT NULL,
  state text NOT NULL,
  active_question_id text NULL,
  conversation_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  trigger_id uuid NOT NULL,
  last_decision text NOT NULL,
  last_decision_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT investigations_event_unique UNIQUE (event_id),
  CONSTRAINT investigations_event_family_check CHECK (event_family IN ('HYPO')),
  CONSTRAINT investigations_state_check CHECK (state IN ('NEW', 'OPEN', 'QUESTION_PENDING', 'RE_EVALUATING', 'FINISHED_NO_QUESTION', 'FINISHED_ASK_LATER', 'RESOLVED', 'CLOSED')),
  CONSTRAINT investigations_last_decision_check CHECK (last_decision IN ('ASK_NOW', 'ASK_LATER', 'FINISH')),
  CONSTRAINT investigations_event_patient_fk
    FOREIGN KEY (event_id, patient_id)
    REFERENCES events(id, patient_id)
    ON DELETE CASCADE,
  CONSTRAINT investigations_episode_event_patient_fk
    FOREIGN KEY (episode_id, patient_id, event_id)
    REFERENCES hypo_episodes(id, patient_id, start_event_id)
    ON DELETE CASCADE,
  CONSTRAINT investigations_trigger_episode_event_patient_fk
    FOREIGN KEY (trigger_id, patient_id, episode_id, event_id)
    REFERENCES triggers(id, patient_id, episode_id, source_event_id)
    ON DELETE CASCADE,
  CONSTRAINT investigations_conversation_episode_patient_fk
    FOREIGN KEY (conversation_id, patient_id, episode_id)
    REFERENCES conversations(id, patient_id, episode_id)
    ON DELETE CASCADE
);

CREATE INDEX investigations_patient_state_idx
  ON investigations (patient_id, state, updated_at DESC);

CREATE INDEX investigations_conversation_idx
  ON investigations (conversation_id, updated_at DESC);