/**
 * `WriteIntent`, `WriteSnapshot`, `WriteResult` and managed-write helpers
 * (DD-FND-091).
 *
 * All persisted paths are relative to `root_id`. The absolute `approved_root`
 * of a resolution never enters an intent, a result, a journal frame or a hash.
 */

import { canonicalHash, isHash, isId } from "@evoplug/core";
import type {
  ContentUpload,
  ErrorEnvelope,
  Hash,
  Id,
  JsonValue,
  Result,
  SourceRef,
  VersionBinding,
} from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import { fieldError } from "./errors.js";
import { validateBlockSelector } from "./block.js";
import type { GrantPublicView } from "./grants.js";

export type WriteIntentState =
  | "intent_recorded"
  | "snapshot_written"
  | "temp_written"
  | "renamed"
  | "dir_synced"
  | "verified"
  | "pending_approval"
  | "conflict"
  | "path_rejected"
  | "write_failed"
  | "partial"
  | "recovery_required";

type WriteScopeRef =
  | { kind: "task"; task_id: Id<"task"> }
  | { kind: "session"; session_id: Id<"sess"> };

const WRITE_APPLY_SCHEMA_VERSION: "rsi.write_apply/1" = "rsi.write_apply/1";

export const WRITE_INTENT_SCHEMA_VERSION: "rsi.write_intent/2" = "rsi.write_intent/2";

export const WRITE_RESULT_SCHEMA_VERSION: "rsi.write_result/2" = "rsi.write_result/2";

/**
 * The closed field set of `rsi.write_apply/1`.
 *
 * Mirrors the `properties` of `schemas/write/write-apply-request.schema.json`,
 * which sets `additionalProperties=false`. The kernel-owned fields
 * (`target_ownership`, `approved_root`, `root_identity_pin`, `snapshot_ref`)
 * are deliberately absent: the caller may not supply or override them.
 */
const WRITE_APPLY_REQUEST_FIELDS: ReadonlySet<string> = new Set([
  "schema_version",
  "deadline_ms",
  "grant_id",
  "action",
  "object_type",
  "candidate_id",
  "candidate_hash",
  "binding",
  "scope_ref",
  "root_id",
  "target_path",
  "write_mode",
  "block_action",
  "block_selector",
  "expected_file_hash",
  "expected_block_hash",
  "new_content",
  "new_content_hash",
  "rollback_of_write_id",
  "target_snapshot_id",
  "target_snapshot_hash",
  "unattended_policy"
]);

const WRITE_SNAPSHOT_SCHEMA_VERSION: "rsi.write_snapshot/2" = "rsi.write_snapshot/2";

const WRITE_SCOPE_SCHEMA_VERSION: "rsi.write_scope/1" = "rsi.write_scope/1";

export interface RootIdentityPin {
  schema_version: "rsi.root_identity/1";
  root_id: string;
  identity_kind: "dev_inode" | "file_id";
  device_id: string;
  file_id: string;
}

export interface WriteApplyRequest {
  schema_version: "rsi.write_apply/1";
  /** Monotonic remaining milliseconds, 1..600000; excluded from request_hash. */
  deadline_ms: number;
  grant_id: Id<"grant">;
  action: "create" | "update" | "disable" | "rollback";
  object_type: "skill" | "memory" | "instructions";
  candidate_id: Id<"prop">;
  candidate_hash: Hash;
  binding: VersionBinding;
  scope_ref: WriteScopeRef;
  root_id: string;
  target_path: string;
  write_mode: "whole_file" | "managed_block";
  block_action: "update" | "attach" | "detach" | null;
  block_selector: string | null;
  expected_file_hash: Hash | null;
  expected_block_hash: Hash | null;
  new_content: ContentUpload | null;
  new_content_hash: Hash | null;
  rollback_of_write_id: Id<"wi"> | null;
  target_snapshot_id: Id<"wsnap"> | null;
  target_snapshot_hash: Hash | null;
  unattended_policy: "auto_allowed" | "pending_approval" | "rsi_managed_file_only";
}

