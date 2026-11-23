/**
 * Authorization, managed-write and config-write error envelopes
 * (DD-FND-090, DD-FND-091, DD-FND-095.6).
 *
 * Authorization failures always use `details.kind="authorization"` with a
 * closed `denied_dimension`; config-write failures use `details.kind=
 * "config_write"` only for the two codes that require it.
 */

import { newId } from "@evoplug/core";
import type { ErrorEnvelope, Hash, Id } from "@evoplug/core";

import type { GrantObjectType, WriteDenyReasonCode } from "@evoplug/core";

type AuthErrorCode =
  | "E_AUTH_DENIED"
  | "E_AUTH_UNAVAILABLE"
  | "E_AUTH_CONFIG_SCOPE"
  | "E_GRANT_SCOPE"
  | "E_GRANT_OBJECT_ID"
  | "E_WRITE_SCOPE_UNRESOLVED"
  | "E_WRITE_CANDIDATE_ID"
  | "E_WRITE_CANDIDATE_HASH"
  | "E_WRITE_STATE"
  | "E_WRITE_NOT_FOUND"
  | "E_WRITE_MODE_UNSUPPORTED"
  | "E_WRITE_ROLLBACK_TARGET"
  | "E_WRITE_CONFIG_PATCH"
  | "E_WRITE_CONFIG_FIELD"
  | "E_WRITE_CONFIG_PATH"
  | "E_WRITE_CONFIG_UNSUPPORTED"
  | "E_WRITE_CONFIG_STALE"
  | "E_WRITE_CONFIG_LOCKED"
  | "E_WRITE_CONFIG_APPLY"
  | "E_WRITE_CONFIG_READBACK"
  | "E_WRITE_CONFIG_RECOVERY_REQUIRED"
  | "E_WRITE_CONFIG_NOT_FOUND"
  | "E_WRITE_CONFIG_CONTENT"
  | "E_WRITE_CONFIG_IN_PROGRESS"
  | "E_BLOCK_SELECTOR"
  | "E_BLOCK_CONTENT"
  | "E_BLOCK_STATE"
  | "E_BLOCK_HASH_MISMATCH"
  | "E_BLOCK_MALFORMED"
  | "E_BLOCK_AMBIGUOUS"
  | "E_PATH_ESCAPE"
  | "E_PATH_CHANGED"
  | "E_ROOT_NOT_FOUND"
  | "E_ROOT_UNAVAILABLE"
  | "E_ROOT_INVALID"
  | "E_ROOT_AMBIGUOUS"
  | "E_ROOT_IDENTITY_MISMATCH"
  | "E_SCHEMA"
  | "E_VERSION_BINDING"
  | "E_IDEMPOTENCY_CONFLICT"
  | "E_DEADLINE_EXCEEDED"
  | "E_CANCELLED";

const CATEGORY_BY_CODE: Readonly<Record<AuthErrorCode, ErrorEnvelope["category"]>> = {
  E_AUTH_DENIED: "authorization",
  E_AUTH_UNAVAILABLE: "authorization",
  E_AUTH_CONFIG_SCOPE: "authorization",
  E_GRANT_SCOPE: "authorization",
  E_GRANT_OBJECT_ID: "authorization",
  E_WRITE_SCOPE_UNRESOLVED: "authorization",
  E_WRITE_CANDIDATE_ID: "authorization",
  E_WRITE_CANDIDATE_HASH: "authorization",
  E_WRITE_STATE: "conflict",
  E_WRITE_NOT_FOUND: "not_found",
  E_WRITE_MODE_UNSUPPORTED: "usage",
  E_WRITE_ROLLBACK_TARGET: "policy",
  E_WRITE_CONFIG_PATCH: "policy",
  E_WRITE_CONFIG_FIELD: "authorization",
  E_WRITE_CONFIG_PATH: "policy",
  E_WRITE_CONFIG_UNSUPPORTED: "usage",
  E_WRITE_CONFIG_STALE: "conflict",
  E_WRITE_CONFIG_LOCKED: "conflict",
  E_WRITE_CONFIG_APPLY: "policy",
  E_WRITE_CONFIG_READBACK: "policy",
  E_WRITE_CONFIG_RECOVERY_REQUIRED: "policy",
  E_WRITE_CONFIG_NOT_FOUND: "not_found",
  E_WRITE_CONFIG_CONTENT: "policy",
  E_WRITE_CONFIG_IN_PROGRESS: "conflict",
  E_BLOCK_SELECTOR: "schema",
  E_BLOCK_CONTENT: "schema",
  E_BLOCK_STATE: "conflict",
  E_BLOCK_HASH_MISMATCH: "conflict",
  E_BLOCK_MALFORMED: "schema",
  E_BLOCK_AMBIGUOUS: "schema",
  E_PATH_ESCAPE: "policy",
  E_PATH_CHANGED: "conflict",
  E_ROOT_NOT_FOUND: "not_found",
  E_ROOT_UNAVAILABLE: "source",
  E_ROOT_INVALID: "schema",
  E_ROOT_AMBIGUOUS: "internal",
  E_ROOT_IDENTITY_MISMATCH: "policy",
  E_SCHEMA: "schema",
  E_VERSION_BINDING: "version",
  E_IDEMPOTENCY_CONFLICT: "conflict",
  E_DEADLINE_EXCEEDED: "deadline",
  E_CANCELLED: "usage"
};

