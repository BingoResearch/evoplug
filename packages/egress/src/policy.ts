/**
 * `EgressPolicy` validation and endpoint normalisation (DD-FND-093 rules 1-2).
 *
 * The parser never repairs a policy: unknown fields, unnormalisable hosts,
 * wildcard or private endpoints and `secret` in an endpoint rule all fail the
 * whole policy with `E_SCHEMA`. The returned object is the normalised form
 * whose JCS bytes are the policy preimage.
 */

import { canonicalHash, err, ok } from "@evoplug/core";
import type { ErrorEnvelope, Hash, JsonValue, Result } from "@evoplug/core";
import { domainToASCII } from "node:url";
import { isIP } from "node:net";

import { egressSchemaError } from "./errors.js";
import {
  EGRESS_MAX_REQUEST_BYTES,
  EGRESS_POLICY_SCHEMA_VERSION,
  isDataClass,
  type DataClass,
  type EgressAllowedDataClass,
  type EgressEndpointRule,
  type EgressPolicy,
} from "./types.js";

const POLICY_FIELDS: readonly string[] = [
  "schema_version",
  "policy_version",
  "default_decision",
  "endpoints",
  "project_exclusions",
  "max_source_refs",
  "permission_for_replay",
];

const ENDPOINT_FIELDS: readonly string[] = [
  "scheme",
  "host",
  "port",
  "path_prefix",
  "models",
  "data_classes",
  "max_request_bytes",
];

const MAX_HOST_BYTES = 253;
const MAX_MODEL_BYTES = 256;
const MAX_PROJECT_ID_BYTES = 256;

/** Normalises and validates an endpoint host (DD-FND-093 rule 1). */
export function normalizeEgressHost(host: string): Result<string, ErrorEnvelope> {
  if (typeof host !== "string" || host.length === 0) {
    return err(egressSchemaError("endpoints.host", "non_empty"));
  }
  if (!isWellFormedAsciiSource(host)) {
    return err(egressSchemaError("endpoints.host", "well_formed_text"));
  }
  if (hasControlOrWhitespace(host)) {
    return err(egressSchemaError("endpoints.host", "no_control_or_whitespace"));
  }
  if (
    host.includes("@") ||
    host.includes("/") ||
    host.includes("?") ||
    host.includes("#") ||
    host.includes("[") ||
    host.includes("]") ||
    host.includes("*")
  ) {
    return err(egressSchemaError("endpoints.host", "no_userinfo_wildcard_or_delimiter"));
  }
  const withoutTrailingDot = host.endsWith(".") ? host.slice(0, -1) : host;
  if (withoutTrailingDot.length === 0) {
    return err(egressSchemaError("endpoints.host", "non_empty"));
  }
  const ascii = domainToASCII(withoutTrailingDot);
  if (ascii.length === 0) {
    return err(egressSchemaError("endpoints.host", "idna_ascii"));
  }
  const normalized = ascii.toLowerCase();
  if (new TextEncoder().encode(normalized).length > MAX_HOST_BYTES) {
    return err(egressSchemaError("endpoints.host", "max_253_bytes"));
  }
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return err(egressSchemaError("endpoints.host", "not_localhost"));
  }
  if (normalized.endsWith(".local") || normalized.endsWith(".internal")) {
    return err(egressSchemaError("endpoints.host", "not_private_name"));
  }
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    if (!isPublicIpv4(normalized)) {
      return err(egressSchemaError("endpoints.host", "public_address"));
    }
    return ok(normalized);
  }
  if (ipVersion === 6) {
    if (!isPublicIpv6(normalized)) {
      return err(egressSchemaError("endpoints.host", "public_address"));
    }
    return ok(normalized);
  }
  if (!isDnsName(normalized)) {
    return err(egressSchemaError("endpoints.host", "dns_name"));
  }
  return ok(normalized);
}

