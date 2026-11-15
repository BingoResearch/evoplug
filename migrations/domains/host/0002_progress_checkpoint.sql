-- HOST migration 0002 (DD-TRG-011, DD-HOST-001).
-- progress_checkpoint: 17 columns, STRICT. Runtime writes go through FND
-- StateRowPort.appendStateRows only.

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
