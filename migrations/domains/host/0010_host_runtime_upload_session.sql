-- W1: link a runtime upload to the authenticated session that delivered it.
--
-- The upload row predates the session handshake on existing homes, so the
-- column is nullable and old rows stay valid without a backfill. New rows are
-- written by the kernel upload path with the session that authenticated the
-- IPC call; the observer uses it to relate session + registration + artifact
-- + child pid. Additive only: no existing column or constraint changes.
ALTER TABLE host_runtime_upload ADD COLUMN session_id TEXT;

CREATE INDEX ix_host_runtime_upload_session
  ON host_runtime_upload(session_id, created_at);
