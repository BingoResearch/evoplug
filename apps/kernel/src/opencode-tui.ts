/**
 * OpenCode TUI confirmation companion (closure design appendix O.1).
 *
 * OpenCode 2.1.4 splits the plugin surface in two: the server plugin runs in a
 * headless `serve --stdio` child and has no UI, while the TUI process exposes
 * `ctx.ui.dialog.confirm/select` to a "V2" plugin whose default export has an
 * `id` and a `setup(ctx)` function. Attach therefore installs a second, tiny
 * plugin next to the server plugin and registers it in `tui.json`.
 *
 * The TUI plugin never talks to the kernel. The server plugin owns the single
 * runtime poll/result channel and hands each confirmation prompt to the TUI
 * through a request/response file pair in this directory. The answer travels
 * back to the kernel through the server plugin's `reportResult`, so the proof
 * records `mechanism=opencode_tui_dialog` on the same channel as every other
 * runtime decision.
 *
 * The file must stay outside the server artifact root: the runtime verifies
 * that the artifact directory contains exactly the manifest's files.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openCodeConfigRoot } from "./opencode-mirror.js";

/** Relative name of the TUI plugin directory below the OpenCode config root. */
export const OPENCODE_TUI_DIR_NAME = "evoplug-tui";

/** Entry file name inside the TUI plugin directory (`Zk` resolves `tui`). */
export const OPENCODE_TUI_ENTRY_NAME = "tui.js";

export interface OpenCodeTuiPaths {
  readonly base: string;
  readonly directory: string;
  readonly entry: string;
  readonly config: string;
}

/** Paths for one config space; `null` when the caller environment is unknown. */
export function openCodeTuiPaths(
  configSpace: string,
  env: Readonly<Record<string, string | undefined>>
): OpenCodeTuiPaths | null {
  let base: string | null = null;
  if (configSpace === "user") {
    const root = openCodeConfigRoot(env);
    base = root === null ? null : join(root, "opencode");
  } else if (configSpace === "project") {
    base = join(process.cwd(), ".opencode");
  }
  if (base === null) return null;
  const directory = join(base, OPENCODE_TUI_DIR_NAME);
  return {
    base,
    directory,
    entry: join(directory, OPENCODE_TUI_ENTRY_NAME),
    config: join(base, "tui.json")
  };
}

/**
 * The V2 TUI plugin. Watches its own directory for `.evoplug-request-*.json`
 * and answers one dialog at a time. Answers are written atomically with
 * `wx`, so two TUI windows cannot both claim a request.
 */
const TUI_PLUGIN_SOURCE = String.raw`import { readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REQUEST = /^\.evoplug-request-([A-Za-z0-9-]+)\.json$/;
const HEARTBEAT = ".evoplug-tui-heartbeat.json";
const answered = new Set();
const queue = [];
let draining = false;
let timer = null;
let heartbeatTimer = null;

function beat() {
  try {
    writeFileSync(join(here, HEARTBEAT), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
  } catch {
    // A missing heartbeat only makes the session look dead; it is never faked.
  }
}

function responsePath(id) {
  return join(here, ".evoplug-response-" + id + ".json");
}

function settle(id, answer) {
  const target = responsePath(id);
  try {
    writeFileSync(target, JSON.stringify({ request_id: id, answer }), { flag: "wx", mode: 0o600 });
  } catch {
    // Another window already answered, or the server plugin timed out.
  }
  try {
    unlinkSync(join(here, ".evoplug-request-" + id + ".json"));
  } catch {
    // The server plugin cleans up on timeout.
  }
}

async function ask(ctx, request) {
  if (request.kind === "confirm") {
    const answer = await ctx.ui.dialog.confirm({ title: request.title, message: request.message });
    return answer === true ? "confirmed" : answer === false ? "not_confirmed" : "unknown";
  }
  if (request.kind === "select") {
    const options = Array.isArray(request.options) ? request.options : [];
    const answer = await ctx.ui.dialog.select({
      title: request.title,
      options: options.map((entry) => ({
        title: typeof entry.label === "string" ? entry.label : String(entry.value),
        value: entry.value,
        ...(typeof entry.description === "string" ? { description: entry.description } : {})
      }))
    });
    const value =
      answer !== null && typeof answer === "object" && "value" in answer
        ? answer.value
        : answer;
    return typeof value === "string" ? value : "unknown";
  }
  return "unsupported";
}

async function drain(ctx) {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      let answer = "unknown";
      try {
        answer = await ask(ctx, job.request);
      } catch {
        answer = "unknown";
      }
      settle(job.id, answer);
    }
  } finally {
    draining = false;
  }
}

// The TUI process owns the session lease. Writing the first heartbeat at module
// load lets the server plugin bind the right pid instead of waiting for setup,
// which can run after the server plugin in a TUI-managed service.
beat();

export default {
  id: "evoplug-tui-confirm",
  async setup(ctx) {
    if (ctx === null || typeof ctx !== "object") return;
    if (!ctx.ui || !ctx.ui.dialog || typeof ctx.ui.dialog.confirm !== "function") return;
    beat();
    heartbeatTimer = setInterval(beat, 5000);
    timer = setInterval(() => {
      let names = [];
      try {
        names = readdirSync(here);
      } catch {
        return;
      }
      for (const name of names) {
        const match = REQUEST.exec(name);
        if (match === null || answered.has(match[1])) continue;
        answered.add(match[1]);
        let request;
        try {
          request = JSON.parse(readFileSync(join(here, name), "utf8"));
        } catch {
          continue;
        }
        if (
          request === null ||
          typeof request !== "object" ||
          typeof request.request_id !== "string"
        ) {
          continue;
        }
        if (typeof request.deadline_at === "number" && Date.now() >= request.deadline_at) {
          settle(match[1], "unknown");
          continue;
        }
        queue.push({ id: match[1], request });
      }
      void drain(ctx);
    }, 150);
    return () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      try {
        unlinkSync(join(here, HEARTBEAT));
      } catch {
        // Already removed.
      }
    };
  }
};
`;

