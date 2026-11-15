/**
 * Closed IPC method table (DD-FND-042) and its idempotency classification
 * (DD-FND-041).
 *
 * The union is closed: `schemas/ipc/methods.json` carries the same list, and the
 * server answers an unregistered method with `E_IPC_METHOD_UNKNOWN`. Domain
 * extension methods must be added to all three places (schema, union, maps).
 */

import type {
  AdapterInstallApproveRequest,
  AdapterInstallApprovalView,
  AdapterInstallRevokeSubject,
  DecisionDraft,
  EventDraft,
  GcReport,
  GrantObjectType,
  GrantView,
  Hash,
  HostId,
  HumanAttestation,
  Id,
  IdentityResolution,
  IngestReceipt,
  LedgerView,
  NativeMessageKind,
  ReplayApprovalView,
  ReplayApproveRequest,
  ReplayAuthorization,
  ReplayAuthorizeRequest,
  ReplayClassification,
  ReplayClassifyRequest,
  ReplayExecution,
  ReplayPlan,
  ReplayPlanDraft,
  ReplayReconcileRequest,
  ReplayRejectRequest,
  ReplayRevokeRequest,
  ResumeResult,
  SourceRef,
  SystemDescription,
  SystemStatus,
  VersionBinding,
  WriteApplyRequest,
  WriteResult,
} from "@evoplug/core";
import type { BranchForkResult } from "@evoplug/ledger";
import type {
  BudgetClaimRequest,
  BudgetClaimResult,
  BudgetReservation,
  BudgetReserveRequest,
  BudgetSettlement,
  BudgetSettleRequest,
} from "@evoplug/budget";
import type { GrantIssueRequest, GrantRevokeRequest } from "@evoplug/auth";
import type {
  EgressApprovalRequest,
  EgressApprovalView,
  EgressDecision,
  EgressRequest,
} from "@evoplug/egress";
import type {
  HostRuntimePollRequest,
  HostRuntimePollResult,
  HostRuntimeReadyRequest,
  HostRuntimeReadyResult,
  HostRuntimeResultRequest,
  HostRuntimeResultResult,
  HostRuntimeUploadRequest,
  HostRuntimeUploadResult,
} from "@evoplug/core/host";
import type {
  DeliveryPlan,
  DeliveryRecord,
  DeliveryUpdateRequest,
} from "@evoplug/delivery";
import type {
  CloseTrial,
  ConfigResult,
  ConfigSpaceSelector,
  ConfigSpaceSnapshot,
  ConfigTrial,
  CreateTrialPlan,
  EpochMs,
  ExecuteAttempt,
  FieldReadback,
  PromotionEvidence,
  RecordObservation,
  ReconcileReport,
  RequestRollback,
  StartTrial,
  TrialAttempt,
  TrialPlan,
  FieldSpec,
} from "@evoplug/core/config";

export type IpcMethod =
  | "system.describe"
  | "event.ingest"
  | "host.runtime.ready"
  | "host.runtime.upload"
  | "host.runtime.poll"
  | "host.runtime.result"
  | "identity.resolve"
  | "identity.fork"
  | "identity.resume"
  | "ledger.read"
  | "grant.issue"
  | "grant.revoke"
  | "grant.list"
  | "budget.reserve"
  | "budget.claim"
  | "budget.settle"
  | "decision.record"
  | "delivery.create"
  | "delivery.update"
  | "write.apply"
  | "egress.evaluate"
  | "egress.approve"
  | "install.approve"
  | "install.revoke"
  | "install.approval.get"
  | "install.approval.consume"
  | "replay.classify"
  | "replay.create"
  | "replay.authorize"
  | "replay.approve"
  | "replay.revoke"
  | "replay.reject"
  | "replay.execute"
  | "replay.reconcile"
  | "replay.result"
  | "status.get"
  | "maintenance.gc"
  | "config.space.capture"
  | "config.space.read_fields"
  | "config.trial.create_plan"
  | "config.trial.start"
  | "config.trial.execute_attempt"
  | "config.trial.record_observation"
  | "config.trial.request_rollback"
  | "config.trial.close"
  | "config.trial.reconcile"
  | "config.promotion.collect";

