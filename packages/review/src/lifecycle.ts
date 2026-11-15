/**
 * Lifecycle predicates and priority (DD-REV-110, DD-REV-111, DD-REV-130).
 *
 * Priority is `confirmed_regression` -> `host_incompatible` -> `expired` ->
 * `retained`. A fact that cannot be read is never treated as compatible.
 */

import type { ErrorEnvelope, Result } from "@evoplug/core";
import { err, ok } from "@evoplug/core";

import type { HostLifecycleFacts } from "./budget-contracts.js";
import { noVerifier, revError, windowLimit } from "./errors.js";
import { loadingStageSatisfied } from "./experience.js";
import type {
  ExperienceProjection,
  ProjectionLifecycleReason,
  UsageVerificationRecord,
  ValidationPlan
} from "./types.js";

export interface LifecycleFacts {
  projection: ExperienceProjection;
  plan: ValidationPlan;
  usages: readonly UsageVerificationRecord[];
  now: number;
  grant_valid: boolean;
  write_state: string;
  readback_verified: boolean;
  current_goal_version: string | null;
  host_facts: HostLifecycleFacts | null;
  host_facts_error: ErrorEnvelope | null;
  overlapping_regression: boolean;
  retention_policy: {
    invalidate_on_host_version_change: boolean;
    invalidate_on_tool_version_change: boolean;
    invalidate_on_model_family_change: boolean;
  };
}

export type LifecycleAction =
  | { kind: "begin_trial" }
  | { kind: "retained" }
  | { kind: "disabled"; reason: ProjectionLifecycleReason }
  | { kind: "revoked"; reason: "user_revoked" | "authorization_revoked" }
  | { kind: "none" };

export interface LifecycleEvaluation {
  action: LifecycleAction;
  predicates: {
    begin_trial: boolean;
    retained: boolean;
    confirmed_regression: boolean;
    host_incompatible: boolean;
    expired: boolean;
    extend_window: boolean;
    revoke: boolean;
  };
}

function positiveEvidence(usages: readonly UsageVerificationRecord[]): UsageVerificationRecord[] {
  return usages.filter((usage) => usage.result === "positive_evidence");
}

function withinWindow(usage: UsageVerificationRecord, projection: ExperienceProjection): boolean {
  const start = projection.retention.window_started_at ?? projection.checked_at;
  const end = projection.retention.window_end_at;
  if (end === undefined) {
    return true;
  }
  return usage.observed_at >= start && usage.observed_at < end;
}

export function beginTrialPredicate(facts: LifecycleFacts): Result<true, ErrorEnvelope> {
  const projection = facts.projection;
  if (projection.lifecycle !== "checked") {
    return err(
      revError({
        code: "E_EXPERIENCE_ILLEGAL_PROJECTION_TRANSITION",
        details: { kind: "field", path: "projection.lifecycle", rule: projection.lifecycle }
      })
    );
  }
  if (projection.no_verifier || facts.plan.verifier.kind === "none") {
    return err(noVerifier());
  }
  if (facts.write_state !== "verified" || !facts.readback_verified) {
    return err(
      revError({
        code: "E_WRITE_STATE",
        stage: "begin_trial",
        details: { kind: "field", path: "write.state", rule: facts.write_state }
      })
    );
  }
  if (!facts.grant_valid) {
    return err(
      revError({
        code: "E_AUTH_DENIED",
        stage: "begin_trial",
        details: { kind: "authorization", object_type: "experience", denied_dimension: "expiry" }
      })
    );
  }
  if (facts.plan.verifier.independence !== "independent") {
    return err(
      revError({
        code: "E_EXPERIENCE_VERIFIER_BINDING",
        details: { kind: "version", expected: "independent", actual: facts.plan.verifier.independence }
      })
    );
  }
  if (projection.validation_plan_hash !== facts.plan.plan_hash) {
    return err(
      revError({
        code: "E_EXPERIENCE_VERIFIER_BINDING",
        details: { kind: "version", expected: projection.validation_plan_hash, actual: facts.plan.plan_hash }
      })
    );
  }
  if (
    facts.current_goal_version === null ||
    facts.current_goal_version !== projection.adoption_binding.version_binding.goal_version
  ) {
    return err(
      revError({
        code: "E_VERSION_BINDING",
        stage: "begin_trial",
        details: {
          kind: "version",
          expected: projection.adoption_binding.version_binding.goal_version,
          actual: facts.current_goal_version ?? "null"
        }
      })
    );
  }
  return ok(true);
}