const RETRYABLE_BY_CODE: Readonly<Record<AuthErrorCode, boolean>> = {
  E_AUTH_DENIED: false,
  E_AUTH_UNAVAILABLE: false,
  E_AUTH_CONFIG_SCOPE: false,
  E_GRANT_SCOPE: false,
  E_GRANT_OBJECT_ID: false,
  E_WRITE_SCOPE_UNRESOLVED: false,
  E_WRITE_CANDIDATE_ID: false,
  E_WRITE_CANDIDATE_HASH: false,
  E_WRITE_STATE: false,
  E_WRITE_NOT_FOUND: false,
  E_WRITE_MODE_UNSUPPORTED: false,
  E_WRITE_ROLLBACK_TARGET: false,
  E_WRITE_CONFIG_PATCH: false,
  E_WRITE_CONFIG_FIELD: false,
  E_WRITE_CONFIG_PATH: false,
  E_WRITE_CONFIG_UNSUPPORTED: false,
  E_WRITE_CONFIG_STALE: true,
  E_WRITE_CONFIG_LOCKED: true,
  E_WRITE_CONFIG_APPLY: false,
  E_WRITE_CONFIG_READBACK: false,
  E_WRITE_CONFIG_RECOVERY_REQUIRED: false,
  E_WRITE_CONFIG_NOT_FOUND: false,
  E_WRITE_CONFIG_CONTENT: false,
  E_WRITE_CONFIG_IN_PROGRESS: true,
  E_BLOCK_SELECTOR: false,
  E_BLOCK_CONTENT: false,
  E_BLOCK_STATE: false,
  E_BLOCK_HASH_MISMATCH: false,
  E_BLOCK_MALFORMED: false,
  E_BLOCK_AMBIGUOUS: false,
  E_PATH_ESCAPE: false,
  E_PATH_CHANGED: false,
  E_ROOT_NOT_FOUND: false,
  E_ROOT_UNAVAILABLE: false,
  E_ROOT_INVALID: false,
  E_ROOT_AMBIGUOUS: false,
  E_ROOT_IDENTITY_MISMATCH: false,
  E_SCHEMA: false,
  E_VERSION_BINDING: false,
  E_IDEMPOTENCY_CONFLICT: false,
  E_DEADLINE_EXCEEDED: true,
  E_CANCELLED: true
};

interface AuthErrorInput {
  readonly code: AuthErrorCode;
  readonly stage: string;
  readonly details: ErrorEnvelope["details"];
  readonly trace_id?: Id<"ipc">;
  readonly retryable?: boolean;
  readonly detail_ref?: ErrorEnvelope["detail_ref"];
  readonly retry_after_ms?: number;
}

/** Builds an auth/write `ErrorEnvelope` with per-code registry defaults. */
export function authError(input: AuthErrorInput): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    schema_version: "rsi.error/1",
    code: input.code,
    category: CATEGORY_BY_CODE[input.code],
    retryable: input.retryable ?? RETRYABLE_BY_CODE[input.code],
    side_effect: "none",
    message_key: `error.${input.code.toLowerCase()}`,
    details: input.details,
    stage: input.stage,
    trace_id: input.trace_id ?? newId("ipc")
  };
  if (input.detail_ref !== undefined) {
    envelope.detail_ref = input.detail_ref;
  }
  if (input.retry_after_ms !== undefined) {
    envelope.retry_after_ms = input.retry_after_ms;
  }
  return envelope;
}

type AuthorizationDeniedDimension =
  | "object"
  | "project"
  | "config_space"
  | "path"
  | "block"
  | "action"
  | "mode"
  | "expiry"
  | "scope_empty";

