/**
 * Recovery projection for the evidence-domain state rows (DD-EVD-024).
 *
 * The evidence rows are not part of the ledger registry, so the generic
 * recovery projector cannot rebuild them: it never sees their `evd_*` tables,
 * cannot validate their exact physical columns and projects frames in journal
 * (alphabetical) order, which violates the non-deferred evidence foreign keys.
 *
 * This module is the replay half of `recoverJournal`. It copies the frozen
 * `row_json` of each committed evidence member into its real table, in the
 * dependency order of the evidence migration, and fails closed on any
 * divergence: a non-canonical row, a wrong `after_hash`, a `before_hash` that
 * does not match the projected row, a row-level CAS or state-machine
 * violation, a profile version that is not `max + 1`, or an inconsistent
 * `evd_service_state`. Replaying an already projected row is idempotent.
 */

import { readFileSync, } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalHash, canonicalJsonText, type ErrorEnvelope, type Hash, type JsonValue, type Result } from "@evoplug/core";
import {
  attemptTransitionAllowed,
  shardTransitionAllowed,
  type EvdRowSchema
} from "@evoplug/evidence";
import {
  fieldDetails,
  internalDetails,
  payloadEvents,
  storageError,
  type JournalFrameRecord,
  type SqlRow,
  type StatementSource
} from "@evoplug/storage";
import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return sharedIsRecord(value);
}

/* ------------------------------------------------------------------ */
/* Public interface                                                    */
/* ------------------------------------------------------------------ */

/** The synchronous replay hook shape `recoverJournal` consumes. */
type EvidenceRecoveryReplay = (
  source: StatementSource,
  frame: JournalFrameRecord
) => Result<void, ErrorEnvelope>;

/**
 * Builds the synchronous replay hook for `recoverJournal`.
 *
 * The caller must pass `skip_row_schemas: EVD_ROW_SCHEMA_NAMES` so the generic
 * ledger projector does not try to own the same frames.
 */
export function createEvidenceRecoveryReplay(): EvidenceRecoveryReplay {
  const columnCache = new WeakMap<object, Map<string, readonly ColumnInfo[]>>();

  function columnsFor(source: StatementSource, registration: Registration): readonly ColumnInfo[] {
    let byTable = columnCache.get(source);
    if (byTable === undefined) {
      byTable = new Map();
      columnCache.set(source, byTable);
    }
    const cached = byTable.get(registration.table);
    if (cached !== undefined) {
      return cached;
    }
    const columns = readColumns(source, registration.table);
    byTable.set(registration.table, columns);
    return columns;
  }

  return (source, frame) => {
    let events: readonly ParsedEvent[];
    try {
      events = collectEvents(source, frame, columnsFor);
    } catch (error) {
      return {
        ok: false,
        status: "rejected",
        error: failureEnvelope(error)
      };
    }
    if (events.length === 0) {
      return { ok: true, status: "ok", value: undefined };
    }
    try {
      for (const event of events) {
        applyEvent(source, event);
      }
    } catch (error) {
      return {
        ok: false,
        status: "rejected",
        error: failureEnvelope(error)
      };
    }
    return { ok: true, status: "ok", value: undefined };
  };
}

/* ------------------------------------------------------------------ */
/* Evidence-domain registry                                            */
/* ------------------------------------------------------------------ */

interface Allocation {
  readonly field: string;
  readonly scope_fields: readonly string[];
}

interface Registration {
  readonly row_schema: EvdRowSchema;
  readonly table: string;
  readonly primary_key: readonly string[];
  readonly allowed_operations: readonly ("insert" | "update" | "transition")[];
  readonly binding_source: "row" | "none";
  readonly row_versioned: boolean;
  readonly allocation: Allocation | null;
}

const REGISTRY_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "schemas",
  "domains",
  "evidence",
  "state-row-registry.json"
);

const BINDING_FIELDS = [
  "task_id",
  "branch_id",
  "input_epoch",
  "goal_version",
  "config_version",
  "watermark"
] as const;

/**
 * Evidence tables in real FK order. This is deliberately not the journal's
 * canonical order: `evd_omission` must come after `evd_shard_plan`, and the
 * shard transition of one `commitBinding` frame must precede the request
 * binding row it points at.
 */
