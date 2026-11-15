/**
 * Replay execution lifecycle (DD-FND-094, DD-FND-096.3).
 *
 * `replay.execute` re-runs authorization, consumes a `live_external` approval
 * in the same commit that inserts the single active execution, then starts the
 * process. The executor can only submit a result with the exact
 * `(execution_id, fencing_token, row_version)` it was given.
 */

import { randomBytes } from "node:crypto";

import { err, newId, ok } from "@evoplug/core";
import type {
  ErrorEnvelope,
  Hash,
  Id,
  Result,
  SourceRef,
} from "@evoplug/core";

import {
  consumeReplayApproval,
} from "./approval.js";
import {
  replayApprovalMismatchError,
  replayApprovalStateError,
  replayExecutionInProgressError,
  replayExecutionReconcileRequiredError,
  replayPlanMismatchError,
  replayPlanStateError,
  replaySchemaError,
  replayStaleVersionError,
} from "./errors.js";
import { computeReplayPlanHash, computeReplayResultHash } from "./hash.js";
import { isVerifiedSandbox } from "./plan.js";
import {
  REPLAY_EXECUTION_SCHEMA_VERSION,
  REPLAY_FENCING_TOKEN_BYTES,
  REPLAY_FENCING_TOKEN_LENGTH,
  type ReplayApproval,
  type ReplayExecution,
  type ReplayPlan,
} from "./types.js";

export interface CreateReplayExecutionInput {
  readonly execution_id: Id<"rex">;
  readonly fencing_token: string;
  readonly plan: ReplayPlan;
  readonly approval: ReplayApproval | null;
  readonly expected_plan_hash: Hash;
  readonly now_ms: number;
  /** Returned unchanged when an `authorized`/`running` execution already exists. */
  readonly existing_execution?: ReplayExecution | null;
  /** An `unknown` execution with `reconcile_required=1` blocks a new run. */
  readonly has_unreconciled_unknown?: boolean;
  readonly has_active_execution?: boolean;
}

export type CreateReplayExecutionResult =
  | { readonly kind: "existing"; readonly execution: ReplayExecution }
  | {
      readonly kind: "created";
      readonly execution: ReplayExecution;
      /** Present only for `live_external`; already in the consumed state. */
      readonly approval: ReplayApproval | null;
    };

/** 32 CSPRNG bytes, base64url unpadded (43 characters). */
export function generateFencingToken(): string {
  return randomBytes(REPLAY_FENCING_TOKEN_BYTES).toString("base64url");
}

export function isValidFencingToken(value: string): boolean {
  return new RegExp(`^[A-Za-z0-9_-]{${String(REPLAY_FENCING_TOKEN_LENGTH)}}$`).test(value);
}

/**
 * Validates and creates the unique active execution. For `live_external` the
 * returned approval is the `active → consumed` transition that must be
 * journaled before the execution insert.
 */
export function createReplayExecution(
  input: CreateReplayExecutionInput,
): Result<CreateReplayExecutionResult, ErrorEnvelope> {
  const plan = input.plan;
  if (plan.plan_hash !== input.expected_plan_hash || computeReplayPlanHash(plan) !== plan.plan_hash) {
    return err(replayPlanMismatchError(plan.replay_plan_id));
  }
  if (!isValidFencingToken(input.fencing_token)) {
    return err(replaySchemaError("fencing_token", "base64url_43"));
  }
  if (input.existing_execution !== undefined && input.existing_execution !== null) {
    return ok({ kind: "existing", execution: input.existing_execution });
  }
  if (plan.state !== "planned" && plan.state !== "unverified") {
    return err(replayPlanStateError(plan.replay_plan_id));
  }
  if (input.has_unreconciled_unknown === true) {
    return err(replayExecutionReconcileRequiredError(plan.replay_plan_id));
  }
  if (input.has_active_execution === true) {
    return err(replayExecutionInProgressError(plan.replay_plan_id));
  }

  let consumedApproval: ReplayApproval | null = null;
  if (plan.replay_class === "live_external") {
    if (input.approval === null) {
      return err(replayApprovalMismatchError(plan.replay_plan_id));
    }
    const consumed = consumeReplayApproval(
      input.approval,
      plan,
      input.execution_id,
      input.now_ms,
    );
    if (!consumed.ok) {
      return consumed;
    }
    consumedApproval = consumed.value;
  } else {
    if (input.approval !== null) {
      return err(replayApprovalStateError(plan.replay_plan_id));
    }
    const classFailure = validateAutomaticClass(plan);
    if (classFailure !== null) {
      return err(classFailure);
    }
  }

  const execution: ReplayExecution = {
    schema_version: REPLAY_EXECUTION_SCHEMA_VERSION,
    execution_id: input.execution_id,
    replay_plan_id: plan.replay_plan_id,
    approval_id: consumedApproval?.approval_id ?? null,
    state: "authorized",
    fencing_token: input.fencing_token,
    reconcile_required: false,
    reconciled_at: null,
    reconcile_evidence_ref: null,
    started_at: null,
    ended_at: null,
    exit_code: null,
    stdout_ref: null,
    stderr_ref: null,
    result_hash: null,
    error_code: null,
    row_version: 1,
    created_at: input.now_ms,
  };
  return ok({ kind: "created", execution, approval: consumedApproval });
}

/** `authorized → running` after the process starts. */
export function startReplayExecution(
  execution: ReplayExecution,
  startedAt: number,
): Result<ReplayExecution, ErrorEnvelope> {
  if (execution.state !== "authorized") {
    return err(replaySchemaError("state", "authorized_before_running"));
  }
  return ok({
    ...execution,
    state: "running",
    started_at: startedAt,
    row_version: execution.row_version + 1,
  });
}

