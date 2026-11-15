/**
 * Default FND-side EVD state-row and blob ports (DD-EVD-024).
 *
 * The evidence package owns the typed row builders, content blobs and the
 * state machine; this adapter owns the physical row rules the generic FND
 * writer cannot express: the evidence-domain registry (`evd_*` tables), the
 * `row_version` CAS, the global `binding_source="none"` rows, profile
 * `max_plus_one` allocation, service-state consistency, exact blob closure
 * and idempotency against the physical rows.
 *
 * The wire format is the existing FND `rsi.state_row_batch/1` frame: one
 * journal append + fsync, then one short SQLite transaction that records
 * durability, commit records, ledger events and the typed rows. Blobs are
 * written before the frame, so a `not_written` outcome never has journal or
 * projection bytes and never allocates a `commit_seq`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalHash,
  canonicalJsonText,
  makeErrorEnvelope,
  newId,
  parseSourceRef,
  toJsonValue,
  type ErrorEnvelope,
  type Hash,
  type JsonValue,
  type Result,
  type SourceRef,
  type VersionBinding,
} from "@evoplug/core";
import {
  MAX_EVD_OBJECT_BYTES,
  attemptTransitionAllowed,
  createEvdStateWriter,
  shardTransitionAllowed,
  sourceBlobRefsOf,
  type EvdAppendReceipt,
  type EvdAppendRequest,
  type EvdBlobWritePort,
  type EvdCommitOutcome,
  type EvdRowSchema,
  type EvdRowWrite,
  type EvdStateRowPort,
  type EvdStateWritePort,
  type EvdStoredBlob,
} from "@evoplug/evidence";
import {
  BlobStore,
  STATE_ROW_BATCH_SCHEMA_VERSION,
  compareUtf8Bytes,
  insertCommitRecord,
  isErrorEnvelope,
  mapSqliteFailure,
  readJournalTailSeq,
  receiptRelativePath,
  recordFrameDurability,
  stateRowBatchHash,
  stateRowBatchMemberHash,
  storageDetails,
  storageError,
  type JournalWriter,
  type SqlRow,
  type SqliteConnection,
  type StateRowBatchMember,
} from "@evoplug/storage";

/* ------------------------------------------------------------------ */
/* Public interface                                                    */
/* ------------------------------------------------------------------ */

export interface DefaultEvidenceWriterDeps {
  /** The single-writer SQLite connection shared with the other FND writers. */
  readonly connection: SqliteConnection;
  /** The shared journal writer; this adapter never opens a second journal. */
  readonly writer: JournalWriter;
  /** Path recorded in `journal_state.relative_path`, relative to the home. */
  readonly relative_path: string;
  /** Content-addressed blob store used by `EvdBlobWritePort.put`. */
  readonly blob_store: BlobStore;
  /** Clock used for `created_at`-independent event metadata; defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface DefaultEvidenceWriterBundle {
  readonly rows: EvdStateRowPort;
  readonly blobs: EvdBlobWritePort;
  readonly writer: EvdStateWritePort;
}

/* ------------------------------------------------------------------ */
/* Evidence-domain registry                                            */
/* ------------------------------------------------------------------ */

interface EvdAllocation {
  readonly field: string;
  readonly scope_fields: readonly string[];
  readonly rule: "max_plus_one";
}

interface EvdRegistration {
  readonly row_schema: EvdRowSchema;
  readonly table: string;
  readonly primary_key: readonly string[];
  readonly unique_keys: readonly (readonly string[])[];
  readonly allowed_operations: readonly ("insert" | "update" | "transition")[];
  readonly binding_source: "row" | "none";
  readonly row_versioned: boolean;
  readonly blob_ref_paths: readonly string[];
  readonly allocation: EvdAllocation | null;
}

const REGISTRY_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "schemas",
  "domains",
  "evidence",
  "state-row-registry.json",
);

const BINDING_FIELDS = [
  "task_id",
  "branch_id",
  "input_epoch",
  "goal_version",
  "config_version",
  "watermark",
] as const;

const JSON_TEXT_COLUMNS: Readonly<Record<string, ReadonlySet<string>>> = {
  evd_evidence_pack: new Set(["source_blob_refs"]),
  evd_dependency_unit: new Set(["source_blob_refs"]),
  evd_state_manifest: new Set(["source_blob_refs"]),
  evd_shard_plan: new Set(["source_blob_refs"]),
  evd_shard: new Set(["attempt_ids", "envelope_keys", "reason_codes", "body_json"]),
  evd_omission: new Set(["question_keys", "unit_keys", "source_blob_refs"]),
  evd_budget_estimate: new Set(["source_blob_refs"]),
  evd_service_profile: new Set(["body_json"]),
  evd_service_state: new Set(["reason_codes", "body_json"]),
  evd_validator_binding: new Set(["body_json"]),
  evd_request_binding: new Set(["source_blob_refs"]),
  evd_attempt: new Set(["body_json"]),
  evd_envelope: new Set(["source_blob_refs"]),
  evd_late_result: new Set(["source_blob_refs"]),
  evd_aggregate: new Set(["source_blob_refs"]),
};

const BOOLEAN_INTEGER_COLUMNS: Readonly<Record<string, ReadonlySet<string>>> = {
  evd_service_profile: new Set(["production_use"]),
  evd_omission: new Set(["required_for_issue", "recoverable"]),
  evd_aggregate: new Set(["coverage_complete"]),
};

