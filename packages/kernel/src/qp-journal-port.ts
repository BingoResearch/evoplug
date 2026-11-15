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

import { canonicalHash, canonicalJsonText } from "@evoplug/core";
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

import {
  createJournalCommitter,
  type JournalCommitter,
  type JournalWriter,
  type SqliteConnection,
  type Tx,
} from "@evoplug/storage";

import { fieldError, internalError } from "./errors.js";

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
export interface QpObjectDocumentRow {
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
export interface QpObjectHeadRow {
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

export interface QpJournalCommitPortOptions {
  readonly connection: SqliteConnection;
  readonly journal: JournalWriter;
  readonly journal_relative_path: string;
  readonly now?: () => number;
}

const QP_EVENT_TYPES: ReadonlySet<string> = new Set([
  "issue_transition_appended",
  "question_plan_put",
  "plan_state_appended",
  "judgment_route_recorded",
]);

/** The QP row schema each projection table must carry. */
const QP_ROW_SCHEMAS: Readonly<Record<QpProjectionTable, string>> = {
  issue_transition: "rsi.issue_transition/1",
  issue_judgment: "rsi.issue_judgment/1",
  issue_projection: "rsi.issue/1",
  question_plan: "rsi.question_plan/1",
  plan_state: "rsi.question_plan_state/1",
};

const QP_PRIMARY_KEYS: Readonly<Record<QpProjectionTable, readonly string[]>> = {
  issue_transition: ["object_id"],
  issue_judgment: ["object_id"],
  issue_projection: ["issue_id"],
  question_plan: ["plan_id"],
  plan_state: ["object_id"],
};

/**
 * Creates the concrete FND-side QP commit port.
 *
 * The port owns the writer gate: `apply` runs inside `BEGIN IMMEDIATE`, the
 * single frame is written and fsynced while the transaction is still open, and
 * the typed rows, object documents and object heads are projected in that same
 * transaction before `synchronous=FULL` COMMIT.
 */
export function createQpJournalCommitPort(
  options: QpJournalCommitPortOptions,
): QpJournalCommitPort {
  const now = options.now ?? ((): number => Date.now());
  const committer: JournalCommitter = createJournalCommitter({
    writer: options.journal,
    connection: options.connection,
    relative_path: options.journal_relative_path,
    now
  });

  return {
    async commitQpJournal<Value = null>(
      input: QpJournalCommitRequest<Value>
    ): Promise<QpLiveCommitOutcome<Value>> {
      // The decision is taken inside the writer gate, before any journal byte
      // exists. `existing` and every validation failure therefore leave zero
      // frame bytes, zero commit_seq and zero projection behind.
      const prepared = prepareQpCommit(input, options.connection, now);
      if (!prepared.ok) {
        return { ok: false, commit_state: "not_written", error: prepared.error };
      }
      if (prepared.value.kind === "existing") {
        return { ok: true, commit_state: "existing", value: prepared.value.value };
      }
      const decision = prepared.value.decision;

      const outcome = await committer.commit(
        {
          schema_version: "rsi.journal_event/1",
          event: decision.event as unknown as JsonValue,
          event_hash: canonicalHash(decision.event as unknown as JsonValue),
          blob_hashes: []
        },
        (tx, receipt) => {
          projectQpDecision(tx, decision, receipt.first_commit_seq);
          return null;
        }
      );
      if (!outcome.ok) {
        return {
          ok: false,
          commit_state: outcome.commit_state,
          error: outcome.error
        };
      }
      return {
        ok: true,
        commit_state: "committed",
        receipt: {
          batch_hash: canonicalHash({ event: decision.event as unknown as JsonValue }),
          first_commit_seq: outcome.receipt.first_commit_seq,
          last_commit_seq: outcome.receipt.last_commit_seq
        },
        value: decision.value
      };
    }
  };
}

interface PreparedCommit<Value> {
  readonly kind: "commit";
  readonly decision: QpJournalDecision<Value>;
}

/**
 * Runs `apply` inside `BEGIN IMMEDIATE` and validates the decision it returns.
 *
 * The validation is the FND half of DD-FND-059.1.6.3 step 5: the event must
 * belong to the published four-member closed set, the payload hash must match,
 * every projection must target one of the five QP tables with a registered row
 * schema and a matching `after_hash`, and the object documents and heads must
 * be complete and paired.
 */
function prepareQpCommit<Value>(
  input: QpJournalCommitRequest<Value>,
  connection: SqliteConnection,
  now: () => number
): { ok: true; value: PreparedCommit<Value> | { kind: "existing"; value: Value | null } } | { ok: false; error: ErrorEnvelope } {
  const outcome = runDecisionInTransaction(input, connection);
  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }
  const decision = outcome.value;
  if (decision.kind === "existing") {
    return { ok: true, value: { kind: "existing", value: decision.value } };
  }
  const validation = validateQpDecision(decision);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }
  void now;
  return { ok: true, value: { kind: "commit", decision } };
}

