-- REV rollback restoration: a rollback creates a checked projection for an
-- existing Experience version and records a rollback first event on that
-- projection. The historical projection receives a normal superseding event.
PRAGMA foreign_keys = OFF;

ALTER TABLE experience_lifecycle_events RENAME TO experience_lifecycle_events_v2;

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

INSERT INTO experience_lifecycle_events
SELECT * FROM experience_lifecycle_events_v2;
DROP TABLE experience_lifecycle_events_v2;
CREATE INDEX ix_experience_lifecycle_events_experience
  ON experience_lifecycle_events(experience_id, experience_version, sequence, event_id);

PRAGMA foreign_keys = ON;
