/**
 * Replay authorization precheck (DD-FND-094, DD-FND-096.3).
 *
 * `replay.authorize` never consumes an approval and never spawns a process.
 * `replay.execute` re-runs the same rules server-side; a client-supplied
 * classification, plan hash or token is never trusted.
 */

import { ok } from "@evoplug/core";
import type { Result, ErrorEnvelope } from "@evoplug/core";

import { computeReplayApprovalHash } from "./approval.js";
import { isVerifiedSandbox } from "./plan.js";
import type {
  ReplayApproval,
  ReplayAuthorization,
  ReplayPlan,
} from "./types.js";

export interface ReplayAuthorizationInput {
  readonly plan: ReplayPlan;
  readonly approval: ReplayApproval | null;
  readonly now_ms: number;
}

export function authorizeReplay(
  input: ReplayAuthorizationInput,
): Result<ReplayAuthorization, ErrorEnvelope> {
  const planId = input.plan.replay_plan_id;
  switch (input.plan.replay_class) {
    case "read_only":
      if (input.plan.allowed_network) {
        return ok({
          state: "rejected",
          replay_plan_id: planId,
          reason_code: "network_scope_mismatch",
          fencing_token: null,
        });
      }
      if (input.plan.classification_evidence === "none") {
        return ok({
          state: "rejected",
          replay_plan_id: planId,
          reason_code: "classifier_unknown",
          fencing_token: null,
        });
      }
      return ok({
        state: "authorized",
        replay_plan_id: planId,
        reason_code: "read_only_confirmed",
        fencing_token: null,
      });
    case "sandboxed_temp":
      if (!isVerifiedSandbox(input.plan.isolation)) {
        return ok({
          state: "rejected",
          replay_plan_id: planId,
          reason_code: "isolation_unverified",
          fencing_token: null,
        });
      }
      return ok({
        state: "authorized",
        replay_plan_id: planId,
        reason_code: "sandbox_verified",
        fencing_token: null,
      });
    case "live_external":
      return authorizeLiveExternal(input);
    default:
      return ok(replayInternalClassifierUnknown(planId));
  }
}

function authorizeLiveExternal(
  input: ReplayAuthorizationInput,
): Result<ReplayAuthorization, ErrorEnvelope> {
  const plan = input.plan;
  const planId = plan.replay_plan_id;
  const approval = input.approval;
  if (approval === null) {
    return ok({
      state: "needs_approval",
      replay_plan_id: planId,
      reason_code: "approval_missing",
      fencing_token: null,
    });
  }
  if (approval.replay_plan_id !== planId || approval.plan_hash !== plan.plan_hash) {
    return ok({
      state: "rejected",
      replay_plan_id: planId,
      reason_code: "approval_mismatch",
      fencing_token: null,
    });
  }
  if (
    approval.command !== plan.command ||
    approval.cwd !== plan.cwd ||
    approval.allowed_network !== plan.allowed_network ||
    !sameBinding(approval, plan)
  ) {
    return ok({
      state: "rejected",
      replay_plan_id: planId,
      reason_code: "approval_mismatch",
      fencing_token: null,
    });
  }
  if (approval.network_target !== plan.network_target) {
    return ok({
      state: "rejected",
      replay_plan_id: planId,
      reason_code: "network_scope_mismatch",
      fencing_token: null,
    });
  }
  if (approval.approval_hash !== computeReplayApprovalHash(approval)) {
    return ok({
      state: "rejected",
      replay_plan_id: planId,
      reason_code: "approval_mismatch",
      fencing_token: null,
    });
  }
  if (approval.state === "consumed") {
    return ok({
      state: "needs_approval",
      replay_plan_id: planId,
      reason_code: "approval_consumed",
      fencing_token: null,
    });
  }
  if (approval.state !== "active" || approval.expires_at <= input.now_ms) {
    return ok({
      state: "needs_approval",
      replay_plan_id: planId,
      reason_code: "approval_missing",
      fencing_token: null,
    });
  }
  return ok({
    state: "authorized",
    replay_plan_id: planId,
    reason_code: "explicit_approval",
    fencing_token: null,
  });
}

function sameBinding(approval: ReplayApproval, plan: ReplayPlan): boolean {
  const left = approval.version_binding;
  const right = plan.version_binding;
  return (
    left.task_id === right.task_id &&
    left.branch_id === right.branch_id &&
    left.input_epoch === right.input_epoch &&
    left.goal_version === right.goal_version &&
    left.config_version === right.config_version &&
    left.watermark === right.watermark
  );
}

function replayInternalClassifierUnknown(
  planId: ReplayPlan["replay_plan_id"],
): ReplayAuthorization {
  return {
    state: "rejected",
    replay_plan_id: planId,
    reason_code: "classifier_unknown",
    fencing_token: null,
  };
}
