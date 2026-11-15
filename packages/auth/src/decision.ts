/**
 * `WriteDecision` evaluation (DD-FND-090, DD-FND-091 step 1, DD-FND-095.2).
 *
 * The evaluator is pure: it reads a grant, the already-derived write target and
 * the current consumption state, and returns the closed decision union. It
 * never touches the filesystem, the clock or the database.
 */

import { isId } from "@evoplug/core";
import type { Hash, Id } from "@evoplug/core";
import type {
  CandidateId,
  GrantAction,
  GrantObjectType,
  WriteDecision,
  WriteDenyReasonCode,
} from "@evoplug/core";

import type { AuthorizationGrant, GrantScope } from "./grants.js";
import { USER_PROJECT_SCOPE } from "./grants.js";
import { matchAnyPathGlob } from "./path-glob.js";

export interface ConfigWriteTargetFacts {
  config_space_id: Hash;
  field_ids: readonly Id<"fld">[];
  layer_id: string;
  model_scope_key: string;
}

export interface WriteTargetFacts {
  object_type: GrantObjectType;
  action: GrantAction;
  candidate_id: CandidateId | null;
  candidate_hash: Hash | null;
  /** `task.project_id`; `null` is the reserved `user` scope. */
  project_id: string | null;
  /** Derived config space for a managed write; `null` on a v1 imported row. */
  config_space_id: string | null;
  /** Relative path under the resolved root. */
  target_path: string;
  /** Absolute candidates matched against `path_globs`; defaults to `[target_path]`. */
  path_candidates?: readonly string[];
  config?: ConfigWriteTargetFacts | null;
  target_ownership?: "native_managed" | "rsi_managed" | "shared_handwritten";
  unattended_policy?: "auto_allowed" | "pending_approval" | "rsi_managed_file_only";
}

export interface DecisionContext {
  /** Epoch milliseconds; only `expires_at !== null && expires_at <= now` expires. */
  now: number;
  /** Existing consumption for a `mode="once"` grant, when known. */
  consumption?: {
    write_id: Id<"wi"> | null;
    config_write_id: Id<"cwi"> | null;
  } | null;
}

/**
 * Evaluates a grant against a write target.
 *
 * The checks run in this fixed order: grant presence, subject, revocation,
 * expiry, object type, action, scope emptiness, project, config space, path,
 * object, candidate, config scope, once consumption, unattended policy. The
 * first failure wins.
 */
export function evaluateWriteDecision(
  grant: AuthorizationGrant | null,
  target: WriteTargetFacts,
  context: DecisionContext
): WriteDecision {
  if (grant === null) {
    return deny(null, "no_grant");
  }
  const grantId = grant.grant_id;
  if (grant.subject !== "rsi") {
    return deny(grantId, "subject_mismatch");
  }
  if (grant.revoked_at !== null) {
    return deny(grantId, "revoked");
  }
  if (grant.expires_at !== null && grant.expires_at <= context.now) {
    return deny(grantId, "expired");
  }
  if (grant.object_type !== target.object_type) {
    return deny(grantId, "object_type_mismatch");
  }
  if (!grant.actions.includes(target.action)) {
    return deny(grantId, "action_not_granted");
  }
  const scope = grant.scope;
  if (
    scope.project_ids.length === 0 ||
    scope.config_spaces.length === 0 ||
    scope.path_globs.length === 0
  ) {
    return deny(grantId, "grant_scope_empty");
  }
  const projectKey = projectMatchKey(target.project_id);
  if (!scope.project_ids.includes(projectKey)) {
    return deny(grantId, "project_out_of_scope");
  }
  const configSpace = decideConfigSpace(scope, target);
  if (configSpace !== null) {
    return deny(grantId, configSpace);
  }
  const pathCandidates = target.path_candidates ?? [target.target_path];
  if (!pathCandidates.some((candidate) => matchAnyPathGlob(scope.path_globs, candidate))) {
    return deny(grantId, "path_out_of_scope");
  }
  const objectDeny = decideObjectIds(scope, target);
  if (objectDeny !== null) {
    return deny(grantId, objectDeny);
  }
  const candidateDeny = decideCandidate(grant, target);
  if (candidateDeny !== null) {
    return deny(grantId, candidateDeny);
  }
  if (target.object_type === "config") {
    const configDeny = decideConfigScope(scope, target);
    if (configDeny !== null) {
      return deny(grantId, configDeny);
    }
  }
  if (grant.mode === "once" && isConsumed(context.consumption)) {
    return deny(grantId, "mode_consumed");
  }
  if (target.unattended_policy === "rsi_managed_file_only") {
    if (target.target_ownership !== "rsi_managed") {
      return deny(grantId, "target_unmanaged");
    }
  }
  if (target.unattended_policy === "pending_approval") {
    return deny(grantId, "approval_required");
  }
  return {
    allowed: true,
    grant_id: grantId,
    matched_action: target.action,
    requires_approval: false,
    // Config writes consume a `once` grant only in the terminal `verified`
    // transaction (DD-FND-095.5); the decision does not pre-consume it.
    consumed: grant.mode === "once" && grant.object_type !== "config"
  };
}

