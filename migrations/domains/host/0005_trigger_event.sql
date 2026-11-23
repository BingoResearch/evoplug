-- HOST migration 0005 (DD-HOST-001).
-- trigger_event: 22 columns, append-only, revision fixed at 1.

CREATE TABLE trigger_event (
  trigger_event_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL CHECK (owner = 'host'),
  object_type TEXT NOT NULL CHECK (object_type = 'trigger_event'),
  revision INTEGER NOT NULL CHECK (revision = 1),
  state TEXT NOT NULL CHECK (state = 'recorded'),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN (
    'new_input','tool_fact','compaction','task_boundary_candidate','task_stable',
    'session_end','user_review_request','experience_trigger','config_signal')),
  decision TEXT NOT NULL CHECK (decision IN ('enqueue','skip','defer','suppress')),
  decision_reason TEXT NOT NULL CHECK (decision_reason IN (
    'auto_enqueued','explicit_enqueued','completion_claim_only','no_verified_signal',
    'not_boundary_candidate','stable_boundary_pending','stable_boundary_unknown',
    'watermark_gap','capability_unknown','capability_unsupported','capability_failed',
    'internal_origin','origin_unknown','job_live','task_job_live','replay_duplicate',
    'auto_quota_exhausted','budget_unavailable','authorization_missing','grant_missing',
    'policy_auto_disabled','late_event','invalid_identity','schema_rejected','explicit_stage')),
  trigger_dedupe_key TEXT NOT NULL CHECK (
    length(trigger_dedupe_key) = 71 AND substr(trigger_dedupe_key, 1, 7) = 'sha256:'),
  source_event_key TEXT NOT NULL CHECK (
    length(source_event_key) = 71 AND substr(source_event_key, 1, 7) = 'sha256:'),
  boundary_key TEXT NOT NULL CHECK (
    length(boundary_key) = 71 AND substr(boundary_key, 1, 7) = 'sha256:'),
  signal_digest TEXT NOT NULL CHECK (
    length(signal_digest) = 71 AND substr(signal_digest, 1, 7) = 'sha256:'),
  task_id TEXT NOT NULL CHECK (length(task_id) > 0),
  branch_id TEXT NOT NULL CHECK (length(branch_id) > 0),
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL CHECK (length(goal_version) > 0),
  config_version TEXT NOT NULL CHECK (length(config_version) > 0),
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  source_event_ref TEXT NOT NULL CHECK (length(source_event_ref) > 0),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 71 AND substr(content_hash, 1, 7) = 'sha256:'),
  decided_at INTEGER NOT NULL CHECK (decided_at >= 0),
  FOREIGN KEY (owner, object_type, trigger_event_id, revision)
    REFERENCES object_document(owner, object_type, object_id, revision)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX ix_trigger_event_dedupe
  ON trigger_event(trigger_dedupe_key, decided_at, trigger_event_id);
CREATE INDEX ix_trigger_event_scope
  ON trigger_event(task_id, branch_id, input_epoch, decided_at, trigger_event_id);
