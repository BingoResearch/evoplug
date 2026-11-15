-- CFG durable schema (DD-CFG-159, DD-CFG-189).
-- Owner: cfg; sequence: (cfg, 0001); executed by the FND migration runner
-- after the FND baseline and before any CFG DML.
-- Closed set: 8 STRICT tables, 82 columns, 9 foreign keys, 2 named partial
-- unique indexes, 2 inline UNIQUE constraints and 17 triggers.

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
CREATE TRIGGER cfg_field_claim_no_delete BEFORE DELETE ON cfg_field_claim
BEGIN SELECT RAISE(ABORT, 'cfg_field_claim_history'); END;
