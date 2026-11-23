/**
 * Runtime approved-root registry and resolver (DD-FND-095.0, DD-FND-102).
 *
 * The registry is the only producer of the execution-time
 * `root_id -> approved_root` map used by `write.apply` and `write.config`.
 * A root is registered by the HOST activation flow after the matching adapter
 * registration reached `applied`; the kernel never discovers, guesses or
 * searches for a root path.
 *
 * Absolute paths are call-stack values. `transient_path` is admitted only for
 * the duration of `register`, and the approved path lives only in this
 * process's memory. Neither may enter a journal frame, SQLite, a hash, an
 * error envelope or a log line.
 *
 * Two details are deliberately structural:
 *
 *   - `root_id` is recomputed from the native root evidence and the live
 *     identity pin with the exact DD-HOST-001 preimage. `@evoplug/core` does
 *     not re-export `rootIdFromNative` from its package root, so the formula
 *     is mirrored here byte for byte; the pin itself is the shared
 *     `RootIdentityPin` type, never a second shape.
 *   - Journal frames use `binding=null` and `rsi.root_registration_row/1`, as
 *     required for the two root registration event types. The frame is
 *     fsynced before the short SQLite projection.
 */

import { lstatSync, realpathSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { join, isAbsolute, normalize, parse as parsePath, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import type {
  AdapterInstallSubject,
  ErrorCategory,
  ErrorDetails,
  ErrorEnvelope,
  FailureStatus,
  Hash,
  HostId,
  HostMode,
  Id,
  JsonValue,
  Result,
  RootIdentityKind,
  RootIdentityPin,
  RootRegistrationPort,
  RootRegistrationResult,
  RootResolver,
  Tx
} from "@evoplug/core";
import {
  canonicalHash,
  canonicalJsonText,
  err,
  isHash,
  isHostId,
  isHostMode,
  isId,
  isSourceRef,
  makeErrorEnvelope,
  newId,
  ok,
  toJsonValue
} from "@evoplug/core";
import {
  JournalWriter,
  createJournalCommitter,
  listJournalStates,
  type JournalCommitter,
  type SqliteConnection
} from "@evoplug/storage";

import { homeLayout, type HomeLayout } from "./home.js";
import type { InstallReadinessPort, InstallReadinessView } from "./install-service.js";
import type { WriteApplyRootResolverPort } from "./write-apply.js";

/* ------------------------------------------------------------------ */
/* Public row and port shapes                                         */
/* ------------------------------------------------------------------ */

/** Complete physical row for `root_registration` (DD-FND-102). */
interface RootRegistrationRowShape {
  readonly schema_version: "rsi.root_registration_row/1";
  readonly root_id: string;
  readonly registration_hash: Hash;
  readonly host_id: HostId;
  readonly mode: HostMode;
  readonly config_space: string;
  readonly adapter_id: Id<"adp">;
  readonly native_root_ref: string;
  readonly identity_kind: RootIdentityKind;
  readonly device_id: string;
  readonly file_id: string;
  readonly registered_at: number;
  readonly row_version: number;
}

/** `RootRegistrationPort.register` input (DD-FND-095.0). */
export interface RootRegistrationInput {
  readonly request_id: string;
  readonly registration_hash: Hash;
  readonly root_id: string;
  readonly host_id: HostId;
  readonly mode: HostMode;
  readonly config_space: string;
  readonly adapter_id: Id<"adp">;
  readonly native_root_ref: string;
  /** Call-stack only: never persisted, journalled, hashed or echoed. */
  readonly transient_path: string;
  readonly identity_pin: { readonly device_id: string; readonly file_id: string };
}

/** A persisted root loaded into the runtime map. */
export interface RootRegistryEntry {
  readonly root_id: string;
  readonly registration_hash: Hash;
  readonly host_id: HostId;
  readonly mode: HostMode;
  readonly config_space: string;
  readonly adapter_id: Id<"adp">;
  readonly native_root_ref: string;
  readonly identity_kind: RootIdentityKind;
  readonly device_id: string;
  readonly file_id: string;
  readonly registered_at: number;
  readonly row_version: number;
  /**
   * Live approved directory for this process. `null` means the row was loaded
   * but this process has not observed the root again; resolution stays
   * `E_ROOT_NOT_FOUND` until an activation registration attaches the path.
   */
  readonly approved_root: string | null;
}

/** A persisted row rejected during boot. Contains no path. */
interface RootBootFailure {
  readonly root_id: string;
  readonly code: "E_ROOT_INVALID" | "E_ROOT_UNAVAILABLE" | "E_ROOT_IDENTITY_MISMATCH";
}

export interface RootRegistry extends RootRegistrationPort {
  register(input: RootRegistrationInput): Promise<Result<RootRegistrationResult, ErrorEnvelope>>;
  /** Runtime map lookup used by `createRootResolver`; not an IPC surface. */
  lookup(root_id: string): Result<RootRegistryEntry, ErrorEnvelope>;
  /** Rows present in SQLite that could not be loaded at boot. */
  readonly boot_failures: readonly RootBootFailure[];
}

interface RootRegistryDeps {
  /** The single kernel writer connection. */
  readonly connection: SqliteConnection;
  /** FND journal committer. Built from `home`/`layout` when omitted. */
  readonly journal?: JournalCommitter;
  /** Product home, used only to locate the journal when `journal` is omitted. */
  readonly home?: string;
  readonly layout?: HomeLayout;
  readonly now: () => number;
  /**
   * HOST-owned boot mapping of `root_id` to the live approved directory
   * observed by the activation flow in this process. Never persisted and
   * never logged. A row without an entry stays registered but unresolved.
   */
  readonly approved_roots?: ReadonlyMap<string, string>;
  /**
   * HOST read-only readiness port (DD-FND-102). When supplied, `register`
   * verifies the applied registration and the exact `host_contract` /
   * `product_adapter` evidence itself instead of trusting the caller.
   */
  readonly install_readiness?: InstallReadinessPort;
}

interface RootResolveInput {
  readonly root_id: string;
  readonly request_id: string;
  readonly deadline_ms: number;
  readonly signal?: AbortSignal;
}

/** Superset of `WriteApplyRootResolution` and CFG's `ResolvedRoot`. */
interface RootResolution {
  readonly root_id: string;
  readonly approved_root: string;
  readonly root_identity_pin: RootIdentityPin;
  readonly root_registration_hash: Hash;
  readonly evidence_ref: string;
  readonly resolved_at: number;
}

/** FND resolver; structurally satisfies `RootResolver` and `WriteApplyRootResolverPort`. */
interface RootRegistryResolver extends RootResolver, WriteApplyRootResolverPort {
  resolve(input: RootResolveInput): Promise<Result<RootResolution, ErrorEnvelope>>;
}

interface RootResolverDeps {
  readonly registry: RootRegistry;
  /** Wall clock used for `resolved_at`; never enters a hash. */
  readonly now?: () => number;
  /** Monotonic source for deadline accounting. */
  readonly monotonic?: () => number;
}

/* ------------------------------------------------------------------ */
/* Error construction                                                 */
/* ------------------------------------------------------------------ */

type RootFailureCode =
  | "E_ROOT_NOT_FOUND"
  | "E_ROOT_UNAVAILABLE"
  | "E_ROOT_INVALID"
  | "E_ROOT_AMBIGUOUS"
  | "E_ROOT_IDENTITY_MISMATCH"
  | "E_DEADLINE_EXCEEDED"
  | "E_CANCELLED";

const ROOT_ERROR_META: Readonly<
  Record<RootFailureCode, { readonly category: ErrorCategory; readonly retryable: boolean; readonly message_key: string }>
> = {
  E_ROOT_NOT_FOUND: { category: "not_found", retryable: false, message_key: "error.root.not_found" },
  E_ROOT_UNAVAILABLE: { category: "source", retryable: true, message_key: "error.root.unavailable" },
  E_ROOT_INVALID: { category: "schema", retryable: false, message_key: "error.root.invalid" },
  E_ROOT_AMBIGUOUS: { category: "conflict", retryable: false, message_key: "error.root.ambiguous" },
  E_ROOT_IDENTITY_MISMATCH: {
    category: "conflict",
    retryable: false,
    message_key: "error.root.identity_mismatch"
  },
  E_DEADLINE_EXCEEDED: { category: "deadline", retryable: true, message_key: "error.deadline.exceeded" },
  E_CANCELLED: { category: "deadline", retryable: false, message_key: "error.request.cancelled" }
};

function rootFailureEnvelope(code: RootFailureCode, stage: string, details: ErrorDetails): ErrorEnvelope {
  const meta = ROOT_ERROR_META[code];
  return makeErrorEnvelope({
    code,
    category: meta.category,
    message_key: meta.message_key,
    stage,
    details,
    retryable: meta.retryable,
    side_effect: "none"
  });
}

function rootFailure(
  code: RootFailureCode,
  stage: string,
  details: ErrorDetails,
  status: FailureStatus
): Result<never, ErrorEnvelope> {
  return err(rootFailureEnvelope(code, stage, details), status);
}

function rootFieldFailure(
  code: RootFailureCode,
  path: string,
  rule: string,
  stage = "root_resolve",
  status: FailureStatus = "rejected"
): Result<never, ErrorEnvelope> {
  return rootFailure(code, stage, { kind: "field", path, rule }, status);
}

function rootPlainFailure(
  code: RootFailureCode,
  stage: string,
  status: FailureStatus = "rejected"
): Result<never, ErrorEnvelope> {
  return rootFailure(code, stage, { kind: "none" }, status);
}

function storageFailure(operation: string): Result<never, ErrorEnvelope> {
  return rootFailure("E_ROOT_UNAVAILABLE", "root_register", { kind: "storage", operation }, "degraded");
}

/* ------------------------------------------------------------------ */
/* Identity helpers                                                   */
/* ------------------------------------------------------------------ */

const CONFIG_SPACE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const UNSIGNED_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const OPAQUE_ASCII_PATTERN = /^[\x21-\x7e]{1,256}$/;
const MAX_ROOT_ID_BYTES = 256;

/**
 * A root registration names a host-native directory. Host paths are not
 * SourceRefs (DD-FND-032 forbids host-mutable absolute paths in one), so the
 * persisted form also accepts an absolute `file://` URI. Managed roots written
 * by `attach` use that form; journal/blob refs remain legal for install roots.
 */
function isNativeRootRef(value: string): boolean {
  if (isSourceRef(value)) return true;
  if (!value.startsWith("file://")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "file:" && url.pathname.length > 1 && !value.includes("\u0000");
  } catch {
    return false;
  }
}

function rootIdSyntaxError(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return "non_empty_string";
  }
  if (value.includes("\u0000")) {
    return "no_nul";
  }
  if (value.includes("/") || value.includes("\\")) {
    return "no_path_separator";
  }
  if (value === "." || value === "..") {
    return "not_dot_segment";
  }
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith("\\\\") || value.startsWith("//")) {
    return "not_absolute_or_drive_or_unc";
  }
  if (new TextEncoder().encode(value).byteLength > MAX_ROOT_ID_BYTES) {
    return "max_256_utf8_bytes";
  }
  return null;
}

