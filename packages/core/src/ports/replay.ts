/**
 * FND replay approval read view (DD-FND-096).
 *
 * The full `ReplayApproval` record lives in the replay package; the IPC
 * boundary only returns the view without the attestation payload.
 */

import type { Hash } from "../hash.js";
import type { Id } from "../ids.js";
import type { VersionBinding } from "../version-binding.js";

export type ReplayApprovalState = "active" | "consumed" | "revoked" | "expired";
export type ReplayRevokeReason = "human_revoked" | "plan_rejected" | "policy_replaced";

export interface ReplayApprovalView {
  readonly approval_id: Id<"rpa">;
  readonly replay_plan_id: Id<"rpl">;
  readonly plan_hash: Hash;
  readonly approved_by: "human";
  readonly attestation_subject_hash: Hash;
  readonly approval_hash: Hash;
  readonly command: string;
  readonly cwd: string;
  readonly version_binding: VersionBinding;
  readonly allowed_network: boolean;
  readonly network_target: string | null;
  readonly ttl_ms: number;
  readonly state: ReplayApprovalState;
  readonly created_at: number;
  readonly expires_at: number;
  readonly consumed_at: number | null;
  readonly consumed_execution_id: Id<"rex"> | null;
  readonly revoked_at: number | null;
  readonly revoke_reason: ReplayRevokeReason | null;
  readonly row_version: number;
}
