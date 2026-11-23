-- 0011_host_session_role.sql — separate the session's role from its process
-- lifetime (closure design appendix L.1).
--
-- `ephemeral` now only states whether the runtime process exits after one hook
-- event. The probe/evaluator marker is its own column so a one-shot host hook
-- process can be a real `host_session` without being suppressed as evaluator
-- traffic. Existing rows keep serving as host sessions; a live kernel probe is
-- short-lived, so no backfill is required (new probes declare the role).
ALTER TABLE host_runtime_session
  ADD COLUMN session_role TEXT NOT NULL DEFAULT 'host_session'
  CHECK (session_role IN ('evaluator','host_session'));

CREATE INDEX ix_host_runtime_session_role
  ON host_runtime_session(session_role, last_seen_at);
