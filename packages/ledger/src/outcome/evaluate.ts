import { canonicalJsonText } from "@evoplug/core";
import type { ErrorEnvelope, Id, Result, SourceRef, VersionBinding } from "@evoplug/core";
import type {
  ActiveRequirement,
  PendingWorkItem,
  SuccessEvidence,
  TaskOutcomeEvaluationInput,
  TaskOutcomeRecord,
} from "../domain/outcome.js";
import type { AcceptanceCriterion } from "../domain/requirements.js";
import type { TaskOutcomeStateRow } from "../rows.js";
import { ledgerOk, schemaError } from "../errors.js";
import { versionBindingJson } from "../json.js";
import { sortPendingWork, taskOutcomeHash } from "../hashes.js";
import { isSortedUniqueStrings, uniqueSortedStrings } from "../util.js";
import { validateVersionBinding } from "../validation.js";

export interface TaskOutcomeEvaluation {
  readonly record: TaskOutcomeRecord;
  readonly row: TaskOutcomeStateRow;
  readonly succeeded: boolean;
}

function evidenceUsable(evidence: SuccessEvidence, binding: VersionBinding): boolean {
  if (evidence.task_id !== binding.task_id || evidence.branch_id !== binding.branch_id) {
    return false;
  }
  if (evidence.recorded_at_watermark > binding.watermark) return false;
  if (evidence.kind === "human_acceptance" && evidence.human_attestation === null) {
    return false;
  }
  return true;
}

function criterionCovered(
  criterion: AcceptanceCriterion,
  evidence: readonly SuccessEvidence[],
): boolean {
  return evidence.some((candidate) => candidate.kind === criterion.kind);
}

function requirementCovered(
  requirement: ActiveRequirement,
  evidence: readonly SuccessEvidence[],
): boolean {
  const covering = evidence.filter((candidate) =>
    candidate.covered_requirement_ids.includes(requirement.requirement_id),
  );
  if (covering.length === 0) return false;
  if (requirement.acceptance.length === 0) return true;
  return requirement.acceptance.every((criterion) => criterionCovered(criterion, covering));
}

function sortedSourceRefs(evidence: readonly SuccessEvidence[]): SourceRef[] {
  return uniqueSortedStrings(evidence.map((item) => item.source_ref));
}

/**
 * Task outcome evaluation (DD-FND-054 / DD-FND-074).
 *
 * Stop and agent_end only trigger an evaluation; they never mean success.
 * Delivery submission, inclusion and adoption are not task success either:
 * success requires independent `SuccessEvidence` that covers every active
 * requirement's acceptance criteria.
 */
