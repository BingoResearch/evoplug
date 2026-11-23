/**
 * In-process `ConfigWritePort` (DD-FND-095).
 *
 * FND owns the config-write half of the production-config path: grant
 * re-evaluation, root/path checks, the per-path lock and fencing token, the
 * durable commit claim, the single-file atomic replace, readback verification
 * and terminal result rows. CFG supplies a pure `ConfigPatchApplyPort`; this
 * module never parses or serializes configuration syntax.
 *
 * Absolute paths (`approved_root`, the concrete target path) live only in this
 * call stack. Durable rows, journal frames, hashes and error envelopes carry
 * `root_id` plus the relative `target_path` only.
 *
 * Missing root resolver / apply port / journal fail closed. No method invents
 * a lock, an intent, a result or a success.
 */

import { randomBytes, } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { type ConfigAssignmentValue, type ConfigFieldAssignment, type ConfigFieldMutation, type ConfigFilePath, type ConfigPatchApplyOutput, type ConfigPatchApplyPort, type ConfigPatchApplyResult, type ConfigProtectedSubtree, type ConfigProtectedSubtreeProof, type ConfigWriteAbortAck, type ConfigWriteAbortRequest, type ConfigWriteCommitRequest, type ConfigWriteIntent, type ConfigWriteLock, type ConfigWriteLockRequest, type ConfigWritePatch, type ConfigWritePort, type ConfigWriteResult, type ConfigWriteSnapshot, type ConfigWriteState, type ConfigWriteTerminalState, type ErrorEnvelope, type FailureStatus, type Hash, type Id, type JsonValue, type ResolvedRoot, type Result, type RootIdentityPin, type RootResolver, type SourceRef, type Tx, type VersionBinding, type WriteDecision } from "@evoplug/core";
import {
  CONFIG_WRITE_ACTIVE_STATES,
  CONFIG_WRITE_INTENT_SCHEMA_VERSION,
  CONFIG_WRITE_LOCK_TTL_MS,
  CONFIG_WRITE_MAX_CONTENT_BYTES,
  CONFIG_WRITE_RESULT_SCHEMA_VERSION,
  CONFIG_WRITE_SCHEMA_VERSION,
  CONFIG_WRITE_SNAPSHOT_SCHEMA_VERSION,
  canonicalHash,
  canonicalJsonText,
  compareUtf8,
  err,
  formatSourceRef,
  hashBytes,
  isConfigWriteState,
  isConfigWriteTerminalState,
  isHash,
  isId,
  isSourceRef,
  isWriteDenyReasonCode,
  makeErrorEnvelope,
  newId,
  ok,
  parseVersionBinding,
  toJsonValue
} from "@evoplug/core";
import {
  BlobStore,
  createTransactionRunner,
  isErrorEnvelope,
  mapSqliteFailure,
  type JournalAppendResult,
  type JournalCommitter,
  type SqliteConnection,
  type TransactionRunner
} from "@evoplug/storage";
import {
  consumeGrantInTransaction,
  planGrantConsumption
} from "./consumption.js";

import {
  configApplyError,
  configStaleError,
  fieldError,
  authConfigScope,
  authDenied,
  authError,
  idempotencyConflict
} from "./errors.js";
import {
  configLockKey,
  configWriteRequestHash,
  validateConfigWriteCommitRequest,
  validateConfigWriteLockRequest,
  validateConfigWritePatch
} from "./config-patch.js";
import type { AuthorizationGrant, GrantScope } from "./grants.js";
import { evaluateWriteDecision } from "./decision.js";
import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return sharedIsRecord(value);
}

/* ------------------------------------------------------------------ */
/* Public dependency contract                                          */
/* ------------------------------------------------------------------ */

/**
 * Dependencies of the FND config-write port.
 *
 * `root_resolver`, `apply_port` and `journal` are optional so a composition
 * that lacks one fails closed with a typed internal error instead of writing
 * a lock, an intent or a file.
 */
export interface ConfigWritePortDependencies {
  /** The single kernel writer connection. */
  readonly connection: SqliteConnection;
  readonly blob_store: BlobStore;
  /** Wall clock; never enters a hash. */
  readonly now: () => number;
  /** Monotonic source for deadline accounting; defaults to `performance.now`. */
  readonly monotonic?: () => number;
  /** FND journal committer; absent means every durable step fails closed. */
  readonly journal?: JournalCommitter;
  /** Host-owned root resolution (DD-FND-095.0). */
  readonly root_resolver?: RootResolver;
  /** CFG-owned pure parser/apply port. */
  readonly apply_port?: ConfigPatchApplyPort;
  /**
   * Current kernel process instance identity. Never supplied by a caller of
   * the port; defaults to a per-process value.
   */
  readonly holder_client_id?: string;
}

/** One reconciled intent, reported without any absolute path. */
interface ConfigWriteReconcileEntry {
  readonly config_write_id: Id<"cwi">;
  readonly state: ConfigWriteTerminalState;
}

/** Startup reconciliation summary (DD-FND-095.5). */
interface ConfigWriteReconcileReport {
  readonly released_locks: number;
  readonly scanned_intents: number;
  readonly entries: readonly ConfigWriteReconcileEntry[];
}

/* ------------------------------------------------------------------ */
/* Constants and local primitives                                     */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

const ACTIVE_STATES: readonly ConfigWriteState[] = CONFIG_WRITE_ACTIVE_STATES;
const UNCERTAIN_STATES: readonly ConfigWriteTerminalState[] = ["uncertain", "recovery_required"];
const LOCK_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TEMP_PREFIX = ".rsi-config-";
const DEFAULT_HOLDER: string = `kernel:${String(process.pid)}:${randomBytes(8).toString("hex")}`;

function okResult<T>(value: T): Result<T, ErrorEnvelope> {
  return { ok: true, status: "ok", value };
}

function failResult<T>(error: ErrorEnvelope, status: FailureStatus = "rejected"): Result<T, ErrorEnvelope> {
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

function nullableString(row: Row, key: string): string | null {
  return stringField(row, key);
}

function nullableNumber(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function isActiveState(value: string): boolean {
  return (ACTIVE_STATES as readonly string[]).includes(value);
}

function isTerminalStateValue(value: string): value is ConfigWriteTerminalState {
  return isConfigWriteTerminalState(value);
}

function internalFailure(stage: string, incidentId: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_INTERNAL",
    category: "internal",
    message_key: "error.internal",
    stage,
    details: { kind: "internal", incident_id: incidentId }
  });
}

function lockedFailure(): ErrorEnvelope {
  return authError({
    code: "E_WRITE_CONFIG_LOCKED",
    stage: "config_write_lock",
    details: { kind: "none" }
  });
}

function recoveryFailure(): ErrorEnvelope {
  return authError({
    code: "E_WRITE_CONFIG_RECOVERY_REQUIRED",
    stage: "config_write_lock",
    details: { kind: "none" }
  });
}

function inProgressFailure(): ErrorEnvelope {
  return authError({
    code: "E_WRITE_CONFIG_IN_PROGRESS",
    stage: "config_write_commit",
    details: { kind: "none" }
  });
}

function pathFailure(rule: string, stage = "config_write_path"): ErrorEnvelope {
  return fieldError("E_WRITE_CONFIG_PATH", "target_path", rule, stage);
}

function contentFailure(rule: string): ErrorEnvelope {
  return fieldError("E_WRITE_CONFIG_CONTENT", "new_content", rule, "config_write_apply");
}

function storageFailure(stage: string, operation: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_STORAGE_IO",
    category: "storage",
    message_key: "error.e_storage_io",
    stage,
    details: { kind: "storage", operation }
  });
}

function fsCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const value = error["code"];
  return typeof value === "string" ? value : undefined;
}

function deadlineFailure(): Result<never, ErrorEnvelope> {
  return failResult(
    authError({ code: "E_DEADLINE_EXCEEDED", stage: "config_write", details: { kind: "none" } }),
    "degraded"
  );
}

function cancelledFailure(): Result<never, ErrorEnvelope> {
  return failResult(
    authError({ code: "E_CANCELLED", stage: "config_write", details: { kind: "none" } }),
    "degraded"
  );
}

function blobSourceRef(hash: Hash, byteLength: number): SourceRef {
  if (byteLength > 0) {
    const formatted = formatSourceRef({ scheme: "blob", locator: hash, start: 0, end: byteLength });
    if (formatted.ok) {
      return formatted.value;
    }
  }
  return `blob://${hash}#bytes=0-0` as SourceRef;
}

function hashHandle(handle: string): Hash {
  return hashBytes(new TextEncoder().encode(handle));
}

function newLockHandle(): string {
  return randomBytes(32).toString("base64url");
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

function pinJson(pin: RootIdentityPin): JsonValue {
  return {
    schema_version: pin.schema_version,
    root_id: pin.root_id,
    identity_kind: pin.identity_kind,
    device_id: pin.device_id,
    file_id: pin.file_id
  };
}

function parsePin(value: unknown, rootId: string): RootIdentityPin | null {
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

function pinsEqual(
  left: { readonly identity_kind: string; readonly device_id: string; readonly file_id: string },
  right: { readonly identity_kind: string; readonly device_id: string; readonly file_id: string }
): boolean {
  return (
    left.identity_kind === right.identity_kind &&
    left.device_id === right.device_id &&
    left.file_id === right.file_id
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function assignmentValueJson(value: ConfigWritePatch["candidate_values"][number]["value"]): JsonValue {
  return value.presence === "present"
    ? { presence: "present", value: value.value }
    : { presence: "absent" };
}

function pathJson(path: ConfigWritePatch["expected_fields"][number]["path"]): JsonValue {
  return {
    kind: path.kind,
    format: path.format,
    root: path.root,
    relative_path: path.relative_path,
    pointer: path.pointer,
    create: path.create
  };
}

function assignmentJson(assignment: ConfigWritePatch["expected_fields"][number]): JsonValue {
  return {
    field_id: assignment.field_id,
    path: pathJson(assignment.path),
    value: assignmentValueJson(assignment.value)
  };
}

function mutationJson(mutation: ConfigWritePatch["mutations"][number]): JsonValue {
  if (mutation.op === "set") {
    return {
      op: "set",
      field_id: mutation.field_id,
      path: pathJson(mutation.path),
      value: mutation.value
    };
  }
  return { op: "remove", field_id: mutation.field_id, path: pathJson(mutation.path) };
}

function patchJson(patch: ConfigWritePatch): JsonValue {
  return {
    schema_version: patch.schema_version,
    config_space_id: patch.config_space_id,
    field_registry_snapshot_hash: patch.field_registry_snapshot_hash,
    layer_id: patch.layer_id,
    model_scope_key: patch.model_scope_key,
    target_path: patch.target_path,
    expected_fields: patch.expected_fields.map(assignmentJson),
    mutations: patch.mutations.map(mutationJson),
    protected_subtrees: patch.protected_subtrees.map((subtree) => ({
      path: subtree.path,
      semantic_hash: subtree.semantic_hash
    })),
    candidate_values: patch.candidate_values.map(assignmentJson),
    patch_hash: patch.patch_hash
  };
}

function proofJson(proof: readonly ConfigProtectedSubtreeProof[]): JsonValue {
  return proof.map((entry) => ({
    path: entry.path,
    expected_semantic_hash: entry.expected_semantic_hash,
    before_semantic_hash: entry.before_semantic_hash,
    after_semantic_hash: entry.after_semantic_hash
  }));
}

function decisionJson(decision: WriteDecision): JsonValue {
  return toJsonValue(decision);
}

/* ------------------------------------------------------------------ */
/* Root and target-path inspection                                    */
/* ------------------------------------------------------------------ */

interface RootRegistrationFacts {
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
): Result<RootRegistrationFacts, ErrorEnvelope> {
  let row: Row | undefined;
  try {
    row = connection
      .prepare<Row>(
        `SELECT root_id, registration_hash, config_space, identity_kind, device_id, file_id
           FROM root_registration WHERE root_id = :root_id`
      )
      .get({ root_id: rootId });
  } catch (error) {
    return err(mapSqliteFailure(error, "config_write_root", "read_root_registration"), "degraded");
  }
  if (row === undefined) {
    return err(
      authError({
        code: "E_ROOT_NOT_FOUND",
        stage: "config_write_root",
        details: { kind: "field", path: "root_id", rule: "not_registered" }
      })
    );
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
    return err(internalFailure("config_write_root", "fnd.config_write_root_row_corrupt"));
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

interface RootContext {
  readonly approved_root: string;
  readonly pin: RootIdentityPin;
}

/**
 * Resolves the root and checks it against the durable registration row and,
 * when supplied, the caller's pin and absolute path. The approved path never
 * leaves this call stack.
 */
async function resolveRootContext(
  resolver: RootResolver,
  input: {
    readonly root_id: string;
    readonly deadline_at: number;
    readonly signal?: AbortSignal;
    readonly request_id: string;
    readonly expected_path?: string;
    readonly expected_pin?: RootIdentityPin;
  },
  monotonic: () => number
): Promise<Result<RootContext, ErrorEnvelope>> {
  const remaining = Math.floor(input.deadline_at - monotonic());
  if (remaining < 1) {
    return deadlineFailure();
  }
  const resolved = await resolver.resolve({
    root_id: input.root_id,
    request_id: input.request_id,
    deadline_ms: remaining,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  }).catch((): Result<ResolvedRoot, ErrorEnvelope> => failResult(
    makeErrorEnvelope({
      code: "E_ROOT_UNAVAILABLE",
      category: "source",
      message_key: "error.root.unavailable",
      stage: "config_write_root",
      details: { kind: "none" }
    }),
    "degraded"
  ));
  if (!resolved.ok) {
    return resolved;
  }
  if (input.signal !== undefined && input.signal.aborted) {
    return cancelledFailure();
  }
  return validateResolvedRoot(resolved.value, input);
}

function validateResolvedRoot(
  resolved: ResolvedRoot,
  input: {
    readonly root_id: string;
    readonly expected_path?: string;
    readonly expected_pin?: RootIdentityPin;
  }
): Result<RootContext, ErrorEnvelope> {
  if (resolved.root_id !== input.root_id) {
    return err(
      authError({
        code: "E_ROOT_IDENTITY_MISMATCH",
        stage: "config_write_root",
        details: { kind: "field", path: "root_id", rule: "resolver_root_mismatch" }
      })
    );
  }
  const pin = resolved.root_identity_pin;
  if (
    pin.schema_version !== "rsi.root_identity/1" ||
    pin.root_id !== input.root_id ||
    (pin.identity_kind !== "dev_inode" && pin.identity_kind !== "file_id") ||
    typeof pin.device_id !== "string" ||
    typeof pin.file_id !== "string"
  ) {
    return err(
      authError({
        code: "E_ROOT_IDENTITY_MISMATCH",
        stage: "config_write_root",
        details: { kind: "field", path: "root_identity_pin", rule: "shape" }
      })
    );
  }
  if (input.expected_pin !== undefined && !pinsEqual(pin, input.expected_pin)) {
    return err(
      authError({
        code: "E_ROOT_IDENTITY_MISMATCH",
        stage: "config_write_root",
        details: { kind: "field", path: "root_identity_pin", rule: "pinned_pin_mismatch" }
      })
    );
  }
  if (!isAbsolute(resolved.approved_root) || resolved.approved_root.includes("\u0000")) {
    return err(
      authError({
        code: "E_ROOT_INVALID",
        stage: "config_write_root",
        details: { kind: "field", path: "approved_root", rule: "absolute" }
      })
    );
  }
  let realRoot: string;
  try {
    const stats = lstatSync(resolved.approved_root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return err(
        authError({
          code: "E_ROOT_UNAVAILABLE",
          stage: "config_write_root",
          details: { kind: "field", path: "approved_root", rule: "not_a_directory" }
        })
      );
    }
    realRoot = realpathSync(resolved.approved_root);
  } catch {
    return err(
      authError({
        code: "E_ROOT_UNAVAILABLE",
        stage: "config_write_root",
        details: { kind: "field", path: "approved_root", rule: "unreadable" }
      }),
      "degraded"
    );
  }
  if (realRoot !== resolved.approved_root) {
    return err(
      authError({
        code: "E_ROOT_IDENTITY_MISMATCH",
        stage: "config_write_root",
        details: { kind: "field", path: "approved_root", rule: "realpath_not_equal" }
      })
    );
  }
  if (input.expected_path !== undefined && input.expected_path !== realRoot) {
    return err(pathFailure("approved_root_changed", "config_write_root"));
  }
  return ok({ approved_root: realRoot, pin });
}

interface TargetFile {
  readonly absolute_path: string;
  readonly bytes: Uint8Array;
  readonly file_hash: Hash;
  readonly mode: number;
  readonly directory: string;
  readonly base_name: string;
  readonly root_device: number;
  readonly stat_device: number;
  readonly stat_inode: number;
}

/**
 * Walks every component under the approved root with `lstat`, rejecting
 * symlinks, cross-device mounts, non-regular files, hard links and special
 * mode bits. Missing targets return `null` when `allow_missing` is set.
 */
function inspectTargetFile(
  approvedRoot: string,
  relativePath: string,
  allowMissing: boolean
): Result<TargetFile | null, ErrorEnvelope> {
  let rootStats;
  try {
    rootStats = lstatSync(approvedRoot, { bigint: true });
  } catch {
    return failResult(
      authError({
        code: "E_ROOT_UNAVAILABLE",
        stage: "config_write_path",
        details: { kind: "field", path: "approved_root", rule: "unreadable" }
      }),
      "degraded"
    );
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    return err(pathFailure("root_not_directory"));
  }
  const absolute = resolvePath(approvedRoot, relativePath);
  if (absolute !== approvedRoot && !absolute.startsWith(approvedRoot + sep)) {
    return err(pathFailure("outside_approved_root"));
  }
  const segments = relativePath.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) {
    return err(pathFailure("target_is_root"));
  }
  let current = approvedRoot;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      return err(pathFailure("empty_segment"));
    }
    current = join(current, segment);
    const last = index === segments.length - 1;
    let stats;
    try {
      stats = lstatSync(current, { bigint: true });
    } catch (error) {
      if (fsCode(error) === "ENOENT") {
        if (last && allowMissing) {
          return ok(null);
        }
        return err(pathFailure(last ? "target_missing" : "parent_missing"));
      }
      return failResult(storageFailure("config_write_path", "lstat_target"), "degraded");
    }
    if (stats.isSymbolicLink()) {
      return err(pathFailure("symlink_component"));
    }
    if (stats.dev !== rootStats.dev) {
      return err(pathFailure("cross_device_mount"));
    }
    if (!last) {
      if (!stats.isDirectory()) {
        return err(pathFailure("parent_not_directory"));
      }
      continue;
    }
    if (!stats.isFile()) {
      return err(pathFailure("not_regular_file"));
    }
    if (stats.nlink !== 1n) {
      return err(pathFailure("hardlink_count"));
    }
    if ((stats.mode & 0o7000n) !== 0n) {
      return err(pathFailure("special_mode_bits"));
    }
    const read = readFileNoFollow(absolute, rootStats.dev);
    if (!read.ok) {
      return read;
    }
    if (read.value === null) {
      return err(pathFailure("disappeared"));
    }
    return ok({
      absolute_path: absolute,
      bytes: read.value,
      file_hash: hashBytes(read.value),
      mode: Number(stats.mode & 0o777n),
      directory: dirname(absolute),
      base_name: segment,
      root_device: Number(rootStats.dev),
      stat_device: Number(stats.dev),
      stat_inode: Number(stats.ino)
    });
  }
  return err(pathFailure("unreachable"));
}

function readFileNoFollow(
  absolutePath: string,
  rootDevice: bigint
): Result<Uint8Array | null, ErrorEnvelope> {
  let fd: number;
  try {
    fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (fsCode(error) === "ENOENT") {
      return ok(null);
    }
    if (fsCode(error) === "ELOOP") {
      return err(pathFailure("symlink_swap"));
    }
    return failResult(storageFailure("config_write_path", "open_target"), "degraded");
  }
  try {
    const stats = fstatSync(fd, { bigint: true });
    if (!stats.isFile()) {
      return err(pathFailure("not_regular_file"));
    }
    if (stats.nlink !== 1n) {
      return err(pathFailure("hardlink_count"));
    }
    if (stats.dev !== rootDevice) {
      return err(pathFailure("cross_device_mount"));
    }
    if ((stats.mode & 0o7000n) !== 0n) {
      return err(pathFailure("special_mode_bits"));
    }
    return ok(new Uint8Array(readFileSync(fd)));
  } catch {
    return failResult(storageFailure("config_write_path", "read_target"), "degraded");
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Secondary close failure does not change the outcome.
    }
  }
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

function createTempFile(input: {
  readonly directory: string;
  readonly base_name: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
}): Result<{ readonly path: string }, ErrorEnvelope> {
  const path = join(input.directory, `${TEMP_PREFIX}${input.base_name}-${randomBytes(8).toString("hex")}`);
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      input.mode & 0o777
    );
  } catch {
    return failResult(storageFailure("config_write_temp", "create_temp"), "degraded");
  }
  try {
    writeAll(fd, input.bytes);
    fsyncSync(fd);
    closeSync(fd);
    return ok({ path });
  } catch {
    try {
      closeSync(fd);
    } catch {
      // Secondary close failure.
    }
    try {
      unlinkSync(path);
    } catch {
      // Temporary file may already be gone.
    }
    return failResult(storageFailure("config_write_temp", "write_temp"), "degraded");
  }
}

function removeTempFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Maintenance GC owns residual temporary files.
  }
}