const PROJECTION_ORDER: readonly string[] = [
  "evd_service_profile",
  "evd_validator_binding",
  "evd_evidence_pack",
  "evd_shard_plan",
  "evd_shard",
  "evd_request_binding",
  "evd_state_manifest",
  "evd_dependency_unit",
  "evd_omission",
  "evd_budget_estimate",
  "evd_attempt",
  "evd_envelope",
  "evd_late_result",
  "evd_aggregate",
  "evd_service_state"
];

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
  evd_aggregate: new Set(["source_blob_refs"])
};

function registryFailure(detail: string): never {
  throw new Error(`EVD recovery registry unavailable: ${detail}`);
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

function loadRegistry(): ReadonlyMap<EvdRowSchema, Registration> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as unknown;
  } catch (error) {
    registryFailure(error instanceof Error ? error.message : "unreadable registry");
  }
  if (!isRecord(parsed)) {
    registryFailure("registry is not an object");
  }
  if (
    parsed["schema_version"] !== "rsi.state_row_registry/1" ||
    parsed["owner_domain"] !== "evd"
  ) {
    registryFailure("unsupported registry header");
  }
  const rows = parsed["rows"];
  if (!Array.isArray(rows) || rows.length !== 15) {
    registryFailure("registry must publish exactly 15 evidence rows");
  }
  const bySchema = new Map<EvdRowSchema, Registration>();
  const tables = new Set<string>();
  for (const raw of rows) {
    if (!isRecord(raw)) {
      registryFailure("row entry is not an object");
    }
    const rowSchema = raw["row_schema"];
    const table = raw["table"];
    if (
      typeof rowSchema !== "string" ||
      !rowSchema.startsWith("rsi.evd_") ||
      typeof table !== "string" ||
      !/^evd_[a-z_]+$/.test(table)
    ) {
      registryFailure("malformed row identity");
    }
    if (tables.has(table)) {
      registryFailure(`duplicate table ${table}`);
    }
    tables.add(table);
    const primaryKey = stringArray(raw["primary_key"]);
    const operations = stringArray(raw["allowed_operations"]);
    const bindingSource = raw["binding_source"];
    if (
      primaryKey === null ||
      primaryKey.length === 0 ||
      operations === null ||
      operations.some(
        (operation) =>
          operation !== "insert" && operation !== "update" && operation !== "transition"
      ) ||
      (bindingSource !== "row" && bindingSource !== "none") ||
      typeof raw["row_versioned"] !== "boolean" ||
      raw["document"] !== null
    ) {
      registryFailure(`malformed row ${rowSchema}`);
    }
    let allocation: Allocation | null = null;
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
        scope.length !== 1 ||
        rawAllocation["rule"] !== "max_plus_one"
      ) {
        registryFailure(`unsupported allocation for ${rowSchema}`);
      }
      allocation = { field, scope_fields: scope };
    }
    bySchema.set(rowSchema as EvdRowSchema, {
      row_schema: rowSchema as EvdRowSchema,
      table,
      primary_key: primaryKey,
      allowed_operations: operations as ("insert" | "update" | "transition")[],
      binding_source: bindingSource,
      row_versioned: raw["row_versioned"],
      allocation
    });
  }
  if (bySchema.size !== PROJECTION_ORDER.length) {
    registryFailure("registry/order size mismatch");
  }
  for (const table of PROJECTION_ORDER) {
    if (!tables.has(table)) {
      registryFailure(`projection order names unknown table ${table}`);
    }
  }
  return bySchema;
}

const REGISTRY = loadRegistry();

/** The exact evidence row schemas owned by the replay hook. */
export const EVD_ROW_SCHEMA_NAMES: readonly string[] = Object.freeze(
  [...REGISTRY.keys()].sort()
);

/* ------------------------------------------------------------------ */
/* Physical table metadata                                             */
/* ------------------------------------------------------------------ */

interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly not_null: boolean;
}

function readColumns(source: StatementSource, table: string): readonly ColumnInfo[] {
  const rows = source.prepare<SqlRow>(`PRAGMA table_info("${table}")`).all();
  if (rows.length === 0) {
    throw schemaFailure(`table.${table}`, "missing");
  }
  return rows.map((row) => ({
    name: String(row["name"]),
    type: String(row["type"]).toUpperCase(),
    not_null: Number(row["notnull"]) === 1
  }));
}

/* ------------------------------------------------------------------ */
/* Typed failures                                                      */
/* ------------------------------------------------------------------ */

class RecoveryFailure extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope) {
    super(envelope.code);
    this.name = "RecoveryFailure";
    this.envelope = envelope;
  }
}

