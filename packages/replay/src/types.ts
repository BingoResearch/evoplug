/**
 * Replay plan, classification, authorization, approval and execution shapes
 * (DD-FND-094, DD-FND-096).
 *
 * Field names, schema versions and closed unions are copied verbatim from the
 * design. `plan_hash` never covers `replay_plan_id`, `state` or itself.
 */

import type {
  Hash,
  Id,
  SourceRef,
  VersionBinding,
} from "@evoplug/core";

import type { HumanAttestation } from "@evoplug/egress";

export type ReplayClass = "read_only" | "sandboxed_temp" | "live_external";

export type ReplayEnvironment = "host" | "temp_copy" | "sandbox";

export type ReplayIsolationMechanism = "none" | "container" | "vm" | "os_sandbox";

export interface ReplayIsolation {
  mechanism: ReplayIsolationMechanism;
  verified: boolean;
  evidence_ref: SourceRef | null;
  network_namespace: boolean;
  writable_roots: string[];
}

export type ReplaySideEffectKind =
  | "file_write"
  | "network"
  | "process_spawn"
  | "secret_access"
  | "external_state";

export type ReplayPlanState =
  | "planned"
  | "running"
  | "passed"
  | "failed"
  | "rejected"
  | "unverified";

export type ReplayClassificationEvidence = "tool_metadata" | "observed_effects" | "none";

export interface ReplayPlan {
  schema_version: "rsi.replay_plan/2";
  replay_plan_id: Id<"rpl">;
  validation_plan_id: string;
  replay_class: ReplayClass;
  command: string;
  cwd: string;
  allowed_network: boolean;
  /** `host:port`; null when `allowed_network=false`. */
  network_target: string | null;
  classification_evidence: ReplayClassificationEvidence;
  environment: ReplayEnvironment;
  isolation: ReplayIsolation;
  side_effect_kinds: ReplaySideEffectKind[];
  side_effect_refs: SourceRef[];
  version_binding: VersionBinding;
  state: ReplayPlanState;
  plan_hash: Hash;
  /**
   * Row version. `plan_hash` deliberately excludes it (DD-FND-094 white list),
   * but the ledger row snapshot must carry it: a plan may leave and re-enter
   * the `running` state (DD-FND-097.5), and without a version the repeated
   * after-image would collide with the earlier one on
   * `ledger_event_log(entity_type, entity_id, after_hash)`.
   */
  row_version: number;
}

export type ReplayPlanDraft = Omit<
  ReplayPlan,
  "replay_plan_id" | "state" | "plan_hash" | "row_version"
>;

export type ReplayExecutionState =
  | "authorized"
  | "running"
  | "passed"
  | "failed"
  | "unknown"
  | "cancelled";

export interface ReplayExecution {
  schema_version: "rsi.replay_execution/1";
  execution_id: Id<"rex">;
  replay_plan_id: Id<"rpl">;
  approval_id: Id<"rpa"> | null;
  state: ReplayExecutionState;
  /** 32 CSPRNG bytes, base64url unpadded (43 characters). */
  fencing_token: string;
  reconcile_required: boolean;
  reconciled_at: number | null;
  reconcile_evidence_ref: SourceRef | null;
  started_at: number | null;
  ended_at: number | null;
  exit_code: number | null;
  stdout_ref: SourceRef | null;
  stderr_ref: SourceRef | null;
  result_hash: Hash | null;
  error_code: string | null;
  row_version: number;
  created_at: number;
}

export type ReplayClassification =
  | {
      state: "known";
      requested_class: ReplayClass;
      allowed_network: boolean;
      network_target: string | null;
      classification_evidence: "tool_metadata" | "observed_effects";
      side_effect_kinds: ReplayPlan["side_effect_kinds"];
    }
  | {
      state: "unknown";
      reason_code:
        | "tool_metadata_missing"
        | "effects_unobserved"
        | "isolation_unverified"
        | "command_dynamic";
    };

export type ReplayClassificationUnknownReason = Extract<
  ReplayClassification,
  { state: "unknown" }
>["reason_code"];

export interface ReplayClassifyRequest {
  schema_version: "rsi.replay_classify/1";
  validation_plan_id: string;
  command: string;
  cwd: string;
  requested_class: ReplayClass;
  allowed_network: boolean;
  network_target: string | null;
  environment: ReplayEnvironment;
  isolation: ReplayIsolation;
  tool_metadata_ref: SourceRef | null;
  observed_effects: ReplayPlan["side_effect_kinds"];
}

export interface ReplayAuthorizeRequest {
  schema_version: "rsi.replay_authorize/1";
  replay_plan_id: Id<"rpl">;
  approval_id: Id<"rpa"> | null;
}

export type ReplayApprovalState = "active" | "consumed" | "revoked" | "expired";

export type ReplayRevokeReason = "human_revoked" | "plan_rejected" | "policy_replaced";

