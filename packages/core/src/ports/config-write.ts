/**
 * Shared `ConfigWritePort` DTOs (DD-FND-095).
 *
 * `write.config` is an in-process typed port, not an IPC method. FND owns the
 * implementation in `@evoplug/auth`; CFG owns the parser/apply port in
 * `@evoplug/core/src/config`. Both sides depend only on this module, never on
 * each other's implementation.
 *
 * Absolute realpaths (`approved_root`, `transient_path`) are call-stack values:
 * they never enter a hash, a journal frame, SQLite or a result.
 */

import type { ErrorEnvelope } from "../errors.js";
import type { HostId, HostMode } from "../generated/host-vocabulary.js";
import type { Hash } from "../hash.js";
import type { Id } from "../ids.js";
import type { Result } from "../result.js";
import type { SourceRef } from "../source-ref.js";
import type { VersionBinding } from "../version-binding.js";
import type { WriteDecision } from "./write-decision.js";

/* ------------------------------------------------------------------ */
/* Schema and limit constants                                          */
/* ------------------------------------------------------------------ */

export const CONFIG_WRITE_SCHEMA_VERSION: "rsi.config_write/1" = "rsi.config_write/1";

export const CONFIG_WRITE_RESULT_SCHEMA_VERSION: "rsi.config_write_result/1" =
  "rsi.config_write_result/1";

export const CONFIG_WRITE_INTENT_SCHEMA_VERSION: "rsi.config_write_intent/1" =
  "rsi.config_write_intent/1";

export const CONFIG_WRITE_SNAPSHOT_SCHEMA_VERSION: "rsi.config_write_snapshot/1" =
  "rsi.config_write_snapshot/1";

export const ROOT_IDENTITY_SCHEMA_VERSION: "rsi.root_identity/1" = "rsi.root_identity/1";

/** Fixed lock TTL, 60 s (DD-FND-095.2). */
export const CONFIG_WRITE_LOCK_TTL_MS = 60_000;

/** Maximum parser output FND will write, 8 MiB. */
export const CONFIG_WRITE_MAX_CONTENT_BYTES = 8_388_608;

/** `deadline_ms` range for every config-write entry point. */
export const CONFIG_WRITE_MIN_DEADLINE_MS = 1;
export const CONFIG_WRITE_MAX_DEADLINE_MS = 600_000;

/** Non-terminal config-write states; these hold the durable commit claim. */
export const CONFIG_WRITE_ACTIVE_STATES: readonly ConfigWriteState[] = [
  "intent_recorded",
  "snapshot_written",
  "temp_written",
  "renamed",
  "dir_synced"
];

export const CONFIG_WRITE_TERMINAL_STATES: readonly ConfigWriteTerminalState[] = [
  "verified",
  "conflict",
  "path_rejected",
  "write_failed",
  "uncertain",
  "recovery_required"
];

export function isConfigWriteState(value: string): value is ConfigWriteState {
  switch (value) {
    case "intent_recorded":
    case "snapshot_written":
    case "temp_written":
    case "renamed":
    case "dir_synced":
    case "verified":
    case "conflict":
    case "path_rejected":
    case "write_failed":
    case "uncertain":
    case "recovery_required":
      return true;
    default:
      return false;
  }
}

export function isConfigWriteTerminalState(value: string): value is ConfigWriteTerminalState {
  return (
    value === "verified" ||
    value === "conflict" ||
    value === "path_rejected" ||
    value === "write_failed" ||
    value === "uncertain" ||
    value === "recovery_required"
  );
}

export function isConfigWriteActiveState(value: string): boolean {
  return (
    value === "intent_recorded" ||
    value === "snapshot_written" ||
    value === "temp_written" ||
    value === "renamed" ||
    value === "dir_synced"
  );
}

/* ------------------------------------------------------------------ */
/* Root registration and resolution                                    */
/* ------------------------------------------------------------------ */

export type RootIdentityKind = "dev_inode" | "file_id";

export interface RootIdentityPin {
  schema_version: "rsi.root_identity/1";
  root_id: string;
  identity_kind: RootIdentityKind;
  /** `dev_inode`: `st_dev` as unsigned decimal; `file_id`: volume identifier. */
  device_id: string;
  /** `dev_inode`: `st_ino` as unsigned decimal; `file_id`: platform opaque id. */
  file_id: string;
}