export function confirmedRegressionPredicate(facts: LifecycleFacts): boolean {
  if (facts.overlapping_regression) {
    return true;
  }
  return facts.usages.some(
    (usage) =>
      usage.verification.status === "failed" &&
      usage.experience_version === facts.projection.experience_version &&
      (usage.attribution === "isolated_replay" || usage.attribution === "controlled_trial")
  );
}

export function expiredPredicate(facts: LifecycleFacts): boolean {
  const projection = facts.projection;
  const end = projection.retention.window_end_at;
  if (projection.lifecycle === "checked") {
    return projection.no_verifier && end !== undefined && facts.now >= end;
  }
  if (projection.lifecycle === "trial") {
    return end !== undefined && facts.now >= end;
  }
  if (projection.lifecycle === "retained") {
    const reviewAfter = projection.retention.review_after_at;
    return reviewAfter !== undefined && facts.now >= reviewAfter;
  }
  return false;
}

export function hostIncompatiblePredicate(facts: LifecycleFacts): Result<boolean, ErrorEnvelope> {
  const projection = facts.projection;
  if (projection.lifecycle !== "trial" && projection.lifecycle !== "retained") {
    return ok(false);
  }
  const baseline = projection.baseline;
  if (baseline === null) {
    return ok(false);
  }
  if (facts.host_facts_error !== null) {
    return err(facts.host_facts_error);
  }
  if (facts.host_facts === null) {
    // No live facts supplied: the predicate is not evaluated. The service
    // path still fails closed through `host_facts_error`.
    return ok(false);
  }
  const current = facts.host_facts;
  const hostChanged = current.host_version !== baseline.host_version;
  const toolChanged = Object.keys({ ...baseline.tool_versions, ...current.tool_versions }).some(
    (tool) => baseline.tool_versions[tool] !== current.tool_versions[tool]
  );
  const modelChanged = current.model_family !== baseline.model_family;
  const expiry = projectionExpiryPolicy(facts);
  const incompatible =
    (hostChanged && expiry.invalidate_on_host_version_change) ||
    (toolChanged && expiry.invalidate_on_tool_version_change) ||
    (modelChanged && expiry.invalidate_on_model_family_change);
  return ok(incompatible);
}

function projectionExpiryPolicy(facts: LifecycleFacts): {
  invalidate_on_host_version_change: boolean;
  invalidate_on_tool_version_change: boolean;
  invalidate_on_model_family_change: boolean;
} {
  return facts.retention_policy;
}

export function retainedPredicate(facts: LifecycleFacts): boolean {
  const projection = facts.projection;
  if (projection.lifecycle !== "trial") {
    return false;
  }
  const end = projection.retention.window_end_at;
  if (end === undefined || facts.now >= end) {
    return false;
  }
  const positives = positiveEvidence(facts.usages).filter((usage) => withinWindow(usage, projection));
  const distinctTasks = new Set(positives.map((usage) => usage.version_binding.task_id));
  if (distinctTasks.size < facts.plan.retention_rule.min_independent_passes) {
    return false;
  }
  if (positives.length > facts.plan.observation_window.max_triggered_uses) {
    return false;
  }
  for (const usage of positives) {
    if (!facts.plan.retention_rule.required_verifier_kinds.includes(usage.verification.kind)) {
      return false;
    }
    if (usage.verification.independence !== "independent") {
      return false;
    }
    if (usage.verification.validation_plan_hash !== projection.validation_plan_hash) {
      return false;
    }
    if (
      usage.loading.included !== "provider_payload" &&
      usage.loading.included !== "transport_body" &&
      usage.loading.included !== "verified"
    ) {
      return false;
    }
  }
  for (const required of facts.plan.required_loading_evidence) {
    // Every positive record that counts toward retention must carry the
    // required loading stage; one unrelated verified record cannot satisfy it.
    const satisfied = positives.every((usage) => loadingStageSatisfied(required, usage.loading));
    if (!satisfied) {
      return false;
    }
  }
  return true;
}

