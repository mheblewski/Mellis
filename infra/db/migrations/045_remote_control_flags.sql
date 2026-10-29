-- Remote control of the patient's loop (Trio) from GlucoMind: who may send commands (docs/product/remote-bolus-trio-plan.md, W1).
--  * patients.remote_control: the patient's switch. {"enabled": false} until the owner turns it on (deploy/sql/remote-control.sql).
--  * caregiver_relationships.permissions.remote_commands: the caregiver's switch for that patient (permissions was unused so far).
-- Both must be on, and REMOTE_COMMANDS_ENABLED on the server, before the app shows anything that sends a command.
-- No secret is stored here: the Trio shared secret and APNs key stay in the phone's Keychain.

ALTER TABLE patients ADD COLUMN IF NOT EXISTS remote_control jsonb NOT NULL DEFAULT '{"enabled": false}'::jsonb;
ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_remote_control_check;
ALTER TABLE patients ADD CONSTRAINT patients_remote_control_check CHECK (jsonb_typeof(remote_control) = 'object');

-- A switch turned on or off reaches the phones at once: they read the capabilities again.
CREATE OR REPLACE FUNCTION patients_notify_remote_control() RETURNS trigger AS $$
BEGIN
  IF NEW.remote_control IS DISTINCT FROM OLD.remote_control THEN
    PERFORM glucomind_notify_event(NEW.id, 'capabilities', NULL);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS patients_remote_control_live_event ON patients;
CREATE TRIGGER patients_remote_control_live_event AFTER UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION patients_notify_remote_control();

CREATE OR REPLACE FUNCTION caregiver_relationships_notify_permissions() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.permissions IS DISTINCT FROM OLD.permissions THEN
    PERFORM glucomind_notify_event(CASE WHEN TG_OP = 'DELETE' THEN OLD.patient_id ELSE NEW.patient_id END, 'capabilities', NULL);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS caregiver_relationships_permissions_live_event ON caregiver_relationships;
CREATE TRIGGER caregiver_relationships_permissions_live_event AFTER INSERT OR UPDATE OR DELETE ON caregiver_relationships
  FOR EACH ROW EXECUTE FUNCTION caregiver_relationships_notify_permissions();
