/**
 * Result envelope and status axes (DD-FND-034).
 *
 * Success carries `ok | no_op`; failure carries one of the five failure
 * statuses. `Result` is the only return shape for domain operations; thrown
 * exceptions are reserved for programmer errors at pure seams.
 */

import type { ErrorEnvelope } from "./errors.js";

export type SuccessStatus = "ok" | "no_op";

export type FailureStatus = "degraded" | "rejected" | "conflict" | "pending" | "unknown";

export type Result<T, E extends ErrorEnvelope = ErrorEnvelope> =
  | { ok: true; status: SuccessStatus; value: T }
  | { ok: false; status: FailureStatus; error: E };

export type OkResult<T> = { ok: true; status: SuccessStatus; value: T };

export type ErrResult<E extends ErrorEnvelope = ErrorEnvelope> = { ok: false; status: FailureStatus; error: E };

export function ok<T>(value: T, status: SuccessStatus = "ok"): OkResult<T> {
  return { ok: true, status, value };
}

/**
 * Wraps an error envelope. The failure axis is chosen by the caller because it
 * describes the operation outcome, not the error category; `rejected` is the
 * default for a synchronous business refusal.
 */
export function err<E extends ErrorEnvelope>(error: E, status: FailureStatus = "rejected"): ErrResult<E> {
  return { ok: false, status, error };
}

export function isOk<T, E extends ErrorEnvelope>(
  result: Result<T, E>
): result is { ok: true; status: SuccessStatus; value: T } {
  return result.ok;
}

export function isErr<T, E extends ErrorEnvelope>(
  result: Result<T, E>
): result is { ok: false; status: FailureStatus; error: E } {
  return !result.ok;
}

export function isSuccessStatus(value: string): value is SuccessStatus {
  return value === "ok" || value === "no_op";
}

export function isFailureStatus(value: string): value is FailureStatus {
  return (
    value === "degraded" ||
    value === "rejected" ||
    value === "conflict" ||
    value === "pending" ||
    value === "unknown"
  );
}