export interface ResolvedRoot {
  root_id: string;
  approved_root: string;
  root_identity_pin: RootIdentityPin;
  evidence_ref: SourceRef;
  resolved_at: number;
}

export interface RootResolver {
  resolve(input: {
    root_id: string;
    request_id: string;
    deadline_ms: number;
    signal?: AbortSignal;
  }): Promise<Result<ResolvedRoot, ErrorEnvelope>>;
}

export interface RootRegistrationResult {
  root_id: string;
  identity_pin: { device_id: string; file_id: string };
  registered_at: number;
}

export interface RootRegistrationPort {
  register(input: {
    request_id: string;
    registration_hash: Hash;
    root_id: string;
    host_id: HostId;
    mode: HostMode;
    config_space: string;
    adapter_id: Id<"adp">;
    native_root_ref: SourceRef;
    /** Call-stack only: never persisted, journalled or hashed. */
    transient_path: string;
    identity_pin: { device_id: string; file_id: string };
  }): Promise<Result<RootRegistrationResult, ErrorEnvelope>>;
}

/* ------------------------------------------------------------------ */
/* Config write state and results                                      */
/* ------------------------------------------------------------------ */

export type ConfigWriteState =
  | "intent_recorded"
  | "snapshot_written"
  | "temp_written"
  | "renamed"
  | "dir_synced"
  | "verified"
  | "conflict"
  | "path_rejected"
  | "write_failed"
  | "uncertain"
  | "recovery_required";

export type ConfigWriteTerminalState =
  | "verified"
  | "conflict"
  | "path_rejected"
  | "write_failed"
  | "uncertain"
  | "recovery_required";

export interface ConfigWriteLockRequest {
  schema_version: "rsi.config_write/1";
  deadline_ms: number;
  grant_id: Id<"grant">;
  action: "update" | "rollback";
  object_type: "config";
  candidate_id: Id<"ctr">;
  candidate_hash: Hash;
  binding: VersionBinding;
  config_space_id: Hash;
  field_registry_snapshot_hash: Hash;
  layer_id: string;
  model_scope_key: string;
  root_id: string;
  /** CFG-resolved absolute realpath for this call; FND never persists it. */
  approved_root: string;
  target_path: string;
  expected_config_version: string;
  reason: "trial_write" | "trial_rollback";
}

export interface ConfigWriteCommitRequest {
  schema_version: "rsi.config_write/1";
  deadline_ms: number;
  /** base64url, 32 bytes; never persisted in clear. */
  lock_handle: string;
  fencing_token: number;
  base_file_hash: Hash;
  patch: ConfigWritePatch;
  idempotency_key: string;
}

export interface ConfigWriteAbortRequest {
  schema_version: "rsi.config_write/1";
  deadline_ms: number;
  lock_handle: string;
  fencing_token: number;
}

export interface ConfigWriteLock {
  schema_version: "rsi.config_write/1";
  lock_handle: string;
  fencing_token: number;
  base_file_hash: Hash;
  base_config_version: string;
  base_content_ref: SourceRef;
  root_identity_pin: RootIdentityPin;
  root_registration_hash: Hash;
  expires_at: number;
}

export interface ConfigWriteResult {
  schema_version: "rsi.config_write_result/1";
  config_write_id: Id<"cwi">;
  candidate_id: Id<"ctr">;
  /** Always the normalized `patch_hash`. */
  candidate_hash: Hash;
  attempt: number;
  state: ConfigWriteTerminalState;
  path: string;
  candidate_content_hash: Hash | null;
  new_file_hash: Hash | null;
  new_semantic_hash: Hash | null;
  snapshot_id: Id<"wsnap"> | null;
  readback_verified: boolean;
  protected_subtrees_verified: boolean;
  atomicity: "single_file_atomic" | "none";
  exclusion: "native_cooperative" | "rsi_advisory" | "none";
  error_code: string | null;
  completed_at: number;
}

export interface ConfigWriteAbortAck {
  schema_version: "rsi.config_write/1";
  state: "aborted" | "no_op";
  released: boolean;
}

export interface ConfigWritePort {
  lock(input: ConfigWriteLockRequest, signal?: AbortSignal): Promise<Result<ConfigWriteLock, ErrorEnvelope>>;
  commit(
    input: ConfigWriteCommitRequest,
    signal?: AbortSignal
  ): Promise<Result<ConfigWriteResult, ErrorEnvelope>>;
  abort(
    input: ConfigWriteAbortRequest,
    signal?: AbortSignal
  ): Promise<Result<ConfigWriteAbortAck, ErrorEnvelope>>;
}

