/**
 * Typed fault injection points (testing design TST 5.1).
 *
 * A `FaultRegistry` is an ordinary object owned by one test. It never uses
 * module-global mutable state, so parallel cases in the same process cannot
 * see each other's faults. The registry only decides *which* action applies
 * and counts occurrences; executing a kill, hang or disconnect belongs to the
 * harness that owns the process, socket or fake host.
 */

export type FaultPoint =
  | "blob.after_write_before_fsync"
  | "blob.after_fsync"
  | "journal.after_append_before_fsync"
  | "journal.after_fsync"
  | "sqlite.after_commit_before_ack"
  | "ack.before_return"
  | "ipc.after_send"
  | "queue.enqueue"
  | "gateway.after_send"
  | "delivery.before_host"
  | "delivery.after_host_accept_before_record"
  | "write.before_replace"
  | "write.after_replace"
  | "reader.slow"
  | "fs.enospc"
  | "sqlite.busy"
  | "process.kill";

export type FaultTarget =
  | "blob"
  | "journal"
  | "sqlite"
  | "ack"
  | "ipc"
  | "queue"
  | "gateway"
  | "delivery"
  | "write"
  | "reader";

export type FaultAction =
  | { readonly kind: "kill"; readonly signal: "SIGKILL" }
  | { readonly kind: "throw"; readonly error_code: string }
  | { readonly kind: "errno"; readonly errno: "EIO" | "ENOSPC" }
  | { readonly kind: "hang"; readonly duration_ms: number }
  | { readonly kind: "block"; readonly duration_ms: number }
  | {
      readonly kind: "reject";
      readonly error_code: "E_OVERLOAD";
      readonly retry_after_ms: number;
    }
  | { readonly kind: "disconnect" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "reorder"; readonly delay_ms: number }
  | { readonly kind: "timeout"; readonly duration_ms: number }
  | { readonly kind: "http"; readonly status: 429 | 500 }
  | { readonly kind: "conflict"; readonly error_code: string }
  | { readonly kind: "lock"; readonly duration_ms: number }
  | { readonly kind: "backpressure"; readonly duration_ms: number };

export interface FaultSpec {
  readonly point: FaultPoint;
  readonly action: FaultAction;
  /**
   * 1-based call index at which the action applies. When omitted, the action
   * applies on every call to `trigger` for that point. A stress case that must
   * fail exactly once uses `occurrence: 1`.
   */
  readonly occurrence?: number;
  readonly target?: FaultTarget;
}

/** Guard used by boundary code that receives a plain string point name. */
export const FAULT_POINTS: readonly FaultPoint[] = [
  "blob.after_write_before_fsync",
  "blob.after_fsync",
  "journal.after_append_before_fsync",
  "journal.after_fsync",
  "sqlite.after_commit_before_ack",
  "ack.before_return",
  "ipc.after_send",
  "queue.enqueue",
  "gateway.after_send",
  "delivery.before_host",
  "delivery.after_host_accept_before_record",
  "write.before_replace",
  "write.after_replace",
  "reader.slow",
  "fs.enospc",
  "sqlite.busy",
  "process.kill"
];

const FAULT_POINT_SET: ReadonlySet<string> = new Set(FAULT_POINTS);

export function isFaultPoint(value: string): value is FaultPoint {
  return FAULT_POINT_SET.has(value);
}

/** Raised by `FaultRegistry.triggerOrThrow` for throw/conflict actions. */
export class FaultInjectionError extends Error {
  readonly point: FaultPoint;
  readonly errorCode: string;
  readonly action: FaultAction;

  constructor(point: FaultPoint, errorCode: string, action: FaultAction) {
    super(`${point}: injected ${action.kind} (${errorCode})`);
    this.name = "FaultInjectionError";
    this.point = point;
    this.errorCode = errorCode;
    this.action = action;
  }
}

interface FaultRegistration {
  readonly spec: FaultSpec;
}

function assertDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number, received ${String(value)}`);
  }
}

function validateAction(action: FaultAction): void {
  switch (action.kind) {
    case "hang":
    case "block":
    case "timeout":
    case "lock":
    case "backpressure":
      assertDuration(action.duration_ms, `${action.kind}.duration_ms`);
      return;
    case "reorder":
      assertDuration(action.delay_ms, "reorder.delay_ms");
      return;
    case "reject":
      assertDuration(action.retry_after_ms, "reject.retry_after_ms");
      return;
    case "throw":
    case "conflict":
      if (action.error_code.length === 0) {
        throw new RangeError(`${action.kind}.error_code must be non-empty`);
      }
      return;
    case "kill":
    case "errno":
    case "disconnect":
    case "duplicate":
    case "http":
      return;
  }
}

function validateSpec(spec: FaultSpec): void {
  if (!isFaultPoint(spec.point)) {
    throw new RangeError(`unknown fault point ${JSON.stringify(spec.point)}`);
  }
  if (spec.occurrence !== undefined) {
    if (!Number.isSafeInteger(spec.occurrence) || spec.occurrence < 1) {
      throw new RangeError(
        `occurrence must be a positive safe integer, received ${String(spec.occurrence)}`
      );
    }
  }
  validateAction(spec.action);
}

/**
 * Per-test fault registry.
 *
 * Registration order decides which spec wins when several specs target the
 * same point at the same occurrence. `trigger` always increments the point's
 * call counter, whether or not a spec matches, so `occurrence` stays stable.
 */
export class FaultRegistry {
  private readonly registrations: Map<FaultPoint, FaultRegistration[]>;
  private readonly counts: Map<FaultPoint, number>;

  constructor() {
    this.registrations = new Map<FaultPoint, FaultRegistration[]>();
    this.counts = new Map<FaultPoint, number>();
  }

  /**
   * Registers a fault and returns an idempotent unregister function. The
   * unregister function does not reset the point's call counter.
   */
  register(spec: FaultSpec): () => void {
    validateSpec(spec);
    const existing = this.registrations.get(spec.point);
    const registration: FaultRegistration = { spec };
    if (existing === undefined) {
      this.registrations.set(spec.point, [registration]);
    } else {
      existing.push(registration);
    }
    let active = true;
    return (): void => {
      if (!active) {
        return;
      }
      active = false;
      const current = this.registrations.get(spec.point);
      if (current === undefined) {
        return;
      }
      const index = current.indexOf(registration);
      if (index >= 0) {
        current.splice(index, 1);
      }
      if (current.length === 0) {
        this.registrations.delete(spec.point);
      }
    };
  }

  /**
   * Advances the point's call counter and returns the action to apply, or
   * `undefined` when no spec matches this occurrence. No side effect is
   * performed beyond counting.
   */
  trigger(point: FaultPoint): FaultAction | undefined {
    const count = (this.counts.get(point) ?? 0) + 1;
    this.counts.set(point, count);
    const registrations = this.registrations.get(point);
    if (registrations === undefined) {
      return undefined;
    }
    for (const registration of registrations) {
      const occurrence = registration.spec.occurrence;
      if (occurrence === undefined || occurrence === count) {
        return registration.spec.action;
      }
    }
    return undefined;
  }

  /**
   * Like `trigger`, but throws `FaultInjectionError` for `throw` and
   * `conflict` actions. Kill/hang/disconnect actions are returned unchanged
   * for the harness to execute.
   */
  triggerOrThrow(point: FaultPoint): FaultAction | undefined {
    const action = this.trigger(point);
    if (action === undefined) {
      return undefined;
    }
    if (action.kind === "throw" || action.kind === "conflict") {
      throw new FaultInjectionError(point, action.error_code, action);
    }
    return action;
  }

  /** Number of calls observed for `point`. */
  count(point: FaultPoint): number {
    return this.counts.get(point) ?? 0;
  }

  /** Number of specs currently armed for `point`. */
  armed(point: FaultPoint): number {
    return this.registrations.get(point)?.length ?? 0;
  }

  /**
   * Clears registrations and counters. With a point, only that point is
   * cleared; without one, the whole registry is reset.
   */
  clear(point?: FaultPoint): void {
    if (point === undefined) {
      this.registrations.clear();
      this.counts.clear();
      return;
    }
    this.registrations.delete(point);
    this.counts.delete(point);
  }
}

/** Creates an independent fault registry. */
export function createFaultRegistry(): FaultRegistry {
  return new FaultRegistry();
}
