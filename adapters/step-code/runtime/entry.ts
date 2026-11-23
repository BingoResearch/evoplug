/**
 * Step Code runtime entry (DD-HOST-204, `step-code` row).
 *
 * Loaded by Pi from `<agentDir>/extensions/evoplug/`. It only collects native
 * fields and payload bytes, uploads them through the shared runtime client and
 * injects a pending delivery at `before_agent_start`. Normalization, identity
 * and persistence stay in the kernel host core.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadHostRuntimeConfig,
  claimRuntimeLoad,
  handleHumanConfirmationCall,
  handleRuntimeCall,
  handleSessionConfirmationCall,
  nativeChooserFromHostContext,
  nativeReasonAskerFromHostContext,
  nativeConfirmerFromHostContext,
  startHostRuntime,
  type HostRuntime,
  type HostRuntimeSubmitOutcome,
  type RuntimeCall
} from "@evoplug/host-runtime";

import { InputBoundaryQueue, SessionUploadGate, ToolPhaseDeduper, toolCallNativeId } from "./upload-gate.js";

function artifactPaths(metaUrl: string): { root: string; config: string } {
  const here = dirname(fileURLToPath(metaUrl));
  const singleFileConfig = join(here, "evoplug.runtime", "config.json");
  if (existsSync(singleFileConfig)) {
    return { root: here, config: singleFileConfig };
  }
  return { root: here, config: join(here, "config.json") };
}

/**
 * Step hook payloads do not carry the native session id on every event. The
 * extension context exposes it through the read-only session manager, which is
 * the only documented accessor on the Pi-compatible API.
 */
function contextSessionId(ctx: unknown): string | undefined {
  const manager = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | null)?.sessionManager;
  if (typeof manager?.getSessionId !== "function") return undefined;
  try {
    const value = manager.getSessionId();
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function nativeSessionId(event: unknown, ctx: unknown): string | undefined {
  const value = event as { session_id?: unknown; sessionId?: unknown } | null;
  if (typeof value?.session_id === "string") return value.session_id;
  if (typeof value?.sessionId === "string") return value.sessionId;
  return contextSessionId(ctx);
}

/**
 * Host hook payloads are plain JS objects: optional members are `undefined`,
 * which is not a JSON value and cannot be uploaded. Round-tripping through JSON
 * keeps the host's own wire representation without inventing a field.
 */
function jsonPayload(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? {} : (JSON.parse(text) as unknown);
  } catch {
    return {};
  }
}

