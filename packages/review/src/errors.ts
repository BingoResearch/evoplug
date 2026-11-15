/**
 * REV error envelopes (DD-REV-042, DD-REV-153).
 *
 * Every REV-owned code comes from `error-registry.ts`; the stage and
 * retryable default are read from that registry, never from the prose table.
 * FND-owned codes are passed through unchanged. Envelope construction never
 * adds `commit_state`.
 */

import { newId } from "@evoplug/core";
import type {
  ErrorCategory,
  ErrorEnvelope,
  ErrorSideEffect,
  Hash,
  Id,
  SourceRef
} from "@evoplug/core";

import type { HostAdapterError } from "./host-contracts.js";
import {
  REV_ERROR_REGISTRY_ROWS,
  canonicalRevCode,
  isRevRegistryCode,
  revErrorRow
} from "./error-registry.js";
import type { RevOwnedErrorCode } from "./error-registry.js";

/** Codes owned by other domains that REV propagates verbatim. */
export type PassThroughErrorCode =
  | "E_SCHEMA"
  | "E_VERSION_BINDING"
  | "E_IDEMPOTENCY_CONFLICT"
  | "E_AUTH_DENIED"
  | "E_AUTH_UNAVAILABLE"
  | "E_WRITE_NOT_FOUND"
  | "E_WRITE_STATE"
  | "E_DEADLINE_EXCEEDED"
  | "E_CANCELLED"
  | "E_REBUILD_DIVERGENCE"
  | "E_JUDGMENT_BASIS_INSUFFICIENT"
  | "E_TEMPLATE_BINDING_MISSING"
  | "E_SOURCE_HASH"
  | "E_STORAGE_UNAVAILABLE"
  | "E_STORAGE_CONFLICT"
  | "E_STORAGE_CORRUPT"
  | "E_INTERNAL";

export type RevErrorCode = RevOwnedErrorCode | PassThroughErrorCode;

const PASS_THROUGH_SPECS: Readonly<Record<PassThroughErrorCode, { category: ErrorCategory; stage: string; retryable: boolean }>> = {
  E_SCHEMA: { category: "schema", stage: "schema_validate", retryable: false },
  E_VERSION_BINDING: { category: "version", stage: "binding", retryable: false },
  E_IDEMPOTENCY_CONFLICT: { category: "conflict", stage: "idempotency", retryable: false },
  E_AUTH_DENIED: { category: "authorization", stage: "authorize", retryable: false },
  E_AUTH_UNAVAILABLE: { category: "authorization", stage: "authorize", retryable: false },
  E_WRITE_NOT_FOUND: { category: "not_found", stage: "adoption", retryable: false },
  E_WRITE_STATE: { category: "conflict", stage: "adoption", retryable: false },
  E_DEADLINE_EXCEEDED: { category: "deadline", stage: "deadline", retryable: true },
  E_CANCELLED: { category: "usage", stage: "cancel", retryable: true },
  E_REBUILD_DIVERGENCE: { category: "internal", stage: "journal_rebuild", retryable: false },
  E_JUDGMENT_BASIS_INSUFFICIENT: { category: "policy", stage: "judge", retryable: false },
  E_TEMPLATE_BINDING_MISSING: { category: "schema", stage: "judge", retryable: false },
  E_SOURCE_HASH: { category: "source", stage: "source_metadata", retryable: false },
  E_STORAGE_UNAVAILABLE: { category: "storage", stage: "storage", retryable: true },
  E_STORAGE_CONFLICT: { category: "storage", stage: "storage", retryable: true },
  E_STORAGE_CORRUPT: { category: "storage", stage: "storage", retryable: false },
  E_INTERNAL: { category: "internal", stage: "internal", retryable: false }
};

const CATEGORY_BY_CODE: Readonly<Record<string, ErrorCategory>> = Object.fromEntries(
  REV_ERROR_REGISTRY_ROWS.filter((entry) => !entry.deprecated).map((entry) => [entry.code, entry.category])
);

const RETRYABLE_BY_CODE: Readonly<Record<string, boolean>> = Object.fromEntries(
  REV_ERROR_REGISTRY_ROWS.filter((entry) => !entry.deprecated).map((entry) => [
    entry.code,
    entry.retryable_default
  ])
);