/** Removes attempt-owned temporary files left next to a terminal target. */
function removeAttemptTempFiles(approvedRoot: string, relativePath: string): void {
  const absolute = resolvePath(approvedRoot, relativePath);
  const directory = dirname(absolute);
  const baseName = absolute.slice(directory.length + 1);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  const prefix = `${TEMP_PREFIX}${baseName}-`;
  for (const name of names) {
    if (name.startsWith(prefix)) {
      removeTempFile(join(directory, name));
    }
  }
}

function fsyncDirectory(directory: string): Result<void, ErrorEnvelope> {
  let fd: number;
  try {
    fd = openSync(directory, constants.O_RDONLY);
  } catch {
    return failResult(storageFailure("config_write_fsync", "open_parent_dir"), "degraded");
  }
  try {
    fsyncSync(fd);
    return ok(undefined);
  } catch {
    return failResult(storageFailure("config_write_fsync", "fsync_parent_dir"), "unknown");
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Secondary close failure.
    }
  }
}

function readBackHash(path: string): Result<Hash | null, ErrorEnvelope> {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile()) {
        return ok(null);
      }
      return ok(hashBytes(new Uint8Array(readFileSync(fd))));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (fsCode(error) === "ENOENT") {
      return ok(null);
    }
    return failResult(storageFailure("config_write_readback", "read_back"), "unknown");
  }
}

/* ------------------------------------------------------------------ */
/* Grant, decision and lock-row reads                                 */
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
    return { project_ids: projectIds, config_spaces: configSpaces, path_globs: pathGlobs, object_ids: objectIds };
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
  const configFields: Id<"fld">[] = [];
  for (const fieldId of fieldIds) {
    if (!isId(fieldId, "fld")) {
      return null;
    }
    configFields.push(fieldId);
  }
  return {
    project_ids: projectIds,
    config_spaces: configSpaces,
    path_globs: pathGlobs,
    object_ids: objectIds,
    config_scope: {
      field_ids: configFields,
      source_layer_ids: layerIds,
      model_scope_keys: modelKeys
    }
  };
}

function parseAttestation(value: unknown): AuthorizationGrant["human_attestation"] | null {
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
    !isSourceRef(evidenceRef) ||
    typeof confirmedAt !== "number" ||
    !Number.isSafeInteger(confirmedAt) ||
    confirmedAt < 0
  ) {
    return null;
  }
  return {
    kind,
    capability_id: capabilityId,
    evidence_ref: evidenceRef,
    confirmed_at: confirmedAt
  };
}

function grantFromRow(row: Row): AuthorizationGrant | null {
  const grantId = stringField(row, "grant_id");
  const issuedBy = stringField(row, "issued_by");
  const subject = stringField(row, "subject");
  const objectType = stringField(row, "object_type");
  const scopeRaw = stringField(row, "scope_json");
  const actionsRaw = stringField(row, "actions_json");
  const attestationRaw = stringField(row, "human_attestation_json");
  const mode = stringField(row, "mode");
  const candidateId = nullableString(row, "candidate_id");
  const candidateHash = nullableString(row, "candidate_hash");
  const policyVersion = stringField(row, "policy_version");
  const issuedAt = numberField(row, "issued_at");
  const expiresAt = nullableNumber(row, "expires_at");
  const revokedAt = nullableNumber(row, "revoked_at");
  const grantHashValue = stringField(row, "grant_hash");
  if (
    grantId === null ||
    !isId(grantId, "grant") ||
    (issuedBy !== "human" && issuedBy !== "preconfigured_policy") ||
    subject !== "rsi" ||
    (objectType !== "skill" &&
      objectType !== "memory" &&
      objectType !== "instructions" &&
      objectType !== "config") ||
    scopeRaw === null ||
    actionsRaw === null ||
    attestationRaw === null ||
    (mode !== "once" && mode !== "standing") ||
    (candidateId !== null && !isId(candidateId, "prop") && !isId(candidateId, "ctr")) ||
    (candidateHash !== null && !isHash(candidateHash)) ||
    policyVersion === null ||
    issuedAt === null ||
    grantHashValue === null ||
    !isHash(grantHashValue)
  ) {
    return null;
  }
  const scope = parseGrantScope(parseJson(scopeRaw));
  const actions = parseStringArray(parseJson(actionsRaw));
  const attestation = parseAttestation(parseJson(attestationRaw));
  if (scope === null || actions === null || attestation === null) {
    return null;
  }
  const typedActions: AuthorizationGrant["actions"] = [];
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
    grant_hash: grantHashValue
  };
}

function readGrant(
  connection: SqliteConnection,
  grantId: Id<"grant">
): Result<AuthorizationGrant | null, ErrorEnvelope> {
  let row: Row | undefined;
  try {
    row = connection
      .prepare<Row>("SELECT * FROM authorization_grant WHERE grant_id = :grant_id")
      .get({ grant_id: grantId });
  } catch (error) {
    return err(mapSqliteFailure(error, "config_write_grant", "read_grant"), "degraded");
  }
  if (row === undefined) {
    return ok(null);
  }
  const grant = grantFromRow(row);
  if (grant === null) {
    return err(internalFailure("config_write_grant", "fnd.config_write_grant_row_corrupt"));
  }
  return ok(grant);
}

interface ConsumptionState {
  readonly write_id: Id<"wi"> | null;
  readonly config_write_id: Id<"cwi"> | null;
}

function readConsumptionState(
  connection: SqliteConnection,
  grantId: Id<"grant">
): Result<ConsumptionState | null, ErrorEnvelope> {
  let row: Row | undefined;
  try {
    row = connection
      .prepare<Row>(
        "SELECT grant_id, write_kind, managed_write_id, config_write_id FROM grant_consumption WHERE grant_id = :grant_id"
      )
      .get({ grant_id: grantId });
  } catch (error) {
    return err(mapSqliteFailure(error, "config_write_grant", "read_consumption"), "degraded");
  }
  if (row === undefined) {
    return ok(null);
  }
  const kind = stringField(row, "write_kind");
  const managed = nullableString(row, "managed_write_id");
  const config = nullableString(row, "config_write_id");
  if (kind === "managed") {
    if (managed === null || !isId(managed, "wi") || config !== null) {
      return err(internalFailure("config_write_grant", "fnd.config_write_consumption_corrupt"));
    }
    return ok({ write_id: managed, config_write_id: null });
  }
  if (kind === "config") {
    if (config === null || !isId(config, "cwi") || managed !== null) {
      return err(internalFailure("config_write_grant", "fnd.config_write_consumption_corrupt"));
    }
    return ok({ write_id: null, config_write_id: config });
  }
  return err(internalFailure("config_write_grant", "fnd.config_write_consumption_corrupt"));
}

function decisionDenial(decision: WriteDecision, grant: AuthorizationGrant): ErrorEnvelope | null {
  if (decision.allowed) {
    return null;
  }
  const reason = decision.reason_code;
  if (reason === "config_scope_missing" || reason === "config_space_not_exact") {
    return authConfigScope(grant.grant_id);
  }
  if (
    reason === "config_layer_out_of_scope" ||
    reason === "config_model_scope_out_of_scope"
  ) {
    return authConfigScope(grant.grant_id);
  }
  return authDenied({
    object_type: "config",
    reason,
    grant_id: grant.grant_id,
    stage: "config_write_authorize"
  });
}

function evaluateConfigDecision(input: {
  readonly grant: AuthorizationGrant;
  readonly action: "update" | "rollback";
  readonly candidate_id: Id<"ctr">;
  readonly patch_hash: Hash;
  readonly config_space_id: Hash;
  readonly field_ids: readonly Id<"fld">[];
  readonly layer_id: string;
  readonly model_scope_key: string;
  readonly target_path: string;
  /** Absolute candidate for `path_globs`; call-stack only. */
  readonly absolute_path: string;
  readonly now: number;
  readonly consumption: ConsumptionState | null;
}): WriteDecision {
  return evaluateWriteDecision(
    input.grant,
    {
      object_type: "config",
      action: input.action,
      candidate_id: input.candidate_id,
      candidate_hash: input.patch_hash,
      project_id: null,
      config_space_id: input.config_space_id,
      target_path: input.target_path,
      path_candidates: [input.absolute_path],
      config: {
        config_space_id: input.config_space_id,
        field_ids: input.field_ids,
        layer_id: input.layer_id,
        model_scope_key: input.model_scope_key
      }
    },
    { now: input.now, consumption: input.consumption }
  );
}

function patchFieldIds(patch: ConfigWritePatch): Result<readonly Id<"fld">[], ErrorEnvelope> {
  const ids = new Set<string>();
  for (const assignment of patch.expected_fields) {
    ids.add(assignment.field_id);
  }
  for (const assignment of patch.candidate_values) {
    ids.add(assignment.field_id);
  }
  for (const mutation of patch.mutations) {
    ids.add(mutation.field_id);
  }
  const sorted: Id<"fld">[] = [];
  for (const value of [...ids].sort(compareUtf8)) {
    if (!isId(value, "fld")) {
      return err(fieldError("E_WRITE_CONFIG_PATCH", "field_id", "fld_id"));
    }
    sorted.push(value);
  }
  return ok(sorted);
}

function patchFieldScopeFailure(
  grant: AuthorizationGrant,
  fieldIds: readonly Id<"fld">[]
): ErrorEnvelope | null {
  const scope = grant.scope.config_scope;
  if (scope === undefined) {
    return authConfigScope(grant.grant_id);
  }
  for (const fieldId of fieldIds) {
    if (!scope.field_ids.includes(fieldId)) {
      return fieldError(
        "E_WRITE_CONFIG_FIELD",
        "field_id",
        "outside_grant_config_scope",
        "config_write_authorize"
      );
    }
  }
  return null;
}

interface LockRow {
  readonly lock_key: Hash;
  readonly lock_handle_hash: Hash;
  readonly holder_client_id: string;
  readonly fencing_token: number;
  readonly grant_id: Id<"grant">;
  readonly action: "update" | "rollback";
  readonly candidate_id: Id<"ctr">;
  readonly candidate_hash: Hash;
  readonly binding: VersionBinding;
  readonly config_space_id: Hash;
  readonly field_registry_snapshot_hash: Hash;
  readonly layer_id: string;
  readonly model_scope_key: string;
  readonly root_id: string;
  readonly root_registration_hash: Hash;
  readonly pin: RootIdentityPin;
  readonly target_path: string;
  readonly expected_config_version: string;
  readonly reason: "trial_write" | "trial_rollback";
  readonly base_file_hash: Hash;
  readonly base_content_ref: SourceRef;
  readonly base_byte_length: number;
  readonly acquired_at: number;
  readonly expires_at: number;
  readonly released_at: number | null;
}

function lockFromRow(row: Row): LockRow | null {
  const lockKey = stringField(row, "lock_key");
  const handleHash = stringField(row, "lock_handle_hash");
  const holder = stringField(row, "holder_client_id");
  const fencing = numberField(row, "fencing_token");
  const grantId = stringField(row, "grant_id");
  const action = stringField(row, "action");
  const candidateId = stringField(row, "candidate_id");
  const candidateHashValue = stringField(row, "candidate_hash");
  const bindingRaw = stringField(row, "binding_json");
  const configSpaceId = stringField(row, "config_space_id");
  const registryHash = stringField(row, "field_registry_snapshot_hash");
  const layerId = stringField(row, "layer_id");
  const modelKey = stringField(row, "model_scope_key");
  const rootId = stringField(row, "root_id");
  const registrationHash = stringField(row, "root_registration_hash");
  const pinRaw = stringField(row, "root_identity_pin_json");
  const targetPath = stringField(row, "target_path");
  const configVersion = stringField(row, "expected_config_version");
  const reason = stringField(row, "reason");
  const baseHash = stringField(row, "base_file_hash");
  const baseRef = stringField(row, "base_content_ref");
  const baseLength = numberField(row, "base_byte_length");
  const acquiredAt = numberField(row, "acquired_at");
  const expiresAt = numberField(row, "expires_at");
  const releasedAt = nullableNumber(row, "released_at");
  if (
    lockKey === null ||
    !isHash(lockKey) ||
    handleHash === null ||
    !isHash(handleHash) ||
    holder === null ||
    fencing === null ||
    fencing < 1 ||
    grantId === null ||
    !isId(grantId, "grant") ||
    (action !== "update" && action !== "rollback") ||
    candidateId === null ||
    !isId(candidateId, "ctr") ||
    candidateHashValue === null ||
    !isHash(candidateHashValue) ||
    bindingRaw === null ||
    configSpaceId === null ||
    !isHash(configSpaceId) ||
    registryHash === null ||
    !isHash(registryHash) ||
    layerId === null ||
    modelKey === null ||
    rootId === null ||
    registrationHash === null ||
    !isHash(registrationHash) ||
    pinRaw === null ||
    targetPath === null ||
    configVersion === null ||
    (reason !== "trial_write" && reason !== "trial_rollback") ||
    baseHash === null ||
    !isHash(baseHash) ||
    baseRef === null ||
    !isSourceRef(baseRef) ||
    baseLength === null ||
    acquiredAt === null ||
    expiresAt === null
  ) {
    return null;
  }
  const binding = parseVersionBinding(parseJson(bindingRaw));
  const pin = parsePin(parseJson(pinRaw), rootId);
  if (!binding.ok || pin === null) {
    return null;
  }
  return {
    lock_key: lockKey,
    lock_handle_hash: handleHash,
    holder_client_id: holder,
    fencing_token: fencing,
    grant_id: grantId,
    action,
    candidate_id: candidateId,
    candidate_hash: candidateHashValue,
    binding: binding.value,
    config_space_id: configSpaceId,
    field_registry_snapshot_hash: registryHash,
    layer_id: layerId,
    model_scope_key: modelKey,
    root_id: rootId,
    root_registration_hash: registrationHash,
    pin,
    target_path: targetPath,
    expected_config_version: configVersion,
    reason,
    base_file_hash: baseHash,
    base_content_ref: baseRef,
    base_byte_length: baseLength,
    acquired_at: acquiredAt,
    expires_at: expiresAt,
    released_at: releasedAt
  };
}

