/**
 * `evolve attach` / `evolve detach` (DD-FND-101, DD-FND-102, DD-HOST-001,
 * DD-HOST-200, DD-HOST-205).
 *
 * The kernel may not import adapter packages (DD-FND-021), so host resolution
 * is an injected, narrow port. This module owns the installation side of an
 * attach: it reads the host config, applies only the write mode that the
 * descriptor declares, backs the original file up before touching it, and
 * records `install_manifest` / `install_path` / `install_backup` rows.
 *
 * Four write modes are supported:
 *
 *   - `managed_block` edits one DD-FND-102 marker block and never rewrites
 *     bytes outside it;
 *   - `whole_file` writes a file the product owns end to end;
 *   - `artifact_dir` writes a runtime artifact directory (entry, runtime
 *     dependencies, generated `manifest.json` and `config.json`) and records
 *     one `install_path` row per file and directory;
 *   - `json_merge` edits only host JSON entries whose `command` references the
 *     artifact root, preserving every other key.
 *
 * Safety rules implemented here:
 *
 *   - a missing registry, a missing target or an unready project trust gate
 *     fails closed before any file or row is written;
 *   - a pre-existing file is replaced only when it is the product's own
 *     unchanged managed file; a `json_merge` file is never replaced, only
 *     merged, and its original bytes are backed up first;
 *   - artifact writes are read back and hashed; `written_hash` is only
 *     reported when every file matches, otherwise `E_ARTIFACT_MISMATCH`;
 *   - detach is driven by the `install_path` rows of the install id, not by
 *     the current registry: a row is removed only when its current hash still
 *     equals `installed_hash`, a user-modified file is kept and reported as
 *     `modified_by_user`, and empty product directories are removed. A
 *     `json_merge` file is not removed as a whole: detach removes only the
 *     entries whose value still matches the resolved plan, preserves unrelated
 *     user additions, and reports `E_INSTALL_CONFLICT` when a managed entry was
 *     edited or ownership cannot be decided;
 *   - every state transition is a CAS on the persisted row, never a blind
 *     overwrite.
 *
 * Persistence order (DD-FND-102 rules 3-6):
 *
 *   1. resolve + validate and simulate every target in memory;
 *   2. fsync every backup blob, then in one DB transaction write `blob`,
 *      `blob_ref`, `install_backup` and mark the manifest `installing`;
 *   3. write each host file atomically (temp + fsync + rename + dir fsync);
 *   4. in one DB transaction CAS `install_path` rows, persist
 *      `adapter_registration.config_hash`, and finish the manifest.
 *
 * The design defines no FND journal event for `install`, `attach` or `detach`;
 * `install_manifest` / `install_path` / `install_backup` are the durable
 * records, and the backup blob is fsynced before the host file changes.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";

import type {
  ErrorCategory,
  ErrorCode,
  ErrorDetails,
  ErrorEnvelope,
  ErrorSideEffect,
  Hash,
  Id,
  JsonValue,
  Result,
  SourceRef
} from "@evoplug/core";
import {
  canonicalHash,
  canonicalJsonText,
  compareUtf8,
  err,
  formatSourceRef,
  hashBytes,
  isHash,
  isHostId,
  isHostMode,
  makeErrorEnvelope,
  newId,
  ok,
  parseSourceRef,
  toJsonValue
} from "@evoplug/core";
import type {
  AdapterDescriptor,
  ConfigSpace,
  HostId,
  HostInstallApprovalPort,
  HostMode,
  RegistrationTarget
} from "@evoplug/core/host";
import {
  adapterDescriptorHash,
  computeRegistrationHash,
  descriptorToJson,
  installConsumeIdempotencyKey,
  validateAdapterDescriptor
} from "@evoplug/core/host";
import type { EvoplugConfig } from "./config.js";
import {
  canonicalConfigJson,
  computeConfigContentHash,
  computeConfigVersion
} from "./config.js";
import { readConfigFile } from "./home.js";
import {
  applyManagedBlockEdit,
  managedBlockHash,
  parseManagedBlocks,
  validateBlockSelector
} from "@evoplug/auth";
import type { ManagedBlockSpan } from "@evoplug/auth";
import type { SqliteConnection, SqlRow, Tx } from "@evoplug/storage";
import {
  createTransactionRunner,
  isErrorEnvelope
} from "@evoplug/storage";

/* ------------------------------------------------------------------ */
/* Public contracts                                                    */
/* ------------------------------------------------------------------ */

const CONFIG_SPACE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ATTACH_RESULT_SCHEMA = "rsi.host_attach_result/1" as const;
const DETACH_RESULT_SCHEMA = "rsi.host_detach_result/1" as const;
const HOST_RUNTIME_ARTIFACT_SCHEMA = "rsi.host_runtime_artifact/1" as const;
const HOST_RUNTIME_CONFIG_SCHEMA = "rsi.host_runtime_config/1" as const;
const RUNTIME_MANIFEST_FILE = "manifest.json";
const RUNTIME_CONFIG_FILE = "config.json";
const DEFAULT_MAX_PAYLOAD_BYTES = 8_388_608;
const DEFAULT_REDACT_FIELDS: readonly string[] = Object.freeze([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "token",
  "secret",
  "password",
  "credential"
]);

export type HostAttachWriteMode = "managed_block" | "whole_file" | "artifact_dir" | "json_merge";

export type HostAttachEntryKind =
  | "host_config_block"
  | "host_registration"
  | "file"
  | "directory";

/** One runtime artifact member below `root_path`. */
export interface HostAttachArtifactFile {
  /** Relative path below the artifact root. */
  readonly relative_path: string;
  readonly content: string;
  /** `384` = 0600, `420` = 0644. */
  readonly mode: 384 | 420;
}

/**
 * One entry inserted into a shared host JSON file.
 *
 * `pointer` is an RFC 6901 pointer to the array that owns the entry, and
 * `value` is the host-native object. Entries are product-owned when one of
 * their `command` strings contains the artifact root selector.
 */
export interface HostAttachJsonMergeEntry {
  readonly pointer: string;
  readonly value: JsonValue;
}

/** The registration target resolved to one concrete host path and payload. */
export interface HostAttachTargetPlan {
  readonly target: RegistrationTarget;
  /** Absolute host path. For `artifact_dir` this equals `root_path`. */
  readonly path: string;
  /** UTF-8 payload of the managed block, or the whole managed file. */
  readonly content?: string;
  readonly write_mode: HostAttachWriteMode;
  /** Absolute artifact root; required for `artifact_dir`. */
  readonly root_path?: string;
  /**
   * Absolute directory for generated `manifest.json` / `config.json`.
   *
   * Directory artifacts keep them at the root. Hosts that only accept a
   * single-file plugin (DD-HOST-204, OpenCode 1.18.32) put them in
   * `<plugin-name>.runtime/` so the host plugin directory is not polluted.
   */
  readonly runtime_meta_dir?: string;
  /** Runtime artifact members; required for `artifact_dir`. */
  readonly files?: readonly HostAttachArtifactFile[];
  /** Artifact root realpath that owns `json_merge` command entries. */
  readonly selector?: string;
  /** Entries added by `json_merge`. */
  readonly entries?: readonly HostAttachJsonMergeEntry[];
  /** True when the host requires a project/trust confirmation first. */
  readonly requires_trust: boolean;
  readonly trust_state: "ready" | "pending" | "unknown";
}

/** Result of resolving one `(host, mode, config_space, [target])` request. */
export interface HostAttachResolution {
  readonly descriptor: AdapterDescriptor;
  readonly targets: readonly HostAttachTargetPlan[];
}

/**
 * Injected adapter registry. The kernel never imports `adapters/*`; the
 * composition root supplies this port. `null` means the host/mode/config
 * space is not declared and the operation fails closed.
 */
export interface HostAdapterRegistryPort {
  resolve(
    request: HostAttachRequest
  ):
    | Result<HostAttachResolution | null, ErrorEnvelope>
    | Promise<Result<HostAttachResolution | null, ErrorEnvelope>>;
}

/** Narrow subset of `BlobStore` used for pre-write host config backups. */
export interface HostAttachBlobPort {
  putSync(bytes: Uint8Array): Result<
    { readonly hash: Hash; readonly byte_length: number; readonly relative_path: string },
    ErrorEnvelope
  >;
  verify(hash: Hash): Result<
    { readonly present: boolean; readonly hash_matches: boolean; readonly byte_length: number | null },
    ErrorEnvelope
  >;
  absolutePath(hash: Hash): string;
}

/**
 * Optional runtime-session port (DD-HOST-200.4/205). Detach revokes every
 * runtime session bound to the detached registration and closes its
 * connection. The port is injected so the kernel does not import the runtime
 * implementation.
 */
export interface HostBindingSessionPort {
  revokeBindingSessions(
    registration_hash: Hash
  ): Result<number, ErrorEnvelope> | Promise<Result<number, ErrorEnvelope>>;
}

/**
 * Install approval coordinates written on a newly applied registration.
 *
 * `evolve attach` consumes an existing FND approval when the composition root
 * supplies one. The local attach command has no attestation channel of its
 * own, so the host core derives a deterministic attach approval binding for
 * the registration it is about to write instead of accepting caller hashes.
 */
export interface HostAttachApproval {
  readonly approval_id: string;
  readonly approval_hash: Hash;
  readonly approval_subject_hash: Hash;
  readonly approval_consumption_ref?: string | null;
}

export interface HostAttachRequest {
  readonly host_id: HostId;
  readonly mode: HostMode;
  readonly config_space: ConfigSpace;
  /** Optional descriptor target filter; omitted means every target in the space. */
  readonly target_id?: string;
}

export interface HostAttachApprovalRequest {
  readonly approval_id: string;
  readonly approval_hash: Hash;
  readonly request_id?: string;
  readonly idempotency_key?: string;
}

export interface HostAttachDeps {
  /** Single kernel write connection (DD-FND-024). */
  readonly connection: SqliteConnection;
  /** Blob store rooted at `<home>/blobs`; backups are fsynced here. */
  readonly blobs: HostAttachBlobPort;
  /** Adapter registry. Absent fails closed with `E_AUTH_UNAVAILABLE`. */
  readonly registry?: HostAdapterRegistryPort;
  /** Optional runtime-session revocation used by detach. */
  readonly sessions?: HostBindingSessionPort;
  /** Install approval to bind on a new registration; derived when absent. */
  readonly approval?: HostAttachApproval;
  /**
   * Existing FND approval to verify and consume before writing (DD-HOST-205).
   * The port is required when this is set; attach never fabricates an
   * approval in that mode.
   */
  readonly approval_request?: HostAttachApprovalRequest;
  /** FND install-approval port used by `approval_request`. */
  readonly approvals?: HostInstallApprovalPort;
  readonly now?: () => number;
  /** Product home that owns the install manifest. */
  readonly home_root: string;
  readonly product_version: string;
  readonly schema_major: number;
  /** Defaults to `<home_root>/install`. */
  readonly install_root?: string;
  /** Reuse a known install id instead of allocating one. */
  readonly install_id?: string;
  /**
   * Optional W1 probe trigger. Supplied only when the probe feature is
   * enabled; attach then notifies the producer after the registration commits.
   * The callback can never change the attach outcome.
   */
  readonly probe?: HostAttachProbePort;
}

/** Post-commit notification that a registration is applied on this host. */
export interface HostAttachProbePort {
  onAttached(input: {
    readonly registration_hash: Hash;
    readonly artifact_hash: Hash;
    readonly host_id: HostId;
    readonly mode: HostMode;
    readonly config_space: ConfigSpace;
  }): void | Promise<void>;
}

export interface HostAttachConflict {
  readonly target_id: string;
  readonly path: string;
  readonly code: string;
}

export type HostAttachTargetState =
  | "present"
  | "no_change"
  | "removed"
  | "restored"
  | "missing"
  | "modified_by_user"
  | "failed";

export interface HostAttachTargetOutcome {
  readonly target_id: string;
  readonly path: string;
  readonly marker_id: string | null;
  readonly kind: "host_config_block" | "host_registration" | "runtime_artifact" | "json_merge";
  readonly state: HostAttachTargetState;
  readonly installed_hash: Hash | null;
  readonly error_code: string | null;
}

export interface HostAttachResult {
  readonly schema_version: typeof ATTACH_RESULT_SCHEMA;
  readonly status: "attached" | "no_op" | "partial";
  readonly host_id: HostId;
  readonly mode: HostMode;
  readonly config_space: ConfigSpace;
  readonly adapter_id: AdapterDescriptor["adapter_id"];
  readonly adapter_version: string;
  readonly descriptor_hash: Hash;
  readonly install_id: string;
  /**
   * `artifact_hash` after every artifact file was read back and re-hashed;
   * null when the target has no artifact or the readback failed.
   */
  readonly written_hash: Hash | null;
  /** JCS hash of the generated runtime manifest; null for non-artifact modes. */
  readonly artifact_hash: Hash | null;
  /** JCS hash of the generated `config.json`; null for non-artifact modes. */
  readonly config_hash: Hash | null;
  readonly targets: readonly HostAttachTargetOutcome[];
  readonly conflicts: readonly HostAttachConflict[];
}

export interface HostDetachResult {
  readonly schema_version: typeof DETACH_RESULT_SCHEMA;
  readonly status: "detached" | "no_op" | "partial";
  readonly host_id: HostId;
  readonly mode: HostMode;
  readonly config_space: ConfigSpace;
  /** Resolved from the registry or the registration row; null when neither exists. */
  readonly adapter_id: AdapterDescriptor["adapter_id"] | null;
  readonly adapter_version: string | null;
  readonly descriptor_hash: Hash | null;
  readonly install_id: string;
  readonly targets: readonly HostAttachTargetOutcome[];
  readonly conflicts: readonly HostAttachConflict[];
}

export type HostAttachOperation = (
  request: HostAttachRequest
) => Promise<Result<HostAttachResult, ErrorEnvelope>>;

export type HostDetachOperation = (
  request: HostAttachRequest
) => Promise<Result<HostDetachResult, ErrorEnvelope>>;

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

const ERROR_CATEGORY: Readonly<Record<string, ErrorCategory>> = {
  E_SCHEMA: "schema",
  E_UNSUPPORTED: "policy",
  E_TARGET_NOT_DECLARED: "policy",
  E_CONFIG_SPACE_NOT_DECLARED: "policy",
  E_ADAPTER_MISMATCH: "conflict",
  E_ARTIFACT_MISMATCH: "source",
  E_AUTH_UNAVAILABLE: "authorization",
  E_INSTALL_CONFLICT: "conflict",
  E_CONFLICT: "conflict",
  E_PATH_CHANGED: "conflict",
  E_BLOCK_SELECTOR: "schema",
  E_BLOCK_CONTENT: "schema",
  E_BLOCK_MALFORMED: "conflict",
  E_BLOCK_AMBIGUOUS: "conflict",
  E_BLOCK_STATE: "conflict",
  E_BLOCK_HASH_MISMATCH: "conflict",
  E_IO: "storage",
  E_INTERNAL: "internal"
};

function attachError(
  code: ErrorCode,
  stage: string,
  details: ErrorDetails,
  sideEffect: ErrorSideEffect = "none",
  retryable = false
): ErrorEnvelope {
  return makeErrorEnvelope({
    code,
    category: ERROR_CATEGORY[code] ?? "internal",
    message_key: `error.${code.toLowerCase()}`,
    stage,
    details,
    side_effect: sideEffect,
    retryable
  });
}

function fieldError(code: ErrorCode, path: string, rule: string): ErrorEnvelope {
  return attachError(code, "host_attach", { kind: "field", path, rule });
}

function internalError(incident: string, sideEffect: ErrorSideEffect = "none"): ErrorEnvelope {
  return attachError("E_INTERNAL", "host_attach", { kind: "internal", incident_id: incident }, sideEffect);
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === code
  );
}

function isAbsoluteHostPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && isAbsolute(path) && !path.includes("\u0000");
}

function encodeContent(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function decodeContent(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function hashText(content: string): Hash {
  return hashBytes(encodeContent(content));
}

function emptyBytes(): Uint8Array {
  return new Uint8Array(0);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Filesystem                                                          */
/* ------------------------------------------------------------------ */

interface HostFileState {
  readonly exists: boolean;
  readonly bytes: Uint8Array;
  /** Preserved permission bits, or 0600 for a new file. */
  readonly mode: number;
}

function readHostFile(path: string): Result<HostFileState | null, ErrorEnvelope> {
  if (!isAbsoluteHostPath(path)) {
    return err(fieldError("E_SCHEMA", "path", "absolute"));
  }
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return ok(null);
    }
    return err(attachError("E_IO", "host_attach_read", { kind: "field", path: "path", rule: "lstat_failed" }));
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    return err(fieldError("E_PATH_CHANGED", "path", "regular_single_link"));
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return err(attachError("E_IO", "host_attach_read", { kind: "field", path: "path", rule: "open_failed" }));
  }
  try {
    const bytes = new Uint8Array(readFileSync(fd));
    return ok({ exists: true, bytes, mode: stats.mode & 0o777 });
  } catch {
    return err(attachError("E_IO", "host_attach_read", { kind: "field", path: "path", rule: "read_failed" }));
  } finally {
    closeSync(fd);
  }
}

type HostPathKind = "missing" | "file" | "directory" | "other";

/** Classifies a path without following symlinks. */
function inspectHostPath(path: string): Result<HostPathKind, ErrorEnvelope> {
  if (!isAbsoluteHostPath(path)) {
    return err(fieldError("E_SCHEMA", "path", "absolute"));
  }
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return ok("missing");
    }
    return err(attachError("E_IO", "host_attach_read", { kind: "field", path: "path", rule: "lstat_failed" }));
  }
  if (stats.isSymbolicLink()) {
    return ok("other");
  }
  if (stats.isDirectory()) {
    return ok("directory");
  }
  if (stats.isFile()) {
    return ok(stats.nlink === 1 ? "file" : "other");
  }
  return ok("other");
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) {
      throw new Error("short write");
    }
    offset += written;
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Atomic host-file write. The original mode is preserved; the temporary file
 * is created with `O_EXCL|O_NOFOLLOW` in the same directory and only becomes
 * visible through `rename`.
 */
