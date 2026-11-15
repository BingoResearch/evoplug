/**
 * `WriteDecision` evaluation (DD-FND-090, DD-FND-091 step 1, DD-FND-095.2).
 *
 * The evaluator is pure: it reads a grant, the already-derived write target and
 * the current consumption state, and returns the closed decision union. It
 * never touches the filesystem, the clock or the database.
 */
import type { Hash, Id } from "@evoplug/core";
import type { CandidateId, GrantAction, GrantObjectType, WriteDecision } from "@evoplug/core";
import type { AuthorizationGrant } from "./grants.js";
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
export declare function evaluateWriteDecision(grant: AuthorizationGrant | null, target: WriteTargetFacts, context: DecisionContext): WriteDecision;
/** The `project_ids` element that matches a task: the raw id or reserved `user`. */
export declare function projectMatchKey(projectId: string | null): string;