function schemaFailure(path: string, rule: string): RecoveryFailure {
  return new RecoveryFailure(
    storageError({
      code: "E_STATE_ROW_SCHEMA",
      stage: "evd.recovery",
      details: fieldDetails(path, rule),
      message_key: "error.storage.state_row_schema_invalid"
    })
  );
}

function bindingFailure(rule: string): RecoveryFailure {
  return new RecoveryFailure(
    storageError({
      code: "E_STATE_ROW_BINDING",
      stage: "evd.recovery",
      details: fieldDetails("binding", rule),
      message_key: "error.storage.state_row_binding_invalid"
    })
  );
}

function divergence(detail: string): RecoveryFailure {
  return new RecoveryFailure(
    storageError({
      code: "E_REBUILD_DIVERGENCE",
      stage: "evd.recovery",
      details: internalDetails(detail),
      message_key: "error.storage.rebuild_divergence"
    })
  );
}

/** Appendix F.6: report the table and the unique key on a conflicting replay. */
function keyDivergence(
  table: string,
  registration: Registration,
  row: SqlRow,
  detail: string
): RecoveryFailure {
  const key: Record<string, JsonValue> = {};
  for (const column of registration.primary_key) {
    key[column] = row[column] as JsonValue;
  }
  return divergence(
    `state_row_conflict:table=${table};key=${canonicalJsonText(key)};detail=${detail}`
  );
}

function failureEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof RecoveryFailure) {
    return error.envelope;
  }
  const detail = error instanceof Error ? error.message : "unknown recovery failure";
  return storageError({
    code: "E_REBUILD_DIVERGENCE",
    stage: "evd.recovery",
    details: internalDetails(detail),
    message_key: "error.storage.rebuild_divergence"
  });
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

interface ParsedEvent {
  readonly registration: Registration;
  readonly operation: "insert" | "update" | "transition";
  readonly row: SqlRow;
  readonly row_json: string;
  readonly before_hash: Hash | null;
  readonly after_hash: Hash;
  readonly object_key: string;
  readonly binding: Record<string, JsonValue> | null;
}

function asRecordValue(value: JsonValue): Record<string, JsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null;
}

function rowJsonOf(row: unknown): string {
  return canonicalJsonText(row as JsonValue);
}

function afterHashOf(rowSchema: string, rowJson: string): Hash {
  return canonicalHash({ row_schema: rowSchema, row_json: rowJson });
}

function objectKeyOf(registration: Registration, row: SqlRow): string {
  const key: Record<string, JsonValue> = {};
  for (const column of registration.primary_key) {
    key[column] = row[column] as JsonValue;
  }
  return canonicalHash({
    schema_version: "rsi.state_row_key/1",
    row_schema: registration.row_schema,
    key
  });
}

function normalizeRow(
  registration: Registration,
  columns: readonly ColumnInfo[],
  raw: Record<string, JsonValue>,
  operation: "insert" | "update" | "transition"
): SqlRow {
  const expected = new Set(columns.map((column) => column.name));
  for (const name of Object.keys(raw)) {
    if (!expected.has(name)) {
      throw schemaFailure(`${registration.row_schema}.${name}`, "unknown_column");
    }
  }
  const row: SqlRow = {};
  for (const column of columns) {
    if (!(column.name in raw)) {
      throw schemaFailure(`${registration.row_schema}.${column.name}`, "missing_column");
    }
    const value = raw[column.name];
    if (value === null) {
      if (column.not_null) {
        throw schemaFailure(`${registration.row_schema}.${column.name}`, "not_null");
      }
      row[column.name] = null;
      continue;
    }
    if (column.type.includes("INT")) {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw schemaFailure(`${registration.row_schema}.${column.name}`, "integer");
      }
      row[column.name] = value;
      continue;
    }
    if (typeof value !== "string") {
      throw schemaFailure(`${registration.row_schema}.${column.name}`, "text");
    }
    if (JSON_TEXT_COLUMNS[registration.table]?.has(column.name) === true) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(value) as unknown;
      } catch {
        throw schemaFailure(`${registration.table}.${column.name}`, "json_text");
      }
      if (!isRecord(parsedJson) && !Array.isArray(parsedJson)) {
        throw schemaFailure(`${registration.table}.${column.name}`, "json_text");
      }
      if (canonicalJsonText(parsedJson as JsonValue) !== value) {
        throw divergence(`${registration.table}.${column.name}.non_canonical_json`);
      }
    }
    row[column.name] = value;
  }
  const rowVersion = row["row_version"];
  if (
    typeof rowVersion !== "number" ||
    !Number.isSafeInteger(rowVersion) ||
    rowVersion < 0
  ) {
    throw schemaFailure(`${registration.row_schema}.row_version`, "integer");
  }
  if (operation === "insert" && rowVersion !== 0) {
    throw divergence(`${registration.row_schema}.row_version.insert_not_zero`);
  }
  for (const column of registration.primary_key) {
    const value = row[column];
    if (value === null || value === undefined) {
      throw schemaFailure(`${registration.row_schema}.${column}`, "primary_key_null");
    }
  }
  return row;
}

