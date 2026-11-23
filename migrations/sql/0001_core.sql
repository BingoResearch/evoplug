-- evoplug schema major 4 (P1 consolidation).
--
-- Generated from the frozen major-3 artifacts. Mixed-lifecycle records are
-- stored once in a shared record table keyed by `record_kind`; the former
-- table names are compatibility views so every existing read and write path
-- keeps its shape while the physical schema drops to the consolidated set.
-- Foreign keys are enforced by the write layer and the state-row registry;
-- SQLite FOREIGN KEY clauses are omitted because their former targets are views.
-- evoplug:directive:begin
-- evoplug:schema_major=4
-- evoplug:schema_minor=0
-- evoplug:directive:end

CREATE TABLE authorization_grant (
  grant_id TEXT PRIMARY KEY,
  issued_by TEXT NOT NULL CHECK (issued_by IN ('human','preconfigured_policy')),
  human_attestation_json TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (subject = 'rsi'),
  object_type TEXT NOT NULL CHECK (object_type IN ('skill','memory','instructions','config')),
  scope_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('once','standing')),
  candidate_id TEXT,
  candidate_hash TEXT,
  policy_version TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  grant_hash TEXT NOT NULL,
  CHECK (mode <> 'once' OR (candidate_id IS NOT NULL AND candidate_hash IS NOT NULL)),
  CHECK (object_type <> 'config' OR (candidate_id IS NOT NULL AND candidate_hash IS NOT NULL)),
  CHECK (candidate_id IS NULL OR
    (object_type = 'config' AND substr(candidate_id,1,4) = 'ctr:' AND length(candidate_id) = 30) OR
    (object_type <> 'config' AND substr(candidate_id,1,5) = 'prop:' AND length(candidate_id) = 31)),
  CHECK (expires_at IS NULL OR expires_at > issued_at)
) STRICT;

CREATE INDEX ix_grant_active ON authorization_grant(revoked_at, expires_at);

CREATE TABLE blob (
  blob_hash TEXT PRIMARY KEY,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  relative_path TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('present','deleted','tombstoned')),
  verified_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deletion_reason TEXT CHECK (deletion_reason IS NULL OR deletion_reason IN ('explicit','retention','corruption','missing_source')),
  CHECK (length(blob_hash) = 71 AND substr(blob_hash,1,7) = 'sha256:'),
  CHECK ((state = 'present' AND deleted_at IS NULL) OR (state <> 'present' AND deleted_at IS NOT NULL))
) STRICT;

CREATE TABLE blob_ref (
  blob_hash TEXT NOT NULL REFERENCES blob(blob_hash) ON DELETE RESTRICT,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('event','requirement','fact','feedback','evidence','review','delivery','write','experience','maintenance','journal','document')),
  owner_id TEXT NOT NULL,
  source_ref TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blob_hash, owner_type, owner_id)
) STRICT;

CREATE INDEX ix_blob_ref_owner ON blob_ref(owner_type, owner_id);

CREATE TABLE branch (
  branch_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  parent_branch_id TEXT REFERENCES branch(branch_id) ON DELETE RESTRICT,
  forked_from_watermark INTEGER,
  inherited_goal_snapshot_id TEXT,
  current_goal_version TEXT NOT NULL,
  current_goal_revision INTEGER NOT NULL CHECK (current_goal_revision >= 1),
  current_goal_snapshot_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (forked_from_watermark IS NULL OR forked_from_watermark >= 0),
  CHECK (parent_branch_id IS NOT NULL OR forked_from_watermark IS NULL)
) STRICT;

CREATE INDEX ix_branch_task ON branch(task_id);

CREATE TABLE budget_reservation (
  reservation_id TEXT PRIMARY KEY,
  reservation_key TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  task_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('judge','review_generate','review_match','verifier','egress_other')),
  scope_key TEXT NOT NULL,
  service_profile_id TEXT NOT NULL,
  service_profile_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','claimed','settled','released','expired','unsettled')),
  attempt_allowance INTEGER NOT NULL CHECK (attempt_allowance >= 0),
  input_token_allowance INTEGER NOT NULL CHECK (input_token_allowance >= 0),
  output_token_allowance INTEGER NOT NULL CHECK (output_token_allowance >= 0),
  cost_allowance_micros INTEGER,
  cost_status TEXT NOT NULL CHECK (cost_status IN ('known','unknown','not_applicable')),
  wall_allowance_ms INTEGER NOT NULL CHECK (wall_allowance_ms >= 0),
  non_refundable INTEGER NOT NULL CHECK (non_refundable IN (0,1)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  settled_at INTEGER,
  UNIQUE (scope_key, reservation_key),
  CHECK (cost_status <> 'known' OR cost_allowance_micros IS NOT NULL),
  CHECK (cost_status = 'unknown' OR cost_allowance_micros IS NULL OR cost_allowance_micros >= 0)
) STRICT;

CREATE INDEX ix_budget_reservation_binding ON budget_reservation(branch_id, input_epoch, purpose);

CREATE INDEX ix_budget_reservation_scope_state ON budget_reservation(scope_key, state, expires_at);

CREATE TABLE cfg_attempt (
  trial_id TEXT NOT NULL REFERENCES cfg_trial(trial_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 512),
  request_hash TEXT NOT NULL CHECK (request_hash GLOB 'sha256:????????????????????????????????????????????????????????????????'),
  phase_before TEXT NOT NULL CHECK (phase_before IN ('planned','authorized','writing','write_recorded',
    'awaiting_apply','observing','rolling_back','recovery_required','closed','aborted')),
  phase_after TEXT NOT NULL CHECK (phase_after IN ('planned','authorized','writing','write_recorded',
    'awaiting_apply','observing','rolling_back','recovery_required','closed','aborted')),
  task_id TEXT NOT NULL CHECK (length(task_id) > 0),
  branch_id TEXT NOT NULL CHECK (length(branch_id) > 0),
  input_epoch INTEGER NOT NULL CHECK (input_epoch > 0),
  goal_version TEXT NOT NULL CHECK (length(goal_version) BETWEEN 1 AND 256),
  config_version TEXT NOT NULL CHECK (length(config_version) BETWEEN 1 AND 128),
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  attempt_json TEXT NOT NULL CHECK (json_valid(attempt_json) AND json_type(attempt_json) = 'object'),
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  finished_at INTEGER,
  PRIMARY KEY (trial_id, sequence),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
) STRICT;

CREATE TRIGGER cfg_attempt_finished_immutable
BEFORE UPDATE ON cfg_attempt
WHEN OLD.finished_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'cfg_attempt_immutable'); END;

CREATE TRIGGER cfg_attempt_identity_immutable
BEFORE UPDATE ON cfg_attempt
WHEN NEW.trial_id <> OLD.trial_id OR NEW.sequence <> OLD.sequence
  OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.request_hash <> OLD.request_hash
  OR NEW.phase_before <> OLD.phase_before OR NEW.phase_after <> OLD.phase_after
  OR NEW.task_id <> OLD.task_id OR NEW.branch_id <> OLD.branch_id
  OR NEW.input_epoch <> OLD.input_epoch OR NEW.goal_version <> OLD.goal_version
  OR NEW.config_version <> OLD.config_version OR NEW.watermark <> OLD.watermark
  OR NEW.started_at <> OLD.started_at
  OR json_extract(NEW.attempt_json, '$.audit_input')
     IS NOT json_extract(OLD.attempt_json, '$.audit_input')
BEGIN SELECT RAISE(ABORT, 'cfg_attempt_immutable'); END;

CREATE TRIGGER cfg_attempt_no_delete BEFORE DELETE ON cfg_attempt
BEGIN SELECT RAISE(ABORT, 'cfg_attempt_history'); END;

