/**
 * In-memory admission control and resource statistics (DD-FND-103,
 * TST LOAD §2.3).
 *
 * The admission order is fixed and each step short-circuits:
 *
 *   1. schema / subject-policy mismatch → `E_SCHEMA` or `E_VERSION_BINDING`,
 *      and no decision is produced;
 *   2. `now >= min(deadline_mono_ms, enqueued_at_mono_ms + admission_deadline_ms)`
 *      → `E_DEADLINE_EXCEEDED`, and no capacity check runs;
 *   3. `depth + inflight >= queue_capacity` → the reject branch returns
 *      `E_OVERLOAD` with `retry_after_ms = policy.retry_after_ms`; the block
 *      branch waits for capacity or the deadline and returns
 *      `E_DEADLINE_EXCEEDED` when the deadline arrives first or together
 *      with the release;
 *   4. everything else is `admitted`.
 *
 * The queue counters obey
 * `admitted_total = completed_total + failed_total + timed_out_total + depth + inflight`.
 * `rejected_total` counts only `E_OVERLOAD`, `deadline_rejected_total` counts
 * only the pre-admission deadline and `timed_out_total` counts only the
 * post-admission deadline.
 */

import { randomBytes } from "node:crypto";

import type { ErrorEnvelope } from "../errors.js";
import { makeErrorEnvelope } from "../errors.js";
import { isId } from "../ids.js";
import type { Result } from "../result.js";
import { err, ok } from "../result.js";
import type {
  AdmissionDecision,
  AdmissionPort,
  AdmissionRequest,
  AdmissionSubject,
  IoStats,
  OverloadPolicy,
  ProcessStats,
  QueueStats,
  ResourceStatsPort,
  ResourceStatsRequest,
  ResourceStatsSnapshot,
  StorageStats
} from "../ports/admission.js";
import {
  ADMISSION_DECISION_SCHEMA_VERSION,
  ADMISSION_REQUEST_SCHEMA_VERSION,
  RESOURCE_STATS_REQUEST_SCHEMA_VERSION,
  RESOURCE_STATS_SNAPSHOT_SCHEMA_VERSION
} from "../ports/admission.js";
import type { FrozenOverloadPolicy } from "./policy.js";
import { OverloadPolicyRegistry } from "./policy.js";

/** The subject kind each policy scope admits. */
const SCOPE_SUBJECT_KIND: Readonly<Record<OverloadPolicy["scope"], AdmissionSubject["kind"]>> =
  Object.freeze({
    ingress: "event",
    delivery: "delivery"
  });

/** The scope each subject kind is admitted under. */
function scopeForSubject(
  subject: AdmissionSubject
): OverloadPolicy["scope"] {
  return subject.kind === "event" ? "ingress" : "delivery";
}

/** Minimal monotonic clock surface the ports need. */
export interface MonotonicClock {
  /** Monotonic milliseconds; only differences between readings matter. */
  nowMonoMs(): number;
}

/** A clock backed by `performance.now()`. */
function createMonotonicClock(): MonotonicClock {
  return Object.freeze({
    nowMonoMs(): number {
      return performance.now();
    }
  });
}

/**
 * Deferred-callback scheduler. The default implementation uses the platform
 * timer; a test injects a manual scheduler to drive deadlines without
 * sleeping.
 */
interface AdmissionScheduler {
  /** Runs `callback` after `delayMs`; the returned function cancels it. */
  schedule(delayMs: number, callback: () => void): () => void;
}

/** The default scheduler: platform timers, never kept alive by the queue. */
function createDefaultScheduler(): AdmissionScheduler {
  return Object.freeze({
    schedule(delayMs: number, callback: () => void): () => void {
      const timer = setTimeout(callback, delayMs);
      if (typeof timer === "object" && timer !== null && "unref" in timer) {
        timer.unref();
      }
      return (): void => {
        clearTimeout(timer);
      };
    }
  });
}

/** Terminal state of an admitted subject. */
type AdmissionCompletion = "completed" | "failed" | "timed_out";

interface AdmissionRuntimeOptions {
  readonly policies: readonly OverloadPolicy[];
  readonly clock?: MonotonicClock;
  readonly scheduler?: AdmissionScheduler;
}

/**
 * The queue model. `depth` counts subjects that are admitted but not started;
 * `inflight` counts subjects that are being processed.
 */
