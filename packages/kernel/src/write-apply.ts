/**
 * `write.apply` managed-write executor (DD-FND-091).
 *
 * The handler owns the FND half of a managed write: grant re-evaluation,
 * scope/root/path resolution, snapshot capture, atomic whole-file or managed
 * block replacement, readback verification and the `write_intent` /
 * `write_snapshot` / `write_result` projection.
 *
 * Everything that is a domain rule stays in `@evoplug/auth`: request shape,
 * `WriteDecision`, scope/request/snapshot hashes, block parsing and editing,
 * rollback target validation and grant consumption. This module only supplies
 * the execution order, the filesystem effects and the journal/SQLite
 * projection.
 *
 * Two host-owned capabilities are injected:
 *
 *   - `root_resolver` maps a registered `root_id` to the approved absolute
 *     directory and its live identity pin. The kernel does not own the
 *     in-memory root map, so an absent resolver fails closed before any
 *     intent row or file effect.
 *   - `journal` is the FND journal committer. It is built from the home
 *     layout when omitted. An unavailable journal also fails closed before
 *     the intent row.
 *
 * Neither capability is ever faked. A missing one produces a typed `E_INTERNAL`
 * whose incident id names the missing dependency.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import type {
  ContentUpload,
  ErrorEnvelope,
  FailureStatus,
  Hash,
  HumanAttestation,
  Id,
  JsonValue,
  Result,
  SourceRef,
  VersionBinding
} from "@evoplug/core";
import {
  canonicalHash,
  canonicalJsonText,
  formatSourceRef,
  hashBytes,
  isHash,
  isId,
  isWellFormedUnicode,
  newId,
  parseSourceRef,
  parseVersionBinding,
  toJsonValue
} from "@evoplug/core";
import type { IpcHandler, IpcHandlerContext, IpcResult } from "@evoplug/ipc";
import { computeIdempotencyRequestHash } from "@evoplug/ipc";
import {
  applyManagedBlockEdit,
  authDenied,
  authError,
  checkExpectedBlockHash,
  consumeGrantInTransaction,
  evaluateWriteDecision,
  fieldError as authFieldError,
  idempotencyConflict,
  isWriteTransitionAllowed,
  managedBlockHash,
  parseManagedBlocks,
  planGrantConsumption,
  transitionWriteIntent,
  validateRelativeTargetPath,
  validateRollbackTarget,
  validateWriteApplyRequest,
  verifyGrantHash,
  writeRequestHash,
  writeScopeHash,
  writeSnapshotHash,
  type AuthorizationGrant,
  type GrantScope,
  type ManagedBlockSpan,
  type RootIdentityPin,
  type WriteIntent,
  type WriteIntentState,
  type WriteResult as AuthWriteResult,
  type WriteSnapshot,
  type WriteTargetFacts
} from "@evoplug/auth";
import {
  BlobStore,
  JournalWriter,
  createJournalCommitter,
  createTransactionRunner,
  listJournalStates,
  type JournalAppendResult,
  type JournalCommitter,
  type SqlRow,
  type SqliteConnection,
  type Tx
} from "@evoplug/storage";

import { internalError, kernelError } from "./errors.js";
import { homeLayout, type HomeLayout } from "./home.js";

/* ------------------------------------------------------------------ */
/* Public dependency contract                                          */
/* ------------------------------------------------------------------ */

/** Live resolution of a registered root; absolute paths stay in this call stack. */
export interface WriteApplyRootResolution {
  readonly approved_root: string;
  readonly root_identity_pin: RootIdentityPin;
  readonly root_registration_hash: Hash;
}

/** Host-owned port behind `RootResolver.resolve` (DD-FND-095.0). */
export interface WriteApplyRootResolverPort {
  resolve(input: {
    readonly root_id: string;
    readonly request_id: Id<"ipc">;
    readonly deadline_ms: number;
    readonly signal: AbortSignal;
  }): Promise<Result<WriteApplyRootResolution, ErrorEnvelope>>;
}

export interface WriteApplyDependencies {
  /** The single kernel writer connection. */
  readonly connection: SqliteConnection;
  readonly blob_store: BlobStore;
  readonly now: () => number;
  /** Product home, used to locate the journal when `journal` is omitted. */
  readonly home: string;
  readonly layout?: HomeLayout;
  /** Absent means the handler fails closed before any effect. */
  readonly root_resolver?: WriteApplyRootResolverPort;
  /** Pre-built FND committer; built from `home`/`layout` when omitted. */
  readonly journal?: JournalCommitter;
}

/* ------------------------------------------------------------------ */
/* Local primitives                                                   */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

const TERMINAL_STATES: readonly WriteIntentState[] = [
  "verified",
  "conflict",
  "path_rejected",
  "write_failed",
  "partial",
  "recovery_required"
];

