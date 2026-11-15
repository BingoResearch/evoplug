/**
 * Structural validators for the three JSON envelopes carried by frames
 * (DD-FND-040). The generated Ajv validators from `schemas/ipc/*.schema.json`
 * perform the same checks at the boundary; these functions are the transport's
 * synchronous gates and reject unknown fields the same way
 * `additionalProperties: false` does.
 */

import type {
  ErrorEnvelope,
  FailureStatus,
  Id,
  SuccessStatus,
} from "@evoplug/core";
import { isId } from "@evoplug/core";
import {
  IPC_CLIENT_KINDS,
  IPC_CANCEL_SCHEMA_VERSION,
  IPC_HELLO_SCHEMA_VERSION,
  IPC_PROTOCOL_VERSION,
  IPC_REQUEST_SCHEMA_VERSION,
  IPC_RESPONSE_SCHEMA_VERSION,
  type HelloFrame,
  type IpcCancelFrame,
  type IpcClientKind,
} from "./protocol.js";
import { isIpcMethod, isValidIdempotencyKey, type IpcMethod } from "./methods.js";

export type ValidationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly path: string; readonly rule: string };

export interface DecodedResponse {
  readonly schema_version: "rsi.ipc_response/1";
  readonly request_id: Id<"ipc">;
  /** Echoed request method; may be an unregistered string on `E_IPC_METHOD_UNKNOWN`. */
  readonly method: string;
  readonly result: DecodedResult;
}

export type DecodedResult =
  | { readonly kind: "success"; readonly status: SuccessStatus; readonly value: unknown }
  | { readonly kind: "failure"; readonly status: FailureStatus; readonly error: ErrorEnvelope };

const SUCCESS_STATUSES: readonly SuccessStatus[] = ["ok", "no_op"];
const FAILURE_STATUSES: readonly FailureStatus[] = ["degraded", "rejected", "conflict", "pending", "unknown"];
const ERROR_CATEGORIES: ReadonlySet<string> = new Set([
  "usage",
  "schema",
  "version",
  "not_found",
  "policy",
  "authorization",
  "budget",
  "deadline",
  "source",
  "conflict",
  "storage",
  "ipc",
  "capacity",
  "external",
  "internal",
]);
const ERROR_SIDE_EFFECTS: ReadonlySet<string> = new Set(["none", "committed", "partial", "unknown"]);
const ERROR_STAGE_PATTERN: RegExp = /^[a-z][a-z0-9_.-]{0,63}$/;
const TOKEN_PATTERN: RegExp = /^[A-Za-z0-9_-]{43}$/;
const PRODUCT_VERSION_MAX_LENGTH = 64;

function invalid<T>(path: string, rule: string): ValidationOutcome<T> {
  return { ok: false, path, rule };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): string | null {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      return key;
    }
  }
  return null;
}

export function validateHello(value: unknown): ValidationOutcome<HelloFrame> {
  if (!isPlainRecord(value)) {
    return invalid("$", "object_required");
  }
  const extra = hasOnlyKeys(value, [
    "schema_version",
    "protocol_version",
    "client_id",
    "client_kind",
    "product_version",
    "pid",
    "token",
  ]);
  if (extra !== null) {
    return invalid(extra, "unknown_field");
  }
  if (value["schema_version"] !== IPC_HELLO_SCHEMA_VERSION) {
    return invalid("schema_version", "const");
  }
  if (value["protocol_version"] !== IPC_PROTOCOL_VERSION) {
    return invalid("protocol_version", "const");
  }
  const clientId = value["client_id"];
  if (typeof clientId !== "string" || !isId(clientId, "adp")) {
    return invalid("client_id", "id_prefix_adp");
  }
  const clientKind = value["client_kind"];
  if (typeof clientKind !== "string" || !IPC_CLIENT_KINDS.includes(clientKind as IpcClientKind)) {
    return invalid("client_kind", "enum");
  }
  const productVersion = value["product_version"];
  if (
    typeof productVersion !== "string" ||
    productVersion.length === 0 ||
    productVersion.length > PRODUCT_VERSION_MAX_LENGTH
  ) {
    return invalid("product_version", "length_1_64");
  }
  const pid = value["pid"];
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    return invalid("pid", "positive_integer");
  }
  const token = value["token"];
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    return invalid("token", "base64url_32_bytes");
  }
  return {
    ok: true,
    value: {
      schema_version: IPC_HELLO_SCHEMA_VERSION,
      protocol_version: IPC_PROTOCOL_VERSION,
      client_id: clientId,
      client_kind: clientKind as IpcClientKind,
      product_version: productVersion,
      pid,
      token,
    },
  };
}

export interface DecodedRequest {
  readonly schema_version: "rsi.ipc_request/1";
  readonly request_id: Id<"ipc">;
  readonly method: IpcMethod;
  readonly idempotency_key?: string;
  /** Structurally known to be a plain JSON object; the method decides its schema. */
  readonly params: unknown;
}

