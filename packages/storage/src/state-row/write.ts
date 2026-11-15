/**
 * Write side of the FND StateRow port (DD-FND-059.1.6 and DD-FND-059.1.6.1).
 *
 * `appendStateRows` is the admission-free wrapper: it stages the request's
 * documents, heads and rows, runs the same unified validation, writes one
 * `rsi.state_row_batch/1` frame, fsyncs the journal and projects every member
 * in one SQLite transaction.
 *
 * `commitLiveGated` runs the caller's stage callback exactly once inside the
 * single writer gate and `BEGIN IMMEDIATE`. The callback must not await, must
 * not nest a stage and must not take a second connection; the stage only
 * records a plan, it never writes. After the callback returns, FND validates
 * the plan, writes the staged blobs, assembles one frame, fsyncs it and
 * projects the members atomically.
 */

import {
  canonicalHash,
  canonicalJsonText,
  newId,
  objectDocumentId,
  stateRowKey,
  type AppendStateRowsRequest,
  type AppendStateRowsResult,
  type ErrorEnvelope,
  type FrozenBlob,
  type Hash,
  type Id,
  type JsonValue,
  type LiveCommitDecision,
  type LiveCommitOutcome,
  type LiveCommitRequest,
  type LiveCommitStage,
  type LiveReadTx,
  type ObjectDocumentRow,
  type ObjectHeadRow,
  type OutboxEnqueueInput,
  type Result,
  type StageDocumentKey,
  type StateRowKeyMap,
  type StateRowSchema,
  type StateRowTypeMap,
  type StateRowWrite,
  type VersionBinding
} from "@evoplug/core";
import { err, ok, toJsonValue } from "@evoplug/core";

import { fieldDetails, storageDetails, storageError } from "../errors.js";
import type { SqlRow } from "../types.js";
import type { SqliteConnection } from "../sqlite/driver.js";
import { isErrorEnvelope, mapSqliteFailure } from "../sqlite/tx.js";
import type { Tx } from "../sqlite/tx.js";
import { BlobStore } from "../blob/store.js";
import { receiptRelativePath, type JournalWriter } from "../journal/writer.js";
import { recordFrameDurability } from "../journal/state.js";
import { insertCommitRecord } from "../journal/commit-record.js";
import {
  STATE_ROW_BATCH_SCHEMA_VERSION,
  stateRowBatchHash,
  stateRowBatchMemberHash,
  type StateRowBatchMember
} from "../journal/payload.js";
import {
  checkBatchBinding,
  findRegistration,
  isDedicatedWriterRow,
  normalizeRowForTable,
  resolveBatchScope
} from "./registry.js";
import { readRowBindingFields } from "./binding.js";
import { advanceBranchForGoalSnapshot } from "./goal-branch.js";

/** The maximum number of members one batch may carry. */
export const FND_STATE_ROW_BATCH_MAX_MEMBERS = 256;

/** The minimum number of members one batch may carry. */
export const FND_STATE_ROW_BATCH_MIN_MEMBERS = 1;

function schemaError(path: string, rule: string): ErrorEnvelope {
  return storageError({
    code: "E_STATE_ROW_SCHEMA",
    stage: "storage.state_row",
    details: fieldDetails(path, rule),
    message_key: "error.storage.state_row_schema_invalid"
  });
}

