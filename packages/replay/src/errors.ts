/**
 * Replay error envelopes (DD-FND-096.5).
 *
 * Every code uses `ErrorDetails.kind="replay"` and the canonical reason from
 * the shared core detail branch. Replay never returns free text in an error.
 */

import { makeErrorEnvelope } from "@evoplug/core";
import type { ErrorCategory, ErrorCode, ErrorEnvelope, Id } from "@evoplug/core";

type ReplayErrorReason =
  | "needs_approval"
  | "network_scope_mismatch"
  | "isolation_unverified"
  | "classifier_unknown"
  | "approval_not_found"
  | "approval_mismatch"
  | "approval_consumed"
  | "approval_expired"
  | "approval_revoked"
  | "approval_state"
  | "plan_not_found"
  | "plan_mismatch"
  | "plan_state"
  | "execution_reconcile_required"
  | "execution_in_progress"
  | "execution_unknown"
  | "reconcile_conflict"
  | "attestation_unverified";

interface ReplayErrorInit {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly reason: ReplayErrorReason;
  readonly stage: string;
  readonly replayPlanId?: Id<"rpl">;
}

function buildReplayError(init: ReplayErrorInit): ErrorEnvelope {
  const details =
    init.replayPlanId === undefined
      ? { kind: "replay" as const, reason: init.reason }
      : { kind: "replay" as const, reason: init.reason, replay_plan_id: init.replayPlanId };
  return makeErrorEnvelope({
    code: init.code,
    category: init.category,
    message_key: `error.${init.code.toLowerCase()}`,
    stage: init.stage,
    details,
  });
}

export function replayApprovalNotFoundError(replayPlanId?: Id<"rpl">): ErrorEnvelope {
  return buildReplayError({
    code: "E_REPLAY_APPROVAL_NOT_FOUND",
    category: "not_found",
    reason: "approval_not_found",
    stage: "replay_approve",
    ...(replayPlanId === undefined ? {} : { replayPlanId }),
  });
}

export function replayApprovalMismatchError(replayPlanId?: Id<"rpl">): ErrorEnvelope {
  return buildReplayError({
    code: "E_REPLAY_APPROVAL_MISMATCH",
    category: "conflict",
    reason: "approval_mismatch",
    stage: "replay_approve",
    ...(replayPlanId === undefined ? {} : { replayPlanId }),
  });
}

export function replayApprovalConsumedError(replayPlanId?: Id<"rpl">): ErrorEnvelope {
  return buildReplayError({
    code: "E_REPLAY_APPROVAL_CONSUMED",
    category: "authorization",
    reason: "approval_consumed",
    stage: "replay_approve",
    ...(replayPlanId === undefined ? {} : { replayPlanId }),
  });
}

export function replayApprovalExpiredError(replayPlanId?: Id<"rpl">): ErrorEnvelope {
  return buildReplayError({
    code: "E_REPLAY_APPROVAL_EXPIRED",
    category: "authorization",
    reason: "approval_expired",
    stage: "replay_approve",
    ...(replayPlanId === undefined ? {} : { replayPlanId }),
  });
}

export function replayApprovalRevokedError(replayPlanId?: Id<"rpl">): ErrorEnvelope {
  return buildReplayError({
    code: "E_REPLAY_APPROVAL_REVOKED",
    category: "authorization",
    reason: "approval_revoked",
    stage: "replay_approve",
    ...(replayPlanId === undefined ? {} : { replayPlanId }),
  });
}

export function replayApprovalStateError(replayPlanId?: Id<"rpl">): ErrorEnvelope {
  return buildReplayError({
    code: "E_REPLAY_APPROVAL_STATE",
    category: "conflict",
    reason: "approval_state",
    stage: "replay_approve",
    ...(replayPlanId === undefined ? {} : { replayPlanId }),
  });
}

export function replayAttestationUnverifiedError(replayPlanId?: Id<"rpl">): ErrorEnvelope {
  return buildReplayError({
    code: "E_REPLAY_ATTESTATION_UNVERIFIED",
    category: "authorization",
    reason: "attestation_unverified",
    stage: "replay_approve",
    ...(replayPlanId === undefined ? {} : { replayPlanId }),
  });
}

export function replayPlanNotFoundError(): ErrorEnvelope {
  return buildReplayError({
    code: "E_REPLAY_PLAN_NOT_FOUND",
    category: "not_found",
    reason: "plan_not_found",
    stage: "replay_plan",
  });
}

export function replayPlanMismatchError(replayPlanId?: Id<"rpl">): ErrorEnvelope {
  return buildReplayError({
    code: "E_REPLAY_PLAN_MISMATCH",
    category: "conflict",
    reason: "plan_mismatch",
    stage: "replay_plan",
    ...(replayPlanId === undefined ? {} : { replayPlanId }),
  });
}

export function replayPlanStateError(replayPlanId?: Id<"rpl">): ErrorEnvelope {
  return buildReplayError({
    code: "E_REPLAY_PLAN_STATE",
    category: "conflict",
    reason: "plan_state",
    stage: "replay_plan",
    ...(replayPlanId === undefined ? {} : { replayPlanId }),
  });
}

export function replayExecutionInProgressError(replayPlanId?: Id<"rpl">): ErrorEnvelope {
  return buildReplayError({
    code: "E_REPLAY_EXECUTION_IN_PROGRESS",
    category: "conflict",
    reason: "execution_in_progress",
    stage: "replay_reconcile",
    ...(replayPlanId === undefined ? {} : { replayPlanId }),
  });
}

export function replayExecutionReconcileRequiredError(replayPlanId?: Id<"rpl">): ErrorEnvelope {
  return buildReplayError({
    code: "E_REPLAY_EXECUTION_RECONCILE_REQUIRED",
    category: "conflict",
    reason: "execution_reconcile_required",
    stage: "replay_reconcile",
    ...(replayPlanId === undefined ? {} : { replayPlanId }),
  });
}

export function replayReconcileConflictError(replayPlanId?: Id<"rpl">): ErrorEnvelope {
  return buildReplayError({
    code: "E_REPLAY_RECONCILE_CONFLICT",
    category: "conflict",
    reason: "reconcile_conflict",
    stage: "replay_reconcile",
    ...(replayPlanId === undefined ? {} : { replayPlanId }),
  });
}

export function replaySchemaError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "replay_schema",
    details: { kind: "field", path, rule },
  });
}

export function replayStaleVersionError(expected: number, actual: number): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_STALE_VERSION",
    category: "version",
    message_key: "error.stale_version",
    stage: "replay_cas",
    details: {
      kind: "version",
      expected: String(expected),
      actual: String(actual),
    },
  });
}