class AdmissionQueue {
  #queued = 0;

  #inflight = 0;

  #admittedTotal = 0;

  #rejectedTotal = 0;

  #deadlineRejectedTotal = 0;

  #completedTotal = 0;

  #failedTotal = 0;

  #timedOutTotal = 0;

  get depth(): number {
    return this.#queued;
  }

  get inflight(): number {
    return this.#inflight;
  }

  get admitted_total(): number {
    return this.#admittedTotal;
  }

  get rejected_total(): number {
    return this.#rejectedTotal;
  }

  get deadline_rejected_total(): number {
    return this.#deadlineRejectedTotal;
  }

  get completed_total(): number {
    return this.#completedTotal;
  }

  get failed_total(): number {
    return this.#failedTotal;
  }

  get timed_out_total(): number {
    return this.#timedOutTotal;
  }

  /** Admits a subject that can start immediately. */
  admitToInflight(): void {
    this.#inflight += 1;
    this.#admittedTotal += 1;
  }

  /** Admits a subject that has to wait for a processing slot. */
  admitToQueue(): void {
    this.#queued += 1;
    this.#admittedTotal += 1;
  }

  /** Moves one waiting subject into the processing set. */
  startQueued(): boolean {
    if (this.#queued === 0) {
      return false;
    }
    this.#queued -= 1;
    this.#inflight += 1;
    return true;
  }

  /** Records a capacity rejection (`E_OVERLOAD` only). */
  rejectOverload(): void {
    this.#rejectedTotal += 1;
  }

  /** Records a pre-admission deadline rejection. */
  rejectDeadline(): void {
    this.#deadlineRejectedTotal += 1;
  }

  /** Records the terminal outcome of an in-flight subject. */
  complete(outcome: AdmissionCompletion): void {
    if (this.#inflight > 0) {
      this.#inflight -= 1;
    }
    if (outcome === "completed") {
      this.#completedTotal += 1;
    } else if (outcome === "failed") {
      this.#failedTotal += 1;
    } else {
      this.#timedOutTotal += 1;
    }
  }

  /**
   * `admitted_total = completed_total + failed_total + timed_out_total + depth + inflight`.
   * The identity holds in every observable state of the queue.
   */
  stats(capacity: number, maxInflight: number, overflow: OverloadPolicy["overflow"]): QueueStats {
    return {
      depth: this.#queued,
      capacity,
      inflight: this.#inflight,
      max_inflight: maxInflight,
      overflow,
      admitted_total: this.#admittedTotal,
      rejected_total: this.#rejectedTotal,
      deadline_rejected_total: this.#deadlineRejectedTotal,
      completed_total: this.#completedTotal,
      failed_total: this.#failedTotal,
      timed_out_total: this.#timedOutTotal
    };
  }
}

interface CapacityWaiter {
  resolve(): void;
}

/**
 * The full outcome of one admission. A rejected request still carries its
 * `AdmissionDecision` — the decision names the rejection branch and the
 * retry hint. Only the schema and binding failures carry no decision, which
 * matches "两种失败都不产生 `AdmissionDecision`".
 */
interface AdmissionOutcome {
  readonly ok: boolean;
  readonly decision: AdmissionDecision | null;
  readonly error: ErrorEnvelope | null;
}

/**
 * The shared runtime behind the admission and statistics ports: the frozen
 * policy registry, one queue per scope and the blocked-admission waiters.
 */
class AdmissionRuntime {
  readonly registry: OverloadPolicyRegistry;

  readonly #clock: MonotonicClock;

  readonly #scheduler: AdmissionScheduler;

  readonly #queues: Map<OverloadPolicy["scope"], AdmissionQueue>;

  readonly #waiters: Map<OverloadPolicy["scope"], Set<CapacityWaiter>>;

  constructor(options: AdmissionRuntimeOptions) {
    this.registry = new OverloadPolicyRegistry(options.policies);
    this.#clock = options.clock ?? createMonotonicClock();
    this.#scheduler = options.scheduler ?? createDefaultScheduler();
    this.#queues = new Map();
    this.#waiters = new Map();
    for (const frozen of this.registry.all()) {
      this.#queues.set(frozen.policy.scope, new AdmissionQueue());
      this.#waiters.set(frozen.policy.scope, new Set());
    }
  }

