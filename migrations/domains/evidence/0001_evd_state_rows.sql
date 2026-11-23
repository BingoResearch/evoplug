-- EVD state-row migration artifact (DD-EVD-024).
-- Owner: evd, sequence key: (evd, 0001).
-- Exactly 15 CREATE TABLE statements and 19 index declarations, no DML.
-- Source of truth: docs/design/evoplug-详细设计-2026-10-21.md DD-EVD-024.
CREATE TABLE evd_evidence_pack (
  pack_id TEXT PRIMARY KEY,
  pack_key TEXT NOT NULL CHECK (length(pack_key) = 71 AND substr(pack_key,1,7) = 'sha256:'),
  pack_hash TEXT NOT NULL CHECK (length(pack_hash) = 71 AND substr(pack_hash,1,7) = 'sha256:'),
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 71 AND substr(evidence_hash,1,7) = 'sha256:'),
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 71 AND substr(plan_hash,1,7) = 'sha256:'),
  issue_id TEXT NOT NULL,
  issue_key TEXT NOT NULL,
  pack_state TEXT NOT NULL CHECK (pack_state IN ('valid','invalidated')),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND substr(content_hash,1,7) = 'sha256:'),
  content_ref TEXT NOT NULL CHECK (substr(content_ref,1,7) = 'blob://'),
  content_bytes INTEGER NOT NULL CHECK (content_bytes BETWEEN 1 AND 33554432),
  source_blob_refs TEXT NOT NULL CHECK (json_valid(source_blob_refs) AND json_type(source_blob_refs) = 'array'),
  row_version INTEGER NOT NULL CHECK (row_version = 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0)
) STRICT;