function writeHostFile(path: string, bytes: Uint8Array, mode: number): Result<void, ErrorEnvelope> {
  const directory = dirname(path);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch {
    return err(attachError("E_IO", "host_attach_write", { kind: "field", path: "path", rule: "directory_create_failed" }));
  }
  const temporary = join(directory, `.${randomUUID()}.rsi-attach.tmp`);
  let fd: number;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      mode
    );
  } catch {
    return err(attachError("E_IO", "host_attach_write", { kind: "field", path: "path", rule: "temp_create_failed" }));
  }
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } catch {
    try {
      closeSync(fd);
    } catch {
      // secondary failure
    }
    try {
      unlinkSync(temporary);
    } catch {
      // temp may not exist
    }
    return err(attachError("E_IO", "host_attach_write", { kind: "field", path: "path", rule: "temp_write_failed" }));
  }
  try {
    closeSync(fd);
    renameSync(temporary, path);
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // temp may already be gone
    }
    return err(attachError("E_IO", "host_attach_write", { kind: "field", path: "path", rule: "rename_failed" }));
  }
  try {
    syncDirectory(directory);
  } catch {
    // The rename is already durable; a directory fsync failure is reported as
    // partial so the caller can retry without losing the written content.
    return err(attachError("E_IO", "host_attach_write", { kind: "field", path: "path", rule: "dir_sync_failed" }, "partial"));
  }
  return ok(undefined);
}

function removeHostFile(path: string): Result<void, ErrorEnvelope> {
  const state = readHostFile(path);
  if (!state.ok) {
    return state;
  }
  if (state.value === null) {
    return ok(undefined);
  }
  try {
    unlinkSync(path);
    syncDirectory(dirname(path));
    return ok(undefined);
  } catch {
    return err(attachError("E_IO", "host_attach_remove", { kind: "field", path: "path", rule: "unlink_failed" }));
  }
}

type DirectoryRemoval = "removed" | "missing" | "not_empty" | "failed" | "not_directory";

/** Removes a product directory only when it is empty (DD-FND-102 rule 6). */
function removeEmptyDirectory(path: string): DirectoryRemoval {
  const inspected = inspectHostPath(path);
  if (!inspected.ok) {
    return "failed";
  }
  if (inspected.value === "missing") {
    return "missing";
  }
  if (inspected.value !== "directory") {
    return "not_directory";
  }
  try {
    const entries = readdirSync(path);
    if (entries.length > 0) {
      return "not_empty";
    }
    rmdirSync(path);
    syncDirectory(dirname(path));
    return "removed";
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return "missing";
    }
    if (isErrno(error, "ENOTEMPTY") || isErrno(error, "EEXIST")) {
      return "not_empty";
    }
    return "failed";
  }
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

interface ResolvedTargets {
  readonly descriptor: AdapterDescriptor;
  readonly descriptor_hash: Hash;
  readonly targets: readonly HostAttachTargetPlan[];
}

function validateDeps(deps: HostAttachDeps): ErrorEnvelope | null {
  if (
    typeof deps.home_root !== "string" ||
    !isAbsolute(deps.home_root) ||
    deps.home_root.includes("\u0000")
  ) {
    return fieldError("E_SCHEMA", "home_root", "absolute");
  }
  if (typeof deps.product_version !== "string" || deps.product_version.length === 0) {
    return fieldError("E_SCHEMA", "product_version", "non_empty_string");
  }
  if (!Number.isSafeInteger(deps.schema_major) || deps.schema_major < 1) {
    return fieldError("E_SCHEMA", "schema_major", "safe_positive_integer");
  }
  if (deps.install_root !== undefined && !isAbsoluteHostPath(deps.install_root)) {
    return fieldError("E_SCHEMA", "install_root", "absolute");
  }
  return null;
}

function validateRequest(request: HostAttachRequest): Result<HostAttachRequest, ErrorEnvelope> {
  if (!isHostId(request.host_id)) {
    return err(fieldError("E_SCHEMA", "host_id", "host_id"));
  }
  if (!isHostMode(request.mode)) {
    return err(fieldError("E_SCHEMA", "mode", "host_mode"));
  }
  if (typeof request.config_space !== "string" || !CONFIG_SPACE_PATTERN.test(request.config_space)) {
    return err(fieldError("E_SCHEMA", "config_space", "config_space_token"));
  }
  if (request.target_id !== undefined && (typeof request.target_id !== "string" || request.target_id.length === 0)) {
    return err(fieldError("E_SCHEMA", "target_id", "non_empty_string"));
  }
  return ok(request);
}

const RELATIVE_PATH_SEGMENT = /^(?:[^/\\\u0000]+)$/;

function validateArtifactFile(file: HostAttachArtifactFile): ErrorEnvelope | null {
  const relative = file.relative_path;
  if (typeof relative !== "string" || relative.length === 0 || relative.length > 1024) {
    return fieldError("E_SCHEMA", "files.relative_path", "1..1024");
  }
  if (relative.includes("\\") || relative.includes("\u0000") || isAbsolute(relative)) {
    return fieldError("E_SCHEMA", "files.relative_path", "relative");
  }
  if (relative.normalize("NFC") !== relative) {
    return fieldError("E_SCHEMA", "files.relative_path", "nfc");
  }
  for (const segment of relative.split("/")) {
    if (!RELATIVE_PATH_SEGMENT.test(segment) || segment === "." || segment === "..") {
      return fieldError("E_SCHEMA", "files.relative_path", "no_dot_segments");
    }
  }
  if (relative === RUNTIME_MANIFEST_FILE || relative === RUNTIME_CONFIG_FILE) {
    return fieldError("E_SCHEMA", "files.relative_path", "reserved_artifact_file");
  }
  if (typeof file.content !== "string") {
    return fieldError("E_SCHEMA", "files.content", "string");
  }
  if (file.mode !== 384 && file.mode !== 420) {
    return fieldError("E_SCHEMA", "files.mode", "0600_or_0644");
  }
  return null;
}

function validateArtifactFiles(files: readonly HostAttachArtifactFile[]): ErrorEnvelope | null {
  if (!Array.isArray(files) || files.length === 0) {
    return fieldError("E_SCHEMA", "files", "non_empty");
  }
  const seen = new Set<string>();
  for (const file of files) {
    const invalid = validateArtifactFile(file);
    if (invalid !== null) {
      return invalid;
    }
    const key = file.relative_path.normalize("NFC").toLowerCase();
    if (seen.has(key)) {
      return fieldError("E_SCHEMA", "files.relative_path", "duplicate_path");
    }
    seen.add(key);
  }
  return null;
}

function isValidJsonPointer(pointer: string): boolean {
  if (typeof pointer !== "string" || pointer.length === 0 || pointer[0] !== "/") {
    return false;
  }
  return pointer.split("/").every((token) => !/~(?:[^01]|$)/.test(token));
}

function containsCommandReference(value: JsonValue, selector: string): boolean {
  if (Array.isArray(value)) {
    return value.some((element) => containsCommandReference(element, selector));
  }
  if (isJsonObject(value)) {
    const command = value["command"];
    if (typeof command === "string" && command.includes(selector)) {
      return true;
    }
    return Object.values(value).some((child) => containsCommandReference(child, selector));
  }
  return false;
}

function validateJsonEntries(
  entries: readonly HostAttachJsonMergeEntry[],
  selector: string
): ErrorEnvelope | null {
  if (!Array.isArray(entries) || entries.length === 0) {
    return fieldError("E_SCHEMA", "entries", "non_empty");
  }
  for (const entry of entries) {
    if (!isValidJsonPointer(entry.pointer)) {
      return fieldError("E_SCHEMA", "entries.pointer", "rfc6901");
    }
    if (!isJsonObject(entry.value)) {
      return fieldError("E_SCHEMA", "entries.value", "object");
    }
    if (!containsCommandReference(entry.value, selector)) {
      return fieldError("E_SCHEMA", "entries.command", "artifact_root_reference");
    }
  }
  return null;
}

function validatePlan(plan: HostAttachTargetPlan): Result<HostAttachTargetPlan, ErrorEnvelope> {
  if (typeof plan.path !== "string" || !isAbsoluteHostPath(plan.path)) {
    return err(fieldError("E_SCHEMA", "path", "absolute"));
  }
  if (typeof plan.requires_trust !== "boolean") {
    return err(fieldError("E_SCHEMA", "requires_trust", "boolean"));
  }
  if (plan.trust_state !== "ready" && plan.trust_state !== "pending" && plan.trust_state !== "unknown") {
    return err(fieldError("E_SCHEMA", "trust_state", "ready_pending_unknown"));
  }
  switch (plan.write_mode) {
    case "managed_block": {
      if (typeof plan.content !== "string") {
        return err(fieldError("E_SCHEMA", "content", "string"));
      }
      if (plan.target.marker_id === null) {
        return err(fieldError("E_SCHEMA", "write_mode", "managed_block_requires_marker"));
      }
      const selector = validateBlockSelector(plan.target.marker_id);
      if (!selector.ok) {
        return selector;
      }
      return ok(plan);
    }
    case "whole_file": {
      if (typeof plan.content !== "string") {
        return err(fieldError("E_SCHEMA", "content", "string"));
      }
      if (plan.target.marker_id !== null) {
        return err(fieldError("E_SCHEMA", "write_mode", "whole_file_requires_null_marker"));
      }
      return ok(plan);
    }
    case "artifact_dir": {
      if (plan.target.marker_id !== null) {
        return err(fieldError("E_SCHEMA", "write_mode", "artifact_dir_requires_null_marker"));
      }
      if (
        plan.target.kind !== "extension" &&
        plan.target.kind !== "plugin" &&
        plan.target.kind !== "sdk_package"
      ) {
        return err(fieldError("E_SCHEMA", "write_mode", "artifact_dir_kind"));
      }
      if (typeof plan.root_path !== "string" || !isAbsoluteHostPath(plan.root_path)) {
        return err(fieldError("E_SCHEMA", "root_path", "absolute"));
      }
      if (plan.root_path !== plan.path) {
        return err(fieldError("E_SCHEMA", "root_path", "equals_path"));
      }
      if (plan.runtime_meta_dir !== undefined) {
        if (!isAbsoluteHostPath(plan.runtime_meta_dir)) {
          return err(fieldError("E_SCHEMA", "runtime_meta_dir", "absolute"));
        }
        if (
          plan.runtime_meta_dir !== plan.root_path &&
          !plan.runtime_meta_dir.startsWith(`${plan.root_path}/`)
        ) {
          return err(fieldError("E_SCHEMA", "runtime_meta_dir", "inside_root"));
        }
      }
      if (plan.files === undefined) {
        return err(fieldError("E_SCHEMA", "files", "artifact_dir_required"));
      }
      const invalidFiles = validateArtifactFiles(plan.files);
      if (invalidFiles !== null) {
        return err(invalidFiles);
      }
      return ok(plan);
    }
    case "json_merge": {
      if (plan.target.marker_id !== null) {
        return err(fieldError("E_SCHEMA", "write_mode", "json_merge_requires_null_marker"));
      }
      if (plan.target.kind !== "hook_config") {
        return err(fieldError("E_SCHEMA", "write_mode", "json_merge_kind"));
      }
      if (typeof plan.selector !== "string" || !isAbsoluteHostPath(plan.selector)) {
        return err(fieldError("E_SCHEMA", "selector", "absolute"));
      }
      if (plan.entries === undefined) {
        return err(fieldError("E_SCHEMA", "entries", "json_merge_required"));
      }
      const invalidEntries = validateJsonEntries(plan.entries, plan.selector);
      if (invalidEntries !== null) {
        return err(invalidEntries);
      }
      return ok(plan);
    }
    default:
      return err(fieldError("E_SCHEMA", "write_mode", "managed_block_whole_file_artifact_dir_json_merge"));
  }
}

async function resolveTargets(
  deps: HostAttachDeps,
  request: HostAttachRequest
): Promise<Result<ResolvedTargets, ErrorEnvelope>> {
  const validRequest = validateRequest(request);
  if (!validRequest.ok) {
    return validRequest;
  }
  const registry = deps.registry;
  if (registry === undefined) {
    return err(attachError("E_AUTH_UNAVAILABLE", "host_attach_registry", { kind: "none" }));
  }
  let resolved: Result<HostAttachResolution | null, ErrorEnvelope>;
  try {
    const outcome = registry.resolve(request);
    resolved = isPromiseLike(outcome) ? await outcome : outcome;
  } catch {
    return err(attachError("E_AUTH_UNAVAILABLE", "host_attach_registry", { kind: "none" }, "none", true));
  }
  if (!resolved.ok) {
    return resolved;
  }
  if (resolved.value === null) {
    return err(
      attachError("E_UNSUPPORTED", "host_attach_registry", {
        kind: "field",
        path: "host",
        rule: `${request.host_id}/${request.mode}/${request.config_space}`
      })
    );
  }
  if (!Array.isArray(resolved.value.targets)) {
    return err(fieldError("E_SCHEMA", "targets", "array"));
  }
  const validated = validateAdapterDescriptor(resolved.value.descriptor);
  if (!validated.ok) {
    return validated;
  }
  const descriptor = validated.value;
  if (descriptor.host_id !== request.host_id) {
    return err(fieldError("E_ADAPTER_MISMATCH", "host_id", "descriptor_host"));
  }
  if (!descriptor.supported_modes.includes(request.mode)) {
    return err(fieldError("E_ADAPTER_MISMATCH", "mode", "descriptor_mode"));
  }
  if (!descriptor.config_spaces.includes(request.config_space)) {
    return err(fieldError("E_CONFIG_SPACE_NOT_DECLARED", "config_space", "descriptor_config_space"));
  }
  const declaredById = new Map<string, RegistrationTarget>();
  for (const target of descriptor.registration_targets) {
    declaredById.set(target.target_id, target);
  }
  const targets: HostAttachTargetPlan[] = [];
  const paths = new Set<string>();
  for (const plan of resolved.value.targets) {
    if (plan === null || typeof plan !== "object") {
      return err(fieldError("E_SCHEMA", "targets", "target_plan_shape"));
    }
    const rawTarget: unknown = plan.target;
    if (!isRecord(rawTarget) || typeof rawTarget["target_id"] !== "string") {
      return err(fieldError("E_SCHEMA", "targets", "target_plan_shape"));
    }
    const declared = declaredById.get(rawTarget["target_id"]);
    if (declared === undefined) {
      return err(fieldError("E_TARGET_NOT_DECLARED", "target_id", "descriptor_target"));
    }
    if (declared.config_space !== request.config_space) {
      return err(fieldError("E_CONFIG_SPACE_NOT_DECLARED", "config_space", "target_config_space"));
    }
    if (request.target_id !== undefined && declared.target_id !== request.target_id) {
      continue;
    }
    const canonical: HostAttachTargetPlan = {
      target: declared,
      path: plan.path,
      write_mode: plan.write_mode,
      requires_trust: plan.requires_trust,
      trust_state: plan.trust_state,
      ...(plan.content !== undefined ? { content: plan.content } : {}),
      ...(plan.root_path !== undefined ? { root_path: plan.root_path } : {}),
      ...(plan.runtime_meta_dir !== undefined ? { runtime_meta_dir: plan.runtime_meta_dir } : {}),
      ...(plan.files !== undefined ? { files: plan.files } : {}),
      ...(plan.selector !== undefined ? { selector: plan.selector } : {}),
      ...(plan.entries !== undefined ? { entries: plan.entries } : {})
    };
    const validatedPlan = validatePlan(canonical);
    if (!validatedPlan.ok) {
      return validatedPlan;
    }
    if (paths.has(canonical.path)) {
      return err(fieldError("E_CONFLICT", "path", "duplicate_registration_path"));
    }
    paths.add(canonical.path);
    targets.push(canonical);
  }
  if (request.target_id !== undefined && targets.length === 0) {
    return err(fieldError("E_TARGET_NOT_DECLARED", "target_id", "declared_target"));
  }
  if (targets.length === 0) {
    return err(fieldError("E_TARGET_NOT_DECLARED", "registration_targets", "non_empty"));
  }
  targets.sort((left, right) => (left.target.target_id < right.target.target_id ? -1 : 1));
  return ok({
    descriptor,
    descriptor_hash: adapterDescriptorHash(descriptor),
    targets
  });
}

/* ------------------------------------------------------------------ */
/* Database rows                                                       */
/* ------------------------------------------------------------------ */

