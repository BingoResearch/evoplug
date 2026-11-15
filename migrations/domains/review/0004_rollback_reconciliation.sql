-- Durable cross-domain rollback reconciliation (DD-REV-151).
-- FND and REV commit in separate durability domains; this row records the
-- interval between the verified FND write and REV materialisation.
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
