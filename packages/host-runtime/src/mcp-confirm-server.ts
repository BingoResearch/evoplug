/**
 * Stdio MCP confirmation server (closure design §5, appendix K.2 mechanism 2).
 *
 * The adapter registers this process as an MCP server in the host's own
 * configuration. The host renders `elicitation/create` with its native form and
 * returns the user's click to this process; the model neither sees the form nor
 * can answer it. One host-native decision travels to the kernel as a
 * `confirm_human_setup` / `confirm_candidate` runtime probe answer carrying
 * `mechanism=mcp_elicitation` and the channel binding (MCP server name, the
 * authenticated runtime session id, and the elicitation request id).
 *
 * Fail-closed rules:
 *
 * - a non-interactive attach (`mode != interactive`) never asks and never
 *   connects to the kernel; the tool answers `not processed`;
 * - a host version outside the adapter's verified range is treated the same
 *   way: the capability stays `unknown` instead of being guessed;
 * - if the host does not advertise the elicitation form capability, the
 *   request is reported `unsupported`;
 * - any dialog error, dismissal or timeout is `unknown` and leaves the
 *   candidate pending or the capability unknown.
 */

import { appendFileSync } from "node:fs";

import { existsSync } from "node:fs";
import { join } from "node:path";

import { hashUtf8, type Hash, type JsonValue } from "@evoplug/core";
import { MCP_CONFIRM_POLL_EVENT } from "@evoplug/core/host";
import type { RuntimeCall } from "@evoplug/core/host";
import type { HostId } from "@evoplug/core/host";

import type { HostRuntimeConfig } from "./artifact.js";
import {
  createMcpConfirmProtocol,
  MCP_CONFIRM_TOOL_NAME,
  type McpConfirmProtocol,
  type McpElicitationOutcome,
  type McpElicitationRequest
} from "./mcp-confirm-protocol.js";
import { detectInteractiveHostSession } from "./mcp-confirm-session.js";
import type { HostRuntime } from "./runtime.js";
import { startHostRuntime } from "./runtime.js";
import { handleRuntimeCall } from "./runtime-probe.js";
import {
  handleSessionConfirmationCall,
  type SessionConfirmationOptions
} from "./runtime-session-confirmation.js";
import {
  defaultMonotonicClock,
  NATIVE_CONFIRMATION_MIN_ANSWER_MS,
  type MonotonicClock,
  type NativeChoice
} from "./runtime-confirmation.js";

/** Mechanism name recorded in every proof produced by this channel. */
export const MCP_ELICITATION_MECHANISM = "mcp_elicitation" as const;

/** Hook event used only as the poll key of this channel; not a host event. */
const CONFIRM_HOOK_EVENT = MCP_CONFIRM_POLL_EVENT;

const DEFAULT_IDLE_POLL_MS = 5_000;

export interface McpConfirmHostSpec {
  readonly host_id: HostId;
  /** MCP server name as registered in the host configuration. */
  readonly server_name: string;
  /** Mechanism name recorded in every proof minted from this channel. */
  readonly mechanism: "mcp_elicitation";
  /** Verified compatibility range, e.g. `>=2.1.304 <2.2.0`. */
  readonly supported_range: string;
  /** Input-family host event used only for diagnostic carrier uploads. */
  readonly carrier_event: string;
}

export interface McpConfirmServerOptions {
  readonly artifact_root: string;
  readonly config: HostRuntimeConfig;
  readonly host: McpConfirmHostSpec;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly now?: () => number;
  /** Monotonic clock for the early-key rule; tests inject it. */
  readonly clock?: MonotonicClock;
  readonly log_path?: string;
  readonly idle_poll_ms?: number;
  readonly elicitation_timeout_ms?: number;
  /**
   * Whether the host process that launched this server is interactive.
   * Defaults to the parent-command-line probe; tests pass it explicitly.
   */
  readonly interactive_session?: boolean;
}

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseVersion(value: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value.trim());
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return { major, minor, patch };
}

