/**
 * Unknown-source constraint conflict classification (DD-FND-053, DD-FND-074).
 *
 * An `UnverifiedConstraint` carries a `scope_hint`. When the hint is disjoint
 * from an active requirement's scope, the constraint contradicts the current
 * goal; the ledger keeps the conflict visible by abstaining instead of asking
 * the user or blocking the task. The detector is pure: it opens no port, writes
 * no ledger row, creates no question and emits no prompt or delivery.
 */

import type { Id } from "@evoplug/core";
import type { RequirementScope } from "../domain/requirements.js";

export interface ConstraintConflictInput {
  /** Scope of the active requirement the constraint is compared against. */
  readonly requirement_scope: RequirementScope;
  /** Scope hint frozen with the unknown-source constraint. */
  readonly constraint_scope: RequirementScope;
  readonly requirement_id?: Id<"req">;
}

export interface ConstraintConflictDecision {
  readonly conflict: boolean;
  /** Fixed abstain decision; a conflict never becomes a user question. */
  readonly decision: "abstain";
  readonly user_question_created: false;
  readonly blocked_task: false;
  /** Requirements whose scope is disjoint from the constraint hint. */
  readonly conflicting_requirement_ids: readonly Id<"req">[];
}

/**
 * Static prefix of a scope glob, used for overlap. A glob such as `src/**`
 * covers `src/`; an exact path such as `docs` covers itself. Two path globs
 * overlap when one prefix is a prefix of the other.
 */
function globPrefix(glob: string): string {
  const wildcard = glob.search(/[*?[]/);
  return wildcard < 0 ? glob : glob.slice(0, wildcard);
}

function pathSetsOverlap(left: readonly string[], right: readonly string[]): boolean {
  // An empty list is an unrestricted axis, not an empty set.
  if (left.length === 0 || right.length === 0) return true;
  for (const a of left) {
    const prefixA = globPrefix(a);
    for (const b of right) {
      const prefixB = globPrefix(b);
      if (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA)) return true;
    }
  }
  return false;
}

function setsOverlap<T extends string>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length === 0 || right.length === 0) return true;
  const known = new Set<string>(left);
  return right.some((value) => known.has(value));
}

/**
 * Classifies a constraint scope against the active requirement's scope.
 *
 * The axes are conjunctive: a disjoint path set, host set, mode set or project
 * set means the constraint cannot apply to the same work as the requirement.
 * The result is always `decision="abstain"` with no user question and no task
 * blocking, as required for S-UNK-02.
 */
export function detectConstraintConflict(
  input: ConstraintConflictInput
): ConstraintConflictDecision {
  const requirement = input.requirement_scope;
  const constraint = input.constraint_scope;
  const conflict =
    !pathSetsOverlap(requirement.paths, constraint.paths) ||
    !setsOverlap(requirement.hosts, constraint.hosts) ||
    !setsOverlap(requirement.modes, constraint.modes) ||
    !setsOverlap(requirement.project_ids, constraint.project_ids);
  return {
    conflict,
    decision: "abstain",
    user_question_created: false,
    blocked_task: false,
    conflicting_requirement_ids:
      conflict && input.requirement_id !== undefined ? [input.requirement_id] : []
  };
}