CREATE TABLE cfg_capacity_evidence (
  evidence_hash TEXT PRIMARY KEY CHECK (evidence_hash GLOB 'sha256:????????????????????????????????????????????????????????????????'),
  config_space_id TEXT NOT NULL CHECK (config_space_id GLOB 'sha256:????????????????????????????????????????????????????????????????'),
  schema_version TEXT NOT NULL CHECK (schema_version = 'rsi.capacity_evidence/1'),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TRIGGER cfg_capacity_evidence_immutable BEFORE UPDATE ON cfg_capacity_evidence
BEGIN SELECT RAISE(ABORT, 'cfg_capacity_evidence_immutable'); END;

CREATE TRIGGER cfg_capacity_evidence_no_delete BEFORE DELETE ON cfg_capacity_evidence
BEGIN SELECT RAISE(ABORT, 'cfg_capacity_evidence_immutable'); END;

CREATE TABLE cfg_field_claim (
  config_space_id TEXT NOT NULL CHECK (config_space_id GLOB 'sha256:????????????????????????????????????????????????????????????????'),
  field_id TEXT NOT NULL CHECK (field_id LIKE 'fld:%'),
  trial_id TEXT NOT NULL REFERENCES cfg_trial(trial_id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL CHECK (schema_version = 'rsi.field_claim_row/1'),
  state TEXT NOT NULL CHECK (state IN ('held', 'released')),
  claimed_at INTEGER NOT NULL CHECK (claimed_at >= 0),
  released_at INTEGER,
  task_id TEXT NOT NULL CHECK (length(task_id) > 0),
  branch_id TEXT NOT NULL CHECK (length(branch_id) > 0),
  input_epoch INTEGER NOT NULL CHECK (input_epoch > 0),
  goal_version TEXT NOT NULL CHECK (length(goal_version) BETWEEN 1 AND 256),
  config_version TEXT NOT NULL CHECK (length(config_version) BETWEEN 1 AND 128),
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  PRIMARY KEY (config_space_id, field_id, trial_id),
  CHECK ((state = 'held' AND released_at IS NULL)
    OR (state = 'released' AND released_at IS NOT NULL AND released_at >= claimed_at))
) STRICT;

CREATE UNIQUE INDEX ux_cfg_claim_held
  ON cfg_field_claim(config_space_id, field_id) WHERE state = 'held';

CREATE TRIGGER cfg_field_claim_no_delete BEFORE DELETE ON cfg_field_claim
BEGIN SELECT RAISE(ABORT, 'cfg_field_claim_history'); END;

CREATE TRIGGER cfg_field_claim_transition
BEFORE UPDATE ON cfg_field_claim
WHEN OLD.state <> 'held' OR NEW.state <> 'released'
  OR NEW.config_space_id <> OLD.config_space_id OR NEW.field_id <> OLD.field_id
  OR NEW.trial_id <> OLD.trial_id OR NEW.claimed_at <> OLD.claimed_at
  OR NEW.schema_version <> OLD.schema_version
  OR NEW.task_id <> OLD.task_id OR NEW.branch_id <> OLD.branch_id
  OR NEW.input_epoch <> OLD.input_epoch OR NEW.goal_version <> OLD.goal_version
  OR NEW.config_version <> OLD.config_version OR NEW.watermark <> OLD.watermark
BEGIN SELECT RAISE(ABORT, 'cfg_field_claim_transition'); END;

CREATE TABLE cfg_field_spec (
  snapshot_hash TEXT NOT NULL REFERENCES cfg_registry_snapshot(snapshot_hash) ON DELETE RESTRICT,
  field_id TEXT NOT NULL CHECK (field_id LIKE 'fld:%'),
  schema_version TEXT NOT NULL CHECK (schema_version = 'rsi.field_spec/1'),
  spec_hash TEXT NOT NULL CHECK (spec_hash GLOB 'sha256:????????????????????????????????????????????????????????????????'),
  spec_json TEXT NOT NULL CHECK (json_valid(spec_json) AND json_type(spec_json) = 'object'),
  PRIMARY KEY (snapshot_hash, field_id)
) STRICT;

CREATE TRIGGER cfg_field_spec_immutable BEFORE UPDATE ON cfg_field_spec
BEGIN SELECT RAISE(ABORT, 'cfg_registry_immutable'); END;

CREATE TRIGGER cfg_field_spec_no_delete BEFORE DELETE ON cfg_field_spec
BEGIN SELECT RAISE(ABORT, 'cfg_registry_immutable'); END;

CREATE TABLE cfg_observation (
  trial_id TEXT NOT NULL REFERENCES cfg_trial(trial_id) ON DELETE RESTRICT,
  sample_id TEXT NOT NULL CHECK (length(sample_id) > 0),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  record_hash TEXT NOT NULL CHECK (record_hash GLOB 'sha256:????????????????????????????????????????????????????????????????'),
  schema_version TEXT NOT NULL CHECK (schema_version = 'rsi.config_observation/1'),
  task_id TEXT NOT NULL CHECK (length(task_id) > 0),
  branch_id TEXT NOT NULL CHECK (length(branch_id) > 0),
  input_epoch INTEGER NOT NULL CHECK (input_epoch > 0),
  goal_version TEXT NOT NULL CHECK (length(goal_version) BETWEEN 1 AND 256),
  config_version TEXT NOT NULL CHECK (length(config_version) BETWEEN 1 AND 128),
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  observation_json TEXT NOT NULL CHECK (json_valid(observation_json) AND json_type(observation_json) = 'object'),
  PRIMARY KEY (trial_id, sample_id)
) STRICT;

CREATE TRIGGER cfg_observation_immutable BEFORE UPDATE ON cfg_observation
BEGIN SELECT RAISE(ABORT, 'cfg_observation_immutable'); END;

CREATE TRIGGER cfg_observation_no_delete BEFORE DELETE ON cfg_observation
BEGIN SELECT RAISE(ABORT, 'cfg_observation_history'); END;

CREATE TABLE cfg_plan (
  plan_id TEXT PRIMARY KEY CHECK (plan_id LIKE 'trial:%'),
  schema_version TEXT NOT NULL CHECK (schema_version = 'rsi.trial_plan/2'),
  plan_hash TEXT NOT NULL UNIQUE CHECK (plan_hash GLOB 'sha256:????????????????????????????????????????????????????????????????'),
  task_id TEXT NOT NULL CHECK (length(task_id) > 0),
  branch_id TEXT NOT NULL CHECK (length(branch_id) > 0),
  input_epoch INTEGER NOT NULL CHECK (input_epoch > 0),
  goal_version TEXT NOT NULL CHECK (length(goal_version) BETWEEN 1 AND 256),
  config_version TEXT NOT NULL CHECK (length(config_version) BETWEEN 1 AND 128),
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json) AND json_type(plan_json) = 'object'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (task_id) REFERENCES task(task_id) ON DELETE RESTRICT,
  FOREIGN KEY (branch_id) REFERENCES branch(branch_id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER cfg_plan_immutable BEFORE UPDATE ON cfg_plan
BEGIN SELECT RAISE(ABORT, 'cfg_plan_immutable'); END;

CREATE TRIGGER cfg_plan_no_delete BEFORE DELETE ON cfg_plan
BEGIN SELECT RAISE(ABORT, 'cfg_plan_immutable'); END;

CREATE TABLE cfg_registry_snapshot (
  snapshot_hash TEXT PRIMARY KEY CHECK (snapshot_hash GLOB 'sha256:????????????????????????????????????????????????????????????????'),
  schema_version TEXT NOT NULL CHECK (schema_version = 'rsi.field_registry_snapshot/1'),
  registry_version TEXT NOT NULL CHECK (length(registry_version) BETWEEN 1 AND 128),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TRIGGER cfg_registry_snapshot_immutable BEFORE UPDATE ON cfg_registry_snapshot
BEGIN SELECT RAISE(ABORT, 'cfg_registry_immutable'); END;

CREATE TRIGGER cfg_registry_snapshot_no_delete BEFORE DELETE ON cfg_registry_snapshot
BEGIN SELECT RAISE(ABORT, 'cfg_registry_immutable'); END;

CREATE TABLE cfg_trial (
  trial_id TEXT PRIMARY KEY CHECK (trial_id LIKE 'ctr:%'),
  plan_id TEXT NOT NULL REFERENCES cfg_plan(plan_id) ON DELETE RESTRICT,
  config_space_id TEXT NOT NULL CHECK (config_space_id GLOB 'sha256:????????????????????????????????????????????????????????????????'),
  phase TEXT NOT NULL CHECK (phase IN ('planned','authorized','writing','write_recorded',
    'awaiting_apply','observing','rolling_back','recovery_required','closed','aborted')),
  evidence_level TEXT NOT NULL CHECK (evidence_level IN ('none','written_unverified','applied','effective','causal')),
  outcome TEXT NOT NULL CHECK (outcome IN ('running','not_exercised','inconclusive','effect_supported',
    'effect_rejected','rolled_back','failed','aborted')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  task_id TEXT NOT NULL CHECK (length(task_id) > 0),
  branch_id TEXT NOT NULL CHECK (length(branch_id) > 0),
  input_epoch INTEGER NOT NULL CHECK (input_epoch > 0),
  goal_version TEXT NOT NULL CHECK (length(goal_version) BETWEEN 1 AND 256),
  config_version TEXT NOT NULL CHECK (length(config_version) BETWEEN 1 AND 128),
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  trial_json TEXT NOT NULL CHECK (json_valid(trial_json) AND json_type(trial_json) = 'object'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (phase NOT IN ('closed', 'aborted') OR outcome <> 'running'),
  FOREIGN KEY (task_id) REFERENCES task(task_id) ON DELETE RESTRICT,
  FOREIGN KEY (branch_id) REFERENCES branch(branch_id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX ux_cfg_trial_active_space
  ON cfg_trial(config_space_id)
  WHERE phase NOT IN ('closed', 'aborted');

CREATE TRIGGER cfg_trial_identity_immutable
BEFORE UPDATE ON cfg_trial
WHEN NEW.trial_id <> OLD.trial_id OR NEW.plan_id <> OLD.plan_id
  OR NEW.config_space_id <> OLD.config_space_id
  OR NEW.task_id <> OLD.task_id OR NEW.branch_id <> OLD.branch_id
  OR NEW.input_epoch <> OLD.input_epoch OR NEW.goal_version <> OLD.goal_version
  OR NEW.config_version <> OLD.config_version OR NEW.watermark <> OLD.watermark
  OR NEW.created_at <> OLD.created_at OR NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'cfg_trial_identity'); END;

CREATE TRIGGER cfg_trial_no_delete BEFORE DELETE ON cfg_trial
BEGIN SELECT RAISE(ABORT, 'cfg_trial_history'); END;

CREATE TABLE commit_record (
  journal_id TEXT NOT NULL REFERENCES journal_state(journal_id) ON DELETE RESTRICT,
  commit_seq INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  blob_hashes_json TEXT NOT NULL,
  batch_hash TEXT,
  batch_first_commit_seq INTEGER,
  batch_ordinal INTEGER,
  committed_at INTEGER NOT NULL,
  indexed_at INTEGER,
  CHECK (commit_seq > 0),
  CHECK (length(payload_hash) = 71 AND substr(payload_hash,1,7) = 'sha256:'),
  CHECK ((batch_hash IS NULL AND batch_first_commit_seq IS NULL AND batch_ordinal IS NULL)
      OR (batch_hash IS NOT NULL AND length(batch_hash) = 71 AND substr(batch_hash,1,7) = 'sha256:'
          AND batch_first_commit_seq > 0 AND batch_ordinal >= 0
          AND commit_seq = batch_first_commit_seq + batch_ordinal))
) STRICT;

CREATE INDEX ix_commit_indexed ON commit_record(indexed_at);

CREATE UNIQUE INDEX ux_commit_batch_member ON commit_record(batch_hash, batch_ordinal)
  WHERE batch_hash IS NOT NULL;

CREATE UNIQUE INDEX ux_commit_journal_seq ON commit_record(journal_id, commit_seq);

CREATE TABLE config_write_intent (
  config_write_id TEXT PRIMARY KEY
    CHECK (substr(config_write_id,1,4) = 'cwi:' AND length(config_write_id) = 30),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES authorization_grant(grant_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('update','rollback')),
  object_type TEXT NOT NULL CHECK (object_type = 'config'),
  candidate_id TEXT NOT NULL CHECK (substr(candidate_id,1,4) = 'ctr:' AND length(candidate_id) = 30),
  candidate_hash TEXT NOT NULL,
  patch_hash TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  auth_decision_json TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  config_space_id TEXT NOT NULL,
  field_registry_snapshot_hash TEXT NOT NULL,
  layer_id TEXT NOT NULL,
  model_scope_key TEXT NOT NULL,
  root_id TEXT NOT NULL REFERENCES root_registration(root_id) ON DELETE RESTRICT,
  root_registration_hash TEXT NOT NULL,
  root_identity_pin_json TEXT NOT NULL,
  target_path TEXT NOT NULL,
  expected_config_version TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('trial_write','trial_rollback')),
  base_file_hash TEXT NOT NULL,
  base_content_ref TEXT NOT NULL,
  base_byte_length INTEGER NOT NULL CHECK (base_byte_length >= 0 AND base_byte_length <= 8388608),
  candidate_content_hash TEXT,
  candidate_content_ref TEXT,
  new_semantic_hash TEXT,
  protected_subtree_proof_json TEXT NOT NULL,
  snapshot_id TEXT REFERENCES config_write_snapshot(snapshot_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN (
    'intent_recorded','snapshot_written','temp_written','renamed','dir_synced','verified',
    'conflict','path_rejected','write_failed','uncertain','recovery_required')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  last_error_code TEXT,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (patch_hash = candidate_hash),
  CHECK (json_type(protected_subtree_proof_json) = 'array' AND
    length(CAST(protected_subtree_proof_json AS BLOB)) <= 8388608),
  CHECK (action <> 'update' OR reason = 'trial_write'),
  CHECK (action <> 'rollback' OR reason = 'trial_rollback'),
  CHECK (state NOT IN ('temp_written','renamed','dir_synced','verified') OR
    (candidate_content_hash IS NOT NULL AND candidate_content_ref IS NOT NULL AND
     new_semantic_hash IS NOT NULL AND snapshot_id IS NOT NULL)),
  CHECK (state <> 'verified' OR last_error_code IS NULL),
  CHECK (length(root_registration_hash) = 71 AND substr(root_registration_hash,1,7) = 'sha256:'),
  CHECK (json_type(root_identity_pin_json) IS 'object'
      AND json_extract(root_identity_pin_json,'$.schema_version') IS 'rsi.root_identity/1'
      AND json_extract(root_identity_pin_json,'$.root_id') IS root_id
      AND coalesce(json_extract(root_identity_pin_json,'$.identity_kind'),'') IN ('dev_inode','file_id')
      AND json_type(root_identity_pin_json,'$.device_id') IS 'text'
      AND json_type(root_identity_pin_json,'$.file_id') IS 'text'),
  CHECK (target_path <> '' AND substr(target_path,1,1) <> '/'
      AND instr(target_path, char(0)) = 0
      AND instr('/' || target_path || '/', '/../') = 0
      AND target_path <> '..'
      AND target_path NOT GLOB '[A-Za-z]:*'
      AND target_path NOT GLOB '\\*')
) STRICT;

CREATE INDEX ix_config_intent_grant ON config_write_intent(grant_id);

CREATE INDEX ix_config_intent_state ON config_write_intent(state, updated_at);

CREATE INDEX ix_config_intent_target ON config_write_intent(root_id, target_path);

CREATE UNIQUE INDEX ux_config_intent_active ON config_write_intent(root_id, target_path)
  WHERE state IN ('intent_recorded','snapshot_written','temp_written','renamed','dir_synced');

CREATE TRIGGER config_write_intent_root_binding
BEFORE INSERT ON config_write_intent
WHEN NOT EXISTS (
  SELECT 1 FROM root_registration
  WHERE root_id = NEW.root_id AND registration_hash = NEW.root_registration_hash
)
BEGIN SELECT RAISE(ABORT, 'config_write_root_binding'); END;

CREATE TABLE config_write_lock (
  lock_key TEXT PRIMARY KEY,
  lock_handle_hash TEXT NOT NULL UNIQUE,
  holder_client_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  grant_id TEXT NOT NULL REFERENCES authorization_grant(grant_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('update','rollback')),
  object_type TEXT NOT NULL CHECK (object_type = 'config'),
  candidate_id TEXT NOT NULL CHECK (substr(candidate_id,1,4) = 'ctr:' AND length(candidate_id) = 30),
  candidate_hash TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  config_space_id TEXT NOT NULL,
  field_registry_snapshot_hash TEXT NOT NULL,
  layer_id TEXT NOT NULL,
  model_scope_key TEXT NOT NULL,
  root_id TEXT NOT NULL,
  root_registration_hash TEXT NOT NULL,
  root_identity_pin_json TEXT NOT NULL,
  target_path TEXT NOT NULL,
  expected_config_version TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('trial_write','trial_rollback')),
  base_file_hash TEXT NOT NULL,
  base_content_ref TEXT NOT NULL,
  base_byte_length INTEGER NOT NULL CHECK (base_byte_length >= 0 AND base_byte_length <= 8388608),
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER,
  CHECK (expires_at > acquired_at),
  CHECK (released_at IS NULL OR released_at >= acquired_at),
  CHECK ((action = 'update' AND reason = 'trial_write') OR (action = 'rollback' AND reason = 'trial_rollback')),
  CHECK (length(root_registration_hash) = 71 AND substr(root_registration_hash,1,7) = 'sha256:'),
  CHECK (json_type(root_identity_pin_json) IS 'object'
      AND json_extract(root_identity_pin_json,'$.schema_version') IS 'rsi.root_identity/1'
      AND json_extract(root_identity_pin_json,'$.root_id') IS root_id
      AND coalesce(json_extract(root_identity_pin_json,'$.identity_kind'),'') IN ('dev_inode','file_id')
      AND json_type(root_identity_pin_json,'$.device_id') IS 'text'
      AND json_type(root_identity_pin_json,'$.file_id') IS 'text'),
  CHECK (target_path <> '' AND substr(target_path,1,1) <> '/'
      AND instr(target_path, char(0)) = 0
      AND instr('/' || target_path || '/', '/../') = 0
      AND target_path <> '..'
      AND target_path NOT GLOB '[A-Za-z]:*'
      AND target_path NOT GLOB '\\*')
) STRICT;

CREATE INDEX ix_config_lock_expiry ON config_write_lock(released_at, expires_at);

CREATE TABLE config_write_result (
  config_write_id TEXT NOT NULL REFERENCES config_write_intent(config_write_id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  candidate_id TEXT NOT NULL CHECK (substr(candidate_id,1,4) = 'ctr:' AND length(candidate_id) = 30),
  candidate_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'verified','conflict','path_rejected','write_failed','uncertain','recovery_required')),
  path TEXT NOT NULL CHECK (
    path <> '' AND substr(path,1,1) <> '/'
    AND instr(path, char(0)) = 0
    AND instr('/' || path || '/', '/../') = 0
    AND path <> '..'
    AND path NOT GLOB '[A-Za-z]:*'
    AND path NOT GLOB '\\*'),
  candidate_content_hash TEXT,
  new_file_hash TEXT,
  new_semantic_hash TEXT,
  snapshot_id TEXT REFERENCES config_write_snapshot(snapshot_id) ON DELETE RESTRICT,
  readback_verified INTEGER NOT NULL DEFAULT 0 CHECK (readback_verified IN (0,1)),
  protected_subtrees_verified INTEGER NOT NULL DEFAULT 0 CHECK (protected_subtrees_verified IN (0,1)),
  atomicity TEXT NOT NULL CHECK (atomicity IN ('single_file_atomic','none')),
  exclusion TEXT NOT NULL CHECK (exclusion IN ('native_cooperative','rsi_advisory','none')),
  error_code TEXT,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (config_write_id, attempt),
  CHECK (state <> 'verified' OR
    (readback_verified = 1 AND protected_subtrees_verified = 1 AND
     candidate_content_hash IS NOT NULL AND new_file_hash = candidate_content_hash AND
     new_semantic_hash IS NOT NULL AND snapshot_id IS NOT NULL AND error_code IS NULL)),
  CHECK (state = 'verified' OR error_code IS NOT NULL)
) STRICT;

CREATE TABLE config_write_snapshot (
  snapshot_id TEXT PRIMARY KEY
    CHECK (substr(snapshot_id,1,6) = 'wsnap:' AND length(snapshot_id) = 32),
  config_write_id TEXT NOT NULL UNIQUE REFERENCES config_write_intent(config_write_id) ON DELETE RESTRICT,
  path TEXT NOT NULL CHECK (
    path <> '' AND substr(path,1,1) <> '/'
    AND instr(path, char(0)) = 0
    AND instr('/' || path || '/', '/../') = 0
    AND path <> '..'
    AND path NOT GLOB '[A-Za-z]:*'
    AND path NOT GLOB '\\*'),
  base_file_hash TEXT NOT NULL,
  content_ref TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0 AND byte_length <= 8388608),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE credential_ref (
  secret_ref TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('api_key','oauth_refresh','host_native')),
  locator TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','revoked','missing')),
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
) STRICT;

CREATE TABLE delivery (
  delivery_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  requirement_ids_json TEXT NOT NULL,
  issue_id TEXT,
  dedupe_key TEXT NOT NULL,
  pack_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','submitted','expired','failed')),
  inclusion_evidence TEXT NOT NULL CHECK (inclusion_evidence IN ('unknown','context_projection','provider_payload','transport_body','host_confirmed')),
  transport_body_verified INTEGER NOT NULL DEFAULT 0 CHECK (transport_body_verified IN (0,1)),
  submission_ref TEXT,
  inclusion_ref TEXT,
  adoption TEXT NOT NULL CHECK (adoption IN ('unknown','observed','verified')),
  adoption_ref TEXT,
  terminal_reason TEXT CHECK (terminal_reason IS NULL OR terminal_reason IN ('host_rejected','version_changed','timeout','cancelled','expired_by_time')),
  expires_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (dedupe_key, evidence_hash),
  CHECK (json_array_length(requirement_ids_json) >= 0),
  CHECK (json_array_length(requirement_ids_json) > 0 OR issue_id IS NOT NULL),
  CHECK (transport_body_verified = 0 OR inclusion_evidence IN ('transport_body','host_confirmed')),
  CHECK (state <> 'submitted' OR submission_ref IS NOT NULL),
  CHECK (state NOT IN ('expired','failed') OR terminal_reason IS NOT NULL),
  CHECK (terminal_reason IS NULL OR state IN ('expired','failed'))
) STRICT;

CREATE INDEX ix_delivery_branch ON delivery(branch_id, created_at);

CREATE INDEX ix_delivery_dedupe ON delivery(dedupe_key, evidence_hash);

CREATE INDEX ix_delivery_state_expiry ON delivery(state, expires_at);

CREATE TABLE egress_approval (
  approval_id TEXT PRIMARY KEY,
  policy_version TEXT NOT NULL,
  approved_by TEXT NOT NULL CHECK (approved_by = 'human'),
  human_attestation_json TEXT NOT NULL,
  attestation_subject_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  approval_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('judge','review_generate','review_match','replay','other')),
  version_binding_json TEXT NOT NULL CHECK (json_type(version_binding_json) = 'object'),
  host TEXT NOT NULL,
  scheme TEXT NOT NULL CHECK (scheme = 'https'),
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  path TEXT NOT NULL CHECK (substr(path,1,1) = '/' AND length(CAST(path AS BLOB)) BETWEEN 1 AND 8192),
  model TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sources_json TEXT NOT NULL CHECK (json_type(sources_json) = 'array'),
  body_sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 16777216),
  replay_plan_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('active','consumed','revoked','expired')),
  ttl_ms INTEGER NOT NULL CHECK (ttl_ms BETWEEN 1 AND 600000),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_request_hash TEXT,
  revoked_at INTEGER,
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR revoke_reason IN ('human_revoked','policy_replaced')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CHECK (length(request_hash) = 71 AND substr(request_hash,1,7) = 'sha256:'),
  CHECK (length(approval_hash) = 71 AND substr(approval_hash,1,7) = 'sha256:'),
  CHECK (length(attestation_subject_hash) = 71 AND substr(attestation_subject_hash,1,7) = 'sha256:'),
  CHECK (length(body_sha256) = 71 AND substr(body_sha256,1,7) = 'sha256:'),
  CHECK (expires_at = created_at + ttl_ms),
  CHECK (state <> 'consumed' OR (consumed_at IS NOT NULL AND consumed_request_hash IS NOT NULL AND revoked_at IS NULL AND revoke_reason IS NULL)),
  CHECK (state <> 'revoked' OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL AND consumed_at IS NULL AND consumed_request_hash IS NULL)),
  CHECK (state <> 'active' OR (consumed_at IS NULL AND consumed_request_hash IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL)),
  CHECK (state <> 'expired' OR (consumed_at IS NULL AND consumed_request_hash IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL))
) STRICT;

CREATE INDEX ix_egress_approval_expiry ON egress_approval(state, expires_at);

CREATE TABLE evidence_supplement_record (
  schema_version TEXT NOT NULL CHECK (schema_version = 'rsi.evidence_supplement_record/1'),
  supplement_id TEXT PRIMARY KEY CHECK (length(supplement_id) = 68 AND substr(supplement_id,1,4) = 'sup:'),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL CHECK (length(goal_version) BETWEEN 1 AND 256),
  config_version TEXT NOT NULL CHECK (length(config_version) BETWEEN 1 AND 128),
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  issue_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 71 AND substr(plan_hash,1,7) = 'sha256:'),
  pack_id TEXT NOT NULL,
  pack_key TEXT NOT NULL CHECK (length(pack_key) = 71 AND substr(pack_key,1,7) = 'sha256:'),
  pack_hash TEXT NOT NULL CHECK (length(pack_hash) = 71 AND substr(pack_hash,1,7) = 'sha256:'),
  aggregate_id TEXT NOT NULL,
  aggregate_hash TEXT NOT NULL CHECK (length(aggregate_hash) = 71 AND substr(aggregate_hash,1,7) = 'sha256:'),
  rounds_json TEXT NOT NULL CHECK (json_valid(rounds_json) AND json_type(rounds_json) = 'array'),
  read_manifest_json TEXT NOT NULL CHECK (json_valid(read_manifest_json) AND json_type(read_manifest_json) = 'array'),
  pruned_json TEXT NOT NULL CHECK (json_valid(pruned_json) AND json_type(pruned_json) = 'array'),
  gap_codes_json TEXT NOT NULL CHECK (json_valid(gap_codes_json) AND json_type(gap_codes_json) = 'array'),
  decision_json TEXT NOT NULL CHECK (json_valid(decision_json) AND json_type(decision_json) IN ('object','null')),
  outcome TEXT NOT NULL CHECK (outcome IN ('resolved','insufficient','disabled')),
  budget_cap INTEGER NOT NULL CHECK (budget_cap IN (0,1)),
  stop_reason TEXT NOT NULL,
  requires_repack INTEGER NOT NULL CHECK (requires_repack IN (0,1)),
  record_hash TEXT NOT NULL CHECK (length(record_hash) = 71 AND substr(record_hash,1,7) = 'sha256:'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
) STRICT;

CREATE INDEX ix_evidence_supplement_aggregate ON evidence_supplement_record(aggregate_hash);

CREATE INDEX ix_evidence_supplement_binding ON evidence_supplement_record(task_id, branch_id, input_epoch, watermark);

CREATE INDEX ix_evidence_supplement_pack ON evidence_supplement_record(pack_key);