export interface IpcParams {
  "system.describe": Record<string, never>;
  "event.ingest": { draft: EventDraft };
  "host.runtime.ready": HostRuntimeReadyRequest;
  "host.runtime.upload": HostRuntimeUploadRequest;
  "host.runtime.poll": HostRuntimePollRequest;
  "host.runtime.result": HostRuntimeResultRequest;
  "identity.resolve": {
    host_id: HostId;
    config_space: string;
    native_session_id: string;
    native_message_id?: string;
    native_kind?: NativeMessageKind;
  };
  "identity.fork": {
    source_branch_id: Id<"br">;
    at_watermark: number;
    reason: "user_fork" | "host_fork";
  };
  "identity.resume": {
    session_id: string;
    host_id: HostId;
    config_space: string;
    observed_watermark: number;
  };
  "ledger.read": {
    binding: VersionBinding;
    include: Array<"requirements" | "facts" | "feedback" | "corrections" | "outcome" | "constraints">;
  };
  "grant.issue": GrantIssueRequest;
  "grant.revoke": GrantRevokeRequest;
  "grant.list": {
    object_type?: GrantObjectType;
    state?: "active" | "revoked" | "expired" | "consumed";
    limit?: number;
  };
  "budget.reserve": BudgetReserveRequest;
  "budget.claim": BudgetClaimRequest;
  "budget.settle": BudgetSettleRequest;
  "decision.record": { decision: DecisionDraft };
  "delivery.create": { plan: DeliveryPlan };
  "delivery.update": DeliveryUpdateRequest;
  "write.apply": WriteApplyRequest;
  "egress.evaluate": EgressRequest;
  "egress.approve": EgressApprovalRequest;
  "install.approve": AdapterInstallApproveRequest;
  "install.revoke": {
    subject: AdapterInstallRevokeSubject;
    human_attestation: HumanAttestation;
    idempotency_key: string;
  };
  "install.approval.get": { approval_id: Id<"iap">; expected_subject_hash: Hash };
  "install.approval.consume": {
    approval_id: Id<"iap">;
    expected_approval_hash: Hash;
    registration_hash: Hash;
    request_id: string;
    idempotency_key: string;
  };
  "replay.classify": ReplayClassifyRequest;
  "replay.create": { plan: ReplayPlanDraft };
  "replay.authorize": ReplayAuthorizeRequest;
  "replay.approve": ReplayApproveRequest;
  "replay.revoke": ReplayRevokeRequest;
  "replay.reject": ReplayRejectRequest;
  "replay.execute": {
    replay_plan_id: Id<"rpl">;
    expected_plan_hash: Hash;
    approval_id: Id<"rpa"> | null;
  };
  "replay.reconcile": ReplayReconcileRequest;
  "replay.result": { execution_id: Id<"rex"> };
  "status.get": {
    include: Array<"storage" | "ipc" | "budget" | "outbox" | "config" | "capabilities">;
  };
  "maintenance.gc": { mode: "dry_run" | "apply"; retention_days?: number };
  "config.space.capture": ConfigSpaceSelector;
  "config.space.read_fields": {
    config_space_id: Hash;
    field_ids: readonly Id<"fld">[];
    layer_id: string;
  };
  "config.trial.create_plan": CreateTrialPlan;
  "config.trial.start": StartTrial;
  "config.trial.execute_attempt": Omit<ExecuteAttempt, "signal">;
  "config.trial.record_observation": RecordObservation;
  "config.trial.request_rollback": RequestRollback;
  "config.trial.close": CloseTrial;
  "config.trial.reconcile": { now: EpochMs };
  "config.promotion.collect": {
    trial_id: Id<"ctr">;
    field_id: Id<"fld">;
    spec: FieldSpec;
    deadline_ms?: number;
  };
}

export interface IpcResult {
  "system.describe": SystemDescription;
  "event.ingest": IngestReceipt;
  "host.runtime.ready": HostRuntimeReadyResult;
  "host.runtime.upload": HostRuntimeUploadResult;
  "host.runtime.poll": HostRuntimePollResult;
  "host.runtime.result": HostRuntimeResultResult;
  "identity.resolve": IdentityResolution;
  "identity.fork": BranchForkResult;
  "identity.resume": ResumeResult;
  "ledger.read": LedgerView;
  "grant.issue": GrantView;
  "grant.revoke": GrantView;
  "grant.list": { grants: GrantView[] };
  "budget.reserve": BudgetReservation;
  "budget.claim": BudgetClaimResult;
  "budget.settle": BudgetSettlement;
  "decision.record": { decision_id: Id<"dec">; created: boolean };
  "delivery.create": { delivery: DeliveryRecord; dedupe_hit: boolean };
  "delivery.update": { delivery: DeliveryRecord };
  "write.apply": WriteResult;
  "egress.evaluate": EgressDecision;
  "egress.approve": EgressApprovalView;
  "install.approve": AdapterInstallApprovalView;
  "install.revoke": AdapterInstallApprovalView;
  "install.approval.get": AdapterInstallApprovalView;
  "install.approval.consume": {
    approval: AdapterInstallApprovalView;
    consumption_ref: SourceRef;
  };
  "replay.classify": ReplayClassification;
  "replay.create": { plan: ReplayPlan; created: boolean };
  "replay.authorize": ReplayAuthorization;
  "replay.approve": ReplayApprovalView;
  "replay.revoke": ReplayApprovalView;
  "replay.reject": { plan: ReplayPlan; revoked_approval_ids: Id<"rpa">[] };
  "replay.execute": ReplayExecution;
  "replay.reconcile": ReplayExecution;
  "replay.result": ReplayExecution;
  "status.get": SystemStatus;
  "maintenance.gc": GcReport;
  "config.space.capture": ConfigResult<ConfigSpaceSnapshot>;
  "config.space.read_fields": ConfigResult<readonly FieldReadback[]>;
  "config.trial.create_plan": ConfigResult<TrialPlan>;
  "config.trial.start": ConfigResult<ConfigTrial>;
  "config.trial.execute_attempt": ConfigResult<TrialAttempt>;
  "config.trial.record_observation": ConfigResult<ConfigTrial>;
  "config.trial.request_rollback": ConfigResult<ConfigTrial>;
  "config.trial.close": ConfigResult<ConfigTrial>;
  "config.trial.reconcile": ConfigResult<ReconcileReport>;
  "config.promotion.collect": ConfigResult<PromotionEvidence>;
}