function bindingError(rule: string): ErrorEnvelope {
  return storageError({
    code: "E_STATE_ROW_BINDING",
    stage: "storage.state_row",
    details: { kind: "none" },
    message_key: "error.storage.state_row_binding_invalid"
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the value is PromiseLike; a stage callback may not return one. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

/** The binding as a canonical JSON value; `null` for a global batch. */
function bindingAsJson(binding: VersionBinding | null): JsonValue {
  if (binding === null) {
    return null;
  }
  return {
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark
  };
}

/** A plain record as a canonical JSON value. */
function recordAsJson(record: Record<string, unknown>): JsonValue {
  return record as JsonValue;
}

/** The complete physical row as a plain object, or null when it is not one. */
function rowAsSqlRow(row: unknown): SqlRow | null {
  if (!isRecord(row)) {
    return null;
  }
  const out: SqlRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) {
      return null;
    }
    out[key] = value;
  }
  return out;
}

/** The canonical JSON text of one complete physical row. */
export function rowJsonOf(row: SqlRow): string {
  return canonicalJsonText(toJsonValue(row));
}

/** `after_hash = sha256(JCS({row_schema,row_json}))` (DD-FND-059.1.2). */
export function stateRowAfterHash(rowSchema: string, rowJson: string): Hash {
  return canonicalHash({ row_schema: rowSchema, row_json: rowJson });
}

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

/** One typed row of the commit plan. */
interface PlannedRow {
  readonly row_schema: string;
  readonly operation: "insert" | "update" | "transition";
  readonly row: SqlRow;
  readonly document_id: Hash | null;
}

/** One object document of the commit plan. */
interface PlannedDocument {
  readonly row: ObjectDocumentRow;
}

/** One object head of the commit plan. */
interface PlannedHead {
  readonly row: ObjectHeadRow;
}

/** One outbox member of the commit plan. */
interface PlannedOutbox {
  readonly input: OutboxEnqueueInput;
}

/**
 * The state of the single writer gate of one connection.
 *
 * The gate is not reentrant: a nested `commitLiveGated` or an
 * `appendStateRows` inside an open stage is refused instead of opening a
 * second transaction on the same connection.
 */
const OPEN_GATES = new WeakSet<SqliteConnection>();

/** The in-memory plan of one commit; it is never an uncommitted projection. */
interface CommitPlan {
  readonly rows: PlannedRow[];
  readonly documents: PlannedDocument[];
  readonly heads: PlannedHead[];
  readonly outbox: PlannedOutbox[];
  readonly blobs: FrozenBlob[];
}

function emptyPlan(): CommitPlan {
  return { rows: [], documents: [], heads: [], outbox: [], blobs: [] };
}

/* ------------------------------------------------------------------ */
/* Live stage                                                          */
/* ------------------------------------------------------------------ */

/** Rejects any SQL that is not a read-only statement. */
function assertReadOnlySql(sql: string): void {
  const head = sql.trim().split(/\s+/, 1)[0] ?? "";
  const upper = head.toUpperCase();
  if (upper === "SELECT" || upper === "WITH") {
    return;
  }
  throw storageError({
    code: "E_STATE_ROW_SCHEMA",
    stage: "storage.state_row",
    details: fieldDetails("stage.tx.sql", "read_only_statement_required"),
    message_key: "error.storage.state_row_read_only_sql"
  });
}

class LiveReadTxImpl implements LiveReadTx {
  readonly #tx: Tx;

  constructor(tx: Tx) {
    this.#tx = tx;
  }

  get<Row extends SqlRow = SqlRow>(sql: string, params?: unknown): Row | null {
    assertReadOnlySql(sql);
    const row = this.#tx.prepare<Row>(sql).get(params as never);
    return row === undefined ? null : row;
  }

  all<Row extends SqlRow = SqlRow>(sql: string, params?: unknown): readonly Row[] {
    assertReadOnlySql(sql);
    return this.#tx.prepare<Row>(sql).all(params as never);
  }
}

/**
 * The stage handed to the caller's callback.
 *
 * `stageRows` and friends only record the complete rows; the buffer is a
 * plan, not a SQLite projection. `resolve*` reads the buffer first and falls
 * back to the same SQLite snapshot; the two branches never merge.
 */
class LiveCommitStageImpl implements LiveCommitStage {
  readonly #tx: Tx;
  readonly #plan: CommitPlan;
  #closed = false;

  constructor(tx: Tx, plan: CommitPlan) {
    this.#tx = tx;
    this.#plan = plan;
  }

  get tx(): LiveReadTx {
    this.#assertOpen();
    return new LiveReadTxImpl(this.#tx);
  }

  resolveStateRow<S extends StateRowSchema>(q: {
    row_schema: S;
    key: StateRowKeyMap[S];
  }): Result<StateRowTypeMap[S] | null, ErrorEnvelope> {
    this.#assertOpen();
    const staged = this.#plan.rows.find((candidate) =>
      rowMatchesKey(candidate.row_schema, candidate.row, q.row_schema, q.key)
    );
    if (staged !== undefined) {
      return ok(staged.row as unknown as StateRowTypeMap[S]);
    }
    const committed = readCommittedRow(this.#tx, q.row_schema, q.key);
    if (committed === null) {
      return ok(null);
    }
    return ok(committed as unknown as StateRowTypeMap[S]);
  }

  resolveDocument(q: StageDocumentKey): Result<ObjectDocumentRow | null, ErrorEnvelope> {
    this.#assertOpen();
    const documentId = objectDocumentId({
      owner: q.owner,
      object_type: q.object_type,
      object_id: q.object_id,
      revision: q.revision
    });
    const staged = this.#plan.documents.find(
      (candidate) => candidate.row.document_id === documentId
    );
    if (staged !== undefined) {
      return ok(staged.row);
    }
    const row = this.#tx
      .prepare<SqlRow>("SELECT * FROM object_document WHERE document_id = :document_id")
      .get({ document_id: documentId });
    if (row === undefined) {
      return ok(null);
    }
    return ok(row as unknown as ObjectDocumentRow);
  }

  resolveHead(q: { object_id: string }): Result<ObjectHeadRow | null, ErrorEnvelope> {
    this.#assertOpen();
    const staged = this.#plan.heads.find(
      (candidate) => candidate.row.object_id === q.object_id
    );
    if (staged !== undefined) {
      return ok(staged.row);
    }
    const row = this.#tx
      .prepare<SqlRow>("SELECT * FROM object_head WHERE object_id = :object_id")
      .get({ object_id: q.object_id });
    if (row === undefined) {
      return ok(null);
    }
    return ok(row as unknown as ObjectHeadRow);
  }

  stageRows(rows: readonly StateRowWrite[]): Result<void, ErrorEnvelope> {
    this.#assertOpen();
    for (const write of rows) {
      const row = rowAsSqlRow(write.row);
      if (row === null) {
        return err(schemaError(`stageRows.${write.row_schema}`, "row_is_not_an_object"));
      }
      if (findRegistration(write.row_schema) === null) {
        return err(schemaError(`stageRows.${write.row_schema}`, "unregistered_row_schema"));
      }
      this.#plan.rows.push({
        row_schema: write.row_schema,
        operation: write.operation,
        row: normalizeRowForTable(write.row_schema, row),
        document_id: write.document_id
      });
    }
    return ok(undefined);
  }

  stageDocuments(rows: readonly ObjectDocumentRow[]): Result<void, ErrorEnvelope> {
    this.#assertOpen();
    for (const row of rows) {
      this.#plan.documents.push({ row });
    }
    return ok(undefined);
  }

  stageHeads(rows: readonly ObjectHeadRow[]): Result<void, ErrorEnvelope> {
    this.#assertOpen();
    for (const row of rows) {
      this.#plan.heads.push({ row });
    }
    return ok(undefined);
  }

  stageOutbox(input: OutboxEnqueueInput): Result<void, ErrorEnvelope> {
    this.#assertOpen();
    this.#plan.outbox.push({ input });
    return ok(undefined);
  }

  stageBlob(blob: FrozenBlob): Result<void, ErrorEnvelope> {
    this.#assertOpen();
    this.#plan.blobs.push(blob);
    return ok(undefined);
  }

  /** Invalidates the stage, its read results and the tx handle. */
  close(): void {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw storageError({
        code: "E_STATE_ROW_SCHEMA",
        stage: "storage.state_row",
        details: fieldDetails("stage", "expired"),
        message_key: "error.storage.state_row_stage_expired"
      });
    }
  }
}

/** True when the row carries exactly the registered primary key values. */
function rowMatchesKey(
  rowSchema: string,
  row: SqlRow,
  keySchema: string,
  key: StateRowKeyMap[StateRowSchema]
): boolean {
  if (rowSchema !== keySchema) {
    return false;
  }
  const registration = findRegistration(rowSchema);
  if (registration === null) {
    return false;
  }
  for (const column of registration.primary_key) {
    const expected = (key as Record<string, unknown>)[column];
    if (expected === undefined || row[column] !== expected) {
      return false;
    }
  }
  return true;
}

