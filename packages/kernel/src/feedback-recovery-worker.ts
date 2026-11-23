/**
 * Appendix P background feedback recovery.
 *
 * Endpoint publication no longer waits for classification replay. This worker
 * runs after the server is ready, replays a bounded batch at a time and
 * yields between batches. The durable attempt counter in `feedback_recovery`
 * stops an always-failing backend from being replayed on every start.
 *
 * The worker owns no durable state of its own: `pending` and
 * `terminal_failed` are read from the intake, while the counters below are
 * process-local progress for `evolve status`.
 */

import type {
  FeedbackRecoveryBatchOptions,
  FeedbackRecoveryStats,
  FeedbackRecoveryStopReason,
  FeedbackRecoverySummary
} from "./feedback-producer.js";

export interface FeedbackRecoveryWorkerLimits {
  readonly max_items: number;
  readonly max_wall_ms: number;
  readonly idle_delay_ms: number;
  readonly max_attempts: number;
}

export const DEFAULT_FEEDBACK_RECOVERY_WORKER_LIMITS: FeedbackRecoveryWorkerLimits = {
  max_items: 8,
  max_wall_ms: 30_000,
  idle_delay_ms: 5_000,
  max_attempts: 3
};

export interface FeedbackRecoveryLastRun {
  readonly started_at: number;
  readonly finished_at: number;
  readonly scanned: number;
  readonly recorded: number;
  readonly skipped: number;
  readonly failed: number;
  readonly terminal_failed: number;
  readonly remaining: number;
  readonly stopped_reason: FeedbackRecoveryStopReason;
}

export interface FeedbackRecoveryWorkerStatus extends FeedbackRecoveryStats {
  readonly state: "idle" | "running" | "waiting" | "stopped";
  /** Items replayed by this process. */
  readonly processed: number;
  /** Failed items observed by this process (not only terminal ones). */
  readonly failed: number;
  readonly last_run: FeedbackRecoveryLastRun | null;
}

export interface FeedbackRecoveryWorkerPort {
  start(): void;
  /** Cancels future batches and waits for one in flight to settle. */
  stop(): Promise<void>;
  /** Runs exactly one bounded batch; used by tests and manual maintenance. */
  runOnce(): Promise<FeedbackRecoveryLastRun>;
  status(): FeedbackRecoveryWorkerStatus;
}

interface FeedbackRecoveryIntakePort {
  recoverBatch(options?: FeedbackRecoveryBatchOptions): Promise<FeedbackRecoverySummary>;
  recoveryStats(): FeedbackRecoveryStats;
}

export interface FeedbackRecoveryWorkerOptions {
  readonly intake: FeedbackRecoveryIntakePort;
  readonly limits?: Partial<FeedbackRecoveryWorkerLimits>;
  readonly now?: () => number;
  readonly on_summary?: (summary: FeedbackRecoveryLastRun) => void;
  /** Injectable for deterministic tests. */
  readonly schedule?: (run: () => void, delay_ms: number) => unknown;
  readonly cancel_schedule?: (handle: unknown) => void;
}

export function createFeedbackRecoveryWorker(
  options: FeedbackRecoveryWorkerOptions
): FeedbackRecoveryWorkerPort {
  const limits: FeedbackRecoveryWorkerLimits = {
    ...DEFAULT_FEEDBACK_RECOVERY_WORKER_LIMITS,
    ...options.limits
  };
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((run, delay) => setTimeout(run, delay));
  const cancelSchedule = options.cancel_schedule ??
    ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let state: FeedbackRecoveryWorkerStatus["state"] = "idle";
  let stopped = true;
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;
  let processedTotal = 0;
  let failedTotal = 0;
  let lastRun: FeedbackRecoveryLastRun | null = null;

  function snapshot(): FeedbackRecoveryWorkerStatus {
    let stats: FeedbackRecoveryStats = { pending: 0, terminal_failed: 0 };
    try {
      stats = options.intake.recoveryStats();
    } catch {
      // A status read must never fail just because the backlog is unreadable.
    }
    return {
      state,
      pending: stats.pending,
      terminal_failed: stats.terminal_failed,
      processed: processedTotal,
      failed: failedTotal,
      last_run: lastRun
    };
  }

  async function runBatch(): Promise<FeedbackRecoveryLastRun> {
    const startedAt = now();
    const summary = await options.intake.recoverBatch({
      max_items: limits.max_items,
      max_wall_ms: limits.max_wall_ms,
      max_attempts: limits.max_attempts
    });
    const finishedAt = now();
    processedTotal += summary.scanned;
    failedTotal += summary.failed;
    lastRun = {
      started_at: startedAt,
      finished_at: finishedAt,
      scanned: summary.scanned,
      recorded: summary.recorded,
      skipped: summary.skipped,
      failed: summary.failed,
      terminal_failed: summary.terminal_failed,
      remaining: summary.remaining,
      stopped_reason: summary.stopped_reason
    };
    try {
      options.on_summary?.(lastRun);
    } catch {
      // Diagnostics never interrupt recovery.
    }
    return lastRun;
  }

  function arm(delay_ms: number): void {
    timer = schedule(() => {
      timer = null;
      const run = tick();
      let tracked: Promise<void>;
      tracked = run.then(
        () => undefined,
        () => undefined
      ).finally(() => {
        if (inFlight === tracked) inFlight = null;
      });
      inFlight = tracked;
    }, delay_ms);
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    state = "running";
    try {
      await runBatch();
    } catch {
      // Leave the durable backlog untouched; retry after the idle delay.
      if (stopped) {
        state = "stopped";
        return;
      }
      state = "waiting";
      arm(limits.idle_delay_ms);
      return;
    }
    if (stopped) {
      state = "stopped";
      return;
    }
    let pending: number;
    try {
      pending = options.intake.recoveryStats().pending;
    } catch {
      state = "idle";
      return;
    }
    if (pending === 0) {
      state = "idle";
      return;
    }
    state = "waiting";
    arm(limits.idle_delay_ms);
  }

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      state = "waiting";
      arm(0);
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== null) {
        cancelSchedule(timer);
        timer = null;
      }
      if (inFlight !== null) await inFlight;
      state = "stopped";
    },
    async runOnce(): Promise<FeedbackRecoveryLastRun> {
      const run = runBatch();
      inFlight = run.then(
        () => undefined,
        () => undefined
      );
      try {
        return await run;
      } finally {
        inFlight = null;
      }
    },
    status(): FeedbackRecoveryWorkerStatus {
      return snapshot();
    }
  };
}
