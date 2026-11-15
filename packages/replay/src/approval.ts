/**
 * Replay approval issuance, cancellation and one-time consumption
 * (DD-FND-094, DD-FND-096.1/96.2/96.3).
 *
 * Every control-plane subject hash binds the exact purpose. `approval_hash`
 * includes `approval_id`, so re-approving the same plan produces a new hash
 * and can never collide with the unique index. Consumption is atomic in the
 * journal before SQLite; these helpers describe the transitions the service
 * must persist in that order.
 */

import {
  canonicalHash,
  equalVersionBinding,
  err,
  ok,
} from "@evoplug/core";
import type {
  ErrorEnvelope,
  Hash,
  Id,
  JsonValue,
  Result,
} from "@evoplug/core";
import type { HumanAttestation } from "@evoplug/egress";

import {
  replayApprovalConsumedError,
  replayApprovalExpiredError,
  replayApprovalMismatchError,
  replayApprovalRevokedError,
  replayApprovalStateError,
  replayExecutionInProgressError,
  replayExecutionReconcileRequiredError,
  replayPlanMismatchError,
  replayPlanStateError,
  replaySchemaError,
} from "./errors.js";
import { computeReplayPlanHash } from "./hash.js";
import {
  REPLAY_MAX_REASON_BYTES,
  REPLAY_MAX_TTL_MS,
  REPLAY_MIN_TTL_MS,
  type ReplayApproval,
  type ReplayApprovalView,
  type ReplayPlan,
  type ReplayRevokeReason,
} from "./types.js";

export const REPLAY_APPROVE_SUBJECT_SCHEMA_VERSION: "rsi.replay_approve_subject/1" =
  "rsi.replay_approve_subject/1";

export const REPLAY_APPROVAL_HASH_SCHEMA_VERSION: "rsi.replay_approval_hash/1" =
  "rsi.replay_approval_hash/1";

export const REPLAY_REVOKE_SUBJECT_SCHEMA_VERSION: "rsi.replay_revoke_subject/1" =
  "rsi.replay_revoke_subject/1";

export const REPLAY_REJECT_SUBJECT_SCHEMA_VERSION: "rsi.replay_reject_subject/1" =
  "rsi.replay_reject_subject/1";

export const REPLAY_RECONCILE_SUBJECT_SCHEMA_VERSION: "rsi.replay_reconcile_subject/1" =
  "rsi.replay_reconcile_subject/1";

export interface CreateReplayApprovalInput {
  readonly approval_id: Id<"rpa">;
  readonly plan: ReplayPlan;
  readonly expected_plan_hash: Hash;
  readonly ttl_ms: number;
  /** 1..512 UTF-8 bytes; enters the attestation subject only. */
  readonly reason: string;
  readonly now_ms: number;
  readonly human_attestation: HumanAttestation;
  /** At least one `authorized`/`running` execution exists for the plan. */
  readonly has_active_execution?: boolean;
  /** An `unknown` execution still has `reconcile_required=1`. */
  readonly has_unreconciled_unknown?: boolean;
}

/** `sha256(JCS({schema_version:"rsi.replay_approve_subject/1", …}))`. */
export function computeReplayApproveSubjectHash(input: {
  replay_plan_id: Id<"rpl">;
  plan_hash: Hash;
  ttl_ms: number;
  reason: string;
}): Hash {
  const preimage: JsonValue = {
    schema_version: REPLAY_APPROVE_SUBJECT_SCHEMA_VERSION,
    purpose: "replay_approve",
    replay_plan_id: input.replay_plan_id,
    plan_hash: input.plan_hash,
    ttl_ms: input.ttl_ms,
    reason: input.reason,
  };
  return canonicalHash(preimage);
}

/** `sha256(JCS(preimage))` over the DD-FND-094 approval white list. */
export function computeReplayApprovalHash(
  approval: Omit<ReplayApproval, "approval_hash">,
): Hash {
  const preimage: JsonValue = {
    schema_version: REPLAY_APPROVAL_HASH_SCHEMA_VERSION,
    approval_id: approval.approval_id,
    replay_plan_id: approval.replay_plan_id,
    plan_hash: approval.plan_hash,
    approved_by: "human",
    attestation_subject_hash: approval.attestation_subject_hash,
    command: approval.command,
    cwd: approval.cwd,
    version_binding: {
      task_id: approval.version_binding.task_id,
      branch_id: approval.version_binding.branch_id,
      input_epoch: approval.version_binding.input_epoch,
      goal_version: approval.version_binding.goal_version,
      config_version: approval.version_binding.config_version,
      watermark: approval.version_binding.watermark,
    },
    allowed_network: approval.allowed_network,
    network_target: approval.network_target,
    ttl_ms: approval.ttl_ms,
  };
  return canonicalHash(preimage);
}