CREATE TABLE experience_lifecycle_events (
  event_id                TEXT PRIMARY KEY NOT NULL,
  schema_version          TEXT NOT NULL
                            CHECK (schema_version = 'rsi.experience_lifecycle_event/1'),
  projection_id           TEXT NOT NULL REFERENCES experience_projections(projection_id)
                            ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  experience_id           TEXT NOT NULL,
  experience_version      INTEGER NOT NULL CHECK (experience_version >= 1),
  experience_content_hash TEXT NOT NULL,
  adoption_binding_hash   TEXT NOT NULL,
  sequence                INTEGER NOT NULL CHECK (sequence >= 1),
  from_lifecycle          TEXT CHECK (from_lifecycle IS NULL OR from_lifecycle IN
                            ('checked','trial','retained','disabled','revoked')),
  to_lifecycle            TEXT NOT NULL CHECK (to_lifecycle IN
                            ('checked','trial','retained','disabled','revoked')),
  reason                  TEXT NOT NULL CHECK (reason IN
                            ('adopted','trial_started','retention_rule_met','confirmed_regression',
                             'expired','superseded','user_revoked','authorization_revoked',
                             'host_incompatible','window_extended','rollback')),
  trigger_kind            TEXT NOT NULL CHECK (trigger_kind IN
                            ('adoption','begin_trial','retention_evaluated','usage_verification',
                             'user_action','expiry','supersede','host_change',
                             'authorization_change','window_extension','rollback')),
  trigger_ref             TEXT CHECK (trigger_ref IS NULL OR trigger_ref LIKE 'blob://%'
                            OR trigger_ref LIKE 'journal://%'),
  trigger_usage_ids_json  TEXT NOT NULL CHECK (json_valid(trigger_usage_ids_json)
                            AND json_type(trigger_usage_ids_json) = 'array'),
  write_id                TEXT NOT NULL CHECK (length(write_id) >= 1),
  version_binding_json    TEXT NOT NULL CHECK (json_valid(version_binding_json)
                            AND json_type(version_binding_json) = 'object'),
  projection_before_hash  TEXT,
  projection_after_hash   TEXT NOT NULL,
  projection_after_json   TEXT NOT NULL CHECK (json_valid(projection_after_json)
                            AND json_type(projection_after_json) = 'object'),
  row_version_before      INTEGER NOT NULL CHECK (row_version_before >= 0),
  row_version_after       INTEGER NOT NULL CHECK (row_version_after >= 1),
  recorded_at             INTEGER NOT NULL CHECK (recorded_at >= 0),
  event_hash              TEXT NOT NULL,
  event_blob              TEXT NOT NULL CHECK (event_blob LIKE 'blob://%'),
  UNIQUE (projection_id, sequence),
  FOREIGN KEY (experience_id, experience_version)
    REFERENCES experiences(experience_id, version) ON DELETE RESTRICT,
  CHECK (row_version_after = row_version_before + 1),
  CHECK ((sequence = 1 AND from_lifecycle IS NULL AND projection_before_hash IS NULL
          AND row_version_before = 0 AND to_lifecycle = 'checked'
          AND ((reason = 'adopted' AND trigger_kind = 'adoption')
            OR (reason = 'rollback' AND trigger_kind = 'rollback')))
      OR (sequence > 1 AND from_lifecycle IS NOT NULL
          AND projection_before_hash IS NOT NULL AND row_version_before >= 1
          AND (from_lifecycle <> to_lifecycle
               OR (from_lifecycle = 'trial' AND to_lifecycle = 'trial'
                   AND reason = 'window_extended'
                   AND trigger_kind = 'window_extension')))),
  CHECK (length(experience_content_hash) = 71 AND substr(experience_content_hash,1,7) = 'sha256:'),
  CHECK (length(adoption_binding_hash) = 71 AND substr(adoption_binding_hash,1,7) = 'sha256:'),
  CHECK (projection_before_hash IS NULL OR
    (length(projection_before_hash) = 71 AND substr(projection_before_hash,1,7) = 'sha256:')),
  CHECK (length(projection_after_hash) = 71 AND substr(projection_after_hash,1,7) = 'sha256:'),
  CHECK (length(event_hash) = 71 AND substr(event_hash,1,7) = 'sha256:')
) STRICT;

CREATE INDEX ix_experience_lifecycle_events_experience
  ON experience_lifecycle_events(experience_id, experience_version, sequence, event_id);

CREATE TABLE experience_projections (
  projection_id          TEXT PRIMARY KEY NOT NULL,
  schema_version         TEXT NOT NULL CHECK (schema_version = 'rsi.experience_projection/2'),
  experience_id          TEXT NOT NULL,
  experience_version     INTEGER NOT NULL CHECK (experience_version >= 1),
  experience_content_hash TEXT NOT NULL,
  host_id                TEXT NOT NULL,
  config_space           TEXT NOT NULL,
  mode                   TEXT NOT NULL,
  object_type            TEXT NOT NULL CHECK (object_type IN ('skill','memory','instructions')),
  path_or_block          TEXT NOT NULL,
  block_id               TEXT,
  write_id               TEXT NOT NULL UNIQUE,
  adoption_binding_json  TEXT NOT NULL CHECK (json_valid(adoption_binding_json)
                           AND json_type(adoption_binding_json) = 'object'),
  adoption_binding_hash  TEXT NOT NULL,
  lifecycle              TEXT NOT NULL CHECK (lifecycle IN
                           ('checked','trial','retained','disabled','revoked')),
  lifecycle_reason       TEXT NOT NULL CHECK (lifecycle_reason IN
                           ('adopted','trial_started','retention_rule_met','confirmed_regression',
                            'expired','superseded','user_revoked','authorization_revoked',
                            'host_incompatible','window_extended','rollback')),
  checked_at             INTEGER NOT NULL,
  write_json             TEXT NOT NULL CHECK (json_valid(write_json)
                           AND json_type(write_json) = 'object'),
  loading_evidence_json  TEXT NOT NULL CHECK (json_valid(loading_evidence_json)
                           AND json_type(loading_evidence_json) = 'object'),
  validation_plan_id     TEXT NOT NULL,
  validation_plan_hash   TEXT NOT NULL,
  verifier_json          TEXT NOT NULL CHECK (json_valid(verifier_json)
                           AND json_type(verifier_json) = 'object'),
  no_verifier            INTEGER NOT NULL CHECK (no_verifier IN (0,1)),
  retention_rule_id      TEXT NOT NULL,
  retention_json         TEXT NOT NULL CHECK (json_valid(retention_json)
                           AND json_type(retention_json) = 'object'),
  baseline_json          TEXT CHECK (baseline_json IS NULL OR
                           (json_valid(baseline_json) AND json_type(baseline_json) = 'object')),
  usage_record_ids_json  TEXT NOT NULL CHECK (json_valid(usage_record_ids_json)
                           AND json_type(usage_record_ids_json) = 'array'),
  restored_from_projection_id TEXT REFERENCES experience_projections(projection_id) ON DELETE RESTRICT,
  superseded_by_projection_id TEXT REFERENCES experience_projections(projection_id) ON DELETE RESTRICT,
  last_lifecycle_event_id TEXT NOT NULL,
  causal_supported       INTEGER NOT NULL CHECK (causal_supported = 0),
  row_version            INTEGER NOT NULL CHECK (row_version >= 1),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  FOREIGN KEY (experience_id, experience_version)
    REFERENCES experiences(experience_id, version) ON DELETE RESTRICT,
  FOREIGN KEY (validation_plan_id) REFERENCES validation_plans(validation_plan_id) ON DELETE RESTRICT,
  CHECK (length(experience_content_hash) = 71 AND substr(experience_content_hash,1,7) = 'sha256:'),
  CHECK (length(adoption_binding_hash) = 71 AND substr(adoption_binding_hash,1,7) = 'sha256:'),
  CHECK (length(validation_plan_hash) = 71 AND substr(validation_plan_hash,1,7) = 'sha256:'),
  CHECK (updated_at >= created_at),
  CHECK (checked_at <= updated_at)
) STRICT;

CREATE INDEX ix_experience_projections_candidate
  ON experience_projections(host_id, config_space, mode, lifecycle, experience_id, experience_version);

CREATE UNIQUE INDEX ux_experience_projection_active_target
  ON experience_projections(host_id, config_space, mode, object_type, path_or_block,
                            COALESCE(block_id, ''))
  WHERE lifecycle IN ('trial','retained');

CREATE TABLE experience_rollback_reconciliation (
  operation_id             TEXT PRIMARY KEY NOT NULL,
  fnd_write_id             TEXT NOT NULL,
  source_projection_id     TEXT NOT NULL
                             REFERENCES experience_projections(projection_id)
                             ON DELETE RESTRICT,
  target_projection_id     TEXT NOT NULL
                             REFERENCES experience_projections(projection_id)
                             ON DELETE RESTRICT,
  target_experience_id     TEXT NOT NULL,
  target_experience_version INTEGER NOT NULL CHECK (target_experience_version >= 1),
  target_snapshot_id       TEXT NOT NULL,
  target_snapshot_hash     TEXT NOT NULL,
  state                    TEXT NOT NULL CHECK (state IN
                             ('pending_fnd','fnd_verified','rev_committed','recovery_required')),
  error_code               TEXT,
  created_at               INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at               INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE (fnd_write_id),
  CHECK (length(target_snapshot_hash) = 71 AND substr(target_snapshot_hash, 1, 7) = 'sha256:')
) STRICT;

CREATE INDEX ix_experience_rollback_reconciliation_state
  ON experience_rollback_reconciliation(state, updated_at, operation_id);

CREATE TABLE experience_version_allocators (
  experience_id TEXT PRIMARY KEY NOT NULL,
  next_version INTEGER NOT NULL CHECK (next_version >= 1),
  row_version INTEGER NOT NULL CHECK (row_version >= 1),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

CREATE TABLE experiences (
  experience_id        TEXT NOT NULL,
  version              INTEGER NOT NULL CHECK (version >= 1),
  type                 TEXT NOT NULL CHECK (type IN
                         ('recovery_procedure','tool_workflow','project_constraint',
                          'user_preference','validation_check')),
  title                TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  summary              TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 2048),
  validation_plan_id   TEXT NOT NULL,
  validation_plan_hash TEXT NOT NULL,
  body_ref             TEXT NOT NULL,
  risk                 TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  content_hash         TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  superseded_by_version INTEGER,
  lineage_json         TEXT NOT NULL CHECK (json_valid(lineage_json)
                         AND json_type(lineage_json) = 'object'),
  trigger_json         TEXT NOT NULL CHECK (json_valid(trigger_json)
                         AND json_type(trigger_json) = 'object'),
  scope_json           TEXT NOT NULL CHECK (json_valid(scope_json)
                         AND json_type(scope_json) = 'object'),
  preconditions_json   TEXT NOT NULL CHECK (json_valid(preconditions_json)
                         AND json_type(preconditions_json) = 'array'),
  steps_json           TEXT NOT NULL CHECK (json_valid(steps_json)
                         AND json_type(steps_json) = 'array'),
  expected_effects_json TEXT NOT NULL CHECK (json_valid(expected_effects_json)
                         AND json_type(expected_effects_json) = 'array'),
  completion_check_json TEXT NOT NULL CHECK (json_valid(completion_check_json)
                         AND json_type(completion_check_json) = 'object'),
  failure_branches_json TEXT NOT NULL CHECK (json_valid(failure_branches_json)
                         AND json_type(failure_branches_json) = 'array'),
  counterexamples_json TEXT NOT NULL CHECK (json_valid(counterexamples_json)
                         AND json_type(counterexamples_json) = 'array'),
  expiry_policy_json   TEXT NOT NULL CHECK (json_valid(expiry_policy_json)
                         AND json_type(expiry_policy_json) = 'object'),
  evidence_refs_json   TEXT NOT NULL CHECK (json_valid(evidence_refs_json)
                         AND json_type(evidence_refs_json) = 'array'),
  PRIMARY KEY (experience_id, version),
  CHECK (length(validation_plan_hash) = 71
    AND substr(validation_plan_hash,1,7) = 'sha256:'),
  CHECK (length(body_ref) BETWEEN 1 AND 2048),
  CHECK (length(content_hash) = 71 AND substr(content_hash,1,7) = 'sha256:'),
  CHECK (superseded_by_version IS NULL
    OR (superseded_by_version >= 1 AND superseded_by_version <> version))
) STRICT;

CREATE INDEX ix_experiences_body_ref
  ON experiences(body_ref);

CREATE INDEX ix_experiences_candidate
  ON experiences(created_at DESC, experience_id ASC, version DESC)
  WHERE superseded_by_version IS NULL;

CREATE INDEX ix_experiences_validation_plan
  ON experiences(validation_plan_id);

CREATE TABLE grant_consumption (
  grant_id TEXT PRIMARY KEY REFERENCES authorization_grant(grant_id) ON DELETE RESTRICT,
  write_kind TEXT NOT NULL CHECK (write_kind IN ('managed','config')),
  managed_write_id TEXT UNIQUE REFERENCES write_intent(write_id) ON DELETE RESTRICT,
  config_write_id TEXT UNIQUE REFERENCES config_write_intent(config_write_id) ON DELETE RESTRICT,
  consumed_at INTEGER NOT NULL,
  CHECK ((write_kind = 'managed' AND managed_write_id IS NOT NULL AND config_write_id IS NULL)
      OR (write_kind = 'config' AND config_write_id IS NOT NULL AND managed_write_id IS NULL))
) STRICT;

CREATE TABLE input (
  input_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE RESTRICT,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  parent_input_id TEXT REFERENCES input(input_id) ON DELETE RESTRICT,
  origin TEXT NOT NULL CHECK (origin IN ('human','user','agent','evaluator','system','host','unknown')),
  human_attestation_json TEXT,
  directive_strength TEXT NOT NULL CHECK (directive_strength IN ('explicit','ambiguous')),
  content_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  receipt_seq INTEGER NOT NULL UNIQUE CHECK (receipt_seq > 0),
  UNIQUE (branch_id, input_epoch),
  CHECK ((origin = 'human' AND human_attestation_json IS NOT NULL) OR (origin <> 'human' AND human_attestation_json IS NULL))
) STRICT;

CREATE INDEX ix_input_session ON input(session_id, received_at);

CREATE TABLE install_backup (
  backup_id TEXT PRIMARY KEY,
  install_id TEXT NOT NULL REFERENCES install_manifest(install_id) ON DELETE RESTRICT,
  path TEXT NOT NULL,
  content_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','tombstoned')),
  tombstoned_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK ((state = 'active' AND tombstoned_at IS NULL) OR (state = 'tombstoned' AND tombstoned_at IS NOT NULL))
) STRICT;

CREATE TABLE install_manifest (
  install_id TEXT PRIMARY KEY,
  product_version TEXT NOT NULL,
  schema_major INTEGER NOT NULL,
  install_root TEXT NOT NULL UNIQUE,
  home_root TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('installing','installed','detaching','uninstalled','failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE install_path (
  install_id TEXT NOT NULL REFERENCES install_manifest(install_id) ON DELETE RESTRICT,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file','directory','host_config_block','host_registration','runtime_binary')),
  ownership TEXT NOT NULL CHECK (ownership IN ('managed','host_managed_block')),
  marker_id TEXT,
  installed_hash TEXT,
  origin_hash TEXT,
  state TEXT NOT NULL CHECK (state IN ('present','removed','modified_by_user','missing','restored')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (install_id, path)
) STRICT;

CREATE TABLE ipc_idempotency (
  client_id TEXT NOT NULL,
  method TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_progress','succeeded','failed','uncertain')),
  response_json TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, method, idempotency_key),
  CHECK (state <> 'in_progress' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
) STRICT;

CREATE INDEX ix_ipc_idem_expiry ON ipc_idempotency(expires_at);

CREATE TABLE issue_judgment (
  object_id TEXT PRIMARY KEY,
  row_version INTEGER NOT NULL CHECK (row_version >= 1),
  judgment_id TEXT NOT NULL UNIQUE
    CHECK (substr(judgment_id,1,5) = 'judg:' AND length(judgment_id) = 31),
  issue_id TEXT NOT NULL,
  issue_key TEXT NOT NULL,
  issue_version INTEGER NOT NULL CHECK (issue_version >= 1),
  decision_kind TEXT NOT NULL CHECK (decision_kind IN ('answer_aggregate','local_facts')),
  basis TEXT NOT NULL CHECK (basis IN ('hard_fact','mixed')),
  outcome TEXT NOT NULL CHECK (outcome IN
    ('consistent','inconsistent','satisfied','not_satisfied')),
  accepted INTEGER NOT NULL CHECK (accepted = 1),
  judgment_hash TEXT NOT NULL CHECK (length(judgment_hash) = 71 AND substr(judgment_hash,1,7) = 'sha256:'),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND substr(content_hash,1,7) = 'sha256:'),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  CHECK (object_id = judgment_id),
  CHECK (content_hash = judgment_hash),
  UNIQUE (issue_id, issue_version)
) STRICT;

CREATE INDEX ix_issue_judgment_issue ON issue_judgment(issue_id, issue_version);

CREATE TABLE issue_projection (
  object_id TEXT PRIMARY KEY,
  row_version INTEGER NOT NULL CHECK (row_version >= 1),
  issue_id TEXT NOT NULL UNIQUE,
  issue_key TEXT NOT NULL,
  issue_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('proposed','open','needs_evidence','judged','abstained','closed','stale_goal','rejected')),
  issue_version INTEGER NOT NULL CHECK (issue_version >= 1),
  input_epoch INTEGER NOT NULL,
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND substr(content_hash,1,7) = 'sha256:'),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  updated_at INTEGER NOT NULL,
  CHECK (object_id = issue_id)
) STRICT;

