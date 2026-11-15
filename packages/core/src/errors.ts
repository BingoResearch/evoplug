/**
 * Error envelope, shared status axes and error construction (DD-FND-034,
 * DD-FND-035, DD-FND-103).
 *
 * The machine source for error codes is `schemas/errors/registry.json`
 * (root `rsi.error_registry/1`). Alias codes never appear at runtime; every
 * envelope carries the canonical code, one closed detail branch, a stable
 * `message_key` and a correlation `trace_id`.
 */

import { newId, type Id } from "./ids.js";
import { isHash, type Hash } from "./hash.js";
import type { JsonValue } from "./json.js";
import type { SourceRef } from "./source-ref.js";

/**
 * Canonical error code.
 *
 * The literal union is generated from the registry fragments and published by
 * the generated schema module (DD-FND-103). Core root keeps the structural
 * namespace type so each owner package can type its own subset without a
 * second local code list; runtime validation uses the registry pattern.
 */
export type ErrorCode = `E_${string}`;

export type ErrorCategory =
  | "usage"
  | "schema"
  | "version"
  | "not_found"
  | "policy"
  | "authorization"
  | "budget"
  | "deadline"
  | "source"
  | "conflict"
  | "storage"
  | "ipc"
  | "capacity"
  | "external"
  | "internal";

export type ErrorSideEffect = "none" | "committed" | "partial" | "unknown";

/** Registry detail branch for EVD-owned codes (DD-FND-035, DD-EVD-024). */
export type RegistryErrorDetails<C extends ErrorCode = ErrorCode, D extends JsonValue = JsonValue> = {
  kind: "registry";
  code: C;
  details: D;
};

export type ErrorDetails =
  | { kind: "none" }
  | { kind: "field"; path: string; rule: string }
  | { kind: "version"; expected: string; actual: string }
  | {
      kind: "source";
      source_ref: string;
      reason: "missing" | "tombstoned" | "hash_mismatch" | "out_of_range" | "not_utf8" | "too_large";
    }
  | { kind: "source_unretrievable"; source_ref: string; upstream_code: string }
  | { kind: "source_conflict"; source_ref: string; expected: string; actual: string }
  | { kind: "idempotency"; key: string; existing_hash: Hash; incoming_hash: Hash }
  | { kind: "conflict"; current_hash: Hash; expected_hash: Hash; diff_ref?: SourceRef }
  | {
      kind: "budget";
      scope_key: string;
      policy_version: string;
      budget_kind: "token" | "cost" | "attempt" | "rate" | "deadline";
      remaining: number | null;
    }
  | {
      kind: "authorization";
      grant_id?: Id<"grant">;
      object_type: string;
      denied_dimension:
        | "object"
        | "project"
        | "config_space"
        | "path"
        | "block"
        | "action"
        | "mode"
        | "expiry"
        | "scope_empty";
    }
  | {
      kind: "egress";
      policy_version: string;
      denied_dimension: "endpoint" | "model" | "data_class" | "project_exclusion" | "byte_limit" | "approval";
      refs: SourceRef[];
    }
  | {
      kind: "replay";
      replay_plan_id?: Id<"rpl">;
      reason:
        | "needs_approval"
        | "network_scope_mismatch"
        | "isolation_unverified"
        | "classifier_unknown"
        | "approval_not_found"
        | "approval_mismatch"
        | "approval_consumed"
        | "approval_expired"
        | "approval_revoked"
        | "approval_state"
        | "plan_not_found"
        | "plan_mismatch"
        | "plan_state"
        | "execution_reconcile_required"
        | "execution_in_progress"
        | "execution_unknown"
        | "reconcile_conflict"
        | "attestation_unverified";
    }
  | {
      kind: "config_write";
      apply_reason?:
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
      stale_reason?: "base_changed" | "lock_expired" | "fencing" | "connection";
    }
  | { kind: "ipc"; method: string; connection_id: string; frame_kind: string }
  | {
      kind: "capacity";
      policy_version: string;
      queue_depth: number;
      queue_capacity: number;
      inflight: number;
      max_inflight: number;
    }
  | {
      kind: "resource";
      resource: "fd" | "memory" | "child_process";
      limit: number;
      observed: number;
    }
  | { kind: "storage"; operation: string; sqlite_code?: string; journal_offset?: number }
  | { kind: "external"; provider: string; http_status?: number; provider_code?: string }
  | { kind: "internal"; incident_id: string }
  | RegistryErrorDetails;

