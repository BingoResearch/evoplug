/**
 * Payload decoding and blob resolution before normalization (DD-TRG-004).
 *
 * The adapter never sees `ContentUpload`, `SourceRefPort` or the payload store;
 * host core writes the blob, reads it back and freezes the resolved payload.
 */

import { performance } from "node:perf_hooks";

import type { Clock } from "../clock.js";
import type { ErrorEnvelope } from "../errors.js";
import { hashBytes, type Hash } from "../hash.js";
import { isWellFormedUnicode, type JsonValue } from "../json.js";
import type { SourceRef, SourceRefPort } from "../source-ref.js";
import type { Result } from "../result.js";
import { err, ok } from "../result.js";
import { adapterErr, type HostAdapterError, type HostAdapterResult } from "./errors.js";
import type {
  ContentUpload,
  HostPayloadStorePort,
  ResolvedHostPayload,
  StoredContent
} from "./types.js";
import { isRecord, isSafePositiveInt, utf8ByteLength } from "./validation.js";

export const MAX_HOST_PAYLOAD_BYTES = 8_388_608;

export const MAX_HOST_JSON_BYTES = 1_048_576;

export const MAX_HOST_JSON_DEPTH = 64;

export interface HostPayloadResolverDeps {
  store: Pick<HostPayloadStorePort, "put">;
  sourceRefs: Pick<SourceRefPort, "resolve">;
  clock: Clock;
  limits?: { max_bytes: number; max_json_bytes: number; max_json_depth: number };
  /** Diagnostic locator used for local failures without a committed blob. */
  failure_ref?: SourceRef;
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function failure(
  deps: HostPayloadResolverDeps,
  code: HostAdapterError["code"],
  retryable: boolean,
  ref: SourceRef
): HostAdapterError {
  return {
    code,
    retryable,
    detail_ref: ref,
    observed_at: deps.clock.utcNowMs()
  };
}

function diagnosticRef(deps: HostPayloadResolverDeps, payloadHash: Hash, byteLength: number): SourceRef {
  if (deps.failure_ref !== undefined) {
    return deps.failure_ref;
  }
  const end = byteLength > 0 ? byteLength : 1;
  return `blob://${payloadHash}#bytes=0-${String(end)}` as SourceRef;
}

function deadline(deps: HostPayloadResolverDeps, remainingMs: number): number {
  return deps.clock.monotonicNowMs() + remainingMs;
}

function expired(deps: HostPayloadResolverDeps, deadlineAt: number): boolean {
  return deps.clock.monotonicRemainingMs(deadlineAt) <= 0;
}

function decodeUpload(
  upload: unknown
): { ok: true; bytes: Uint8Array; mediaType: ResolvedHostPayload["media_type"] } | { ok: false } {
  if (!isRecord(upload)) {
    return { ok: false };
  }
  const mediaType = upload["media_type"];
  const encoding = upload["encoding"];
  const data = upload["data"];
  const byteLength = upload["byte_length"];
  if (
    (mediaType !== "text/plain;charset=utf-8" &&
      mediaType !== "application/json" &&
      mediaType !== "application/octet-stream") ||
    (encoding !== "utf8" && encoding !== "base64") ||
    typeof data !== "string" ||
    !isSafePositiveInt(byteLength) ||
    byteLength > MAX_HOST_PAYLOAD_BYTES
  ) {
    return { ok: false };
  }
  let bytes: Uint8Array;
  if (encoding === "base64") {
    if (!BASE64_PATTERN.test(data)) {
      return { ok: false };
    }
    bytes = Uint8Array.from(Buffer.from(data, "base64"));
  } else {
    if (!isWellFormedUnicode(data)) {
      return { ok: false };
    }
    bytes = new TextEncoder().encode(data);
  }
  if (bytes.length !== byteLength) {
    return { ok: false };
  }
  return { ok: true, bytes, mediaType };
}

function jsonDepth(value: unknown, depth = 1): number {
  if (depth > MAX_HOST_JSON_DEPTH) {
    return depth;
  }
  if (Array.isArray(value)) {
    let max = depth;
    for (const entry of value) {
      max = Math.max(max, jsonDepth(entry, depth + 1));
    }
    return max;
  }
  if (isRecord(value)) {
    let max = depth;
    for (const entry of Object.values(value)) {
      max = Math.max(max, jsonDepth(entry, depth + 1));
    }
    return max;
  }
  return depth;
}

/**
 * Resolves an upload in the fixed DD-TRG-004 order. The returned payload is
 * frozen; `bytes` is a read-only view of a private copy.
 */
export async function resolveHostPayload(
  upload: ContentUpload,
  raw: { host_id: string; config_space: string; raw_event_id: string; payload_hash: Hash },
  deps: HostPayloadResolverDeps,
  deadlineRemainingMs = 600_000
): Promise<HostAdapterResult<ResolvedHostPayload>> {
  const limits = deps.limits ?? {
    max_bytes: MAX_HOST_PAYLOAD_BYTES,
    max_json_bytes: MAX_HOST_JSON_BYTES,
    max_json_depth: MAX_HOST_JSON_DEPTH
  };
  const deadlineAt = deadline(deps, deadlineRemainingMs);
  const decoded = decodeUpload(upload);
  if (!decoded.ok) {
    return adapterErr(failure(deps, "E_SCHEMA", false, diagnosticRef(deps, raw.payload_hash, 1)));
  }
  if (decoded.bytes.length > limits.max_bytes) {
    return adapterErr(failure(deps, "E_SCHEMA", false, diagnosticRef(deps, raw.payload_hash, decoded.bytes.length)));
  }
  if (expired(deps, deadlineAt)) {
    return adapterErr(failure(deps, "E_DEADLINE_EXCEEDED", true, diagnosticRef(deps, raw.payload_hash, decoded.bytes.length)));
  }
  const computedHash = hashBytes(decoded.bytes);
  if (computedHash !== raw.payload_hash) {
    return adapterErr(failure(deps, "E_CONFLICT", false, diagnosticRef(deps, raw.payload_hash, decoded.bytes.length)));
  }
  let stored: StoredContent;
  try {
    const put = await deps.store.put(upload, { type: "host_raw_event", id: raw.raw_event_id });
    if (!put.ok) {
      const code = put.error.code;
      if (code === "E_SCHEMA") {
        return adapterErr(failure(deps, "E_SCHEMA", false, diagnosticRef(deps, raw.payload_hash, decoded.bytes.length)));
      }
      if (code === "E_SOURCE_HASH") {
        return adapterErr(failure(deps, "E_CONFLICT", false, diagnosticRef(deps, raw.payload_hash, decoded.bytes.length)));
      }
      if (code.startsWith("E_STORAGE_")) {
        return adapterErr(failure(deps, "E_IO", put.error.retryable, diagnosticRef(deps, raw.payload_hash, decoded.bytes.length)));
      }
      return adapterErr(failure(deps, "E_IO", put.error.retryable, diagnosticRef(deps, raw.payload_hash, decoded.bytes.length)));
    }
    stored = put.value;
  } catch {
    return adapterErr(failure(deps, "E_IO", true, diagnosticRef(deps, raw.payload_hash, decoded.bytes.length)));
  }
  const expectedRef = `blob://${raw.payload_hash}#bytes=0-${String(decoded.bytes.length)}`;
  if (
    stored.content_ref !== expectedRef ||
    stored.content_hash !== raw.payload_hash ||
    stored.byte_length !== decoded.bytes.length
  ) {
    return adapterErr(failure(deps, "E_CONFLICT", false, diagnosticRef(deps, raw.payload_hash, decoded.bytes.length)));
  }
  if (expired(deps, deadlineAt)) {
    return adapterErr(failure(deps, "E_DEADLINE_EXCEEDED", true, stored.content_ref));
  }
  let resolvedBytes: Uint8Array;
  try {
    const resolved = await deps.sourceRefs.resolve(stored.content_ref, { maxBytes: limits.max_bytes });
    if (!resolved.ok) {
      return adapterErr(failure(deps, "E_IO", true, stored.content_ref));
    }
    if (!resolved.value.retrievable || resolved.value.bytes === null) {
      return adapterErr(failure(deps, "E_EVIDENCE_UNKNOWN", false, stored.content_ref));
    }
    if (resolved.value.contentVersion !== null && resolved.value.contentVersion !== raw.payload_hash) {
      return adapterErr(failure(deps, "E_CONFLICT", false, stored.content_ref));
    }
    if (resolved.value.bytes.length !== decoded.bytes.length) {
      return adapterErr(failure(deps, "E_CONFLICT", false, stored.content_ref));
    }
    resolvedBytes = resolved.value.bytes;
  } catch {
    return adapterErr(failure(deps, "E_IO", true, stored.content_ref));
  }
  let decodedText: string | undefined;
  if (decoded.mediaType === "text/plain;charset=utf-8" || decoded.mediaType === "application/json") {
    try {
      decodedText = new TextDecoder("utf-8", { fatal: true }).decode(resolvedBytes);
    } catch {
      return adapterErr(failure(deps, "E_SCHEMA", false, stored.content_ref));
    }
    if (new TextEncoder().encode(decodedText).length !== resolvedBytes.length) {
      return adapterErr(failure(deps, "E_SCHEMA", false, stored.content_ref));
    }
  }
  let jsonValue: JsonValue | undefined;
  if (decoded.mediaType === "application/json") {
    if (resolvedBytes.length > limits.max_json_bytes || decodedText === undefined) {
      return adapterErr(failure(deps, "E_SCHEMA", false, stored.content_ref));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodedText);
    } catch {
      return adapterErr(failure(deps, "E_SCHEMA", false, stored.content_ref));
    }
    if (jsonDepth(parsed) > limits.max_json_depth) {
      return adapterErr(failure(deps, "E_SCHEMA", false, stored.content_ref));
    }
    jsonValue = parsed as JsonValue;
  }
  if (expired(deps, deadlineAt)) {
    return adapterErr(failure(deps, "E_DEADLINE_EXCEEDED", true, stored.content_ref));
  }
  const payload: ResolvedHostPayload = {
    schema_version: "rsi.resolved_host_payload/1",
    canonical_ref: stored.content_ref,
    content_version: raw.payload_hash,
    payload_hash: raw.payload_hash,
    media_type: decoded.mediaType,
    encoding: upload.encoding,
    byte_length: resolvedBytes.length,
    bytes: resolvedBytes,
    resolved_at: deps.clock.utcNowMs()
  };
  if (decodedText !== undefined) {
    payload.decoded_text = decodedText;
  }
  if (jsonValue !== undefined) {
    payload.json_value = jsonValue;
  }
  return ok(Object.freeze(payload));
}

/** Validates `ContentUpload` shape without decoding (phase A preflight). */
export function validateContentUploadShape(value: unknown): boolean {
  return decodeUpload(value).ok;
}

/** Recomputes the byte hash; used before and after `normalizeEvent`. */
export function payloadBytesHash(bytes: Readonly<Uint8Array>): Hash {
  return hashBytes(bytes);
}

/** Strict UTF-8 text length check used by callers that already have bytes. */
export function isStrictUtf8(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return new TextEncoder().encode(text).length === bytes.length && utf8ByteLength(text) === bytes.length;
  } catch {
    return false;
  }
}

/** Unused import guard for `Result` in this module's public types. */
export type PayloadResult = Result<ResolvedHostPayload, ErrorEnvelope>;