CREATE UNIQUE INDEX ux_issue_projection_active_key ON issue_projection(issue_key)
  WHERE state IN ('proposed','open','needs_evidence','judged','abstained');

CREATE TABLE issue_transition (
  object_id TEXT PRIMARY KEY,
  row_version INTEGER NOT NULL CHECK (row_version >= 1),
  transition_id TEXT NOT NULL UNIQUE,
  issue_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  issue_version INTEGER NOT NULL CHECK (issue_version >= 1),
  from_state TEXT NOT NULL CHECK (from_state IN
    ('none','proposed','open','needs_evidence','judged','abstained','closed','stale_goal','rejected')),
  to_state TEXT NOT NULL CHECK (to_state IN
    ('proposed','open','needs_evidence','judged','abstained','closed','stale_goal','rejected')),
  event TEXT NOT NULL CHECK (event IN
    ('propose','confirm','reject','require_evidence','supply_evidence','judge','abstain',
     'reopen_evidence','close','reopen','review_handoff_close','review_handoff_reject',
     'invalidate_goal','reject_issue','attach_evidence')),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 71 AND substr(payload_hash,1,7) = 'sha256:'),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND substr(content_hash,1,7) = 'sha256:'),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  CHECK (object_id = transition_id),
  CHECK (issue_version = expected_version + 1),
  CHECK ((expected_version = 0) = (from_state = 'none')),
  UNIQUE (issue_id, issue_version)
) STRICT;

CREATE INDEX ix_issue_transition_issue ON issue_transition(issue_id, issue_version);

CREATE TABLE journal_state (
  journal_id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  base_commit_seq INTEGER NOT NULL,
  last_commit_seq INTEGER NOT NULL,
  trusted_prefix_end INTEGER NOT NULL,
  tail_state TEXT NOT NULL CHECK (tail_state IN ('clean','corrupt_tail','corrupt_middle')),
  read_only INTEGER NOT NULL CHECK (read_only IN (0,1)),
  quarantine_ref TEXT,
  updated_at INTEGER NOT NULL,
  CHECK (base_commit_seq >= 0 AND last_commit_seq >= base_commit_seq AND trusted_prefix_end >= 0)
) STRICT;

CREATE TABLE maintenance_run (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('gc','recovery','migration','backup')),
  mode TEXT NOT NULL CHECK (mode IN ('dry_run','apply')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  report_json TEXT NOT NULL,
  run_hash TEXT NOT NULL
) STRICT;

CREATE TABLE native_id_map (
  session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE RESTRICT,
  host_id TEXT NOT NULL,
  config_space TEXT NOT NULL,
  native_kind TEXT NOT NULL CHECK (native_kind IN ('message','turn','event','prompt','other')),
  native_message_id TEXT NOT NULL,
  input_id TEXT NOT NULL REFERENCES input(input_id) ON DELETE RESTRICT,
  source_event_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, host_id, config_space, native_kind, native_message_id)
) STRICT;

CREATE INDEX ix_native_map_input ON native_id_map(input_id);

CREATE TABLE object_document (
  document_id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL,
  owner TEXT NOT NULL CHECK (owner IN ('evd','rev','host','cfg','qp')),
  object_type TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL,
  task_id TEXT,
  branch_id TEXT,
  input_epoch INTEGER,
  goal_version TEXT,
  config_version TEXT,
  watermark INTEGER,
  content_hash TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (object_id, revision),
  UNIQUE (owner, object_type, object_id, revision),
  CHECK (length(document_id) = 71 AND substr(document_id,1,7) = 'sha256:'),
  CHECK (length(CAST(canonical_json AS BLOB)) <= 1048576)
) STRICT;

CREATE INDEX ix_object_document_binding ON object_document(owner, object_type, task_id, branch_id, watermark);

CREATE INDEX ix_object_document_object ON object_document(object_id, revision);

CREATE TABLE object_head (
  object_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL CHECK (owner IN ('evd','rev','host','cfg','qp')),
  object_type TEXT NOT NULL,
  revision INTEGER NOT NULL,
  document_id TEXT NOT NULL REFERENCES object_document(document_id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_at INTEGER NOT NULL,
  UNIQUE (owner, object_type, object_id),
  CHECK (length(document_id) = 71 AND substr(document_id,1,7) = 'sha256:')
) STRICT;

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
  FOREIGN KEY (owner, object_type, pending_id, row_version)
    REFERENCES object_document(owner, object_type, object_id, revision)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX ix_pending_entry_due
  ON pending_entry(kind, pending_state, deadline_at, pending_id);

CREATE UNIQUE INDEX ux_pending_defer_active
  ON pending_entry(boundary_key)
  WHERE kind = 'review_defer' AND pending_state = 'waiting';

CREATE UNIQUE INDEX ux_pending_delivery_active
  ON pending_entry(host_id, config_space, session_ref, boundary_event_ref, delivery_target_hash)
  WHERE kind = 'delivery' AND pending_state IN ('pending','submitted_not_verified');

CREATE UNIQUE INDEX ux_pending_entry_key ON pending_entry(pending_key);

CREATE UNIQUE INDEX ux_pending_resume_active
  ON pending_entry(review_job_id)
  WHERE kind = 'generation_resume' AND pending_state IN ('queued','resuming','blocked_no_backend');

CREATE TABLE plan_state (
  object_id TEXT PRIMARY KEY,
  row_version INTEGER NOT NULL CHECK (row_version >= 1),
  plan_id TEXT NOT NULL,
  state_seq INTEGER NOT NULL CHECK (state_seq >= 1),
  state TEXT NOT NULL CHECK (state IN
    ('active','superseded','stale_goal','stale_binding','stale_template','rejected')),
  reason_code TEXT,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 71 AND substr(plan_hash,1,7) = 'sha256:'),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND substr(content_hash,1,7) = 'sha256:'),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (plan_id, state_seq),
  CHECK (object_id = 'plan_state:' || plan_id || ':' || printf('%d', state_seq))
) STRICT;

CREATE INDEX ix_plan_state_plan ON plan_state(plan_id, state_seq);

CREATE TABLE progress_checkpoint (
  checkpoint_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL CHECK (owner = 'host'),
  object_type TEXT NOT NULL CHECK (object_type = 'progress_checkpoint'),
  revision INTEGER NOT NULL CHECK (revision = 1),
  state TEXT NOT NULL CHECK (state = 'recorded'),
  checkpoint_kind TEXT NOT NULL CHECK (checkpoint_kind IN ('input_boundary','stable_boundary')),
  task_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  trigger_event_id TEXT NOT NULL,
  source_event_ref TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 71 AND substr(content_hash, 1, 7) = 'sha256:'),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (owner, object_type, checkpoint_id, revision)
    REFERENCES object_document(owner, object_type, object_id, revision)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX ix_progress_checkpoint_window
  ON progress_checkpoint(task_id, branch_id, input_epoch, goal_version,
                         config_version, watermark, checkpoint_id);

CREATE UNIQUE INDEX ux_progress_checkpoint_event
  ON progress_checkpoint(trigger_event_id, checkpoint_kind);

CREATE TABLE proposal_candidates (
  candidate_key        TEXT PRIMARY KEY NOT NULL,
  job_id               TEXT NOT NULL REFERENCES review_jobs(job_id) ON DELETE RESTRICT,
  attempt_id           TEXT NOT NULL REFERENCES review_attempts(attempt_id) ON DELETE RESTRICT,
  ordinal              INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 16),
  version_binding_json TEXT NOT NULL
                         CHECK (json_valid(version_binding_json)
                           AND json_type(version_binding_json) = 'object'),
  output_ref           TEXT NOT NULL,
  output_hash          TEXT NOT NULL,
  candidate_ref        TEXT NOT NULL,
  candidate_json_hash  TEXT NOT NULL,
  generator_json       TEXT NOT NULL
                         CHECK (json_valid(generator_json)
                           AND json_type(generator_json) = 'object'),
  state                TEXT NOT NULL CHECK (state IN ('pending','accepted','rejected','stale')),
  failure_code         TEXT CHECK (failure_code IS NULL OR failure_code IN (
                         'E_PROPOSAL_DIFF_TOO_LARGE','E_EXPERIENCE_TOO_LARGE',
                         'E_PROPOSAL_UNTRUSTED_FIELD','E_PROPOSAL_SCHEMA','E_EXPERIENCE_SCHEMA',
                         'E_PROPOSAL_TARGET','E_PROPOSAL_OLD_HASH_MISSING','E_PROPOSAL_OLD_HASH_MISMATCH',
                         'E_PROPOSAL_DIFF_MISMATCH','E_PROPOSAL_DIFF_APPLY',
                         'E_PROPOSAL_EVIDENCE_NOT_ALLOWED','E_PROPOSAL_SCOPE',
                         'E_PROPOSAL_PROTECTED_FIELD','E_EXPERIENCE_PLAN_SOURCE_CHANGED',
                         'E_EXPERIENCE_VERIFIER_BINDING','E_PROPOSAL_NO_CHANGE',
                         'E_PROPOSAL_STALE_TARGET')),
  failure_step         TEXT CHECK (failure_step IS NULL OR failure_step IN (
                         'P0a','P0b','S0a','S0b','S0c','S1a','S1b','S2a','S2b',
                         'S3a','S3b','S3c','S4','S5','S6','S7a','S7b','S8','S9')),
  diagnostic_ref       TEXT,
  proposal_id          TEXT REFERENCES proposals(proposal_id) ON DELETE RESTRICT,
  proposal_hash        TEXT,
  experience_id        TEXT,
  experience_version   INTEGER,
  accepted_bundle_ref  TEXT,
  row_version          INTEGER NOT NULL DEFAULT 1 CHECK (row_version IN (1,2)),
  created_at           INTEGER NOT NULL,
  checked_at           INTEGER,
  UNIQUE (attempt_id, ordinal),
  UNIQUE (proposal_id),
  FOREIGN KEY (experience_id, experience_version)
    REFERENCES experiences(experience_id, version) ON DELETE RESTRICT,
  CHECK (length(candidate_key) = 71 AND substr(candidate_key,1,7) = 'sha256:'),
  CHECK (length(output_hash) = 71 AND substr(output_hash,1,7) = 'sha256:'),
  CHECK (length(candidate_json_hash) = 71 AND substr(candidate_json_hash,1,7) = 'sha256:'),
  CHECK (proposal_hash IS NULL
    OR (length(proposal_hash) = 71 AND substr(proposal_hash,1,7) = 'sha256:')),
  CHECK (state = 'pending'
    OR (checked_at IS NOT NULL AND checked_at >= created_at)),
  CHECK ((state = 'pending'
      AND failure_code IS NULL AND failure_step IS NULL AND diagnostic_ref IS NULL
      AND proposal_id IS NULL AND proposal_hash IS NULL
      AND experience_id IS NULL AND experience_version IS NULL
      AND accepted_bundle_ref IS NULL AND checked_at IS NULL AND row_version = 1)
    OR (state = 'accepted'
      AND failure_code IS NULL AND failure_step IS NULL AND diagnostic_ref IS NULL
      AND proposal_id IS NOT NULL AND proposal_hash IS NOT NULL
      AND experience_id IS NOT NULL AND experience_version IS NOT NULL
      AND experience_version >= 1
      AND accepted_bundle_ref IS NOT NULL AND row_version = 2)
    OR (state = 'rejected'
      AND failure_code IS NOT NULL AND failure_code <> 'E_PROPOSAL_STALE_TARGET'
      AND failure_step IS NOT NULL AND failure_step <> 'S9'
      AND diagnostic_ref IS NOT NULL AND proposal_id IS NULL AND proposal_hash IS NULL
      AND experience_id IS NULL AND experience_version IS NULL
      AND accepted_bundle_ref IS NULL AND row_version = 2)
    OR (state = 'stale'
      AND failure_code = 'E_PROPOSAL_STALE_TARGET' AND failure_step = 'S9'
      AND diagnostic_ref IS NOT NULL AND proposal_id IS NULL AND proposal_hash IS NULL
      AND experience_id IS NULL AND experience_version IS NULL
      AND accepted_bundle_ref IS NULL AND row_version = 2))
) STRICT;

CREATE INDEX ix_proposal_candidates_job_state
  ON proposal_candidates(job_id, state, ordinal);

CREATE TABLE proposals (
  proposal_id          TEXT PRIMARY KEY NOT NULL,
  proposal_hash        TEXT NOT NULL,
  job_id               TEXT NOT NULL REFERENCES review_jobs(job_id) ON DELETE RESTRICT,
  attempt_id           TEXT NOT NULL REFERENCES review_attempts(attempt_id) ON DELETE RESTRICT,
  ordinal              INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 16),
  question_key         TEXT,
  state                TEXT NOT NULL CHECK (state IN
                         ('checked','unverified','proposed','stale','withdrawn','adopted')),
  change_kind          TEXT NOT NULL CHECK (change_kind IN
                         ('create','update','disable','rollback')),
  expected_file_hash   TEXT,
  expected_block_hash  TEXT,
  base_ref             TEXT,
  create_policy        TEXT CHECK (create_policy IS NULL OR create_policy = 'must_not_exist'),
  candidate_hash       TEXT NOT NULL,
  candidate_file_hash  TEXT NOT NULL,
  candidate_block_hash TEXT,
  experience_type      TEXT NOT NULL CHECK (experience_type IN
                         ('recovery_procedure','tool_workflow','project_constraint',
                          'user_preference','validation_check')),
  handoff_id           TEXT,
  adoption_ref         TEXT,
  stale_reason         TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  version              INTEGER NOT NULL CHECK (version >= 1),
  target_json          TEXT NOT NULL CHECK (json_valid(target_json)
                         AND json_type(target_json) = 'object'),
  diff_json            TEXT NOT NULL CHECK (json_valid(diff_json)
                         AND json_type(diff_json) = 'object'),
  experience_json      TEXT NOT NULL CHECK (json_valid(experience_json)
                         AND json_type(experience_json) = 'object'),
  normalization_json   TEXT NOT NULL CHECK (json_valid(normalization_json)
                         AND json_type(normalization_json) = 'object'),
  evidence_refs_json   TEXT NOT NULL CHECK (json_valid(evidence_refs_json)
                         AND json_type(evidence_refs_json) = 'array'),
  egress_decision_ref  TEXT,
  generator_json       TEXT NOT NULL CHECK (json_valid(generator_json)
                         AND json_type(generator_json) = 'object'),
  static_check_json    TEXT NOT NULL CHECK (json_valid(static_check_json)
                         AND json_type(static_check_json) = 'object'),
  match_judge_json     TEXT NOT NULL CHECK (json_valid(match_judge_json)
                         AND json_type(match_judge_json) = 'object'),
  UNIQUE (attempt_id, ordinal),
  CHECK (length(proposal_hash) = 71 AND substr(proposal_hash,1,7) = 'sha256:'),
  CHECK (length(candidate_hash) = 71 AND substr(candidate_hash,1,7) = 'sha256:'),
  CHECK (length(candidate_file_hash) = 71 AND substr(candidate_file_hash,1,7) = 'sha256:'),
  CHECK (expected_file_hash IS NULL
    OR (length(expected_file_hash) = 71 AND substr(expected_file_hash,1,7) = 'sha256:')),
  CHECK (expected_block_hash IS NULL
    OR (length(expected_block_hash) = 71 AND substr(expected_block_hash,1,7) = 'sha256:')),
  CHECK (candidate_block_hash IS NULL
    OR (length(candidate_block_hash) = 71 AND substr(candidate_block_hash,1,7) = 'sha256:')),
  CHECK (updated_at >= created_at)
) STRICT;

CREATE INDEX ix_proposals_attempt ON proposals(attempt_id, ordinal);

CREATE INDEX ix_proposals_job_state ON proposals(job_id, state, ordinal);

CREATE TABLE quarantine (
  quarantine_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('journal','event','transition','idempotency')),
  journal_id TEXT,
  byte_offset INTEGER,
  commit_seq INTEGER,
  reason_code TEXT NOT NULL,
  payload_hash TEXT,
  bytes_ref TEXT,
  discovered_at INTEGER NOT NULL,
  resolved_at INTEGER,
  CHECK (byte_offset IS NULL OR byte_offset >= 0)
) STRICT;

CREATE TABLE question_plan (
  object_id TEXT PRIMARY KEY,
  row_version INTEGER NOT NULL CHECK (row_version >= 1),
  plan_id TEXT NOT NULL UNIQUE,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 71 AND substr(plan_hash,1,7) = 'sha256:'),
  planning_idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(planning_idempotency_key) = 71 AND substr(planning_idempotency_key,1,7) = 'sha256:'),
  issue_id TEXT NOT NULL,
  issue_key TEXT NOT NULL,
  issue_type TEXT NOT NULL,
  issue_version INTEGER NOT NULL CHECK (issue_version >= 1),
  state_profile TEXT NOT NULL CHECK (state_profile IN ('progress_issue','experience_review')),
  registry_version TEXT NOT NULL,
  registry_hash TEXT NOT NULL CHECK (length(registry_hash) = 71 AND substr(registry_hash,1,7) = 'sha256:'),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND substr(content_hash,1,7) = 'sha256:'),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  input_epoch INTEGER NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  supersedes_plan_id TEXT,
  created_at INTEGER NOT NULL,
  CHECK (object_id = plan_id),
  UNIQUE (issue_key, plan_hash)
) STRICT;

CREATE INDEX ix_question_plan_issue ON question_plan(issue_key);