export function computeReplayRevokeSubjectHash(input: {
  approval_id: Id<"rpa">;
  expected_approval_hash: Hash;
  reason: ReplayRevokeReason;
}): Hash {
  const preimage: JsonValue = {
    schema_version: REPLAY_REVOKE_SUBJECT_SCHEMA_VERSION,
    purpose: "replay_revoke",
    approval_id: input.approval_id,
    expected_approval_hash: input.expected_approval_hash,
    reason: input.reason,
  };
  return canonicalHash(preimage);
}

export function computeReplayRejectSubjectHash(input: {
  replay_plan_id: Id<"rpl">;
  plan_hash: Hash;
  reason: string;
}): Hash {
  const preimage: JsonValue = {
    schema_version: REPLAY_REJECT_SUBJECT_SCHEMA_VERSION,
    purpose: "replay_reject",
    replay_plan_id: input.replay_plan_id,
    plan_hash: input.plan_hash,
    reason: input.reason,
  };
  return canonicalHash(preimage);
}

export function computeReplayReconcileSubjectHash(input: {
  execution_id: Id<"rex">;
  fencing_token: string;
  evidence_ref: string;
  reason: string;
}): Hash {
  const preimage: JsonValue = {
    schema_version: REPLAY_RECONCILE_SUBJECT_SCHEMA_VERSION,
    purpose: "replay_reconcile",
    execution_id: input.execution_id,
    fencing_token: input.fencing_token,
    evidence_ref: input.evidence_ref,
    reason: input.reason,
  };
  return canonicalHash(preimage);
}

/**
 * Freezes an active `live_external` approval. The caller must have verified
 * the control-plane attestation over `computeReplayApproveSubjectHash`.
 */
export function createReplayApproval(
  input: CreateReplayApprovalInput,
): Result<ReplayApproval, ErrorEnvelope> {
  if (
    !Number.isSafeInteger(input.ttl_ms) ||
    input.ttl_ms < REPLAY_MIN_TTL_MS ||
    input.ttl_ms > REPLAY_MAX_TTL_MS
  ) {
    return err(replaySchemaError("ttl_ms", "1_600000"));
  }
  const reasonFailure = validateReason(input.reason);
  if (reasonFailure !== null) {
    return err(reasonFailure);
  }
  if (input.plan.plan_hash !== input.expected_plan_hash) {
    return err(replayPlanMismatchError(input.plan.replay_plan_id));
  }
  if (computeReplayPlanHash(input.plan) !== input.plan.plan_hash) {
    return err(replayPlanMismatchError(input.plan.replay_plan_id));
  }
  if (input.plan.state !== "planned" && input.plan.state !== "unverified") {
    return err(replayPlanStateError(input.plan.replay_plan_id));
  }
  if (input.plan.replay_class !== "live_external") {
    return err(replayPlanStateError(input.plan.replay_plan_id));
  }
  if (input.has_active_execution === true) {
    return err(replayExecutionInProgressError(input.plan.replay_plan_id));
  }
  if (input.has_unreconciled_unknown === true) {
    return err(replayExecutionReconcileRequiredError(input.plan.replay_plan_id));
  }
  const subjectHash = computeReplayApproveSubjectHash({
    replay_plan_id: input.plan.replay_plan_id,
    plan_hash: input.plan.plan_hash,
    ttl_ms: input.ttl_ms,
    reason: input.reason,
  });
  const withoutHash: Omit<ReplayApproval, "approval_hash"> = {
    approval_id: input.approval_id,
    replay_plan_id: input.plan.replay_plan_id,
    plan_hash: input.plan.plan_hash,
    approved_by: "human",
    human_attestation: input.human_attestation,
    attestation_subject_hash: subjectHash,
    command: input.plan.command,
    cwd: input.plan.cwd,
    version_binding: input.plan.version_binding,
    allowed_network: input.plan.allowed_network,
    network_target: input.plan.network_target,
    ttl_ms: input.ttl_ms,
    state: "active",
    created_at: input.now_ms,
    expires_at: input.now_ms + input.ttl_ms,
    consumed_at: null,
    consumed_execution_id: null,
    revoked_at: null,
    revoke_reason: null,
    row_version: 1,
  };
  return ok({
    ...withoutHash,
    approval_hash: computeReplayApprovalHash(withoutHash),
  });
}

/**
 * Validates an approval for `replay.execute` and returns the `consumed`
 * transition. Order: plan/hash/scope match first, then state, then expiry.
 */