function rowBindingOf(registration: Registration, row: SqlRow): Record<string, JsonValue> | null {
  if (registration.binding_source === "none") {
    return null;
  }
  const binding: Record<string, JsonValue> = {};
  for (const field of BINDING_FIELDS) {
    const value = row[field];
    if (
      (field === "input_epoch" || field === "watermark")
        ? typeof value !== "number" || !Number.isSafeInteger(value)
        : typeof value !== "string"
    ) {
      throw bindingFailure(`row.${field}`);
    }
    binding[field] = value as JsonValue;
  }
  return binding;
}

function equalBindings(
  right: Record<string, JsonValue>,
  left: Record<string, JsonValue>
): boolean {
  for (const field of BINDING_FIELDS) {
    if (right[field] !== left[field]) {
      return false;
    }
  }
  return true;
}

function parseEvent(
  source: StatementSource,
  raw: JsonValue,
  columnsFor: (source: StatementSource, registration: Registration) => readonly ColumnInfo[]
): ParsedEvent | null {
  const record = asRecordValue(raw);
  if (record === null) {
    return null;
  }
  const rowSchema = record["row_schema"];
  if (typeof rowSchema !== "string" || !rowSchema.startsWith("rsi.evd_")) {
    return null;
  }
  const registration = REGISTRY.get(rowSchema as EvdRowSchema);
  if (registration === undefined) {
    throw schemaFailure(`rows.${rowSchema}`, "unregistered_row_schema");
  }
  if (
    record["schema_version"] !== "rsi.ledger_event/1" ||
    record["event_type"] !== "state_row.recorded" ||
    record["entity_type"] !== "state_row"
  ) {
    throw schemaFailure(`rows.${rowSchema}`, "ledger_event_shape");
  }
  const operation = record["operation"];
  if (
    operation !== "insert" &&
    operation !== "update" &&
    operation !== "transition"
  ) {
    throw schemaFailure(`rows.${rowSchema}.operation`, "operation");
  }
  if (!registration.allowed_operations.includes(operation)) {
    throw schemaFailure(`rows.${rowSchema}`, "operation_not_allowed");
  }
  const rowJson = record["row_json"];
  const afterHash = record["after_hash"];
  const entityId = record["entity_id"];
  if (
    typeof rowJson !== "string" ||
    typeof afterHash !== "string" ||
    typeof entityId !== "string" ||
    record["document_id"] !== null
  ) {
    throw schemaFailure(`rows.${rowSchema}`, "ledger_event_fields");
  }
  const computedAfter = afterHashOf(rowSchema, rowJson);
  if (computedAfter !== afterHash) {
    throw divergence(`${rowSchema}.after_hash`);
  }
  let parsedRow: unknown;
  try {
    parsedRow = JSON.parse(rowJson) as unknown;
  } catch {
    throw divergence(`${rowSchema}.row_json_not_json`);
  }
  if (!isRecord(parsedRow)) {
    throw divergence(`${rowSchema}.row_json_not_object`);
  }
  if (canonicalJsonText(parsedRow as JsonValue) !== rowJson) {
    throw divergence(`${rowSchema}.row_json_not_canonical`);
  }
  const columns = columnsFor(source, registration);
  const row = normalizeRow(
    registration,
    columns,
    parsedRow as Record<string, JsonValue>,
    operation
  );
  if (objectKeyOf(registration, row) !== entityId) {
    throw divergence(`${rowSchema}.entity_id`);
  }
  const expectedBinding = rowBindingOf(registration, row);
  const frozenBinding = record["binding"];
  if (expectedBinding === null) {
    if (frozenBinding !== null) {
      throw bindingFailure("global_row_carries_binding");
    }
  } else {
    const frozen = asRecordValue(frozenBinding as JsonValue);
    if (
      frozen === null ||
      Object.keys(frozen).length !== BINDING_FIELDS.length ||
      !equalBindings(frozen, expectedBinding)
    ) {
      throw bindingFailure("row_binding");
    }
  }
  const beforeRaw = record["before_hash"];
  const beforeHash = typeof beforeRaw === "string" ? (beforeRaw as Hash) : null;
  if (operation === "insert" && beforeRaw !== null) {
    throw divergence(`${rowSchema}.insert_before_hash`);
  }
  if (operation !== "insert" && beforeHash === null) {
    throw divergence(`${rowSchema}.mutation_before_hash_missing`);
  }
  return {
    registration,
    operation,
    row,
    row_json: rowJson,
    before_hash: beforeHash,
    after_hash: afterHash as Hash,
    object_key: entityId,
    binding: expectedBinding
  };
}

