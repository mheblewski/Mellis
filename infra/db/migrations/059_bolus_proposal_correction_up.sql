-- An upward correction only where Trio cannot give it itself (docs/product/correction-up-plan.md, owner decision
-- 2026-10-21): the chat card compares Trio's insulinReq with what Trio can add within an hour at the current basal and
-- adds at most half of insulinReq (minus SMBs since) when Trio cannot; a high despite insulin gets a safety message.
--
-- bolus_proposals.correction_up: {policy_version, status (TRIO_COVERS | TERM | NO_TERM | SAFETY), glucose_mgdl,
-- target_mgdl, eventual_mgdl, min_pred_mgdl, insulin_req_u, computed_at, trio {expected_u, smb_u, temp_u, smb_cap_u,
-- basal_u_per_h, limited_by}, smbs_since_u, term_u, blocked_by, safety {kind, message}, night, summary}; NULL: no line.

ALTER TABLE bolus_proposals ADD COLUMN IF NOT EXISTS correction_up jsonb NULL;
ALTER TABLE bolus_proposals DROP CONSTRAINT IF EXISTS bolus_proposals_correction_up_check;
ALTER TABLE bolus_proposals ADD CONSTRAINT bolus_proposals_correction_up_check
  CHECK (correction_up IS NULL OR jsonb_typeof(correction_up) = 'object');