function readLockByHandle(
  connection: SqliteConnection,
  handleHash: Hash
): Result<LockRow | null, ErrorEnvelope> {
  let row: Row | undefined;
  try {
    row = connection
      .prepare<Row>("SELECT * FROM config_write_lock WHERE lock_handle_hash = :handle_hash")
      .get({ handle_hash: handleHash });
  } catch (error) {
    return err(mapSqliteFailure(error, "config_write_lock", "read_lock"), "degraded");
  }
  if (row === undefined) {
    return ok(null);
  }
  const lock = lockFromRow(row);
  return lock === null
    ? err(internalFailure("config_write_lock", "fnd.config_write_lock_row_corrupt"))
    : ok(lock);
}

/* ------------------------------------------------------------------ */
/* Intent, snapshot and result rows                                   */
/* ------------------------------------------------------------------ */

interface StoredIntent {
  readonly config_write_id: Id<"cwi">;
  readonly idempotency_key: string;
  readonly request_hash: Hash;
  readonly grant_id: Id<"grant">;
  readonly action: "update" | "rollback";
  readonly candidate_id: Id<"ctr">;
  readonly candidate_hash: Hash;
  readonly patch_hash: Hash;
  readonly patch: ConfigWritePatch | null;
  readonly auth_decision: WriteDecision | null;
  readonly binding: VersionBinding;
  readonly config_space_id: Hash;
  readonly field_registry_snapshot_hash: Hash;
  readonly layer_id: string;
  readonly model_scope_key: string;
  readonly root_id: string;
  readonly root_registration_hash: Hash;
  readonly pin: RootIdentityPin;
  readonly target_path: string;
  readonly expected_config_version: string;
  readonly reason: "trial_write" | "trial_rollback";
  readonly base_file_hash: Hash;
  readonly base_content_ref: SourceRef;
  readonly base_byte_length: number;
  readonly candidate_content_hash: Hash | null;
  readonly candidate_content_ref: SourceRef | null;
  readonly new_semantic_hash: Hash | null;
  readonly protected_subtree_proof: readonly ConfigProtectedSubtreeProof[];
  readonly snapshot_id: Id<"wsnap"> | null;
  readonly state: ConfigWriteState;
  readonly attempt: number;
  readonly last_error_code: string | null;
  readonly row_version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

function parseAddress(value: unknown): SourceRef | null {
  if (typeof value !== "string") {
    return null;
  }
  if (isSourceRef(value)) {
    return value;
  }
  // A zero-byte base has no legal non-empty SourceRef range; the DDL keeps the
  // empty range as the only honest encoding.
  if (/^blob:\/\/sha256:[0-9a-f]{64}#bytes=0-0$/.test(value)) {
    return value as SourceRef;
  }
  return null;
}

function parseProof(value: unknown): ConfigProtectedSubtreeProof[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const proof: ConfigProtectedSubtreeProof[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return null;
    }
    const path = entry["path"];
    const expected = entry["expected_semantic_hash"];
    const before = entry["before_semantic_hash"];
    const after = entry["after_semantic_hash"];
    if (
      typeof path !== "string" ||
      typeof expected !== "string" ||
      !isHash(expected) ||
      typeof before !== "string" ||
      !isHash(before) ||
      typeof after !== "string" ||
      !isHash(after)
    ) {
      return null;
    }
    proof.push({
      path,
      expected_semantic_hash: expected,
      before_semantic_hash: before,
      after_semantic_hash: after
    });
  }
  return proof;
}

function parseProtectedSubtrees(value: unknown): ConfigProtectedSubtree[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const subtrees: ConfigProtectedSubtree[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return null;
    }
    const path = entry["path"];
    const semanticHash = entry["semantic_hash"];
    if (typeof path !== "string" || typeof semanticHash !== "string" || !isHash(semanticHash)) {
      return null;
    }
    subtrees.push({ path, semantic_hash: semanticHash });
  }
  return subtrees;
}

function parseFilePath(value: unknown): ConfigFilePath | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value["kind"];
  const format = value["format"];
  const root = value["root"];
  const relativePath = value["relative_path"];
  const pointer = value["pointer"];
  const create = value["create"];
  if (
    kind !== "file" ||
    (format !== "json" && format !== "jsonc" && format !== "yaml" && format !== "toml") ||
    (root !== "user" && root !== "project" && root !== "managed" && root !== "session") ||
    typeof relativePath !== "string" ||
    typeof pointer !== "string" ||
    typeof create !== "boolean"
  ) {
    return null;
  }
  return { kind, format, root, relative_path: relativePath, pointer, create };
}

function parseAssignmentValue(value: unknown): ConfigAssignmentValue | null {
  if (!isRecord(value)) {
    return null;
  }
  const presence = value["presence"];
  if (presence === "absent") {
    return { presence: "absent" };
  }
  if (presence !== "present") {
    return null;
  }
  const scalar = value["value"];
  if (
    scalar !== null &&
    typeof scalar !== "string" &&
    typeof scalar !== "number" &&
    typeof scalar !== "boolean"
  ) {
    return null;
  }
  if (typeof scalar === "number" && !Number.isFinite(scalar)) {
    return null;
  }
  return { presence: "present", value: scalar };
}

function parseAssignment(value: unknown): ConfigFieldAssignment | null {
  if (!isRecord(value)) {
    return null;
  }
  const fieldId = value["field_id"];
  const path = parseFilePath(value["path"]);
  const assignmentValue = parseAssignmentValue(value["value"]);
  if (typeof fieldId !== "string" || !isId(fieldId, "fld") || path === null || assignmentValue === null) {
    return null;
  }
  return { field_id: fieldId, path, value: assignmentValue };
}

function parseMutation(value: unknown): ConfigFieldMutation | null {
  if (!isRecord(value)) {
    return null;
  }
  const op = value["op"];
  const fieldId = value["field_id"];
  const path = parseFilePath(value["path"]);
  if (typeof fieldId !== "string" || !isId(fieldId, "fld") || path === null) {
    return null;
  }
  if (op === "remove") {
    return { op: "remove", field_id: fieldId, path };
  }
  if (op !== "set") {
    return null;
  }
  const scalar = value["value"];
  if (
    scalar !== null &&
    typeof scalar !== "string" &&
    typeof scalar !== "number" &&
    typeof scalar !== "boolean"
  ) {
    return null;
  }
  if (typeof scalar === "number" && !Number.isFinite(scalar)) {
    return null;
  }
  return { op: "set", field_id: fieldId, path, value: scalar };
}

function parsePatch(value: unknown): ConfigWritePatch | null {
  if (!isRecord(value)) {
    return null;
  }
  const schemaVersion = value["schema_version"];
  const configSpace = value["config_space_id"];
  const registryHash = value["field_registry_snapshot_hash"];
  const layerId = value["layer_id"];
  const modelKey = value["model_scope_key"];
  const targetPath = value["target_path"];
  const patchHash = value["patch_hash"];
  const expectedRaw = value["expected_fields"];
  const mutationsRaw = value["mutations"];
  const protectedRaw = value["protected_subtrees"];
  const candidatesRaw = value["candidate_values"];
  if (
    schemaVersion !== CONFIG_WRITE_SCHEMA_VERSION ||
    typeof configSpace !== "string" ||
    !isHash(configSpace) ||
    typeof registryHash !== "string" ||
    !isHash(registryHash) ||
    typeof layerId !== "string" ||
    typeof modelKey !== "string" ||
    typeof targetPath !== "string" ||
    typeof patchHash !== "string" ||
    !isHash(patchHash) ||
    !Array.isArray(expectedRaw) ||
    !Array.isArray(mutationsRaw) ||
    !Array.isArray(candidatesRaw)
  ) {
    return null;
  }
  const protectedSubtrees = parseProtectedSubtrees(protectedRaw);
  if (protectedSubtrees === null) {
    return null;
  }
  const expected: ConfigFieldAssignment[] = [];
  for (const entry of expectedRaw) {
    const parsed = parseAssignment(entry);
    if (parsed === null) {
      return null;
    }
    expected.push(parsed);
  }
  const mutations: ConfigFieldMutation[] = [];
  for (const entry of mutationsRaw) {
    const parsed = parseMutation(entry);
    if (parsed === null) {
      return null;
    }
    mutations.push(parsed);
  }
  const candidates: ConfigFieldAssignment[] = [];
  for (const entry of candidatesRaw) {
    const parsed = parseAssignment(entry);
    if (parsed === null) {
      return null;
    }
    candidates.push(parsed);
  }
  const candidate: ConfigWritePatch = {
    schema_version: CONFIG_WRITE_SCHEMA_VERSION,
    config_space_id: configSpace,
    field_registry_snapshot_hash: registryHash,
    layer_id: layerId,
    model_scope_key: modelKey,
    target_path: targetPath,
    expected_fields: expected,
    mutations,
    protected_subtrees: protectedSubtrees,
    candidate_values: candidates,
    patch_hash: patchHash
  };
  return validateConfigWritePatch(candidate).ok ? candidate : null;
}

function parseDecision(value: unknown): WriteDecision | null {
  if (!isRecord(value)) {
    return null;
  }
  const allowed = value["allowed"];
  if (allowed === true) {
    const grantId = value["grant_id"];
    const matchedAction = value["matched_action"];
    const requiresApproval = value["requires_approval"];
    const consumed = value["consumed"];
    if (
      typeof grantId !== "string" ||
      !isId(grantId, "grant") ||
      (matchedAction !== "create" &&
        matchedAction !== "update" &&
        matchedAction !== "disable" &&
        matchedAction !== "rollback") ||
      requiresApproval !== false ||
      typeof consumed !== "boolean"
    ) {
      return null;
    }
    return {
      allowed: true,
      grant_id: grantId,
      matched_action: matchedAction,
      requires_approval: false,
      consumed
    };
  }
  if (allowed === false) {
    const grantId = value["grant_id"];
    const reason = value["reason_code"];
    if (typeof reason !== "string" || !isWriteDenyReasonCode(reason)) {
      return null;
    }
    if (grantId === null) {
      return { allowed: false, grant_id: null, reason_code: reason };
    }
    if (typeof grantId !== "string" || !isId(grantId, "grant")) {
      return null;
    }
    return { allowed: false, grant_id: grantId, reason_code: reason };
  }
  return null;
}

