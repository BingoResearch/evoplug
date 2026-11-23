-- W11/D3: deterministic dispatch may mark a shard/omission with the terminal
-- status/reason `deterministic_skip`. SQLite cannot alter a CHECK constraint, so
-- both tables are rebuilt with the original column set and rows copied verbatim.
--
-- The rebuild follows SQLite's documented table-rebuild recipe: build the new
-- table under a temporary name, copy rows, drop the old table, then rename the
-- new table into place. Renaming the *old* table out of the way would rewrite
-- every REFERENCES evd_shard(...) clause in the other evidence tables to point
-- at the temporary name, leaving dangling foreign keys after the drop.
--
-- The directive lets the runner turn foreign_keys off while the referenced
-- table is dropped, then run PRAGMA foreign_key_check before commit. No column,
-- FK or row is changed.
-- evoplug:foreign_keys=off

CREATE TABLE evd_shard__w11_new (
  shard_id TEXT PRIMARY KEY,
  shard_plan_id TEXT NOT NULL REFERENCES evd_shard_plan(shard_plan_id) ON DELETE RESTRICT,
  shard_plan_key TEXT NOT NULL CHECK (length(shard_plan_key) = 71 AND substr(shard_plan_key,1,7) = 'sha256:'),
  shard_key TEXT NOT NULL CHECK (length(shard_key) = 71 AND substr(shard_key,1,7) = 'sha256:'),
  shard_order INTEGER NOT NULL CHECK (shard_order >= 1),
  status TEXT NOT NULL CHECK (status IN
    ('planned','budget_rejected','projection_rejected','bound','sent','accepted',
     'degraded','unknown','cancelled','deterministic_skip')),
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

INSERT INTO evd_shard__w11_new (shard_id, shard_plan_id, shard_plan_key, shard_key, shard_order, status, request_binding_id, attempt_ids, envelope_keys, reason_codes, body_json, row_version, created_at, task_id, branch_id, input_epoch, goal_version, config_version, watermark)
  SELECT shard_id, shard_plan_id, shard_plan_key, shard_key, shard_order, status, request_binding_id, attempt_ids, envelope_keys, reason_codes, body_json, row_version, created_at, task_id, branch_id, input_epoch, goal_version, config_version, watermark FROM evd_shard;

DROP TABLE evd_shard;

ALTER TABLE evd_shard__w11_new RENAME TO evd_shard;

CREATE UNIQUE INDEX ux_evd_shard_plan_shard ON evd_shard(shard_plan_id, shard_key);
CREATE UNIQUE INDEX ux_evd_shard_plan_order ON evd_shard(shard_plan_id, shard_order);

CREATE TABLE evd_omission__w11_new (
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
     'outside_scope','unretrievable','template_filtered','retrieval_gap','deterministic_skip')),
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

INSERT INTO evd_omission__w11_new (omission_id, omission_key, shard_plan_id, plan_hash, shard_id, question_keys, unit_keys, impact, reason, required_for_issue, recoverable, content_hash, content_ref, content_bytes, source_blob_refs, row_version, created_at, task_id, branch_id, input_epoch, goal_version, config_version, watermark)
  SELECT omission_id, omission_key, shard_plan_id, plan_hash, shard_id, question_keys, unit_keys, impact, reason, required_for_issue, recoverable, content_hash, content_ref, content_bytes, source_blob_refs, row_version, created_at, task_id, branch_id, input_epoch, goal_version, config_version, watermark FROM evd_omission;

DROP TABLE evd_omission;

ALTER TABLE evd_omission__w11_new RENAME TO evd_omission;

CREATE UNIQUE INDEX ux_evd_omission_key ON evd_omission(shard_plan_id, omission_key);
