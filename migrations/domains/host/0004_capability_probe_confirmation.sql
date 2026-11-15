-- HOST migration 0004 (DD-CAP-008).
-- capability_record (17), host_probe (19), host_human_confirmation (13).

CREATE TABLE capability_record (
  capability_id TEXT PRIMARY KEY,
  binding_key TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('unknown','verified','unsupported','failed')),
  evidence_stage TEXT NOT NULL CHECK(evidence_stage IN ('none','static','loaded','roundtrip')),
  evidence_refs_json TEXT NOT NULL,
  probe_ref TEXT,
  probe_result TEXT CHECK(probe_result IN ('passed','failed','blocked','unknown')),
  blocker_code TEXT,
  failure_code TEXT,
  checked_at INTEGER NOT NULL,
  verified_at INTEGER,
  last_verified_at INTEGER,
  details_json TEXT NOT NULL,
  legacy_json TEXT,
  row_version INTEGER NOT NULL CHECK(row_version >= 1),
  UNIQUE(binding_key,name)
) STRICT;
CREATE INDEX cap_binding_status ON capability_record(binding_key,status);
CREATE TABLE host_probe (
  probe_id TEXT PRIMARY KEY,
  binding_key TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  subject TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('host','jev_api','filesystem')),
  probe_contract_version TEXT NOT NULL CHECK(probe_contract_version = 'host-probe/2'),
  probe_mode TEXT NOT NULL CHECK(probe_mode IN ('read_only','temp_fixture')),
  fixture_ref TEXT,
  probe_action TEXT NOT NULL,
  assertions_json TEXT NOT NULL,
  capability_results_json TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('passed','failed','blocked','unknown')),
  blocker_json TEXT,
  expected TEXT NOT NULL,
  observed TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
  checked_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL CHECK(row_version >= 1)
) STRICT;
CREATE INDEX ix_host_probe_binding_action
  ON host_probe(binding_key,probe_action,checked_at);
CREATE TABLE host_human_confirmation (
  confirmation_id TEXT PRIMARY KEY,
  binding_key TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  host_binding_json TEXT NOT NULL,
  event_identity_key TEXT NOT NULL,
  challenge_nonce TEXT NOT NULL,
  probe_id TEXT UNIQUE NOT NULL REFERENCES host_probe(probe_id),
  state TEXT NOT NULL CHECK(state IN ('pending','confirmed','failed','expired')),
  evidence_ref TEXT,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  updated_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL CHECK(row_version >= 1)
) STRICT;
CREATE UNIQUE INDEX ux_human_confirmation_event
  ON host_human_confirmation(binding_key,event_identity_key,challenge_nonce);
