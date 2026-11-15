/**
 * Issue lifecycle (DD-QP-05, DD-QP-05a, DD-QP-09).
 *
 * Events are commands; state only changes through a transition record. The
 * transition table here is the single authority used by the planner and the
 * repository, so an illegal edge cannot be accepted on one path and rejected
 * on another.
 */

import type { VersionBinding } from "../version-binding.js";
import type { SourceRef } from "../source-ref.js";
import type {
  CloseEvidence,
  ConfirmationEvidence,
  EvidenceGap,
  Issue,
  IssueConfirmation,
  IssueState,
  IssueTransitionEvent,
  IssueType,
  ReviewHandoffClosure
} from "./types.js";
import { sortedUnique, sortedUniqueRefs } from "./hashes.js";

export const ISSUE_TYPES: readonly IssueType[] = Object.freeze([
  "constraint_violation",
  "missing_requirement",
  "wrong_target",
  "missing_verification",
  "goal_change",
  "insufficient_evidence",
  "stall_or_regression_candidate",
  "experience_applicability"
]);

export const ISSUE_STATES: readonly IssueState[] = Object.freeze([
  "proposed",
  "open",
  "needs_evidence",
  "judged",
  "abstained",
  "closed",
  "stale_goal",
  "rejected"
]);

export const ISSUE_TRANSITION_EVENTS: readonly IssueTransitionEvent[] = Object.freeze([
  "propose",
  "confirm",
  "reject",
  "require_evidence",
  "supply_evidence",
  "judge",
  "abstain",
  "reopen_evidence",
  "close",
  "reopen",
  "review_handoff_close",
  "review_handoff_reject",
  "invalidate_goal",
  "reject_issue",
  "attach_evidence"
]);

export function isIssueType(value: string): value is IssueType {
  return (ISSUE_TYPES as readonly string[]).includes(value);
}

export function isIssueState(value: string): value is IssueState {
  return (ISSUE_STATES as readonly string[]).includes(value);
}

export function isIssueTransitionEvent(value: string): value is IssueTransitionEvent {
  return (ISSUE_TRANSITION_EVENTS as readonly string[]).includes(value);
}

/** Deterministic output order for discovery: detector order, then issue_key. */
export function issueTypeRank(type: IssueType): number {
  return ISSUE_TYPES.indexOf(type);
}

/** Terminal states never transition again except no-op invalidate/reject. */
export function isTerminalState(state: IssueState): boolean {
  return state === "stale_goal" || state === "rejected";
}

/**
 * Returns the target state for an edge, or `null` when the edge is illegal.
 * `invalidate_goal` on `closed` is a no-op, represented by `null`; callers
 * must treat that case as `no_op`, not as an error.
 */
export function transitionTarget(
  event: IssueTransitionEvent,
  from: IssueState | "none",
  issueType: IssueType
): IssueState | null {
  switch (event) {
    case "propose":
      return from === "none" ? "proposed" : null;
    case "confirm":
      return from === "proposed" ? "open" : null;
    case "reject":
      return from === "proposed" ? "rejected" : null;
    case "require_evidence":
      return from === "open" || from === "judged" ? "needs_evidence" : null;
    case "supply_evidence":
      return from === "needs_evidence" ? "open" : null;
    case "judge":
      return from === "open" || from === "needs_evidence" || from === "judged" ? "judged" : null;
    case "abstain":
      return from === "open" || from === "needs_evidence" || from === "judged" ? "abstained" : null;
    case "reopen_evidence":
      return from === "abstained" ? "open" : null;
    case "close":
      return from === "judged" ? "closed" : null;
    case "reopen":
      return from === "closed" ? "open" : null;
    case "review_handoff_close":
      if (issueType !== "experience_applicability") {
        return null;
      }
      return from === "open" || from === "needs_evidence" || from === "judged" ? "closed" : null;
    case "review_handoff_reject":
      if (issueType !== "experience_applicability") {
        return null;
      }
      return from === "open" || from === "needs_evidence" || from === "judged" ? "rejected" : null;
    case "invalidate_goal":
      if (
        from === "proposed" ||
        from === "open" ||
        from === "needs_evidence" ||
        from === "judged" ||
        from === "abstained"
      ) {
        return "stale_goal";
      }
      return null;
    case "reject_issue":
      if (from === "open" || from === "needs_evidence" || from === "judged" || from === "abstained") {
        return "rejected";
      }
      return null;
    case "attach_evidence":
      return from === "closed" ? "closed" : null;
  }
}