/** Reads one committed row by its exact primary key. */
function readCommittedRow(
  source: { prepare<Row extends SqlRow>(sql: string): { get(params?: unknown): Row | undefined } },
  rowSchema: string,
  key: StateRowKeyMap[StateRowSchema]
): SqlRow | null {
  const registration = findRegistration(rowSchema);
  if (registration === null) {
    return null;
  }
  const params: Record<string, unknown> = {};
  const parts: string[] = [];
  for (const column of registration.primary_key) {
    const value = (key as Record<string, unknown>)[column];
    if (value === undefined || value === null) {
      return null;
    }
    params[column] = value;
    parts.push(`${column} = :${column}`);
  }
  const row = source
    .prepare<SqlRow>(`SELECT * FROM ${registration.table} WHERE ${parts.join(" AND ")}`)
    .get(params);
  return row === undefined ? null : row;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/** The six binding fields a `row`-scoped row carries. */
function rowOwnBinding(row: SqlRow): VersionBinding | null {
  return readRowBindingFields(row);
}

/**
 * The effective binding of one planned row.
 *
 * `row`-scoped rows carry their own six fields, `batch`-scoped rows inherit
 * the request binding and `none`-scoped rows have none.
 */
function effectiveBinding(
  bindingSource: "row" | "batch" | "none",
  row: SqlRow,
  requestBinding: VersionBinding | null
): VersionBinding | null {
  if (bindingSource === "none") {
    return null;
  }
  if (bindingSource === "batch") {
    return requestBinding;
  }
  return rowOwnBinding(row);
}

/**
 * Validates the commit plan before the first journal byte is written.
 *
 * The checks are the ones the design states for the unified validation:
 * registration and operation, binding scope, PK/UNIQUE, the two dedicated
 * writer rows, document/head references and the member count.
 */
function validatePlan(
  plan: CommitPlan,
  requestBinding: VersionBinding | null
): { ok: true } | { ok: false; error: ErrorEnvelope } {
  const memberCount =
    plan.rows.length + plan.documents.length + plan.heads.length + plan.outbox.length;
  if (memberCount < FND_STATE_ROW_BATCH_MIN_MEMBERS) {
    return { ok: false, error: schemaError("members", "empty_batch") };
  }
  if (memberCount > FND_STATE_ROW_BATCH_MAX_MEMBERS) {
    return { ok: false, error: schemaError("members", "max_256") };
  }
  for (const planned of plan.rows) {
    const registration = findRegistration(planned.row_schema);
    if (registration === null) {
      return {
        ok: false,
        error: schemaError(`rows.${planned.row_schema}`, "unregistered_row_schema")
      };
    }
    if (isDedicatedWriterRow(planned.row_schema)) {
      return {
        ok: false,
        error: schemaError(`rows.${planned.row_schema}`, "dedicated_writer_only")
      };
    }
  }
  const scope = resolveBatchScope(
    plan.rows.map((row) => {
      const registration = findRegistration(row.row_schema);
      return {
        row_schema: row.row_schema,
        binding_source: registration?.binding_source ?? "none"
      };
    })
  );
  if (!scope.ok) {
    return { ok: false, error: scope.error };
  }
  const bindingCheck = checkBatchBinding(scope.scope, requestBinding);
  if (!bindingCheck.ok) {
    return { ok: false, error: bindingCheck.error };
  }
  const seenKeys = new Set<string>();
  for (const planned of plan.rows) {
    const registration = findRegistration(planned.row_schema);
    if (registration === null) {
      return { ok: false, error: schemaError(`rows.${planned.row_schema}`, "unregistered_row_schema") };
    }
    if (!registration.allowed_operations.includes(planned.operation)) {
      return { ok: false, error: schemaError(`rows.${planned.row_schema}`, "operation_not_allowed") };
    }
    const binding = effectiveBinding(registration.binding_source, planned.row, requestBinding);
    if (registration.binding_source === "row" && binding === null) {
      return { ok: false, error: bindingError("row_scoped_row_requires_six_binding_fields") };
    }
    const objectKey = objectKeyOf(planned.row_schema, planned.row);
    if (objectKey === null) {
      return { ok: false, error: schemaError(`rows.${planned.row_schema}`, "primary_key_incomplete") };
    }
    if (seenKeys.has(objectKey)) {
      return { ok: false, error: schemaError(`rows.${planned.row_schema}`, "duplicate_object_key") };
    }
    seenKeys.add(objectKey);
    if (registration.binding_source !== "none" && requestBinding !== null) {
      if (binding === null || !equalBindings(binding, requestBinding)) {
        return { ok: false, error: bindingError("bound_row_must_share_the_batch_binding") };
      }
    }
  }
  const documentIds = new Set<string>();
  for (const planned of plan.documents) {
    if (documentIds.has(planned.row.document_id)) {
      return { ok: false, error: schemaError("documents", "duplicate_document_id") };
    }
    documentIds.add(planned.row.document_id);
  }
  const objectIds = new Set<string>();
  for (const planned of plan.heads) {
    if (objectIds.has(planned.row.object_id)) {
      return { ok: false, error: schemaError("heads", "duplicate_object_id") };
    }
    objectIds.add(planned.row.object_id);
    if (!documentIds.has(planned.row.document_id)) {
      return { ok: false, error: schemaError("heads", "document_not_in_batch") };
    }
  }
  const effectKeys = new Set<string>();
  for (const planned of plan.outbox) {
    if (effectKeys.has(planned.input.effect_key)) {
      return { ok: false, error: schemaError("outbox", "duplicate_effect_key") };
    }
    effectKeys.add(planned.input.effect_key);
  }
  return { ok: true };
}

/**
 * Reads the projection before a frame is written and rejects plans that can
 * never project: an `insert` over an existing primary key is a duplicate, and
 * an `update`/`transition` without the before-image is a missing CAS target.
 *
 * The check runs under the same single-writer discipline as the commit and the
 * transactional projection re-checks its affected row count, so a hidden
 * replace can never mask a missing preimage.
 */
function preflightProjection(
  connection: SqliteConnection,
  plan: CommitPlan
): { ok: true } | { ok: false; error: ErrorEnvelope } {
  for (const planned of plan.rows) {
    const registration = findRegistration(planned.row_schema);
    if (registration === null) {
      return {
        ok: false,
        error: schemaError(`rows.${planned.row_schema}`, "unregistered_row_schema")
      };
    }
    const key = primaryKeyPredicate(registration.primary_key, planned.row);
    if (key === null) {
      return {
        ok: false,
        error: schemaError(`rows.${planned.row_schema}`, "primary_key_incomplete")
      };
    }
    const existing = connection
      .prepare<SqlRow>(`SELECT * FROM ${registration.table} WHERE ${key.where}`)
      .get(key.params);
    if (planned.operation === "insert") {
      if (existing !== undefined) {
        return {
          ok: false,
          error: storageError({
            code: "E_IDEMPOTENCY_CONFLICT",
            stage: "storage.state_row",
            details: fieldDetails(`rows.${planned.row_schema}`, "insert_over_existing"),
            message_key: "error.storage.state_row_idempotency_conflict"
          })
        };
      }
      continue;
    }
    if (existing === undefined) {
      return {
        ok: false,
        error: storageError({
          code: "E_STATE_ROW_BINDING",
          stage: "storage.state_row",
          details: fieldDetails(`rows.${planned.row_schema}`, "update_target_missing"),
          message_key: "error.storage.state_row_binding_invalid"
        })
      };
    }
    const versionColumn =
      planned.row["row_version"] !== undefined
        ? "row_version"
        : planned.row["version"] !== undefined
          ? "version"
          : null;
    if (versionColumn !== null) {
      const before = existing[versionColumn];
      const after = planned.row[versionColumn];
      if (typeof before === "number" && typeof after === "number" && after < before) {
        return {
          ok: false,
          error: storageError({
            code: "E_STATE_ROW_BINDING",
            stage: "storage.state_row",
            details: fieldDetails(
              `rows.${planned.row_schema}`,
              "row_version_regressed"
            ),
            message_key: "error.storage.state_row_binding_invalid"
          })
        };
      }
    }
  }
  return { ok: true };
}

function equalBindings(left: VersionBinding, right: VersionBinding): boolean {  return (
    left.task_id === right.task_id &&
    left.branch_id === right.branch_id &&
    left.input_epoch === right.input_epoch &&
    left.goal_version === right.goal_version &&
    left.config_version === right.config_version &&
    left.watermark === right.watermark
  );
}

/** The `object_key` of a planned row, per the registry primary key. */
function objectKeyOf(rowSchema: string, row: SqlRow): string | null {
  try {
    return stateRowKey(rowSchema as StateRowSchema, row as never);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Frame assembly                                                      */
/* ------------------------------------------------------------------ */

/** One member of the frame, with the metadata the projection needs. */
interface FrameMember {
  readonly member: StateRowBatchMember;
  readonly kind: "row" | "document" | "head" | "outbox";
  readonly row_schema: string;
  readonly operation: "insert" | "update" | "transition";
  readonly row_json: string;
  readonly after_hash: Hash;
  readonly before_hash: Hash | null;
  readonly entity_id: string;
  readonly object_key: string | null;
  /** The `effect_key` of an outbox member; the outbox order key. */
  readonly effect_key: string | null;
  readonly table: string | null;
  readonly row: SqlRow | null;
  readonly binding: VersionBinding | null;
  readonly document_id: Hash | null;
  readonly event_id: Id<"ev">;
}

/** The `state_row.recorded` event of one typed row. */
function buildRowEvent(input: {
  readonly row_schema: string;
  readonly operation: "insert" | "update" | "transition";
  readonly row_json: string;
  readonly object_key: string;
  readonly binding: VersionBinding | null;
  readonly document_id: Hash | null;
  readonly before_hash: Hash | null;
  readonly after_hash: Hash;
  readonly event_id: Id<"ev">;
  readonly recorded_at: number;
}): Record<string, JsonValue> {
  const eventKey = canonicalHash({
    event_type: "state_row.recorded",
    entity_type: "state_row",
    entity_id: input.object_key,
    operation: input.operation,
    before_hash: input.before_hash,
    after_hash: input.after_hash,
    binding: bindingAsJson(input.binding),
    document_id: input.document_id
  });
  return {
    schema_version: "rsi.ledger_event/1",
    event_id: input.event_id,
    event_key: eventKey,
    event_type: "state_row.recorded",
    entity_type: "state_row",
    entity_id: input.object_key,
    operation: input.operation,
    binding: bindingAsJson(input.binding),
    before_hash: input.before_hash,
    after_hash: input.after_hash,
    row_schema: input.row_schema,
    row_json: input.row_json,
    document_id: input.document_id,
    payload_hash: input.after_hash,
    recorded_at: input.recorded_at
  };
}

/** The `object_document.recorded` event of one document. */
function buildDocumentEvent(input: {
  readonly row: ObjectDocumentRow;
  readonly after_hash: Hash;
  readonly binding: VersionBinding | null;
  readonly event_id: Id<"ev">;
  readonly recorded_at: number;
}): Record<string, JsonValue> {
  const eventKey = canonicalHash({
    event_type: "object_document.recorded",
    entity_type: "object_document",
    entity_id: input.row.document_id,
    operation: "insert",
    before_hash: null,
    after_hash: input.after_hash,
    binding: bindingAsJson(input.binding),
    document_id: input.row.document_id
  });
  return {
    schema_version: "rsi.ledger_event/1",
    event_id: input.event_id,
    event_key: eventKey,
    event_type: "object_document.recorded",
    entity_type: "object_document",
    entity_id: input.row.document_id,
    operation: "insert",
    binding: bindingAsJson(input.binding),
    before_hash: null,
    after_hash: input.after_hash,
    row_schema: "rsi.object_document_row/1",
    row_json: canonicalJsonText(toJsonValue(input.row)),
    document_id: input.row.document_id,
    payload_hash: input.after_hash,
    recorded_at: input.recorded_at
  };
}

/** The `object_head.transition` event of one head. */
function buildHeadEvent(input: {
  readonly row: ObjectHeadRow;
  readonly after_hash: Hash;
  readonly before_hash: Hash | null;
  readonly binding: VersionBinding | null;
  readonly event_id: Id<"ev">;
  readonly recorded_at: number;
}): Record<string, JsonValue> {
  const eventKey = canonicalHash({
    event_type: "object_head.transition",
    entity_type: "object_head",
    entity_id: input.row.object_id,
    operation: input.before_hash === null ? "insert" : "transition",
    before_hash: input.before_hash,
    after_hash: input.after_hash,
    binding: bindingAsJson(input.binding),
    document_id: input.row.document_id
  });
  return {
    schema_version: "rsi.ledger_event/1",
    event_id: input.event_id,
    event_key: eventKey,
    event_type: "object_head.transition",
    entity_type: "object_head",
    entity_id: input.row.object_id,
    operation: input.before_hash === null ? "insert" : "transition",
    binding: bindingAsJson(input.binding),
    before_hash: input.before_hash,
    after_hash: input.after_hash,
    row_schema: "rsi.object_head_row/1",
    row_json: canonicalJsonText(toJsonValue(input.row)),
    document_id: input.row.document_id,
    payload_hash: input.after_hash,
    recorded_at: input.recorded_at
  };
}

/** The `outbox.enqueued` event of one outbox member. */
function buildOutboxEvent(input: {
  readonly outbox_id: Id<"ob">;
  readonly effect_key: string;
  readonly row_json: string;
  readonly after_hash: Hash;
  readonly binding: VersionBinding | null;
  readonly event_id: Id<"ev">;
  readonly recorded_at: number;
}): Record<string, JsonValue> {
  const eventKey = canonicalHash({
    event_type: "outbox.enqueued",
    entity_type: "outbox",
    entity_id: input.outbox_id,
    operation: "insert",
    before_hash: null,
    after_hash: input.after_hash,
    binding: bindingAsJson(input.binding),
    document_id: null
  });
  return {
    schema_version: "rsi.ledger_event/1",
    event_id: input.event_id,
    event_key: eventKey,
    event_type: "outbox.enqueued",
    entity_type: "outbox",
    entity_id: input.outbox_id,
    operation: "insert",
    binding: bindingAsJson(input.binding),
    before_hash: null,
    after_hash: input.after_hash,
    row_schema: "rsi.outbox/1",
    row_json: input.row_json,
    document_id: null,
    payload_hash: input.after_hash,
    recorded_at: input.recorded_at
  };
}

/**
 * Assembles the frame members of one plan.
 *
 * The default member order is `object_document` (by `document_id`) →
 * `object_head` (by `object_id`) → typed rows (by `row_schema` then
 * `object_key`) → outbox (by `effect_key`).
 */
function assembleMembers(
  plan: CommitPlan,
  requestBinding: VersionBinding | null,
  now: number
): FrameMember[] {
  const members: FrameMember[] = [];
  for (const planned of plan.documents) {
    const rowJson = canonicalJsonText(toJsonValue(planned.row));
    const afterHash = stateRowAfterHash("rsi.object_document_row/1", rowJson);
    const eventId = newId("ev", now);
    const event = buildDocumentEvent({
      row: planned.row,
      after_hash: afterHash,
      binding: requestBinding,
      event_id: eventId,
      recorded_at: now
    });
    members.push({
      member: { event, event_hash: canonicalHash(recordAsJson(event)), blob_hashes: [] },
      kind: "document",
      row_schema: "rsi.object_document_row/1",
      operation: "insert",
      row_json: rowJson,
      after_hash: afterHash,
      before_hash: null,
      entity_id: planned.row.document_id,
      object_key: null,
      effect_key: null,
      table: "object_document",
      row: null,
      binding: requestBinding,
      document_id: planned.row.document_id as Hash,
      event_id: eventId
    });
  }
  for (const planned of plan.heads) {
    const rowJson = canonicalJsonText(toJsonValue(planned.row));
    const afterHash = stateRowAfterHash("rsi.object_head_row/1", rowJson);
    const eventId = newId("ev", now);
    const event = buildHeadEvent({
      row: planned.row,
      after_hash: afterHash,
      before_hash: null,
      binding: requestBinding,
      event_id: eventId,
      recorded_at: now
    });
    members.push({
      member: { event, event_hash: canonicalHash(recordAsJson(event)), blob_hashes: [] },
      kind: "head",
      row_schema: "rsi.object_head_row/1",
      operation: "insert",
      row_json: rowJson,
      after_hash: afterHash,
      before_hash: null,
      entity_id: planned.row.object_id,
      object_key: null,
      effect_key: null,
      table: "object_head",
      row: null,
      binding: requestBinding,
      document_id: planned.row.document_id as Hash,
      event_id: eventId
    });
  }
  for (const planned of plan.rows) {
    const registration = findRegistration(planned.row_schema);
    const rowJson = rowJsonOf(planned.row);
    const afterHash = stateRowAfterHash(planned.row_schema, rowJson);
    const objectKey = objectKeyOf(planned.row_schema, planned.row);
    if (objectKey === null) {
      throw storageError({
        code: "E_STATE_ROW_SCHEMA",
        stage: "storage.state_row",
        details: fieldDetails(`rows.${planned.row_schema}`, "primary_key_incomplete"),
        message_key: "error.storage.state_row_schema_invalid"
      });
    }
    const binding = effectiveBinding(
      registration?.binding_source ?? "none",
      planned.row,
      requestBinding
    );
    const eventId = newId("ev", now);
    const event = buildRowEvent({
      row_schema: planned.row_schema,
      operation: planned.operation,
      row_json: rowJson,
      object_key: objectKey,
      binding,
      document_id: planned.document_id,
      before_hash: null,
      after_hash: afterHash,
      event_id: eventId,
      recorded_at: now
    });
    members.push({
      member: { event, event_hash: canonicalHash(recordAsJson(event)), blob_hashes: [] },
      kind: "row",
      row_schema: planned.row_schema,
      operation: planned.operation,
      row_json: rowJson,
      after_hash: afterHash,
      before_hash: null,
      entity_id: objectKey,
      object_key: objectKey,
      effect_key: null,
      table: registration?.table ?? null,
      row: planned.row,
      binding,
      document_id: planned.document_id,
      event_id: eventId
    });
  }
  for (const planned of plan.outbox) {
    const outboxId = newId("ob", now);
    const payloadJson = canonicalJsonText(toJsonValue(planned.input.payload));
    const rowJson = canonicalJsonText(
      toJsonValue({
        outbox_id: outboxId,
        effect_kind: planned.input.effect_kind,
        effect_key: planned.input.effect_key,
        payload_json: payloadJson,
        state: "pending",
        priority: planned.input.priority,
        attempts: 0,
        max_attempts: planned.input.max_attempts,
        next_attempt_at: now,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        reconcile_required: 0,
        last_error_code: null,
        result_ref: null,
        created_at: now,
        updated_at: now
      })
    );
    const afterHash = stateRowAfterHash("rsi.outbox/1", rowJson);
    const eventId = newId("ev", now);
    const event = buildOutboxEvent({
      outbox_id: outboxId,
      effect_key: planned.input.effect_key,
      row_json: rowJson,
      after_hash: afterHash,
      binding: requestBinding,
      event_id: eventId,
      recorded_at: now
    });
    members.push({
      member: { event, event_hash: canonicalHash(recordAsJson(event)), blob_hashes: [] },
      kind: "outbox",
      row_schema: "rsi.outbox/1",
      operation: "insert",
      row_json: rowJson,
      after_hash: afterHash,
      before_hash: null,
      entity_id: outboxId,
      object_key: null,
      effect_key: planned.input.effect_key,
      table: "outbox",
      row: null,
      binding: requestBinding,
      document_id: null,
      event_id: eventId
    });
  }
  return members;
}

/* ------------------------------------------------------------------ */
/* Projection                                                          */
/* ------------------------------------------------------------------ */

/** Inserts one typed row into its registered table. */
function insertTypedRow(tx: Tx, table: string, row: SqlRow): void {
  const columns = Object.keys(row);
  const placeholders = columns.map((column) => `:${column}`).join(", ");
  tx.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`
  ).run(row);
}

/** The registered primary-key predicate of one physical row. */
function primaryKeyPredicate(
  primaryKey: readonly string[],
  row: SqlRow
): { readonly where: string; readonly params: Record<string, unknown> } | null {
  const params: Record<string, unknown> = {};
  const parts: string[] = [];
  for (const column of primaryKey) {
    const value = row[column];
    if (value === undefined || value === null) {
      return null;
    }
    params[column] = value;
    parts.push(`${column} = :${column}`);
  }
  return { where: parts.join(" AND "), params };
}

/**
 * Applies the after-image of an `update`/`transition` member.
 *
 * The row being replaced must already exist: a missing before-image is a
 * conflict, never an insert. The UPDATE is keyed by the registered primary key
 * and must affect exactly one row; recovery (`projectStateRowEvent`) applies
 * the same frozen after-image with `replaceRow`, so a successfully committed
 * transition rebuilds to the same row.
 */
function updateTypedRow(
  tx: Tx,
  table: string,
  primaryKey: readonly string[],
  row: SqlRow,
  rowSchema: string
): void {
  const key = primaryKeyPredicate(primaryKey, row);
  if (key === null) {
    throw schemaError(`rows.${rowSchema}`, "primary_key_incomplete");
  }
  const assignments = Object.keys(row).filter(
    (column) => !primaryKey.includes(column)
  );
  if (assignments.length === 0) {
    throw schemaError(`rows.${rowSchema}`, "update_has_no_after_image_columns");
  }
  const current = tx
    .prepare<SqlRow>(`SELECT * FROM ${table} WHERE ${key.where}`)
    .get(key.params);
  if (current === undefined) {
    throw storageError({
      code: "E_STATE_ROW_BINDING",
      stage: "storage.state_row",
      details: fieldDetails(`rows.${rowSchema}`, "update_target_missing"),
      message_key: "error.storage.state_row_binding_invalid"
    });
  }
  const versionColumn = row["row_version"] !== undefined
    ? "row_version"
    : row["version"] !== undefined
      ? "version"
      : null;
  if (versionColumn !== null) {
    const before = current[versionColumn];
    const after = row[versionColumn];
    if (
      typeof before === "number" &&
      typeof after === "number" &&
      after < before
    ) {
      throw storageError({
        code: "E_STATE_ROW_BINDING",
        stage: "storage.state_row",
        details: fieldDetails(`rows.${rowSchema}`, "row_version_regressed"),
        message_key: "error.storage.state_row_binding_invalid"
      });
    }
  }
  const result = tx
    .prepare(
      `UPDATE ${table} SET ${assignments
        .map((column) => `${column} = :${column}`)
        .join(", ")} WHERE ${key.where}`
    )
    .run(row);
  if (result.changes !== 1) {
    throw storageError({
      code: "E_STATE_ROW_BINDING",
      stage: "storage.state_row",
      details: fieldDetails(
        `rows.${rowSchema}`,
        result.changes === 0 ? "update_target_missing" : "update_affected_multiple_rows"
      ),
      message_key: "error.storage.state_row_binding_invalid"
    });
  }
}

/**
 * A typed-row insert must land on a free primary key. A repeated key is
 * rejected before the INSERT so the caller gets a stable conflict instead of
 * the raw SQLite uniqueness error, and so a duplicate never silently replaces
 * an existing row.
 */
function assertInsertable(
  tx: Tx,
  table: string,
  primaryKey: readonly string[],
  row: SqlRow,
  rowSchema: string
): void {
  const key = primaryKeyPredicate(primaryKey, row);
  if (key === null) {
    throw schemaError(`rows.${rowSchema}`, "primary_key_incomplete");
  }
  const existing = tx
    .prepare<SqlRow>(`SELECT 1 AS present FROM ${table} WHERE ${key.where}`)
    .get(key.params);
  if (existing !== undefined) {
    throw storageError({
      code: "E_IDEMPOTENCY_CONFLICT",
      stage: "storage.state_row",
      details: fieldDetails(`rows.${rowSchema}`, "insert_over_existing"),
      message_key: "error.storage.state_row_idempotency_conflict"
    });
  }
}

/** Inserts one object document row. */
function insertDocument(tx: Tx, row: SqlRow): void {
  insertTypedRow(tx, "object_document", row);
}

/** Inserts one object head row. */
function insertHead(tx: Tx, row: SqlRow): void {
  insertTypedRow(tx, "object_head", row);
}

/** Inserts one outbox row. */
function insertOutbox(tx: Tx, row: SqlRow): void {
  insertTypedRow(tx, "outbox", row);
}

/** Writes the `ledger_event_log` projection of one frame member. */
function insertLedgerEvent(
  tx: Tx,
  input: {
    readonly member: FrameMember;
    readonly commit_seq: number;
    readonly journal_id: string;
    readonly recorded_at: number;
  }
): void {
  const event = input.member.member.event as Record<string, unknown>;
  const binding = input.member.binding;
  const bound = binding !== null;
  tx.prepare(
    `INSERT INTO ledger_event_log (
       event_id, event_key, commit_seq, journal_id, event_type, entity_type, entity_id,
       operation, binding_mode, task_id, branch_id, input_epoch, goal_version,
       config_version, watermark, before_hash, after_hash, row_schema, row_json,
       document_id, payload_hash, recorded_at
     ) VALUES (
       :event_id, :event_key, :commit_seq, :journal_id, :event_type, :entity_type, :entity_id,
       :operation, :binding_mode, :task_id, :branch_id, :input_epoch, :goal_version,
       :config_version, :watermark, :before_hash, :after_hash, :row_schema, :row_json,
       :document_id, :payload_hash, :recorded_at
     )`
  ).run({
    event_id: String(event["event_id"]),
    event_key: String(event["event_key"]),
    commit_seq: input.commit_seq,
    journal_id: input.journal_id,
    event_type: String(event["event_type"]),
    entity_type: String(event["entity_type"]),
    entity_id: input.member.entity_id,
    operation: input.member.operation,
    binding_mode: bound ? "bound" : "global",
    task_id: bound ? binding.task_id : null,
    branch_id: bound ? binding.branch_id : null,
    input_epoch: bound ? binding.input_epoch : null,
    goal_version: bound ? binding.goal_version : null,
    config_version: bound ? binding.config_version : null,
    watermark: bound ? binding.watermark : null,
    before_hash: input.member.before_hash,
    after_hash: input.member.after_hash,
    row_schema: input.member.row_schema,
    row_json: input.member.row_json,
    document_id:
      input.member.kind === "row" ? input.member.document_id : null,
    payload_hash: input.member.after_hash,
    recorded_at: input.recorded_at
  });
}

/* ------------------------------------------------------------------ */
/* Writer                                                              */
/* ------------------------------------------------------------------ */

export interface StateRowWriterOptions {
  readonly connection: SqliteConnection;
  /** The single journal writer; the caller owns the writer gate. */
  readonly writer: JournalWriter;
  /** Path recorded in `journal_state.relative_path`, relative to the evoplug home. */
  readonly relative_path: string;
  /** Content-addressed blob store; staged blobs are written before the frame. */
  readonly blob_store: BlobStore;
  readonly now?: () => number;
}

/** The receipt of one committed batch. */
export interface BatchReceipt extends AppendStateRowsResult {}

function failure(
  commit_state: "not_written" | "unknown_recovery_required",
  error: ErrorEnvelope
): { ok: false; commit_state: "not_written" | "unknown_recovery_required"; error: ErrorEnvelope } {
  return { ok: false, commit_state, error };
}

/**
 * Re-syncs the writer against `journal_state` before an append.
 *
 * The state row is the era-wide authority: its `last_commit_seq` keeps the
 * sequence disjoint from other writers, and its `relative_path` moves this
 * writer onto the segment after another writer rotated the era. A state path
 * the writer refuses leaves it recovery-required, and the append then fails
 * closed instead of writing to a stale segment.
 */
function resyncWriterFromState(options: StateRowWriterOptions): void {
  if (typeof options.writer.resyncFromDisk !== "function") {
    return;
  }
  const row = options.connection
    .prepare<{
      last_commit_seq: number;
      trusted_prefix_end: number;
      relative_path: string;
    }>(
      "SELECT last_commit_seq, trusted_prefix_end, relative_path FROM journal_state WHERE journal_id = :journal_id"
    )
    .get({ journal_id: options.writer.journalId });
  if (row === undefined) {
    // A non-empty file without a state row is an orphaned projection; prefix
    // zero makes the writer refuse it instead of reusing its sequence.
    options.writer.resyncFromDisk(options.writer.lastCommitSeq);
    return;
  }
  options.writer.resyncFromDisk(
    Number(row.last_commit_seq),
    row.relative_path,
    Number(row.trusted_prefix_end)
  );
}

/**
 * Fences the era after a durable frame whose projection did not commit.
 * Without it a second writer on the same era would keep allocating from the
 * stale counter and reuse the frame's `commit_seq`.
 */
function fenceWriter(options: StateRowWriterOptions): void {
  options.writer.markRecoveryRequired();
}

/**
 * Commits one plan: validate, write the staged blobs, assemble one frame,
 * fsync the journal and project every member in one transaction.
 */
function commitPlan(
  options: StateRowWriterOptions,
  plan: CommitPlan,
  requestBinding: VersionBinding | null,
  now: number
): { ok: true; receipt: BatchReceipt } | { ok: false; error: ErrorEnvelope; commit_state: "not_written" | "unknown_recovery_required" } {
  const validation = validatePlan(plan, requestBinding);
  if (!validation.ok) {
    return { ok: false, error: validation.error, commit_state: "not_written" };
  }
  const preflight = preflightProjection(options.connection, plan);
  if (!preflight.ok) {
    return { ok: false, error: preflight.error, commit_state: "not_written" };
  }
  // Staged blobs are written and fsynced before the frame.
  for (const blob of plan.blobs) {
    const stored = options.blob_store.putSync(blob.bytes);
    if (!stored.ok) {
      return { ok: false, error: stored.error, commit_state: "not_written" };
    }
    if (stored.value.hash !== blob.hash) {
      return {
        ok: false,
        error: storageError({
          code: "E_SOURCE_HASH",
          stage: "storage.state_row",
          details: {
            kind: "source_conflict",
            source_ref: `blob://${blob.hash}#bytes=0-${blob.bytes.byteLength}`,
            expected: blob.hash,
            actual: stored.value.hash
          }
        }),
        commit_state: "not_written"
      };
    }
  }
  let members: FrameMember[];
  try {
    members = assembleMembers(plan, requestBinding, now);
  } catch (error) {
    if (isErrorEnvelope(error)) {
      return { ok: false, error, commit_state: "not_written" };
    }
    return {
      ok: false,
      error: mapSqliteFailure(error, "storage.state_row", "assemble_members"),
      commit_state: "not_written"
    };
  }
  const sortedMembers = sortMembers(members);
  const batchHash = stateRowBatchHash(
    sortedMembers.map((member) => stateRowBatchMemberHash(member.member))
  );
  resyncWriterFromState(options);
  const append = options.writer.append({
    schema_version: STATE_ROW_BATCH_SCHEMA_VERSION,
    member_count: sortedMembers.length,
    batch_hash: batchHash,
    members: sortedMembers.map((member) => member.member)
  });
  if (!append.ok) {
    return {
      ok: false,
      error: append.error,
      commit_state: options.writer.needsRecovery ? "unknown_recovery_required" : "not_written"
    };
  }
  const receipt = append.value;
  const relativePath = receiptRelativePath(options.relative_path, receipt.file_path);
  if (relativePath === null) {
    fenceWriter(options);
    return {
      ok: false,
      error: storageError({
        code: "E_STORAGE_CORRUPT",
        stage: "storage.state_row",
        details: storageDetails("receipt.file_path", "not_a_journal_segment"),
        side_effect: "unknown"
      }),
      commit_state: "unknown_recovery_required"
    };
  }
  try {
    options.connection.exec("BEGIN IMMEDIATE");
  } catch (error) {
    fenceWriter(options);
    return {
      ok: false,
      error: mapSqliteFailure(error, "storage.state_row", "begin_immediate"),
      commit_state: "unknown_recovery_required"
    };
  }
  try {
    // A frame is one logical commit whose projection order is fixed by
    // `sortMembers`, not by FK dependency order. Defer immediate FK checks to
    // COMMIT so a member may reference a parent that sorts after it, exactly
    // like the DDL's declared deferred FKs. Anything still missing at COMMIT
    // aborts the whole frame with the same constraint error.
    options.connection.exec("PRAGMA defer_foreign_keys = ON");
    recordFrameDurability(options.connection, {
      journal_id: receipt.journal_id,
      relative_path: relativePath,
      first_commit_seq: receipt.first_commit_seq,
      member_count: receipt.member_count,
      trusted_prefix_end: receipt.file_offset + receipt.frame_bytes,
      updated_at: now
    });
    sortedMembers.forEach((member, ordinal) => {
      const commitSeq = receipt.first_commit_seq + ordinal;
      insertCommitRecord(options.connection, {
        journal_id: receipt.journal_id,
        commit_seq: commitSeq,
        event_id: member.event_id,
        payload_hash: member.after_hash,
        blob_hashes_json: canonicalJsonText([]),
        batch_hash: batchHash,
        batch_first_commit_seq: receipt.first_commit_seq,
        batch_ordinal: ordinal,
        committed_at: now,
        indexed_at: null
      });
      insertLedgerEvent(options.connection, {
        member,
        commit_seq: commitSeq,
        journal_id: receipt.journal_id,
        recorded_at: now
      });
      projectMember(options.connection, member);
    });
    options.connection.exec("COMMIT");
  } catch (error) {
    try {
      options.connection.exec("ROLLBACK");
    } catch {
      // The connection is already unusable; the frame stays durable.
    }
    fenceWriter(options);
    return {
      ok: false,
      error: isErrorEnvelope(error)
        ? error
        : mapSqliteFailure(error, "storage.state_row", "project_frame"),
      commit_state: "unknown_recovery_required"
    };
  }
  return {
    ok: true,
    receipt: {
      batch_hash: batchHash,
      first_commit_seq: receipt.first_commit_seq,
      last_commit_seq: receipt.last_commit_seq,
      event_ids: sortedMembers.map((member) => member.event_id)
    }
  };
}

