/**
 * Egress request validation, normalisation and `request_hash` derivation
 * (DD-FND-093, DD-FND-097.6).
 *
 * `policy_version` and `request_hash` are server-derived. The preimage is
 * exactly the white list below; nothing else (findings, resolved IPs, TLS
 * session, timestamps or approval fields) may enter it.
 */

import {
  canonicalHash,
  compareUtf8,
  err,
  hashBytes,
  isHash,
  isId,
  ok,
  parseId,
  parseSourceRef,
  parseVersionBinding,
} from "@evoplug/core";
import type {
  ErrorEnvelope,
  Hash,
  Id,
  JsonValue,
  Result,
  SourceRef,
  VersionBinding,
} from "@evoplug/core";

import {
  egressByteLimitError,
  egressRequestHashError,
  egressRequestInvalidError,
  egressRequestPreimageError,
  egressSchemaError,
} from "./errors.js";
import { normalizeEgressHost, validateOriginFormPath } from "./policy.js";
import {
  EGRESS_MAX_PATH_BYTES,
  EGRESS_MAX_REQUEST_BYTES,
  EGRESS_REQUEST_SCHEMA_VERSION,
  isDataClass,
  isEgressPurpose,
  type DataClass,
  type EgressEndpoint,
  type EgressRequest,
  type EgressRequestInput,
  type EgressRequestSource,
} from "./types.js";

const INPUT_FIELDS: readonly string[] = [
  "schema_version",
  "binding",
  "purpose",
  "endpoint",
  "model",
  "project_id",
  "sources",
  "body_sha256",
  "byte_length",
  "replay_plan_id",
];

const ENDPOINT_FIELDS: readonly string[] = ["scheme", "host", "port", "path"];

const SOURCE_FIELDS: readonly string[] = ["ref", "data_class"];

const MAX_MODEL_BYTES = 256;
const MAX_PROJECT_ID_BYTES = 256;

/** Parses an `EgressRequestInput` received at the IPC boundary. */
export function parseEgressRequestInput(
  value: unknown,
): Result<EgressRequestInput, ErrorEnvelope> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(egressSchemaError("$", "object"));
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!INPUT_FIELDS.includes(key)) {
      return err(egressSchemaError(key, "known_field"));
    }
  }
  for (const field of INPUT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return err(egressSchemaError(field, "required"));
    }
  }
  if (record["schema_version"] !== EGRESS_REQUEST_SCHEMA_VERSION) {
    return err(egressSchemaError("schema_version", EGRESS_REQUEST_SCHEMA_VERSION));
  }
  const binding = parseVersionBinding(record["binding"]);
  if (!binding.ok) {
    return binding;
  }
  const purpose = record["purpose"];
  if (typeof purpose !== "string" || !isEgressPurpose(purpose)) {
    return err(egressSchemaError("purpose", "egress_purpose"));
  }
  const endpoint = parseEgressEndpoint(record["endpoint"]);
  if (!endpoint.ok) {
    return endpoint;
  }
  const model = parseBoundedText(record["model"], "model", MAX_MODEL_BYTES);
  if (!model.ok) {
    return model;
  }
  const projectId = parseBoundedText(record["project_id"], "project_id", MAX_PROJECT_ID_BYTES);
  if (!projectId.ok) {
    return projectId;
  }
  const sources = parseRequestSources(record["sources"]);
  if (!sources.ok) {
    return sources;
  }
  const bodyHash = record["body_sha256"];
  if (typeof bodyHash !== "string" || !isHash(bodyHash)) {
    return err(egressSchemaError("body_sha256", "sha256_full_hash"));
  }
  const byteLength = record["byte_length"];
  if (
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > EGRESS_MAX_REQUEST_BYTES
  ) {
    return err(egressSchemaError("byte_length", "1_16777216"));
  }
  const replayPlanId = record["replay_plan_id"];
  if (replayPlanId !== null) {
    if (typeof replayPlanId !== "string" || !isId(replayPlanId, "rpl")) {
      return err(egressSchemaError("replay_plan_id", "rpl_id_or_null"));
    }
  }
  return ok({
    schema_version: EGRESS_REQUEST_SCHEMA_VERSION,
    binding: binding.value,
    purpose,
    endpoint: endpoint.value,
    model: model.value,
    project_id: projectId.value,
    sources: sources.value,
    body_sha256: bodyHash,
    byte_length: byteLength,
    replay_plan_id: replayPlanId,
  });
}

