import type { StatementSource } from "../types.js";
import {
  failOutbox,
  listOutboxAttempts,
  markOutboxDone,
  markOutboxUncertain,
  returnOutboxToPending
} from "./store.js";
import type { OutboxAttemptRow, OutboxRow } from "./model.js";

interface OutboxRecoveryOptions {
  readonly now: number;
  /**
   * Evidence that a started attempt crossed its external call point. The
   * journal only records `started`; without positive evidence recovery is
   * fail-closed and treats the attempt as crossed (=> uncertain).
   */
  readonly isExternalCallCrossed?: (row: OutboxRow, attempt: OutboxAttemptRow) => boolean;
  /** Positive evidence that an external effect succeeded. */
  readonly verifyExternalSuccess?: (row: OutboxRow, attempt: OutboxAttemptRow) => boolean;
  /** Overrides the local-idempotent effect set. */
  readonly isLocalIdempotentEffect?: (effectKind: string) => boolean;
}

interface OutboxRecoveryResult {
  readonly released: readonly string[];
  readonly uncertain: readonly string[];
  readonly failed: readonly string[];
  readonly completed: readonly string[];
}

/** Effects that only touch local, idempotent state and may be marked done after success. */
const DEFAULT_LOCAL_EFFECTS: ReadonlySet<string> = new Set([
  "maintenance.gc",
  "delivery.expire"
]);

/**
 * Reconstructs outbox leases after a crash (DD-FND-061):
 *
 * - leased with no attempt, or a started attempt before the external call
 *   point, returns to pending with exponential backoff; if attempts reached
 *   `max_attempts` it becomes failed instead of an unclaimable pending row;
 * - a started attempt past the external call point becomes uncertain with
 *   `reconcile_required=1` and is never resent automatically;
 * - an ended attempt whose outbox row was not updated is reconciled from the
 *   attempt result;
 * - a pending row already at `max_attempts` is failed, never silently dropped.
 */
export function recoverOutbox(
  source: StatementSource,
  options: OutboxRecoveryOptions,
): OutboxRecoveryResult {
  const released: string[] = [];
  const uncertain: string[] = [];
  const failed: string[] = [];
  const completed: string[] = [];

  const rows = source
    .prepare<OutboxRow>(
      `SELECT outbox_id, effect_kind, effect_key, payload_json, state, priority,
              attempts, max_attempts, next_attempt_at, lease_owner, lease_token,
              lease_expires_at, reconcile_required, last_error_code, result_ref,
              created_at, updated_at
         FROM outbox
        WHERE state IN ('leased','pending')
        ORDER BY outbox_id ASC`,
    )
    .all();

  const isLocal = (kind: string): boolean =>
    options.isLocalIdempotentEffect === undefined
      ? DEFAULT_LOCAL_EFFECTS.has(kind)
      : options.isLocalIdempotentEffect(kind);

  for (const row of rows) {
    const outboxId = row.outbox_id;
    const attempts = Number(row.attempts);
    const maxAttempts = Number(row.max_attempts);

    if (row.state === "pending") {
      if (attempts >= maxAttempts) {
        if (failOutbox(source, { outbox_id: outboxId, now: options.now })) {
          failed.push(outboxId);
        }
      }
      continue;
    }

    const attemptRows = listOutboxAttempts(source, outboxId);
    const last = attemptRows.length === 0 ? undefined : attemptRows[attemptRows.length - 1];
    if (last === undefined) {
      if (attempts >= maxAttempts) {
        if (failOutbox(source, { outbox_id: outboxId, now: options.now })) {
          failed.push(outboxId);
        }
      } else if (returnOutboxToPending(source, { outbox_id: outboxId, now: options.now })) {
        released.push(outboxId);
      }
      continue;
    }

    switch (last.state) {
      case "started": {
        const crossed =
          options.isExternalCallCrossed === undefined
            ? true
            : options.isExternalCallCrossed(row, last);
        if (!crossed) {
          if (attempts >= maxAttempts) {
            if (
              failOutbox(source, {
                outbox_id: outboxId,
                now: options.now,
                error_code: "recovery_attempts_exhausted"
              })
            ) {
              failed.push(outboxId);
            }
          } else if (
            returnOutboxToPending(source, {
              outbox_id: outboxId,
              now: options.now,
              error_code: "recovery_released"
            })
          ) {
            released.push(outboxId);
          }
          break;
        }
        if (
          markOutboxUncertain(source, {
            outbox_id: outboxId,
            now: options.now,
            error_code: "recovery_unknown_fence"
          })
        ) {
          uncertain.push(outboxId);
        }
        break;
      }
      case "succeeded": {
        const verified =
          isLocal(row.effect_kind) ||
          (options.verifyExternalSuccess !== undefined &&
            options.verifyExternalSuccess(row, last));
        if (verified) {
          if (
            markOutboxDone(source, {
              outbox_id: outboxId,
              now: options.now,
              result_ref: last.outbox_attempt_id
            })
          ) {
            completed.push(outboxId);
          }
        } else if (
          markOutboxUncertain(source, {
            outbox_id: outboxId,
            now: options.now,
            error_code: "recovery_external_unverified"
          })
        ) {
          uncertain.push(outboxId);
        }
        break;
      }
      case "retryable_failed": {
        if (attempts >= maxAttempts) {
          if (
            failOutbox(source, {
              outbox_id: outboxId,
              now: options.now,
              error_code: last.error_code ?? "retryable_failed"
            })
          ) {
            failed.push(outboxId);
          }
        } else if (
          returnOutboxToPending(source, {
            outbox_id: outboxId,
            now: options.now,
            ...(last.error_code === null ? {} : { error_code: last.error_code })
          })
        ) {
          released.push(outboxId);
        }
        break;
      }
      case "terminal_failed":
      case "cancelled": {
        if (
          failOutbox(source, {
            outbox_id: outboxId,
            now: options.now,
            ...(last.error_code === null ? {} : { error_code: last.error_code })
          })
        ) {
          failed.push(outboxId);
        }
        break;
      }
      case "uncertain": {
        if (
          markOutboxUncertain(source, {
            outbox_id: outboxId,
            now: options.now,
            error_code: last.error_code ?? "recovery_unknown_fence"
          })
        ) {
          uncertain.push(outboxId);
        }
        break;
      }
      default: {
        break;
      }
    }
  }

  return { released, uncertain, failed, completed };
}
