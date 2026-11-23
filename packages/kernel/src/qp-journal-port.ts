/**
 * QP's single journal entry point (DD-FND-059.1.6.3).
 *
 * QP owns five tables and the `QpJournalEvent` closed set, but it never opens
 * a transaction or writes a journal frame itself. FND takes the one writer
 * gate, opens `BEGIN IMMEDIATE`, calls `apply` exactly once, validates the
 * returned decision, writes exactly one QP frame, fsyncs it and projects the
 * typed rows plus the object documents/heads in the same short transaction.
 *
 * The ordering is fixed and every failure before the first journal byte is
 * `not_written` (zero frame bytes, zero commit_seq, zero projection). A
 * failure after the fsync is `unknown_recovery_required`: recovery replays the
 * frozen frame and never re-runs `apply`.
 */

import type {
  ErrorEnvelope,
  Hash,
  JsonValue,
  VersionBinding,
} from "@evoplug/core";
import type {
  QpJournalEvent,
  QpLiveStage,
} from "@evoplug/core/evidence";

/** The five QP-owned physical tables. */
export type QpProjectionTable =
  | "issue_transition"
  | "issue_judgment"
  | "issue_projection"
  | "question_plan"
  | "plan_state";

/** One QP typed row: the complete physical row, never an incremental patch. */
export interface QpProjectionRow {
  readonly table: QpProjectionTable;
  readonly operation: "insert" | "update";
  readonly object_id: string;
  /** `null` for inserts; the current `row_version` for updates. */
  readonly expected_row_version: number | null;
  readonly row_schema: string;
  readonly row: Record<string, JsonValue>;
  readonly after_hash: Hash;
}

/** The immutable object document a QP commit writes alongside its typed rows. */
interface QpObjectDocumentRow {
  readonly document_id: Hash;
  readonly object_id: string;
  readonly owner: "qp";
  readonly object_type: string;
  readonly schema_version: string;
  readonly revision: number;
  readonly state: string;
  readonly binding: VersionBinding | null;
  readonly content_hash: Hash;
  readonly canonical_json: string;
  readonly created_at: number;
}

/** The object head a QP commit writes alongside its object documents. */
interface QpObjectHeadRow {
  readonly object_id: string;
  readonly owner: "qp";
  readonly object_type: string;
  readonly revision: number;
  readonly document_id: Hash;
  readonly state: string;
  readonly content_hash: Hash;
  readonly row_version: number;
  readonly updated_at: number;
}

/** The decision QP returns from `apply`. */
export interface QpJournalDecision<Value> {
  readonly kind: "commit" | "existing";
  /** Exactly one event for `commit`; `null` for `existing`. */
  readonly event: QpJournalEvent | null;
  readonly projections: readonly QpProjectionRow[];
  readonly documents: readonly QpObjectDocumentRow[];
  readonly heads: readonly QpObjectHeadRow[];
  readonly value: Value | null;
}

export interface QpJournalCommitRequest<Value = null> {
  readonly binding: VersionBinding;
  apply(stage: QpLiveStage): {
    ok: true;
    status: "ok";
    value: QpJournalDecision<Value>;
  } | {
    ok: false;
    status: "rejected" | "conflict" | "degraded" | "pending" | "unknown";
    error: ErrorEnvelope;
  };
}

export type QpLiveCommitOutcome<Value = null> =
  | {
      ok: true;
      commit_state: "committed";
      receipt: { batch_hash: Hash; first_commit_seq: number; last_commit_seq: number };
      value: Value | null;
    }
  | { ok: true; commit_state: "existing"; value: Value | null }
  | { ok: false; commit_state: "not_written"; error: ErrorEnvelope }
  | { ok: false; commit_state: "unknown_recovery_required"; error: ErrorEnvelope };

export interface QpJournalCommitPort {
  commitQpJournal<Value = null>(
    input: QpJournalCommitRequest<Value>,
  ): Promise<QpLiveCommitOutcome<Value>>;
}

/** Re-exported for callers that only import the port surface. */
export type { QpJournalEvent, QpLiveStage };

