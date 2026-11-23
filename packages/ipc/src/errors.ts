/**
 * IPC error registry rows and envelope builders (DD-FND-043, DD-FND-103).
 *
 * Values mirror the canonical rows in `schemas/errors/fragments/fnd.json`:
 * category, retryable and stage are copied from the registry, never re-derived
 * at the call site. `retryable` is never overridden here.
 */

import type {
  ErrorCategory,
  ErrorDetails,
  ErrorEnvelope,
  FailureStatus,
  Hash,
  Id,
  Result,
} from "@evoplug/core";

export type IpcErrorCode =
  | "E_IPC_AUTH"
  | "E_IPC_PROTOCOL"
  | "E_IPC_FRAME_TOO_LARGE"
  | "E_IPC_BODY_TOO_LARGE"
  | "E_IPC_TRUNCATED"
  | "E_IPC_METHOD_UNKNOWN"
  | "E_IPC_METHOD_NOT_IDEMPOTENT"
  | "E_IPC_IN_PROGRESS"
  | "E_IPC_IDEMPOTENCY_UNCERTAIN"
  | "E_IPC_BUSY"
  | "E_IPC_PEER_LIMIT"
  | "E_IPC_DISCONNECTED"
  | "E_DEADLINE_EXCEEDED"
  | "E_CANCELLED"
  | "E_IDEMPOTENCY_CONFLICT"
  | "E_SCHEMA"
  | "E_INTERNAL";

type IpcDetailsKind = "ipc" | "none" | "field" | "idempotency" | "internal";

interface IpcErrorSpec {
  readonly code: IpcErrorCode;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly side_effect: "none" | "committed" | "partial" | "unknown";
  readonly stage: string;
  readonly details_kind: IpcDetailsKind;
  readonly failure_status: FailureStatus;
  readonly message_key: string;
}

function spec(
  code: IpcErrorCode,
  category: ErrorCategory,
  retryable: boolean,
  stage: string,
  detailsKind: IpcDetailsKind,
  failureStatus: FailureStatus,
  sideEffect: "none" | "unknown" = "none",
): IpcErrorSpec {
  return {
    code,
    category,
    retryable,
    side_effect: sideEffect,
    stage,
    details_kind: detailsKind,
    failure_status: failureStatus,
    message_key: `error.${code.toLowerCase()}`,
  };
}

export const IPC_ERROR_REGISTRY: Readonly<Record<IpcErrorCode, IpcErrorSpec>> = {
  E_IPC_AUTH: spec("E_IPC_AUTH", "authorization", false, "ipc_auth", "ipc", "rejected"),
  E_IPC_PROTOCOL: spec("E_IPC_PROTOCOL", "ipc", false, "ipc_frame", "ipc", "rejected"),
  E_IPC_FRAME_TOO_LARGE: spec("E_IPC_FRAME_TOO_LARGE", "ipc", false, "ipc_frame", "ipc", "rejected"),
  E_IPC_BODY_TOO_LARGE: spec("E_IPC_BODY_TOO_LARGE", "ipc", false, "ipc_frame", "ipc", "rejected"),
  E_IPC_TRUNCATED: spec("E_IPC_TRUNCATED", "ipc", false, "ipc_frame", "ipc", "rejected"),
  E_IPC_METHOD_UNKNOWN: spec("E_IPC_METHOD_UNKNOWN", "usage", false, "ipc_dispatch", "ipc", "rejected"),
  E_IPC_METHOD_NOT_IDEMPOTENT: spec(
    "E_IPC_METHOD_NOT_IDEMPOTENT",
    "usage",
    false,
    "ipc_dispatch",
    "ipc",
    "rejected",
  ),
  E_IPC_IN_PROGRESS: spec("E_IPC_IN_PROGRESS", "conflict", false, "ipc_idempotency", "ipc", "pending", "unknown"),
  E_IPC_IDEMPOTENCY_UNCERTAIN: spec(
    "E_IPC_IDEMPOTENCY_UNCERTAIN",
    "internal",
    false,
    "ipc_idempotency",
    "ipc",
    "unknown",
    "unknown",
  ),
  E_IPC_BUSY: spec("E_IPC_BUSY", "capacity", true, "ipc_admit", "ipc", "rejected"),
  E_IPC_PEER_LIMIT: spec("E_IPC_PEER_LIMIT", "capacity", true, "ipc_admit", "ipc", "rejected"),
  E_IPC_DISCONNECTED: spec("E_IPC_DISCONNECTED", "ipc", true, "ipc_transport", "ipc", "rejected"),
  E_DEADLINE_EXCEEDED: spec("E_DEADLINE_EXCEEDED", "deadline", true, "request_control", "none", "degraded"),
  E_CANCELLED: spec("E_CANCELLED", "deadline", false, "request_control", "none", "degraded"),
  E_IDEMPOTENCY_CONFLICT: spec(
    "E_IDEMPOTENCY_CONFLICT",
    "conflict",
    false,
    "persist",
    "idempotency",
    "conflict",
  ),
  E_SCHEMA: spec("E_SCHEMA", "schema", false, "schema_validate", "field", "rejected"),
  E_INTERNAL: spec("E_INTERNAL", "internal", false, "internal", "internal", "rejected"),
};

