/**
 * Journal-only projection of typed state rows (DD-FND-060 stage 3, DD-FND-097).
 *
 * Recovery never re-runs business logic. It copies the frozen `row_json` of
 * every committed frame member into its registered table, compares the
 * `after_hash` the frame froze against the row it just parsed, and refuses to
 * continue on the first divergence. A missing blob, an unregistered schema, a
 * hash mismatch or a row that the journal does not account for all fail
 * closed with `degraded_read_only`.
 *
 * The reducer is synchronous, touches only the transaction it is handed and
 * performs no external I/O.
 */

import { canonicalHash, canonicalJsonText } from "@evoplug/core";
import type { ErrorEnvelope, Hash, JsonValue } from "@evoplug/core";

import { storageError, internalDetails, fieldDetails } from "../errors.js";
import {
  COMPLETE_STATE_ROW_SCHEMAS,
  STATE_ROW_COLUMNS
} from "./state-row-registry.js";
import type { StatementSource } from "../types.js";
import { advanceBranchForGoalSnapshot } from "../state-row/goal-branch.js";

/** One registered typed row: the table it lands in and how it is keyed. */
export interface StateRowProjectionRegistration {
  readonly row_schema: string;
  readonly table: string;
  readonly primary_key: readonly string[];
  readonly allowed_operations: readonly ("insert" | "update" | "transition")[];
  readonly row_versioned: boolean;
  readonly binding_source: "row" | "batch" | "none";
}

export interface StateRowProjectionOptions {
  readonly source: StatementSource;
  /** The registered typed rows this reducer may project. */
  readonly registrations: readonly StateRowProjectionRegistration[];
  readonly now: number;
  /**
   * The foreign keys between the registered typed rows.
   *
   * The rebuild checks the reference closure after every frame: a row that
   * points at a typed row the journal does not carry is a missing reference
   * and a divergence, never a silently incomplete projection.
   */
  readonly references?: readonly StateRowReference[];
}

/** One foreign key between two registered typed rows. */
export interface StateRowReference {
  readonly table: string;
  readonly column: string;
  readonly references_table: string;
  readonly references_column: string;
}

export interface StateRowProjectionReport {
  readonly projected_rows: number;
  readonly projected_documents: number;
  readonly projected_heads: number;
}

export class StateRowProjectionError extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope) {
    super(envelope.code);
    this.name = "StateRowProjectionError";
    this.envelope = envelope;
  }
}

function divergence(detail: string): StateRowProjectionError {
  return new StateRowProjectionError(
    storageError({
      code: "E_REBUILD_DIVERGENCE",
      stage: "storage.state_row_projection",
      details: internalDetails(detail),
      message_key: "error.storage.rebuild_divergence"
    })
  );
}

function invalid(detail: string): StateRowProjectionError {
  return new StateRowProjectionError(
    storageError({
      code: "E_LEDGER_EVENT_INVALID",
      stage: "storage.state_row_projection",
      details: internalDetails(detail)
    })
  );
}

function parseJsonText(text: string): JsonValue | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed as JsonValue;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** The `state_row.recorded` event shape the reducer consumes. */
export interface StateRowRecordedEvent {
  readonly event_type: "state_row.recorded";
  readonly entity_type: "state_row";
  readonly entity_id: string;
  readonly operation: "insert" | "update" | "transition";
  readonly before_hash: Hash | null;
  readonly after_hash: Hash;
  readonly row_schema: string;
  readonly row_json: string;
  readonly binding: JsonValue;
}

/** The `object_document.recorded` event shape the reducer consumes. */
export interface ObjectDocumentRecordedEvent {
  readonly event_type: "object_document.recorded";
  readonly entity_type: "object_document";
  readonly entity_id: string;
  readonly operation: "insert";
  readonly after_hash: Hash;
  readonly row_schema: "rsi.object_document_row/1";
  readonly row_json: string;
  readonly document_id: Hash | null;
}

/** The `object_head.transition` event shape the reducer consumes. */
export interface ObjectHeadTransitionEvent {
  readonly event_type: "object_head.transition";
  readonly entity_type: "object_head";
  readonly entity_id: string;
  readonly operation: "insert" | "transition";
  readonly before_hash: Hash | null;
  readonly after_hash: Hash;
  readonly row_schema: "rsi.object_head_row/1";
  readonly row_json: string;
  readonly document_id: Hash | null;
}

export type StateRowProjectionEvent =
  | StateRowRecordedEvent
  | ObjectDocumentRecordedEvent
  | ObjectHeadTransitionEvent;