CREATE TABLE evd_service_profile (
  profile_id TEXT PRIMARY KEY,
  profile_key TEXT NOT NULL CHECK (length(profile_key) = 71 AND substr(profile_key,1,7) = 'sha256:'),
  profile_version INTEGER NOT NULL CHECK (profile_version >= 1),
  acceptance_status TEXT NOT NULL CHECK (acceptance_status IN ('eligible','shadow_only','blocked')),
  production_use INTEGER NOT NULL CHECK (production_use IN (0,1)),
  body_json TEXT NOT NULL CHECK (json_valid(body_json) AND json_type(body_json) = 'object'),
  row_version INTEGER NOT NULL CHECK (row_version = 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (acceptance_status <> 'blocked' OR production_use = 0)
) STRICT;

CREATE TABLE evd_validator_binding (
  validator_binding_id TEXT PRIMARY KEY,
  validator_binding_key TEXT NOT NULL CHECK (length(validator_binding_key) = 71 AND substr(validator_binding_key,1,7) = 'sha256:'),
  validator_policy_hash TEXT NOT NULL CHECK (length(validator_policy_hash) = 71 AND substr(validator_policy_hash,1,7) = 'sha256:'),
  service_profile_key TEXT NOT NULL CHECK (length(service_profile_key) = 71 AND substr(service_profile_key,1,7) = 'sha256:'),
  body_json TEXT NOT NULL CHECK (json_valid(body_json) AND json_type(body_json) = 'object'),
  row_version INTEGER NOT NULL CHECK (row_version = 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE evd_shard_plan (
  shard_plan_id TEXT PRIMARY KEY,
  shard_plan_key TEXT NOT NULL CHECK (length(shard_plan_key) = 71 AND substr(shard_plan_key,1,7) = 'sha256:'),
  shard_plan_hash TEXT NOT NULL CHECK (length(shard_plan_hash) = 71 AND substr(shard_plan_hash,1,7) = 'sha256:'),
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 71 AND substr(plan_hash,1,7) = 'sha256:'),
  issue_id TEXT NOT NULL,
  pack_id TEXT NOT NULL REFERENCES evd_evidence_pack(pack_id) ON DELETE RESTRICT,
  pack_key TEXT NOT NULL CHECK (length(pack_key) = 71 AND substr(pack_key,1,7) = 'sha256:'),
  service_profile_id TEXT NOT NULL REFERENCES evd_service_profile(profile_id) ON DELETE RESTRICT,
  service_profile_key TEXT NOT NULL CHECK (length(service_profile_key) = 71 AND substr(service_profile_key,1,7) = 'sha256:'),
  state TEXT NOT NULL CHECK (state IN ('planned','partially_rejected','bound','dispatched','completed','rejected')),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND substr(content_hash,1,7) = 'sha256:'),
  content_ref TEXT NOT NULL CHECK (substr(content_ref,1,7) = 'blob://'),
  content_bytes INTEGER NOT NULL CHECK (content_bytes BETWEEN 1 AND 33554432),
  source_blob_refs TEXT NOT NULL CHECK (json_valid(source_blob_refs) AND json_type(source_blob_refs) = 'array'),
  row_version INTEGER NOT NULL CHECK (row_version = 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0)
) STRICT;

CREATE TABLE evd_shard (
  shard_id TEXT PRIMARY KEY,
  shard_plan_id TEXT NOT NULL REFERENCES evd_shard_plan(shard_plan_id) ON DELETE RESTRICT,
  shard_plan_key TEXT NOT NULL CHECK (length(shard_plan_key) = 71 AND substr(shard_plan_key,1,7) = 'sha256:'),
  shard_key TEXT NOT NULL CHECK (length(shard_key) = 71 AND substr(shard_key,1,7) = 'sha256:'),
  shard_order INTEGER NOT NULL CHECK (shard_order >= 1),
  status TEXT NOT NULL CHECK (status IN
    ('planned','budget_rejected','projection_rejected','bound','sent','accepted',
     'degraded','unknown','cancelled')),
  request_binding_id TEXT REFERENCES evd_request_binding(binding_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  attempt_ids TEXT NOT NULL CHECK (json_valid(attempt_ids) AND json_type(attempt_ids) = 'array'),
  envelope_keys TEXT NOT NULL CHECK (json_valid(envelope_keys) AND json_type(envelope_keys) = 'array'),
  reason_codes TEXT NOT NULL CHECK (json_valid(reason_codes) AND json_type(reason_codes) = 'array'),
  body_json TEXT NOT NULL CHECK (json_valid(body_json) AND json_type(body_json) = 'object'),
  row_version INTEGER NOT NULL CHECK (row_version >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0)
) STRICT;

CREATE TABLE evd_request_binding (
  binding_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 71 AND substr(request_hash,1,7) = 'sha256:'),
  dispatch_key TEXT NOT NULL CHECK (length(dispatch_key) = 71 AND substr(dispatch_key,1,7) = 'sha256:'),
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 71 AND substr(plan_hash,1,7) = 'sha256:'),
  shard_id TEXT NOT NULL REFERENCES evd_shard(shard_id) ON DELETE RESTRICT,
  shard_key TEXT NOT NULL CHECK (length(shard_key) = 71 AND substr(shard_key,1,7) = 'sha256:'),
  shard_plan_id TEXT NOT NULL REFERENCES evd_shard_plan(shard_plan_id) ON DELETE RESTRICT,
  shard_plan_key TEXT NOT NULL CHECK (length(shard_plan_key) = 71 AND substr(shard_plan_key,1,7) = 'sha256:'),
  service_profile_key TEXT NOT NULL CHECK (length(service_profile_key) = 71 AND substr(service_profile_key,1,7) = 'sha256:'),
  validator_binding_key TEXT NOT NULL REFERENCES evd_validator_binding(validator_binding_key)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  state_hash TEXT NOT NULL CHECK (length(state_hash) = 71 AND substr(state_hash,1,7) = 'sha256:'),
  state_content_hash TEXT NOT NULL CHECK (length(state_content_hash) = 71 AND substr(state_content_hash,1,7) = 'sha256:'),
  questions_hash TEXT NOT NULL CHECK (length(questions_hash) = 71 AND substr(questions_hash,1,7) = 'sha256:'),
  template_bindings_digest TEXT NOT NULL CHECK (length(template_bindings_digest) = 71 AND substr(template_bindings_digest,1,7) = 'sha256:'),
  question_bindings_digest TEXT NOT NULL CHECK (length(question_bindings_digest) = 71 AND substr(question_bindings_digest,1,7) = 'sha256:'),
  proposition_bindings_digest TEXT NOT NULL CHECK (length(proposition_bindings_digest) = 71 AND substr(proposition_bindings_digest,1,7) = 'sha256:'),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND substr(content_hash,1,7) = 'sha256:'),
  content_ref TEXT NOT NULL CHECK (substr(content_ref,1,7) = 'blob://'),
  content_bytes INTEGER NOT NULL CHECK (content_bytes BETWEEN 1 AND 33554432),
  source_blob_refs TEXT NOT NULL CHECK (json_valid(source_blob_refs) AND json_type(source_blob_refs) = 'array'),
  row_version INTEGER NOT NULL CHECK (row_version = 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0)
) STRICT;

