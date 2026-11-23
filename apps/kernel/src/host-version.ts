/**
 * Host version readback and compatibility ranges (closed-loop design §8, G8).
 *
 * Attach executes the host's own version command once, records the real
 * version on the host contract and injects it into the generated runtime
 * config. A failed read is recorded as `unknown`; it never falls back to the
 * declared constant.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { HostId } from "@evoplug/core/host";

/** Environment used to run a host command (appendix J.5). */
export type HostCommandEnvironment = Readonly<Record<string, string | undefined>>;

export interface HostCompatibility {
  /** Declared semver range, inclusive lower bound and exclusive upper bound. */
  readonly supported_range: string;
  /** Versions this repository has actually exercised. */
  readonly tested_versions: readonly string[];
  /** Command template used by attach to read the real version. */
  readonly version_argv: readonly string[];
  /** Function name of the host executable on PATH. */
  readonly command: string;
}

export const HOST_COMPATIBILITY: Readonly<Record<HostId, HostCompatibility>> = Object.freeze({
  pi: Object.freeze({
    supported_range: ">=1.2.0 <2.0.0",
    tested_versions: Object.freeze(["1.5.2"]),
    version_argv: Object.freeze(["--version"]),
    command: "pi"
  }),
  "oh-my-pi": Object.freeze({
    supported_range: ">=18.12.3 <19.0.0",
    tested_versions: Object.freeze(["18.12.3"]),
    version_argv: Object.freeze(["--version"]),
    command: "omp"
  }),
  "step-code": Object.freeze({
    supported_range: ">=0.1.5 <0.2.0",
    tested_versions: Object.freeze(["0.1.5"]),
    version_argv: Object.freeze(["--version"]),
    command: "step"
  }),
  codex: Object.freeze({
    supported_range: ">=0.160.1 <0.170.0",
    tested_versions: Object.freeze(["0.160.1"]),
    version_argv: Object.freeze(["--version"]),
    command: "codex"
  }),
  opencode: Object.freeze({
    supported_range: ">=2.1.4 <3.0.0",
    tested_versions: Object.freeze(["2.1.4"]),
    version_argv: Object.freeze(["--version"]),
    command: "opencode"
  }),
  "openhands-sdk": Object.freeze({
    supported_range: ">=1.56.0 <2.0.0",
    tested_versions: Object.freeze(["1.56.0"]),
    version_argv: Object.freeze([]),
    command: "python3"
  }),
  "claude-code": Object.freeze({
    supported_range: ">=2.1.304 <2.2.0",
    tested_versions: Object.freeze(["2.1.326"]),
    version_argv: Object.freeze(["--version"]),
    command: "claude"
  })
});

export interface ReadHostVersion {
  readonly host_version: string | null;
  readonly source: "command" | "unknown";
  readonly command: string | null;
}

const SEMVER = /(\d+)\.(\d+)\.(\d+)/u;

/** First semantic version in a host's version output. */
export function parseHostVersionOutput(hostId: HostId, output: string): string | null {
  const text = output.trim();
  let selected = text;
  if (hostId === "oh-my-pi") {
    // oh-my-pi prints `<runtime>/<version>`; the version is after the last `/`.
    const parts = text.split("/");
    selected = parts[parts.length - 1] ?? text;
  } else if (hostId === "codex") {
    // codex prints `<binary> <version>`; the version is the last token.
    const parts = text.split(/\s+/u);
    selected = parts[parts.length - 1] ?? text;
  } else if (hostId === "claude-code") {
    // claude prints `<version> (<label>)`; the version is the first token.
    selected = text.split(/\s+/u)[0] ?? text;
  }
  const match = SEMVER.exec(selected);
  return match === null ? null : `${match[1]}.${match[2]}.${match[3]}`;
}

/** Resolves one host command against an explicit environment's PATH. */
function resolveHostCommand(command: string, env: HostCommandEnvironment): string | null {
  if (isAbsolute(command)) return command;
  for (const directory of (env["PATH"] ?? "").split(delimiter)) {
    if (directory.length === 0 || !isAbsolute(directory)) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // next directory
    }
  }
  return null;
}

function runVersionCommand(
  hostId: HostId,
  env: HostCommandEnvironment
): string | null {
  const spec = HOST_COMPATIBILITY[hostId];
  if (hostId === "openhands-sdk") {
    const hostsDir = env["EVOPLUG_HOSTS_DIR"] ?? join(homedir(), ".local", "share", "evoplug-hosts");
    const isolated = join(hostsDir, "openhands", "bin", "python");
    const python = env["EVOPLUG_OPENHANDS_PYTHON"]
      ?? (existsSync(isolated) ? isolated : spec.command);
    const resolvedPython = resolveHostCommand(python, env);
    if (resolvedPython === null) return null;
    const result = spawnSync(
      resolvedPython,
      [
        "-I",
        "-c",
        "import importlib.metadata as m; print(m.version('openhands-sdk'))"
      ],
      { encoding: "utf8", timeout: 10_000, env }
    );
    return result.status === 0 ? parseHostVersionOutput(hostId, result.stdout) : null;
  }
  const executable = resolveHostCommand(spec.command, env);
  if (executable === null) return null;
  const result = spawnSync(executable, [...spec.version_argv], {
    encoding: "utf8",
    timeout: 10_000,
    env
  });
  if (result.status !== 0) {
    return null;
  }
  return parseHostVersionOutput(hostId, `${result.stdout}${result.stderr}`);
}

/**
 * Reads the host's real version; a missing binary or unparsable output is unknown.
 *
 * `env` is required: hosts such as OpenCode create log and state files during a
 * bare `--version` run, so the caller must pass the attach-registered host
 * environment (isolated HOME/XDG for tests) instead of inheriting process.env.
 */
export function readHostVersion(
  hostId: HostId,
  env: HostCommandEnvironment
): ReadHostVersion {
  const spec = HOST_COMPATIBILITY[hostId];
  const version = runVersionCommand(hostId, env);
  const command = hostId === "openhands-sdk"
    ? `${env["EVOPLUG_OPENHANDS_PYTHON"] ?? join(env["EVOPLUG_HOSTS_DIR"] ?? join(homedir(), ".local", "share", "evoplug-hosts"), "openhands", "bin", "python")} -I -c importlib.metadata`
    : `${spec.command} ${spec.version_argv.join(" ")}`.trim();
  return {
    host_version: version,
    source: version === null ? "unknown" : "command",
    command
  };
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

function parseTuple(value: string): number[] | null {
  const match = SEMVER.exec(value);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Evaluates the closed range subset this product uses
 * (`>=x.y.z <a.b.c`). A malformed range or version is unsupported.
 */
export function isVersionInRange(version: string | null, range: string): boolean {
  if (version === null) {
    return false;
  }
  const versionTuple = parseTuple(version);
  if (versionTuple === null) {
    return false;
  }
  const match = /^>=\s*([0-9.]+)\s*<\s*([0-9.]+)$/u.exec(range.trim());
  if (match === null) {
    return false;
  }
  const lower = parseTuple(match[1] as string);
  const upper = parseTuple(match[2] as string);
  if (lower === null || upper === null) {
    return false;
  }
  return compare(versionTuple, lower) >= 0 && compare(versionTuple, upper) < 0;
}
