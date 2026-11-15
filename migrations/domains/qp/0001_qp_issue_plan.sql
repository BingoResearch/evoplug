-- QP domain schema (DD-QP-27a).
--
-- Owner: qp. Executed by the FND migrator in (owner, sequence) order after
-- migrations/sql/0001_core.sql. Five typed tables are relationship indexes and
-- projections only; every object is also written to object_document /
-- object_head in the same writer-gate transaction. STRICT and foreign keys
-- match the FND baseline.

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