CREATE TABLE evd_attempt (
  attempt_id TEXT PRIMARY KEY,
  attempt_key TEXT NOT NULL CHECK (length(attempt_key) = 71 AND substr(attempt_key,1,7) = 'sha256:'),
  binding_id TEXT NOT NULL REFERENCES evd_request_binding(binding_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  request_id TEXT NOT NULL,
  dispatch_key TEXT NOT NULL CHECK (length(dispatch_key) = 71 AND substr(dispatch_key,1,7) = 'sha256:'),
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  state TEXT NOT NULL CHECK (state IN
    ('prepared','sending','response_received','accepted','degraded','transport_error',
     'timeout','outcome_unknown','cancelled')),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  error_code TEXT,
  response_envelope_id TEXT REFERENCES evd_envelope(envelope_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  late_result_id TEXT REFERENCES evd_late_result(late_result_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  body_json TEXT NOT NULL CHECK (json_valid(body_json) AND json_type(body_json) = 'object'),
  row_version INTEGER NOT NULL CHECK (row_version >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0)
) STRICT;

CREATE TABLE evd_envelope (
  envelope_id TEXT PRIMARY KEY,
  envelope_key TEXT NOT NULL CHECK (length(envelope_key) = 71 AND substr(envelope_key,1,7) = 'sha256:'),
  binding_id TEXT NOT NULL REFERENCES evd_request_binding(binding_id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL REFERENCES evd_attempt(attempt_id) ON DELETE RESTRICT,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 71 AND substr(request_hash,1,7) = 'sha256:'),
  dispatch_key TEXT NOT NULL CHECK (length(dispatch_key) = 71 AND substr(dispatch_key,1,7) = 'sha256:'),
  shard_id TEXT NOT NULL REFERENCES evd_shard(shard_id) ON DELETE RESTRICT,
  shard_key TEXT NOT NULL CHECK (length(shard_key) = 71 AND substr(shard_key,1,7) = 'sha256:'),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('accepted','degraded')),
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND substr(content_hash,1,7) = 'sha256:'),
  content_ref TEXT NOT NULL CHECK (substr(content_ref,1,7) = 'blob://'),
  content_bytes INTEGER NOT NULL CHECK (content_bytes BETWEEN 1 AND 33554432),
  source_blob_refs TEXT NOT NULL CHECK (json_valid(source_blob_refs) AND json_type(source_blob_refs) = 'array'),
  row_version INTEGER NOT NULL CHECK (row_version = 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0)
) STRICT;

CREATE TABLE evd_late_result (
  late_result_id TEXT PRIMARY KEY,
  late_result_key TEXT NOT NULL CHECK (length(late_result_key) = 71 AND substr(late_result_key,1,7) = 'sha256:'),
  attempt_id TEXT NOT NULL REFERENCES evd_attempt(attempt_id) ON DELETE RESTRICT,
  envelope_key TEXT CHECK (envelope_key IS NULL OR (length(envelope_key) = 71 AND substr(envelope_key,1,7) = 'sha256:')),
  disposition TEXT NOT NULL CHECK (disposition IN ('appended_history','conflict_rejected')),
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND substr(content_hash,1,7) = 'sha256:'),
  content_ref TEXT NOT NULL CHECK (substr(content_ref,1,7) = 'blob://'),
  content_bytes INTEGER NOT NULL CHECK (content_bytes BETWEEN 1 AND 33554432),
  source_blob_refs TEXT NOT NULL CHECK (json_valid(source_blob_refs) AND json_type(source_blob_refs) = 'array'),
  row_version INTEGER NOT NULL CHECK (row_version = 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0)
) STRICT;