export interface ReplayResultSubmission {
  readonly expected_row_version: number;
  readonly fencing_token: string;
  /** Current plan hash; binds the result to the approved plan. */
  readonly plan_hash: Hash;
  readonly state: "passed" | "failed" | "unknown" | "cancelled";
  readonly ended_at: number;
  readonly exit_code: number | null;
  readonly stdout_ref: SourceRef | null;
  readonly stderr_ref: SourceRef | null;
  /** Explicit "command produced no output" marker required when both refs are null. */
  readonly explicit_empty_output: boolean;
  readonly error_code: string | null;
}

/**
 * CAS result submission by the holder of `(execution_id, fencing_token)`.
 * `passed`/`failed` require retrievable stdout/stderr refs or the explicit
 * empty-output marker; `unknown` raises the reconcile fence.
 */
export function completeReplayExecution(
  execution: ReplayExecution,
  submission: ReplayResultSubmission,
): Result<ReplayExecution, ErrorEnvelope> {
  if (execution.fencing_token !== submission.fencing_token) {
    return err(replaySchemaError("fencing_token", "byte_equal"));
  }
  if (execution.row_version !== submission.expected_row_version) {
    return err(replayStaleVersionError(submission.expected_row_version, execution.row_version));
  }
  if (execution.state !== "running") {
    return err(replaySchemaError("state", "running"));
  }
  if (!Number.isSafeInteger(submission.ended_at) || submission.ended_at < execution.created_at) {
    return err(replaySchemaError("ended_at", "epoch_ms_after_created_at"));
  }
  if (submission.state === "passed" || submission.state === "failed") {
    const hasOutput =
      submission.stdout_ref !== null ||
      submission.stderr_ref !== null ||
      submission.explicit_empty_output;
    if (!hasOutput) {
      return err(replaySchemaError("stdout_ref", "output_ref_or_explicit_empty"));
    }
    const resultHash = computeReplayResultHash({
      plan_hash: submission.plan_hash,
      exit_code: submission.exit_code,
      stdout_ref: submission.stdout_ref,
      stderr_ref: submission.stderr_ref,
    });
    return ok({
      ...execution,
      state: submission.state,
      ended_at: submission.ended_at,
      exit_code: submission.exit_code,
      stdout_ref: submission.stdout_ref,
      stderr_ref: submission.stderr_ref,
      result_hash: resultHash,
      error_code: submission.error_code,
      reconcile_required: false,
      row_version: execution.row_version + 1,
    });
  }
  if (submission.state === "cancelled") {
    return ok({
      ...execution,
      state: "cancelled",
      ended_at: submission.ended_at,
      exit_code: submission.exit_code,
      stdout_ref: null,
      stderr_ref: null,
      result_hash: null,
      error_code: submission.error_code ?? "cancelled",
      row_version: execution.row_version + 1,
    });
  }
  return ok({
    ...execution,
    state: "unknown",
    ended_at: submission.ended_at,
    exit_code: submission.exit_code,
    stdout_ref: submission.stdout_ref,
    stderr_ref: submission.stderr_ref,
    result_hash: null,
    error_code: submission.error_code ?? "execution_unknown",
    reconcile_required: true,
    reconciled_at: null,
    reconcile_evidence_ref: null,
    row_version: execution.row_version + 1,
  });
}

/**
 * Startup fence for an `authorized`/`running` execution with no live
 * executor: state becomes `unknown`, `reconcile_required=1`, the fencing
 * token is kept but no longer accepted for result writes.
 */
export function fenceReplayExecutionOnRecovery(
  execution: ReplayExecution,
  nowMs: number,
): ReplayExecution {
  if (execution.state !== "authorized" && execution.state !== "running") {
    return execution;
  }
  return {
    ...execution,
    state: "unknown",
    reconcile_required: true,
    reconciled_at: null,
    reconcile_evidence_ref: null,
    ended_at: nowMs,
    error_code: "recovery_unknown",
    row_version: execution.row_version + 1,
  };
}

/** Maps an execution terminal state to the plan transition it implies. */
export function planStateForExecutionResult(
  state: ReplayExecution["state"],
): ReplayPlan["state"] | null {
  switch (state) {
    case "passed":
      return "passed";
    case "failed":
    case "cancelled":
      return "failed";
    case "unknown":
      return "unverified";
    case "authorized":
    case "running":
      return null;
    default:
      return null;
  }
}

/** Generates a fresh `rex` identifier. */
export function newReplayExecutionId(): Id<"rex"> {
  return newId("rex");
}

function validateAutomaticClass(plan: ReplayPlan): ErrorEnvelope | null {
  if (plan.replay_class === "read_only") {
    if (plan.allowed_network) {
      return replaySchemaError("allowed_network", "read_only_no_network");
    }
    if (plan.classification_evidence === "none") {
      return replaySchemaError("classification_evidence", "read_only_needs_evidence");
    }
    return null;
  }
  if (plan.replay_class === "sandboxed_temp") {
    if (plan.environment !== "sandbox") {
      return replaySchemaError("environment", "sandboxed_temp_requires_sandbox");
    }
    if (!isVerifiedSandbox(plan.isolation)) {
      return replaySchemaError("isolation", "verified_sandbox");
    }
    return null;
  }
  return replayPlanStateError(plan.replay_plan_id);
}
