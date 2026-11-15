/**
 * IPC protocol constants and wire envelopes (DD-FND-040).
 *
 * Every frame body is canonical-free UTF-8 JSON (plain `JSON.stringify`, not
 * JCS): only the envelope fields are positional, and hashes are computed over
 * domain objects, never over the wire text.
 */

import type { Id, Result } from "@evoplug/core";
import type { IpcMethod, IpcParams, IpcResult } from "./methods.js";

export const IPC_PROTOCOL_VERSION = "evoplug-ipc/1";
export const IPC_PROTOCOL_MAJOR = 1;

export const IPC_HELLO_SCHEMA_VERSION = "rsi.ipc_hello/1";
export const IPC_REQUEST_SCHEMA_VERSION = "rsi.ipc_request/1";
export const IPC_RESPONSE_SCHEMA_VERSION = "rsi.ipc_response/1";
export const IPC_CANCEL_SCHEMA_VERSION = "rsi.ipc_cancel/1";

/** A client has 1000 ms after connect to deliver its hello frame. */
export const IPC_HELLO_TIMEOUT_MS = 1000;
export const IPC_HELLO_DEADLINE_MS = 1000;

export const IPC_MIN_REQUEST_DEADLINE_MS = 1;
export const IPC_MAX_REQUEST_DEADLINE_MS = 600000;

/** One connection may hold at most 16 in-flight requests (DD-FND-040). */
export const IPC_MAX_INFLIGHT_PER_CONNECTION = 16;

/** Decoded event content (after base64) is capped at 8 MiB. */
export const IPC_MAX_DECODED_CONTENT_BYTES = 8_388_608;

/** Minimum useful remaining work; below it the server degrades without calling out. */
export const IPC_MIN_WORK_MS = 1;

export type IpcClientKind = "host_runtime" | "adapter" | "cli" | "worker" | "test";

export const IPC_CLIENT_KINDS: readonly IpcClientKind[] = ["host_runtime", "adapter", "cli", "worker", "test"];

export interface HelloFrame {
  schema_version: "rsi.ipc_hello/1";
  protocol_version: "evoplug-ipc/1";
  client_id: Id<"adp">;
  client_kind: IpcClientKind;
  product_version: string;
  pid: number;
  token: string;
}

export interface IpcRequest<M extends IpcMethod = IpcMethod> {
  schema_version: "rsi.ipc_request/1";
  request_id: Id<"ipc">;
  method: M;
  idempotency_key?: string;
  params: IpcParams[M];
}

export interface IpcResponse<M extends IpcMethod = IpcMethod> {
  schema_version: "rsi.ipc_response/1";
  request_id: Id<"ipc">;
  method: M;
  result: Result<IpcResult[M]>;
}

/**
 * Body of a `cancel` frame. The design fixes the frame kind and the
 * `request_id` correlation but does not spell out the body: this is the
 * literal minimum carrying the same `request_id` as the request being cancelled.
 */
export interface IpcCancelFrame {
  schema_version: "rsi.ipc_cancel/1";
  request_id: Id<"ipc">;
}

/** `evoplug-ipc/1` -> `1`; anything else is `null`. */
export function protocolMajor(protocolVersion: string): number | null {
  const match = /^evoplug-ipc\/(\d{1,4})$/.exec(protocolVersion);
  if (match === null) {
    return null;
  }
  const major = match[1];
  if (major === undefined) {
    return null;
  }
  const value = Number.parseInt(major, 10);
  return Number.isSafeInteger(value) ? value : null;
}

export function isRequestDeadlineInRange(deadlineMs: number): boolean {
  return (
    Number.isInteger(deadlineMs) &&
    deadlineMs >= IPC_MIN_REQUEST_DEADLINE_MS &&
    deadlineMs <= IPC_MAX_REQUEST_DEADLINE_MS
  );
}
