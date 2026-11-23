/**
 * `replay.reconcile` (DD-FND-096.4).
 *
 * Reconciliation only clears the recovery fence on an `unknown` execution
 * whose exact fencing token is presented. It never restarts a process, never
 * re-consumes an approval, never creates a second execution and never changes
 * the plan away from `unverified`.
 */

import { err, ok } from "@evoplug/core";
import type { ErrorEnvelope, Result, SourceRef } from "@evoplug/core";

import { validateReason } from "./approval.js";
import {
  replayReconcileConflictError,
  replayStaleVersionError,
} from "./errors.js";
import type { ReplayExecution } from "./types.js";

interface ReconcileReplayExecutionInput {
  readonly execution: ReplayExecution;
  readonly fencing_token: string;
  readonly evidence_ref: SourceRef;
  readonly reason: string;
  readonly now_ms: number;
  /** Set by the caller after resolving the evidence; false aborts with no write. */
  readonly evidence_retrievable: boolean;
  readonly expected_row_version: number;
}

/**
 * Returns the reconciled `unknown` row. The journal frame and CAS update must
 * use `(execution_id,state='unknown',reconcile_required=1,fencing_token,row_version)`.
 */
export function reconcileReplayExecution(
  input: ReconcileReplayExecutionInput,
): Result<ReplayExecution, ErrorEnvelope> {
  const execution = input.execution;
  if (execution.state !== "unknown" || !execution.reconcile_required) {
    return err(replayReconcileConflictError(execution.replay_plan_id));
  }
  if (execution.fencing_token !== input.fencing_token) {
    return err(replayReconcileConflictError(execution.replay_plan_id));
  }
  if (execution.row_version !== input.expected_row_version) {
    return err(replayStaleVersionError(input.expected_row_version, execution.row_version));
  }
  if (!input.evidence_retrievable) {
    return err(replayReconcileConflictError(execution.replay_plan_id));
  }
  const reasonFailure = validateReason(input.reason);
  if (reasonFailure !== null) {
    return err(reasonFailure);
  }
  if (execution.reconciled_at !== null || execution.reconcile_evidence_ref !== null) {
    // A second reconcile with a different idempotency key must not rewrite the
    // cleared fence; the cleared row is terminal for reconciliation.
    return err(replayReconcileConflictError(execution.replay_plan_id));
  }
  return ok({
    ...execution,
    reconcile_required: false,
    reconciled_at: input.now_ms,
    reconcile_evidence_ref: input.evidence_ref,
    row_version: execution.row_version + 1,
  });
}
