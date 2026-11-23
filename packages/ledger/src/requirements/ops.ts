import { canonicalJsonText, compareUtf8, makeGoalVersion } from "@evoplug/core";
import type { ErrorEnvelope, Id, Result, SourceRef, VersionBinding } from "@evoplug/core";
import type {
  AcceptanceCriterion,
  RequirementOpDraft,
  RequirementOpRecord,
  RequirementScope,
} from "../domain/requirements.js";
import type {
  DirectiveStrength,
  Origin,
  RequirementOpKind,
  RequirementOpStatus,
} from "../domain/common.js";
import { schemaError, ledgerOk } from "../errors.js";
import { isHash } from "../raw-hash.js";
import { acceptanceCriterionJson } from "../json.js";
import { isSafeRelativePath, isSortedUniqueStrings, uniqueSortedStrings } from "../util.js";
import { requirementOpContentHash } from "../hashes.js";

export const REQUIREMENT_OP_KINDS: readonly RequirementOpKind[] = [
  "add",
  "clarify",
  "supersede",
  "retract",
  "confirm",
];

export const REQUIREMENT_OP_STATUSES: readonly RequirementOpStatus[] = [
  "applied",
  "proposed",
  "conflict",
  "rejected",
];

export const REQUIREMENT_SCOPE_MODES: readonly RequirementScope["modes"][number][] = [
  "online",
  "review",
  "trial",
  "global",
];

/** Stable sort key for acceptance criteria: kind, then stable fields. */
export function acceptanceSortKey(criterion: AcceptanceCriterion): string {
  return criterion.kind + "\u0000" + canonicalJsonText(acceptanceCriterionJson(criterion));
}

export function sortAcceptance(
  acceptance: readonly AcceptanceCriterion[],
): AcceptanceCriterion[] {
  return [...acceptance].sort((a, b) =>
    compareUtf8(acceptanceSortKey(a), acceptanceSortKey(b)),
  );
}

export function isSortedAcceptance(acceptance: readonly AcceptanceCriterion[]): boolean {
  for (let i = 1; i < acceptance.length; i += 1) {
    const previous = acceptance[i - 1];
    const current = acceptance[i];
    if (previous === undefined || current === undefined) return false;
    if (compareUtf8(acceptanceSortKey(previous), acceptanceSortKey(current)) >= 0) return false;
  }
  return true;
}

/** Validates the closed `RequirementScope` shape, keeping caller order. */
export function validateRequirementScope(
  scope: RequirementScope,
): Result<RequirementScope, ErrorEnvelope> {
  if (!isSortedUniqueStrings(scope.paths)) {
    return schemaError<RequirementScope>("scope.paths", "sorted_unique_utf8");
  }
  for (const path of scope.paths) {
    if (!isSafeRelativePath(path)) {
      return schemaError<RequirementScope>("scope.paths[]", "safe_relative_glob");
    }
  }
  if (!isSortedUniqueStrings(scope.hosts)) {
    return schemaError<RequirementScope>("scope.hosts", "sorted_unique_utf8");
  }
  if (!isSortedUniqueStrings(scope.project_ids)) {
    return schemaError<RequirementScope>("scope.project_ids", "sorted_unique_utf8");
  }
  const seenModes = new Set<string>();
  for (const mode of scope.modes) {
    if (!REQUIREMENT_SCOPE_MODES.includes(mode)) {
      return schemaError<RequirementScope>("scope.modes[]", "closed_enum");
    }
    if (seenModes.has(mode)) {
      return schemaError<RequirementScope>("scope.modes[]", "unique");
    }
    seenModes.add(mode);
  }
  return ledgerOk(scope);
}

