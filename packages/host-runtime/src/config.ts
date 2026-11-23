/**
 * Runtime instance configuration (DD-HOST-200.3).
 *
 * `config.json` is written by attach with mode 0600 and is deliberately outside
 * `artifact_hash`. The runtime derives the UDS socket and token paths from
 * `evoplug_home` unless explicit test/CLI overrides are present, and computes
 * `config_hash = sha256(JCS(config))` for ready.
 */

import { lstat, readFile, } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { canonicalHash, isHash, isHostId, isHostMode, isId, type Hash, type Id, type JsonValue } from "@evoplug/core";
import type { HostId, HostMode } from "@evoplug/core/host";
import { runtimePaths } from "@evoplug/ipc";

import {
  HOST_RUNTIME_CONFIG_SCHEMA_VERSION,
  type HostRuntimeConfig,
  type HostRuntimeConfigBehavior,
  type HostRuntimeConfigIpc,
  type HostRuntimeConfigLog,
  type HostRuntimeLogLevel
} from "./artifact.js";
import { DEFAULT_REDACT_PREFIXES } from "./redact.js";
import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return sharedIsRecord(value);
}

const HOST_RUNTIME_CONFIG_MODE = 0o600;

const CONFIG_SPACE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const LOG_LEVELS: readonly HostRuntimeLogLevel[] = ["error", "warn", "info"];

interface HostRuntimeConfigIssue {
  readonly code: string;
  readonly path: string;
  readonly rule: string;
}

interface HostRuntimeConfigEndpoints {
  readonly evoplug_home: string;
  readonly socket_path: string;
  readonly token_path: string;
}

type HostRuntimeConfigParseResult =
  | { readonly ok: true; readonly value: HostRuntimeConfig }
  | { readonly ok: false; readonly issue: HostRuntimeConfigIssue };

interface HostRuntimeConfigLoadResult {
  readonly ok: true;
  readonly config: HostRuntimeConfig;
  readonly config_hash: Hash;
  readonly endpoints: HostRuntimeConfigEndpoints;
}

type HostRuntimeConfigReadResult =
  | HostRuntimeConfigLoadResult
  | { readonly ok: false; readonly issue: HostRuntimeConfigIssue };

interface LoadHostRuntimeConfigOptions {
  /** Expected file mode; defaults to 0600. */
  readonly expected_mode?: number;
  /** Defaults to true. Disable only in tests that cannot use POSIX modes. */
  readonly enforce_mode?: boolean;
}

function issue(code: string, path: string, rule: string): HostRuntimeConfigIssue {
  return { code, path, rule };
}

function hasOnlyKeys(record: Record<string, unknown>, known: readonly string[], prefix: string): HostRuntimeConfigIssue | null {
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) {
      return issue("unknown_field", `${prefix}${key}`, "closed_object");
    }
  }
  return null;
}

function requiredKeys(record: Record<string, unknown>, required: readonly string[], prefix: string): HostRuntimeConfigIssue | null {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      return issue("missing_field", `${prefix}${key}`, "required");
    }
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function parseIpc(value: unknown, adapterId: Id<"adp">): HostRuntimeConfigIpc | HostRuntimeConfigIssue {
  if (!isRecord(value)) {
    return issue("ipc_shape", "ipc", "object");
  }
  const keyIssue = hasOnlyKeys(value, ["evoplug_home", "socket_path", "token_path", "client_id", "client_kind"], "ipc.");
  if (keyIssue !== null) {
    return keyIssue;
  }
  const missing = requiredKeys(value, ["evoplug_home", "client_id", "client_kind"], "ipc.");
  if (missing !== null) {
    return missing;
  }
  const home = value["evoplug_home"];
  if (!isNonEmptyString(home) || !isAbsolute(home)) {
    return issue("ipc_home", "ipc.evoplug_home", "absolute_path");
  }
  const socketPath = value["socket_path"];
  if (socketPath !== undefined && (!isNonEmptyString(socketPath) || !isAbsolute(socketPath))) {
    return issue("ipc_socket_path", "ipc.socket_path", "absolute_path");
  }
  const tokenPath = value["token_path"];
  if (tokenPath !== undefined && (!isNonEmptyString(tokenPath) || !isAbsolute(tokenPath))) {
    return issue("ipc_token_path", "ipc.token_path", "absolute_path");
  }
  if (value["client_kind"] !== "host_runtime") {
    return issue("ipc_client_kind", "ipc.client_kind", "host_runtime");
  }
  const clientId = value["client_id"];
  if (typeof clientId !== "string" || !isId(clientId, "adp")) {
    return issue("ipc_client_id", "ipc.client_id", "adp_id");
  }
  if (clientId !== adapterId) {
    return issue("ipc_client_id_mismatch", "ipc.client_id", "equals_adapter_id");
  }
  const parsed: HostRuntimeConfigIpc = {
    evoplug_home: home,
    client_id: clientId,
    client_kind: "host_runtime"
  };
  if (socketPath !== undefined) {
    Object.assign(parsed, { socket_path: socketPath });
  }
  if (tokenPath !== undefined) {
    Object.assign(parsed, { token_path: tokenPath });
  }
  return parsed;
}

