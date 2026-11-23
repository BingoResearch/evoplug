/**
 * Review worker loop (DD-REV-080, DD-REV-140).
 *
 * The worker claims one attempt, starts the backend, heartbeats, then hands
 * the canonical `output/events.jsonl` to `acceptOutput`. It never parses the
 * output itself and never writes SQLite directly.
 */

import type { Clock } from "@evoplug/core";

import type { GeneratorInput } from "../generator.js";
import type { ClaimedAttempt, ReviewService, RevError, RevResult } from "../service.js";
import type { ReviewAttempt, ReviewJob } from "../types.js";

export interface GeneratorRunResult {
  output_bytes: Uint8Array;
  exit_code: number | null;
  signal: string | null;
  completion_evidence_ref?: import("@evoplug/core").SourceRef;
}

export interface GeneratorRunnerPort {
  run(input: GeneratorInput, attempt: ReviewAttempt, signal: AbortSignal): Promise<RevResult<GeneratorRunResult>>;
  cancel(attempt: ReviewAttempt): Promise<"cancelled" | "not_running" | "unsupported">;
}

interface ReviewWorkerDeps {
  service: ReviewService;
  runner: GeneratorRunnerPort;
  clock: Clock;
  worker_id: string;
  heartbeat_interval_ms: number;
  cancelRequested(attempt_id: string): Promise<boolean>;
}

type WorkerIteration =
  | { kind: "idle" }
  | { kind: "accepted"; job: ReviewJob; attempt: ReviewAttempt }
  | { kind: "failed"; attempt_id: string; error: RevError };

export class ReviewWorker {
  private readonly deps: ReviewWorkerDeps;

  constructor(deps: ReviewWorkerDeps) {
    this.deps = deps;
  }

  async runOnce(): Promise<WorkerIteration> {
    const now = this.deps.clock.utcNowMs();
    const claimed = await this.deps.service.claimNextAttempt({
      worker_id: this.deps.worker_id,
      now
    });
    if (!claimed.ok) {
      return { kind: "failed", attempt_id: "", error: claimed.error };
    }
    if (claimed.value === null) {
      return { kind: "idle" };
    }
    return this.runClaimed(claimed.value);
  }

  private async runClaimed(claimed: ClaimedAttempt): Promise<WorkerIteration> {
    const controller = new AbortController();
    const heartbeat = this.startHeartbeat(claimed.attempt);
    try {
      if (await this.deps.cancelRequested(claimed.attempt.attempt_id)) {
        await this.deps.runner.cancel(claimed.attempt);
      }
      const run = await this.deps.runner.run(claimed.input, claimed.attempt, controller.signal);
      if (!run.ok) {
        await this.fail(claimed.attempt, run.error);
        return { kind: "failed", attempt_id: claimed.attempt.attempt_id, error: run.error };
      }
      const now = this.deps.clock.utcNowMs();
      const accepted = await this.deps.service.acceptOutput({
        attempt_id: claimed.attempt.attempt_id,
        lease_id: claimed.attempt.lease?.lease_id ?? "",
        fencing_token: claimed.attempt.lease?.fencing_token ?? -1,
        now
      });
      if (!accepted.ok) {
        await this.fail(claimed.attempt, accepted.error);
        return { kind: "failed", attempt_id: claimed.attempt.attempt_id, error: accepted.error };
      }
      return { kind: "accepted", job: accepted.value.job, attempt: accepted.value.attempt };
    } finally {
      clearInterval(heartbeat);
    }
  }

  private startHeartbeat(attempt: ReviewAttempt): ReturnType<typeof setInterval> {
    const lease = attempt.lease;
    if (lease === undefined) {
      return setInterval(() => undefined, this.deps.heartbeat_interval_ms);
    }
    const timer = setInterval(() => {
      void this.deps.service.heartbeat({
        attempt_id: attempt.attempt_id,
        lease_id: lease.lease_id,
        fencing_token: lease.fencing_token,
        now: this.deps.clock.utcNowMs()
      });
    }, this.deps.heartbeat_interval_ms);
    timer.unref?.();
    return timer;
  }

  private async fail(attempt: ReviewAttempt, error: RevError): Promise<void> {
    await this.deps.service.failAttempt({
      attempt_id: attempt.attempt_id,
      lease_id: attempt.lease?.lease_id ?? "",
      fencing_token: attempt.lease?.fencing_token ?? -1,
      error,
      now: this.deps.clock.utcNowMs()
    });
  }
}