interface InstallManifestRow extends SqlRow {
  readonly install_id: string;
  readonly product_version: string;
  readonly schema_major: number;
  readonly install_root: string;
  readonly home_root: string;
  readonly status: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface InstallPathRow extends SqlRow {
  readonly install_id: string;
  readonly path: string;
  readonly kind: string;
  readonly ownership: string;
  readonly marker_id: string | null;
  readonly installed_hash: string | null;
  readonly origin_hash: string | null;
  readonly state: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface InstallBackupRow extends SqlRow {
  readonly backup_id: string;
  readonly install_id: string;
  readonly path: string;
  readonly content_ref: string;
  readonly content_hash: string;
  readonly state: string;
  readonly tombstoned_at: number | null;
  readonly created_at: number;
}

function readManifest(connection: SqliteConnection, homeRoot: string): InstallManifestRow | null {
  const row = connection
    .prepare<InstallManifestRow>(
      `SELECT install_id, product_version, schema_major, install_root, home_root,
              status, created_at, updated_at
         FROM install_manifest
        WHERE home_root = :home_root
        ORDER BY created_at ASC
        LIMIT 1`
    )
    .get({ home_root: homeRoot });
  return row ?? null;
}

function readInstallPaths(
  connection: SqliteConnection,
  installId: string
): Map<string, InstallPathRow> {
  const rows = connection
    .prepare<InstallPathRow>(
      `SELECT install_id, path, kind, ownership, marker_id, installed_hash,
              origin_hash, state, created_at, updated_at
         FROM install_path
        WHERE install_id = :install_id`
    )
    .all({ install_id: installId });
  const byPath = new Map<string, InstallPathRow>();
  for (const row of rows) {
    byPath.set(row.path, row);
  }
  return byPath;
}

function readActiveBackup(
  connection: SqliteConnection,
  installId: string,
  path: string
): InstallBackupRow | null {
  const row = connection
    .prepare<InstallBackupRow>(
      `SELECT backup_id, install_id, path, content_ref, content_hash, state,
              tombstoned_at, created_at
         FROM install_backup
        WHERE install_id = :install_id AND path = :path AND state = 'active'
        ORDER BY created_at ASC
        LIMIT 1`
    )
    .get({ install_id: installId, path });
  return row ?? null;
}

function ensureManifest(
  deps: HostAttachDeps,
  now: number
): Result<InstallManifestRow, ErrorEnvelope> {
  const existing = readManifest(deps.connection, deps.home_root);
  if (existing !== null) {
    if (existing.status === "uninstalled") {
      return err(fieldError("E_CONFLICT", "install_manifest.status", "uninstalled"));
    }
    return ok(existing);
  }
  const installId = deps.install_id ?? newId("ev", now);
  const installRoot = deps.install_root ?? join(deps.home_root, "install");
  const runner = createTransactionRunner(deps.connection);
  try {
    const row = runner.withTxSync<InstallManifestRow>((tx) => {
      const current = tx
        .prepare<InstallManifestRow>(
          `SELECT install_id, product_version, schema_major, install_root, home_root,
                  status, created_at, updated_at
             FROM install_manifest
            WHERE home_root = :home_root
            ORDER BY created_at ASC
            LIMIT 1`
        )
        .get({ home_root: deps.home_root });
      if (current !== undefined) {
        if (current.status === "uninstalled") {
          throw fieldError("E_CONFLICT", "install_manifest.status", "uninstalled");
        }
        return current;
      }
      tx.prepare(
        `INSERT INTO install_manifest
           (install_id, product_version, schema_major, install_root, home_root,
            status, created_at, updated_at)
         VALUES
           (:install_id, :product_version, :schema_major, :install_root, :home_root,
            'installed', :now, :now)`
      ).run({
        install_id: installId,
        product_version: deps.product_version,
        schema_major: deps.schema_major,
        install_root: installRoot,
        home_root: deps.home_root,
        now
      });
      const inserted = tx
        .prepare<InstallManifestRow>(
          `SELECT install_id, product_version, schema_major, install_root, home_root,
                  status, created_at, updated_at
             FROM install_manifest
            WHERE install_id = :install_id`
        )
        .get({ install_id: installId });
      if (inserted === undefined) {
        throw internalError("kernel.host_attach_manifest_readback");
      }
      return inserted;
    });
    return ok(row);
  } catch (error) {
    if (isErrorEnvelope(error)) {
      return { ok: false, status: "rejected", error };
    }
    return err(internalError("kernel.host_attach_manifest"));
  }
}

function setManifestStatus(
  tx: Tx,
  installId: string,
  expected: string,
  next: string,
  now: number
): void {
  if (expected === next) {
    return;
  }
  const result = tx
    .prepare(
      `UPDATE install_manifest
          SET status = :next, updated_at = :now
        WHERE install_id = :install_id AND status = :expected`
    )
    .run({ next, now, install_id: installId, expected });
  if (result.changes !== 1) {
    throw attachError("E_CONFLICT", "host_attach_manifest", {
      kind: "field",
      path: "install_manifest.status",
      rule: "cas_mismatch"
    });
  }
}

function touchManifest(tx: Tx, installId: string, now: number): void {
  tx.prepare("UPDATE install_manifest SET updated_at = :now WHERE install_id = :install_id").run({
    now,
    install_id: installId
  });
}

function casInstallPath(
  tx: Tx,
  input: {
    readonly install_id: string;
    readonly path: string;
    readonly kind: HostAttachEntryKind;
    readonly marker_id: string | null;
    readonly installed_hash: Hash | null;
    readonly origin_hash: Hash | null;
    readonly now: number;
    readonly expected: InstallPathRow | null;
  }
): void {
  if (input.expected === null) {
    tx.prepare(
      `INSERT INTO install_path
         (install_id, path, kind, ownership, marker_id, installed_hash, origin_hash,
          state, created_at, updated_at)
       VALUES
         (:install_id, :path, :kind, 'managed', :marker_id, :installed_hash, :origin_hash,
          'present', :now, :now)`
    ).run({
      install_id: input.install_id,
      path: input.path,
      kind: input.kind,
      marker_id: input.marker_id,
      installed_hash: input.installed_hash,
      origin_hash: input.origin_hash,
      now: input.now
    });
    return;
  }
  const result = tx
    .prepare(
      `UPDATE install_path
          SET kind = :kind,
              ownership = 'managed',
              marker_id = :marker_id,
              installed_hash = :installed_hash,
              origin_hash = :origin_hash,
              state = 'present',
              updated_at = :now
        WHERE install_id = :install_id
          AND path = :path
          AND state = :expected_state
          AND installed_hash IS :expected_hash`
    )
    .run({
      kind: input.kind,
      marker_id: input.marker_id,
      installed_hash: input.installed_hash,
      origin_hash: input.origin_hash,
      now: input.now,
      install_id: input.install_id,
      path: input.path,
      expected_state: input.expected.state,
      expected_hash: input.expected.installed_hash
    });
  if (result.changes !== 1) {
    throw attachError("E_CONFLICT", "host_attach_install_path", {
      kind: "field",
      path: "install_path",
      rule: "cas_mismatch"
    });
  }
}

function updateDetachedPath(
  tx: Tx,
  input: {
    readonly row: InstallPathRow;
    readonly state: "removed" | "restored" | "missing" | "modified_by_user";
    readonly now: number;
  }
): void {
  const result = tx
    .prepare(
      `UPDATE install_path
          SET state = :state, updated_at = :now
        WHERE install_id = :install_id
          AND path = :path
          AND state = :expected_state
          AND installed_hash IS :expected_hash`
    )
    .run({
      state: input.state,
      now: input.now,
      install_id: input.row.install_id,
      path: input.row.path,
      expected_state: input.row.state,
      expected_hash: input.row.installed_hash
    });
  if (result.changes !== 1) {
    throw attachError("E_CONFLICT", "host_detach_install_path", {
      kind: "field",
      path: "install_path",
      rule: "cas_mismatch"
    });
  }
}

function tombstoneBackup(tx: Tx, backupId: string, now: number): void {
  tx.prepare(
    `UPDATE install_backup
        SET state = 'tombstoned', tombstoned_at = :now
      WHERE backup_id = :backup_id AND state = 'active'`
  ).run({ now, backup_id: backupId });
}

interface AppliedRegistrationRow extends SqlRow {
  readonly registration_hash: string;
  readonly adapter_id: string;
  readonly host_id: string;
  readonly mode: string;
  readonly config_space: string;
  readonly adapter_version: string;
  readonly implementation_hash: string;
  readonly descriptor_hash: string;
  readonly target_id: string;
  readonly artifact_hash: string;
  readonly expected_previous_hash: string | null;
  readonly written_hash: string | null;
  readonly config_hash: string | null;
}

interface PreviousRegistrationRow extends SqlRow {
  readonly registration_hash: string;
  readonly state: string;
}

function readAppliedRegistrations(
  connection: SqliteConnection,
  request: HostAttachRequest
): AppliedRegistrationRow[] {
  try {
    return connection
      .prepare<AppliedRegistrationRow>(
        `SELECT registration_hash, adapter_id, host_id, mode, config_space,
                adapter_version, implementation_hash, descriptor_hash, target_id,
                artifact_hash, expected_previous_hash, written_hash, config_hash
           FROM adapter_registration
          WHERE host_id = :host_id
            AND mode = :mode
            AND config_space = :config_space
            AND state = 'applied'
          ORDER BY created_at ASC
          LIMIT 2`
      )
      .all({
        host_id: request.host_id,
        mode: request.mode,
        config_space: request.config_space
      });
  } catch {
    // A database without the HOST registration table has no registration row
    // to transition; file cleanup is still driven by install_path.
    return [];
  }
}

/** Latest finished registration for a binding, used to chain a re-attach. */
function readPreviousRegistration(
  connection: SqliteConnection,
  request: HostAttachRequest
): PreviousRegistrationRow | null {
  try {
    const row = connection
      .prepare<PreviousRegistrationRow>(
        `SELECT registration_hash, state
           FROM adapter_registration
          WHERE host_id = :host_id
            AND mode = :mode
            AND config_space = :config_space
            AND state IN ('detached','failed','superseded')
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1`
      )
      .get({
        host_id: request.host_id,
        mode: request.mode,
        config_space: request.config_space
      });
    return row === undefined ? null : row;
  } catch {
    return null;
  }
}

function readInflightRegistration(
  connection: SqliteConnection,
  request: HostAttachRequest
): PreviousRegistrationRow | null {
  try {
    const row = connection
      .prepare<PreviousRegistrationRow>(
        `SELECT registration_hash, state
           FROM adapter_registration
          WHERE host_id = :host_id
            AND mode = :mode
            AND config_space = :config_space
            AND state IN ('intent','applying','unknown')
          LIMIT 1`
      )
      .get({
        host_id: request.host_id,
        mode: request.mode,
        config_space: request.config_space
      });
    return row === undefined ? null : row;
  } catch {
    return null;
  }
}

/** True when every hash-bearing field recomputes to the stored primary key. */
function isSelfConsistentRegistration(row: AppliedRegistrationRow): boolean {
  if (
    !isHash(row.registration_hash) ||
    !isHash(row.implementation_hash) ||
    !isHash(row.descriptor_hash) ||
    !isHash(row.artifact_hash) ||
    (row.expected_previous_hash !== null && !isHash(row.expected_previous_hash))
  ) {
    return false;
  }
  const recomputed = computeRegistrationHash({
    host_id: row.host_id,
    mode: row.mode,
    config_space: row.config_space,
    adapter_id: row.adapter_id,
    adapter_version: row.adapter_version,
    implementation_hash: row.implementation_hash as Hash,
    descriptor_hash: row.descriptor_hash as Hash,
    target_id: row.target_id,
    artifact_hash: row.artifact_hash as Hash,
    expected_previous_hash: row.expected_previous_hash as Hash | null
  });
  return recomputed === row.registration_hash;
}


/**
 * Persists the attach-time runtime config baseline on the active registration
 * (DD-HOST-200.3/205). Attach never creates or transitions a registration row.
 */
function persistConfigHash(
  tx: Tx,
  request: HostAttachRequest,
  configHash: Hash,
  writtenHash: Hash,
  registrationHash: Hash | null,
  now: number
): void {
  const scoped = registrationHash === null
    ? ""
    : " AND registration_hash = :registration_hash";
  tx.prepare(
    `UPDATE adapter_registration
        SET config_hash = :config_hash, written_hash = :written_hash, updated_at = :now
      WHERE host_id = :host_id
        AND mode = :mode
        AND config_space = :config_space
        AND state = 'applied'${scoped}`
  ).run({
    config_hash: configHash,
    written_hash: writtenHash,
    now,
    host_id: request.host_id,
    mode: request.mode,
    config_space: request.config_space,
    ...(registrationHash === null ? {} : { registration_hash: registrationHash })
  });
}

interface RegistrationStateRow extends SqlRow {
  readonly registration_hash: string;
  readonly state: string;
}

function readRegistrationState(tx: Tx, registrationHash: Hash): string | null {
  const row = tx
    .prepare<RegistrationStateRow>(
      "SELECT registration_hash, state FROM adapter_registration WHERE registration_hash = :registration_hash"
    )
    .get({ registration_hash: registrationHash });
  return row === undefined || row === null ? null : row.state;
}

function readAppliedRegistrationCount(tx: Tx, request: HostAttachRequest): number {
  const row = tx
    .prepare<SqlRow>(
      `SELECT COUNT(*) AS total
         FROM adapter_registration
        WHERE host_id = :host_id AND mode = :mode AND config_space = :config_space
          AND state = 'applied'`
    )
    .get({
      host_id: request.host_id,
      mode: request.mode,
      config_space: request.config_space
    });
  return row === undefined ? 0 : Number(row["total"]);
}

function attachApprovalSubject(input: {
  readonly descriptor: AdapterDescriptor;
  readonly request: HostAttachRequest;
  readonly target_id: string;
  readonly artifact_hash: Hash;
  readonly expected_previous_hash: Hash | null;
}): { readonly subject: JsonValue; readonly subject_hash: Hash } {
  const subject = toJsonValue({
    schema_version: "rsi.adapter_install_subject/1",
    purpose: "adapter_install",
    host_id: input.request.host_id,
    mode: input.request.mode,
    config_space: input.request.config_space,
    adapter_id: input.descriptor.adapter_id,
    adapter_version: input.descriptor.adapter_version,
    implementation_hash: input.descriptor.implementation_hash,
    target_id: input.target_id,
    artifact_hash: input.artifact_hash,
    expected_previous_hash: input.expected_previous_hash
  });
  return { subject, subject_hash: canonicalHash(subject) };
}

function deriveAttachApproval(input: {
  readonly descriptor: AdapterDescriptor;
  readonly request: HostAttachRequest;
  readonly target_id: string;
  readonly artifact_hash: Hash;
  readonly expected_previous_hash: Hash | null;
  readonly now: number;
}): HostAttachApproval {
  const { subject, subject_hash: subjectHash } = attachApprovalSubject(input);
  const issuedAt = input.now;
  const expiresAt = issuedAt + 600_000;
  const approvalHash = canonicalHash(
    toJsonValue({
      schema_version: "rsi.adapter_install_approval_hash/1",
      subject,
      subject_hash: subjectHash,
      issued_at: issuedAt,
      expires_at: expiresAt
    })
  );
  return {
    approval_id: newId("iap", input.now),
    approval_hash: approvalHash,
    approval_subject_hash: subjectHash,
    approval_consumption_ref: null
  };
}

/**
 * Verifies and consumes a real FND approval before any host file is touched.
 *
 * The local CLI uses the same FND row readers and journal committer as
 * `install.approval.get` / `install.approval.consume`, so an attach cannot
 * accept an approval that the IPC surface would reject.
 */
async function consumeAttachApproval(input: {
  readonly deps: HostAttachDeps;
  readonly descriptor: AdapterDescriptor;
  readonly request: HostAttachRequest;
  readonly target_id: string;
  readonly artifact_hash: Hash;
  readonly expected_previous_hash: Hash | null;
  readonly registration_hash: Hash;
  readonly now: number;
}): Promise<Result<HostAttachApproval, ErrorEnvelope>> {
  const request = input.deps.approval_request;
  if (request === undefined) {
    return err(internalError("kernel.host_attach_approval_request"));
  }
  const approvals = input.deps.approvals;
  if (approvals === undefined) {
    return err(
      attachError("E_AUTH_UNAVAILABLE", "host_attach_approval", {
        kind: "field",
        path: "approvals",
        rule: "port_required"
      })
    );
  }
  const { subject_hash: subjectHash } = attachApprovalSubject({
    descriptor: input.descriptor,
    request: input.request,
    target_id: input.target_id,
    artifact_hash: input.artifact_hash,
    expected_previous_hash: input.expected_previous_hash
  });
  let view;
  try {
    const read = await approvals.get({
      approval_id: request.approval_id as Id<"iap">,
      expected_subject_hash: subjectHash
    });
    if (!read.ok) {
      return read;
    }
    view = read.value;
  } catch {
    return err(
      attachError("E_AUTH_UNAVAILABLE", "host_attach_approval", {
        kind: "field",
        path: "approvals.get",
        rule: "unavailable"
      }, "none", true)
    );
  }
  if (
    view.state !== "active" ||
    view.approval_hash !== request.approval_hash ||
    view.subject_hash !== subjectHash
  ) {
    return err(
      attachError("E_AUTH_UNAVAILABLE", "host_attach_approval", {
        kind: "field",
        path: "approval",
        rule: view.state === "active" ? "hash_or_subject" : view.state
      })
    );
  }
  if (view.expires_at <= input.now) {
    return err(
      attachError("E_AUTH_UNAVAILABLE", "host_attach_approval", {
        kind: "field",
        path: "approval.expires_at",
        rule: "expired"
      })
    );
  }
  if (
    view.bootstrap_state !== "preinstall_ready" &&
    view.bootstrap_state !== "postinstall_ready"
  ) {
    return err(
      attachError("E_AUTH_UNAVAILABLE", "host_attach_approval", {
        kind: "field",
        path: "approval.bootstrap_state",
        rule: view.bootstrap_state
      })
    );
  }
  const idempotencyKey =
    request.idempotency_key ??
    installConsumeIdempotencyKey(request.approval_id, input.registration_hash);
  try {
    const consumed = await approvals.consume({
      approval_id: request.approval_id as Id<"iap">,
      expected_approval_hash: request.approval_hash,
      registration_hash: input.registration_hash,
      request_id: request.request_id ?? newId("ipc", input.now),
      idempotency_key: idempotencyKey
    });
    if (!consumed.ok) {
      return consumed;
    }
    return ok({
      approval_id: consumed.value.approval.approval_id,
      approval_hash: consumed.value.approval.approval_hash,
      approval_subject_hash: consumed.value.approval.subject_hash,
      approval_consumption_ref: consumed.value.consumption_ref
    });
  } catch {
    return err(
      attachError("E_AUTH_UNAVAILABLE", "host_attach_approval", {
        kind: "field",
        path: "approvals.consume",
        rule: "unavailable"
      }, "none", true)
    );
  }
}

function artifactRefFor(artifactHash: Hash): string {
  return `blob://${artifactHash}#bytes=0-1`;
}

/**
 * Host-core registration write (DD-HOST-001, DD-HOST-200.2). The descriptor is
 * the one just validated by the registry preflight; its JCS bytes are frozen
 * in `adapter_descriptor_snapshot` in the same transaction that makes the
 * registration visible, so `host.runtime.ready` never reads a live
 * `describe()` result.
 */
function persistRegistration(
  tx: Tx,
  input: {
    readonly descriptor: AdapterDescriptor;
    readonly request: HostAttachRequest;
    readonly target_id: string;
    readonly registration_hash: Hash;
    readonly registration_action: "reuse" | "insert" | "upgrade";
    readonly expected_previous_hash: Hash | null;
    readonly artifact_hash: Hash;
    readonly written_hash: Hash;
    readonly config_hash: Hash;
    readonly approval: HostAttachApproval;
    readonly now: number;
  }
): void {
  const descriptorHash = adapterDescriptorHash(input.descriptor);
  const existingState = readRegistrationState(tx, input.registration_hash);
  if (input.registration_action === "reuse") {
    if (existingState === null) {
      throw attachError("E_CONFLICT", "host_attach_registration", {
        kind: "field",
        path: "registration",
        rule: "missing"
      });
    }
    const changed = tx.prepare(
      `UPDATE adapter_registration SET
         artifact_hash = :artifact_hash,
         written_hash = :written_hash,
         config_hash = :config_hash,
         state = 'applied',
         failure_code = NULL,
         applied_at = :now,
         updated_at = :now,
         row_version = row_version + 1
       WHERE registration_hash = :registration_hash AND state = :state`
    ).run({
      artifact_hash: input.artifact_hash,
      written_hash: input.written_hash,
      config_hash: input.config_hash,
      now: input.now,
      registration_hash: input.registration_hash,
      state: existingState
    });
    if (changed.changes !== 1) {
      throw attachError("E_CONFLICT", "host_attach_registration", {
        kind: "field",
        path: "registration",
        rule: "cas_mismatch"
      });
    }
  } else {
    if (existingState !== null) {
      throw attachError("E_CONFLICT", "host_attach_registration", {
        kind: "field",
        path: "registration",
        rule: existingState
      });
    }
    const applied = readAppliedRegistrationCount(tx, input.request);
    if (input.registration_action === "upgrade") {
      if (applied !== 1 || input.expected_previous_hash === null) {
        throw attachError("E_CONFLICT", "host_attach_registration", {
          kind: "field",
          path: "registration",
          rule: "active_binding_mismatch"
        });
      }
      const superseded = tx.prepare(
        `UPDATE adapter_registration
            SET state = 'superseded', updated_at = :now, row_version = row_version + 1
          WHERE registration_hash = :registration_hash
            AND host_id = :host_id AND mode = :mode AND config_space = :config_space
            AND state = 'applied'`
      ).run({
        now: input.now,
        registration_hash: input.expected_previous_hash,
        host_id: input.request.host_id,
        mode: input.request.mode,
        config_space: input.request.config_space
      });
      if (superseded.changes !== 1) {
        throw attachError("E_CONFLICT", "host_attach_registration", {
          kind: "field",
          path: "registration",
          rule: "active_binding_mismatch"
        });
      }
    } else if (applied > 0) {
      throw attachError("E_CONFLICT", "host_attach_registration", {
        kind: "field",
        path: "registration",
        rule: "active_binding"
      });
    }
    tx.prepare(
      `INSERT INTO adapter_registration (
         registration_hash, adapter_id, host_id, mode, config_space, target_id,
         adapter_version, implementation_hash, descriptor_hash, artifact_ref,
         artifact_hash, expected_previous_hash, approval_id, approval_hash,
         approval_subject_hash, approval_consumption_ref, state, written_hash,
         failure_code, created_at, applied_at, updated_at, row_version, config_hash
       ) VALUES (
         :registration_hash, :adapter_id, :host_id, :mode, :config_space, :target_id,
         :adapter_version, :implementation_hash, :descriptor_hash, :artifact_ref,
         :artifact_hash, :expected_previous_hash, :approval_id, :approval_hash,
         :approval_subject_hash, :approval_consumption_ref, 'applied', :written_hash,
         NULL, :now, :now, :now, 1, :config_hash
       )`
    ).run({
      registration_hash: input.registration_hash,
      adapter_id: input.descriptor.adapter_id,
      host_id: input.request.host_id,
      mode: input.request.mode,
      config_space: input.request.config_space,
      target_id: input.target_id,
      adapter_version: input.descriptor.adapter_version,
      implementation_hash: input.descriptor.implementation_hash,
      descriptor_hash: descriptorHash,
      artifact_ref: artifactRefFor(input.artifact_hash),
      artifact_hash: input.artifact_hash,
      expected_previous_hash: input.expected_previous_hash,
      approval_id: input.approval.approval_id,
      approval_hash: input.approval.approval_hash,
      approval_subject_hash: input.approval.approval_subject_hash,
      approval_consumption_ref: input.approval.approval_consumption_ref ?? null,
      written_hash: input.written_hash,
      config_hash: input.config_hash,
      now: input.now
    });
  }

  const snapshot = tx
    .prepare<SqlRow>(
      `SELECT descriptor_hash, descriptor_json
         FROM adapter_descriptor_snapshot
        WHERE registration_hash = :registration_hash`
    )
    .get({ registration_hash: input.registration_hash });
  const descriptorJson = canonicalJsonText(descriptorToJson(input.descriptor));
  if (snapshot === undefined) {
    tx.prepare(
      `INSERT INTO adapter_descriptor_snapshot
         (registration_hash, descriptor_hash, descriptor_json, created_at)
       VALUES (:registration_hash, :descriptor_hash, :descriptor_json, :now)`
    ).run({
      registration_hash: input.registration_hash,
      descriptor_hash: descriptorHash,
      descriptor_json: descriptorJson,
      now: input.now
    });
  } else if (
    snapshot["descriptor_hash"] !== descriptorHash ||
    snapshot["descriptor_json"] !== descriptorJson
  ) {
    throw attachError("E_CONFLICT", "host_attach_registration", {
      kind: "field",
      path: "descriptor_snapshot",
      rule: "descriptor_drift"
    });
  }
}

/**
 * Activates the attach-time `config_profile` for the target space. A host
 * target lives in `user`/`project*`/... while `evolve init` creates `default`;
 * without this row the kernel rejects host events for the attached space.
 */
function activateConfigProfile(tx: Tx, config: EvoplugConfig, now: number): void {
  const configVersion = computeConfigVersion(config);
  tx.prepare(
    `UPDATE config_profile
        SET status = 'superseded'
      WHERE config_space = :config_space
        AND status = 'active'
        AND config_version <> :config_version`
  ).run({ config_space: config.config_space, config_version: configVersion });
  tx.prepare(
    `INSERT INTO config_profile (config_version, config_space, canonical_json, content_hash, status, created_at)
     VALUES (:config_version, :config_space, :canonical_json, :content_hash, 'active', :now)
     ON CONFLICT(config_version) DO UPDATE SET
       config_space = excluded.config_space,
       canonical_json = excluded.canonical_json,
       content_hash = excluded.content_hash,
       status = 'active'`
  ).run({
    config_version: configVersion,
    config_space: config.config_space,
    canonical_json: canonicalConfigJson(config),
    content_hash: computeConfigContentHash(config),
    now
  });
}

/* ------------------------------------------------------------------ */
/* Backups                                                             */
/* ------------------------------------------------------------------ */

interface PreparedBackup {
  readonly path: string;
  readonly content_ref: SourceRef;
  readonly content_hash: Hash;
  readonly byte_length: number;
  readonly relative_path: string;
}

function makeBackupRef(contentHash: Hash, byteLength: number): Result<SourceRef, ErrorEnvelope> {
  // `SourceRef` ranges are non-empty by construction. An empty original file
  // still needs a retrievable pointer to its blob, so use a 0..1 range and let
  // the backup reader resolve the stored length (zero) from the blob table.
  const ref = formatSourceRef({
    scheme: "blob",
    locator: contentHash,
    start: 0,
    end: byteLength === 0 ? 1 : byteLength
  });
  if (!ref.ok) {
    return ref;
  }
  return ok(ref.value);
}

function prepareBackup(
  deps: HostAttachDeps,
  path: string,
  bytes: Uint8Array
): Result<PreparedBackup, ErrorEnvelope> {
  const stored = deps.blobs.putSync(bytes);
  if (!stored.ok) {
    return stored;
  }
  if (stored.value.hash !== hashBytes(bytes) || stored.value.byte_length !== bytes.length) {
    return err(internalError("kernel.host_attach_backup_hash"));
  }
  const verified = deps.blobs.verify(stored.value.hash);
  if (
    !verified.ok ||
    !verified.value.present ||
    !verified.value.hash_matches ||
    verified.value.byte_length !== bytes.length
  ) {
    return err(attachError("E_IO", "host_attach_backup", { kind: "field", path: "path", rule: "verify_failed" }));
  }
  const ref = makeBackupRef(stored.value.hash, bytes.length);
  if (!ref.ok) {
    return ref;
  }
  return ok({
    path,
    content_ref: ref.value,
    content_hash: stored.value.hash,
    byte_length: bytes.length,
    relative_path: stored.value.relative_path
  });
}

function readBackupBytes(
  deps: HostAttachDeps,
  backup: InstallBackupRow
): Result<Uint8Array, ErrorEnvelope> {
  const parsed = parseSourceRef(backup.content_ref);
  if (!parsed.ok || parsed.value.scheme !== "blob" || !isHash(parsed.value.locator)) {
    return err(internalError("kernel.host_attach_backup_ref"));
  }
  if (backup.content_hash !== parsed.value.locator) {
    return err(internalError("kernel.host_attach_backup_ref"));
  }
  const hash = parsed.value.locator;
  const verified = deps.blobs.verify(hash);
  if (!verified.ok || !verified.value.present || !verified.value.hash_matches) {
    return err(attachError("E_IO", "host_detach_backup", { kind: "field", path: "path", rule: "verify_failed" }));
  }
  const byteLength = verified.value.byte_length;
  if (byteLength === null) {
    return err(internalError("kernel.host_attach_backup_length"));
  }
  if (byteLength === 0) {
    return ok(emptyBytes());
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(deps.blobs.absolutePath(hash)));
  } catch {
    return err(attachError("E_IO", "host_detach_backup", { kind: "field", path: "path", rule: "read_failed" }));
  }
  if (bytes.length < byteLength) {
    return err(internalError("kernel.host_attach_backup_short"));
  }
  const slice = bytes.subarray(0, byteLength);
  if (hashBytes(slice) !== hash) {
    return err(internalError("kernel.host_attach_backup_hash"));
  }
  return ok(slice);
}

function insertBackupRows(
  tx: Tx,
  input: {
    readonly backup: PreparedBackup;
    readonly installId: string;
    readonly backupId: string;
    readonly now: number;
  }
): void {
  tx.prepare(
    `INSERT INTO blob
       (blob_hash, byte_length, relative_path, state, verified_at, created_at,
        deleted_at, deletion_reason)
     VALUES
       (:blob_hash, :byte_length, :relative_path, 'present', :now, :now, NULL, NULL)
     ON CONFLICT(blob_hash) DO NOTHING`
  ).run({
    blob_hash: input.backup.content_hash,
    byte_length: input.backup.byte_length,
    relative_path: input.backup.relative_path,
    now: input.now
  });
  tx.prepare(
    `INSERT INTO blob_ref (blob_hash, owner_type, owner_id, source_ref, created_at)
     VALUES (:blob_hash, 'maintenance', :owner_id, :source_ref, :now)
     ON CONFLICT(blob_hash, owner_type, owner_id) DO NOTHING`
  ).run({
    blob_hash: input.backup.content_hash,
    owner_id: input.backupId,
    source_ref: input.backup.content_ref,
    now: input.now
  });
  tx.prepare(
    `INSERT INTO install_backup
       (backup_id, install_id, path, content_ref, content_hash, state,
        tombstoned_at, created_at)
     VALUES
       (:backup_id, :install_id, :path, :content_ref, :content_hash, 'active',
        NULL, :now)`
  ).run({
    backup_id: input.backupId,
    install_id: input.installId,
    path: input.backup.path,
    content_ref: input.backup.content_ref,
    content_hash: input.backup.content_hash,
    now: input.now
  });
}

/* ------------------------------------------------------------------ */
/* Runtime artifact manifest and config                                */
/* ------------------------------------------------------------------ */

interface ArtifactManifestFile {
  readonly path: string;
  readonly sha256: Hash;
  readonly mode: 384 | 420;
}

function artifactEntryPath(files: readonly HostAttachArtifactFile[]): string {
  const sorted = [...files].sort((left, right) => compareUtf8(left.relative_path, right.relative_path));
  // DD-HOST-200.1 names the factory entry `entry.<ext>` at the artifact root.
  // A plan without that name falls back to its byte-order-first member.
  const entry = sorted.find((file) => /^entry\.[A-Za-z0-9]+$/.test(file.relative_path));
  const first = sorted[0];
  if (entry !== undefined) {
    return entry.relative_path;
  }
  return first === undefined ? "" : first.relative_path;
}

function buildRuntimeManifest(
  descriptor: AdapterDescriptor,
  files: readonly HostAttachArtifactFile[]
): { readonly manifest: { readonly [key: string]: JsonValue }; readonly artifact_hash: Hash } {
  const manifestFiles: ArtifactManifestFile[] = [...files]
    .sort((left, right) => compareUtf8(left.relative_path, right.relative_path))
    .map((file) => ({
      path: file.relative_path,
      sha256: hashText(file.content),
      mode: file.mode
    }));
  const manifest = toJsonValue({
    schema_version: HOST_RUNTIME_ARTIFACT_SCHEMA,
    host_id: descriptor.host_id,
    adapter_id: descriptor.adapter_id,
    adapter_version: descriptor.adapter_version,
    implementation_hash: descriptor.implementation_hash,
    entry: artifactEntryPath(files),
    files: manifestFiles,
    config_schema: HOST_RUNTIME_CONFIG_SCHEMA
  });
  if (!isJsonObject(manifest)) {
    throw internalError("kernel.host_attach_manifest_shape");
  }
  return { manifest, artifact_hash: canonicalHash(manifest) };
}

function readConfigCreatedAt(current: HostFileState | null, now: number): number {
  if (current === null) {
    return now;
  }
  try {
    const parsed: unknown = JSON.parse(decodeContent(current.bytes));
    if (isRecord(parsed)) {
      const created = parsed["created_at"];
      if (typeof created === "number" && Number.isSafeInteger(created) && created >= 0) {
        return created;
      }
    }
  } catch {
    // An unreadable previous config is regenerated with the current clock.
  }
  return now;
}

function buildRuntimeConfig(input: {
  readonly descriptor: AdapterDescriptor;
  readonly plan: HostAttachTargetPlan;
  readonly mode: HostMode;
  readonly home_root: string;
  readonly registration_hash: Hash;
  readonly created_at: number;
}): { readonly config: { readonly [key: string]: JsonValue }; readonly config_hash: Hash } {
  const config = toJsonValue({
    schema_version: HOST_RUNTIME_CONFIG_SCHEMA,
    host_id: input.descriptor.host_id,
    mode: input.mode,
    config_space: input.plan.target.config_space,
    adapter_id: input.descriptor.adapter_id,
    adapter_version: input.descriptor.adapter_version,
    implementation_hash: input.descriptor.implementation_hash,
    registration_hash: input.registration_hash,
    ipc: {
      evoplug_home: input.home_root,
      client_id: input.descriptor.adapter_id,
      client_kind: "host_runtime"
    },
    behavior: {
      submit_events: true,
      allow_delivery: true,
      max_payload_bytes: DEFAULT_MAX_PAYLOAD_BYTES,
      redact_fields: [...DEFAULT_REDACT_FIELDS]
    },
    log: {
      path: join(input.home_root, "logs", "host-runtime.log"),
      level: "info"
    },
    created_at: input.created_at
  });
  if (!isJsonObject(config)) {
    throw internalError("kernel.host_attach_config_shape");
  }
  return { config, config_hash: canonicalHash(config) };
}

function jsonDocumentBytes(value: { readonly [key: string]: JsonValue }): Uint8Array {
  return encodeContent(`${JSON.stringify(value, null, 2)}\n`);
}

/* ------------------------------------------------------------------ */
/* JSON merge helpers                                                  */
/* ------------------------------------------------------------------ */

interface JsonDocument {
  readonly value: { [key: string]: JsonValue };
  readonly state: HostFileState | null;
  readonly indent: string;
  readonly eol: string;
  readonly trailing_newline: boolean;
}

function readJsonDocument(path: string): Result<JsonDocument, ErrorEnvelope> {
  const read = readHostFile(path);
  if (!read.ok) {
    return read;
  }
  const state = read.value;
  if (state === null) {
    return ok({ value: {}, state: null, indent: "  ", eol: "\n", trailing_newline: true });
  }
  let text: string;
  try {
    text = decodeContent(state.bytes);
  } catch {
    return err(
      attachError("E_INSTALL_CONFLICT", "host_attach_json_merge", {
        kind: "field",
        path: "path",
        rule: "json_utf8"
      })
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err(
      attachError("E_INSTALL_CONFLICT", "host_attach_json_merge", {
        kind: "field",
        path: "path",
        rule: "json_parse"
      })
    );
  }
  if (!isJsonObject(parsed)) {
    return err(
      attachError("E_INSTALL_CONFLICT", "host_attach_json_merge", {
        kind: "field",
        path: "path",
        rule: "json_object"
      })
    );
  }
  const indentMatch = /(?:^|\n)([ \t]+)\S/.exec(text);
  const indent = indentMatch !== null ? indentMatch[1] ?? "  " : "  ";
  return ok({
    value: parsed,
    state,
    indent,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    trailing_newline: text.endsWith("\n")
  });
}

function serializeJsonDocument(
  value: { readonly [key: string]: JsonValue },
  document: JsonDocument
): Uint8Array {
  let text = JSON.stringify(value, null, document.indent);
  if (document.eol !== "\n") {
    text = text.replaceAll("\n", document.eol);
  }
  if (document.trailing_newline) {
    text += document.eol;
  }
  return encodeContent(text);
}

function decodeJsonPointer(pointer: string): string[] | null {
  if (pointer === "" || pointer[0] !== "/") {
    return null;
  }
  const tokens: string[] = [];
  for (const raw of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(raw)) {
      return null;
    }
    tokens.push(raw.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  return tokens;
}

function entryArrayFor(
  root: { [key: string]: JsonValue },
  tokens: readonly string[]
): JsonValue[] | null {
  let node: JsonValue = root;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    const last = index === tokens.length - 1;
    if (Array.isArray(node)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) {
        return null;
      }
      const position = Number(token);
      if (position >= node.length) {
        return null;
      }
      const child = node[position];
      if (last) {
        return Array.isArray(child) ? child : null;
      }
      node = child as JsonValue;
      continue;
    }
    if (!isJsonObject(node)) {
      return null;
    }
    const existing: JsonValue | undefined = node[token];
    if (last) {
      if (existing === undefined) {
        const created: JsonValue[] = [];
        node[token] = created;
        return created;
      }
      return Array.isArray(existing) ? existing : null;
    }
    if (existing === undefined) {
      const created: { [key: string]: JsonValue } = {};
      node[token] = created;
      node = created;
      continue;
    }
    node = existing;
  }
  return null;
}

function removeOwnedEntries(
  value: JsonValue,
  selector: string
): { readonly value: JsonValue; readonly removed: number } {
  if (Array.isArray(value)) {
    const kept: JsonValue[] = [];
    let removed = 0;
    for (const element of value) {
      if (containsCommandReference(element, selector)) {
        removed += 1;
        continue;
      }
      const next = removeOwnedEntries(element, selector);
      removed += next.removed;
      kept.push(next.value);
    }
    return { value: kept, removed };
  }
  if (isJsonObject(value)) {
    const result: { [key: string]: JsonValue } = {};
    let removed = 0;
    for (const [key, child] of Object.entries(value)) {
      const next = removeOwnedEntries(child, selector);
      removed += next.removed;
      result[key] = next.value;
    }
    return { value: result, removed };
  }
  return { value, removed: 0 };
}

function isEmptyJsonValue(value: JsonValue): boolean {
  if (Array.isArray(value)) {
    return value.every((element) => isEmptyJsonValue(element));
  }
  if (isJsonObject(value)) {
    return Object.values(value).every((child) => isEmptyJsonValue(child));
  }
  return false;
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  return canonicalJsonText(left) === canonicalJsonText(right);
}

/**
 * Removes only owned entries whose value still equals what attach wrote.
 *
 * Ownership is the DD-FND-102 `json_merge` selector: an entry belongs to the
 * product when its `command` references the artifact root. On a file modified
 * after attach, an owned entry that no longer matches the resolved plan may be
 * a user edit or an unknown product version, so the whole detach is reported as
 * a conflict rather than removing it.
 */
function removeOwnedEntriesMatching(
  value: JsonValue,
  selector: string,
  expected: readonly JsonValue[]
): { readonly value: JsonValue; readonly removed: number; readonly conflict: boolean } {
  if (Array.isArray(value)) {
    const kept: JsonValue[] = [];
    let removed = 0;
    let conflict = false;
    for (const element of value) {
      if (containsCommandReference(element, selector)) {
        if (expected.some((candidate) => jsonValuesEqual(candidate, element))) {
          removed += 1;
          continue;
        }
        conflict = true;
        kept.push(element);
        continue;
      }
      const next = removeOwnedEntriesMatching(element, selector, expected);
      removed += next.removed;
      conflict = conflict || next.conflict;
      kept.push(next.value);
    }
    return { value: kept, removed, conflict };
  }
  if (isJsonObject(value)) {
    const result: { [key: string]: JsonValue } = {};
    let removed = 0;
    let conflict = false;
    for (const [key, child] of Object.entries(value)) {
      const next = removeOwnedEntriesMatching(child, selector, expected);
      removed += next.removed;
      conflict = conflict || next.conflict;
      result[key] = next.value;
    }
    return { value: result, removed, conflict };
  }
  return { value, removed: 0, conflict: false };
}

/**
 * Drops the container keys that attach created for the given JSON pointers and
 * that became empty when product entries were removed. `origin === null` means
 * attach created the file, so every such container is product residue;
 * `origin === undefined` means the original document could not be read, so
 * nothing is pruned. Keys outside the managed pointers are never touched.
 */
function pruneVacatedPointers(
  node: JsonValue,
  pointers: readonly (readonly string[])[],
  origin: JsonValue | null | undefined
): JsonValue {
  let result = node;
  for (const tokens of pointers) {
    result = pruneVacatedPointer(result, tokens, origin);
  }
  return result;
}

function pruneVacatedPointer(
  node: JsonValue,
  tokens: readonly string[],
  origin: JsonValue | null | undefined
): JsonValue {
  if (!isJsonObject(node) || tokens.length === 0) {
    return node;
  }
  const token = tokens[0] as string;
  const child: JsonValue | undefined = node[token];
  if (child === undefined) {
    return node;
  }
  const originChild =
    origin === undefined ? undefined : isJsonObject(origin) ? origin[token] : undefined;
  const prunedChild =
    tokens.length === 1
      ? child
      : pruneVacatedPointer(child, tokens.slice(1), originChild);
  if (isEmptyJsonValue(prunedChild) && originChild === undefined) {
    const remaining: { [key: string]: JsonValue } = {};
    for (const [key, value] of Object.entries(node)) {
      if (key !== token) {
        remaining[key] = value;
      }
    }
    return remaining;
  }
  if (prunedChild === child) {
    return node;
  }
  return { ...node, [token]: prunedChild };
}

function mergeJsonDocument(
  document: JsonDocument,
  selector: string,
  entries: readonly HostAttachJsonMergeEntry[],
  removeOnly: boolean
): { readonly value: { [key: string]: JsonValue }; readonly removed: number } | null {
  const cleaned = removeOwnedEntries(document.value, selector);
  if (!isJsonObject(cleaned.value)) {
    return null;
  }
  const root = cleaned.value;
  if (!removeOnly) {
    for (const entry of entries) {
      const tokens = decodeJsonPointer(entry.pointer);
      if (tokens === null) {
        return null;
      }
      const array = entryArrayFor(root, tokens);
      if (array === null) {
        return null;
      }
      array.push(toJsonValue(structuredClone(entry.value)));
    }
  }
  return { value: root, removed: cleaned.removed };
}

/* ------------------------------------------------------------------ */
/* Simulation                                                          */
/* ------------------------------------------------------------------ */

interface PlannedEntry {
  readonly plan: HostAttachTargetPlan;
  readonly path: string;
  readonly before: HostFileState | null;
  readonly kind: HostAttachEntryKind;
  readonly marker_id: string | null;
  readonly installed_hash: Hash | null;
  readonly origin_hash: Hash | null;
  readonly after_bytes: Uint8Array | null;
  readonly after_mode: number;
  readonly no_change: boolean;
  readonly expected: InstallPathRow | null;
  /** Restore the active backup on detach (host config files). */
  readonly restore_backup: boolean;
  /** True for every artifact_dir member, including manifest and config. */
  readonly artifact_member: boolean;
}

interface PlannedTarget {
  readonly plan: HostAttachTargetPlan;
  readonly entries: readonly PlannedEntry[];
  readonly no_change: boolean;
  readonly written_hash: Hash | null;
  readonly artifact_hash: Hash | null;
  readonly config_hash: Hash | null;
  /** Registration binding carried by an artifact target. */
  readonly registration_hash: Hash | null;
  /** Set only by an artifact target; absent for every other write mode. */
  readonly registration_action?: "reuse" | "insert" | "upgrade";
  readonly registration_expected_previous_hash?: Hash | null;
}

function simulateSingle(input: {
  readonly plan: HostAttachTargetPlan;
  readonly current: HostFileState | null;
  readonly expected: InstallPathRow | null;
}): Result<PlannedTarget, ErrorEnvelope> {
  const plan = input.plan;
  const contentBytes = encodeContent(plan.content ?? "");
  if (plan.write_mode === "managed_block") {
    const selector = plan.target.marker_id;
    if (selector === null) {
      return err(fieldError("E_SCHEMA", "marker_id", "managed_block_requires_marker"));
    }
    const currentBytes = input.current?.bytes ?? emptyBytes();
    const existing = findBlock(currentBytes, selector);
    if (!existing.ok) {
      return existing;
    }
    const installedHash = managedBlockHash(selector, contentBytes);
    if (existing.value !== null && existing.value.block_hash === installedHash) {
      return ok({
        plan,
        entries: [
          {
            plan,
            path: plan.path,
            before: input.current,
            kind: "host_config_block",
            marker_id: selector,
            installed_hash: installedHash,
            origin_hash: installedHash,
            after_bytes: null,
            after_mode: input.current?.mode ?? 0o600,
            no_change: true,
            expected: input.expected,
            restore_backup: true,
            artifact_member: false
          }
        ],
        no_change: true,
        written_hash: installedHash,
        artifact_hash: null,
        config_hash: null,
        registration_hash: null
      });
    }
    const edited = applyManagedBlockEdit({
      bytes: currentBytes,
      selector,
      block_action: existing.value === null ? "attach" : "update",
      content: contentBytes
    });
    if (!edited.ok) {
      return edited;
    }
    return ok({
      plan,
      entries: [
        {
          plan,
          path: plan.path,
          before: input.current,
          kind: "host_config_block",
          marker_id: selector,
          installed_hash: installedHash,
          origin_hash: installedHash,
          after_bytes: edited.value.bytes,
          after_mode: input.current?.mode ?? 0o600,
          no_change: false,
          expected: input.expected,
          restore_backup: true,
          artifact_member: false
        }
      ],
      no_change: false,
      written_hash: installedHash,
      artifact_hash: null,
      config_hash: null,
      registration_hash: null
    });
  }

  const installedHash = hashBytes(contentBytes);
  const currentHash = input.current === null ? null : hashBytes(input.current.bytes);
  if (input.current === null) {
    return ok({
      plan,
      entries: [
        {
          plan,
          path: plan.path,
          before: null,
          kind: "host_registration",
          marker_id: null,
          installed_hash: installedHash,
          origin_hash: installedHash,
          after_bytes: contentBytes,
          after_mode: 0o600,
          no_change: false,
          expected: input.expected,
          restore_backup: true,
          artifact_member: false
        }
      ],
      no_change: false,
      written_hash: installedHash,
      artifact_hash: null,
      config_hash: null,
      registration_hash: null
    });
  }
  if (bytesEqual(input.current.bytes, contentBytes)) {
    return ok({
      plan,
      entries: [
        {
          plan,
          path: plan.path,
          before: input.current,
          kind: "host_registration",
          marker_id: null,
          installed_hash: installedHash,
          origin_hash: installedHash,
          after_bytes: null,
          after_mode: input.current.mode,
          no_change: true,
          expected: input.expected,
          restore_backup: true,
          artifact_member: false
        }
      ],
      no_change: true,
      written_hash: installedHash,
      artifact_hash: null,
      config_hash: null,
      registration_hash: null
    });
  }
  const owned =
    input.expected !== null &&
    input.expected.ownership === "managed" &&
    (input.expected.state === "restored" ||
      (input.expected.installed_hash !== null &&
        input.expected.installed_hash === currentHash));
  if (!owned) {
    const expectedHash =
      input.expected !== null &&
      input.expected.installed_hash !== null &&
      isHash(input.expected.installed_hash)
        ? input.expected.installed_hash
        : installedHash;
    return err(
      attachError("E_INSTALL_CONFLICT", "host_attach_scan", {
        kind: "conflict",
        current_hash: currentHash ?? installedHash,
        expected_hash: expectedHash
      })
    );
  }
  return ok({
    plan,
    entries: [
      {
        plan,
        path: plan.path,
        before: input.current,
        kind: "host_registration",
        marker_id: null,
        installed_hash: installedHash,
        origin_hash: installedHash,
        after_bytes: contentBytes,
        after_mode: input.current.mode,
        no_change: false,
        expected: input.expected,
        restore_backup: true,
        artifact_member: false
      }
    ],
    no_change: false,
    written_hash: installedHash,
    artifact_hash: null,
    config_hash: null,
    registration_hash: null
  });
}

function artifactDirectories(root: string, files: readonly HostAttachArtifactFile[]): string[] {
  const directories = new Set<string>([root]);
  for (const file of files) {
    let directory = dirname(join(root, file.relative_path));
    while (directory !== root && directory.startsWith(`${root}/`)) {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  return [...directories].sort(
    (left, right) => left.length - right.length || compareUtf8(left, right)
  );
}

function conflictDetails(
  currentBytes: Uint8Array | null,
  expectedHash: Hash
): ErrorDetails {
  return {
    kind: "conflict",
    current_hash: currentBytes === null ? expectedHash : hashBytes(currentBytes),
    expected_hash: expectedHash
  };
}

function simulateArtifactDir(input: {
  readonly plan: HostAttachTargetPlan;
  readonly descriptor: AdapterDescriptor;
  readonly mode: HostMode;
  readonly home_root: string;
  readonly now: number;
  readonly expectedRows: Map<string, InstallPathRow>;
  /** Unique applied registration for the target triple, when one exists. */
  readonly applied_registration: AppliedRegistrationRow | null;
  /** Finished registration to chain when the binding is re-attached. */
  readonly previous_registration_hash: Hash | null;
}): Result<PlannedTarget, ErrorEnvelope> {
  const plan = input.plan;
  const root = join(plan.root_path as string);
  const metaDir = join(plan.runtime_meta_dir ?? (plan.root_path as string));
  const files = plan.files as readonly HostAttachArtifactFile[];
  const configPath = join(metaDir, RUNTIME_CONFIG_FILE);
  const manifestPath = join(metaDir, RUNTIME_MANIFEST_FILE);

  const configCurrent = readHostFile(configPath);
  if (!configCurrent.ok) {
    return configCurrent;
  }
  const { manifest, artifact_hash: artifactHash } = buildRuntimeManifest(input.descriptor, files);
  const descriptorHash = adapterDescriptorHash(input.descriptor);
  const applied = input.applied_registration;
  const appliedIsValid = applied !== null && isSelfConsistentRegistration(applied);
  // A real applied row whose artifact, target and descriptor are unchanged is
  // the same registration and is reused byte-for-byte. A different artifact
  // is a version switch: the old row is superseded and the new registration
  // binds `expected_previous_hash` to it. Rows written before the runtime
  // binding existed (or seeded by fixtures) do not recompute; attach keeps
  // their registration hash so file-only attach remains compatible.
  const reuseApplied =
    applied !== null &&
    (!appliedIsValid ||
      (applied.artifact_hash === artifactHash &&
        applied.target_id === plan.target.target_id &&
        applied.descriptor_hash === descriptorHash &&
        applied.adapter_id === input.descriptor.adapter_id &&
        applied.adapter_version === input.descriptor.adapter_version &&
        applied.implementation_hash === input.descriptor.implementation_hash));
  const expectedPreviousHash: Hash | null = reuseApplied
    ? (applied?.expected_previous_hash as Hash | null) ?? null
    : appliedIsValid
      ? (applied.registration_hash as Hash)
      : input.previous_registration_hash;
  const registrationHash = reuseApplied
    ? (applied.registration_hash as Hash)
    : computeRegistrationHash({
        host_id: input.descriptor.host_id,
        mode: input.mode,
        config_space: plan.target.config_space,
        adapter_id: input.descriptor.adapter_id,
        adapter_version: input.descriptor.adapter_version,
        implementation_hash: input.descriptor.implementation_hash,
        descriptor_hash: descriptorHash,
        target_id: plan.target.target_id,
        artifact_hash: artifactHash,
        expected_previous_hash: expectedPreviousHash
      });
  const registrationAction: "reuse" | "insert" | "upgrade" = reuseApplied
    ? "reuse"
    : appliedIsValid
      ? "upgrade"
      : "insert";
  const { config, config_hash: configHash } = buildRuntimeConfig({
    descriptor: input.descriptor,
    plan,
    mode: input.mode,
    home_root: input.home_root,
    registration_hash: registrationHash,
    created_at: readConfigCreatedAt(configCurrent.value, input.now)
  });

  const members: Array<{
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly mode: 384 | 420;
    readonly current: HostFileState | null;
  }> = [];
  for (const file of files) {
    members.push({
      path: join(root, file.relative_path),
      bytes: encodeContent(file.content),
      mode: file.mode,
      current: null
    });
  }
  members.push({
    path: manifestPath,
    bytes: jsonDocumentBytes(manifest),
    mode: 420,
    current: null
  });
  members.push({
    path: configPath,
    bytes: jsonDocumentBytes(config),
    mode: 384,
    current: configCurrent.value
  });

  const entries: PlannedEntry[] = [];
  const seenPaths = new Set<string>();
  let noChange = true;
  for (const member of members) {
    if (seenPaths.has(member.path)) {
      return err(fieldError("E_CONFLICT", "path", "duplicate_artifact_path"));
    }
    seenPaths.add(member.path);
    const currentRead = member.current !== null || member.path === configPath
      ? ok(member.current)
      : readHostFile(member.path);
    if (!currentRead.ok) {
      return currentRead;
    }
    const current = currentRead.value;
    const installedHash = hashBytes(member.bytes);
    const identical = current !== null && bytesEqual(current.bytes, member.bytes);
    if (!identical && current !== null) {
      const expected = input.expectedRows.get(member.path) ?? null;
      const owned =
        expected !== null &&
        expected.ownership === "managed" &&
        (expected.state === "restored" || expected.installed_hash === hashBytes(current.bytes));
      if (!owned) {
        return err(
          attachError("E_INSTALL_CONFLICT", "host_attach_scan", conflictDetails(current.bytes, installedHash))
        );
      }
    }
    if (!identical) {
      noChange = false;
    }
    entries.push({
      plan,
      path: member.path,
      before: current,
      kind: "file",
      marker_id: null,
      installed_hash: installedHash,
      origin_hash: current === null ? installedHash : hashBytes(current.bytes),
      after_bytes: identical ? null : member.bytes,
      after_mode: member.mode,
      no_change: identical,
      expected: input.expectedRows.get(member.path) ?? null,
      restore_backup: false,
      artifact_member: true
    });
  }

  for (const directory of artifactDirectories(root, files)) {
    if (seenPaths.has(directory)) {
      return err(fieldError("E_CONFLICT", "path", "duplicate_artifact_path"));
    }
    seenPaths.add(directory);
    const inspected = inspectHostPath(directory);
    if (!inspected.ok) {
      return inspected;
    }
    if (inspected.value !== "missing" && inspected.value !== "directory") {
      return err(fieldError("E_PATH_CHANGED", "path", "artifact_directory"));
    }
    entries.push({
      plan,
      path: directory,
      before: null,
      kind: "directory",
      marker_id: null,
      installed_hash: null,
      origin_hash: null,
      after_bytes: null,
      after_mode: 0o700,
      no_change: true,
      expected: input.expectedRows.get(directory) ?? null,
      restore_backup: false,
      artifact_member: true
    });
  }
  // Metadata lives outside `files`, so its directory is not covered by
  // `artifactDirectories`. It still has to be an `install_path` row: detach
  // removes it after the last metadata file.
  if (metaDir !== root && metaDir.startsWith(`${root}/`) && !seenPaths.has(metaDir)) {
    const inspected = inspectHostPath(metaDir);
    if (!inspected.ok) {
      return inspected;
    }
    if (inspected.value !== "missing" && inspected.value !== "directory") {
      return err(fieldError("E_PATH_CHANGED", "path", "artifact_metadata_directory"));
    }
    entries.push({
      plan,
      path: metaDir,
      before: null,
      kind: "directory",
      marker_id: null,
      installed_hash: null,
      origin_hash: null,
      after_bytes: null,
      after_mode: 0o700,
      no_change: true,
      expected: input.expectedRows.get(metaDir) ?? null,
      restore_backup: false,
      artifact_member: true
    });
  }

  return ok({
    plan,
    entries,
    no_change: noChange,
    written_hash: artifactHash,
    artifact_hash: artifactHash,
    config_hash: configHash,
    registration_hash: registrationHash,
    registration_action: registrationAction,
    registration_expected_previous_hash: expectedPreviousHash
  });
}

function simulateJsonMerge(input: {
  readonly plan: HostAttachTargetPlan;
  readonly expected: InstallPathRow | null;
}): Result<PlannedTarget, ErrorEnvelope> {
  const plan = input.plan;
  const document = readJsonDocument(plan.path);
  if (!document.ok) {
    return document;
  }
  const merged = mergeJsonDocument(
    document.value,
    plan.selector as string,
    plan.entries as readonly HostAttachJsonMergeEntry[],
    false
  );
  if (merged === null) {
    return err(
      attachError("E_INSTALL_CONFLICT", "host_attach_json_merge", {
        kind: "field",
        path: "entries",
        rule: "pointer_not_array"
      })
    );
  }
  const afterBytes = serializeJsonDocument(merged.value, document.value);
  const current = document.value.state;
  const noChange = current !== null && bytesEqual(current.bytes, afterBytes);
  const installedHash = hashBytes(afterBytes);
  return ok({
    plan,
    entries: [
      {
        plan,
        path: plan.path,
        before: current,
        kind: "file",
        marker_id: null,
        installed_hash: installedHash,
        origin_hash: current === null ? installedHash : hashBytes(current.bytes),
        after_bytes: noChange ? null : afterBytes,
        after_mode: current?.mode ?? 0o600,
        no_change: noChange,
        expected: input.expected,
        restore_backup: true,
        artifact_member: false
      }
    ],
    no_change: noChange,
    written_hash: installedHash,
    artifact_hash: null,
    config_hash: null,
    registration_hash: null
  });
}

function findBlock(
  bytes: Uint8Array,
  selector: string
): Result<ManagedBlockSpan | null, ErrorEnvelope> {
  const parsed = parseManagedBlocks(bytes);
  if (!parsed.ok) {
    return parsed;
  }
  const blocks = parsed.value.blocks.filter((block) => block.selector === selector);
  if (blocks.length > 1) {
    return err(fieldError("E_BLOCK_AMBIGUOUS", "block", "duplicate_selector"));
  }
  return ok(blocks[0] ?? null);
}

/* ------------------------------------------------------------------ */
/* Attach                                                              */
/* ------------------------------------------------------------------ */

function buildTargetOutcome(
  target: HostAttachTargetPlan,
  state: HostAttachTargetState,
  installedHash: Hash | null,
  errorCode: string | null
): HostAttachTargetOutcome {
  const kind =
    target.write_mode === "managed_block"
      ? "host_config_block"
      : target.write_mode === "artifact_dir"
        ? "runtime_artifact"
        : target.write_mode === "json_merge"
          ? "json_merge"
          : "host_registration";
  return {
    target_id: target.target.target_id,
    path: target.path,
    marker_id: target.target.marker_id,
    kind,
    state,
    installed_hash: installedHash,
    error_code: errorCode
  };
}

function selectHashes(
  planned: readonly PlannedTarget[],
  failures: ReadonlyMap<string, ErrorEnvelope>
): { written_hash: Hash | null; artifact_hash: Hash | null; config_hash: Hash | null } {
  for (const target of planned) {
    if (target.artifact_hash !== null) {
      const failed = target.entries.some((entry) => failures.has(entry.path));
      return {
        written_hash: failed ? null : target.written_hash,
        artifact_hash: target.artifact_hash,
        config_hash: target.config_hash
      };
    }
  }
  const written = planned.find((target) => target.written_hash !== null);
  return {
    written_hash: written?.written_hash ?? null,
    artifact_hash: null,
    config_hash: null
  };
}

function verifyArtifactReadback(
  planned: readonly PlannedTarget[],
  failures: Map<string, ErrorEnvelope>
): void {
  for (const target of planned) {
    if (target.artifact_hash === null) {
      continue;
    }
    for (const entry of target.entries) {
      if (entry.after_bytes === null || entry.kind === "directory") {
        continue;
      }
      const read = readHostFile(entry.path);
      if (!read.ok) {
        failures.set(entry.path, read.error);
        continue;
      }
      if (
        read.value === null ||
        entry.installed_hash === null ||
        hashBytes(read.value.bytes) !== entry.installed_hash
      ) {
        failures.set(
          entry.path,
          attachError("E_ARTIFACT_MISMATCH", "host_attach_verify", {
            kind: "field",
            path: "path",
            rule: "readback_hash"
          }, "partial")
        );
      }
    }
  }
}

function writeAttachResult(input: {
  readonly status: HostAttachResult["status"];
  readonly request: HostAttachRequest;
  readonly descriptor: AdapterDescriptor;
  readonly descriptor_hash: Hash;
  readonly install_id: string;
  readonly hashes: {
    readonly written_hash: Hash | null;
    readonly artifact_hash: Hash | null;
    readonly config_hash: Hash | null;
  };
  readonly outcomes: readonly HostAttachTargetOutcome[];
  readonly conflicts: readonly HostAttachConflict[];
}): HostAttachResult {
  return {
    schema_version: ATTACH_RESULT_SCHEMA,
    status: input.status,
    host_id: input.request.host_id,
    mode: input.request.mode,
    config_space: input.request.config_space,
    adapter_id: input.descriptor.adapter_id,
    adapter_version: input.descriptor.adapter_version,
    descriptor_hash: input.descriptor_hash,
    install_id: input.install_id,
    written_hash: input.hashes.written_hash,
    artifact_hash: input.hashes.artifact_hash,
    config_hash: input.hashes.config_hash,
    targets: input.outcomes,
    conflicts: input.conflicts
  };
}

async function attach(
  deps: HostAttachDeps,
  request: HostAttachRequest
): Promise<Result<HostAttachResult, ErrorEnvelope>> {
  const depsError = validateDeps(deps);
  if (depsError !== null) {
    return err(depsError);
  }
  const resolved = await resolveTargets(deps, request);
  if (!resolved.ok) {
    return resolved;
  }
  const resolution = resolved.value;
  for (const target of resolution.targets) {
    if (target.requires_trust && target.trust_state !== "ready") {
      return err(
        attachError(
          "E_AUTH_UNAVAILABLE",
          "host_attach_trust",
          { kind: "field", path: "trust_state", rule: target.trust_state }
        )
      );
    }
  }
  const now = (deps.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0) {
    return err(internalError("kernel.host_attach_clock"));
  }
  /**
   * Post-commit probe trigger. Attach is done once the registration row is
   * applied, whether the files changed or not; a probe scheduling failure must
   * never surface as an attach failure.
   */
  function notifyAttachProbe(
    plan: { readonly registration_hash: Hash | null } | null,
    fallbackRegistrationHash: Hash | null,
    committed: {
      readonly artifact_hash: Hash | null;
      readonly written_hash: Hash | null;
    }
  ): void {
    const port = deps.probe;
    const registrationHash = plan?.registration_hash ?? fallbackRegistrationHash;
    const artifactHash = committed.artifact_hash ?? committed.written_hash;
    if (port === undefined || registrationHash === null || artifactHash === null) {
      return;
    }
    try {
      const outcome = port.onAttached({
        registration_hash: registrationHash,
        artifact_hash: artifactHash,
        host_id: request.host_id,
        mode: request.mode,
        config_space: request.config_space
      });
      if (outcome instanceof Promise) {
        outcome.catch(() => undefined);
      }
    } catch {
      // Probe scheduling is best-effort by contract.
    }
  }
  // DD-HOST-200.3/200.4: the runtime config binds exactly one applied
  // registration for `(host_id, mode, config_space)`. Select it before
  // simulating artifact targets so `config_hash` covers `registration_hash`.
  const artifactTargets = resolution.targets.filter(
    (target) => target.write_mode === "artifact_dir"
  );
  const appliedRegistrations =
    artifactTargets.length > 0 ? readAppliedRegistrations(deps.connection, request) : [];
  if (appliedRegistrations.length > 1) {
    return err(
      attachError("E_CONFLICT", "host_attach_registration", {
        kind: "field",
        path: "registration",
        rule: "multiple_applied"
      })
    );
  }
  const inflight =
    artifactTargets.length > 0 ? readInflightRegistration(deps.connection, request) : null;
  if (inflight !== null && appliedRegistrations.length === 0) {
    return err(
      attachError("E_CONFLICT", "host_attach_registration", {
        kind: "field",
        path: "registration",
        rule: "applying"
      })
    );
  }
  const appliedRegistration = appliedRegistrations[0] ?? null;
  const previousRegistration =
    artifactTargets.length > 0 && appliedRegistration === null
      ? readPreviousRegistration(deps.connection, request)
      : null;
  let registrationHash: Hash | null =
    appliedRegistration === null
      ? null
      : (appliedRegistration.registration_hash as Hash);
  const homeConfig = await readConfigFile(deps.home_root).catch(() => null);
  const spaceConfig: EvoplugConfig | null =
    homeConfig !== null && homeConfig.ok
      ? { ...homeConfig.value, config_space: request.config_space }
      : null;
  const existingManifest = readManifest(deps.connection, deps.home_root);
  if (existingManifest !== null && existingManifest.status === "uninstalled") {
    return err(fieldError("E_CONFLICT", "install_manifest.status", "uninstalled"));
  }
  if (existingManifest !== null && existingManifest.status === "detaching") {
    return err(fieldError("E_CONFLICT", "install_manifest.status", "detaching"));
  }
  const lookupInstallId = existingManifest?.install_id ?? deps.install_id ?? "";
  const expectedRows =
    lookupInstallId.length === 0
      ? new Map<string, InstallPathRow>()
      : readInstallPaths(deps.connection, lookupInstallId);

  const planned: PlannedTarget[] = [];
  const simulated = new Map<string, HostFileState | null>();
  const plannedPaths = new Set<string>();
  for (const target of resolution.targets) {
    let plannedTarget: Result<PlannedTarget, ErrorEnvelope>;
    if (target.write_mode === "artifact_dir") {
      plannedTarget = simulateArtifactDir({
        plan: target,
        descriptor: resolution.descriptor,
        mode: request.mode,
        home_root: deps.home_root,
        now,
        expectedRows,
        applied_registration: appliedRegistration,
        previous_registration_hash:
          previousRegistration === null
            ? null
            : (previousRegistration.registration_hash as Hash)
      });
    } else if (target.write_mode === "json_merge") {
      plannedTarget = simulateJsonMerge({
        plan: target,
        expected: expectedRows.get(target.path) ?? null
      });
    } else {
      let current: HostFileState | null;
      if (simulated.has(target.path)) {
        current = simulated.get(target.path) ?? null;
      } else {
        const read = readHostFile(target.path);
        if (!read.ok) {
          return read;
        }
        current = read.value;
        simulated.set(target.path, current);
      }
      plannedTarget = simulateSingle({
        plan: target,
        current,
        expected: expectedRows.get(target.path) ?? null
      });
      if (plannedTarget.ok) {
        const entry = plannedTarget.value.entries[0];
        if (entry !== undefined && entry.after_bytes !== null) {
          simulated.set(target.path, {
            exists: true,
            bytes: entry.after_bytes,
            mode: entry.after_mode
          });
        }
      }
    }
    if (!plannedTarget.ok) {
      return plannedTarget;
    }
    for (const entry of plannedTarget.value.entries) {
      if (plannedPaths.has(entry.path)) {
        return err(fieldError("E_CONFLICT", "path", "duplicate_attach_path"));
      }
      plannedPaths.add(entry.path);
    }
    planned.push(plannedTarget.value);
  }

  const artifactPlans = planned.filter(
    (target) => target.artifact_hash !== null && target.registration_hash !== null
  );
  if (artifactPlans.length > 1) {
    return err(
      attachError("E_CONFLICT", "host_attach_registration", {
        kind: "field",
        path: "registration",
        rule: "multiple_artifact_targets"
      })
    );
  }
  const artifactPlan = artifactPlans[0] ?? null;
  const registrationAction = artifactPlan?.registration_action ?? null;
  const registrationExpectedPrevious =
    artifactPlan?.registration_expected_previous_hash ?? null;
  const writeRegistration =
    (registrationAction === "insert" || registrationAction === "upgrade") &&
    artifactPlan !== null;
  const manifest = ensureManifest(deps, now);
  if (!manifest.ok) {
    return manifest;
  }
  const installId = manifest.value.install_id;
  let registrationApproval: HostAttachApproval | null = null;
  if (writeRegistration && artifactPlan !== null) {
    if (deps.approval_request !== undefined) {
      const consumed = await consumeAttachApproval({
        deps,
        descriptor: resolution.descriptor,
        request,
        target_id: artifactPlan.plan.target.target_id,
        artifact_hash: artifactPlan.artifact_hash as Hash,
        expected_previous_hash: registrationExpectedPrevious,
        registration_hash: artifactPlan.registration_hash as Hash,
        now
      });
      if (!consumed.ok) {
        return consumed;
      }
      registrationApproval = consumed.value;
    } else {
      registrationApproval =
        deps.approval ??
        deriveAttachApproval({
          descriptor: resolution.descriptor,
          request,
          target_id: artifactPlan.plan.target.target_id,
          artifact_hash: artifactPlan.artifact_hash as Hash,
          expected_previous_hash: registrationExpectedPrevious,
          now
        });
    }
  }
  if (registrationHash === null && artifactPlan !== null) {
    registrationHash = artifactPlan.registration_hash;
  }

  const allEntries = planned.flatMap((target) => target.entries);
  const changedEntries = allEntries.filter((entry) => !entry.no_change);
  const allNoChange = changedEntries.length === 0;

  if (allNoChange) {
    const hashes = selectHashes(planned, new Map());
    const runner = createTransactionRunner(deps.connection);
    try {
      runner.withTxSync((tx) => {
        for (const entry of allEntries) {
          casInstallPath(tx, {
            install_id: installId,
            path: entry.path,
            kind: entry.kind,
            marker_id: entry.marker_id,
            installed_hash: entry.installed_hash,
            origin_hash: entry.origin_hash,
            now,
            expected: entry.expected
          });
        }
        if (spaceConfig !== null) {
          activateConfigProfile(tx, spaceConfig, now);
        }
        if (
          writeRegistration &&
          artifactPlan !== null &&
          registrationApproval !== null &&
          hashes.config_hash !== null &&
          hashes.written_hash !== null
        ) {
          persistRegistration(tx, {
            descriptor: resolution.descriptor,
            request,
            target_id: artifactPlan.plan.target.target_id,
            registration_hash: artifactPlan.registration_hash as Hash,
            registration_action:
              artifactPlan.registration_action === "upgrade" ? "upgrade" : "insert",
            expected_previous_hash: registrationExpectedPrevious,
            artifact_hash: artifactPlan.artifact_hash as Hash,
            written_hash: hashes.written_hash,
            config_hash: hashes.config_hash,
            approval: registrationApproval,
            now
          });
        }
        if (hashes.config_hash !== null && hashes.written_hash !== null) {
          persistConfigHash(
            tx,
            request,
            hashes.config_hash,
            hashes.written_hash,
            registrationHash,
            now
          );
        }
        if (manifest.value.status !== "installed") {
          setManifestStatus(tx, installId, manifest.value.status, "installed", now);
        } else {
          touchManifest(tx, installId, now);
        }
        return null;
      });
    } catch (error) {
      if (isErrorEnvelope(error)) {
        return { ok: false, status: "rejected", error };
      }
      return err(internalError("kernel.host_attach_projection"));
    }
    notifyAttachProbe(artifactPlan, registrationHash, hashes);
    return ok(
      writeAttachResult({
        status: "no_op",
        request,
        descriptor: resolution.descriptor,
        descriptor_hash: resolution.descriptor_hash,
        install_id: installId,
        hashes,
        outcomes: planned.map((target) =>
          buildTargetOutcome(
            target.plan,
            "no_change",
            target.entries[0]?.installed_hash ?? target.written_hash,
            null
          )
        ),
        conflicts: []
      })
    );
  }

  const backups: PreparedBackup[] = [];
  const seenBackupPaths = new Set<string>();
  for (const entry of changedEntries) {
    if (
      entry.before === null ||
      !entry.before.exists ||
      seenBackupPaths.has(entry.path)
    ) {
      continue;
    }
    seenBackupPaths.add(entry.path);
    if (readActiveBackup(deps.connection, installId, entry.path) !== null) {
      continue;
    }
    const prepared = prepareBackup(deps, entry.path, entry.before.bytes);
    if (!prepared.ok) {
      return prepared;
    }
    backups.push(prepared.value);
  }

  const runner = createTransactionRunner(deps.connection);
  try {
    runner.withTxSync((tx) => {
      const status = manifest.value.status;
      if (status === "uninstalled" || status === "detaching") {
        throw fieldError("E_CONFLICT", "install_manifest.status", status);
      }
      setManifestStatus(tx, installId, status, "installing", now);
      for (const backup of backups) {
        insertBackupRows(tx, {
          backup,
          installId,
          backupId: newId("ev", now),
          now
        });
      }
      return null;
    });
  } catch (error) {
    if (isErrorEnvelope(error)) {
      return { ok: false, status: "rejected", error };
    }
    return err(internalError("kernel.host_attach_backup"));
  }

  const failures = new Map<string, ErrorEnvelope>();
  for (const entry of changedEntries) {
    if (entry.after_bytes === null) {
      continue;
    }
    const written = writeHostFile(entry.path, entry.after_bytes, entry.after_mode);
    if (!written.ok) {
      failures.set(entry.path, written.error);
    }
  }
  verifyArtifactReadback(planned, failures);

  const hashes = selectHashes(planned, failures);
  const finalStatus = failures.size === 0 ? "installed" : "failed";
  try {
    runner.withTxSync((tx) => {
      for (const entry of allEntries) {
        if (failures.has(entry.path)) {
          continue;
        }
        casInstallPath(tx, {
          install_id: installId,
          path: entry.path,
          kind: entry.kind,
          marker_id: entry.marker_id,
          installed_hash: entry.installed_hash,
          origin_hash: entry.origin_hash,
          now,
          expected: entry.expected
        });
      }
      if (spaceConfig !== null) {
        activateConfigProfile(tx, spaceConfig, now);
      }
      if (
        failures.size === 0 &&
        writeRegistration &&
        artifactPlan !== null &&
        registrationApproval !== null &&
        hashes.config_hash !== null &&
        hashes.written_hash !== null
      ) {
        persistRegistration(tx, {
          descriptor: resolution.descriptor,
          request,
          target_id: artifactPlan.plan.target.target_id,
          registration_hash: artifactPlan.registration_hash as Hash,
          registration_action:
            artifactPlan.registration_action === "upgrade" ? "upgrade" : "insert",
          expected_previous_hash: registrationExpectedPrevious,
          artifact_hash: artifactPlan.artifact_hash as Hash,
          written_hash: hashes.written_hash,
          config_hash: hashes.config_hash,
          approval: registrationApproval,
          now
        });
      }
      if (hashes.config_hash !== null && hashes.written_hash !== null) {
        persistConfigHash(
          tx,
          request,
          hashes.config_hash,
          hashes.written_hash,
          registrationHash,
          now
        );
      }
      setManifestStatus(tx, installId, "installing", finalStatus, now);
      return null;
    });
  } catch (error) {
    if (isErrorEnvelope(error)) {
      return { ok: false, status: "rejected", error: { ...error, side_effect: "partial" } };
    }
    return err(internalError("kernel.host_attach_projection", "partial"));
  }

  const outcomes: HostAttachTargetOutcome[] = planned.map((target) => {
    const failure = target.entries
      .map((entry) => failures.get(entry.path))
      .find((candidate) => candidate !== undefined);
    if (failure !== undefined) {
      return buildTargetOutcome(target.plan, "failed", target.entries[0]?.installed_hash ?? null, failure.code);
    }
    return buildTargetOutcome(
      target.plan,
      target.no_change ? "no_change" : "present",
      target.entries[0]?.installed_hash ?? target.written_hash,
      null
    );
  });
  const conflicts: HostAttachConflict[] = [];
  for (const target of planned) {
    for (const entry of target.entries) {
      const failure = failures.get(entry.path);
      if (failure !== undefined) {
        conflicts.push({
          target_id: target.plan.target.target_id,
          path: entry.path,
          code: failure.code
        });
        break;
      }
    }
  }

  notifyAttachProbe(artifactPlan, registrationHash, hashes);
  return ok(
    writeAttachResult({
      status: failures.size > 0 ? "partial" : "attached",
      request,
      descriptor: resolution.descriptor,
      descriptor_hash: resolution.descriptor_hash,
      install_id: installId,
      hashes,
      outcomes,
      conflicts
    })
  );
}

/* ------------------------------------------------------------------ */
/* Detach                                                              */
/* ------------------------------------------------------------------ */

interface DetachAction {
  readonly row: InstallPathRow;
  readonly path: string;
  /** `install_path.state` after the action; `null` keeps the current state. */
  readonly state: "removed" | "restored" | "missing" | "modified_by_user" | null;
  readonly outcome: HostAttachTargetState;
  readonly after_bytes: Uint8Array | null;
  readonly after_mode: number;
  readonly remove_file: boolean;
  readonly remove_directory: boolean;
  readonly backup: InstallBackupRow | null;
  readonly conflict: boolean;
  readonly conflict_code: string | null;
  readonly target_id: string;
}

interface DetachIdentity {
  readonly adapter_id: AdapterDescriptor["adapter_id"] | null;
  readonly adapter_version: string | null;
  readonly descriptor_hash: Hash | null;
  readonly targets_by_path: Map<string, HostAttachTargetPlan>;
}

interface DetachIdentityRow extends SqlRow {
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly descriptor_hash: string;
}

function readRegistrationIdentity(
  connection: SqliteConnection,
  request: HostAttachRequest
): DetachIdentityRow | null {
  try {
    const row = connection
      .prepare<DetachIdentityRow>(
        `SELECT adapter_id, adapter_version, descriptor_hash
           FROM adapter_registration
          WHERE host_id = :host_id
            AND mode = :mode
            AND config_space = :config_space
          ORDER BY created_at DESC
          LIMIT 1`
      )
      .get({
        host_id: request.host_id,
        mode: request.mode,
        config_space: request.config_space
      });
    return row ?? null;
  } catch {
    return null;
  }
}

async function resolveDetachIdentity(
  deps: HostAttachDeps,
  request: HostAttachRequest
): Promise<DetachIdentity> {
  const targetsByPath = new Map<string, HostAttachTargetPlan>();
  let descriptor: AdapterDescriptor | null = null;
  if (deps.registry !== undefined) {
    try {
      const outcome = deps.registry.resolve(request);
      const resolved = isPromiseLike(outcome) ? await outcome : outcome;
      if (resolved.ok && resolved.value !== null) {
        descriptor = resolved.value.descriptor;
        for (const target of resolved.value.targets) {
          targetsByPath.set(target.path, target);
        }
      }
    } catch {
      descriptor = null;
    }
  }
  if (descriptor !== null) {
    return {
      adapter_id: descriptor.adapter_id,
      adapter_version: descriptor.adapter_version,
      descriptor_hash: adapterDescriptorHash(descriptor),
      targets_by_path: targetsByPath
    };
  }
  const row = readRegistrationIdentity(deps.connection, request);
  return {
    adapter_id: row === null ? null : (row.adapter_id as AdapterDescriptor["adapter_id"]),
    adapter_version: row?.adapter_version ?? null,
    descriptor_hash:
      row !== null && isHash(row.descriptor_hash) ? row.descriptor_hash : null,
    targets_by_path: targetsByPath
  };
}

function hasManagedAncestor(path: string, directories: ReadonlySet<string>): boolean {
  let directory = dirname(path);
  while (true) {
    if (directories.has(directory)) {
      return true;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return false;
    }
    directory = parent;
  }
}

function detachTargetId(
  row: InstallPathRow,
  identity: DetachIdentity,
  directories: ReadonlySet<string>
): string {
  const exact = identity.targets_by_path.get(row.path);
  if (exact !== undefined) {
    return exact.target.target_id;
  }
  let directory = dirname(row.path);
  while (true) {
    const target = identity.targets_by_path.get(directory);
    if (target !== undefined) {
      return target.target.target_id;
    }
    if (directories.has(directory)) {
      const rootTarget = identity.targets_by_path.get(directory);
      if (rootTarget !== undefined) {
        return rootTarget.target.target_id;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return row.marker_id ?? row.kind;
}

function detachOutcomeKind(row: InstallPathRow): HostAttachTargetOutcome["kind"] {
  switch (row.kind) {
    case "host_config_block":
      return "host_config_block";
    case "host_registration":
      return "host_registration";
    case "directory":
    case "file":
      return "runtime_artifact";
    default:
      return "host_registration";
  }
}

/**
 * Ownership data for a shared JSON file on detach.
 *
 * `entries` is non-null only when the current registry resolves the same target
 * and therefore tells us exactly which entry values attach wrote. Without it,
 * ownership of an entry inside a modified file is undecidable and detach must
 * keep the file instead of guessing.
 */
interface JsonMergeDetachPlan {
  readonly selectors: readonly string[];
  readonly entries: readonly HostAttachJsonMergeEntry[] | null;
}

function jsonMergePlansForDetach(
  actions: readonly { readonly row: InstallPathRow }[],
  identity: DetachIdentity,
  directories: ReadonlySet<string>
): Map<string, JsonMergeDetachPlan> {
  const byPath = new Map<string, JsonMergeDetachPlan>();
  for (const action of actions) {
    const row = action.row;
    if (row.kind !== "file" || hasManagedAncestor(row.path, directories)) {
      continue;
    }
    const plan = identity.targets_by_path.get(row.path);
    if (plan !== undefined && plan.write_mode === "json_merge" && plan.selector !== undefined) {
      byPath.set(row.path, {
        selectors: [plan.selector],
        entries: plan.entries ?? []
      });
      continue;
    }
    // Without a current plan, an artifact root recorded by the same install is
    // the only trustworthy selector; expected entry values stay unknown.
    const current = readHostFile(row.path);
    if (!current.ok || current.value === null) {
      continue;
    }
    let text = "";
    try {
      text = decodeContent(current.value.bytes);
    } catch {
      text = "";
    }
    const selectors: string[] = [];
    for (const directory of [...directories].sort(
      (left, right) => right.length - left.length
    )) {
      if (text.includes(directory)) {
        selectors.push(directory);
      }
    }
    if (selectors.length > 0) {
      byPath.set(row.path, { selectors, entries: null });
    }
  }
  return byPath;
}

async function detach(
  deps: HostAttachDeps,
  request: HostAttachRequest
): Promise<Result<HostDetachResult, ErrorEnvelope>> {
  const depsError = validateDeps(deps);
  if (depsError !== null) {
    return err(depsError);
  }
  const validRequest = validateRequest(request);
  if (!validRequest.ok) {
    return validRequest;
  }
  const identity = await resolveDetachIdentity(deps, request);
  const manifest = readManifest(deps.connection, deps.home_root);
  if (manifest === null) {
    return ok({
      schema_version: DETACH_RESULT_SCHEMA,
      status: "no_op",
      host_id: request.host_id,
      mode: request.mode,
      config_space: request.config_space,
      adapter_id: identity.adapter_id,
      adapter_version: identity.adapter_version,
      descriptor_hash: identity.descriptor_hash,
      install_id: "",
      targets: [],
      conflicts: []
    });
  }
  const now = (deps.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0) {
    return err(internalError("kernel.host_detach_clock"));
  }
  const rows = readInstallPaths(deps.connection, manifest.install_id);
  const directories = new Set(
    [...rows.values()].filter((row) => row.kind === "directory").map((row) => row.path)
  );

  const productRoot = manifest.install_root.replace(/[\\/]+$/u, "");
  const orderedRows = [...rows.values()].filter(
    (row) =>
      row.state !== "removed" &&
      row.state !== "restored" &&
      // Product installation rows belong to `uninstall`, not host detach.
      !(productRoot !== null && (row.path === productRoot || row.path.startsWith(productRoot + sep)))
  );
  orderedRows.sort((left, right) => {
    if (left.kind === "directory" && right.kind !== "directory") {
      return 1;
    }
    if (right.kind === "directory" && left.kind !== "directory") {
      return -1;
    }
    if (left.kind === "directory" && right.kind === "directory") {
      return right.path.length - left.path.length || compareUtf8(left.path, right.path);
    }
    return compareUtf8(left.path, right.path);
  });

  const jsonMergePlans = jsonMergePlansForDetach(
    orderedRows.map((row) => ({ row })),
    identity,
    directories
  );
  const acts: DetachAction[] = [];
  const simulated = new Map<string, HostFileState | null>();
  const failures = new Map<string, ErrorEnvelope>();

  for (const row of orderedRows) {
    const targetId = detachTargetId(row, identity, directories);
    const base = {
      row,
      path: row.path,
      target_id: targetId,
      backup: null as InstallBackupRow | null
    };
    if (row.kind === "directory") {
      // Directories are removed after every recorded file is gone, so an
      // otherwise empty product directory is not left behind by ordering.
      continue;
    }

    let current: HostFileState | null;
    if (simulated.has(row.path)) {
      current = simulated.get(row.path) ?? null;
    } else {
      const read = readHostFile(row.path);
      if (!read.ok) {
        return read;
      }
      current = read.value;
      simulated.set(row.path, current);
    }
    const backup = readActiveBackup(deps.connection, manifest.install_id, row.path);
    const withBackup = { ...base, backup };

    if (row.state === "modified_by_user") {
      acts.push({
        ...withBackup,
        state: null,
        outcome: "modified_by_user",
        after_bytes: null,
        after_mode: current?.mode ?? 0o600,
        remove_file: false,
        remove_directory: false,
        conflict: true,
        conflict_code: "E_INSTALL_CONFLICT"
      });
      continue;
    }

    if (current === null) {
      acts.push({
        ...withBackup,
        state: "missing",
        outcome: "missing",
        after_bytes: null,
        after_mode: 0o600,
        remove_file: false,
        remove_directory: false,
        conflict: false,
        conflict_code: null
      });
      continue;
    }

    const installedHash = row.installed_hash;
    if (installedHash === null || !isHash(installedHash)) {
      acts.push({
        ...withBackup,
        state: "modified_by_user",
        outcome: "modified_by_user",
        after_bytes: null,
        after_mode: current.mode,
        remove_file: false,
        remove_directory: false,
        conflict: true,
        conflict_code: "E_INSTALL_CONFLICT"
      });
      continue;
    }

    if (row.kind === "host_config_block") {
      const selector = row.marker_id;
      if (selector === null) {
        acts.push({
          ...withBackup,
          state: "modified_by_user",
          outcome: "modified_by_user",
          after_bytes: null,
          after_mode: current.mode,
          remove_file: false,
          remove_directory: false,
          conflict: true,
          conflict_code: "E_INSTALL_CONFLICT"
        });
        continue;
      }
      const existing = findBlock(current.bytes, selector);
      if (!existing.ok) {
        return existing;
      }
      if (existing.value === null) {
        acts.push({
          ...withBackup,
          state: "removed",
          outcome: "removed",
          after_bytes: null,
          after_mode: current.mode,
          remove_file: false,
          remove_directory: false,
          conflict: false,
          conflict_code: null
        });
        continue;
      }
      if (existing.value.block_hash !== installedHash) {
        acts.push({
          ...withBackup,
          state: "modified_by_user",
          outcome: "modified_by_user",
          after_bytes: null,
          after_mode: current.mode,
          remove_file: false,
          remove_directory: false,
          conflict: true,
          conflict_code: "E_INSTALL_CONFLICT"
        });
        continue;
      }
      const edited = applyManagedBlockEdit({
        bytes: current.bytes,
        selector,
        block_action: "detach",
        content: null
      });
      if (!edited.ok) {
        return edited;
      }
      let restored = false;
      if (backup !== null) {
        const backupBytes = readBackupBytes(deps, backup);
        if (!backupBytes.ok) {
          return backupBytes;
        }
        restored = bytesEqual(edited.value.bytes, backupBytes.value);
      }
      acts.push({
        ...withBackup,
        state: restored ? "restored" : "removed",
        outcome: restored ? "restored" : "removed",
        after_bytes: edited.value.bytes,
        after_mode: current.mode,
        remove_file: false,
        remove_directory: false,
        conflict: false,
        conflict_code: null
      });
      simulated.set(row.path, {
        exists: true,
        bytes: edited.value.bytes,
        mode: current.mode
      });
      continue;
    }

    const artifactMember = hasManagedAncestor(row.path, directories);
    const mergePlan = jsonMergePlans.get(row.path);
    const selectors = mergePlan?.selectors;

    if (hashBytes(current.bytes) !== installedHash) {
      // A shared JSON file modified after attach still belongs to the user.
      // Remove only entries that are provably ours and unchanged; an owned
      // entry that no longer matches the plan is undecidable and must not be
      // overwritten or removed (DD-FND-102 rules 4 and 6).
      if (
        !artifactMember &&
        row.kind === "file" &&
        mergePlan !== undefined &&
        mergePlan.entries !== null &&
        mergePlan.selectors.length > 0
      ) {
        const document = readJsonDocument(row.path);
        if (!document.ok) {
          acts.push({
            ...withBackup,
            state: "modified_by_user",
            outcome: "modified_by_user",
            after_bytes: null,
            after_mode: current.mode,
            remove_file: false,
            remove_directory: false,
            conflict: true,
            conflict_code: "E_INSTALL_CONFLICT"
          });
          continue;
        }
        const parsedDocument = document.value;
        const expected = mergePlan.entries.map((entry) => entry.value);
        const cleaned = removeOwnedEntriesMatching(
          parsedDocument.value,
          mergePlan.selectors[0] as string,
          expected
        );
        if (cleaned.conflict || !isJsonObject(cleaned.value)) {
          acts.push({
            ...withBackup,
            state: "modified_by_user",
            outcome: "modified_by_user",
            after_bytes: null,
            after_mode: current.mode,
            remove_file: false,
            remove_directory: false,
            conflict: true,
            conflict_code: "E_INSTALL_CONFLICT"
          });
          continue;
        }
        let origin: JsonValue | null | undefined;
        let backupValue: Uint8Array | null = null;
        if (backup === null) {
          origin = null;
        } else {
          const backupBytes = readBackupBytes(deps, backup);
          if (!backupBytes.ok) {
            return backupBytes;
          }
          backupValue = backupBytes.value;
          try {
            const parsed: unknown = JSON.parse(decodeContent(backupValue));
            origin = isJsonObject(parsed) ? parsed : undefined;
          } catch {
            origin = undefined;
          }
        }
        const pointers: string[][] = [];
        for (const entry of mergePlan.entries) {
          const tokens = decodeJsonPointer(entry.pointer);
          if (tokens !== null) {
            pointers.push(tokens);
          }
        }
        const pruned = pruneVacatedPointers(cleaned.value, pointers, origin);
        if (!isJsonObject(pruned)) {
          acts.push({
            ...withBackup,
            state: "modified_by_user",
            outcome: "modified_by_user",
            after_bytes: null,
            after_mode: current.mode,
            remove_file: false,
            remove_directory: false,
            conflict: true,
            conflict_code: "E_INSTALL_CONFLICT"
          });
          continue;
        }
        if (backup === null && isEmptyJsonValue(pruned)) {
          acts.push({
            ...withBackup,
            state: "removed",
            outcome: "removed",
            after_bytes: null,
            after_mode: current.mode,
            remove_file: true,
            remove_directory: false,
            conflict: false,
            conflict_code: null
          });
          simulated.set(row.path, null);
          continue;
        }
        const afterBytes = serializeJsonDocument(pruned, parsedDocument);
        if (bytesEqual(afterBytes, current.bytes)) {
          // Nothing of ours is left and no user content changed: keep the
          // bytes as they are and record the row as detached.
          acts.push({
            ...withBackup,
            state: "removed",
            outcome: "removed",
            after_bytes: null,
            after_mode: current.mode,
            remove_file: false,
            remove_directory: false,
            conflict: false,
            conflict_code: null
          });
          continue;
        }
        const restored = backupValue !== null && bytesEqual(afterBytes, backupValue);
        acts.push({
          ...withBackup,
          state: restored ? "restored" : "removed",
          outcome: restored ? "restored" : "removed",
          after_bytes: afterBytes,
          after_mode: current.mode,
          remove_file: false,
          remove_directory: false,
          conflict: false,
          conflict_code: null
        });
        simulated.set(row.path, {
          exists: true,
          bytes: afterBytes,
          mode: current.mode
        });
        continue;
      }
      acts.push({
        ...withBackup,
        state: "modified_by_user",
        outcome: "modified_by_user",
        after_bytes: null,
        after_mode: current.mode,
        remove_file: false,
        remove_directory: false,
        conflict: true,
        conflict_code: "E_INSTALL_CONFLICT"
      });
      continue;
    }

    if (backup !== null && !artifactMember) {
      const backupBytes = readBackupBytes(deps, backup);
      if (!backupBytes.ok) {
        return backupBytes;
      }
      acts.push({
        ...withBackup,
        state: "restored",
        outcome: "restored",
        after_bytes: backupBytes.value,
        after_mode: current.mode,
        remove_file: false,
        remove_directory: false,
        conflict: false,
        conflict_code: null
      });
      simulated.set(row.path, {
        exists: true,
        bytes: backupBytes.value,
        mode: current.mode
      });
      continue;
    }

    if (!artifactMember && selectors !== undefined && selectors.length > 0) {
      const document = readJsonDocument(row.path);
      if (!document.ok) {
        return document;
      }
      let merged: { readonly value: { [key: string]: JsonValue } } | null = null;
      for (const selector of selectors) {
        merged = mergeJsonDocument(document.value, selector, [], true);
        if (merged !== null) {
          break;
        }
      }
      if (merged === null) {
        acts.push({
          ...withBackup,
          state: "modified_by_user",
          outcome: "modified_by_user",
          after_bytes: null,
          after_mode: current.mode,
          remove_file: false,
          remove_directory: false,
          conflict: true,
          conflict_code: "E_INSTALL_CONFLICT"
        });
        continue;
      }
      if (backup === null && isEmptyJsonValue(merged.value)) {
        acts.push({
          ...withBackup,
          state: "removed",
          outcome: "removed",
          after_bytes: null,
          after_mode: current.mode,
          remove_file: true,
          remove_directory: false,
          conflict: false,
          conflict_code: null
        });
        simulated.set(row.path, null);
        continue;
      }
      const afterBytes = serializeJsonDocument(merged.value, document.value);
      acts.push({
        ...withBackup,
        state: "removed",
        outcome: "removed",
        after_bytes: afterBytes,
        after_mode: current.mode,
        remove_file: false,
        remove_directory: false,
        conflict: false,
        conflict_code: null
      });
      simulated.set(row.path, {
        exists: true,
        bytes: afterBytes,
        mode: current.mode
      });
      continue;
    }

    if (!artifactMember && selectors !== undefined && selectors.length === 0) {
      acts.push({
        ...withBackup,
        state: "modified_by_user",
        outcome: "modified_by_user",
        after_bytes: null,
        after_mode: current.mode,
        remove_file: false,
        remove_directory: false,
        conflict: true,
        conflict_code: "E_INSTALL_CONFLICT"
      });
      continue;
    }

    if (row.kind === "file" && !artifactMember && selectors === undefined) {
      // A shared JSON row whose artifact-root selector cannot be recovered is
      // preserved instead of being deleted or rewritten (DD-FND-102 rule 4).
      acts.push({
        ...withBackup,
        state: "modified_by_user",
        outcome: "modified_by_user",
        after_bytes: null,
        after_mode: current.mode,
        remove_file: false,
        remove_directory: false,
        conflict: true,
        conflict_code: "E_INSTALL_CONFLICT"
      });
      continue;
    }

    acts.push({
      ...withBackup,
      state: "removed",
      outcome: "removed",
      after_bytes: null,
      after_mode: current.mode,
      remove_file: true,
      remove_directory: false,
      conflict: false,
      conflict_code: null
    });
    simulated.set(row.path, null);
  }

  for (const action of acts) {
    if (action.conflict) {
      continue;
    }
    if (action.remove_directory) {
      continue;
    }
    if (action.remove_file) {
      const removed = removeHostFile(action.path);
      if (!removed.ok) {
        failures.set(action.path, removed.error);
      }
      continue;
    }
    if (action.after_bytes !== null) {
      const written = writeHostFile(action.path, action.after_bytes, action.after_mode);
      if (!written.ok) {
        failures.set(action.path, written.error);
      }
    }
  }

  // Empty product directories are removed only after every recorded file has
  // been handled, deepest first.
  for (const row of orderedRows.filter((candidate) => candidate.kind === "directory")) {
    const base = {
      row,
      path: row.path,
      target_id: detachTargetId(row, identity, directories),
      backup: null as InstallBackupRow | null
    };
    const removal = removeEmptyDirectory(row.path);
    if (removal === "removed") {
      acts.push({
        ...base,
        state: "removed",
        outcome: "removed",
        after_bytes: null,
        after_mode: 0o700,
        remove_file: false,
        remove_directory: false,
        conflict: false,
        conflict_code: null
      });
    } else if (removal === "missing") {
      acts.push({
        ...base,
        state: "missing",
        outcome: "missing",
        after_bytes: null,
        after_mode: 0o700,
        remove_file: false,
        remove_directory: false,
        conflict: false,
        conflict_code: null
      });
    } else if (removal === "not_empty") {
      // A directory that still holds user files is preserved; this is not a
      // detach failure (DD-FND-102 rule 6 removes empty product dirs only).
      acts.push({
        ...base,
        state: null,
        outcome: "modified_by_user",
        after_bytes: null,
        after_mode: 0o700,
        remove_file: false,
        remove_directory: false,
        conflict: false,
        conflict_code: null
      });
    } else if (removal === "not_directory") {
      acts.push({
        ...base,
        state: "modified_by_user",
        outcome: "modified_by_user",
        after_bytes: null,
        after_mode: 0o700,
        remove_file: false,
        remove_directory: false,
        conflict: true,
        conflict_code: "E_INSTALL_CONFLICT"
      });
    } else {
      failures.set(
        row.path,
        attachError("E_IO", "host_detach_remove", {
          kind: "field",
          path: "path",
          rule: "rmdir_failed"
        })
      );
      acts.push({
        ...base,
        state: null,
        outcome: "failed",
        after_bytes: null,
        after_mode: 0o700,
        remove_file: false,
        remove_directory: false,
        conflict: false,
        conflict_code: null
      });
    }
  }

  let registrationHash: Hash | null = null;
  let registrationConflict = false;
  const runner = createTransactionRunner(deps.connection);
  try {
    registrationHash = runner.withTxSync<Hash | null>((tx) => {
      for (const action of acts) {
        if (action.state === null || failures.has(action.path)) {
          continue;
        }
        if (action.state !== action.row.state) {
          updateDetachedPath(tx, {
            row: action.row,
            state: action.state,
            now
          });
        }
        if (action.backup !== null && (action.state === "restored" || action.state === "removed")) {
          tombstoneBackup(tx, action.backup.backup_id, now);
        }
      }
      touchManifest(tx, manifest.install_id, now);
      const applied = readAppliedRegistrations(deps.connection, request);
      if (applied.length > 1) {
        registrationConflict = true;
        return null;
      }
      const row = applied[0];
      if (row === undefined) {
        return null;
      }
      const transition = tx
        .prepare(
          `UPDATE adapter_registration
              SET state = 'detached', updated_at = :now, row_version = row_version + 1
            WHERE registration_hash = :registration_hash AND state = 'applied'`
        )
        .run({ now, registration_hash: row.registration_hash });
      if (transition.changes !== 1) {
        registrationConflict = true;
        return null;
      }
      return isHash(row.registration_hash) ? row.registration_hash : null;
    });
  } catch (error) {
    if (isErrorEnvelope(error)) {
      return { ok: false, status: "rejected", error: { ...error, side_effect: "partial" } };
    }
    return err(internalError("kernel.host_detach_projection", "partial"));
  }

  const conflicts: HostAttachConflict[] = [];
  for (const action of acts) {
    const failure = failures.get(action.path);
    if (failure !== undefined) {
      conflicts.push({
        target_id: action.target_id,
        path: action.path,
        code: failure.code
      });
      continue;
    }
    if (action.conflict) {
      conflicts.push({
        target_id: action.target_id,
        path: action.path,
        code: action.conflict_code ?? "E_INSTALL_CONFLICT"
      });
    }
  }

  if (registrationConflict) {
    conflicts.push({
      target_id: "adapter_registration",
      path: "adapter_registration",
      code: "E_CONFLICT"
    });
  }

  if (registrationHash !== null && deps.sessions !== undefined) {
    try {
      const outcome = deps.sessions.revokeBindingSessions(registrationHash);
      const revoked = isPromiseLike(outcome) ? await outcome : outcome;
      if (!revoked.ok) {
        conflicts.push({
          target_id: "adapter_registration",
          path: "host_runtime_session",
          code: revoked.error.code
        });
      }
    } catch {
      conflicts.push({
        target_id: "adapter_registration",
        path: "host_runtime_session",
        code: "E_INTERNAL"
      });
    }
  }

  const outcomes: HostAttachTargetOutcome[] = acts.map((action) => {
    if (failures.has(action.path)) {
      return {
        target_id: action.target_id,
        path: action.path,
        marker_id: action.row.marker_id,
        kind: detachOutcomeKind(action.row),
        state: "failed",
        installed_hash:
          action.row.installed_hash !== null && isHash(action.row.installed_hash)
            ? action.row.installed_hash
            : null,
        error_code: failures.get(action.path)?.code ?? "E_INTERNAL"
      };
    }
    return {
      target_id: action.target_id,
      path: action.path,
      marker_id: action.row.marker_id,
      kind: detachOutcomeKind(action.row),
      state: action.outcome,
      installed_hash:
        action.row.installed_hash !== null && isHash(action.row.installed_hash)
          ? action.row.installed_hash
          : null,
      error_code: action.conflict ? action.conflict_code ?? "E_INSTALL_CONFLICT" : null
    };
  });

  const didWork =
    registrationHash !== null ||
    acts.some(
      (action) =>
        action.state !== null ||
        action.after_bytes !== null ||
        action.remove_file ||
        action.remove_directory
    );
  const status: HostDetachResult["status"] =
    conflicts.length > 0 || failures.size > 0
      ? "partial"
      : didWork
        ? "detached"
        : "no_op";
  return ok({
    schema_version: DETACH_RESULT_SCHEMA,
    status,
    host_id: request.host_id,
    mode: request.mode,
    config_space: request.config_space,
    adapter_id: identity.adapter_id,
    adapter_version: identity.adapter_version,
    descriptor_hash: identity.descriptor_hash,
    install_id: manifest.install_id,
    targets: outcomes,
    conflicts
  });
}

/* ------------------------------------------------------------------ */
/* Factories                                                           */
/* ------------------------------------------------------------------ */

/** Builds the `evolve attach` operation over the supplied ports. */
export function attachHost(deps: HostAttachDeps): HostAttachOperation {
  return async (request: HostAttachRequest) => attach(deps, request);
}

/** Builds the `evolve detach` operation over the supplied ports. */
export function detachHost(deps: HostAttachDeps): HostDetachOperation {
  return async (request: HostAttachRequest) => detach(deps, request);
}