function isRootId(value: string): boolean {
  return rootIdSyntaxError(value) === null;
}

/**
 * DD-HOST-001 `root_id` formula. Mirrors `nativeRootId` in
 * `packages/core/src/host/keys.ts`; the package root does not re-export it.
 */
function rootIdFromNative(input: {
  readonly host_id: string;
  readonly mode: string;
  readonly config_space: string;
  readonly native_root_ref: string;
  readonly identity_pin: { readonly device_id: string; readonly file_id: string };
}): string {
  const hash = canonicalHash({
    schema_version: "rsi.host_native_root_id/1",
    host_id: input.host_id,
    mode: input.mode,
    config_space: input.config_space,
    native_root_ref: input.native_root_ref,
    identity_pin: { device_id: input.identity_pin.device_id, file_id: input.identity_pin.file_id }
  });
  return `root:${hash.slice("sha256:".length)}`;
}

interface LiveRootIdentity {
  readonly approved_root: string;
  readonly identity_kind: RootIdentityKind;
  readonly device_id: string;
  readonly file_id: string;
}

function identityKindForPlatform(): RootIdentityKind {
  return process.platform === "win32" ? "file_id" : "dev_inode";
}

function validatePinString(kind: RootIdentityKind, value: string): boolean {
  if (value.length < 1 || value.length > 256) {
    return false;
  }
  return kind === "dev_inode" ? UNSIGNED_DECIMAL_PATTERN.test(value) : OPAQUE_ASCII_PATTERN.test(value);
}