/** Parses and normalises the nested endpoint object. */
export function parseEgressEndpoint(value: unknown): Result<EgressEndpoint, ErrorEnvelope> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(egressSchemaError("endpoint", "object"));
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ENDPOINT_FIELDS.includes(key)) {
      return err(egressSchemaError(`endpoint.${key}`, "known_field"));
    }
  }
  for (const field of ENDPOINT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return err(egressSchemaError(`endpoint.${field}`, "required"));
    }
  }
  if (record["scheme"] !== "https") {
    return err(egressSchemaError("endpoint.scheme", "https"));
  }
  const hostValue = record["host"];
  if (typeof hostValue !== "string") {
    return err(egressSchemaError("endpoint.host", "string"));
  }
  const host = normalizeEgressHost(hostValue);
  if (!host.ok) {
    return host;
  }
  const port = record["port"];
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return err(egressSchemaError("endpoint.port", "1_65535"));
  }
  const path = record["path"];
  if (typeof path !== "string") {
    return err(egressSchemaError("endpoint.path", "string"));
  }
  const failure = validateOriginFormPath(path, EGRESS_MAX_PATH_BYTES);
  if (failure !== null) {
    return err(egressSchemaError("endpoint.path", failure));
  }
  return ok({ scheme: "https", host: host.value, port, path });
}

/**
 * Parses the paired source list, sorts it by `ref` UTF-8 then `data_class`
 * UTF-8, and merges duplicate refs only when their data class is identical.
 */
export function parseRequestSources(
  value: unknown,
): Result<EgressRequestSource[], ErrorEnvelope> {
  if (!Array.isArray(value)) {
    return err(egressSchemaError("sources", "array"));
  }
  const byRef = new Map<SourceRef, DataClass>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return err(egressSchemaError(`sources[${String(index)}]`, "object"));
    }
    const record = item as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!SOURCE_FIELDS.includes(key)) {
        return err(egressSchemaError(`sources[${String(index)}].${key}`, "known_field"));
      }
    }
    const refValue = record["ref"];
    const dataClass = record["data_class"];
    if (typeof refValue !== "string") {
      return err(egressSchemaError(`sources[${String(index)}].ref`, "string"));
    }
    if (typeof dataClass !== "string" || !isDataClass(dataClass)) {
      return err(egressSchemaError(`sources[${String(index)}].data_class`, "data_class"));
    }
    const parsedRef = parseSourceRef(refValue);
    if (!parsedRef.ok) {
      return parsedRef;
    }
    const existing = byRef.get(parsedRef.value.source_ref);
    if (existing !== undefined && existing !== dataClass) {
      return err(egressRequestInvalidError());
    }
    byRef.set(parsedRef.value.source_ref, dataClass);
  }
  const out: EgressRequestSource[] = [];
  for (const [ref, dataClass] of byRef) {
    out.push({ ref, data_class: dataClass });
  }
  out.sort((left, right) => {
    const byRefOrder = compareUtf8(left.ref, right.ref);
    if (byRefOrder !== 0) {
      return byRefOrder;
    }
    return compareUtf8(left.data_class, right.data_class);
  });
  return ok(out);
}

/**
 * Computes `request_hash = sha256(JCS(preimage))` with the DD-FND-097.6 white
 * list. The caller's `sources` are re-sorted by the same comparator so a
 * different input order cannot change the hash.
 */
export function computeEgressRequestHash(
  input: EgressRequestInput,
  policyVersion: string,
): Hash {
  const sources = [...input.sources].sort((left, right) => {
    const byRefOrder = compareUtf8(left.ref, right.ref);
    if (byRefOrder !== 0) {
      return byRefOrder;
    }
    return compareUtf8(left.data_class, right.data_class);
  });
  const preimage: JsonValue = {
    schema_version: "rsi.egress_request_hash/1",
    binding: versionBindingPreimage(input.binding),
    purpose: input.purpose,
    endpoint: {
      scheme: input.endpoint.scheme,
      host: input.endpoint.host,
      port: input.endpoint.port,
      path: input.endpoint.path,
    },
    policy_version: policyVersion,
    model: input.model,
    project_id: input.project_id,
    sources: sources.map((source) => ({
      ref: source.ref,
      data_class: source.data_class,
    })),
    body_sha256: input.body_sha256,
    byte_length: input.byte_length,
    replay_plan_id: input.replay_plan_id,
  };
  return canonicalHash(preimage);
}

/**
 * Freezes an input into the full `EgressRequest` returned by
 * `egress.evaluate`. The policy version is always taken from the argument,
 * never from the request.
 */
export function freezeEgressRequest(
  input: EgressRequestInput,
  policyVersion: string,
): Result<EgressRequest, ErrorEnvelope> {
  if (policyVersion.length === 0) {
    return err(egressSchemaError("policy_version", "non_empty"));
  }
  const request: EgressRequest = {
    schema_version: input.schema_version,
    binding: input.binding,
    purpose: input.purpose,
    endpoint: input.endpoint,
    model: input.model,
    project_id: input.project_id,
    sources: [...input.sources],
    body_sha256: input.body_sha256,
    byte_length: input.byte_length,
    replay_plan_id: input.replay_plan_id,
    policy_version: policyVersion,
    request_hash: computeEgressRequestHash(input, policyVersion),
  };
  return ok(request);
}