export default async function evoplugStepRuntime(pi: any): Promise<void> {
  const paths = artifactPaths(import.meta.url);
  const root = paths.root;
  const releaseLoad = claimRuntimeLoad(paths.config);
  if (releaseLoad === null) return;
  const loaded = await loadHostRuntimeConfig(paths.config);
  if (!loaded.ok) { releaseLoad(); return; }

  let runtime: HostRuntime | null = null;
  let activeContext: unknown = null;
  /** Dialogs use the editor context; post-turn contexts have no surface. */
  let inputContext: unknown = null;

  const onCall = async (call: RuntimeCall): Promise<void> => {
    if (runtime === null) return;
    if (call.kind === "probe" && call.request.probe_action === "confirm_human_event") {
      const confirm = nativeConfirmerFromHostContext(inputContext ?? activeContext);
      // A hook without a dialog answers `unsupported` so the call closes
      // without consuming an ask and the next input can arm it again.
      await handleHumanConfirmationCall(runtime, call, {
        carrier_event: "input",
        observed_at: Date.now(),
        confirm_native: confirm
      });
      return;
    }
    if (
      call.kind === "probe" &&
      (call.request.probe_action === "confirm_human_setup" ||
        call.request.probe_action === "confirm_candidate")
    ) {
      const timeout = call.deadline_ms;
      const dialogContext = inputContext ?? activeContext;
      const confirm = nativeConfirmerFromHostContext(dialogContext);
      const choose = nativeChooserFromHostContext(dialogContext);
      const askReason = nativeReasonAskerFromHostContext(dialogContext);
      await handleSessionConfirmationCall(runtime, call, {
        observed_at: Date.now(),
        confirm_native:
          confirm === null
            ? null
            : (prompt) => confirm({ ...prompt, signal: AbortSignal.timeout(timeout) }),
        choose_native:
          choose === null
            ? null
            : (prompt) => choose({ ...prompt, signal: AbortSignal.timeout(timeout) }),
        ask_reason_native:
          askReason === null
            ? null
            : (prompt) => askReason(prompt)
      });
      return;
    }
    await handleRuntimeCall(runtime, call, {
      artifact_root: root,
      carrier_event: "input",
      observed_at: Date.now(),
      host_observation: () => null
    });
  };

  const started = await startHostRuntime({
    config: loaded.config,
    hooks: {
      artifact_root: root,
      registration_hash: loaded.config.registration_hash,
      host_version: loaded.config.host_version ?? process.env["EVOPLUG_HOST_VERSION"] ?? "unknown",
      ephemeral: false,
      onCall
    }
  });
  if (!started.ok) { releaseLoad(); return; }
  runtime = started.runtime;

  const inflight = new Set<Promise<void>>();
  const track = (task: Promise<unknown>): Promise<unknown> => {
    const tracked = task.then(
      () => undefined,
      () => undefined
    );
    inflight.add(tracked);
    void tracked.finally(() => inflight.delete(tracked));
    return task;
  };
  /**
   * One input-boundary upload per turn, consumed in order by
   * `before_agent_start`. A single map slot loses a rapid second prompt when
   * both inputs arrive before the first turn starts.
   */
  const inputBoundaries = new InputBoundaryQueue<Promise<HostRuntimeSubmitOutcome | null>>();
  /**
   * Task scope is created by the first accepted input and is per native
   * session (appendix F.1). A runtime-wide flag lets a second TUI session
   * upload `before_agent_start` and tool events with no scope, which the
   * kernel rejects with `E_EVENT_SCOPE_UNBOUND`.
   */
  const gate = new SessionUploadGate({ max_events: 64, max_bytes: 256 * 1024 });
  /** Step exposes one tool activity through two hook pairs. */
  const toolPhases = new ToolPhaseDeduper();

  const send = (
    hostEvent: string,
    event: unknown,
    payload: unknown,
    ctx: unknown,
    receivedAt: number
  ): Promise<HostRuntimeSubmitOutcome | null> => {
    const sessionId = nativeSessionId(event, ctx);
    const active = runtime;
    if (active === null || sessionId === undefined) {
      return Promise.resolve(null);
    }
    // Step's tool hooks carry `toolCallId` and no event id. Uploading it as
    // the native event id keeps parallel calls and their results distinct;
    // otherwise two events in the same millisecond share the kernel identity
    // and the second is rejected as `E_IDEMPOTENCY_CONFLICT`.
    const callId = toolCallNativeId(hostEvent, event);
    const ids: {
      session_id: string;
      event_id?: string;
      tool_call_id?: string;
    } = { session_id: sessionId };
    if (callId !== undefined) {
      ids.event_id = callId;
      ids.tool_call_id = callId;
    }
    return active
      .submitHostEvent(hostEvent, ids, jsonPayload(payload) as never, receivedAt)
      .catch(() => null);
  };

  /**
   * The input that created the scope is already queued before these entries,
   * so flushing in arrival order after it preserves appendix F.1's ordering.
   */
  const acceptAndFlush = (sessionId: string): void => {
    for (const entry of gate.accept(sessionId)) {
      track(send(entry.host_event, entry.event, entry.payload, entry.ctx, entry.received_at));
    }
  };

  const submit = (
    hostEvent: string,
    event: unknown,
    payload: unknown,
    ctx: unknown,
    force = false
  ): Promise<HostRuntimeSubmitOutcome | null> => {
    const sessionId = nativeSessionId(event, ctx);
    const receivedAt = Date.now();
    if (sessionId === undefined) {
      process.stderr.write(
        `evoplug runtime: skipped ${hostEvent} because the native session id is missing\n`
      );
      return Promise.resolve(null);
    }
    if (hostEvent !== "input" && !force && !gate.isAccepted(sessionId)) {
      // A session that shut down without any typed input never gets a scope;
      // buffering its shutdown would only flush it into a rejection later.
      if (hostEvent === "session_shutdown") {
        const dropped = gate.discard(sessionId);
        if (dropped > 0) {
          process.stderr.write(
            `evoplug runtime: discarded ${String(dropped)} pre-input events for a session without input\n`
          );
        }
        return Promise.resolve(null);
      }
      const deferred = gate.defer(sessionId, {
        host_event: hostEvent,
        event,
        payload,
        ctx,
        received_at: receivedAt
      });
      if (deferred.dropped > 0) {
        process.stderr.write(
          `evoplug runtime: pre-input cache overflow dropped ${String(deferred.dropped)} oldest events\n`
        );
      }
      return Promise.resolve(null);
    }
    if (toolPhases.seen(sessionId, hostEvent, event)) {
      return Promise.resolve(null);
    }
    const task = track(send(hostEvent, event, payload, ctx, receivedAt)) as Promise<
      HostRuntimeSubmitOutcome | null
    >;
    if (hostEvent === "input") {
      inputBoundaries.push(sessionId, task);
      void task.then((outcome) => {
        if (outcome?.receipt !== undefined && outcome.receipt !== null) {
          acceptAndFlush(sessionId);
        }
      });
    }
    void task.then((outcome) => {
      if (outcome === null) return;
      if (outcome.rejection !== null) {
        process.stderr.write(
          `evoplug runtime: upload rejected host_event=${hostEvent} reason=${outcome.rejection.reason} field=${outcome.rejection.field} phase=${outcome.rejection.phase}\n`
        );
        return;
      }
      if (outcome.error !== null) {
        process.stderr.write(
          `evoplug runtime: upload failed host_event=${hostEvent} code=${outcome.error.code} retryable=${String(outcome.error.retryable)}\n`
        );
      }
    });
    return task;
  };

  /** Drains every queued upload before the runtime socket is closed. */
  const drain = async (): Promise<void> => {
    while (inflight.size > 0) {
      await Promise.allSettled([...inflight]);
    }
  };

  // Q.4: a confirmation is asked at the start of an interactive process.
  // Step does not poll on its own at session start, so do it here and drain
  // every pending candidate in creation order.
  const flushSessionStart = async (event: unknown, ctx: unknown): Promise<void> => {
    const outcome = await submit("session_start", event, event, ctx);
    const key = (outcome?.receipt?.event_key ?? null) as Parameters<HostRuntime["pollOnce"]>[1];
    let polled = await runtime?.pollOnce("session_start", key, 0);
    for (let round = 0; round < 8 && polled?.ok === true && polled.call !== null; round += 1) {
      polled = await runtime?.pollOnce("session_start", key, 0);
    }
  };
  pi.on("session_start", (event: unknown, ctx: unknown) => { activeContext = ctx; void flushSessionStart(event, ctx); });
  pi.on("input", (event: unknown, ctx: unknown) => { activeContext = ctx; inputContext = ctx; void submit("input", event, event, ctx); });
  pi.on("context", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("context", event, event, ctx); });
  pi.on("before_provider_request", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("before_provider_request", event, event, ctx); });
  pi.on("tool_call", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("tool_call", event, event, ctx); });
  pi.on("tool_result", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("tool_result", event, event, ctx); });
  pi.on("tool_call", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("tool_call", event, event, ctx); });
  pi.on("tool_result", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("tool_result", event, event, ctx); });
  // Step 0.1.5 also reports the same activity through its agent-loop pair.
  // `tool_call` precedes `tool_execution_start`, so the deduper keeps the
  // canonical call and drops the alias; `tool_execution_end` is not registered
  // because `tool_result` carries the same call's richer result payload.
  pi.on("tool_execution_start", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("tool_call", event, event, ctx); });
  pi.on("compaction", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("compaction", event, event, ctx); });
  pi.on("cron", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("cron", event, event, ctx); });
  pi.on("lane", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("lane", event, event, ctx); });
  pi.on("agent_end", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("agent_end", event, event, ctx); });
  pi.on("agent_settled", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("agent_settled", event, event, ctx); });
  pi.on("session_shutdown", async (event: unknown, ctx: unknown) => {
    activeContext = ctx;
    void submit("session_shutdown", event, event, ctx);
    await drain();
    runtime?.close();
  });

  pi.on("before_agent_start", async (event: unknown, ctx: unknown) => {
    activeContext = ctx;
    const sessionId = nativeSessionId(event, ctx) ?? "";
    // Inputs and their turns are ordered; consume the oldest boundary that has
    // not been paired with a start. A single slot would lose the previous turn
    // when two prompts arrive before the first `before_agent_start` runs.
    const input = inputBoundaries.shift(sessionId);
    const inputOutcome = input === undefined ? null : await input;
    const inputKey = inputOutcome?.receipt?.event_key ?? null;
    // Wait for the input upload first: submitting this hook before the kernel
    // has created the task scope is what produced `E_EVENT_SCOPE_UNBOUND` on
    // real Step Code. A rejected input still uploads this hook so the poll
    // keeps its fail-closed fallback boundary.
    const own = submit("before_agent_start", event, event, ctx, inputOutcome !== null && inputKey === null);
    const ownOutcome = await own;
    // Prefer the input boundary: it is the event that triggers an online
    // delivery, while `before_agent_start` only provides the injection point.
    // Without a successful input receipt, fall back to this hook's own
    // receipt; both paths fail closed when neither upload was accepted.
    const hookEvent = inputKey === null ? "before_agent_start" : "input";
    const eventKey = inputKey ?? ownOutcome?.receipt?.event_key ?? null;
    const outcome = await runtime?.pollOnce(
      hookEvent,
      eventKey as Parameters<HostRuntime["pollOnce"]>[1]
    );
    const call = outcome?.call ?? null;
    if (call === null || call.kind !== "deliver") return undefined;
    await runtime?.reportResult(call.call_id, {
      kind: "deliver",
      state: "completed",
      result: {
        delivery_id: call.request.delivery_id,
        submitted: "true",
        inclusion: { level: "provider_payload" },
        degraded: false,
        completed_at: Date.now()
      }
    });
    return { message: { customType: "evoplug", content: call.content.text, display: false } };
  });
}
