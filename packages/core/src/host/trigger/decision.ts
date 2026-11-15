/**
 * Automatic and explicit trigger decisions (DD-TRG-006).
 *
 * The decision table is implemented in the documented first-error order. The
 * functions are pure: callers supply already-observed facts and never get an
 * inferred stable boundary or capability status from here.
 */

import type { Id } from "../../ids.js";
import type {
  CapabilityGateResult,
  CapabilityStatus,
  EvidenceStage,
  OriginKind,
  StableBoundaryEvidence,
  TriggerOrigin,
  TriggerPolicy,
  TriggerReasonCode,
  VerifiedSignal
} from "../types.js";
import { hasVerifiedAutoSignal, isCompletionClaimOnly } from "./signals.js";
import { triggerPolicyHash } from "../keys.js";

export type TriggerDecisionKind = "enqueue" | "skip" | "defer" | "suppress";

export interface TriggerDecision {
  decision: TriggerDecisionKind;
  reason: TriggerReasonCode;
  /** True only for explicit staged enqueues (`explicit_stage`). */
  staged: boolean;
}

/** Evaluator and its descendants are always suppressed (HOST-02, DD-TRG-005). */
export function isSuppressedOrigin(origin: TriggerOrigin, policy: TriggerPolicy): boolean {
  if (origin.kind === "evaluator") {
    return policy.origin.evaluator_suppression;
  }
  if (origin.kind === "evaluator_descendant") {
    return policy.origin.descendant_suppression;
  }
  return false;
}

export function capabilityReason(status: CapabilityStatus): TriggerDecision["reason"] {
  switch (status) {
    case "unknown":
      return "capability_unknown";
    case "unsupported":
      return "capability_unsupported";
    case "failed":
      return "capability_failed";
    case "verified":
      return "auto_enqueued";
  }
}

export interface StableBoundaryInput {
  candidate: boolean;
  boundary_kind: StableBoundaryEvidence["boundary_kind"];
  stable_event_ids: readonly string[];
  source_event_ids: readonly string[];
  stable_watermark: number;
  goal_version: string;
  pending_state: "none" | "pending" | "unknown";
  pending_work_refs: StableBoundaryEvidence["pending_work_refs"];
  watermark_gap: boolean;
  goal_changed: boolean;
}

/**
 * Computes `StableBoundaryEvidence` (I-04). Any unknown component makes the
 * boundary unstable with an explicit reason; it is never silently treated as
 * stable.
 */
export function assessStableBoundary(input: StableBoundaryInput): StableBoundaryEvidence {
  const unstableReasons: string[] = [];
  if (!input.candidate) {
    unstableReasons.push("not_boundary_candidate");
  }
  if (input.watermark_gap) {
    unstableReasons.push("watermark_gap");
  }
  if (input.goal_changed) {
    unstableReasons.push("goal_changed");
  }
  if (input.pending_state === "pending") {
    unstableReasons.push("stable_boundary_pending");
  }
  if (input.pending_state === "unknown") {
    unstableReasons.push("stable_boundary_unknown");
  }
  if (input.candidate && input.stable_event_ids.length === 0 && !input.watermark_gap) {
    unstableReasons.push("stable_event_missing");
  }
  const stable =
    input.candidate &&
    !input.watermark_gap &&
    !input.goal_changed &&
    input.pending_state === "none" &&
    input.stable_event_ids.length > 0;
  return {
    candidate: input.candidate,
    stable,
    boundary_kind: input.candidate ? input.boundary_kind : "none",
    stable_event_ids: Array.from(new Set(input.stable_event_ids)),
    source_event_ids: Array.from(new Set(input.source_event_ids)),
    stable_watermark: input.stable_watermark,
    goal_version: input.goal_version,
    pending_state: input.pending_state,
    pending_work_refs: input.pending_work_refs,
    unstable_reasons: unstableReasons
  };
}

export interface AutoDecisionInput {
  origin: TriggerOrigin;
  boundary: StableBoundaryEvidence;
  signals: readonly VerifiedSignal[];
  stableBoundaryStatus: CapabilityStatus;
  liveJob: boolean;
  replayDuplicate: boolean;
  autoQuotaExhausted: boolean;
  budgetAvailable: boolean;
  policy: TriggerPolicy;
  /**
   * Current goal version. Defaults to `boundary.goal_version`. Signals that
   * carry a different `goal_version` were detected before the active goal and
   * are stale (DD-TRG-009); they never participate in the signal gate.
   */
  goal_version?: string;
}

/**
 * True when a signal predates the active goal/policy generation. A signal with
 * an explicit `goal_version` is stale when it differs from the current goal.
 * Without one, a detection earlier than the active policy's creation is
 * treated as stale rather than silently re-used for a newer goal.
 */
function isStaleSignal(signal: VerifiedSignal, goalVersion: string, policyCreatedAt: number): boolean {
  if (signal.goal_version !== undefined) {
    return signal.goal_version !== goalVersion;
  }
  return signal.detected_at < policyCreatedAt;
}

/** Automatic path, in the fixed DD-TRG-006 order. */
/**
 * True when the stored policy hash equals the recomputed semantic hash.
 * A row that cannot be hashed (missing scope or malformed fields) counts as
 * a mismatch so that the safe default applies instead of throwing.
 */
function policyHashMatches(policy: TriggerPolicy): boolean {
  if (policy.scope === null || typeof policy.scope !== "object") {
    return false;
  }
  try {
    return policy.policy_hash === triggerPolicyHash(policy);
  } catch {
    return false;
  }
}