function parseBehavior(value: unknown): HostRuntimeConfigBehavior | HostRuntimeConfigIssue {
  if (!isRecord(value)) {
    return issue("behavior_shape", "behavior", "object");
  }
  const keyIssue = hasOnlyKeys(
    value,
    ["submit_events", "allow_delivery", "max_payload_bytes", "redact_fields"],
    "behavior."
  );
  if (keyIssue !== null) {
    return keyIssue;
  }
  const missing = requiredKeys(
    value,
    ["submit_events", "allow_delivery", "max_payload_bytes", "redact_fields"],
    "behavior."
  );
  if (missing !== null) {
    return missing;
  }
  if (typeof value["submit_events"] !== "boolean") {
    return issue("behavior_submit_events", "behavior.submit_events", "boolean");
  }
  if (typeof value["allow_delivery"] !== "boolean") {
    return issue("behavior_allow_delivery", "behavior.allow_delivery", "boolean");
  }
  if (!isSafePositiveInt(value["max_payload_bytes"])) {
    return issue("behavior_max_payload_bytes", "behavior.max_payload_bytes", "positive_integer");
  }
  const redactFields = value["redact_fields"];
  if (!Array.isArray(redactFields) || redactFields.length === 0) {
    return issue("behavior_redact_fields", "behavior.redact_fields", "non_empty_array");
  }
  const seen = new Set<string>();
  for (let index = 0; index < redactFields.length; index += 1) {
    const field = redactFields[index];
    if (!isNonEmptyString(field)) {
      return issue("behavior_redact_field", `behavior.redact_fields[${String(index)}]`, "non_empty_string");
    }
    const lowered = field.toLowerCase();
    if (seen.has(lowered)) {
      return issue("behavior_redact_field", `behavior.redact_fields[${String(index)}]`, "unique");
    }
    seen.add(lowered);
  }
  return {
    submit_events: value["submit_events"],
    allow_delivery: value["allow_delivery"],
    max_payload_bytes: value["max_payload_bytes"],
    redact_fields: redactFields as string[]
  };
}

function parseLog(value: unknown): HostRuntimeConfigLog | HostRuntimeConfigIssue {
  if (!isRecord(value)) {
    return issue("log_shape", "log", "object");
  }
  const keyIssue = hasOnlyKeys(value, ["path", "level"], "log.");
  if (keyIssue !== null) {
    return keyIssue;
  }
  const missing = requiredKeys(value, ["path", "level"], "log.");
  if (missing !== null) {
    return missing;
  }
  const path = value["path"];
  if (!isNonEmptyString(path) || path.includes("\0")) {
    return issue("log_path", "log.path", "non_empty_path");
  }
  const level = value["level"];
  if (typeof level !== "string" || !(LOG_LEVELS as readonly string[]).includes(level)) {
    return issue("log_level", "log.level", "error_warn_info");
  }
  return { path, level: level as HostRuntimeLogLevel };
}

/**
 * Parses and validates a config value. Unknown fields are rejected; optional
 * `socket_path`/`token_path` are preserved only when present.
 */