export interface ErrorEnvelope {
  schema_version: "rsi.error/1";
  code: ErrorCode;
  category: ErrorCategory;
  retryable: boolean;
  side_effect: ErrorSideEffect;
  message_key: string;
  details: ErrorDetails;
  stage: string;
  detail_ref?: SourceRef;
  retry_after_ms?: number;
  trace_id: Id<"ipc">;
}

export interface ErrorEnvelopeInit {
  code: ErrorCode;
  category: ErrorCategory;
  message_key: string;
  stage: string;
  details: ErrorDetails;
  /** Defaults to false; only registry-allowed contexts override (DD-FND-034). */
  retryable?: boolean;
  /** Defaults to "none". */
  side_effect?: ErrorSideEffect;
  detail_ref?: SourceRef;
  retry_after_ms?: number;
  /** Defaults to a locally generated `ipc:` correlation id. */
  trace_id?: Id<"ipc">;
}

const ERROR_CODE_PATTERN = /^E_[A-Z0-9_]+$/;
const ERROR_STAGE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

export function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODE_PATTERN.test(value);
}

export function isErrorCategory(value: string): value is ErrorCategory {
  switch (value) {
    case "usage":
    case "schema":
    case "version":
    case "not_found":
    case "policy":
    case "authorization":
    case "budget":
    case "deadline":
    case "source":
    case "conflict":
    case "storage":
    case "ipc":
    case "capacity":
    case "external":
    case "internal":
      return true;
    default:
      return false;
  }
}

export function isErrorSideEffect(value: string): value is ErrorSideEffect {
  return value === "none" || value === "committed" || value === "partial" || value === "unknown";
}

/** `stage` must match `^[a-z][a-z0-9_.-]{0,63}$` (DD-FND-034). */
export function isErrorStage(value: string): boolean {
  return ERROR_STAGE_PATTERN.test(value);
}

/**
 * Builds a complete `ErrorEnvelope`. Required identity fields never default:
 * callers must supply the registry `code`, `category`, `message_key`, `stage`
 * and the discriminant detail branch.
 */
export function makeErrorEnvelope(init: ErrorEnvelopeInit): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    schema_version: "rsi.error/1",
    code: init.code,
    category: init.category,
    retryable: init.retryable ?? false,
    side_effect: init.side_effect ?? "none",
    message_key: init.message_key,
    details: init.details,
    stage: init.stage,
    trace_id: init.trace_id ?? newId("ipc")
  };
  if (init.detail_ref !== undefined) {
    envelope.detail_ref = init.detail_ref;
  }
  if (init.retry_after_ms !== undefined) {
    envelope.retry_after_ms = init.retry_after_ms;
  }
  return envelope;
}

/** Fact truth axis (DD-FND-034). `CapabilityStatus` and `EvidenceStage` stay in HOST. */
export type TruthState = "claim" | "observed" | "verified" | "contradicted" | "unknown";

/** Task lifecycle axis (DD-FND-034). */
export type TaskOutcome = "active" | "paused" | "cancelled" | "ended_unverified" | "succeeded" | "failed";

/** Delivery transport axis (DD-FND-034). */
export type DeliveryState = "pending" | "submitted" | "expired" | "failed";

export function isTruthState(value: string): value is TruthState {
  return (
    value === "claim" ||
    value === "observed" ||
    value === "verified" ||
    value === "contradicted" ||
    value === "unknown"
  );
}

export function isTaskOutcome(value: string): value is TaskOutcome {
  return (
    value === "active" ||
    value === "paused" ||
    value === "cancelled" ||
    value === "ended_unverified" ||
    value === "succeeded" ||
    value === "failed"
  );
}

export function isDeliveryState(value: string): value is DeliveryState {
  return value === "pending" || value === "submitted" || value === "expired" || value === "failed";
}

/* ------------------------------------------------------------------ */
/* Code → ErrorDetails compatibility (DD-FND-035, DD-FND-103)          */
/* ------------------------------------------------------------------ */

const APPLY_REASONS = [
  "expected_field_mismatch",
  "candidate_mismatch",
  "protected_subtree_mismatch",
  "parser_failed",
  "serializer_failed",
  "forbidden_field",
  "unsupported_field",
  "path_invalid"
] as const;

