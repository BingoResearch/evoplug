import type { ErrorEnvelope, Result } from "@evoplug/core";
import { err, ok } from "@evoplug/core";
import type { SqliteConnection } from "@evoplug/storage";
import type {
  ReviewHandoff,
  ReviewJob,
  ReviewRepository
} from "@evoplug/review";

import { internalError } from "./errors.js";
import type { ReviewWorkerDeliveryPort } from "./review-worker-loop.js";

const RETRY_BACKOFF_MS: readonly number[] = [1000, 5000, 30000, 300000];

type PendingDeliveryRow = {
  readonly handoff_id: string;
  readonly job_id: string;
  readonly attempts: number;
};

function rowValue(row: Record<string, unknown>, key: string): unknown {
  return row[key];
}

function readPending(row: Record<string, unknown>): PendingDeliveryRow | null {
  const handoffId = rowValue(row, "handoff_id");
  const jobId = rowValue(row, "job_id");
  const attempts = rowValue(row, "attempts");
  if (
    typeof handoffId !== "string" ||
    typeof jobId !== "string" ||
    typeof attempts !== "number" ||
    !Number.isSafeInteger(attempts) ||
    attempts < 0
  ) {
    return null;
  }
  return { handoff_id: handoffId, job_id: jobId, attempts };
}

/**
 * Adds a durable pending marker around an optional downstream handoff hook.
 * The marker is inserted in the T6 handoff commit. A callback that succeeds
 * after a process crash may be invoked again with the same handoff_id, so the
 * downstream contract must be idempotent at that identity.
 */
export function createDurableReviewWorkerDeliveryPort(input: {
  readonly connection: SqliteConnection;
  readonly repository: ReviewRepository;
  readonly downstream: ReviewWorkerDeliveryPort;
  readonly now?: () => number;
}): ReviewWorkerDeliveryPort {
  const now = input.now ?? (() => Date.now());

  function pending(handoffId: string): PendingDeliveryRow | null {
    const row = input.connection
      .prepare<Record<string, unknown>>(
        `SELECT handoff_id, job_id, attempts
           FROM review_handoff_delivery
          WHERE handoff_id = :handoff_id`
      )
      .get({ handoff_id: handoffId });
    return row === undefined ? null : readPending(row);
  }

  function recordFailure(marker: PendingDeliveryRow, at: number): void {
    const attempts = marker.attempts + 1;
    const backoff = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)] ?? 300000;
    input.connection
      .prepare(
        `UPDATE review_handoff_delivery
            SET attempts = :attempts,
                last_error_code = :last_error_code,
                next_attempt_at = :next_attempt_at,
                updated_at = :updated_at
          WHERE handoff_id = :handoff_id AND state = 'pending'`
      )
      .run({
        handoff_id: marker.handoff_id,
        attempts,
        last_error_code: "downstream_handoff_failed",
        next_attempt_at: at + backoff,
        updated_at: at
      });
  }

  async function deliver(inputValue: {
    readonly job: ReviewJob;
    readonly handoff: ReviewHandoff;
  }): Promise<Result<void, ErrorEnvelope>> {
    const marker = pending(inputValue.handoff.handoff_id);
    if (marker === null) {
      return err(internalError("kernel.review_handoff_delivery_marker_missing"));
    }
    if (marker.job_id !== inputValue.job.job_id) {
      return err(internalError("kernel.review_handoff_delivery_binding_changed"));
    }
    if (
      input.connection
        .prepare<{ state: string }>(
          `SELECT state FROM review_handoff_delivery WHERE handoff_id = :handoff_id`
        )
        .get({ handoff_id: marker.handoff_id })?.state === "done"
    ) {
      return ok(undefined);
    }

    let result: Result<void, ErrorEnvelope>;
    try {
      result = await input.downstream.handoffCommitted(inputValue);
    } catch {
      recordFailure(marker, now());
      return err(internalError("kernel.review_handoff_delivery_callback_failed"));
    }
    if (!result.ok) {
      recordFailure(marker, now());
      return result;
    }
    try {
      const updated = input.connection
        .prepare(
          `UPDATE review_handoff_delivery
              SET state = 'done', last_error_code = NULL, updated_at = :updated_at
            WHERE handoff_id = :handoff_id AND job_id = :job_id AND state = 'pending'`
        )
        .run({
          handoff_id: marker.handoff_id,
          job_id: marker.job_id,
          updated_at: now()
        });
      if (updated.changes !== 1) {
        return err(internalError("kernel.review_handoff_delivery_transition_failed"));
      }
    } catch {
      return err(internalError("kernel.review_handoff_delivery_transition_failed"));
    }
    return ok(undefined);
  }

  async function recoverPending(): Promise<Result<number, ErrorEnvelope>> {
    const rows = input.connection
      .prepare<Record<string, unknown>>(
        `SELECT handoff_id, job_id, attempts
           FROM review_handoff_delivery
          WHERE state = 'pending' AND next_attempt_at <= :now
          ORDER BY next_attempt_at ASC, handoff_id ASC`
      )
      .all({ now: now() });
    let delivered = 0;
    for (const raw of rows) {
      const marker = readPending(raw);
      if (marker === null) {
        return err(internalError("kernel.review_handoff_delivery_row_invalid"));
      }
      const job = await input.repository.getJob(marker.job_id);
      const handoff = await input.repository.getHandoff(marker.handoff_id);
      if (job === null || handoff === null) {
        return err(internalError("kernel.review_handoff_delivery_source_missing"));
      }
      const result = await deliver({ job, handoff });
      if (!result.ok) {
        return result as Result<number, ErrorEnvelope>;
      }
      delivered += 1;
    }
    return ok(delivered);
  }

  return {
    handoffCommitted: deliver,
    recoverPending
  };
}
