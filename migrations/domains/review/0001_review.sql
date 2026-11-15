-- evoplug REV domain schema (DD-REV-150, DD-REV-150.1).
--
-- 13 CREATE TABLE and 17 CREATE INDEX statements, 25 FK constraints.
-- review_handoffs and experience_projections are derived tables and are not
-- registered as typed StateRow members. All tables are STRICT; hashes are
-- sha256: plus 64 lowercase hex; timestamps are UTC epoch milliseconds.

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
CREATE INDEX ix_review_jobs_state_stage ON review_jobs(state, stage, updated_at);
CREATE INDEX ix_review_jobs_snapshot ON review_jobs(snapshot_id);
CREATE INDEX ix_review_attempts_job_state ON review_attempts(job_id, state, ordinal);

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
CREATE INDEX ix_proposals_job_state ON proposals(job_id, state, ordinal);
CREATE INDEX ix_proposals_attempt ON proposals(attempt_id, ordinal);

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
CREATE INDEX ix_experiences_validation_plan
  ON experiences(validation_plan_id);
CREATE INDEX ix_experiences_body_ref
  ON experiences(body_ref);
CREATE INDEX ix_experiences_candidate
  ON experiences(created_at DESC, experience_id ASC, version DESC)
  WHERE superseded_by_version IS NULL;

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
CREATE UNIQUE INDEX ux_experience_projection_active_target
  ON experience_projections(host_id, config_space, mode, object_type, path_or_block,
                            COALESCE(block_id, ''))
  WHERE lifecycle IN ('trial','retained');
CREATE INDEX ix_experience_projections_candidate
  ON experience_projections(host_id, config_space, mode, lifecycle, experience_id, experience_version);

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

CREATE TABLE experience_lifecycle_events (
  event_id                TEXT PRIMARY KEY NOT NULL,
  schema_version          TEXT NOT NULL
                            CHECK (schema_version = 'rsi.experience_lifecycle_event/1'),
  projection_id           TEXT NOT NULL
                            REFERENCES experience_projections(projection_id)
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
                             'host_incompatible','rollback')),
  trigger_kind            TEXT NOT NULL CHECK (trigger_kind IN
                            ('adoption','begin_trial','retention_evaluated','usage_verification',
                             'user_action','expiry','supersede','host_change',
                             'authorization_change','rollback')),
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
          AND reason = 'adopted' AND trigger_kind = 'adoption')
      OR (sequence > 1 AND from_lifecycle IS NOT NULL
          AND projection_before_hash IS NOT NULL AND row_version_before >= 1
          AND from_lifecycle <> to_lifecycle)),
  CHECK (length(experience_content_hash) = 71
    AND substr(experience_content_hash,1,7) = 'sha256:'),
  CHECK (length(adoption_binding_hash) = 71
    AND substr(adoption_binding_hash,1,7) = 'sha256:'),
  CHECK (projection_before_hash IS NULL
    OR (length(projection_before_hash) = 71 AND substr(projection_before_hash,1,7) = 'sha256:')),
  CHECK (length(projection_after_hash) = 71
    AND substr(projection_after_hash,1,7) = 'sha256:'),
  CHECK (length(event_hash) = 71 AND substr(event_hash,1,7) = 'sha256:')
) STRICT;
CREATE INDEX ix_experience_lifecycle_events_experience
  ON experience_lifecycle_events(experience_id, experience_version, sequence, event_id);
