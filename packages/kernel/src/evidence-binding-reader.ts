/**
 * FND-side `EvidenceBindingReadPort` for the EVD `/3` binding path
 * (DD-EVD-015, DD-EVD-016A, DD-EVD-019, DD-EVD-024, DD-EVD-026).
 *
 * `EvidenceCompiler.buildRequest` never accepts caller-supplied temporary
 * objects. This adapter loads the persisted EVD rows named by `BindingInput`
 * through the single-writer SQLite connection, resolves each `content_ref`
 * through the content-addressed blob store, verifies `content_hash` /
 * `content_bytes` / canonical JSON, and returns the decoded object next to its
 * physical row.
 *
 * Missing rows are `null`; corrupt, mismatched or unreadable rows are a typed
 * `Err`. No method fabricates a default object.
 */

import { canonicalJsonText, hashBytes, isHash, makeErrorEnvelope, parseSourceRef, type ErrorEnvelope, type Hash, type Id, type JsonValue, type Result, type SourceRef, type SourceRefPort, type VersionBinding } from "@evoplug/core";
import { err, ok } from "@evoplug/core";
import type { PackCompilerDeps } from "@evoplug/evidence";
import {
  evdError,
  stateContentHash,
  stateHashOf,
  type DependencyUnit,
  type EvdDependencyUnitRow,
  type EvdEvidencePackRow,
  type EvdServiceProfileRow,
  type EvdShardPlanRow,
  type EvdShardRow,
  type EvdStateManifestRow,
  type EvdValidatorBindingRow,
  type EvidencePack,
  type JevServiceProfile,
  type JudgeState,
  type JudgeStateManifest,
  type SemanticBackendCapability,
  type SemanticValidationBinding,
  type Shard,
  type ShardPlan,
  type ValidatorBinding,
} from "@evoplug/evidence";
import type { SqliteConnection, SqlRow } from "@evoplug/storage";
import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return sharedIsRecord(value);
}

/**
 * The persisted-row contract from `@evoplug/evidence`. It is re-derived from
 * the compiler dependency instead of a second structural copy because the
 * package does not publish the `binding-reader` subpath.
 */
export type EvidenceBindingReadPort = NonNullable<PackCompilerDeps["binding"]>;

/** Read-only blob source; the concrete kernel blob store satisfies it. */
interface EvidenceBindingBlobSource {
  read(hash: Hash): Result<Uint8Array, ErrorEnvelope>;
}

export interface EvidenceBindingReadPortDeps {
  /** The open single-writer connection owned by the kernel composition root. */
  readonly connection: SqliteConnection;
  /** Content-addressed blob store used by EVD `content_ref` rows. */
  readonly blobs: EvidenceBindingBlobSource;
  /**
   * Optional resolver for non-blob (journal) source refs. Without it
   * `verifySourceRefs` can only confirm blob refs and returns `false` when a
   * journal ref is present.
   */
  readonly sources?: Pick<SourceRefPort, "resolve">;
}

/* ------------------------------------------------------------------ */
/* Typed read failures                                                 */
/* ------------------------------------------------------------------ */

class ReadFailure extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope) {
    super(envelope.code);
    this.name = "ReadFailure";
    this.envelope = envelope;
  }
}

function fail(envelope: ErrorEnvelope): never {
  throw new ReadFailure(envelope);
}

function stateRowError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_STATE_ROW_SCHEMA",
    category: "schema",
    retryable: false,
    side_effect: "none",
    message_key: "error.state_row.schema",
    stage: "state_row_read",
    details: { kind: "field", path, rule },
  });
}

function bindingError(_field: string, expected: string, actual: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_VERSION_BINDING",
    category: "version",
    retryable: false,
    side_effect: "none",
    message_key: "error.version.binding",
    stage: "binding",
    details: { kind: "version", expected, actual },
  });
}

function contentError(contentRef: SourceRef, expected: string, actual: string): ErrorEnvelope {
  return evdError("E_CONTENT_HASH_MISMATCH", {
    content_ref: contentRef,
    expected,
    actual,
  });
}

