-- 0005_event_origin_tui_basis.sql — appendix L.2 records `origin_basis =
-- 'host_tui_session'` when the runtime judged the host process itself to be an
-- interactive TUI (no host field distinguished typed input). SQLite cannot
-- alter a CHECK constraint, so `event_log` is rebuilt with the original column
-- set and every row copied verbatim.
-- evoplug:directive:begin
-- evoplug:schema_major=4
-- evoplug:schema_minor=0
-- evoplug:directive:end
--
-- Follows the documented rebuild recipe: new table under a temporary name,
-- copy, drop the old table, rename. Renaming the old table out of the way
-- would rewrite `fact_verification.event_id REFERENCES event_log(event_id)` to
-- the temporary name.
--
-- evoplug:foreign_keys=off

CREATE TABLE event_log__l2_new (
  event_id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  commit_seq INTEGER NOT NULL UNIQUE,
  journal_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'input.received','input.retry','agent.message','tool.call','tool.result','host.boundary',
    'compaction.observed','subagent.started','subagent.ended','delivery.receipt',
    'feedback.observed','ledger.correction','review.requested','capability.observed',
    'config.applied','identity.fork','identity.resume','host.unclassified',
    'fact_verification.recorded')),
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('human','user','agent','evaluator','system','host','unknown')),
  origin_basis TEXT NOT NULL CHECK (origin_basis IN ('host_typed_field','host_tui_session','host_capability','explicit_event','inferred_from_agent','unavailable')),
  human_attestation_json TEXT,
  trigger_axis TEXT NOT NULL CHECK (trigger_axis IN ('external','internal_evaluator','internal_review','unknown')),
  trigger_root_event_id TEXT,
  trigger_depth INTEGER NOT NULL DEFAULT 0 CHECK (trigger_depth >= 0),
  host_id TEXT NOT NULL,
  config_space TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT,
  branch_id TEXT,
  input_id TEXT,
  run_id TEXT,
  input_epoch INTEGER,
  goal_version TEXT,
  config_version TEXT,
  watermark INTEGER NOT NULL,
  source_seq INTEGER,
  correlation_id TEXT NOT NULL,
  parent_event_id TEXT,
  call_id TEXT,
  content_ref TEXT,
  content_hash TEXT,
  content_bytes INTEGER,
  payload_hash TEXT NOT NULL,
  payload_text TEXT NOT NULL,
  CHECK (commit_seq > 0 AND watermark >= 0),
  CHECK (input_epoch IS NULL OR input_epoch >= 1),
  CHECK (content_bytes IS NULL OR content_bytes >= 0),
  CHECK ((origin = 'human' AND human_attestation_json IS NOT NULL) OR (origin <> 'human' AND human_attestation_json IS NULL)),
  CHECK ((trigger_axis IN ('external','unknown') AND trigger_root_event_id IS NULL AND trigger_depth = 0)
      OR (trigger_axis IN ('internal_evaluator','internal_review') AND trigger_root_event_id IS NOT NULL AND trigger_depth >= 1)),
  CHECK (length(payload_hash) = 71 AND substr(payload_hash,1,7) = 'sha256:'),
  UNIQUE (journal_id, commit_seq)
) STRICT;

INSERT INTO event_log__l2_new (
  event_id, event_key, commit_seq, journal_id, event_type, occurred_at, received_at,
  origin, origin_basis, human_attestation_json, trigger_axis, trigger_root_event_id,
  trigger_depth, host_id, config_space, session_id, task_id, branch_id, input_id, run_id,
  input_epoch, goal_version, config_version, watermark, source_seq, correlation_id,
  parent_event_id, call_id, content_ref, content_hash, content_bytes, payload_hash,
  payload_text
)
SELECT
  event_id, event_key, commit_seq, journal_id, event_type, occurred_at, received_at,
  origin, origin_basis, human_attestation_json, trigger_axis, trigger_root_event_id,
  trigger_depth, host_id, config_space, session_id, task_id, branch_id, input_id, run_id,
  input_epoch, goal_version, config_version, watermark, source_seq, correlation_id,
  parent_event_id, call_id, content_ref, content_hash, content_bytes, payload_hash,
  payload_text
FROM event_log;

DROP TABLE event_log;

ALTER TABLE event_log__l2_new RENAME TO event_log;

CREATE INDEX ix_event_task_branch_watermark ON event_log(task_id, branch_id, watermark);
CREATE INDEX ix_event_session_time ON event_log(session_id, occurred_at);
CREATE INDEX ix_event_type_time ON event_log(event_type, occurred_at);
CREATE INDEX ix_event_input ON event_log(input_id);
CREATE INDEX ix_event_correlation ON event_log(correlation_id);
CREATE INDEX ix_event_trigger ON event_log(trigger_axis, occurred_at);