function pinFromStats(rootId: string, identityKind: RootIdentityKind, stats: BigIntStats): RootIdentityPin {
  return {
    schema_version: "rsi.root_identity/1",
    root_id: rootId,
    identity_kind: identityKind,
    device_id: stats.dev.toString(),
    file_id: stats.ino.toString()
  };
}
void pinFromStats;

function pinsMatch(
  left: { readonly identity_kind: string; readonly device_id: string; readonly file_id: string },
  right: { readonly identity_kind: string; readonly device_id: string; readonly file_id: string }
): boolean {
  return (
    left.identity_kind === right.identity_kind &&
    left.device_id === right.device_id &&
    left.file_id === right.file_id
  );
}

function livePinMatches(
  identity: LiveRootIdentity,
  pin: { readonly identity_kind: string; readonly device_id: string; readonly file_id: string }
): boolean {
  return (
    identity.identity_kind === pin.identity_kind &&
    identity.device_id === pin.device_id &&
    identity.file_id === pin.file_id
  );
}

/* ------------------------------------------------------------------ */
/* Native path inspection                                             */
/* ------------------------------------------------------------------ */

function inspectNativeRoot(path: string): Result<LiveRootIdentity, ErrorEnvelope> {
  if (path.length === 0 || path.includes("\u0000") || !isAbsolute(path)) {
    return rootFieldFailure(
      "E_ROOT_IDENTITY_MISMATCH",
      "transient_path",
      "absolute_and_no_nul",
      "root_register"
    );
  }
  if (normalize(path) !== path || resolvePath(path) !== path) {
    return rootFieldFailure(
      "E_ROOT_IDENTITY_MISMATCH",
      "transient_path",
      "posix_normalized",
      "root_register"
    );
  }

  const parsed = parsePath(path);
  if (parsed.root === "") {
    return rootFieldFailure(
      "E_ROOT_IDENTITY_MISMATCH",
      "transient_path",
      "absolute_and_no_nul",
      "root_register"
    );
  }
  const remainder = path.slice(parsed.root.length);
  const segments = remainder.split(sep).filter((segment) => segment.length > 0);
  let current = parsed.root;
  let finalStats: BigIntStats;
  try {
    finalStats = lstatSync(current, { bigint: true });
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment === undefined) {
        return rootFieldFailure(
          "E_ROOT_IDENTITY_MISMATCH",
          "transient_path",
          "segment",
          "root_register"
        );
      }
      current = join(current, segment);
      const stats = lstatSync(current, { bigint: true });
      if (stats.isSymbolicLink()) {
        return rootFieldFailure(
          "E_ROOT_IDENTITY_MISMATCH",
          "transient_path",
          "symlink_component",
          "root_register"
        );
      }
      const last = index === segments.length - 1;
      if (!last && !stats.isDirectory()) {
        return rootFieldFailure(
          "E_ROOT_IDENTITY_MISMATCH",
          "transient_path",
          "parent_not_directory",
          "root_register"
        );
      }
      if (last) {
        finalStats = stats;
      }
    }
  } catch {
    return rootFailure("E_ROOT_UNAVAILABLE", "root_register", { kind: "none" }, "degraded");
  }

  if (!finalStats.isDirectory()) {
    return rootFieldFailure(
      "E_ROOT_IDENTITY_MISMATCH",
      "transient_path",
      "not_a_directory",
      "root_register"
    );
  }
  if (
    finalStats.isFIFO() ||
    finalStats.isSocket() ||
    finalStats.isCharacterDevice() ||
    finalStats.isBlockDevice()
  ) {
    return rootFieldFailure(
      "E_ROOT_IDENTITY_MISMATCH",
      "transient_path",
      "special_file",
      "root_register"
    );
  }

  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return rootFailure("E_ROOT_UNAVAILABLE", "root_register", { kind: "none" }, "degraded");
  }
  if (real !== path) {
    return rootFieldFailure(
      "E_ROOT_IDENTITY_MISMATCH",
      "transient_path",
      "realpath_not_equal",
      "root_register"
    );
  }

  const identityKind = identityKindForPlatform();
  return ok({
    approved_root: real,
    identity_kind: identityKind,
    device_id: finalStats.dev.toString(),
    file_id: finalStats.ino.toString()
  });
}

/* ------------------------------------------------------------------ */
/* Persisted row access                                               */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

