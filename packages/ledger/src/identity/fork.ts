import { canonicalJsonText, compareUtf8, makeGoalVersion } from "@evoplug/core";
import type { ErrorEnvelope, Hash, Id, Result } from "@evoplug/core";
import type { AcceptanceCriterion, RequirementScope } from "../domain/requirements.js";
import type {
  BranchForkResult,
  ForkIdempotencyRecord,
  ForkRequest,
  ForkSourceBranch,
} from "../domain/identity.js";
import type { GoalSnapshotStateRow } from "../rows.js";
import { ledgerOk, ledgerFailure } from "../errors.js";
import { goalSnapshotHash } from "../hashes.js";
import { goalSnapshotRowJson } from "../rows.js";

/** Requirement revision that survives a fork; no issue/delivery state does. */
export interface InheritedRequirementRef {
  readonly requirement_id: Id<"req">;
  readonly revision: number;
  /** Only active/proposed revisions survive a fork. */
  readonly status: "proposed" | "active";
  readonly statement_ref: string;
  readonly statement_text_hash: Hash;
  readonly scope: RequirementScope;
  readonly acceptance: readonly AcceptanceCriterion[];
}

export interface ForkAuditDecision {
  readonly action_kind: "identity_fork";
  readonly reason_code: "explicit_request";
  readonly target_branch_id: Id<"br">;
}

export interface ForkSeedInput {
  readonly origin: "system";
  readonly directive_strength: "ambiguous";
  readonly input_epoch: 1;
  readonly human_attestation: null;
}

export interface ForkPlanInput {
  readonly request: ForkRequest;
  /** Resolved source branch, or `null` when it does not exist. */
  readonly source: ForkSourceBranch | null;
  /** Current committed receipt sequence of the branch. */
  readonly receipt_seq: number;
  /** True when `request.at_watermark` has a complete `commit_record` set. */
  readonly watermark_committed: boolean;
  /** Existing idempotency row for the exact request tuple, if any. */
  readonly existing: ForkIdempotencyRecord | null;
  /** Identifier reserved for a new branch. */
  readonly new_branch_id: Id<"br">;
  /** Identifier reserved for the inherited goal snapshot. */
  readonly new_goal_snapshot_id: Id<"gsnap">;
  /** Requirement revisions active or proposed at `at_watermark`. */
  readonly inherited_requirements: readonly InheritedRequirementRef[];
  readonly now: number;
}

export interface ForkPlan {
  readonly fork: BranchForkResult;
  readonly goal_snapshot: GoalSnapshotStateRow;
  /** Canonical JSON text for the `goal_snapshot` state row. */
  readonly goal_snapshot_row_json: string;
  readonly active_requirement_ids: Id<"req">[];
  readonly inherited_requirements: readonly InheritedRequirementRef[];
  readonly seed_input: ForkSeedInput;
  readonly audit: ForkAuditDecision;
  readonly created: boolean;
}

function watermarkUnknown<T>(): Result<T, ErrorEnvelope> {
  return ledgerFailure<T>({
    code: "E_WATERMARK_UNKNOWN",
    category: "version",
    details: { kind: "field", path: "watermark", rule: "not_committed" },
    stage: "watermark_read",
  });
}

/**
 * Fork rule validation and plan construction (DD-FND-073).
 *
 * A fork copies the requirement revisions in force at `at_watermark` into a
 * new branch with `goal_version = gv:<new_branch_id>:1` and `input_epoch = 1`.
 * Issues, judgments, deliveries, review jobs, budget reservations, write
 * intents and experience trials are deliberately not copied.
 */