CREATE TABLE evd_aggregate (
  aggregate_id TEXT PRIMARY KEY,
  aggregate_key TEXT NOT NULL CHECK (length(aggregate_key) = 71 AND substr(aggregate_key,1,7) = 'sha256:'),
  aggregate_hash TEXT NOT NULL CHECK (length(aggregate_hash) = 71 AND substr(aggregate_hash,1,7) = 'sha256:'),
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 71 AND substr(plan_hash,1,7) = 'sha256:'),
  shard_plan_key TEXT NOT NULL REFERENCES evd_shard_plan(shard_plan_key) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  final_state TEXT NOT NULL CHECK (final_state IN ('consistent','inconsistent','unknown','abstain','needs_evidence')),
  final_basis TEXT CHECK (final_basis IS NULL OR final_basis IN ('hard_fact','semantic_shadow','mixed')),
  coverage_complete INTEGER NOT NULL CHECK (coverage_complete IN (0,1)),
  supersedes_aggregate_id TEXT REFERENCES evd_aggregate(aggregate_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND substr(content_hash,1,7) = 'sha256:'),
  content_ref TEXT NOT NULL CHECK (substr(content_ref,1,7) = 'blob://'),
  content_bytes INTEGER NOT NULL CHECK (content_bytes BETWEEN 1 AND 33554432),
  source_blob_refs TEXT NOT NULL CHECK (json_valid(source_blob_refs) AND json_type(source_blob_refs) = 'array'),
  row_version INTEGER NOT NULL CHECK (row_version = 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  CHECK ((final_state = 'needs_evidence' AND final_basis IS NULL)
      OR (final_state = 'unknown' AND final_basis IS NULL)
      OR (final_state = 'unknown' AND final_basis = 'semantic_shadow')
      OR (final_state = 'consistent' AND final_basis IS NOT NULL AND final_basis IN ('hard_fact','mixed','semantic_shadow'))
      OR (final_state = 'inconsistent' AND final_basis IS NOT NULL AND final_basis IN ('hard_fact','semantic_shadow'))
      OR (final_state = 'abstain' AND final_basis IS NOT NULL AND final_basis IN ('hard_fact','semantic_shadow')))
) STRICT;

CREATE TABLE evd_state_manifest (
  manifest_id TEXT PRIMARY KEY,
  manifest_key TEXT NOT NULL CHECK (length(manifest_key) = 71 AND substr(manifest_key,1,7) = 'sha256:'),
  manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 71 AND substr(manifest_hash,1,7) = 'sha256:'),
  shard_id TEXT NOT NULL REFERENCES evd_shard(shard_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  shard_key TEXT NOT NULL CHECK (length(shard_key) = 71 AND substr(shard_key,1,7) = 'sha256:'),
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 71 AND substr(plan_hash,1,7) = 'sha256:'),
  pack_key TEXT NOT NULL REFERENCES evd_evidence_pack(pack_key) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  state_hash TEXT NOT NULL CHECK (length(state_hash) = 71 AND substr(state_hash,1,7) = 'sha256:'),
  state_content_hash TEXT NOT NULL CHECK (length(state_content_hash) = 71 AND substr(state_content_hash,1,7) = 'sha256:'),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND substr(content_hash,1,7) = 'sha256:'),
  content_ref TEXT NOT NULL CHECK (substr(content_ref,1,7) = 'blob://'),
  content_bytes INTEGER NOT NULL CHECK (content_bytes BETWEEN 1 AND 33554432),
  source_blob_refs TEXT NOT NULL CHECK (json_valid(source_blob_refs) AND json_type(source_blob_refs) = 'array'),
  row_version INTEGER NOT NULL CHECK (row_version = 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0)
) STRICT;

