/**
 * Pi runtime entry (DD-HOST-204, `pi` row).
 *
 * Loaded by Pi from `<agentDir>/extensions/evoplug/`. It only collects native
 * fields and payload bytes, uploads them through the shared runtime client and
 * injects a pending delivery at `before_agent_start`. Normalization, identity
 * and persistence stay in the kernel host core.
 */

import { appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
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
 * Pi hook payloads do not carry the native session id on every event. The
 * extension context exposes it through the read-only session manager, which is
 * the only documented accessor (Pi 0.87.1 `ReadonlySessionManager`).
 */
function contextSessionId(ctx: unknown): string | undefined {
  const record = ctx as {
    sessionManager?: {
      getSessionId?: () => unknown;
      getHeader?: () => unknown;
    };
    session?: {
      id?: unknown;
      sessionId?: unknown;
      getSessionId?: () => unknown;
    };
    sessionId?: unknown;
  } | null;
  const manager = record?.sessionManager;
  if (typeof manager?.getSessionId === "function") {
    try {
      const value = manager.getSessionId();
      if (typeof value === "string" && value.length > 0) return value;
    } catch {
      // Fall through to the immutable header and the session facade.
    }
  }
  if (typeof manager?.getHeader === "function") {
    try {
      const header = manager.getHeader() as { id?: unknown } | null;
      if (typeof header?.id === "string" && header.id.length > 0) return header.id;
    } catch {
      // Fall through.
    }
  }
  const session = record?.session;
  if (typeof session?.getSessionId === "function") {
    try {
      const value = session.getSessionId();
      if (typeof value === "string" && value.length > 0) return value;
    } catch {
      // Fall through.
    }
  }
  if (typeof session?.id === "string" && session.id.length > 0) return session.id;
  if (typeof session?.sessionId === "string" && session.sessionId.length > 0) return session.sessionId;
  if (typeof record?.sessionId === "string" && record.sessionId.length > 0) return record.sessionId;
  return undefined;
}

function nativeSessionId(event: unknown, ctx: unknown): string | undefined {
  const value = event as { session_id?: unknown; sessionId?: unknown } | null;
  if (typeof value?.session_id === "string") return value.session_id;
  if (typeof value?.sessionId === "string") return value.sessionId;
  return contextSessionId(ctx);
}

/**
 * Host-native upload ids. Pi's tool hooks carry `toolCallId` for every call,
 * including parallel calls that finish in the same millisecond, but no event
 * id. The kernel's event identity is (session, host_event, message/event id,
 * occurred_at); without a per-call id two `tool_result` uploads in one
 * millisecond share an identity key and the second is rejected as an
 * idempotency conflict — which leaves the tool call without its result and the
 * task `pending_tool` forever.
 *
 * `toolCallId` is the host's native identifier of exactly that tool event, so
 * it is uploaded as `event_id`. `host_event` still separates a call from its
 * result, and a repeated result of the same call is a genuine duplicate.
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
 * Host hook payloads are plain JS objects: Pi sets optional members to
 * `undefined`, which is not a JSON value and cannot be uploaded. Round-tripping
 * through JSON keeps the host's own wire representation (undefined members are
 * absent) without inventing or defaulting any field.
 */
function jsonPayload(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? {} : (JSON.parse(text) as unknown);
  } catch {
    return {};
  }
}