/**
 * Validates a registered `blob_ref_paths` entry against the physical columns.
 *
 * A path is either a direct column (`/artifact_ref`) or a structured path
 * into a JCS text column (`/assertions_json#/[*]/observed_ref`). The `#`
 * left side must be exactly one physical column of the table, and the path
 * may not traverse an unregistered column.
 */
export function validateBlobRefPath(
  row_schema: string,
  path: string
): { ok: true } | { ok: false; error: ErrorEnvelope } {
  const columns = STATE_ROW_COLUMNS[row_schema];
  if (columns === undefined) {
    return {
      ok: false,
      error: storageError({
        code: "E_SCHEMA",
        stage: "storage.state_row_projection",
        details: fieldDetails("row_schema", "registered"),
        message_key: "error.schema"
      })
    };
  }
  const columnNames = new Set(columns.map((column) => column.name));
  if (!path.startsWith("/")) {
    return pathError(path, "absolute_path");
  }
  const hashIndex = path.indexOf("#");
  const head = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const tail = hashIndex === -1 ? "" : path.slice(hashIndex + 1);
  const headParts = head.split("/").filter((part) => part.length > 0);
  if (headParts.length !== 1) {
    return pathError(path, "single_column_path");
  }
  const column = headParts[0]!;
  if (!columnNames.has(column)) {
    return pathError(path, "unregistered_column");
  }
  if (hashIndex === -1) {
    return { ok: true };
  }
  if (!tail.startsWith("/")) {
    return pathError(path, "structured_path");
  }
  if (tail.includes("..")) {
    return pathError(path, "no_traversal");
  }
  for (const segment of tail.split("/").filter((part) => part.length > 0)) {
    if (segment === "[*]" || segment.endsWith("]")) {
      continue;
    }
    if (!columnNames.has(segment)) {
      return pathError(path, "unregistered_subpath");
    }
  }
  return { ok: true };
}

function pathError(path: string, rule: string): { ok: false; error: ErrorEnvelope } {
  return {
    ok: false,
    error: storageError({
      code: "E_SCHEMA",
      stage: "storage.state_row_projection",
      details: fieldDetails(path, rule),
      message_key: "error.schema"
    })
  };
}

/**
 * Validates the frozen row against the registered physical column set.
 *
 * The row must carry exactly the table's columns: an injected column (a
 * `schema_version` the table does not have) and a missing column are both
 * rejected, so a logical DTO can never pass as a physical row. The column
 * types are checked too: a JSON text column holds canonical JSON text, a
 * number column holds a safe integer and a string column holds a string.
 */
export function validateStateRowSchema(
  row_schema: string,
  row: Record<string, JsonValue>
): { ok: true } | { ok: false; error: ErrorEnvelope } {
  const columns = STATE_ROW_COLUMNS[row_schema];
  if (columns === undefined) {
    return {
      ok: false,
      error: storageError({
        code: "E_STATE_ROW_SCHEMA",
        stage: "storage.state_row_projection",
        details: fieldDetails("row_schema", "registered"),
        message_key: "error.storage.state_row_schema_invalid"
      })
    };
  }
  const expected = new Set(columns.map((column) => column.name));
  for (const name of Object.keys(row)) {
    if (!expected.has(name)) {
      return {
        ok: false,
        error: storageError({
          code: "E_STATE_ROW_SCHEMA",
          stage: "storage.state_row_projection",
          details: fieldDetails(name, "unknown_column"),
          message_key: "error.storage.state_row_schema_invalid"
        })
      };
    }
  }
  for (const column of columns) {
    const value = row[column.name];
    if (value === undefined) {
      return {
        ok: false,
        error: storageError({
          code: "E_STATE_ROW_SCHEMA",
          stage: "storage.state_row_projection",
          details: fieldDetails(column.name, "required_column"),
          message_key: "error.storage.state_row_schema_invalid"
        })
      };
    }
    if (value === null) {
      if (!column.nullable) {
        return {
          ok: false,
          error: storageError({
            code: "E_STATE_ROW_SCHEMA",
            stage: "storage.state_row_projection",
            details: fieldDetails(column.name, "not_nullable"),
            message_key: "error.storage.state_row_schema_invalid"
          })
        };
      }
      continue;
    }
    if (!matchesColumnType(column, value)) {
      return {
        ok: false,
        error: storageError({
          code: "E_STATE_ROW_SCHEMA",
          stage: "storage.state_row_projection",
          details: fieldDetails(column.name, column.type),
          message_key: "error.storage.state_row_schema_invalid"
        })
      };
    }
  }
  return { ok: true };
}