export function consumeReplayApproval(
  approval: ReplayApproval,
  plan: ReplayPlan,
  executionId: Id<"rex">,
  nowMs: number,
): Result<ReplayApproval, ErrorEnvelope> {
  if (
    approval.replay_plan_id !== plan.replay_plan_id ||
    approval.plan_hash !== plan.plan_hash ||
    !equalVersionBinding(approval.version_binding, plan.version_binding) ||
    approval.command !== plan.command ||
    approval.cwd !== plan.cwd ||
    approval.allowed_network !== plan.allowed_network ||
    approval.network_target !== plan.network_target
  ) {
    return err(replayApprovalMismatchError(plan.replay_plan_id));
  }
  if (approval.approval_hash !== computeReplayApprovalHash(approval)) {
    return err(replayApprovalMismatchError(plan.replay_plan_id));
  }
  switch (approval.state) {
    case "consumed":
      return err(replayApprovalConsumedError(plan.replay_plan_id));
    case "revoked":
      return err(replayApprovalRevokedError(plan.replay_plan_id));
    case "expired":
      return err(replayApprovalExpiredError(plan.replay_plan_id));
    case "active":
      break;
    default:
      return err(replayApprovalStateError(plan.replay_plan_id));
  }
  if (approval.expires_at <= nowMs) {
    return err(replayApprovalExpiredError(plan.replay_plan_id));
  }
  return ok({
    ...approval,
    state: "consumed",
    consumed_at: nowMs,
    consumed_execution_id: executionId,
    row_version: approval.row_version + 1,
  });
}

/** `active → revoked`; the expected hash is a CAS guard, not a lookup key. */
export function revokeReplayApproval(
  approval: ReplayApproval,
  expectedApprovalHash: Hash,
  nowMs: number,
  reason: ReplayRevokeReason,
): Result<ReplayApproval, ErrorEnvelope> {
  if (approval.approval_hash !== expectedApprovalHash) {
    return err(replayApprovalMismatchError(approval.replay_plan_id));
  }
  switch (approval.state) {
    case "consumed":
      return err(replayApprovalConsumedError(approval.replay_plan_id));
    case "revoked":
      return err(replayApprovalRevokedError(approval.replay_plan_id));
    case "expired":
      return err(replayApprovalExpiredError(approval.replay_plan_id));
    case "active":
      break;
    default:
      return err(replayApprovalStateError(approval.replay_plan_id));
  }
  if (approval.expires_at <= nowMs) {
    return err(replayApprovalExpiredError(approval.replay_plan_id));
  }
  return ok({
    ...approval,
    state: "revoked",
    revoked_at: nowMs,
    revoke_reason: reason,
    row_version: approval.row_version + 1,
  });
}

/** Access-path/recovery `active → expired`; terminal states are unchanged. */
export function expireReplayApproval(
  approval: ReplayApproval,
  nowMs: number,
): ReplayApproval {
  if (approval.state !== "active" || approval.expires_at > nowMs) {
    return approval;
  }
  return {
    ...approval,
    state: "expired",
    row_version: approval.row_version + 1,
  };
}

export interface RejectReplayPlanResult {
  readonly plan: ReplayPlan;
  readonly approvals: readonly ReplayApproval[];
}

/**
 * `replay.reject`: every active approval is revoked with
 * `reason="plan_rejected"` before the plan becomes `rejected`. Partial journal
 * prefixes are recovered by the service in that order.
 */
export function rejectReplayPlan(
  plan: ReplayPlan,
  approvals: readonly ReplayApproval[],
  expectedPlanHash: Hash,
  nowMs: number,
  hasActiveExecution: boolean,
  hasUnreconciledUnknown: boolean,
): Result<RejectReplayPlanResult, ErrorEnvelope> {
  if (plan.plan_hash !== expectedPlanHash || computeReplayPlanHash(plan) !== plan.plan_hash) {
    return err(replayPlanMismatchError(plan.replay_plan_id));
  }
  if (plan.state !== "planned" && plan.state !== "unverified") {
    return err(replayPlanStateError(plan.replay_plan_id));
  }
  if (hasActiveExecution) {
    return err(replayExecutionInProgressError(plan.replay_plan_id));
  }
  if (hasUnreconciledUnknown) {
    return err(replayExecutionReconcileRequiredError(plan.replay_plan_id));
  }
  const revoked: ReplayApproval[] = [];
  for (const approval of approvals) {
    if (approval.replay_plan_id !== plan.replay_plan_id) {
      continue;
    }
    if (approval.state !== "active") {
      continue;
    }
    revoked.push({
      ...approval,
      state: "revoked",
      revoked_at: nowMs,
      revoke_reason: "plan_rejected",
      row_version: approval.row_version + 1,
    });
  }
  return ok({
    plan: { ...plan, state: "rejected" },
    approvals: revoked,
  });
}

/** Strips attestation text for IPC responses. */
export function toReplayApprovalView(approval: ReplayApproval): ReplayApprovalView {
  const { human_attestation: _attestation, ...view } = approval;
  return view;
}

/** Validates a 1..512 UTF-8 byte audit reason. */
export function validateReason(reason: string): ErrorEnvelope | null {
  if (typeof reason !== "string" || reason.length === 0) {
    return replaySchemaError("reason", "non_empty_string");
  }
  if (new TextEncoder().encode(reason).length > REPLAY_MAX_REASON_BYTES) {
    return replaySchemaError("reason", `max_${String(REPLAY_MAX_REASON_BYTES)}_bytes`);
  }
  return null;
}
