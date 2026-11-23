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
  claimRuntimeLoad,
  handleHumanConfirmationCall,
  handleRuntimeCall,
  handleSessionConfirmationCall,
  nativeChooserFromHostContext,
  nativeReasonAskerFromHostContext,
  nativeConfirmerFromUiContext,
  nativeConfirmerFromHostContext,
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
 * Host-native upload ids. oh-my-pi shares Pi's tool hook shape: `toolCallId` is
 * present for every call, including parallel calls that finish in the same
 * millisecond, but there is no event id. Uploading it as `event_id` gives each
 * tool event its own identity; `host_event` still separates a call from its
 * result.
 */
function nativeUploadIds(
  hostEvent: string,
  event: unknown,
  ctx: unknown
): { session_id?: string; event_id?: string; tool_call_id?: string } {
  const sessionId = nativeSessionId(event, ctx);
  const ids: { session_id?: string; event_id?: string; tool_call_id?: string } = {};
  if (sessionId !== undefined) ids.session_id = sessionId;
  if (hostEvent === "tool_call" || hostEvent === "tool_result") {
    const record = event as { toolCallId?: unknown; tool_call_id?: unknown } | null;
    const callId =
      typeof record?.toolCallId === "string"
        ? record.toolCallId
        : typeof record?.tool_call_id === "string"
          ? record.tool_call_id
          : undefined;
    if (callId !== undefined && callId.length > 0) {
      ids.event_id = callId;
      ids.tool_call_id = callId;
    }
  }
  return ids;
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
  const releaseLoad = claimRuntimeLoad(paths.config);
  if (releaseLoad === null) return;
  const loaded = await loadHostRuntimeConfig(paths.config);
  if (!loaded.ok) { releaseLoad(); return; }

  let runtime: HostRuntime | null = null;
  /**
   * The last extension context seen by a hook. Native confirmation must use
   * the host's own dialog surface and fails closed when the mode has none.
   */
  let activeContext: unknown = null;
  /**
   * Some hooks receive a stripped context without `ui`; the session and input
   * hooks carry the dialog surface. Remember the newest context that actually
   * exposes a chooser or confirmer instead of relying on hook order.
   */
  let uiContext: unknown = null;
  /** The session_start context owns the render-capable dialog surface. */
  let sessionContext: unknown = null;
  const rememberContext = (ctx: unknown): void => {
    activeContext = ctx;
    if (
      nativeChooserFromHostContext(ctx) !== null ||
      nativeConfirmerFromUiContext(ctx) !== null ||
      nativeConfirmerFromHostContext(ctx) !== null
    ) {
      uiContext = ctx;
    }
  };
  /**
   * oh-my-pi can render a modal dialog only from the editor context delivered
   * with `input`; a `before_agent_start` or post-turn context accepts the call
   * but resolves it immediately without drawing anything. Confirmation probes
   * therefore use the last input context.
   */
  let inputContext: unknown = null;
  // OMP only accepts the `input` contract in interactive/rpc modes. Other
  // modes use the always-declared `context` observation event as the upload
  // carrier; the diagnostic payload carries no native id, so it still ends as
  // a phase-B rejection with the CAS ref as `detail_ref`.
  const diagnosticCarrier =
    loaded.config.mode === "interactive" || loaded.config.mode === "rpc" ? "input" : "context";

  /**
   * Interactive sessions receive confirmation probes on several boundaries.
   * A post-turn hook has no dialog surface; the handler then reports an honest
   * `unsupported` (which the kernel does not count as an ask), so the next
   * dialog-capable boundary can arm the same candidate again instead of the
   * call staying issued for its whole deadline.
   */
  const onCall = async (call: RuntimeCall): Promise<void> => {
    if (runtime === null) return;
    if (
      call.kind === "probe" &&
      call.request.probe_action === "confirm_human_event"
    ) {
      const dialogContext = sessionContext ?? inputContext ?? uiContext ?? activeContext;
      const confirm = nativeConfirmerFromUiContext(dialogContext);
      // Report `unsupported` when the hook has no dialog instead of leaving the
      // call issued: the kernel closes it without counting an ask, so the next
      // input boundary can arm the same candidate again.
      await handleHumanConfirmationCall(runtime, call, {
        carrier_event: diagnosticCarrier,
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
      const dialogContext = sessionContext ?? inputContext ?? uiContext ?? activeContext;
      const confirm = nativeConfirmerFromUiContext(dialogContext) ??
        nativeConfirmerFromHostContext(dialogContext);
      // oh-my-pi's `ui.select` can resolve the first value without drawing a
      // dialog; that is not a human answer. Use the render-capable yes/no
      // confirm surface for adoption on this host and fail closed when it is
      // absent. A source-session resume maps No to reject rather than guessing
      // an incomplete verdict.
      const choose = confirm === null
        ? null
        : async (prompt: { readonly title: string; readonly message: string; readonly signal: AbortSignal }) => {
            // Some oh-my-pi builds render only the message body in their
            // confirm dialog. Repeat the confirmation title and the two
            // choices there so the user sees what is being accepted.
            const answer = await confirm({
              ...prompt,
              message: `${prompt.message}\n\n选择“是”采用，选择“否”拒绝。\nEvoPlug 经验采用确认`
            });
            return answer === "confirmed" ? "adopt" as const
              : answer === "not_confirmed" ? "reject" as const
                : answer;
          };
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
      carrier_event: diagnosticCarrier,
      observed_at: Date.now(),
      host_observation: () => null
    });
  };

  const startOptions = {
    config: loaded.config,
    hooks: {
      artifact_root: root,
      registration_hash: loaded.config.registration_hash,
      host_version: loaded.config.host_version ?? process.env["EVOPLUG_HOST_VERSION"] ?? "unknown",
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
  } as const;
  // A freshly started `serve` can still be finishing its startup probes when
  // the host launches; a socket connect then fails with `E_IO` for a few
  // seconds. Retry that transient case instead of leaving the session without
  // a runtime for its whole lifetime.
  let started = await startHostRuntime(startOptions);
  // Keep the retry window short enough for a short interactive session: a
  // 30 s window used to outlive the whole session.
  for (let attempt = 0; attempt < 40 && !started.ok && started.error.code === "E_IO"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    started = await startHostRuntime(startOptions);
  }
  if (!started.ok) { releaseLoad(); return; }
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
  /**
   * Events that can arrive before the first `input` (Appendix F.1). The kernel
   * owns no task/branch scope until an input exists, so these are cached in
   * arrival order, bounded, and uploaded after the first input is accepted.
   */
  const OBSERVATION_EVENTS = new Set([
    "session_start",
    "context",
    "before_provider_request",
    "tool_call",
    "tool_result",
    "session_compact",
    "session_compact_failed"
  ]);
  const PRE_INPUT_MAX_EVENTS = 64;
  const PRE_INPUT_MAX_BYTES = 256 * 1024;
  interface CachedUpload {
    readonly host_event: string;
    readonly event: unknown;
    readonly payload: unknown;
    readonly ctx: unknown;
    readonly received_at: number;
  }
  let preInputQueue: CachedUpload[] = [];
  let preInputBytes = 0;
  let preInputDropped = 0;
  let inputAccepted = false;
  let flushing = false;
  let uploadChain: Promise<unknown> = Promise.resolve();

  const enqueueUpload = (
    hostEvent: string,
    event: unknown,
    payload: unknown,
    ctx: unknown,
    receivedAt: number
  ): Promise<HostRuntimeSubmitOutcome | null> => {
    const run = uploadChain.then(() => {
      const active = runtime;
      if (active === null) return null;
      return active
        .submitHostEvent(
          hostEvent,
          nativeUploadIds(hostEvent, event, ctx),
          jsonPayload(payload) as never,
          receivedAt
        )
        .catch(() => null);
    });
    uploadChain = run.then(
      () => undefined,
      () => undefined
    );
    const tracked = run.then(() => undefined);
    inflight.add(tracked);
    void tracked.finally(() => inflight.delete(tracked));
    return run;
  };

  const cachedSize = (entry: CachedUpload): number => {
    try {
      return Buffer.byteLength(JSON.stringify({ event: entry.event, payload: entry.payload }), "utf8");
    } catch {
      return 1;
    }
  };

  const reportCacheDrops = (): void => {
    if (preInputDropped === 0) return;
    process.stderr.write(`evoplug runtime: pre_input_cache_dropped count=${String(preInputDropped)}\n`);
    preInputDropped = 0;
  };

  const flushPreInput = (): void => {
    if (flushing) return;
    flushing = true;
    const queued = preInputQueue;
    preInputQueue = [];
    preInputBytes = 0;
    reportCacheDrops();
    for (const entry of queued) {
      const task = enqueueUpload(entry.host_event, entry.event, entry.payload, entry.ctx, entry.received_at);
      void task.then((outcome) => reportOutcome(entry.host_event, outcome));
    }
    flushing = false;
  };

  const reportOutcome = (hostEvent: string, outcome: HostRuntimeSubmitOutcome | null): void => {
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
  };

  const submit = (
    hostEvent: string,
    event: unknown,
    payload: unknown,
    ctx: unknown
  ): Promise<HostRuntimeSubmitOutcome | null> => {
    const sessionId = nativeSessionId(event, ctx);
    const receivedAt = Date.now();
    if (!inputAccepted && OBSERVATION_EVENTS.has(hostEvent)) {
      const entry: CachedUpload = { host_event: hostEvent, event, payload, ctx, received_at: receivedAt };
      preInputQueue.push(entry);
      preInputBytes += cachedSize(entry);
      while (
        (preInputQueue.length > PRE_INPUT_MAX_EVENTS || preInputBytes > PRE_INPUT_MAX_BYTES) &&
        preInputQueue.length > 0
      ) {
        const dropped = preInputQueue.shift();
        if (dropped !== undefined) {
          preInputBytes -= cachedSize(dropped);
          preInputDropped += 1;
        }
      }
      return Promise.resolve(null);
    }
    if (
      !inputAccepted &&
      (hostEvent === "session_shutdown" || hostEvent === "agent_end" || hostEvent === "agent_settled")
    ) {
      process.stderr.write(`evoplug runtime: skipped ${hostEvent} because no input established a session scope\n`);
      return Promise.resolve(null);
    }
    const task = enqueueUpload(hostEvent, event, payload, ctx, receivedAt);
    if (hostEvent === "input") {
      inputSubmissions.set(sessionId ?? "", task);
      void task.then((outcome) => {
        if (outcome?.receipt !== undefined && outcome.receipt !== null) {
          inputAccepted = true;
          flushPreInput();
        }
      });
    }
    void task.then((outcome) => reportOutcome(hostEvent, outcome));
    return task;
  };

  /** Drains every queued upload before the runtime socket is closed. */
  const drain = async (): Promise<void> => {
    while (inflight.size > 0) {
      await Promise.allSettled([...inflight]);
    }
  };

  const flushBacklog = async (hostEvent: string, event: unknown, ctx: unknown): Promise<void> => {
    const outcome = await submit(hostEvent, event, event, ctx);
    const key = (outcome?.receipt?.event_key ?? null) as Parameters<HostRuntime["pollOnce"]>[1];
    // Never leave a long poll in flight from a backlog flush; the next hook
    // would collide with it and the probe/candidate never reaches the UI.
    await runtime?.pollOnce(hostEvent, key, 0);
  };
  pi.on("session_start", (event: unknown, ctx: unknown) => { rememberContext(ctx); sessionContext = ctx; void flushBacklog("session_start", event, ctx); });
  pi.on("input", async (event: unknown, ctx: unknown) => {
    rememberContext(ctx);
    inputContext = ctx;
    const submitted = submit("input", event, event, ctx);
    const outcome = await submitted;
    const key = (outcome?.receipt?.event_key ?? null) as Parameters<HostRuntime["pollOnce"]>[1];
    // First poll lets the kernel arm a setup/candidate confirmation for this
    // boundary; the second fetches it so the host dialog is drawn while the
    // editor context is still active. A `before_agent_start` dialog context
    // resolves select/confirm immediately without rendering.
    await runtime?.pollOnce("input", key, 0);
    await runtime?.pollOnce("input", key, 0);
  });
  pi.on("context", (event: unknown, ctx: unknown) => { rememberContext(ctx); void submit("context", event, event, ctx); });
  pi.on("before_provider_request", (event: unknown, ctx: unknown) => { rememberContext(ctx); void submit("before_provider_request", event, event, ctx); });
  pi.on("tool_call", (event: unknown, ctx: unknown) => { rememberContext(ctx); void submit("tool_call", event, event, ctx); });
  pi.on("tool_result", (event: unknown, ctx: unknown) => { rememberContext(ctx); void submit("tool_result", event, event, ctx); });
  pi.on("agent_end", (event: unknown, ctx: unknown) => { rememberContext(ctx); void flushBacklog("agent_end", event, ctx); });
  pi.on("agent_settled", (event: unknown, ctx: unknown) => { rememberContext(ctx); void submit("agent_settled", event, event, ctx); });
  pi.on("agent_pause", (event: unknown, ctx: unknown) => { rememberContext(ctx); void submit("agent_pause", event, event, ctx); });
  pi.on("session_stop", async (event: unknown, ctx: unknown) => {
    rememberContext(ctx);
    const submitted = await submit("session_stop", event, event, ctx);
    // oh-my-pi emits `session_stop` after every turn. A default (waiting)
    // poll would hold the runtime's single poll slot for the whole delivery
    // window, so the next turn's `before_agent_start` sees E_HOST_RUNTIME_BUSY
    // and a pending confirmation is never delivered. The injection point is
    // `before_agent_start`; this boundary poll is a zero-wait probe.
    const outcome = await runtime?.pollOnce(
      "session_stop",
      (submitted?.receipt?.event_key ?? null) as Parameters<HostRuntime["pollOnce"]>[1],
      0
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
    rememberContext(ctx);
    if (!inputAccepted && preInputQueue.length > 0) {
      process.stderr.write(
        `evoplug runtime: pre_input_cache_unusable count=${String(preInputQueue.length)} reason=no_input\n`
      );
      preInputQueue = [];
      preInputBytes = 0;
      preInputDropped = 0;
    }
    await flushBacklog("session_shutdown", event, ctx);
    await drain();
    inputAccepted = false;
    runtime?.close();
  });

  pi.on("before_agent_start", async (event: unknown, ctx: unknown) => {
    rememberContext(ctx);
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