export interface WriteIntent {
  schema_version: "rsi.write_intent/2";
  write_id: Id<"wi">;
  idempotency_key: string;
  grant_id: Id<"grant">;
  action: "create" | "update" | "disable" | "rollback";
  object_type: "skill" | "memory" | "instructions";
  candidate_id: Id<"prop">;
  candidate_hash: Hash;
  binding: VersionBinding;
  scope_kind: "task" | "session";
  scope_ref_id: string;
  project_id: string | null;
  config_space_id: string | null;
  scope_hash: Hash;
  root_id: string;
  root_identity_pin: RootIdentityPin;
  root_registration_hash: Hash;
  target_path: string;
  target_ownership: "native_managed" | "rsi_managed" | "shared_handwritten";
  write_mode: "whole_file" | "managed_block";
  block_action: "update" | "attach" | "detach" | null;
  block_selector: string | null;
  expected_file_hash: Hash | null;
  expected_block_hash: Hash | null;
  snapshot_id: Id<"wsnap"> | null;
  rollback_of_write_id: Id<"wi"> | null;
  target_snapshot_id: Id<"wsnap"> | null;
  target_snapshot_hash: Hash | null;
  atomicity: "native_atomic" | "single_file_atomic" | "none";
  exclusion: "native_cooperative" | "rsi_advisory" | "none";
  unattended_policy: "auto_allowed" | "pending_approval" | "rsi_managed_file_only";
  state: WriteIntentState;
  attempt: number;
  last_error_code: string | null;
  row_version: number;
  created_at: number;
  updated_at: number;
}

export interface WriteSnapshot {
  snapshot_id: Id<"wsnap">;
  write_id: Id<"wi">;
  path: string;
  write_mode: "whole_file" | "managed_block";
  file_hash: Hash;
  file_byte_length: number;
  block_action: "update" | "attach" | "detach" | null;
  block_selector: string | null;
  /** Byte offset of the begin marker line; `null` when `attach` had no old block. */
  block_start: number | null;
  /** Full byte length of begin/end marker lines including their line endings. */
  block_byte_length: number | null;
  block_content_hash: Hash | null;
  block_hash: Hash | null;
  content_ref: SourceRef;
  snapshot_hash: Hash;
  created_at: number;
}

export interface WriteResult {
  schema_version: "rsi.write_result/2";
  write_id: Id<"wi">;
  attempt: number;
  state: WriteIntentState;
  root_id: string;
  path: string;
  new_file_hash: Hash | null;
  new_block_hash: Hash | null;
  snapshot_id: Id<"wsnap"> | null;
  target_snapshot_id: Id<"wsnap"> | null;
  target_snapshot_hash: Hash | null;
  three_way_diff_ref: SourceRef | null;
  readback_verified: boolean;
  atomicity: "native_atomic" | "single_file_atomic" | "none";
  exclusion: "native_cooperative" | "rsi_advisory" | "none";
  unattended_policy: "auto_allowed" | "pending_approval" | "rsi_managed_file_only";
  error_code: string | null;
  completed_at: number | null;
}

export interface WriteAdoptionView {
  schema_version: "rsi.write_adoption_view/1";
  intent: WriteIntent;
  /** Latest attempt for `write_id`; `verified` is the attempt's terminal state. */
  result: WriteResult;
  grant: GrantPublicView;
}

export interface WriteAdoptionReadPort {
  getAdoption(write_id: Id<"wi">): Promise<Result<WriteAdoptionView, ErrorEnvelope>>;
}

/* ------------------------------------------------------------------ */
/* State machine                                                       */
/* ------------------------------------------------------------------ */

/** Allowed transitions from the DD-FND-091 state diagram. */
const WRITE_TRANSITIONS: Readonly<Record<WriteIntentState, readonly WriteIntentState[]>> = {
  intent_recorded: ["pending_approval", "path_rejected", "snapshot_written", "conflict"],
  pending_approval: ["intent_recorded"],
  snapshot_written: ["temp_written", "conflict", "write_failed"],
  temp_written: ["renamed", "write_failed"],
  renamed: ["dir_synced", "recovery_required"],
  dir_synced: ["verified"],
  verified: [],
  conflict: [],
  path_rejected: [],
  write_failed: [],
  partial: [],
  recovery_required: []
};