const WRITE_STATES: readonly WriteIntentState[] = [
  "intent_recorded",
  "snapshot_written",
  "temp_written",
  "renamed",
  "dir_synced",
  "verified",
  "pending_approval",
  "conflict",
  "path_rejected",
  "write_failed",
  "partial",
  "recovery_required"
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ok<T>(value: T): Result<T, ErrorEnvelope> {
  return { ok: true, status: "ok", value };
}

function fail<T>(error: ErrorEnvelope, status: FailureStatus = "rejected"): Result<T, ErrorEnvelope> {
  return { ok: false, status, error };
}

function stringField(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function numberField(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function nullableStringField(row: Row, key: string): string | null {
  return stringField(row, key);
}

function nullableNumberField(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function isWriteState(value: string): value is WriteIntentState {
  return (WRITE_STATES as readonly string[]).includes(value);
}

function isTerminalState(state: WriteIntentState): boolean {
  return TERMINAL_STATES.includes(state);
}

function bindingJson(binding: VersionBinding): JsonValue {
  return {
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark
  };
}

function schemaFieldError(path: string, rule: string): ErrorEnvelope {
  return authFieldError("E_SCHEMA", path, rule);
}

function scopeError(rule: string): ErrorEnvelope {
  return authError({
    code: "E_WRITE_SCOPE_UNRESOLVED",
    stage: "write_scope",
    details: { kind: "field", path: "scope_ref", rule }
  });
}

function rootError(
  code: "E_ROOT_NOT_FOUND" | "E_ROOT_UNAVAILABLE" | "E_ROOT_INVALID" | "E_ROOT_IDENTITY_MISMATCH",
  path: string,
  rule: string
): ErrorEnvelope {
  return authError({
    code,
    stage: "write_root_resolve",
    details: { kind: "field", path, rule }
  });
}

function pathEscape(rule: string): ErrorEnvelope {
  return authError({
    code: "E_PATH_ESCAPE",
    stage: "write_path_check",
    details: { kind: "field", path: "target_path", rule }
  });
}

function pathChanged(rule: string): ErrorEnvelope {
  return authError({
    code: "E_PATH_CHANGED",
    stage: "write_path_check",
    details: { kind: "field", path: "target_path", rule }
  });
}

function writeStateError(rule: string): ErrorEnvelope {
  return authError({
    code: "E_WRITE_STATE",
    stage: "write_apply",
    details: { kind: "field", path: "state", rule }
  });
}

function ioError(operation: string, sideEffect: "none" | "partial" | "unknown", code?: string): ErrorEnvelope {
  return kernelError("E_IO", {
    details: { kind: "storage", operation, ...(code === undefined ? {} : { sqlite_code: code }) },
    side_effect: sideEffect
  });
}

function fsCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)["code"];
  return typeof value === "string" ? value : undefined;
}

function blobSourceRef(hash: Hash, byteLength: number): SourceRef {
  if (byteLength > 0) {
    const formatted = formatSourceRef({ scheme: "blob", locator: hash, start: 0, end: byteLength });
    if (formatted.ok) {
      return formatted.value;
    }
  }
  // A zero-byte snapshot has no legal non-empty SourceRef range. The DDL keeps
  // the ref as text; the empty range is the only honest encoding.
  return `blob://${hash}#bytes=0-0` as SourceRef;
}

/* ------------------------------------------------------------------ */
/* Request parsing                                                    */
/* ------------------------------------------------------------------ */

function parseStringArray(value: unknown): string[] | null {
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

function parseContentUpload(value: unknown): Result<ContentUpload, ErrorEnvelope> {
  if (!isRecord(value)) {
    return fail(schemaFieldError("new_content", "must_be_object"));
  }
  const mediaType = value["media_type"];
  const encoding = value["encoding"];
  const data = value["data"];
  const byteLength = value["byte_length"];
  if (
    mediaType !== "text/plain;charset=utf-8" &&
    mediaType !== "application/json" &&
    mediaType !== "application/octet-stream"
  ) {
    return fail(schemaFieldError("new_content.media_type", "content_media_type"));
  }
  if (encoding !== "utf8" && encoding !== "base64") {
    return fail(schemaFieldError("new_content.encoding", "utf8_or_base64"));
  }
  if (typeof data !== "string") {
    return fail(schemaFieldError("new_content.data", "string"));
  }
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    return fail(schemaFieldError("new_content.byte_length", "non_negative_safe_integer"));
  }
  return ok({ media_type: mediaType, encoding, data, byte_length: byteLength });
}

function parseWriteScopeRef(
  value: unknown
): Result<WriteApplyRequestScope, ErrorEnvelope> {
  if (!isRecord(value)) {
    return fail(schemaFieldError("scope_ref", "must_be_object"));
  }
  const kind = value["kind"];
  if (kind === "task") {
    const taskId = value["task_id"];
    if (typeof taskId !== "string" || !isId(taskId, "task")) {
      return fail(schemaFieldError("scope_ref.task_id", "task_id"));
    }
    return ok({ kind: "task", task_id: taskId });
  }
  if (kind === "session") {
    const sessionId = value["session_id"];
    if (typeof sessionId !== "string" || !isId(sessionId, "sess")) {
      return fail(schemaFieldError("scope_ref.session_id", "sess_id"));
    }
    return ok({ kind: "session", session_id: sessionId });
  }
  return fail(schemaFieldError("scope_ref.kind", "task_or_session"));
}

interface WriteApplyRequestScopeTask {
  readonly kind: "task";
  readonly task_id: Id<"task">;
}

interface WriteApplyRequestScopeSession {
  readonly kind: "session";
  readonly session_id: Id<"sess">;
}

type WriteApplyRequestScope = WriteApplyRequestScopeTask | WriteApplyRequestScopeSession;

interface ParsedWriteApplyRequest {
  readonly schema_version: "rsi.write_apply/1";
  readonly deadline_ms: number;
  readonly grant_id: Id<"grant">;
  readonly action: "create" | "update" | "disable" | "rollback";
  readonly object_type: "skill" | "memory" | "instructions";
  readonly candidate_id: Id<"prop">;
  readonly candidate_hash: Hash;
  readonly binding: VersionBinding;
  readonly scope_ref: WriteApplyRequestScope;
  readonly root_id: string;
  readonly target_path: string;
  readonly write_mode: "whole_file" | "managed_block";
  readonly block_action: "update" | "attach" | "detach" | null;
  readonly block_selector: string | null;
  readonly expected_file_hash: Hash | null;
  readonly expected_block_hash: Hash | null;
  readonly new_content: ContentUpload | null;
  readonly new_content_hash: Hash | null;
  readonly rollback_of_write_id: Id<"wi"> | null;
  readonly target_snapshot_id: Id<"wsnap"> | null;
  readonly target_snapshot_hash: Hash | null;
  readonly unattended_policy: "auto_allowed" | "pending_approval" | "rsi_managed_file_only";
}

function parseOptionalHash(value: unknown, path: string): Result<Hash | null, ErrorEnvelope> {
  if (value === null || value === undefined) {
    return ok(null);
  }
  if (typeof value !== "string" || !isHash(value)) {
    return fail(schemaFieldError(path, "sha256"));
  }
  return ok(value);
}

/**
 * Structural parsing before the domain validator runs. The domain validator
 * narrows the remaining shape rules and rejects `object_type="config"` before
 * any intent is created.
 */
function parseWriteApplyRequest(value: unknown): Result<ParsedWriteApplyRequest, ErrorEnvelope> {
  if (!isRecord(value)) {
    return fail(schemaFieldError("params", "must_be_object"));
  }
  if (value["schema_version"] !== "rsi.write_apply/1") {
    return fail(schemaFieldError("schema_version", "rsi.write_apply/1"));
  }
  const deadline = value["deadline_ms"];
  if (typeof deadline !== "number" || !Number.isSafeInteger(deadline) || deadline < 1 || deadline > 600_000) {
    return fail(schemaFieldError("deadline_ms", "1..600000"));
  }
  const grantId = value["grant_id"];
  if (typeof grantId !== "string" || !isId(grantId, "grant")) {
    return fail(schemaFieldError("grant_id", "grant_id"));
  }
  const action = value["action"];
  if (action !== "create" && action !== "update" && action !== "disable" && action !== "rollback") {
    return fail(schemaFieldError("action", "grant_action"));
  }
  const objectType = value["object_type"];
  if (
    objectType !== "skill" &&
    objectType !== "memory" &&
    objectType !== "instructions" &&
    objectType !== "config"
  ) {
    return fail(schemaFieldError("object_type", "grant_object_type"));
  }
  if (objectType === "config") {
    return fail(
      authError({
        code: "E_WRITE_MODE_UNSUPPORTED",
        stage: "write_authorize",
        details: { kind: "field", path: "object_type", rule: "no_config_in_write_apply" }
      })
    );
  }
  const typedObjectType: "skill" | "memory" | "instructions" = objectType;
  const candidateId = value["candidate_id"];
  if (typeof candidateId !== "string" || !isId(candidateId, "prop")) {
    return fail(schemaFieldError("candidate_id", "prop_id"));
  }
  const candidateHash = value["candidate_hash"];
  if (typeof candidateHash !== "string" || !isHash(candidateHash)) {
    return fail(schemaFieldError("candidate_hash", "sha256"));
  }
  const binding = parseVersionBinding(value["binding"]);
  if (!binding.ok) {
    return fail(binding.error, binding.status);
  }
  const scopeRef = parseWriteScopeRef(value["scope_ref"]);
  if (!scopeRef.ok) {
    return scopeRef;
  }
  const rootId = value["root_id"];
  if (typeof rootId !== "string" || rootId.length === 0 || rootId.includes("\u0000")) {
    return fail(schemaFieldError("root_id", "non_empty"));
  }
  const targetPath = value["target_path"];
  if (typeof targetPath !== "string") {
    return fail(schemaFieldError("target_path", "string"));
  }
  const writeMode = value["write_mode"];
  if (writeMode !== "whole_file" && writeMode !== "managed_block") {
    return fail(schemaFieldError("write_mode", "whole_file_or_managed_block"));
  }
  const blockAction = value["block_action"];
  if (blockAction !== null && blockAction !== "update" && blockAction !== "attach" && blockAction !== "detach") {
    return fail(schemaFieldError("block_action", "update_attach_detach_or_null"));
  }
  const blockSelector = value["block_selector"];
  if (blockSelector !== null && typeof blockSelector !== "string") {
    return fail(schemaFieldError("block_selector", "string_or_null"));
  }
  const expectedFileHash = parseOptionalHash(value["expected_file_hash"], "expected_file_hash");
  if (!expectedFileHash.ok) {
    return expectedFileHash;
  }
  const expectedBlockHash = parseOptionalHash(value["expected_block_hash"], "expected_block_hash");
  if (!expectedBlockHash.ok) {
    return expectedBlockHash;
  }
  let newContent: ContentUpload | null = null;
  if (value["new_content"] !== null && value["new_content"] !== undefined) {
    const parsed = parseContentUpload(value["new_content"]);
    if (!parsed.ok) {
      return parsed;
    }
    newContent = parsed.value;
  }
  const newContentHash = parseOptionalHash(value["new_content_hash"], "new_content_hash");
  if (!newContentHash.ok) {
    return newContentHash;
  }
  const rollbackOfWriteId = value["rollback_of_write_id"];
  if (rollbackOfWriteId !== null && (typeof rollbackOfWriteId !== "string" || !isId(rollbackOfWriteId, "wi"))) {
    return fail(schemaFieldError("rollback_of_write_id", "wi_id_or_null"));
  }
  const targetSnapshotId = value["target_snapshot_id"];
  if (targetSnapshotId !== null && (typeof targetSnapshotId !== "string" || !isId(targetSnapshotId, "wsnap"))) {
    return fail(schemaFieldError("target_snapshot_id", "wsnap_id_or_null"));
  }
  const targetSnapshotHash = parseOptionalHash(value["target_snapshot_hash"], "target_snapshot_hash");
  if (!targetSnapshotHash.ok) {
    return targetSnapshotHash;
  }
  const unattended = value["unattended_policy"];
  if (
    unattended !== "auto_allowed" &&
    unattended !== "pending_approval" &&
    unattended !== "rsi_managed_file_only"
  ) {
    return fail(schemaFieldError("unattended_policy", "unattended_policy"));
  }

  const request: ParsedWriteApplyRequest = {
    schema_version: "rsi.write_apply/1",
    deadline_ms: deadline,
    grant_id: grantId,
    action,
    object_type: typedObjectType,
    candidate_id: candidateId,
    candidate_hash: candidateHash,
    binding: binding.value,
    scope_ref: scopeRef.value,
    root_id: rootId,
    target_path: targetPath,
    write_mode: writeMode,
    block_action: blockAction,
    block_selector: blockSelector,
    expected_file_hash: expectedFileHash.value,
    expected_block_hash: expectedBlockHash.value,
    new_content: newContent,
    new_content_hash: newContentHash.value,
    rollback_of_write_id: rollbackOfWriteId,
    target_snapshot_id: targetSnapshotId,
    target_snapshot_hash: targetSnapshotHash.value,
    unattended_policy: unattended
  };

  const validated = validateWriteApplyRequest(request);
  if (!validated.ok) {
    return fail(validated.error, validated.status);
  }
  return ok(request);
}

/* ------------------------------------------------------------------ */
/* Grant and consumption reads                                        */
/* ------------------------------------------------------------------ */

function parseHumanAttestation(value: unknown): HumanAttestation | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value["kind"];
  const capabilityId = value["capability_id"];
  const evidenceRef = value["evidence_ref"];
  const confirmedAt = value["confirmed_at"];
  if (
    (kind !== "host_verified_interactive_user" && kind !== "control_plane_explicit_confirmation") ||
    typeof capabilityId !== "string" ||
    typeof evidenceRef !== "string" ||
    typeof confirmedAt !== "number" ||
    !Number.isSafeInteger(confirmedAt) ||
    confirmedAt < 0
  ) {
    return null;
  }
  return {
    kind,
    capability_id: capabilityId,
    evidence_ref: evidenceRef as SourceRef,
    confirmed_at: confirmedAt
  };
}

function parseGrantScope(value: unknown): GrantScope | null {
  if (!isRecord(value)) {
    return null;
  }
  const projectIds = parseStringArray(value["project_ids"]);
  const configSpaces = parseStringArray(value["config_spaces"]);
  const pathGlobs = parseStringArray(value["path_globs"]);
  const objectIds = parseStringArray(value["object_ids"]);
  if (projectIds === null || configSpaces === null || pathGlobs === null || objectIds === null) {
    return null;
  }
  const rawConfigScope = value["config_scope"];
  if (rawConfigScope === undefined) {
    return {
      project_ids: projectIds,
      config_spaces: configSpaces,
      path_globs: pathGlobs,
      object_ids: objectIds
    };
  }
  if (!isRecord(rawConfigScope)) {
    return null;
  }
  const fieldIds = parseStringArray(rawConfigScope["field_ids"]);
  const layerIds = parseStringArray(rawConfigScope["source_layer_ids"]);
  const modelKeys = parseStringArray(rawConfigScope["model_scope_keys"]);
  if (fieldIds === null || layerIds === null || modelKeys === null) {
    return null;
  }
  return {
    project_ids: projectIds,
    config_spaces: configSpaces,
    path_globs: pathGlobs,
    object_ids: objectIds,
    config_scope: {
      field_ids: fieldIds as Id<"fld">[],
      source_layer_ids: layerIds,
      model_scope_keys: modelKeys
    }
  };
}

function grantFromRow(row: Row): AuthorizationGrant | null {
  const grantId = stringField(row, "grant_id");
  const issuedBy = stringField(row, "issued_by");
  const subject = stringField(row, "subject");
  const objectType = stringField(row, "object_type");
  const scopeJson = stringField(row, "scope_json");
  const actionsJson = stringField(row, "actions_json");
  const attestationJson = stringField(row, "human_attestation_json");
  const mode = stringField(row, "mode");
  const candidateId = nullableStringField(row, "candidate_id");
  const candidateHash = nullableStringField(row, "candidate_hash");
  const policyVersion = stringField(row, "policy_version");
  const issuedAt = numberField(row, "issued_at");
  const expiresAt = nullableNumberField(row, "expires_at");
  const revokedAt = nullableNumberField(row, "revoked_at");
  const grantHash = stringField(row, "grant_hash");
  if (
    grantId === null ||
    !isId(grantId, "grant") ||
    (issuedBy !== "human" && issuedBy !== "preconfigured_policy") ||
    subject !== "rsi" ||
    (objectType !== "skill" && objectType !== "memory" && objectType !== "instructions" && objectType !== "config") ||
    scopeJson === null ||
    actionsJson === null ||
    attestationJson === null ||
    (mode !== "once" && mode !== "standing") ||
    (candidateId !== null && !isId(candidateId, "prop") && !isId(candidateId, "ctr")) ||
    (candidateHash !== null && !isHash(candidateHash)) ||
    policyVersion === null ||
    issuedAt === null ||
    grantHash === null ||
    !isHash(grantHash)
  ) {
    return null;
  }
  let scopeValue: unknown;
  let actionsValue: unknown;
  let attestationValue: unknown;
  try {
    scopeValue = JSON.parse(scopeJson);
    actionsValue = JSON.parse(actionsJson);
    attestationValue = JSON.parse(attestationJson);
  } catch {
    return null;
  }
  const scope = parseGrantScope(scopeValue);
  const actions = parseStringArray(actionsValue);
  const attestation = parseHumanAttestation(attestationValue);
  if (scope === null || actions === null || attestation === null) {
    return null;
  }
  const typedActions: Array<"create" | "update" | "disable" | "rollback"> = [];
  for (const action of actions) {
    if (action !== "create" && action !== "update" && action !== "disable" && action !== "rollback") {
      return null;
    }
    typedActions.push(action);
  }
  return {
    schema_version: "rsi.authorization_grant/1",
    grant_id: grantId,
    issued_by: issuedBy,
    human_attestation: attestation,
    subject: "rsi",
    object_type: objectType,
    scope,
    actions: typedActions,
    mode,
    candidate_id: candidateId,
    candidate_hash: candidateHash,
    policy_version: policyVersion,
    issued_at: issuedAt,
    expires_at: expiresAt,
    revoked_at: revokedAt,
    grant_hash: grantHash
  };
}

interface ConsumptionView {
  readonly write_id: Id<"wi"> | null;
  readonly config_write_id: Id<"cwi"> | null;
}

function readConsumption(
  connection: SqliteConnection,
  grantId: Id<"grant">
): Result<ConsumptionView | null, ErrorEnvelope> {
  const row = connection
    .prepare<Row>(
      "SELECT grant_id, write_kind, managed_write_id, config_write_id FROM grant_consumption WHERE grant_id = :grant_id"
    )
    .get({ grant_id: grantId });
  if (row === undefined) {
    return ok(null);
  }
  const kind = stringField(row, "write_kind");
  const managed = nullableStringField(row, "managed_write_id");
  const config = nullableStringField(row, "config_write_id");
  if (kind === "managed") {
    if (managed === null || !isId(managed, "wi") || config !== null) {
      return fail(internalError("kernel.write_apply_consumption_corrupt"));
    }
    return ok({ write_id: managed, config_write_id: null });
  }
  if (kind === "config") {
    if (config === null || !isId(config, "cwi") || managed !== null) {
      return fail(internalError("kernel.write_apply_consumption_corrupt"));
    }
    return ok({ write_id: null, config_write_id: config });
  }
  return fail(internalError("kernel.write_apply_consumption_corrupt"));
}

/* ------------------------------------------------------------------ */
/* Scope, root and path resolution                                    */
/* ------------------------------------------------------------------ */

interface ResolvedScope {
  readonly scope_kind: "task" | "session";
  readonly scope_ref_id: string;
  readonly project_id: string | null;
  readonly config_space_id: string | null;
  readonly scope_hash: Hash;
}

function resolveScope(
  connection: SqliteConnection,
  request: ParsedWriteApplyRequest,
  grant: AuthorizationGrant
): Result<ResolvedScope, ErrorEnvelope> {
  const binding = request.binding;
  if (request.scope_ref.kind === "task") {
    const taskId = request.scope_ref.task_id;
    if (binding.task_id !== taskId) {
      return fail(scopeError("binding_task_mismatch"));
    }
    const row = connection
      .prepare<Row>("SELECT task_id, project_id FROM task WHERE task_id = :task_id")
      .get({ task_id: taskId });
    if (row === undefined) {
      return fail(scopeError("task_not_found"));
    }
    const projectId = nullableStringField(row, "project_id");
    const configSpaces = grant.scope.config_spaces;
    if (configSpaces.length > 1) {
      return fail(scopeError("multiple_config_spaces"));
    }
    const configSpaceId = configSpaces[0] ?? null;
    if (request.object_type === "instructions" && projectId === null) {
      return fail(scopeError("instructions_requires_project"));
    }
    return ok({
      scope_kind: "task",
      scope_ref_id: taskId,
      project_id: projectId,
      config_space_id: configSpaceId,
      scope_hash: writeScopeHash({
        scope_kind: "task",
        scope_ref_id: taskId,
        project_id: projectId,
        config_space_id: configSpaceId
      })
    });
  }

  const sessionId = request.scope_ref.session_id;
  const sessionRow = connection
    .prepare<Row>(
      "SELECT session_id, current_branch_id, config_space FROM session WHERE session_id = :session_id"
    )
    .get({ session_id: sessionId });
  if (sessionRow === undefined) {
    return fail(scopeError("session_not_found"));
  }
  const currentBranch = nullableStringField(sessionRow, "current_branch_id");
  const configSpace = stringField(sessionRow, "config_space");
  if (currentBranch === null || currentBranch !== binding.branch_id) {
    return fail(scopeError("session_branch_mismatch"));
  }
  if (configSpace === null || configSpace.length === 0) {
    return fail(scopeError("session_config_space_missing"));
  }
  const branchRow = connection
    .prepare<Row>("SELECT task_id FROM branch WHERE branch_id = :branch_id")
    .get({ branch_id: binding.branch_id });
  if (branchRow === undefined || stringField(branchRow, "task_id") !== binding.task_id) {
    return fail(scopeError("session_task_mismatch"));
  }
  const taskRow = connection
    .prepare<Row>("SELECT task_id, project_id FROM task WHERE task_id = :task_id")
    .get({ task_id: binding.task_id });
  if (taskRow === undefined) {
    return fail(scopeError("task_not_found"));
  }
  const projectId = nullableStringField(taskRow, "project_id");
  if (request.object_type === "instructions" && projectId === null) {
    return fail(scopeError("instructions_requires_project"));
  }
  return ok({
    scope_kind: "session",
    scope_ref_id: sessionId,
    project_id: projectId,
    config_space_id: configSpace,
    scope_hash: writeScopeHash({
      scope_kind: "session",
      scope_ref_id: sessionId,
      project_id: projectId,
      config_space_id: configSpace
    })
  });
}

interface RootRegistrationRow {
  readonly root_id: string;
  readonly registration_hash: Hash;
  readonly config_space: string;
  readonly identity_kind: "dev_inode" | "file_id";
  readonly device_id: string;
  readonly file_id: string;
}

function readRootRegistration(
  connection: SqliteConnection,
  rootId: string
): Result<RootRegistrationRow, ErrorEnvelope> {
  const row = connection
    .prepare<Row>(
      `SELECT root_id, registration_hash, config_space, identity_kind, device_id, file_id
         FROM root_registration WHERE root_id = :root_id`
    )
    .get({ root_id: rootId });
  if (row === undefined) {
    return fail(rootError("E_ROOT_NOT_FOUND", "root_id", "not_registered"));
  }
  const registrationHash = stringField(row, "registration_hash");
  const configSpace = stringField(row, "config_space");
  const identityKind = stringField(row, "identity_kind");
  const deviceId = stringField(row, "device_id");
  const fileId = stringField(row, "file_id");
  if (
    registrationHash === null ||
    !isHash(registrationHash) ||
    configSpace === null ||
    (identityKind !== "dev_inode" && identityKind !== "file_id") ||
    deviceId === null ||
    fileId === null
  ) {
    return fail(internalError("kernel.write_apply_root_row_corrupt"));
  }
  return ok({
    root_id: rootId,
    registration_hash: registrationHash,
    config_space: configSpace,
    identity_kind: identityKind,
    device_id: deviceId,
    file_id: fileId
  });
}

interface ResolvedRoot {
  readonly approved_root: string;
  readonly pin: RootIdentityPin;
  readonly registration_hash: Hash;
}

async function resolveRoot(
  resolver: WriteApplyRootResolverPort,
  registration: RootRegistrationRow,
  scope: ResolvedScope,
  context: IpcHandlerContext<"write.apply">,
  deadlineAt: number
): Promise<Result<ResolvedRoot, ErrorEnvelope>> {
  if (registration.config_space !== scope.config_space_id) {
    return fail(scopeError("root_config_space_mismatch"));
  }
  const remaining = Math.floor(deadlineAt - performance.now());
  const resolved = await resolver.resolve({
    root_id: registration.root_id,
    request_id: context.request_id,
    deadline_ms: Math.max(0, remaining),
    signal: context.signal
  });
  if (!resolved.ok) {
    return resolved;
  }
  const pin = resolved.value.root_identity_pin;
  if (
    pin.schema_version !== "rsi.root_identity/1" ||
    pin.root_id !== registration.root_id ||
    pin.identity_kind !== registration.identity_kind ||
    pin.device_id !== registration.device_id ||
    pin.file_id !== registration.file_id
  ) {
    return fail(rootError("E_ROOT_IDENTITY_MISMATCH", "root_identity_pin", "live_pin_mismatch"));
  }
  if (resolved.value.root_registration_hash !== registration.registration_hash) {
    return fail(rootError("E_ROOT_IDENTITY_MISMATCH", "root_registration_hash", "registration_hash_mismatch"));
  }
  if (!isAbsolute(resolved.value.approved_root) || resolved.value.approved_root.includes("\u0000")) {
    return fail(rootError("E_ROOT_INVALID", "approved_root", "absolute"));
  }
  let realRoot: string;
  try {
    const stats = lstatSync(resolved.value.approved_root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return fail(rootError("E_ROOT_UNAVAILABLE", "approved_root", "not_a_directory"));
    }
    realRoot = realpathSync(resolved.value.approved_root);
  } catch {
    return fail(rootError("E_ROOT_UNAVAILABLE", "approved_root", "unreadable"));
  }
  if (realRoot !== resolved.value.approved_root) {
    return fail(rootError("E_ROOT_IDENTITY_MISMATCH", "approved_root", "realpath_not_equal"));
  }
  return ok({
    approved_root: realRoot,
    pin,
    registration_hash: registration.registration_hash
  });
}

interface TargetInspection {
  readonly absolute_path: string;
  readonly exists: boolean;
  readonly bytes: Uint8Array | null;
  readonly file_hash: Hash | null;
  readonly root_device: number;
  readonly mode: number;
}

function inspectTargetPath(
  root: string,
  relativePath: string
): Result<TargetInspection, ErrorEnvelope> {
  const validated = validateRelativeTargetPath(relativePath);
  if (!validated.ok) {
    return fail(validated.error, validated.status);
  }
  let rootStats;
  try {
    rootStats = lstatSync(root);
  } catch {
    return fail(rootError("E_ROOT_UNAVAILABLE", "approved_root", "unreadable"));
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    return fail(rootError("E_ROOT_UNAVAILABLE", "approved_root", "not_a_directory"));
  }
  const absolute = resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    return fail(pathEscape("outside_approved_root"));
  }
  const segments = relativePath.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) {
    return fail(pathChanged("target_is_root"));
  }
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      return fail(pathEscape("empty_segment"));
    }
    current = join(current, segment);
    const isLast = index === segments.length - 1;
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (fsCode(error) === "ENOENT") {
        if (isLast) {
          return ok({
            absolute_path: absolute,
            exists: false,
            bytes: null,
            file_hash: null,
            root_device: rootStats.dev,
            mode: 0o600
          });
        }
        return fail(pathEscape("parent_missing"));
      }
      return fail(ioError("lstat_target", "none", fsCode(error)));
    }
    if (stats.isSymbolicLink()) {
      return fail(pathEscape("symlink_component"));
    }
    if (stats.dev !== rootStats.dev) {
      return fail(pathEscape("cross_device_mount"));
    }
    if (!isLast) {
      if (!stats.isDirectory()) {
        return fail(pathEscape("parent_not_directory"));
      }
      continue;
    }
    if (!stats.isFile()) {
      return fail(pathChanged("not_regular_file"));
    }
    if (stats.nlink !== 1) {
      return fail(pathChanged("hardlink_count"));
    }
    if ((stats.mode & 0o7000) !== 0) {
      return fail(pathEscape("special_mode_bits"));
    }
    const read = readFileNoFollow(absolute, rootStats.dev);
    if (!read.ok) {
      return read;
    }
    if (read.value === null) {
      return fail(pathChanged("disappeared"));
    }
    return ok({
      absolute_path: absolute,
      exists: true,
      bytes: read.value,
      file_hash: hashBytes(read.value),
      root_device: rootStats.dev,
      mode: stats.mode & 0o777
    });
  }
  return fail(pathEscape("unreachable"));
}

