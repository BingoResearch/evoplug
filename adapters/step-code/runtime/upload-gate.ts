/**
 * Session-scoped upload gate for the Step Code runtime.
 *
 * The kernel creates task scope from the first accepted `input` (appendix F.1).
 * Every other event that arrives before that point must wait, per native
 * session: the previous implementation used one boolean for the whole runtime,
 * so a second TUI session inherited the first session's accepted state and its
 * `before_agent_start`/tool events were uploaded without a scope and rejected
 * with `E_EVENT_SCOPE_UNBOUND`.
 *
 * The gate also owns the input-boundary FIFO. Rapid consecutive prompts push
 * one boundary per turn; `before_agent_start` must consume them in order
 * instead of reading a single map slot that the next prompt overwrites.
 */

export interface GateEntry {
  readonly host_event: string;
  readonly event: unknown;
  readonly payload: unknown;
  readonly ctx: unknown;
  readonly received_at: number;
}

/** JSON byte size used for the bounded pre-input cache. */
export function gateEntryBytes(entry: GateEntry): number {
  try {
    return Buffer.byteLength(
      JSON.stringify({ event: entry.event, payload: entry.payload }),
      "utf8"
    );
  } catch {
    return 1;
  }
}

export interface DeferResult {
  readonly buffered: boolean;
  /** Oldest entries discarded in this call because a limit was exceeded. */
  readonly dropped: number;
}

export class SessionUploadGate {
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  readonly #accepted = new Set<string>();
  readonly #queues = new Map<string, GateEntry[]>();
  readonly #bytes = new Map<string, number>();

  constructor(options: { readonly max_events: number; readonly max_bytes: number }) {
    this.#maxEvents = options.max_events;
    this.#maxBytes = options.max_bytes;
  }

  isAccepted(sessionId: string): boolean {
    return this.#accepted.has(sessionId);
  }

  queueDepth(sessionId: string): number {
    return this.#queues.get(sessionId)?.length ?? 0;
  }

  /**
   * Buffers an event until `accept` is called for the session. Returns
   * `buffered=false` when the session already has a scope, so the caller
   * uploads immediately.
   */
  defer(sessionId: string, entry: GateEntry): DeferResult {
    if (this.#accepted.has(sessionId)) {
      return { buffered: false, dropped: 0 };
    }
    const queue = this.#queues.get(sessionId) ?? [];
    queue.push(entry);
    let bytes = (this.#bytes.get(sessionId) ?? 0) + gateEntryBytes(entry);
    let dropped = 0;
    while ((queue.length > this.#maxEvents || bytes > this.#maxBytes) && queue.length > 0) {
      const oldest = queue.shift();
      if (oldest !== undefined) {
        bytes -= gateEntryBytes(oldest);
      }
      dropped += 1;
    }
    this.#queues.set(sessionId, queue);
    this.#bytes.set(sessionId, Math.max(0, bytes));
    return { buffered: true, dropped };
  }

  /**
   * Marks the session as scoped and returns its buffered events in arrival
   * order. The first accepted input is uploaded before these entries, which is
   * the order appendix F.1 requires.
   */
  accept(sessionId: string): readonly GateEntry[] {
    this.#accepted.add(sessionId);
    const queued = this.#queues.get(sessionId) ?? [];
    this.#queues.delete(sessionId);
    this.#bytes.delete(sessionId);
    return queued;
  }

  /** Drops a session that never established scope (e.g. shutdown without input). */
  discard(sessionId: string): number {
    const queued = this.#queues.get(sessionId)?.length ?? 0;
    this.#queues.delete(sessionId);
    this.#bytes.delete(sessionId);
    return queued;
  }
}

/** FIFO of input-boundary uploads, one queue per native session. */
export class InputBoundaryQueue<T> {
  readonly #queues = new Map<string, T[]>();

  push(sessionId: string, item: T): void {
    const queue = this.#queues.get(sessionId) ?? [];
    queue.push(item);
    this.#queues.set(sessionId, queue);
  }

  shift(sessionId: string): T | undefined {
    const queue = this.#queues.get(sessionId);
    if (queue === undefined) {
      return undefined;
    }
    const item = queue.shift();
    if (queue.length === 0) {
      this.#queues.delete(sessionId);
    }
    return item;
  }

  depth(sessionId: string): number {
    return this.#queues.get(sessionId)?.length ?? 0;
  }
}

/**
 * The host's native id of one tool event. Step 0.1.5 identifies tool events by
 * `toolCallId` (both the `tool_call`/`tool_result` pair and the
 * `tool_execution_*` pair). Without it, two tool events in the same millisecond
 * share the kernel event identity and the second is rejected as an
 * idempotency conflict.
 */
export function toolCallNativeId(hostEvent: string, event: unknown): string | undefined {
  if (hostEvent !== "tool_call" && hostEvent !== "tool_result") {
    return undefined;
  }
  const record = event as { toolCallId?: unknown; tool_call_id?: unknown } | null;
  const value =
    typeof record?.toolCallId === "string"
      ? record.toolCallId
      : typeof record?.tool_call_id === "string"
        ? record.tool_call_id
        : undefined;
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Suppresses the second delivery of the same tool phase when Step exposes one
 * tool activity through both its Pi-compatible pair (`tool_call`/
 * `tool_result`) and the agent loop pair (`tool_execution_*`). The canonical
 * pair arrives first for calls and carries the richer result payload.
 */
export class ToolPhaseDeduper {
  readonly #seen = new Map<string, Set<string>>();

  /** True when this (session, phase, call id) was already uploaded. */
  seen(sessionId: string, hostEvent: string, event: unknown): boolean {
    const phase = hostEvent === "tool_call" ? "call" : hostEvent === "tool_result" ? "result" : null;
    if (phase === null) {
      return false;
    }
    const callId = toolCallNativeId(hostEvent, event);
    if (callId === undefined) {
      return false;
    }
    const key = `${phase}\u0000${callId}`;
    const session = this.#seen.get(sessionId) ?? new Set<string>();
    if (session.has(key)) {
      return true;
    }
    session.add(key);
    this.#seen.set(sessionId, session);
    return false;
  }
}
