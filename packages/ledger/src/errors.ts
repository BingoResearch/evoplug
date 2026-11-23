import { newId } from "@evoplug/core";
import type { ErrorEnvelope, Hash, Result, SourceRef } from "@evoplug/core";

/**
 * Error codes that the ledger (FND 5) can produce. They are typed through
 * `ErrorEnvelope["code"]` so the generated registry remains the single source
 * of the literal union; the ledger never declares a second code list.
 */
export type LedgerErrorCode = ErrorEnvelope["code"];

export interface LedgerErrorInput {
  readonly code: LedgerErrorCode;
  readonly category: ErrorEnvelope["category"];
  readonly details: ErrorEnvelope["details"];
  readonly stage: string;
  readonly retryable?: boolean;
}

export type LedgerFailureStatus = "degraded" | "rejected" | "conflict" | "pending" | "unknown";

/**
 * Builds the single error envelope shape used across the ledger domain.
 * `side_effect` is always `"none"` because every ledger validation runs before
 * any journal or SQLite write; write failures are mapped by the storage port.
 */
export function ledgerError(input: LedgerErrorInput): ErrorEnvelope {
  return {
    schema_version: "rsi.error/1",
    code: input.code,
    category: input.category,
    retryable: input.retryable ?? false,
    side_effect: "none",
    message_key: "error." + input.code.toLowerCase(),
    details: input.details,
    stage: input.stage,
    trace_id: newId("ipc"),
  };
}

export function ledgerFailure<T>(
  input: LedgerErrorInput,
  status: LedgerFailureStatus = "rejected",
): Result<T, ErrorEnvelope> {
  return { ok: false, status, error: ledgerError(input) };
}

export function ledgerOk<T>(value: T): Result<T, ErrorEnvelope> {
  return { ok: true, status: "ok", value };
}

export function ledgerNoOp<T>(value: T): Result<T, ErrorEnvelope> {
  return { ok: true, status: "no_op", value };
}

export function schemaError<T>(path: string, rule: string): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_SCHEMA",
    category: "schema",
    details: { kind: "field", path, rule },
    stage: "ledger_validate",
  });
}

export function asofUnavailable<T>(): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_LEDGER_ASOF_UNAVAILABLE",
    category: "version",
    details: { kind: "none" },
    stage: "ledger_read",
  });
}

export function versionBindingError<T>(): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_VERSION_BINDING",
    category: "version",
    details: { kind: "version", expected: "current_branch_binding", actual: "request_binding" },
    stage: "binding",
  });
}

export function watermarkAheadError<T>(): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_WATERMARK_AHEAD",
    category: "version",
    details: { kind: "field", path: "watermark", rule: "ahead_of_receipt_seq" },
    stage: "ledger_read",
  });
}

export function idempotencyConflict<T>(
  key: string,
  existingHash: Hash,
  incomingHash: Hash,
): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>(
    {
      code: "E_IDEMPOTENCY_CONFLICT",
      category: "conflict",
      details: { kind: "idempotency", key, existing_hash: existingHash, incoming_hash: incomingHash },
      stage: "persist",
    },
    "conflict",
  );
}

export function sourceRefInvalid<T>(): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_SOURCE_REF_INVALID",
    category: "source",
    details: { kind: "none" },
    stage: "source_ref_parse",
  });
}

export function sourceNotFound<T>(ref: SourceRef): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_SOURCE_NOT_FOUND",
    category: "source",
    details: { kind: "source", source_ref: ref, reason: "missing" },
    stage: "source_resolve",
  });
}

export function sourceHashError<T>(ref: SourceRef): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_SOURCE_HASH",
    category: "source",
    details: { kind: "source", source_ref: ref, reason: "hash_mismatch" },
    stage: "source_verify",
  });
}

export function sourceUtf8Error<T>(ref: SourceRef): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_SOURCE_UTF8_INVALID",
    category: "source",
    details: { kind: "source", source_ref: ref, reason: "not_utf8" },
    stage: "source_utf8",
  });
}