function readFileNoFollow(
  absolutePath: string,
  rootDevice: number
): Result<Uint8Array | null, ErrorEnvelope> {
  let fd: number;
  try {
    fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (fsCode(error) === "ENOENT") {
      return ok(null);
    }
    if (fsCode(error) === "ELOOP") {
      return fail(pathChanged("symlink_swap"));
    }
    return fail(ioError("open_target", "none", fsCode(error)));
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      return fail(pathChanged("not_regular_file"));
    }
    if (stats.nlink !== 1) {
      return fail(pathChanged("hardlink_count"));
    }
    if (stats.dev !== rootDevice) {
      return fail(pathEscape("cross_device_mount"));
    }
    if ((stats.mode & 0o7000) !== 0) {
      return fail(pathEscape("special_mode_bits"));
    }
    return ok(new Uint8Array(readFileSync(fd)));
  } catch (error) {
    return fail(ioError("read_target", "none", fsCode(error)));
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Secondary close failure does not change the outcome.
    }
  }
}

type TargetOwnership = "native_managed" | "rsi_managed" | "shared_handwritten";

function determineTargetOwnership(input: {
  readonly connection: SqliteConnection;
  readonly absolute_path: string;
  readonly target_path: string;
  readonly exists: boolean;
  readonly file_hash: Hash | null;
  readonly blocks: readonly ManagedBlockSpan[] | null;
}): Result<TargetOwnership, ErrorEnvelope> {
  let rows: readonly Row[];
  try {
    rows = input.connection
      .prepare<Row>(
        `SELECT ownership, origin_hash FROM install_path
          WHERE state = 'present' AND path IN (:absolute_path, :target_path)`
      )
      .all({ absolute_path: input.absolute_path, target_path: input.target_path });
  } catch (error) {
    return fail(kernelError("E_INTERNAL", {
      details: { kind: "internal", incident_id: "kernel.write_apply_install_index_unavailable" },
      side_effect: "none"
    }));
  }
  let nativeManaged = false;
  for (const row of rows) {
    const ownership = stringField(row, "ownership");
    const originHash = nullableStringField(row, "origin_hash");
    if (ownership === "managed") {
      if (
        !input.exists ||
        originHash === null ||
        (input.file_hash !== null && originHash === input.file_hash)
      ) {
        return ok("rsi_managed");
      }
    } else if (ownership === "host_managed_block") {
      nativeManaged = true;
    }
  }
  if (nativeManaged) {
    return ok("native_managed");
  }
  if (input.blocks !== null && input.blocks.length > 0) {
    return ok("rsi_managed");
  }
  // A target that does not exist is created by RSI, so it is RSI-managed. Only
  // an existing file without a managed install index is shared/handwritten.
  return ok(input.exists ? "shared_handwritten" : "rsi_managed");
}

/* ------------------------------------------------------------------ */
/* Rollback target validation                                         */
/* ------------------------------------------------------------------ */

interface RollbackTargetRead {
  readonly intent: WriteIntent;
  readonly latest_result: AuthWriteResult;
  readonly snapshot: WriteSnapshot;
  readonly content: Uint8Array;
  readonly is_latest_verified: boolean;
}

function parseRootIdentityPin(value: unknown, rootId: string): RootIdentityPin | null {
  if (!isRecord(value)) {
    return null;
  }
  const schemaVersion = value["schema_version"];
  const pinRootId = value["root_id"];
  const identityKind = value["identity_kind"];
  const deviceId = value["device_id"];
  const fileId = value["file_id"];
  if (
    schemaVersion !== "rsi.root_identity/1" ||
    pinRootId !== rootId ||
    (identityKind !== "dev_inode" && identityKind !== "file_id") ||
    typeof deviceId !== "string" ||
    typeof fileId !== "string"
  ) {
    return null;
  }
  return {
    schema_version: "rsi.root_identity/1",
    root_id: rootId,
    identity_kind: identityKind,
    device_id: deviceId,
    file_id: fileId
  };
}

