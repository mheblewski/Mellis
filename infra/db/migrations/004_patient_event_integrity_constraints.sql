CREATE UNIQUE INDEX events_id_patient_unique_idx
  ON events (id, patient_id);

CREATE UNIQUE INDEX conversations_id_patient_unique_idx
  ON conversations (id, patient_id);

CREATE UNIQUE INDEX hypo_episodes_id_patient_unique_idx
  ON hypo_episodes (id, patient_id);

CREATE UNIQUE INDEX triggers_id_patient_unique_idx
  ON triggers (id, patient_id);

ALTER TABLE hypo_episodes
  ADD CONSTRAINT hypo_episodes_start_event_patient_fk
  FOREIGN KEY (start_event_id, patient_id)
  REFERENCES events(id, patient_id)
  ON DELETE CASCADE;

ALTER TABLE hypo_episodes
  ADD CONSTRAINT hypo_episodes_latest_event_patient_fk
  FOREIGN KEY (latest_event_id, patient_id)
  REFERENCES events(id, patient_id)
  ON DELETE CASCADE;

ALTER TABLE triggers
  ADD CONSTRAINT triggers_source_event_patient_fk
  FOREIGN KEY (source_event_id, patient_id)
  REFERENCES events(id, patient_id)
  ON DELETE CASCADE;

ALTER TABLE triggers
  ADD CONSTRAINT triggers_episode_patient_fk
  FOREIGN KEY (episode_id, patient_id)
  REFERENCES hypo_episodes(id, patient_id)
  ON DELETE CASCADE;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_episode_patient_fk
  FOREIGN KEY (episode_id, patient_id)
  REFERENCES hypo_episodes(id, patient_id)
  ON DELETE CASCADE;

ALTER TABLE patient_context
  ADD CONSTRAINT patient_context_source_event_patient_fk
  FOREIGN KEY (source_event_id, patient_id)
  REFERENCES events(id, patient_id)
  ON DELETE CASCADE;

ALTER TABLE patient_context
  ADD CONSTRAINT patient_context_source_conversation_patient_fk
  FOREIGN KEY (source_conversation_id, patient_id)
  REFERENCES conversations(id, patient_id)
  ON DELETE CASCADE;

ALTER TABLE patient_context
  ADD CONSTRAINT patient_context_related_episode_patient_fk
  FOREIGN KEY (related_episode_id, patient_id)
  REFERENCES hypo_episodes(id, patient_id)
  ON DELETE SET NULL (related_episode_id);

ALTER TABLE patient_context
  ADD CONSTRAINT patient_context_related_trigger_patient_fk
  FOREIGN KEY (related_trigger_id, patient_id)
  REFERENCES triggers(id, patient_id)
  ON DELETE SET NULL (related_trigger_id);

ALTER TABLE patient_context
  ADD CONSTRAINT patient_context_scope_check
  CHECK (scope IN ('EVENT'));

ALTER TABLE patient_context
  ADD CONSTRAINT patient_context_knowledge_status_check
  CHECK (knowledge_status IN ('KNOWN', 'UNKNOWN', 'INSUFFICIENT', 'STALE', 'CONTRADICTED'));

ALTER TABLE patient_context
  ADD CONSTRAINT patient_context_validity_check
  CHECK (validity IN ('VALID', 'INVALID', 'STALE', 'CONTRADICTED'));

ALTER TABLE patient_context
  ADD CONSTRAINT patient_context_status_check
  CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'REJECTED', 'ARCHIVED', 'INACTIVE'));

ALTER TABLE patient_context
  ADD CONSTRAINT patient_context_value_type_check
  CHECK (value_type IN ('BOOLEAN', 'TEXT', 'NULL'));