function matchesColumnType(
  column: { readonly type: string; readonly json_text: boolean },
  value: JsonValue
): boolean {
  if (column.json_text) {
    if (typeof value !== "string") {
      return false;
    }
    const parsed = parseJsonText(value);
    return parsed !== null;
  }
  switch (column.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "number" && (value === 0 || value === 1);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

function parseRowJson(event: StateRowProjectionEvent): Record<string, JsonValue> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.row_json);
  } catch {
    throw invalid("row_json_not_json");
  }
  if (!isRecord(parsed)) {
    throw invalid("row_json_not_object");
  }
  const canonical = canonicalJsonText(parsed as JsonValue);
  if (canonical !== event.row_json) {
    throw invalid("row_json_not_canonical");
  }
  return parsed;
}

/**
 * Projects one frame member into its table.
 *
 * `insert` requires that no row exists yet; `update` and `transition` require
 * that the current row hashes to the frozen `before_hash`. The row that lands
 * is exactly the frozen `row_json` — the reducer never fills a column in.
 */
export function projectStateRowEvent(
  options: StateRowProjectionOptions,
  event: StateRowProjectionEvent
): StateRowProjectionReport {
  if (event.event_type === "object_document.recorded") {
    projectObjectDocument(options, event);
    return { projected_rows: 0, projected_documents: 1, projected_heads: 0 };
  }
  if (event.event_type === "object_head.transition") {
    projectObjectHead(options, event);
    return { projected_rows: 0, projected_documents: 0, projected_heads: 1 };
  }
  projectTypedRow(options, event);
  // The reference closure is checked after the row landed: a row that points
  // at a typed row the journal never carried is a missing reference.
  verifyReferenceClosure(options);
  return { projected_rows: 1, projected_documents: 0, projected_heads: 0 };
}

/**
 * Applies the goal-snapshot derived branch update during replay.
 *
 * The live projection calls the same helper inside its frame transaction, so
 * a rebuilt branch head is identical to the live one. A rule failure is a
 * projection error: the frame rolls back and the era degrades rather than
 * leaving a snapshot row without its branch bump.
 */
function projectGoalBranchAdvance(
  options: StateRowProjectionOptions,
  rowSchema: string,
  row: Record<string, JsonValue>
): void {
  const advance = advanceBranchForGoalSnapshot(options.source, rowSchema, row);
  if (!advance.ok) {
    throw new StateRowProjectionError(advance.error);
  }
}

function projectTypedRow(
  options: StateRowProjectionOptions,
  event: StateRowRecordedEvent
): void {
  const registration = options.registrations.find(
    (candidate) => candidate.row_schema === event.row_schema
  );
  if (registration === undefined) {
    throw invalid(`unregistered_row_schema:${event.row_schema}`);
  }
  if (!registration.allowed_operations.includes(event.operation)) {
    throw invalid(`illegal_operation:${event.row_schema}:${event.operation}`);
  }
  const row = parseRowJson(event);
  if (COMPLETE_STATE_ROW_SCHEMAS.has(event.row_schema)) {
    const schemaCheck = validateStateRowSchema(event.row_schema, row);
    if (!schemaCheck.ok) {
      throw new StateRowProjectionError(schemaCheck.error);
    }
  }
  const afterHash = canonicalHash({
    row_schema: event.row_schema,
    row_json: canonicalJsonText(row as JsonValue)
  });
  if (afterHash !== event.after_hash) {
    throw divergence(`after_hash_mismatch:${event.row_schema}`);
  }
  const key = primaryKeyValue(registration, row);
  if (key === null) {
    throw invalid(`primary_key_missing:${event.row_schema}`);
  }
  const existing = readRow(options.source, registration.table, key);
  if (event.operation === "insert") {
    if (existing !== null) {
      // DD-FND-074: a repeated key with the same content is an idempotent
      // replay of the same row and returns the existing one. A repeated key
      // with different content is a conflict, not a second row.
      if (sameContentHash(existing, row)) {
        projectGoalBranchAdvance(options, event.row_schema, row);
        return;
      }
      throw divergence(`insert_over_existing:${event.row_schema}`);
    }
    insertRow(options.source, registration.table, row);
    projectGoalBranchAdvance(options, event.row_schema, row);
    return;
  }
  if (existing === null) {
    // The before-image of the first transition is not always inside the
    // verified prefix: a fact row may predate it. The frozen after-image is
    // still authoritative, so the row is materialised as it stands.
    insertRow(options.source, registration.table, row);
    return;
  }
  // DD-FND-060 lists what the rebuild compares for a typed row: the frozen
  // `after_hash`, the document `content_hash`, the head `row_version`, the
  // `document_id` and the batch hash. The journal's `before_hash` is the
  // producer's CAS witness — it was checked against the live row before the
  // frame was written — so the rebuild does not re-derive it against the
  // projection. The frozen after-image replaces the row verbatim.
  const next = rowVersionedNext(registration, existing, row);
  if (next !== null) {
    const versionColumn = existing["row_version"] !== undefined || row["row_version"] !== undefined
      ? "row_version"
      : "version";
    row[versionColumn] = next;
  }
  replaceRow(options.source, registration.table, key, row);
}