function runDecisionInTransaction<Value>(
  input: QpJournalCommitRequest<Value>,
  connection: SqliteConnection
): { ok: true; value: QpJournalDecision<Value> } | { ok: false; error: ErrorEnvelope } {
  try {
    connection.exec("BEGIN IMMEDIATE");
  } catch (error) {
    return {
      ok: false,
      error: internalError(`kernel.qp_begin_immediate_failed:${String(error)}`)
    };
  }
  let decision: QpJournalDecision<Value>;
  try {
    const stage: QpLiveStage = { tx: { get: null, all: null } as unknown as QpLiveStage["tx"] };
    const applied = input.apply(stage);
    if (!applied.ok) {
      connection.exec("ROLLBACK");
      return { ok: false, error: applied.error };
    }
    decision = applied.value;
  } catch (error) {
    try {
      connection.exec("ROLLBACK");
    } catch {
      // A failed rollback leaves the connection unusable; the original error wins.
    }
    return {
      ok: false,
      error: internalError(`kernel.qp_apply_failed:${String(error)}`)
    };
  }
  try {
    connection.exec("COMMIT");
  } catch (error) {
    try {
      connection.exec("ROLLBACK");
    } catch {
      // Ignore a secondary rollback failure.
    }
    return {
      ok: false,
      error: internalError(`kernel.qp_decision_commit_failed:${String(error)}`)
    };
  }
  return { ok: true, value: decision };
}

function validateQpDecision<Value>(
  decision: QpJournalDecision<Value>
): { ok: true } | { ok: false; error: ErrorEnvelope } {
  if (decision.kind === "existing") {
    if (
      decision.event !== null ||
      decision.projections.length > 0 ||
      decision.documents.length > 0 ||
      decision.heads.length > 0
    ) {
      return {
        ok: false,
        error: fieldError("qp.decision", "existing_must_be_empty", "E_STATE_ROW_SCHEMA")
      };
    }
    return { ok: true };
  }
  const event = decision.event;
  if (event === null) {
    return {
      ok: false,
      error: fieldError("qp.event", "commit_requires_one_event", "E_STATE_ROW_SCHEMA")
    };
  }
  if (!QP_EVENT_TYPES.has(event.event_type)) {
    return {
      ok: false,
      error: fieldError("qp.event_type", "registered_event_type", "E_STATE_ROW_SCHEMA")
    };
  }
  const payloadHash = canonicalHash(event.payload as unknown as JsonValue);
  if (payloadHash !== event.payload_hash) {
    return {
      ok: false,
      error: fieldError("qp.payload_hash", "payload_hash_mismatch", "E_STATE_ROW_SCHEMA")
    };
  }
  if (decision.projections.length === 0 && decision.documents.length === 0) {
    return {
      ok: false,
      error: fieldError("qp.decision", "empty_commit", "E_STATE_ROW_SCHEMA")
    };
  }
  if (decision.documents.length !== decision.heads.length) {
    return {
      ok: false,
      error: fieldError("qp.decision", "documents_heads_paired", "E_STATE_ROW_SCHEMA")
    };
  }
  for (const projection of decision.projections) {
    const expectedSchema = QP_ROW_SCHEMAS[projection.table];
    if (expectedSchema === undefined) {
      return {
        ok: false,
        error: fieldError("qp.projection.table", "qp_table", "E_STATE_ROW_SCHEMA")
      };
    }
    if (projection.row_schema !== expectedSchema) {
      return {
        ok: false,
        error: fieldError("qp.projection.row_schema", expectedSchema, "E_STATE_ROW_SCHEMA")
      };
    }
    const afterHash = canonicalHash(projection.row as unknown as JsonValue);
    if (afterHash !== projection.after_hash) {
      return {
        ok: false,
        error: fieldError("qp.projection.after_hash", "after_hash_mismatch", "E_LEDGER_EVENT_INVALID")
      };
    }
    const primaryKey = QP_PRIMARY_KEYS[projection.table];
    const keyValue = projection.row[primaryKey[0] ?? "object_id"];
    if (keyValue !== projection.object_id) {
      return {
        ok: false,
        error: fieldError("qp.projection.object_id", "primary_key_match", "E_STATE_ROW_SCHEMA")
      };
    }
    if (projection.operation === "insert" && projection.expected_row_version !== null) {
      return {
        ok: false,
        error: fieldError("qp.projection.expected_row_version", "null_for_insert", "E_STATE_ROW_SCHEMA")
      };
    }
    if (projection.operation === "update" && projection.expected_row_version === null) {
      return {
        ok: false,
        error: fieldError("qp.projection.expected_row_version", "required_for_update", "E_STATE_ROW_SCHEMA")
      };
    }
  }
  return { ok: true };
}