function writeIntentFromRow(row: Row): WriteIntent | null {
  const writeId = stringField(row, "write_id");
  const idempotencyKey = stringField(row, "idempotency_key");
  const grantId = stringField(row, "grant_id");
  const action = stringField(row, "action");
  const objectType = stringField(row, "object_type");
  const candidateId = stringField(row, "candidate_id");
  const candidateHash = stringField(row, "candidate_hash");
  const bindingJson = stringField(row, "binding_json");
  const scopeKind = stringField(row, "scope_kind");
  const scopeRefId = stringField(row, "scope_ref_id");
  const scopeHash = stringField(row, "scope_hash");
  const rootId = stringField(row, "root_id");
  const pinJson = stringField(row, "root_identity_pin_json");
  const rootRegistrationHash = stringField(row, "root_registration_hash");
  const targetPath = stringField(row, "target_path");
  const targetOwnership = stringField(row, "target_ownership");
  const writeMode = stringField(row, "write_mode");
  const atomicity = stringField(row, "atomicity");
  const exclusion = stringField(row, "exclusion");
  const unattended = stringField(row, "unattended_policy");
  const state = stringField(row, "state");
  const attempt = numberField(row, "attempt");
  const rowVersion = numberField(row, "row_version");
  const createdAt = numberField(row, "created_at");
  const updatedAt = numberField(row, "updated_at");
  if (
    writeId === null ||
    !isId(writeId, "wi") ||
    idempotencyKey === null ||
    grantId === null ||
    !isId(grantId, "grant") ||
    (action !== "create" && action !== "update" && action !== "disable" && action !== "rollback") ||
    (objectType !== "skill" && objectType !== "memory" && objectType !== "instructions") ||
    candidateId === null ||
    candidateHash === null ||
    !isHash(candidateHash) ||
    bindingJson === null ||
    (scopeKind !== "task" && scopeKind !== "session") ||
    scopeRefId === null ||
    scopeHash === null ||
    !isHash(scopeHash) ||
    rootId === null ||
    pinJson === null ||
    rootRegistrationHash === null ||
    !isHash(rootRegistrationHash) ||
    targetPath === null ||
    (targetOwnership !== "native_managed" && targetOwnership !== "rsi_managed" && targetOwnership !== "shared_handwritten") ||
    (writeMode !== "whole_file" && writeMode !== "managed_block") ||
    (atomicity !== "native_atomic" && atomicity !== "single_file_atomic" && atomicity !== "none") ||
    (exclusion !== "native_cooperative" && exclusion !== "rsi_advisory" && exclusion !== "none") ||
    (unattended !== "auto_allowed" && unattended !== "pending_approval" && unattended !== "rsi_managed_file_only") ||
    state === null ||
    !isWriteState(state) ||
    attempt === null ||
    rowVersion === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  let bindingValue: unknown;
  let pinValue: unknown;
  try {
    bindingValue = JSON.parse(bindingJson);
    pinValue = JSON.parse(pinJson);
  } catch {
    return null;
  }
  const binding = parseVersionBinding(bindingValue);
  if (!binding.ok) {
    return null;
  }
  const pin = parseRootIdentityPin(pinValue, rootId);
  if (pin === null) {
    return null;
  }
  if (candidateId === null || !isId(candidateId, "prop")) {
    return null;
  }
  if (candidateHash === null || !isHash(candidateHash)) {
    return null;
  }
  if (scopeHash === null || !isHash(scopeHash)) {
    return null;
  }
  if (rootRegistrationHash === null || !isHash(rootRegistrationHash)) {
    return null;
  }
  const blockActionRaw = nullableStringField(row, "block_action");
  if (blockActionRaw !== null && blockActionRaw !== "update" && blockActionRaw !== "attach" && blockActionRaw !== "detach") {
    return null;
  }
  const expectedFileHashRaw = nullableStringField(row, "expected_file_hash");
  if (expectedFileHashRaw !== null && !isHash(expectedFileHashRaw)) {
    return null;
  }
  const expectedBlockHashRaw = nullableStringField(row, "expected_block_hash");
  if (expectedBlockHashRaw !== null && !isHash(expectedBlockHashRaw)) {
    return null;
  }
  const snapshotIdRaw = nullableStringField(row, "snapshot_id");
  if (snapshotIdRaw !== null && !isId(snapshotIdRaw, "wsnap")) {
    return null;
  }
  const rollbackOfWriteIdRaw = nullableStringField(row, "rollback_of_write_id");
  if (rollbackOfWriteIdRaw !== null && !isId(rollbackOfWriteIdRaw, "wi")) {
    return null;
  }
  const targetSnapshotIdRaw = nullableStringField(row, "target_snapshot_id");
  if (targetSnapshotIdRaw !== null && !isId(targetSnapshotIdRaw, "wsnap")) {
    return null;
  }
  const targetSnapshotHashRaw = nullableStringField(row, "target_snapshot_hash");
  if (targetSnapshotHashRaw !== null && !isHash(targetSnapshotHashRaw)) {
    return null;
  }
  return {
    schema_version: "rsi.write_intent/2",
    write_id: writeId,
    idempotency_key: idempotencyKey,
    grant_id: grantId,
    action,
    object_type: objectType,
    candidate_id: candidateId,
    candidate_hash: candidateHash,
    binding: binding.value,
    scope_kind: scopeKind,
    scope_ref_id: scopeRefId,
    project_id: nullableStringField(row, "project_id"),
    config_space_id: nullableStringField(row, "config_space_id"),
    scope_hash: scopeHash,
    root_id: rootId,
    root_identity_pin: pin,
    root_registration_hash: rootRegistrationHash,
    target_path: targetPath,
    target_ownership: targetOwnership,
    write_mode: writeMode,
    block_action: blockActionRaw,
    block_selector: nullableStringField(row, "block_selector"),
    expected_file_hash: expectedFileHashRaw,
    expected_block_hash: expectedBlockHashRaw,
    snapshot_id: snapshotIdRaw,
    rollback_of_write_id: rollbackOfWriteIdRaw,
    target_snapshot_id: targetSnapshotIdRaw,
    target_snapshot_hash: targetSnapshotHashRaw,
    atomicity,
    exclusion,
    unattended_policy: unattended,
    state,
    attempt,
    last_error_code: nullableStringField(row, "last_error_code"),
    row_version: rowVersion,
    created_at: createdAt,
    updated_at: updatedAt
  };
}

function writeSnapshotFromRow(row: Row): WriteSnapshot | null {
  const snapshotId = stringField(row, "snapshot_id");
  const writeId = stringField(row, "write_id");
  const path = stringField(row, "path");
  const writeMode = stringField(row, "write_mode");
  const fileHash = stringField(row, "file_hash");
  const fileByteLength = numberField(row, "file_byte_length");
  const contentRef = stringField(row, "content_ref");
  const snapshotHash = stringField(row, "snapshot_hash");
  const createdAt = numberField(row, "created_at");
  if (
    snapshotId === null ||
    !isId(snapshotId, "wsnap") ||
    writeId === null ||
    !isId(writeId, "wi") ||
    path === null ||
    (writeMode !== "whole_file" && writeMode !== "managed_block") ||
    fileHash === null ||
    !isHash(fileHash) ||
    fileByteLength === null ||
    contentRef === null ||
    snapshotHash === null ||
    !isHash(snapshotHash) ||
    createdAt === null
  ) {
    return null;
  }
  let contentSourceRef: SourceRef;
  const parsedRef = parseSourceRef(contentRef);
  if (parsedRef.ok) {
    contentSourceRef = parsedRef.value.source_ref;
  } else if (/^blob:\/\/sha256:[0-9a-f]{64}#bytes=0-0$/.test(contentRef)) {
    // Zero-byte base files have no non-empty SourceRef range.
    contentSourceRef = contentRef as SourceRef;
  } else {
    return null;
  }
  const blockAction = nullableStringField(row, "block_action");
  if (blockAction !== null && blockAction !== "update" && blockAction !== "attach" && blockAction !== "detach") {
    return null;
  }
  if (!isHash(fileHash) || !isHash(snapshotHash)) {
    return null;
  }
  const blockContentHashRaw = nullableStringField(row, "block_content_hash");
  if (blockContentHashRaw !== null && !isHash(blockContentHashRaw)) {
    return null;
  }
  const blockHashRaw = nullableStringField(row, "block_hash");
  if (blockHashRaw !== null && !isHash(blockHashRaw)) {
    return null;
  }
  return {
    snapshot_id: snapshotId,
    write_id: writeId,
    path,
    write_mode: writeMode,
    file_hash: fileHash,
    file_byte_length: fileByteLength,
    block_action: blockAction,
    block_selector: nullableStringField(row, "block_selector"),
    block_start: nullableNumberField(row, "block_start"),
    block_byte_length: nullableNumberField(row, "block_byte_length"),
    block_content_hash: blockContentHashRaw,
    block_hash: blockHashRaw,
    content_ref: contentSourceRef,
    snapshot_hash: snapshotHash,
    created_at: createdAt
  };
}

function writeResultFromRow(row: Row): AuthWriteResult | null {
  const writeId = stringField(row, "write_id");
  const attempt = numberField(row, "attempt");
  const state = stringField(row, "state");
  const rootId = stringField(row, "root_id");
  const path = stringField(row, "path");
  const atomicity = stringField(row, "atomicity");
  const exclusion = stringField(row, "exclusion");
  const unattended = stringField(row, "unattended_policy");
  const readback = numberField(row, "readback_verified");
  if (
    writeId === null ||
    !isId(writeId, "wi") ||
    attempt === null ||
    state === null ||
    !isWriteState(state) ||
    rootId === null ||
    path === null ||
    (atomicity !== "native_atomic" && atomicity !== "single_file_atomic" && atomicity !== "none") ||
    (exclusion !== "native_cooperative" && exclusion !== "rsi_advisory" && exclusion !== "none") ||
    (unattended !== "auto_allowed" && unattended !== "pending_approval" && unattended !== "rsi_managed_file_only") ||
    (readback !== 0 && readback !== 1)
  ) {
    return null;
  }
  const newFileHashRaw = nullableStringField(row, "new_file_hash");
  if (newFileHashRaw !== null && !isHash(newFileHashRaw)) {
    return null;
  }
  const newBlockHashRaw = nullableStringField(row, "new_block_hash");
  if (newBlockHashRaw !== null && !isHash(newBlockHashRaw)) {
    return null;
  }
  const snapshotIdRaw = nullableStringField(row, "snapshot_id");
  if (snapshotIdRaw !== null && !isId(snapshotIdRaw, "wsnap")) {
    return null;
  }
  const targetSnapshotIdRaw = nullableStringField(row, "target_snapshot_id");
  if (targetSnapshotIdRaw !== null && !isId(targetSnapshotIdRaw, "wsnap")) {
    return null;
  }
  const targetSnapshotHashRaw = nullableStringField(row, "target_snapshot_hash");
  if (targetSnapshotHashRaw !== null && !isHash(targetSnapshotHashRaw)) {
    return null;
  }
  const threeWayDiffRefRaw = nullableStringField(row, "three_way_diff_ref");
  if (threeWayDiffRefRaw !== null && !parseSourceRef(threeWayDiffRefRaw).ok) {
    return null;
  }
  return {
    schema_version: "rsi.write_result/2",
    write_id: writeId,
    attempt,
    state,
    root_id: rootId,
    path,
    new_file_hash: newFileHashRaw,
    new_block_hash: newBlockHashRaw,
    snapshot_id: snapshotIdRaw,
    target_snapshot_id: targetSnapshotIdRaw,
    target_snapshot_hash: targetSnapshotHashRaw,
    three_way_diff_ref: threeWayDiffRefRaw === null ? null : (threeWayDiffRefRaw as SourceRef),
    readback_verified: readback === 1,
    atomicity,
    exclusion,
    unattended_policy: unattended,
    error_code: nullableStringField(row, "error_code"),
    completed_at: nullableNumberField(row, "completed_at")
  };
}

function readWriteIntentById(
  connection: SqliteConnection,
  writeId: Id<"wi">
): Result<WriteIntent | null, ErrorEnvelope> {
  const row = connection
    .prepare<Row>("SELECT * FROM write_intent WHERE write_id = :write_id")
    .get({ write_id: writeId });
  if (row === undefined) {
    return ok(null);
  }
  const intent = writeIntentFromRow(row);
  if (intent === null) {
    return fail(internalError("kernel.write_apply_intent_row_corrupt"));
  }
  return ok(intent);
}

function readLatestWriteResult(
  connection: SqliteConnection,
  writeId: Id<"wi">
): Result<AuthWriteResult | null, ErrorEnvelope> {
  const row = connection
    .prepare<Row>(
      "SELECT * FROM write_result WHERE write_id = :write_id ORDER BY attempt DESC LIMIT 1"
    )
    .get({ write_id: writeId });
  if (row === undefined) {
    return ok(null);
  }
  const result = writeResultFromRow(row);
  if (result === null) {
    return fail(internalError("kernel.write_apply_result_row_corrupt"));
  }
  return ok(result);
}

function readWriteSnapshotById(
  connection: SqliteConnection,
  snapshotId: Id<"wsnap">
): Result<WriteSnapshot | null, ErrorEnvelope> {
  const row = connection
    .prepare<Row>("SELECT * FROM write_snapshot WHERE snapshot_id = :snapshot_id")
    .get({ snapshot_id: snapshotId });
  if (row === undefined) {
    return ok(null);
  }
  const snapshot = writeSnapshotFromRow(row);
  if (snapshot === null) {
    return fail(internalError("kernel.write_apply_snapshot_row_corrupt"));
  }
  return ok(snapshot);
}

function rollbackTargetError(path: string, rule: string): ErrorEnvelope {
  return authError({
    code: "E_WRITE_ROLLBACK_TARGET",
    stage: "write_rollback_target",
    details: { kind: "field", path, rule }
  });
}

function validateRollbackRequest(
  connection: SqliteConnection,
  blobStore: BlobStore,
  request: ParsedWriteApplyRequest
): Result<RollbackTargetRead, ErrorEnvelope> {
  if (request.action !== "rollback") {
    return fail(rollbackTargetError("action", "rollback"));
  }
  if (request.rollback_of_write_id === null || request.target_snapshot_id === null || request.target_snapshot_hash === null) {
    return fail(rollbackTargetError("rollback_of_write_id", "target_fields_required"));
  }
  const targetIntentResult = readWriteIntentById(connection, request.rollback_of_write_id);
  if (!targetIntentResult.ok) {
    return targetIntentResult;
  }
  if (targetIntentResult.value === null) {
    return fail(rollbackTargetError("rollback_of_write_id", "not_found"));
  }
  const targetIntent = targetIntentResult.value;
  const latestResult = readLatestWriteResult(connection, targetIntent.write_id);
  if (!latestResult.ok) {
    return latestResult;
  }
  if (latestResult.value === null) {
    return fail(rollbackTargetError("latest_result", "missing"));
  }
  const snapshotResult = readWriteSnapshotById(connection, request.target_snapshot_id);
  if (!snapshotResult.ok) {
    return snapshotResult;
  }
  if (snapshotResult.value === null) {
    return fail(rollbackTargetError("target_snapshot_id", "not_found"));
  }
  const snapshot = snapshotResult.value;
  if (snapshot.write_id !== targetIntent.write_id) {
    return fail(rollbackTargetError("target_snapshot_id", "belongs_to_target_write"));
  }

  const verifiedRows = connection
    .prepare<Row>(
      `SELECT write_id, binding_json FROM write_intent
        WHERE target_path = :target_path AND state = 'verified' AND action <> 'rollback'
        ORDER BY created_at DESC, write_id DESC`
    )
    .all({ target_path: targetIntent.target_path });
  let isLatestVerified = false;
  for (const row of verifiedRows) {
    const rowWriteId = stringField(row, "write_id");
    const rowBindingJson = stringField(row, "binding_json");
    if (rowWriteId === null || rowBindingJson === null) {
      return fail(internalError("kernel.write_apply_verified_index_corrupt"));
    }
    let bindingValue: unknown;
    try {
      bindingValue = JSON.parse(rowBindingJson);
    } catch {
      return fail(internalError("kernel.write_apply_verified_index_corrupt"));
    }
    const binding = parseVersionBinding(bindingValue);
    if (!binding.ok) {
      return fail(internalError("kernel.write_apply_verified_index_corrupt"));
    }
    if (
      binding.value.task_id === targetIntent.binding.task_id &&
      binding.value.branch_id === targetIntent.binding.branch_id
    ) {
      isLatestVerified = rowWriteId === targetIntent.write_id;
      break;
    }
  }

  const snapshotCheck = validateRollbackTarget(request, {
    intent: targetIntent,
    latest_result: latestResult.value,
    snapshot,
    is_latest_verified: isLatestVerified
  });
  if (!snapshotCheck.ok) {
    return fail(snapshotCheck.error, snapshotCheck.status);
  }

  const verifiedBlob = blobStore.read(snapshot.file_hash);
  if (!verifiedBlob.ok) {
    return fail(rollbackTargetError("target_snapshot_id", "blob_unreadable"));
  }
  if (verifiedBlob.value.length !== snapshot.file_byte_length) {
    return fail(rollbackTargetError("target_snapshot_id", "blob_length_mismatch"));
  }
  return ok({
    intent: targetIntent,
    latest_result: latestResult.value,
    snapshot,
    content: verifiedBlob.value,
    is_latest_verified: isLatestVerified
  });
}

/* ------------------------------------------------------------------ */
/* Journal projection                                                 */
/* ------------------------------------------------------------------ */

interface WriteJournalEvent {
  readonly event_type:
    | "write.intent_recorded"
    | "write.transition"
    | "write.snapshot_recorded"
    | "write.result_recorded";
  readonly entity_type: "write_intent" | "write_snapshot" | "write_result";
  readonly entity_id: string;
  readonly operation: "insert" | "update" | "transition";
  readonly binding: VersionBinding;
  readonly row_schema: string;
  readonly row: Record<string, JsonValue>;
  readonly before: Record<string, JsonValue> | null;
  readonly blob_hashes: readonly Hash[];
  readonly project: (tx: Tx, receipt: JournalAppendResult) => void;
}

interface JournalCommitView {
  readonly ok: boolean;
  readonly unknown: boolean;
  readonly error: ErrorEnvelope | null;
}

function createWriteJournal(deps: WriteApplyDependencies): JournalCommitter | null {
  if (deps.journal !== undefined) {
    return deps.journal;
  }
  const layout = deps.layout ?? homeLayout(deps.home);
  const states = listJournalStates(deps.connection);
  const latest = states[states.length - 1];
  const journalId = latest?.journal_id ?? "journal-000001";
  const relativePath = latest?.relative_path ?? "journal-000001.rsij";
  const writer = JournalWriter.open({
    file_path: join(layout.journal_dir, relativePath),
    journal_id: journalId,
    last_commit_seq: latest?.last_commit_seq ?? 0,
    trusted_prefix_end: latest?.trusted_prefix_end ?? 0,
    read_only: latest?.read_only === 1,
    tail_state: latest?.tail_state ?? "clean"
  });
  if (!writer.ok) {
    return null;
  }
  return createJournalCommitter({
    writer: writer.value,
    connection: deps.connection,
    relative_path: relativePath,
    now: deps.now
  });
}

function insertLedgerEventLog(
  tx: Tx,
  input: {
    readonly event: Record<string, JsonValue>;
    readonly eventType: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly operation: "insert" | "update" | "transition";
    readonly binding: VersionBinding;
    readonly beforeHash: Hash | null;
    readonly afterHash: Hash;
    readonly rowSchema: string;
    readonly rowJson: string;
    readonly payloadHash: Hash;
    readonly journalId: string;
    readonly commitSeq: number;
    readonly recordedAt: number;
  }
): void {
  tx.prepare(
    `INSERT INTO ledger_event_log (
       event_id, event_key, commit_seq, journal_id, event_type, entity_type, entity_id,
       operation, binding_mode, task_id, branch_id, input_epoch, goal_version,
       config_version, watermark, before_hash, after_hash, row_schema, row_json,
       document_id, payload_hash, recorded_at
     ) VALUES (
       :event_id, :event_key, :commit_seq, :journal_id, :event_type, :entity_type, :entity_id,
       :operation, 'bound', :task_id, :branch_id, :input_epoch, :goal_version,
       :config_version, :watermark, :before_hash, :after_hash, :row_schema, :row_json,
       NULL, :payload_hash, :recorded_at
     )`
  ).run({
    event_id: String(input.event["event_id"]),
    event_key: String(input.event["event_key"]),
    commit_seq: input.commitSeq,
    journal_id: input.journalId,
    event_type: input.eventType,
    entity_type: input.entityType,
    entity_id: input.entityId,
    operation: input.operation,
    task_id: input.binding.task_id,
    branch_id: input.binding.branch_id,
    input_epoch: input.binding.input_epoch,
    goal_version: input.binding.goal_version,
    config_version: input.binding.config_version,
    watermark: input.binding.watermark,
    before_hash: input.beforeHash,
    after_hash: input.afterHash,
    row_schema: input.rowSchema,
    row_json: input.rowJson,
    payload_hash: input.payloadHash,
    recorded_at: input.recordedAt
  });
}

/* ------------------------------------------------------------------ */
/* Row builders                                                       */
/* ------------------------------------------------------------------ */

function intentRow(intent: WriteIntent): Record<string, JsonValue> {
  return {
    schema_version: intent.schema_version,
    write_id: intent.write_id,
    idempotency_key: intent.idempotency_key,
    grant_id: intent.grant_id,
    action: intent.action,
    object_type: intent.object_type,
    candidate_id: intent.candidate_id,
    candidate_hash: intent.candidate_hash,
    binding_json: canonicalJsonText(bindingJson(intent.binding)),
    scope_kind: intent.scope_kind,
    scope_ref_id: intent.scope_ref_id,
    project_id: intent.project_id,
    config_space_id: intent.config_space_id,
    scope_hash: intent.scope_hash,
    root_id: intent.root_id,
    root_identity_pin_json: canonicalJsonText({
      schema_version: intent.root_identity_pin.schema_version,
      root_id: intent.root_identity_pin.root_id,
      identity_kind: intent.root_identity_pin.identity_kind,
      device_id: intent.root_identity_pin.device_id,
      file_id: intent.root_identity_pin.file_id
    }),
    root_registration_hash: intent.root_registration_hash,
    target_path: intent.target_path,
    target_ownership: intent.target_ownership,
    write_mode: intent.write_mode,
    block_action: intent.block_action,
    block_selector: intent.block_selector,
    expected_file_hash: intent.expected_file_hash,
    expected_block_hash: intent.expected_block_hash,
    snapshot_id: intent.snapshot_id,
    rollback_of_write_id: intent.rollback_of_write_id,
    target_snapshot_id: intent.target_snapshot_id,
    target_snapshot_hash: intent.target_snapshot_hash,
    atomicity: intent.atomicity,
    exclusion: intent.exclusion,
    unattended_policy: intent.unattended_policy,
    state: intent.state,
    attempt: intent.attempt,
    last_error_code: intent.last_error_code,
    row_version: intent.row_version,
    created_at: intent.created_at,
    updated_at: intent.updated_at
  };
}

function snapshotRow(snapshot: WriteSnapshot): Record<string, JsonValue> {
  return {
    snapshot_id: snapshot.snapshot_id,
    write_id: snapshot.write_id,
    path: snapshot.path,
    write_mode: snapshot.write_mode,
    file_hash: snapshot.file_hash,
    file_byte_length: snapshot.file_byte_length,
    block_action: snapshot.block_action,
    block_selector: snapshot.block_selector,
    block_start: snapshot.block_start,
    block_byte_length: snapshot.block_byte_length,
    block_content_hash: snapshot.block_content_hash,
    block_hash: snapshot.block_hash,
    content_ref: snapshot.content_ref,
    snapshot_hash: snapshot.snapshot_hash,
    created_at: snapshot.created_at
  };
}

function resultRow(result: IpcResult["write.apply"]): Record<string, JsonValue> {
  return {
    write_id: result.write_id,
    attempt: result.attempt,
    state: result.state,
    root_id: result.root_id,
    path: result.path,
    new_file_hash: result.new_file_hash,
    new_block_hash: result.new_block_hash,
    snapshot_id: result.snapshot_id,
    target_snapshot_id: result.target_snapshot_id,
    target_snapshot_hash: result.target_snapshot_hash,
    three_way_diff_ref: result.three_way_diff_ref,
    readback_verified: result.readback_verified ? 1 : 0,
    atomicity: result.atomicity,
    exclusion: result.exclusion,
    unattended_policy: result.unattended_policy,
    error_code: result.error_code,
    completed_at: result.completed_at
  };
}

function buildWriteResult(input: {
  readonly intent: WriteIntent;
  readonly state: WriteIntentState;
  readonly new_file_hash: Hash | null;
  readonly new_block_hash: Hash | null;
  readonly three_way_diff_ref: SourceRef | null;
  readonly readback_verified: boolean;
  readonly error_code: string | null;
  readonly completed_at: number | null;
}): IpcResult["write.apply"] {
  return {
    schema_version: "rsi.write_result/2",
    write_id: input.intent.write_id,
    attempt: input.intent.attempt,
    state: input.state,
    root_id: input.intent.root_id,
    path: input.intent.target_path,
    new_file_hash: input.new_file_hash,
    new_block_hash: input.new_block_hash,
    snapshot_id: input.intent.snapshot_id,
    target_snapshot_id: input.intent.target_snapshot_id,
    target_snapshot_hash: input.intent.target_snapshot_hash,
    three_way_diff_ref: input.three_way_diff_ref,
    readback_verified: input.readback_verified,
    atomicity: input.intent.atomicity,
    exclusion: input.intent.exclusion,
    unattended_policy: input.intent.unattended_policy,
    error_code: input.error_code,
    completed_at: input.completed_at
  };
}

/* ------------------------------------------------------------------ */
/* Filesystem effects                                                 */
/* ------------------------------------------------------------------ */

function decodeContent(content: ContentUpload): Result<Uint8Array, ErrorEnvelope> {
  if (content.encoding === "utf8") {
    if (!isWellFormedUnicode(content.data)) {
      return fail(schemaFieldError("new_content.data", "well_formed_unicode"));
    }
    const bytes = new TextEncoder().encode(content.data);
    if (bytes.length !== content.byte_length) {
      return fail(schemaFieldError("new_content.byte_length", "matches_data"));
    }
    return ok(bytes);
  }
  if (content.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content.data)) {
    return fail(schemaFieldError("new_content.data", "base64"));
  }
  const bytes = new Uint8Array(Buffer.from(content.data, "base64"));
  if (bytes.length !== content.byte_length) {
    return fail(schemaFieldError("new_content.byte_length", "matches_data"));
  }
  return ok(bytes);
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = writeSync(fd, bytes, written, bytes.byteLength - written);
    if (count <= 0) {
      throw new Error("short write");
    }
    written += count;
  }
}