const STAGE_BY_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  REV_ERROR_REGISTRY_ROWS.filter((entry) => !entry.deprecated).map((entry) => [entry.code, entry.stage])
);

export interface RevErrorInput {
  readonly code: RevErrorCode;
  readonly details: ErrorEnvelope["details"];
  readonly stage?: string;
  readonly retryable?: boolean;
  readonly side_effect?: ErrorSideEffect;
  readonly detail_ref?: SourceRef;
  readonly retry_after_ms?: number;
  readonly trace_id?: Id<"ipc">;
}

/** Builds a REV `ErrorEnvelope`; registry defaults apply when not overridden. */
export function revError(input: RevErrorInput): ErrorEnvelope {
  const canonical = canonicalRevCode(input.code);
  const owned = isRevRegistryCode(canonical) && !revErrorRow(canonical).deprecated;
  const passThrough = PASS_THROUGH_SPECS[canonical as PassThroughErrorCode];
  const category: ErrorCategory = owned
    ? CATEGORY_BY_CODE[canonical] ?? "internal"
    : passThrough !== undefined
      ? passThrough.category
      : "internal";
  const stage = input.stage ?? (owned ? STAGE_BY_CODE[canonical] ?? "review" : passThrough?.stage ?? "review");
  const retryable = input.retryable ?? (owned ? RETRYABLE_BY_CODE[canonical] ?? false : passThrough?.retryable ?? false);
  const code: ErrorEnvelope["code"] = canonical.startsWith("E_")
    ? (canonical as ErrorEnvelope["code"])
    : "E_INTERNAL";
  const envelope: ErrorEnvelope = {
    schema_version: "rsi.error/1",
    code,
    category,
    retryable,
    side_effect: input.side_effect ?? "none",
    message_key: `error.${canonical.toLowerCase()}`,
    details: input.details,
    stage,
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

export function isRevErrorCode(code: string): code is RevErrorCode {
  if (isRevRegistryCode(code) && !revErrorRow(code).deprecated) {
    return true;
  }
  return Object.prototype.hasOwnProperty.call(PASS_THROUGH_SPECS, code);
}

export function retryableFor(code: string): boolean {
  if (isRevRegistryCode(code)) {
    return revErrorRow(code).retryable_default;
  }
  return PASS_THROUGH_SPECS[code as PassThroughErrorCode]?.retryable ?? false;
}

export function stageFor(code: string): string {
  if (isRevRegistryCode(code)) {
    return revErrorRow(code).stage;
  }
  return PASS_THROUGH_SPECS[code as PassThroughErrorCode]?.stage ?? "review";
}

/* ------------------------------------------------------------------ */
/* Closed detail branches                                             */
/* ------------------------------------------------------------------ */

export function fieldDetails(path: string, rule: string): ErrorEnvelope["details"] {
  return { kind: "field", path, rule };
}

export function versionDetails(expected: string, actual: string): ErrorEnvelope["details"] {
  return { kind: "version", expected, actual };
}

export function sourceDetails(
  ref: string,
  reason: "missing" | "tombstoned" | "hash_mismatch" | "out_of_range" | "not_utf8" | "too_large"
): ErrorEnvelope["details"] {
  return { kind: "source", source_ref: ref, reason };
}

export function conflictDetails(
  currentHash: Hash,
  expectedHash: Hash,
  diffRef?: SourceRef
): ErrorEnvelope["details"] {
  return diffRef === undefined
    ? { kind: "conflict", current_hash: currentHash, expected_hash: expectedHash }
    : { kind: "conflict", current_hash: currentHash, expected_hash: expectedHash, diff_ref: diffRef };
}

export function budgetDetails(input: {
  scopeKey: string;
  policyVersion: string;
  budgetKind: "token" | "cost" | "attempt" | "rate" | "deadline";
  remaining: number | null;
}): ErrorEnvelope["details"] {
  return {
    kind: "budget",
    scope_key: input.scopeKey,
    policy_version: input.policyVersion,
    budget_kind: input.budgetKind,
    remaining: input.remaining
  };
}

export function authorizationDetails(input: {
  objectType: string;
  deniedDimension: "object" | "project" | "config_space" | "path" | "block" | "action" | "mode" | "expiry" | "scope_empty";
  grantId?: Id<"grant">;
}): ErrorEnvelope["details"] {
  return input.grantId === undefined
    ? { kind: "authorization", object_type: input.objectType, denied_dimension: input.deniedDimension }
    : { kind: "authorization", object_type: input.objectType, denied_dimension: input.deniedDimension, grant_id: input.grantId };
}

export function egressDetails(input: {
  policyVersion: string;
  deniedDimension: "endpoint" | "model" | "data_class" | "project_exclusion" | "byte_limit" | "approval";
  refs: SourceRef[];
}): ErrorEnvelope["details"] {
  return {
    kind: "egress",
    policy_version: input.policyVersion,
    denied_dimension: input.deniedDimension,
    refs: input.refs
  };
}

export function idempotencyDetails(
  key: string,
  existingHash: Hash,
  incomingHash: Hash
): ErrorEnvelope["details"] {
  return { kind: "idempotency", key, existing_hash: existingHash, incoming_hash: incomingHash };
}

export function ipcDetails(input: {
  method: string;
  connectionId: string;
  frameKind: string;
}): ErrorEnvelope["details"] {
  return { kind: "ipc", method: input.method, connection_id: input.connectionId, frame_kind: input.frameKind };
}

export function externalDetails(input: {
  provider: string;
  httpStatus?: number;
  providerCode?: string;
}): ErrorEnvelope["details"] {
  if (input.httpStatus !== undefined && input.providerCode !== undefined) {
    return {
      kind: "external",
      provider: input.provider,
      http_status: input.httpStatus,
      provider_code: input.providerCode
    };
  }
  if (input.httpStatus !== undefined) {
    return { kind: "external", provider: input.provider, http_status: input.httpStatus };
  }
  if (input.providerCode !== undefined) {
    return { kind: "external", provider: input.provider, provider_code: input.providerCode };
  }
  return { kind: "external", provider: input.provider };
}

/* ------------------------------------------------------------------ */
/* Snapshot and enqueue                                               */
/* ------------------------------------------------------------------ */

export function snapshotInvalid(path: string, rule: string): ErrorEnvelope {
  return revError({ code: "E_REVIEW_SNAPSHOT_INVALID", details: fieldDetails(path, rule) });
}

export function snapshotCollision(expected: Hash, actual: Hash): ErrorEnvelope {
  return revError({
    code: "E_REVIEW_SNAPSHOT_COLLISION",
    details: conflictDetails(actual, expected)
  });
}

export function snapshotSourceMissing(ref: string, reason: "missing" | "tombstoned" | "hash_mismatch" = "missing"): ErrorEnvelope {
  return revError({
    code: "E_REVIEW_SNAPSHOT_SOURCE_MISSING",
    details: sourceDetails(ref, reason)
  });
}

export function triggerInvalid(path: string, rule: string): ErrorEnvelope {
  return revError({ code: "E_REVIEW_TRIGGER_INVALID", details: fieldDetails(path, rule) });
}

export function boundaryPending(path: string, rule: string): ErrorEnvelope {
  return revError({ code: "E_REVIEW_BOUNDARY_PENDING", details: fieldDetails(path, rule) });
}

export function quotaPolicyUnavailable(expected: string, actual: string): ErrorEnvelope {
  return revError({
    code: "E_REVIEW_QUOTA_POLICY_UNAVAILABLE",
    details: versionDetails(expected, actual)
  });
}

export function budgetInvalid(input: {
  scopeKey: string;
  policyVersion: string;
  budgetKind: "token" | "cost" | "attempt" | "rate" | "deadline";
  remaining: number | null;
}): ErrorEnvelope {
  return revError({ code: "E_REVIEW_BUDGET_INVALID", details: budgetDetails(input) });
}

export function outputPolicyInvalid(path: string, rule: string): ErrorEnvelope {
  return revError({ code: "E_REVIEW_OUTPUT_POLICY_INVALID", details: fieldDetails(path, rule) });
}

export function egressNotApproved(input: {
  policyVersion: string;
  refs: SourceRef[];
  deniedDimension?: "endpoint" | "model" | "data_class" | "project_exclusion" | "byte_limit" | "approval";
}): ErrorEnvelope {
  return revError({
    code: "E_REVIEW_EGRESS_NOT_APPROVED",
    details: egressDetails({
      policyVersion: input.policyVersion,
      deniedDimension: input.deniedDimension ?? "approval",
      refs: input.refs
    })
  });
}

export function idempotencyConflict(key: string, existingHash: Hash, incomingHash: Hash): ErrorEnvelope {
  return revError({
    code: "E_IDEMPOTENCY_CONFLICT",
    details: idempotencyDetails(key, existingHash, incomingHash)
  });
}

export function schemaError(path: string, rule: string): ErrorEnvelope {
  return revError({ code: "E_SCHEMA", details: fieldDetails(path, rule) });
}

export function versionBindingError(expected: string, actual: string): ErrorEnvelope {
  return revError({ code: "E_VERSION_BINDING", details: versionDetails(expected, actual) });
}

/* ------------------------------------------------------------------ */
/* Job, attempt, proposal and lifecycle                               */
/* ------------------------------------------------------------------ */

export function illegalJobTransition(from: string, to: string): ErrorEnvelope {
  return revError({
    code: "E_ILLEGAL_REVIEW_JOB_TRANSITION",
    details: fieldDetails("job.state", `${from}->${to}`)
  });
}

export function illegalAttemptTransition(from: string, to: string): ErrorEnvelope {
  return revError({
    code: "E_REVIEW_ILLEGAL_ATTEMPT_TRANSITION",
    details: fieldDetails("attempt.state", `${from}->${to}`)
  });
}

export function illegalProposalTransition(from: string, to: string): ErrorEnvelope {
  return revError({
    code: "E_PROPOSAL_ILLEGAL_TRANSITION",
    details: fieldDetails("proposal.state", `${from}->${to}`)
  });
}

export function illegalProjectionTransition(from: string, to: string): ErrorEnvelope {
  return revError({
    code: "E_EXPERIENCE_ILLEGAL_PROJECTION_TRANSITION",
    details: fieldDetails("projection.lifecycle", `${from}->${to}`)
  });
}

export function concurrentUpdate(expected: string, actual: string): ErrorEnvelope {
  return revError({ code: "E_REVIEW_CONCURRENT_UPDATE", details: versionDetails(expected, actual) });
}

export function fencingStale(expected: string, actual: string): ErrorEnvelope {
  return revError({ code: "E_REVIEW_FENCING_STALE", details: versionDetails(expected, actual) });
}

export function leaseExpired(expected: string, actual: string): ErrorEnvelope {
  return revError({ code: "E_REVIEW_LEASE_EXPIRED", details: versionDetails(expected, actual) });
}

export function handoffConflict(expected: Hash, actual: Hash): ErrorEnvelope {
  return revError({ code: "E_HANDOFF_CONFLICT", details: conflictDetails(actual, expected) });
}

export function handoffIncomplete(path: string, rule: string): ErrorEnvelope {
  return revError({ code: "E_HANDOFF_INCOMPLETE", details: fieldDetails(path, rule) });
}

export function handoffNotReady(path: string, rule: string): ErrorEnvelope {
  return revError({ code: "E_HANDOFF_NOT_READY", details: fieldDetails(path, rule) });
}

export function handoffPayloadInvalid(path: string, rule: string): ErrorEnvelope {
  return revError({ code: "E_HANDOFF_PAYLOAD_INVALID", details: fieldDetails(path, rule) });
}

export function handoffProposalMismatch(path: string, rule: string): ErrorEnvelope {
  return revError({ code: "E_HANDOFF_PROPOSAL_MISMATCH", details: fieldDetails(path, rule) });
}

export function experienceEventConflict(expected: Hash, actual: Hash): ErrorEnvelope {
  return revError({ code: "E_EXPERIENCE_EVENT_CONFLICT", details: conflictDetails(actual, expected) });
}

export function experienceUsageKeyCollision(key: string, existingHash: Hash, incomingHash: Hash): ErrorEnvelope {
  return revError({
    code: "E_EXPERIENCE_USAGE_KEY_COLLISION",
    details: idempotencyDetails(key, existingHash, incomingHash)
  });
}

export function experienceVerifierBinding(expected: string, actual: string): ErrorEnvelope {
  return revError({ code: "E_EXPERIENCE_VERIFIER_BINDING", details: versionDetails(expected, actual) });
}

export function experienceHostFactsUnavailable(method: string): ErrorEnvelope {
  return revError({
    code: "E_EXPERIENCE_HOST_FACTS_UNAVAILABLE",
    details: ipcDetails({ method, connectionId: "host_facts", frameKind: "read" })
  });
}

export function experiencePlanSourceChanged(ref: string, reason: "missing" | "tombstoned" | "hash_mismatch" = "missing"): ErrorEnvelope {
  return revError({ code: "E_EXPERIENCE_PLAN_SOURCE_CHANGED", details: sourceDetails(ref, reason) });
}

export function goalUnavailable(method: string): ErrorEnvelope {
  return revError({
    code: "E_REVIEW_GOAL_UNAVAILABLE",
    details: ipcDetails({ method, connectionId: "goal", frameKind: "read" })
  });
}

export function noVerifier(): ErrorEnvelope {
  return revError({ code: "E_REVIEW_NO_VERIFIER", details: { kind: "none" } });
}

export function windowLimit(path: string, rule: string): ErrorEnvelope {
  return revError({ code: "E_REVIEW_WINDOW_LIMIT", details: fieldDetails(path, rule) });
}

export function rollbackConflict(expected: Hash, actual: Hash): ErrorEnvelope {
  return revError({ code: "E_REVIEW_ROLLBACK_CONFLICT", details: conflictDetails(actual, expected) });
}

export function supersedeInvalid(path: string, rule: string): ErrorEnvelope {
  return revError({ code: "E_REVIEW_SUPERSEDE_INVALID", details: fieldDetails(path, rule) });
}

export function snapshotStale(expected: string, actual: string): ErrorEnvelope {
  return revError({ code: "E_REVIEW_SNAPSHOT_STALE", details: versionDetails(expected, actual) });
}

export function cancelled(): ErrorEnvelope {
  return revError({ code: "E_REVIEW_CANCELLED", details: { kind: "none" } });
}

export function outputReadMismatch(expected: Hash, actual: Hash): ErrorEnvelope {
  return revError({ code: "E_REVIEW_OUTPUT_READ_MISMATCH", details: conflictDetails(actual, expected) });
}

export function budgetLedgerMismatch(input: {
  scopeKey: string;
  policyVersion: string;
  budgetKind: "token" | "cost" | "attempt" | "rate" | "deadline";
  remaining: number | null;
}): ErrorEnvelope {
  return revError({ code: "E_REVIEW_BUDGET_LEDGER_MISMATCH", details: budgetDetails(input) });
}

export function providerCostOverage(input: {
  scopeKey: string;
  policyVersion: string;
  remaining: number | null;
}): ErrorEnvelope {
  return revError({
    code: "E_REVIEW_PROVIDER_COST_OVERAGE",
    details: budgetDetails({ ...input, budgetKind: "cost" })
  });
}

export function budgetExhausted(input: {
  scopeKey: string;
  policyVersion: string;
  budgetKind?: "token" | "cost" | "attempt" | "rate" | "deadline";
  remaining?: number | null;
}): ErrorEnvelope {
  return revError({
    code: "E_REVIEW_BUDGET_EXHAUSTED",
    details: budgetDetails({
      scopeKey: input.scopeKey,
      policyVersion: input.policyVersion,
      budgetKind: input.budgetKind ?? "attempt",
      remaining: input.remaining ?? null
    })
  });
}

export function backendUnavailable(provider = "host", providerCode?: string): ErrorEnvelope {
  return revError({
    code: "E_REVIEW_BACKEND_UNAVAILABLE",
    details: externalDetails({ provider, ...(providerCode === undefined ? {} : { providerCode }) })
  });
}

export function backendCapability(expected: string, actual: string): ErrorEnvelope {
  return revError({ code: "E_REVIEW_BACKEND_CAPABILITY", details: versionDetails(expected, actual) });
}

export function backendSpawn(provider: string, providerCode?: string): ErrorEnvelope {
  return revError({
    code: "E_REVIEW_BACKEND_SPAWN",
    details: externalDetails({ provider, ...(providerCode === undefined ? {} : { providerCode }) })
  });
}

export function backendAuth(grantId?: Id<"grant">): ErrorEnvelope {
  return revError({
    code: "E_REVIEW_BACKEND_AUTH",
    details: authorizationDetails({ objectType: "generation_backend", deniedDimension: "action", ...(grantId === undefined ? {} : { grantId }) })
  });
}

export function backendTimeout(provider: string): ErrorEnvelope {
  return revError({ code: "E_REVIEW_BACKEND_TIMEOUT", details: externalDetails({ provider }) });
}

export function backendExit(provider: string, exitCode?: number): ErrorEnvelope {
  return revError({
    code: "E_REVIEW_BACKEND_EXIT",
    details: externalDetails({ provider, ...(exitCode === undefined ? {} : { providerCode: String(exitCode) }) })
  });
}

export function exitTimeout(provider: string): ErrorEnvelope {
  return revError({ code: "E_REVIEW_EXIT_TIMEOUT", details: externalDetails({ provider }) });
}

export function outputParseError(
  code:
    | "E_REVIEW_OUTPUT_BAD_UTF8"
    | "E_REVIEW_OUTPUT_BAD_JSON"
    | "E_REVIEW_OUTPUT_START"
    | "E_REVIEW_OUTPUT_UNKNOWN_EVENT"
    | "E_REVIEW_OUTPUT_DUPLICATE_ORDINAL"
    | "E_REVIEW_OUTPUT_ORDINAL_GAP"
    | "E_REVIEW_OUTPUT_TRUNCATED"
    | "E_REVIEW_OUTPUT_AFTER_TERMINAL"
    | "E_REVIEW_OUTPUT_MULTIPLE_TERMINAL"
    | "E_REVIEW_OUTPUT_COUNT_MISMATCH"
    | "E_REVIEW_OUTPUT_TOO_MANY_PROPOSALS"
    | "E_REVIEW_OUTPUT_TOO_MANY_PROGRESS",
  path: string,
  rule: string
): ErrorEnvelope {
  return revError({ code, details: fieldDetails(path, rule) });
}

export function outputTooLarge(ref: string, reason: "too_large" = "too_large"): ErrorEnvelope {
  return revError({ code: "E_REVIEW_OUTPUT_TOO_LARGE", details: sourceDetails(ref, reason) });
}

export function outputLineTooLarge(ref: string): ErrorEnvelope {
  return revError({ code: "E_REVIEW_OUTPUT_LINE_TOO_LARGE", details: sourceDetails(ref, "too_large") });
}

export function outputTooManyLines(ref: string): ErrorEnvelope {
  return revError({ code: "E_REVIEW_OUTPUT_TOO_MANY_LINES", details: sourceDetails(ref, "too_large") });
}

export function inputTooLarge(ref: string, reason: "too_large" = "too_large"): ErrorEnvelope {
  return revError({ code: "E_REVIEW_INPUT_TOO_LARGE", details: sourceDetails(ref, reason) });
}

export function inputPath(path: string, rule: string): ErrorEnvelope {
  return revError({ code: "E_REVIEW_INPUT_PATH", details: fieldDetails(path, rule) });
}

export function credentialLeak(field: string, line?: number): ErrorEnvelope {
  const path = line === undefined ? field : `${field}#line=${String(line)}`;
  return revError({ code: "E_REVIEW_CREDENTIAL_LEAK", details: fieldDetails(path, "no_credentials") });
}

export function orphanUnknown(path: string, rule: string): ErrorEnvelope {
  return revError({ code: "E_REVIEW_ORPHAN_UNKNOWN", details: fieldDetails(path, rule) });
}

export function proposalBinding(path: string, rule: string): ErrorEnvelope {
  return revError({ code: "E_PROPOSAL_BINDING", details: fieldDetails(path, rule) });
}

export function proposalTarget(path: string, rule: string): ErrorEnvelope {
  return revError({ code: "E_PROPOSAL_TARGET", details: fieldDetails(path, rule) });
}

export function proposalAdoptionMismatch(expected: Hash, actual: Hash): ErrorEnvelope {
  return revError({
    code: "E_PROPOSAL_ADOPTION_MISMATCH",
    details: conflictDetails(actual, expected)
  });
}

export function proposalStaticFailure(
  code:
    | "E_PROPOSAL_DIFF_TOO_LARGE"
    | "E_EXPERIENCE_TOO_LARGE"
    | "E_PROPOSAL_UNTRUSTED_FIELD"
    | "E_PROPOSAL_SCHEMA"
    | "E_EXPERIENCE_SCHEMA"
    | "E_PROPOSAL_OLD_HASH_MISSING"
    | "E_PROPOSAL_OLD_HASH_MISMATCH"
    | "E_PROPOSAL_DIFF_MISMATCH"
    | "E_PROPOSAL_DIFF_APPLY"
    | "E_PROPOSAL_EVIDENCE_NOT_ALLOWED"
    | "E_PROPOSAL_SCOPE"
    | "E_PROPOSAL_PROTECTED_FIELD"
    | "E_EXPERIENCE_PLAN_SOURCE_CHANGED"
    | "E_EXPERIENCE_VERIFIER_BINDING"
    | "E_PROPOSAL_NO_CHANGE"
    | "E_PROPOSAL_STALE_TARGET",
  path: string,
  rule: string
): ErrorEnvelope {
  return revError({ code, details: fieldDetails(path, rule) });
}

export function duplicateOrdinal(path: string): ErrorEnvelope {
  return revError({ code: "E_PROPOSAL_DUPLICATE_ORDINAL", details: fieldDetails(path, "unique_ordinal") });
}

export function generatorMismatch(expected: string, actual: string): ErrorEnvelope {
  return revError({ code: "E_PROPOSAL_GENERATOR_MISMATCH", details: versionDetails(expected, actual) });
}

/* ------------------------------------------------------------------ */
/* HOST adapter error mapping (DD-REV-042)                            */
/* ------------------------------------------------------------------ */

const HOST_ERROR_MAP: Readonly<Record<string, RevOwnedErrorCode>> = {
  E_DEADLINE_EXCEEDED: "E_REVIEW_BACKEND_TIMEOUT",
  E_CAPABILITY: "E_REVIEW_BACKEND_CAPABILITY",
  E_UNSUPPORTED: "E_REVIEW_BACKEND_CAPABILITY",
  E_HOST_REJECTED: "E_REVIEW_BACKEND_SPAWN",
  E_AUTH_UNAVAILABLE: "E_REVIEW_BACKEND_AUTH",
  E_EVIDENCE_UNKNOWN: "E_REVIEW_BACKEND_CAPABILITY",
  E_SCHEMA: "E_REVIEW_BACKEND_CAPABILITY",
  E_CONFLICT: "E_REVIEW_CONCURRENT_UPDATE",
  E_CANCELLED: "E_REVIEW_CANCELLED",
  E_IO: "E_REVIEW_BACKEND_SPAWN",
  E_INTERNAL: "E_REVIEW_BACKEND_EXIT"
};

/** Maps a `HostAdapterError.code` to the fixed REV code; retryable is kept. */
export function mapHostAdapterError(error: HostAdapterError, detailRef?: SourceRef): ErrorEnvelope {
  const mapped = HOST_ERROR_MAP[error.code] ?? "E_REVIEW_BACKEND_EXIT";
  if (mapped === "E_REVIEW_CONCURRENT_UPDATE") {
    return revError({
      code: mapped,
      retryable: error.retryable,
      details: versionDetails("host_conflict", error.code),
      ...(detailRef === undefined ? {} : { detail_ref: detailRef })
    });
  }
  if (mapped === "E_REVIEW_CANCELLED") {
    return revError({
      code: mapped,
      retryable: error.retryable,
      details: { kind: "none" },
      ...(detailRef === undefined ? {} : { detail_ref: detailRef })
    });
  }
  if (mapped === "E_REVIEW_BACKEND_AUTH") {
    return revError({
      code: mapped,
      retryable: error.retryable,
      details: authorizationDetails({ objectType: "generation_backend", deniedDimension: "action" }),
      ...(detailRef === undefined ? {} : { detail_ref: detailRef })
    });
  }
  if (mapped === "E_REVIEW_BACKEND_CAPABILITY") {
    return revError({
      code: mapped,
      retryable: error.retryable,
      details: versionDetails("verified", error.code),
      ...(detailRef === undefined ? {} : { detail_ref: detailRef })
    });
  }
  return revError({
    code: mapped,
    retryable: error.retryable,
    details: externalDetails({
      provider: "host",
      ...(error.http_status === undefined ? {} : { httpStatus: error.http_status }),
      ...(error.provider_code === undefined ? {} : { providerCode: error.provider_code })
    }),
    ...(detailRef === undefined ? {} : { detail_ref: detailRef })
  });
}

/** Registry rows for the merge tool (13 fields per row). */
export function revErrorFragmentRows(): readonly import("./error-registry.js").RevErrorRegistryRow[] {
  return REV_ERROR_REGISTRY_ROWS;
}