export function decideAutomatic(input: AutoDecisionInput): TriggerDecision {
  const originKind: OriginKind = input.origin.kind;
  if (originKind === "evaluator" || originKind === "evaluator_descendant") {
    return { decision: "suppress", reason: "internal_origin", staged: false };
  }
  if (originKind === "unknown") {
    return { decision: "skip", reason: "origin_unknown", staged: false };
  }
  if (!input.policy.review.auto.enabled) {
    return { decision: "skip", reason: "policy_auto_disabled", staged: false };
  }
  // DD-TRG-002: a policy row whose stored hash no longer matches the
  // recomputed semantic hash falls back to `safe_default`, which turns
  // automatic review off.
  if (!policyHashMatches(input.policy)) {
    return { decision: "skip", reason: "policy_auto_disabled", staged: false };
  }
  if (!input.boundary.candidate) {
    return { decision: "skip", reason: "not_boundary_candidate", staged: false };
  }
  if (input.boundary.pending_state === "pending") {
    return { decision: "defer", reason: "stable_boundary_pending", staged: false };
  }
  if (input.boundary.pending_state === "unknown") {
    return { decision: "defer", reason: "stable_boundary_unknown", staged: false };
  }
  if (input.boundary.unstable_reasons.includes("watermark_gap")) {
    return { decision: "skip", reason: "watermark_gap", staged: false };
  }
  if (!input.boundary.stable) {
    return { decision: "skip", reason: "not_boundary_candidate", staged: false };
  }
  if (input.stableBoundaryStatus !== "verified") {
    return { decision: "skip", reason: capabilityReason(input.stableBoundaryStatus), staged: false };
  }
  const goalVersion = input.goal_version ?? input.boundary.goal_version;
  const activeSignals = input.signals.filter(
    (signal) => !isStaleSignal(signal, goalVersion, input.policy.created_at)
  );
  if (isCompletionClaimOnly(activeSignals)) {
    return { decision: "skip", reason: "completion_claim_only", staged: false };
  }
  const relevant = activeSignals.filter((signal) => input.policy.review.auto.min_signals.includes(signal.type));
  if (!hasVerifiedAutoSignal(relevant)) {
    return { decision: "skip", reason: "no_verified_signal", staged: false };
  }
  if (input.replayDuplicate) {
    return { decision: "skip", reason: "replay_duplicate", staged: false };
  }
  if (input.liveJob) {
    return { decision: "skip", reason: "job_live", staged: false };
  }
  if (input.autoQuotaExhausted) {
    return { decision: "skip", reason: "auto_quota_exhausted", staged: false };
  }
  if (!input.budgetAvailable) {
    return { decision: "skip", reason: "budget_unavailable", staged: false };
  }
  return { decision: "enqueue", reason: "auto_enqueued", staged: false };
}

export interface ExplicitDecisionInput {
  origin: TriggerOrigin;
  boundary: StableBoundaryEvidence;
  authorizationRef: Id<"grant"> | null;
  stage: boolean;
  liveJob: boolean;
  replayDuplicate: boolean;
  policy: TriggerPolicy;
}

/**
 * Explicit path. A `grant_missing` skip happens before any FND authorization
 * gate and therefore never produces an interaction escalation.
 */
export function decideExplicit(input: ExplicitDecisionInput): TriggerDecision {
  if (input.origin.kind === "evaluator" || input.origin.kind === "evaluator_descendant") {
    return { decision: "suppress", reason: "internal_origin", staged: false };
  }
  if (input.authorizationRef === null) {
    return { decision: "skip", reason: "grant_missing", staged: false };
  }
  if (!input.policy.review.explicit.enabled) {
    return { decision: "skip", reason: "policy_auto_disabled", staged: false };
  }
  if (input.replayDuplicate) {
    return { decision: "skip", reason: "replay_duplicate", staged: false };
  }
  if (input.liveJob) {
    return { decision: "skip", reason: "job_live", staged: false };
  }
  if (input.stage) {
    return { decision: "enqueue", reason: "explicit_stage", staged: true };
  }
  if (input.boundary.pending_state === "pending" || input.boundary.pending_state === "unknown") {
    return { decision: "defer", reason: "stable_boundary_pending", staged: false };
  }
  if (!input.boundary.stable && input.boundary.pending_state === "none") {
    return { decision: "enqueue", reason: "explicit_stage", staged: true };
  }
  return { decision: "enqueue", reason: "explicit_enqueued", staged: false };
}

/** Builds the `capability_gate` projection stored on a TriggerEvent. */
export function buildCapabilityGate(
  required: readonly string[],
  statusOf: (name: string) => { status: CapabilityStatus; evidence_stage: CapabilityGateResult["evidence_stage"] }
): CapabilityGateResult[] {
  return required.map((name) => {
    const observed = statusOf(name);
    const result: CapabilityGateResult = {
      name: name as CapabilityGateResult["name"],
      subject: "product_adapter",
      required_status: "verified",
      observed_status: observed.status,
      evidence_stage: observed.evidence_stage,
      passed: observed.status === "verified"
    };
    if (observed.status !== "verified") {
      result.reason_code = capabilityReason(observed.status);
    }
    return result;
  });
}

/** True when every capability gate entry passed. */
export function capabilityGatePassed(gate: readonly CapabilityGateResult[]): boolean {
  return gate.every((entry) => entry.passed);
}