function collectEvents(
  source: StatementSource,
  frame: JournalFrameRecord,
  columnsFor: (source: StatementSource, registration: Registration) => readonly ColumnInfo[]
): ParsedEvent[] {
  const events: { readonly event: ParsedEvent; readonly index: number }[] = [];
  let index = 0;
  for (const raw of payloadEvents(frame.payload)) {
    const event = parseEvent(source, raw, columnsFor);
    if (event !== null) {
      events.push({ event, index });
    }
    index += 1;
  }
  events.sort((left, right) => {
    const leftRank = PROJECTION_ORDER.indexOf(left.event.registration.table);
    const rightRank = PROJECTION_ORDER.indexOf(right.event.registration.table);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    // Profiles in one frame must be projected by ascending version so the
    // max_plus_one check sees the previous version.
    const allocation = left.event.registration.allocation;
    if (allocation !== null) {
      const leftValue = left.event.row[allocation.field];
      const rightValue = right.event.row[allocation.field];
      if (typeof leftValue === "number" && typeof rightValue === "number") {
        return leftValue - rightValue;
      }
    }
    return left.index - right.index;
  });
  return events.map((entry) => entry.event);
}

/* ------------------------------------------------------------------ */
/* Projection                                                          */
/* ------------------------------------------------------------------ */

function readPrimary(source: StatementSource, event: ParsedEvent): SqlRow | null {
  const params: Record<string, unknown> = {};
  const clauses: string[] = [];
  for (const column of event.registration.primary_key) {
    params[column] = event.row[column];
    clauses.push(`${column} = :${column}`);
  }
  const found = source
    .prepare<SqlRow>(
      `SELECT * FROM ${event.registration.table} WHERE ${clauses.join(" AND ")}`
    )
    .get(params);
  return found ?? null;
}

function maxProfileVersion(source: StatementSource, profileKey: string): number | null {
  const found = source
    .prepare<{ max_version: number | null }>(
      "SELECT MAX(profile_version) AS max_version FROM evd_service_profile WHERE profile_key = :profile_key"
    )
    .get({ profile_key: profileKey });
  const value = found?.max_version;
  return typeof value === "number" ? value : null;
}

function requireProfileAllocation(source: StatementSource, event: ParsedEvent): void {
  const allocation = event.registration.allocation;
  if (allocation === null) {
    return;
  }
  const field = allocation.field;
  const scopeField = allocation.scope_fields[0];
  const requested = event.row[field];
  const scopeValue = scopeField === undefined ? undefined : event.row[scopeField];
  if (
    typeof requested !== "number" ||
    !Number.isSafeInteger(requested) ||
    typeof scopeValue !== "string"
  ) {
    throw divergence(`${event.registration.row_schema}.profile_identity`);
  }
  const maximum = maxProfileVersion(source, scopeValue);
  if (requested !== (maximum ?? 0) + 1) {
    throw divergence(
      `${event.registration.row_schema}.profile_version:${String(maximum)}:${requested}`
    );
  }
}

function requireServiceStateConsistency(source: StatementSource, event: ParsedEvent): void {
  const row = event.row;
  const profileKey = row["profile_key"];
  const version = row["current_profile_version"];
  const profileId = row["current_profile_id"];
  if (
    typeof profileKey !== "string" ||
    typeof version !== "number" ||
    typeof profileId !== "string"
  ) {
    throw divergence(`${event.registration.row_schema}.profile_identity`);
  }
  const maximum = maxProfileVersion(source, profileKey);
  if (maximum !== version) {
    throw divergence(
      `${event.registration.row_schema}.profile_version:${String(maximum)}:${version}`
    );
  }
  const profile = source
    .prepare<SqlRow>(
      "SELECT profile_id, acceptance_status FROM evd_service_profile WHERE profile_key = :profile_key AND profile_version = :profile_version"
    )
    .get({ profile_key: profileKey, profile_version: version });
  if (
    profile === undefined ||
    profile["profile_id"] !== profileId ||
    profile["acceptance_status"] !== row["acceptance_status"]
  ) {
    throw divergence(`${event.registration.row_schema}.profile_consistency`);
  }
}

