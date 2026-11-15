-- REV migration 0005 (DD-REV handoff notification durability).
--
-- A completed handoff is durable before any downstream notification is called.
-- The pending row is deliberately local and idempotent: a crash during the
-- callback leaves it pending, so restart can retry with the same handoff_id.
CREATE TABLE review_handoff_delivery (
  handoff_id       TEXT PRIMARY KEY NOT NULL
                   REFERENCES review_handoffs(handoff_id) ON DELETE RESTRICT,
  job_id           TEXT NOT NULL UNIQUE
                   REFERENCES review_jobs(job_id) ON DELETE RESTRICT,
  state            TEXT NOT NULL CHECK (state IN ('pending','done')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code  TEXT,
  next_attempt_at  INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  created_at       INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at       INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;
CREATE INDEX ix_review_handoff_delivery_due
  ON review_handoff_delivery(state, next_attempt_at, handoff_id);

-- Existing completed handoffs are not silently considered delivered after an
-- upgrade. They enter the same durable recovery path as newly committed ones.
INSERT INTO review_handoff_delivery (
  handoff_id, job_id, state, attempts, last_error_code,
  next_attempt_at, created_at, updated_at
)
SELECT handoff_id, job_id, 'pending', 0, NULL, created_at, created_at, created_at
  FROM review_handoffs;