export function parseHostRuntimeConfig(value: unknown): HostRuntimeConfigParseResult {
  if (!isRecord(value)) {
    return { ok: false, issue: issue("config_shape", "$", "object") };
  }
  const known = [
    "schema_version",
    "host_id",
    "host_version",
    "mode",
    "config_space",
    "adapter_id",
    "adapter_version",
    "implementation_hash",
    "registration_hash",
    "ipc",
    "behavior",
    "log",
    "created_at"
  ];
  const keyIssue = hasOnlyKeys(value, known, "");
  if (keyIssue !== null) {
    return { ok: false, issue: keyIssue };
  }
  const missing = requiredKeys(value, known.filter((key) => key !== "host_version"), "");
  if (missing !== null) {
    return { ok: false, issue: missing };
  }
  if (value["schema_version"] !== HOST_RUNTIME_CONFIG_SCHEMA_VERSION) {
    return { ok: false, issue: issue("schema_version", "schema_version", HOST_RUNTIME_CONFIG_SCHEMA_VERSION) };
  }
  const hostId = value["host_id"];
  if (typeof hostId !== "string" || !isHostId(hostId)) {
    return { ok: false, issue: issue("host_id", "host_id", "host_id") };
  }
  const hostVersion = value["host_version"];
  if (hostVersion !== undefined && !isNonEmptyString(hostVersion)) {
    return { ok: false, issue: issue("host_version", "host_version", "non_empty") };
  }
  const mode = value["mode"];
  if (typeof mode !== "string" || !isHostMode(mode)) {
    return { ok: false, issue: issue("mode", "mode", "host_mode") };
  }
  const configSpace = value["config_space"];
  if (typeof configSpace !== "string" || !CONFIG_SPACE_PATTERN.test(configSpace)) {
    return { ok: false, issue: issue("config_space", "config_space", "token") };
  }
  const adapterId = value["adapter_id"];
  if (typeof adapterId !== "string" || !isId(adapterId, "adp")) {
    return { ok: false, issue: issue("adapter_id", "adapter_id", "adp_id") };
  }
  const adapterVersion = value["adapter_version"];
  if (!isNonEmptyString(adapterVersion)) {
    return { ok: false, issue: issue("adapter_version", "adapter_version", "non_empty") };
  }
  const implementationHash = value["implementation_hash"];
  if (typeof implementationHash !== "string" || !isHash(implementationHash)) {
    return { ok: false, issue: issue("implementation_hash", "implementation_hash", "sha256") };
  }
  const registrationHash = value["registration_hash"];
  if (typeof registrationHash !== "string" || !isHash(registrationHash)) {
    return { ok: false, issue: issue("registration_hash", "registration_hash", "sha256") };
  }
  const ipc = parseIpc(value["ipc"], adapterId);
  if ("code" in ipc) {
    return { ok: false, issue: ipc };
  }
  const behavior = parseBehavior(value["behavior"]);
  if ("code" in behavior) {
    return { ok: false, issue: behavior };
  }
  const log = parseLog(value["log"]);
  if ("code" in log) {
    return { ok: false, issue: log };
  }
  const createdAt = value["created_at"];
  if (!isSafeNonNegativeInt(createdAt)) {
    return { ok: false, issue: issue("created_at", "created_at", "safe_non_negative_integer") };
  }
  return {
    ok: true,
    value: {
      schema_version: HOST_RUNTIME_CONFIG_SCHEMA_VERSION,
      host_id: hostId as HostId,
      ...(hostVersion === undefined ? {} : { host_version: hostVersion }),
      mode: mode as HostMode,
      config_space: configSpace,
      adapter_id: adapterId,
      adapter_version: adapterVersion,
      implementation_hash: implementationHash,
      registration_hash: registrationHash,
      ipc,
      behavior,
      log,
      created_at: createdAt
    }
  };
}

/** Returns the socket/token endpoints derived from config overrides or home. */
export function resolveHostRuntimeEndpoints(config: HostRuntimeConfig): HostRuntimeConfigEndpoints {
  const derived = runtimePaths(config.ipc.evoplug_home);
  return {
    evoplug_home: config.ipc.evoplug_home,
    socket_path: config.ipc.socket_path ?? derived.socket_path,
    token_path: config.ipc.token_path ?? derived.token_path
  };
}

/** `sha256(JCS(config))`; attach stores the same value as `config_hash`. */
export function computeHostRuntimeConfigHash(config: HostRuntimeConfig): Hash {
  return canonicalHash(config as unknown as JsonValue);
}

/**
 * Loads `config.json`, enforces `0600` on a regular non-symlink file, and
 * returns the parsed config with its hash and resolved endpoints.
 */
export async function loadHostRuntimeConfig(
  path: string,
  options?: LoadHostRuntimeConfigOptions
): Promise<HostRuntimeConfigReadResult> {
  const expectedMode = options?.expected_mode ?? HOST_RUNTIME_CONFIG_MODE;
  const enforceMode = options?.enforce_mode ?? true;
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    return {
      ok: false,
      issue: issue("config_unreadable", path, error instanceof Error ? error.message : String(error))
    };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, issue: issue("config_symlink", path, "regular_file") };
  }
  if (!stat.isFile()) {
    return { ok: false, issue: issue("config_not_regular_file", path, "regular_file") };
  }
  if (enforceMode && (stat.mode & 0o777) !== expectedMode) {
    return { ok: false, issue: issue("config_mode", path, expectedMode.toString(8)) };
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      issue: issue("config_unreadable", path, error instanceof Error ? error.message : String(error))
    };
  }
  if (text.length > 256 * 1024) {
    return { ok: false, issue: issue("config_too_large", path, "max_262144_chars") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, issue: issue("config_json", path, "valid_json") };
  }
  const config = parseHostRuntimeConfig(parsed);
  if (!config.ok) {
    return { ok: false, issue: config.issue };
  }
  return {
    ok: true,
    config: config.value,
    config_hash: computeHostRuntimeConfigHash(config.value),
    endpoints: resolveHostRuntimeEndpoints(config.value)
  };
}

/** Default deny prefixes used by attach when it writes `config.json`. */
export function defaultRedactFields(): readonly string[] {
  return DEFAULT_REDACT_PREFIXES;
}