function requireTransition(event: ParsedEvent, current: SqlRow): void {
  if (event.operation !== "transition") {
    return;
  }
  if (event.registration.row_schema === "rsi.evd_shard_row/1") {
    const from = current["status"];
    const to = event.row["status"];
    if (typeof from !== "string" || typeof to !== "string" || from === to) {
      throw divergence("rsi.evd_shard_row/1.status");
    }
    if (!shardTransitionAllowed(from as never, to as never)) {
      throw divergence(`rsi.evd_shard_row/1.transition:${from}:${to}`);
    }
    return;
  }
  if (event.registration.row_schema === "rsi.evd_attempt_row/1") {
    const from = current["state"];
    const to = event.row["state"];
    if (typeof from !== "string" || typeof to !== "string" || from === to) {
      throw divergence("rsi.evd_attempt_row/1.state");
    }
    if (!attemptTransitionAllowed(from as never, to as never)) {
      throw divergence(`rsi.evd_attempt_row/1.transition:${from}:${to}`);
    }
  }
}

function insertRow(source: StatementSource, event: ParsedEvent): void {
  const columns = Object.keys(event.row);
  const placeholders = columns.map((column) => `:${column}`).join(", ");
  source
    .prepare(
      `INSERT INTO ${event.registration.table} (${columns.join(", ")}) VALUES (${placeholders})`
    )
    .run(event.row);
}

function updateRow(source: StatementSource, event: ParsedEvent): void {
  const assignments = Object.keys(event.row)
    .filter((column) => !event.registration.primary_key.includes(column))
    .map((column) => `${column} = :${column}`);
  const where = event.registration.primary_key.map((column) => `${column} = :${column}`);
  source
    .prepare(
      `UPDATE ${event.registration.table} SET ${assignments.join(", ")} WHERE ${where.join(" AND ")}`
    )
    .run(event.row);
}

function applyEvent(source: StatementSource, event: ParsedEvent): void {
  const existing = readPrimary(source, event);
  if (existing !== null) {
    const currentJson = rowJsonOf(existing);
    if (currentJson === event.row_json) {
      // The frame was already projected by the failed commit or by an earlier
      // recovery pass. The frozen row is byte-identical: idempotent.
      return;
    }
    if (event.operation === "insert") {
      throw keyDivergence(
        event.registration.table,
        event.registration,
        event.row,
        "insert_conflicts_existing"
      );
    }
  }
  if (event.operation === "insert") {
    requireProfileAllocation(source, event);
    if (event.registration.row_schema === "rsi.evd_service_state_row/1") {
      requireServiceStateConsistency(source, event);
    }
    insertRow(source, event);
    return;
  }

  if (existing === null) {
    throw divergence(`${event.registration.row_schema}.mutation_target_missing`);
  }
  const currentJson = rowJsonOf(existing);
  const currentHash = afterHashOf(event.registration.row_schema, currentJson);
  if (event.before_hash !== currentHash) {
    throw keyDivergence(
      event.registration.table,
      event.registration,
      event.row,
      "before_hash"
    );
  }
  const currentVersion = Number(existing["row_version"]);
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 0) {
    throw divergence(`${event.registration.row_schema}.row_version.stored`);
  }
  if (
    event.registration.row_versioned &&
    Number(event.row["row_version"]) !== currentVersion + 1
  ) {
    throw divergence(`${event.registration.row_schema}.row_version.step`);
  }
  requireTransition(event, existing);
  if (event.registration.row_schema === "rsi.evd_service_state_row/1") {
    const previousVersion = Number(existing["current_profile_version"]);
    const nextVersion = Number(event.row["current_profile_version"]);
    if (
      !Number.isSafeInteger(nextVersion) ||
      !Number.isSafeInteger(previousVersion) ||
      nextVersion <= previousVersion
    ) {
      throw divergence("rsi.evd_service_state_row/1.profile_version_regression");
    }
    requireServiceStateConsistency(source, event);
  }
  updateRow(source, event);
}