CREATE TABLE replay_execution (
  execution_id TEXT PRIMARY KEY,
  replay_plan_id TEXT NOT NULL REFERENCES replay_plan(replay_plan_id) ON DELETE RESTRICT,
  approval_id TEXT REFERENCES replay_approval(approval_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('authorized','running','passed','failed','unknown','cancelled')),
  fencing_token TEXT NOT NULL,
  reconcile_required INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_required IN (0,1)),
  reconciled_at INTEGER,
  reconcile_evidence_ref TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  exit_code INTEGER,
  stdout_ref TEXT,
  stderr_ref TEXT,
  result_hash TEXT,
  error_code TEXT,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at INTEGER NOT NULL,
  CHECK (state NOT IN ('running','passed') OR started_at IS NOT NULL),
  CHECK (state NOT IN ('passed','failed','cancelled') OR ended_at IS NOT NULL),
  CHECK (stdout_ref IS NULL OR state IN ('running','passed','failed','unknown')),
  CHECK (reconciled_at IS NULL OR reconcile_evidence_ref IS NOT NULL),
  CHECK (reconcile_required = 0 OR (reconciled_at IS NULL AND reconcile_evidence_ref IS NULL)),
  CHECK (state <> 'unknown' OR reconcile_required = 1 OR
    (reconciled_at IS NOT NULL AND reconcile_evidence_ref IS NOT NULL)),
  CHECK (reconcile_required = 0 OR state = 'unknown')
) STRICT;

CREATE INDEX ix_replay_execution_result ON replay_execution(replay_plan_id, created_at);

CREATE UNIQUE INDEX ux_replay_execution_active ON replay_execution(replay_plan_id)
  WHERE state IN ('authorized','running');

CREATE TABLE replay_plan (
  replay_plan_id TEXT PRIMARY KEY,
  validation_plan_id TEXT NOT NULL,
  replay_class TEXT NOT NULL CHECK (replay_class IN ('read_only','sandboxed_temp','live_external')),
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  allowed_network INTEGER NOT NULL CHECK (allowed_network IN (0,1)),
  network_target TEXT,
  classification_evidence TEXT NOT NULL CHECK (classification_evidence IN ('tool_metadata','observed_effects','none')),
  environment TEXT NOT NULL CHECK (environment IN ('host','temp_copy','sandbox')),
  isolation_json TEXT NOT NULL,
  version_binding_json TEXT NOT NULL,
  side_effect_kinds_json TEXT NOT NULL,
  side_effect_refs_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planned','running','passed','failed','rejected','unverified')),
  plan_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CHECK (replay_class <> 'sandboxed_temp'
      OR (COALESCE(json_extract(isolation_json, '$.verified'), 0) = 1
          AND json_extract(isolation_json, '$.mechanism') IN ('container','vm','os_sandbox'))),
  CHECK (replay_class <> 'read_only' OR classification_evidence IN ('tool_metadata','observed_effects')),
  CHECK (allowed_network = 1 OR network_target IS NULL),
  CHECK (json_type(isolation_json) = 'object')
) STRICT;

CREATE UNIQUE INDEX ux_replay_plan_hash ON replay_plan(validation_plan_id, plan_hash);

CREATE TABLE requirement_op (
  op_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  source_event_id TEXT NOT NULL,
  actor_origin TEXT NOT NULL CHECK (actor_origin IN ('human','user','agent','evaluator','system','host','unknown')),
  directive_strength TEXT NOT NULL CHECK (directive_strength IN ('explicit','ambiguous')),
  op TEXT NOT NULL CHECK (op IN ('add','clarify','supersede','retract','confirm')),
  target_requirement_id TEXT,
  created_requirement_id TEXT,
  superseded_requirement_ids_json TEXT NOT NULL,
  statement_ref TEXT,
  scope_json TEXT NOT NULL,
  acceptance_json TEXT NOT NULL,
  source_quote_ref TEXT NOT NULL,
  source_text_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applied','proposed','conflict','rejected')),
  recorded_at INTEGER NOT NULL,
  valid_from_event INTEGER NOT NULL,
  valid_to_event INTEGER,
  effective_input_epoch INTEGER NOT NULL CHECK (effective_input_epoch >= 1),
  goal_version_before TEXT NOT NULL,
  goal_version_after TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  CHECK (valid_to_event IS NULL OR valid_to_event >= valid_from_event),
  CHECK (status <> 'applied' OR actor_origin = 'human'),
  CHECK (status <> 'applied' OR directive_strength = 'explicit'),
  CHECK (json_type(scope_json) = 'object'),
  CHECK (json_type(acceptance_json) = 'array'),
  CHECK (json_type(superseded_requirement_ids_json) = 'array'),
  CHECK ((op IN ('add','clarify','supersede') AND statement_ref IS NOT NULL)
      OR (op IN ('retract','confirm') AND statement_ref IS NULL)),
  CHECK (op <> 'add' OR (target_requirement_id IS NULL AND json_array_length(superseded_requirement_ids_json) = 0)),
  CHECK (op <> 'clarify' OR (target_requirement_id IS NOT NULL AND json_array_length(superseded_requirement_ids_json) = 0)),
  CHECK (op <> 'supersede' OR (target_requirement_id IS NOT NULL
      AND json_array_length(superseded_requirement_ids_json) > 0)),
  CHECK (op <> 'confirm' OR target_requirement_id IS NOT NULL),
  CHECK (op <> 'retract' OR json_array_length(superseded_requirement_ids_json) > 0),
  CHECK (op IN ('add','clarify','supersede') OR (scope_json = '{}' AND acceptance_json = '[]')),
  CHECK (op IN ('add','clarify','supersede','retract','confirm'))
) STRICT;

CREATE INDEX ix_req_op_branch_time ON requirement_op(branch_id, recorded_at);

CREATE INDEX ix_req_op_source ON requirement_op(source_event_id);

CREATE TABLE review_attempts (
  attempt_id            TEXT PRIMARY KEY NOT NULL,
  attempt_key           TEXT NOT NULL UNIQUE,
  job_id                TEXT NOT NULL REFERENCES review_jobs(job_id) ON DELETE RESTRICT,
  ordinal               INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 10),
  state                 TEXT NOT NULL CHECK (state IN
                         ('queued','leased','running','succeeded','failed','cancelled','lost')),
  backend_json          TEXT NOT NULL CHECK (json_valid(backend_json)
                         AND json_type(backend_json) = 'object'),
  model_id              TEXT NOT NULL,
  protocol_version      TEXT NOT NULL CHECK (protocol_version = 'rsi.generator_protocol/1'),
  host_run_json         TEXT NOT NULL CHECK (json_valid(host_run_json)
                         AND json_type(host_run_json) = 'object'),
  isolation_json        TEXT NOT NULL CHECK (json_valid(isolation_json)
                         AND json_type(isolation_json) = 'object'),
  input_manifest_ref    TEXT NOT NULL,
  input_manifest_hash   TEXT NOT NULL,
  output_ref            TEXT NOT NULL,
  output_hash           TEXT,
  budget_json           TEXT NOT NULL CHECK (json_valid(budget_json)
                         AND json_type(budget_json) = 'object'),
  deadline_at           INTEGER,
  lease_json            TEXT CHECK (lease_json IS NULL OR
                         (json_valid(lease_json) AND json_type(lease_json) = 'object')),
  cancel_json           TEXT NOT NULL CHECK (json_valid(cancel_json)
                         AND json_type(cancel_json) = 'object'),
  output_json           TEXT CHECK (output_json IS NULL OR
                         (json_valid(output_json) AND json_type(output_json) = 'object')),
  completion_evidence_ref TEXT,
  allowance_charge_json TEXT NOT NULL CHECK (json_valid(allowance_charge_json)
                         AND json_type(allowance_charge_json) = 'object'),
  provider_usage_json   TEXT NOT NULL CHECK (json_valid(provider_usage_json)
                         AND json_type(provider_usage_json) = 'object'),
  generator_reported_usage_json TEXT CHECK (generator_reported_usage_json IS NULL OR
                         (json_valid(generator_reported_usage_json)
                          AND json_type(generator_reported_usage_json) = 'object')),
  exit_json             TEXT CHECK (exit_json IS NULL OR
                         (json_valid(exit_json) AND json_type(exit_json) = 'object')),
  last_error_json       TEXT CHECK (last_error_json IS NULL OR
                         (json_valid(last_error_json) AND json_type(last_error_json) = 'object')),
  started_at            INTEGER,
  ended_at              INTEGER,
  row_version           INTEGER NOT NULL CHECK (row_version >= 1),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE (job_id, ordinal),
  CHECK (length(attempt_key) = 71 AND substr(attempt_key,1,7) = 'sha256:'),
  CHECK (length(input_manifest_hash) = 71 AND substr(input_manifest_hash,1,7) = 'sha256:'),
  CHECK (updated_at >= created_at),
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
) STRICT;

CREATE INDEX ix_review_attempts_job_state ON review_attempts(job_id, state, ordinal);

CREATE TABLE review_enqueue_requests (
  request_id           TEXT PRIMARY KEY NOT NULL,
  schema_version       TEXT NOT NULL CHECK (schema_version = 'rsi.review_enqueue/1'),
  request_hash         TEXT NOT NULL UNIQUE,
  trigger_event_id     TEXT NOT NULL CHECK (length(trigger_event_id) >= 1),
  trigger_kind         TEXT NOT NULL CHECK (trigger_kind IN
                          ('task_stable','user_review_request','experience_trigger','session_end')),
  trigger_dedupe_key   TEXT NOT NULL,
  version_binding_json TEXT NOT NULL CHECK (json_valid(version_binding_json)
                          AND json_type(version_binding_json) = 'object'),
  stable_evidence_ref  TEXT NOT NULL CHECK (stable_evidence_ref LIKE 'blob://%'
                          OR stable_evidence_ref LIKE 'journal://%'),
  request_json         TEXT NOT NULL CHECK (json_valid(request_json)
                          AND json_type(request_json) = 'object'),
  result_json          TEXT NOT NULL CHECK (json_valid(result_json)
                          AND json_type(result_json) = 'object'),
  review_job_id        TEXT NOT NULL UNIQUE
                         REFERENCES review_jobs(job_id) ON DELETE RESTRICT
                         DEFERRABLE INITIALLY DEFERRED,
  created_at           INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (length(request_hash) = 71 AND substr(request_hash,1,7) = 'sha256:'),
  CHECK (length(trigger_dedupe_key) = 71 AND substr(trigger_dedupe_key,1,7) = 'sha256:'),
  CHECK (json_extract(request_json,'$.schema_version') = 'rsi.review_enqueue/1'),
  CHECK (json_extract(request_json,'$.request_id') = request_id),
  CHECK (json_extract(result_json,'$.schema_version') = 'rsi.review_enqueue_result/1'),
  CHECK (json_extract(result_json,'$.request_id') = request_id),
  CHECK (json_extract(result_json,'$.disposition') = 'created'),
  CHECK (json_extract(result_json,'$.review_job_id') = review_job_id)
) STRICT;

CREATE INDEX ix_review_enqueue_requests_job
  ON review_enqueue_requests(review_job_id, created_at);

CREATE TABLE review_handoff_delivery (
  handoff_id       TEXT PRIMARY KEY NOT NULL
                   REFERENCES review_handoffs(handoff_id) ON DELETE RESTRICT,
  job_id           TEXT NOT NULL UNIQUE
                   REFERENCES review_jobs(job_id) ON DELETE RESTRICT,
  state            TEXT NOT NULL CHECK (state IN ('pending','done')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code  TEXT,
  next_attempt_at  INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  created_at       INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at       INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE INDEX ix_review_handoff_delivery_due
  ON review_handoff_delivery(state, next_attempt_at, handoff_id);

CREATE TABLE review_handoffs (
  handoff_id          TEXT PRIMARY KEY NOT NULL,
  schema_version      TEXT NOT NULL CHECK (schema_version = 'rsi.review_handoff/2'),
  job_id              TEXT NOT NULL UNIQUE
                        REFERENCES review_jobs(job_id) ON DELETE RESTRICT,
  snapshot_id         TEXT NOT NULL
                        REFERENCES review_snapshots(snapshot_id) ON DELETE RESTRICT,
  snapshot_hash       TEXT NOT NULL,
  policy_version      TEXT NOT NULL CHECK (length(policy_version) >= 1),
  stage_results_json  TEXT NOT NULL CHECK (json_valid(stage_results_json)
                        AND json_type(stage_results_json) = 'array'),
  proposals_json      TEXT NOT NULL CHECK (json_valid(proposals_json)
                        AND json_type(proposals_json) = 'array'),
  job_result          TEXT NOT NULL CHECK (job_result IN
                        ('proposed','no_candidate','all_rejected','all_stale')),
  handoff_hash        TEXT NOT NULL,
  body_blob           TEXT NOT NULL CHECK (body_blob LIKE 'blob://%'),
  created_at          INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (length(snapshot_hash) = 71 AND substr(snapshot_hash,1,7) = 'sha256:'),
  CHECK (length(handoff_hash) = 71 AND substr(handoff_hash,1,7) = 'sha256:')
) STRICT;

CREATE INDEX ix_review_handoffs_snapshot
  ON review_handoffs(snapshot_id, created_at, handoff_id);

CREATE TABLE review_jobs (
  job_id                TEXT PRIMARY KEY NOT NULL,
  request_id            TEXT NOT NULL
                          REFERENCES review_enqueue_requests(request_id)
                          ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  task_id               TEXT NOT NULL,
  branch_id             TEXT NOT NULL,
  snapshot_id           TEXT NOT NULL
                          REFERENCES review_snapshots(snapshot_id) ON DELETE RESTRICT,
  snapshot_hash         TEXT NOT NULL,
  trigger_event_id      TEXT NOT NULL,
  trigger_kind          TEXT NOT NULL,
  review_kind           TEXT NOT NULL CHECK (review_kind IN ('auto','explicit')),
  review_scope_key      TEXT NOT NULL,
  boundary_key          TEXT NOT NULL,
  trigger_dedupe_key    TEXT NOT NULL UNIQUE,
  signal_digest         TEXT NOT NULL,
  stable_event_ids_json TEXT NOT NULL CHECK (json_valid(stable_event_ids_json)
                         AND json_type(stable_event_ids_json) = 'array'),
  stable_watermark      INTEGER NOT NULL,
  stable                INTEGER NOT NULL CHECK (stable IN (0,1)),
  stable_evidence_ref   TEXT NOT NULL,
  pending_state         TEXT NOT NULL CHECK (pending_state IN ('none','pending','unknown')),
  pending_work_refs_json TEXT NOT NULL CHECK (json_valid(pending_work_refs_json)
                         AND json_type(pending_work_refs_json) = 'array'),
  scope_json            TEXT NOT NULL CHECK (json_valid(scope_json)
                         AND json_type(scope_json) = 'object'),
  origin_json           TEXT NOT NULL CHECK (json_valid(origin_json)
                         AND json_type(origin_json) = 'object'),
  policy_ref            TEXT NOT NULL,
  policy_version        TEXT NOT NULL,
  policy_hash           TEXT NOT NULL,
  capability_snapshot_hash TEXT NOT NULL,
  budget_policy_ref     TEXT NOT NULL,
  budget_policy_hash    TEXT NOT NULL,
  authorization_ref     TEXT,
  input_epoch           INTEGER NOT NULL CHECK (input_epoch >= 0),
  goal_version          TEXT NOT NULL,
  config_version        TEXT NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN
                         ('queued','blocked_no_backend','generating','proposed',
                          'stale','done','failed','cancelled')),
  stage                 TEXT NOT NULL CHECK (stage IN
                         ('snapshot','generate','static_check','experience_match_judge',
                          'handoff','closed')),
  block_reason          TEXT,
  backend_json          TEXT NOT NULL CHECK (json_valid(backend_json)
                         AND json_type(backend_json) = 'object'),
  active_attempt_id     TEXT,
  current_fencing_token INTEGER NOT NULL CHECK (current_fencing_token >= 0),
  attempt_count         INTEGER NOT NULL CHECK (attempt_count >= 0),
  proposal_ids_json     TEXT NOT NULL CHECK (json_valid(proposal_ids_json)
                         AND json_type(proposal_ids_json) = 'array'),
  handoff_id            TEXT,
  handoff_body_ref      TEXT CHECK (handoff_body_ref IS NULL OR
                         (length(handoff_body_ref) BETWEEN 1 AND 2048
                          AND substr(handoff_body_ref,1,7) = 'blob://')),
  supersedes_job_id     TEXT UNIQUE REFERENCES review_jobs(job_id) ON DELETE RESTRICT,
  superseded_by_job_id  TEXT REFERENCES review_jobs(job_id) ON DELETE RESTRICT,
  supersession_depth    INTEGER NOT NULL CHECK (supersession_depth BETWEEN 0 AND 3),
  allowance_charge_json TEXT NOT NULL CHECK (json_valid(allowance_charge_json)
                         AND json_type(allowance_charge_json) = 'object'),
  provider_usage_json   TEXT NOT NULL CHECK (json_valid(provider_usage_json)
                         AND json_type(provider_usage_json) = 'object'),
  last_error_json       TEXT CHECK (last_error_json IS NULL OR
                         (json_valid(last_error_json) AND json_type(last_error_json) = 'object')),
  retry_after_at        INTEGER,
  terminal_reason       TEXT,
  version               INTEGER NOT NULL CHECK (version >= 1),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  terminal_at           INTEGER,
  CHECK (length(snapshot_hash) = 71 AND substr(snapshot_hash,1,7) = 'sha256:'),
  CHECK (length(review_scope_key) = 71 AND substr(review_scope_key,1,7) = 'sha256:'),
  CHECK (length(boundary_key) = 71 AND substr(boundary_key,1,7) = 'sha256:'),
  CHECK (length(trigger_dedupe_key) = 71 AND substr(trigger_dedupe_key,1,7) = 'sha256:'),
  CHECK (length(signal_digest) = 71 AND substr(signal_digest,1,7) = 'sha256:'),
  CHECK (length(policy_hash) = 71 AND substr(policy_hash,1,7) = 'sha256:'),
  CHECK (length(capability_snapshot_hash) = 71 AND substr(capability_snapshot_hash,1,7) = 'sha256:'),
  CHECK (length(budget_policy_hash) = 71 AND substr(budget_policy_hash,1,7) = 'sha256:'),
  CHECK ((state IN ('stale','done','failed','cancelled') AND stage = 'closed'
          AND terminal_at IS NOT NULL)
    OR (state NOT IN ('stale','done','failed','cancelled') AND terminal_at IS NULL)),
  CHECK ((handoff_id IS NULL) = (handoff_body_ref IS NULL)),
  CHECK (state <> 'done' OR (handoff_id IS NOT NULL AND handoff_body_ref IS NOT NULL)),
  CHECK (updated_at >= created_at)
) STRICT;

CREATE INDEX ix_review_jobs_snapshot ON review_jobs(snapshot_id);

CREATE INDEX ix_review_jobs_state_stage ON review_jobs(state, stage, updated_at);

CREATE TABLE review_output_acceptances (
  attempt_id             TEXT PRIMARY KEY NOT NULL
                           REFERENCES review_attempts(attempt_id) ON DELETE RESTRICT,
  job_id                 TEXT NOT NULL REFERENCES review_jobs(job_id) ON DELETE RESTRICT,
  output_ref             TEXT NOT NULL,
  output_hash            TEXT NOT NULL,
  candidate_count        INTEGER NOT NULL CHECK (candidate_count BETWEEN 0 AND 16),
  attempt_version_before INTEGER NOT NULL CHECK (attempt_version_before >= 1),
  attempt_version_after  INTEGER NOT NULL,
  job_version_before     INTEGER NOT NULL CHECK (job_version_before >= 1),
  job_version_after      INTEGER NOT NULL,
  job_stage_after        TEXT NOT NULL CHECK (job_stage_after = 'static_check'),
  fencing_token          INTEGER NOT NULL CHECK (fencing_token >= 0),
  accepted_at            INTEGER NOT NULL,
  row_version            INTEGER NOT NULL DEFAULT 1 CHECK (row_version = 1),
  CHECK (attempt_version_after = attempt_version_before + 1),
  CHECK (job_version_after = job_version_before + 1),
  CHECK (length(output_hash) = 71 AND substr(output_hash,1,7) = 'sha256:')
) STRICT;

CREATE TABLE review_snapshots (
  snapshot_id          TEXT PRIMARY KEY NOT NULL,
  schema_version       TEXT NOT NULL CHECK (schema_version = 'rsi.review_snapshot/1'),
  snapshot_key         TEXT NOT NULL UNIQUE,
  snapshot_hash        TEXT NOT NULL,
  version_binding_json TEXT NOT NULL CHECK (json_valid(version_binding_json)
                          AND json_type(version_binding_json) = 'object'),
  snapshot_scope       TEXT NOT NULL CHECK (snapshot_scope IN
                          ('stable_boundary','explicit_stage','superseded_retry')),
  task_id              TEXT NOT NULL CHECK (length(task_id) >= 1),
  branch_id            TEXT NOT NULL CHECK (length(branch_id) >= 1),
  input_epoch          INTEGER NOT NULL CHECK (input_epoch >= 0),
  goal_version         TEXT NOT NULL CHECK (length(goal_version) >= 1),
  config_version       TEXT NOT NULL CHECK (length(config_version) >= 1),
  watermark            INTEGER NOT NULL CHECK (watermark >= 0),
  host_id              TEXT NOT NULL CHECK (length(host_id) >= 1),
  config_space         TEXT NOT NULL CHECK (length(config_space) >= 1),
  mode                 TEXT NOT NULL CHECK (length(mode) >= 1),
  trigger_event_id     TEXT NOT NULL CHECK (length(trigger_event_id) >= 1),
  trigger_kind         TEXT NOT NULL CHECK (trigger_kind IN
                          ('task_stable','user_review_request','experience_trigger','session_end')),
  review_kind          TEXT NOT NULL CHECK (review_kind IN ('auto','explicit')),
  review_scope_key     TEXT NOT NULL,
  boundary_key         TEXT NOT NULL,
  signal_digest        TEXT NOT NULL,
  trigger_dedupe_key   TEXT NOT NULL,
  policy_version       TEXT NOT NULL CHECK (length(policy_version) >= 1),
  authorization_ref    TEXT,
  body_blob            TEXT NOT NULL CHECK (body_blob LIKE 'blob://%'),
  created_at           INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK ((review_kind = 'auto'
          AND trigger_kind <> 'user_review_request' AND authorization_ref IS NULL)
      OR (review_kind = 'explicit' AND authorization_ref IS NOT NULL)),
  CHECK (length(snapshot_key) = 71 AND substr(snapshot_key,1,7) = 'sha256:'),
  CHECK (length(snapshot_hash) = 71 AND substr(snapshot_hash,1,7) = 'sha256:'),
  CHECK (length(review_scope_key) = 71 AND substr(review_scope_key,1,7) = 'sha256:'),
  CHECK (length(boundary_key) = 71 AND substr(boundary_key,1,7) = 'sha256:'),
  CHECK (length(signal_digest) = 71 AND substr(signal_digest,1,7) = 'sha256:'),
  CHECK (length(trigger_dedupe_key) = 71 AND substr(trigger_dedupe_key,1,7) = 'sha256:')
) STRICT;

CREATE INDEX ix_review_snapshots_task_branch
  ON review_snapshots(task_id, branch_id, created_at, snapshot_id);

CREATE TABLE root_registration (
  root_id TEXT PRIMARY KEY,
  registration_hash TEXT NOT NULL CHECK (length(registration_hash) = 71 AND substr(registration_hash,1,7) = 'sha256:'),
  host_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  config_space TEXT NOT NULL,
  adapter_id TEXT NOT NULL CHECK (length(adapter_id) = 30 AND substr(adapter_id,1,4) = 'adp:'),
  native_root_ref TEXT NOT NULL,
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('dev_inode','file_id')),
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 256),
  file_id TEXT NOT NULL CHECK (length(file_id) BETWEEN 1 AND 256),
  registered_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CHECK (identity_kind <> 'dev_inode' OR
    (device_id NOT GLOB '*[^0-9]*' AND file_id NOT GLOB '*[^0-9]*'
     AND (device_id = '0' OR device_id NOT GLOB '0*') AND (file_id = '0' OR file_id NOT GLOB '0*')))
) STRICT;

