/**
 * Authorization, managed-write and config-write error envelopes
 * (DD-FND-090, DD-FND-091, DD-FND-095.6).
 *
 * Authorization failures always use `details.kind="authorization"` with a
 * closed `denied_dimension`; config-write failures use `details.kind=
 * "config_write"` only for the two codes that require it.
 */
import type { ErrorEnvelope, Hash, Id } from "@evoplug/core";
import type { GrantObjectType, WriteDenyReasonCode } from "@evoplug/core";
export type AuthErrorCode = "E_AUTH_DENIED" | "E_AUTH_UNAVAILABLE" | "E_AUTH_CONFIG_SCOPE" | "E_GRANT_SCOPE" | "E_GRANT_OBJECT_ID" | "E_WRITE_SCOPE_UNRESOLVED" | "E_WRITE_CANDIDATE_ID" | "E_WRITE_CANDIDATE_HASH" | "E_WRITE_STATE" | "E_WRITE_NOT_FOUND" | "E_WRITE_MODE_UNSUPPORTED" | "E_WRITE_ROLLBACK_TARGET" | "E_WRITE_CONFIG_PATCH" | "E_WRITE_CONFIG_FIELD" | "E_WRITE_CONFIG_PATH" | "E_WRITE_CONFIG_UNSUPPORTED" | "E_WRITE_CONFIG_STALE" | "E_WRITE_CONFIG_LOCKED" | "E_WRITE_CONFIG_APPLY" | "E_WRITE_CONFIG_READBACK" | "E_WRITE_CONFIG_RECOVERY_REQUIRED" | "E_WRITE_CONFIG_NOT_FOUND" | "E_WRITE_CONFIG_CONTENT" | "E_WRITE_CONFIG_IN_PROGRESS" | "E_BLOCK_SELECTOR" | "E_BLOCK_CONTENT" | "E_BLOCK_STATE" | "E_BLOCK_HASH_MISMATCH" | "E_BLOCK_MALFORMED" | "E_BLOCK_AMBIGUOUS" | "E_PATH_ESCAPE" | "E_PATH_CHANGED" | "E_ROOT_NOT_FOUND" | "E_ROOT_UNAVAILABLE" | "E_ROOT_INVALID" | "E_ROOT_AMBIGUOUS" | "E_ROOT_IDENTITY_MISMATCH" | "E_SCHEMA" | "E_VERSION_BINDING" | "E_IDEMPOTENCY_CONFLICT" | "E_DEADLINE_EXCEEDED" | "E_CANCELLED";
export interface AuthErrorInput {
    readonly code: AuthErrorCode;
    readonly stage: string;
    readonly details: ErrorEnvelope["details"];
    readonly trace_id?: Id<"ipc">;
    readonly retryable?: boolean;
    readonly detail_ref?: ErrorEnvelope["detail_ref"];
    readonly retry_after_ms?: number;
}
/** Builds an auth/write `ErrorEnvelope` with per-code registry defaults. */
export declare function authError(input: AuthErrorInput): ErrorEnvelope;
export type AuthorizationDeniedDimension = "object" | "project" | "config_space" | "path" | "block" | "action" | "mode" | "expiry" | "scope_empty";
/** Maps a `WriteDecision` deny reason onto the authorization detail dimension. */
export declare function deniedDimensionFor(reason: WriteDenyReasonCode): AuthorizationDeniedDimension;
/** `details.kind="authorization"` (DD-FND-034). */
export declare function authorizationDetails(input: {
    object_type: string;
    denied_dimension: AuthorizationDeniedDimension;
    grant_id?: Id<"grant">;
}): ErrorEnvelope["details"];
/** `E_AUTH_DENIED` with the closed authorization detail branch. */
export declare function authDenied(input: {
    object_type: GrantObjectType | "grant" | "write";
    reason: WriteDenyReasonCode | "attestation" | "proof";
    grant_id?: Id<"grant">;
    stage?: string;
}): ErrorEnvelope;
/** `E_AUTH_CONFIG_SCOPE`: v1 config grant without `config_scope`, or axis miss. */
export declare function authConfigScope(grantId?: Id<"grant">): ErrorEnvelope;
/** Schema-level rejection with the precise field. */
export declare function fieldError(code: AuthErrorCode, path: string, rule: string, stage?: string): ErrorEnvelope;
/** `E_WRITE_CONFIG_APPLY` carries the parser failure reason verbatim. */
export declare function configApplyError(input: {
    apply_reason: "expected_field_mismatch" | "candidate_mismatch" | "protected_subtree_mismatch" | "parser_failed" | "serializer_failed" | "forbidden_field" | "unsupported_field" | "path_invalid";
    field_id?: Id<"fld">;
    path?: string;
}): ErrorEnvelope;
/** `E_WRITE_CONFIG_STALE` names which precondition failed. */
export declare function configStaleError(stale_reason: "base_changed" | "lock_expired" | "fencing" | "connection"): ErrorEnvelope;
/** `E_VERSION_BINDING` on a six-field comparison. */
export declare function versionBindingError(path: string): ErrorEnvelope;
/** `E_IDEMPOTENCY_CONFLICT` with the conflicting hashes. */
export declare function idempotencyConflict(key: string, existingHash: Hash, incomingHash: Hash): ErrorEnvelope;
/** True when `code` belongs to the auth package's closed set. */
export declare function isAuthErrorCode(code: string): code is AuthErrorCode;