export interface ReplayApproval {
  approval_id: Id<"rpa">;
  replay_plan_id: Id<"rpl">;
  plan_hash: Hash;
  approved_by: "human";
  human_attestation: HumanAttestation;
  attestation_subject_hash: Hash;
  approval_hash: Hash;
  command: string;
  cwd: string;
  version_binding: VersionBinding;
  allowed_network: boolean;
  network_target: string | null;
  ttl_ms: number;
  state: ReplayApprovalState;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  consumed_execution_id: Id<"rex"> | null;
  revoked_at: number | null;
  revoke_reason: ReplayRevokeReason | null;
  row_version: number;
}

export type ReplayApprovalView = Omit<ReplayApproval, "human_attestation">;

export interface ReplayApproveRequest {
  schema_version: "rsi.replay_approve/1";
  replay_plan_id: Id<"rpl">;
  expected_plan_hash: Hash;
  ttl_ms: number;
  human_attestation: HumanAttestation;
  /** 1..512 UTF-8 bytes; audit only. */
  reason: string;
  /**
   * Optional control-plane idempotency key. DD-FND-041 carries the key in the
   * IPC envelope; DD-FND-096.1 step 1 validates it before the plan read, so the
   * wire request may also carry it. The empty string means "no key supplied".
   */
  idempotency_key: string;
}

export interface ReplayRevokeRequest {
  schema_version: "rsi.replay_revoke/1";
  approval_id: Id<"rpa">;
  expected_approval_hash: Hash;
  human_attestation: HumanAttestation;
  reason: "human_revoked" | "policy_replaced";
}

export interface ReplayRejectRequest {
  schema_version: "rsi.replay_reject/1";
  replay_plan_id: Id<"rpl">;
  expected_plan_hash: Hash;
  human_attestation: HumanAttestation;
  /** 1..512 UTF-8 bytes. */
  reason: string;
}

export interface ReplayReconcileRequest {
  schema_version: "rsi.replay_reconcile/1";
  execution_id: Id<"rex">;
  fencing_token: string;
  /** Retrievable proof that the process group no longer exists. */
  evidence_ref: SourceRef;
  human_attestation: HumanAttestation;
  /** 1..512 UTF-8 bytes. */
  reason: string;
}

export type ReplayAuthorizationState = "authorized" | "needs_approval" | "rejected";

export type ReplayAuthorizationReason =
  | "read_only_confirmed"
  | "sandbox_verified"
  | "explicit_approval"
  | "approval_missing"
  | "approval_mismatch"
  | "approval_consumed"
  | "network_scope_mismatch"
  | "isolation_unverified"
  | "classifier_unknown";

export interface ReplayAuthorization {
  state: ReplayAuthorizationState;
  replay_plan_id: Id<"rpl">;
  reason_code: ReplayAuthorizationReason;
  fencing_token: string | null;
}

export const REPLAY_PLAN_SCHEMA_VERSION: "rsi.replay_plan/2" = "rsi.replay_plan/2";

export const REPLAY_EXECUTION_SCHEMA_VERSION: "rsi.replay_execution/1" =
  "rsi.replay_execution/1";

export const REPLAY_CLASSIFY_SCHEMA_VERSION: "rsi.replay_classify/1" =
  "rsi.replay_classify/1";

export const REPLAY_APPROVE_SCHEMA_VERSION: "rsi.replay_approve/1" = "rsi.replay_approve/1";

export const REPLAY_REVOKE_SCHEMA_VERSION: "rsi.replay_revoke/1" = "rsi.replay_revoke/1";

export const REPLAY_REJECT_SCHEMA_VERSION: "rsi.replay_reject/1" = "rsi.replay_reject/1";

export const REPLAY_RECONCILE_SCHEMA_VERSION: "rsi.replay_reconcile/1" =
  "rsi.replay_reconcile/1";

export const REPLAY_MIN_TTL_MS = 1;
export const REPLAY_MAX_TTL_MS = 600_000;
export const REPLAY_MAX_REASON_BYTES = 512;
export const REPLAY_MAX_COMMAND_BYTES = 65_536;
export const REPLAY_FENCING_TOKEN_BYTES = 32;
export const REPLAY_FENCING_TOKEN_LENGTH = 43;

export const REPLAY_SIDE_EFFECT_KINDS: readonly ReplaySideEffectKind[] = [
  "file_write",
  "network",
  "process_spawn",
  "secret_access",
  "external_state",
];

export function isReplayClass(value: string): value is ReplayClass {
  return value === "read_only" || value === "sandboxed_temp" || value === "live_external";
}

export function isReplayPlanState(value: string): value is ReplayPlanState {
  return (
    value === "planned" ||
    value === "running" ||
    value === "passed" ||
    value === "failed" ||
    value === "rejected" ||
    value === "unverified"
  );
}

export function isReplayExecutionState(value: string): value is ReplayExecutionState {
  return (
    value === "authorized" ||
    value === "running" ||
    value === "passed" ||
    value === "failed" ||
    value === "unknown" ||
    value === "cancelled"
  );
}

export function isReplaySideEffectKind(value: string): value is ReplaySideEffectKind {
  return REPLAY_SIDE_EFFECT_KINDS.includes(value as ReplaySideEffectKind);
}
