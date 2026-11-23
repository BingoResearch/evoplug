-- 0006_feedback_recovery.sql — appendix P: durable bookkeeping for the
-- background feedback replay. A classification replay is the only startup
-- recovery task that calls an external service. Its per-event attempt count
-- survives restarts so an always-failing backend reaches a terminal state
-- instead of being replayed forever.
-- evoplug:directive:begin
-- evoplug:schema_major=4
-- evoplug:schema_minor=0
-- evoplug:directive:end

CREATE TABLE feedback_recovery (
  event_id TEXT PRIMARY KEY REFERENCES event_log(event_id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending','skipped','terminal_failed')),
  last_error_code TEXT,
  last_error_stage TEXT,
  last_error_retryable INTEGER CHECK (last_error_retryable IS NULL OR last_error_retryable IN (0,1)),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_feedback_recovery_state ON feedback_recovery(state, updated_at);