/** States after which a `write_id` accepts no further attempt. */
const WRITE_TERMINAL_STATES: readonly WriteIntentState[] = [
  "verified",
  "conflict",
  "path_rejected",
  "write_failed",
  "partial",
  "recovery_required"
];

export function isWriteTerminalState(state: WriteIntentState): boolean {
  return WRITE_TERMINAL_STATES.includes(state);
}

export function isWriteTransitionAllowed(from: WriteIntentState, to: WriteIntentState): boolean {
  return WRITE_TRANSITIONS[from].includes(to);
}

/** True once any `verified` result exists: the `write_id` is sealed. */
function isSealedWrite(latest: WriteResult | null): boolean {
  return latest !== null && latest.state === "verified";
}

/**
 * A new attempt may be appended unless a `verified` result already exists
 * (DD-FND-091). Other terminal states keep returning their latest attempt.
 */
export function canAppendWriteAttempt(latest: WriteResult | null): boolean {
  return !isSealedWrite(latest);
}

/**
 * Applies one state transition with the `row_version` CAS convention.
 *
 * The caller performs the SQLite CAS; this helper only enforces the allowed
 * transition set and produces the next row value.
 */
export function transitionWriteIntent(input: {
  intent: WriteIntent;
  to: WriteIntentState;
  now: number;
  error_code?: string | null;
}): Result<WriteIntent, ErrorEnvelope> {
  if (!isWriteTransitionAllowed(input.intent.state, input.to)) {
    return err(fieldError("E_WRITE_STATE", "state", `${input.intent.state}_to_${input.to}`));
  }
  const next: WriteIntent = {
    ...input.intent,
    state: input.to,
    row_version: input.intent.row_version + 1,
    updated_at: input.now
  };
  if (input.error_code !== undefined) {
    next.last_error_code = input.error_code;
  }
  return ok(next);
}

/** Appending after `verified` is refused with `E_WRITE_STATE`, zero writes. */
export function assertAppendable(latest: WriteResult | null): Result<null, ErrorEnvelope> {
  if (!canAppendWriteAttempt(latest)) {
    return err(fieldError("E_WRITE_STATE", "write_id", "verified_is_terminal"));
  }
  return ok(null);
}

/* ------------------------------------------------------------------ */
/* Hashes                                                              */
/* ------------------------------------------------------------------ */

interface WriteScopeInput {
  scope_kind: "task" | "session";
  scope_ref_id: string;
  project_id: string | null;
  config_space_id: string | null;
}

/**
 * `scope_hash = sha256(JCS({schema_version:"rsi.write_scope/1", scope_kind,
 * scope_ref_id, project_id, config_space_id}))`.
 */
export function writeScopeHash(input: WriteScopeInput): Hash {
  return canonicalHash({
    schema_version: WRITE_SCOPE_SCHEMA_VERSION,
    scope_kind: input.scope_kind,
    scope_ref_id: input.scope_ref_id,
    project_id: input.project_id,
    config_space_id: input.config_space_id
  });
}

interface WriteRequestHashInput {
  grant_id: Id<"grant">;
  action: "create" | "update" | "disable" | "rollback";
  object_type: "skill" | "memory" | "instructions";
  candidate_id: Id<"prop">;
  candidate_hash: Hash;
  binding: VersionBinding;
  scope_kind: "task" | "session";
  scope_ref_id: string;
  root_id: string;
  target_path: string;
  write_mode: "whole_file" | "managed_block";
  block_action: "update" | "attach" | "detach" | null;
  block_selector: string | null;
  expected_file_hash: Hash | null;
  expected_block_hash: Hash | null;
  rollback_of_write_id: Id<"wi"> | null;
  target_snapshot_id: Id<"wsnap"> | null;
  target_snapshot_hash: Hash | null;
  unattended_policy: "auto_allowed" | "pending_approval" | "rsi_managed_file_only";
}

/**
 * `request_hash` over the DD-FND-091 whitelist.
 *
 * Excluded: `deadline_ms`, `idempotency_key`, the raw `new_content` bytes
 * (represented by `new_content_hash`), `approved_root`, the root pin and the
 * registration hash. The design's brace list omits `new_content_hash` itself,
 * so it is not part of the preimage; `candidate_hash` is the bound content.
 */