/** Parses and normalises one endpoint rule. */
function parseEgressEndpointRule(value: unknown): Result<EgressEndpointRule, ErrorEnvelope> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(egressSchemaError("endpoints[]", "object"));
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ENDPOINT_FIELDS.includes(key)) {
      return err(egressSchemaError(`endpoints[].${key}`, "known_field"));
    }
  }
  for (const field of ENDPOINT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return err(egressSchemaError(`endpoints[].${field}`, "required"));
    }
  }
  if (record["scheme"] !== "https") {
    return err(egressSchemaError("endpoints[].scheme", "https"));
  }
  const hostValue = record["host"];
  if (typeof hostValue !== "string") {
    return err(egressSchemaError("endpoints[].host", "string"));
  }
  const host = normalizeEgressHost(hostValue);
  if (!host.ok) {
    return host;
  }
  const port = record["port"];
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return err(egressSchemaError("endpoints[].port", "1_65535"));
  }
  const pathPrefix = record["path_prefix"];
  if (typeof pathPrefix !== "string") {
    return err(egressSchemaError("endpoints[].path_prefix", "string"));
  }
  const pathFailure = validateOriginFormPath(pathPrefix, 8_192);
  if (pathFailure !== null) {
    return err(egressSchemaError("endpoints[].path_prefix", pathFailure));
  }
  const models = parseUniqueStringArray(record["models"], "endpoints[].models", MAX_MODEL_BYTES);
  if (!models.ok) {
    return models;
  }
  const dataClasses = parseDataClassArray(record["data_classes"]);
  if (!dataClasses.ok) {
    return dataClasses;
  }
  const maxRequestBytes = record["max_request_bytes"];
  if (
    typeof maxRequestBytes !== "number" ||
    !Number.isSafeInteger(maxRequestBytes) ||
    maxRequestBytes < 1 ||
    maxRequestBytes > EGRESS_MAX_REQUEST_BYTES
  ) {
    return err(egressSchemaError("endpoints[].max_request_bytes", "1_16777216"));
  }
  return ok({
    scheme: "https",
    host: host.value,
    port,
    path_prefix: pathPrefix,
    models: models.value,
    data_classes: dataClasses.value,
    max_request_bytes: maxRequestBytes,
  });
}

/**
 * Parses an `EgressPolicy`. Structural violations and rule violations both
 * fail with `E_SCHEMA`; this parser never downgrades a malformed rule.
 */
export function parseEgressPolicy(value: unknown): Result<EgressPolicy, ErrorEnvelope> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(egressSchemaError("$", "object"));
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!POLICY_FIELDS.includes(key)) {
      return err(egressSchemaError(key, "known_field"));
    }
  }
  for (const field of POLICY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return err(egressSchemaError(field, "required"));
    }
  }
  if (record["schema_version"] !== EGRESS_POLICY_SCHEMA_VERSION) {
    return err(egressSchemaError("schema_version", EGRESS_POLICY_SCHEMA_VERSION));
  }
  if (record["default_decision"] !== "deny") {
    return err(egressSchemaError("default_decision", "deny"));
  }
  const policyVersion = record["policy_version"];
  if (
    typeof policyVersion !== "string" ||
    policyVersion.length === 0 ||
    new TextEncoder().encode(policyVersion).length > 128 ||
    hasControlOrWhitespace(policyVersion)
  ) {
    return err(egressSchemaError("policy_version", "1_128_utf8_bytes"));
  }
  const endpointsValue = record["endpoints"];
  if (!Array.isArray(endpointsValue)) {
    return err(egressSchemaError("endpoints", "array"));
  }
  const endpoints: EgressEndpointRule[] = [];
  for (let index = 0; index < endpointsValue.length; index += 1) {
    const parsed = parseEgressEndpointRule(endpointsValue[index]);
    if (!parsed.ok) {
      return parsed;
    }
    endpoints.push(parsed.value);
  }
  const projectExclusions = parseUniqueStringArray(
    record["project_exclusions"],
    "project_exclusions",
    MAX_PROJECT_ID_BYTES,
  );
  if (!projectExclusions.ok) {
    return projectExclusions;
  }
  const maxSourceRefs = record["max_source_refs"];
  if (
    typeof maxSourceRefs !== "number" ||
    !Number.isSafeInteger(maxSourceRefs) ||
    maxSourceRefs < 0
  ) {
    return err(egressSchemaError("max_source_refs", "non_negative_safe_integer"));
  }
  const permission = record["permission_for_replay"];
  if (permission !== "same_policy" && permission !== "deny") {
    return err(egressSchemaError("permission_for_replay", "same_policy_or_deny"));
  }
  return ok({
    schema_version: EGRESS_POLICY_SCHEMA_VERSION,
    policy_version: policyVersion,
    default_decision: "deny",
    endpoints,
    project_exclusions: projectExclusions.value,
    max_source_refs: maxSourceRefs,
    permission_for_replay: permission,
  });
}

/** `policy_hash = sha256(JCS(policy))` over the normalised policy. */
export function computeEgressPolicyHash(policy: EgressPolicy): Hash {
  const preimage: JsonValue = {
    schema_version: policy.schema_version,
    policy_version: policy.policy_version,
    default_decision: policy.default_decision,
    endpoints: policy.endpoints.map((endpoint) => ({
      scheme: endpoint.scheme,
      host: endpoint.host,
      port: endpoint.port,
      path_prefix: endpoint.path_prefix,
      models: [...endpoint.models],
      data_classes: [...endpoint.data_classes],
      max_request_bytes: endpoint.max_request_bytes,
    })),
    project_exclusions: [...policy.project_exclusions],
    max_source_refs: policy.max_source_refs,
    permission_for_replay: policy.permission_for_replay,
  };
  return canonicalHash(preimage);
}

/**
 * Union of every endpoint's `data_classes`. `secret` never enters the
 * eligible set even if a malformed policy listed it (DD-FND-093.1).
 */