function compare(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Evaluates the closed range form used by adapter manifests
 * (`>=a.b.c <d.e.f`, either bound optional). Anything it cannot parse is
 * outside the range: an unreadable version must not enable a confirmation.
 */
/** Candidate decision field. Deliberately has no default value. */
export function candidateDecisionSchema(options: readonly string[]): Record<string, unknown> {
  return {
    type: "string",
    title: options.join(" / "),
    enum: [...options],
    enumNames: [...options]
    // No default: accepting the form without choosing a value must stay
    // undecided, never become the first option.
  };
}

export function hostVersionInRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (parsed === null) return false;
  const bounds = range.trim().split(/\s+/u).filter((part) => part.length > 0);
  if (bounds.length === 0) return false;
  for (const bound of bounds) {
    const match = /^(>=|<=|>|<|=)(.+)$/u.exec(bound);
    if (match === null) return false;
    const other = parseVersion(match[2] ?? "");
    if (other === null) return false;
    const order = compare(parsed, other);
    const operator = match[1];
    if (operator === ">=" && order < 0) return false;
    if (operator === ">" && order <= 0) return false;
    if (operator === "<=" && order > 0) return false;
    if (operator === "<" && order >= 0) return false;
    if (operator === "=" && order !== 0) return false;
  }
  return true;
}

/**
 * A test-mode home keeps the channel diagnostics next to its own database.
 * Production homes stay silent unless the operator names a log path.
 */
function defaultLogPath(): string | null {
  const explicit = process.env["EVOPLUG_MCP_CONFIRM_LOG"];
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const home = process.env["EVOPLUG_HOME"];
  if (typeof home !== "string" || home.length === 0) return null;
  try {
    return existsSync(join(home, "test-mode.json")) ? join(home, "mcp-confirm.jsonl") : null;
  } catch {
    return null;
  }
}

function jsonLog(path: string | null): (entry: Record<string, JsonValue>) => void {
  if (path === null) return () => undefined;
  return (entry) => {
    try {
      appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
    } catch {
      // Logging never changes the decision.
    }
  };
}

function channelSessionId(hostId: HostId, now: number): string {
  return `mcp-confirm:${hostId}:${String(process.pid)}:${String(now)}`;
}

/**
 * The three independent gates that decide whether the channel may ask at all:
 * attach registered an interactive mode, the host process really is a TUI, and
 * the version is inside the adapter's verified range.
 */
export function confirmationAskable(input: {
  readonly mode: string;
  readonly host_interactive: boolean;
  readonly host_version: string;
  readonly supported_range: string;
}): boolean {
  return (
    input.mode === "interactive" &&
    input.host_interactive &&
    hostVersionInRange(input.host_version, input.supported_range)
  );
}

/**
 * Elicits one answer and applies the early-key rule to the MCP channel: the
 * timer starts when the request is sent and stops when the host returns its
 * answer. A first answer inside the threshold is dropped and the same form is
 * sent once more; a second early answer is no decision. Outcomes that are not
 * a human answer (timeout, unsupported, dismissal) are returned unchanged.
 */
export interface ElicitedHumanAnswer<T> {
  readonly value: T;
  readonly outcome: McpElicitationOutcome;
}

export async function elicitWithEarlyKeyGuard<T>(input: {
  readonly elicit: (request: McpElicitationRequest) => Promise<McpElicitationOutcome>;
  readonly request: McpElicitationRequest;
  readonly map: (outcome: McpElicitationOutcome) => T;
  readonly isAnswer: (value: T) => boolean;
  readonly noDecision: T;
  readonly clock?: MonotonicClock;
}): Promise<ElicitedHumanAnswer<T>> {
  const clock = input.clock ?? defaultMonotonicClock;
  const once = async (): Promise<{
    readonly value: T;
    readonly outcome: McpElicitationOutcome;
    readonly premature: boolean;
  }> => {
    const started = clock();
    const outcome = await input.elicit(input.request);
    const premature = clock() - started < NATIVE_CONFIRMATION_MIN_ANSWER_MS;
    return { value: input.map(outcome), outcome, premature };
  };
  const first = await once();
  if (!first.premature || !input.isAnswer(first.value)) {
    return { value: first.value, outcome: first.outcome };
  }
  const second = await once();
  if (!second.premature || !input.isAnswer(second.value)) {
    return { value: second.value, outcome: second.outcome };
  }
  return { value: input.noDecision, outcome: second.outcome };
}