function stringField(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function numberField(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function parsePersistedRow(row: Row): Result<RootRegistrationRowShape, ErrorEnvelope> {
  const rootId = stringField(row, "root_id");
  const registrationHash = stringField(row, "registration_hash");
  const hostId = stringField(row, "host_id");
  const mode = stringField(row, "mode");
  const configSpace = stringField(row, "config_space");
  const adapterId = stringField(row, "adapter_id");
  const nativeRootRef = stringField(row, "native_root_ref");
  const identityKind = stringField(row, "identity_kind");
  const deviceId = stringField(row, "device_id");
  const fileId = stringField(row, "file_id");
  const registeredAt = numberField(row, "registered_at");
  const rowVersion = numberField(row, "row_version");
  if (
    rootId === null ||
    !isRootId(rootId) ||
    registrationHash === null ||
    !isHash(registrationHash) ||
    hostId === null ||
    !isHostId(hostId) ||
    mode === null ||
    !isHostMode(mode) ||
    configSpace === null ||
    !CONFIG_SPACE_PATTERN.test(configSpace) ||
    adapterId === null ||
    !isId(adapterId, "adp") ||
    nativeRootRef === null ||
    !isNativeRootRef(nativeRootRef) ||
    (identityKind !== "dev_inode" && identityKind !== "file_id") ||
    deviceId === null ||
    !validatePinString(identityKind, deviceId) ||
    fileId === null ||
    !validatePinString(identityKind, fileId) ||
    registeredAt === null ||
    registeredAt < 0 ||
    rowVersion === null ||
    rowVersion < 1
  ) {
    return rootPlainFailure("E_ROOT_UNAVAILABLE", "root_recovery", "degraded");
  }
  return ok({
    schema_version: "rsi.root_registration_row/1",
    root_id: rootId,
    registration_hash: registrationHash,
    host_id: hostId,
    mode,
    config_space: configSpace,
    adapter_id: adapterId,
    native_root_ref: nativeRootRef,
    identity_kind: identityKind,
    device_id: deviceId,
    file_id: fileId,
    registered_at: registeredAt,
    row_version: rowVersion
  });
}

function readPersistedRoot(
  connection: SqliteConnection,
  rootId: string
): Result<RootRegistrationRowShape | null, ErrorEnvelope> {
  let row: Row | undefined;
  try {
    row = connection
      .prepare<Row>(
        `SELECT root_id, registration_hash, host_id, mode, config_space, adapter_id,
                native_root_ref, identity_kind, device_id, file_id, registered_at, row_version
           FROM root_registration
          WHERE root_id = :root_id`
      )
      .get({ root_id: rootId });
  } catch {
    return storageFailure("root_registration_read");
  }
  if (row === undefined) {
    return ok(null);
  }
  const parsed = parsePersistedRow(row);
  if (!parsed.ok) {
    return parsed;
  }
  return ok(parsed.value);
}

/* ------------------------------------------------------------------ */
/* Journal projection                                                 */
/* ------------------------------------------------------------------ */

interface LedgerEventInput {
  readonly event_type: "root.registration_recorded" | "root.registration_updated";
  readonly operation: "insert" | "update";
  readonly entity_id: string;
  readonly row: RootRegistrationRowShape;
  readonly before: RootRegistrationRowShape | null;
  readonly project: (tx: Tx) => void;
}

interface CommitView {
  readonly ok: boolean;
  readonly unknown: boolean;
  readonly error: ErrorEnvelope | null;
}

function insertLedgerEventLog(
  tx: Tx,
  input: {
    readonly event: Readonly<Record<string, JsonValue>>;
    readonly eventType: string;
    readonly entityId: string;
    readonly operation: "insert" | "update";
    readonly beforeHash: Hash | null;
    readonly afterHash: Hash;
    readonly rowJson: string;
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
       :event_id, :event_key, :commit_seq, :journal_id, :event_type, 'root_registration', :entity_id,
       :operation, 'global', NULL, NULL, NULL, NULL, NULL, NULL, :before_hash, :after_hash,
       'rsi.root_registration_row/1', :row_json, NULL, :payload_hash, :recorded_at
     )`
  ).run({
    event_id: String(input.event["event_id"]),
    event_key: String(input.event["event_key"]),
    commit_seq: input.commitSeq,
    journal_id: input.journalId,
    event_type: input.eventType,
    entity_id: input.entityId,
    operation: input.operation,
    before_hash: input.beforeHash,
    after_hash: input.afterHash,
    row_json: input.rowJson,
    payload_hash: input.afterHash,
    recorded_at: input.recordedAt
  });
}

/* ------------------------------------------------------------------ */
/* Boot load                                                          */
/* ------------------------------------------------------------------ */

interface BootState {
  readonly roots: Map<string, RootRegistryEntry[]>;
  readonly failures: RootBootFailure[];
}

function loadPersistedRoots(
  connection: SqliteConnection,
  approvedRoots: ReadonlyMap<string, string> | undefined
): BootState {
  const roots = new Map<string, RootRegistryEntry[]>();
  const failures: RootBootFailure[] = [];
  let rows: Row[];
  try {
    rows = connection
      .prepare<Row>(
        `SELECT root_id, registration_hash, host_id, mode, config_space, adapter_id,
                native_root_ref, identity_kind, device_id, file_id, registered_at, row_version
           FROM root_registration
          ORDER BY root_id ASC`
      )
      .all();
  } catch {
    rows = [];
  }

  for (const row of rows) {
    const parsed = parsePersistedRow(row);
    if (!parsed.ok) {
      const rawRootId = stringField(row, "root_id");
      failures.push({
        root_id: rawRootId !== null && isRootId(rawRootId) ? rawRootId : "",
        code: "E_ROOT_INVALID"
      });
      if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
        process.stderr.write(`evoplug kernel: root_boot_failure root=${String(rawRootId)} code=parse\n`);
      }
      continue;
    }
    const shape = parsed.value;
    let candidatePath = approvedRoots?.get(shape.root_id);
    if (candidatePath === undefined && shape.native_root_ref.startsWith("file://")) {
      // Managed roots record their host-native directory as an absolute file
      // URI (attach writes it); the registry must hydrate that path or every
      // adoption fails with `not_re_registered`.
      try {
        candidatePath = realpathSync(fileURLToPath(shape.native_root_ref));
      } catch {
        candidatePath = undefined;
      }
    }
    if (candidatePath === undefined) {
      roots.set(shape.root_id, [{ ...shape, approved_root: null }]);
      continue;
    }

    const inspected = inspectNativeRoot(candidatePath);
    if (!inspected.ok) {
      failures.push({ root_id: shape.root_id, code: bootFailureCode(inspected.error.code) });
      if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
        process.stderr.write(`evoplug kernel: root_boot_failure root=${shape.root_id} code=${bootFailureCode(inspected.error.code)}\n`);
      }
      continue;
    }
    if (!livePinMatches(inspected.value, shape)) {
      failures.push({ root_id: shape.root_id, code: "E_ROOT_IDENTITY_MISMATCH" });
      if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
        process.stderr.write(`evoplug kernel: root_boot_failure root=${shape.root_id} code=pin\n`);
      }
      continue;
    }
    // Install roots derive their id from the native root ref. Managed roots
    // (`file://`, written by attach) use the host/config/kind formula; their
    // identity is already verified by `livePinMatches` above, so the install
    // id formula does not apply.
    const managedRoot = shape.native_root_ref.startsWith("file://");
    const recomputed = managedRoot
      ? shape.root_id
      : rootIdFromNative({
          host_id: shape.host_id,
          mode: shape.mode,
          config_space: shape.config_space,
          native_root_ref: shape.native_root_ref,
          identity_pin: { device_id: inspected.value.device_id, file_id: inspected.value.file_id }
        });
    if (recomputed !== shape.root_id) {
      failures.push({ root_id: shape.root_id, code: "E_ROOT_IDENTITY_MISMATCH" });
      if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
        process.stderr.write(`evoplug kernel: root_boot_failure root=${shape.root_id} code=recompute\n`);
      }
      continue;
    }
    roots.set(shape.root_id, [{ ...shape, approved_root: inspected.value.approved_root }]);
  }

  return { roots, failures };
}