function registryFailure(message: string): never {
  // The registry is a build artifact of the evidence domain. A missing or
  // malformed registry is a startup failure, not a recoverable row error.
  throw new Error(`EVD registry unavailable: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return null;
    }
    out.push(item);
  }
  return out;
}

function loadRegistry(): ReadonlyMap<EvdRowSchema, EvdRegistration> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as unknown;
  } catch (error) {
    registryFailure(error instanceof Error ? error.message : "unreadable registry");
  }
  if (!isRecord(parsed)) {
    registryFailure("registry is not an object");
  }
  if (parsed["schema_version"] !== "rsi.state_row_registry/1") {
    registryFailure("unsupported schema_version");
  }
  if (parsed["owner_domain"] !== "evd") {
    registryFailure("owner_domain is not evd");
  }
  const rawRows = parsed["rows"];
  if (!Array.isArray(rawRows) || rawRows.length !== 15) {
    registryFailure("registry must publish exactly 15 evidence rows");
  }
  const bySchema = new Map<EvdRowSchema, EvdRegistration>();
  const tables = new Set<string>();
  for (const raw of rawRows) {
    if (!isRecord(raw)) {
      registryFailure("row entry is not an object");
    }
    const rowSchema = raw["row_schema"];
    if (typeof rowSchema !== "string" || !rowSchema.startsWith("rsi.evd_")) {
      registryFailure("row_schema is not an evidence row");
    }
    const table = raw["table"];
    if (typeof table !== "string" || !/^evd_[a-z_]+$/.test(table)) {
      registryFailure(`table is not an evd_* table: ${String(table)}`);
    }
    if (tables.has(table)) {
      registryFailure(`duplicate table ${table}`);
    }
    tables.add(table);
    const primaryKey = stringArray(raw["primary_key"]);
    if (primaryKey === null || primaryKey.length === 0) {
      registryFailure(`primary_key missing for ${rowSchema}`);
    }
    const uniqueKeysRaw = raw["unique_keys"];
    if (!Array.isArray(uniqueKeysRaw)) {
      registryFailure(`unique_keys missing for ${rowSchema}`);
    }
    const uniqueKeys: string[][] = [];
    for (const candidate of uniqueKeysRaw) {
      const key = stringArray(candidate);
      if (key === null || key.length === 0) {
        registryFailure(`unique_keys malformed for ${rowSchema}`);
      }
      uniqueKeys.push(key);
    }
    const operations = stringArray(raw["allowed_operations"]);
    if (
      operations === null ||
      operations.some(
        (operation) =>
          operation !== "insert" && operation !== "update" && operation !== "transition",
      )
    ) {
      registryFailure(`allowed_operations malformed for ${rowSchema}`);
    }
    const bindingSource = raw["binding_source"];
    if (bindingSource !== "row" && bindingSource !== "none") {
      registryFailure(`binding_source malformed for ${rowSchema}`);
    }
    if (typeof raw["row_versioned"] !== "boolean") {
      registryFailure(`row_versioned malformed for ${rowSchema}`);
    }
    const blobPaths = stringArray(raw["blob_ref_paths"]);
    if (blobPaths === null) {
      registryFailure(`blob_ref_paths malformed for ${rowSchema}`);
    }
    let allocation: EvdAllocation | null = null;
    const rawAllocation = raw["allocation"];
    if (rawAllocation !== null) {
      if (!isRecord(rawAllocation)) {
        registryFailure(`allocation malformed for ${rowSchema}`);
      }
      const field = rawAllocation["field"];
      const scope = stringArray(rawAllocation["scope_fields"]);
      if (
        typeof field !== "string" ||
        scope === null ||
        rawAllocation["rule"] !== "max_plus_one"
      ) {
        registryFailure(`allocation unsupported for ${rowSchema}`);
      }
      allocation = { field, scope_fields: scope, rule: "max_plus_one" };
    }
    if (raw["document"] !== null) {
      registryFailure(`document must be null for ${rowSchema}`);
    }
    bySchema.set(rowSchema as EvdRowSchema, {
      row_schema: rowSchema as EvdRowSchema,
      table,
      primary_key: primaryKey,
      unique_keys: uniqueKeys,
      allowed_operations: operations as ("insert" | "update" | "transition")[],
      binding_source: bindingSource,
      row_versioned: raw["row_versioned"],
      blob_ref_paths: blobPaths,
      allocation,
    });
  }
  return bySchema;
}

/* ------------------------------------------------------------------ */
/* Physical table metadata                                             */
/* ------------------------------------------------------------------ */

interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly not_null: boolean;
  readonly primary_key: boolean;
}

function loadColumns(connection: SqliteConnection, table: string): readonly ColumnInfo[] {
  const rows = connection.prepare<SqlRow>(`PRAGMA table_info("${table}")`).all();
  if (rows.length === 0) {
    throw storageError({
      code: "E_STATE_ROW_SCHEMA",
      stage: "evd.state_row",
      details: { kind: "field", path: `table.${table}`, rule: "missing" },
    });
  }
  return rows.map((row) => ({
    name: String(row["name"]),
    type: String(row["type"]).toUpperCase(),
    not_null: Number(row["notnull"]) === 1,
    primary_key: Number(row["pk"]) > 0,
  }));
}

/* ------------------------------------------------------------------ */
/* Typed failures                                                      */
/* ------------------------------------------------------------------ */

function schemaError(path: string, rule: string): ErrorEnvelope {
  return storageError({
    code: "E_STATE_ROW_SCHEMA",
    stage: "evd.state_row",
    details: { kind: "field", path, rule },
    message_key: "error.storage.state_row_schema_invalid",
  });
}

function bindingError(rule: string): ErrorEnvelope {
  return storageError({
    code: "E_STATE_ROW_BINDING",
    stage: "evd.state_row",
    details: { kind: "none" },
    message_key: "error.storage.state_row_binding_invalid",
  });
}

function versionError(expected: string, actual: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_VERSION_BINDING",
    category: "version",
    retryable: false,
    side_effect: "none",
    message_key: "error.version.binding",
    stage: "evd.state_row",
    details: { kind: "version", expected, actual },
  });
}

function idempotencyError(key: string, existing: Hash, incoming: Hash): ErrorEnvelope {
  return storageError({
    code: "E_IDEMPOTENCY_CONFLICT",
    stage: "evd.state_row",
    details: { kind: "idempotency", key, existing_hash: existing, incoming_hash: incoming },
    message_key: "error.storage.state_row_idempotency_conflict",
  });
}

function notWritten(error: ErrorEnvelope): EvdCommitOutcome {
  return { ok: false, commit_state: "not_written", error };
}

function recoveryRequired(error: ErrorEnvelope): EvdCommitOutcome {
  return { ok: false, commit_state: "unknown_recovery_required", error };
}

/* ------------------------------------------------------------------ */
/* Row normalisation                                                   */
/* ------------------------------------------------------------------ */

function normalizeJsonColumn(
  table: string,
  column: string,
  value: unknown
): { ok: true; value: string } | { ok: false; error: ErrorEnvelope } {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as JsonValue;
      if (isRecord(parsed) || Array.isArray(parsed)) {
        return { ok: true, value: canonicalJsonText(parsed) };
      }
    } catch {
      // Fall through to the typed error.
    }
    return { ok: false, error: schemaError(`${table}.${column}`, "json_text") };
  }
  if (isRecord(value) || Array.isArray(value)) {
    return { ok: true, value: canonicalJsonText(value as JsonValue) };
  }
  return { ok: false, error: schemaError(`${table}.${column}`, "json_text") };
}

function normalizeCell(
  table: string,
  column: ColumnInfo,
  value: unknown
): { ok: true; value: unknown } | { ok: false; error: ErrorEnvelope } {
  if (value === null) {
    return column.not_null
      ? { ok: false, error: schemaError(`${table}.${column.name}`, "not_null") }
      : { ok: true, value: null };
  }
  if (JSON_TEXT_COLUMNS[table]?.has(column.name) === true) {
    return normalizeJsonColumn(table, column.name, value);
  }
  if (column.type.includes("INT")) {
    if (typeof value === "boolean") {
      return { ok: true, value: value ? 1 : 0 };
    }
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      return { ok: true, value };
    }
    return { ok: false, error: schemaError(`${table}.${column.name}`, "integer") };
  }
  if (typeof value === "string") {
    return { ok: true, value };
  }
  return { ok: false, error: schemaError(`${table}.${column.name}`, "text") };
}

function normalizeCompleteRow(
  registration: EvdRegistration,
  columns: readonly ColumnInfo[],
  raw: unknown,
  mode: "insert" | "mutation"
): { ok: true; row: SqlRow; row_json: string } | { ok: false; error: ErrorEnvelope } {
  if (!isRecord(raw)) {
    return { ok: false, error: schemaError(registration.row_schema, "row_is_not_an_object") };
  }
  const expected = new Set(columns.map((column) => column.name));
  for (const name of Object.keys(raw)) {
    if (!expected.has(name)) {
      return {
        ok: false,
        error: schemaError(`${registration.row_schema}.${name}`, "unknown_column"),
      };
    }
  }
  const row: SqlRow = {};
  for (const column of columns) {
    if (!(column.name in raw)) {
      return {
        ok: false,
        error: schemaError(`${registration.row_schema}.${column.name}`, "missing_column"),
      };
    }
    const cell = normalizeCell(registration.table, column, raw[column.name]);
    if (!cell.ok) {
      return cell;
    }
    row[column.name] = cell.value;
  }
  const rowVersion = row["row_version"];
  if (typeof rowVersion !== "number" || !Number.isSafeInteger(rowVersion) || rowVersion < 0) {
    return { ok: false, error: schemaError(`${registration.row_schema}.row_version`, "integer") };
  }
  if (mode === "insert" && rowVersion !== 0) {
    return {
      ok: false,
      error: schemaError(`${registration.row_schema}.row_version`, "insert_must_start_at_zero"),
    };
  }
  for (const column of registration.primary_key) {
    const value = row[column];
    if (value === null || value === undefined) {
      return {
        ok: false,
        error: schemaError(`${registration.row_schema}.${column}`, "primary_key_null"),
      };
    }
  }
  return { ok: true, row, row_json: canonicalJsonText(toJsonValue(row)) };
}

function normalizePatch(
  registration: EvdRegistration,
  columns: readonly ColumnInfo[],
  raw: unknown
): { ok: true; patch: SqlRow } | { ok: false; error: ErrorEnvelope } {
  if (!isRecord(raw)) {
    return { ok: false, error: schemaError(registration.row_schema, "row_is_not_an_object") };
  }
  const byName = new Map(columns.map((column) => [column.name, column]));
  const patch: SqlRow = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name === "expected_row_version") {
      // CAS control field, not a physical column.
      continue;
    }
    if (name === "row_version" || name === "created_at") {
      return {
        ok: false,
        error: schemaError(`${registration.row_schema}.${name}`, "managed_column"),
      };
    }
    const column = byName.get(name);
    if (column === undefined) {
      return {
        ok: false,
        error: schemaError(`${registration.row_schema}.${name}`, "unknown_column"),
      };
    }
    if (value === null && column.not_null) {
      return {
        ok: false,
        error: schemaError(`${registration.row_schema}.${name}`, "not_null"),
      };
    }
    if (value === null) {
      patch[name] = null;
      continue;
    }
    const cell = normalizeCell(registration.table, column, value);
    if (!cell.ok) {
      return cell;
    }
    patch[name] = cell.value;
  }
  for (const column of registration.primary_key) {
    if (!(column in patch)) {
      return {
        ok: false,
        error: schemaError(`${registration.row_schema}.${column}`, "primary_key_required"),
      };
    }
  }
  return { ok: true, patch };
}

function rowJsonOf(row: SqlRow): string {
  return canonicalJsonText(toJsonValue(row));
}

function afterHashOf(rowSchema: string, rowJson: string): Hash {
  return canonicalHash({ row_schema: rowSchema, row_json: rowJson });
}

function objectKeyOf(registration: EvdRegistration, row: SqlRow): string {
  const key: Record<string, JsonValue> = {};
  for (const column of registration.primary_key) {
    key[column] = toJsonValue(row[column]);
  }
  return canonicalHash({
    schema_version: "rsi.state_row_key/1",
    row_schema: registration.row_schema,
    key,
  });
}

/* ------------------------------------------------------------------ */
/* Binding / blob helpers                                              */
/* ------------------------------------------------------------------ */

function rowBinding(row: SqlRow): VersionBinding | null {
  const task_id = row["task_id"];
  const branch_id = row["branch_id"];
  const input_epoch = row["input_epoch"];
  const goal_version = row["goal_version"];
  const config_version = row["config_version"];
  const watermark = row["watermark"];
  if (
    typeof task_id !== "string" ||
    typeof branch_id !== "string" ||
    typeof input_epoch !== "number" ||
    !Number.isSafeInteger(input_epoch) ||
    typeof goal_version !== "string" ||
    typeof config_version !== "string" ||
    typeof watermark !== "number" ||
    !Number.isSafeInteger(watermark)
  ) {
    return null;
  }
  return {
    task_id: task_id as VersionBinding["task_id"],
    branch_id: branch_id as VersionBinding["branch_id"],
    input_epoch,
    goal_version,
    config_version,
    watermark,
  };
}

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
    watermark: binding.watermark,
  };
}

function equalBindings(left: VersionBinding, right: VersionBinding): boolean {
  return (
    left.task_id === right.task_id &&
    left.branch_id === right.branch_id &&
    left.input_epoch === right.input_epoch &&
    left.goal_version === right.goal_version &&
    left.config_version === right.config_version &&
    left.watermark === right.watermark
  );
}

function splitBlobPath(path: string): { column: string; jsonPath: readonly string[] } | null {
  if (!path.startsWith("/")) {
    return null;
  }
  const marker = path.indexOf("#");
  if (marker < 0) {
    return { column: path.slice(1), jsonPath: [] };
  }
  const column = path.slice(1, marker);
  const rest = path.slice(marker + 1);
  if (column.length === 0 || rest.length === 0) {
    return null;
  }
  return {
    column,
    jsonPath: rest.split("/").filter((segment) => segment.length > 0),
  };
}

function collectAtPath(node: unknown, segments: readonly string[], into: Set<SourceRef>): void {
  if (segments.length === 0) {
    if (typeof node === "string" && node.startsWith("blob://")) {
      into.add(node as SourceRef);
    }
    return;
  }
  const [segment, ...rest] = segments;
  if (segment === undefined) {
    return;
  }
  if (segment === "[*]") {
    if (Array.isArray(node)) {
      for (const entry of node) {
        collectAtPath(entry, rest, into);
      }
    }
    return;
  }
  if (segment.endsWith("[*]")) {
    const name = segment.slice(0, -3);
    if (isRecord(node) && Array.isArray(node[name])) {
      for (const entry of node[name] as unknown[]) {
        collectAtPath(entry, rest, into);
      }
    }
    return;
  }
  if (isRecord(node)) {
    collectAtPath(node[segment], rest, into);
  }
}

function byteCompare(left: string, right: string): number {
  return compareUtf8Bytes(left, right);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(byteCompare);
}

function validateBlobRef(
  ref: SourceRef,
  blobStore: BlobStore
): { ok: true; hash: Hash; bytes: Uint8Array } | { ok: false; error: ErrorEnvelope } {
  const parsed = parseSourceRef(ref);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  if (parsed.value.scheme !== "blob") {
    return {
      ok: false,
      error: schemaError(`row.blob_ref`, "blob_scheme_required"),
    };
  }
  const hash = parsed.value.locator as Hash;
  const read = blobStore.read(hash);  if (!read.ok) {
    return { ok: false, error: read.error };
  }
  if (parsed.value.end > read.value.byteLength) {
    return {
      ok: false,
      error: schemaError(`row.blob_ref`, "range_exceeds_blob"),
    };
  }
  return { ok: true, hash, bytes: read.value };
}

function inspectRowBlobs(
  registration: EvdRegistration,
  row: SqlRow,
  blobStore: BlobStore
): { ok: true; blob_hashes: Hash[] } | { ok: false; error: ErrorEnvelope } {
  const refs = new Set<SourceRef>();
  for (const path of registration.blob_ref_paths) {
    const split = splitBlobPath(path);
    if (split === null) {
      return { ok: false, error: schemaError(`registry.blob_ref_paths.${path}`, "syntax") };
    }
    const column = row[split.column];
    if (column === undefined) {
      return {
        ok: false,
        error: schemaError(`registry.blob_ref_paths.${path}`, "dangling_column"),
      };
    }
    if (split.jsonPath.length === 0) {
      if (typeof column === "string" && column.startsWith("blob://")) {
        refs.add(column as SourceRef);
      }
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(column)) as unknown;
    } catch {
      return {
        ok: false,
        error: schemaError(`${registration.table}.${split.column}`, "json_text"),
      };
    }
    collectAtPath(parsed, split.jsonPath, refs);
  }

  const hashes: Hash[] = [];
  for (const ref of refs) {
    const checked = validateBlobRef(ref, blobStore);
    if (!checked.ok) {
      return checked;
    }
    hashes.push(checked.hash);
  }

  if (registration.table !== undefined && "content_ref" in row) {
    const contentRef = row["content_ref"];
    const contentHash = row["content_hash"];
    const contentBytes = row["content_bytes"];
    if (
      typeof contentRef !== "string" ||
      typeof contentHash !== "string" ||
      typeof contentBytes !== "number"
    ) {
      return { ok: false, error: schemaError(registration.row_schema, "content_meta") };
    }
    if (contentBytes < 1 || contentBytes > MAX_EVD_OBJECT_BYTES) {
      return {
        ok: false,
        error: schemaError(`${registration.row_schema}.content_bytes`, "out_of_range"),
      };
    }
    const parsed = parseSourceRef(contentRef);
    if (!parsed.ok || parsed.value.scheme !== "blob") {
      return { ok: false, error: schemaError(`${registration.row_schema}.content_ref`, "blob_ref") };
    }
    if (
      parsed.value.locator !== contentHash ||
      parsed.value.start !== 0 ||
      parsed.value.end !== contentBytes
    ) {
      return {
        ok: false,
        error: makeErrorEnvelope({
          code: "E_CONTENT_HASH_MISMATCH",
          category: "conflict",
          retryable: false,
          side_effect: "none",
          message_key: "error.evd.content_hash_mismatch",
          stage: "evd.state_row",
          details: {
            kind: "registry",
            code: "E_CONTENT_HASH_MISMATCH",
            details: {
              content_ref: contentRef,
              expected: contentHash,
              actual: parsed.value.locator,
            },
          },
        }),
      };
    }
    const read = blobStore.read(contentHash as Hash);
    if (!read.ok) {
      return { ok: false, error: read.error };
    }
    if (read.value.byteLength !== contentBytes) {
      return {
        ok: false,
        error: makeErrorEnvelope({
          code: "E_CONTENT_HASH_MISMATCH",
          category: "conflict",
          retryable: false,
          side_effect: "none",
          message_key: "error.evd.content_hash_mismatch",
          stage: "evd.state_row",
          details: {
            kind: "registry",
            code: "E_CONTENT_HASH_MISMATCH",
            details: {
              content_ref: contentRef,
              expected: String(contentBytes),
              actual: String(read.value.byteLength),
            },
          },
        }),
      };
    }
    let content: JsonValue;
    try {
      content = JSON.parse(new TextDecoder().decode(read.value)) as JsonValue;
    } catch {
      return {
        ok: false,
        error: schemaError(`${registration.row_schema}.content_ref`, "invalid_json"),
      };
    }
    const declaredRaw = row["source_blob_refs"];
    if (typeof declaredRaw !== "string") {
      return {
        ok: false,
        error: schemaError(`${registration.row_schema}.source_blob_refs`, "missing"),
      };
    }
    let declared: unknown;
    try {
      declared = JSON.parse(declaredRaw) as unknown;
    } catch {
      return {
        ok: false,
        error: schemaError(`${registration.row_schema}.source_blob_refs`, "invalid_json"),
      };
    }
    const declaredRefs = stringArray(declared);
    if (declaredRefs === null) {
      return {
        ok: false,
        error: schemaError(`${registration.row_schema}.source_blob_refs`, "string_array"),
      };
    }
    const closure = sourceBlobRefsOf(content);
    const declaredSorted = [...declaredRefs].sort(byteCompare);
    if (
      declaredSorted.length !== declaredRefs.length ||
      declaredRefs.some((ref, index) => ref !== declaredSorted[index]) ||
      new Set(declaredRefs).size !== declaredRefs.length
    ) {
      return {
        ok: false,
        error: schemaError(`${registration.row_schema}.source_blob_refs`, "sorted_unique"),
      };
    }
    if (
      declaredRefs.length !== closure.length ||
      declaredRefs.some((ref, index) => ref !== closure[index])
    ) {
      return {
        ok: false,
        error: schemaError(`${registration.row_schema}.source_blob_refs`, "exact_closure"),
      };
    }
    hashes.push(contentHash as Hash);
  }

  return { ok: true, blob_hashes: sortedUnique(hashes) as Hash[] };
}

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

interface PlannedRow {
  readonly registration: EvdRegistration;
  readonly operation: "insert" | "update" | "transition";
  readonly row: SqlRow;
  readonly row_json: string;
  readonly before_hash: Hash | null;
  readonly after_hash: Hash;
  readonly object_key: string;
  readonly binding: VersionBinding | null;
  readonly blob_hashes: readonly Hash[];
}

type Evaluated =
  | { readonly kind: "new"; readonly planned: PlannedRow }
  | { readonly kind: "existing" };

function readByPrimaryKey(
  connection: SqliteConnection,
  registration: EvdRegistration,
  row: SqlRow
): SqlRow | null {
  const params: Record<string, unknown> = {};
  const clauses: string[] = [];
  for (const column of registration.primary_key) {
    params[column] = row[column];
    clauses.push(`${column} = :${column}`);
  }
  const found = connection
    .prepare<SqlRow>(
      `SELECT * FROM ${registration.table} WHERE ${clauses.join(" AND ")}`,
    )
    .get(params);
  return found ?? null;
}

function readUnique(
  connection: SqliteConnection,
  registration: EvdRegistration,
  columns: readonly string[],
  row: SqlRow
): readonly SqlRow[] {
  if (
    registration.row_schema === "rsi.evd_late_result_row/1" &&
    columns.length === 1 &&
    columns[0] === "attempt_id" &&
    row["disposition"] !== "appended_history"
  ) {
    return [];
  }
  const params: Record<string, unknown> = {};
  const clauses: string[] = [];
  for (const column of columns) {
    params[column] = row[column];
    clauses.push(`${column} = :${column}`);
  }
  if (registration.row_schema === "rsi.evd_late_result_row/1" && columns[0] === "attempt_id") {
    clauses.push("disposition = 'appended_history'");
  }
  return connection
    .prepare<SqlRow>(`SELECT * FROM ${registration.table} WHERE ${clauses.join(" AND ")}`)
    .all(params);
}

function maxProfileVersion(
  connection: SqliteConnection,
  profileKey: string
): number | null {
  const row = connection
    .prepare<{ max_version: number | null }>(
      "SELECT MAX(profile_version) AS max_version FROM evd_service_profile WHERE profile_key = :profile_key",
    )
    .get({ profile_key: profileKey });
  const value = row?.max_version;
  return typeof value === "number" ? value : null;
}

function serviceStateConsistency(
  connection: SqliteConnection,
  row: SqlRow
): ErrorEnvelope | null {
  const profileKey = row["profile_key"];
  const version = row["current_profile_version"];
  const profileId = row["current_profile_id"];
  if (
    typeof profileKey !== "string" ||
    typeof version !== "number" ||
    typeof profileId !== "string"
  ) {
    return schemaError("rsi.evd_service_state_row/1", "profile_identity");
  }
  const maximum = maxProfileVersion(connection, profileKey);
  if (maximum !== version) {
    return makeErrorEnvelope({
      code: "E_SERVICE_STATE_INCONSISTENT",
      category: "conflict",
      retryable: false,
      side_effect: "none",
      message_key: "error.evd.service_state_inconsistent",
      stage: "evd.state_row",
      details: {
        kind: "registry",
        code: "E_SERVICE_STATE_INCONSISTENT",
        details: {
          profile_key: profileKey,
          expected_previous_version: maximum ?? 0,
          current_version: version,
        },
      },
    });
  }
  const profile = connection
    .prepare<SqlRow>(
      "SELECT profile_id, acceptance_status FROM evd_service_profile WHERE profile_key = :profile_key AND profile_version = :profile_version",
    )
    .get({ profile_key: profileKey, profile_version: version });
  if (profile === undefined || profile["profile_id"] !== profileId) {
    return makeErrorEnvelope({
      code: "E_SERVICE_STATE_INCONSISTENT",
      category: "conflict",
      retryable: false,
      side_effect: "none",
      message_key: "error.evd.service_state_inconsistent",
      stage: "evd.state_row",
      details: {
        kind: "registry",
        code: "E_SERVICE_STATE_INCONSISTENT",
        details: {
          profile_key: profileKey,
          expected_previous_version: maximum ?? 0,
          current_version: version,
        },
      },
    });
  }
  if (profile["acceptance_status"] !== row["acceptance_status"]) {
    return makeErrorEnvelope({
      code: "E_SERVICE_STATE_INCONSISTENT",
      category: "conflict",
      retryable: false,
      side_effect: "none",
      message_key: "error.evd.service_state_inconsistent",
      stage: "evd.state_row",
      details: {
        kind: "registry",
        code: "E_SERVICE_STATE_INCONSISTENT",
        details: {
          profile_key: profileKey,
          expected_previous_version: maximum ?? 0,
          current_version: version,
        },
      },
    });
  }
  return null;
}

function preparePlanned(
  connection: SqliteConnection,
  blobStore: BlobStore,
  registration: EvdRegistration,
  operation: "insert" | "update" | "transition",
  row: SqlRow,
  before: SqlRow | null
): { ok: true; planned: PlannedRow } | { ok: false; error: ErrorEnvelope } {
  const rowJson = rowJsonOf(row);
  const blobs = inspectRowBlobs(registration, row, blobStore);
  if (!blobs.ok) {
    return blobs;
  }
  return {
    ok: true,
    planned: {
      registration,
      operation,
      row,
      row_json: rowJson,
      before_hash: before === null ? null : afterHashOf(registration.row_schema, rowJsonOf(before)),
      after_hash: afterHashOf(registration.row_schema, rowJson),
      object_key: objectKeyOf(registration, row),
      binding: registration.binding_source === "none" ? null : rowBinding(row),
      blob_hashes: blobs.blob_hashes,
    },
  };
}

function evaluateInsert(
  connection: SqliteConnection,
  blobStore: BlobStore,
  registration: EvdRegistration,
  columns: readonly ColumnInfo[],
  raw: unknown
): { ok: true; evaluated: Evaluated } | { ok: false; error: ErrorEnvelope } {
  const normalized = normalizeCompleteRow(registration, columns, raw, "insert");
  if (!normalized.ok) {
    return normalized;
  }
  const row = normalized.row;
  const incomingHash = afterHashOf(registration.row_schema, normalized.row_json);

  const primary = readByPrimaryKey(connection, registration, row);
  if (primary !== null) {
    if (rowJsonOf(primary) === normalized.row_json) {
      return { ok: true, evaluated: { kind: "existing" } };
    }
    return {
      ok: false,
      error: idempotencyError(
        objectKeyOf(registration, row),
        afterHashOf(registration.row_schema, rowJsonOf(primary)),
        incomingHash,
      ),
    };
  }

  let uniqueConflict:
    | { key: string; existing: Hash; incoming: Hash }
    | null = null;
  for (const unique of registration.unique_keys) {
    const existing = readUnique(connection, registration, unique, row);
    if (existing.length === 0) {
      continue;
    }
    const exact = existing.find((candidate) => rowJsonOf(candidate) === normalized.row_json);
    if (exact !== undefined) {
      return { ok: true, evaluated: { kind: "existing" } };
    }
    if (uniqueConflict === null) {
      uniqueConflict = {
        key: `${registration.row_schema}:${unique.join(",")}`,
        existing: afterHashOf(registration.row_schema, rowJsonOf(existing[0] as SqlRow)),
        incoming: incomingHash,
      };
    }
  }

  if (registration.allocation !== null) {
    const field = registration.allocation.field;
    const requested = row[field];
    if (typeof requested !== "number" || !Number.isSafeInteger(requested)) {
      return { ok: false, error: schemaError(`${registration.row_schema}.${field}`, "integer") };
    }
    const scope = registration.allocation.scope_fields[0];
    const scopeValue = scope === undefined ? undefined : row[scope];
    if (typeof scopeValue !== "string") {
      return { ok: false, error: schemaError(`${registration.row_schema}.${scope ?? "scope"}`, "missing") };
    }
    const maximum = maxProfileVersion(connection, scopeValue);
    const expectedPrevious = requested - 1;
    if ((maximum ?? 0) !== expectedPrevious) {
      return {
        ok: false,
        error: makeErrorEnvelope({
          code: "E_SERVICE_STATE_INCONSISTENT",
          category: "conflict",
          retryable: false,
          side_effect: "none",
          message_key: "error.evd.service_state_inconsistent",
          stage: "evd.state_row",
          details: {
            kind: "registry",
            code: "E_SERVICE_STATE_INCONSISTENT",
            details: {
              profile_key: scopeValue,
              expected_previous_version: expectedPrevious,
              current_version: maximum ?? 0,
            },
          },
        }),
      };
    }
  }

  if (uniqueConflict !== null) {
    return {
      ok: false,
      error: idempotencyError(
        uniqueConflict.key,
        uniqueConflict.existing,
        uniqueConflict.incoming,
      ),
    };
  }

  if (registration.row_schema === "rsi.evd_service_state_row/1") {
    const inconsistent = serviceStateConsistency(connection, row);
    if (inconsistent !== null) {
      return { ok: false, error: inconsistent };
    }
  }

  const prepared = preparePlanned(connection, blobStore, registration, "insert", row, null);
  if (!prepared.ok) {
    return prepared;
  }
  return { ok: true, evaluated: { kind: "new", planned: prepared.planned } };
}

function patchMatches(row: SqlRow, patch: SqlRow): boolean {
  for (const [key, value] of Object.entries(patch)) {
    if (row[key] !== value) {
      return false;
    }
  }
  return true;
}

function evaluateMutation(
  connection: SqliteConnection,
  blobStore: BlobStore,
  registration: EvdRegistration,
  columns: readonly ColumnInfo[],
  operation: "update" | "transition",
  raw: unknown
): { ok: true; evaluated: Evaluated } | { ok: false; error: ErrorEnvelope } {
  const normalized = normalizePatch(registration, columns, raw);
  if (!normalized.ok) {
    return normalized;
  }
  const patch = normalized.patch;
  const expectedRaw = (raw as Record<string, unknown>)["expected_row_version"];
  if (typeof expectedRaw !== "number" || !Number.isSafeInteger(expectedRaw) || expectedRaw < 0) {
    return {
      ok: false,
      error: schemaError(`${registration.row_schema}.expected_row_version`, "integer"),
    };
  }
  const current = readByPrimaryKey(connection, registration, patch);
  if (current === null) {
    return {
      ok: false,
      error: versionError(
        `${registration.row_schema}:row_version=${String(expectedRaw)}`,
        "row_missing",
      ),
    };
  }
  const currentVersion = Number(current["row_version"]);
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 0) {
    return { ok: false, error: schemaError(`${registration.row_schema}.row_version`, "stored") };
  }
  const matches = patchMatches(current, patch);

  if (expectedRaw === currentVersion - 1 && matches) {
    return { ok: true, evaluated: { kind: "existing" } };
  }
  if (expectedRaw !== currentVersion) {
    return {
      ok: false,
      error: versionError(String(expectedRaw), String(currentVersion)),
    };
  }
  if (matches) {
    return {
      ok: false,
      error: idempotencyError(
        objectKeyOf(registration, current),
        afterHashOf(registration.row_schema, rowJsonOf(current)),
        afterHashOf(registration.row_schema, rowJsonOf(current)),
      ),
    };
  }

  if (operation === "transition") {
    if (registration.row_schema === "rsi.evd_shard_row/1") {
      const from = current["status"];
      const to = patch["status"];
      if (typeof to !== "string") {
        return { ok: false, error: schemaError(`${registration.row_schema}.status`, "required") };
      }
      if (from === to) {
        return {
          ok: false,
          error: idempotencyError(
            objectKeyOf(registration, current),
            afterHashOf(registration.row_schema, rowJsonOf(current)),
            afterHashOf(registration.row_schema, rowJsonOf(current)),
          ),
        };
      }
      if (
        typeof from !== "string" ||
        !shardTransitionAllowed(from as never, to as never)
      ) {
        return {
          ok: false,
          error: versionError(String(from), to),
        };
      }
    }
    if (registration.row_schema === "rsi.evd_attempt_row/1") {
      const from = current["state"];
      const to = patch["state"];
      if (typeof to !== "string") {
        return { ok: false, error: schemaError(`${registration.row_schema}.state`, "required") };
      }
      if (from === to) {
        return {
          ok: false,
          error: idempotencyError(
            objectKeyOf(registration, current),
            afterHashOf(registration.row_schema, rowJsonOf(current)),
            afterHashOf(registration.row_schema, rowJsonOf(current)),
          ),
        };
      }
      if (
        typeof from !== "string" ||
        !attemptTransitionAllowed(from as never, to as never)
      ) {
        return {
          ok: false,
          error: versionError(String(from), to),
        };
      }
    }
  }

  const target: SqlRow = { ...current, ...patch, row_version: currentVersion + 1 };
  const normalizedTarget = normalizeCompleteRow(registration, columns, target, "mutation");
  if (!normalizedTarget.ok) {
    return normalizedTarget;
  }
  const row = normalizedTarget.row;

  if (registration.row_schema === "rsi.evd_service_state_row/1") {
    const previousVersion = Number(current["current_profile_version"]);
    const nextVersion = Number(row["current_profile_version"]);
    if (
      !Number.isSafeInteger(nextVersion) ||
      nextVersion <= previousVersion
    ) {
      return {
        ok: false,
        error: makeErrorEnvelope({
          code: "E_SERVICE_STATE_INCONSISTENT",
          category: "conflict",
          retryable: false,
          side_effect: "none",
          message_key: "error.evd.service_state_inconsistent",
          stage: "evd.state_row",
          details: {
            kind: "registry",
            code: "E_SERVICE_STATE_INCONSISTENT",
            details: {
              profile_key: String(row["profile_key"]),
              expected_previous_version: previousVersion,
              current_version: nextVersion,
            },
          },
        }),
      };
    }
    const inconsistent = serviceStateConsistency(connection, row);
    if (inconsistent !== null) {
      return { ok: false, error: inconsistent };
    }
  }

  const prepared = preparePlanned(connection, blobStore, registration, operation, row, current);
  if (!prepared.ok) {
    return prepared;
  }
  return { ok: true, evaluated: { kind: "new", planned: prepared.planned } };
}

/* ------------------------------------------------------------------ */
/* Frame assembly / projection                                         */
/* ------------------------------------------------------------------ */

interface FrameMember {
  readonly member: StateRowBatchMember;
  readonly planned: PlannedRow;
  readonly event_id: string;
}

function buildEvent(planned: PlannedRow, eventId: string, recordedAt: number): Record<string, JsonValue> {
  const eventKey = canonicalHash({
    event_type: "state_row.recorded",
    entity_type: "state_row",
    entity_id: planned.object_key,
    operation: planned.operation,
    before_hash: planned.before_hash,
    after_hash: planned.after_hash,
    binding: bindingAsJson(planned.binding),
    document_id: null,
  });
  return {
    schema_version: "rsi.ledger_event/1",
    event_id: eventId,
    event_key: eventKey,
    event_type: "state_row.recorded",
    entity_type: "state_row",
    entity_id: planned.object_key,
    operation: planned.operation,
    binding: bindingAsJson(planned.binding),
    before_hash: planned.before_hash,
    after_hash: planned.after_hash,
    row_schema: planned.registration.row_schema,
    row_json: planned.row_json,
    document_id: null,
    payload_hash: planned.after_hash,
    recorded_at: recordedAt,
  };
}

function assembleMembers(plannedRows: readonly PlannedRow[], now: number): FrameMember[] {
  return plannedRows.map((planned) => {
    const eventId = newId("ev", now);
    const event = buildEvent(planned, eventId, now);
    return {
      event_id: eventId,
      planned,
      member: {
        event,
        event_hash: canonicalHash(event),
        blob_hashes: [...planned.blob_hashes],
      },
    };
  });
}

function sortMembers(members: readonly FrameMember[]): FrameMember[] {
  return [...members].sort((left, right) => {
    const schema = compareUtf8Bytes(
      left.planned.registration.row_schema,
      right.planned.registration.row_schema,
    );
    if (schema !== 0) {
      return schema;
    }
    return compareUtf8Bytes(left.planned.object_key, right.planned.object_key);
  });
}

function projectMember(connection: SqliteConnection, planned: PlannedRow): void {
  const { registration, row } = planned;
  if (planned.operation === "insert") {
    const columns = Object.keys(row);
    const placeholders = columns.map((column) => `:${column}`).join(", ");
    connection
      .prepare(
        `INSERT INTO ${registration.table} (${columns.join(", ")}) VALUES (${placeholders})`,
      )
      .run(row);
    return;
  }
  const assignments = Object.keys(row)
    .filter((column) => !registration.primary_key.includes(column))
    .map((column) => `${column} = :${column}`);
  const where = registration.primary_key.map((column) => `${column} = :${column}`);
  connection
    .prepare(`UPDATE ${registration.table} SET ${assignments.join(", ")} WHERE ${where.join(" AND ")}`)
    .run(row);
}

function insertLedgerEvent(
  connection: SqliteConnection,
  input: {
    readonly member: FrameMember;
    readonly commit_seq: number;
    readonly journal_id: string;
    readonly recorded_at: number;
  },
): void {
  const event = input.member.member.event as Record<string, unknown>;
  const binding = input.member.planned.binding;
  const bound = binding !== null;
  connection
    .prepare(
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
       )`,
    )
    .run({
      event_id: String(event["event_id"]),
      event_key: String(event["event_key"]),
      commit_seq: input.commit_seq,
      journal_id: input.journal_id,
      event_type: "state_row.recorded",
      entity_type: "state_row",
      entity_id: input.member.planned.object_key,
      operation: input.member.planned.operation,
      binding_mode: bound ? "bound" : "global",
      task_id: bound ? binding.task_id : null,
      branch_id: bound ? binding.branch_id : null,
      input_epoch: bound ? binding.input_epoch : null,
      goal_version: bound ? binding.goal_version : null,
      config_version: bound ? binding.config_version : null,
      watermark: bound ? binding.watermark : null,
      before_hash: input.member.planned.before_hash,
      after_hash: input.member.planned.after_hash,
      row_schema: input.member.planned.registration.row_schema,
      row_json: input.member.planned.row_json,
      document_id: null,
      payload_hash: input.member.planned.after_hash,
      recorded_at: input.recorded_at,
    });
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

/** Serialises the single-writer gate of this adapter, one entry per connection. */
const OPEN_GATES = new WeakSet<SqliteConnection>();

export function createDefaultEvidenceWriter(
  deps: DefaultEvidenceWriterDeps
): DefaultEvidenceWriterBundle {
  const registry = loadRegistry();
  const now = deps.now ?? ((): number => Date.now());
  const columnCache = new Map<string, readonly ColumnInfo[]>();

  function columnsFor(registration: EvdRegistration): readonly ColumnInfo[] {
    const cached = columnCache.get(registration.table);
    if (cached !== undefined) {
      return cached;
    }
    const columns = loadColumns(deps.connection, registration.table);
    columnCache.set(registration.table, columns);
    return columns;
  }

  function registrationFor(rowSchema: string): EvdRegistration | null {
    return registry.get(rowSchema as EvdRowSchema) ?? null;
  }

  const rows: EvdStateRowPort = {
    async appendStateRows(input: EvdAppendRequest): Promise<EvdCommitOutcome> {
      if (OPEN_GATES.has(deps.connection)) {
        return notWritten(schemaError("stage", "nested_evd_append_forbidden"));
      }
      if (input.rows.length === 0) {
        return notWritten(schemaError("rows", "empty_batch"));
      }
      if (input.rows.length > 256) {
        return notWritten(schemaError("rows", "max_256"));
      }
      try {
        deps.connection.exec("BEGIN IMMEDIATE");
      } catch (error) {
        return notWritten(mapSqliteFailure(error, "evd.state_row", "begin_immediate"));
      }
      OPEN_GATES.add(deps.connection);
      try {
        return commitLocked(input);
      } catch (error) {
        try {
          deps.connection.exec("ROLLBACK");
        } catch {
          // Already rolled back or the connection is unusable.
        }
        return isErrorEnvelope(error)
          ? notWritten(error)
          : notWritten(mapSqliteFailure(error, "evd.state_row", "append"));
      } finally {
        OPEN_GATES.delete(deps.connection);
      }
    },
  };

  function commitLocked(input: EvdAppendRequest): EvdCommitOutcome {
    const entries: { write: EvdRowWrite; registration: EvdRegistration }[] = [];
    for (const write of input.rows) {
      const registration = registrationFor(write.row_schema);
      if (registration === null) {
        rollback();
        return notWritten(schemaError(`rows.${write.row_schema}`, "unregistered_row_schema"));
      }
      if (!registration.allowed_operations.includes(write.operation)) {
        rollback();
        return notWritten(schemaError(`rows.${write.row_schema}`, "operation_not_allowed"));
      }
      if (write.document_id !== null) {
        rollback();
        return notWritten(schemaError(`rows.${write.row_schema}`, "document_must_be_null"));
      }
      entries.push({ write, registration });
    }

    const hasBound = entries.some((entry) => entry.registration.binding_source !== "none");
    const hasGlobal = entries.some((entry) => entry.registration.binding_source === "none");
    if (hasBound && hasGlobal) {
      rollback();
      return notWritten(bindingError("global_and_bound_rows_must_not_mix"));
    }
    if (hasGlobal && input.binding !== null) {
      rollback();
      return notWritten(bindingError("global_batch_must_not_carry_binding"));
    }
    if (hasBound && input.binding === null) {
      rollback();
      return notWritten(bindingError("bound_batch_requires_binding"));
    }

    const seenKeys = new Set<string>();
    const seenUnique = new Set<string>();
    const existing: Evaluated[] = [];
    const plannedRows: PlannedRow[] = [];

    for (const entry of entries) {
      const columns = columnsFor(entry.registration);
      if (entry.registration.binding_source === "row" && entry.write.operation === "insert") {
        const raw = isRecord(entry.write.row) ? entry.write.row : null;
        if (raw === null) {
          rollback();
          return notWritten(schemaError(`rows.${entry.write.row_schema}`, "row_is_not_an_object"));
        }
        for (const field of BINDING_FIELDS) {
          if (!(field in raw)) {
            rollback();
            return notWritten(
              versionError("request_binding.six_fields", "row_binding_missing"),
            );
          }
        }
        const own = rowBinding(raw as SqlRow);
        if (own === null || input.binding === null || !equalBindings(own, input.binding)) {
          rollback();
          return notWritten(versionError("request_binding", "row_binding"));
        }
      }

      let evaluated: { ok: true; evaluated: Evaluated } | { ok: false; error: ErrorEnvelope };
      if (entry.write.operation === "insert") {
        evaluated = evaluateInsert(
          deps.connection,
          deps.blob_store,
          entry.registration,
          columns,
          entry.write.row,
        );
      } else {
        evaluated = evaluateMutation(
          deps.connection,
          deps.blob_store,
          entry.registration,
          columns,
          entry.write.operation,
          entry.write.row,
        );
      }
      if (!evaluated.ok) {
        rollback();
        return notWritten(evaluated.error);
      }
      if (evaluated.evaluated.kind === "existing") {
        existing.push(evaluated.evaluated);
        continue;
      }
      const planned = evaluated.evaluated.planned;
      if (seenKeys.has(planned.object_key)) {
        rollback();
        return notWritten(schemaError(`rows.${entry.write.row_schema}`, "duplicate_object_key"));
      }
      seenKeys.add(planned.object_key);
      for (const unique of entry.registration.unique_keys) {
        if (
          entry.registration.row_schema === "rsi.evd_late_result_row/1" &&
          unique.length === 1 &&
          unique[0] === "attempt_id" &&
          planned.row["disposition"] !== "appended_history"
        ) {
          continue;
        }
        const signature = `${entry.registration.table}:${unique
          .map((column) => `${column}=${String(planned.row[column])}`)
          .join("|")}`;
        if (seenUnique.has(signature)) {
          rollback();
          return notWritten(
            idempotencyError(signature, planned.after_hash, planned.after_hash),
          );
        }
        seenUnique.add(signature);
      }
      plannedRows.push(planned);
    }

    if (existing.length > 0) {
      rollback();
      const firstPlanned = plannedRows[0];
      if (firstPlanned === undefined) {
        return { ok: true, commit_state: "existing" };
      }
      return notWritten(
        idempotencyError("batch", firstPlanned.after_hash, firstPlanned.after_hash),
      );
    }

    const recordedAt = now();
    const members = sortMembers(assembleMembers(plannedRows, recordedAt));
    const batchHash = stateRowBatchHash(
      members.map((member) => stateRowBatchMemberHash(member.member)),
    );

    // Every member of an EVD batch is a state row, so the journal's canonical
    // order is (row_schema, entity_id) and each member owns one commit_seq.
    // The state path is part of the re-sync: another writer may have rotated
    // the era, and this writer must not append to the stale segment.
    const journalState = deps.connection
      .prepare<{
        last_commit_seq: number;
        trusted_prefix_end: number;
        relative_path: string;
      }>(
        "SELECT last_commit_seq, trusted_prefix_end, relative_path FROM journal_state WHERE journal_id = :journal_id",
      )
      .get({ journal_id: deps.writer.journalId });
    if (journalState === undefined) {
      deps.writer.resyncFromDisk(deps.writer.lastCommitSeq);
    } else {
      deps.writer.resyncFromDisk(
        Number(journalState.last_commit_seq),
        journalState.relative_path,
        Number(journalState.trusted_prefix_end),
      );
    }
    const append = deps.writer.append({
      schema_version: STATE_ROW_BATCH_SCHEMA_VERSION,
      member_count: members.length,
      batch_hash: batchHash,
      members: members.map((member) => member.member),
    });
    if (!append.ok) {
      rollback();
      return deps.writer.needsRecovery
        ? recoveryRequired(append.error)
        : notWritten(append.error);
    }
    const receipt = append.value;
    const relativePath = receiptRelativePath(deps.relative_path, receipt.file_path);
    if (relativePath === null) {
      deps.writer.markRecoveryRequired();
      rollback();
      return recoveryRequired(
        storageError({
          code: "E_STORAGE_CORRUPT",
          stage: "storage.evidence",
          details: storageDetails("receipt.file_path", "not_a_journal_segment"),
          side_effect: "unknown",
        }),
      );
    }
    try {
      recordFrameDurability(deps.connection, {
        journal_id: receipt.journal_id,
        relative_path: relativePath,
        first_commit_seq: receipt.first_commit_seq,
        member_count: receipt.member_count,
        trusted_prefix_end: receipt.file_offset + receipt.frame_bytes,
        updated_at: recordedAt,
      });
      members.forEach((member, ordinal) => {
        const commitSeq = receipt.first_commit_seq + ordinal;
        insertCommitRecord(deps.connection, {
          journal_id: receipt.journal_id,
          commit_seq: commitSeq,
          event_id: member.event_id,
          payload_hash: member.planned.after_hash,
          blob_hashes_json: canonicalJsonText([...member.planned.blob_hashes]),
          batch_hash: batchHash,
          batch_first_commit_seq: receipt.first_commit_seq,
          batch_ordinal: ordinal,
          committed_at: recordedAt,
          indexed_at: null,
        });
        insertLedgerEvent(deps.connection, {
          member,
          commit_seq: commitSeq,
          journal_id: receipt.journal_id,
          recorded_at: recordedAt,
        });
      });
      // The frame order is canonical (row_schema, entity_id); the physical
      // projection keeps the caller's order so that non-deferred foreign keys
      // inside one compile batch (pack -> plan -> shard -> omission) hold.
      for (const planned of plannedRows) {
        projectMember(deps.connection, planned);
      }
      deps.connection.exec("COMMIT");
    } catch (error) {
      try {
        deps.connection.exec("ROLLBACK");
      } catch {
        // The journal frame stays durable; recovery replays it.
      }
      deps.writer.markRecoveryRequired();
      return recoveryRequired(
        isErrorEnvelope(error)
          ? error
          : mapSqliteFailure(error, "evd.state_row", "project_frame"),
      );
    }
    const committed: EvdAppendReceipt = {
      batch_hash: batchHash,
      first_commit_seq: receipt.first_commit_seq,
      last_commit_seq: receipt.last_commit_seq,
    };
    return { ok: true, commit_state: "committed", receipt: committed };
  }

  function rollback(): void {
    try {
      deps.connection.exec("ROLLBACK");
    } catch {
      // The transaction may already have been rolled back by SQLite.
    }
  }

  const blobs: EvdBlobWritePort = {
    async put(bytes: Uint8Array): Promise<Result<EvdStoredBlob, ErrorEnvelope>> {
      if (bytes.byteLength > MAX_EVD_OBJECT_BYTES) {
        return {
          ok: false,
          status: "rejected",
          error: makeErrorEnvelope({
            code: "E_EVD_OBJECT_TOO_LARGE",
            category: "usage",
            retryable: false,
            side_effect: "none",
            message_key: "error.evd.object_too_large",
            stage: "evd.blob",
            details: {
              kind: "registry",
              code: "E_EVD_OBJECT_TOO_LARGE",
              details: {
                object_type: "content",
                observed: bytes.byteLength,
                limit: MAX_EVD_OBJECT_BYTES,
              },
            },
          }),
        };
      }
      const stored = deps.blob_store.putSync(bytes);
      if (!stored.ok) {
        return stored;
      }
      return {
        ok: true,
        status: "ok",
        value: {
          content_hash: stored.value.hash,
          content_ref: `blob://${stored.value.hash}#bytes=0-${bytes.byteLength}` as SourceRef,
          content_bytes: bytes.byteLength,
        },
      };
    },
  };

  const writer = createEvdStateWriter({ rows, blobs, now });
  return { rows, blobs, writer };
}
