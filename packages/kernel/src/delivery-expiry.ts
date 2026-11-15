/**
 * Delivery expiry SQL + journal paths (D4, W5).
 *
 * Two producers are defined here, both opt-in:
 *
 * - `stageDueDeliveryExpiry`: before a worker claims a row, stage one
 *   `delivery.expire` outbox effect per due pending/submitted row. The effect
 *   key is the existing `delivery.expire:<delivery_id>`, so a restart or a
 *   concurrent sweep cannot create a second effect.
 * - `createDeliveryEpochInvalidator`: after a committed `input.received`,
 *   expire still-pending rows from older input epochs with
 *   `version_changed`. Submitted rows are left alone: their reminder already
 *   reached the host and is not revoked.
 *
 * Both paths never rewrite `expires_at`, never clear inclusion/adoption, and
 * route row transitions through `DeliveryTransitionWriter` (journal frame +
 * one SQLite transaction).
 */

import { err, isId, ok } from "@evoplug/core";
import type {
  ErrorEnvelope,
  Id,
  Result,
  StateRowLiveCommitPort,
  VersionBinding
} from "@evoplug/core";
import {
  applyDeliveryUpdate,
  buildDeliveryExpireOutbox,
  epochInvalidationRequest,
  selectEpochInvalidated,
  validateEpochBinding
} from "@evoplug/delivery";
import type { DeliveryRecord } from "@evoplug/delivery";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";

import { fieldError, internalError } from "./errors.js";
import { readPendingDeliveriesBelowEpoch } from "./delivery-row.js";
import { isDeliveryTransitionStale } from "./delivery-transition.js";
import type { DeliveryTransitionWriter } from "./delivery-transition.js";

/** Staging bound for one sweep; keeps one pass short. */
export const DEFAULT_DELIVERY_EXPIRY_SWEEP_LIMIT = 100;

export interface StageDueDeliveryExpiryOptions {
  readonly priority?: number;
  readonly max_attempts?: number;
}

/**
 * The durable enqueue surface of one sweep.
 *
 * `commitLiveGated` runs the read, the `outbox.enqueued` member and the outbox
 * row under one `BEGIN IMMEDIATE` and one journal frame, so a journal-only
 * rebuild can restore the staged effect.
 */
export type DeliveryExpirySweepEnqueuePort = Pick<
  StateRowLiveCommitPort,
  "commitLiveGated"
>;

function readDueRow(row: SqlRow): { delivery_id: Id<"del">; expires_at: number } | null {
  const deliveryId = row["delivery_id"];
  const expiresAt = row["expires_at"];
  if (typeof deliveryId !== "string" || !isId(deliveryId, "del")) {
    return null;
  }
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    return null;
  }
  return { delivery_id: deliveryId, expires_at: expiresAt };
}

const DUE_DELIVERY_SQL = `SELECT delivery_id, expires_at FROM delivery
  WHERE state IN ('pending','submitted')
    AND expires_at <= :now
    AND NOT EXISTS (
      SELECT 1 FROM outbox o
       WHERE o.effect_key = 'delivery.expire:' || delivery.delivery_id
    )
  ORDER BY expires_at ASC, delivery_id ASC
  LIMIT :limit`;

/**
 * Stages `delivery.expire` effects for rows at or past `expires_at`.
 *
 * The read and every enqueue run in the caller's single-writer gate. Each
 * staged effect carries an `outbox.enqueued` member in the same journal frame
 * as its outbox row, so it survives journal-only recovery. The query excludes
 * ids that already have an effect key; a repeat sweep stages zero.
 */
export async function stageDueDeliveryExpiry(
  port: DeliveryExpirySweepEnqueuePort,
  now_ms: number,
  limit: number = DEFAULT_DELIVERY_EXPIRY_SWEEP_LIMIT,
  options: StageDueDeliveryExpiryOptions = {}
): Promise<Result<number, ErrorEnvelope>> {
  if (!Number.isSafeInteger(now_ms) || now_ms < 0) {
    return err(fieldError("now_ms", "non_negative_safe_integer"));
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    return err(fieldError("limit", "1_10000"));
  }
  const priority = options.priority ?? 0;
  const maxAttempts = options.max_attempts ?? 3;
  const committed = await port.commitLiveGated<{ readonly staged: number }>({
    // The sweep spans tasks, so the frame itself has no single binding.
    binding: null,
    stage(stage) {
      const rows = stage.tx.all<SqlRow>(DUE_DELIVERY_SQL, { now: now_ms, limit });
      const due: { delivery_id: Id<"del">; expires_at: number }[] = [];
      for (const raw of rows) {
        const row = readDueRow(raw);
        if (row === null) {
          return err(internalError("kernel.delivery_row_corrupt"));
        }
        due.push(row);
      }
      if (due.length === 0) {
        return ok({ kind: "existing" as const, value: { staged: 0 } });
      }
      for (const row of due) {
        const enqueue = buildDeliveryExpireOutbox({
          delivery_id: row.delivery_id,
          expires_at: row.expires_at,
          priority,
          max_attempts: maxAttempts
        });
        if (!enqueue.ok) {
          return err(enqueue.error);
        }
        const staged = stage.stageOutbox(enqueue.value);
        if (!staged.ok) {
          return staged;
        }
      }
      return ok({ kind: "commit" as const, value: { staged: due.length } });
    }
  });
  if (!committed.ok) {
    return err(committed.error);
  }
  return ok(committed.value?.staged ?? 0);
}