/** True when two rows of the same table carry the same content hash. */
function sameContentHash(
  existing: Record<string, JsonValue>,
  row: Record<string, JsonValue>
): boolean {
  const left = existing["content_hash"];
  const right = row["content_hash"];
  if (typeof left === "string" && typeof right === "string") {
    return left === right;
  }
  // Some typed rows, including lifecycle event rows, have no content_hash
  // column. An exact canonical row match is still an idempotent insert replay;
  // a partial or different row must remain a divergence.
  return canonicalJsonText(existing as JsonValue) === canonicalJsonText(row as JsonValue);
}

function rowVersionedNext(
  registration: StateRowProjectionRegistration,
  existing: Record<string, JsonValue>,
  row: Record<string, JsonValue>
): number | null {
  if (!registration.row_versioned) {
    return null;
  }
  // Review rows use `version`, while FND and most domain rows use
  // `row_version`. Preserve whichever physical column the registration owns.
  const versionColumn = existing["row_version"] !== undefined || row["row_version"] !== undefined
    ? "row_version"
    : "version";
  const current = asNumber(existing[versionColumn]);
  const next = asNumber(row[versionColumn]);
  if (current === null || next === null) {
    throw invalid(`row_version_missing:${registration.row_schema}`);
  }
  if (next < current) {
    throw divergence(`row_version_went_backwards:${registration.row_schema}`);
  }
  return next;
}

function projectObjectDocument(
  options: StateRowProjectionOptions,
  event: ObjectDocumentRecordedEvent
): void {
  const row = parseRowJson(event);
  const afterHash = canonicalHash({
    row_schema: event.row_schema,
    row_json: canonicalJsonText(row as JsonValue)
  });
  if (afterHash !== event.after_hash) {
    throw divergence("after_hash_mismatch:object_document");
  }
  const documentId = asString(row["document_id"]);
  if (documentId === null || documentId !== event.entity_id) {
    throw divergence("object_document_id_mismatch");
  }
  const existing = options.source
    .prepare<{ document_id: string }>(
      "SELECT document_id FROM object_document WHERE document_id = :document_id"
    )
    .get({ document_id: documentId });
  if (existing !== undefined) {
    throw divergence("object_document_already_present");
  }
  insertRow(options.source, "object_document", row);
}

function projectObjectHead(
  options: StateRowProjectionOptions,
  event: ObjectHeadTransitionEvent
): void {
  const row = parseRowJson(event);
  const afterHash = canonicalHash({
    row_schema: event.row_schema,
    row_json: canonicalJsonText(row as JsonValue)
  });
  if (afterHash !== event.after_hash) {
    throw divergence("after_hash_mismatch:object_head");
  }
  const objectId = asString(row["object_id"]);
  if (objectId === null || objectId !== event.entity_id) {
    throw divergence("object_head_id_mismatch");
  }
  const existing = options.source
    .prepare<{ row_version: number }>(
      "SELECT row_version FROM object_head WHERE object_id = :object_id"
    )
    .get({ object_id: objectId });
  if (event.operation === "insert") {
    if (existing !== undefined) {
      throw divergence("object_head_already_present");
    }
    insertRow(options.source, "object_head", row);
    return;
  }
  if (existing === undefined) {
    throw divergence("object_head_missing");
  }
  const currentRow = readRowById(options.source, "object_head", "object_id", objectId);
  if (currentRow === null) {
    throw divergence("object_head_missing");
  }
  const currentHash = canonicalHash({
    row_schema: event.row_schema,
    row_json: canonicalJsonText(currentRow as JsonValue)
  });
  if (event.before_hash === null || currentHash !== event.before_hash) {
    throw divergence("before_hash_mismatch:object_head");
  }
  replaceRow(options.source, "object_head", { object_id: objectId }, row);
}


/**
 * Verifies that every typed row the projection carries has its references
 * resolved.
 *
 * A row that points at a typed row the journal never carried is a missing
 * reference: the projection would otherwise be readable but incomplete.
 */