/**
 * Installs the TUI plugin file and adds its directory to `tui.json`.
 *
 * `tui.json` is the user's file: every key except `plugin` is preserved byte
 * for byte at the JSON value level, and an unparseable file is left untouched
 * instead of being replaced. A failure is reported to attach so the user sees
 * that native confirmation is unavailable rather than a silent degradation.
 */
export function installOpenCodeTuiPlugin(
  configSpace: string,
  env: Readonly<Record<string, string | undefined>>
): { readonly ok: boolean; readonly path?: string; readonly reason?: string } {
  const paths = openCodeTuiPaths(configSpace, env);
  if (paths === null) {
    return { ok: false, reason: "config_root_unknown" };
  }
  try {
    mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    writeFileSync(paths.entry, TUI_PLUGIN_SOURCE, { mode: 0o644 });
    chmodSync(paths.entry, 0o644);
  } catch (error) {
    return { ok: false, reason: `tui_plugin_write_failed:${error instanceof Error ? error.message : String(error)}` };
  }
  let document: Record<string, unknown> = {};
  if (existsSync(paths.config)) {
    try {
      const parsed = JSON.parse(readFileSync(paths.config, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "tui_config_not_object" };
      }
      document = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "tui_config_invalid_json" };
    }
  }
  const plugin = Array.isArray(document["plugin"]) ? [...(document["plugin"] as unknown[])] : [];
  const entry = paths.directory;
  const present = plugin.some((value) => value === entry);
  if (!present) {
    plugin.push(entry);
    document["plugin"] = plugin;
    try {
      writeFileSync(paths.config, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 });
    } catch (error) {
      return { ok: false, reason: `tui_config_write_failed:${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: true, path: paths.directory };
}

/** Removes the entry added by attach, then the companion directory. */
export function removeOpenCodeTuiPlugin(
  configSpace: string,
  env: Readonly<Record<string, string | undefined>>
): void {
  const paths = openCodeTuiPaths(configSpace, env);
  if (paths === null) return;
  try {
    if (existsSync(paths.config)) {
      const parsed = JSON.parse(readFileSync(paths.config, "utf8")) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const document = parsed as Record<string, unknown>;
        const plugin = document["plugin"];
        if (Array.isArray(plugin)) {
          const next = plugin.filter((value) => value !== paths.directory);
          if (next.length !== plugin.length) {
            document["plugin"] = next;
            writeFileSync(paths.config, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 });
          }
        }
      }
    }
  } catch {
    // Outside our ownership; leave the user's file untouched.
  }
  rmSync(paths.directory, { recursive: true, force: true });
}

/** True when the installed TUI companion can render dialogs. */
export function openCodeTuiInstalled(
  configSpace: string,
  env: Readonly<Record<string, string | undefined>>
): boolean {
  const paths = openCodeTuiPaths(configSpace, env);
  return paths !== null && existsSync(paths.entry);
}
