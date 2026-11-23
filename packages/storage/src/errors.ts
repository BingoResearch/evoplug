import { newId } from "@evoplug/core";
import type { ErrorEnvelope, Id, SourceRef } from "@evoplug/core";

/**
 * Error codes returned by the storage package. `E_STORAGE_*` is the family
 * reserved for persistence failures by DD-FND-024/DD-FND-103; the concrete
 * members below are the ones this package needs.
 */
export type StorageErrorCode =
  | "E_STORAGE_BUSY"
  | "E_STORAGE_SQLITE_UNSAFE"
  | "E_STORAGE_BLOB_ENOSPC"
  | "E_STORAGE_JOURNAL_ENOSPC"
  | "E_STORAGE_SQLITE_ENOSPC"
  | "E_STORAGE_ACK_ENOSPC"
  | "E_STORAGE_DELIVERY_ENOSPC"
  | "E_STORAGE_CORRUPT"
  | "E_STORAGE_IO"
  | "E_STORAGE_JOURNAL_RECOVERY_REQUIRED"
  | "E_STORAGE_MIGRATION"
  | "E_BLOB_MISSING"
  | "E_SOURCE_HASH"
  | "E_SCHEMA"
  | "E_SCHEMA_MAJOR_UNSUPPORTED"
  | "E_CONFLICT"
  | "E_STATE_ROW_SCHEMA"
  | "E_STATE_ROW_BINDING"
  | "E_REBUILD_DIVERGENCE"
  | "E_JOURNAL_CORRUPT_MIDDLE"
  | "E_LEDGER_EVENT_INVALID"
  | "E_IDEMPOTENCY_CONFLICT"
  | "E_WRITE_CONFIG_RECOVERY_REQUIRED";

type StorageErrorCategory = ErrorEnvelope["category"];
type StorageSideEffect = ErrorEnvelope["side_effect"];

interface StorageErrorInput {
  readonly code: StorageErrorCode;
  readonly stage: string;
  readonly details: ErrorEnvelope["details"];
  readonly trace_id?: Id<"ipc">;
  readonly retryable?: boolean;
  readonly side_effect?: StorageSideEffect;
  readonly message_key?: string;
  readonly detail_ref?: SourceRef;
  readonly retry_after_ms?: number;
}

const CATEGORY_BY_CODE: Readonly<Record<StorageErrorCode, StorageErrorCategory>> = {
  E_STORAGE_BUSY: "storage",
  E_STORAGE_SQLITE_UNSAFE: "storage",
  E_STORAGE_BLOB_ENOSPC: "storage",
  E_STORAGE_JOURNAL_ENOSPC: "storage",
  E_STORAGE_JOURNAL_RECOVERY_REQUIRED: "storage",
  E_STORAGE_SQLITE_ENOSPC: "storage",
  E_STORAGE_ACK_ENOSPC: "storage",
  E_STORAGE_DELIVERY_ENOSPC: "storage",
  E_STORAGE_CORRUPT: "storage",
  E_STORAGE_IO: "storage",
  E_STORAGE_MIGRATION: "storage",
  E_BLOB_MISSING: "storage",
  E_SOURCE_HASH: "source",
  E_SCHEMA: "schema",
  E_SCHEMA_MAJOR_UNSUPPORTED: "version",
  E_CONFLICT: "conflict",
  E_STATE_ROW_SCHEMA: "schema",
  E_STATE_ROW_BINDING: "version",
  E_REBUILD_DIVERGENCE: "internal",
  E_JOURNAL_CORRUPT_MIDDLE: "storage",
  E_LEDGER_EVENT_INVALID: "schema",
  E_IDEMPOTENCY_CONFLICT: "conflict",
  E_WRITE_CONFIG_RECOVERY_REQUIRED: "storage"
};

const RETRYABLE_BY_CODE: Readonly<Record<StorageErrorCode, boolean>> = {
  E_STORAGE_BUSY: true,
  E_STORAGE_SQLITE_UNSAFE: false,
  E_STORAGE_BLOB_ENOSPC: true,
  E_STORAGE_JOURNAL_ENOSPC: true,
  E_STORAGE_JOURNAL_RECOVERY_REQUIRED: false,
  E_STORAGE_SQLITE_ENOSPC: true,
  E_STORAGE_ACK_ENOSPC: true,
  E_STORAGE_DELIVERY_ENOSPC: true,
  E_STORAGE_CORRUPT: false,
  E_STORAGE_IO: false,
  E_STORAGE_MIGRATION: false,
  E_BLOB_MISSING: false,
  E_SOURCE_HASH: false,
  E_SCHEMA: false,
  E_SCHEMA_MAJOR_UNSUPPORTED: false,
  E_CONFLICT: false,
  E_STATE_ROW_SCHEMA: false,
  E_STATE_ROW_BINDING: false,
  E_REBUILD_DIVERGENCE: false,
  E_JOURNAL_CORRUPT_MIDDLE: false,
  E_LEDGER_EVENT_INVALID: false,
  E_IDEMPOTENCY_CONFLICT: false,
  E_WRITE_CONFIG_RECOVERY_REQUIRED: false
};

/** Allocates a fresh IPC trace id for an internally raised storage error. */
function newTraceId(): Id<"ipc"> {
  return newId("ipc");
}

/** Builds a storage `ErrorEnvelope` with the registry defaults for the code. */
export function storageError(input: StorageErrorInput): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    schema_version: "rsi.error/1",
    code: input.code,
    category: CATEGORY_BY_CODE[input.code],
    retryable: input.retryable ?? RETRYABLE_BY_CODE[input.code],
    side_effect: input.side_effect ?? "none",
    message_key: input.message_key ?? `error.${input.code}`,
    details: input.details,
    stage: input.stage,
    trace_id: input.trace_id ?? newTraceId()
  };
  return {
    ...envelope,
    ...(input.detail_ref === undefined ? {} : { detail_ref: input.detail_ref }),
    ...(input.retry_after_ms === undefined ? {} : { retry_after_ms: input.retry_after_ms })
  };
}

/** `details.kind="none"` for codes that carry no structured detail. */
export function noneDetails(): ErrorEnvelope["details"] {
  return { kind: "none" };
}

/** `details.kind="storage"` as defined by DD-FND-035. */
export function storageDetails(
  operation: string,
  sqlite_code?: string,
  journal_offset?: number,
): ErrorEnvelope["details"] {
  return {
    kind: "storage",
    operation,
    ...(sqlite_code === undefined ? {} : { sqlite_code }),
    ...(journal_offset === undefined ? {} : { journal_offset })
  };
}

/** `details.kind="field"` for schema violations. */
export function fieldDetails(path: string, rule: string): ErrorEnvelope["details"] {
  return { kind: "field", path, rule };
}

/** `details.kind="internal"` for divergence incidents. */
export function internalDetails(incident_id: string): ErrorEnvelope["details"] {
  return { kind: "internal", incident_id };
}