/** Confirmation kind allowed for each issue type (DD-QP-09). */
const CONFIRMATION_MATRIX: Readonly<Record<IssueType, readonly ConfirmationEvidence["kind"][]>> = Object.freeze({
  constraint_violation: ["verified_fact"],
  missing_requirement: ["coverage_gap"],
  wrong_target: ["verified_fact"],
  missing_verification: ["coverage_gap"],
  goal_change: ["human_input"],
  insufficient_evidence: ["coverage_gap"],
  stall_or_regression_candidate: ["stable_signal"],
  experience_applicability: ["review_snapshot"]
});

export function confirmationKindAllowed(issueType: IssueType, kind: ConfirmationEvidence["kind"]): boolean {
  return CONFIRMATION_MATRIX[issueType].includes(kind);
}

/** Close evidence kinds allowed per issue type (DD-QP-06). */
const CLOSE_MATRIX: Readonly<Record<IssueType, readonly CloseEvidence["kind"][]>> = Object.freeze({
  constraint_violation: ["verified_behavior", "verified_artifact", "human_acceptance"],
  missing_requirement: ["verified_behavior", "verified_artifact", "human_acceptance"],
  wrong_target: ["verified_artifact", "verified_behavior"],
  missing_verification: ["verified_behavior", "human_acceptance"],
  goal_change: ["coverage_completion"],
  insufficient_evidence: ["coverage_completion", "verified_behavior", "human_acceptance"],
  stall_or_regression_candidate: ["verified_behavior", "coverage_completion"],
  experience_applicability: ["review_handoff"]
});

export function closeKindAllowed(issueType: IssueType, kind: CloseEvidence["kind"]): boolean {
  return CLOSE_MATRIX[issueType].includes(kind);
}

/** Maps a confirmation payload onto the persisted confirmation projection. */
export function confirmationProjection(
  confirmation: ConfirmationEvidence,
  watermark: number
): IssueConfirmation {
  switch (confirmation.kind) {
    case "human_input":
      return {
        kind: "human_input",
        evidence_ids: [confirmation.event_id],
        source_refs: sortedUniqueRefs(confirmation.source_refs),
        confirmed_at_watermark: watermark
      };
    case "verified_fact":
      return {
        kind: "verified_fact",
        evidence_ids: sortedUnique(confirmation.fact_ids),
        source_refs: sortedUniqueRefs(confirmation.source_refs),
        confirmed_at_watermark: watermark
      };
    case "coverage_gap":
      return {
        kind: "coverage_gap",
        evidence_ids: [confirmation.coverage_snapshot_id],
        source_refs: sortedUniqueRefs(confirmation.source_refs),
        confirmed_at_watermark: watermark
      };
    case "stable_signal":
      return {
        kind: "stable_signal",
        evidence_ids: [confirmation.signal_id],
        source_refs: sortedUniqueRefs(confirmation.source_refs),
        confirmed_at_watermark: watermark
      };
    case "review_snapshot":
      return {
        kind: "review_snapshot",
        evidence_ids: sortedUnique([confirmation.snapshot_id, ...confirmation.experience_ids]),
        source_refs: sortedUniqueRefs(confirmation.source_refs),
        confirmed_at_watermark: watermark
      };
  }
}

/** Patches a transition may write into the next issue version. */
export interface IssueTransitionPatch {
  confirmation?: IssueConfirmation;
  judgment_ref?: string;
  close_evidence?: CloseEvidence;
  review_handoff_closure?: ReviewHandoffClosure;
  rejection?: Issue["rejection"];
  evidence_gap?: EvidenceGap[];
  source_event_ids?: string[];
  source_refs?: SourceRef[];
  last_observed_watermark?: number;
  reopen_count?: number;
  experience_ref?: Issue["experience_ref"];
}

