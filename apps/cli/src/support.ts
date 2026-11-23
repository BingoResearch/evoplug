/**
 * Shared CLI runtime helpers: home resolution, JSON input, error envelopes and
 * closed-value guards (DD-FND-100, DD-FND-101).
 *
 * `apps/cli` imports only `@evoplug/core` and `@evoplug/ipc` (DD-FND-021), so
 * the home layout and the endpoint files are resolved here instead of using
 * the kernel package.
 */

import { readFile, } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type ErrorEnvelope, type GrantObjectType, type Hash, type HostId, type Id, type IdPrefix, type Result, type SourceRef } from "@evoplug/core";
import { isHash, isId, isSourceRef, makeErrorEnvelope } from "@evoplug/core";
import { isValidIdempotencyKey } from "@evoplug/ipc";
import { cliFieldError } from "./errors.js";
import { isRecord as sharedIsRecord } from "@evoplug/core";

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return sharedIsRecord(value);
}

export const PRODUCT_VERSION = "0.1.0-alpha.1";export const EVOPLUG_HOME_ENV = "EVOPLUG_HOME";
export const DEFAULT_HOME_DIR_NAME = ".evoplug";
export const INIT_COMPLETE_FILE_NAME = "init.complete.json";
export const CONFIG_FILE_NAME = "config.json";
const RUNTIME_DIR_NAME = "runtime";
const ENDPOINT_FILE_NAME = "endpoint.json";
const TOKEN_FILE_NAME = "ipc.token";
const SOCKET_FILE_NAME = "kernel.sock";
export const HOME_DIR_MODE = 0o700;
export const HOME_FILE_MODE = 0o600;

export interface CliEnvironment {
  readonly [key: string]: string | undefined;
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const DEFAULT_CLI_IO: CliIo = {
  stdout: (text: string): void => {
    process.stdout.write(text);
  },
  stderr: (text: string): void => {
    process.stderr.write(text);
  }
};

/** `--home`, then `EVOPLUG_HOME`, then `~/.evoplug`; relative paths are exit-2 input. */
export function resolveCliHome(
  explicit: string | null,
  env: CliEnvironment
): Result<string, ErrorEnvelope> {
  const fromEnv = env[EVOPLUG_HOME_ENV];
  const candidate =
    explicit !== null && explicit.length > 0
      ? explicit
      : fromEnv !== undefined && fromEnv.length > 0
        ? fromEnv
        : join(homedir(), DEFAULT_HOME_DIR_NAME);
  if (!isAbsolute(candidate)) {
    return { ok: false, status: "rejected", error: cliFieldError("--home", "must_be_absolute") };
  }
  return { ok: true, status: "ok", value: candidate };
}

export function homePaths(home: string): {
  readonly config_path: string;
  readonly init_complete_path: string;
  readonly runtime_dir: string;
  readonly endpoint_path: string;
  readonly token_path: string;
  readonly socket_path: string;
} {
  const runtimeDir = join(home, RUNTIME_DIR_NAME);
  return {
    config_path: join(home, CONFIG_FILE_NAME),
    init_complete_path: join(home, INIT_COMPLETE_FILE_NAME),
    runtime_dir: runtimeDir,
    endpoint_path: join(runtimeDir, ENDPOINT_FILE_NAME),
    token_path: join(runtimeDir, TOKEN_FILE_NAME),
    socket_path: join(runtimeDir, SOCKET_FILE_NAME)
  };
}

/**
 * An uninitialized or foreign home. `expected`/`actual` stay symbolic so the
 * envelope never carries a user path.
 */
export function cliHomeIncompatibleError(actual: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_HOME_INCOMPATIBLE",
    category: "version",
    retryable: false,
    message_key: "error.e_home_incompatible",
    details: { kind: "version", expected: "initialized_home", actual },
    stage: "home_init"
  });
}

export function cliInternalError(incident: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_INTERNAL",
    category: "internal",
    retryable: false,
    message_key: "error.e_internal",
    details: { kind: "internal", incident_id: incident },
    stage: "internal"
  });
}

/** Structured `E_INTERNAL` for a command this build cannot execute. */
export function cliUnsupportedCommandError(command: string): ErrorEnvelope {
  return cliInternalError(`cli.unsupported:${command}`);
}

/** True when `init.complete.json` exists and is a JSON object. */
export async function ensureInitialized(home: string): Promise<Result<void, ErrorEnvelope>> {
  let text: string;
  try {
    text = await readFile(homePaths(home).init_complete_path, "utf8");
  } catch {
    return { ok: false, status: "rejected", error: cliHomeIncompatibleError("missing_init_complete") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: "rejected", error: cliHomeIncompatibleError("invalid_init_complete") };
  }
  if (!isRecord(parsed)) {
    return { ok: false, status: "rejected", error: cliHomeIncompatibleError("invalid_init_complete") };
  }
  return { ok: true, status: "ok", value: undefined };
}

/**
 * Reads a JSON object from a user-supplied file. Syntax and shape errors are
 * `E_SCHEMA` (exit 2); deeper validation belongs to the IPC server.
 */