/** Sorts the frame members into the canonical batch order. */
function sortMembers(members: readonly FrameMember[]): FrameMember[] {
  const rank = (member: FrameMember): number => {
    switch (member.kind) {
      case "document":
        return 0;
      case "head":
        return 1;
      case "row":
        return 2;
      default:
        return 3;
    }
  };
  return [...members].sort((left, right) => {
    const rankDelta = rank(left) - rank(right);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    if (left.kind === "document" && right.kind === "document") {
      return left.entity_id < right.entity_id ? -1 : left.entity_id > right.entity_id ? 1 : 0;
    }
    if (left.kind === "head" && right.kind === "head") {
      return left.entity_id < right.entity_id ? -1 : left.entity_id > right.entity_id ? 1 : 0;
    }
    if (left.kind === "row" && right.kind === "row") {
      if (left.row_schema !== right.row_schema) {
        return left.row_schema < right.row_schema ? -1 : 1;
      }
      return left.entity_id < right.entity_id ? -1 : left.entity_id > right.entity_id ? 1 : 0;
    }
    if (left.kind === "outbox" && right.kind === "outbox") {
      const leftKey = left.effect_key ?? "";
      const rightKey = right.effect_key ?? "";
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }
    return 0;
  });
}

/** Projects one frame member into its table. */
function projectMember(tx: Tx, member: FrameMember): void {
  if (member.kind === "document") {
    insertDocument(tx, JSON.parse(member.row_json) as SqlRow);
    return;
  }
  if (member.kind === "head") {
    insertHead(tx, JSON.parse(member.row_json) as SqlRow);
    return;
  }
  if (member.kind === "outbox") {
    insertOutbox(tx, JSON.parse(member.row_json) as SqlRow);
    return;
  }
  if (member.table === null || member.row === null) {
    throw storageError({
      code: "E_STATE_ROW_SCHEMA",
      stage: "storage.state_row",
      details: fieldDetails(`rows.${member.row_schema}`, "unregistered_row_schema"),
      message_key: "error.storage.state_row_schema_invalid"
    });
  }
  const registration = findRegistration(member.row_schema);
  if (registration === null) {
    throw storageError({
      code: "E_STATE_ROW_SCHEMA",
      stage: "storage.state_row",
      details: fieldDetails(`rows.${member.row_schema}`, "unregistered_row_schema"),
      message_key: "error.storage.state_row_schema_invalid"
    });
  }
  if (member.operation === "insert") {
    assertInsertable(
      tx,
      member.table,
      registration.primary_key,
      member.row,
      member.row_schema
    );
    insertTypedRow(tx, member.table, member.row);
    const advance = advanceBranchForGoalSnapshot(
      tx,
      member.row_schema,
      member.row
    );
    if (!advance.ok) {
      throw advance.error;
    }
    return;
  }
  updateTypedRow(
    tx,
    member.table,
    registration.primary_key,
    member.row,
    member.row_schema
  );
}