/**
 * Runs the confirmation channel until the host closes stdin.
 *
 * The channel never throws to the host: every failure ends in `not processed`
 * so the model cannot turn a broken channel into a decision.
 */
export async function runMcpConfirmServer(options: McpConfirmServerOptions): Promise<void> {
  const now = options.now ?? (() => Date.now());
  const answerClock = options.clock ?? defaultMonotonicClock;
  const logPath = options.log_path ?? defaultLogPath();
  const log = jsonLog(logPath === null ? null : logPath);
  const sessionId = channelSessionId(options.host.host_id, now());
  const idlePollMs = options.idle_poll_ms ?? DEFAULT_IDLE_POLL_MS;
  const hostInteractive =
    options.interactive_session === undefined
      ? detectInteractiveHostSession(options.host.host_id)
      : options.interactive_session;
  const versionOk = hostVersionInRange(options.config.host_version ?? "unknown", options.host.supported_range);
  // Three independent gates: attach registered an interactive mode, the host
  // process really is a TUI (a print/exec session must not be asked even when
  // attach says interactive), and the version is one this adapter exercised.
  const askable = confirmationAskable({
    mode: options.config.mode,
    host_interactive: hostInteractive,
    host_version: options.config.host_version ?? "unknown",
    supported_range: options.host.supported_range
  });

  let runtime: HostRuntime | null = null;
  let closed = false;
  let lastRequestId: number | null = null;
  let presentedInCycle = false;
  /**
   * Appendix L.4: after the person answers "adopt", the kernel adopts by
   * subject hash. This server must not ask about the same subject again before
   * that decision has landed. The set is per process; a new host session
   * starts empty, which is exactly the retry window the design allows.
   */
  const acceptedSubjects = new Set<string>();
  const lastChoice = { value: "unknown" as NativeChoice };
  let callChain: Promise<void> = Promise.resolve();
  let cycleChain: Promise<void> = Promise.resolve();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const protocol: McpConfirmProtocol = createMcpConfirmProtocol({
    input: options.input,
    output: options.output,
    log,
    server_name: options.host.server_name,
    now,
    on_tool_call: async () => {
      // Codex renders server-initiated elicitation only while a tool call is
      // in progress, and the review worker may finish arming the candidate a
      // moment after the model calls the tool. Retry briefly so the call sees
      // a just-pending candidate instead of returning "not processed".
      let presented = false;
      for (let attempt = 0; attempt < 6 && !presented; attempt += 1) {
        presented = await runCycle();
        if (!presented) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      return presented;
    }
  });

  log({
    event: "channel_start",
    host_id: options.host.host_id,
    session_id: sessionId,
    mode: options.config.mode,
    host_version: options.config.host_version ?? "unknown",
    host_interactive: hostInteractive,
    version_ok: versionOk,
    askable
  });

  const timeoutFor = (deadlineMs: number): number =>
    Math.max(1, Math.min(options.elicitation_timeout_ms ?? 5 * 60_000, deadlineMs));

  const setupPrompt = async (prompt: { readonly title: string; readonly message: string }, deadlineMs: number) => {
    presentedInCycle = true;
    const answer = await elicitWithEarlyKeyGuard<"confirmed" | "not_confirmed" | "unsupported" | "unknown">({
      elicit: (request) => protocol.elicit(request),
      request: {
        message: `${prompt.title}\n\n${prompt.message}`,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: {
              type: "string",
              title: "确认",
              enum: ["确认", "取消"],
              enumNames: ["确认", "取消"],
              // Pre-select the safe answer so a person can accept with Enter.
              default: "确认"
            }
          },
          required: ["confirm"]
        },
        timeout_ms: timeoutFor(deadlineMs)
      },
      map: mapSetupAnswer,
      isAnswer: (state) => state === "confirmed" || state === "not_confirmed",
      noDecision: "unknown",
      clock: answerClock
    });
    lastRequestId = answer.outcome.request_id;
    log({
      event: "setup_answer",
      state: answer.outcome.state,
      request_id: answer.outcome.request_id,
      content: answer.outcome.state === "accepted" ? answer.outcome.content : null
    });
    return answer.value;
  };

  const candidatePrompt = async (
    prompt: {
      readonly title: string;
      readonly message: string;
      readonly options: readonly string[];
      readonly codes?: readonly NativeChoice[];
    },
    deadlineMs: number
  ): Promise<NativeChoice> => {
    presentedInCycle = true;
    const answer = await elicitWithEarlyKeyGuard<NativeChoice>({
      elicit: (request) => protocol.elicit(request),
      request: {
        message: `${prompt.title}\n\n${prompt.message}`,
        requestedSchema: {
          type: "object",
          properties: {
            decision: {
              type: "string",
              // Show exactly the choices this session is offered: an
              // other-session candidate has 采用/拒绝, a source-session resume
              // has 采用/还没做完/内容不对.
              title: prompt.options.join(" / "),
              enum: [...prompt.options],
              enumNames: [...prompt.options]
              // No default: accepting the form without choosing a value must
              // stay undecided, never become the first option.
            }
          },
          required: ["decision"]
        },
        timeout_ms: timeoutFor(deadlineMs)
      },
      map: (outcome): NativeChoice => {
        if (outcome.state === "accepted") {
          const raw = outcome.content["decision"];
          const index = typeof raw === "string" ? prompt.options.indexOf(raw) : -1;
          const code = index < 0 ? undefined : prompt.codes?.[index];
          return code === "adopt" || code === "incomplete" || code === "reject" ? code : "unknown";
        }
        if (outcome.state === "declined") {
          // An explicit Decline on the candidate form is a rejection, matching
          // the yes/no fallback used for hosts without a three-way dialog.
          return "reject";
        }
        return outcome.state === "unsupported" ? "unsupported" : "unknown";
      },
      isAnswer: (choice) =>
        choice === "adopt" || choice === "incomplete" || choice === "reject",
      noDecision: "unknown",
      clock: answerClock
    });
    lastRequestId = answer.outcome.request_id;
    log({
      event: "candidate_answer",
      state: answer.outcome.state,
      request_id: answer.outcome.request_id,
      content: answer.outcome.state === "accepted" ? answer.outcome.content : null
    });
    return (lastChoice.value = answer.value);
  };

  const reasonPrompt = async (
    prompt: { readonly title: string; readonly message: string },
    deadlineMs: number
  ): Promise<string | null> => {
    const answer = await elicitWithEarlyKeyGuard<string | null>({
      elicit: (request) => protocol.elicit(request),
      request: {
        message: prompt.title,
        requestedSchema: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              title: "原因（可留空）",
              description: "可选：说明内容哪里不符合预期",
              maxLength: 500
            }
          },
          required: []
        },
        timeout_ms: timeoutFor(deadlineMs)
      },
      map: (outcome) => {
        if (outcome.state !== "accepted") return null;
        const reason = outcome.content["reason"];
        return typeof reason === "string" && reason.trim().length > 0 ? reason.trim().slice(0, 500) : null;
      },
      isAnswer: (value) => typeof value === "string",
      noDecision: null,
      clock: answerClock
    });
    lastRequestId = answer.outcome.request_id;
    return answer.value;
  };

  const confirmationOptions = (deadlineMs: number): SessionConfirmationOptions => ({
    observed_at: now(),
    mechanism: options.host.mechanism,
    channel: () => ({
      server: options.host.server_name,
      session_id: sessionId,
      request_id: lastRequestId
    }),
    confirm_native: (prompt) => setupPrompt(prompt, deadlineMs),
    choose_native: (prompt) => candidatePrompt(prompt, deadlineMs),
    ask_reason_native: (prompt) => reasonPrompt(prompt, deadlineMs)
  });

  async function onCall(call: RuntimeCall): Promise<void> {
    const active = runtime;
    if (active === null) return;
    if (
      call.kind === "probe" &&
      (call.request.probe_action === "confirm_human_setup" ||
        call.request.probe_action === "confirm_candidate")
    ) {
      lastRequestId = null;
      const candidate = call.request.candidate_confirmation;
      if (
        call.request.probe_action === "confirm_candidate" &&
        candidate !== undefined &&
        acceptedSubjects.has(candidate.subject_hash)
      ) {
        // The person already said "adopt" for this subject in this process.
        // Report `unknown` without drawing another form; the kernel keeps the
        // candidate pending and its subject-hash idempotency decides.
        log({ event: "candidate_suppressed", subject_hash: candidate.subject_hash });
        await handleSessionConfirmationCall(active, call, {
          ...confirmationOptions(call.deadline_ms),
          choose_native: async () => "unknown"
        });
        return;
      }
      lastChoice.value = "unknown";
      const optionsForCall = confirmationOptions(call.deadline_ms);
      await handleSessionConfirmationCall(active, call, optionsForCall);
      const chosen = lastChoice.value as NativeChoice;
      if (
        call.request.probe_action === "confirm_candidate" &&
        candidate !== undefined &&
        chosen === "adopt"
      ) {
        acceptedSubjects.add(candidate.subject_hash);
      }
      return;
    }
    await handleRuntimeCall(active, call, {
      artifact_root: options.artifact_root,
      carrier_event: options.host.carrier_event,
      observed_at: now(),
      host_observation: () => ({ session_id: sessionId, message_id: null, tool_call_id: null, compaction: false })
    });
  }

  let loggedGates = false;
  async function runCycle(): Promise<boolean> {
    if (!loggedGates) {
      loggedGates = true;
      log({
        event: "channel_gates",
        askable,
        host_interactive: hostInteractive,
        client_elicitation: protocol.clientSupportsElicitation(),
        initialized: protocol.ready()
      });
    }
    if (!askable || runtime === null || closed) return false;
    presentedInCycle = false;
    const counter = `${String(now())}:${String(Math.random())}`;
    const key = hashUtf8(`${sessionId}:${counter}:${CONFIRM_HOOK_EVENT}`) as Hash;
    try {
      const polled = await runtime.pollOnce(CONFIRM_HOOK_EVENT, key, 0);
      await callChain;
      if (polled.call !== null) {
        log({ event: "cycle_call", kind: polled.call.kind });
      }
    } catch {
      return presentedInCycle;
    }
    return presentedInCycle;
  }

  function scheduleIdle(): void {
    if (!askable || idlePollMs <= 0 || closed) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (closed) return;
      // Never stack a second dialog on top of one already open.
      if (protocol.pendingCount() > 0) {
        scheduleIdle();
        return;
      }
      cycleChain = cycleChain.then(async () => {
        await runCycle();
      });
      void cycleChain.finally(() => scheduleIdle());
    }, idlePollMs);
    idleTimer.unref?.();
  }

  if (askable) {
    const started = await startHostRuntime({
      config: options.config,
      hooks: {
        artifact_root: options.artifact_root,
        registration_hash: options.config.registration_hash,
        host_version: options.config.host_version ?? process.env["EVOPLUG_HOST_VERSION"] ?? "unknown",
        ephemeral: true,
        // The channel session is not a kernel probe (appendix L.1): it is the
        // host-launched MCP process and its answers are host-native decisions.
        session_role: "host_session",
        instance_key: sessionId,
        onCall: (call: RuntimeCall) => {
          callChain = callChain.then(() => onCall(call)).catch(() => undefined);
        }
      }
    });
    if (started.ok) {
      runtime = started.runtime;
      log({ event: "runtime_ready", session_id: sessionId });
      scheduleIdle();
    } else {
      log({ event: "runtime_unavailable", code: started.error.code });
    }
  }

  await protocol.closed;
  closed = true;
  if (idleTimer !== null) clearTimeout(idleTimer);
  await cycleChain.catch(() => undefined);
  await callChain.catch(() => undefined);
  runtime?.close();
  log({ event: "channel_stop", session_id: sessionId });
}

function mapSetupAnswer(outcome: McpElicitationOutcome): "confirmed" | "not_confirmed" | "unsupported" | "unknown" {
  if (outcome.state === "accepted") {
    return outcome.content["confirm"] === "确认" ? "confirmed" : "not_confirmed";
  }
  if (outcome.state === "declined") return "not_confirmed";
  if (outcome.state === "unsupported") return "unsupported";
  return "unknown";
}

export { MCP_CONFIRM_TOOL_NAME };