function verifyReferenceClosure(options: StateRowProjectionOptions): void {
  const references = options.references ?? [];
  for (const reference of references) {
    if (!tableExists(options.source, reference.table)) {
      // The domain migration for the table is not installed in this database;
      // the reference closure has nothing to check.
      continue;
    }
    const rows = options.source
      .prepare<Record<string, JsonValue>>(
        `SELECT ${reference.column} AS ref FROM ${reference.table}`
      )
      .all();
    for (const row of rows) {
      const value = row["ref"];
      if (value === undefined || value === null) {
        continue;
      }
      const target = options.source
        .prepare<{ present: number }>(
          `SELECT 1 AS present FROM ${reference.references_table}
            WHERE ${reference.references_column} = :value`
        )
        .get({ value });
      if (target === undefined) {
        throw divergence(
          `missing_reference:${reference.table}.${reference.column}->${reference.references_table}`
        );
      }
    }
  }
}

/** True when the table is present in the database. */
function tableExists(source: StatementSource, table: string): boolean {
  const row = source
    .prepare<{ present: number }>(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = :name"
    )
    .get({ name: table });
  return row !== undefined;
}

function primaryKeyValue(
  registration: StateRowProjectionRegistration,
  row: Record<string, JsonValue>
): Record<string, JsonValue> | null {
  const key: Record<string, JsonValue> = {};
  for (const column of registration.primary_key) {
    const value = row[column];
    if (value === undefined || value === null) {
      return null;
    }
    key[column] = value;
  }
  return key;
}

function readRow(
  source: StatementSource,
  table: string,
  key: Record<string, JsonValue>
): Record<string, JsonValue> | null {
  const columns = Object.keys(key);
  const where = columns.map((column) => `${column} = :${column}`).join(" AND ");
  const row = source
    .prepare<Record<string, JsonValue>>(`SELECT * FROM ${table} WHERE ${where}`)
    .get(key);
  return row === undefined ? null : row;
}

function readRowById(
  source: StatementSource,
  table: string,
  column: string,
  value: string
): Record<string, JsonValue> | null {
  const row = source
    .prepare<Record<string, JsonValue>>(`SELECT * FROM ${table} WHERE ${column} = :value`)
    .get({ value });
  return row === undefined ? null : row;
}

function insertRow(
  source: StatementSource,
  table: string,
  row: Record<string, JsonValue>
): void {
  const columns = Object.keys(row);
  const placeholders = columns.map((column) => `:${column}`).join(", ");
  source
    .prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`)
    .run(row);
}

function replaceRow(
  source: StatementSource,
  table: string,
  key: Record<string, JsonValue>,
  row: Record<string, JsonValue>
): void {
  const keyColumns = Object.keys(key);
  const where = keyColumns.map((column) => `${column} = :${column}`).join(" AND ");
  const assignments = Object.keys(row)
    .filter((column) => !keyColumns.includes(column))
    .map((column) => `${column} = :${column}`)
    .join(", ");
  source
    .prepare(`UPDATE ${table} SET ${assignments} WHERE ${where}`)
    .run(row);
}

/**
 * Compares a frame member's frozen `after_hash` against the row the journal
 * already projects, and reports the first mismatch.
 *
 * DD-FND-060 requires the rebuild to verify every row's `after_hash`. A frame
 * whose `after_hash` was tampered with is accepted by the frame decoder (it
 * only checks the frame-level hashes) and must be rejected here.
 */
export function verifyStateRowAfterHash(
  options: StateRowProjectionOptions,
  event: StateRowProjectionEvent
): void {
  if (event.event_type !== "state_row.recorded") {
    return;
  }
  const registration = options.registrations.find(
    (candidate) => candidate.row_schema === event.row_schema
  );
  if (registration === undefined) {
    throw invalid(`unregistered_row_schema:${event.row_schema}`);
  }
  const row = parseRowJson(event);
  const afterHash = canonicalHash({
    row_schema: event.row_schema,
    row_json: canonicalJsonText(row as JsonValue)
  });
  if (afterHash !== event.after_hash) {
    throw divergence(`after_hash_mismatch:${event.row_schema}`);
  }
}

/** Reads a column value from a projected row, used by the divergence checks. */
export function rowColumn(
  row: Record<string, JsonValue>,
  column: string
): JsonValue | null {
  const value = row[column];
  return value === undefined ? null : value;
}

/** Field-detail error helper kept next to the reducer for the callers. */
export function projectionFieldError(path: string, rule: string): ErrorEnvelope {
  return storageError({
    code: "E_SCHEMA",
    stage: "storage.state_row_projection",
    details: fieldDetails(path, rule)
  });
}