export function validateRequest(value: unknown): ValidationOutcome<DecodedRequest> {
  if (!isPlainRecord(value)) {
    return invalid("$", "object_required");
  }
  const extra = hasOnlyKeys(value, ["schema_version", "request_id", "method", "idempotency_key", "params"]);
  if (extra !== null) {
    return invalid(extra, "unknown_field");
  }
  if (value["schema_version"] !== IPC_REQUEST_SCHEMA_VERSION) {
    return invalid("schema_version", "const");
  }
  const requestId = value["request_id"];
  if (typeof requestId !== "string" || !isId(requestId, "ipc")) {
    return invalid("request_id", "id_prefix_ipc");
  }
  const method = value["method"];
  if (typeof method !== "string" || !isIpcMethod(method)) {
    return invalid("method", "ipc_method_unknown");
  }
  const key = value["idempotency_key"];
  if (key !== undefined) {
    if (typeof key !== "string" || !isValidIdempotencyKey(key)) {
      return invalid("idempotency_key", "pattern");
    }
  }
  const params = value["params"];
  if (!isPlainRecord(params)) {
    return invalid("params", "object_required");
  }
  const decoded: DecodedRequest = {
    schema_version: IPC_REQUEST_SCHEMA_VERSION,
    request_id: requestId,
    method,
    params,
    ...(key === undefined ? {} : { idempotency_key: key }),
  };
  return { ok: true, value: decoded };
}

export function validateCancel(value: unknown): ValidationOutcome<IpcCancelFrame> {
  if (!isPlainRecord(value)) {
    return invalid("$", "object_required");
  }
  const extra = hasOnlyKeys(value, ["schema_version", "request_id"]);
  if (extra !== null) {
    return invalid(extra, "unknown_field");
  }
  if (value["schema_version"] !== IPC_CANCEL_SCHEMA_VERSION) {
    return invalid("schema_version", "const");
  }
  const requestId = value["request_id"];
  if (typeof requestId !== "string" || !isId(requestId, "ipc")) {
    return invalid("request_id", "id_prefix_ipc");
  }
  return { ok: true, value: { schema_version: IPC_CANCEL_SCHEMA_VERSION, request_id: requestId } };
}

function validateErrorEnvelope(input: unknown): ValidationOutcome<ErrorEnvelope> {
  const original: unknown = input;
  const value = input;
  if (!isPlainRecord(value)) {
    return invalid("result.error", "object_required");
  }
  if (value["schema_version"] !== "rsi.error/1") {
    return invalid("result.error.schema_version", "const");
  }
  const code = value["code"];
  if (typeof code !== "string" || !/^E_[A-Z0-9_]+$/.test(code)) {
    return invalid("result.error.code", "pattern_E_CODE");
  }
  const category = value["category"];
  if (typeof category !== "string" || !ERROR_CATEGORIES.has(category)) {
    return invalid("result.error.category", "enum");
  }
  if (typeof value["retryable"] !== "boolean") {
    return invalid("result.error.retryable", "boolean_required");
  }
  const sideEffect = value["side_effect"];
  if (typeof sideEffect !== "string" || !ERROR_SIDE_EFFECTS.has(sideEffect)) {
    return invalid("result.error.side_effect", "enum");
  }
  const messageKey = value["message_key"];
  if (typeof messageKey !== "string" || messageKey.length === 0) {
    return invalid("result.error.message_key", "non_empty_string");
  }
  const details = value["details"];
  if (!isPlainRecord(details) || typeof details["kind"] !== "string") {
    return invalid("result.error.details", "discriminated_object");
  }
  const stage = value["stage"];
  if (typeof stage !== "string" || !ERROR_STAGE_PATTERN.test(stage)) {
    return invalid("result.error.stage", "pattern_stage");
  }
  const traceId = value["trace_id"];
  if (typeof traceId !== "string" || !isId(traceId, "ipc")) {
    return invalid("result.error.trace_id", "id_prefix_ipc");
  }
  const retryAfter = value["retry_after_ms"];
  if (retryAfter !== undefined && (typeof retryAfter !== "number" || !Number.isSafeInteger(retryAfter))) {
    return invalid("result.error.retry_after_ms", "safe_integer");
  }
  // Every registry field above is structurally checked; return the parsed object.
  return { ok: true, value: original as ErrorEnvelope };
}

export function decodeResult(value: unknown): ValidationOutcome<DecodedResult> {
  if (!isPlainRecord(value)) {
    return invalid("result", "object_required");
  }
  const ok = value["ok"];
  const status = value["status"];
  if (typeof status !== "string") {
    return invalid("result.status", "string_required");
  }
  if (ok === true) {
    if (!SUCCESS_STATUSES.includes(status as SuccessStatus)) {
      return invalid("result.status", "success_status");
    }
    return { ok: true, value: { kind: "success", status: status as SuccessStatus, value: value["value"] } };
  }
  if (ok === false) {
    if (!FAILURE_STATUSES.includes(status as FailureStatus)) {
      return invalid("result.status", "failure_status");
    }
    const envelope = validateErrorEnvelope(value["error"]);
    if (!envelope.ok) {
      return envelope;
    }
    return { ok: true, value: { kind: "failure", status: status as FailureStatus, error: envelope.value } };
  }
  return invalid("result.ok", "boolean_required");
}

export function validateResponse(value: unknown): ValidationOutcome<DecodedResponse> {
  if (!isPlainRecord(value)) {
    return invalid("$", "object_required");
  }
  const extra = hasOnlyKeys(value, ["schema_version", "request_id", "method", "result"]);
  if (extra !== null) {
    return invalid(extra, "unknown_field");
  }
  if (value["schema_version"] !== IPC_RESPONSE_SCHEMA_VERSION) {
    return invalid("schema_version", "const");
  }
  const requestId = value["request_id"];
  if (typeof requestId !== "string" || !isId(requestId, "ipc")) {
    return invalid("request_id", "id_prefix_ipc");
  }
  const method = value["method"];
  if (typeof method !== "string" || method.length === 0 || method.length > 128) {
    return invalid("method", "non_empty_string");
  }
  const result = decodeResult(value["result"]);
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    value: { schema_version: IPC_RESPONSE_SCHEMA_VERSION, request_id: requestId, method, result: result.value },
  };
}