export const IPC_METHODS: readonly IpcMethod[] = [
  "system.describe",
  "event.ingest",
  "host.runtime.ready",
  "host.runtime.upload",
  "host.runtime.poll",
  "host.runtime.result",
  "identity.resolve",
  "identity.fork",
  "identity.resume",
  "ledger.read",
  "grant.issue",
  "grant.revoke",
  "grant.list",
  "budget.reserve",
  "budget.claim",
  "budget.settle",
  "decision.record",
  "delivery.create",
  "delivery.update",
  "write.apply",
  "egress.evaluate",
  "egress.approve",
  "install.approve",
  "install.revoke",
  "install.approval.get",
  "install.approval.consume",
  "replay.classify",
  "replay.create",
  "replay.authorize",
  "replay.approve",
  "replay.revoke",
  "replay.reject",
  "replay.execute",
  "replay.reconcile",
  "replay.result",
  "status.get",
  "maintenance.gc",
  "config.space.capture",
  "config.space.read_fields",
  "config.trial.create_plan",
  "config.trial.start",
  "config.trial.execute_attempt",
  "config.trial.record_observation",
  "config.trial.request_rollback",
  "config.trial.close",
  "config.trial.reconcile",
  "config.promotion.collect",
];

/**
 * `required` — the request envelope must carry `idempotency_key` (DD-FND-041).
 * `forbidden` — read-only methods and `egress.evaluate`, `replay.classify`,
 *   `grant.list`, `replay.result` never carry one.
 * `in_params` — the install methods carry their own `idempotency_key` inside
 *   `params` per the method table, so the envelope field must stay empty.
 */
export type IpcIdempotencyPolicy = "required" | "forbidden" | "in_params";

export const IPC_METHOD_IDEMPOTENCY: Readonly<Record<IpcMethod, IpcIdempotencyPolicy>> = {
  "system.describe": "forbidden",
  "event.ingest": "required",
  "host.runtime.ready": "required",
  "host.runtime.upload": "required",
  "host.runtime.poll": "forbidden",
  "host.runtime.result": "required",
  "identity.resolve": "forbidden",
  "identity.fork": "required",
  "identity.resume": "required",
  "ledger.read": "forbidden",
  "grant.issue": "required",
  "grant.revoke": "required",
  "grant.list": "forbidden",
  "budget.reserve": "required",
  "budget.claim": "required",
  "budget.settle": "required",
  "decision.record": "required",
  "delivery.create": "required",
  "delivery.update": "required",
  "write.apply": "required",
  "egress.evaluate": "forbidden",
  "egress.approve": "required",
  "install.approve": "in_params",
  "install.revoke": "in_params",
  "install.approval.get": "forbidden",
  "install.approval.consume": "in_params",
  "replay.classify": "forbidden",
  "replay.create": "required",
  "replay.authorize": "required",
  "replay.approve": "required",
  "replay.revoke": "required",
  "replay.reject": "required",
  "replay.execute": "required",
  "replay.reconcile": "required",
  "replay.result": "forbidden",
  "status.get": "forbidden",
  "maintenance.gc": "required",
  "config.space.capture": "forbidden",
  "config.space.read_fields": "forbidden",
  "config.trial.create_plan": "required",
  "config.trial.start": "required",
  "config.trial.execute_attempt": "required",
  "config.trial.record_observation": "required",
  "config.trial.request_rollback": "required",
  "config.trial.close": "required",
  "config.trial.reconcile": "required",
  "config.promotion.collect": "forbidden",
};

export const IPC_IDEMPOTENCY_KEY_PATTERN: RegExp = /^[A-Za-z0-9._:-]{8,128}$/;

const METHOD_SET: ReadonlySet<string> = new Set<string>(IPC_METHODS);

export function isIpcMethod(value: string): value is IpcMethod {
  return METHOD_SET.has(value);
}

export function requiresIdempotencyKey(method: IpcMethod): boolean {
  return IPC_METHOD_IDEMPOTENCY[method] === "required";
}

export function isValidIdempotencyKey(value: string): boolean {
  return IPC_IDEMPOTENCY_KEY_PATTERN.test(value);
}