/**
 * Creates the writer half of the FND `StateRowPort`.
 *
 * `appendStateRows` runs the same unified validation, blob closure, single
 * frame, journal fsync, projection and commit as the live-gated path, but it
 * reads no live business state.
 */
export function createFndStateRowWriter(options: StateRowWriterOptions): {
  appendStateRows(input: AppendStateRowsRequest): Promise<LiveCommitOutcome<null>>;
} {
  const now = options.now ?? ((): number => Date.now());
  return {
    async appendStateRows(input: AppendStateRowsRequest): Promise<LiveCommitOutcome<null>> {
      const plan = emptyPlan();
      for (const write of input.rows) {
        const row = rowAsSqlRow(write.row);
        if (row === null) {
          return {
            ok: false,
            commit_state: "not_written",
            error: schemaError(`rows.${write.row_schema}`, "row_is_not_an_object")
          };
        }
        plan.rows.push({
          row_schema: write.row_schema,
          operation: write.operation,
          row: normalizeRowForTable(write.row_schema, row),
          document_id: write.document_id
        });
      }
      for (const document of input.documents) {
        plan.documents.push({ row: document });
      }
      for (const head of input.heads) {
        plan.heads.push({ row: head });
      }
      const committed = commitPlan(options, plan, input.binding, now());
      if (!committed.ok) {
        return {
          ok: false,
          commit_state: committed.commit_state,
          error: committed.error
        };
      }
      return {
        ok: true,
        commit_state: "committed",
        receipt: committed.receipt,
        value: null
      };
    }
  };
}

