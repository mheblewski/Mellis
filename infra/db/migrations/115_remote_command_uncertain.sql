-- A bolus the pump may have started (Trio: "Bolus may have failed", MinimedKit SetBolusError.uncertain) is UNCERTAIN,
-- not refused: Trio records such a dose as given and writes it to Nightscout, which then settles the command as
-- SUCCEEDED. It is never offered again (no retry): 2026-11-06 and 2026-11-10 a quick "Podaj ponownie" after this answer
-- gave the dose twice. It may have been given, so it is matched to the loop's entries like a sent command.

ALTER TABLE remote_commands DROP CONSTRAINT IF EXISTS remote_commands_status_check;
ALTER TABLE remote_commands ADD CONSTRAINT remote_commands_status_check CHECK (status IN (
  'AUTHORIZED', 'EXPIRED', 'SENT', 'SEND_FAILED', 'TRIO_ACCEPTED', 'SUCCEEDED', 'PARTIAL', 'REJECTED', 'NO_REPLY', 'UNCERTAIN'
));

DROP INDEX IF EXISTS remote_commands_unmatched_idx;
CREATE INDEX IF NOT EXISTS remote_commands_unmatched_idx ON remote_commands (patient_id, authorized_at)
  WHERE loop_action_id IS NULL AND status IN ('SENT', 'TRIO_ACCEPTED', 'SUCCEEDED', 'PARTIAL', 'NO_REPLY', 'UNCERTAIN');