function bootFailureCode(code: string): RootBootFailure["code"] {
  switch (code) {
    case "E_ROOT_IDENTITY_MISMATCH":
      return "E_ROOT_IDENTITY_MISMATCH";
    case "E_ROOT_UNAVAILABLE":
      return "E_ROOT_UNAVAILABLE";
    default:
      return "E_ROOT_INVALID";
  }
}

/* ------------------------------------------------------------------ */
/* Registration approval association                                  */
/* ------------------------------------------------------------------ */

/**
 * DD-FND-095.0 step 2, local half: the consumed approval row must exist,
 * bind the same `registration_hash`, and freeze a subject whose recomputed
 * hash and coordinates match this registration. Host readiness evidence is
 * verified by the HOST-supplied readiness port at the call site; it is never
 * replaced by a local copy here.
 */
interface ConsumedApproval {
  readonly subject: AdapterInstallSubject;
  readonly subject_hash: Hash;
}

function verifyConsumedApproval(
  connection: SqliteConnection,
  input: RootRegistrationInput
): Result<ConsumedApproval, ErrorEnvelope> {
  let rows: Row[];
  try {
    rows = connection
      .prepare<Row>(
        `SELECT subject_json, subject_hash
           FROM adapter_install_approval
          WHERE state = 'consumed'
            AND consumed_registration_hash = :registration_hash`
      )
      .all({ registration_hash: input.registration_hash });
  } catch {
    return storageFailure("install_approval_read");
  }
  if (rows.length !== 1) {
    return rootFieldFailure("E_ROOT_NOT_FOUND", "registration_hash", "consumed_approval", "root_register");
  }
  const row = rows[0];
  if (row === undefined) {
    return rootFieldFailure("E_ROOT_NOT_FOUND", "registration_hash", "consumed_approval", "root_register");
  }
  const subjectJson = stringField(row, "subject_json");
  const subjectHash = stringField(row, "subject_hash");
  if (subjectJson === null || subjectHash === null || !isHash(subjectHash)) {
    return rootFieldFailure("E_ROOT_NOT_FOUND", "registration_hash", "consumed_approval", "root_register");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(subjectJson);
  } catch {
    return rootFieldFailure("E_ROOT_NOT_FOUND", "registration_hash", "subject_json", "root_register");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return rootFieldFailure("E_ROOT_NOT_FOUND", "registration_hash", "subject_json", "root_register");
  }
  let subject: JsonValue;
  try {
    subject = toJsonValue(parsed);
  } catch {
    return rootFieldFailure("E_ROOT_NOT_FOUND", "registration_hash", "subject_json", "root_register");
  }
  if (canonicalHash(subject) !== subjectHash) {
    return rootFieldFailure("E_ROOT_NOT_FOUND", "registration_hash", "subject_hash", "root_register");
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(parsed));
  if (
    record["schema_version"] !== "rsi.adapter_install_subject/1" ||
    record["purpose"] !== "adapter_install" ||
    record["host_id"] !== input.host_id ||
    record["mode"] !== input.mode ||
    record["config_space"] !== input.config_space ||
    record["adapter_id"] !== input.adapter_id
  ) {
    return rootFieldFailure("E_ROOT_NOT_FOUND", "registration_hash", "subject_mismatch", "root_register");
  }
  const adapterVersion = record["adapter_version"];
  const implementationHash = record["implementation_hash"];
  const targetId = record["target_id"];
  const artifactHash = record["artifact_hash"];
  const expectedPrevious = record["expected_previous_hash"];
  if (
    typeof adapterVersion !== "string" ||
    typeof implementationHash !== "string" ||
    !isHash(implementationHash) ||
    typeof targetId !== "string" ||
    typeof artifactHash !== "string" ||
    !isHash(artifactHash) ||
    !(
      expectedPrevious === null ||
      (typeof expectedPrevious === "string" && isHash(expectedPrevious))
    )
  ) {
    return rootFieldFailure("E_ROOT_NOT_FOUND", "registration_hash", "subject_shape", "root_register");
  }
  return ok({
    subject: {
      schema_version: "rsi.adapter_install_subject/1",
      purpose: "adapter_install",
      host_id: input.host_id,
      mode: input.mode,
      config_space: input.config_space,
      adapter_id: input.adapter_id,
      adapter_version: adapterVersion,
      implementation_hash: implementationHash,
      target_id: targetId,
      artifact_hash: artifactHash,
      expected_previous_hash: expectedPrevious
    },
    subject_hash: subjectHash
  });
}

/* ------------------------------------------------------------------ */
/* Registry factory                                                   */
/* ------------------------------------------------------------------ */

function readinessUnavailable(path: string, rule: string): Result<never, ErrorEnvelope> {
  return rootFieldFailure("E_ROOT_UNAVAILABLE", path, rule, "root_register");
}

/**
 * DD-FND-102: the registry verifies the applied registration and the exact
 * `host_contract`/`product_adapter` capability evidence itself. Caller-side
 * checks never substitute for this gate.
 */
async function verifyReadiness(
  port: InstallReadinessPort,
  input: RootRegistrationInput,
  approval: ConsumedApproval
): Promise<Result<void, ErrorEnvelope>> {
  const view = await port.get({
    request_id: input.request_id,
    subject: approval.subject,
    subject_hash: approval.subject_hash
  });
  if (!view.ok) {
    return view;
  }
  const value: InstallReadinessView = view.value;
  if (value.active_binding !== "adapter") {
    return readinessUnavailable("active_binding", "applied_registration");
  }
  const hostContract = value.host_contract;
  if (
    hostContract === null ||
    hostContract.status !== "verified" ||
    !hostContract.roundtrip ||
    !hostContract.probe_passed
  ) {
    return readinessUnavailable("host_contract", "verified_roundtrip_probe_passed");
  }
  const productAdapter = value.product_adapter;
  if (productAdapter === null || !productAdapter.active) {
    return readinessUnavailable("product_adapter", "active");
  }
  return ok(undefined);
}