const STALE_REASONS = ["base_changed", "lock_expired", "fencing", "connection"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) {
    return false;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (isRecord(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
  }
  return false;
}

function isClosedDetailShape(details: unknown): details is ErrorDetails {
  if (!isRecord(details) || !isString(details["kind"])) {
    return false;
  }
  switch (details["kind"]) {
    case "none":
      return hasOnlyKeys(details, ["kind"]);
    case "field":
      return (
        hasOnlyKeys(details, ["kind", "path", "rule"]) &&
        isNonEmptyString(details["path"]) &&
        isNonEmptyString(details["rule"])
      );
    case "version":
      return (
        hasOnlyKeys(details, ["kind", "expected", "actual"]) &&
        isString(details["expected"]) &&
        isString(details["actual"])
      );
    case "source":
      return (
        hasOnlyKeys(details, ["kind", "source_ref", "reason"]) &&
        isNonEmptyString(details["source_ref"]) &&
        isOneOf(details["reason"], [
          "missing",
          "tombstoned",
          "hash_mismatch",
          "out_of_range",
          "not_utf8",
          "too_large"
        ])
      );
    case "source_unretrievable":
      return (
        hasOnlyKeys(details, ["kind", "source_ref", "upstream_code"]) &&
        isNonEmptyString(details["source_ref"]) &&
        isString(details["upstream_code"])
      );
    case "source_conflict":
      return (
        hasOnlyKeys(details, ["kind", "source_ref", "expected", "actual"]) &&
        isNonEmptyString(details["source_ref"]) &&
        isString(details["expected"]) &&
        isString(details["actual"])
      );
    case "idempotency":
      return (
        hasOnlyKeys(details, ["kind", "key", "existing_hash", "incoming_hash"]) &&
        isNonEmptyString(details["key"]) &&
        isString(details["existing_hash"]) &&
        isHash(details["existing_hash"]) &&
        isString(details["incoming_hash"]) &&
        isHash(details["incoming_hash"])
      );
    case "conflict":
      return (
        hasOnlyKeys(details, ["kind", "current_hash", "expected_hash", "diff_ref"]) &&
        isString(details["current_hash"]) &&
        isHash(details["current_hash"]) &&
        isString(details["expected_hash"]) &&
        isHash(details["expected_hash"]) &&
        (details["diff_ref"] === undefined || isNonEmptyString(details["diff_ref"]))
      );
    case "budget":
      return (
        hasOnlyKeys(details, ["kind", "scope_key", "policy_version", "budget_kind", "remaining"]) &&
        isNonEmptyString(details["scope_key"]) &&
        isNonEmptyString(details["policy_version"]) &&
        isOneOf(details["budget_kind"], ["token", "cost", "attempt", "rate", "deadline"]) &&
        (details["remaining"] === null || isNonNegativeInteger(details["remaining"]))
      );
    case "authorization":
      return (
        hasOnlyKeys(details, ["kind", "grant_id", "object_type", "denied_dimension"]) &&
        (details["grant_id"] === undefined || isNonEmptyString(details["grant_id"])) &&
        isNonEmptyString(details["object_type"]) &&
        isOneOf(details["denied_dimension"], [
          "object",
          "project",
          "config_space",
          "path",
          "block",
          "action",
          "mode",
          "expiry",
          "scope_empty"
        ])
      );
    case "egress":
      return (
        hasOnlyKeys(details, ["kind", "policy_version", "denied_dimension", "refs"]) &&
        isNonEmptyString(details["policy_version"]) &&
        isOneOf(details["denied_dimension"], [
          "endpoint",
          "model",
          "data_class",
          "project_exclusion",
          "byte_limit",
          "approval"
        ]) &&
        Array.isArray(details["refs"]) &&
        details["refs"].every((ref) => isNonEmptyString(ref))
      );
    case "replay":
      return (
        hasOnlyKeys(details, ["kind", "replay_plan_id", "reason"]) &&
        (details["replay_plan_id"] === undefined || isNonEmptyString(details["replay_plan_id"])) &&
        isOneOf(details["reason"], [
          "needs_approval",
          "network_scope_mismatch",
          "isolation_unverified",
          "classifier_unknown",
          "approval_not_found",
          "approval_mismatch",
          "approval_consumed",
          "approval_expired",
          "approval_revoked",
          "approval_state",
          "plan_not_found",
          "plan_mismatch",
          "plan_state",
          "execution_reconcile_required",
          "execution_in_progress",
          "execution_unknown",
          "reconcile_conflict",
          "attestation_unverified"
        ])
      );
    case "config_write": {
      if (
        !hasOnlyKeys(details, ["kind", "apply_reason", "field_id", "path", "stale_reason"]) ||
        (details["field_id"] !== undefined && !isNonEmptyString(details["field_id"])) ||
        (details["path"] !== undefined && !isNonEmptyString(details["path"]))
      ) {
        return false;
      }
      const hasApply = details["apply_reason"] !== undefined;
      const hasStale = details["stale_reason"] !== undefined;
      if (hasApply === hasStale) {
        return false;
      }
      if (hasApply) {
        return isOneOf(details["apply_reason"], APPLY_REASONS);
      }
      return (
        isOneOf(details["stale_reason"], STALE_REASONS) &&
        details["field_id"] === undefined &&
        details["path"] === undefined
      );
    }
    case "ipc":
      return (
        hasOnlyKeys(details, ["kind", "method", "connection_id", "frame_kind"]) &&
        isNonEmptyString(details["method"]) &&
        isNonEmptyString(details["connection_id"]) &&
        isNonEmptyString(details["frame_kind"])
      );
    case "capacity":
      return (
        hasOnlyKeys(details, [
          "kind",
          "policy_version",
          "queue_depth",
          "queue_capacity",
          "inflight",
          "max_inflight"
        ]) &&
        isNonEmptyString(details["policy_version"]) &&
        isNonNegativeInteger(details["queue_depth"]) &&
        isNonNegativeInteger(details["queue_capacity"]) &&
        isNonNegativeInteger(details["inflight"]) &&
        isNonNegativeInteger(details["max_inflight"])
      );
    case "resource":
      return (
        hasOnlyKeys(details, ["kind", "resource", "limit", "observed"]) &&
        isOneOf(details["resource"], ["fd", "memory", "child_process"]) &&
        isNonNegativeInteger(details["limit"]) &&
        isNonNegativeInteger(details["observed"])
      );
    case "storage":
      return (
        hasOnlyKeys(details, ["kind", "operation", "sqlite_code", "journal_offset"]) &&
        isNonEmptyString(details["operation"]) &&
        (details["sqlite_code"] === undefined || isString(details["sqlite_code"])) &&
        (details["journal_offset"] === undefined || isNonNegativeInteger(details["journal_offset"]))
      );
    case "external":
      return (
        hasOnlyKeys(details, ["kind", "provider", "http_status", "provider_code"]) &&
        isNonEmptyString(details["provider"]) &&
        (details["http_status"] === undefined || isNonNegativeInteger(details["http_status"])) &&
        (details["provider_code"] === undefined || isString(details["provider_code"]))
      );
    case "internal":
      return hasOnlyKeys(details, ["kind", "incident_id"]) && isNonEmptyString(details["incident_id"]);
    case "registry":
      return (
        hasOnlyKeys(details, ["kind", "code", "details"]) &&
        isNonEmptyString(details["code"]) &&
        isJsonValue(details["details"])
      );
    default:
      return false;
  }
}

function detailBranchAllowedForCode(code: ErrorCode, details: ErrorDetails): boolean {
  if (code === "E_WRITE_CONFIG_APPLY") {
    return (
      details.kind === "config_write" &&
      details.apply_reason !== undefined &&
      details.stale_reason === undefined
    );
  }
  if (code === "E_WRITE_CONFIG_STALE") {
    return (
      details.kind === "config_write" &&
      details.stale_reason !== undefined &&
      details.apply_reason === undefined
    );
  }
  if (code === "E_DEADLINE_EXCEEDED" || code === "E_CANCELLED") {
    return details.kind === "none";
  }
  // The partial config_write branch is reserved for the two codes above.
  return details.kind !== "config_write";
}

/**
 * True when `details` is a closed `ErrorDetails` branch and is legal for
 * `code`. Generic envelope schema validation cannot express the code binding,
 * so callers that already know the expected code use this predicate.
 */
export function isErrorDetailsForCode(code: ErrorCode, details: unknown): details is ErrorDetails {
  return isClosedDetailShape(details) && detailBranchAllowedForCode(code, details);
}

/**
 * Validating alias of {@link isErrorDetailsForCode}, named for call sites that
 * want an explicit pass/fail verdict.
 */
export function validateErrorDetailsForCode(code: ErrorCode, details: unknown): details is ErrorDetails {
  return isErrorDetailsForCode(code, details);
}