export default async function evoplugPiRuntime(pi: any): Promise<void> {
  const paths = artifactPaths(import.meta.url);
  const root = paths.root;
  const releaseLoad = claimRuntimeLoad(paths.config);
  if (releaseLoad === null) {
    // Pi can evaluate the same artifact twice (directory discovery plus an
    // explicit `settings.extensions` entry). One runtime owns the session.
    return;
  }
  const loaded = await loadHostRuntimeConfig(paths.config);
  if (!loaded.ok) { releaseLoad(); process.stderr.write(`evoplug runtime: config ${JSON.stringify(loaded.issue)}\n`); return; }

  let runtime: HostRuntime | null = null;
  /**
   * The last extension context seen by a hook. Runtime calls are delivered
   * inside `pollOnce`, which each hook calls with its own context; native
   * confirmation must use that same host surface (and must fail closed when
   * no dialog-capable context exists, as in print/json modes).
   */
  let activeContext: unknown = null;
  /**
   * Dialogs may only be rendered from the editor context. Post-turn hooks
   * (`agent_end`, `session_stop`) carry a context that resolves confirm/select
   * immediately without drawing anything, so confirmation probes use the last
   * input context and stay pending when no dialog surface exists.
   */
  let inputContext: unknown = null;

  const onCall = async (call: RuntimeCall): Promise<void> => {
    if (runtime === null) return;
    if (
      call.kind === "probe" &&
      call.request.probe_action === "confirm_human_event"
    ) {
      const confirm = nativeConfirmerFromUiContext(inputContext ?? activeContext);
      // A context without a dialog (a post-turn hook, or an interactive
      // session start before the editor is ready) answers `unsupported`
      // instead of leaving the call pending: an unresolved `issued` call
      // would block the next input boundary from arming the same candidate.
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
      const confirm = nativeConfirmerFromUiContext(dialogContext);
      const choose = nativeChooserFromHostContext(dialogContext);
      const askReason = nativeReasonAskerFromHostContext(dialogContext);
      // Same rule as the human-event probe: report `unsupported` from a
      // context that cannot draw so the call closes without consuming an ask,
      // and the next input boundary can arm it again.
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

  const startOptions = {
    config: loaded.config,
    hooks: {
      artifact_root: root,
      registration_hash: loaded.config.registration_hash,
      host_version: loaded.config.host_version ?? process.env["EVOPLUG_HOST_VERSION"] ?? "unknown",
      ephemeral: false,
      onCall,
      onError: (error: { code?: unknown; message?: unknown }) => {
        if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
          process.stderr.write(
            `evoplug runtime: ipc_error code=${String(error.code ?? "unknown")} message=${String(error.message ?? "")}\n`
          );
        }
      }
    }
  } as const;
  // A freshly started `serve` can still be finishing its startup probes when
  // the host launches; a socket connect then fails with `E_IO` for a few
  // seconds. Retry that transient case instead of leaving the session without
  // a runtime for its whole lifetime.
  let started = await startHostRuntime(startOptions);
  // A freshly started `serve` (or a session whose previous process just
  // exited) can refuse the first connection with `E_IO` for a few seconds.
  // Keep the retry window short enough that a short interactive session still
  // gets its first poll: a 30 s window used to outlive the whole session.
  for (let attempt = 0; attempt < 40 && !started.ok && started.error.code === "E_IO"; attempt += 1) {
    if (process.env["EVOPLUG_DEBUG_IPC"] === "1" && attempt === 0) {
      process.stderr.write("evoplug runtime: start_retry code=E_IO\n");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    started = await startHostRuntime(startOptions);
  }
  if (!started.ok) {
    releaseLoad();
    if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
      try {
        appendFileSync(
          process.env["EVOPLUG_RUNTIME_TRACE"] ?? join(tmpdir(), "evoplug-runtime-start.log"),
          `${JSON.stringify({ at: Date.now(), error: started.error, issues: started.issues })}\n`
        );
      } catch {
        // Trace only.
      }
    }
    process.stderr.write(`evoplug runtime: start ${JSON.stringify(started.error)} ${JSON.stringify(started.issues)}\n`);
    return;
  }
  runtime = started.runtime;

  const inflight = new Set<Promise<void>>();
  /**
   * Events that can arrive before the first `input`. The kernel cannot build a
   * task/branch scope until an input exists, so these are held in arrival order
   * and uploaded after the first input is accepted (Appendix F.1). The cache is
   * bounded; the oldest event is dropped first and the drop count is reported,
   * never silently discarded.
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
  /**
   * Every upload runs on one chain, so the first input is committed before any
   * cached observation that then needs its scope. Without the chain two hook
   * callbacks can race and the observation reaches the kernel first.
   */
  let uploadChain: Promise<unknown> = Promise.resolve();
  /**
   * The last `input` upload of each native session. A delivery is created from
   * the event that triggered the online pipeline, so the injection hook must
   * poll with the *input* boundary key, not with `before_agent_start`'s own
   * key. The entry is consumed when `before_agent_start` runs so a later run
   * without a new input cannot reuse a stale boundary.
   */
  const inputSubmissions = new Map<string, Promise<HostRuntimeSubmitOutcome | null>>();

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

  const dropOldestCached = (): void => {
    const dropped = preInputQueue.shift();
    if (dropped === undefined) return;
    preInputBytes -= cachedSize(dropped);
    preInputDropped += 1;
  };

  const reportCacheDrops = (): void => {
    if (preInputDropped === 0) return;
    process.stderr.write(
      `evoplug runtime: pre_input_cache_dropped count=${String(preInputDropped)}\n`
    );
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
      const task = enqueueUpload(
        entry.host_event,
        entry.event,
        entry.payload,
        entry.ctx,
        entry.received_at
      );
      void task.then((outcome) => reportOutcome(entry.host_event, outcome));
    }
    flushing = false;
  };

  const submit = (
    hostEvent: string,
    event: unknown,
    payload: unknown,
    ctx: unknown
  ): Promise<HostRuntimeSubmitOutcome | null> => {
    const sessionId = nativeSessionId(event, ctx);
    const receivedAt = Date.now();
    if (process.env["EVOPLUG_DEBUG_IPC"] === "1" && hostEvent === "session_start") {
      process.stderr.write(
        `evoplug runtime: session_start native_session_id=${sessionId === undefined ? "missing" : "present"} deferred=${String(!inputAccepted)}\n`
      );
    }
    if (!inputAccepted && OBSERVATION_EVENTS.has(hostEvent)) {
      const entry: CachedUpload = { host_event: hostEvent, event, payload, ctx, received_at: receivedAt };
      const size = cachedSize(entry);
      preInputQueue.push(entry);
      preInputBytes += size;
      while (
        (preInputQueue.length > PRE_INPUT_MAX_EVENTS || preInputBytes > PRE_INPUT_MAX_BYTES) &&
        preInputQueue.length > 0
      ) {
        dropOldestCached();
      }
      return Promise.resolve(null);
    }
    if (
      !inputAccepted &&
      (hostEvent === "session_shutdown" || hostEvent === "agent_end" || hostEvent === "agent_settled")
    ) {
      process.stderr.write(
        `evoplug runtime: skipped ${hostEvent} because no input established a session scope\n`
      );
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
    // A rejected upload is a visible service failure, not a silent drop. The
    // reason and field are the kernel's own verdict; printing them keeps the
    // host log actionable without opening the database.
    void task.then((outcome) => reportOutcome(hostEvent, outcome));
    return task;
  };

  /** Drains every queued upload before the runtime socket is closed. */
  const drain = async (): Promise<void> => {
    while (inflight.size > 0) {
      await Promise.allSettled([...inflight]);
    }
  };

  /**
   * G7: a short session may exit before `before_agent_start` polls. Every
   * boundary event flushes the backlog with its own receipt key so queued
   * probe calls are answered before the process exits.
   */
  const flushBacklog = async (hostEvent: string, event: unknown, ctx: unknown): Promise<void> => {
    const outcome = await submit(hostEvent, event, event, ctx);
    const key = (outcome?.receipt?.event_key ?? null) as Parameters<HostRuntime["pollOnce"]>[1];
    // A backlog flush must not start a long poll: the next hook (for example
    // `before_agent_start`) would then collide with it and read
    // `E_HOST_RUNTIME_BUSY`, so the confirmation probe never reaches the UI.
    let polled = await runtime?.pollOnce(hostEvent, key, 0);
    // Q.4.2: several pending candidates at one session start are asked in
    // creation order. Keep draining zero-wait calls until none is returned.
    for (let round = 0; round < 8 && polled?.ok === true && polled.call !== null; round += 1) {
      polled = await runtime?.pollOnce(hostEvent, key, 0);
    }
    if (
      process.env["EVOPLUG_DEBUG_IPC"] === "1" &&
      polled !== undefined &&
      !polled.ok
    ) {
      process.stderr.write(
        `evoplug runtime: poll_error hook=${hostEvent} code=${String(polled.error?.code ?? "unknown")}\n`
      );
    }
  };
  pi.on("session_start", (event: unknown, ctx: unknown) => { activeContext = ctx; void flushBacklog("session_start", event, ctx); });
  pi.on("input", (event: unknown, ctx: unknown) => { activeContext = ctx; inputContext = ctx; void submit("input", event, event, ctx); });
  pi.on("context", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("context", event, event, ctx); });
  pi.on("before_provider_request", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("before_provider_request", event, event, ctx); });
  pi.on("tool_call", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("tool_call", event, event, ctx); });
  pi.on("tool_result", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("tool_result", event, event, ctx); });
  pi.on("session_compact", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("session_compact", event, event, ctx); });
  pi.on("session_compact_failed", (event: unknown, ctx: unknown) => { activeContext = ctx; void submit("session_compact_failed", event, event, ctx); });
  pi.on("agent_end", (event: unknown, ctx: unknown) => { activeContext = ctx; void flushBacklog("agent_end", event, ctx); });
  pi.on("agent_settled", (event: unknown, ctx: unknown) => { activeContext = ctx; void flushBacklog("agent_settled", event, ctx); });
  pi.on("session_shutdown", async (event: unknown, ctx: unknown) => {
    activeContext = ctx;
    if (!inputAccepted && preInputQueue.length > 0) {
      // No input ever established a scope, so the cached observations cannot be
      // projected. Report them instead of dropping them silently.
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
    activeContext = ctx;
    // 1.2.0 and newer type this hook by the message being started. Only a
    // user turn is an injection point; agent/system turns are not.
    const messageType = (event as { messageType?: unknown } | null)?.messageType;
    if (typeof messageType === "string" && messageType !== "user") return undefined;
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
    // A concurrent hook poll is reported as `E_CONFLICT` (the runtime maps
    // `E_HOST_RUNTIME_BUSY` onto it). Retry briefly instead of dropping the
    // probe/candidate delivery for this turn.
    let outcome = await runtime?.pollOnce(
      hookEvent,
      eventKey as Parameters<HostRuntime["pollOnce"]>[1]
    );
    for (let attempt = 0; attempt < 2 && outcome !== undefined && !outcome.ok; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      outcome = await runtime?.pollOnce(
        hookEvent,
        eventKey as Parameters<HostRuntime["pollOnce"]>[1]
      );
    }
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
