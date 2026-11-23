/**
 * Deterministic dispatch short-circuit (W3 / D1).
 *
 * The semantic backend is only asked when a question cannot be settled from
 * verified local facts. This module is a pure decision layer:
 *
 *   - `decided`            every required proposition of the question has a
 *                          clean verified hard decision under the current
 *                          `VersionBinding`;
 *   - `gap`                no verified hard fact can settle the question and
 *                          no stronger signal exists, so the question needs
 *                          evidence supplementation (W4 decides how);
 *   - `semantic_required`  the question is genuinely ambiguous, unbound, only
 *                          partially covered by hard facts, or carries
 *                          observed-but-unverified evidence.
 *
 * The layer never reads a clock, never writes, never upgrades an observed
 * fact to a verified one and never invents a missing proposition or
 * requirement identity. A hard conflict is never `decided`.
 *
 * The input types are structural mirrors of the read-only views the online
 * pipeline already has (`AggregatePlanView.questions`, `HardFactReadView`).
 * `@evoplug/core` must not depend on `@evoplug/evidence`, so the mirrors live
 * here and the caller passes its own views unchanged.
 */

import type { Hash } from "../../hash.js";
import type { VersionBinding } from "../../version-binding.js";

/* ------------------------------------------------------------------ */
/* Local closed unions                                                 */
/* ------------------------------------------------------------------ */

/**
 * Closed gap-code set, structurally identical to the EVD evidence domain's
 * `EvidenceGapCode`. It is declared locally so the HOST submodule never
 * imports another core submodule (or another package) just for a literal
 * union; a caller's gap code stays assignable by structure.
 */
type DispatchGapCode =
  | "source_unretrievable"
  | "interface_contract_missing"
  | "artifact_version_unknown"
  | "verifier_absent"
  | "counterevidence_not_searched"
  | "capture_gap"
  | "template_role_unresolved"
  | "authorization_not_local"
  | "conflicting_sources";

/** Closed routing-reason set, structurally identical to `JudgmentRouteReason`. */
type DispatchRouteReason =
  | "deterministic_decisive"
  | "deterministic_inconclusive"
  | "retrieval_required"
  | "retrieval_gap"
  | "retrieval_truncated"
  | "semantic_not_needed"
  | "semantic_disabled"
  | "semantic_unavailable"
  | "semantic_shadow"
  | "semantic_unknown"
  | "verification_existing_fact"
  | "verification_absent"
  | "verification_failed"
  | "verification_not_independent"
  | "scope_mismatch"
  | "version_stale"
  | "counterevidence"
  | "conflict"
  | "budget_exhausted"
  | "deadline_exceeded"
  | "rate_limited"
  | "cancelled"
  | "late_discarded"
  | "skipped_by_order"
  | "owner_unavailable";

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

/** Structural subset of `AggregatePlanView["questions"][number]`. */
export interface DispatchQuestionView {
  readonly question_key: string;
  readonly proposition_id: string;
  readonly requirement_ids: readonly string[];
  readonly required_for_issue: boolean;
}

/** Structural subset of `HardFactReadView`. */
export interface DispatchHardFactView {
  readonly fact_key: Hash;
  readonly independence_key: Hash;
  readonly requirement_id: string;
  readonly proposition_id?: string;
  readonly effect: "supports" | "violates";
  /** Only `true` may decide. An observed row is never a hard fact. */
  readonly verified: boolean;
}

/**
 * Evidence-index facts that the caller already knows beside the hard facts.
 *
 * `gap_codes` comes from the frozen coverage snapshot's `missing` entries for
 * the question's requirements. It only adds detail to a `gap` decision: the
 * absence of a usable hard fact is already enough to stop a dispatch.
 */
export interface DispatchEvidenceView {
  readonly gap_codes?: readonly DispatchGapCode[];
  /** Observed, unverified facts that mention this question. */
  readonly observed_fact_count?: number;
  /** Semantic outcomes already present from a previous round. */
  readonly semantic_outcome_count?: number;
  /** A previous round recorded contradictory evidence. */
  readonly ambiguous?: boolean;
}

/** Structural subset of the `AggregatePlanView` the pipeline holds. */
export interface DispatchPlanView {
  readonly plan_id: string;
  readonly plan_hash: Hash;
  readonly binding: VersionBinding;
  readonly questions: readonly DispatchQuestionView[];
}

/* ------------------------------------------------------------------ */
/* Decisions                                                           */
/* ------------------------------------------------------------------ */

