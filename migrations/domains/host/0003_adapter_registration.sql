-- HOST migration 0003 (DD-HOST-001).
-- Adapter registration and immutable descriptor snapshot.

CREATE TABLE adapter_registration (
  registration_hash TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  config_space TEXT NOT NULL,
  target_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  implementation_hash TEXT NOT NULL,
  descriptor_hash TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  expected_previous_hash TEXT,
  approval_id TEXT NOT NULL,
  approval_hash TEXT NOT NULL,
  approval_subject_hash TEXT NOT NULL,
  approval_consumption_ref TEXT,
  state TEXT NOT NULL CHECK (state IN ('intent','applying','applied','failed','unknown','superseded','detached')),
  written_hash TEXT,
  failure_code TEXT,
  created_at INTEGER NOT NULL,
  applied_at INTEGER,
  updated_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL CHECK (row_version >= 1)
) STRICT;

CREATE TABLE adapter_descriptor_snapshot (
  registration_hash TEXT PRIMARY KEY REFERENCES adapter_registration(registration_hash),
  descriptor_hash TEXT NOT NULL,
  descriptor_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_adapter_descriptor_hash ON adapter_descriptor_snapshot(descriptor_hash);

CREATE UNIQUE INDEX ux_adapter_registration_active
  ON adapter_registration(host_id, mode, config_space)
  WHERE state = 'applied';
CREATE UNIQUE INDEX ux_adapter_registration_inflight
  ON adapter_registration(host_id, mode, config_space)
  WHERE state IN ('intent','applying','unknown');