export function evaluateTaskOutcome(
  input: TaskOutcomeEvaluationInput,
): Result<TaskOutcomeEvaluation, ErrorEnvelope> {
  const bindingResult = validateVersionBinding(input.binding);
  if (!bindingResult.ok) return bindingResult;

  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    return schemaError<TaskOutcomeEvaluation>("revision", "positive_safe_integer");
  }
  if (!Number.isSafeInteger(input.decided_at) || input.decided_at < 0) {
    return schemaError<TaskOutcomeEvaluation>("decided_at", "non_negative_safe_integer");
  }
  if (!isSortedUniqueStrings(input.unresolved_issue_ids)) {
    return schemaError<TaskOutcomeEvaluation>("unresolved_issue_ids", "sorted_unique_utf8");
  }

  const lifecycle = input.explicit_lifecycle_event;
  if (lifecycle !== null) {
    if (lifecycle.kind !== "cancel" && lifecycle.kind !== "pause") {
      return schemaError<TaskOutcomeEvaluation>("explicit_lifecycle_event.kind", "cancel_or_pause");
    }
    if (lifecycle.origin !== "human" && lifecycle.origin !== "user") {
      return schemaError<TaskOutcomeEvaluation>(
        "explicit_lifecycle_event.origin",
        "human_or_user_explicit_event",
      );
    }
    if (lifecycle.directive_strength !== "explicit") {
      return schemaError<TaskOutcomeEvaluation>(
        "explicit_lifecycle_event.directive_strength",
        "explicit",
      );
    }
  }

  const pending: PendingWorkItem[] = sortPendingWork(input.pending_work);
  const unresolvedIssues = uniqueSortedStrings(input.unresolved_issue_ids);
  const issuePending: PendingWorkItem[] = unresolvedIssues.map((issueId) => ({
    kind: "issue",
    ref: issueId,
    reason_code: "queued",
  }));
  const effectivePending = sortPendingWork([...pending, ...issuePending]);

  const eligibleEvidence = input.success_evidence.filter((evidence) =>
    evidenceUsable(evidence, input.binding),
  );

  const uncovered: Id<"req">[] = [];
  for (const requirement of input.active_requirements) {
    if (!requirementCovered(requirement, eligibleEvidence)) {
      uncovered.push(requirement.requirement_id);
    }
  }
  const uncoveredSorted = uniqueSortedStrings(uncovered);
  const staleFacts = input.supporting_facts.some((fact) => fact.stale);

  let outcome: TaskOutcomeRecord["outcome"];
  let reason: TaskOutcomeRecord["reason_code"];
  let successRefs: SourceRef[] = [];
  let pendingOut: PendingWorkItem[] = effectivePending;

  if (lifecycle !== null && lifecycle.kind === "cancel") {
    outcome = "cancelled";
    reason = "human_cancel";
    pendingOut = [];
  } else if (lifecycle !== null && lifecycle.kind === "pause") {
    outcome = "paused";
    reason = "human_pause";
    pendingOut = [];
  } else if (effectivePending.length > 0) {
    outcome = "active";
    reason = "pending_work";
  } else if (input.external_blockers.length > 0) {
    outcome = "active";
    reason = "external_blocker";
    pendingOut = uniqueSortedStrings(input.external_blockers).map((ref) => ({
      kind: "human_decision",
      ref,
      reason_code: "awaiting_human",
    }));
  } else if (eligibleEvidence.length === 0) {
    outcome = "ended_unverified";
    reason = "no_success_evidence";
    pendingOut = [];
  } else if (uncoveredSorted.length > 0) {
    outcome = "ended_unverified";
    reason = "scope_uncovered";
    pendingOut = [];
  } else if (staleFacts) {
    outcome = "ended_unverified";
    reason = "version_stale";
    pendingOut = [];
  } else {
    outcome = "succeeded";
    reason = "none";
    successRefs = sortedSourceRefs(eligibleEvidence);
    pendingOut = [];
  }

  const outcomeHash = taskOutcomeHash({
    task_id: input.binding.task_id,
    branch_id: input.binding.branch_id,
    binding: input.binding,
    revision: input.revision,
    outcome,
    success_evidence_refs: successRefs,
    uncovered_requirement_ids: uncoveredSorted,
    pending_work: pendingOut,
    reason_code: reason,
    boundary_event_id: input.boundary_event_id,
  });

  const record: TaskOutcomeRecord = {
    schema_version: "rsi.task_outcome/2",
    outcome_id: input.outcome_id,
    task_id: input.binding.task_id,
    branch_id: input.binding.branch_id,
    binding: input.binding,
    revision: input.revision,
    outcome,
    success_evidence_refs: successRefs,
    uncovered_requirement_ids: uncoveredSorted,
    pending_work: pendingOut,
    reason_code: reason,
    boundary_event_id: input.boundary_event_id,
    decided_at: input.decided_at,
    outcome_hash: outcomeHash,
  };

  const row: TaskOutcomeStateRow = {
    outcome_id: record.outcome_id,
    task_id: record.task_id,
    branch_id: record.branch_id,
    revision: record.revision,
    outcome: record.outcome,
    success_evidence_refs_json: canonicalJsonText(record.success_evidence_refs),
    uncovered_requirement_ids_json: canonicalJsonText(record.uncovered_requirement_ids),
    pending_work_json: canonicalJsonText(
      record.pending_work.map((item) => ({
        kind: item.kind,
        ref: item.ref,
        reason_code: item.reason_code,
      })),
    ),
    reason_code: record.reason_code,
    boundary_event_id: record.boundary_event_id,
    version_binding_json: canonicalJsonText(versionBindingJson(record.binding)),
    decided_at: record.decided_at,
    outcome_hash: record.outcome_hash,
  };

  return ledgerOk({ record, row, succeeded: outcome === "succeeded" });
}