export function writeRequestHash(input: WriteRequestHashInput): Hash {
  const binding = input.binding;
  return canonicalHash({
    schema_version: WRITE_APPLY_SCHEMA_VERSION,
    grant_id: input.grant_id,
    action: input.action,
    object_type: input.object_type,
    candidate_id: input.candidate_id,
    candidate_hash: input.candidate_hash,
    binding: {
      task_id: binding.task_id,
      branch_id: binding.branch_id,
      input_epoch: binding.input_epoch,
      goal_version: binding.goal_version,
      config_version: binding.config_version,
      watermark: binding.watermark
    },
    scope_kind: input.scope_kind,
    scope_ref_id: input.scope_ref_id,
    root_id: input.root_id,
    target_path: input.target_path,
    write_mode: input.write_mode,
    block_action: input.block_action,
    block_selector: input.block_selector,
    expected_file_hash: input.expected_file_hash,
    expected_block_hash: input.expected_block_hash,
    rollback_of_write_id: input.rollback_of_write_id,
    target_snapshot_id: input.target_snapshot_id,
    target_snapshot_hash: input.target_snapshot_hash,
    unattended_policy: input.unattended_policy
  });
}

/** `snapshot_hash` over the DD-FND-091 whitelist; excludes id and time. */
export function writeSnapshotHash(snapshot: Omit<WriteSnapshot, "snapshot_hash">): Hash {
  return canonicalHash(writeSnapshotPreimage(snapshot));
}

/** Recomputes and compares the stored snapshot hash. */
export function verifyWriteSnapshotHash(snapshot: WriteSnapshot): boolean {
  const { snapshot_hash: stored, ...rest } = snapshot;
  return writeSnapshotHash(rest) === stored;
}