function writeTempFile(input: {
  readonly directory: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
}): Result<{ readonly path: string }, ErrorEnvelope> {
  const path = join(input.directory, `.rsi-write-${randomUUID()}`);
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      input.mode & 0o777
    );
  } catch (error) {
    return fail(ioError("create_temp", "none", fsCode(error)));
  }
  try {
    writeAll(fd, input.bytes);
    fsyncSync(fd);
    closeSync(fd);
    return ok({ path });
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Secondary close failure.
    }
    try {
      unlinkSync(path);
    } catch {
      // The temporary file may already be gone.
    }
    return fail(ioError("write_temp", "none", fsCode(error)));
  }
}

function removeTempFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Maintenance GC owns residual temporary files.
  }
}

function fsyncDirectory(directory: string): Result<void, ErrorEnvelope> {
  let fd: number;
  try {
    fd = openSync(directory, constants.O_RDONLY);
  } catch (error) {
    return fail(ioError("open_parent_dir", "unknown", fsCode(error)));
  }
  try {
    fsyncSync(fd);
    return ok(undefined);
  } catch (error) {
    return fail(ioError("fsync_parent_dir", "unknown", fsCode(error)));
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Secondary close failure.
    }
  }
}

function writeThreeWayDiff(input: {
  readonly blobStore: BlobStore;
  readonly writeId: Id<"wi">;
  readonly path: string;
  readonly baseHash: Hash | null;
  readonly currentHash: Hash;
  readonly proposedHash: Hash;
  readonly currentByteLength: number;
}): SourceRef | null {
  const document: JsonValue = {
    schema_version: "rsi.write_three_way_diff/1",
    write_id: input.writeId,
    path: input.path,
    base_file_hash: input.baseHash,
    current_file_hash: input.currentHash,
    proposed_file_hash: input.proposedHash,
    current_byte_length: input.currentByteLength
  };
  const bytes = new TextEncoder().encode(canonicalJsonText(document));
  const stored = input.blobStore.putSync(bytes);
  if (!stored.ok) {
    return null;
  }
  return blobSourceRef(stored.value.hash, bytes.length);
}

/* ------------------------------------------------------------------ */
/* Handler factory                                                    */
/* ------------------------------------------------------------------ */

interface ExecutionState {
  post_rename: boolean;
  intent: WriteIntent | null;
  last_known_hash: Hash | null;
  last_error_code: string | null;
}

interface Deadline {
  readonly deadline_at: number;
}

function deadlineFailure(): Result<never, ErrorEnvelope> {
  return fail(
    authError({ code: "E_DEADLINE_EXCEEDED", stage: "write_apply", details: { kind: "none" } }),
    "degraded"
  );
}

function cancelledFailure(): Result<never, ErrorEnvelope> {
  return fail(
    authError({ code: "E_CANCELLED", stage: "write_apply", details: { kind: "none" } }),
    "degraded"
  );
}

