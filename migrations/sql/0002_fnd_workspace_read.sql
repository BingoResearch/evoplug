-- W11/D2 targeted evidence supplementation (W4).
-- Additive fnd rows: evidence_supplement_record first, then its workspace read audit.
--
-- evoplug:directive:begin
-- These objects start schema major 3. The directive below is the runner's
-- target version: applying this file advances schema_meta from 2.0 to 3.0 in
-- place, after the mandatory pre-migration backup.
--
-- The fenced block is the only difference from the artifact shipped by
-- earlier binaries. The runner strips it to derive the checksum those homes
-- recorded, so an already-applied 0002 is not mistaken for a checksum defect.
-- evoplug:schema_major=3
-- evoplug:schema_minor=0
-- evoplug:directive:end

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

CREATE INDEX ix_evidence_supplement_binding ON evidence_supplement_record(task_id, branch_id, input_epoch, watermark);
CREATE INDEX ix_evidence_supplement_pack ON evidence_supplement_record(pack_key);
CREATE INDEX ix_evidence_supplement_aggregate ON evidence_supplement_record(aggregate_hash);

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

CREATE INDEX ix_workspace_read_supplement ON workspace_read_record(supplement_id);
CREATE INDEX ix_workspace_read_binding ON workspace_read_record(task_id, branch_id, input_epoch, watermark);
CREATE INDEX ix_workspace_read_path_hash ON workspace_read_record(path_hash);
