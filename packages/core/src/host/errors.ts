/**
 * HOST-local errors (DD-HOST-001, DD-TRG-010, DD-TRG-011).
 *
 * HOST owns a closed adapter error vocabulary and several local error
 * envelopes. None of these are re-exported as FND `ErrorEnvelope` codes; the
 * design requires the local namespaces to stay separate.
 */

import type { CapabilityName } from "./types.js";
import type { SourceRef } from "../source-ref.js";
import type { FailureStatus, SuccessStatus } from "../result.js";

/**
 * Error returned by every `HostAdapter` method (DD-HOST-001). The deadline and
 * cancel codes are canonical; there is no `E_DEADLINE` alias.
 */
export interface HostAdapterError {
  code:
    | "E_DEADLINE_EXCEEDED"
    | "E_CAPABILITY"
    | "E_UNSUPPORTED"
    | "E_CONFLICT"
    | "E_HOST_REJECTED"
    | "E_AUTH_UNAVAILABLE"
    | "E_EVIDENCE_UNKNOWN"
    | "E_SCHEMA"
    | "E_IO"
    | "E_CANCELLED"
    | "E_INTERNAL";
  retryable: boolean;
  capability?: CapabilityName;
  detail_ref: SourceRef;
  observed_at: number;
}

/** Builds a frozen adapter error. `detail_ref` is mandatory by contract. */
export function makeHostAdapterError(init: {
  code: HostAdapterError["code"];
  retryable: boolean;
  detail_ref: SourceRef;
  observed_at: number;
  capability?: CapabilityName;
}): HostAdapterError {
  const error: HostAdapterError = {
    code: init.code,
    retryable: init.retryable,
    detail_ref: init.detail_ref,
    observed_at: init.observed_at
  };
  if (init.capability !== undefined) {
    error.capability = init.capability;
  }
  return error;
}

/** Adapter registration conflict codes (DD-HOST-001). */
export type RegistrationConflictCode =
  | "E_ADAPTER_NOT_DECLARED"
  | "E_CONFIG_SPACE_NOT_DECLARED"
  | "E_TARGET_NOT_DECLARED"
  | "E_ADAPTER_MISMATCH"
  | "E_ACTIVE_BINDING_MISMATCH"
  | "E_ARTIFACT_MISMATCH"
  | "E_MARKER_MISMATCH"
  | "E_APPROVAL_NOT_FOUND"
  | "E_APPROVAL_SUBJECT_MISMATCH"
  | "E_APPROVAL_STATE"
  | "E_APPROVAL_EXPIRED"
  | "E_APPROVAL_HASH"
  | "E_APPROVAL_CONSUMED";

export type HostEventRejectionReason =
  | "E_EVENT_ADAPTER_UNBOUND"
  | "E_EVENT_CONFIG_SPACE_UNBOUND"
  | "E_EVENT_CONTRACT_VIOLATION"
  | "E_EVENT_POST_NORMALIZE_MISMATCH"
  | "E_EVENT_IDENTITY_MISMATCH"
  | "E_EVENT_SCOPE_UNBOUND"
  | "E_EVENT_SCOPE_FORBIDDEN"
  | "E_FIELD_MISSING"
  | "E_ENUM_UNKNOWN"
  | "E_IDENTITY_MISSING"
  | "E_ORIGIN_UNRESOLVED"
  | "E_VERSION_UNMAPPED";

/** A local HOST validation failure. Never crosses the adapter boundary. */
export interface HostValidationIssue {
  code: string;
  path: string;
  rule: string;
}

/**
 * Result shape for adapter-facing operations. `HostAdapterError` is a closed
 * adapter vocabulary and is not an FND `ErrorEnvelope`, so it cannot use the
 * core `Result<T, E extends ErrorEnvelope>` alias; this local alias preserves
 * the same ok/status/error shape.
 */
export type HostAdapterResult<T> =
  | { ok: true; status: SuccessStatus; value: T }
  | { ok: false; status: FailureStatus; error: HostAdapterError };

export function adapterOk<T>(value: T, status: SuccessStatus = "ok"): HostAdapterResult<T> {
  return { ok: true, status, value };
}

export function adapterErr(error: HostAdapterError, status: FailureStatus = "rejected"): HostAdapterResult<never> {
  return { ok: false, status, error };
}

/**
 * Result shape for HOST-local error vocabularies that are not FND
 * `ErrorEnvelope`s (progress, capacity, interaction). Same success/failure
 * axes as the core `Result`.
 */
export type HostResult<T, E> =
  | { ok: true; status: SuccessStatus; value: T }
  | { ok: false; status: FailureStatus; error: E };

export function hostOk<T>(value: T, status: SuccessStatus = "ok"): HostResult<T, never> {
  return { ok: true, status, value };
}

export function hostErr<E>(error: E, status: FailureStatus = "rejected"): HostResult<never, E> {
  return { ok: false, status, error };
}
