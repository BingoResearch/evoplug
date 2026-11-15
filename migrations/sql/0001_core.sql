-- evoplug FND core schema baseline.
--
-- Source of truth: docs/design/evoplug-详细设计-2026-10-21.md
--   DD-FND-051 (metadata, journal, blob)
--   DD-FND-052 (identity, input, goal snapshots)
--   DD-FND-053 (requirement, fact, feedback, correction)
--   DD-FND-054 (success evidence, task outcome)
--   DD-FND-055 (decision record, budget)
--   DD-FND-056 (authorization, managed writes)
--   DD-FND-057 (delivery, outbox, idempotency, replay, egress approval)
--   DD-FND-058 (generic object documents, install tables)
--   DD-FND-095.4 (config write tables, schema major 2)
--
-- Every table is STRICT. Timestamps are UTC epoch milliseconds. Booleans are 0/1.
-- Hash columns hold `sha256:` plus 64 lowercase hex characters (71 chars total).
-- Domain tables (EVD/REV/HOST/CFG/QP) live in migrations/domains/<owner>/ and are
-- never created here.

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
CREATE UNIQUE INDEX ux_commit_journal_seq ON commit_record(journal_id, commit_seq);
CREATE UNIQUE INDEX ux_commit_batch_member ON commit_record(batch_hash, batch_ordinal)
  WHERE batch_hash IS NOT NULL;
CREATE INDEX ix_commit_indexed ON commit_record(indexed_at);

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

CREATE TABLE task (
  task_id TEXT PRIMARY KEY,
  project_id TEXT,
  root_task_id TEXT,
  parent_task_id TEXT REFERENCES task(task_id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (root_task_id IS NULL OR root_task_id = task_id OR parent_task_id IS NOT NULL)
) STRICT;

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

CREATE VIEW requirement_current AS
SELECT r.* FROM requirement r
JOIN requirement_head h ON h.requirement_id = r.requirement_id AND h.revision = r.revision;

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
CREATE INDEX ix_fact_branch_kind ON state_fact(branch_id, kind, observed_at);
CREATE INDEX ix_fact_binding ON state_fact(task_id, branch_id, input_epoch, watermark);

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

CREATE VIEW task_outcome_current AS
SELECT o.* FROM task_outcome o
WHERE o.revision = (SELECT max(x.revision) FROM task_outcome x WHERE x.branch_id = o.branch_id);

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

CREATE TABLE budget_policy (
  policy_version TEXT PRIMARY KEY,
  canonical_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX ux_budget_policy_active ON budget_policy(active) WHERE active = 1;

CREATE TABLE config_profile (
  config_version TEXT PRIMARY KEY,
  config_space TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','superseded')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX ux_config_profile_active ON config_profile(config_space, status) WHERE status = 'active';

CREATE TABLE egress_policy (
  policy_version TEXT PRIMARY KEY,
  canonical_json TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX ux_egress_policy_active ON egress_policy(active) WHERE active = 1;

CREATE TABLE credential_ref (
  secret_ref TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('api_key','oauth_refresh','host_native')),
  locator TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','revoked','missing')),
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
) STRICT;

CREATE TABLE budget_reservation (
  reservation_id TEXT PRIMARY KEY,
  reservation_key TEXT NOT NULL,
  policy_version TEXT NOT NULL REFERENCES budget_policy(policy_version) ON DELETE RESTRICT,
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
CREATE INDEX ix_budget_reservation_scope_state ON budget_reservation(scope_key, state, expires_at);
CREATE INDEX ix_budget_reservation_binding ON budget_reservation(branch_id, input_epoch, purpose);

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
CREATE INDEX ix_write_state ON write_intent(state, updated_at);
CREATE INDEX ix_write_grant ON write_intent(grant_id);
CREATE INDEX ix_write_root_target ON write_intent(root_id, target_path);
CREATE INDEX ix_write_rollback_target ON write_intent(rollback_of_write_id);

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
CREATE TRIGGER config_write_intent_root_binding
BEFORE INSERT ON config_write_intent
WHEN NOT EXISTS (
  SELECT 1 FROM root_registration
  WHERE root_id = NEW.root_id AND registration_hash = NEW.root_registration_hash
)
BEGIN SELECT RAISE(ABORT, 'config_write_root_binding'); END;
CREATE INDEX ix_config_intent_state ON config_write_intent(state, updated_at);
CREATE INDEX ix_config_intent_grant ON config_write_intent(grant_id);
CREATE INDEX ix_config_intent_target ON config_write_intent(root_id, target_path);
CREATE UNIQUE INDEX ux_config_intent_active ON config_write_intent(root_id, target_path)
  WHERE state IN ('intent_recorded','snapshot_written','temp_written','renamed','dir_synced');

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

CREATE TABLE grant_consumption (
  grant_id TEXT PRIMARY KEY REFERENCES authorization_grant(grant_id) ON DELETE RESTRICT,
  write_kind TEXT NOT NULL CHECK (write_kind IN ('managed','config')),
  managed_write_id TEXT UNIQUE REFERENCES write_intent(write_id) ON DELETE RESTRICT,
  config_write_id TEXT UNIQUE REFERENCES config_write_intent(config_write_id) ON DELETE RESTRICT,
  consumed_at INTEGER NOT NULL,
  CHECK ((write_kind = 'managed' AND managed_write_id IS NOT NULL AND config_write_id IS NULL)
      OR (write_kind = 'config' AND config_write_id IS NOT NULL AND managed_write_id IS NULL))
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
CREATE INDEX ix_delivery_state_expiry ON delivery(state, expires_at);
CREATE INDEX ix_delivery_branch ON delivery(branch_id, created_at);
CREATE INDEX ix_delivery_dedupe ON delivery(dedupe_key, evidence_hash);

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
CREATE UNIQUE INDEX ux_replay_execution_active ON replay_execution(replay_plan_id)
  WHERE state IN ('authorized','running');
CREATE INDEX ix_replay_execution_result ON replay_execution(replay_plan_id, created_at);

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

CREATE TABLE maintenance_run (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('gc','recovery','migration','backup')),
  mode TEXT NOT NULL CHECK (mode IN ('dry_run','apply')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  report_json TEXT NOT NULL,
  run_hash TEXT NOT NULL
) STRICT;
