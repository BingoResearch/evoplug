/**
 * `WriteIntent`, `WriteSnapshot`, `WriteResult` and managed-write helpers
 * (DD-FND-091).
 *
 * All persisted paths are relative to `root_id`. The absolute `approved_root`
 * of a resolution never enters an intent, a result, a journal frame or a hash.
 */
import type { ContentUpload, ErrorEnvelope, Hash, Id, JsonValue, Result, SourceRef, VersionBinding } from "@evoplug/core";
import type { GrantPublicView } from "./grants.js";
export type WriteIntentState = "intent_recorded" | "snapshot_written" | "temp_written" | "renamed" | "dir_synced" | "verified" | "pending_approval" | "conflict" | "path_rejected" | "write_failed" | "partial" | "recovery_required";
export type WriteScopeRef = {
    kind: "task";
    task_id: Id<"task">;
} | {
    kind: "session";
    session_id: Id<"sess">;
};
export declare const WRITE_APPLY_SCHEMA_VERSION: "rsi.write_apply/1";
export declare const WRITE_INTENT_SCHEMA_VERSION: "rsi.write_intent/2";
export declare const WRITE_RESULT_SCHEMA_VERSION: "rsi.write_result/2";
export declare const WRITE_SNAPSHOT_SCHEMA_VERSION: "rsi.write_snapshot/2";
export declare const WRITE_SCOPE_SCHEMA_VERSION: "rsi.write_scope/1";
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
/** Allowed transitions from the DD-FND-091 state diagram. */
export declare const WRITE_TRANSITIONS: Readonly<Record<WriteIntentState, readonly WriteIntentState[]>>;
/** States after which a `write_id` accepts no further attempt. */
export declare const WRITE_TERMINAL_STATES: readonly WriteIntentState[];
export declare function isWriteTerminalState(state: WriteIntentState): boolean;
export declare function isWriteTransitionAllowed(from: WriteIntentState, to: WriteIntentState): boolean;
/** True once any `verified` result exists: the `write_id` is sealed. */
export declare function isSealedWrite(latest: WriteResult | null): boolean;
/**
 * A new attempt may be appended unless a `verified` result already exists
 * (DD-FND-091). Other terminal states keep returning their latest attempt.
 */
export declare function canAppendWriteAttempt(latest: WriteResult | null): boolean;
/**
 * Applies one state transition with the `row_version` CAS convention.
 *
 * The caller performs the SQLite CAS; this helper only enforces the allowed
 * transition set and produces the next row value.
 */
export declare function transitionWriteIntent(input: {
    intent: WriteIntent;
    to: WriteIntentState;
    now: number;
    error_code?: string | null;
}): Result<WriteIntent, ErrorEnvelope>;
/** Appending after `verified` is refused with `E_WRITE_STATE`, zero writes. */
export declare function assertAppendable(latest: WriteResult | null): Result<null, ErrorEnvelope>;
export interface WriteScopeInput {
    scope_kind: "task" | "session";
    scope_ref_id: string;
    project_id: string | null;
    config_space_id: string | null;
}
/**
 * `scope_hash = sha256(JCS({schema_version:"rsi.write_scope/1", scope_kind,
 * scope_ref_id, project_id, config_space_id}))`.
 */
export declare function writeScopeHash(input: WriteScopeInput): Hash;
export interface WriteRequestHashInput {
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
export declare function writeRequestHash(input: WriteRequestHashInput): Hash;
/** `snapshot_hash` over the DD-FND-091 whitelist; excludes id and time. */
export declare function writeSnapshotHash(snapshot: Omit<WriteSnapshot, "snapshot_hash">): Hash;
/** Recomputes and compares the stored snapshot hash. */
export declare function verifyWriteSnapshotHash(snapshot: WriteSnapshot): boolean;
/** JCS preimage of `snapshot_hash`. */
export declare function writeSnapshotPreimage(snapshot: Omit<WriteSnapshot, "snapshot_hash">): JsonValue;
/**
 * Validates the request against the DD-FND-091 shape rules.
 *
 * `object_type="config"` is rejected with `E_WRITE_MODE_UNSUPPORTED` before any
 * intent is created: config files only go through `ConfigWritePort`.
 */
export declare function validateWriteApplyRequest(request: WriteApplyRequest): Result<WriteApplyRequest, ErrorEnvelope>;
/**
 * Relative path rules shared by `target_path`, `ConfigWriteLock.target_path`
 * and `WriteResult.path`: non-empty, no NUL, not absolute, no `..` component,
 * no Windows drive/UNC prefix.
 */
export declare function validateRelativeTargetPath(value: string): Result<string, ErrorEnvelope>;
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
export declare function validateRollbackTarget(request: WriteApplyRequest, target: RollbackTargetState): Result<RollbackTargetState, ErrorEnvelope>;
