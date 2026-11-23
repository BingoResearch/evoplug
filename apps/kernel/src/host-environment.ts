/**
 * Attach-registered host environment (closed-loop appendix J.5).
 *
 * The kernel executes host commands (version readback, generation probe, review
 * generation) with the environment the host was attached with, never with the
 * long-lived kernel process's own environment. Without this a Pi/Step/Codex CLI
 * started by `serve` inherits the user's real `HOME` and writes telemetry or
 * logs into the user's host directories.
 *
 * Only path and locale variables are persisted. Credentials are never copied:
 * callers merge the configured credential environment variable in memory for
 * the duration of one child process, exactly like the formal generation path.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalJsonText, type JsonValue } from "@evoplug/core";
import { mergeGenerationConfig } from "@evoplug/adapter-opencode";

export type HostEnvironment = Readonly<Record<string, string | undefined>>;

export const HOST_ENVIRONMENT_SCHEMA = "rsi.host_environment/1";

/**
 * Variables a host CLI uses to locate its own configuration, workspace and
 * temporary files. A value is persisted verbatim and only when present.
 */
export const HOST_ENV_KEYS: readonly string[] = Object.freeze([
  "HOME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PI_CODING_AGENT_DIR",
  "PI_PROFILE",
  "OMP_PROFILE",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "STEP_CODING_AGENT_DIR",
  "OH_PERSISTENCE_DIR",
  "OPENHANDS_SETTINGS",
  "EVOPLUG_HOSTS_DIR",
  "EVOPLUG_OPENHANDS_PYTHON",
  "EVOPLUG_GENERATION_WORKSPACE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_OPTIONS",
  // OpenCode's generation probe runs the raw CLI spec (`--agent
  // evoplug-generation`) with this registered environment and never through
  // the generation adapter that adds the inline agent definition. Registering
  // the merged inline config here lets the probe resolve the agent.
  "OPENCODE_CONFIG_CONTENT"
]);

/** Deterministic, secret-free snapshot of one caller environment. */
export function snapshotHostEnvironment(
  env: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const key of HOST_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

/** Directory that carries the per-host environment registrations. */
export function hostEnvironmentDir(home: string): string {
  return join(home, "host-environment");
}

function hostEnvironmentPath(home: string, host_id: string): string {
  // Host ids are lowercase, hyphenated slugs; reject anything else so the
  // path never escapes the directory.
  if (!/^[a-z0-9-]+$/u.test(host_id)) {
    throw new Error(`invalid host id: ${host_id}`);
  }
  return join(hostEnvironmentDir(home), `${host_id}.json`);
}

/**
 * Persists one attach caller's environment. The file is created with mode 0600
 * and replaced atomically; the value set is already free of secrets.
 */
export function persistHostEnvironment(input: {
  readonly home: string;
  readonly host_id: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: number;
}): Record<string, string> {
  const env = snapshotHostEnvironment(input.env);
  if (input.host_id === "opencode") {
    env["OPENCODE_CONFIG_CONTENT"] = mergeGenerationConfig(input.env["OPENCODE_CONFIG_CONTENT"]);
  }
  const document = {
    schema_version: HOST_ENVIRONMENT_SCHEMA,
    host_id: input.host_id,
    captured_at: input.now,
    env
  };
  const directory = hostEnvironmentDir(input.home);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = hostEnvironmentPath(input.home, input.host_id);
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, canonicalJsonText(document as unknown as JsonValue), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return env;
}

/**
 * Returns the registered environment, or `null` when the host was never
 * attached from a caller that could provide one. Callers must fail closed
 * (`host_env_unregistered`) instead of falling back to `process.env`.
 */
export function loadHostEnvironment(
  home: string,
  host_id: string
): Record<string, string> | null {
  let path: string;
  try {
    path = hostEnvironmentPath(home, host_id);
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record["schema_version"] !== HOST_ENVIRONMENT_SCHEMA) return null;
  const env = record["env"];
  if (typeof env !== "object" || env === null || Array.isArray(env)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value === "string" && HOST_ENV_KEYS.includes(key)) out[key] = value;
  }
  return out;
}

/**
 * Merges one credential environment variable from the process that owns the
 * secret into a copy of the registered environment. The persisted snapshot
 * never contains it.
 */
export function withCredentialEnv(
  env: HostEnvironment,
  credential_env: string | undefined,
  source: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") merged[key] = value;
  }
  if (credential_env !== undefined && credential_env.length > 0) {
    const secret = source[credential_env];
    if (typeof secret === "string" && secret.length > 0) merged[credential_env] = secret;
  }
  return merged;
}

/** Removes the registration for one host; detach uses it to stop reuse. */
export function clearHostEnvironment(home: string, host_id: string): void {
  let path: string;
  try {
    path = hostEnvironmentPath(home, host_id);
  } catch {
    return;
  }
  rmSync(path, { force: true });
}