export async function readJsonFile<T>(path: string): Promise<Result<T, ErrorEnvelope>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { ok: false, status: "rejected", error: cliFieldError(path, "file_not_found") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: "rejected", error: cliFieldError(path, "invalid_json") };
  }
  if (!isRecord(parsed)) {
    return { ok: false, status: "rejected", error: cliFieldError(path, "must_be_object") };
  }
  return { ok: true, status: "ok", value: parsed as T };
}

export function checkIdempotencyKey(key: string): ErrorEnvelope | null {
  return isValidIdempotencyKey(key) ? null : cliFieldError("--idempotency-key", "pattern");
}

export function asId<P extends IdPrefix>(
  value: string,
  prefix: P,
  path: string
): Result<Id<P>, ErrorEnvelope> {
  if (!isId(value, prefix)) {
    return { ok: false, status: "rejected", error: cliFieldError(path, `must_be_${prefix}_id`) };
  }
  return { ok: true, status: "ok", value };
}

export function asHash(value: string, path: string): Result<Hash, ErrorEnvelope> {
  if (!isHash(value)) {
    return { ok: false, status: "rejected", error: cliFieldError(path, "must_be_sha256_hash") };
  }
  return { ok: true, status: "ok", value };
}

export function asSourceRef(value: string, path: string): Result<SourceRef, ErrorEnvelope> {
  if (!isSourceRef(value)) {
    return { ok: false, status: "rejected", error: cliFieldError(path, "must_be_source_ref") };
  }
  return { ok: true, status: "ok", value };
}

const CLI_HOST_IDS: readonly HostId[] = [
  "pi",
  "oh-my-pi",
  "step-code",
  "codex",
  "opencode",
  "openhands-sdk",
  "claude-code"
];

export function asHostId(value: string, path: string): Result<HostId, ErrorEnvelope> {
  for (const hostId of CLI_HOST_IDS) {
    if (hostId === value) {
      return { ok: true, status: "ok", value: hostId };
    }
  }
  return { ok: false, status: "rejected", error: cliFieldError(path, "unknown_host") };
}

export function asGrantObjectType(
  value: string,
  path: string
): Result<GrantObjectType, ErrorEnvelope> {
  switch (value) {
    case "skill":
    case "memory":
    case "instructions":
    case "config":
      return { ok: true, status: "ok", value };
    default:
      return { ok: false, status: "rejected", error: cliFieldError(path, "unknown_enum") };
  }
}

export type GrantListState = "active" | "revoked" | "expired" | "consumed";

export function asGrantListState(
  value: string,
  path: string
): Result<GrantListState, ErrorEnvelope> {
  switch (value) {
    case "active":
    case "revoked":
    case "expired":
    case "consumed":
      return { ok: true, status: "ok", value };
    default:
      return { ok: false, status: "rejected", error: cliFieldError(path, "unknown_enum") };
  }
}

type InstallRevokeReason = "human_revoked" | "superseded" | "security";

export function asInstallRevokeReason(
  value: string,
  path: string
): Result<InstallRevokeReason, ErrorEnvelope> {
  switch (value) {
    case "human_revoked":
    case "superseded":
    case "security":
      return { ok: true, status: "ok", value };
    default:
      return { ok: false, status: "rejected", error: cliFieldError(path, "unknown_enum") };
  }
}

export type ReplayRevokeReason = "human_revoked" | "policy_replaced";

export function asReplayRevokeReason(
  value: string,
  path: string
): Result<ReplayRevokeReason, ErrorEnvelope> {
  switch (value) {
    case "human_revoked":
    case "policy_replaced":
      return { ok: true, status: "ok", value };
    default:
      return { ok: false, status: "rejected", error: cliFieldError(path, "unknown_enum") };
  }
}

type ForkReason = "user_fork" | "host_fork";

export function asForkReason(value: string, path: string): Result<ForkReason, ErrorEnvelope> {
  switch (value) {
    case "user_fork":
    case "host_fork":
      return { ok: true, status: "ok", value };
    default:
      return { ok: false, status: "rejected", error: cliFieldError(path, "unknown_enum") };
  }
}

/**
 * Closed feature flags this CLI build knows how to gate before IPC. The CLI
 * cannot import `@evoplug/kernel`, so the names are spelled here once; the
 * kernel owns resolution and the serving side re-checks the same flag.
 */
export const CLI_GATED_FLAGS = ["config_autotune", "active_replay"] as const;
export type CliGatedFlag = (typeof CLI_GATED_FLAGS)[number];

/** The single rejection shape for a subsystem whose flag is off. */
export function cliFeatureDisabledError(feature: CliGatedFlag): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_DISABLED",
    category: "policy",
    message_key: "error.disabled",
    stage: "feature_gate",
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path: `feature.${feature}`, rule: "feature_not_enabled" }
  });
}

/**
 * Reads the persisted `features` array. A missing or unreadable config leaves
 * the flag off: the defaults are all-off and the CLI must not guess.
 */
export async function isConfigFlagEnabled(home: string, flag: CliGatedFlag): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(homePaths(home).config_path, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed["features"])) {
      return false;
    }
    return parsed["features"].includes(flag);
  } catch {
    return false;
  }
}