/** Policy version prefix written for a loopback standing receiver (N.3). */
const LOOPBACK_POLICY_PREFIX = "egress/standing/loopback/";

/**
 * Data classes eligible for the prompt. An endpoint rule names its own set.
 * A loopback standing policy has no external endpoint (traffic never leaves
 * the machine), so its local review prompt may use every non-secret class.
 */
export function eligibleEgressDataClasses(policy: EgressPolicy): ReadonlySet<EgressAllowedDataClass> {
  if (policy.endpoints.length === 0 && policy.policy_version.startsWith(LOOPBACK_POLICY_PREFIX)) {
    return new Set<EgressAllowedDataClass>(["public", "user_text", "source_code", "tool_output"]);
  }
  const eligible = new Set<EgressAllowedDataClass>();
  for (const endpoint of policy.endpoints) {
    for (const dataClass of endpoint.data_classes) {
      eligible.add(dataClass);
    }
  }
  return eligible;
}

/** Validates an origin-form request target: ASCII, starts with "/", no fragment. */
export function validateOriginFormPath(path: string, maxBytes: number): string | null {
  if (path.length === 0) {
    return "non_empty";
  }
  if (!path.startsWith("/")) {
    return "starts_with_slash";
  }
  if (path.includes("#")) {
    return "no_fragment";
  }
  if (/\s/.test(path)) {
    return "no_whitespace";
  }
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      return "printable_ascii";
    }
  }
  if (new TextEncoder().encode(path).length > maxBytes) {
    return `max_${String(maxBytes)}_bytes`;
  }
  return null;
}

function parseUniqueStringArray(
  value: unknown,
  path: string,
  maxBytes: number,
): Result<string[], ErrorEnvelope> {
  if (!Array.isArray(value)) {
    return err(egressSchemaError(path, "array"));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || item.length === 0) {
      return err(egressSchemaError(`${path}[${String(index)}]`, "non_empty_string"));
    }
    if (new TextEncoder().encode(item).length > maxBytes) {
      return err(egressSchemaError(`${path}[${String(index)}]`, `max_${String(maxBytes)}_bytes`));
    }
    if (hasControlOrWhitespace(item)) {
      return err(egressSchemaError(`${path}[${String(index)}]`, "no_control_or_whitespace"));
    }
    if (seen.has(item)) {
      return err(egressSchemaError(`${path}[${String(index)}]`, "unique"));
    }
    seen.add(item);
    out.push(item);
  }
  return ok(out);
}

function parseDataClassArray(value: unknown): Result<EgressAllowedDataClass[], ErrorEnvelope> {
  if (!Array.isArray(value)) {
    return err(egressSchemaError("endpoints[].data_classes", "array"));
  }
  const seen = new Set<DataClass>();
  const out: EgressAllowedDataClass[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || !isDataClass(item)) {
      return err(egressSchemaError(`endpoints[].data_classes[${String(index)}]`, "data_class"));
    }
    if (item === "secret") {
      return err(egressSchemaError(`endpoints[].data_classes[${String(index)}]`, "secret_forbidden"));
    }
    if (seen.has(item)) {
      return err(egressSchemaError(`endpoints[].data_classes[${String(index)}]`, "unique"));
    }
    seen.add(item);
    out.push(item);
  }
  return ok(out);
}

function isWellFormedAsciiSource(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasControlOrWhitespace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function isDnsName(value: string): boolean {
  const labels = value.split(".");
  if (labels.length < 2) {
    return false;
  }
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      return false;
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      return false;
    }
    if (!/^[a-z0-9-]+$/.test(label)) {
      return false;
    }
  }
  const last = labels[labels.length - 1];
  if (last === undefined || /^[0-9]+$/.test(last)) {
    return false;
  }
  return true;
}

function isPublicIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) {
      return false;
    }
    const octet = Number(part);
    if (octet > 255) {
      return false;
    }
    octets.push(octet);
  }
  const first = octets[0];
  const second = octets[1];
  const third = octets[2];
  if (first === undefined || second === undefined || third === undefined) {
    return false;
  }
  if (first === 0 || first === 10 || first === 127) {
    return false;
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return false;
  }
  if (first === 169 && second === 254) {
    return false;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return false;
  }
  if (first === 192 && second === 168) {
    return false;
  }
  if (first === 192 && second === 0 && (third === 0 || third === 2)) {
    return false;
  }
  if (first === 198 && (second === 18 || second === 19)) {
    return false;
  }
  if (first === 198 && second === 51 && third === 100) {
    return false;
  }
  if (first === 203 && second === 0 && third === 113) {
    return false;
  }
  if (first >= 224) {
    return false;
  }
  return true;
}

function isPublicIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized.includes(".")) {
    return false;
  }
  if (normalized === "::" || normalized === "::1") {
    return false;
  }
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return false;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return false;
  }
  if (normalized.startsWith("ff")) {
    return false;
  }
  return true;
}
