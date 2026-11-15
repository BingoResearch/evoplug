-- HOST migration 0006 (DD-TRG-007, DD-HOST-001).
-- pending_entry: 29 columns with variant CHECK and partial unique indexes.

CREATE TABLE pending_entry (
  pending_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL CHECK (owner = 'host'),
  object_type TEXT NOT NULL CHECK (object_type = 'pending_entry'),
  row_version INTEGER NOT NULL CHECK (row_version >= 1),
  record_state TEXT NOT NULL CHECK (record_state = 'recorded'),
  pending_key TEXT NOT NULL CHECK (
    length(pending_key) = 71 AND substr(pending_key, 1, 7) = 'sha256:'),
  kind TEXT NOT NULL CHECK (kind IN ('delivery','review_defer','generation_resume')),
  pending_state TEXT NOT NULL,
  task_id TEXT NOT NULL CHECK (length(task_id) > 0),
  branch_id TEXT NOT NULL CHECK (length(branch_id) > 0),
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL CHECK (length(goal_version) > 0),
  config_version TEXT NOT NULL CHECK (length(config_version) > 0),
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  host_id TEXT NOT NULL CHECK (length(host_id) > 0),
  mode TEXT NOT NULL CHECK (length(mode) > 0),
  config_space TEXT NOT NULL CHECK (length(config_space) > 0),
  trigger_event_id TEXT,
  deadline_at INTEGER,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  session_ref TEXT,
  boundary_event_ref TEXT,
  delivery_target_hash TEXT,
  boundary_key TEXT,
  review_job_id TEXT,
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 71 AND substr(content_hash, 1, 7) = 'sha256:'),
  CHECK (
    (kind = 'delivery'
      AND session_ref IS NOT NULL AND boundary_event_ref IS NOT NULL
      AND delivery_target_hash IS NOT NULL AND boundary_key IS NULL AND review_job_id IS NULL
      AND pending_state IN ('pending','submitted_not_verified','included','expired','superseded','rejected'))
    OR (kind = 'review_defer'
      AND session_ref IS NULL AND boundary_event_ref IS NULL
      AND delivery_target_hash IS NULL AND boundary_key IS NOT NULL AND review_job_id IS NULL
      AND deadline_at IS NOT NULL
      AND pending_state IN ('waiting','resumed','expired_await_explicit','cancelled'))
    OR (kind = 'generation_resume'
      AND session_ref IS NULL AND boundary_event_ref IS NULL
      AND delivery_target_hash IS NULL AND boundary_key IS NULL AND review_job_id IS NOT NULL
      AND pending_state IN ('queued','resuming','resumed','blocked_no_backend','expired'))
  ),
  FOREIGN KEY (trigger_event_id) REFERENCES trigger_event(trigger_event_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner, object_type, pending_id, row_version)
    REFERENCES object_document(owner, object_type, object_id, revision)
    ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX ux_pending_entry_key ON pending_entry(pending_key);
CREATE UNIQUE INDEX ux_pending_delivery_active
  ON pending_entry(host_id, config_space, session_ref, boundary_event_ref, delivery_target_hash)
  WHERE kind = 'delivery' AND pending_state IN ('pending','submitted_not_verified');
CREATE UNIQUE INDEX ux_pending_defer_active
  ON pending_entry(boundary_key)
  WHERE kind = 'review_defer' AND pending_state = 'waiting';
CREATE UNIQUE INDEX ux_pending_resume_active
  ON pending_entry(review_job_id)
  WHERE kind = 'generation_resume' AND pending_state IN ('queued','resuming','blocked_no_backend');
CREATE INDEX ix_pending_entry_due
  ON pending_entry(kind, pending_state, deadline_at, pending_id);