export interface ConfigWriteReadPort {
  getConfigWrite(input: { config_write_id: Id<"cwi"> }): Promise<Result<ConfigWriteResult, ErrorEnvelope>>;
}

/* ------------------------------------------------------------------ */
/* Safety audit                                                        */
/* ------------------------------------------------------------------ */

export type SafetyAuditEventKind =
  | "forbidden_field_attempt"
  | "forbidden_path_attempt"
  | "protected_subtree_violation"
  | "root_escape_attempt";

export type SafetyAuditClassification = "forbidden" | "allowed" | "unknown";

export type SafetyAuditReasonCode =
  | "forbidden_class"
  | "deny_rule"
  | "protected_subtree"
  | "root_escape"
  | "out_of_scope";

export type SafetyAuditMissingSource =
  | "fnd_config_write_intent"
  | "fnd_config_write_result"
  | "fnd_journal"
  | "cfg_attempt";

export interface SafetyAuditEvent {
  /** `fnd:<config_write_id>/<attempt>` or `cfg:<trial_id>/<sequence>`. */
  event_id: string;
  sample_id: string | null;
  occurred_at: number;
  kind: SafetyAuditEventKind;
  classification: SafetyAuditClassification;
  reason_code: SafetyAuditReasonCode;
  /** Ascending by `field_id` UTF-8. */
  field_ids: readonly Id<"fld">[];
  /** Relative path only; no absolute path, realpath, `..`, NUL or drive/UNC. */
  target_path: string | null;
  evidence_ref: SourceRef;
}

export interface SafetyAuditRequest {
  schema_version: "rsi.safety_audit_request/1";
  request_id: string;
  trial_id: Id<"ctr">;
  sample_id: string | null;
  audit_scope: "sample_close" | "window_close";
  config_space_id: Hash;
  field_registry_snapshot_hash: Hash;
  root_id: string;
  root_identity_pin: RootIdentityPin;
  protected_subtrees: readonly ConfigProtectedSubtree[];
  attempt_refs: readonly { trial_id: Id<"ctr">; sequence: number }[];
  window: { opened_at: number; closed_at: number };
  deadline_ms: number;
  signal?: AbortSignal;
}

export interface SafetyAuditResult {
  schema_version: "rsi.safety_audit_result/1";
  request_id: string;
  trial_id: Id<"ctr">;
  sample_id: string | null;
  audit_scope: "sample_close" | "window_close";
  window: { opened_at: number; closed_at: number };
  /** Ascending by `event_id` UTF-8, deduplicated. */
  events: readonly SafetyAuditEvent[];
  forbidden_event_count: number;
  complete: boolean;
  /** Ascending UTF-8, deduplicated. */
  missing_sources: readonly SafetyAuditMissingSource[];
  evidence_ref: SourceRef;
  evidence_hash: Hash;
}

export interface SafetyAuditPort {
  audit(input: SafetyAuditRequest): Promise<Result<SafetyAuditResult, ErrorEnvelope>>;
}

/* ------------------------------------------------------------------ */
/* Patch DTOs                                                          */
/* ------------------------------------------------------------------ */

export interface ConfigFilePath {
  kind: "file";
  format: "json" | "jsonc" | "yaml" | "toml";
  root: "user" | "project" | "managed" | "session";
  relative_path: string;
  pointer: string;
  create: boolean;
}

export type ConfigAssignmentValue =
  | { presence: "present"; value: string | number | boolean | null }
  | { presence: "absent" };

export interface ConfigFieldAssignment {
  field_id: Id<"fld">;
  path: ConfigFilePath;
  value: ConfigAssignmentValue;
}

export type ConfigFieldMutation =
  | { op: "set"; field_id: Id<"fld">; path: ConfigFilePath; value: string | number | boolean | null }
  | { op: "remove"; field_id: Id<"fld">; path: ConfigFilePath };

export interface ConfigProtectedSubtree {
  path: string;
  semantic_hash: Hash;
}

export interface ConfigProtectedSubtreeProof {
  path: string;
  expected_semantic_hash: Hash;
  before_semantic_hash: Hash;
  after_semantic_hash: Hash;
}