/** Parses a complete `EgressRequest`, including the two server-derived fields. */
export function parseEgressRequest(value: unknown): Result<EgressRequest, ErrorEnvelope> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(egressSchemaError("$", "object"));
  }
  const record = value as Record<string, unknown>;
  const policyVersion = record["policy_version"];
  const requestHash = record["request_hash"];
  const allowed = new Set<string>([...INPUT_FIELDS, "policy_version", "request_hash"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      return err(egressSchemaError(key, "known_field"));
    }
  }
  for (const field of [...INPUT_FIELDS, "policy_version", "request_hash"]) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return err(egressRequestPreimageError());
    }
  }
  if (typeof policyVersion !== "string" || policyVersion.length === 0) {
    return err(egressSchemaError("policy_version", "non_empty_string"));
  }
  if (typeof requestHash !== "string" || !isHash(requestHash)) {
    return err(egressSchemaError("request_hash", "sha256_full_hash"));
  }
  const inputLike: Record<string, unknown> = {};
  for (const field of INPUT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      inputLike[field] = record[field];
    }
  }
  const input = parseEgressRequestInput(inputLike);
  if (!input.ok) {
    return input;
  }
  const frozen = freezeEgressRequest(input.value, policyVersion);
  if (!frozen.ok) {
    return frozen;
  }
  if (frozen.value.request_hash !== requestHash) {
    return err(egressRequestHashError());
  }
  return ok(frozen.value);
}

/** Recomputes the hash from the full request, ignoring the stored value. */
export function recomputeEgressRequestHash(request: EgressRequest): Hash {
  return computeEgressRequestHash(request, request.policy_version);
}

/** Derives the two body facts the server must freeze before evaluation. */
export function computeEgressBodyDigest(body: Uint8Array): {
  body_sha256: Hash;
  byte_length: number;
} {
  return { body_sha256: hashBytes(body), byte_length: body.byteLength };
}

/**
 * Recomputes the body facts from the actual serialized bytes.
 *
 * A length mismatch is `E_EGRESS_BYTE_LIMIT` when the body exceeds the
 * endpoint cap, and `E_EGRESS_REQUEST_HASH` when the declared length is simply
 * wrong; a hash mismatch is always `E_EGRESS_REQUEST_HASH`. The gateway calls
 * this immediately before and after sending.
 */
export function verifyEgressBody(
  input: EgressRequestInput,
  body: Uint8Array,
  policyVersion = "",
): Result<{ body_sha256: Hash; byte_length: number }, ErrorEnvelope> {
  return verifyEgressBodyAgainstLimit(
    input,
    body,
    EGRESS_MAX_REQUEST_BYTES,
    policyVersion,
  );
}

/** Same check with the matched endpoint's `max_request_bytes`. */
export function verifyEgressBodyAgainstLimit(
  input: EgressRequestInput,
  body: Uint8Array,
  maxBytes: number,
  policyVersion: string,
): Result<{ body_sha256: Hash; byte_length: number }, ErrorEnvelope> {
  const actual = computeEgressBodyDigest(body);
  if (actual.byte_length !== input.byte_length) {
    if (actual.byte_length > maxBytes) {
      return err(egressByteLimitError(policyVersion, input.sources.map((source) => source.ref)));
    }
    return err(egressRequestHashError());
  }
  if (actual.body_sha256 !== input.body_sha256) {
    return err(egressRequestHashError());
  }
  return ok(actual);
}

/**
 * Validates that a full request's `request_hash` equals the server-derived
 * value. Missing preimage fields are caught by `parseEgressRequestInput`
 * before this point and surface as `E_EGRESS_REQUEST_PREIMAGE`.
 */
export function verifyEgressRequestHash(
  request: EgressRequest,
): Result<EgressRequest, ErrorEnvelope> {
  const recomputed = recomputeEgressRequestHash(request);
  if (recomputed !== request.request_hash) {
    return err(egressRequestHashError());
  }
  return ok(request);
}

function parseBoundedText(
  value: unknown,
  path: string,
  maxBytes: number,
): Result<string, ErrorEnvelope> {
  if (typeof value !== "string" || value.length === 0) {
    return err(egressSchemaError(path, "non_empty_string"));
  }
  if (new TextEncoder().encode(value).length > maxBytes) {
    return err(egressSchemaError(path, `max_${String(maxBytes)}_bytes`));
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return err(egressSchemaError(path, "no_control_characters"));
    }
  }
  return ok(value);
}

function versionBindingPreimage(binding: VersionBinding): JsonValue {
  return {
    task_id: binding.task_id,
    branch_id: binding.branch_id,
    input_epoch: binding.input_epoch,
    goal_version: binding.goal_version,
    config_version: binding.config_version,
    watermark: binding.watermark,
  };
}

/** Re-exported for callers that need to construct an `rpl` identifier. */
export type EgressReplayPlanId = Id<"rpl">;

/** Parses an existing replay plan identifier at an approval boundary. */
export function parseReplayPlanId(value: string): Result<Id<"rpl">, ErrorEnvelope> {
  try {
    const parsed = parseId(value);
    if (parsed.prefix !== "rpl") {
      return err(egressSchemaError("replay_plan_id", "rpl_id"));
    }
    return ok(value as Id<"rpl">);
  } catch {
    return err(egressSchemaError("replay_plan_id", "rpl_id"));
  }
}