export function validateAcceptanceList(
  acceptance: readonly AcceptanceCriterion[],
): Result<readonly AcceptanceCriterion[], ErrorEnvelope> {
  for (const criterion of acceptance) {
    if (criterion.kind === "artifact_check") {
      if (!isSafeRelativePath(criterion.path)) {
        return schemaError<readonly AcceptanceCriterion[]>("acceptance[].path", "safe_relative_path");
      }
      if (criterion.expected_hash !== undefined && !isHash(criterion.expected_hash)) {
        return schemaError<readonly AcceptanceCriterion[]>(
          "acceptance[].expected_hash",
          "sha256_lower_hex",
        );
      }
    }
    if (criterion.kind === "test_pass" && criterion.command.length === 0) {
      return schemaError<readonly AcceptanceCriterion[]>("acceptance[].command", "non_empty");
    }
    if (criterion.kind === "external_verification" && criterion.verifier.length === 0) {
      return schemaError<readonly AcceptanceCriterion[]>("acceptance[].verifier", "non_empty");
    }
  }
  if (!isSortedAcceptance(acceptance)) {
    return schemaError<readonly AcceptanceCriterion[]>(
      "acceptance",
      "sorted_unique_by_kind_and_stable_fields",
    );
  }
  return ledgerOk(acceptance);
}

export interface RequirementOpValidationContext {
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
  /** Origin copied byte-for-byte from the committed source event. */
  readonly source_origin: Origin;
  readonly source_directive_strength: DirectiveStrength;
  /** Requirement IDs known to belong to the same task/branch. */
  readonly same_scope_requirement_ids: ReadonlySet<string>;
}

function hasStatementPayload(op: RequirementOpKind): boolean {
  return op === "add" || op === "clarify" || op === "supersede";
}

/**
 * Closed-set payload validation for a `RequirementOpDraft` (DD-FND-053 /
 * DD-FND-074). It does not decide the final op status; that is
 * `determineRequirementOpStatus`.
 */
export function validateRequirementOpDraft(
  draft: RequirementOpDraft,
  context: RequirementOpValidationContext,
): Result<RequirementOpDraft, ErrorEnvelope> {
  if (draft.schema_version !== "rsi.requirement_op/1") {
    return schemaError<RequirementOpDraft>("schema_version", "rsi.requirement_op/1");
  }
  if (draft.task_id !== context.task_id || draft.branch_id !== context.branch_id) {
    return schemaError<RequirementOpDraft>("task_id/branch_id", "same_task_branch_as_source_event");
  }
  if (draft.actor_origin !== context.source_origin) {
    return schemaError<RequirementOpDraft>("actor_origin", "copied_from_source_event");
  }
  if (draft.directive_strength !== context.source_directive_strength) {
    return schemaError<RequirementOpDraft>(
      "directive_strength",
      "copied_from_source_event",
    );
  }
  if (!REQUIREMENT_OP_KINDS.includes(draft.op)) {
    return schemaError<RequirementOpDraft>("op", "closed_enum");
  }
  if (!isHash(draft.source_text_hash)) {
    return schemaError<RequirementOpDraft>("source_text_hash", "sha256_lower_hex");
  }
  // `statement_ref` is produced by the write service from the frozen statement
  // blob; a draft that carries one (notably retract/confirm) is forged and is
  // never accepted as a closed-set payload.
  if (Object.prototype.hasOwnProperty.call(draft, "statement_ref")) {
    return schemaError<RequirementOpDraft>("statement_ref", "not_in_draft");
  }
  if (draft.source_quote_ref.length === 0) {
    return schemaError<RequirementOpDraft>("source_quote_ref", "non_empty");
  }
  if (!isSortedUniqueStrings(draft.superseded_requirement_ids)) {
    return schemaError<RequirementOpDraft>(
      "superseded_requirement_ids",
      "sorted_unique_utf8",
    );
  }

  const statementRequired = hasStatementPayload(draft.op);
  if (statementRequired && draft.statement_text.length === 0) {
    return schemaError<RequirementOpDraft>("statement_text", "non_empty");
  }

  switch (draft.op) {
    case "add": {
      if (draft.target_requirement_id !== null) {
        return schemaError<RequirementOpDraft>("target_requirement_id", "null_for_add");
      }
      if (draft.superseded_requirement_ids.length !== 0) {
        return schemaError<RequirementOpDraft>("superseded_requirement_ids", "empty_for_add");
      }
      break;
    }
    case "clarify": {
      if (draft.target_requirement_id === null) {
        return schemaError<RequirementOpDraft>("target_requirement_id", "required_for_clarify");
      }
      if (draft.superseded_requirement_ids.length !== 0) {
        return schemaError<RequirementOpDraft>(
          "superseded_requirement_ids",
          "empty_for_clarify",
        );
      }
      break;
    }
    case "supersede": {
      if (draft.target_requirement_id === null) {
        return schemaError<RequirementOpDraft>("target_requirement_id", "required_for_supersede");
      }
      if (draft.superseded_requirement_ids.length === 0) {
        return schemaError<RequirementOpDraft>(
          "superseded_requirement_ids",
          "non_empty_for_supersede",
        );
      }
      break;
    }
    case "retract": {
      if (draft.superseded_requirement_ids.length === 0) {
        return schemaError<RequirementOpDraft>(
          "superseded_requirement_ids",
          "non_empty_for_retract",
        );
      }
      break;
    }
    case "confirm": {
      if (draft.target_requirement_id === null) {
        return schemaError<RequirementOpDraft>("target_requirement_id", "required_for_confirm");
      }
      if (draft.superseded_requirement_ids.length !== 0) {
        return schemaError<RequirementOpDraft>(
          "superseded_requirement_ids",
          "empty_for_confirm",
        );
      }
      break;
    }
  }

  for (const targetId of draft.superseded_requirement_ids) {
    if (!context.same_scope_requirement_ids.has(targetId)) {
      return schemaError<RequirementOpDraft>(
        "superseded_requirement_ids[]",
        "same_task_branch",
      );
    }
  }
  if (
    draft.target_requirement_id !== null &&
    !context.same_scope_requirement_ids.has(draft.target_requirement_id)
  ) {
    return schemaError<RequirementOpDraft>("target_requirement_id", "same_task_branch");
  }

  if (statementRequired) {
    const scopeResult = validateRequirementScope(draft.scope);
    if (!scopeResult.ok) return scopeResult;
    const acceptanceResult = validateAcceptanceList(draft.acceptance);
    if (!acceptanceResult.ok) return acceptanceResult;
  } else {
    if (
      draft.scope.paths.length !== 0 ||
      draft.scope.hosts.length !== 0 ||
      draft.scope.modes.length !== 0 ||
      draft.scope.project_ids.length !== 0
    ) {
      return schemaError<RequirementOpDraft>("scope", "empty_for_retract_confirm");
    }
    if (draft.acceptance.length !== 0) {
      return schemaError<RequirementOpDraft>("acceptance", "empty_for_retract_confirm");
    }
  }

  return ledgerOk(draft);
}