function intentFromRow(row: Row): StoredIntent | null {
  const id = stringField(row, "config_write_id");
  const idempotencyKey = stringField(row, "idempotency_key");
  const requestHash = stringField(row, "request_hash");
  const grantId = stringField(row, "grant_id");
  const action = stringField(row, "action");
  const candidateId = stringField(row, "candidate_id");
  const candidateHashValue = stringField(row, "candidate_hash");
  const patchHash = stringField(row, "patch_hash");
  const patchRaw = stringField(row, "patch_json");
  const decisionRaw = stringField(row, "auth_decision_json");
  const bindingRaw = stringField(row, "binding_json");
  const configSpaceId = stringField(row, "config_space_id");
  const registryHash = stringField(row, "field_registry_snapshot_hash");
  const layerId = stringField(row, "layer_id");
  const modelKey = stringField(row, "model_scope_key");
  const rootId = stringField(row, "root_id");
  const registrationHash = stringField(row, "root_registration_hash");
  const pinRaw = stringField(row, "root_identity_pin_json");
  const targetPath = stringField(row, "target_path");
  const configVersion = stringField(row, "expected_config_version");
  const reason = stringField(row, "reason");
  const baseHash = stringField(row, "base_file_hash");
  const baseRefRaw = stringField(row, "base_content_ref");
  const baseLength = numberField(row, "base_byte_length");
  const candidateContentHash = nullableString(row, "candidate_content_hash");
  const candidateRefRaw = nullableString(row, "candidate_content_ref");
  const semanticHash = nullableString(row, "new_semantic_hash");
  const proofRaw = stringField(row, "protected_subtree_proof_json");
  const snapshotIdRaw = nullableString(row, "snapshot_id");
  const state = stringField(row, "state");
  const attempt = numberField(row, "attempt");
  const rowVersion = numberField(row, "row_version");
  const createdAt = numberField(row, "created_at");
  const updatedAt = numberField(row, "updated_at");
  if (
    id === null ||
    !isId(id, "cwi") ||
    idempotencyKey === null ||
    requestHash === null ||
    !isHash(requestHash) ||
    grantId === null ||
    !isId(grantId, "grant") ||
    (action !== "update" && action !== "rollback") ||
    candidateId === null ||
    !isId(candidateId, "ctr") ||
    candidateHashValue === null ||
    !isHash(candidateHashValue) ||
    patchHash === null ||
    !isHash(patchHash) ||
    patchRaw === null ||
    decisionRaw === null ||
    bindingRaw === null ||
    configSpaceId === null ||
    !isHash(configSpaceId) ||
    registryHash === null ||
    !isHash(registryHash) ||
    layerId === null ||
    modelKey === null ||
    rootId === null ||
    registrationHash === null ||
    !isHash(registrationHash) ||
    pinRaw === null ||
    targetPath === null ||
    configVersion === null ||
    (reason !== "trial_write" && reason !== "trial_rollback") ||
    baseHash === null ||
    !isHash(baseHash) ||
    baseRefRaw === null ||
    baseLength === null ||
    proofRaw === null ||
    state === null ||
    (!isActiveState(state) && !isTerminalStateValue(state)) ||
    attempt === null ||
    rowVersion === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  const binding = parseVersionBinding(parseJson(bindingRaw));
  const pin = parsePin(parseJson(pinRaw), rootId);
  const baseRef = parseAddress(baseRefRaw);
  if (!binding.ok || pin === null || baseRef === null) {
    return null;
  }
  const candidateRef = candidateRefRaw === null ? null : parseAddress(candidateRefRaw);
  if (candidateRefRaw !== null && candidateRef === null) {
    return null;
  }
  if (snapshotIdRaw !== null && !isId(snapshotIdRaw, "wsnap")) {
    return null;
  }
  if (candidateContentHash !== null && !isHash(candidateContentHash)) {
    return null;
  }
  if (semanticHash !== null && !isHash(semanticHash)) {
    return null;
  }
  const patchValue = parsePatch(parseJson(patchRaw));
  const decisionValue = parseDecision(parseJson(decisionRaw));
  const proofValue = parseProof(parseJson(proofRaw));
  const stateValue: ConfigWriteState = isTerminalStateValue(state)
    ? state
    : isConfigWriteState(state)
      ? state
      : "recovery_required";
  return {
    config_write_id: id,
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    grant_id: grantId,
    action,
    candidate_id: candidateId,
    candidate_hash: candidateHashValue,
    patch_hash: patchHash,
    patch: patchValue,
    auth_decision: decisionValue,
    binding: binding.value,
    config_space_id: configSpaceId,
    field_registry_snapshot_hash: registryHash,
    layer_id: layerId,
    model_scope_key: modelKey,
    root_id: rootId,
    root_registration_hash: registrationHash,
    pin,
    target_path: targetPath,
    expected_config_version: configVersion,
    reason,
    base_file_hash: baseHash,
    base_content_ref: baseRef,
    base_byte_length: baseLength,
    candidate_content_hash: candidateContentHash,
    candidate_content_ref: candidateRef,
    new_semantic_hash: semanticHash,
    protected_subtree_proof: proofValue ?? [],
    snapshot_id: snapshotIdRaw,
    state: stateValue,
    attempt,
    last_error_code: nullableString(row, "last_error_code"),
    row_version: rowVersion,
    created_at: createdAt,
    updated_at: updatedAt
  };
}

function readIntentById(
  connection: SqliteConnection,
  id: Id<"cwi">
): Result<StoredIntent | null, ErrorEnvelope> {
  let row: Row | undefined;
  try {
    row = connection
      .prepare<Row>("SELECT * FROM config_write_intent WHERE config_write_id = :config_write_id")
      .get({ config_write_id: id });
  } catch (error) {
    return err(mapSqliteFailure(error, "config_write_intent", "read_intent"), "degraded");
  }
  if (row === undefined) {
    return ok(null);
  }
  const intent = intentFromRow(row);
  return intent === null
    ? err(internalFailure("config_write_intent", "fnd.config_write_intent_row_corrupt"))
    : ok(intent);
}

function readIntentByKey(
  connection: SqliteConnection,
  key: string
): Result<StoredIntent | null, ErrorEnvelope> {
  let row: Row | undefined;
  try {
    row = connection
      .prepare<Row>("SELECT * FROM config_write_intent WHERE idempotency_key = :idempotency_key")
      .get({ idempotency_key: key });
  } catch (error) {
    return err(mapSqliteFailure(error, "config_write_intent", "read_intent"), "degraded");
  }
  if (row === undefined) {
    return ok(null);
  }
  const intent = intentFromRow(row);
  return intent === null
    ? err(internalFailure("config_write_intent", "fnd.config_write_intent_row_corrupt"))
    : ok(intent);
}

function resultFromRow(row: Row): ConfigWriteResult | null {
  const id = stringField(row, "config_write_id");
  const attempt = numberField(row, "attempt");
  const candidateId = stringField(row, "candidate_id");
  const candidateHashValue = stringField(row, "candidate_hash");
  const state = stringField(row, "state");
  const path = stringField(row, "path");
  const candidateContentHash = nullableString(row, "candidate_content_hash");
  const newFileHash = nullableString(row, "new_file_hash");
  const semanticHash = nullableString(row, "new_semantic_hash");
  const snapshotIdRaw = nullableString(row, "snapshot_id");
  const readback = numberField(row, "readback_verified");
  const protectedVerified = numberField(row, "protected_subtrees_verified");
  const atomicity = stringField(row, "atomicity");
  const exclusion = stringField(row, "exclusion");
  const completedAt = numberField(row, "completed_at");
  if (
    id === null ||
    !isId(id, "cwi") ||
    attempt === null ||
    candidateId === null ||
    !isId(candidateId, "ctr") ||
    candidateHashValue === null ||
    !isHash(candidateHashValue) ||
    state === null ||
    !isTerminalStateValue(state) ||
    path === null ||
    readback === null ||
    (readback !== 0 && readback !== 1) ||
    protectedVerified === null ||
    (protectedVerified !== 0 && protectedVerified !== 1) ||
    (atomicity !== "single_file_atomic" && atomicity !== "none") ||
    (exclusion !== "native_cooperative" && exclusion !== "rsi_advisory" && exclusion !== "none") ||
    completedAt === null
  ) {
    return null;
  }
  if (candidateContentHash !== null && !isHash(candidateContentHash)) {
    return null;
  }
  if (newFileHash !== null && !isHash(newFileHash)) {
    return null;
  }
  if (semanticHash !== null && !isHash(semanticHash)) {
    return null;
  }
  if (snapshotIdRaw !== null && !isId(snapshotIdRaw, "wsnap")) {
    return null;
  }
  return {
    schema_version: CONFIG_WRITE_RESULT_SCHEMA_VERSION,
    config_write_id: id,
    candidate_id: candidateId,
    candidate_hash: candidateHashValue,
    attempt,
    state,
    path,
    candidate_content_hash: candidateContentHash,
    new_file_hash: newFileHash,
    new_semantic_hash: semanticHash,
    snapshot_id: snapshotIdRaw,
    readback_verified: readback === 1,
    protected_subtrees_verified: protectedVerified === 1,
    atomicity,
    exclusion,
    error_code: nullableString(row, "error_code"),
    completed_at: completedAt
  };
}

function readLatestResult(
  connection: SqliteConnection,
  id: Id<"cwi">
): Result<ConfigWriteResult | null, ErrorEnvelope> {
  let row: Row | undefined;
  try {
    row = connection
      .prepare<Row>(
        "SELECT * FROM config_write_result WHERE config_write_id = :config_write_id ORDER BY attempt DESC LIMIT 1"
      )
      .get({ config_write_id: id });
  } catch (error) {
    return err(mapSqliteFailure(error, "config_write_result", "read_result"), "degraded");
  }
  if (row === undefined) {
    return ok(null);
  }
  const result = resultFromRow(row);
  return result === null
    ? err(internalFailure("config_write_result", "fnd.config_write_result_row_corrupt"))
    : ok(result);
}

function intentRow(intent: ConfigWriteIntent): Record<string, JsonValue> {
  return {
    schema_version: intent.schema_version,
    config_write_id: intent.config_write_id,
    idempotency_key: intent.idempotency_key,
    request_hash: intent.request_hash,
    grant_id: intent.grant_id,
    action: intent.action,
    object_type: intent.object_type,
    candidate_id: intent.candidate_id,
    candidate_hash: intent.candidate_hash,
    patch_hash: intent.patch_hash,
    patch_json: canonicalJsonText(patchJson(intent.patch)),
    auth_decision_json: canonicalJsonText(decisionJson(intent.auth_decision)),
    binding_json: canonicalJsonText(bindingJson(intent.binding)),
    config_space_id: intent.config_space_id,
    field_registry_snapshot_hash: intent.field_registry_snapshot_hash,
    layer_id: intent.layer_id,
    model_scope_key: intent.model_scope_key,
    root_id: intent.root_id,
    root_registration_hash: intent.root_registration_hash,
    root_identity_pin_json: canonicalJsonText(pinJson(intent.root_identity_pin)),
    target_path: intent.target_path,
    expected_config_version: intent.expected_config_version,
    reason: intent.reason,
    base_file_hash: intent.base_file_hash,
    base_content_ref: intent.base_content_ref,
    base_byte_length: intent.base_byte_length,
    candidate_content_hash: intent.candidate_content_hash,
    candidate_content_ref: intent.candidate_content_ref,
    new_semantic_hash: intent.new_semantic_hash,
    protected_subtree_proof_json: canonicalJsonText(proofJson(intent.protected_subtree_proof)),
    snapshot_id: intent.snapshot_id,
    state: intent.state,
    attempt: intent.attempt,
    last_error_code: intent.last_error_code,
    row_version: intent.row_version,
    created_at: intent.created_at,
    updated_at: intent.updated_at
  };
}

function snapshotRow(snapshot: ConfigWriteSnapshot): Record<string, JsonValue> {
  return {
    schema_version: snapshot.schema_version,
    snapshot_id: snapshot.snapshot_id,
    config_write_id: snapshot.config_write_id,
    path: snapshot.path,
    base_file_hash: snapshot.base_file_hash,
    content_ref: snapshot.content_ref,
    byte_length: snapshot.byte_length,
    created_at: snapshot.created_at
  };
}

function resultRow(result: ConfigWriteResult): Record<string, JsonValue> {
  return {
    schema_version: result.schema_version,
    config_write_id: result.config_write_id,
    attempt: result.attempt,
    candidate_id: result.candidate_id,
    candidate_hash: result.candidate_hash,
    state: result.state,
    path: result.path,
    candidate_content_hash: result.candidate_content_hash,
    new_file_hash: result.new_file_hash,
    new_semantic_hash: result.new_semantic_hash,
    snapshot_id: result.snapshot_id,
    readback_verified: result.readback_verified ? 1 : 0,
    protected_subtrees_verified: result.protected_subtrees_verified ? 1 : 0,
    atomicity: result.atomicity,
    exclusion: result.exclusion,
    error_code: result.error_code,
    completed_at: result.completed_at
  };
}

/* ------------------------------------------------------------------ */
/* Journal and ledger projection                                      */
/* ------------------------------------------------------------------ */

type ConfigEventType =
  | "config_write.intent_recorded"
  | "config_write.transition"
  | "config_write.snapshot_recorded"
  | "config_write.result_recorded";

type ConfigEntityType =
  | "config_write_intent"
  | "config_write_snapshot"
  | "config_write_result"
  | "grant_consumption";

interface JournalOutcome {
  readonly ok: boolean;
  readonly unknown: boolean;
  readonly error: ErrorEnvelope | null;
  readonly event: Record<string, JsonValue> | null;
  readonly receipt: JournalAppendResult | null;
}

interface JournalEventInput {
  readonly event_type: ConfigEventType | "grant.consumed";
  readonly entity_type: ConfigEntityType;
  readonly entity_id: string;
  readonly operation: "insert" | "update" | "transition";
  readonly binding: VersionBinding;
  readonly row_schema: string;
  readonly row: Record<string, JsonValue>;
  readonly before: Record<string, JsonValue> | null;
  readonly blob_hashes: readonly Hash[];
  /** False leaves ledger projection to a later frame in the same commit. */
  readonly project_ledger: boolean;
  readonly project?: (tx: Tx, receipt: JournalAppendResult) => void;
}

interface LedgerEventInput {
  readonly event: Record<string, JsonValue>;
  readonly eventType: string;
  readonly entityType: ConfigEntityType;
  readonly entityId: string;
  readonly operation: "insert" | "update" | "transition";
  readonly binding: VersionBinding;
  readonly beforeHash: Hash | null;
  readonly afterHash: Hash;
  readonly rowSchema: string;
  readonly rowJson: string;
  readonly journalId: string;
  readonly commitSeq: number;
  readonly recordedAt: number;
}

function insertLedgerEventLog(tx: Tx, input: LedgerEventInput): void {
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
    payload_hash: input.afterHash,
    recorded_at: input.recordedAt
  });
}

async function appendConfigEvent(
  journal: JournalCommitter,
  input: JournalEventInput,
  now: () => number
): Promise<JournalOutcome> {
  const rowJson = canonicalJsonText(input.row);
  const afterHash = canonicalHash({ row_schema: input.row_schema, row_json: rowJson });
  const beforeHash =
    input.before === null
      ? null
      : canonicalHash({
          row_schema: input.row_schema,
          row_json: canonicalJsonText(input.before)
        });
  const eventId = newId("ev", now());
  const eventKey = canonicalHash({
    event_type: input.event_type,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    operation: input.operation,
    before_hash: beforeHash,
    after_hash: afterHash,
    binding: bindingJson(input.binding)
  });
  const event: Record<string, JsonValue> = {
    schema_version: "rsi.ledger_event/1",
    event_id: eventId,
    event_key: eventKey,
    event_type: input.event_type,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    operation: input.operation,
    binding: bindingJson(input.binding),
    before_hash: beforeHash,
    after_hash: afterHash,
    row_schema: input.row_schema,
    row_json: rowJson,
    payload_hash: afterHash,
    recorded_at: now()
  };
  const blobHashes = [...new Set(input.blob_hashes)].sort(compareUtf8);
  const outcome = await journal.commit(
    {
      schema_version: "rsi.journal_event/1",
      event,
      event_hash: canonicalHash(event),
      blob_hashes: blobHashes
    },
    (tx, receipt) => {
      if (input.project_ledger) {
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
          journalId: receipt.journal_id,
          commitSeq: receipt.first_commit_seq,
          recordedAt: now()
        });
      }
      if (input.project !== undefined) {
        input.project(tx, receipt);
      }
      return null;
    }
  );
  if (!outcome.ok) {
    return {
      ok: false,
      unknown: outcome.commit_state === "unknown_recovery_required",
      error: outcome.error,
      event: outcome.commit_state === "unknown_recovery_required" ? event : null,
      receipt: outcome.commit_state === "unknown_recovery_required" ? outcome.receipt ?? null : null
    };
  }
  return { ok: true, unknown: false, error: null, event, receipt: outcome.receipt };
}

/* ------------------------------------------------------------------ */
/* Proof and parser-output validation                                 */
/* ------------------------------------------------------------------ */

function verifyProof(
  subtrees: readonly ConfigProtectedSubtree[],
  proof: readonly ConfigProtectedSubtreeProof[]
): boolean {
  if (subtrees.length !== proof.length) {
    return false;
  }
  const byPath = new Map(proof.map((entry) => [entry.path, entry]));
  for (const subtree of subtrees) {
    const entry = byPath.get(subtree.path);
    if (
      entry === undefined ||
      entry.expected_semantic_hash !== subtree.semantic_hash ||
      entry.before_semantic_hash !== subtree.semantic_hash
    ) {
      return false;
    }
  }
  return true;
}

function assignmentsEqual(
  left: readonly ConfigFieldAssignment[],
  right: readonly ConfigFieldAssignment[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) {
      return false;
    }
    if (a.field_id !== b.field_id) {
      return false;
    }
    if (canonicalJsonText(assignmentJson(a)) !== canonicalJsonText(assignmentJson(b))) {
      return false;
    }
  }
  return true;
}

interface ValidatedApplyOutput {
  readonly output: ConfigPatchApplyOutput;
  readonly candidate_hash: Hash;
}

function validateApplyOutput(
  patch: ConfigWritePatch,
  output: ConfigPatchApplyOutput
): Result<ValidatedApplyOutput, ErrorEnvelope> {
  if (output.new_content.byteLength > CONFIG_WRITE_MAX_CONTENT_BYTES) {
    return err(configApplyError({ apply_reason: "candidate_mismatch" }));
  }
  const candidateHash = hashBytes(output.new_content);
  if (candidateHash !== output.candidate_content_hash) {
    return err(configApplyError({ apply_reason: "candidate_mismatch" }));
  }
  if (!isHash(output.new_semantic_hash)) {
    return err(configApplyError({ apply_reason: "candidate_mismatch" }));
  }
  if (!assignmentsEqual(output.applied_fields, patch.candidate_values)) {
    return err(
      configApplyError({
        apply_reason: "candidate_mismatch",
        ...(output.applied_fields[0] === undefined ? {} : { field_id: output.applied_fields[0].field_id })
      })
    );
  }
  if (!verifyProof(patch.protected_subtrees, output.protected_subtree_proof)) {
    return err(configApplyError({ apply_reason: "protected_subtree_mismatch" }));
  }
  return ok({ output, candidate_hash: candidateHash });
}

function applyFailureEnvelope(failure: {
  readonly reason:
    | "expected_field_mismatch"
    | "protected_subtree_mismatch"
    | "unsupported_field"
    | "forbidden_field"
    | "path_invalid"
    | "candidate_mismatch"
    | "parser_failed"
    | "serializer_failed";
  readonly field_id: Id<"fld"> | null;
  readonly path: string | null;
}): ErrorEnvelope {
  return configApplyError({
    apply_reason: failure.reason,
    ...(failure.field_id === null ? {} : { field_id: failure.field_id }),
    ...(failure.path === null ? {} : { path: failure.path })
  });
}

/* ------------------------------------------------------------------ */
/* Port factory                                                       */
/* ------------------------------------------------------------------ */

interface Deadline {
  readonly at: number;
}