type DispatchSemanticReason =
  | "unbound_proposition"
  | "unbound_requirement"
  | "hard_conflict"
  | "same_source_conflict"
  | "partial_hard_fact"
  | "unverified_evidence"
  | "semantic_evidence_present"
  | "ambiguous_evidence";

export type DispatchDecision =
  | {
      readonly kind: "decided";
      readonly basis: "hard_fact";
      readonly fact_keys: readonly Hash[];
      readonly reason_codes: readonly DispatchRouteReason[];
    }
  | {
      readonly kind: "gap";
      readonly basis: "evidence_missing";
      readonly gap_codes: readonly DispatchGapCode[];
      readonly reason_codes: readonly DispatchRouteReason[];
    }
  | {
      readonly kind: "semantic_required";
      readonly reason: DispatchSemanticReason;
      readonly reason_codes: readonly DispatchRouteReason[];
    };

interface QuestionDispatchDecision {
  readonly question_key: string;
  readonly required_for_issue: boolean;
  readonly decision: DispatchDecision;
}

type PlanDispatchKind = "dispatch" | "skip" | "binding_mismatch";

export interface PlanDispatchDecision {
  readonly kind: PlanDispatchKind;
  readonly plan_id: string;
  readonly plan_hash: Hash;
  readonly binding: VersionBinding;
  readonly policy_version: string;
  readonly questions: readonly QuestionDispatchDecision[];
  /** Required questions that must reach the semantic backend. */
  readonly semantic_question_keys: readonly string[];
  readonly decided_question_keys: readonly string[];
  readonly gap_question_keys: readonly string[];
  /** Union of the deciding hard facts, deduplicated and sorted. */
  readonly fact_keys: readonly Hash[];
  readonly reason_codes: readonly DispatchRouteReason[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const DECIDED_REASONS: readonly DispatchRouteReason[] = Object.freeze([
  "deterministic_decisive",
  "semantic_not_needed"
]);

const GAP_REASONS: readonly DispatchRouteReason[] = Object.freeze(["retrieval_gap"]);

const SEMANTIC_REASONS: readonly DispatchRouteReason[] = Object.freeze([
  "deterministic_inconclusive"
]);

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function uniqueSorted(values: readonly string[]): string[] {
  return sortStrings([...new Set(values)]);
}

function reasonCodesFor(reason: DispatchSemanticReason): readonly DispatchRouteReason[] {
  switch (reason) {
    case "hard_conflict":
    case "same_source_conflict":
      return Object.freeze(["deterministic_inconclusive", "conflict"]);
    case "unverified_evidence":
      return Object.freeze(["deterministic_inconclusive", "verification_absent"]);
    case "unbound_proposition":
    case "unbound_requirement":
    case "partial_hard_fact":
    case "semantic_evidence_present":
    case "ambiguous_evidence":
      return SEMANTIC_REASONS;
  }
}

function semantic(reason: DispatchSemanticReason): DispatchDecision {
  return {
    kind: "semantic_required",
    reason,
    reason_codes: reasonCodesFor(reason)
  };
}

function bindingMismatch(left: VersionBinding, right: VersionBinding): boolean {
  return (
    left.task_id !== right.task_id ||
    left.branch_id !== right.branch_id ||
    left.input_epoch !== right.input_epoch ||
    left.goal_version !== right.goal_version ||
    left.config_version !== right.config_version ||
    left.watermark !== right.watermark
  );
}

function isBoundQuestion(question: DispatchQuestionView): boolean {
  return question.proposition_id.trim().length > 0;
}

function requirementSet(question: DispatchQuestionView): Set<string> {
  return new Set(question.requirement_ids.filter((value) => value.trim().length > 0));
}

/**
 * Facts that may decide this question.
 *
 * A fact qualifies only when it is verified, names the same proposition and
 * names one of the question's requirements. The requirement list is not
 * extended from unrelated facts: a question whose requirement is absent from
 * the fact cannot borrow a decision from another requirement.
 */
function qualifyingFacts(
  question: DispatchQuestionView,
  facts: readonly DispatchHardFactView[],
  requirements: ReadonlySet<string>
): readonly DispatchHardFactView[] {
  return facts.filter(
    (fact) =>
      fact.verified === true &&
      fact.fact_key.length > 0 &&
      fact.independence_key.length > 0 &&
      fact.requirement_id.length > 0 &&
      fact.proposition_id === question.proposition_id &&
      requirements.has(fact.requirement_id)
  );
}

interface RequirementFacts {
  readonly supports: readonly DispatchHardFactView[];
  readonly violates: readonly DispatchHardFactView[];
}

function groupByRequirement(
  requirements: ReadonlySet<string>,
  facts: readonly DispatchHardFactView[]
): ReadonlyMap<string, RequirementFacts> {
  const grouped = new Map<string, RequirementFacts>();
  for (const requirementId of requirements) {
    const scoped = facts.filter((fact) => fact.requirement_id === requirementId);
    grouped.set(requirementId, {
      supports: scoped.filter((fact) => fact.effect === "supports"),
      violates: scoped.filter((fact) => fact.effect === "violates")
    });
  }
  return grouped;
}

/**
 * A requirement is decided only when one side exists and the other does not.
 *
 * Two-sided evidence is a conflict regardless of source independence. When
 * every pair shares one independence key it is a same-source conflict (the
 * two readings are not independent); otherwise it is a hard conflict. Neither
 * may be `decided`.
 */
function conflictKind(group: RequirementFacts): "hard_conflict" | "same_source_conflict" | null {
  if (group.supports.length === 0 || group.violates.length === 0) {
    return null;
  }
  const independence = new Set<string>();
  for (const fact of group.supports) {
    independence.add(fact.independence_key);
  }
  for (const fact of group.violates) {
    independence.add(fact.independence_key);
  }
  return independence.size > 1 ? "hard_conflict" : "same_source_conflict";
}

function decidingKeys(group: RequirementFacts): Hash[] {
  const keys = group.supports.length > 0 ? group.supports : group.violates;
  return sortStrings(keys.map((fact) => fact.fact_key)) as Hash[];
}

/* ------------------------------------------------------------------ */
/* Public decision                                                     */
/* ------------------------------------------------------------------ */

/**
 * Decides one question from verified hard facts only.
 *
 * Order of precedence (first match wins):
 *   1. unbound proposition or requirement           -> semantic_required
 *   2. any two-sided proposition across the question's requirements
 *                                                  -> semantic_required (conflict)
 *   3. every requirement has a clean hard decision  -> decided
 *   4. no qualifying verified fact:
 *        ambiguous evidence                         -> semantic_required
 *        observed but unverified facts              -> semantic_required
 *        existing semantic outcomes                 -> semantic_required
 *        otherwise (no evidence at all)             -> gap
 *   5. partial hard coverage                        -> semantic_required
 */
export function decideDispatch(
  question: DispatchQuestionView,
  facts: readonly DispatchHardFactView[],
  evidence?: DispatchEvidenceView
): DispatchDecision {
  if (!isBoundQuestion(question)) {
    return semantic("unbound_proposition");
  }
  const requirements = requirementSet(question);
  if (requirements.size === 0) {
    return semantic("unbound_requirement");
  }

  const qualifying = qualifyingFacts(question, facts, requirements);

  // A question names one proposition. Two-sided evidence for that proposition
  // is a conflict across the whole question, not per requirement: R1 saying
  // supports and R2 saying violates cannot both be clean merely because each
  // requirement is one-sided. Resolve before per-requirement grouping.
  const questionConflict = conflictKind({
    supports: qualifying.filter((fact) => fact.effect === "supports"),
    violates: qualifying.filter((fact) => fact.effect === "violates")
  });
  if (questionConflict !== null) {
    return semantic(questionConflict);
  }

  const grouped = groupByRequirement(requirements, qualifying);

  const undecided: string[] = [];
  const keys: Hash[] = [];
  for (const [requirementId, group] of grouped) {
    if (group.supports.length > 0 || group.violates.length > 0) {
      keys.push(...decidingKeys(group));
      continue;
    }
    undecided.push(requirementId);
  }

  if (undecided.length === 0) {
    return {
      kind: "decided",
      basis: "hard_fact",
      fact_keys: uniqueSorted(keys) as Hash[],
      reason_codes: DECIDED_REASONS
    };
  }

  // Observed-but-unverified rows never qualify as deciding facts. Counting
  // them keeps the question in the semantic lane instead of calling it a
  // coverage gap, and never promotes an observation to `verified`.
  const observed =
    Math.max(0, evidence?.observed_fact_count ?? 0) +
    facts.filter((fact) => fact.verified !== true).length;
  const semanticOutcomes = Math.max(0, evidence?.semantic_outcome_count ?? 0);
  const gapCodes = uniqueSorted(evidence?.gap_codes ?? []) as DispatchGapCode[];
  const gapOnly = gapCodes.filter((code) => code !== "conflicting_sources");
  const conflictingSources = gapCodes.some((code) => code === "conflicting_sources");

  if (qualifying.length === 0) {
    if (evidence?.ambiguous === true || conflictingSources) {
      return semantic("ambiguous_evidence");
    }
    if (observed > 0) {
      return semantic("unverified_evidence");
    }
    if (semanticOutcomes > 0) {
      return semantic("semantic_evidence_present");
    }
    // No verified fact can settle the question. That is an evidence gap, not
    // a reason to ask the semantic backend: the backend judges a pack, it
    // does not retrieve. W4 decides whether and how to supplement.
    return {
      kind: "gap",
      basis: "evidence_missing",
      gap_codes: gapOnly.length > 0 ? gapOnly : Object.freeze(["capture_gap"]),
      reason_codes: GAP_REASONS
    };
  }

  // Some requirements have clean hard facts and others have none. That is
  // neither a complete decision nor a pure gap; the remaining proposition
  // needs semantic judgment (or supplementation decided by W4).
  if (evidence?.ambiguous === true || conflictingSources) {
    return semantic("ambiguous_evidence");
  }
  if (observed > 0) {
    return semantic("unverified_evidence");
  }
  if (semanticOutcomes > 0) {
    return semantic("semantic_evidence_present");
  }
  return semantic("partial_hard_fact");
}

/**
 * Plan-level decision: complete `VersionBinding` coverage and per-question
 * aggregation.
 *
 * The current binding must match the plan binding in all six fields. A
 * mismatched binding is `binding_mismatch` and carries no question decision,
 * so a stale fact set can never short-circuit dispatch.
 *
 * `skip` means no issue-required question needs the semantic backend
 * (`decided` and `gap` questions only). Optional questions never force a
 * dispatch; they ride along only when another required question in their
 * shard is dispatched.
 */
export function decidePlanDispatch(
  plan: DispatchPlanView,
  current: VersionBinding,
  facts: readonly DispatchHardFactView[],
  evidenceByQuestion?: Readonly<Record<string, DispatchEvidenceView>>
): PlanDispatchDecision {
  const policyVersion = "dp.dispatch/1";
  if (bindingMismatch(plan.binding, current)) {
    return {
      kind: "binding_mismatch",
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      binding: current,
      policy_version: policyVersion,
      questions: [],
      semantic_question_keys: [],
      decided_question_keys: [],
      gap_question_keys: [],
      fact_keys: [],
      reason_codes: Object.freeze(["version_stale"])
    };
  }

  const questions: QuestionDispatchDecision[] = plan.questions.map((question) => ({
    question_key: question.question_key,
    required_for_issue: question.required_for_issue,
    decision: decideDispatch(question, facts, evidenceByQuestion?.[question.question_key])
  }));

  const semanticQuestionKeys: string[] = [];
  const decidedQuestionKeys: string[] = [];
  const gapQuestionKeys: string[] = [];
  const factKeys: Hash[] = [];
  for (const entry of questions) {
    switch (entry.decision.kind) {
      case "decided":
        decidedQuestionKeys.push(entry.question_key);
        factKeys.push(...entry.decision.fact_keys);
        break;
      case "gap":
        gapQuestionKeys.push(entry.question_key);
        break;
      case "semantic_required":
        if (entry.required_for_issue) {
          semanticQuestionKeys.push(entry.question_key);
        }
        break;
    }
  }

  const requiredQuestions = questions.filter((entry) => entry.required_for_issue);
  // Any required question that still needs the semantic backend keeps the
  // plan dispatching; `decided` and `gap` questions never do.
  const kind: PlanDispatchKind = semanticQuestionKeys.length > 0 ? "dispatch" : "skip";
  const reasonCodes: DispatchRouteReason[] =
    kind === "dispatch"
      ? [...SEMANTIC_REASONS]
      : requiredQuestions.length === 0
        ? ["semantic_not_needed"]
        : requiredQuestions.every((entry) => entry.decision.kind === "decided")
          ? [...DECIDED_REASONS]
          : [...GAP_REASONS];

  return {
    kind,
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    binding: current,
    policy_version: policyVersion,
    questions,
    semantic_question_keys: uniqueSorted(semanticQuestionKeys),
    decided_question_keys: uniqueSorted(decidedQuestionKeys),
    gap_question_keys: uniqueSorted(gapQuestionKeys),
    fact_keys: uniqueSorted(factKeys) as Hash[],
    reason_codes: Object.freeze(reasonCodes)
  };
}