  get clock(): MonotonicClock {
    return this.#clock;
  }

  /** The queue of one scope; `null` when the scope has no frozen policy. */
  queue(scope: OverloadPolicy["scope"]): AdmissionQueue | null {
    return this.#queues.get(scope) ?? null;
  }

  /** The frozen policy of a scope. */
  frozenPolicy(scope: OverloadPolicy["scope"]): FrozenOverloadPolicy | null {
    return this.registry.byScope(scope);
  }

  /**
   * The full outcome of one admission. A rejected request still carries its
   * `AdmissionDecision`; only the schema and binding failures carry none.
   */
  async decide(input: AdmissionRequest): Promise<AdmissionOutcome> {
    const requestError = validateAdmissionRequest(input);
    if (requestError !== null) {
      return { ok: false, decision: null, error: requestError };
    }

    const frozen = this.registry.byVersion(input.policy_version);
    if (frozen === null) {
      return { ok: false, decision: null, error: this.#bindingError(input) };
    }
    const active = this.registry.byScope(frozen.policy.scope);
    if (active === null || active.policy.policy_version !== frozen.policy.policy_version) {
      return { ok: false, decision: null, error: this.#bindingError(input) };
    }
    if (SCOPE_SUBJECT_KIND[frozen.policy.scope] !== input.subject.kind) {
      return {
        ok: false,
        decision: null,
        error: makeErrorEnvelope({
          code: "E_VERSION_BINDING",
          category: "version",
          message_key: "error.version.binding",
          stage: "admission",
          details: {
            kind: "version",
            expected: frozen.policy.scope,
            actual: input.subject.kind
          }
        })
      };
    }

    const policy = frozen.policy;
    const queue = this.#queues.get(policy.scope);
    if (queue === undefined) {
      return { ok: false, decision: null, error: this.#bindingError(input) };
    }

    const deadline = effectiveDeadlineMonoMs(input, policy);
    const now = this.#clock.nowMonoMs();

    // Step 2: the deadline check precedes every capacity check.
    if (now >= deadline) {
      queue.rejectDeadline();
      const decision = this.#rejectedDecision(
        input.subject,
        "E_DEADLINE_EXCEEDED",
        null,
        policy,
        queue
      );
      return { ok: false, decision, error: deadlineError() };
    }

    // Step 3: the capacity check.
    if (queue.depth + queue.inflight >= policy.queue_capacity) {
      if (policy.overflow === "reject") {
        queue.rejectOverload();
        const decision = this.#rejectedDecision(
          input.subject,
          "E_OVERLOAD",
          policy.retry_after_ms,
          policy,
          queue
        );
        return {
          ok: false,
          decision,
          error: overloadError(decision, policy.retry_after_ms)
        };
      }
      const released = await this.#awaitCapacity(policy, queue, deadline);
      if (!released) {
        queue.rejectDeadline();
        const decision = this.#rejectedDecision(
          input.subject,
          "E_DEADLINE_EXCEEDED",
          null,
          policy,
          queue
        );
        return { ok: false, decision, error: deadlineError() };
      }
    }

    // Step 4: admitted. The subject enters the processing set when a slot is
    // free and waits in the queue otherwise; the decision reports the queue
    // state after the admission, so the conservation identity already holds.
    if (queue.inflight < policy.max_inflight) {
      queue.admitToInflight();
    } else {
      queue.admitToQueue();
    }
    const decision = this.#admittedDecision(input.subject, policy, queue);
    return { ok: true, decision, error: null };
  }