export interface DeliveryEpochInvalidatorDeps {
  readonly connection: SqliteConnection;
  readonly transition: DeliveryTransitionWriter;
  readonly now?: () => number;
  /** Rows per call; default 100. */
  readonly limit?: number;
}

export interface DeliveryEpochInvalidator {
  invalidateForInput(
    binding: Pick<VersionBinding, "task_id" | "branch_id" | "input_epoch">
  ): Promise<Result<readonly Id<"del">[], ErrorEnvelope>>;
}

/** Request shape of the ingest post-commit hook; no runtime import. */
export interface InputEpochEventLike {
  readonly draft: {
    readonly payload: { readonly kind: string };
  };
  readonly binding: Pick<VersionBinding, "task_id" | "branch_id" | "input_epoch">;
}

export function createDeliveryEpochInvalidator(
  deps: DeliveryEpochInvalidatorDeps
): DeliveryEpochInvalidator {
  const now = deps.now ?? ((): number => Date.now());
  const limit = deps.limit ?? 100;
  /**
   * A journal commit that reports `unknown` may already own a durable frame.
   * Re-running the selector in the same process could append a second frame
   * for the same transition, so every later call fails closed until restart
   * recovery has replayed the journal.
   */
  let recoveryRequired: ErrorEnvelope | null = null;
  /** Serialises calls on one instance; SQLite CAS still fends off other processes. */
  let tail: Promise<unknown> = Promise.resolve();

  async function invalidate(
    binding: Pick<VersionBinding, "task_id" | "branch_id" | "input_epoch">
  ): Promise<Result<readonly Id<"del">[], ErrorEnvelope>> {
    if (recoveryRequired !== null) {
      return err(recoveryRequired);
    }
    const validated = validateEpochBinding(binding);
    if (!validated.ok) {
      return validated;
    }
    const expired: Id<"del">[] = [];
    // `limit` bounds one read, not one input: every pending row from an
    // older epoch must be terminal before the hook returns.
    for (;;) {
      const records = readPendingDeliveriesBelowEpoch(deps.connection, validated.value, limit);
      if (!records.ok) {
        return records;
      }
      const selected = selectEpochInvalidated(records.value, validated.value);
      if (selected.length === 0) {
        return ok(expired);
      }
      for (const record of selected) {
        const request = epochInvalidationRequest(record);
        const applied = applyDeliveryUpdate(record, request, {
          now_ms: now(),
          evidence_retrievable: true,
          human_attestation_verified: false
        });
        if (!applied.ok) {
          return applied;
        }
        const committed = await deps.transition.commit(record, applied.value);
        if (!committed.ok) {
          if (isDeliveryTransitionStale(committed.error)) {
            // Another writer moved the row after selection and the transition
            // writer refused before appending a frame. Re-select instead of
            // returning an unknown-recovery error.
            continue;
          }
          if (committed.status === "unknown") {
            recoveryRequired = internalError(
              "kernel.delivery_epoch_invalidation_unknown_recovery_required"
            );
          }
          return committed;
        }
        expired.push(record.delivery_id);
      }
    }
  }

  return {
    invalidateForInput(binding) {
      const run = tail.then(
        () => invalidate(binding),
        () => invalidate(binding)
      );
      tail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    }
  };
}

/**
 * Main-facing hook: run the invalidator with a committed input binding.
 * Returns the expired ids so callers can log them; a duplicate run returns
 * `[]` because the rows are already terminal.
 */
export async function expireForInputEpoch(
  invalidator: DeliveryEpochInvalidator,
  binding: Pick<VersionBinding, "task_id" | "branch_id" | "input_epoch">
): Promise<Result<readonly Id<"del">[], ErrorEnvelope>> {
  return invalidator.invalidateForInput(binding);
}

/**
 * Adapter for `EventIngestDeps.post_commit`. Only `input.received` carries a
 * new epoch; every other event is a no-op. The hook never throws so the
 * ingest ACK path cannot be changed by an expiry failure.
 */
export function createInputEpochExpiryHook(
  invalidator: DeliveryEpochInvalidator
): (event: InputEpochEventLike) => Promise<Result<readonly Id<"del">[], ErrorEnvelope> | null> {
  return async (event) => {
    if (event.draft.payload.kind !== "input.received") {
      return null;
    }
    try {
      return await expireForInputEpoch(invalidator, event.binding);
    } catch {
      return err(internalError("kernel.delivery_epoch_invalidation_failed"));
    }
  };
}
