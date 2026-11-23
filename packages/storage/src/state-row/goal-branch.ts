/**
 * The `rsi.goal_snapshot_row/1` derived reducer.
 *
 * A committed goal snapshot is the durable record of a goal bump. The branch
 * head (`current_goal_version`, `current_goal_revision`,
 * `current_goal_snapshot_id`) must move in the same transaction as the row
 * insert, both for the live projection and for journal recovery. Keeping the
 * two paths on this one function is what makes a rebuilt branch identical to
 * the live one.
 *
 * Rules (identical in both paths):
 *
 *   - the snapshot's `source_branch_id` must exist and belong to the row's
 *     `task_id` (no cross-task goal bumps);
 *   - `local_goal_revision` must be exactly one past the branch head;
 *   - an equal revision is a replay only when it names the same snapshot and
 *     goal version, otherwise it is a conflict;
 *   - a lower revision is a regression and a higher non-consecutive revision
 *     is a skip; both are rejected instead of silently moving the head.
 */

import type { ErrorEnvelope } from "@evoplug/core";

import { fieldDetails, storageError } from "../errors.js";
import type { SqlRow, StatementSource } from "../types.js";

const GOAL_SNAPSHOT_ROW_SCHEMA = "rsi.goal_snapshot_row/1";

type GoalBranchAdvanceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ErrorEnvelope };

function branchError(rule: string): GoalBranchAdvanceResult {
  return {
    ok: false,
    error: storageError({
      code: "E_STATE_ROW_BINDING",
      stage: "storage.state_row",
      details: fieldDetails(GOAL_SNAPSHOT_ROW_SCHEMA, rule),
      message_key: "error.storage.state_row_binding_invalid"
    })
  };
}

function requiredString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredRevision(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : null;
}

interface BranchGoalHead extends SqlRow {
  readonly task_id: unknown;
  readonly current_goal_version: unknown;
  readonly current_goal_revision: unknown;
  readonly current_goal_snapshot_id: unknown;
}

/**
 * Applies the branch head update for one inserted goal snapshot.
 *
 * The caller must invoke this inside the same transaction that inserted the
 * snapshot row. Non-goal rows return `{ok:true}` without touching anything.
 */
export function advanceBranchForGoalSnapshot(
  source: StatementSource,
  rowSchema: string,
  row: Record<string, unknown>
): GoalBranchAdvanceResult {
  if (rowSchema !== GOAL_SNAPSHOT_ROW_SCHEMA) {
    return { ok: true };
  }
  const snapshotId = requiredString(row, "snapshot_id");
  const taskId = requiredString(row, "task_id");
  const branchId = requiredString(row, "source_branch_id");
  const goalVersion = requiredString(row, "local_goal_version");
  const goalRevision = requiredRevision(row, "local_goal_revision");
  if (snapshotId === null) return branchError("goal_snapshot_snapshot_id_invalid");
  if (taskId === null) return branchError("goal_snapshot_task_id_invalid");
  if (branchId === null) return branchError("goal_snapshot_source_branch_id_invalid");
  if (goalVersion === null) return branchError("goal_snapshot_local_goal_version_invalid");
  if (goalRevision === null) return branchError("goal_snapshot_local_goal_revision_invalid");

  const branch = source
    .prepare<BranchGoalHead>(
      `SELECT task_id, current_goal_version, current_goal_revision, current_goal_snapshot_id
         FROM branch WHERE branch_id = :branch_id`
    )
    .get({ branch_id: branchId });
  if (branch === undefined) {
    return branchError("goal_snapshot_branch_missing");
  }
  if (branch.task_id !== taskId) {
    return branchError("goal_snapshot_task_mismatch");
  }
  const currentRevision = branch.current_goal_revision;
  if (
    typeof currentRevision !== "number" ||
    !Number.isSafeInteger(currentRevision) ||
    currentRevision < 1
  ) {
    return branchError("goal_snapshot_branch_revision_invalid");
  }

  if (goalRevision < currentRevision) {
    return branchError("goal_snapshot_revision_regressed");
  }
  if (goalRevision > currentRevision + 1) {
    return branchError("goal_snapshot_revision_skipped");
  }
  if (goalRevision === currentRevision) {
    const sameSnapshot = branch.current_goal_snapshot_id === snapshotId;
    const sameVersion = branch.current_goal_version === goalVersion;
    return sameSnapshot && sameVersion
      ? { ok: true }
      : branchError("goal_snapshot_revision_conflict");
  }

  const updated = source
    .prepare(
      `UPDATE branch
          SET current_goal_version = :goal_version,
              current_goal_revision = :goal_revision,
              current_goal_snapshot_id = :snapshot_id
        WHERE branch_id = :branch_id
          AND current_goal_revision = :expected_revision`
    )
    .run({
      goal_version: goalVersion,
      goal_revision: goalRevision,
      snapshot_id: snapshotId,
      branch_id: branchId,
      expected_revision: currentRevision
    });
  if (updated.changes !== 1) {
    return branchError("goal_snapshot_branch_concurrent_update");
  }
  return { ok: true };
}