  /**
   * Waits for a capacity release or for the deadline. Returns false when the
   * deadline wins, including the tie case in which the release and the
   * deadline coincide.
   */
  async #awaitCapacity(
    policy: OverloadPolicy,
    queue: AdmissionQueue,
    deadline: number
  ): Promise<boolean> {
    for (;;) {
      if (this.#clock.nowMonoMs() >= deadline) {
        return false;
      }
      if (queue.depth + queue.inflight < policy.queue_capacity) {
        return true;
      }
      const released = await this.#waitForSignal(policy.scope, deadline);
      if (!released) {
        return false;
      }
    }
  }

  /**
   * Resolves true when a capacity release was signalled and false when the
   * deadline timer fired first.
   */
  #waitForSignal(scope: OverloadPolicy["scope"], deadline: number): Promise<boolean> {
    const waiters = this.#waiters.get(scope);
    if (waiters === undefined) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let cancel: (() => void) | null = null;
      let waiter: CapacityWaiter | undefined = undefined;
      const finish = (released: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (cancel !== null) {
          cancel();
        }
        if (waiter !== undefined) {
          waiters.delete(waiter);
        }
        resolve(released);
      };
      waiter = { resolve: (): void => finish(true) };
      waiters.add(waiter);
      cancel = this.#scheduler.schedule(
        Math.max(0, deadline - this.#clock.nowMonoMs()),
        (): void => finish(false)
      );
    });
  }

  /**
   * Releases one in-flight slot of a scope and wakes one blocked admission.
   * This is the capacity release the block branch waits for.
   */
  releaseCapacity(scope: OverloadPolicy["scope"], outcome: AdmissionCompletion = "completed"): void {
    const queue = this.#queues.get(scope);
    if (queue === undefined) {
      return;
    }
    queue.complete(outcome);
    const waiters = this.#waiters.get(scope);
    if (waiters === undefined || waiters.size === 0) {
      return;
    }
    const next = waiters.values().next();
    if (next.done !== true) {
      waiters.delete(next.value);
      next.value.resolve();
    }
  }

  /** Moves one waiting subject of a scope into the processing set. */
  startQueued(scope: OverloadPolicy["scope"]): boolean {
    const queue = this.#queues.get(scope);
    if (queue === undefined) {
      return false;
    }
    return queue.startQueued();
  }

  #bindingError(input: AdmissionRequest): ErrorEnvelope {
    const scope = scopeForSubject(input.subject);
    const active = this.registry.byScope(scope);
    return makeErrorEnvelope({
      code: "E_VERSION_BINDING",
      category: "version",
      message_key: "error.version.binding",
      stage: "admission",
      details: {
        kind: "version",
        expected: active?.policy.policy_version ?? "",
        actual: input.policy_version
      }
    });
  }

  #admittedDecision(
    subject: AdmissionSubject,
    policy: OverloadPolicy,
    queue: AdmissionQueue
  ): AdmissionDecision {
    return {
      schema_version: ADMISSION_DECISION_SCHEMA_VERSION,
      subject,
      outcome: "admitted",
      code: null,
      retry_after_ms: null,
      policy_version: policy.policy_version,
      queue_depth: queue.depth,
      queue_capacity: policy.queue_capacity,
      inflight: queue.inflight,
      max_inflight: policy.max_inflight,
      decided_at_mono_ms: this.#clock.nowMonoMs()
    };
  }

  #rejectedDecision(
    subject: AdmissionSubject,
    code: "E_OVERLOAD" | "E_DEADLINE_EXCEEDED",
    retryAfterMs: number | null,
    policy: OverloadPolicy,
    queue: AdmissionQueue
  ): AdmissionDecision {
    return {
      schema_version: ADMISSION_DECISION_SCHEMA_VERSION,
      subject,
      outcome: "rejected",
      code,
      retry_after_ms: retryAfterMs,
      policy_version: policy.policy_version,
      queue_depth: queue.depth,
      queue_capacity: policy.queue_capacity,
      inflight: queue.inflight,
      max_inflight: policy.max_inflight,
      decided_at_mono_ms: this.#clock.nowMonoMs()
    };
  }
}

/**
 * `effective_deadline_mono_ms = min(deadline_mono_ms, enqueued_at_mono_ms + admission_deadline_ms)`.
 * The addition saturates at `Number.MAX_SAFE_INTEGER`.
 */
export function effectiveDeadlineMonoMs(
  request: Pick<AdmissionRequest, "enqueued_at_mono_ms" | "deadline_mono_ms">,
  policy: Pick<OverloadPolicy, "admission_deadline_ms">
): number {
  const sum = request.enqueued_at_mono_ms + policy.admission_deadline_ms;
  const saturated = Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
  return Math.min(request.deadline_mono_ms, saturated);
}