/* ------------------------------------------------------------------ */
/* Live-gated commit                                                   */
/* ------------------------------------------------------------------ */

/**
 * Creates the live-gated commit port.
 *
 * The stage callback runs exactly once inside the single writer gate and
 * `BEGIN IMMEDIATE`. It may not await, may not nest a stage and may not open
 * a second connection; the stage only records a plan.
 */
export function createFndLiveCommitPort(options: StateRowWriterOptions): {
  commitLiveGated<Value = null>(
    input: LiveCommitRequest<Value>
  ): Promise<LiveCommitOutcome<Value>>;
} {
  const now = options.now ?? ((): number => Date.now());

  return {
    async commitLiveGated<Value = null>(input: LiveCommitRequest<Value>) {
      const plan = emptyPlan();
      let decision: LiveCommitDecision<Value> | null = null;
      let stageError: ErrorEnvelope | null = null;

      if (OPEN_GATES.has(options.connection)) {
        return failure(
          "not_written",
          schemaError("stage", "nested_live_commit_forbidden")
        );
      }
      try {
        options.connection.exec("BEGIN IMMEDIATE");
      } catch (error) {
        return failure("not_written", mapSqliteFailure(error, "storage.state_row", "begin_immediate"));
      }
      OPEN_GATES.add(options.connection);
      const stage = new LiveCommitStageImpl(options.connection as unknown as Tx, plan);
      try {
        const result = input.stage(stage);
        // The stage callback must be synchronous: a Promise return would let
        // the callback observe state after the commit.
        if (isThenable(result)) {
          stageError = schemaError("stage", "callback_must_be_synchronous");
        } else if (result.ok) {
          decision = result.value;
        } else {
          stageError = result.error;
        }
      } catch (error) {
        stageError = isErrorEnvelope(error)
          ? error
          : mapSqliteFailure(error, "storage.state_row", "stage_callback");
      } finally {
        stage.close();
      }
      if (stageError !== null) {
        rollback(options.connection);
        OPEN_GATES.delete(options.connection);
        return failure("not_written", stageError);
      }
      if (decision === null) {
        rollback(options.connection);
        OPEN_GATES.delete(options.connection);
        return failure("not_written", schemaError("stage", "no_decision"));
      }
      if (decision.kind === "existing") {
        const hasMembers =
          plan.rows.length + plan.documents.length + plan.heads.length + plan.outbox.length > 0;
        if (hasMembers) {
          rollback(options.connection);
          OPEN_GATES.delete(options.connection);
          return failure(
            "not_written",
            storageError({
              code: "E_IDEMPOTENCY_CONFLICT",
              stage: "storage.state_row",
              details: { kind: "none" },
              message_key: "error.storage.state_row_idempotency_conflict"
            })
          );
        }
        rollback(options.connection);
        OPEN_GATES.delete(options.connection);
        return { ok: true, commit_state: "existing", value: decision.value };
      }
      // The stage buffer must carry at least one member; a zero-member commit
      // would write an empty frame.
      if (
        plan.rows.length + plan.documents.length + plan.heads.length + plan.outbox.length ===
        0
      ) {
        rollback(options.connection);
        OPEN_GATES.delete(options.connection);
        return failure("not_written", schemaError("members", "empty_batch"));
      }
      const stagedNow = now();
      const validation = validatePlan(plan, input.binding);
      if (!validation.ok) {
        rollback(options.connection);
        OPEN_GATES.delete(options.connection);
        return failure("not_written", validation.error);
      }
      const preflight = preflightProjection(options.connection, plan);
      if (!preflight.ok) {
        rollback(options.connection);
        OPEN_GATES.delete(options.connection);
        return failure("not_written", preflight.error);
      }
      // The staged blobs are written inside the transaction, before the frame.
      for (const blob of plan.blobs) {
        const stored = options.blob_store.putSync(blob.bytes);
        if (!stored.ok) {
          rollback(options.connection);
          OPEN_GATES.delete(options.connection);
          return failure("not_written", stored.error);
        }
        if (stored.value.hash !== blob.hash) {
          rollback(options.connection);
          OPEN_GATES.delete(options.connection);
          return failure(
            "not_written",
            storageError({
              code: "E_SOURCE_HASH",
              stage: "storage.state_row",
              details: {
                kind: "source_conflict",
                source_ref: `blob://${blob.hash}#bytes=0-${blob.bytes.byteLength}`,
                expected: blob.hash,
                actual: stored.value.hash
              }
            })
          );
        }
      }
      let members: FrameMember[];
      try {
        members = assembleMembers(plan, input.binding, stagedNow);
      } catch (error) {
        rollback(options.connection);
        OPEN_GATES.delete(options.connection);
        return failure(
          "not_written",
          isErrorEnvelope(error)
            ? error
            : mapSqliteFailure(error, "storage.state_row", "assemble_members")
        );
      }
      const sortedMembers = sortMembers(members);
      const batchHash = stateRowBatchHash(
        sortedMembers.map((member) => stateRowBatchMemberHash(member.member))
      );
      resyncWriterFromState(options);
      const append = options.writer.append({
        schema_version: STATE_ROW_BATCH_SCHEMA_VERSION,
        member_count: sortedMembers.length,
        batch_hash: batchHash,
        members: sortedMembers.map((member) => member.member)
      });
      if (!append.ok) {
        rollback(options.connection);
        OPEN_GATES.delete(options.connection);
        return failure(
          options.writer.needsRecovery ? "unknown_recovery_required" : "not_written",
          append.error
        );
      }
      const receipt = append.value;
      const relativePath = receiptRelativePath(options.relative_path, receipt.file_path);
      if (relativePath === null) {
        fenceWriter(options);
        rollback(options.connection);
        OPEN_GATES.delete(options.connection);
        return failure(
          "unknown_recovery_required",
          storageError({
            code: "E_STORAGE_CORRUPT",
            stage: "storage.state_row",
            details: storageDetails("receipt.file_path", "not_a_journal_segment"),
            side_effect: "unknown"
          })
        );
      }
      try {
        // See `commitPlan`: projection order follows the canonical member
        // order, so immediate FKs are checked at COMMIT.
        options.connection.exec("PRAGMA defer_foreign_keys = ON");
        recordFrameDurability(options.connection, {
          journal_id: receipt.journal_id,
          relative_path: relativePath,
          first_commit_seq: receipt.first_commit_seq,
          member_count: receipt.member_count,
          trusted_prefix_end: receipt.file_offset + receipt.frame_bytes,
          updated_at: stagedNow
        });
        sortedMembers.forEach((member, ordinal) => {
          const commitSeq = receipt.first_commit_seq + ordinal;
          insertCommitRecord(options.connection, {
            journal_id: receipt.journal_id,
            commit_seq: commitSeq,
            event_id: member.event_id,
            payload_hash: member.after_hash,
            blob_hashes_json: canonicalJsonText([]),
            batch_hash: batchHash,
            batch_first_commit_seq: receipt.first_commit_seq,
            batch_ordinal: ordinal,
            committed_at: stagedNow,
            indexed_at: null
          });
          insertLedgerEvent(options.connection, {
            member,
            commit_seq: commitSeq,
            journal_id: receipt.journal_id,
            recorded_at: stagedNow
          });
          projectMember(options.connection, member);
        });
        options.connection.exec("COMMIT");
      } catch (error) {
        try {
          options.connection.exec("ROLLBACK");
        } catch {
          // The frame stays durable; recovery replays it.
        }
        fenceWriter(options);
        OPEN_GATES.delete(options.connection);
        return failure(
          "unknown_recovery_required",
          isErrorEnvelope(error)
            ? error
            : mapSqliteFailure(error, "storage.state_row", "project_frame")
        );
      }
      OPEN_GATES.delete(options.connection);
      return {
        ok: true,
        commit_state: "committed",
        receipt: {
          batch_hash: batchHash,
          first_commit_seq: receipt.first_commit_seq,
          last_commit_seq: receipt.last_commit_seq,
          event_ids: sortedMembers.map((member) => member.event_id)
        },
        value: decision.value
      };
    }
  };
}

/** Rolls back the open transaction, ignoring a secondary failure. */
function rollback(connection: SqliteConnection): void {
  try {
    connection.exec("ROLLBACK");
  } catch {
    // The transaction is already gone.
  }
}