export interface ConfigWritePatch {
  schema_version: "rsi.config_write/1";
  config_space_id: Hash;
  field_registry_snapshot_hash: Hash;
  layer_id: string;
  model_scope_key: string;
  target_path: string;
  /** Base values read by the parser; ascending and unique by `field_id`. */
  expected_fields: ConfigFieldAssignment[];
  /** Ascending by `(field_id, canonical path text)`, unique. */
  mutations: ConfigFieldMutation[];
  /** Ascending by `path`, unique. */
  protected_subtrees: ConfigProtectedSubtree[];
  /** Post-write values; ascending and unique by `field_id`. */
  candidate_values: ConfigFieldAssignment[];
  patch_hash: Hash;
}

/* ------------------------------------------------------------------ */
/* Persisted config write records                                      */
/* ------------------------------------------------------------------ */

export interface ConfigWriteIntent {
  schema_version: "rsi.config_write_intent/1";
  config_write_id: Id<"cwi">;
  idempotency_key: string;
  request_hash: Hash;
  grant_id: Id<"grant">;
  action: "update" | "rollback";
  object_type: "config";
  candidate_id: Id<"ctr">;
  candidate_hash: Hash;
  patch_hash: Hash;
  patch: ConfigWritePatch;
  auth_decision: WriteDecision;
  binding: VersionBinding;
  config_space_id: Hash;
  field_registry_snapshot_hash: Hash;
  layer_id: string;
  model_scope_key: string;
  root_id: string;
  root_registration_hash: Hash;
  root_identity_pin: RootIdentityPin;
  target_path: string;
  expected_config_version: string;
  reason: "trial_write" | "trial_rollback";
  base_file_hash: Hash;
  base_content_ref: SourceRef;
  base_byte_length: number;
  candidate_content_hash: Hash | null;
  candidate_content_ref: SourceRef | null;
  new_semantic_hash: Hash | null;
  protected_subtree_proof: ConfigProtectedSubtreeProof[];
  snapshot_id: Id<"wsnap"> | null;
  state: ConfigWriteState;
  attempt: number;
  last_error_code: string | null;
  row_version: number;
  created_at: number;
  updated_at: number;
}

export interface ConfigWriteSnapshot {
  schema_version: "rsi.config_write_snapshot/1";
  snapshot_id: Id<"wsnap">;
  config_write_id: Id<"cwi">;
  path: string;
  base_file_hash: Hash;
  content_ref: SourceRef;
  byte_length: number;
  created_at: number;
}

/* ------------------------------------------------------------------ */
/* Parser / apply port                                                 */
/* ------------------------------------------------------------------ */

export interface ConfigPatchApplyInput {
  patch: ConfigWritePatch;
  base_bytes: Uint8Array;
  base_file_hash: Hash;
}

export interface ConfigPatchApplyOutput {
  /** Bounded by `CONFIG_WRITE_MAX_CONTENT_BYTES`; FND writes it. */
  new_content: Uint8Array;
  candidate_content_hash: Hash;
  new_semantic_hash: Hash;
  applied_fields: ConfigFieldAssignment[];
  protected_subtrees_verified: true;
  protected_subtree_proof: ConfigProtectedSubtreeProof[];
}

export type ConfigPatchApplyFailureReason =
  | "expected_field_mismatch"
  | "protected_subtree_mismatch"
  | "unsupported_field"
  | "forbidden_field"
  | "path_invalid"
  | "candidate_mismatch"
  | "parser_failed"
  | "serializer_failed";

export interface ConfigPatchApplyFailure {
  reason: ConfigPatchApplyFailureReason;
  field_id: Id<"fld"> | null;
  path: string | null;
}

/**
 * Outcome of the parser/apply port.
 *
 * `@evoplug/core`'s `Result` constrains its error to `ErrorEnvelope`, while the
 * design declares `Result<ConfigPatchApplyOutput, ConfigPatchApplyFailure>`.
 * This local union keeps the design's discriminated shape; FND maps a failure
 * onto `E_WRITE_CONFIG_APPLY` with `details.apply_reason`.
 */
export type ConfigPatchApplyResult =
  | { ok: true; status: "ok"; value: ConfigPatchApplyOutput }
  | { ok: false; status: "rejected"; error: ConfigPatchApplyFailure };

export interface ConfigPatchApplyPort {
  /** Pure byte/syntax-tree transform: no file, network, clock or grant access. */
  apply(input: ConfigPatchApplyInput): Promise<ConfigPatchApplyResult>;
}