export function extendWindowPredicate(facts: LifecycleFacts): Result<true, ErrorEnvelope> {
  const projection = facts.projection;
  if (projection.lifecycle !== "trial") {
    return err(
      revError({
        code: "E_EXPERIENCE_ILLEGAL_PROJECTION_TRANSITION",
        details: { kind: "field", path: "projection.lifecycle", rule: projection.lifecycle }
      })
    );
  }
  const end = projection.retention.window_end_at;
  if (end === undefined || facts.now >= end) {
    return err(windowLimit("retention.window_end_at", "expired"));
  }
  if (projection.retention.window_extensions >= facts.plan.observation_window.max_extensions) {
    return err(windowLimit("retention.window_extensions", "max_extensions"));
  }
  if (!facts.grant_valid) {
    return err(
      revError({
        code: "E_AUTH_DENIED",
        stage: "extend_window",
        details: { kind: "authorization", object_type: "experience", denied_dimension: "expiry" }
      })
    );
  }
  return ok(true);
}

export function revokeReason(
  actor: "user" | "authorization_owner"
): { reason: ProjectionLifecycleReason; trigger: "user_action" | "authorization_change" } {
  return actor === "user"
    ? { reason: "user_revoked", trigger: "user_action" }
    : { reason: "authorization_revoked", trigger: "authorization_change" };
}

/** Fixed priority; the first applicable predicate wins. */
export function evaluateLifecycle(facts: LifecycleFacts): Result<LifecycleEvaluation, ErrorEnvelope> {
  const hostIncompatible = hostIncompatiblePredicate(facts);
  if (!hostIncompatible.ok) {
    return err(hostIncompatible.error);
  }
  const predicates: LifecycleEvaluation["predicates"] = {
    begin_trial: false,
    retained: retainedPredicate(facts),
    confirmed_regression: confirmedRegressionPredicate(facts),
    host_incompatible: hostIncompatible.value,
    expired: expiredPredicate(facts),
    extend_window: false,
    revoke: false
  };
  if (predicates.confirmed_regression) {
    return ok({ action: { kind: "disabled", reason: "confirmed_regression" }, predicates });
  }
  if (predicates.host_incompatible) {
    return ok({ action: { kind: "disabled", reason: "host_incompatible" }, predicates });
  }
  if (predicates.expired) {
    return ok({ action: { kind: "disabled", reason: "expired" }, predicates });
  }
  if (predicates.retained) {
    return ok({ action: { kind: "retained" }, predicates });
  }
  return ok({ action: { kind: "none" }, predicates });
}

export function lifecycleTransitionError(
  from: ExperienceProjection["lifecycle"],
  to: ExperienceProjection["lifecycle"]
): ErrorEnvelope | null {
  const edges: Readonly<Record<ExperienceProjection["lifecycle"], readonly ExperienceProjection["lifecycle"][]>> = {
    checked: ["trial", "disabled", "revoked"],
    trial: ["retained", "disabled", "revoked"],
    retained: ["disabled", "revoked"],
    disabled: [],
    revoked: []
  };
  return edges[from].includes(to)
    ? null
    : revError({
        code: "E_EXPERIENCE_ILLEGAL_PROJECTION_TRANSITION",
        details: { kind: "field", path: "projection.lifecycle", rule: `${from}->${to}` }
      });
}

export function isActiveProjection(lifecycle: ExperienceProjection["lifecycle"]): boolean {
  return lifecycle === "trial" || lifecycle === "retained";
}

export function disabledReasonForAction(
  action: LifecycleAction
): ProjectionLifecycleReason | null {
  return action.kind === "disabled" ? action.reason : null;
}

export function activeTargetKey(projection: ExperienceProjection): string {
  return `${projection.host_id}\u0000${projection.config_space}\u0000${projection.mode}\u0000${projection.object_type}\u0000${projection.path_or_block}\u0000${projection.block_id ?? ""}`;
}