CREATE INDEX ix_root_registration_hash ON root_registration(registration_hash);

-- Managed-write roots declared by an attached host (design §7, G6). The
-- absolute path is never stored; it is derived from the host's own directory
-- variables at use time. `state` gates the first adoption.
CREATE TABLE managed_root (
  root_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  config_space TEXT NOT NULL,
  adapter_id TEXT NOT NULL CHECK (length(adapter_id) = 30 AND substr(adapter_id,1,4) = 'adp:'),
  kind TEXT NOT NULL CHECK (kind IN ('skill','memory','instructions')),
  relative_path TEXT NOT NULL,
  write_mode TEXT NOT NULL CHECK (write_mode IN ('whole_file','managed_block')),
  block_selector TEXT,
  target_prefix TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending_approval','approved','revoked')),
  registration_hash TEXT NOT NULL CHECK (length(registration_hash) = 71 AND substr(registration_hash,1,7) = 'sha256:'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_managed_root_host ON managed_root(host_id, config_space, kind);

-- Candidate confirmation queue (design §5.3). One row per candidate subject
-- hash; `ask_count` enforces the three-question cap and `state` records the
-- human decision that authorised (or refused) adoption.
CREATE TABLE candidate_confirmation (
  candidate_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  candidate_hash TEXT NOT NULL CHECK (length(candidate_hash) = 71 AND substr(candidate_hash,1,7) = 'sha256:'),
  subject_hash TEXT NOT NULL CHECK (length(subject_hash) = 71 AND substr(subject_hash,1,7) = 'sha256:'),
  object_type TEXT NOT NULL CHECK (object_type IN ('skill','memory','instructions')),
  target_path TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json) AND json_type(summary_json) = 'object'),
  ask_count INTEGER NOT NULL DEFAULT 0 CHECK (ask_count >= 0 AND ask_count <= 3),
  state TEXT NOT NULL CHECK (state IN ('pending','adopted','rejected','deferred')),
  proof_kind TEXT CHECK (proof_kind IS NULL OR proof_kind IN ('host_native_confirmation','test_backdoor_confirmation')),
  last_asked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_candidate_confirmation_state ON candidate_confirmation(state, updated_at);

CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE schema_migration (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  CHECK (version > 0)
) STRICT;

CREATE TABLE session (
  session_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  config_space TEXT NOT NULL,
  external_session_id TEXT,
  current_branch_id TEXT,
  resume_generation INTEGER NOT NULL DEFAULT 1 CHECK (resume_generation >= 1),
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_session_native ON session(host_id, config_space, external_session_id) WHERE external_session_id IS NOT NULL;

CREATE TABLE state_fact (
  fact_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('code','interface_contract','call','result','diff','test','message')),
  subject TEXT NOT NULL,
  value TEXT NOT NULL,
  truth_state TEXT NOT NULL CHECK (truth_state IN ('claim','observed','verified','contradicted','unknown')),
  source_ref TEXT NOT NULL,
  producer_ref TEXT NOT NULL,
  verifier_ref TEXT,
  artifact_version TEXT,
  observed_at INTEGER NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0,1)),
  stale_reason TEXT CHECK (stale_reason IS NULL OR stale_reason IN ('artifact_changed','verifier_invalidated','correction','explicit')),
  content_hash TEXT NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CHECK (truth_state <> 'verified' OR verifier_ref IS NOT NULL),
  CHECK ((stale = 0 AND stale_reason IS NULL) OR (stale = 1 AND stale_reason IS NOT NULL))
) STRICT;

CREATE INDEX ix_fact_binding ON state_fact(task_id, branch_id, input_epoch, watermark);

CREATE INDEX ix_fact_branch_kind ON state_fact(branch_id, kind, observed_at);

CREATE TABLE task (
  task_id TEXT PRIMARY KEY,
  project_id TEXT,
  root_task_id TEXT,
  parent_task_id TEXT REFERENCES task(task_id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (root_task_id IS NULL OR root_task_id = task_id OR parent_task_id IS NOT NULL)
) STRICT;

CREATE TABLE task_outcome (
  outcome_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  outcome TEXT NOT NULL CHECK (outcome IN ('active','paused','cancelled','ended_unverified','succeeded','failed')),
  success_evidence_refs_json TEXT NOT NULL,
  uncovered_requirement_ids_json TEXT NOT NULL,
  pending_work_json TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'none','no_success_evidence','pending_work','human_cancel','human_pause','external_blocker',
    'verification_failed','scope_uncovered','version_stale','boundary_unstable')),
  boundary_event_id TEXT,
  version_binding_json TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  outcome_hash TEXT NOT NULL,
  UNIQUE (branch_id, revision),
  CHECK (outcome <> 'succeeded' OR (json_array_length(uncovered_requirement_ids_json) = 0 AND json_array_length(pending_work_json) = 0 AND json_array_length(success_evidence_refs_json) > 0)),
  CHECK (outcome <> 'succeeded' OR reason_code = 'none')
) STRICT;

CREATE INDEX ix_task_outcome_branch_revision ON task_outcome(branch_id, revision);

CREATE TABLE usage_verification_records (
  usage_id               TEXT PRIMARY KEY NOT NULL,
  schema_version         TEXT NOT NULL CHECK (schema_version = 'rsi.usage_verification/1'),
  usage_key              TEXT NOT NULL UNIQUE,
  projection_id          TEXT NOT NULL
                           REFERENCES experience_projections(projection_id) ON DELETE RESTRICT,
  experience_id          TEXT NOT NULL,
  experience_version     INTEGER NOT NULL CHECK (experience_version >= 1),
  experience_content_hash TEXT NOT NULL,
  validation_plan_id     TEXT NOT NULL
                           REFERENCES validation_plans(validation_plan_id) ON DELETE RESTRICT,
  validation_plan_hash   TEXT NOT NULL,
  version_binding_json   TEXT NOT NULL CHECK (json_valid(version_binding_json)
                           AND json_type(version_binding_json) = 'object'),
  task_family_id         TEXT NOT NULL CHECK (length(task_family_id) >= 1),
  trigger_result         TEXT NOT NULL CHECK (trigger_result IN
                           ('triggered','not_triggered','unknown')),
  loading_json           TEXT NOT NULL CHECK (json_valid(loading_json)
                           AND json_type(loading_json) = 'object'),
  behavior_json          TEXT NOT NULL CHECK (json_valid(behavior_json)
                           AND json_type(behavior_json) = 'object'),
  verification_json      TEXT NOT NULL CHECK (json_valid(verification_json)
                           AND json_type(verification_json) = 'object'),
  outcome_ref            TEXT CHECK (outcome_ref IS NULL OR outcome_ref LIKE 'blob://%'
                           OR outcome_ref LIKE 'journal://%'),
  other_change_refs_json TEXT NOT NULL CHECK (json_valid(other_change_refs_json)
                           AND json_type(other_change_refs_json) = 'array'),
  attribution            TEXT NOT NULL CHECK (attribution IN
                           ('not_claimed','confounded','isolated_replay','controlled_trial')),
  result                 TEXT NOT NULL CHECK (result IN
                           ('positive_evidence','negative_evidence','counterexample',
                            'inconclusive','not_exercised')),
  evidence_hash          TEXT NOT NULL,
  causal_supported       INTEGER NOT NULL CHECK (causal_supported = 0),
  observed_at            INTEGER NOT NULL CHECK (observed_at >= 0),
  window_index           INTEGER NOT NULL CHECK (window_index >= 0),
  FOREIGN KEY (experience_id, experience_version)
    REFERENCES experiences(experience_id, version) ON DELETE RESTRICT,
  CHECK (length(usage_key) = 71 AND substr(usage_key,1,7) = 'sha256:'),
  CHECK (length(experience_content_hash) = 71
    AND substr(experience_content_hash,1,7) = 'sha256:'),
  CHECK (length(validation_plan_hash) = 71
    AND substr(validation_plan_hash,1,7) = 'sha256:'),
  CHECK (length(evidence_hash) = 71 AND substr(evidence_hash,1,7) = 'sha256:')
) STRICT;

CREATE INDEX ix_usage_verification_records_projection_window
  ON usage_verification_records(projection_id, window_index, observed_at, usage_id);

CREATE TABLE validation_plans (
  validation_plan_id    TEXT PRIMARY KEY NOT NULL,
  experience_id         TEXT NOT NULL,
  experience_version    INTEGER NOT NULL CHECK (experience_version >= 1),
  expected_behavior     TEXT NOT NULL CHECK (length(expected_behavior) >= 1),
  plan_hash             TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  source_requirement_refs_json TEXT NOT NULL CHECK (json_valid(source_requirement_refs_json)
                         AND json_type(source_requirement_refs_json) = 'array'),
  required_loading_evidence_json TEXT NOT NULL CHECK (json_valid(required_loading_evidence_json)
                         AND json_type(required_loading_evidence_json) = 'array'),
  verifier_json         TEXT NOT NULL CHECK (json_valid(verifier_json)
                         AND json_type(verifier_json) = 'object'),
  observation_window_json TEXT NOT NULL CHECK (json_valid(observation_window_json)
                         AND json_type(observation_window_json) = 'object'),
  retention_rule_json   TEXT NOT NULL CHECK (json_valid(retention_rule_json)
                         AND json_type(retention_rule_json) = 'object'),
  stop_conditions_json  TEXT NOT NULL CHECK (json_valid(stop_conditions_json)
                         AND json_type(stop_conditions_json) = 'array'),
  replay_json           TEXT NOT NULL CHECK (json_valid(replay_json)
                         AND json_type(replay_json) = 'object'),
  CHECK (length(plan_hash) = 71 AND substr(plan_hash,1,7) = 'sha256:')
) STRICT;

CREATE INDEX ix_validation_plans_experience
  ON validation_plans(experience_id, experience_version);

CREATE TABLE workspace_read_record (
  schema_version TEXT NOT NULL CHECK (schema_version = 'rsi.workspace_read_record/1'),
  read_id TEXT PRIMARY KEY CHECK (length(read_id) = 68 AND substr(read_id,1,4) = 'wrd:'),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL CHECK (length(goal_version) BETWEEN 1 AND 256),
  config_version TEXT NOT NULL CHECK (length(config_version) BETWEEN 1 AND 128),
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  supplement_id TEXT NOT NULL CHECK (length(supplement_id) = 68 AND substr(supplement_id,1,4) = 'sup:'),
  action TEXT NOT NULL CHECK (action IN ('list','read','stat','attachment')),
  root_id TEXT NOT NULL CHECK (length(root_id) >= 1),
  path_rel TEXT NOT NULL,
  path_hash TEXT NOT NULL CHECK (length(path_hash) = 71 AND substr(path_hash,1,7) = 'sha256:'),
  content_hash TEXT CHECK (content_hash IS NULL OR (length(content_hash) = 71 AND substr(content_hash,1,7) = 'sha256:')),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 0 AND 1048576),
  range_start INTEGER CHECK (range_start IS NULL OR range_start BETWEEN 0 AND 1048576),
  range_end INTEGER CHECK (range_end IS NULL OR range_end BETWEEN 0 AND 1048576),
  binary INTEGER NOT NULL CHECK (binary IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('ok','denied','too_large','not_found','changed','unsupported','binary')),
  reason_code TEXT,
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CHECK (range_start IS NULL OR range_end IS NULL OR range_end >= range_start)
) STRICT;

CREATE INDEX ix_workspace_read_binding ON workspace_read_record(task_id, branch_id, input_epoch, watermark);