CREATE TABLE evd_dependency_unit (
  unit_id TEXT PRIMARY KEY,
  unit_key TEXT NOT NULL CHECK (length(unit_key) = 71 AND substr(unit_key,1,7) = 'sha256:'),
  unit_hash TEXT NOT NULL CHECK (length(unit_hash) = 71 AND substr(unit_hash,1,7) = 'sha256:'),
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 71 AND substr(plan_hash,1,7) = 'sha256:'),
  pack_id TEXT NOT NULL REFERENCES evd_evidence_pack(pack_id) ON DELETE RESTRICT,
  pack_key TEXT NOT NULL CHECK (length(pack_key) = 71 AND substr(pack_key,1,7) = 'sha256:'),
  dependency_key TEXT NOT NULL,
  inseparable_group_key TEXT NOT NULL,
  transport_role TEXT NOT NULL CHECK (transport_role IN
    ('requirement','feedback','artifact','verifier','counter','history','context')),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND substr(content_hash,1,7) = 'sha256:'),
  content_ref TEXT NOT NULL CHECK (substr(content_ref,1,7) = 'blob://'),
  content_bytes INTEGER NOT NULL CHECK (content_bytes BETWEEN 1 AND 33554432),
  source_blob_refs TEXT NOT NULL CHECK (json_valid(source_blob_refs) AND json_type(source_blob_refs) = 'array'),
  row_version INTEGER NOT NULL CHECK (row_version = 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0)
) STRICT;

CREATE TABLE evd_omission (
  omission_id TEXT PRIMARY KEY,
  omission_key TEXT NOT NULL CHECK (length(omission_key) = 71 AND substr(omission_key,1,7) = 'sha256:'),
  shard_plan_id TEXT NOT NULL REFERENCES evd_shard_plan(shard_plan_id) ON DELETE RESTRICT,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 71 AND substr(plan_hash,1,7) = 'sha256:'),
  shard_id TEXT REFERENCES evd_shard(shard_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  question_keys TEXT NOT NULL CHECK (json_valid(question_keys) AND json_type(question_keys) = 'array'),
  unit_keys TEXT NOT NULL CHECK (json_valid(unit_keys) AND json_type(unit_keys) = 'array'),
  impact TEXT NOT NULL CHECK (impact IN ('none','may_change_answer','blocking')),
  reason TEXT NOT NULL CHECK (reason IN
    ('not_required','dedup_same_content','budget_context','budget_exceeds','limits_unknown',
     'outside_scope','unretrievable','template_filtered','retrieval_gap')),
  required_for_issue INTEGER NOT NULL CHECK (required_for_issue IN (0,1)),
  recoverable INTEGER NOT NULL CHECK (recoverable IN (0,1)),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND substr(content_hash,1,7) = 'sha256:'),
  content_ref TEXT NOT NULL CHECK (substr(content_ref,1,7) = 'blob://'),
  content_bytes INTEGER NOT NULL CHECK (content_bytes BETWEEN 1 AND 33554432),
  source_blob_refs TEXT NOT NULL CHECK (json_valid(source_blob_refs) AND json_type(source_blob_refs) = 'array'),
  row_version INTEGER NOT NULL CHECK (row_version = 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0)
) STRICT;

CREATE TABLE evd_budget_estimate (
  estimate_id TEXT PRIMARY KEY,
  estimate_key TEXT NOT NULL CHECK (length(estimate_key) = 71 AND substr(estimate_key,1,7) = 'sha256:'),
  estimate_hash TEXT NOT NULL CHECK (length(estimate_hash) = 71 AND substr(estimate_hash,1,7) = 'sha256:'),
  shard_id TEXT NOT NULL REFERENCES evd_shard(shard_id) ON DELETE RESTRICT,
  shard_key TEXT NOT NULL CHECK (length(shard_key) = 71 AND substr(shard_key,1,7) = 'sha256:'),
  shard_plan_id TEXT NOT NULL REFERENCES evd_shard_plan(shard_plan_id) ON DELETE RESTRICT,
  service_profile_key TEXT NOT NULL CHECK (length(service_profile_key) = 71 AND substr(service_profile_key,1,7) = 'sha256:'),
  limits_hash TEXT NOT NULL CHECK (length(limits_hash) = 71 AND substr(limits_hash,1,7) = 'sha256:'),
  verdict TEXT NOT NULL CHECK (verdict IN ('fits','exceeds_request','exceeds_question','limits_unknown')),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND substr(content_hash,1,7) = 'sha256:'),
  content_ref TEXT NOT NULL CHECK (substr(content_ref,1,7) = 'blob://'),
  content_bytes INTEGER NOT NULL CHECK (content_bytes BETWEEN 1 AND 33554432),
  source_blob_refs TEXT NOT NULL CHECK (json_valid(source_blob_refs) AND json_type(source_blob_refs) = 'array'),
  row_version INTEGER NOT NULL CHECK (row_version = 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  task_id TEXT NOT NULL REFERENCES task(task_id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(branch_id) ON DELETE RESTRICT,
  input_epoch INTEGER NOT NULL CHECK (input_epoch >= 1),
  goal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0)
) STRICT;

