import { compareUtf8 } from "@evoplug/core";
import type { Id } from "@evoplug/core";
import type {
  BranchCandidate,
  IdentityResolution,
  IdentityResolveInput,
  NativeSessionMapping,
} from "../domain/identity.js";

interface MappingGroup {
  readonly branch_id: Id<"br">;
  readonly task_id: Id<"task">;
  readonly mapping: NativeSessionMapping;
}

function groupByBranch(mappings: readonly NativeSessionMapping[]): MappingGroup[] {
  const groups: MappingGroup[] = [];
  for (const mapping of mappings) {
    if (!groups.some((group) => group.branch_id === mapping.branch_id)) {
      groups.push({
        branch_id: mapping.branch_id,
        task_id: mapping.task_id,
        mapping,
      });
    }
  }
  groups.sort((a, b) => compareUtf8(a.branch_id, b.branch_id));
  return groups;
}

function toCandidate(group: MappingGroup): BranchCandidate {
  return {
    branch_id: group.branch_id,
    task_id: group.task_id,
    watermark: group.mapping.watermark,
  };
}

/**
 * `identity.resolve` is a pure, non-selecting resolution. A native session that
 * maps to more than one branch returns `ambiguous` with every candidate; it is
 * never resolved by recency, text similarity or `current_branch_id`.
 *
 * `host_conflict` reports a mapping the host contradicts and yields `stale`,
 * keeping the candidates visible without choosing one.
 */
export function resolveIdentity(input: IdentityResolveInput): IdentityResolution {
  const groups = groupByBranch(input.mappings);

  if (input.host_conflict === true) {
    return {
      state: "stale",
      reason_code: "host_conflict",
      candidates: groups.map((group) => toCandidate(group)),
    };
  }

  if (groups.length === 0) {
    return { state: "not_found", reason_code: "native_not_mapped" };
  }

  if (groups.length > 1) {
    return {
      state: "ambiguous",
      reason_code: "multiple_branches",
      candidates: groups.map((group) => toCandidate(group)),
    };
  }

  const selected = groups[0];
  if (selected === undefined) {
    return { state: "not_found", reason_code: "native_not_mapped" };
  }

  const mapping = selected.mapping;
  const resolution: IdentityResolution = {
    state: "resolved",
    session_id: mapping.session_id,
    task_id: selected.task_id,
    branch_id: selected.branch_id,
    input_epoch: mapping.input_epoch,
    goal_version: mapping.goal_version,
    watermark: mapping.watermark,
    reason_code: "none",
    ...(mapping.input_id === null ? {} : { input_id: mapping.input_id }),
  };
  return resolution;
}

/** True only when a resolution identifies exactly one branch and session. */
export function isResolved(resolution: IdentityResolution): boolean {
  return (
    resolution.state === "resolved" &&
    resolution.session_id !== undefined &&
    resolution.branch_id !== undefined &&
    resolution.task_id !== undefined
  );
}
