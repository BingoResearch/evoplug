/**
 * Interactive-session detection for the confirmation channel (design §5.1).
 *
 * A stdio MCP server inherits pipes, not the host TUI, and neither host passes
 * a session-mode variable to MCP children. The one fact both hosts expose is
 * their own command line: the parent process is the host binary, and a
 * non-interactive invocation carries `-p` (Claude Code) or a subcommand such as
 * `exec` (Codex). This module reads that command line and answers a single
 * question: may the channel ask the user anything at all?
 *
 * It fails closed. An unreadable parent, an unknown host or an unrecognized
 * invocation is not interactive, and the candidate or capability stays
 * unknown instead of opening a dialog in a headless run.
 */

import { execFileSync } from "node:child_process";

export type HostInvocation = "interactive" | "non_interactive" | "unknown";

/** Codex subcommands that never host a TUI. */
const CODEX_NON_INTERACTIVE_SUBCOMMANDS: readonly string[] = Object.freeze([
  "app-server",
  "exec-server",
  "exec",
  "review",
  "mcp",
  "plugin",
  "doctor",
  "sandbox",
  "apply",
  "completion",
  "update",
  "features",
  "migrate-rollouts",
  "archive",
  "delete",
  "unarchive",
  "queue",
  "cloud",
  "debug"
]);

/** Codex options whose next token is a value, not a subcommand. */
const CODEX_VALUE_OPTIONS: readonly string[] = Object.freeze([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "-i",
  "--image",
  "-m",
  "--model",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-a",
  "--ask-for-approval",
  "-C",
  "--cd",
  "--add-dir",
  "--remote",
  "--remote-auth-token-env",
  "--local-provider"
]);

function tokens(commandLine: string): string[] {
  // The command line is only used to find flags and the first subcommand, so a
  // whitespace split is sufficient; quoted prompts are never inspected.
  return commandLine
    .trim()
    .split(/\s+/u)
    .map((token) => token.replace(/^['"]|['"]$/gu, ""))
    .filter((token) => token.length > 0);
}

function executableName(token: string | undefined): string {
  if (token === undefined) return "";
  const parts = token.split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * Finds the host executable through wrappers (`/bin/sh /path/claude ...`) and
 * returns the arguments after it. A busybox-style wrapper is common in SDK and
 * desktop integrations, so argv[0] alone is not enough.
 */
function hostTokens(host_id: string, argv: readonly string[]): string[] | null {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    const exe = executableName(token);
    if (host_id === "claude-code" && exe.startsWith("claude")) return argv.slice(index + 1);
    if (host_id === "codex" && exe === "codex") return argv.slice(index + 1);
    if (host_id === "opencode" && exe === "opencode") return argv.slice(index + 1);
  }
  return null;
}

/** Classifies one host command line. Pure; used directly by tests. */
export function classifyHostInvocation(host_id: string, argv: readonly string[]): HostInvocation {
  if (argv.length === 0) return "unknown";
  const rest = hostTokens(host_id, argv);
  if (rest === null) return "unknown";
  if (host_id === "claude-code") {
    if (rest.includes("--version") || rest.includes("-v") || rest.includes("--help") || rest.includes("-h")) {
      return "non_interactive";
    }
    // `-p` / `--print` is the only headless entry; `--print` may be spelled
    // `-p<value>`? Claude Code takes no value, so an exact match is correct.
    if (rest.includes("-p") || rest.includes("--print")) return "non_interactive";
    return "interactive";
  }
  if (host_id === "codex") {
    if (rest.includes("--help") || rest.includes("-h") || rest.includes("--version") || rest.includes("-V")) {
      return "non_interactive";
    }
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === undefined) break;
      // `--` ends option parsing; everything after it is a prompt.
      if (token === "--") return "interactive";
      if (CODEX_VALUE_OPTIONS.includes(token)) {
        index += 1;
        continue;
      }
      if (token.startsWith("-")) continue;
      // First positional: a known subcommand means a non-TUI mode; anything
      // else is the optional initial prompt of the TUI.
      return CODEX_NON_INTERACTIVE_SUBCOMMANDS.includes(token) ? "non_interactive" : "interactive";
    }
    return "interactive";
  }
  if (host_id === "opencode") {
    // `opencode` without a subcommand is the TUI. The plugin runs inside a
    // `serve --stdio` child of that TUI, so `serve` stays unknown and the
    // parent walk reaches the interactive invocation. Print/server
    // subcommands are classified directly.
    const valueOptions = new Set(["--session", "-s", "--server", "--prompt"]);
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === undefined) break;
      if (token === "--") return "interactive";
      if (valueOptions.has(token)) {
        index += 1;
        continue;
      }
      if (token.startsWith("-")) continue;
      if (token === "serve") return "unknown";
      if (token === "run" || token === "acp") return "non_interactive";
      return "interactive";
    }
    return "interactive";
  }
  return "unknown";
}

/** Reads the parent pid. Returns null when `ps` cannot answer. */
export function readParentPid(pid: number): number | null {
  try {
    const output = execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000
    });
    const value = Number(output.trim());
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Reads a process command line. Returns null when `ps` cannot answer. */
export function readProcessCommandLine(pid: number): string | null {
  try {
    const output = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000
    });
    const line = output.trim();
    return line.length === 0 ? null : line;
  } catch {
    return null;
  }
}

/**
 * True only when the host process that launched this MCP server is in an
 * interactive mode. `command_line` overrides `ps` for tests and for hosts that
 * already know their parent invocation.
 */
export function detectInteractiveHostSession(
  host_id: string,
  options: {
    readonly ppid?: number;
    readonly command_line?: string | null;
    readonly read?: (pid: number) => string | null;
    readonly read_parent?: (pid: number) => number | null;
  } = {}
): boolean {
  if (options.command_line !== undefined) {
    return options.command_line !== null &&
      classifyHostInvocation(host_id, tokens(options.command_line)) === "interactive";
  }
  const read = options.read ?? readProcessCommandLine;
  const readParent = options.read_parent ?? readParentPid;
  let pid = options.ppid ?? process.ppid;
  // Command hooks run through a shell and, for Codex, through an intermediate
  // hook runner. Walk up to the host process instead of trusting one level.
  for (let depth = 0; depth < 6; depth += 1) {
    const line = read(pid);
    if (line !== null) {
      const verdict = classifyHostInvocation(host_id, tokens(line));
      if (verdict !== "unknown") return verdict === "interactive";
    }
    const parent = readParent(pid);
    if (parent === null || parent <= 1) return false;
    pid = parent;
  }
  return false;
}