async function readResult<T>(
  read: () => T | Promise<T>
): Promise<Result<T, ErrorEnvelope>> {
  try {
    return ok(await read());
  } catch (error: unknown) {
    if (error instanceof ReadFailure) {
      return err(error.envelope);
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Row decoding                                                        */
/* ------------------------------------------------------------------ */

function stringField(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    fail(stateRowError(key, "string_required"));
  }
  return value;
}

function numberField(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(stateRowError(key, "safe_integer_required"));
  }
  return value;
}

function booleanField(row: SqlRow, key: string): boolean {
  const value = numberField(row, key);
  if (value !== 0 && value !== 1) {
    fail(stateRowError(key, "boolean_integer_required"));
  }
  return value === 1;
}

function nullableStringField(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    fail(stateRowError(key, "nullable_string_required"));
  }
  return value;
}

function nullableIdField(row: SqlRow, key: string): Id | null {
  const value = nullableStringField(row, key);
  if (value === null) {
    return null;
  }
  if (value.length === 0) {
    fail(stateRowError(key, "non_empty_id"));
  }
  return value as Id;
}

function hashField(row: SqlRow, key: string): Hash {
  const value = stringField(row, key);
  if (!isHash(value)) {
    fail(stateRowError(key, "sha256_full_hash"));
  }
  return value;
}

function idField(row: SqlRow, key: string): Id {
  const value = stringField(row, key);
  if (value.length === 0) {
    fail(stateRowError(key, "non_empty_id"));
  }
  return value as Id;
}

function sourceRefField(row: SqlRow, key: string): SourceRef {
  const value = stringField(row, key);
  const parsed = parseSourceRef(value);
  if (!parsed.ok) {
    fail(parsed.error);
  }
  return parsed.value.source_ref;
}

function jsonArrayField(row: SqlRow, key: string): unknown[] {
  const text = stringField(row, key);
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    fail(stateRowError(key, "json_array"));
  }
  if (!Array.isArray(decoded)) {
    fail(stateRowError(key, "json_array"));
  }
  return decoded;
}

function stringArrayField(row: SqlRow, key: string): string[] {
  const values: string[] = [];
  for (const entry of jsonArrayField(row, key)) {
    if (typeof entry !== "string") {
      fail(stateRowError(key, "string_array"));
    }
    values.push(entry);
  }
  return values;
}

function sourceRefArrayField(row: SqlRow, key: string): SourceRef[] {
  const values: SourceRef[] = [];
  for (const entry of stringArrayField(row, key)) {
    const parsed = parseSourceRef(entry);
    if (!parsed.ok) {
      fail(parsed.error);
    }
    values.push(parsed.value.source_ref);
  }
  return values;
}

function jsonObjectField(row: SqlRow, key: string): unknown {
  const text = stringField(row, key);
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    fail(stateRowError(key, "json_object"));
  }
  if (!isRecord(decoded)) {
    fail(stateRowError(key, "json_object"));
  }
  return decoded;
}

function schemaVersionOf(value: unknown, path: string): string {
  if (!isRecord(value) || typeof value["schema_version"] !== "string") {
    fail(stateRowError(path, "schema_version_required"));
  }
  return value["schema_version"];
}

function bindingOf(row: SqlRow): VersionBinding {
  return {
    task_id: idField(row, "task_id") as VersionBinding["task_id"],
    branch_id: idField(row, "branch_id") as VersionBinding["branch_id"],
    input_epoch: numberField(row, "input_epoch"),
    goal_version: stringField(row, "goal_version"),
    config_version: stringField(row, "config_version"),
    watermark: numberField(row, "watermark"),
  };
}