export function planBranchFork(input: ForkPlanInput): Result<ForkPlan, ErrorEnvelope> {
  const { request, source } = input;

  if (source === null) {
    return ledgerFailure<ForkPlan>({
      code: "E_VERSION_BINDING",
      category: "version",
      details: {
        kind: "version",
        expected: "existing_source_branch",
        actual: request.source_branch_id,
      },
      stage: "binding",
    });
  }

  if (
    !Number.isSafeInteger(request.at_watermark) ||
    request.at_watermark < 0 ||
    request.at_watermark > source.current_watermark ||
    request.at_watermark > input.receipt_seq ||
    !input.watermark_committed
  ) {
    return watermarkUnknown<ForkPlan>();
  }

  const goalVersion = makeGoalVersion(input.new_branch_id, 1);
  const inherited = [...input.inherited_requirements].sort((a, b) => {
    const byId = compareUtf8(a.requirement_id, b.requirement_id);
    if (byId !== 0) return byId;
    return a.revision - b.revision;
  });
  const activeRequirementIds = [
    ...new Set(inherited.filter((row) => row.status === "active").map((row) => row.requirement_id)),
  ].sort(compareUtf8);

  const snapshotHash = goalSnapshotHash({
    task_id: source.task_id,
    source_branch_id: source.branch_id,
    source_goal_version: source.current_goal_version,
    local_goal_version: goalVersion,
    local_goal_revision: 1,
    watermark: request.at_watermark,
    active_requirement_ids: activeRequirementIds,
  });

  const snapshot: GoalSnapshotStateRow = {
    snapshot_id: input.new_goal_snapshot_id,
    task_id: source.task_id,
    source_branch_id: source.branch_id,
    source_goal_version: source.current_goal_version,
    local_goal_version: goalVersion,
    local_goal_revision: 1,
    watermark: request.at_watermark,
    active_requirement_ids_json: canonicalJsonText(activeRequirementIds),
    snapshot_hash: snapshotHash,
    created_at: input.now,
  };

  if (input.existing !== null) {
    const existing = input.existing;
    const replay: ForkPlan = {
      fork: {
        branch_id: existing.branch_id,
        parent_branch_id: existing.source_branch_id,
        forked_from_watermark: existing.at_watermark,
        goal_snapshot_id: existing.goal_snapshot_id,
        task_id: existing.task_id,
        goal_version: existing.goal_version,
        input_epoch: existing.input_epoch,
        created: false,
      },
      goal_snapshot: snapshot,
      goal_snapshot_row_json: canonicalJsonText(goalSnapshotRowJson(snapshot)),
      active_requirement_ids: activeRequirementIds,
      inherited_requirements: inherited,
      seed_input: {
        origin: "system",
        directive_strength: "ambiguous",
        input_epoch: 1,
        human_attestation: null,
      },
      audit: {
        action_kind: "identity_fork",
        reason_code: "explicit_request",
        target_branch_id: existing.branch_id,
      },
      created: false,
    };
    return ledgerOk(replay);
  }

  const plan: ForkPlan = {
    fork: {
      branch_id: input.new_branch_id,
      parent_branch_id: source.branch_id,
      forked_from_watermark: request.at_watermark,
      goal_snapshot_id: input.new_goal_snapshot_id,
      task_id: source.task_id,
      goal_version: goalVersion,
      input_epoch: 1,
      created: true,
    },
    goal_snapshot: snapshot,
    goal_snapshot_row_json: canonicalJsonText(goalSnapshotRowJson(snapshot)),
    active_requirement_ids: activeRequirementIds,
    inherited_requirements: inherited,
    seed_input: {
      origin: "system",
      directive_strength: "ambiguous",
      input_epoch: 1,
      human_attestation: null,
    },
    audit: {
      action_kind: "identity_fork",
      reason_code: "explicit_request",
      target_branch_id: input.new_branch_id,
    },
    created: true,
  };
  return ledgerOk(plan);
}

/**
 * Retry rule: the same `(source_branch_id, at_watermark, reason,
 * idempotency_key)` returns the original branch with `created=false`; a
 * different request is never merged.
 */
export function isSameForkRequest(
  existing: ForkIdempotencyRecord,
  request: ForkRequest,
): boolean {
  return (
    existing.source_branch_id === request.source_branch_id &&
    existing.at_watermark === request.at_watermark &&
    existing.reason === request.reason &&
    existing.idempotency_key === request.idempotency_key
  );
}