/** JCS preimage of `snapshot_hash`. */
function writeSnapshotPreimage(snapshot: Omit<WriteSnapshot, "snapshot_hash">): JsonValue {
  return {
    schema_version: WRITE_SNAPSHOT_SCHEMA_VERSION,
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
    content_ref: snapshot.content_ref
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Validates the request against the DD-FND-091 shape rules.
 *
 * `object_type="config"` is rejected with `E_WRITE_MODE_UNSUPPORTED` before any
 * intent is created: config files only go through `ConfigWritePort`.
 *
 * The request is a closed shape (`schemas/write/write-apply-request.schema.json`
 * sets `additionalProperties=false`), so an unknown field is rejected. That
 * covers the fields the kernel owns and the caller may not supply, such as
 * `target_ownership`, which the kernel derives from the install manifest and
 * the managed-block markers (DD-FND-091 step 3).
 */
export function validateWriteApplyRequest(
  request: WriteApplyRequest
): Result<WriteApplyRequest, ErrorEnvelope> {
  if (request.schema_version !== WRITE_APPLY_SCHEMA_VERSION) {
    return err(fieldError("E_SCHEMA", "schema_version", WRITE_APPLY_SCHEMA_VERSION));
  }
  for (const key of Object.keys(request as unknown as Record<string, unknown>)) {
    if (!WRITE_APPLY_REQUEST_FIELDS.has(key)) {
      return err(fieldError("E_SCHEMA", key, "unknown_field"));
    }
  }
  const objectType: string = request.object_type;
  if (objectType === "config") {
    return err(fieldError("E_WRITE_MODE_UNSUPPORTED", "object_type", "no_config_in_write_apply"));
  }
  if (!isId(request.grant_id, "grant")) {
    return err(fieldError("E_SCHEMA", "grant_id", "grant_id"));
  }
  if (!isId(request.candidate_id, "prop")) {
    return err(fieldError("E_WRITE_CANDIDATE_ID", "candidate_id", "prop_id"));
  }
  if (!isHash(request.candidate_hash)) {
    return err(fieldError("E_WRITE_CANDIDATE_HASH", "candidate_hash", "sha256"));
  }
  if (
    !Number.isSafeInteger(request.deadline_ms) ||
    request.deadline_ms < 1 ||
    request.deadline_ms > 600_000
  ) {
    return err(fieldError("E_SCHEMA", "deadline_ms", "1..600000"));
  }
  const path = validateRelativeTargetPath(request.target_path);
  if (!path.ok) {
    return path;
  }
  if (request.scope_ref.kind === "task") {
    if (!isId(request.scope_ref.task_id, "task")) {
      return err(fieldError("E_WRITE_SCOPE_UNRESOLVED", "scope_ref.task_id", "task_id"));
    }
  } else if (!isId(request.scope_ref.session_id, "sess")) {
    return err(fieldError("E_WRITE_SCOPE_UNRESOLVED", "scope_ref.session_id", "sess_id"));
  }
  if (request.write_mode === "whole_file") {
    if (
      request.block_action !== null ||
      request.block_selector !== null ||
      request.expected_block_hash !== null
    ) {
      return err(fieldError("E_SCHEMA", "write_mode", "whole_file_has_no_block_fields"));
    }
    if (request.expected_file_hash === null && request.action !== "create") {
      return err(fieldError("E_SCHEMA", "expected_file_hash", "required_for_existing_file"));
    }
  } else {
    if (request.block_action === null || request.block_selector === null) {
      return err(fieldError("E_SCHEMA", "block_action", "required_for_managed_block"));
    }
    const selector = validateBlockSelector(request.block_selector);
    if (!selector.ok) {
      return selector;
    }
    if (request.expected_file_hash === null) {
      return err(fieldError("E_SCHEMA", "expected_file_hash", "required_for_managed_block"));
    }
    if (request.block_action === "attach" && request.expected_block_hash !== null) {
      return err(fieldError("E_BLOCK_HASH_MISMATCH", "expected_block_hash", "null_for_attach"));
    }
    if (request.block_action !== "attach" && request.expected_block_hash === null) {
      return err(fieldError("E_BLOCK_HASH_MISMATCH", "expected_block_hash", "required"));
    }
  }
  const nullContent = request.action === "rollback" || request.block_action === "detach";
  if (nullContent) {
    if (request.new_content !== null || request.new_content_hash !== null) {
      return err(fieldError("E_WRITE_CANDIDATE_HASH", "new_content_hash", "null_for_rollback_or_detach"));
    }
  } else {
    if (request.new_content === null) {
      return err(fieldError("E_SCHEMA", "new_content", "required"));
    }
    if (request.new_content_hash === null || !isHash(request.new_content_hash)) {
      return err(fieldError("E_WRITE_CANDIDATE_HASH", "new_content_hash", "sha256"));
    }
  }
  if (request.action === "rollback") {
    if (
      request.rollback_of_write_id === null ||
      request.target_snapshot_id === null ||
      request.target_snapshot_hash === null
    ) {
      return err(
        fieldError("E_WRITE_ROLLBACK_TARGET", "rollback_of_write_id", "target_fields_required")
      );
    }
    if (request.write_mode !== "whole_file") {
      return err(fieldError("E_WRITE_ROLLBACK_TARGET", "write_mode", "whole_file"));
    }
    if (!isId(request.rollback_of_write_id, "wi")) {
      return err(fieldError("E_WRITE_ROLLBACK_TARGET", "rollback_of_write_id", "wi_id"));
    }
    if (!isId(request.target_snapshot_id, "wsnap")) {
      return err(fieldError("E_WRITE_ROLLBACK_TARGET", "target_snapshot_id", "wsnap_id"));
    }
    if (!isHash(request.target_snapshot_hash)) {
      return err(fieldError("E_WRITE_ROLLBACK_TARGET", "target_snapshot_hash", "sha256"));
    }
  } else if (
    request.rollback_of_write_id !== null ||
    request.target_snapshot_id !== null ||
    request.target_snapshot_hash !== null
  ) {
    return err(fieldError("E_SCHEMA", "rollback_of_write_id", "null_outside_rollback"));
  }
  return ok(request);
}

/**
 * Relative path rules shared by `target_path`, `ConfigWriteLock.target_path`
 * and `WriteResult.path`: non-empty, no NUL, not absolute, no `..` component,
 * no Windows drive/UNC prefix.
 */
export function validateRelativeTargetPath(value: string): Result<string, ErrorEnvelope> {
  if (value.length === 0) {
    return err(fieldError("E_SCHEMA", "target_path", "non_empty"));
  }
  if (value.includes("\u0000")) {
    return err(fieldError("E_SCHEMA", "target_path", "no_nul"));
  }
  if (value.startsWith("/") || value.startsWith("\\")) {
    return err(fieldError("E_SCHEMA", "target_path", "relative"));
  }
  if (/^[A-Za-z]:/.test(value)) {
    return err(fieldError("E_SCHEMA", "target_path", "no_windows_drive"));
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      return err(fieldError("E_SCHEMA", "target_path", "no_dotdot"));
    }
  }
  return ok(value);
}

/* ------------------------------------------------------------------ */
/* Rollback target validation                                          */
/* ------------------------------------------------------------------ */

export interface RollbackTargetState {
  intent: WriteIntent;
  latest_result: WriteResult;
  snapshot: WriteSnapshot;
  /** True when this is the newest verified managed write for the path. */
  is_latest_verified: boolean;
}

/**
 * Validates a rollback target before any intent is created (DD-FND-091).
 *
 * Any failure is `E_WRITE_ROLLBACK_TARGET`, with zero intent, zero grant
 * consumption and zero file writes. The caller must pass the newest verified
 * write for `(task_id, branch_id, target_path)`; "newer write exists" is
 * reported as `is_latest_verified = false`.
 */
export function validateRollbackTarget(
  request: WriteApplyRequest,
  target: RollbackTargetState
): Result<RollbackTargetState, ErrorEnvelope> {
  if (request.action !== "rollback") {
    return err(fieldError("E_SCHEMA", "action", "rollback"));
  }
  if (
    request.rollback_of_write_id !== target.intent.write_id ||
    request.target_snapshot_id !== target.snapshot.snapshot_id
  ) {
    return rollbackError("rollback_of_write_id", "target_mismatch");
  }
  if (target.latest_result.state !== "verified" || !target.latest_result.readback_verified) {
    return rollbackError("latest_result", "verified");
  }
  if (target.intent.action === "rollback") {
    return rollbackError("rollback_of_write_id", "target_is_rollback");
  }
  if (
    target.intent.object_type !== request.object_type ||
    target.intent.candidate_id !== request.candidate_id ||
    target.intent.candidate_hash !== request.candidate_hash
  ) {
    return rollbackError("candidate", "object_and_candidate_equal");
  }
  if (!bindingCompatible(request.binding, target.intent.binding)) {
    return rollbackError("binding", "task_branch_goal_config_equal");
  }
  if (
    target.intent.root_id !== request.root_id ||
    target.intent.target_path !== request.target_path
  ) {
    return rollbackError("target_path", "root_and_path_equal");
  }
  if (target.snapshot.write_id !== target.intent.write_id) {
    return rollbackError("target_snapshot_id", "belongs_to_target_write");
  }
  if (target.snapshot.path !== target.intent.target_path) {
    return rollbackError("target_snapshot_id", "path_equals_target_path");
  }
  if (!verifyWriteSnapshotHash(target.snapshot)) {
    return rollbackError("target_snapshot_hash", "snapshot_hash_recomputed");
  }
  if (request.target_snapshot_hash !== target.snapshot.snapshot_hash) {
    return rollbackError("target_snapshot_hash", "equals_request");
  }
  if (
    request.expected_file_hash === null ||
    request.expected_file_hash !== target.latest_result.new_file_hash
  ) {
    return rollbackError("expected_file_hash", "latest_verified_new_file_hash");
  }
  if (!target.is_latest_verified) {
    return rollbackError("rollback_of_write_id", "latest_verified_managed_write");
  }
  return ok(target);
}

function bindingCompatible(current: VersionBinding, target: VersionBinding): boolean {
  return (
    current.task_id === target.task_id &&
    current.branch_id === target.branch_id &&
    current.goal_version === target.goal_version &&
    current.config_version === target.config_version &&
    current.input_epoch >= target.input_epoch &&
    current.watermark >= target.watermark
  );
}

function rollbackError(path: string, rule: string): Result<never, ErrorEnvelope> {
  return err(fieldError("E_WRITE_ROLLBACK_TARGET", path, rule));
}
