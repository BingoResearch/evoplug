-- 0007_host_runtime.sql — host-side runtime sessions and calls (DD-HOST-200.4/200.5)
CREATE TABLE host_runtime_session (
  session_id TEXT PRIMARY KEY,
  session_nonce TEXT NOT NULL,
  host_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  config_space TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  implementation_hash TEXT NOT NULL,
  registration_hash TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  host_version TEXT NOT NULL,
  binary_hash TEXT,
  ephemeral INTEGER NOT NULL CHECK (ephemeral IN (0,1)),
  instance_key TEXT,
  native_session_id TEXT,
  pid INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready','revoked','closed','failed')),
  lease_expires_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  closed_at INTEGER
) STRICT;
CREATE INDEX ix_host_runtime_session_binding ON host_runtime_session(host_id, mode, config_space, state);
CREATE UNIQUE INDEX ux_host_runtime_session_instance ON host_runtime_session(registration_hash, instance_key) WHERE instance_key IS NOT NULL AND state IN ('ready','closed');

CREATE TABLE host_runtime_call (
  call_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('deliver','check_load','probe')),
  registration_hash TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  host_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  config_space TEXT NOT NULL,
  native_session_id TEXT,
  hook_event TEXT,
  boundary_event_key TEXT,
  goal_version TEXT,
  config_version TEXT,
  input_epoch INTEGER,
  object_ref TEXT NOT NULL,
  deadline_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','issued','completed','uncertain','expired')),
  issued_session_id TEXT,
  issued_at INTEGER,
  result_hash TEXT,
  result_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_host_runtime_call_pending ON host_runtime_call(registration_hash, state, deadline_at);
CREATE UNIQUE INDEX ux_host_runtime_call_object ON host_runtime_call(kind, object_ref);

CREATE TABLE host_runtime_upload (
  registration_hash TEXT NOT NULL,
  raw_event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  receipt_ref TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (registration_hash, raw_event_id)
) STRICT;

-- adapter_registration gains the attach-time config baseline (DD-HOST-200.3/205)
ALTER TABLE adapter_registration ADD COLUMN config_hash TEXT;