/** Applies one accepted transition to an issue, producing version + 1. */
export function applyTransition(
  issue: Issue,
  input: {
    event: IssueTransitionEvent;
    to_state: IssueState;
    transition_id: string;
    at: number;
    watermark: number;
    patch?: IssueTransitionPatch;
  }
): Issue {
  const patch = input.patch ?? {};
  const next: Issue = {
    ...issue,
    state: input.to_state,
    issue_version: issue.issue_version + 1,
    last_transition_id: input.transition_id,
    updated_at: input.at,
    last_observed_watermark: Math.max(
      issue.last_observed_watermark,
      patch.last_observed_watermark ?? input.watermark
    )
  };
  if (input.event === "confirm") {
    next.opened_at_watermark = input.watermark;
  }
  if (patch.confirmation !== undefined) {
    next.confirmation = patch.confirmation;
  }
  if (patch.judgment_ref !== undefined) {
    next.judgment_ref = patch.judgment_ref;
  }
  if (patch.close_evidence !== undefined) {
    next.close_evidence = patch.close_evidence;
  }
  if (patch.review_handoff_closure !== undefined) {
    next.review_handoff_closure = patch.review_handoff_closure;
  }
  if (patch.rejection !== undefined) {
    next.rejection = patch.rejection;
  }
  if (patch.evidence_gap !== undefined) {
    next.evidence_gap = patch.evidence_gap;
  }
  if (patch.source_event_ids !== undefined) {
    next.source_event_ids = patch.source_event_ids;
  }
  if (patch.source_refs !== undefined) {
    next.source_refs = patch.source_refs;
  }
  if (patch.experience_ref !== undefined) {
    next.experience_ref = patch.experience_ref;
  }
  if (patch.reopen_count !== undefined) {
    next.reopen_count = patch.reopen_count;
  }
  if (input.event === "reopen" || input.event === "reopen_evidence") {
    // Reopening clears the current close reference; history keeps the record.
    delete next.close_evidence;
    delete next.review_handoff_closure;
    delete next.judgment_ref;
  }
  if (input.event === "reject" || input.event === "review_handoff_reject" || input.event === "reject_issue") {
    delete next.judgment_ref;
  }
  return next;
}

/** New proposed issue factory used by discovery and review planning. */
export function createProposedIssue(input: {
  issue_id: string;
  issue_key: string;
  binding: VersionBinding;
  type: IssueType;
  subject_key: string;
  question_text: string | null;
  requirement_ids: readonly string[];
  artifact_paths: readonly string[];
  artifact_versions: readonly { path: string; version: string }[];
  contract_required: boolean;
  contract_paths: readonly string[];
  trigger: Issue["trigger"];
  source_event_ids: readonly string[];
  source_refs: readonly SourceRef[];
  evidence_gap: readonly EvidenceGap[];
  created_at: number;
  previous_issue_id?: string;
  experience_ref?: Issue["experience_ref"];
}): Issue {
  const issue: Issue = {
    schema_version: "rsi.issue/1",
    issue_id: input.issue_id,
    issue_version: 1,
    issue_key: input.issue_key,
    binding: input.binding,
    type: input.type,
    state: "proposed",
    subject_key: input.subject_key,
    question_text: input.question_text,
    requirement_ids: sortedUnique(input.requirement_ids),
    artifact_paths: sortedUnique(input.artifact_paths),
    artifact_versions: [...input.artifact_versions].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    ),
    contract_required: input.contract_required,
    contract_paths: sortedUnique(input.contract_paths),
    trigger: {
      kind: input.trigger.kind,
      event_ids: sortedUnique(input.trigger.event_ids),
      detector_id: input.trigger.detector_id,
      detector_version: input.trigger.detector_version
    },
    source_event_ids: sortedUnique(input.source_event_ids),
    source_refs: sortedUniqueRefs(input.source_refs),
    evidence_gap: input.evidence_gap.map((gap) => ({
      code: gap.code,
      requirement_ids: sortedUnique(gap.requirement_ids),
      source_refs: sortedUniqueRefs(gap.source_refs),
      affects_question_keys: sortedUnique(gap.affects_question_keys)
    })),
    reopen_count: 0,
    opened_at_watermark: 0,
    last_observed_watermark: input.binding.watermark,
    created_at: input.created_at,
    updated_at: input.created_at,
    last_transition_id: ""
  };
  if (input.previous_issue_id !== undefined) {
    issue.previous_issue_id = input.previous_issue_id;
  }
  if (input.experience_ref !== undefined) {
    issue.experience_ref = input.experience_ref;
  }
  return issue;
}