export interface RequirementOpStatusContext {
  readonly extractor_status: "proposed" | "conflict" | "rejected" | null;
  readonly actor_origin: Origin;
  readonly directive_strength: DirectiveStrength;
  /** True only when the source event carries a verified human attestation. */
  readonly human_attested: boolean;
}

/**
 * `extractor_status` decides proposed/conflict/rejected; `null` delegates to
 * the origin rule, where only human + explicit + attested can apply.
 */
export function determineRequirementOpStatus(
  context: RequirementOpStatusContext,
): RequirementOpStatus {
  if (context.extractor_status !== null) {
    return context.extractor_status;
  }
  if (
    context.actor_origin === "human" &&
    context.directive_strength === "explicit" &&
    context.human_attested
  ) {
    return "applied";
  }
  return "proposed";
}

export interface RequirementGoalTransitionInput {
  readonly op: RequirementOpKind;
  readonly status: RequirementOpStatus;
  readonly binding: VersionBinding;
  /** Branch's current goal revision (never parsed from `goal_version`). */
  readonly current_goal_revision: number;
  /** Current revision of the target requirement, if one exists. */
  readonly target_requirement_revision: number | null;
  readonly target_requirement_status: "proposed" | "active" | "superseded" | "retracted" | "rejected" | null;
  /** True when statement, scope or acceptance content actually changed. */
  readonly content_changed: boolean;
}

export interface RequirementGoalTransition {
  readonly goal_version_before: string;
  readonly goal_version_after: string;
  readonly next_goal_revision: number;
  /** Revision written for the target/new requirement, `null` when none. */
  readonly requirement_revision: number | null;
  readonly creates_requirement: boolean;
  /** True when a proposed requirement becomes active. */
  readonly activates_requirement: boolean;
}

/**
 * Goal-version progression. Only content/scope/acceptance changes and human
 * activation increment `goal_revision`; a source-only confirmation does not.
 */