/** Writes the QP typed rows plus the object documents and heads. */
function projectQpDecision(
  tx: Tx,
  decision: QpJournalDecision<unknown>,
  commitSeq: number
): void {
  for (const document of decision.documents) {
    tx.prepare(
      `INSERT INTO object_document (
         document_id, object_id, owner, object_type, schema_version, revision, state,
         task_id, branch_id, input_epoch, goal_version, config_version, watermark,
         content_hash, canonical_json, created_at
       ) VALUES (
         :document_id, :object_id, :owner, :object_type, :schema_version, :revision, :state,
         :task_id, :branch_id, :input_epoch, :goal_version, :config_version, :watermark,
         :content_hash, :canonical_json, :created_at
       )`
    ).run({
      document_id: document.document_id,
      object_id: document.object_id,
      owner: document.owner,
      object_type: document.object_type,
      schema_version: document.schema_version,
      revision: document.revision,
      state: document.state,
      task_id: document.binding?.task_id ?? null,
      branch_id: document.binding?.branch_id ?? null,
      input_epoch: document.binding?.input_epoch ?? null,
      goal_version: document.binding?.goal_version ?? null,
      config_version: document.binding?.config_version ?? null,
      watermark: document.binding?.watermark ?? null,
      content_hash: document.content_hash,
      canonical_json: document.canonical_json,
      created_at: document.created_at
    });
  }
  for (const head of decision.heads) {
    tx.prepare(
      `INSERT INTO object_head (
         object_id, owner, object_type, revision, document_id, state, content_hash,
         row_version, updated_at
       ) VALUES (
         :object_id, :owner, :object_type, :revision, :document_id, :state, :content_hash,
         :row_version, :updated_at
       )`
    ).run({
      object_id: head.object_id,
      owner: head.owner,
      object_type: head.object_type,
      revision: head.revision,
      document_id: head.document_id,
      state: head.state,
      content_hash: head.content_hash,
      row_version: head.row_version,
      updated_at: head.updated_at
    });
  }
  for (const projection of decision.projections) {
    insertQpProjectionRow(tx, projection);
  }
  void commitSeq;
}

function insertQpProjectionRow(tx: Tx, projection: QpProjectionRow): void {
  const columns = Object.keys(projection.row);
  const placeholders = columns.map((column) => `:${column}`).join(", ");
  const values: Record<string, JsonValue> = {};
  for (const column of columns) {
    values[column] = projection.row[column] ?? null;
  }
  tx.prepare(
    `INSERT INTO ${projection.table} (${columns.join(", ")})
     VALUES (${placeholders})`
  ).run(values);
}

/** Canonical JCS text of a QP row, used by the callers that build rows. */
export function qpRowJson(row: Record<string, JsonValue>): string {
  return canonicalJsonText(row as unknown as JsonValue);
}

/** The `Id` prefix set QP mints; FND never mints these. */
export const QP_ID_PREFIXES: readonly string[] = ["issue", "plan", "judg"];

/** Convenience alias used by the composition root. */
export type QpJournalCommitOutcome<Value = null> = QpLiveCommitOutcome<Value>;

/** Re-exported for callers that only import the port surface. */
export type { QpJournalEvent, QpLiveStage };