function assertBinding(row: SqlRow, expected: VersionBinding, field: string): void {
  const persisted = bindingOf(row);
  // `watermark` is the write-time snapshot and is allowed to lag the runtime
  // watermark; the compiler applies its own staleness rule against the pack.
  // The five identity axes must match exactly.
  if (
    persisted.task_id !== expected.task_id ||
    persisted.branch_id !== expected.branch_id ||
    persisted.input_epoch !== expected.input_epoch ||
    persisted.goal_version !== expected.goal_version ||
    persisted.config_version !== expected.config_version
  ) {
    fail(bindingError(field, JSON.stringify(expected), JSON.stringify(persisted)));
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

/* ------------------------------------------------------------------ */
/* Content blobs                                                       */
/* ------------------------------------------------------------------ */

interface ContentMetaRow {
  readonly content_hash: Hash;
  readonly content_ref: SourceRef;
  readonly content_bytes: number;
}

function contentMetaOf(row: SqlRow): ContentMetaRow {
  return {
    content_hash: hashField(row, "content_hash"),
    content_ref: sourceRefField(row, "content_ref"),
    content_bytes: numberField(row, "content_bytes"),
  };
}

/**
 * Resolves `content_ref`, verifies the byte range, the SHA-256 of the bytes,
 * `content_bytes`, UTF-8 decoding and canonical JSON, then returns the parsed
 * value.
 */
function decodeContent(
  blobs: EvidenceBindingBlobSource,
  meta: ContentMetaRow
): unknown {
  const parsedRef = parseSourceRef(meta.content_ref);
  if (!parsedRef.ok) {
    fail(parsedRef.error);
  }
  if (parsedRef.value.scheme !== "blob") {
    fail(stateRowError("content_ref", "blob_scheme"));
  }
  if (
    parsedRef.value.start !== 0 ||
    parsedRef.value.end !== meta.content_bytes
  ) {
    fail(
      contentError(
        meta.content_ref,
        `bytes=0-${String(meta.content_bytes)}`,
        `bytes=${String(parsedRef.value.start)}-${String(parsedRef.value.end)}`
      )
    );
  }
  const locator = parsedRef.value.locator;
  if (!isHash(locator)) {
    fail(stateRowError("content_ref.locator", "sha256_full_hash"));
  }
  const read = blobs.read(locator);
  if (!read.ok) {
    fail(read.error);
  }
  const bytes = read.value;
  if (bytes.byteLength !== meta.content_bytes) {
    fail(
      contentError(
        meta.content_ref,
        String(meta.content_bytes),
        String(bytes.byteLength)
      )
    );
  }
  const recomputed = hashBytes(bytes);
  if (recomputed !== meta.content_hash) {
    fail(contentError(meta.content_ref, recomputed, meta.content_hash));
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(stateRowError("content_ref", "utf8"));
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    fail(stateRowError("content_ref", "json"));
  }
  let canonical: string;
  try {
    canonical = canonicalJsonText(decoded as JsonValue);
  } catch {
    fail(stateRowError("content_ref", "json_value"));
  }
  if (canonical !== text) {
    fail(stateRowError("content_ref", "canonical_json"));
  }
  return decoded;
}

/* ------------------------------------------------------------------ */
/* SQL helpers                                                         */
/* ------------------------------------------------------------------ */

function oneRow(
  connection: SqliteConnection,
  sql: string,
  params?: Readonly<Record<string, string | number | null>>
): SqlRow | null {
  const row = connection.prepare<SqlRow>(sql).get(params);
  return row === undefined ? null : row;
}

function allRows(
  connection: SqliteConnection,
  sql: string,
  params?: Readonly<Record<string, string | number | null>>
): SqlRow[] {
  return connection.prepare<SqlRow>(sql).all(params);
}

/* ------------------------------------------------------------------ */
/* Row constructors                                                    */
/* ------------------------------------------------------------------ */

function packRowOf(row: SqlRow): EvdEvidencePackRow {
  return {
    ...bindingOf(row),
    row_version: numberField(row, "row_version"),
    created_at: numberField(row, "created_at"),
    ...contentMetaOf(row),
    source_blob_refs: sourceRefArrayField(row, "source_blob_refs"),
    pack_id: idField(row, "pack_id"),
    pack_key: hashField(row, "pack_key"),
    pack_hash: hashField(row, "pack_hash"),
    evidence_hash: hashField(row, "evidence_hash"),
    plan_id: idField(row, "plan_id"),
    plan_hash: hashField(row, "plan_hash"),
    issue_id: idField(row, "issue_id"),
    issue_key: stringField(row, "issue_key"),
    pack_state: packStateOf(row),
  };
}

function packStateOf(row: SqlRow): EvdEvidencePackRow["pack_state"] {
  const value = stringField(row, "pack_state");
  if (value !== "valid" && value !== "invalidated") {
    fail(stateRowError("pack_state", "valid_or_invalidated"));
  }
  return value;
}

function shardPlanRowOf(row: SqlRow): EvdShardPlanRow {
  return {
    ...bindingOf(row),
    row_version: numberField(row, "row_version"),
    created_at: numberField(row, "created_at"),
    ...contentMetaOf(row),
    source_blob_refs: sourceRefArrayField(row, "source_blob_refs"),
    shard_plan_id: idField(row, "shard_plan_id"),
    shard_plan_key: hashField(row, "shard_plan_key"),
    shard_plan_hash: hashField(row, "shard_plan_hash"),
    plan_id: idField(row, "plan_id"),
    plan_hash: hashField(row, "plan_hash"),
    issue_id: idField(row, "issue_id"),
    pack_id: idField(row, "pack_id"),
    pack_key: hashField(row, "pack_key"),
    service_profile_id: idField(row, "service_profile_id"),
    service_profile_key: hashField(row, "service_profile_key"),
    state: shardPlanStateOf(row),
  };
}

function shardPlanStateOf(row: SqlRow): EvdShardPlanRow["state"] {
  const value = stringField(row, "state");
  if (
    value !== "planned" &&
    value !== "partially_rejected" &&
    value !== "bound" &&
    value !== "dispatched" &&
    value !== "completed" &&
    value !== "rejected"
  ) {
    fail(stateRowError("state", "shard_plan_state"));
  }
  return value;
}

function shardRowOf(row: SqlRow): EvdShardRow {
  return {
    ...bindingOf(row),
    row_version: numberField(row, "row_version"),
    created_at: numberField(row, "created_at"),
    shard_id: idField(row, "shard_id"),
    shard_plan_id: idField(row, "shard_plan_id"),
    shard_plan_key: hashField(row, "shard_plan_key"),
    shard_key: hashField(row, "shard_key"),
    shard_order: numberField(row, "shard_order"),
    status: shardStatusOf(row),
    request_binding_id: nullableIdField(row, "request_binding_id"),
    attempt_ids: stringArrayField(row, "attempt_ids") as Id[],
    envelope_keys: stringArrayField(row, "envelope_keys") as Hash[],
    reason_codes: stringArrayField(row, "reason_codes"),
    body_json: jsonObjectField(row, "body_json") as Shard,
  };
}

function shardStatusOf(row: SqlRow): EvdShardRow["status"] {
  const value = stringField(row, "status");
  const allowed = [
    "planned",
    "deterministic_skip",
    "budget_rejected",
    "projection_rejected",
    "bound",
    "sent",
    "accepted",
    "degraded",
    "unknown",
    "cancelled",
  ] as const;
  const match = allowed.find((entry) => entry === value);
  if (match === undefined) {
    fail(stateRowError("status", "shard_status"));
  }
  return match;
}

function manifestRowOf(row: SqlRow): EvdStateManifestRow {
  return {
    ...bindingOf(row),
    row_version: numberField(row, "row_version"),
    created_at: numberField(row, "created_at"),
    ...contentMetaOf(row),
    source_blob_refs: sourceRefArrayField(row, "source_blob_refs"),
    manifest_id: idField(row, "manifest_id"),
    manifest_key: hashField(row, "manifest_key"),
    manifest_hash: hashField(row, "manifest_hash"),
    shard_id: idField(row, "shard_id"),
    shard_key: hashField(row, "shard_key"),
    plan_id: idField(row, "plan_id"),
    plan_hash: hashField(row, "plan_hash"),
    pack_key: hashField(row, "pack_key"),
    state_hash: hashField(row, "state_hash"),
    state_content_hash: hashField(row, "state_content_hash"),
  };
}

function unitRowOf(row: SqlRow): EvdDependencyUnitRow {
  return {
    ...bindingOf(row),
    row_version: numberField(row, "row_version"),
    created_at: numberField(row, "created_at"),
    ...contentMetaOf(row),
    source_blob_refs: sourceRefArrayField(row, "source_blob_refs"),
    unit_id: idField(row, "unit_id"),
    unit_key: hashField(row, "unit_key"),
    unit_hash: hashField(row, "unit_hash"),
    plan_id: idField(row, "plan_id"),
    plan_hash: hashField(row, "plan_hash"),
    pack_id: idField(row, "pack_id"),
    pack_key: hashField(row, "pack_key"),
    dependency_key: stringField(row, "dependency_key"),
    inseparable_group_key: stringField(row, "inseparable_group_key"),
    transport_role: transportRoleOf(row),
  };
}

function transportRoleOf(row: SqlRow): EvdDependencyUnitRow["transport_role"] {
  const value = stringField(row, "transport_role");
  const allowed = [
    "requirement",
    "feedback",
    "artifact",
    "verifier",
    "counter",
    "history",
    "context",
  ] as const;
  const match = allowed.find((entry) => entry === value);
  if (match === undefined) {
    fail(stateRowError("transport_role", "transport_role"));
  }
  return match;
}

function serviceProfileRowOf(row: SqlRow): EvdServiceProfileRow {
  const body = jsonObjectField(row, "body_json");
  const schema = schemaVersionOf(body, "body_json.schema_version");
  if (
    schema !== "rsi.jev_service_profile/1" &&
    schema !== "rsi.semantic_backend_capability/1"
  ) {
    fail(stateRowError("body_json.schema_version", "service_profile_schema"));
  }
  return {
    row_version: numberField(row, "row_version"),
    created_at: numberField(row, "created_at"),
    profile_id: idField(row, "profile_id"),
    profile_key: hashField(row, "profile_key"),
    profile_version: numberField(row, "profile_version"),
    acceptance_status: acceptanceStatusOf(row),
    production_use: booleanField(row, "production_use"),
    body_json: body as JevServiceProfile | SemanticBackendCapability,
  };
}

function acceptanceStatusOf(row: SqlRow): EvdServiceProfileRow["acceptance_status"] {
  const value = stringField(row, "acceptance_status");
  if (value !== "eligible" && value !== "shadow_only" && value !== "blocked") {
    fail(stateRowError("acceptance_status", "acceptance_status"));
  }
  return value;
}

function validatorBindingRowOf(row: SqlRow): EvdValidatorBindingRow {
  const body = jsonObjectField(row, "body_json");
  const schema = schemaVersionOf(body, "body_json.schema_version");
  if (
    schema !== "rsi.judge.validator_binding/1" &&
    schema !== "rsi.semantic_validation_binding/1"
  ) {
    fail(stateRowError("body_json.schema_version", "validator_binding_schema"));
  }
  return {
    row_version: numberField(row, "row_version"),
    created_at: numberField(row, "created_at"),
    validator_binding_id: idField(row, "validator_binding_id"),
    validator_binding_key: hashField(row, "validator_binding_key"),
    validator_policy_hash: hashField(row, "validator_policy_hash"),
    service_profile_key: hashField(row, "service_profile_key"),
    body_json: body as ValidatorBinding | SemanticValidationBinding,
  };
}

/* ------------------------------------------------------------------ */
/* Judge state lookup                                                  */
/* ------------------------------------------------------------------ */

function stateFromDocument(
  connection: SqliteConnection,
  stateHash: Hash,
  stateContent: Hash
): JudgeState | null {
  const row = oneRow(
    connection,
    `SELECT canonical_json
       FROM object_document
      WHERE content_hash = :content_hash
      ORDER BY revision DESC
      LIMIT 1`,
    { content_hash: stateHash }
  );
  if (row === null) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(stringField(row, "canonical_json"));
  } catch {
    fail(stateRowError("object_document.canonical_json", "json"));
  }
  if (!isRecord(decoded)) {
    fail(stateRowError("object_document.canonical_json", "json_object"));
  }
  const schema = schemaVersionOf(decoded, "object_document.schema_version");
  const document: unknown = decoded;
  const contentMatches =
    schema === "rsi.judge_state/1"
      ? true
      : stateContentHash(decoded as JsonValue) === stateContent;
  if (stateHashOf(decoded as JsonValue) !== stateHash || !contentMatches) {
    return null;
  }
  return document as JudgeState;
}

function stateFromRequestBinding(
  connection: SqliteConnection,
  blobs: EvidenceBindingBlobSource,
  q: {
    binding: VersionBinding;
    shard_id: Id;
    shard_key: Hash;
    state_hash: Hash;
    state_content_hash: Hash;
  }
): JudgeState | null {
  const row = oneRow(
    connection,
    `SELECT *
       FROM evd_request_binding
      WHERE shard_id = :shard_id
        AND shard_key = :shard_key
        AND state_hash = :state_hash
        AND state_content_hash = :state_content_hash
      ORDER BY created_at DESC
      LIMIT 1`,
    {
      shard_id: q.shard_id,
      shard_key: q.shard_key,
      state_hash: q.state_hash,
      state_content_hash: q.state_content_hash,
    }
  );
  if (row === null) {
    return null;
  }
  assertBinding(row, q.binding, "request_binding.binding");
  const decoded = decodeContent(blobs, contentMetaOf(row));
  if (!isRecord(decoded)) {
    fail(stateRowError("request_binding.content", "json_object"));
  }
  const request = decoded["request"];
  if (!isRecord(request)) {
    return null;
  }
  const adapter = request["adapter_request"];
  if (!isRecord(adapter)) {
    return null;
  }
  const state = adapter["state"];
  if (!isRecord(state)) {
    return null;
  }
  const stateValue: unknown = state;
  const schema = schemaVersionOf(state, "request_binding.adapter_request.state");
  const contentMatches =
    schema === "rsi.judge_state/1"
      ? true
      : stateContentHash(state as JsonValue) === q.state_content_hash;
  if (stateHashOf(state as JsonValue) !== q.state_hash || !contentMatches) {
    return null;
  }
  return stateValue as JudgeState;
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createEvidenceBindingReadPort(
  deps: EvidenceBindingReadPortDeps
): EvidenceBindingReadPort {
  const { connection, blobs } = deps;

  return {
    readShardPlan(q) {
      return readResult(() => {
        const row = oneRow(
          connection,
          "SELECT * FROM evd_shard_plan WHERE shard_plan_id = :shard_plan_id",
          { shard_plan_id: q.shard_plan_id }
        );
        if (row === null) {
          return null;
        }
        assertBinding(row, q.binding, "shard_plan.binding");
        const physical = shardPlanRowOf(row);
        const decoded = decodeContent(blobs, contentMetaOf(row));
        if (schemaVersionOf(decoded, "content.schema_version") !== "rsi.shard_plan/1") {
          fail(stateRowError("content.schema_version", "rsi.shard_plan/1"));
        }
        const plan = decoded as ShardPlan;
        if (
          physical.shard_plan_id !== plan.shard_plan_id ||
          physical.shard_plan_key !== plan.shard_plan_key ||
          physical.shard_plan_hash !== plan.shard_plan_hash ||
          physical.plan_id !== plan.plan_id ||
          physical.plan_hash !== plan.plan_hash ||
          physical.pack_id !== plan.pack_id ||
          physical.pack_key !== plan.pack_key ||
          physical.issue_id !== plan.issue_id ||
          physical.service_profile_id !== plan.service_profile_id ||
          physical.service_profile_key !== plan.service_profile_key ||
          physical.state !== plan.state
        ) {
          fail(stateRowError("shard_plan", "denormalized_columns"));
        }
        return { row: physical, plan };
      });
    },

    readShard(q) {
      return readResult(() => {
        const row = oneRow(
          connection,
          `SELECT * FROM evd_shard
            WHERE shard_id = :shard_id AND shard_plan_id = :shard_plan_id`,
          { shard_id: q.shard_id, shard_plan_id: q.shard_plan_id }
        );
        if (row === null) {
          return null;
        }
        assertBinding(row, q.binding, "shard.binding");
        const physical = shardRowOf(row);
        const shard = physical.body_json;
        if (
          physical.shard_id !== shard.shard_id ||
          physical.shard_key !== shard.shard_key ||
          physical.status !== shard.status ||
          !sameStringSet(physical.reason_codes, shard.reason_codes) ||
          physical.shard_plan_id !== q.shard_plan_id
        ) {
          fail(stateRowError("shard", "denormalized_columns"));
        }
        return { row: physical, shard };
      });
    },

    readPack(q) {
      return readResult(() => {
        const row = oneRow(
          connection,
          `SELECT * FROM evd_evidence_pack
            WHERE pack_id = :pack_id AND pack_key = :pack_key`,
          { pack_id: q.pack_id, pack_key: q.pack_key }
        );
        if (row === null) {
          return null;
        }
        assertBinding(row, q.binding, "pack.binding");
        const physical = packRowOf(row);
        const decoded = decodeContent(blobs, contentMetaOf(row));
        const schema = schemaVersionOf(decoded, "content.schema_version");
        const packValue: unknown = decoded;
        const pack = packValue as EvidencePack;
        // `/1` is archived read-only history and keeps its own field set; the
        // compiler rejects it before reading any v2 field. Only `/2` rows are
        // cross-checked against the denormalized columns.
        if (
          schema === "rsi.evidence_pack/2" &&
          (physical.pack_id !== pack.pack_id ||
            physical.pack_key !== pack.pack_key ||
            physical.pack_hash !== pack.pack_hash ||
            physical.evidence_hash !== pack.evidence_hash ||
            physical.plan_id !== pack.plan_id ||
            physical.plan_hash !== pack.plan_hash ||
            physical.issue_id !== pack.issue_id ||
            physical.issue_key !== pack.issue_key)
        ) {
          fail(stateRowError("pack", "denormalized_columns"));
        }
        return { row: physical, pack };
      });
    },

    readManifest(q) {
      return readResult(() => {
        const row = oneRow(
          connection,
          `SELECT * FROM evd_state_manifest
            WHERE shard_id = :shard_id
              AND shard_key = :shard_key
              AND pack_key = :pack_key
              AND plan_hash = :plan_hash
            ORDER BY created_at DESC
            LIMIT 1`,
          {
            shard_id: q.shard_id,
            shard_key: q.shard_key,
            pack_key: q.pack_key,
            plan_hash: q.plan_hash,
          }
        );
        if (row === null) {
          return null;
        }
        assertBinding(row, q.binding, "manifest.binding");
        const physical = manifestRowOf(row);
        const decoded = decodeContent(blobs, contentMetaOf(row));
        if (
          schemaVersionOf(decoded, "content.schema_version") !==
          "rsi.judge_state_manifest/1"
        ) {
          fail(
            stateRowError("content.schema_version", "rsi.judge_state_manifest/1")
          );
        }
        const manifest = decoded as JudgeStateManifest;
        if (
          physical.manifest_id !== manifest.manifest_id ||
          physical.manifest_key !== manifest.manifest_key ||
          physical.manifest_hash !== manifest.manifest_hash ||
          physical.shard_id !== manifest.shard_id ||
          physical.shard_key !== manifest.shard_key ||
          physical.pack_key !== manifest.pack_key ||
          physical.plan_hash !== manifest.plan_hash ||
          physical.state_hash !== manifest.state_hash ||
          physical.state_content_hash !== manifest.state_content_hash
        ) {
          fail(stateRowError("manifest", "denormalized_columns"));
        }
        return { row: physical, manifest };
      });
    },

    readJudgeState(q) {
      return readResult(() => {
        const fromDocument = stateFromDocument(
          connection,
          q.state_hash,
          q.state_content_hash
        );
        if (fromDocument !== null) {
          return fromDocument;
        }
        return stateFromRequestBinding(connection, blobs, q);
      });
    },

    readServiceProfile(q) {
      return readResult(() => {
        if (q.profile_id !== undefined) {
          const row = oneRow(
            connection,
            "SELECT * FROM evd_service_profile WHERE profile_id = :profile_id",
            { profile_id: q.profile_id }
          );
          return row === null ? null : serviceProfileRowOf(row);
        }
        if (q.profile_key !== undefined) {
          const row = oneRow(
            connection,
            `SELECT * FROM evd_service_profile
              WHERE profile_key = :profile_key
              ORDER BY profile_version DESC
              LIMIT 1`,
            { profile_key: q.profile_key }
          );
          return row === null ? null : serviceProfileRowOf(row);
        }
        fail(stateRowError("profile_selector", "profile_id_or_profile_key"));
      });
    },

    readValidatorBinding(q) {
      return readResult(() => {
        if (q.validator_binding_id !== undefined) {
          const row = oneRow(
            connection,
            `SELECT * FROM evd_validator_binding
              WHERE validator_binding_id = :validator_binding_id`,
            { validator_binding_id: q.validator_binding_id }
          );
          return row === null ? null : validatorBindingRowOf(row);
        }
        if (q.validator_binding_key !== undefined) {
          const row = oneRow(
            connection,
            `SELECT * FROM evd_validator_binding
              WHERE validator_binding_key = :validator_binding_key`,
            { validator_binding_key: q.validator_binding_key }
          );
          return row === null ? null : validatorBindingRowOf(row);
        }
        fail(
          stateRowError(
            "validator_binding_selector",
            "validator_binding_id_or_validator_binding_key"
          )
        );
      });
    },

    readUnits(q) {
      return readResult(() => {
        if (q.unit_keys.length === 0) {
          return [];
        }
        const rows = allRows(
          connection,
          `SELECT * FROM evd_dependency_unit
            WHERE pack_id = :pack_id
              AND unit_key IN (SELECT value FROM json_each(:unit_keys))
            ORDER BY unit_key ASC`,
          {
            pack_id: q.pack_id,
            unit_keys: JSON.stringify([...q.unit_keys]),
          }
        );
        const units: DependencyUnit[] = [];
        for (const row of rows) {
          assertBinding(row, q.binding, "unit.binding");
          const physical = unitRowOf(row);
          if (physical.pack_key !== q.pack_key) {
            fail(bindingError("unit.pack_key", q.pack_key, physical.pack_key));
          }
          const decoded = decodeContent(blobs, contentMetaOf(row));
          if (
            schemaVersionOf(decoded, "content.schema_version") !==
            "rsi.dependency_unit/1"
          ) {
            fail(stateRowError("content.schema_version", "rsi.dependency_unit/1"));
          }
          const unit = decoded as DependencyUnit;
          if (
            physical.unit_id !== unit.unit_id ||
            physical.unit_key !== unit.unit_key ||
            physical.unit_hash !== unit.unit_hash ||
            physical.plan_id !== unit.plan_id ||
            physical.plan_hash !== unit.plan_hash ||
            physical.pack_id !== unit.pack_id ||
            physical.dependency_key !== unit.dependency_key ||
            physical.inseparable_group_key !== unit.inseparable_group_key ||
            physical.transport_role !== unit.transport_role
          ) {
            fail(stateRowError("unit", "denormalized_columns"));
          }
          units.push(unit);
        }
        if (!sameStringSet(units.map((unit) => unit.unit_key), q.unit_keys)) {
          fail(stateRowError("unit_keys", "all_requested_rows_present"));
        }
        return units;
      });
    },

    async verifySourceRefs(refs) {
      if (refs.length === 0) {
        return ok(true);
      }
      for (const ref of refs) {
        const parsed = parseSourceRef(ref);
        if (!parsed.ok) {
          return err(parsed.error);
        }
        if (deps.sources !== undefined) {
          const resolved = await deps.sources.resolve(ref);
          if (!resolved.ok) {
            return err(resolved.error);
          }
          if (!resolved.value.retrievable) {
            return ok(false);
          }
          continue;
        }
        if (parsed.value.scheme !== "blob" || !isHash(parsed.value.locator)) {
          return ok(false);
        }
        const verified = blobs.read(parsed.value.locator);
        if (!verified.ok) {
          return ok(false);
        }
        if (
          verified.value.byteLength < parsed.value.end
        ) {
          return ok(false);
        }
      }
      return ok(true);
    },
  };
}