/** Maps a `WriteDecision` deny reason onto the authorization detail dimension. */
export function deniedDimensionFor(reason: WriteDenyReasonCode): AuthorizationDeniedDimension {
  switch (reason) {
    case "project_out_of_scope":
      return "project";
    case "config_space_out_of_scope":
    case "config_space_not_exact":
      return "config_space";
    case "path_out_of_scope":
    case "target_unmanaged":
      return "path";
    case "object_type_mismatch":
    case "object_out_of_scope":
    case "candidate_mismatch":
    case "config_scope_missing":
    case "config_field_out_of_scope":
    case "config_layer_out_of_scope":
    case "config_model_scope_out_of_scope":
      return "object";
    case "action_not_granted":
      return "action";
    case "mode_consumed":
      return "mode";
    case "expired":
      return "expiry";
    case "grant_scope_empty":
      return "scope_empty";
    case "revoked":
    case "subject_mismatch":
    case "no_grant":
      return "action";
    case "approval_required":
      return "action";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** `details.kind="authorization"` (DD-FND-034). */
export function authorizationDetails(input: {
  object_type: string;
  denied_dimension: AuthorizationDeniedDimension;
  grant_id?: Id<"grant">;
}): ErrorEnvelope["details"] {
  return {
    kind: "authorization",
    object_type: input.object_type,
    denied_dimension: input.denied_dimension,
    ...(input.grant_id === undefined ? {} : { grant_id: input.grant_id })
  };
}

/** `E_AUTH_DENIED` with the closed authorization detail branch. */
export function authDenied(input: {
  object_type: GrantObjectType | "grant" | "write";
  reason: WriteDenyReasonCode | "attestation" | "proof";
  grant_id?: Id<"grant">;
  stage?: string;
}): ErrorEnvelope {
  const dimension: AuthorizationDeniedDimension =
    input.reason === "attestation" || input.reason === "proof"
      ? "action"
      : deniedDimensionFor(input.reason);
  return authError({
    code: "E_AUTH_DENIED",
    stage: input.stage ?? "write_authorize",
    details: authorizationDetails({
      object_type: input.object_type,
      denied_dimension: dimension,
      ...(input.grant_id === undefined ? {} : { grant_id: input.grant_id })
    })
  });
}

/** `E_AUTH_CONFIG_SCOPE`: v1 config grant without `config_scope`, or axis miss. */
export function authConfigScope(grantId?: Id<"grant">): ErrorEnvelope {
  return authError({
    code: "E_AUTH_CONFIG_SCOPE",
    stage: "config_write_authorize",
    details: authorizationDetails({
      object_type: "config",
      denied_dimension: "object",
      ...(grantId === undefined ? {} : { grant_id: grantId })
    })
  });
}

/** Schema-level rejection with the precise field. */
export function fieldError(
  code: AuthErrorCode,
  path: string,
  rule: string,
  stage = "schema_validate"
): ErrorEnvelope {
  return authError({ code, stage, details: { kind: "field", path, rule } });
}

/** `E_WRITE_CONFIG_APPLY` carries the parser failure reason verbatim. */
export function configApplyError(input: {
  apply_reason:
    | "expected_field_mismatch"
    | "candidate_mismatch"
    | "protected_subtree_mismatch"
    | "parser_failed"
    | "serializer_failed"
    | "forbidden_field"
    | "unsupported_field"
    | "path_invalid";
  field_id?: Id<"fld">;
  path?: string;
}): ErrorEnvelope {
  return authError({
    code: "E_WRITE_CONFIG_APPLY",
    stage: "config_write_apply",
    details: {
      kind: "config_write",
      apply_reason: input.apply_reason,
      ...(input.field_id === undefined ? {} : { field_id: input.field_id }),
      ...(input.path === undefined ? {} : { path: input.path })
    }
  });
}

/** `E_WRITE_CONFIG_STALE` names which precondition failed. */
export function configStaleError(
  stale_reason: "base_changed" | "lock_expired" | "fencing" | "connection"
): ErrorEnvelope {
  return authError({
    code: "E_WRITE_CONFIG_STALE",
    stage: "config_write_precheck",
    details: { kind: "config_write", stale_reason }
  });
}

/** `E_VERSION_BINDING` on a six-field comparison. */
export function versionBindingError(path: string): ErrorEnvelope {
  return authError({
    code: "E_VERSION_BINDING",
    stage: "binding",
    details: { kind: "version", expected: "version_binding", actual: path }
  });
}

/** `E_IDEMPOTENCY_CONFLICT` with the conflicting hashes. */
export function idempotencyConflict(
  key: string,
  existingHash: Hash,
  incomingHash: Hash
): ErrorEnvelope {
  return authError({
    code: "E_IDEMPOTENCY_CONFLICT",
    stage: "idempotency",
    details: { kind: "idempotency", key, existing_hash: existingHash, incoming_hash: incomingHash }
  });
}

/** True when `code` belongs to the auth package's closed set. */
export function isAuthErrorCode(code: string): code is AuthErrorCode {
  return Object.prototype.hasOwnProperty.call(CATEGORY_BY_CODE, code);
}