CREATE TABLE evd_service_state (
  service_state_key TEXT PRIMARY KEY CHECK (length(service_state_key) = 71 AND substr(service_state_key,1,7) = 'sha256:'),
  profile_key TEXT NOT NULL CHECK (length(profile_key) = 71 AND substr(profile_key,1,7) = 'sha256:'),
  current_profile_version INTEGER NOT NULL CHECK (current_profile_version >= 1),
  current_profile_id TEXT NOT NULL REFERENCES evd_service_profile(profile_id) ON DELETE RESTRICT,
  acceptance_status TEXT NOT NULL CHECK (acceptance_status IN ('eligible','shadow_only','blocked')),
  reason_codes TEXT NOT NULL CHECK (json_valid(reason_codes) AND json_type(reason_codes) = 'array'),
  body_json TEXT NOT NULL CHECK (json_valid(body_json) AND json_type(body_json) = 'object'),
  row_version INTEGER NOT NULL CHECK (row_version >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;
CREATE UNIQUE INDEX ux_evd_pack_key ON evd_evidence_pack(pack_key);
CREATE UNIQUE INDEX ux_evd_unit_pack_key ON evd_dependency_unit(pack_id, unit_key);
CREATE UNIQUE INDEX ux_evd_manifest_key ON evd_state_manifest(manifest_key);
CREATE UNIQUE INDEX ux_evd_shard_plan_key ON evd_shard_plan(shard_plan_key);
CREATE UNIQUE INDEX ux_evd_shard_plan_shard ON evd_shard(shard_plan_id, shard_key);
CREATE UNIQUE INDEX ux_evd_shard_plan_order ON evd_shard(shard_plan_id, shard_order);
CREATE UNIQUE INDEX ux_evd_omission_key ON evd_omission(shard_plan_id, omission_key);
CREATE UNIQUE INDEX ux_evd_estimate_key ON evd_budget_estimate(estimate_key);
CREATE UNIQUE INDEX ux_evd_profile_key_version ON evd_service_profile(profile_key, profile_version);
CREATE UNIQUE INDEX ux_evd_service_state_profile ON evd_service_state(profile_key);
CREATE UNIQUE INDEX ux_evd_validator_binding_key ON evd_validator_binding(validator_binding_key);
CREATE UNIQUE INDEX ux_evd_request_dispatch_state ON evd_request_binding(dispatch_key, state_hash);
CREATE UNIQUE INDEX ux_evd_attempt_no ON evd_attempt(binding_id, attempt_no);
CREATE UNIQUE INDEX ux_evd_envelope_key ON evd_envelope(envelope_key);
CREATE UNIQUE INDEX ux_evd_envelope_attempt ON evd_envelope(attempt_id);
CREATE UNIQUE INDEX ux_evd_late_result_key ON evd_late_result(late_result_key);
CREATE UNIQUE INDEX ux_evd_late_result_attempt_base
  ON evd_late_result(attempt_id) WHERE disposition = 'appended_history';
CREATE UNIQUE INDEX ux_evd_aggregate_key ON evd_aggregate(aggregate_key);
-- 非唯一索引，仅服务 readEvdAggregateSnapshot 的历史 aggregate 枚举；不参与唯一性裁决
CREATE INDEX ix_evd_aggregate_shard_plan
  ON evd_aggregate(shard_plan_key, created_at, aggregate_id);