export function createWriteApplyHandler(deps: WriteApplyDependencies): IpcHandler<"write.apply"> {
  const journal = createWriteJournal(deps);
  const runner = createTransactionRunner(deps.connection);

  async function commitEvent(input: WriteJournalEvent): Promise<JournalCommitView> {
    if (journal === null) {
      return {
        ok: false,
        unknown: false,
        error: internalError("kernel.write_apply_journal_unavailable")
      };
    }
    const rowJson = canonicalJsonText(input.row);
    const afterHash = canonicalHash({ row_schema: input.row_schema, row_json: rowJson });
    const beforeHash = input.before === null
      ? null
      : canonicalHash({
          row_schema: input.row_schema,
          row_json: canonicalJsonText(input.before)
        });
    const binding = bindingJson(input.binding);
    const eventId = newId("ev", deps.now());
    const eventKey = canonicalHash({
      event_type: input.event_type,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      operation: input.operation,
      before_hash: beforeHash,
      after_hash: afterHash,
      binding
    });
    const event: Record<string, JsonValue> = {
      schema_version: "rsi.ledger_event/1",
      event_id: eventId,
      event_key: eventKey,
      event_type: input.event_type,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      operation: input.operation,
      binding,
      before_hash: beforeHash,
      after_hash: afterHash,
      row_schema: input.row_schema,
      row_json: rowJson,
      payload_hash: afterHash,
      recorded_at: deps.now()
    };
    const blobHashes = [...new Set(input.blob_hashes)].sort();
    const outcome = await journal.commit(
      {
        schema_version: "rsi.journal_event/1",
        event,
        event_hash: canonicalHash(event),
        blob_hashes: blobHashes
      },
      (tx, receipt) => {
        insertLedgerEventLog(tx, {
          event,
          eventType: input.event_type,
          entityType: input.entity_type,
          entityId: input.entity_id,
          operation: input.operation,
          binding: input.binding,
          beforeHash,
          afterHash,
          rowSchema: input.row_schema,
          rowJson,
          payloadHash: afterHash,
          journalId: receipt.journal_id,
          commitSeq: receipt.first_commit_seq,
          recordedAt: deps.now()
        });
        input.project(tx, receipt);
        return null;
      }
    );
    if (!outcome.ok) {
      return {
        ok: false,
        unknown: outcome.commit_state === "unknown_recovery_required",
        error: outcome.error
      };
    }
    return { ok: true, unknown: false, error: null };
  }

  interface TransitionOutcome {
    readonly ok: boolean;
    readonly unknown: boolean;
    readonly intent: WriteIntent | null;
    readonly error: ErrorEnvelope | null;
  }

  async function transitionIntent(input: {
    readonly intent: WriteIntent;
    readonly to: WriteIntentState;
    readonly error_code: string | null;
  }): Promise<TransitionOutcome> {
    if (!isWriteTransitionAllowed(input.intent.state, input.to)) {
      return {
        ok: false,
        unknown: false,
        intent: null,
        error: writeStateError(`${input.intent.state}_to_${input.to}`)
      };
    }
    const transitioned = transitionWriteIntent({
      intent: input.intent,
      to: input.to,
      now: deps.now(),
      error_code: input.error_code
    });
    if (!transitioned.ok) {
      return { ok: false, unknown: false, intent: null, error: transitioned.error };
    }
    const next = transitioned.value;
    const before = intentRow(input.intent);
    const after = intentRow(next);
    const committed = await commitEvent({
      event_type: "write.transition",
      entity_type: "write_intent",
      entity_id: next.write_id,
      operation: "transition",
      binding: next.binding,
      row_schema: "rsi.write_intent/2",
      row: after,
      before,
      blob_hashes: [],
      project: (tx) => {
        const updated = tx.prepare(
          `UPDATE write_intent
              SET state = :state,
                  last_error_code = :last_error_code,
                  row_version = :row_version,
                  updated_at = :updated_at
            WHERE write_id = :write_id AND row_version = :expected_row_version`
        ).run({
          state: next.state,
          last_error_code: next.last_error_code,
          row_version: next.row_version,
          updated_at: next.updated_at,
          write_id: next.write_id,
          expected_row_version: input.intent.row_version
        });
        if (updated.changes !== 1) {
          throw writeStateError("row_version_cas");
        }
      }
    });
    if (!committed.ok) {
      return { ok: false, unknown: committed.unknown, intent: null, error: committed.error };
    }
    return { ok: true, unknown: false, intent: next, error: null };
  }

  interface AppendOutcome {
    readonly ok: boolean;
    readonly unknown: boolean;
    readonly result: IpcResult["write.apply"] | null;
    readonly error: ErrorEnvelope | null;
  }

  async function appendAttemptResult(input: {
    readonly intent: WriteIntent;
    readonly state: WriteIntentState;
    readonly new_file_hash: Hash | null;
    readonly new_block_hash: Hash | null;
    readonly three_way_diff_ref: SourceRef | null;
    readonly readback_verified: boolean;
    readonly error_code: string | null;
    readonly blob_hashes: readonly Hash[];
  }): Promise<AppendOutcome> {
    const completedAt = deps.now();
    const result = buildWriteResult({
      intent: input.intent,
      state: input.state,
      new_file_hash: input.new_file_hash,
      new_block_hash: input.new_block_hash,
      three_way_diff_ref: input.three_way_diff_ref,
      readback_verified: input.readback_verified,
      error_code: input.error_code,
      completed_at: completedAt
    });
    const committed = await commitEvent({
      event_type: "write.result_recorded",
      entity_type: "write_result",
      entity_id: input.intent.write_id,
      operation: "insert",
      binding: input.intent.binding,
      row_schema: "rsi.write_result/2",
      row: resultRow(result),
      before: null,
      blob_hashes: input.blob_hashes,
      project: (tx) => {
        tx.prepare(
          `INSERT INTO write_result (
             write_id, attempt, state, root_id, path, new_file_hash, new_block_hash,
             snapshot_id, target_snapshot_id, target_snapshot_hash, three_way_diff_ref,
             readback_verified, atomicity, exclusion, unattended_policy, error_code, completed_at
           ) VALUES (
             :write_id, :attempt, :state, :root_id, :path, :new_file_hash, :new_block_hash,
             :snapshot_id, :target_snapshot_id, :target_snapshot_hash, :three_way_diff_ref,
             :readback_verified, :atomicity, :exclusion, :unattended_policy, :error_code, :completed_at
           )`
        ).run({
          write_id: result.write_id,
          attempt: result.attempt,
          state: result.state,
          root_id: result.root_id,
          path: result.path,
          new_file_hash: result.new_file_hash,
          new_block_hash: result.new_block_hash,
          snapshot_id: result.snapshot_id,
          target_snapshot_id: result.target_snapshot_id,
          target_snapshot_hash: result.target_snapshot_hash,
          three_way_diff_ref: result.three_way_diff_ref,
          readback_verified: result.readback_verified ? 1 : 0,
          atomicity: result.atomicity,
          exclusion: result.exclusion,
          unattended_policy: result.unattended_policy,
          error_code: result.error_code,
          completed_at: result.completed_at
        });
        const updated = tx.prepare(
          `UPDATE write_intent
              SET state = :state,
                  last_error_code = :last_error_code,
                  row_version = :row_version,
                  updated_at = :updated_at
            WHERE write_id = :write_id AND row_version = :expected_row_version`
        ).run({
          state: result.state,
          last_error_code: result.error_code,
          row_version: input.intent.row_version + 1,
          updated_at: completedAt,
          write_id: input.intent.write_id,
          expected_row_version: input.intent.row_version
        });
        if (updated.changes !== 1) {
          throw writeStateError("row_version_cas");
        }
      }
    });
    if (!committed.ok) {
      return { ok: false, unknown: committed.unknown, result: null, error: committed.error };
    }
    return { ok: true, unknown: false, result, error: null };
  }

  function recoveryResult(
    intent: WriteIntent,
    errorCode: string | null,
    knownHash: Hash | null
  ): IpcResult["write.apply"] {
    return buildWriteResult({
      intent,
      state: "recovery_required",
      new_file_hash: knownHash,
      new_block_hash: null,
      three_way_diff_ref: null,
      readback_verified: false,
      error_code: errorCode,
      completed_at: deps.now()
    });
  }

  async function resolveIdempotencyKey(
    context: IpcHandlerContext<"write.apply">,
    fallbackHash: Hash
  ): Promise<string> {
    try {
      const dispatcherHash = computeIdempotencyRequestHash(toJsonValue(context.params));
      const row = deps.connection
        .prepare<Row>(
          `SELECT idempotency_key FROM ipc_idempotency
            WHERE client_id = :client_id
              AND method = 'write.apply'
              AND request_hash = :request_hash
              AND state = 'in_progress'
            ORDER BY created_at DESC LIMIT 1`
        )
        .get({ client_id: context.client_id, request_hash: dispatcherHash });
      if (row !== undefined) {
        const key = stringField(row, "idempotency_key");
        if (key !== null && key.length >= 8) {
          return key;
        }
      }
    } catch {
      // Fall through to the deterministic request key.
    }
    return `wreq:${fallbackHash.slice("sha256:".length)}`;
  }

  /**
   * Re-checks the compare-and-swap precondition of a replayed write.
   *
   * A replay of the same idempotency key must not create a second intent, but
   * it must not report a stale success either: `write.apply` is a
   * compare-and-swap against the live target (DD-FND-091 step 6, "更新前再次
   * 比较 expected hash；不匹配走三方 diff，不覆盖"). When the target no longer
   * holds the bytes the request expected, the retry reports a `conflict`
   * result and leaves the file alone.
   *
   * Returns `null` when the precondition still holds (the retry is a genuine
   * replay) or when the target cannot be inspected (the stored result stands
   * and no conflict is invented).
   */
  async function detectExternalDrift(
    writeDeps: WriteApplyDependencies,
    intent: WriteIntent,
    request: ParsedWriteApplyRequest,
    proposedHash: Hash | null
  ): Promise<Result<IpcResult["write.apply"], ErrorEnvelope> | null> {
    const resolver = writeDeps.root_resolver;
    if (resolver === undefined) {
      return null;
    }
    const registration = readRootRegistration(writeDeps.connection, intent.root_id);
    if (!registration.ok) {
      return null;
    }
    let approvedRoot: string;
    try {
      const resolved = await resolver.resolve({
        root_id: intent.root_id,
        request_id: newId("ipc", writeDeps.now()),
        deadline_ms: 60_000,
        signal: new AbortController().signal
      });
      if (!resolved.ok) {
        return null;
      }
      approvedRoot = resolved.value.approved_root;
    } catch {
      return null;
    }
    const inspection = inspectTargetPath(approvedRoot, intent.target_path);
    if (!inspection.ok) {
      // The path itself is gone or unusable: the write is no longer
      // replayable, but the file state is not a compare-and-swap conflict.
      return null;
    }
    if (!inspection.value.exists || inspection.value.file_hash === null) {
      return null;
    }
    const expected = request.expected_file_hash;
    if (expected === null || inspection.value.file_hash === expected) {
      return null;
    }
    const currentHash = inspection.value.file_hash;
    const diffRef = writeThreeWayDiff({
      blobStore: writeDeps.blob_store,
      writeId: intent.write_id,
      path: request.target_path,
      baseHash: expected,
      currentHash,
      proposedHash: proposedHash ?? currentHash,
      currentByteLength: inspection.value.bytes?.byteLength ?? 0
    });
    return ok({
      schema_version: "rsi.write_result/2",
      write_id: intent.write_id,
      attempt: intent.attempt,
      state: "conflict",
      root_id: intent.root_id,
      path: intent.target_path,
      new_file_hash: null,
      new_block_hash: null,
      snapshot_id: intent.snapshot_id,
      target_snapshot_id: intent.target_snapshot_id,
      target_snapshot_hash: intent.target_snapshot_hash,
      three_way_diff_ref: diffRef,
      readback_verified: false,
      atomicity: intent.atomicity,
      exclusion: intent.exclusion,
      unattended_policy: intent.unattended_policy,
      error_code: "E_CONFLICT",
      completed_at: writeDeps.now()
    });
  }

  function requestHashFromIntentRow(
    row: Row
  ): Result<{ readonly hash: Hash; readonly intent: WriteIntent }, ErrorEnvelope> {
    const intent = writeIntentFromRow(row);
    if (intent === null) {
      return fail(internalError("kernel.write_apply_intent_row_corrupt"));
    }
    if (!isId(intent.candidate_id, "prop")) {
      return fail(internalError("kernel.write_apply_intent_row_corrupt"));
    }
    const hash = writeRequestHash({
      grant_id: intent.grant_id,
      action: intent.action,
      object_type: intent.object_type,
      candidate_id: intent.candidate_id,
      candidate_hash: intent.candidate_hash,
      binding: intent.binding,
      scope_kind: intent.scope_kind,
      scope_ref_id: intent.scope_ref_id,
      root_id: intent.root_id,
      target_path: intent.target_path,
      write_mode: intent.write_mode,
      block_action: intent.block_action === null ? null : (intent.block_action as "update" | "attach" | "detach"),
      block_selector: intent.block_selector,
      expected_file_hash: intent.expected_file_hash === null ? null : (intent.expected_file_hash as Hash),
      expected_block_hash: intent.expected_block_hash === null ? null : (intent.expected_block_hash as Hash),
      rollback_of_write_id: intent.rollback_of_write_id === null ? null : (intent.rollback_of_write_id as Id<"wi">),
      target_snapshot_id: intent.target_snapshot_id === null ? null : (intent.target_snapshot_id as Id<"wsnap">),
      target_snapshot_hash: intent.target_snapshot_hash === null ? null : (intent.target_snapshot_hash as Hash),
      unattended_policy: intent.unattended_policy
    });
    return ok({ hash, intent });
  }

  function pinJson(intent: WriteIntent): string {
    return canonicalJsonText({
      schema_version: intent.root_identity_pin.schema_version,
      root_id: intent.root_identity_pin.root_id,
      identity_kind: intent.root_identity_pin.identity_kind,
      device_id: intent.root_identity_pin.device_id,
      file_id: intent.root_identity_pin.file_id
    });
  }

  async function run(
    context: IpcHandlerContext<"write.apply">,
    state: ExecutionState,
    deadline: Deadline
  ): Promise<Result<IpcResult["write.apply"], ErrorEnvelope>> {
    if (context.signal.aborted) {
      return cancelledFailure();
    }
    if (context.deadline_ms < 1 || performance.now() > deadline.deadline_at) {
      return deadlineFailure();
    }

    const parsed = parseWriteApplyRequest(context.params);
    if (!parsed.ok) {
      return parsed;
    }
    const request = parsed.value;

    const grantResult = await readGrantForRequest(deps.connection, request);
    if (!grantResult.ok) {
      return grantResult;
    }
    const grant = grantResult.value;
    if (!verifyGrantHash(grant)) {
      return fail(internalError("kernel.write_apply_grant_hash_mismatch"));
    }

    const scope = resolveScope(deps.connection, request, grant);
    if (!scope.ok) {
      return scope;
    }

    const incomingRequestHash = writeRequestHash({
      grant_id: request.grant_id,
      action: request.action,
      object_type: request.object_type,
      candidate_id: request.candidate_id,
      candidate_hash: request.candidate_hash,
      binding: request.binding,
      scope_kind: scope.value.scope_kind,
      scope_ref_id: scope.value.scope_ref_id,
      root_id: request.root_id,
      target_path: request.target_path,
      write_mode: request.write_mode,
      block_action: request.block_action,
      block_selector: request.block_selector,
      expected_file_hash: request.expected_file_hash,
      expected_block_hash: request.expected_block_hash,
      rollback_of_write_id: request.rollback_of_write_id,
      target_snapshot_id: request.target_snapshot_id,
      target_snapshot_hash: request.target_snapshot_hash,
      unattended_policy: request.unattended_policy
    });

    const idempotencyKey = await resolveIdempotencyKey(context, incomingRequestHash);
    const existing = deps.connection
      .prepare<Row>("SELECT * FROM write_intent WHERE idempotency_key = :idempotency_key")
      .get({ idempotency_key: idempotencyKey });
    if (existing !== undefined) {
      const stored = requestHashFromIntentRow(existing);
      if (!stored.ok) {
        return stored;
      }
      if (
        stored.value.hash !== incomingRequestHash ||
        stored.value.intent.scope_hash !== scope.value.scope_hash ||
        stored.value.intent.root_id !== request.root_id ||
        stored.value.intent.target_path !== request.target_path
      ) {
        return fail(
          idempotencyConflict(idempotencyKey, stored.value.hash, incomingRequestHash),
          "conflict"
        );
      }
      const rootRow = deps.connection
        .prepare<Row>("SELECT identity_kind, device_id, file_id FROM root_registration WHERE root_id = :root_id")
        .get({ root_id: request.root_id });
      if (rootRow !== undefined) {
        const pin = stored.value.intent.root_identity_pin;
        if (
          stringField(rootRow, "identity_kind") !== pin.identity_kind ||
          stringField(rootRow, "device_id") !== pin.device_id ||
          stringField(rootRow, "file_id") !== pin.file_id
        ) {
          return fail(
            idempotencyConflict(idempotencyKey, stored.value.hash, incomingRequestHash),
            "conflict"
          );
        }
      }
      const latest = readLatestWriteResult(deps.connection, stored.value.intent.write_id);
      if (!latest.ok) {
        return latest;
      }
      if (latest.value !== null) {
        // A stored result is only replayable while the target still matches
        // the request's compare-and-swap precondition. When the file changed
        // underneath, the retry is no longer a replay: the precondition broke
        // and the request must be reported as a conflict (DD-FND-091).
        if (latest.value.state === "verified") {
          const drift = await detectExternalDrift(
            deps,
            stored.value.intent,
            request,
            request.new_content_hash
          );
          if (drift !== null) {
            return drift;
          }
        }
        return ok(latest.value);
      }
      if (journal === null) {
        return ok(recoveryResult(stored.value.intent, null, state.last_known_hash));
      }
      const recovered = await appendAttemptResult({
        intent: stored.value.intent,
        state: "recovery_required",
        new_file_hash: state.last_known_hash,
        new_block_hash: null,
        three_way_diff_ref: null,
        readback_verified: false,
        error_code: null,
        blob_hashes: []
      });
      if (recovered.ok && recovered.result !== null) {
        return ok(recovered.result);
      }
      return ok(recoveryResult(stored.value.intent, recovered.error?.code ?? null, state.last_known_hash));
    }

    // Grant and consumption are re-read after the idempotency check so a
    // replay of a completed write is never invalidated by a later revoke.
    const consumption = readConsumption(deps.connection, grant.grant_id);
    if (!consumption.ok) {
      return consumption;
    }

    if (deps.root_resolver === undefined) {
      return fail(internalError("kernel.write_apply_root_resolver_unavailable"));
    }
    const registration = readRootRegistration(deps.connection, request.root_id);
    if (!registration.ok) {
      return registration;
    }
    const root = await resolveRoot(
      deps.root_resolver,
      registration.value,
      scope.value,
      context,
      deadline.deadline_at
    );
    if (!root.ok) {
      return root;
    }

    const inspection = inspectTargetPath(root.value.approved_root, request.target_path);
    if (!inspection.ok) {
      return inspection;
    }

    let oldBlocks: readonly ManagedBlockSpan[] | null = null;
    if (inspection.value.exists && inspection.value.bytes !== null) {
      // Best effort for ownership classification. The authoritative parse runs
      // after the intent exists and is recorded as a conflict result on error.
      const parsedBlocks = parseManagedBlocks(inspection.value.bytes);
      if (parsedBlocks.ok) {
        oldBlocks = parsedBlocks.value.blocks;
      }
    }
    const ownership = determineTargetOwnership({
      connection: deps.connection,
      absolute_path: inspection.value.absolute_path,
      target_path: request.target_path,
      exists: inspection.value.exists,
      file_hash: inspection.value.file_hash,
      blocks: oldBlocks
    });
    if (!ownership.ok) {
      return ownership;
    }

    const objectType: "skill" | "memory" | "instructions" = request.object_type;
    const decision = evaluateWriteDecision(
      grant,
      {
        object_type: objectType,
        action: request.action,
        candidate_id: request.candidate_id,
        candidate_hash: request.candidate_hash,
        project_id: scope.value.project_id,
        config_space_id: scope.value.config_space_id,
        target_path: request.target_path,
        path_candidates: [inspection.value.absolute_path],
        target_ownership: ownership.value,
        unattended_policy: request.unattended_policy
      },
      { now: deps.now(), consumption: consumption.value }
    );
    if (!decision.allowed) {
      const deniedInput = decision.grant_id === null
        ? { object_type: objectType, reason: decision.reason_code, stage: "write_authorize" }
        : {
            object_type: objectType,
            reason: decision.reason_code,
            grant_id: decision.grant_id,
            stage: "write_authorize"
          };
      return fail(authDenied(deniedInput));
    }

    let contentBytes: Uint8Array | null = null;
    if (request.new_content !== null) {
      const decoded = decodeContent(request.new_content);
      if (!decoded.ok) {
        return decoded;
      }
      contentBytes = decoded.value;
    }
    const contentIsNull = request.action === "rollback" || request.block_action === "detach";
    if (contentIsNull) {
      if (request.new_content_hash !== null || contentBytes !== null) {
        return fail(
          authError({
            code: "E_WRITE_CANDIDATE_HASH",
            stage: "write_content",
            details: { kind: "field", path: "new_content_hash", rule: "null_for_rollback_or_detach" }
          })
        );
      }
    } else {
      if (contentBytes === null || request.new_content_hash === null) {
        return fail(schemaFieldError("new_content", "required"));
      }
      if (hashBytes(contentBytes) !== request.new_content_hash) {
        return fail(
          authError({
            code: "E_WRITE_CANDIDATE_HASH",
            stage: "write_content",
            details: { kind: "field", path: "new_content_hash", rule: "matches_new_content" }
          })
        );
      }
    }

    let rollback: RollbackTargetRead | null = null;
    if (request.action === "rollback") {
      const rollbackResult = validateRollbackRequest(deps.connection, deps.blob_store, request);
      if (!rollbackResult.ok) {
        return rollbackResult;
      }
      rollback = rollbackResult.value;
    }

    if (journal === null) {
      return fail(internalError("kernel.write_apply_journal_unavailable"));
    }
    if (context.signal.aborted) {
      return cancelledFailure();
    }
    if (performance.now() > deadline.deadline_at) {
      return deadlineFailure();
    }

    const createdAt = deps.now();
    const writeId = newId("wi", createdAt);
    const intent: WriteIntent = {
      schema_version: "rsi.write_intent/2",
      write_id: writeId,
      idempotency_key: idempotencyKey,
      grant_id: grant.grant_id,
      action: request.action,
      object_type: objectType,
      candidate_id: request.candidate_id,
      candidate_hash: request.candidate_hash,
      binding: request.binding,
      scope_kind: scope.value.scope_kind,
      scope_ref_id: scope.value.scope_ref_id,
      project_id: scope.value.project_id,
      config_space_id: scope.value.config_space_id,
      scope_hash: scope.value.scope_hash,
      root_id: request.root_id,
      root_identity_pin: root.value.pin,
      root_registration_hash: root.value.registration_hash,
      target_path: request.target_path,
      target_ownership: ownership.value,
      write_mode: request.write_mode,
      block_action: request.block_action,
      block_selector: request.block_selector,
      expected_file_hash: request.expected_file_hash,
      expected_block_hash: request.expected_block_hash,
      snapshot_id: null,
      rollback_of_write_id: request.rollback_of_write_id,
      target_snapshot_id: request.target_snapshot_id,
      target_snapshot_hash: request.target_snapshot_hash,
      atomicity: "single_file_atomic",
      exclusion: "rsi_advisory",
      unattended_policy: request.unattended_policy,
      state: "intent_recorded",
      attempt: 1,
      last_error_code: null,
      row_version: 1,
      created_at: createdAt,
      updated_at: createdAt
    };
    state.intent = intent;

    const intentCreated = await commitEvent({
      event_type: "write.intent_recorded",
      entity_type: "write_intent",
      entity_id: intent.write_id,
      operation: "insert",
      binding: intent.binding,
      row_schema: "rsi.write_intent/2",
      row: intentRow(intent),
      before: null,
      blob_hashes: [],
      project: (tx) => {
        tx.prepare(
          `INSERT INTO write_intent (
             write_id, idempotency_key, grant_id, action, object_type, candidate_id,
             candidate_hash, binding_json, scope_kind, scope_ref_id, project_id,
             config_space_id, scope_hash, root_id, root_identity_pin_json,
             root_registration_hash, target_path, target_ownership, write_mode,
             block_action, block_selector, expected_file_hash, expected_block_hash,
             snapshot_id, rollback_of_write_id, target_snapshot_id, target_snapshot_hash,
             atomicity, exclusion, unattended_policy, state, attempt, last_error_code,
             row_version, created_at, updated_at
           ) VALUES (
             :write_id, :idempotency_key, :grant_id, :action, :object_type, :candidate_id,
             :candidate_hash, :binding_json, :scope_kind, :scope_ref_id, :project_id,
             :config_space_id, :scope_hash, :root_id, :root_identity_pin_json,
             :root_registration_hash, :target_path, :target_ownership, :write_mode,
             :block_action, :block_selector, :expected_file_hash, :expected_block_hash,
             NULL, :rollback_of_write_id, :target_snapshot_id, :target_snapshot_hash,
             :atomicity, :exclusion, :unattended_policy, 'intent_recorded', 1, NULL,
             1, :created_at, :updated_at
           )`
        ).run(intentRow(intent));
        if (grant.mode === "once") {
          const planned = planGrantConsumption({
            grant_id: grant.grant_id,
            write_kind: "managed",
            write_id: intent.write_id,
            consumed_at: createdAt
          });
          if (!planned.ok) {
            throw planned.error;
          }
          const consumed = consumeGrantInTransaction(tx, planned.value);
          if (consumed.state === "failed") {
            throw consumed.error;
          }
          if (consumed.state === "mode_consumed") {
            throw authDenied({
              object_type: objectType,
              reason: "mode_consumed",
              grant_id: grant.grant_id,
              stage: "write_authorize"
            });
          }
        }
      }
    });
    if (!intentCreated.ok) {
      return fail(
        intentCreated.error ?? internalError("kernel.write_apply_intent_commit_failed"),
        intentCreated.unknown ? "unknown" : "rejected"
      );
    }

    // The snapshot is captured from the live file after the intent is durable.
    // A path/type change in this window is a zero-effect path rejection.
    const live = inspectTargetPath(root.value.approved_root, request.target_path);
    if (!live.ok) {
      const rejected = await appendAttemptResult({
        intent,
        state: "path_rejected",
        new_file_hash: null,
        new_block_hash: null,
        three_way_diff_ref: null,
        readback_verified: false,
        error_code: live.error.code,
        blob_hashes: []
      });
      if (rejected.ok && rejected.result !== null) {
        return ok(rejected.result);
      }
      return fail(rejected.error ?? live.error, rejected.unknown ? "unknown" : "conflict");
    }

    const oldBytes = live.value.exists && live.value.bytes !== null
      ? live.value.bytes
      : new Uint8Array(0);
    const oldHash = hashBytes(oldBytes);

    // Snapshot: expected file hash is verified against the live bytes read
    // inside the intent's critical section.
    if (request.action === "create") {
      if (live.value.exists) {
        const diffRef = writeThreeWayDiff({
          blobStore: deps.blob_store,
          writeId: intent.write_id,
          path: request.target_path,
          baseHash: null,
          currentHash: oldHash,
          proposedHash: hashBytes(contentBytes ?? new Uint8Array(0)),
          currentByteLength: oldBytes.length
        });
        const conflict = await appendAttemptResult({
          intent,
          state: "conflict",
          new_file_hash: null,
          new_block_hash: null,
          three_way_diff_ref: diffRef,
          readback_verified: false,
          error_code: "E_CONFLICT",
          blob_hashes: []
        });
        if (conflict.ok && conflict.result !== null) {
          return ok(conflict.result);
        }
        return fail(
          conflict.error ?? kernelError("E_CONFLICT", { details: { kind: "none" }, side_effect: "none" }),
          conflict.unknown ? "unknown" : "conflict"
        );
      }
    } else {
      if (!live.value.exists) {
        const rejected = await appendAttemptResult({
          intent,
          state: "path_rejected",
          new_file_hash: null,
          new_block_hash: null,
          three_way_diff_ref: null,
          readback_verified: false,
          error_code: "E_PATH_CHANGED",
          blob_hashes: []
        });
        if (rejected.ok && rejected.result !== null) {
          return ok(rejected.result);
        }
        return fail(
          rejected.error ?? pathChanged("disappeared"),
          rejected.unknown ? "unknown" : "conflict"
        );
      }
      const expected = request.expected_file_hash;
      if (expected === null || oldHash !== expected) {
        const proposed = contentBytes === null
          ? (rollback?.content ?? new Uint8Array(0))
          : contentBytes;
        const diffRef = writeThreeWayDiff({
          blobStore: deps.blob_store,
          writeId: intent.write_id,
          path: request.target_path,
          baseHash: expected,
          currentHash: oldHash,
          proposedHash: hashBytes(proposed),
          currentByteLength: oldBytes.length
        });
        const conflict = await appendAttemptResult({
          intent,
          state: "conflict",
          new_file_hash: null,
          new_block_hash: null,
          three_way_diff_ref: diffRef,
          readback_verified: false,
          error_code: "E_CONFLICT",
          blob_hashes: []
        });
        if (conflict.ok && conflict.result !== null) {
          return ok(conflict.result);
        }
        return fail(
          conflict.error ?? kernelError("E_CONFLICT", { details: { kind: "none" }, side_effect: "none" }),
          conflict.unknown ? "unknown" : "conflict"
        );
      }
    }

    let proposedBytes: Uint8Array;
    let newBlockHash: Hash | null = null;
    let snapshotBlock: ManagedBlockSpan | null = null;

    if (request.write_mode === "managed_block") {
      const selector = request.block_selector;
      const blockAction = request.block_action;
      if (selector === null || blockAction === null) {
        return fail(schemaFieldError("block_action", "required_for_managed_block"));
      }
      const parsed = parseManagedBlocks(oldBytes);
      if (!parsed.ok) {
        return fail(parsed.error, parsed.status);
      }
      const existing = parsed.value.blocks.filter((block) => block.selector === selector);
      if (existing.length > 1) {
        return fail(
          authError({
            code: "E_BLOCK_AMBIGUOUS",
            stage: "write_block_parse",
            details: { kind: "field", path: "block_selector", rule: "duplicate_selector" }
          })
        );
      }
      const block = existing[0] ?? null;
      const blockCheck = checkExpectedBlockHash({
        block_action: blockAction,
        block,
        expected_block_hash: request.expected_block_hash
      });
      if (!blockCheck.ok) {
        const conflict = await appendAttemptResult({
          intent,
          state: "conflict",
          new_file_hash: null,
          new_block_hash: null,
          three_way_diff_ref: null,
          readback_verified: false,
          error_code: blockCheck.error.code,
          blob_hashes: []
        });
        if (conflict.ok && conflict.result !== null) {
          return ok(conflict.result);
        }
        return fail(
          conflict.error ?? blockCheck.error,
          conflict.unknown ? "unknown" : "conflict"
        );
      }
      const edited = applyManagedBlockEdit({
        bytes: oldBytes,
        selector,
        block_action: blockAction,
        content: blockAction === "detach" ? null : contentBytes
      });
      if (!edited.ok) {
        const conflict = await appendAttemptResult({
          intent,
          state: "conflict",
          new_file_hash: null,
          new_block_hash: null,
          three_way_diff_ref: null,
          readback_verified: false,
          error_code: edited.error.code,
          blob_hashes: []
        });
        if (conflict.ok && conflict.result !== null) {
          return ok(conflict.result);
        }
        return fail(
          conflict.error ?? edited.error,
          conflict.unknown ? "unknown" : "conflict"
        );
      }
      proposedBytes = edited.value.bytes;
      newBlockHash = edited.value.new_block_hash;
      snapshotBlock = edited.value.before;
    } else if (request.action === "rollback") {
      if (rollback === null) {
        return fail(rollbackTargetError("rollback_of_write_id", "missing"));
      }
      proposedBytes = rollback.content;
    } else {
      if (contentBytes === null) {
        return fail(schemaFieldError("new_content", "required"));
      }
      proposedBytes = contentBytes;
    }

    const snapshotId = newId("wsnap", deps.now());
    const storedBlob = deps.blob_store.putSync(oldBytes);
    if (!storedBlob.ok) {
      const failed = await appendAttemptResult({
        intent,
        state: "write_failed",
        new_file_hash: null,
        new_block_hash: null,
        three_way_diff_ref: null,
        readback_verified: false,
        error_code: storedBlob.error.code,
        blob_hashes: []
      });
      if (failed.ok && failed.result !== null) {
        return ok(failed.result);
      }
      return fail(failed.error ?? storedBlob.error, failed.unknown ? "unknown" : "rejected");
    }
    const contentRef = blobSourceRef(storedBlob.value.hash, oldBytes.length);
    const snapshotWithoutHash: Omit<WriteSnapshot, "snapshot_hash"> = {
      snapshot_id: snapshotId,
      write_id: intent.write_id,
      path: request.target_path,
      write_mode: request.write_mode,
      file_hash: oldHash,
      file_byte_length: oldBytes.length,
      block_action: request.write_mode === "managed_block" ? request.block_action : null,
      block_selector: request.write_mode === "managed_block" ? request.block_selector : null,
      block_start: snapshotBlock?.begin_start ?? null,
      block_byte_length: snapshotBlock?.block_byte_length ?? null,
      block_content_hash: snapshotBlock?.content_hash ?? null,
      block_hash: snapshotBlock?.block_hash ?? null,
      content_ref: contentRef,
      created_at: deps.now()
    };
    const snapshot: WriteSnapshot = {
      ...snapshotWithoutHash,
      snapshot_hash: writeSnapshotHash(snapshotWithoutHash)
    };
    const snapshotIntent: WriteIntent = { ...intent, snapshot_id: snapshotId };
    const snapshotCommitted = await commitEvent({
      event_type: "write.snapshot_recorded",
      entity_type: "write_snapshot",
      entity_id: snapshotId,
      operation: "insert",
      binding: intent.binding,
      row_schema: "rsi.write_snapshot/2",
      row: snapshotRow(snapshot),
      before: null,
      blob_hashes: [storedBlob.value.hash],
      project: (tx) => {
        tx.prepare(
          `INSERT INTO blob (blob_hash, byte_length, relative_path, state, verified_at, created_at, deleted_at, deletion_reason)
           VALUES (:blob_hash, :byte_length, :relative_path, 'present', :verified_at, :created_at, NULL, NULL)
           ON CONFLICT(blob_hash) DO UPDATE SET
             state = 'present',
             verified_at = excluded.verified_at,
             deleted_at = NULL,
             deletion_reason = NULL`
        ).run({
          blob_hash: storedBlob.value.hash,
          byte_length: storedBlob.value.byte_length,
          relative_path: storedBlob.value.relative_path,
          verified_at: deps.now(),
          created_at: deps.now()
        });
        tx.prepare(
          `INSERT INTO blob_ref (blob_hash, owner_type, owner_id, source_ref, created_at)
           VALUES (:blob_hash, 'write', :owner_id, :source_ref, :created_at)
           ON CONFLICT(blob_hash, owner_type, owner_id) DO NOTHING`
        ).run({
          blob_hash: storedBlob.value.hash,
          owner_id: intent.write_id,
          source_ref: contentRef,
          created_at: deps.now()
        });
        tx.prepare(
          `INSERT INTO write_snapshot (
             snapshot_id, write_id, path, write_mode, file_hash, file_byte_length,
             block_action, block_selector, block_start, block_byte_length,
             block_content_hash, block_hash, content_ref, snapshot_hash, created_at
           ) VALUES (
             :snapshot_id, :write_id, :path, :write_mode, :file_hash, :file_byte_length,
             :block_action, :block_selector, :block_start, :block_byte_length,
             :block_content_hash, :block_hash, :content_ref, :snapshot_hash, :created_at
           )`
        ).run(snapshotRow(snapshot));
        const updated = tx.prepare(
          `UPDATE write_intent
              SET snapshot_id = :snapshot_id,
                  state = 'snapshot_written',
                  row_version = :row_version,
                  updated_at = :updated_at
            WHERE write_id = :write_id AND row_version = :expected_row_version`
        ).run({
          snapshot_id: snapshotId,
          row_version: intent.row_version + 1,
          updated_at: deps.now(),
          write_id: intent.write_id,
          expected_row_version: intent.row_version
        });
        if (updated.changes !== 1) {
          throw writeStateError("row_version_cas");
        }
      }
    });
    if (!snapshotCommitted.ok) {
      return fail(
        snapshotCommitted.error ?? internalError("kernel.write_apply_snapshot_commit_failed"),
        snapshotCommitted.unknown ? "unknown" : "rejected"
      );
    }

    const snapshotWritten: WriteIntent = {
      ...snapshotIntent,
      state: "snapshot_written",
      row_version: intent.row_version + 1,
      updated_at: deps.now()
    };
    state.intent = snapshotWritten;

    const parent = dirname(live.value.absolute_path);
    const mode = live.value.mode;
    const temp = writeTempFile({ directory: parent, bytes: proposedBytes, mode });
    if (!temp.ok) {
      const failed = await appendAttemptResult({
        intent: snapshotWritten,
        state: "write_failed",
        new_file_hash: null,
        new_block_hash: null,
        three_way_diff_ref: null,
        readback_verified: false,
        error_code: temp.error.code,
        blob_hashes: []
      });
      if (failed.ok && failed.result !== null) {
        return ok(failed.result);
      }
      return fail(failed.error ?? temp.error, failed.unknown ? "unknown" : "rejected");
    }
    const tempPath = temp.value.path;

    const tempTransition = await transitionIntent({
      intent: snapshotWritten,
      to: "temp_written",
      error_code: null
    });
    if (!tempTransition.ok || tempTransition.intent === null) {
      removeTempFile(tempPath);
      return fail(
        tempTransition.error ?? internalError("kernel.write_apply_temp_transition_failed"),
        tempTransition.unknown ? "unknown" : "rejected"
      );
    }
    state.intent = tempTransition.intent;

    const preRename = inspectTargetPath(root.value.approved_root, request.target_path);
    if (!preRename.ok) {
      removeTempFile(tempPath);
      const rejected = await appendAttemptResult({
        intent: tempTransition.intent,
        state: "path_rejected",
        new_file_hash: null,
        new_block_hash: null,
        three_way_diff_ref: null,
        readback_verified: false,
        error_code: preRename.error.code,
        blob_hashes: []
      });
      if (rejected.ok && rejected.result !== null) {
        return ok(rejected.result);
      }
      return fail(rejected.error ?? preRename.error, rejected.unknown ? "unknown" : "conflict");
    }
    const preRenameHash = preRename.value.file_hash;
    if (preRename.value.exists !== live.value.exists || preRenameHash !== live.value.file_hash) {
      removeTempFile(tempPath);
      const conflict = await appendAttemptResult({
        intent: tempTransition.intent,
        state: "conflict",
        new_file_hash: null,
        new_block_hash: null,
        three_way_diff_ref: writeThreeWayDiff({
          blobStore: deps.blob_store,
          writeId: intent.write_id,
          path: request.target_path,
          baseHash: request.expected_file_hash,
          currentHash: preRenameHash ?? hashBytes(new Uint8Array(0)),
          proposedHash: hashBytes(proposedBytes),
          currentByteLength: preRename.value.bytes?.length ?? 0
        }),
        readback_verified: false,
        error_code: "E_CONFLICT",
        blob_hashes: []
      });
      if (conflict.ok && conflict.result !== null) {
        return ok(conflict.result);
      }
      return fail(
        conflict.error ?? kernelError("E_CONFLICT", { details: { kind: "none" }, side_effect: "none" }),
        conflict.unknown ? "unknown" : "conflict"
      );
    }

    try {
      renameSync(tempPath, live.value.absolute_path);
    } catch (error) {
      removeTempFile(tempPath);
      const failed = await appendAttemptResult({
        intent: tempTransition.intent,
        state: "write_failed",
        new_file_hash: null,
        new_block_hash: null,
        three_way_diff_ref: null,
        readback_verified: false,
        error_code: fsCode(error) ?? "E_IO",
        blob_hashes: []
      });
      if (failed.ok && failed.result !== null) {
        return ok(failed.result);
      }
      return fail(
        failed.error ?? ioError("rename_target", "none", fsCode(error)),
        failed.unknown ? "unknown" : "rejected"
      );
    }
    state.post_rename = true;
    state.last_known_hash = hashBytes(proposedBytes);

    const renamedTransition = await transitionIntent({
      intent: tempTransition.intent,
      to: "renamed",
      error_code: null
    });
    if (!renamedTransition.ok || renamedTransition.intent === null) {
      return ok(recoveryResult(
        tempTransition.intent,
        renamedTransition.error?.code ?? "E_INTERNAL",
        state.last_known_hash
      ));
    }
    state.intent = renamedTransition.intent;

    const dirSync = fsyncDirectory(parent);
    if (!dirSync.ok) {
      return ok(recoveryResult(renamedTransition.intent, dirSync.error.code, state.last_known_hash));
    }
    const dirTransition = await transitionIntent({
      intent: renamedTransition.intent,
      to: "dir_synced",
      error_code: null
    });
    if (!dirTransition.ok || dirTransition.intent === null) {
      return ok(recoveryResult(
        renamedTransition.intent,
        dirTransition.error?.code ?? "E_INTERNAL",
        state.last_known_hash
      ));
    }
    state.intent = dirTransition.intent;

    const readback = readFileNoFollow(live.value.absolute_path, preRename.value.root_device);
    if (!readback.ok) {
      return ok(recoveryResult(dirTransition.intent, readback.error.code, state.last_known_hash));
    }
    if (readback.value === null) {
      return ok(recoveryResult(dirTransition.intent, "E_PATH_CHANGED", state.last_known_hash));
    }
    const readbackHash = hashBytes(readback.value);
    let verified = readbackHash === hashBytes(proposedBytes);
    let readbackBlockHash: Hash | null = null;
    if (verified && request.write_mode === "managed_block" && request.block_selector !== null) {
      const parsedReadback = parseManagedBlocks(readback.value);
      if (!parsedReadback.ok) {
        verified = false;
      } else {
        const blocks = parsedReadback.value.blocks.filter(
          (block) => block.selector === request.block_selector
        );
        if (request.block_action === "detach") {
          verified = blocks.length === 0;
        } else {
          const block = blocks[0];
          if (block === undefined) {
            verified = false;
          } else {
            readbackBlockHash = block.block_hash;
            verified = newBlockHash !== null && block.block_hash === newBlockHash;
          }
        }
      }
    }
    if (!verified) {
      return ok(recoveryResult(dirTransition.intent, "E_INTERNAL", readbackHash));
    }
    if (request.action === "rollback" && rollback !== null) {
      if (readbackHash !== rollback.snapshot.file_hash) {
        return ok(recoveryResult(dirTransition.intent, "E_WRITE_ROLLBACK_TARGET", readbackHash));
      }
    }
    state.last_known_hash = readbackHash;

    const verifiedResult = await appendAttemptResult({
      intent: dirTransition.intent,
      state: "verified",
      new_file_hash: readbackHash,
      new_block_hash: readbackBlockHash,
      three_way_diff_ref: null,
      readback_verified: true,
      error_code: null,
      blob_hashes: rollback === null ? [] : [rollback.snapshot.file_hash]
    });
    if (verifiedResult.ok && verifiedResult.result !== null) {
      return ok(verifiedResult.result);
    }
    return ok(recoveryResult(dirTransition.intent, verifiedResult.error?.code ?? "E_INTERNAL", readbackHash));
  }

  async function readGrantForRequest(
    connection: SqliteConnection,
    request: ParsedWriteApplyRequest
  ): Promise<Result<AuthorizationGrant, ErrorEnvelope>> {
    const row = connection
      .prepare<Row>("SELECT * FROM authorization_grant WHERE grant_id = :grant_id")
      .get({ grant_id: request.grant_id });
    if (row === undefined) {
      return fail(authDenied({ object_type: "write", reason: "no_grant", stage: "write_authorize" }));
    }
    const grant = grantFromRow(row);
    if (grant === null) {
      return fail(internalError("kernel.write_apply_grant_row_corrupt"));
    }
    return ok(grant);
  }

  return async (
    context: IpcHandlerContext<"write.apply">
  ): Promise<Result<IpcResult["write.apply"], ErrorEnvelope>> => {
    const started = performance.now();
    const state: ExecutionState = {
      post_rename: false,
      intent: null,
      last_known_hash: null,
      last_error_code: null
    };
    try {
      return await run(context, state, { deadline_at: started + context.deadline_ms });
    } catch (error) {
      if (state.post_rename && state.intent !== null) {
        return ok(recoveryResult(
          state.intent,
          state.last_error_code ?? "E_INTERNAL",
          state.last_known_hash
        ));
      }
      if (context.signal.aborted) {
        return cancelledFailure();
      }
      return fail(internalError("kernel.write_apply_unhandled"));
    }
  };
}