export function planRequirementGoalTransition(
  input: RequirementGoalTransitionInput,
): RequirementGoalTransition {
  const before = input.binding.goal_version;
  const current = input.current_goal_revision;

  if (input.status !== "applied") {
    return {
      goal_version_before: before,
      goal_version_after: before,
      next_goal_revision: current,
      requirement_revision: null,
      creates_requirement: false,
      activates_requirement: false,
    };
  }

  const bump = (): number => current + 1;
  const targetRevision = input.target_requirement_revision;

  switch (input.op) {
    case "add":
    case "supersede": {
      const next = bump();
      return {
        goal_version_before: before,
        goal_version_after: makeGoalVersion(input.binding.branch_id, next),
        next_goal_revision: next,
        requirement_revision: 1,
        creates_requirement: true,
        activates_requirement: false,
      };
    }
    case "clarify": {
      if (!input.content_changed) {
        return {
          goal_version_before: before,
          goal_version_after: before,
          next_goal_revision: current,
          requirement_revision: null,
          creates_requirement: false,
          activates_requirement: false,
        };
      }
      const next = bump();
      return {
        goal_version_before: before,
        goal_version_after: makeGoalVersion(input.binding.branch_id, next),
        next_goal_revision: next,
        requirement_revision: targetRevision === null ? 1 : targetRevision + 1,
        creates_requirement: false,
        activates_requirement: false,
      };
    }
    case "retract": {
      const next = bump();
      return {
        goal_version_before: before,
        goal_version_after: makeGoalVersion(input.binding.branch_id, next),
        next_goal_revision: next,
        requirement_revision: targetRevision === null ? null : targetRevision + 1,
        creates_requirement: false,
        activates_requirement: false,
      };
    }
    case "confirm": {
      if (input.target_requirement_status === "active") {
        return {
          goal_version_before: before,
          goal_version_after: before,
          next_goal_revision: current,
          requirement_revision: null,
          creates_requirement: false,
          activates_requirement: false,
        };
      }
      const next = bump();
      return {
        goal_version_before: before,
        goal_version_after: makeGoalVersion(input.binding.branch_id, next),
        next_goal_revision: next,
        requirement_revision: targetRevision === null ? 1 : targetRevision + 1,
        creates_requirement: false,
        activates_requirement: input.target_requirement_status === "proposed",
      };
    }
  }
}

export interface BuildRequirementOpRecordInput {
  readonly draft: RequirementOpDraft;
  readonly op_id: Id<"reqop">;
  readonly status: RequirementOpStatus;
  readonly statement_ref: SourceRef | null;
  readonly created_requirement_id: Id<"req"> | null;
  readonly effective_input_epoch: number;
  readonly goal_version_before: string;
  readonly goal_version_after: string;
  readonly recorded_at: number;
}

/** Persistable op record with the `/1` content hash computed in one place. */
export function buildRequirementOpRecord(
  input: BuildRequirementOpRecordInput,
): RequirementOpRecord {
  const base = {
    op_id: input.op_id,
    task_id: input.draft.task_id,
    branch_id: input.draft.branch_id,
    source_event_id: input.draft.source_event_id,
    actor_origin: input.draft.actor_origin,
    directive_strength: input.draft.directive_strength,
    op: input.draft.op,
    target_requirement_id: input.draft.target_requirement_id,
    superseded_requirement_ids: uniqueSortedStrings(input.draft.superseded_requirement_ids),
    statement_text: input.draft.statement_text,
    scope: input.draft.scope,
    acceptance: input.draft.acceptance,
    source_quote_ref: input.draft.source_quote_ref,
    source_text_hash: input.draft.source_text_hash,
    statement_ref: input.statement_ref,
    status: input.status,
    created_requirement_id: input.created_requirement_id,
    effective_input_epoch: input.effective_input_epoch,
    goal_version_before: input.goal_version_before,
    goal_version_after: input.goal_version_after,
  };
  const contentHash = requirementOpContentHash(base);
  return {
    schema_version: "rsi.requirement_op_record/1",
    ...base,
    recorded_at: input.recorded_at,
    content_hash: contentHash,
  };
}