/** Structural gate for an admission request; `null` when the request is valid. */
function validateAdmissionRequest(input: AdmissionRequest): ErrorEnvelope | null {
  if (input.schema_version !== ADMISSION_REQUEST_SCHEMA_VERSION) {
    return schemaError("schema_version", "const");
  }
  if (!isAdmissionSubject(input.subject)) {
    return schemaError("subject", "admission_subject_shape");
  }
  if (!isNonNegativeSafeInteger(input.enqueued_at_mono_ms)) {
    return schemaError("enqueued_at_mono_ms", "non_negative_safe_integer");
  }
  if (!isNonNegativeSafeInteger(input.deadline_mono_ms)) {
    return schemaError("deadline_mono_ms", "non_negative_safe_integer");
  }
  if (typeof input.policy_version !== "string" || input.policy_version.length === 0) {
    return schemaError("policy_version", "non_empty_string");
  }
  return null;
}

interface AdmissionPortOptions {
  readonly policies: readonly OverloadPolicy[];
  readonly clock?: MonotonicClock;
  readonly scheduler?: AdmissionScheduler;
  /** An existing runtime to share with the statistics port. */
  readonly runtime?: AdmissionRuntime;
}

/**
 * The in-memory admission port. It owns one queue per scope, so an ingress
 * request never competes with a delivery request for capacity.
 */
export class InMemoryAdmissionPort implements AdmissionPort {
  readonly runtime: AdmissionRuntime;

  constructor(options: AdmissionPortOptions) {
    this.runtime =
      options.runtime ??
      new AdmissionRuntime({
        policies: options.policies,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler })
      });
  }

  /** The frozen policy registry backing this port. */
  get policies(): OverloadPolicyRegistry {
    return this.runtime.registry;
  }

  /** The queue of one scope. */
  queue(scope: OverloadPolicy["scope"]): AdmissionQueue | null {
    return this.runtime.queue(scope);
  }

  /**
   * The admission decision of one request. Schema and binding failures
   * return no decision; every other path produces one.
   */
  async decide(input: AdmissionRequest): Promise<AdmissionOutcome> {
    return this.runtime.decide(input);
  }

  async admit(input: AdmissionRequest): Promise<Result<AdmissionDecision, ErrorEnvelope>> {
    const outcome = await this.runtime.decide(input);
    if (outcome.ok && outcome.decision !== null) {
      return ok(outcome.decision);
    }
    return err(outcome.error ?? deadlineError());
  }

  /** Releases one in-flight slot and wakes one blocked admission. */
  releaseCapacity(scope: OverloadPolicy["scope"], outcome: AdmissionCompletion = "completed"): void {
    this.runtime.releaseCapacity(scope, outcome);
  }

  /** Moves one waiting subject into the processing set. */
  startQueued(scope: OverloadPolicy["scope"]): boolean {
    return this.runtime.startQueued(scope);
  }
}

/** What the resource-statistics port reports about the process. */
interface ProcessProbe {
  rss_bytes(): number;
  fd_count(): number;
  child_process_count(): number;
  /** `null` when the thread count is unobtainable; never `0`. */
  thread_count(): number | null;
  cpu_user_ms(): number;
  cpu_system_ms(): number;
}

/** What the resource-statistics port reports about storage. */
interface StorageProbe {
  journal_bytes(): number;
  sqlite_wal_bytes(): number;
  blob_bytes(): number;
  blob_count(): number;
  quarantine_count(): number;
}

/**
 * What the resource-statistics port reports about I/O. A probe that cannot
 * read a counter reports `null` for it, never `0`; the whole `io` axis is
 * then `null`.
 */
interface IoProbe {
  read_bytes(): number | null;
  write_bytes(): number | null;
  fsync_count(): number | null;
}

interface ResourceStatsPortOptions {
  readonly policies: readonly OverloadPolicy[];
  readonly clock?: MonotonicClock;
  readonly scheduler?: AdmissionScheduler;
  /** An existing runtime to share with the admission port. */
  readonly runtime?: AdmissionRuntime;
  /** The scope whose queue the snapshot reports. */
  readonly scope?: OverloadPolicy["scope"];
  /** Stable id of this process instance; a restart must change it. */
  readonly process_instance_id?: string;
  readonly process_probe?: ProcessProbe;
  readonly storage_probe?: StorageProbe;
  readonly io_probe?: IoProbe;
}

/**
 * The in-memory resource-statistics port. The read is observation only: it
 * never enqueues, never dequeues, never writes a journal frame, never takes a
 * SQLite write lock and never triggers a GC or an fsync.
 */