/** The `project_ids` element that matches a task: the raw id or reserved `user`. */
export function projectMatchKey(projectId: string | null): string {
  return projectId ?? USER_PROJECT_SCOPE;
}

function deny(grantId: Id<"grant"> | null, reason: WriteDenyReasonCode): WriteDecision {
  return { allowed: false, grant_id: grantId, reason_code: reason };
}

function decideConfigSpace(scope: GrantScope, target: WriteTargetFacts): WriteDenyReasonCode | null {
  if (target.object_type === "config") {
    if (scope.config_spaces.length !== 1) {
      return "config_space_not_exact";
    }
    const expected = scope.config_spaces[0];
    const actual = target.config?.config_space_id ?? target.config_space_id;
    if (actual === null || actual !== expected) {
      return "config_space_not_exact";
    }
    return null;
  }
  if (target.config_space_id === null) {
    // A managed write derives the space only when the grant has exactly one.
    return scope.config_spaces.length === 1 ? null : "config_space_out_of_scope";
  }
  return scope.config_spaces.includes(target.config_space_id)
    ? null
    : "config_space_out_of_scope";
}

function decideObjectIds(scope: GrantScope, target: WriteTargetFacts): WriteDenyReasonCode | null {
  if (scope.object_ids.length === 0) {
    return null;
  }
  if (target.object_type === "config") {
    const configSpaceId = target.config?.config_space_id ?? target.config_space_id;
    if (configSpaceId === null || !scope.object_ids.includes(configSpaceId)) {
      return "object_out_of_scope";
    }
    return null;
  }
  const candidate = target.candidate_id;
  if (candidate === null || !scope.object_ids.includes(candidate)) {
    return "object_out_of_scope";
  }
  return null;
}

function decideCandidate(
  grant: AuthorizationGrant,
  target: WriteTargetFacts
): WriteDenyReasonCode | null {
  if (grant.candidate_id !== null && grant.candidate_id !== target.candidate_id) {
    return "candidate_mismatch";
  }
  if (grant.candidate_hash !== null && grant.candidate_hash !== target.candidate_hash) {
    return "candidate_mismatch";
  }
  if (target.object_type === "config") {
    if (grant.candidate_id === null || grant.candidate_hash === null) {
      return "candidate_mismatch";
    }
    if (!isId(grant.candidate_id, "ctr")) {
      return "candidate_mismatch";
    }
    if (target.candidate_id === null || !isId(target.candidate_id, "ctr")) {
      return "candidate_mismatch";
    }
  }
  return null;
}

function decideConfigScope(scope: GrantScope, target: WriteTargetFacts): WriteDenyReasonCode | null {
  const configScope = scope.config_scope;
  if (configScope === undefined) {
    return "config_scope_missing";
  }
  const configTarget = target.config;
  if (configTarget === null || configTarget === undefined) {
    return "config_scope_missing";
  }
  for (const fieldId of configTarget.field_ids) {
    if (!configScope.field_ids.includes(fieldId)) {
      return "config_field_out_of_scope";
    }
  }
  if (!configScope.source_layer_ids.includes(configTarget.layer_id)) {
    return "config_layer_out_of_scope";
  }
  if (!configScope.model_scope_keys.includes(configTarget.model_scope_key)) {
    return "config_model_scope_out_of_scope";
  }
  return null;
}

function isConsumed(
  consumption: DecisionContext["consumption"]
): boolean {
  if (consumption === null || consumption === undefined) {
    return false;
  }
  return consumption.write_id !== null || consumption.config_write_id !== null;
}