CREATE INDEX ix_workspace_read_path_hash ON workspace_read_record(path_hash);

CREATE INDEX ix_workspace_read_supplement ON workspace_read_record(supplement_id);

CREATE TABLE write_intent (
  write_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  grant_id TEXT NOT NULL REFERENCES authorization_grant(grant_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('create','update','disable','rollback')),
  object_type TEXT NOT NULL CHECK (object_type IN ('skill','memory','instructions')),
  candidate_id TEXT NOT NULL,
  candidate_hash TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('task','session')),
  scope_ref_id TEXT NOT NULL,
  project_id TEXT,
  config_space_id TEXT,
  scope_hash TEXT NOT NULL CHECK (length(scope_hash) = 71 AND substr(scope_hash,1,7) = 'sha256:'),
  target_ownership TEXT NOT NULL CHECK (target_ownership IN ('native_managed','rsi_managed','shared_handwritten')),
  root_id TEXT NOT NULL REFERENCES root_registration(root_id) ON DELETE RESTRICT,
  root_identity_pin_json TEXT NOT NULL CHECK (json_type(root_identity_pin_json) = 'object'),
  root_registration_hash TEXT NOT NULL CHECK (length(root_registration_hash) = 71 AND substr(root_registration_hash,1,7) = 'sha256:'),
  target_path TEXT NOT NULL,
  write_mode TEXT NOT NULL CHECK (write_mode IN ('whole_file','managed_block')),
  block_action TEXT CHECK (block_action IN ('update','attach','detach')),
  block_selector TEXT,
  expected_file_hash TEXT,
  expected_block_hash TEXT,
  snapshot_id TEXT REFERENCES write_snapshot(snapshot_id) ON DELETE RESTRICT,
  rollback_of_write_id TEXT REFERENCES write_intent(write_id) ON DELETE RESTRICT,
  target_snapshot_id TEXT REFERENCES write_snapshot(snapshot_id) ON DELETE RESTRICT,
  target_snapshot_hash TEXT,
  atomicity TEXT NOT NULL CHECK (atomicity IN ('native_atomic','single_file_atomic','none')),
  exclusion TEXT NOT NULL CHECK (exclusion IN ('native_cooperative','rsi_advisory','none')),
  unattended_policy TEXT NOT NULL CHECK (unattended_policy IN ('auto_allowed','pending_approval','rsi_managed_file_only')),
  state TEXT NOT NULL CHECK (state IN (
    'intent_recorded','snapshot_written','temp_written','renamed','dir_synced','verified',
    'pending_approval','conflict','path_rejected','write_failed','partial','recovery_required')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  last_error_code TEXT,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (write_mode <> 'whole_file' OR (block_action IS NULL AND block_selector IS NULL AND expected_block_hash IS NULL)),
  CHECK (write_mode <> 'managed_block' OR (block_action IS NOT NULL AND block_selector IS NOT NULL)),
  CHECK (write_mode <> 'managed_block' OR expected_file_hash IS NOT NULL),
  CHECK (block_action IS NULL OR (block_action = 'attach' AND expected_block_hash IS NULL)
      OR (block_action IN ('update','detach') AND expected_block_hash IS NOT NULL)),
  CHECK (write_mode <> 'whole_file' OR expected_file_hash IS NOT NULL OR action = 'create'),
  CHECK (action <> 'rollback' OR (rollback_of_write_id IS NOT NULL AND target_snapshot_id IS NOT NULL
      AND target_snapshot_hash IS NOT NULL AND write_mode = 'whole_file')),
  CHECK (action = 'rollback' OR (rollback_of_write_id IS NULL AND target_snapshot_id IS NULL
      AND target_snapshot_hash IS NULL)),
  CHECK (target_snapshot_hash IS NULL OR (length(target_snapshot_hash) = 71 AND substr(target_snapshot_hash,1,7) = 'sha256:')),
  CHECK (json_extract(root_identity_pin_json,'$.schema_version') = 'rsi.root_identity/1'
      AND json_extract(root_identity_pin_json,'$.root_id') = root_id
      AND json_extract(root_identity_pin_json,'$.identity_kind') IN ('dev_inode','file_id')
      AND json_type(root_identity_pin_json,'$.device_id') = 'text'
      AND json_type(root_identity_pin_json,'$.file_id') = 'text'),
  CHECK (target_path <> '' AND substr(target_path,1,1) <> '/'
      AND instr(target_path, char(0)) = 0
      AND instr('/' || target_path || '/', '/../') = 0
      AND target_path <> '..'
      AND target_path NOT GLOB '[A-Za-z]:*'
      AND target_path NOT GLOB '\\*'),
  CHECK (scope_kind <> 'session' OR config_space_id IS NOT NULL),
  CHECK (object_type <> 'instructions' OR project_id IS NOT NULL),
  CHECK (substr(candidate_id,1,5) = 'prop:' AND length(candidate_id) = 31)
) STRICT;

CREATE INDEX ix_write_grant ON write_intent(grant_id);

CREATE INDEX ix_write_rollback_target ON write_intent(rollback_of_write_id);

CREATE INDEX ix_write_root_target ON write_intent(root_id, target_path);

CREATE INDEX ix_write_state ON write_intent(state, updated_at);










CREATE TABLE "policy_record" (
  row_key TEXT PRIMARY KEY,
  record_kind TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  parent_key TEXT,
  task_id TEXT,
  branch_id TEXT,
  input_epoch INTEGER,
  goal_version TEXT,
  config_version TEXT,
  watermark INTEGER,
  content_hash TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX "ix_policy_record_kind" ON "policy_record"(record_kind);
CREATE INDEX "ix_policy_record_binding" ON "policy_record"(task_id, branch_id, input_epoch, goal_version, config_version, watermark);
CREATE INDEX "ix_policy_record_hash" ON "policy_record"(record_kind, content_hash);




































































































-- Physical tables restored from the pre-consolidation schema (P2a fallback).
CREATE TABLE feedback (
  feedback_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  source_event_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('correction','dissatisfaction','new_goal','acceptance')),
  quote_ref TEXT NOT NULL,
  target_issue_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('recorded','needs_evidence')),
  goal_version TEXT NOT NULL,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  recorded_at INTEGER NOT NULL
) STRICT;

CREATE TABLE fact_verification (
  fact_id TEXT NOT NULL REFERENCES state_fact(fact_id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL UNIQUE REFERENCES event_log(event_id) ON DELETE RESTRICT,
  verifier_ref TEXT NOT NULL,
  verifier_id TEXT NOT NULL,
  verifier_kind TEXT NOT NULL CHECK (verifier_kind IN ('test','artifact_check','external','human')),
  method_ref_json TEXT CHECK (method_ref_json IS NULL OR json_type(method_ref_json) = 'object'),
  reservation_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_type(reservation_ids_json) = 'array'),
  independent INTEGER NOT NULL CHECK (independent IN (0,1)),
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  requirement_ids_json TEXT NOT NULL CHECK (json_type(requirement_ids_json) = 'array'),
  proposition_ids_json TEXT NOT NULL CHECK (json_type(proposition_ids_json) = 'array'),
  effect TEXT NOT NULL CHECK (effect IN ('supports','violates','unknown')),
  artifact_version TEXT,
  source_ids_json TEXT NOT NULL CHECK (json_type(source_ids_json) = 'array' AND json_array_length(source_ids_json) > 0),
  source_refs_json TEXT NOT NULL CHECK (json_type(source_refs_json) = 'array'),
  result TEXT NOT NULL CHECK (result IN ('verified','contradicted','unknown')),
  status TEXT NOT NULL CHECK (status IN ('valid','invalidated','unknown')),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71),
  verified_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  PRIMARY KEY (fact_id, verifier_ref)
) STRICT;
CREATE INDEX ix_fact_verification_req ON fact_verification(watermark, status);
CREATE INDEX ix_fact_verification_verifier ON fact_verification(verifier_id, verified_at);

CREATE TABLE success_evidence (
  evidence_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('human_acceptance','test_pass','artifact_check','external_verification')),
  source_event_id TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  producer_ref TEXT NOT NULL,
  producer_kind TEXT NOT NULL CHECK (producer_kind IN ('human','test_runner','artifact_checker','external_verifier')),
  covered_requirement_ids_json TEXT NOT NULL CHECK (json_type(covered_requirement_ids_json) = 'array'),
  version_binding_json TEXT NOT NULL CHECK (json_type(version_binding_json) = 'object'),
  human_attestation_json TEXT,
  attestation_subject_hash TEXT,
  verified_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  recorded_at_watermark INTEGER NOT NULL CHECK (recorded_at_watermark >= 0),
  evidence_hash TEXT NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (branch_id, evidence_hash),
  CHECK (length(evidence_hash) = 71 AND substr(evidence_hash,1,7) = 'sha256:'),
  CHECK (kind <> 'human_acceptance' OR
    (producer_kind = 'human' AND human_attestation_json IS NOT NULL AND attestation_subject_hash IS NOT NULL)),
  CHECK (kind = 'human_acceptance' OR
    (human_attestation_json IS NULL AND attestation_subject_hash IS NULL AND producer_kind <> 'human')),
  CHECK (attestation_subject_hash IS NULL OR
    (length(attestation_subject_hash) = 71 AND substr(attestation_subject_hash,1,7) = 'sha256:'))
) STRICT;
CREATE INDEX ix_success_evidence_branch ON success_evidence(branch_id, verified_at);
CREATE INDEX ix_success_evidence_source ON success_evidence(source_event_id);

CREATE TABLE unverified_constraint (
  constraint_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  binding_json TEXT NOT NULL CHECK (json_type(binding_json) = 'object'),
  source_event_id TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  quote TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  scope_hint_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('unverified_constraint','confirmed','rejected')),
  authorization INTEGER NOT NULL DEFAULT 0 CHECK (authorization = 0),
  usable_for_json TEXT NOT NULL,
  conflict_with_requirement_ids_json TEXT NOT NULL,
  confirmed_by_event_id TEXT,
  recorded_at_watermark INTEGER NOT NULL CHECK (recorded_at_watermark >= 0),
  created_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CHECK (status <> 'confirmed' OR confirmed_by_event_id IS NOT NULL),
  CHECK (json_type(usable_for_json) = 'array'),
  CHECK (json_type(conflict_with_requirement_ids_json) = 'array')
) STRICT;
CREATE INDEX ix_constraint_binding ON unverified_constraint(task_id, branch_id, recorded_at_watermark);

CREATE TABLE ledger_correction (
  correction_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  corrected_record_id TEXT NOT NULL,
  correction_kind TEXT NOT NULL CHECK (correction_kind IN ('missed_extraction','wrong_extraction','wrong_link')),
  original_source_event_id TEXT NOT NULL,
  original_source_ref TEXT NOT NULL,
  original_text_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applied','rejected_original_missing')),
  recorded_at INTEGER NOT NULL,
  valid_from_event INTEGER NOT NULL,
  replacement_op_ids_json TEXT NOT NULL,
  invalidated_judgment_ids_json TEXT NOT NULL,
  correction_hash TEXT NOT NULL,
  CHECK (status = 'rejected_original_missing' OR json_array_length(replacement_op_ids_json) > 0)
) STRICT;
CREATE INDEX ix_ledger_correction_branch ON ledger_correction(branch_id, recorded_at);

CREATE TABLE write_snapshot (
  snapshot_id TEXT PRIMARY KEY,
  write_id TEXT NOT NULL REFERENCES write_intent(write_id) ON DELETE RESTRICT,
  path TEXT NOT NULL,
  write_mode TEXT NOT NULL CHECK (write_mode IN ('whole_file','managed_block')),
  file_hash TEXT NOT NULL,
  file_byte_length INTEGER NOT NULL CHECK (file_byte_length >= 0),
  block_action TEXT CHECK (block_action IN ('update','attach','detach')),
  block_selector TEXT,
  block_start INTEGER CHECK (block_start >= 0),
  block_byte_length INTEGER CHECK (block_byte_length >= 0),
  block_content_hash TEXT,
  block_hash TEXT,
  content_ref TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 71 AND substr(snapshot_hash,1,7) = 'sha256:'),
  created_at INTEGER NOT NULL,
  UNIQUE (write_id, path),
  CHECK (block_content_hash IS NULL OR (length(block_content_hash) = 71 AND substr(block_content_hash,1,7) = 'sha256:')),
  CHECK (block_hash IS NULL OR (length(block_hash) = 71 AND substr(block_hash,1,7) = 'sha256:')),
  CHECK (write_mode <> 'managed_block' OR (block_action IS NOT NULL AND block_selector IS NOT NULL)),
  CHECK (write_mode <> 'whole_file' OR (block_action IS NULL AND block_selector IS NULL
      AND block_start IS NULL AND block_byte_length IS NULL AND block_content_hash IS NULL AND block_hash IS NULL)),
  CHECK (block_action IS NULL OR (block_action = 'attach' AND block_start IS NULL AND block_byte_length IS NULL
      AND block_content_hash IS NULL AND block_hash IS NULL)
      OR (block_action IN ('update','detach') AND block_start IS NOT NULL AND block_byte_length > 0
      AND block_content_hash IS NOT NULL AND block_hash IS NOT NULL))
) STRICT;

CREATE TABLE write_result (
  write_id TEXT NOT NULL REFERENCES write_intent(write_id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  state TEXT NOT NULL CHECK (state IN (
    'intent_recorded','snapshot_written','temp_written','renamed','dir_synced','verified',
    'pending_approval','conflict','path_rejected','write_failed','partial','recovery_required')),
  root_id TEXT NOT NULL REFERENCES root_registration(root_id) ON DELETE RESTRICT,
  path TEXT NOT NULL,
  new_file_hash TEXT,
  new_block_hash TEXT,
  snapshot_id TEXT REFERENCES write_snapshot(snapshot_id) ON DELETE RESTRICT,
  target_snapshot_id TEXT REFERENCES write_snapshot(snapshot_id) ON DELETE RESTRICT,
  target_snapshot_hash TEXT,
  three_way_diff_ref TEXT,
  readback_verified INTEGER NOT NULL DEFAULT 0 CHECK (readback_verified IN (0,1)),
  atomicity TEXT NOT NULL CHECK (atomicity IN ('native_atomic','single_file_atomic','none')),
  exclusion TEXT NOT NULL CHECK (exclusion IN ('native_cooperative','rsi_advisory','none')),
  unattended_policy TEXT NOT NULL CHECK (unattended_policy IN ('auto_allowed','pending_approval','rsi_managed_file_only')),
  error_code TEXT,
  completed_at INTEGER,
  PRIMARY KEY (write_id, attempt),
  CHECK (state <> 'verified' OR readback_verified = 1),
  CHECK ((target_snapshot_id IS NULL) = (target_snapshot_hash IS NULL)),
  CHECK (target_snapshot_hash IS NULL OR (length(target_snapshot_hash) = 71 AND substr(target_snapshot_hash,1,7) = 'sha256:'))
) STRICT;

CREATE TABLE adapter_install_approval (
  approval_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 71 AND substr(request_hash,1,7) = 'sha256:'),
  subject_json TEXT NOT NULL CHECK (json_type(subject_json) = 'object'),
  subject_hash TEXT NOT NULL CHECK (length(subject_hash) = 71 AND substr(subject_hash,1,7) = 'sha256:'),
  state TEXT NOT NULL CHECK (state IN ('active','consumed','revoked','expired')),
  bootstrap_state TEXT NOT NULL CHECK (bootstrap_state IN (
    'preinstall_ready','postinstall_ready','blocked_no_attested_source','unknown')),
  evidence_ref TEXT NOT NULL CHECK (substr(evidence_ref,1,7) = 'blob://'),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_registration_hash TEXT,
  revoked_at INTEGER,
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR revoke_reason IN ('human_revoked','superseded','security')),
  approval_hash TEXT NOT NULL CHECK (length(approval_hash) = 71 AND substr(approval_hash,1,7) = 'sha256:'),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CHECK (length(CAST(subject_json AS BLOB)) <= 1048576),
  CHECK (expires_at > issued_at AND expires_at - issued_at <= 600000),
  CHECK (consumed_registration_hash IS NULL OR
    (length(consumed_registration_hash) = 71 AND substr(consumed_registration_hash,1,7) = 'sha256:')),
  CHECK (state <> 'consumed' OR (consumed_at IS NOT NULL AND consumed_registration_hash IS NOT NULL
    AND revoked_at IS NULL AND revoke_reason IS NULL)),
  CHECK (state <> 'revoked' OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL
    AND consumed_at IS NULL AND consumed_registration_hash IS NULL)),
  CHECK (state <> 'active' OR (consumed_at IS NULL AND consumed_registration_hash IS NULL
    AND revoked_at IS NULL AND revoke_reason IS NULL)),
  CHECK (state <> 'expired' OR (consumed_at IS NULL AND consumed_registration_hash IS NULL
    AND revoked_at IS NULL AND revoke_reason IS NULL)),
  CHECK (bootstrap_state IN ('preinstall_ready','postinstall_ready') OR state <> 'active')
) STRICT;
CREATE UNIQUE INDEX ux_install_approval_registration ON adapter_install_approval(consumed_registration_hash)
  WHERE consumed_registration_hash IS NOT NULL;

