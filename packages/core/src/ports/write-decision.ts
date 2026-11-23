/**
 * `WriteDecision` and the authorization vocabulary it shares with CFG
 * (DD-FND-090, DD-FND-095).
 *
 * `WriteDecision` lives in `@evoplug/core` because `ConfigWriteIntent`
 * persists it and CFG may only depend on core DTOs. `@evoplug/auth` owns the
 * evaluator and re-exports this type; there is no second definition.
 */

import type { Id } from "../ids.js";

export type GrantObjectType = "skill" | "memory" | "instructions" | "config";

export type GrantAction = "create" | "update" | "disable" | "rollback";

/**
 * `prop` is a REV Proposal, `ctr` is a CFG ConfigTrial. No third candidate
 * prefix is accepted anywhere (DD-FND-090).
 */
export type CandidateId = Id<"prop"> | Id<"ctr">;

export type GrantMode = "once" | "standing";

/** Closed deny reasons carried by `WriteDecision.reason_code`. */
export type WriteDenyReasonCode =
  | "no_grant"
  | "revoked"
  | "expired"
  | "subject_mismatch"
  | "object_type_mismatch"
  | "action_not_granted"
  | "project_out_of_scope"
  | "config_space_out_of_scope"
  | "path_out_of_scope"
  | "object_out_of_scope"
  | "candidate_mismatch"
  | "mode_consumed"
  | "grant_scope_empty"
  | "config_scope_missing"
  | "config_field_out_of_scope"
  | "config_layer_out_of_scope"
  | "config_model_scope_out_of_scope"
  | "config_space_not_exact"
  | "target_unmanaged"
  | "approval_required";

export type WriteDecision =
  | {
      allowed: true;
      grant_id: Id<"grant">;
      matched_action: GrantAction;
      requires_approval: false;
      consumed: boolean;
    }
  | {
      allowed: false;
      grant_id: Id<"grant"> | null;
      reason_code: WriteDenyReasonCode;
    };

/** Every `WriteDecision.reason_code`, in design order (DD-FND-090). */
const WRITE_DENY_REASON_CODES: readonly WriteDenyReasonCode[] = [
  "no_grant",
  "revoked",
  "expired",
  "subject_mismatch",
  "object_type_mismatch",
  "action_not_granted",
  "project_out_of_scope",
  "config_space_out_of_scope",
  "path_out_of_scope",
  "object_out_of_scope",
  "candidate_mismatch",
  "mode_consumed",
  "grant_scope_empty",
  "config_scope_missing",
  "config_field_out_of_scope",
  "config_layer_out_of_scope",
  "config_model_scope_out_of_scope",
  "config_space_not_exact",
  "target_unmanaged",
  "approval_required"
];

export function isWriteDenyReasonCode(value: string): value is WriteDenyReasonCode {
  return (WRITE_DENY_REASON_CODES as readonly string[]).includes(value);
}