export class InMemoryResourceStatsPort implements ResourceStatsPort {
  readonly runtime: AdmissionRuntime;

  readonly #scope: OverloadPolicy["scope"];

  readonly #processInstanceId: string;

  readonly #processProbe: ProcessProbe | null;

  readonly #storageProbe: StorageProbe | null;

  readonly #ioProbe: IoProbe | null;

  #sampleSeq = 0;

  constructor(options: ResourceStatsPortOptions) {
    this.runtime =
      options.runtime ??
      new AdmissionRuntime({
        policies: options.policies,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler })
      });
    this.#scope = options.scope ?? "ingress";
    this.#processInstanceId = options.process_instance_id ?? newProcessInstanceId();
    this.#processProbe = options.process_probe ?? null;
    this.#storageProbe = options.storage_probe ?? null;
    this.#ioProbe = options.io_probe ?? null;
  }

  /** The queue whose counters the snapshot reports. */
  get queue(): AdmissionQueue | null {
    return this.runtime.queue(this.#scope);
  }

  async read(input: ResourceStatsRequest): Promise<Result<ResourceStatsSnapshot, ErrorEnvelope>> {
    const requestError = validateResourceStatsRequest(input);
    if (requestError !== null) {
      return err(requestError);
    }

    const startedAt = this.runtime.clock.nowMonoMs();
    const snapshot = this.#sample(new Set(input.include));
    if (this.runtime.clock.nowMonoMs() - startedAt > input.timeout_ms) {
      // A timeout yields the deadline code and no partial snapshot. The
      // sample sequence still advances, so the next successful read reports
      // a strictly larger sequence number.
      return err(deadlineError());
    }
    return ok(snapshot);
  }

  #sample(axes: ReadonlySet<string>): ResourceStatsSnapshot {
    this.#sampleSeq += 1;
    const frozen = this.runtime.frozenPolicy(this.#scope);
    const policy = frozen?.policy ?? null;
    const queue = this.runtime.queue(this.#scope);
    return {
      schema_version: RESOURCE_STATS_SNAPSHOT_SCHEMA_VERSION,
      process_instance_id: this.#processInstanceId,
      sample_seq: this.#sampleSeq,
      sampled_at_mono_ms: this.runtime.clock.nowMonoMs(),
      policy_version: policy?.policy_version ?? "",
      queue:
        axes.has("queue") && queue !== null && policy !== null
          ? queue.stats(policy.queue_capacity, policy.max_inflight, policy.overflow)
          : null,
      process: axes.has("process") ? this.#readProcess() : null,
      storage: axes.has("storage") ? this.#readStorage() : null,
      io: axes.has("io") ? this.#readIo() : null
    };
  }

  #readProcess(): ProcessStats | null {
    const probe = this.#processProbe;
    if (probe === null) {
      return null;
    }
    return {
      rss_bytes: probe.rss_bytes(),
      fd_count: probe.fd_count(),
      child_process_count: probe.child_process_count(),
      thread_count: probe.thread_count(),
      cpu_user_ms: probe.cpu_user_ms(),
      cpu_system_ms: probe.cpu_system_ms()
    };
  }

  #readStorage(): StorageStats | null {
    const probe = this.#storageProbe;
    if (probe === null) {
      return null;
    }
    return {
      journal_bytes: probe.journal_bytes(),
      sqlite_wal_bytes: probe.sqlite_wal_bytes(),
      blob_bytes: probe.blob_bytes(),
      blob_count: probe.blob_count(),
      quarantine_count: probe.quarantine_count()
    };
  }

  /**
   * The `io` axis is all-or-nothing: when any counter is unobtainable the
   * whole axis reads back as `null`, never as a partial counter set.
   */
  #readIo(): IoStats | null {
    const probe = this.#ioProbe;
    if (probe === null) {
      return null;
    }
    const readBytes = probe.read_bytes();
    const writeBytes = probe.write_bytes();
    const fsyncCount = probe.fsync_count();
    if (readBytes === null || writeBytes === null || fsyncCount === null) {
      return null;
    }
    return {
      read_bytes: readBytes,
      write_bytes: writeBytes,
      fsync_count: fsyncCount
    };
  }
}