function remainingMs(deadline: Deadline, monotonic: () => number): number {
  return Math.floor(deadline.at - monotonic());
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function lockParams(input: {
  readonly lock: ConfigWriteLockRequest;
  readonly lock_key: Hash;
  readonly lock_handle_hash: Hash;
  readonly holder: string;
  readonly fencing_token: number;
  readonly root: RootContext;
  readonly registration_hash: Hash;
  readonly base_file_hash: Hash;
  readonly base_content_ref: SourceRef;
  readonly base_byte_length: number;
  readonly acquired_at: number;
  readonly expires_at: number;
}): Record<string, unknown> {
  return {
    lock_key: input.lock_key,
    lock_handle_hash: input.lock_handle_hash,
    holder_client_id: input.holder,
    fencing_token: input.fencing_token,
    grant_id: input.lock.grant_id,
    action: input.lock.action,
    object_type: "config",
    candidate_id: input.lock.candidate_id,
    candidate_hash: input.lock.candidate_hash,
    binding_json: canonicalJsonText(bindingJson(input.lock.binding)),
    config_space_id: input.lock.config_space_id,
    field_registry_snapshot_hash: input.lock.field_registry_snapshot_hash,
    layer_id: input.lock.layer_id,
    model_scope_key: input.lock.model_scope_key,
    root_id: input.lock.root_id,
    root_registration_hash: input.registration_hash,
    root_identity_pin_json: canonicalJsonText(pinJson(input.root.pin)),
    target_path: input.lock.target_path,
    expected_config_version: input.lock.expected_config_version,
    reason: input.lock.reason,
    base_file_hash: input.base_file_hash,
    base_content_ref: input.base_content_ref,
    base_byte_length: input.base_byte_length,
    acquired_at: input.acquired_at,
    expires_at: input.expires_at
  };
}

const LOCK_UPSERT_SQL = `INSERT INTO config_write_lock (
    lock_key, lock_handle_hash, holder_client_id, fencing_token, grant_id, action,
    object_type, candidate_id, candidate_hash, binding_json, config_space_id,
    field_registry_snapshot_hash, layer_id, model_scope_key, root_id,
    root_registration_hash, root_identity_pin_json, target_path,
    expected_config_version, reason, base_file_hash, base_content_ref,
    base_byte_length, acquired_at, expires_at, released_at
  ) VALUES (
    :lock_key, :lock_handle_hash, :holder_client_id, :fencing_token, :grant_id, :action,
    :object_type, :candidate_id, :candidate_hash, :binding_json, :config_space_id,
    :field_registry_snapshot_hash, :layer_id, :model_scope_key, :root_id,
    :root_registration_hash, :root_identity_pin_json, :target_path,
    :expected_config_version, :reason, :base_file_hash, :base_content_ref,
    :base_byte_length, :acquired_at, :expires_at, NULL
  ) ON CONFLICT(lock_key) DO UPDATE SET
    lock_handle_hash = excluded.lock_handle_hash,
    holder_client_id = excluded.holder_client_id,
    fencing_token = excluded.fencing_token,
    grant_id = excluded.grant_id,
    action = excluded.action,
    object_type = excluded.object_type,
    candidate_id = excluded.candidate_id,
    candidate_hash = excluded.candidate_hash,
    binding_json = excluded.binding_json,
    config_space_id = excluded.config_space_id,
    field_registry_snapshot_hash = excluded.field_registry_snapshot_hash,
    layer_id = excluded.layer_id,
    model_scope_key = excluded.model_scope_key,
    root_id = excluded.root_id,
    root_registration_hash = excluded.root_registration_hash,
    root_identity_pin_json = excluded.root_identity_pin_json,
    target_path = excluded.target_path,
    expected_config_version = excluded.expected_config_version,
    reason = excluded.reason,
    base_file_hash = excluded.base_file_hash,
    base_content_ref = excluded.base_content_ref,
    base_byte_length = excluded.base_byte_length,
    acquired_at = excluded.acquired_at,
    expires_at = excluded.expires_at,
    released_at = NULL`;

function releaseLockSql(): string {
  return `UPDATE config_write_lock
             SET released_at = :released_at
           WHERE lock_key = :lock_key
             AND lock_handle_hash = :lock_handle_hash
             AND fencing_token = :fencing_token
             AND released_at IS NULL`;
}

/**
 * Creates the FND `ConfigWritePort`.
 *
 * Durability order per step: journal frame fsync, then one short synchronous
 * SQLite transaction. The apply port is awaited with no SQLite transaction
 * open.
 */
export function createConfigWritePort(deps: ConfigWritePortDependencies): ConfigWritePort {
  const runner: TransactionRunner = createTransactionRunner(deps.connection);
  const monotonic = deps.monotonic ?? ((): number => performance.now());
  const holder = deps.holder_client_id ?? DEFAULT_HOLDER;
  const commitPaths = new Set<string>();

  function requireJournal(stage: string): Result<JournalCommitter, ErrorEnvelope> {
    return deps.journal === undefined
      ? err(internalFailure(stage, "fnd.config_write_journal_unavailable"))
      : ok(deps.journal);
  }

  function requireRootResolver(stage: string): Result<RootResolver, ErrorEnvelope> {
    return deps.root_resolver === undefined
      ? err(internalFailure(stage, "fnd.config_write_root_resolver_unavailable"))
      : ok(deps.root_resolver);
  }

  function requireApplyPort(stage: string): Result<ConfigPatchApplyPort, ErrorEnvelope> {
    return deps.apply_port === undefined
      ? err(internalFailure(stage, "fnd.config_write_apply_port_unavailable"))
      : ok(deps.apply_port);
  }

  function checkDeadline(deadline: Deadline): ErrorEnvelope | null {
    return remainingMs(deadline, monotonic) < 1
      ? authError({ code: "E_DEADLINE_EXCEEDED", stage: "config_write", details: { kind: "none" } })
      : null;
  }

  function releaseOwnedLock(
    lock: LockRow,
    handleHash: Hash,
    fencingToken: number,
    when: number
  ): void {
    try {
      deps.connection.prepare(releaseLockSql()).run({
        released_at: when,
        lock_key: lock.lock_key,
        lock_handle_hash: handleHash,
        fencing_token: fencingToken
      });
    } catch {
      // The lock row is advisory and expires; a failed release does not
      // change the caller-visible outcome of a zero-effect failure.
    }
  }

  /* ---------------------------------------------------------------- */
  /* lock                                                             */
  /* ---------------------------------------------------------------- */

  async function lock(
    input: ConfigWriteLockRequest,
    signal?: AbortSignal
  ): Promise<Result<ConfigWriteLock, ErrorEnvelope>> {
    const deadline: Deadline = { at: monotonic() + input.deadline_ms };
    if (isAborted(signal)) {
      return cancelledFailure();
    }
    const expired = checkDeadline(deadline);
    if (expired !== null) {
      return failResult(expired, "degraded");
    }

    const validated = validateConfigWriteLockRequest(input);
    if (!validated.ok) {
      return validated;
    }
    const journal = requireJournal("config_write_lock");
    if (!journal.ok) {
      return journal;
    }
    const resolver = requireRootResolver("config_write_lock");
    if (!resolver.ok) {
      return resolver;
    }
    const binding = parseVersionBinding(input.binding);
    if (!binding.ok) {
      return binding;
    }

    const grantResult = readGrant(deps.connection, input.grant_id);
    if (!grantResult.ok) {
      return grantResult;
    }
    const grant = grantResult.value;
    if (grant === null) {
      return failResult(
        authDenied({ object_type: "config", reason: "no_grant", stage: "config_write_authorize" })
      );
    }
    if (grant.scope.config_scope === undefined) {
      return failResult(authConfigScope(grant.grant_id));
    }
    const consumption = readConsumptionState(deps.connection, grant.grant_id);
    if (!consumption.ok) {
      return consumption;
    }

    const rootResult = await resolveRootContext(
      resolver.value,
      {
        root_id: input.root_id,
        deadline_at: deadline.at,
        request_id: newId("ipc", deps.now()),
        expected_path: input.approved_root,
        ...(signal === undefined ? {} : { signal })
      },
      monotonic
    );
    if (!rootResult.ok) {
      return rootResult;
    }
    const registration = readRootRegistration(deps.connection, input.root_id);
    if (!registration.ok) {
      return registration;
    }
    if (!pinsEqual(rootResult.value.pin, registration.value)) {
      return failResult(
        authError({
          code: "E_ROOT_IDENTITY_MISMATCH",
          stage: "config_write_root",
          details: { kind: "field", path: "root_identity_pin", rule: "registration_pin_mismatch" }
        })
      );
    }
    const decision = evaluateConfigDecision({
      grant,
      action: input.action,
      candidate_id: input.candidate_id,
      patch_hash: input.candidate_hash,
      config_space_id: input.config_space_id,
      field_ids: [],
      layer_id: input.layer_id,
      model_scope_key: input.model_scope_key,
      target_path: input.target_path,
      absolute_path: join(rootResult.value.approved_root, input.target_path),
      now: deps.now(),
      consumption: consumption.value
    });
    const denied = decisionDenial(decision, grant);
    if (denied !== null) {
      return failResult(denied);
    }
    if (checkDeadline(deadline) !== null) {
      return deadlineFailure();
    }
    if (isAborted(signal)) {
      return cancelledFailure();
    }

    const target = inspectTargetFile(rootResult.value.approved_root, input.target_path, false);
    if (!target.ok) {
      return target;
    }
    if (target.value === null) {
      return failResult(pathFailure("target_missing", "config_write_lock"));
    }
    if (target.value.bytes.byteLength > CONFIG_WRITE_MAX_CONTENT_BYTES) {
      return failResult(contentFailure("base_max_8_mib"));
    }

    const stored = deps.blob_store.putSync(target.value.bytes);
    if (!stored.ok) {
      return stored;
    }
    const baseRef = blobSourceRef(stored.value.hash, target.value.bytes.byteLength);

    const lockKey = configLockKey(input.root_id, input.target_path);
    const handle = newLockHandle();
    const handleHash = hashHandle(handle);
    const acquiredAt = deps.now();
    const expiresAt = acquiredAt + CONFIG_WRITE_LOCK_TTL_MS;
    const params = lockParams({
      lock: input,
      lock_key: lockKey,
      lock_handle_hash: handleHash,
      holder,
      fencing_token: 1,
      root: rootResult.value,
      registration_hash: registration.value.registration_hash,
      base_file_hash: target.value.file_hash,
      base_content_ref: baseRef,
      base_byte_length: target.value.bytes.byteLength,
      acquired_at: acquiredAt,
      expires_at: expiresAt
    });

    let fencingToken = 1;
    try {
      fencingToken = runner.withTxSync((tx) => {
        const active = tx
          .prepare<Row>(
            `SELECT config_write_id FROM config_write_intent
              WHERE root_id = :root_id AND target_path = :target_path
                AND state IN ('intent_recorded','snapshot_written','temp_written','renamed','dir_synced')
              LIMIT 1`
          )
          .get({ root_id: input.root_id, target_path: input.target_path });
        if (active !== undefined) {
          throw lockedFailure();
        }
        const latest = tx
          .prepare<Row>(
            `SELECT state FROM config_write_intent
              WHERE root_id = :root_id AND target_path = :target_path
              ORDER BY updated_at DESC, config_write_id DESC LIMIT 1`
          )
          .get({ root_id: input.root_id, target_path: input.target_path });
        const latestState = latest === undefined ? null : stringField(latest, "state");
        if (
          latestState !== null &&
          (UNCERTAIN_STATES as readonly string[]).includes(latestState) &&
          input.action === "update"
        ) {
          throw recoveryFailure();
        }
        const existing = tx
          .prepare<Row>(
            `SELECT fencing_token, released_at, expires_at FROM config_write_lock
              WHERE lock_key = :lock_key`
          )
          .get({ lock_key: lockKey });
        let nextToken = 1;
        if (existing !== undefined) {
          const currentToken = numberField(existing, "fencing_token") ?? 0;
          const released = nullableNumber(existing, "released_at");
          const rowExpires = numberField(existing, "expires_at") ?? 0;
          if (released === null && rowExpires > deps.now()) {
            throw lockedFailure();
          }
          nextToken = currentToken + 1;
        }
        params["fencing_token"] = nextToken;
        tx.prepare(LOCK_UPSERT_SQL).run(params);
        return nextToken;
      });
    } catch (error) {
      if (isErrorEnvelope(error)) {
        return failResult(error);
      }
      return failResult(mapSqliteFailure(error, "config_write_lock", "acquire"), "degraded");
    }

    return okResult({
      schema_version: CONFIG_WRITE_SCHEMA_VERSION,
      lock_handle: handle,
      fencing_token: fencingToken,
      base_file_hash: target.value.file_hash,
      base_config_version: input.expected_config_version,
      base_content_ref: baseRef,
      root_identity_pin: rootResult.value.pin,
      root_registration_hash: registration.value.registration_hash,
      expires_at: expiresAt
    });
  }

  /* ---------------------------------------------------------------- */
  /* Shared commit helpers                                            */
  /* ---------------------------------------------------------------- */

  type RevalidationKind = "stale" | "path" | "conflict" | "deadline" | "cancelled" | "storage";

  interface RevalidationFailure {
    readonly kind: RevalidationKind;
    readonly error: ErrorEnvelope;
  }

  function staleReason(lock: LockRow, handleHash: Hash, fencingToken: number, now: number): "base_changed" | "lock_expired" | "fencing" | "connection" | null {
    if (lock.lock_handle_hash !== handleHash || lock.holder_client_id !== holder) {
      return "connection";
    }
    if (lock.fencing_token !== fencingToken) {
      return "fencing";
    }
    if (lock.released_at !== null || now >= lock.expires_at) {
      return "lock_expired";
    }
    return null;
  }

  interface LockedTarget {
    readonly root: RootContext;
    readonly target: TargetFile;
  }

  async function inspectLockedTarget(
    lock: LockRow,
    deadline: Deadline,
    signal: AbortSignal | undefined,
    resolver: RootResolver
  ): Promise<Result<LockedTarget, ErrorEnvelope>> {
    const root = await resolveRootContext(
      resolver,
      {
        root_id: lock.root_id,
        deadline_at: deadline.at,
        request_id: newId("ipc", deps.now()),
        expected_pin: lock.pin,
        ...(signal === undefined ? {} : { signal })
      },
      monotonic
    );
    if (!root.ok) {
      return root;
    }
    if (root.value.pin.root_id !== lock.pin.root_id || !pinsEqual(root.value.pin, lock.pin)) {
      return failResult(
        authError({
          code: "E_ROOT_IDENTITY_MISMATCH",
          stage: "config_write_root",
          details: { kind: "field", path: "root_identity_pin", rule: "lock_pin_mismatch" }
        })
      );
    }
    const registration = readRootRegistration(deps.connection, lock.root_id);
    if (!registration.ok) {
      return registration;
    }
    if (registration.value.registration_hash !== lock.root_registration_hash) {
      return failResult(configStaleError("connection"));
    }
    const target = inspectTargetFile(root.value.approved_root, lock.target_path, false);
    if (!target.ok) {
      return target;
    }
    if (target.value === null) {
      return failResult(pathFailure("target_missing"));
    }
    return ok({ root: root.value, target: target.value });
  }

  function classifyRevalidation(error: ErrorEnvelope): RevalidationKind {
    if (error.code === "E_DEADLINE_EXCEEDED") {
      return "deadline";
    }
    if (error.code === "E_CANCELLED") {
      return "cancelled";
    }
    if (error.code === "E_WRITE_CONFIG_PATH" || error.code.startsWith("E_ROOT_")) {
      return "path";
    }
    if (error.code === "E_STORAGE_IO") {
      return "storage";
    }
    return "stale";
  }

  async function revalidateBeforeEffect(input: {
    readonly lock: LockRow;
    readonly handle_hash: Hash;
    readonly fencing_token: number;
    readonly expected_base_hash: Hash;
    readonly deadline: Deadline;
    readonly signal: AbortSignal | undefined;
    readonly resolver: RootResolver;
    readonly grant_id: Id<"grant">;
    readonly patch_hash: Hash;
    readonly action: "update" | "rollback";
    readonly candidate_id: Id<"ctr">;
    readonly config_space_id: Hash;
    readonly field_ids: readonly Id<"fld">[];
    readonly layer_id: string;
    readonly model_scope_key: string;
    readonly target_path: string;
    readonly check_grant: boolean;
  }): Promise<
    | { readonly ok: true; readonly target: LockedTarget; readonly decision: WriteDecision | null }
    | { readonly ok: false; readonly failure: RevalidationFailure }
  > {
    const now = deps.now();
    const stale = staleReason(input.lock, input.handle_hash, input.fencing_token, now);
    if (stale !== null) {
      return { ok: false, failure: { kind: "stale", error: configStaleError(stale) } };
    }
    const deadlineError = checkDeadline(input.deadline);
    if (deadlineError !== null) {
      return { ok: false, failure: { kind: "deadline", error: deadlineError } };
    }
    if (isAborted(input.signal)) {
      return {
        ok: false,
        failure: {
          kind: "cancelled",
          error: authError({ code: "E_CANCELLED", stage: "config_write", details: { kind: "none" } })
        }
      };
    }
    const inspected = await inspectLockedTarget(input.lock, input.deadline, input.signal, input.resolver);
    if (!inspected.ok) {
      return {
        ok: false,
        failure: { kind: classifyRevalidation(inspected.error), error: inspected.error }
      };
    }
    if (inspected.value.target.file_hash !== input.expected_base_hash) {
      return { ok: false, failure: { kind: "conflict", error: configStaleError("base_changed") } };
    }
    let decision: WriteDecision | null = null;
    if (input.check_grant) {
      const grantResult = readGrant(deps.connection, input.grant_id);
      if (!grantResult.ok) {
        return { ok: false, failure: { kind: "stale", error: grantResult.error } };
      }
      if (grantResult.value === null) {
        return {
          ok: false,
          failure: {
            kind: "stale",
            error: authDenied({ object_type: "config", reason: "no_grant", stage: "config_write_authorize" })
          }
        };
      }
      const consumption = readConsumptionState(deps.connection, input.grant_id);
      if (!consumption.ok) {
        return { ok: false, failure: { kind: "stale", error: consumption.error } };
      }
      const decisionValue = evaluateConfigDecision({
        grant: grantResult.value,
        action: input.action,
        candidate_id: input.candidate_id,
        patch_hash: input.patch_hash,
        config_space_id: input.config_space_id,
        field_ids: input.field_ids,
        layer_id: input.layer_id,
        model_scope_key: input.model_scope_key,
        target_path: input.target_path,
        absolute_path: inspected.value.target.absolute_path,
        now: deps.now(),
        consumption: consumption.value
      });
      const denied = decisionDenial(decisionValue, grantResult.value);
      if (denied !== null) {
        return { ok: false, failure: { kind: "stale", error: denied } };
      }
      decision = decisionValue;
    }
    return { ok: true, target: inspected.value, decision };
  }

  function validatePatchAgainstLock(
    patch: ConfigWritePatch,
    lock: LockRow
  ): ErrorEnvelope | null {
    if (patch.patch_hash !== lock.candidate_hash) {
      return fieldError("E_WRITE_CONFIG_PATCH", "patch_hash", "equals_candidate_hash");
    }
    if (patch.target_path !== lock.target_path) {
      return fieldError("E_WRITE_CONFIG_PATH", "target_path", "equals_lock_target");
    }
    if (patch.config_space_id !== lock.config_space_id) {
      return fieldError("E_WRITE_CONFIG_PATCH", "config_space_id", "equals_lock");
    }
    if (patch.field_registry_snapshot_hash !== lock.field_registry_snapshot_hash) {
      return fieldError("E_WRITE_CONFIG_PATCH", "field_registry_snapshot_hash", "equals_lock");
    }
    if (patch.layer_id !== lock.layer_id) {
      return fieldError("E_WRITE_CONFIG_PATCH", "layer_id", "equals_lock");
    }
    if (patch.model_scope_key !== lock.model_scope_key) {
      return fieldError("E_WRITE_CONFIG_PATCH", "model_scope_key", "equals_lock");
    }
    return null;
  }

  const INTENT_INSERT_SQL = `INSERT INTO config_write_intent (
    config_write_id, idempotency_key, request_hash, grant_id, action, object_type,
    candidate_id, candidate_hash, patch_hash, patch_json, auth_decision_json, binding_json,
    config_space_id, field_registry_snapshot_hash, layer_id, model_scope_key, root_id,
    root_registration_hash, root_identity_pin_json, target_path, expected_config_version,
    reason, base_file_hash, base_content_ref, base_byte_length, candidate_content_hash,
    candidate_content_ref, new_semantic_hash, protected_subtree_proof_json, snapshot_id,
    state, attempt, last_error_code, row_version, created_at, updated_at
  ) VALUES (
    :config_write_id, :idempotency_key, :request_hash, :grant_id, :action, :object_type,
    :candidate_id, :candidate_hash, :patch_hash, :patch_json, :auth_decision_json, :binding_json,
    :config_space_id, :field_registry_snapshot_hash, :layer_id, :model_scope_key, :root_id,
    :root_registration_hash, :root_identity_pin_json, :target_path, :expected_config_version,
    :reason, :base_file_hash, :base_content_ref, :base_byte_length, :candidate_content_hash,
    :candidate_content_ref, :new_semantic_hash, :protected_subtree_proof_json, :snapshot_id,
    :state, :attempt, :last_error_code, :row_version, :created_at, :updated_at
  )`;

  const SNAPSHOT_INSERT_SQL = `INSERT INTO config_write_snapshot (
    snapshot_id, config_write_id, path, base_file_hash, content_ref, byte_length, created_at
  ) VALUES (
    :snapshot_id, :config_write_id, :path, :base_file_hash, :content_ref, :byte_length, :created_at
  )`;

  const RESULT_INSERT_SQL = `INSERT INTO config_write_result (
    config_write_id, attempt, candidate_id, candidate_hash, state, path,
    candidate_content_hash, new_file_hash, new_semantic_hash, snapshot_id,
    readback_verified, protected_subtrees_verified, atomicity, exclusion,
    error_code, completed_at
  ) VALUES (
    :config_write_id, :attempt, :candidate_id, :candidate_hash, :state, :path,
    :candidate_content_hash, :new_file_hash, :new_semantic_hash, :snapshot_id,
    :readback_verified, :protected_subtrees_verified, :atomicity, :exclusion,
    :error_code, :completed_at
  )`;

  function intentParams(intent: ConfigWriteIntent): Record<string, unknown> {
    return {
      config_write_id: intent.config_write_id,
      idempotency_key: intent.idempotency_key,
      request_hash: intent.request_hash,
      grant_id: intent.grant_id,
      action: intent.action,
      object_type: intent.object_type,
      candidate_id: intent.candidate_id,
      candidate_hash: intent.candidate_hash,
      patch_hash: intent.patch_hash,
      patch_json: canonicalJsonText(patchJson(intent.patch)),
      auth_decision_json: canonicalJsonText(decisionJson(intent.auth_decision)),
      binding_json: canonicalJsonText(bindingJson(intent.binding)),
      config_space_id: intent.config_space_id,
      field_registry_snapshot_hash: intent.field_registry_snapshot_hash,
      layer_id: intent.layer_id,
      model_scope_key: intent.model_scope_key,
      root_id: intent.root_id,
      root_registration_hash: intent.root_registration_hash,
      root_identity_pin_json: canonicalJsonText(pinJson(intent.root_identity_pin)),
      target_path: intent.target_path,
      expected_config_version: intent.expected_config_version,
      reason: intent.reason,
      base_file_hash: intent.base_file_hash,
      base_content_ref: intent.base_content_ref,
      base_byte_length: intent.base_byte_length,
      candidate_content_hash: intent.candidate_content_hash,
      candidate_content_ref: intent.candidate_content_ref,
      new_semantic_hash: intent.new_semantic_hash,
      protected_subtree_proof_json: canonicalJsonText(proofJson(intent.protected_subtree_proof)),
      snapshot_id: intent.snapshot_id,
      state: intent.state,
      attempt: intent.attempt,
      last_error_code: intent.last_error_code,
      row_version: intent.row_version,
      created_at: intent.created_at,
      updated_at: intent.updated_at
    };
  }

  async function insertIntent(
    journal: JournalCommitter,
    intent: ConfigWriteIntent
  ): Promise<JournalOutcome> {
    return appendConfigEvent(
      journal,
      {
        event_type: "config_write.intent_recorded",
        entity_type: "config_write_intent",
        entity_id: intent.config_write_id,
        operation: "insert",
        binding: intent.binding,
        row_schema: CONFIG_WRITE_INTENT_SCHEMA_VERSION,
        row: intentRow(intent),
        before: null,
        blob_hashes:
          intent.candidate_content_hash === null ? [] : [intent.candidate_content_hash],
        project_ledger: true,
        project: (tx) => {
          tx.prepare(INTENT_INSERT_SQL).run(intentParams(intent));
        }
      },
      deps.now
    );
  }

  interface TransitionOutcome {
    readonly ok: boolean;
    readonly intent: ConfigWriteIntent | null;
    readonly error: ErrorEnvelope | null;
  }

  async function transitionIntent(
    journal: JournalCommitter,
    intent: ConfigWriteIntent,
    to: ConfigWriteState,
    errorCode: string | null
  ): Promise<TransitionOutcome> {
    const now = deps.now();
    const next: ConfigWriteIntent = {
      ...intent,
      state: to,
      last_error_code: errorCode,
      row_version: intent.row_version + 1,
      updated_at: now
    };
    const before = intentRow(intent);
    const after = intentRow(next);
    const outcome = await appendConfigEvent(
      journal,
      {
        event_type: "config_write.transition",
        entity_type: "config_write_intent",
        entity_id: next.config_write_id,
        operation: "transition",
        binding: next.binding,
        row_schema: CONFIG_WRITE_INTENT_SCHEMA_VERSION,
        row: after,
        before,
        blob_hashes: [],
        project_ledger: true,
        project: (tx) => {
          const updated = tx
            .prepare(
              `UPDATE config_write_intent
                  SET state = :state,
                      last_error_code = :last_error_code,
                      row_version = :row_version,
                      updated_at = :updated_at
                WHERE config_write_id = :config_write_id
                  AND row_version = :expected_row_version`
            )
            .run({
              state: next.state,
              last_error_code: next.last_error_code,
              row_version: next.row_version,
              updated_at: next.updated_at,
              config_write_id: next.config_write_id,
              expected_row_version: intent.row_version
            });
          if (updated.changes !== 1) {
            throw authError({
              code: "E_WRITE_STATE",
              stage: "config_write_transition",
              details: { kind: "field", path: "row_version", rule: "cas" }
            });
          }
        }
      },
      deps.now
    );
    if (!outcome.ok) {
      return { ok: false, intent: null, error: outcome.error };
    }
    return { ok: true, intent: next, error: null };
  }

  async function insertSnapshot(
    journal: JournalCommitter,
    intent: ConfigWriteIntent,
    snapshot: ConfigWriteSnapshot
  ): Promise<JournalOutcome> {
    const next: ConfigWriteIntent = {
      ...intent,
      state: "snapshot_written",
      snapshot_id: snapshot.snapshot_id,
      row_version: intent.row_version + 1,
      updated_at: deps.now()
    };
    return appendConfigEvent(
      journal,
      {
        event_type: "config_write.snapshot_recorded",
        entity_type: "config_write_snapshot",
        entity_id: snapshot.snapshot_id,
        operation: "insert",
        binding: intent.binding,
        row_schema: CONFIG_WRITE_SNAPSHOT_SCHEMA_VERSION,
        row: snapshotRow(snapshot),
        before: null,
        blob_hashes: [snapshot.base_file_hash],
        project_ledger: true,
        project: (tx) => {
          tx.prepare(SNAPSHOT_INSERT_SQL).run({
            snapshot_id: snapshot.snapshot_id,
            config_write_id: snapshot.config_write_id,
            path: snapshot.path,
            base_file_hash: snapshot.base_file_hash,
            content_ref: snapshot.content_ref,
            byte_length: snapshot.byte_length,
            created_at: snapshot.created_at
          });
          const updated = tx
            .prepare(
              `UPDATE config_write_intent
                  SET state = 'snapshot_written',
                      snapshot_id = :snapshot_id,
                      row_version = :row_version,
                      updated_at = :updated_at
                WHERE config_write_id = :config_write_id
                  AND row_version = :expected_row_version`
            )
            .run({
              snapshot_id: snapshot.snapshot_id,
              row_version: next.row_version,
              updated_at: next.updated_at,
              config_write_id: intent.config_write_id,
              expected_row_version: intent.row_version
            });
          if (updated.changes !== 1) {
            throw authError({
              code: "E_WRITE_STATE",
              stage: "config_write_transition",
              details: { kind: "field", path: "row_version", rule: "cas" }
            });
          }
        }
      },
      deps.now
    );
  }

  interface TerminalIntent {
    readonly config_write_id: Id<"cwi">;
    readonly candidate_id: Id<"ctr">;
    readonly candidate_hash: Hash;
    readonly attempt: number;
    readonly target_path: string;
    readonly snapshot_id: Id<"wsnap"> | null;
    readonly row_version: number;
    readonly binding: VersionBinding;
  }

  function buildResult(input: {
    readonly intent: TerminalIntent;
    readonly state: ConfigWriteTerminalState;
    readonly candidate_hash: Hash | null;
    readonly semantic_hash: Hash | null;
    readonly readback: boolean;
    readonly protected_verified: boolean;
    readonly renamed: boolean;
    readonly error_code: string | null;
  }): ConfigWriteResult {
    const fileHash = input.state === "verified" ? input.candidate_hash : null;
    return {
      schema_version: CONFIG_WRITE_RESULT_SCHEMA_VERSION,
      config_write_id: input.intent.config_write_id,
      candidate_id: input.intent.candidate_id,
      candidate_hash: input.intent.candidate_hash,
      attempt: input.intent.attempt,
      state: input.state,
      path: input.intent.target_path,
      candidate_content_hash: input.candidate_hash,
      new_file_hash: fileHash,
      new_semantic_hash: input.semantic_hash,
      snapshot_id: input.intent.snapshot_id,
      readback_verified: input.readback,
      protected_subtrees_verified: input.protected_verified,
      atomicity: input.renamed ? "single_file_atomic" : "none",
      exclusion: "rsi_advisory",
      error_code: input.error_code,
      completed_at: deps.now()
    };
  }

  /**
   * Writes a terminal result. `verified` follows the fixed journal order
   * `grant.consumed` (once only) then `config_write.result_recorded`; the
   * result row, consumption and ledger projection share one short transaction.
   */
  async function writeTerminal(input: {
    readonly journal: JournalCommitter;
    readonly intent: TerminalIntent;
    readonly result: ConfigWriteResult;
    readonly grant: AuthorizationGrant;
    readonly lock: LockRow | null;
    readonly handle_hash: Hash | null;
    readonly fencing_token: number | null;
  }): Promise<Result<ConfigWriteResult, ErrorEnvelope>> {
    const { intent, result } = input;
    let consumptionEvent: Record<string, JsonValue> | null = null;
    let consumptionReceipt: JournalAppendResult | null = null;
    let consumptionRow: Record<string, JsonValue> | null = null;

    if (result.state === "verified" && input.grant.mode === "once") {
      const existing = readConsumptionState(deps.connection, input.grant.grant_id);
      if (!existing.ok) {
        return existing;
      }
      const alreadyMine =
        existing.value !== null && existing.value.config_write_id === intent.config_write_id;
      if (!alreadyMine && existing.value === null) {
        const consumedAt = deps.now();
        consumptionRow = {
          schema_version: "rsi.grant_consumption/2",
          grant_id: input.grant.grant_id,
          write_kind: "config",
          managed_write_id: null,
          config_write_id: intent.config_write_id,
          consumed_at: consumedAt
        };
        const frame = await appendConfigEvent(
          input.journal,
          {
            event_type: "grant.consumed",
            entity_type: "grant_consumption",
            entity_id: input.grant.grant_id,
            operation: "insert",
            binding: intent.binding,
            row_schema: "rsi.grant_consumption/2",
            row: consumptionRow,
            before: null,
            blob_hashes: [],
            project_ledger: false
          },
          deps.now
        );
        if (!frame.ok) {
          return failResult(
            frame.error ?? internalFailure("config_write_result", "fnd.config_write_consumption_journal"),
            frame.unknown ? "unknown" : "rejected"
          );
        }
        consumptionEvent = frame.event;
        consumptionReceipt = frame.receipt;
      }
    }

    const outcome = await appendConfigEvent(
      input.journal,
      {
        event_type: "config_write.result_recorded",
        entity_type: "config_write_result",
        entity_id: intent.config_write_id,
        operation: "insert",
        binding: intent.binding,
        row_schema: CONFIG_WRITE_RESULT_SCHEMA_VERSION,
        row: resultRow(result),
        before: null,
        blob_hashes:
          result.candidate_content_hash === null ? [] : [result.candidate_content_hash],
        project_ledger: true,
        project: (tx) => {
          if (consumptionEvent !== null && consumptionReceipt !== null && consumptionRow !== null) {
            const rowJson = canonicalJsonText(consumptionRow);
            insertLedgerEventLog(tx, {
              event: consumptionEvent,
              eventType: "grant.consumed",
              entityType: "grant_consumption",
              entityId: input.grant.grant_id,
              operation: "insert",
              binding: intent.binding,
              beforeHash: null,
              afterHash: canonicalHash({
                row_schema: "rsi.grant_consumption/2",
                row_json: rowJson
              }),
              rowSchema: "rsi.grant_consumption/2",
              rowJson,
              journalId: consumptionReceipt.journal_id,
              commitSeq: consumptionReceipt.first_commit_seq,
              recordedAt: deps.now()
            });
          }
          tx.prepare(RESULT_INSERT_SQL).run({
            config_write_id: result.config_write_id,
            attempt: result.attempt,
            candidate_id: result.candidate_id,
            candidate_hash: result.candidate_hash,
            state: result.state,
            path: result.path,
            candidate_content_hash: result.candidate_content_hash,
            new_file_hash: result.new_file_hash,
            new_semantic_hash: result.new_semantic_hash,
            snapshot_id: result.snapshot_id,
            readback_verified: result.readback_verified ? 1 : 0,
            protected_subtrees_verified: result.protected_subtrees_verified ? 1 : 0,
            atomicity: result.atomicity,
            exclusion: result.exclusion,
            error_code: result.error_code,
            completed_at: result.completed_at
          });
          if (result.state === "verified" && input.grant.mode === "once") {
            const consumption = planGrantConsumption({
              grant_id: input.grant.grant_id,
              write_kind: "config",
              write_id: intent.config_write_id,
              consumed_at: result.completed_at
            });
            if (!consumption.ok) {
              throw consumption.error;
            }
            consumeGrantInTransaction(tx, consumption.value);
          }
          const updated = tx
            .prepare(
              `UPDATE config_write_intent
                  SET state = :state,
                      last_error_code = :last_error_code,
                      row_version = :row_version,
                      updated_at = :updated_at
                WHERE config_write_id = :config_write_id
                  AND row_version = :expected_row_version`
            )
            .run({
              state: result.state,
              last_error_code: result.error_code,
              row_version: intent.row_version + 1,
              updated_at: result.completed_at,
              config_write_id: intent.config_write_id,
              expected_row_version: intent.row_version
            });
          if (updated.changes !== 1) {
            throw authError({
              code: "E_WRITE_STATE",
              stage: "config_write_result",
              details: { kind: "field", path: "row_version", rule: "cas" }
            });
          }
          if (input.lock !== null && input.handle_hash !== null && input.fencing_token !== null) {
            tx.prepare(releaseLockSql()).run({
              released_at: result.completed_at,
              lock_key: input.lock.lock_key,
              lock_handle_hash: input.handle_hash,
              fencing_token: input.fencing_token
            });
          }
        }
      },
      deps.now
    );
    if (!outcome.ok) {
      const existing = readLatestResult(deps.connection, intent.config_write_id);
      if (existing.ok && existing.value !== null) {
        return okResult(existing.value);
      }
      return failResult(
        outcome.error ?? internalFailure("config_write_result", "fnd.config_write_result_journal"),
        outcome.unknown ? "unknown" : "rejected"
      );
    }
    return okResult(result);
  }

  function terminalStateFor(kind: RevalidationKind): ConfigWriteTerminalState {
    switch (kind) {
      case "conflict":
        return "conflict";
      case "path":
        return "path_rejected";
      case "deadline":
      case "cancelled":
      case "stale":
      case "storage":
        return "write_failed";
      default: {
        const exhaustive: never = kind;
        return exhaustive;
      }
    }
  }

  function terminalCode(state: ConfigWriteTerminalState): string | null {
    switch (state) {
      case "conflict":
        return "E_WRITE_CONFIG_STALE";
      case "path_rejected":
        return "E_WRITE_CONFIG_PATH";
      case "write_failed":
        return "E_WRITE_CONFIG_APPLY";
      case "uncertain":
        return "E_WRITE_CONFIG_READBACK";
      case "recovery_required":
        return "E_WRITE_CONFIG_RECOVERY_REQUIRED";
      case "verified":
        return null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* commit                                                           */
  /* ---------------------------------------------------------------- */

  async function commit(
    input: ConfigWriteCommitRequest,
    signal?: AbortSignal
  ): Promise<Result<ConfigWriteResult, ErrorEnvelope>> {
    const deadline: Deadline = { at: monotonic() + input.deadline_ms };
    if (isAborted(signal)) {
      return cancelledFailure();
    }
    const expired = checkDeadline(deadline);
    if (expired !== null) {
      return failResult(expired, "degraded");
    }

    const validatedRequest = validateConfigWriteCommitRequest(input);
    if (!validatedRequest.ok) {
      return validatedRequest;
    }
    const validatedPatch = validateConfigWritePatch(input.patch);
    if (!validatedPatch.ok) {
      return validatedPatch;
    }

    if (!LOCK_HANDLE_PATTERN.test(input.lock_handle)) {
      return failResult(configStaleError("connection"));
    }
    const handleHash = hashHandle(input.lock_handle);
    const lockRead = readLockByHandle(deps.connection, handleHash);
    if (!lockRead.ok) {
      return lockRead;
    }
    const lock = lockRead.value;
    const patch = validatedPatch.value;

    let incomingHash: Hash | null = null;
    if (lock !== null) {
      const patchMismatch = validatePatchAgainstLock(patch, lock);
      if (patchMismatch !== null) {
        return failResult(patchMismatch);
      }
      incomingHash = configWriteRequestHash({
        grant_id: lock.grant_id,
        action: lock.action,
        candidate_id: lock.candidate_id,
        candidate_hash: lock.candidate_hash,
        patch_hash: patch.patch_hash,
        binding: lock.binding,
        config_space_id: lock.config_space_id,
        field_registry_snapshot_hash: lock.field_registry_snapshot_hash,
        layer_id: lock.layer_id,
        model_scope_key: lock.model_scope_key,
        root_id: lock.root_id,
        target_path: lock.target_path,
        reason: lock.reason
      });
    }

    // Idempotent replay wins even after the lock row was released, expired or
    // replaced by a newer acquisition on the same path.
    const existingIntent = readIntentByKey(deps.connection, input.idempotency_key);
    if (!existingIntent.ok) {
      return existingIntent;
    }
    if (existingIntent.value !== null) {
      const stored = existingIntent.value;
      const comparison =
        incomingHash ??
        configWriteRequestHash({
          grant_id: stored.grant_id,
          action: stored.action,
          candidate_id: stored.candidate_id,
          candidate_hash: stored.candidate_hash,
          patch_hash: patch.patch_hash,
          binding: stored.binding,
          config_space_id: stored.config_space_id,
          field_registry_snapshot_hash: stored.field_registry_snapshot_hash,
          layer_id: stored.layer_id,
          model_scope_key: stored.model_scope_key,
          root_id: stored.root_id,
          target_path: stored.target_path,
          reason: stored.reason
        });
      if (stored.request_hash !== comparison) {
        return failResult(
          idempotencyConflict(input.idempotency_key, stored.request_hash, comparison)
        );
      }
      const existingResult = readLatestResult(deps.connection, stored.config_write_id);
      if (!existingResult.ok) {
        return existingResult;
      }
      if (existingResult.value !== null) {
        return okResult(existingResult.value);
      }
      if (isActiveState(stored.state)) {
        return failResult(inProgressFailure());
      }
      return failResult(
        internalFailure("config_write_commit", "fnd.config_write_terminal_without_result")
      );
    }

    if (lock === null) {
      return failResult(configStaleError("connection"));
    }
    if (incomingHash === null) {
      return failResult(configStaleError("connection"));
    }
    const journalResult = requireJournal("config_write_commit");
    if (!journalResult.ok) {
      return journalResult;
    }
    const journal = journalResult.value;
    const resolverResult = requireRootResolver("config_write_commit");
    if (!resolverResult.ok) {
      return resolverResult;
    }
    const resolver = resolverResult.value;
    const applyResult = requireApplyPort("config_write_commit");
    if (!applyResult.ok) {
      return applyResult;
    }
    const applyPort = applyResult.value;

    // Precheck: fencing/TTL/holder/base/version and grant scope.
    const stale = staleReason(lock, handleHash, input.fencing_token, deps.now());
    if (stale !== null) {
      return failResult(configStaleError(stale));
    }
    if (input.base_file_hash !== lock.base_file_hash) {
      return failResult(configStaleError("base_changed"));
    }
    const fieldIdsResult = patchFieldIds(patch);
    if (!fieldIdsResult.ok) {
      return fieldIdsResult;
    }
    const fieldIds = fieldIdsResult.value;

    const grantRead = readGrant(deps.connection, lock.grant_id);
    if (!grantRead.ok) {
      return grantRead;
    }
    if (grantRead.value === null) {
      return failResult(
        authDenied({ object_type: "config", reason: "no_grant", stage: "config_write_authorize" })
      );
    }
    const grant = grantRead.value;
    const fieldScope = patchFieldScopeFailure(grant, fieldIds);
    if (fieldScope !== null) {
      releaseOwnedLock(lock, handleHash, input.fencing_token, deps.now());
      return failResult(fieldScope);
    }

    const pre = await revalidateBeforeEffect({
      lock,
      handle_hash: handleHash,
      fencing_token: input.fencing_token,
      expected_base_hash: lock.base_file_hash,
      deadline,
      signal,
      resolver,
      grant_id: lock.grant_id,
      patch_hash: patch.patch_hash,
      action: lock.action,
      candidate_id: lock.candidate_id,
      config_space_id: lock.config_space_id,
      field_ids: fieldIds,
      layer_id: lock.layer_id,
      model_scope_key: lock.model_scope_key,
      target_path: lock.target_path,
      check_grant: true
    });
    if (!pre.ok) {
      releaseOwnedLock(lock, handleHash, input.fencing_token, deps.now());
      return failResult(pre.failure.error, pre.failure.kind === "deadline" ? "degraded" : "rejected");
    }
    if (pre.decision === null) {
      releaseOwnedLock(lock, handleHash, input.fencing_token, deps.now());
      return failResult(
        authDenied({ object_type: "config", reason: "no_grant", stage: "config_write_authorize" })
      );
    }

    if (commitPaths.has(lock.lock_key)) {
      return failResult(inProgressFailure());
    }
    commitPaths.add(lock.lock_key);
    try {
      const baseBytes = pre.target.target.bytes;
      let applied: ConfigPatchApplyResult;
      try {
        applied = await applyPort.apply({
          patch,
          base_bytes: baseBytes,
          base_file_hash: lock.base_file_hash
        });
      } catch {
        releaseOwnedLock(lock, handleHash, input.fencing_token, deps.now());
        return failResult(configApplyError({ apply_reason: "parser_failed" }));
      }
      if (isAborted(signal)) {
        releaseOwnedLock(lock, handleHash, input.fencing_token, deps.now());
        return cancelledFailure();
      }
      if (checkDeadline(deadline) !== null) {
        releaseOwnedLock(lock, handleHash, input.fencing_token, deps.now());
        return deadlineFailure();
      }
      if (!applied.ok) {
        releaseOwnedLock(lock, handleHash, input.fencing_token, deps.now());
        return failResult(applyFailureEnvelope(applied.error));
      }
      const outputCheck = validateApplyOutput(patch, applied.value);
      if (!outputCheck.ok) {
        releaseOwnedLock(lock, handleHash, input.fencing_token, deps.now());
        return outputCheck;
      }
      const output = outputCheck.value.output;
      const candidateHash = outputCheck.value.candidate_hash;

      // Apply may exceed the lock TTL: re-check everything before any durable
      // claim or file effect.
      const postApply = await revalidateBeforeEffect({
        lock,
        handle_hash: handleHash,
        fencing_token: input.fencing_token,
        expected_base_hash: lock.base_file_hash,
        deadline,
        signal,
        resolver,
        grant_id: lock.grant_id,
        patch_hash: patch.patch_hash,
        action: lock.action,
        candidate_id: lock.candidate_id,
        config_space_id: lock.config_space_id,
        field_ids: fieldIds,
        layer_id: lock.layer_id,
        model_scope_key: lock.model_scope_key,
        target_path: lock.target_path,
        check_grant: true
      });
      if (!postApply.ok) {
        releaseOwnedLock(lock, handleHash, input.fencing_token, deps.now());
        return failResult(
          postApply.failure.error,
          postApply.failure.kind === "deadline" ? "degraded" : "rejected"
        );
      }

      const candidateBlob = deps.blob_store.putSync(output.new_content);
      if (!candidateBlob.ok) {
        releaseOwnedLock(lock, handleHash, input.fencing_token, deps.now());
        return candidateBlob;
      }
      const candidateRef = blobSourceRef(candidateBlob.value.hash, output.new_content.byteLength);

      const requestHash = configWriteRequestHash({
        grant_id: lock.grant_id,
        action: lock.action,
        candidate_id: lock.candidate_id,
        candidate_hash: lock.candidate_hash,
        patch_hash: patch.patch_hash,
        binding: lock.binding,
        config_space_id: lock.config_space_id,
        field_registry_snapshot_hash: lock.field_registry_snapshot_hash,
        layer_id: lock.layer_id,
        model_scope_key: lock.model_scope_key,
        root_id: lock.root_id,
        target_path: lock.target_path,
        reason: lock.reason
      });
      const createdAt = deps.now();
      let intent: ConfigWriteIntent = {
        schema_version: CONFIG_WRITE_INTENT_SCHEMA_VERSION,
        config_write_id: newId("cwi", createdAt),
        idempotency_key: input.idempotency_key,
        request_hash: requestHash,
        grant_id: lock.grant_id,
        action: lock.action,
        object_type: "config",
        candidate_id: lock.candidate_id,
        candidate_hash: lock.candidate_hash,
        patch_hash: patch.patch_hash,
        patch,
        auth_decision: pre.decision,
        binding: lock.binding,
        config_space_id: lock.config_space_id,
        field_registry_snapshot_hash: lock.field_registry_snapshot_hash,
        layer_id: lock.layer_id,
        model_scope_key: lock.model_scope_key,
        root_id: lock.root_id,
        root_registration_hash: lock.root_registration_hash,
        root_identity_pin: lock.pin,
        target_path: lock.target_path,
        expected_config_version: lock.expected_config_version,
        reason: lock.reason,
        base_file_hash: lock.base_file_hash,
        base_content_ref: lock.base_content_ref,
        base_byte_length: lock.base_byte_length,
        candidate_content_hash: candidateHash,
        candidate_content_ref: candidateRef,
        new_semantic_hash: output.new_semantic_hash,
        protected_subtree_proof: output.protected_subtree_proof,
        snapshot_id: null,
        state: "intent_recorded",
        attempt: 1,
        last_error_code: null,
        row_version: 1,
        created_at: createdAt,
        updated_at: createdAt
      };

      const claim = await insertIntent(journal, intent);
      if (!claim.ok) {
        const persisted = readIntentById(deps.connection, intent.config_write_id);
        if (!persisted.ok || persisted.value === null) {
          releaseOwnedLock(lock, handleHash, input.fencing_token, deps.now());
          return failResult(
            claim.error ?? internalFailure("config_write_intent", "fnd.config_write_intent_journal"),
            claim.unknown ? "unknown" : "rejected"
          );
        }
        // The durable claim exists; the in-memory row is the same attempt-1
        // intent that was just journalled.
      }

      let tempPath: string | null = null;

      async function finishFailure(
        state: ConfigWriteTerminalState,
        renamed: boolean
      ): Promise<Result<ConfigWriteResult, ErrorEnvelope>> {
        if (tempPath !== null) {
          removeTempFile(tempPath);
          tempPath = null;
        }
        const fresh = readIntentById(deps.connection, intent.config_write_id);
        const latest = fresh.ok && fresh.value !== null ? fresh.value : intent;
        if (isActiveState(latest.state)) {
          const result = buildResult({
            intent: latest,
            state,
            candidate_hash: intent.candidate_content_hash,
            semantic_hash: intent.new_semantic_hash,
            readback: false,
            protected_verified: false,
            renamed,
            error_code: terminalCode(state)
          });
          return writeTerminal({
            journal,
            intent: latest,
            result,
            grant,
            lock,
            handle_hash: handleHash,
            fencing_token: input.fencing_token
          });
        }
        const existingResult = readLatestResult(deps.connection, intent.config_write_id);
        if (existingResult.ok && existingResult.value !== null) {
          return okResult(existingResult.value);
        }
        return failResult(
          internalFailure("config_write_result", "fnd.config_write_terminal_unresolved")
        );
      }

      const snapshot: ConfigWriteSnapshot = {
        schema_version: CONFIG_WRITE_SNAPSHOT_SCHEMA_VERSION,
        snapshot_id: newId("wsnap", deps.now()),
        config_write_id: intent.config_write_id,
        path: intent.target_path,
        base_file_hash: lock.base_file_hash,
        content_ref: lock.base_content_ref,
        byte_length: lock.base_byte_length,
        created_at: deps.now()
      };
      const snapshotOutcome = await insertSnapshot(journal, intent, snapshot);
      if (!snapshotOutcome.ok) {
        return await finishFailure("write_failed", false);
      }
      intent = {
        ...intent,
        state: "snapshot_written",
        snapshot_id: snapshot.snapshot_id,
        row_version: intent.row_version + 1,
        updated_at: deps.now()
      };

      const beforeTemp = await revalidateBeforeEffect({
        lock,
        handle_hash: handleHash,
        fencing_token: input.fencing_token,
        expected_base_hash: lock.base_file_hash,
        deadline,
        signal,
        resolver,
        grant_id: lock.grant_id,
        patch_hash: patch.patch_hash,
        action: lock.action,
        candidate_id: lock.candidate_id,
        config_space_id: lock.config_space_id,
        field_ids: fieldIds,
        layer_id: lock.layer_id,
        model_scope_key: lock.model_scope_key,
        target_path: lock.target_path,
        check_grant: false
      });
      if (!beforeTemp.ok) {
        return await finishFailure(terminalStateFor(beforeTemp.failure.kind), false);
      }

      const temp = createTempFile({
        directory: beforeTemp.target.target.directory,
        base_name: beforeTemp.target.target.base_name,
        bytes: output.new_content,
        mode: beforeTemp.target.target.mode
      });
      if (!temp.ok) {
        return await finishFailure("write_failed", false);
      }
      tempPath = temp.value.path;
      const tempCheck = readBackHash(tempPath);
      if (!tempCheck.ok || tempCheck.value !== candidateHash) {
        return await finishFailure("write_failed", false);
      }

      const tempTransition = await transitionIntent(journal, intent, "temp_written", null);
      if (!tempTransition.ok || tempTransition.intent === null) {
        return await finishFailure("write_failed", false);
      }
      intent = tempTransition.intent;

      const beforeRename = await revalidateBeforeEffect({
        lock,
        handle_hash: handleHash,
        fencing_token: input.fencing_token,
        expected_base_hash: lock.base_file_hash,
        deadline,
        signal,
        resolver,
        grant_id: lock.grant_id,
        patch_hash: patch.patch_hash,
        action: lock.action,
        candidate_id: lock.candidate_id,
        config_space_id: lock.config_space_id,
        field_ids: fieldIds,
        layer_id: lock.layer_id,
        model_scope_key: lock.model_scope_key,
        target_path: lock.target_path,
        check_grant: false
      });
      if (!beforeRename.ok) {
        return await finishFailure(terminalStateFor(beforeRename.failure.kind), false);
      }

      try {
        renameSync(tempPath, beforeRename.target.target.absolute_path);
      } catch {
        return await finishFailure("write_failed", false);
      }
      const renamedPath = beforeRename.target.target.absolute_path;
      tempPath = null;

      const renamedTransition = await transitionIntent(journal, intent, "renamed", null);
      if (!renamedTransition.ok || renamedTransition.intent === null) {
        return await finishFailure("uncertain", true);
      }
      intent = renamedTransition.intent;

      const dirSync = fsyncDirectory(beforeRename.target.target.directory);
      if (!dirSync.ok) {
        return await finishFailure("uncertain", true);
      }
      const syncedTransition = await transitionIntent(journal, intent, "dir_synced", null);
      if (!syncedTransition.ok || syncedTransition.intent === null) {
        return await finishFailure("uncertain", true);
      }
      intent = syncedTransition.intent;

      // Rename is durable; abort/deadline no longer changes the verdict.
      const readback = readBackHash(renamedPath);
      if (!readback.ok) {
        return await finishFailure("uncertain", true);
      }
      if (readback.value === null || readback.value !== candidateHash) {
        return await finishFailure("recovery_required", true);
      }
      const blobCheck = deps.blob_store.read(candidateHash);
      if (!blobCheck.ok || blobCheck.value.byteLength !== output.new_content.byteLength) {
        return await finishFailure("recovery_required", true);
      }
      if (!verifyProof(patch.protected_subtrees, output.protected_subtree_proof)) {
        return await finishFailure("recovery_required", true);
      }

      const fresh = readIntentById(deps.connection, intent.config_write_id);
      const latest = fresh.ok && fresh.value !== null ? fresh.value : intent;
      const verified = buildResult({
        intent: latest,
        state: "verified",
        candidate_hash: candidateHash,
        semantic_hash: output.new_semantic_hash,
        readback: true,
        protected_verified: true,
        renamed: true,
        error_code: null
      });
      return writeTerminal({
        journal,
        intent: latest,
        result: verified,
        grant,
        lock,
        handle_hash: handleHash,
        fencing_token: input.fencing_token
      });
    } finally {
      commitPaths.delete(lock.lock_key);
    }
  }

  /* ---------------------------------------------------------------- */
  /* abort                                                            */
  /* ---------------------------------------------------------------- */

  async function abort(
    input: ConfigWriteAbortRequest,
    signal?: AbortSignal
  ): Promise<Result<ConfigWriteAbortAck, ErrorEnvelope>> {
    if (input.schema_version !== CONFIG_WRITE_SCHEMA_VERSION) {
      return failResult(fieldError("E_SCHEMA", "schema_version", CONFIG_WRITE_SCHEMA_VERSION));
    }
    if (
      !Number.isSafeInteger(input.deadline_ms) ||
      input.deadline_ms < 1 ||
      input.deadline_ms > 600_000
    ) {
      return failResult(fieldError("E_SCHEMA", "deadline_ms", "1..600000"));
    }
    if (isAborted(signal)) {
      return cancelledFailure();
    }
    if (!LOCK_HANDLE_PATTERN.test(input.lock_handle)) {
      return failResult(configStaleError("connection"));
    }
    const handleHash = hashHandle(input.lock_handle);
    const lockRead = readLockByHandle(deps.connection, handleHash);
    if (!lockRead.ok) {
      return lockRead;
    }
    if (lockRead.value === null) {
      return okResult({
        schema_version: CONFIG_WRITE_SCHEMA_VERSION,
        state: "no_op",
        released: false
      });
    }
    const lock = lockRead.value;
    if (lock.released_at !== null) {
      return okResult({
        schema_version: CONFIG_WRITE_SCHEMA_VERSION,
        state: "no_op",
        released: false
      });
    }
    if (lock.fencing_token !== input.fencing_token || lock.holder_client_id !== holder) {
      return failResult(configStaleError("fencing"));
    }
    let committed = false;
    try {
      runner.withTxSync((tx) => {
        const intent = tx
          .prepare<Row>(
            `SELECT config_write_id FROM config_write_intent
              WHERE root_id = :root_id AND target_path = :target_path
                AND created_at >= :acquired_at
              LIMIT 1`
          )
          .get({
            root_id: lock.root_id,
            target_path: lock.target_path,
            acquired_at: lock.acquired_at
          });
        if (intent !== undefined) {
          throw authError({
            code: "E_WRITE_STATE",
            stage: "config_write_abort",
            details: { kind: "field", path: "state", rule: "commit_intent_exists" }
          });
        }
        const released = tx.prepare(releaseLockSql()).run({
          released_at: deps.now(),
          lock_key: lock.lock_key,
          lock_handle_hash: handleHash,
          fencing_token: input.fencing_token
        });
        committed = released.changes === 1;
      });
    } catch (error) {
      if (isErrorEnvelope(error)) {
        return failResult(error);
      }
      return failResult(mapSqliteFailure(error, "config_write_abort", "release_lock"), "degraded");
    }
    return okResult({
      schema_version: CONFIG_WRITE_SCHEMA_VERSION,
      state: committed ? "aborted" : "no_op",
      released: committed
    });
  }

  return { lock, commit, abort };
}

/* ------------------------------------------------------------------ */
/* Startup reconciliation (DD-FND-095.5)                              */
/* ------------------------------------------------------------------ */

function recoveredResultCode(state: ConfigWriteTerminalState): string | null {
  switch (state) {
    case "conflict":
      return "E_WRITE_CONFIG_STALE";
    case "path_rejected":
      return "E_WRITE_CONFIG_PATH";
    case "write_failed":
      return "E_WRITE_CONFIG_APPLY";
    case "uncertain":
      return "E_WRITE_CONFIG_READBACK";
    case "recovery_required":
      return "E_WRITE_CONFIG_RECOVERY_REQUIRED";
    case "verified":
      return null;
  }
}

function recoveredResult(
  intent: StoredIntent,
  state: ConfigWriteTerminalState,
  renamed: boolean,
  now: number
): ConfigWriteResult {
  const verified = state === "verified";
  return {
    schema_version: CONFIG_WRITE_RESULT_SCHEMA_VERSION,
    config_write_id: intent.config_write_id,
    candidate_id: intent.candidate_id,
    candidate_hash: intent.candidate_hash,
    attempt: intent.attempt,
    state,
    path: intent.target_path,
    candidate_content_hash: intent.candidate_content_hash,
    new_file_hash: verified ? intent.candidate_content_hash : null,
    new_semantic_hash: intent.new_semantic_hash,
    snapshot_id: intent.snapshot_id,
    readback_verified: verified,
    protected_subtrees_verified: verified,
    atomicity: renamed ? "single_file_atomic" : "none",
    exclusion: "rsi_advisory",
    error_code: recoveredResultCode(state),
    completed_at: now
  };
}

interface RecoveryClassification {
  readonly state: ConfigWriteTerminalState;
  readonly renamed: boolean;
}

async function classifyRecoveryState(
  deps: ConfigWritePortDependencies,
  resolver: RootResolver,
  intent: StoredIntent,
  monotonic: () => number
): Promise<RecoveryClassification> {
  const intentDeadline: Deadline = { at: monotonic() + CONFIG_WRITE_LOCK_TTL_MS };
  const root = await resolveRootContext(
    resolver,
    {
      root_id: intent.root_id,
      deadline_at: intentDeadline.at,
      request_id: newId("ipc", deps.now()),
      expected_pin: intent.pin
    },
    monotonic
  );
  const registration = readRootRegistration(deps.connection, intent.root_id);
  let renamed = intent.state === "renamed" || intent.state === "dir_synced";
  if (!root.ok || !registration.ok) {
    return { state: "recovery_required", renamed };
  }
  if (registration.value.registration_hash !== intent.root_registration_hash) {
    return { state: "recovery_required", renamed };
  }
  const target = inspectTargetFile(root.value.approved_root, intent.target_path, true);
  if (!target.ok || target.value === null) {
    return { state: "recovery_required", renamed };
  }
  const currentHash = target.value.file_hash;
  if (currentHash === intent.base_file_hash) {
    return {
      state:
        intent.state === "renamed" || intent.state === "dir_synced"
          ? "recovery_required"
          : "write_failed",
      renamed
    };
  }
  if (
    intent.candidate_content_hash === null ||
    currentHash !== intent.candidate_content_hash
  ) {
    return { state: "recovery_required", renamed: true };
  }
  renamed = true;
  if (intent.state !== "dir_synced") {
    return { state: "recovery_required", renamed };
  }
  const blob = deps.blob_store.read(intent.candidate_content_hash);
  const patch = intent.patch;
  const proofOk =
    blob.ok &&
    patch !== null &&
    verifyProof(patch.protected_subtrees, intent.protected_subtree_proof);
  return { state: proofOk ? "verified" : "recovery_required", renamed };
}

/**
 * Reconciles config writes after a crash (DD-FND-095.5).
 *
 * Lock rows are first released and their fencing counters advanced once. Each
 * active intent without a terminal result is compared against the live file,
 * the stored candidate blob, the persisted protected-subtree proof and the
 * intent state. Existing `uncertain` results are re-examined on the same
 * evidence and either upgraded to `verified` or moved to
 * `recovery_required` on the same attempt/result row. Recovery never re-runs
 * the parser/apply port and never renames again.
 */
export async function reconcileConfigWrites(
  deps: ConfigWritePortDependencies
): Promise<Result<ConfigWriteReconcileReport, ErrorEnvelope>> {
  if (deps.journal === undefined) {
    return failResult(
      internalFailure("config_write_recovery", "fnd.config_write_journal_unavailable")
    );
  }
  if (deps.root_resolver === undefined) {
    return failResult(
      internalFailure("config_write_recovery", "fnd.config_write_root_resolver_unavailable")
    );
  }
  const journal = deps.journal;
  const resolver = deps.root_resolver;
  const runner = createTransactionRunner(deps.connection);
  const monotonic = deps.monotonic ?? ((): number => performance.now());

  let releasedLocks = 0;
  try {
    releasedLocks = runner.withTxSync((tx) => {
      const rows = tx
        .prepare<Row>(
          "SELECT lock_key, fencing_token FROM config_write_lock WHERE released_at IS NULL"
        )
        .all();
      const now = deps.now();
      for (const row of rows) {
        const lockKey = stringField(row, "lock_key");
        const token = numberField(row, "fencing_token");
        if (lockKey === null || token === null) {
          continue;
        }
        tx.prepare(
          `UPDATE config_write_lock
              SET released_at = :released_at, fencing_token = :fencing_token
            WHERE lock_key = :lock_key AND released_at IS NULL`
        ).run({ released_at: now, fencing_token: token + 1, lock_key: lockKey });
      }
      return rows.length;
    });
  } catch (error) {
    return failResult(mapSqliteFailure(error, "config_write_recovery", "release_locks"), "degraded");
  }

  let intentRows: Row[];
  try {
    intentRows = deps.connection
      .prepare<Row>(
        `SELECT i.* FROM config_write_intent i
          WHERE i.state IN ('intent_recorded','snapshot_written','temp_written','renamed','dir_synced')
            AND NOT EXISTS (
              SELECT 1 FROM config_write_result r
               WHERE r.config_write_id = i.config_write_id
            )
          ORDER BY i.created_at ASC, i.config_write_id ASC`
      )
      .all();
  } catch (error) {
    return failResult(mapSqliteFailure(error, "config_write_recovery", "scan_intents"), "degraded");
  }

  const entries: ConfigWriteReconcileEntry[] = [];
  for (const row of intentRows) {
    const intent = intentFromRow(row);
    if (intent === null) {
      return failResult(
        internalFailure("config_write_recovery", "fnd.config_write_intent_row_corrupt")
      );
    }
    const classified = await classifyRecoveryState(deps, resolver, intent, monotonic);
    const cleaned = await writeRecoveredTerminal(
      deps,
      journal,
      intent,
      classified.state,
      classified.renamed,
      false
    );
    if (!cleaned.ok) {
      return cleaned;
    }
    if (classified.state === "write_failed") {
      const root = await resolveRootContext(
        resolver,
        {
          root_id: intent.root_id,
          deadline_at: monotonic() + CONFIG_WRITE_LOCK_TTL_MS,
          request_id: newId("ipc", deps.now()),
          expected_pin: intent.pin
        },
        monotonic
      );
      if (root.ok) {
        removeAttemptTempFiles(root.value.approved_root, intent.target_path);
      }
    }
    entries.push({ config_write_id: intent.config_write_id, state: classified.state });
  }

  let uncertainRows: Row[];
  try {
    uncertainRows = deps.connection
      .prepare<Row>(
        `SELECT i.* FROM config_write_intent i
           JOIN config_write_result r
             ON r.config_write_id = i.config_write_id AND r.attempt = i.attempt
          WHERE i.state = 'uncertain' AND r.state = 'uncertain'
          ORDER BY i.created_at ASC, i.config_write_id ASC`
      )
      .all();
  } catch (error) {
    return failResult(mapSqliteFailure(error, "config_write_recovery", "scan_uncertain"), "degraded");
  }
  for (const row of uncertainRows) {
    const intent = intentFromRow(row);
    if (intent === null) {
      return failResult(
        internalFailure("config_write_recovery", "fnd.config_write_intent_row_corrupt")
      );
    }
    const classified = await classifyRecoveryState(deps, resolver, intent, monotonic);
    const state: ConfigWriteTerminalState =
      classified.state === "verified" ? "verified" : "recovery_required";
    const cleaned = await writeRecoveredTerminal(deps, journal, intent, state, true, true);
    if (!cleaned.ok) {
      return cleaned;
    }
    entries.push({ config_write_id: intent.config_write_id, state });
  }

  return okResult({
    released_locks: releasedLocks,
    scanned_intents: intentRows.length + uncertainRows.length,
    entries
  });
}

async function writeRecoveredTerminal(
  deps: ConfigWritePortDependencies,
  journal: JournalCommitter,
  intent: StoredIntent,
  state: ConfigWriteTerminalState,
  renamed: boolean,
  update_result: boolean
): Promise<Result<ConfigWriteResult, ErrorEnvelope>> {
  const result = recoveredResult(intent, state, renamed, deps.now());
  let consumptionEvent: Record<string, JsonValue> | null = null;
  let consumptionReceipt: JournalAppendResult | null = null;
  let consumptionRow: Record<string, JsonValue> | null = null;
  let grantMode: "once" | "standing" | null = null;

  if (state === "verified") {
    const grant = readGrant(deps.connection, intent.grant_id);
    if (!grant.ok) {
      return grant;
    }
    if (grant.value === null) {
      return failResult(
        internalFailure("config_write_recovery", "fnd.config_write_grant_missing")
      );
    }
    grantMode = grant.value.mode;
    if (grant.value.mode === "once") {
      const existing = readConsumptionState(deps.connection, intent.grant_id);
      if (!existing.ok) {
        return existing;
      }
      const alreadyMine =
        existing.value !== null && existing.value.config_write_id === intent.config_write_id;
      if (!alreadyMine && existing.value === null) {
        consumptionRow = {
          schema_version: "rsi.grant_consumption/2",
          grant_id: intent.grant_id,
          write_kind: "config",
          managed_write_id: null,
          config_write_id: intent.config_write_id,
          consumed_at: deps.now()
        };
        const frame = await appendConfigEvent(
          journal,
          {
            event_type: "grant.consumed",
            entity_type: "grant_consumption",
            entity_id: intent.grant_id,
            operation: "insert",
            binding: intent.binding,
            row_schema: "rsi.grant_consumption/2",
            row: consumptionRow,
            before: null,
            blob_hashes: [],
            project_ledger: false
          },
          deps.now
        );
        if (!frame.ok) {
          return failResult(
            frame.error ??
              internalFailure("config_write_recovery", "fnd.config_write_consumption_journal"),
            frame.unknown ? "unknown" : "rejected"
          );
        }
        consumptionEvent = frame.event;
        consumptionReceipt = frame.receipt;
      }
    }
  }

  const outcome = await appendConfigEvent(
    journal,
    {
      event_type: "config_write.result_recorded",
      entity_type: "config_write_result",
      entity_id: intent.config_write_id,
      operation: update_result ? "update" : "insert",
      binding: intent.binding,
      row_schema: CONFIG_WRITE_RESULT_SCHEMA_VERSION,
      row: resultRow(result),
      before: null,
      blob_hashes:
        result.candidate_content_hash === null ? [] : [result.candidate_content_hash],
      project_ledger: true,
      project: (tx) => {
        if (consumptionEvent !== null && consumptionReceipt !== null && consumptionRow !== null) {
          const rowJson = canonicalJsonText(consumptionRow);
          insertLedgerEventLog(tx, {
            event: consumptionEvent,
            eventType: "grant.consumed",
            entityType: "grant_consumption",
            entityId: intent.grant_id,
            operation: "insert",
            binding: intent.binding,
            beforeHash: null,
            afterHash: canonicalHash({
              row_schema: "rsi.grant_consumption/2",
              row_json: rowJson
            }),
            rowSchema: "rsi.grant_consumption/2",
            rowJson,
            journalId: consumptionReceipt.journal_id,
            commitSeq: consumptionReceipt.first_commit_seq,
            recordedAt: deps.now()
          });
        }
        const resultParams = {
          config_write_id: result.config_write_id,
          attempt: result.attempt,
          candidate_id: result.candidate_id,
          candidate_hash: result.candidate_hash,
          state: result.state,
          path: result.path,
          candidate_content_hash: result.candidate_content_hash,
          new_file_hash: result.new_file_hash,
          new_semantic_hash: result.new_semantic_hash,
          snapshot_id: result.snapshot_id,
          readback_verified: result.readback_verified ? 1 : 0,
          protected_subtrees_verified: result.protected_subtrees_verified ? 1 : 0,
          atomicity: result.atomicity,
          exclusion: result.exclusion,
          error_code: result.error_code,
          completed_at: result.completed_at
        };
        if (update_result) {
          tx.prepare(
            `UPDATE config_write_result
                SET candidate_id = :candidate_id,
                    candidate_hash = :candidate_hash,
                    state = :state,
                    path = :path,
                    candidate_content_hash = :candidate_content_hash,
                    new_file_hash = :new_file_hash,
                    new_semantic_hash = :new_semantic_hash,
                    snapshot_id = :snapshot_id,
                    readback_verified = :readback_verified,
                    protected_subtrees_verified = :protected_subtrees_verified,
                    atomicity = :atomicity,
                    exclusion = :exclusion,
                    error_code = :error_code,
                    completed_at = :completed_at
              WHERE config_write_id = :config_write_id AND attempt = :attempt`
          ).run(resultParams);
        } else {
          tx.prepare(
            `INSERT INTO config_write_result (
               config_write_id, attempt, candidate_id, candidate_hash, state, path,
               candidate_content_hash, new_file_hash, new_semantic_hash, snapshot_id,
               readback_verified, protected_subtrees_verified, atomicity, exclusion,
               error_code, completed_at
             ) VALUES (
               :config_write_id, :attempt, :candidate_id, :candidate_hash, :state, :path,
               :candidate_content_hash, :new_file_hash, :new_semantic_hash, :snapshot_id,
               :readback_verified, :protected_subtrees_verified, :atomicity, :exclusion,
               :error_code, :completed_at
             )`
          ).run(resultParams);
        }
        if (result.state === "verified" && grantMode === "once") {
          const consumption = planGrantConsumption({
            grant_id: intent.grant_id,
            write_kind: "config",
            write_id: intent.config_write_id,
            consumed_at: result.completed_at
          });
          if (!consumption.ok) {
            throw consumption.error;
          }
          consumeGrantInTransaction(tx, consumption.value);
        }
        const updated = tx
          .prepare(
            `UPDATE config_write_intent
                SET state = :state,
                    last_error_code = :last_error_code,
                    row_version = :row_version,
                    updated_at = :updated_at
              WHERE config_write_id = :config_write_id
                AND row_version = :expected_row_version`
          )
          .run({
            state: result.state,
            last_error_code: result.error_code,
            row_version: intent.row_version + 1,
            updated_at: result.completed_at,
            config_write_id: intent.config_write_id,
            expected_row_version: intent.row_version
          });
        if (updated.changes !== 1) {
          throw authError({
            code: "E_WRITE_STATE",
            stage: "config_write_recovery",
            details: { kind: "field", path: "row_version", rule: "cas" }
          });
        }
      }
    },
    deps.now
  );
  if (!outcome.ok) {
    const existing = readLatestResult(deps.connection, intent.config_write_id);
    if (existing.ok && existing.value !== null && existing.value.state === result.state) {
      return okResult(existing.value);
    }
    return failResult(
      outcome.error ?? internalFailure("config_write_recovery", "fnd.config_write_result_journal"),
      outcome.unknown ? "unknown" : "rejected"
    );
  }
  return okResult(result);
}

