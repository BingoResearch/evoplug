/**
 * Oh My Pi runtime entry (DD-HOST-204, `oh-my-pi` row).
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
  handleHumanConfirmationCall,
  handleRuntimeCall,
  nativeConfirmerFromUiContext,
  startHostRuntime,
  type HostRuntime,
  type HostRuntimeSubmitOutcome,
  type RuntimeCall
} from "@evoplug/host-runtime";

function artifactPaths(metaUrl: string): { root: string; config: string } {
  const here = dirname(fileURLToPath(metaUrl));
  const singleFileConfig = join(here, "evoplug.runtime", "config.json");
  if (existsSync(singleFileConfig)) {
    return { root: here, config: singleFileConfig };
  }
  return { root: here, config: join(here, "config.json") };
}

/**
 * OMP hook payloads do not carry the native session id on every event. The
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

export default async function evoplugOmpRuntime(pi: any): Promise<void> {
  const paths = artifactPaths(import.meta.url);
  const root = paths.root;
  const loaded = await loadHostRuntimeConfig(paths.config);
  if (!loaded.ok) return;

  let runtime: HostRuntime | null = null;
  /**
   * The last extension context seen by a hook. Native confirmation must use
   * the host's own dialog surface and fails closed when the mode has none.
   */
  let activeContext: unknown = null;
  // OMP only accepts the `input` contract in interactive/rpc modes. Other
  // modes use the always-declared `context` observation event as the upload
  // carrier; the diagnostic payload carries no native id, so it still ends as
  // a phase-B rejection with the CAS ref as `detail_ref`.
  const diagnosticCarrier =
    loaded.config.mode === "interactive" || loaded.config.mode === "rpc" ? "input" : "context";

  const onCall = async (call: RuntimeCall): Promise<void> => {
    if (runtime === null) return;
    if (
      call.kind === "probe" &&
      call.request.probe_action === "confirm_human_event"
    ) {
      await handleHumanConfirmationCall(runtime, call, {
        carrier_event: diagnosticCarrier,
        observed_at: Date.now(),
        confirm_native: nativeConfirmerFromUiContext(activeContext)
      });
      return;
    }
    await handleRuntimeCall(runtime, call, {
      artifact_root: root,
      carrier_event: diagnosticCarrier,
      observed_at: Date.now(),
      host_observation: () => null
    });
  };

  const started = await startHostRuntime({
    config: loaded.config,
    hooks: {
      artifact_root: root,
      registration_hash: loaded.config.registration_hash,
      host_version: process.env["EVOPLUG_HOST_VERSION"] ?? "18.12.3",
      ephemeral: false,
      // A kernel probe session has no admitted delivery and runs under a hard
      // wall-clock cap. Waiting the full delivery poll window in
      // `before_agent_start` would consume the turn before the host issues its
      // provider request, so the probe poll is a real zero-wait poll instead.
      // Resident sessions keep the session's advertised maximum.
      ...(process.env["EVOPLUG_PROBE_SESSION_MODE"] === "ephemeral"
        ? { poll_wait_max_ms: 0 }
        : {}),
      onCall
    }
  });
  if (!started.ok) return;
  runtime = started.runtime;

  const inflight = new Set<Promise<void>>();
  /**
   * The last `input` upload of each native session. A delivery is created from
   * the event that triggered the online pipeline, so the injection hook must
   * poll with the *input* boundary key, not with `before_agent_start`'s own
   * key. The entry is consumed when `before_agent_start` runs so a later run
   * without a new input cannot reuse a stale boundary.
   */
  const inputSubmissions = new Map<string, Promise<HostRuntimeSubmitOutcome | null>>();
  const submit = (
    hostEvent: string,
    event: unknown,
    payload: unknown,
    ctx: unknown
  ): Promise<HostRuntimeSubmitOutcome | null> => {
    const sessionId = nativeSessionId(event, ctx);
    const active = runtime;
    const task: Promise<HostRuntimeSubmitOutcome | null> =
      active === null
        ? Promise.resolve(null)
        : active
            .submitHostEvent(
              hostEvent,
              sessionId === undefined ? {} : { session_id: sessionId },
              jsonPayload(payload) as never,
              Date.now()
            )
            .catch(() => null);
    if (hostEvent === "input") {
      inputSubmissions.set(sessionId ?? "", task);
    }
    const tracked = task.then(() => undefined);
    inflight.add(tracked);
    void tracked.finally(() => inflight.delete(tracked));
    return task;
  };

  /** Drains every queued upload before the runtime socket is closed. */
  const drain = async (): Promise<void> => {
    while (inflight.size > 0) {
      await Promise.allSettled([...inflight]);
    }
  };

  pi.on("session_start", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("session_start", event, event, ctx); });
  pi.on("input", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("input", event, event, ctx); });
  pi.on("context", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("context", event, event, ctx); });
  pi.on("before_provider_request", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("before_provider_request", event, event, ctx); });
  pi.on("tool_call", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("tool_call", event, event, ctx); });
  pi.on("tool_result", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("tool_result", event, event, ctx); });
  pi.on("agent_end", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("agent_end", event, event, ctx); });
  pi.on("session_stop", async (event: unknown, ctx: unknown) => {
    activeContext = ctx;
    const submitted = await submit("session_stop", event, event, ctx);
    const outcome = await runtime?.pollOnce(
      "session_stop",
      (submitted?.receipt?.event_key ?? null) as Parameters<HostRuntime["pollOnce"]>[1]
    );
    const call = outcome?.call ?? null;
    if (call !== null && call.kind === "deliver") {
      await runtime?.reportResult(call.call_id, {
        kind: "deliver", state: "completed",
        result: { delivery_id: call.request.delivery_id, submitted: "true", inclusion: { level: "provider_payload" }, degraded: false, completed_at: Date.now() }
      });
      return { additionalContext: call.content.text, continue: true };
    }
    return undefined;
  });
  pi.on("session_shutdown", async (event: unknown, ctx: unknown) => {
    activeContext = ctx;
    void submit("session_shutdown", event, event, ctx);
    await drain();
    runtime?.close();
  });

  pi.on("before_agent_start", async (event: unknown, ctx: unknown) => {
    activeContext = ctx;
    const own = submit("before_agent_start", event, event, ctx);
    const sessionId = nativeSessionId(event, ctx) ?? "";
    const input = inputSubmissions.get(sessionId);
    inputSubmissions.delete(sessionId);
    const inputOutcome = input === undefined ? null : await input;
    const ownOutcome = await own;
    // Prefer the input boundary: it is the event that triggers an online
    // delivery, while `before_agent_start` only provides the injection point.
    // Without a successful input receipt, fall back to this hook's own
    // receipt; both paths fail closed when neither upload was accepted.
    const inputKey = inputOutcome?.receipt?.event_key ?? null;
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
