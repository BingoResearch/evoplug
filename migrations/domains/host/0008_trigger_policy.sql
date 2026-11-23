-- HOST migration 0008 (DD-TRG-002).
-- TriggerPolicy persistence.
--
-- This migration owns the schema and indexes only. The default policy and
-- canonical `bpol/1` budget rows are installed by 0009.

CREATE TABLE trigger_policy (
  policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  scope_key TEXT NOT NULL CHECK (length(scope_key) = 71 AND substr(scope_key,1,7) = 'sha256:'),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','superseded')),
  policy_hash TEXT NOT NULL CHECK (length(policy_hash) = 71 AND substr(policy_hash,1,7) = 'sha256:'),
  canonical_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (policy_id, policy_version)
) STRICT;
CREATE UNIQUE INDEX ux_trigger_policy_active_scope
  ON trigger_policy(scope_key) WHERE lifecycle = 'active';
CREATE INDEX ix_trigger_policy_scope ON trigger_policy(scope_key, lifecycle);