CREATE TABLE replay_approval (
  approval_id TEXT PRIMARY KEY,
  replay_plan_id TEXT NOT NULL REFERENCES replay_plan(replay_plan_id) ON DELETE RESTRICT,
  plan_hash TEXT NOT NULL,
  approved_by TEXT NOT NULL CHECK (approved_by = 'human'),
  human_attestation_json TEXT NOT NULL,
  attestation_subject_hash TEXT NOT NULL,
  approval_hash TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  version_binding_json TEXT NOT NULL,
  allowed_network INTEGER NOT NULL CHECK (allowed_network IN (0,1)),
  network_target TEXT,
  ttl_ms INTEGER NOT NULL CHECK (ttl_ms BETWEEN 1 AND 600000),
  state TEXT NOT NULL CHECK (state IN ('active','consumed','revoked','expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_execution_id TEXT,
  revoked_at INTEGER,
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR revoke_reason IN ('human_revoked','plan_rejected','policy_replaced')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CHECK (allowed_network = 1 OR network_target IS NULL),
  CHECK (expires_at = created_at + ttl_ms),
  CHECK (state <> 'consumed' OR (consumed_at IS NOT NULL AND consumed_execution_id IS NOT NULL AND revoked_at IS NULL AND revoke_reason IS NULL)),
  CHECK (state <> 'revoked' OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL AND consumed_at IS NULL AND consumed_execution_id IS NULL)),
  CHECK (state <> 'active' OR (consumed_at IS NULL AND revoked_at IS NULL AND consumed_execution_id IS NULL AND revoke_reason IS NULL)),
  CHECK (state <> 'expired' OR (consumed_at IS NULL AND revoked_at IS NULL AND consumed_execution_id IS NULL AND revoke_reason IS NULL))
) STRICT;
CREATE INDEX ix_replay_approval_plan_state ON replay_approval(replay_plan_id, state, expires_at);

CREATE TABLE allowance_charge (
  charge_id TEXT PRIMARY KEY,
  charge_key TEXT NOT NULL UNIQUE,
  reservation_id TEXT NOT NULL REFERENCES budget_reservation(reservation_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('attempt','input_token','output_token','cost_micros','wall_ms')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  non_refundable INTEGER NOT NULL CHECK (non_refundable IN (0,1)),
  reason TEXT NOT NULL CHECK (reason IN ('claim','retry','usage_actual','overage','expiry_hold')),
  charged_at INTEGER NOT NULL,
  UNIQUE (reservation_id, kind, reason, charge_key)
) STRICT;
CREATE INDEX ix_allowance_reservation ON allowance_charge(reservation_id);

CREATE TABLE provider_usage (
  usage_id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES budget_reservation(reservation_id) ON DELETE RESTRICT,
  usage_key TEXT NOT NULL,
  attempt_ref TEXT,
  provider_request_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_micros INTEGER,
  cost_status TEXT NOT NULL CHECK (cost_status IN ('known','unknown','not_applicable')),
  source TEXT NOT NULL CHECK (source IN ('provider_receipt','host_reported','none')),
  receipt_ref TEXT,
  recorded_at INTEGER NOT NULL,
  UNIQUE (reservation_id, usage_key),
  CHECK (input_tokens IS NULL OR input_tokens >= 0),
  CHECK (output_tokens IS NULL OR output_tokens >= 0),
  CHECK (cost_micros IS NULL OR cost_micros >= 0),
  CHECK (cost_status <> 'known' OR (cost_micros IS NOT NULL AND source <> 'none')),
  CHECK (cost_status <> 'unknown' OR cost_micros IS NULL),
  CHECK (source <> 'none' OR (cost_status IN ('unknown','not_applicable') AND cost_micros IS NULL)),
  CHECK (source <> 'host_reported' OR receipt_ref IS NOT NULL),
  CHECK (source <> 'provider_receipt' OR receipt_ref IS NOT NULL)
) STRICT;
CREATE INDEX ix_provider_usage_reservation ON provider_usage(reservation_id);

CREATE TABLE rate_limit_state (
  scope_key TEXT PRIMARY KEY,
  cooldown_until INTEGER,
  last_error_code TEXT,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('provider_429','provider_error','manual','recovery_unknown_fence','cleared')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_at INTEGER NOT NULL,
  CHECK (cooldown_until IS NULL OR cooldown_until >= updated_at),
  CHECK ((reason_code = 'cleared') = (cooldown_until IS NULL))
) STRICT;

CREATE TABLE delivery_history (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL REFERENCES delivery(delivery_id) ON DELETE RESTRICT,
  event_id TEXT,
  at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','submitted','expired','failed')),
  inclusion_evidence TEXT NOT NULL CHECK (inclusion_evidence IN ('unknown','context_projection','provider_payload','transport_body','host_confirmed')),
  adoption TEXT NOT NULL CHECK (adoption IN ('unknown','observed','verified')),
  evidence_ref TEXT,
  terminal_reason TEXT CHECK (terminal_reason IS NULL OR terminal_reason IN ('host_rejected','version_changed','timeout','cancelled','expired_by_time')),
  note_code TEXT NOT NULL CHECK (note_code IN ('created','submitted','failed','expired','late_ack','inclusion_evidence','adoption_evidence')),
  UNIQUE (delivery_id, event_id),
  CHECK (state NOT IN ('expired','failed') OR terminal_reason IS NOT NULL),
  CHECK (terminal_reason IS NULL OR state IN ('expired','failed'))
) STRICT;

CREATE TABLE decision_record (
  decision_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  policy_version TEXT NOT NULL,
  issue_id TEXT,
  action_kind TEXT NOT NULL CHECK (action_kind IN (
    'no_op','dedupe_hit','fact_reminder','semantic_reminder','shadow_recorded','needs_evidence',
    'abstain','review_enqueued','write_pending','write_authorized','late_history','sync_requirement',
    'budget_blocked','delivery_expired','identity_fork','identity_resume')),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','no_op','degraded','rejected','conflict','pending','unknown')),
  reason_code TEXT NOT NULL,
  dedupe_key TEXT,
  evidence_hash TEXT,
  pack_hash TEXT,
  request_hash TEXT,
  delivery_id TEXT,
  job_id TEXT,
  write_id TEXT,
  aggregate_id TEXT,
  action_json TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  decision_hash TEXT NOT NULL,
  UNIQUE (branch_id, decision_hash)
) STRICT;
CREATE INDEX ix_decision_branch_time ON decision_record(branch_id, decided_at);
CREATE INDEX ix_decision_delivery ON decision_record(delivery_id);
CREATE UNIQUE INDEX ux_decision_dedupe_noop ON decision_record(branch_id, dedupe_key, evidence_hash, goal_version)
  WHERE action_kind = 'dedupe_hit';

CREATE TABLE outbox (
  outbox_id TEXT PRIMARY KEY,
  effect_kind TEXT NOT NULL CHECK (effect_kind IN ('delivery.dispatch','review.enqueue','maintenance.gc','delivery.expire')),
  effect_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','leased','done','failed','uncertain','cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at INTEGER,
  reconcile_required INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_required IN (0,1)),
  last_error_code TEXT,
  result_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (state <> 'leased' OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (attempts <= max_attempts)
) STRICT;
CREATE INDEX ix_outbox_due ON outbox(state, next_attempt_at, priority);
CREATE INDEX ix_outbox_lease ON outbox(lease_expires_at) WHERE state = 'leased';

CREATE TABLE outbox_attempt (
  outbox_attempt_id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES outbox(outbox_id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  state TEXT NOT NULL CHECK (state IN ('started','succeeded','retryable_failed','terminal_failed','uncertain','cancelled')),
  error_code TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE (outbox_id, attempt)
) STRICT;

CREATE TABLE event_log (
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
  origin_basis TEXT NOT NULL CHECK (origin_basis IN ('host_typed_field','host_capability','explicit_event','inferred_from_agent','unavailable')),
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
CREATE INDEX ix_event_task_branch_watermark ON event_log(task_id, branch_id, watermark);
CREATE INDEX ix_event_session_time ON event_log(session_id, occurred_at);
CREATE INDEX ix_event_type_time ON event_log(event_type, occurred_at);
CREATE INDEX ix_event_input ON event_log(input_id);
CREATE INDEX ix_event_correlation ON event_log(correlation_id);
CREATE INDEX ix_event_trigger ON event_log(trigger_axis, occurred_at);

CREATE TABLE ledger_event_log (
  event_id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  commit_seq INTEGER NOT NULL UNIQUE,
  journal_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'grant.issued','grant.revoked','grant.consumed',
    'budget.reserved','budget.claimed','budget.settled','budget.released','budget.expired',
    'budget.unsettled','allowance.charged','provider_usage.recorded',
    'write.intent_recorded','write.transition','write.snapshot_recorded','write.result_recorded',
    'config_write.intent_recorded','config_write.transition','config_write.snapshot_recorded','config_write.result_recorded',
    'outbox.enqueued','outbox.leased','outbox.completed','outbox.failed','outbox.uncertain',
    'outbox.reconciled','outbox.attempt_started','outbox.attempt_finished',
    'delivery.recorded',
    'replay.plan_recorded','replay.plan_transition','replay.approval_recorded','replay.approval_transition',
    'replay.execution_recorded','replay.execution_transition',
    'egress.approval_recorded','egress.approval_transition',
    'ipc_idempotency.started','ipc_idempotency.finished','ipc_idempotency.uncertain',
    'rate_limit.updated','rate_limit.cleared','decision.recorded',
    'install.approval_recorded','install.approval_transition',
    'root.registration_recorded','root.registration_updated',
    'state_row.recorded','object_document.recorded','object_head.transition')),
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'authorization_grant','grant_consumption','budget_reservation','allowance_charge','provider_usage',
    'write_intent','write_snapshot','write_result','config_write_intent','config_write_snapshot','config_write_result',
    'outbox','outbox_attempt','delivery','replay_plan','replay_approval','replay_execution',
    'egress_approval','ipc_idempotency','rate_limit_state','decision_record',
    'adapter_install_approval','root_registration',
    'state_row','object_document','object_head')),
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('insert','update','transition')),
  binding_mode TEXT NOT NULL CHECK (binding_mode IN ('bound','global')),
  task_id TEXT,
  branch_id TEXT,
  input_epoch INTEGER CHECK (input_epoch IS NULL OR input_epoch >= 1),
  goal_version TEXT,
  config_version TEXT,
  watermark INTEGER CHECK (watermark IS NULL OR watermark >= 0),
  before_hash TEXT,
  after_hash TEXT NOT NULL,
  row_schema TEXT NOT NULL,
  row_json TEXT NOT NULL,
  document_id TEXT,
  payload_hash TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  CHECK (document_id IS NULL OR (length(document_id) = 71 AND substr(document_id,1,7) = 'sha256:')),
  CHECK (document_id IS NULL OR event_type = 'state_row.recorded'),
  CHECK ((binding_mode = 'global' AND task_id IS NULL AND branch_id IS NULL
      AND input_epoch IS NULL AND goal_version IS NULL AND config_version IS NULL
      AND watermark IS NULL)
    OR (binding_mode = 'bound' AND task_id IS NOT NULL AND branch_id IS NOT NULL
      AND input_epoch IS NOT NULL AND goal_version IS NOT NULL AND config_version IS NOT NULL
      AND watermark IS NOT NULL)),
  CHECK (binding_mode = 'global' OR event_type NOT IN ('install.approval_recorded',
    'install.approval_transition','root.registration_recorded','root.registration_updated')),
  UNIQUE (entity_type, entity_id, after_hash)
) STRICT;
CREATE INDEX ix_ledger_event_entity ON ledger_event_log(entity_type, entity_id, recorded_at);
CREATE INDEX ix_ledger_event_branch ON ledger_event_log(branch_id, recorded_at);

CREATE TABLE goal_snapshot (
  snapshot_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  source_branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  source_goal_version TEXT NOT NULL,
  local_goal_version TEXT NOT NULL,
  local_goal_revision INTEGER NOT NULL CHECK (local_goal_revision >= 1),
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  active_requirement_ids_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (length(snapshot_hash) = 71)
) STRICT;
CREATE INDEX ix_goal_snapshot_branch ON goal_snapshot(source_branch_id, watermark);

CREATE TABLE run (
  run_id TEXT PRIMARY KEY,
  input_id TEXT NOT NULL REFERENCES input(input_id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  state TEXT NOT NULL CHECK (state IN ('started','active','ended','failed','interrupted')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE (input_id, attempt),
  CHECK ((state IN ('ended','failed','interrupted') AND ended_at IS NOT NULL) OR (state IN ('started','active') AND ended_at IS NULL))
) STRICT;

CREATE TABLE requirement (
  requirement_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  statement_ref TEXT NOT NULL,
  statement_text_hash TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  acceptance_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','active','superseded','retracted','rejected')),
  created_by_op_id TEXT NOT NULL,
  superseded_by_requirement_id TEXT,
  valid_from_event INTEGER NOT NULL,
  valid_to_event INTEGER,
  effective_input_epoch INTEGER NOT NULL CHECK (effective_input_epoch >= 1),
  content_hash TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (requirement_id, revision),
  CHECK (valid_to_event IS NULL OR valid_to_event >= valid_from_event),
  CHECK ((status IN ('superseded','retracted','rejected') AND valid_to_event IS NOT NULL) OR status IN ('active','proposed'))
) STRICT;
CREATE INDEX ix_requirement_branch_status ON requirement(branch_id, status);

CREATE TABLE requirement_head (
  requirement_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','active','superseded','retracted','rejected')),
  current_goal_version TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (requirement_id, revision) REFERENCES requirement(requirement_id, revision) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ix_requirement_head_status ON requirement_head(status);

CREATE TABLE requirement_source (
  requirement_id TEXT NOT NULL,
  requirement_revision INTEGER NOT NULL,
  source_event_id TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('original','clarification','confirmation','correction')),
  PRIMARY KEY (requirement_id, requirement_revision, source_event_id, source_ref),
  FOREIGN KEY (requirement_id, requirement_revision) REFERENCES requirement(requirement_id, revision) ON DELETE RESTRICT
) STRICT;

CREATE VIEW requirement_current AS
SELECT r.* FROM requirement r
JOIN requirement_head h ON h.requirement_id = r.requirement_id AND h.revision = r.revision;

CREATE VIEW task_outcome_current AS
SELECT o.* FROM task_outcome o
WHERE o.revision = (SELECT max(x.revision) FROM task_outcome x WHERE x.branch_id = o.branch_id);

-- HOST migration 0009 (DD-TRG-002).
-- Default TriggerPolicy and canonical `bpol/1` budget policy.
--
-- 0008 owns only the trigger_policy schema. This migration installs the
-- default rows with guards: an existing active policy for the global scope or
-- any existing budget (`bpol/1` or active) is preserved unchanged, so a user
-- replacement is never overwritten, and a fresh home gets a real active row
-- instead of an in-memory fallback.

INSERT INTO policy_record (
  row_key, record_kind, body_json, parent_key, task_id, branch_id,
  input_epoch, goal_version, config_version, watermark, content_hash, created_at
)
SELECT
  'budget_policy:bpol/1',
  'budget_policy',
  json_object(
    'policy_version', 'bpol/1',
    'canonical_json', '{"concurrency":{"burst":3,"cooldown_base_ms":5000,"cooldown_max_ms":300000,"global_inflight":2,"per_scope_inflight":1,"rpm":30,"unknown_limit_inflight":1,"unknown_limit_rpm":6},"policy_version":"bpol/1","reservation_ttl_ms":120000,"schema_version":"rsi.budget_policy/1","scopes":[{"attempt_charge_at":"claim","attempt_refundable":false,"max_attempts":2,"max_cost_micros":100000,"max_input_tokens":32768,"max_output_tokens":2048,"min_work_ms":100,"purpose":"judge","question_margin_tokens":512,"question_max_tokens":32000,"request_margin_tokens":2048,"request_max_tokens":64000,"reserve_ms":150,"wall_ms":5000},{"attempt_charge_at":"claim","attempt_refundable":false,"max_attempts":3,"max_cost_micros":500000,"max_input_tokens":65536,"max_output_tokens":16384,"min_work_ms":1000,"purpose":"review_generate","question_margin_tokens":512,"question_max_tokens":32768,"request_margin_tokens":2048,"request_max_tokens":65536,"reserve_ms":1500,"wall_ms":180000},{"attempt_charge_at":"claim","attempt_refundable":false,"max_attempts":3,"max_cost_micros":100000,"max_input_tokens":32768,"max_output_tokens":4096,"min_work_ms":200,"purpose":"review_match","question_margin_tokens":256,"question_max_tokens":16384,"request_margin_tokens":1024,"request_max_tokens":32768,"reserve_ms":300,"wall_ms":30000},{"attempt_charge_at":"claim","attempt_refundable":false,"max_attempts":2,"max_cost_micros":200000,"max_input_tokens":65536,"max_output_tokens":4096,"min_work_ms":500,"purpose":"verifier","question_margin_tokens":512,"question_max_tokens":32768,"request_margin_tokens":2048,"request_max_tokens":65536,"reserve_ms":1000,"wall_ms":120000},{"attempt_charge_at":"claim","attempt_refundable":false,"max_attempts":1,"max_cost_micros":200000,"max_input_tokens":65536,"max_output_tokens":8192,"min_work_ms":300,"purpose":"egress_other","question_margin_tokens":512,"question_max_tokens":32768,"request_margin_tokens":2048,"request_max_tokens":65536,"reserve_ms":500,"wall_ms":120000}],"unknown_cost":"block_paid","unknown_provider_limit":"local_guard"}',
    'content_hash', 'sha256:337a6ae1b6984e7a2d00ec3249da44645754541f807978dbe26d09d92a00bcec',
    'active', 1,
    'created_at', 1750000000000
  ),
  'budget_policy:bpol/1',
  NULL, NULL, NULL, NULL, NULL, NULL,
  'sha256:337a6ae1b6984e7a2d00ec3249da44645754541f807978dbe26d09d92a00bcec',
  1750000000000
WHERE NOT EXISTS (
  SELECT 1 FROM policy_record
   WHERE record_kind = 'budget_policy'
     AND (json_extract(body_json, '$.policy_version') = 'bpol/1'
          OR json_extract(body_json, '$.active') = 1)
);