/** Structural gate for a resource-statistics request. */
function validateResourceStatsRequest(input: ResourceStatsRequest): ErrorEnvelope | null {
  if (input.schema_version !== RESOURCE_STATS_REQUEST_SCHEMA_VERSION) {
    return schemaError("schema_version", "const");
  }
  if (!Array.isArray(input.include) || input.include.length === 0) {
    return schemaError("include", "non_empty_array");
  }
  const seen = new Set<string>();
  for (const axis of input.include) {
    if (axis !== "queue" && axis !== "process" && axis !== "storage" && axis !== "io") {
      return schemaError("include", "closed_axis_set");
    }
    if (seen.has(axis)) {
      return schemaError("include", "duplicate_axis");
    }
    seen.add(axis);
  }
  if (!Number.isSafeInteger(input.timeout_ms) || input.timeout_ms < 1 || input.timeout_ms > 1000) {
    return schemaError("timeout_ms", "integer_1_1000");
  }
  return null;
}

/** The three `E_RESOURCE_*` codes and their matching entry checks. */
type ResourceKind = "fd" | "memory" | "child_process";

/** The frozen entry-check limits: fd count, 256 MiB memory cap, child processes. */
interface ResourceLimits {
  readonly fd: number;
  readonly memory_bytes: number;
  readonly child_process: number;
}

/** The default frozen limits. */
export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = Object.freeze({
  fd: 256,
  memory_bytes: 268_435_456,
  child_process: 64
});

const RESOURCE_CODES: Readonly<
  Record<ResourceKind, "E_RESOURCE_FD_EXHAUSTED" | "E_RESOURCE_MEMORY_EXHAUSTED" | "E_RESOURCE_CHILD_PROCESS_EXHAUSTED">
> = Object.freeze({
  fd: "E_RESOURCE_FD_EXHAUSTED",
  memory: "E_RESOURCE_MEMORY_EXHAUSTED",
  child_process: "E_RESOURCE_CHILD_PROCESS_EXHAUSTED"
});

/**
 * Runs the resource entry checks. The first tripped check wins; the others
 * are not evaluated, so a request never sees more than one resource code.
 */
export function checkResourceLimits(
  observed: { fd_count: number; rss_bytes: number; child_process_count: number },
  limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS
): ErrorEnvelope | null {
  if (observed.fd_count >= limits.fd) {
    return resourceError("fd", limits.fd, observed.fd_count);
  }
  if (observed.rss_bytes >= limits.memory_bytes) {
    return resourceError("memory", limits.memory_bytes, observed.rss_bytes);
  }
  if (observed.child_process_count >= limits.child_process) {
    return resourceError("child_process", limits.child_process, observed.child_process_count);
  }
  return null;
}

function resourceError(resource: ResourceKind, limit: number, observed: number): ErrorEnvelope {
  return makeErrorEnvelope({
    code: RESOURCE_CODES[resource],
    category: "capacity",
    message_key: `error.resource.${resource}_exhausted`,
    stage: "resource_admit",
    retryable: true,
    side_effect: "none",
    details: { kind: "resource", resource, limit, observed }
  });
}

/** A process-instance id; a restart must produce a different one. */
function newProcessInstanceId(): string {
  return `proc:${randomBytes(8).toString("hex")}`;
}

function schemaError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema.invalid",
    stage: "admission",
    details: { kind: "field", path, rule }
  });
}

function deadlineError(): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_DEADLINE_EXCEEDED",
    category: "deadline",
    message_key: "error.deadline.exceeded",
    stage: "admission",
    details: { kind: "none" }
  });
}

function overloadError(decision: AdmissionDecision, retryAfterMs: number): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_OVERLOAD",
    category: "capacity",
    message_key: "error.capacity.overload",
    stage: "admission",
    retryable: true,
    side_effect: "none",
    retry_after_ms: retryAfterMs,
    details: {
      kind: "capacity",
      policy_version: decision.policy_version,
      queue_depth: decision.queue_depth,
      queue_capacity: decision.queue_capacity,
      inflight: decision.inflight,
      max_inflight: decision.max_inflight
    }
  });
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isAdmissionSubject(value: unknown): value is AdmissionSubject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record["kind"] === "event") {
    return typeof record["event_id"] === "string" && isId(record["event_id"], "ev");
  }
  if (record["kind"] === "delivery") {
    return typeof record["delivery_id"] === "string" && isId(record["delivery_id"], "del");
  }
  return false;
}
