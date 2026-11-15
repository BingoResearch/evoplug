/**
 * IPC idempotency domain rules (DD-FND-041, DD-FND-097.7).
 *
 * The transport never touches SQLite or the journal: the dispatcher calls an
 * `IdempotencyStorePort` whose implementation (storage/kernel) writes the
 * `ipc_idempotency.started` journal frame, fsyncs, inserts the `in_progress`
 * row in a short transaction, and does the reverse for `finished`.
 */

import type {
  ErrorEnvelope,
  Hash,
  Id,
  Result,
  SuccessStatus,
} from "@evoplug/core";
import { canonicalHash } from "@evoplug/core";
import type { JsonValue } from "@evoplug/core";
import { isJsonObject } from "./json.js";
import type { IpcMethod } from "./methods.js";

/** Terminal rows are kept 7 days; `event.ingest` rows are kept 30 days. */
export const IDEMPOTENCY_TERMINAL_RETENTION_MS: number = 7 * 24 * 60 * 60 * 1000;
export const EVENT_INGEST_IDEMPOTENCY_RETENTION_MS: number = 30 * 24 * 60 * 60 * 1000;

/** Fields excluded from `request_hash`; none of them changes what is executed. */
const VOLATILE_PARAM_FIELDS: ReadonlySet<string> = new Set([
  "idempotency_key",
  "deadline_ms",
  "signal",
]);

export type IdempotencyState = "in_progress" | "succeeded" | "failed" | "uncertain";

export interface IdempotencyDomainKey {
  readonly client_id: Id<"adp">;
  readonly method: IpcMethod;
  readonly idempotency_key: string;
}

/**
 * `entity_id = "idem:" + lowerhex(sha256(JCS({client_id, method, idempotency_key})))`,
 * 69 characters, deterministic across restarts and rebuilds.
 */
export function idempotencyEntityId(key: IdempotencyDomainKey): string {
  const digest = canonicalHash({
    client_id: key.client_id,
    method: key.method,
    idempotency_key: key.idempotency_key,
  });
  return `idem:${digest.slice("sha256:".length)}`;
}

export function idempotencyRetentionMs(method: IpcMethod): number {
  return method === "event.ingest"
    ? EVENT_INGEST_IDEMPOTENCY_RETENTION_MS
    : IDEMPOTENCY_TERMINAL_RETENTION_MS;
}

/** Expiry is measured from the terminal transition, not from the request. */
export function idempotencyExpiresAt(method: IpcMethod, terminalAt: number): number {
  return terminalAt + idempotencyRetentionMs(method);
}

function stripVolatileFields(params: JsonValue): JsonValue {
  if (!isJsonObject(params)) {
    return params;
  }
  const stripped: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(params)) {
    if (VOLATILE_PARAM_FIELDS.has(key)) {
      continue;
    }
    const value = params[key];
    if (value !== undefined) {
      stripped[key] = value;
    }
  }
  return stripped;
}

/**
 * `request_hash = sha256(JCS(method_params_without_idempotency_key_deadline_signal))`.
 * Only top-level volatile fields are removed; the method itself is part of the
 * idempotency domain and is not mixed into this hash.
 */
export function computeIdempotencyRequestHash(params: JsonValue): Hash {
  return canonicalHash(stripVolatileFields(params));
}

export interface IdempotencyBeginInput {
  readonly client_id: Id<"adp">;
  readonly method: IpcMethod;
  readonly idempotency_key: string;
  readonly request_hash: Hash;
  readonly lease_owner: string;
  readonly lease_expires_at: number;
  readonly created_at: number;
  readonly trace_id: Id<"ipc">;
}

export type IdempotencyBeginOutcome =
  | { readonly state: "started" }
  | { readonly state: "replay"; readonly status: SuccessStatus | "failed"; readonly result: JsonValue }
  | { readonly state: "in_progress" }
  | { readonly state: "uncertain" };

export interface IdempotencyFinishInput {
  readonly client_id: Id<"adp">;
  readonly method: IpcMethod;
  readonly idempotency_key: string;
  readonly request_hash: Hash;
  readonly state: "succeeded" | "failed";
  readonly result: JsonValue;
  readonly expires_at: number;
  readonly trace_id: Id<"ipc">;
}

export type IdempotencyFinishOutcome = { readonly state: "succeeded" | "failed" };

/**
 * Persistence port for the `ipc_idempotency` row plus its journal frames.
 *
 * `begin` must journal `ipc_idempotency.started` and fsync before inserting the
 * `in_progress` row; `finish` must journal `ipc_idempotency.finished` and fsync
 * before the CAS to the terminal state. A same-key, different-hash request is
 * reported as `Err(E_IDEMPOTENCY_CONFLICT)` by the implementation.
 */
export interface IdempotencyStorePort {
  begin(input: IdempotencyBeginInput): Promise<Result<IdempotencyBeginOutcome, ErrorEnvelope>>;
  finish(input: IdempotencyFinishInput): Promise<Result<IdempotencyFinishOutcome, ErrorEnvelope>>;
}
