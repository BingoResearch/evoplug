/**
 * Server-plugin side of the OpenCode TUI confirmation bridge (appendix O.1).
 *
 * OpenCode 2.1.4 loads plugins into a headless `serve --stdio` child, so the
 * server plugin cannot render a dialog. Attach installs a sibling TUI plugin
 * (`<config>/opencode/evoplug-tui/tui.js`) and registers it in `tui.json`.
 * This module writes one request file per prompt and waits for the TUI's
 * response file. The server plugin then reports the answer through the normal
 * runtime `reportResult` channel, so the kernel sees one channel end to end.
 *
 * Every failure is a non-answer: a missing directory, an unreadable response
 * or an aborted wait becomes `unknown`/`unsupported`, never a confirmation.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { askHumanWithEarlyKeyGuard } from "@evoplug/host-runtime";

export type TuiConfirmState = "confirmed" | "not_confirmed" | "unsupported" | "unknown";
export type TuiChoice = "adopt" | "incomplete" | "reject" | "unsupported" | "unknown";

export interface TuiConfirmPrompt {
  readonly title: string;
  readonly message: string;
  readonly signal: AbortSignal;
}

export interface TuiChoicePrompt extends TuiConfirmPrompt {
  readonly options: readonly string[];
  readonly codes?: readonly TuiChoice[];
}

export interface OpenCodeTuiBridge {
  readonly directory: string;
  confirm(prompt: TuiConfirmPrompt): Promise<TuiConfirmState>;
  choose(prompt: TuiChoicePrompt): Promise<TuiChoice>;
}

export interface OpenCodeTuiBridgeOptions {
  /** Overrides the directory derived from the artifact root (tests). */
  readonly directory?: string;
  /** Poll interval for the response file; default 100 ms. */
  readonly poll_ms?: number;
  /** Request lifetime recorded in the file; default 10 minutes. */
  readonly max_wait_ms?: number;
  /** Monotonic clock for the early-key rule; tests inject it. */
  readonly clock?: () => number;
}

const REQUEST_SCHEMA = "rsi.opencode_tui_request/1";
const ENTRY_NAME = "tui.js";
export const OPENCODE_TUI_HEARTBEAT_FILE = ".evoplug-tui-heartbeat.json";

export interface OpenCodeTuiHeartbeat {
  readonly pid: number;
  readonly at: number;
}

/**
 * Reads the TUI-side liveness heartbeat. A resident service plugin must not
 * keep the host session alive after its TUI exits, so the session pid is the
 * heartbeat writer's pid, and a beat older than the freshness window is
 * ignored. Non-interactive `opencode run` has no TUI plugin and therefore no
 * heartbeat; it keeps its own process pid.
 */
export function readOpenCodeTuiHeartbeat(
  root: string,
  options: { readonly now?: number; readonly max_age_ms?: number; readonly directory?: string } = {}
): OpenCodeTuiHeartbeat | null {
  const directory = options.directory ?? openCodeTuiDirectory(root);
  const path = join(directory, OPENCODE_TUI_HEARTBEAT_FILE);
  const now = options.now ?? Date.now();
  const maxAge = options.max_age_ms ?? 15_000;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; at?: unknown };
    if (
      typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 ||
      typeof parsed.at !== "number" || !Number.isSafeInteger(parsed.at)
    ) {
      return null;
    }
    if (now - parsed.at > maxAge || parsed.at > now + 5_000) return null;
    return { pid: parsed.pid, at: parsed.at };
  } catch {
    return null;
  }
}

let sequence = 0;

function requestId(): string {
  sequence += 1;
  return `${process.pid.toString(36)}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already removed by the TUI or another waiter.
  }
}

/**
 * Resolves the companion directory next to the installed server artifact:
 * `<config>/opencode/plugin` -> `<config>/opencode/evoplug-tui`.
 */
export function openCodeTuiDirectory(root: string): string {
  const override = process.env["EVOPLUG_OPENCODE_TUI_DIR"];
  if (typeof override === "string" && override.length > 0) return override;
  return join(dirname(root), "evoplug-tui");
}

/** Creates the bridge when the companion entry is installed; otherwise null. */
export function createOpenCodeTuiBridge(
  root: string,
  options: OpenCodeTuiBridgeOptions = {}
): OpenCodeTuiBridge | null {
  const directory = options.directory ?? openCodeTuiDirectory(root);
  if (!existsSync(join(directory, ENTRY_NAME))) return null;
  const pollMs = options.poll_ms === undefined ? 100 : Math.max(10, options.poll_ms);
  const maxWaitMs = options.max_wait_ms === undefined ? 600_000 : Math.max(1_000, options.max_wait_ms);
  const answerClock = options.clock;

  const ask = async (
    kind: "confirm" | "select",
    title: string,
    message: string,
    optionsList: readonly { readonly value: string; readonly label: string }[],
    signal: AbortSignal
  ): Promise<string> => {
    if (signal.aborted) return "unknown";
    const id = requestId();
    const requestPath = join(directory, `.evoplug-request-${id}.json`);
    const responsePath = join(directory, `.evoplug-response-${id}.json`);
    const now = Date.now();
    const request = {
      schema_version: REQUEST_SCHEMA,
      request_id: id,
      kind,
      title,
      message,
      ...(kind === "select" ? { options: optionsList } : {}),
      created_at: now,
      deadline_at: now + maxWaitMs
    };
    try {
      writeFileSync(requestPath, JSON.stringify(request), { flag: "wx", mode: 0o600 });
    } catch {
      return "unsupported";
    }
    try {
      while (!signal.aborted) {
        if (existsSync(responsePath)) {
          try {
            const parsed = JSON.parse(readFileSync(responsePath, "utf8")) as {
              request_id?: unknown;
              answer?: unknown;
            };
            if (parsed.request_id === id && typeof parsed.answer === "string") {
              return parsed.answer;
            }
          } catch {
            // A half-written response is retried on the next tick.
          }
        }
        await sleep(pollMs);
      }
      return "unknown";
    } finally {
      removeQuietly(requestPath);
      removeQuietly(responsePath);
    }
  };

  return {
    directory,
    async confirm(prompt) {
      // This bridge bypasses the shared host-runtime adapters, so the
      // early-key rule is applied here as well: an answer that arrives before
      // the TUI could have drawn the request is a queued key, not a decision.
      return askHumanWithEarlyKeyGuard(
        async () => {
          const answer = await ask("confirm", prompt.title, prompt.message, [], prompt.signal);
          return answer === "confirmed" || answer === "not_confirmed"
            ? (answer as TuiConfirmState)
            : ("unknown" as const);
        },
        {
          clock: answerClock,
          isAnswer: (state) => state === "confirmed" || state === "not_confirmed",
          noDecision: "unknown"
        }
      );
    },
    async choose(prompt) {
      const codes = prompt.codes ?? prompt.options.map((_, index) => index === 0 ? "adopt" : index === 1 ? "reject" : "unknown");
      return askHumanWithEarlyKeyGuard(
        async () => {
          const answer = await ask(
            "select",
            prompt.message.length === 0 ? prompt.title : `${prompt.title}\n\n${prompt.message}`,
            prompt.message,
            prompt.options.map((label, index) => ({
              value: codes[index] ?? "unknown",
              label
            })),
            prompt.signal
          );
          return answer === "adopt" || answer === "incomplete" || answer === "reject"
            ? (answer as TuiChoice)
            : ("unknown" as const);
        },
        {
          clock: answerClock,
          isAnswer: (choice) =>
            choice === "adopt" || choice === "incomplete" || choice === "reject",
          noDecision: "unknown"
        }
      );
    }
  };
}
