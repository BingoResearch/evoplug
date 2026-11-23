-- 0007_session_review_state.sql — appendix Q.2 (2026-11-20 revision).
-- Review happens only when a session ends. A stable boundary only records its
-- boundary facts and watermark here; the session-end flush (host event or
-- lease expiry) reads this row, re-evaluates signals after the last review
-- snapshot watermark, and admits one review at the last stable boundary.
-- evoplug:directive:begin
-- evoplug:schema_major=4
-- evoplug:schema_minor=0
-- evoplug:directive:end

CREATE TABLE session_review_state (
  session_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  native_session_id TEXT,
  host_id TEXT NOT NULL,
  config_space TEXT NOT NULL,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  stable_watermark INTEGER NOT NULL CHECK (stable_watermark >= 0),
  last_stable_at INTEGER NOT NULL,
  facts_json TEXT NOT NULL CHECK (json_valid(facts_json) AND json_type(facts_json) = 'object'),
  trigger_json TEXT NOT NULL CHECK (json_valid(trigger_json) AND json_type(trigger_json) = 'object'),
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json) AND json_type(binding_json) = 'object'),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json) AND json_type(policy_json) = 'object'),
  -- Watermark that future reviews must exceed. It advances only when the
  -- candidate decision says the review result was usable (adopted or
  -- content-wrong); "还没做完", "稍后" and an unanswered dialog leave it.
  last_review_watermark INTEGER NOT NULL DEFAULT 0 CHECK (last_review_watermark >= 0),
  last_review_job_id TEXT,
  pending_review_watermark INTEGER CHECK (pending_review_watermark IS NULL OR pending_review_watermark >= 0),
  last_flushed_at INTEGER,
  last_flush_reason TEXT CHECK (last_flush_reason IS NULL OR last_flush_reason IN ('session_end','lease_expired')),
  last_flush_job_id TEXT,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_session_review_state_task ON session_review_state(task_id, last_stable_at);

-- Q.6: the confirmation state gains `withdrawn_incomplete` (the task was not
-- finished, withdraw without negative evidence) and `expired` (pending TTL).
-- It also stores an optional, redacted reason for "内容不对". SQLite cannot
-- alter a CHECK constraint, so the small table is rebuilt.
CREATE TABLE candidate_confirmation__q6_new (
  candidate_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  candidate_hash TEXT NOT NULL CHECK (length(candidate_hash) = 71 AND substr(candidate_hash,1,7) = 'sha256:'),
  subject_hash TEXT NOT NULL CHECK (length(subject_hash) = 71 AND substr(subject_hash,1,7) = 'sha256:'),
  object_type TEXT NOT NULL CHECK (object_type IN ('skill','memory','instructions')),
  target_path TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json) AND json_type(summary_json) = 'object'),
  ask_count INTEGER NOT NULL DEFAULT 0 CHECK (ask_count >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending','adopted','rejected','deferred','withdrawn_incomplete','expired')),
  proof_kind TEXT CHECK (proof_kind IS NULL OR proof_kind IN ('host_native_confirmation','test_backdoor_confirmation')),
  rejection_reason TEXT CHECK (rejection_reason IS NULL OR length(rejection_reason) <= 500),
  last_asked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

INSERT INTO candidate_confirmation__q6_new (
  candidate_id, proposal_id, candidate_hash, subject_hash, object_type, target_path,
  summary_json, ask_count, state, proof_kind, last_asked_at, created_at, updated_at
)
SELECT
  candidate_id, proposal_id, candidate_hash, subject_hash, object_type, target_path,
  summary_json, ask_count, state, proof_kind, last_asked_at, created_at, updated_at
FROM candidate_confirmation;

DROP TABLE candidate_confirmation;

ALTER TABLE candidate_confirmation__q6_new RENAME TO candidate_confirmation;

CREATE INDEX ix_candidate_confirmation_state ON candidate_confirmation(state, updated_at);