export function createRootRegistry(deps: RootRegistryDeps): RootRegistry {
  const boot = loadPersistedRoots(deps.connection, deps.approved_roots);
  if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
    process.stderr.write(
      `evoplug kernel: root_registry_boot roots=${String(boot.roots.size)} failures=${String(boot.failures.length)}\n`
    );
  }
  let journal: JournalCommitter | null = deps.journal ?? null;

  function getJournal(): JournalCommitter | null {
    if (journal !== null) {
      return journal;
    }
    if (deps.home === undefined) {
      return null;
    }
    try {
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
      journal = createJournalCommitter({
        writer: writer.value,
        connection: deps.connection,
        relative_path: relativePath,
        now: deps.now
      });
      return journal;
    } catch {
      return null;
    }
  }

  async function commitRootEvent(input: LedgerEventInput): Promise<CommitView> {
    const committer = getJournal();
    if (committer === null) {
      return {
        ok: false,
        unknown: false,
        error: rootFailureEnvelope("E_ROOT_UNAVAILABLE", "root_register", { kind: "none" })
      };
    }
    const rowJson = canonicalJsonText(rowJsonValue(input.row));
    const afterHash = canonicalHash({ row_schema: "rsi.root_registration_row/1", row_json: rowJson });
    const beforeHash =
      input.before === null
        ? null
        : canonicalHash({
            row_schema: "rsi.root_registration_row/1",
            row_json: canonicalJsonText(rowJsonValue(input.before))
          });
    const eventId = newId("ev", deps.now());
    const eventKey = canonicalHash({
      event_type: input.event_type,
      entity_type: "root_registration",
      entity_id: input.entity_id,
      operation: input.operation,
      before_hash: beforeHash,
      after_hash: afterHash,
      binding: null
    });
    const eventObject: Readonly<Record<string, JsonValue>> = {
      schema_version: "rsi.ledger_event/1",
      event_id: eventId,
      event_key: eventKey,
      event_type: input.event_type,
      entity_type: "root_registration",
      entity_id: input.entity_id,
      operation: input.operation,
      binding: null,
      before_hash: beforeHash,
      after_hash: afterHash,
      row_schema: "rsi.root_registration_row/1",
      row_json: rowJson,
      payload_hash: afterHash,
      recorded_at: deps.now()
    };
    const event: JsonValue = eventObject;
    const outcome = await committer.commit(
      {
        schema_version: "rsi.journal_event/1",
        event,
        event_hash: canonicalHash(event),
        blob_hashes: []
      },
      (tx, receipt) => {
        insertLedgerEventLog(tx, {
          event: eventObject,
          eventType: input.event_type,
          entityId: input.entity_id,
          operation: input.operation,
          beforeHash,
          afterHash,
          rowJson,
          journalId: receipt.journal_id,
          commitSeq: receipt.first_commit_seq,
          recordedAt: deps.now()
        });
        input.project(tx);
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

  async function register(
    input: RootRegistrationInput
  ): Promise<Result<RootRegistrationResult, ErrorEnvelope>> {
    const validated = validateRegistrationInput(input);
    if (!validated.ok) {
      return validated;
    }

    const approval = verifyConsumedApproval(deps.connection, input);
    if (!approval.ok) {
      return approval;
    }
    if (deps.install_readiness !== undefined) {
      const readiness = await verifyReadiness(deps.install_readiness, input, approval.value);
      if (!readiness.ok) {
        return readiness;
      }
    }

    if (!isNativeRootRef(input.native_root_ref)) {
      return rootFieldFailure("E_ROOT_UNAVAILABLE", "native_root_ref", "resolvable_source_ref", "root_register", "degraded");
    }

    const inspected = inspectNativeRoot(input.transient_path);
    if (!inspected.ok) {
      return inspected;
    }
    const live = inspected.value;
    if (
      !validatePinString(live.identity_kind, input.identity_pin.device_id) ||
      !validatePinString(live.identity_kind, input.identity_pin.file_id)
    ) {
      return rootFieldFailure(
        "E_ROOT_IDENTITY_MISMATCH",
        "identity_pin",
        "canonical_identity_string",
        "root_register"
      );
    }
    if (
      live.identity_kind !== identityKindForPlatform() ||
      live.device_id !== input.identity_pin.device_id ||
      live.file_id !== input.identity_pin.file_id
    ) {
      return rootFieldFailure("E_ROOT_IDENTITY_MISMATCH", "identity_pin", "live_pin_mismatch", "root_register");
    }

    const recomputedRootId = rootIdFromNative({
      host_id: input.host_id,
      mode: input.mode,
      config_space: input.config_space,
      native_root_ref: input.native_root_ref,
      identity_pin: { device_id: live.device_id, file_id: live.file_id }
    });
    if (recomputedRootId !== input.root_id) {
      return rootFieldFailure("E_ROOT_IDENTITY_MISMATCH", "root_id", "native_root_id_mismatch", "root_register");
    }

    const existing = readPersistedRoot(deps.connection, input.root_id);
    if (!existing.ok) {
      return existing;
    }
    const current = existing.value;

    let row: RootRegistrationRowShape;
    let before: RootRegistrationRowShape | null = null;
    let eventType: "root.registration_recorded" | "root.registration_updated";
    let operation: "insert" | "update";

    if (current === null) {
      const registeredAt = deps.now();
      row = {
        schema_version: "rsi.root_registration_row/1",
        root_id: input.root_id,
        registration_hash: input.registration_hash,
        host_id: input.host_id,
        mode: input.mode,
        config_space: input.config_space,
        adapter_id: input.adapter_id,
        native_root_ref: input.native_root_ref,
        identity_kind: live.identity_kind,
        device_id: live.device_id,
        file_id: live.file_id,
        registered_at: registeredAt,
        row_version: 1
      };
      eventType = "root.registration_recorded";
      operation = "insert";
    } else {
      if (!pinsMatch(current, { identity_kind: live.identity_kind, ...input.identity_pin })) {
        return rootFieldFailure(
          "E_ROOT_IDENTITY_MISMATCH",
          "identity_pin",
          "existing_pin_mismatch",
          "root_register"
        );
      }
      if (
        current.host_id !== input.host_id ||
        current.mode !== input.mode ||
        current.config_space !== input.config_space ||
        current.adapter_id !== input.adapter_id ||
        current.native_root_ref !== input.native_root_ref
      ) {
        return rootFieldFailure(
          "E_ROOT_IDENTITY_MISMATCH",
          "root_id",
          "existing_root_coordinates_mismatch",
          "root_register"
        );
      }
      if (current.registration_hash === input.registration_hash) {
        setRoot({ ...current, approved_root: live.approved_root });
        return ok({
          root_id: current.root_id,
          identity_pin: { device_id: current.device_id, file_id: current.file_id },
          registered_at: current.registered_at
        });
      }
      before = current;
      row = {
        ...current,
        registration_hash: input.registration_hash,
        registered_at: deps.now(),
        row_version: current.row_version + 1
      };
      eventType = "root.registration_updated";
      operation = "update";
    }

    const committed = await commitRootEvent({
      event_type: eventType,
      operation,
      entity_id: row.root_id,
      row,
      before,
      project: (tx) => {
        if (operation === "insert") {
          tx.prepare(
            `INSERT INTO root_registration (
               root_id, registration_hash, host_id, mode, config_space, adapter_id,
               native_root_ref, identity_kind, device_id, file_id, registered_at, row_version
             ) VALUES (
               :root_id, :registration_hash, :host_id, :mode, :config_space, :adapter_id,
               :native_root_ref, :identity_kind, :device_id, :file_id, :registered_at, :row_version
             )`
          ).run(sqlParams(row));
          return;
        }
        const updated = tx.prepare(
          `UPDATE root_registration
              SET registration_hash = :registration_hash,
                  registered_at = :registered_at,
                  row_version = :row_version
            WHERE root_id = :root_id AND row_version = :expected_row_version`
        ).run({
          registration_hash: row.registration_hash,
          registered_at: row.registered_at,
          row_version: row.row_version,
          root_id: row.root_id,
          expected_row_version: current === null ? 0 : current.row_version
        });
        if (updated.changes !== 1) {
          throw rootFailureEnvelope("E_ROOT_IDENTITY_MISMATCH", "root_register", {
            kind: "field",
            path: "root_id",
            rule: "row_version_cas"
          });
        }
      }
    });
    if (!committed.ok) {
      return {
        ok: false,
        status: committed.unknown ? "unknown" : "rejected",
        error:
          committed.error ??
          rootFailureEnvelope("E_ROOT_UNAVAILABLE", "root_register", {
            kind: "storage",
            operation: "root_registration_commit"
          })
      };
    }

    const readback = readPersistedRoot(deps.connection, row.root_id);
    if (!readback.ok) {
      return readback;
    }
    const stored = readback.value;
    if (
      stored === null ||
      stored.registration_hash !== row.registration_hash ||
      !pinsMatch(stored, row)
    ) {
      return rootFieldFailure(
        "E_ROOT_IDENTITY_MISMATCH",
        "root_id",
        "readback_mismatch",
        "root_register",
        "unknown"
      );
    }

    setRoot({ ...stored, approved_root: live.approved_root });
    return ok({
      root_id: stored.root_id,
      identity_pin: { device_id: stored.device_id, file_id: stored.file_id },
      registered_at: stored.registered_at
    });
  }

  function setRoot(entry: RootRegistryEntry): void {
    boot.roots.set(entry.root_id, [entry]);
  }

  function lookup(rootId: string): Result<RootRegistryEntry, ErrorEnvelope> {
    const syntax = rootIdSyntaxError(rootId);
    if (syntax !== null) {
      return rootFieldFailure("E_ROOT_INVALID", "root_id", syntax);
    }
    const entries = boot.roots.get(rootId);
    if (entries === undefined || entries.length === 0) {
      return rootFieldFailure("E_ROOT_NOT_FOUND", "root_id", "not_registered");
    }
    if (entries.length > 1) {
      return rootFieldFailure("E_ROOT_AMBIGUOUS", "root_id", "multiple_entries");
    }
    const entry = entries[0];
    if (entry === undefined) {
      return rootFieldFailure("E_ROOT_NOT_FOUND", "root_id", "not_registered");
    }
    return ok(entry);
  }

  return {
    register,
    lookup,
    boot_failures: boot.failures
  };
}

function validateRegistrationInput(input: RootRegistrationInput): Result<void, ErrorEnvelope> {
  if (
    typeof input.request_id !== "string" ||
    input.request_id.length < 1 ||
    input.request_id.length > 256
  ) {
    return rootFieldFailure("E_ROOT_INVALID", "request_id", "length_1_256", "root_register");
  }
  if (!isHash(input.registration_hash)) {
    return rootFieldFailure("E_ROOT_INVALID", "registration_hash", "sha256", "root_register");
  }
  const rootIdError = rootIdSyntaxError(input.root_id);
  if (rootIdError !== null) {
    return rootFieldFailure("E_ROOT_INVALID", "root_id", rootIdError, "root_register");
  }
  if (!isHostId(input.host_id)) {
    return rootFieldFailure("E_ROOT_INVALID", "host_id", "host_closed_set", "root_register");
  }
  if (!isHostMode(input.mode)) {
    return rootFieldFailure("E_ROOT_INVALID", "mode", "mode_closed_set", "root_register");
  }
  if (typeof input.config_space !== "string" || !CONFIG_SPACE_PATTERN.test(input.config_space)) {
    return rootFieldFailure("E_ROOT_INVALID", "config_space", "config_space_token", "root_register");
  }
  if (typeof input.adapter_id !== "string" || !isId(input.adapter_id, "adp")) {
    return rootFieldFailure("E_ROOT_INVALID", "adapter_id", "adp_id", "root_register");
  }
  if (typeof input.native_root_ref !== "string" || !isNativeRootRef(input.native_root_ref)) {
    return rootFieldFailure(
      "E_ROOT_UNAVAILABLE",
      "native_root_ref",
      "resolvable_source_ref",
      "root_register",
      "degraded"
    );
  }
  if (typeof input.transient_path !== "string" || input.transient_path.length === 0) {
    return rootFieldFailure("E_ROOT_INVALID", "transient_path", "non_empty_string", "root_register");
  }
  if (
    typeof input.identity_pin !== "object" ||
    input.identity_pin === null ||
    typeof input.identity_pin.device_id !== "string" ||
    typeof input.identity_pin.file_id !== "string"
  ) {
    return rootFieldFailure("E_ROOT_INVALID", "identity_pin", "device_and_file_strings", "root_register");
  }
  return ok(undefined);
}

function rowJsonValue(row: RootRegistrationRowShape): JsonValue {
  return {
    schema_version: row.schema_version,
    root_id: row.root_id,
    registration_hash: row.registration_hash,
    host_id: row.host_id,
    mode: row.mode,
    config_space: row.config_space,
    adapter_id: row.adapter_id,
    native_root_ref: row.native_root_ref,
    identity_kind: row.identity_kind,
    device_id: row.device_id,
    file_id: row.file_id,
    registered_at: row.registered_at,
    row_version: row.row_version
  };
}

function sqlParams(row: RootRegistrationRowShape): Readonly<Record<string, string | number | null>> {
  return {
    root_id: row.root_id,
    registration_hash: row.registration_hash,
    host_id: row.host_id,
    mode: row.mode,
    config_space: row.config_space,
    adapter_id: row.adapter_id,
    native_root_ref: row.native_root_ref,
    identity_kind: row.identity_kind,
    device_id: row.device_id,
    file_id: row.file_id,
    registered_at: row.registered_at,
    row_version: row.row_version
  };
}

/* ------------------------------------------------------------------ */
/* Resolver factory                                                   */
/* ------------------------------------------------------------------ */

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

export function createRootResolver(deps: RootResolverDeps): RootRegistryResolver {
  const monotonic = deps.monotonic ?? ((): number => performance.now());
  const auditNow = deps.now ?? ((): number => Date.now());

  async function resolve(
    input: RootResolveInput
  ): Promise<Result<RootResolution, ErrorEnvelope>> {
    const started = monotonic();
    if (!Number.isSafeInteger(input.deadline_ms) || input.deadline_ms < 1) {
      return rootPlainFailure("E_DEADLINE_EXCEEDED", "root_resolve", "degraded");
    }
    if (isAborted(input.signal)) {
      return rootPlainFailure("E_CANCELLED", "root_resolve", "degraded");
    }
    const rootIdError = rootIdSyntaxError(input.root_id);
    if (rootIdError !== null) {
      return rootFieldFailure("E_ROOT_INVALID", "root_id", rootIdError);
    }

    const found = deps.registry.lookup(input.root_id);
    if (!found.ok) {
      return found;
    }
    const entry = found.value;
    if (entry.approved_root === null) {
      return rootFieldFailure("E_ROOT_NOT_FOUND", "root_id", "not_re_registered");
    }

    const inspected = inspectRootForResolve(entry.approved_root);
    if (!inspected.ok) {
      return inspected;
    }
    const live = inspected.value;
    if (!livePinMatches(live, entry)) {
      return rootFieldFailure("E_ROOT_IDENTITY_MISMATCH", "root_identity_pin", "live_pin_mismatch");
    }
    // Managed roots use the host/config/kind id formula; their identity was
    // already checked by `livePinMatches`. Only install roots derive the id
    // from the native root ref.
    const recomputed = entry.native_root_ref.startsWith("file://")
      ? entry.root_id
      : rootIdFromNative({
          host_id: entry.host_id,
          mode: entry.mode,
          config_space: entry.config_space,
          native_root_ref: entry.native_root_ref,
          identity_pin: { device_id: live.device_id, file_id: live.file_id }
        });
    if (recomputed !== entry.root_id) {
      return rootFieldFailure("E_ROOT_IDENTITY_MISMATCH", "root_id", "native_root_id_mismatch");
    }
    if (monotonic() - started >= input.deadline_ms) {
      return rootPlainFailure("E_DEADLINE_EXCEEDED", "root_resolve", "degraded");
    }
    if (isAborted(input.signal)) {
      return rootPlainFailure("E_CANCELLED", "root_resolve", "degraded");
    }

    return ok({
      root_id: entry.root_id,
      approved_root: live.approved_root,
      root_identity_pin: {
        schema_version: "rsi.root_identity/1",
        root_id: entry.root_id,
        identity_kind: live.identity_kind,
        device_id: live.device_id,
        file_id: live.file_id
      },
      root_registration_hash: entry.registration_hash,
      evidence_ref: entry.native_root_ref,
      resolved_at: auditNow()
    });
  }

  return { resolve };
}

function inspectRootForResolve(path: string): Result<LiveRootIdentity, ErrorEnvelope> {
  if (!isAbsolute(path) || path.includes("\u0000") || normalize(path) !== path || resolvePath(path) !== path) {
    return rootFieldFailure("E_ROOT_IDENTITY_MISMATCH", "approved_root", "not_canonical_absolute");
  }

  const parsed = parsePath(path);
  if (parsed.root === "") {
    return rootFieldFailure("E_ROOT_IDENTITY_MISMATCH", "approved_root", "not_absolute");
  }
  const segments = path
    .slice(parsed.root.length)
    .split(sep)
    .filter((segment) => segment.length > 0);
  let current = parsed.root;
  let finalStats: BigIntStats;
  try {
    finalStats = lstatSync(current, { bigint: true });
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment === undefined) {
        return rootFieldFailure("E_ROOT_IDENTITY_MISMATCH", "approved_root", "segment");
      }
      current = join(current, segment);
      const stats = lstatSync(current, { bigint: true });
      if (stats.isSymbolicLink()) {
        return rootFieldFailure("E_ROOT_IDENTITY_MISMATCH", "approved_root", "symlink_component");
      }
      const last = index === segments.length - 1;
      if (!last && !stats.isDirectory()) {
        return rootFieldFailure("E_ROOT_IDENTITY_MISMATCH", "approved_root", "parent_not_directory");
      }
      if (last) {
        finalStats = stats;
      }
    }
  } catch {
    return rootFailure("E_ROOT_UNAVAILABLE", "root_resolve", { kind: "none" }, "degraded");
  }

  if (
    !finalStats.isDirectory() ||
    finalStats.isFIFO() ||
    finalStats.isSocket() ||
    finalStats.isCharacterDevice() ||
    finalStats.isBlockDevice()
  ) {
    return rootFieldFailure("E_ROOT_IDENTITY_MISMATCH", "approved_root", "not_a_directory");
  }

  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return rootFailure("E_ROOT_UNAVAILABLE", "root_resolve", { kind: "none" }, "degraded");
  }
  if (real !== path) {
    return rootFieldFailure("E_ROOT_IDENTITY_MISMATCH", "approved_root", "realpath_not_equal");
  }

  return ok({
    approved_root: real,
    identity_kind: identityKindForPlatform(),
    device_id: finalStats.dev.toString(),
    file_id: finalStats.ino.toString()
  });
}
