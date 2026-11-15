/**
 * Frozen decision action/reason mapping (DD-FND-072).
 *
 * `action.kind` is copied to `action_kind`; a reason outside the allowlist for
 * that action is rejected. The map is the single source for this rule and is
 * exported frozen so callers cannot extend it at runtime.
 */

export type DecisionActionKind =
  | "no_op"
  | "dedupe_hit"
  | "fact_reminder"
  | "semantic_reminder"
  | "shadow_recorded"
  | "needs_evidence"
  | "abstain"
  | "review_enqueued"
  | "write_pending"
  | "write_authorized"
  | "late_history"
  | "sync_requirement"
  | "budget_blocked"
  | "delivery_expired"
  | "identity_fork"
  | "identity_resume";

export type DecisionReasonCode =
  | "none"
  | "duplicate"
  | "already_delivered"
  | "hard_fact"
  | "semantic_candidate"
  | "shadow_only"
  | "missing_evidence"
  | "ambiguous"
  | "explicit_request"
  | "authorized_write"
  | "late_evidence"
  | "goal_changed"
  | "budget_unknown"
  | "budget_limited"
  | "rate_limited"
  | "delivery_expired"
  | "capability_unknown"
  | "policy_block";

export const DECISION_ACTION_KINDS: readonly DecisionActionKind[] = [
  "no_op",
  "dedupe_hit",
  "fact_reminder",
  "semantic_reminder",
  "shadow_recorded",
  "needs_evidence",
  "abstain",
  "review_enqueued",
  "write_pending",
  "write_authorized",
  "late_history",
  "sync_requirement",
  "budget_blocked",
  "delivery_expired",
  "identity_fork",
  "identity_resume",
];

/**
 * Allowed `reason_code` values per action. `no_op` accepts the no-op reasons
 * and `none`; `identity_fork`/`identity_resume` accept only
 * `explicit_request`.
 */
export const DECISION_ACTION_REASON_ALLOWLIST: Readonly<
  Record<DecisionActionKind, readonly DecisionReasonCode[]>
> = Object.freeze({
  no_op: ["none"],
  dedupe_hit: ["duplicate", "already_delivered"],
  fact_reminder: ["hard_fact"],
  semantic_reminder: ["semantic_candidate"],
  shadow_recorded: ["shadow_only"],
  needs_evidence: ["missing_evidence"],
  abstain: ["ambiguous", "hard_fact"],
  review_enqueued: ["explicit_request", "missing_evidence"],
  write_pending: ["authorized_write"],
  write_authorized: ["authorized_write"],
  late_history: ["late_evidence"],
  sync_requirement: ["goal_changed"],
  budget_blocked: ["budget_unknown", "budget_limited", "rate_limited", "policy_block"],
  delivery_expired: ["delivery_expired"],
  identity_fork: ["explicit_request"],
  identity_resume: ["explicit_request"],
});

export function isAllowedDecisionReason(
  kind: DecisionActionKind,
  reason: DecisionReasonCode,
): boolean {
  return DECISION_ACTION_REASON_ALLOWLIST[kind].includes(reason);
}

export interface DecisionActionReasonCheck {
  readonly action_kind: DecisionActionKind;
  readonly reason_code: DecisionReasonCode;
}

export type DecisionActionReasonVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "unknown_action" | "reason_not_allowed" };

/** Validates the `action_kind`/`reason_code` pairing. */
export function checkDecisionActionReason(
  check: DecisionActionReasonCheck,
): DecisionActionReasonVerdict {
  if (!DECISION_ACTION_KINDS.includes(check.action_kind)) {
    return { ok: false, reason: "unknown_action" };
  }
  if (!isAllowedDecisionReason(check.action_kind, check.reason_code)) {
    return { ok: false, reason: "reason_not_allowed" };
  }
  return { ok: true };
}
