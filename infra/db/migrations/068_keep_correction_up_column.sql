-- 063 dropped bolus_proposals.correction_up (correction-up.v1 is gone). The column comes back, unused and nullable, for
-- one release so that rolling the code back to before 063 can still store chat cards. Drop it again in a later release.

ALTER TABLE bolus_proposals ADD COLUMN IF NOT EXISTS correction_up jsonb NULL;