interface IpcErrorContext {
  readonly trace_id: Id<"ipc">;
  readonly method?: string;
  readonly connection_id?: string;
  readonly frame_kind?: string;
  readonly retry_after_ms?: number;
}

const UNKNOWN_METHOD = "unknown";
const UNKNOWN_CONNECTION = "-";
const UNKNOWN_FRAME_KIND = "unknown";

function defaultDetails(specification: IpcErrorSpec, context: IpcErrorContext): ErrorDetails {
  switch (specification.details_kind) {
    case "ipc":
      return {
        kind: "ipc",
        method: context.method ?? UNKNOWN_METHOD,
        connection_id: context.connection_id ?? UNKNOWN_CONNECTION,
        frame_kind: context.frame_kind ?? UNKNOWN_FRAME_KIND,
      };
    case "none":
      return { kind: "none" };
    case "field":
      return { kind: "field", path: "body", rule: "invalid" };
    case "idempotency":
      return {
        kind: "idempotency",
        key: "",
        existing_hash: "sha256:" as const,
        incoming_hash: "sha256:" as const,
      };
    case "internal":
      return { kind: "internal", incident_id: context.connection_id ?? UNKNOWN_CONNECTION };
  }
}

/**
 * Builds an `ErrorEnvelope` for an IPC registry code. Optional `retry_after_ms`
 * is only attached when supplied, so `exactOptionalPropertyTypes` never sees an
 * explicit `undefined`.
 */
export function makeIpcError(code: IpcErrorCode, context: IpcErrorContext): ErrorEnvelope {
  const specification = IPC_ERROR_REGISTRY[code];
  const envelope: ErrorEnvelope = {
    schema_version: "rsi.error/1",
    code: specification.code,
    category: specification.category,
    retryable: specification.retryable,
    side_effect: specification.side_effect,
    message_key: specification.message_key,
    details: defaultDetails(specification, context),
    stage: specification.stage,
    trace_id: context.trace_id,
    ...(context.retry_after_ms === undefined ? {} : { retry_after_ms: context.retry_after_ms }),
  };
  return envelope;
}

export function ipcFailure(code: IpcErrorCode, context: IpcErrorContext): Result<never, ErrorEnvelope> {
  return {
    ok: false,
    status: IPC_ERROR_REGISTRY[code].failure_status,
    error: makeIpcError(code, context),
  };
}

interface SchemaErrorInput {
  readonly trace_id: Id<"ipc">;
  readonly path: string;
  readonly rule: string;
  readonly method?: string;
  readonly connection_id?: string;
  readonly frame_kind?: string;
}

/** `E_SCHEMA` with the `field` detail branch mandated by DD-FND-035. */
export function schemaError(input: SchemaErrorInput): ErrorEnvelope {
  const specification = IPC_ERROR_REGISTRY.E_SCHEMA;
  return {
    schema_version: "rsi.error/1",
    code: "E_SCHEMA",
    category: specification.category,
    retryable: specification.retryable,
    side_effect: specification.side_effect,
    message_key: specification.message_key,
    details: { kind: "field", path: input.path, rule: input.rule },
    stage: specification.stage,
    trace_id: input.trace_id,
  };
}

interface IdempotencyConflictInput {
  readonly trace_id: Id<"ipc">;
  readonly key: string;
  readonly existing_hash: Hash;
  readonly incoming_hash: Hash;
  readonly method?: string;
  readonly connection_id?: string;
  readonly frame_kind?: string;
}

/** `E_IDEMPOTENCY_CONFLICT` with the `idempotency` detail branch. */
export function idempotencyConflictError(input: IdempotencyConflictInput): ErrorEnvelope {
  const specification = IPC_ERROR_REGISTRY.E_IDEMPOTENCY_CONFLICT;
  return {
    schema_version: "rsi.error/1",
    code: "E_IDEMPOTENCY_CONFLICT",
    category: specification.category,
    retryable: specification.retryable,
    side_effect: specification.side_effect,
    message_key: specification.message_key,
    details: {
      kind: "idempotency",
      key: input.key,
      existing_hash: input.existing_hash,
      incoming_hash: input.incoming_hash,
    },
    stage: specification.stage,
    trace_id: input.trace_id,
  };
}

export function isIpcErrorCode(value: string): value is IpcErrorCode {
  return Object.prototype.hasOwnProperty.call(IPC_ERROR_REGISTRY, value);
}
